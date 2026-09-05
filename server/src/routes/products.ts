// #products-route — see .purpose in this directory.
//
// Public catalog read for the storefront. No auth: browsing is anonymous; the
// ^authenticated gate only applies at /checkout. Prices are returned as strings
// (Postgres numeric) so the client controls formatting/rounding, never float math.

import { Router } from "express";
import { pool } from "../db.js";

export const productsRouter = Router();

productsRouter.get("/products", async (_req, res) => {
  const { rows } = await pool.query<{ sku: string; name: string; price_usdc: string }>(
    "select sku, name, price_usdc from products order by price_usdc asc",
  );
  res.json({ products: rows });
});
