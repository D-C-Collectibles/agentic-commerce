import "dotenv/config";
import cors from "cors";
import express from "express";
import { asyncHandler } from "./async-handler.js";
import { pool } from "./db.js";
import { agentRouter } from "./routes/agent.js";
import { authRouter } from "./routes/auth.js";
import { checkoutRouter } from "./routes/checkout.js";
import { productsRouter } from "./routes/products.js";
import { verifyRouter } from "./routes/verify.js";
import { webhooksRouter } from "./routes/webhooks.js";

const app = express();
// The storefront SPA is served from a different origin (Vite dev server / static host).
// ponytail: reflect a single configured origin, or allow all in the demo default.
// Use || (not ??) so an empty CLIENT_ORIGIN= in .env also falls through to allow-all,
// otherwise cors is told to match origin "" and sends no Access-Control-Allow-Origin.
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }));
app.use(
  express.json({
    verify: (req: express.Request, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(authRouter);
app.use(productsRouter);
app.use(checkoutRouter);
app.use(agentRouter);
app.use(verifyRouter);
app.use(webhooksRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get(
  "/health/db",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query("select now()");
    res.json({ ok: true, now: rows[0].now });
  }),
);

// Central error handler — async route throws (bad config, DB/Circle failures) are
// forwarded here by asyncHandler and returned as a clean 500 instead of hanging.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_error" });
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`listening on :${port}`));
