// #agent-route — the agentic-commerce entry points. A merchant MCP on the user's
// machine holds an agent grant and calls these on the user's behalf. Implements
// $agent-purchase-flow:
//   POST /agent/grant                    — human authorizes an agent (mints the grant +
//                                          its #agent-grants-service scoped policy row)
//   POST /agent/grant/:grantId/revoke    — human revokes a grant early
//   POST /agent/checkout                 — agent initiates a purchase (does NOT charge;
//                                          returns a ^personhood-verified handoff)
//   GET  /agent/purchase/:orderId        — poll the outcome
// Emits !agent-grant-issued, !agent-grant-revoked, !agent-purchase-initiated.

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { log } from "@a-company/paradigm-logger";
import { asyncHandler } from "../async-handler.js";
import {
  agentGrantSessionTtlSeconds,
  getAgentGrantByJti,
  recordAgentGrant,
  revokeAgentGrant,
} from "../services/agent-grants.js";
import { GRANT_AUDIENCE, signAgentGrant, verifyBearer } from "../services/auth.js";
import {
  ensureOrderSchema,
  getOrder,
  getProductPrice,
  ORDER_STATUS,
  parseCheckoutInput,
  parseClientIdempotencyKey,
  reserveOrder,
  type OrderStatus,
} from "../services/orders.js";
import { merchantPayoutAddress } from "../services/payment.js";
import {
  createSession,
  ensureVerificationSchema,
  getLatestSessionForOrder,
  VERIFICATION_STATUS,
  type VerificationSession,
} from "../services/verification.js";
import { VERIFICATION_MODE, verificationMode } from "../services/worldid.js";

export const agentRouter = Router();

// The human-facing verification link. In world mode it points at the SPA (which renders
// the World ID Selfie Check widget); in mock mode at the server's own click-through page.
// Both are configurable so a tunnel (e.g. ngrok) works when the human is on another device.
function verificationUrl(sessionId: string): string {
  if (verificationMode() === VERIFICATION_MODE.world) {
    const appBase = process.env.APP_BASE_URL ?? "http://127.0.0.1:5173";
    return `${appBase}/verify/${sessionId}`;
  }
  const apiBase = process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  return `${apiBase}/verify/${sessionId}`;
}

// Agent-facing purchase status, derived from the order + its verification session.
function derivePurchaseStatus(orderStatus: OrderStatus, session: VerificationSession | null): string {
  if (orderStatus === ORDER_STATUS.confirmed) return "completed";
  if (orderStatus === ORDER_STATUS.submitted) return "submitted"; // real Circle: awaiting webhook
  if (
    orderStatus === ORDER_STATUS.failed ||
    orderStatus === ORDER_STATUS.denied ||
    orderStatus === ORDER_STATUS.cancelled
  ) {
    return orderStatus;
  }
  // Order still pending — the state lives in the verification session.
  if (!session) return "pending_verification";
  if (session.status === VERIFICATION_STATUS.verified) return "verifying_payment";
  if (session.status === VERIFICATION_STATUS.pending && new Date(session.expires_at).getTime() >= Date.now()) {
    return "pending_verification";
  }
  return "expired";
}

// POST /agent/grant — a signed-in human authorizes an agent. Requires a user token
// (not an agent grant), so an agent can't mint fresh grants for itself. Mints both the
// long-lived (365d) JWT the agent holds and a much shorter-lived #agent-grants-service
// scoped policy row (destination/per-tx/rolling caps + its own TTL) checked at
// settlement time (#verify-route) — see .paradigm/specs/wallet-checkout.md
// "Session-scoped agent grants". This is the app-level "session key" for the grant;
// it is NOT an on-chain session key.
agentRouter.post(
  "/agent/grant",
  asyncHandler(async (req, res) => {
    const user = verifyBearer(req.header("authorization"), GRANT_AUDIENCE.user);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const grantJti = randomUUID();
    const agentGrant = signAgentGrant({ id: user.userId, email: user.email }, grantJti);
    const scopedGrant = await recordAgentGrant({
      userId: user.userId,
      grantJti,
      destinationAddress: merchantPayoutAddress(),
    });
    // !agent-grant-issued
    res.status(201).json({
      agentGrant,
      grantId: scopedGrant.id,
      scopedPolicyExpiresAt: scopedGrant.expires_at,
      note:
        "Store this in your merchant MCP config. It lets an agent browse and initiate " +
        "purchases on your behalf; every purchase still requires a live personhood (selfie) check. " +
        `Its spend-policy scope expires in ${agentGrantSessionTtlSeconds()}s and must be re-minted ` +
        "after that (mint a new grant) — even though the token itself lasts longer. " +
        `Use POST /agent/grant/${scopedGrant.id}/revoke to cut it off early.`,
    });
  }),
);

