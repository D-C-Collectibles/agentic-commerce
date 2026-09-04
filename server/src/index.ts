import "dotenv/config";
import express from "express";
import { pool } from "./db.js";
import { checkoutRouter } from "./routes/checkout.js";
import { webhooksRouter } from "./routes/webhooks.js";

const app = express();
app.use(express.json());
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
