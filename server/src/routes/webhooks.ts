// #circle-webhook-route — see .purpose in this directory. Implements the
// webhook leg of $checkout-flow (!payment-confirmed / !payment-failed).

import { Router } from "express";

export const webhooksRouter = Router();

// TODO ^webhook-signature-verified: verify X-Circle-Signature / X-Circle-Key-Id
// before trusting the payload. This is the source of truth for terminal
// transaction state — update the order idempotently by Circle transaction id.
webhooksRouter.post("/webhooks/circle", async (_req, res) => {
  res.status(501).json({ error: "not implemented" });
});
