// #verify-route — the human-facing ^personhood-verified checkpoint for agent-initiated
// purchases, opened from a link/QR the agent surfaced. Two modes (see #worldid-service):
//   - mock:  GET /verify/:sessionId renders a click-through page that settles the order.
//   - world: the SPA renders the World ID Selfie Check widget, reads GET
//            /verify-context/:sessionId for the RP signature, and POSTs the proof to
//            POST /verify/:sessionId, which verifies it with World before settling.
// Settlement is shared and single-use either way. Emits !personhood-verified, !purchase-completed.

import { Router } from "express";
import { asyncHandler } from "../async-handler.js";
import { getOrder, markOrderPaid } from "../services/orders.js";
import { executePayment } from "../services/payment.js";
import { getSession, getSessionForContext, markSessionVerified } from "../services/verification.js";
import {
  buildVerificationContext,
  VERIFICATION_MODE,
  verificationMode,
  verifyWorldProof,
} from "../services/worldid.js";

export const verifyRouter = Router();

type SettleOutcome = "verified" | "already" | "expired" | "not_found" | "order_missing";

// Marks the session verified (atomically, so this runs once) and settles the order via
// #payment-service. Shared by the mock GET and the world POST so both charge exactly once.
async function settleVerifiedSession(sessionId: string): Promise<SettleOutcome> {
  const result = await markSessionVerified(sessionId);
  if (result.outcome !== "verified") return result.outcome;

  const session = result.session!;
  const order = await getOrder(session.order_id);
  if (!order) return "order_missing";

  const payment = await executePayment({
    userId: session.user_id,
    destinationAddress: order.destination_address,
    amountUsdc: Number(order.amount_usdc),
    idempotencyKey: order.idempotency_key,
  });
  await markOrderPaid(order.id, payment.transactionId, payment.orderStatus);
  return "verified";
}

function page(heading: string, body: string, accent = "#111"): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${heading}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f6f6f7; color: #111; margin: 0;
    display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #fff; border-radius: 16px; padding: 2.5rem; max-width: 420px; width: 90%;
    box-shadow: 0 8px 30px rgba(0,0,0,.08); text-align: center; }
  h1 { margin: 0 0 .5rem; font-size: 1.5rem; color: ${accent}; }
  p { margin: .25rem 0; color: #444; line-height: 1.5; }
  .badge { font-size: 2.5rem; margin-bottom: .5rem; }
  .muted { color: #888; font-size: .85rem; margin-top: 1.25rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    ${body}
    <p class="muted">World ID Selfie Check (mock) &middot; agentic-commerce</p>
  </div>
</body>
</html>`;
}

// GET /verify/:sessionId — the MOCK click-through checkpoint. Disabled in world mode so
// it can never be used to settle a purchase without a real selfie proof.
verifyRouter.get(
  "/verify/:sessionId",
  asyncHandler(async (req, res) => {
    if (verificationMode() === VERIFICATION_MODE.world) {
      res
        .status(409)
        .type("html")
        .send(page("Use the app", "<p>Complete this verification in the World ID Selfie Check page shown by your agent.</p>", "#b00"));
      return;
    }

    const outcome = await settleVerifiedSession(req.params.sessionId);
    if (outcome === "not_found") {
      res.status(404).type("html").send(page("Invalid link", "<p>This verification link is not valid.</p>", "#b00"));
      return;
    }
    if (outcome === "order_missing") {
      res.status(404).type("html").send(page("Order missing", "<p>The order for this verification no longer exists.</p>", "#b00"));
      return;
    }
    if (outcome === "expired") {
      res
        .status(410)
        .type("html")
        .send(page("Link expired", "<p>This verification link has expired. Ask your agent to start the purchase again.</p>", "#b00"));
      return;
    }
    if (outcome === "already") {
      res.type("html").send(page("Already verified", "<p>This purchase was already verified. You can return to your agent.</p>"));
      return;
    }

    const order = await getOrder((await getSession(req.params.sessionId))!.order_id);
    res
      .type("html")
      .send(
        page(
          "Verified ✓",
          `<p class="badge">✅</p><p>Purchase of <strong>$${Number(order?.amount_usdc ?? 0).toFixed(2)} USDC</strong> authorized.</p><p>You can return to your agent.</p>`,
          "#0a7d33",
        ),
      );
  }),
);

// GET /verify-context/:sessionId — what the SPA needs to render the Selfie Check widget.
// Public (the session id is the capability). Reports expiry so the SPA can show it.
verifyRouter.get(
  "/verify-context/:sessionId",
  asyncHandler(async (req, res) => {
    const session = await getSessionForContext(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "unknown_session" });
      return;
    }
    if (session.usable === false) {
      res.json({ status: session.status, usable: false });
      return;
    }
    res.json({ status: "pending", usable: true, ...buildVerificationContext() });
  }),
);

// POST /verify/:sessionId — world mode only. Verifies the IDKit proof (body) with World,
// then settles the order. The proof payload is forwarded to World verbatim.
verifyRouter.post(
  "/verify/:sessionId",
  asyncHandler(async (req, res) => {
    if (verificationMode() !== VERIFICATION_MODE.world) {
      res.status(409).json({ error: "world_mode_only" });
      return;
    }

    const valid = await verifyWorldProof(req.body);
    if (!valid) {
      res.status(401).json({ error: "proof_invalid" });
      return;
    }

    const outcome = await settleVerifiedSession(req.params.sessionId);
    if (outcome === "not_found" || outcome === "order_missing") {
      res.status(404).json({ error: outcome });
      return;
    }
    if (outcome === "expired") {
      res.status(410).json({ error: "session_expired" });
      return;
    }
    // "verified" or "already" — the purchase is settled.
    res.json({ status: "completed" });
  }),
);
