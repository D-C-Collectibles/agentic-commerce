// #checkout-route — see .purpose in this directory. Implements $checkout-flow.

import { Router } from "express";

export const checkoutRouter = Router();

// TODO ^authenticated: require a valid session before this handler runs.
// TODO ^checkout-authorized: recompute price server-side, check per-user
// spending caps, and require an explicit !checkout-confirmed signal from the
// user for amounts above the auto-approve threshold — before calling
// transferUsdc() in #wallet-service.
checkoutRouter.post("/checkout", async (_req, res) => {
  res.status(501).json({ error: "not implemented" });
});
