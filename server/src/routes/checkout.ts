// #checkout-route — see .purpose. The human (in-browser) leg of $checkout-flow:
// ^authenticated (a user session, not an agent grant) + ^checkout-authorized (spend
// caps and an explicit confirm above the auto-approve threshold), then an immediate
// charge via #payment-service. The agent leg lives in #agent-route and instead
// requires ^personhood-verified.

import { Router } from "express";
import { log } from "@a-company/paradigm-logger";
import { asyncHandler } from "../async-handler.js";
import { GRANT_AUDIENCE, verifyBearer } from "../services/auth.js";
import { getEnrolledDevice, resolveLedgerGate } from "../services/ledger-confirm.js";
import {
  AUTO_APPROVE_THRESHOLD_USDC,
  ensureOrderSchema,
  getProductPrice,
  markOrderFailed,
  markOrderPaid,
  parseCheckoutInput,
  parseClientIdempotencyKey,
  reserveOrder,
} from "../services/orders.js";
import { executePayment, merchantPayoutAddress, type PaymentResult } from "../services/payment.js";

export const checkoutRouter = Router();

checkoutRouter.post(
  "/checkout",
  asyncHandler(async (req, res) => {
    // ^authenticated — human session only. An agent grant must use /agent/checkout
    // (which forces the personhood check); it is rejected here so it can't bypass it.
    const user = verifyBearer(req.header("authorization"), GRANT_AUDIENCE.user);
    if (!user) {
      log.gate("^authenticated").warn("Checkout rejected: missing/invalid user token");
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const input = parseCheckoutInput(req.body);
    if (!input) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const checkoutConfirmed = (req.body ?? {}).checkoutConfirmed === true;
    const clientIdempotencyKey = parseClientIdempotencyKey(req.body);

    await ensureOrderSchema();

    const price = await getProductPrice(input.sku);
    if (price === null) {
      res.status(404).json({ error: "unknown_sku" });
      return;
    }
    const amountUsdc = price * input.quantity;

    // ^ledger-confirmed REPLACES the spoofable checkoutConfirmed boolean above the
    // auto-approve threshold for a user with an enrolled Ledger device — this is a
    // different, not-yet-reserved-order check than resolveLedgerGate() below (which
    // needs the order row to exist), so it's just "does this user even have a device".
    // A user with no enrolled device keeps today's checkoutConfirmed behavior, unchanged.
    const ledgerDevice = await getEnrolledDevice(user.userId);

    // ^checkout-authorized: explicit confirmation above the auto-approve threshold.
    // Checked before touching the orders table — no point reserving an order for a
    // request we're going to bounce with a 428 anyway. Enrolled-device users skip this
    // entirely (checkoutConfirmed is never consulted for them) and are gated by
    // ^ledger-confirmed instead, once the order exists — see below.
    if (amountUsdc > AUTO_APPROVE_THRESHOLD_USDC && !ledgerDevice && !checkoutConfirmed) {
      res.status(428).json({
        error: "confirmation_required",
        amountUsdc: amountUsdc.toFixed(2),
        threshold: AUTO_APPROVE_THRESHOLD_USDC.toFixed(2),
      });
      return;
    }

    const destinationAddress = merchantPayoutAddress();
    // Dedup + ^checkout-authorized (spend caps, atomically) + order insert — see
    // #orders-service.reserveOrder and .paradigm/specs/wallet-checkout.md "Hardening".
    const reserved = await reserveOrder({
      userId: user.userId,
      sku: input.sku,
      quantity: input.quantity,
      amountUsdc,
      destinationAddress,
      clientIdempotencyKey,
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

    if (!reserved.isNew) {
      // Deduped resubmission (double-click, client retry, agent retry): the order
      // already exists — possibly already charged — so report its current state
      // instead of creating a second order and calling transferUsdc()/executePayment()
      // again.
      log.component("#checkout-route").info("Checkout resubmission deduped", { orderId: order.id });
      res.json({
        orderId: order.id,
        circleTransactionId: order.circle_transaction_id,
        amountUsdc: order.amount_usdc,
        state: order.status,
      });
      return;
    }

    // ^ledger-confirmed: for an enrolled-device user above the auto-approve threshold,
    // this REPLACES checkoutConfirmed — requestApproval()/resolveLedgerGate() need the
    // order row to exist (the signed struct binds orderId), so this can only run once
    // reserveOrder() has returned a real order. A rejected/timed-out approval fails the
    // order outright (never left dangling 'pending') rather than falling back to
    // checkoutConfirmed for this user.
    if (amountUsdc > AUTO_APPROVE_THRESHOLD_USDC && ledgerDevice) {
      const gate = await resolveLedgerGate(order);
      if (gate.status === "denied") {
        await markOrderFailed(order.id, "ledger_confirmation_denied");
        res.status(403).json({ error: "ledger_confirmation_denied", orderId: order.id });
        return;
      }
      if (gate.status !== "approved") {
        res.status(428).json({
          error: "ledger_confirmation_required",
          orderId: order.id,
          approvalId: gate.approvalId,
          amountUsdc: amountUsdc.toFixed(2),
        });
        return;
      }
    }

    let payment: PaymentResult;
    try {
      payment = await executePayment({ order });
      await markOrderPaid(order.id, payment.transactionId, payment.orderStatus);
    } catch (error) {
      // executePayment()/transferUsdc() (Circle API error, network blip, missing token
      // balance) or the markOrderPaid() write can throw. Left unhandled, the order
      // reserveOrder() already inserted would stay 'pending' forever — permanently
      // eating into this user's daily spend cap and wedging its idempotency key against
      // a dead order. Mark it failed immediately so both stop, then error out instead of
      // leaving the response hanging.
      await markOrderFailed(order.id, (error as Error).message);
      log.component("#checkout-route").error("Checkout payment failed, order marked failed", {
        orderId: order.id,
        error: (error as Error).message,
      });
      res.status(502).json({ error: "payment_failed", orderId: order.id });
      return;
    }

    // !payment-submitted
    res.json({
      orderId: order.id,
      circleTransactionId: payment.transactionId,
      amountUsdc: amountUsdc.toFixed(2),
      state: payment.state,
    });
  }),
);
