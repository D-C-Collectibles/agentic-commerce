// #checkout-route — see .purpose. The human (in-browser) leg of $checkout-flow:
// ^authenticated (a user session, not an agent grant) + ^checkout-authorized (spend
// caps and an explicit confirm above the auto-approve threshold), then an immediate
// charge via #payment-service. The agent leg lives in #agent-route and instead
// requires ^personhood-verified.

import { Router } from "express";
import { asyncHandler } from "../async-handler.js";
import { GRANT_AUDIENCE, verifyBearer } from "../services/auth.js";
import {
  AUTO_APPROVE_THRESHOLD_USDC,
  createOrder,
  ensureOrderSchema,
  evaluateSpendPolicy,
  getProductPrice,
  markOrderPaid,
  parseCheckoutInput,
} from "../services/orders.js";
import { executePayment, merchantPayoutAddress } from "../services/payment.js";

export const checkoutRouter = Router();

checkoutRouter.post(
  "/checkout",
  asyncHandler(async (req, res) => {
    // ^authenticated — human session only. An agent grant must use /agent/checkout
    // (which forces the personhood check); it is rejected here so it can't bypass it.
    const user = verifyBearer(req.header("authorization"), GRANT_AUDIENCE.user);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const input = parseCheckoutInput(req.body);
    if (!input) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const checkoutConfirmed = (req.body ?? {}).checkoutConfirmed === true;

    await ensureOrderSchema();

    const price = await getProductPrice(input.sku);
    if (price === null) {
      res.status(404).json({ error: "unknown_sku" });
      return;
    }
    const amountUsdc = price * input.quantity;

    // ^checkout-authorized: spend caps
    const policy = await evaluateSpendPolicy(user.userId, amountUsdc);
    if (!policy.ok) {
      res.status(402).json({
        error: "spend_cap_exceeded",
        cap: policy.cap,
        limit: policy.limitUsdc?.toFixed(2),
        amountUsdc: amountUsdc.toFixed(2),
      });
      return;
    }

    // ^checkout-authorized: explicit confirmation above the auto-approve threshold
    if (amountUsdc > AUTO_APPROVE_THRESHOLD_USDC && !checkoutConfirmed) {
      res.status(428).json({
        error: "confirmation_required",
        amountUsdc: amountUsdc.toFixed(2),
        threshold: AUTO_APPROVE_THRESHOLD_USDC.toFixed(2),
      });
      return;
    }

    const destinationAddress = merchantPayoutAddress();
    const { orderId, idempotencyKey } = await createOrder({
      userId: user.userId,
      sku: input.sku,
      quantity: input.quantity,
      amountUsdc,
      destinationAddress,
    });
    const payment = await executePayment({
      userId: user.userId,
      destinationAddress,
      amountUsdc,
      idempotencyKey,
    });
    await markOrderPaid(orderId, payment.transactionId, payment.orderStatus);

    // !payment-submitted
    res.json({
      orderId,
      circleTransactionId: payment.transactionId,
      amountUsdc: amountUsdc.toFixed(2),
      state: payment.state,
    });
  }),
);
