import "dotenv/config";
import cors from "cors";
import express from "express";
import { pool } from "./db.js";
import { authRouter } from "./routes/auth.js";
import { checkoutRouter } from "./routes/checkout.js";
import { productsRouter } from "./routes/products.js";
import { webhooksRouter } from "./routes/webhooks.js";

const app = express();
// The storefront SPA is served from a different origin (Vite dev server / static host).
// ponytail: reflect a single configured origin, or allow all in the demo default.
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? true }));
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
app.use(webhooksRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/health/db", async (_req, res) => {
  const { rows } = await pool.query("select now()");
  res.json({ ok: true, now: rows[0].now });
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`listening on :${port}`));
