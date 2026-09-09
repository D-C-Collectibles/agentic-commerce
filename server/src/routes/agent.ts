// #agent-route — the agentic-commerce entry points. A merchant MCP on the user's
// machine holds an agent grant and calls these on the user's behalf. Implements
// $agent-purchase-flow:
//   POST /agent/grant            — human authorizes an agent (mints the grant)
//   POST /agent/checkout         — agent initiates a purchase (does NOT charge; returns
//                                  a ^personhood-verified handoff the human must complete)
//   GET  /agent/purchase/:orderId — poll the outcome
// Emits !agent-grant-issued, !agent-purchase-initiated.

import { Router } from "express";
import { asyncHandler } from "../async-handler.js";
import { GRANT_AUDIENCE, signAgentGrant, verifyBearer } from "../services/auth.js";
import {
  createOrder,
  ensureOrderSchema,
  evaluateSpendPolicy,
  getOrder,
  getProductPrice,
  ORDER_STATUS,
  parseCheckoutInput,
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
// (not an agent grant), so an agent can't mint fresh grants for itself.
agentRouter.post(
  "/agent/grant",
  (req, res) => {
    const user = verifyBearer(req.header("authorization"), GRANT_AUDIENCE.user);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const agentGrant = signAgentGrant({ id: user.userId, email: user.email });
    // !agent-grant-issued
    res.status(201).json({
      agentGrant,
      note:
        "Store this in your merchant MCP config. It lets an agent browse and initiate " +
        "purchases on your behalf; every purchase still requires a live personhood (selfie) check.",
    });
  },
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

    const policy = await evaluateSpendPolicy(agent.userId, amountUsdc);
    if (!policy.ok) {
      res.status(402).json({
        error: "spend_cap_exceeded",
        cap: policy.cap,
        limit: policy.limitUsdc?.toFixed(2),
        amountUsdc: amountUsdc.toFixed(2),
      });
      return;
    }

    const { orderId } = await createOrder({
      userId: agent.userId,
      sku: input.sku,
      quantity: input.quantity,
      amountUsdc,
      destinationAddress: merchantPayoutAddress(),
    });
    const sessionId = await createSession(orderId, agent.userId);

    // !agent-purchase-initiated — the charge waits for ^personhood-verified.
    res.status(202).json({
      orderId,
      status: "verification_required",
      amountUsdc: amountUsdc.toFixed(2),
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
