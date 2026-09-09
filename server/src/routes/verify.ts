// #verify-route — the human-facing ^personhood-verified checkpoint for agent-initiated
// purchases, opened from a link/QR the agent surfaced. Two modes (see #worldid-service):
//   - mock:  GET /verify/:sessionId renders a click-through page that settles the order.
//   - world: the SPA renders the World ID Selfie Check widget, reads GET
//            /verify-context/:sessionId for the RP signature, and POSTs the proof to
//            POST /verify/:sessionId, which verifies it with World before settling.
// Settlement is shared and single-use either way. For agent-initiated orders only, it
// also enforces ^grant-scope-valid (#agent-grants-service) — the order's originating
// grant's own scoped destination/per-tx/rolling caps and expiry/revocation — in
// addition to, not instead of, #orders-service's app-wide spend caps. Human orders have
// no agent_grant_id and are unaffected. Emits !personhood-verified, !purchase-completed.

import { Router } from "express";
import { log } from "@a-company/paradigm-logger";
import { asyncHandler } from "../async-handler.js";
import { evaluateGrantScope, getAgentGrantById } from "../services/agent-grants.js";
import { getEnrolledDevice, resolveLedgerGate } from "../services/ledger-confirm.js";
import { getOrder, markOrderFailed, markOrderPaid, ORDER_STATUS } from "../services/orders.js";
import { executePayment } from "../services/payment.js";
import { getSession, getSessionForContext, markSessionVerified } from "../services/verification.js";
import {
  buildVerificationContext,
  VERIFICATION_MODE,
  verificationMode,
  verifyWorldProof,
} from "../services/worldid.js";

export const verifyRouter = Router();

type SettleOutcome =
  | "verified"
  | "already"
  | "expired"
  | "not_found"
  | "order_missing"
  | "payment_failed"
  | "grant_denied"
  | "pending_ledger_confirmation"
  | "ledger_denied";

// Marks the session verified (atomically, so the PERSONHOOD step runs once) and settles
// the order via #payment-service. Shared by the mock GET and the world POST so both
// charge exactly once. Once the session is verified, this may still be called again for
// the same sessionId (the human re-visiting the same link, or a caller retrying) — that
// retry is what lets a ^ledger-confirmed order that was still pending on its first
// settlement attempt get charged once the approval lands, without re-running personhood.
async function settleVerifiedSession(sessionId: string): Promise<SettleOutcome> {
  const result = await markSessionVerified(sessionId);
  if (result.outcome === "not_found" || result.outcome === "expired") return result.outcome;

  const session = result.session!;
  const order = await getOrder(session.order_id);
  if (!order) return "order_missing";

  if (order.status !== ORDER_STATUS.pending) {
    // Already settled (or already failed/denied) by an earlier call for this same
    // session/order — report that outcome again instead of re-running the grant/ledger
    // checks or attempting a second payment.
    if (order.status === ORDER_STATUS.failed || order.status === ORDER_STATUS.denied) return "payment_failed";
    return "already";
  }

  // ^grant-scope-valid: the app-level "session key" check. Only applies to
  // agent-initiated orders (agent_grant_id set); human orders skip this entirely. Runs
  // here — at the moment of charging, not just at /agent/checkout initiation — so a
  // grant revoked while the human was completing the selfie check still blocks money
  // from moving. Denial marks the order failed rather than leaving it pending, the same
  // as a payment-execution failure below.
  if (order.agent_grant_id) {
    const grant = await getAgentGrantById(order.agent_grant_id);
    const scope = grant
      ? await evaluateGrantScope(grant, order)
      : { ok: false as const, reason: "grant_not_found" as const };
    if (!scope.ok) {
      await markOrderFailed(order.id, `grant_scope_denied:${scope.reason}`);
      log.component("#verify-route").error("Agent purchase rejected: grant scope check failed", {
        orderId: order.id,
        reason: scope.reason,
      });
      return "grant_denied";
    }
  }

  // ^ledger-confirmed: runs ALONGSIDE ^grant-scope-valid and personhood verification —
  // all must pass before executePayment() is ever called. Only applies to orders whose
  // user has an enrolled Ledger device (#ledger-confirm-service); everyone else is
  // unaffected. A still-pending approval surfaces "pending_ledger_confirmation" the same
  // way an unverified session surfaces "pending_verification" elsewhere (#agent-route) —
  // the order stays 'pending' and this same link can be revisited once the human
  // approves on their device. A denied/timed-out approval fails the order outright.
  const ledgerDevice = await getEnrolledDevice(session.user_id);
  if (ledgerDevice) {
    const gate = await resolveLedgerGate(order);
    if (gate.status === "denied") {
      await markOrderFailed(order.id, "ledger_confirmation_denied");
      log.component("#verify-route").error("Agent purchase rejected: Ledger confirmation denied", {
        orderId: order.id,
      });
      return "ledger_denied";
    }
    if (gate.status !== "approved") {
      return "pending_ledger_confirmation";
    }
  }

  try {
    const payment = await executePayment({ order });
    await markOrderPaid(order.id, payment.transactionId, payment.orderStatus);
  } catch (error) {
    // Same hardening as #checkout-route: don't leave the order stuck 'pending' (eating
    // the daily cap + wedging its idempotency key) if executePayment()/transferUsdc()
    // or the markOrderPaid() write throws.
    await markOrderFailed(order.id, (error as Error).message);
    log.component("#verify-route").error("Agent purchase payment failed, order marked failed", {
      orderId: order.id,
      error: (error as Error).message,
    });
    return "payment_failed";
  }
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
    if (outcome === "payment_failed") {
      res
        .status(502)
        .type("html")
        .send(page("Payment failed", "<p>Your identity was verified, but the payment could not be completed. Ask your agent to try again.</p>", "#b00"));
      return;
    }
    if (outcome === "grant_denied") {
      res
        .status(403)
        .type("html")
        .send(
          page(
            "Purchase not authorized",
            "<p>This purchase falls outside the agent grant that started it (revoked, expired, or out of scope). Ask your agent to mint a new grant and try again.</p>",
            "#b00",
          ),
        );
      return;
    }
    if (outcome === "ledger_denied") {
      res
        .status(403)
        .type("html")
        .send(
          page(
            "Purchase not authorized",
            "<p>The Ledger confirmation for this purchase was denied or timed out. Ask your agent to try again.</p>",
            "#b00",
          ),
        );
      return;
    }
    if (outcome === "pending_ledger_confirmation") {
      res
        .status(202)
        .type("html")
        .send(
          page(
            "Waiting for Ledger confirmation",
            "<p>Your identity is verified. Approve this purchase on your enrolled Ledger device, then revisit this page.</p>",
            "#b58a00",
          ),
        );
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
    if (outcome === "payment_failed") {
      res.status(502).json({ error: "payment_failed" });
      return;
    }
    if (outcome === "grant_denied") {
      res.status(403).json({ error: "grant_scope_denied" });
      return;
    }
    if (outcome === "ledger_denied") {
      res.status(403).json({ error: "ledger_confirmation_denied" });
      return;
    }
    if (outcome === "pending_ledger_confirmation") {
      res.status(202).json({ status: "pending_ledger_confirmation" });
      return;
    }
    // "verified" or "already" — the purchase is settled.
    res.json({ status: "completed" });
  }),
);
