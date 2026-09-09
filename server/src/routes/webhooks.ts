// #circle-webhook-route — see .purpose in this directory. Implements the
// webhook leg of $checkout-flow (!payment-confirmed / !payment-failed).

import { createVerify } from "node:crypto";
import { Router } from "express";
import { asyncHandler } from "../async-handler.js";
import { pool } from "../db.js";

export const webhooksRouter = Router();

// ponytail: cache forever per process lifetime — Circle's notification keys don't rotate
// per-request. Fine for a hackathon demo; revisit for long-running production processes.
const publicKeyCache = new Map<string, string>();

async function getCirclePublicKey(keyId: string): Promise<string | null> {
  const cached = publicKeyCache.get(keyId);
  if (cached) return cached;

  const res = await fetch(`https://api.circle.com/v2/notifications/publicKey/${keyId}`, {
    headers: { Authorization: `Bearer ${process.env.CIRCLE_API_KEY}` },
  });
  if (!res.ok) return null;

  const body = (await res.json()) as { data?: { publicKey?: string } };
  const publicKey = body.data?.publicKey;
  if (!publicKey) return null;

  publicKeyCache.set(keyId, publicKey);
  return publicKey;
}

const STATE_MAP: Record<string, "confirmed" | "failed" | "denied" | "cancelled"> = {
  COMPLETE: "confirmed",
  FAILED: "failed",
  DENIED: "denied",
  CANCELLED: "cancelled",
};

webhooksRouter.post(
  "/webhooks/circle",
  asyncHandler(async (req, res) => {
  const signature = req.header("x-circle-signature");
  const keyId = req.header("x-circle-key-id");
  const rawBody = req.rawBody;

  if (!signature || !keyId || !rawBody) {
    res.status(401).json({ error: "missing_signature" });
    return;
  }

  const publicKey = await getCirclePublicKey(keyId);
  if (!publicKey) {
    res.status(401).json({ error: "unknown_key_id" });
    return;
  }

  const verifier = createVerify("SHA256");
  verifier.update(rawBody);
  const valid = verifier.verify(publicKey, signature, "base64");
  if (!valid) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  const payload = JSON.parse(rawBody.toString("utf8")) as {
    notification?: { transactionId?: string; state?: string };
  };
  const transactionId = payload.notification?.transactionId;
  const circleState = payload.notification?.state;
  const status = circleState ? STATE_MAP[circleState] : undefined;

  if (!transactionId || !status) {
    // Not a terminal transaction-state notification we care about — ack and ignore.
    res.status(200).json({ ok: true });
    return;
  }

  // Idempotent: replays set the same terminal value.
  await pool.query(
    "update orders set status = $1, updated_at = now() where circle_transaction_id = $2",
    [status, transactionId],
  );

  // !payment-confirmed / !payment-failed
  res.status(200).json({ ok: true });
  }),
);
