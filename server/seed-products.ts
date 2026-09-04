// ponytail: hardcoded demo catalog, not a CSV importer — fine at hackathon scale.
import "dotenv/config";
import { pool } from "./src/db.js";

const PRODUCTS = [
  { sku: "widget-1", name: "Widget", price_usdc: "5.00" },
  { sku: "gadget-1", name: "Gadget", price_usdc: "25.00" },
  { sku: "gizmo-1", name: "Gizmo", price_usdc: "45.00" },
];

async function main() {
  await pool.query(`
    create table if not exists products (
      sku text primary key,
      name text not null,
      price_usdc numeric(12,2) not null
    );
  `);

  for (const p of PRODUCTS) {
    await pool.query(
      `insert into products (sku, name, price_usdc) values ($1, $2, $3)
       on conflict (sku) do update set name = excluded.name, price_usdc = excluded.price_usdc`,
      [p.sku, p.name, p.price_usdc],
    );
  }

  console.log(`seeded ${PRODUCTS.length} products`);
  await pool.end();
}

main();
