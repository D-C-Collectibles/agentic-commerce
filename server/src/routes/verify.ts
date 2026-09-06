// #verify-route — the human-facing ^personhood-verified checkpoint for agent-initiated
// purchases. GET /verify/:sessionId is opened by the human (from a link/QR the agent
// surfaced). In this MVP it is a MOCK: loading the page marks the session verified and
// settles the order. This stands in for the World ID Selfie Check widget + proof
// verification, which will replace the body of this handler (calling markSessionVerified
// only after a valid World ID proof). Emits !personhood-verified, !purchase-completed.

import { Router } from "express";
import { asyncHandler } from "../async-handler.js";
import { getOrder, markOrderPaid } from "../services/orders.js";
import { executePayment } from "../services/payment.js";
import { markSessionVerified } from "../services/verification.js";

export const verifyRouter = Router();

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

verifyRouter.get(
  "/verify/:sessionId",
  asyncHandler(async (req, res) => {
    const result = await markSessionVerified(req.params.sessionId);

    if (result.outcome === "not_found") {
      res.status(404).type("html").send(page("Invalid link", "<p>This verification link is not valid.</p>", "#b00"));
      return;
    }
    if (result.outcome === "expired") {
      res
        .status(410)
        .type("html")
        .send(page("Link expired", "<p>This verification link has expired. Ask your agent to start the purchase again.</p>", "#b00"));
      return;
    }
    if (result.outcome === "already") {
      res
        .type("html")
        .send(page("Already verified", "<p>This purchase was already verified. You can return to your agent.</p>"));
      return;
    }

    // outcome === "verified": settle the order exactly once (this branch runs once).
    const session = result.session!;
    const order = await getOrder(session.order_id);
    if (!order) {
      res.status(404).type("html").send(page("Order missing", "<p>The order for this verification no longer exists.</p>", "#b00"));
      return;
    }

    const payment = await executePayment({
      userId: session.user_id,
      destinationAddress: order.destination_address,
      amountUsdc: Number(order.amount_usdc),
      idempotencyKey: order.idempotency_key,
    });
    await markOrderPaid(order.id, payment.transactionId, payment.orderStatus);

    // !personhood-verified / !purchase-completed
    res
      .type("html")
      .send(
        page(
          "Verified ✓",
          `<p class="badge">✅</p><p>Purchase of <strong>$${Number(order.amount_usdc).toFixed(2)} USDC</strong> authorized.</p><p>You can return to your agent.</p>`,
          "#0a7d33",
        ),
      );
  }),
);