// POST /agent/grant/:grantId/revoke — a signed-in human cuts off a leaked/compromised
// agent grant's spend-policy scope early, without waiting for its TTL or its (much
// longer) JWT expiry. Requires a user token, scoped to the grant's own owner — never
// reveals whether a grantId belongs to someone else's account.
agentRouter.post(
  "/agent/grant/:grantId/revoke",
  asyncHandler(async (req, res) => {
    const user = verifyBearer(req.header("authorization"), GRANT_AUDIENCE.user);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const revoked = await revokeAgentGrant(req.params.grantId, user.userId);
    if (!revoked) {
      res.status(404).json({ error: "unknown_grant" });
      return;
    }
    log.component("#agent-route").info("Agent grant revoked", { grantId: revoked.id, userId: user.userId });
    // !agent-grant-revoked
    res.json({ grantId: revoked.id, revokedAt: revoked.revoked_at });
  }),
);

// POST /agent/checkout — agent initiates a purchase. Never charges here: it creates a
// pending order + verification session and returns the handoff. ^personhood-verified
// (the selfie) must be completed via the returned URL before any money moves.
agentRouter.post(
  "/agent/checkout",
  asyncHandler(async (req, res) => {
    const agent = verifyBearer(req.header("authorization"), GRANT_AUDIENCE.agent);
    if (!agent) {
      res.status(401).json({ error: "agent_grant_required" });
      return;
    }

    const input = parseCheckoutInput(req.body);
    if (!input) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    await ensureOrderSchema();
    await ensureVerificationSchema();

    const price = await getProductPrice(input.sku);
    if (price === null) {
      res.status(404).json({ error: "unknown_sku" });
      return;
    }
    const amountUsdc = price * input.quantity;
    const clientIdempotencyKey = parseClientIdempotencyKey(req.body);

    // Resolve this grant's #agent-grants-service scoped-policy row (if any — a grant
    // minted before this feature existed has none, and simply isn't scoped; see
    // .paradigm/specs/wallet-checkout.md "Session-scoped agent grants"). Rejecting an
    // already-revoked/expired grant here (rather than only at settlement) avoids
    // reserving an order that could never settle; #verify-route's settleVerifiedSession
    // re-checks the same grant at charge time regardless, since it can be revoked in
    // the window between this initiation and the human completing the selfie check.
    const scopedGrant = agent.grantJti ? await getAgentGrantByJti(agent.grantJti) : null;
    if (scopedGrant?.revoked_at) {
      res.status(403).json({ error: "grant_revoked" });
      return;
    }
    if (scopedGrant && new Date(scopedGrant.expires_at).getTime() <= Date.now()) {
      res.status(403).json({ error: "grant_expired" });
      return;
    }

    // Dedup + ^checkout-authorized (spend caps, atomically) + order insert — shared
    // with #checkout-route via #orders-service.reserveOrder so both legs enforce
    // identical rules (see .paradigm/specs/wallet-checkout.md "Hardening").
    const reserved = await reserveOrder({
      userId: agent.userId,
      sku: input.sku,
      quantity: input.quantity,
      amountUsdc,
      destinationAddress: merchantPayoutAddress(),
      clientIdempotencyKey,
      agentGrantId: scopedGrant?.id,
    });

    if (!reserved.policy.ok) {
      res.status(402).json({
        error: reserved.policy.cap === "circle_policy" ? "circle_policy_denied" : "spend_cap_exceeded",
        cap: reserved.policy.cap,
        limit: reserved.policy.limitUsdc?.toFixed(2),
        amountUsdc: amountUsdc.toFixed(2),
      });
      return;
    }

    const order = reserved.order!;

    // A fresh order gets a fresh verification session. A deduped resubmission reuses
    // an existing usable (pending, unexpired) session instead of minting a second one
    // for the same order; only mints a new one if the prior session expired.
    let sessionId: string;
    if (reserved.isNew) {
      sessionId = await createSession(order.id, agent.userId);
    } else {
      log.component("#agent-route").info("Agent checkout resubmission deduped", { orderId: order.id });
      const existingSession = await getLatestSessionForOrder(order.id);
      const reusable =
        existingSession?.status === VERIFICATION_STATUS.pending &&
        new Date(existingSession.expires_at).getTime() > Date.now();
      sessionId = reusable ? existingSession!.id : await createSession(order.id, agent.userId);
    }

    // !agent-purchase-initiated — the charge waits for ^personhood-verified.
    res.status(202).json({
      orderId: order.id,
      status: "verification_required",
      amountUsdc: order.amount_usdc,
      verification: {
        sessionId,
        url: verificationUrl(sessionId),
        instructions:
          "A human must complete the World ID Selfie Check at this URL to authorize the purchase.",
      },
    });
  }),
);

// GET /agent/purchase/:orderId — poll the outcome of an initiated purchase.
agentRouter.get(
  "/agent/purchase/:orderId",
  asyncHandler(async (req, res) => {
    const agent = verifyBearer(req.header("authorization"), GRANT_AUDIENCE.agent);
    if (!agent) {
      res.status(401).json({ error: "agent_grant_required" });
      return;
    }

    const order = await getOrder(req.params.orderId);
    if (!order || order.user_id !== agent.userId) {
      res.status(404).json({ error: "unknown_order" });
      return;
    }

    const session = await getLatestSessionForOrder(order.id);
    res.json({
      orderId: order.id,
      amountUsdc: order.amount_usdc,
      status: derivePurchaseStatus(order.status, session),
    });
  }),
);
