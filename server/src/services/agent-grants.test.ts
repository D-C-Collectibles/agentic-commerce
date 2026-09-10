// Integration tests for #agent-grants-service's "session key" scope check: per-tx/rolling
// caps, destination match, expiry, and revocation — plus proof that a human (non-agent)
// order, which never has an agent_grant_id, is completely unaffected by any of this.
// Runs against the real dev Postgres in DATABASE_URL, matching the pattern in
// #orders-service's orders.test.ts (no DB mocking layer exists yet in this repo).

import { randomUUID } from "node:crypto";
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../db.js";
import {
  evaluateGrantScope,
  getAgentGrantById,
  recordAgentGrant,
  revokeAgentGrant,
  type AgentGrantRow,
} from "./agent-grants.js";
import { ensureOrderSchema, reserveOrder } from "./orders.js";

describe("#agent-grants-service", () => {
  const sku = `test-grant-sku-${randomUUID()}`;
  const destinationAddress = "TEST_MERCHANT";

  beforeAll(async () => {
    await ensureOrderSchema();
    await pool.query(
      "insert into products (sku, name, price_usdc) values ($1, $2, $3)",
      [sku, "Test Grant Product", "10.00"],
    );
  });

  afterAll(async () => {
    await pool.query("delete from products where sku = $1", [sku]);
    await pool.end();
  });

  async function freshGrant(userId: string): Promise<AgentGrantRow> {
    return recordAgentGrant({ userId, grantJti: randomUUID(), destinationAddress });
  }

  it("allows an order within the grant's destination, per-tx cap, and rolling cap", async () => {
    const userId = `test-grant-user-${randomUUID()}`;
    const grant = await freshGrant(userId);
    try {
      const scope = await evaluateGrantScope(grant, { destination_address: destinationAddress, amount_usdc: "10.00" });
      expect(scope.ok).toBe(true);
    } finally {
      await pool.query("delete from agent_grants where id = $1", [grant.id]);
    }
  });

  it("denies an order to a destination other than the grant's own", async () => {
    const userId = `test-grant-user-${randomUUID()}`;
    const grant = await freshGrant(userId);
    try {
      const scope = await evaluateGrantScope(grant, { destination_address: "SOME_OTHER_ADDRESS", amount_usdc: "10.00" });
      expect(scope.ok).toBe(false);
      expect(scope.reason).toBe("destination_mismatch");
    } finally {
      await pool.query("delete from agent_grants where id = $1", [grant.id]);
    }
  });

  it("denies an order above the grant's per-tx cap", async () => {
    const userId = `test-grant-user-${randomUUID()}`;
    const grant = await freshGrant(userId);
    try {
      const overCap = (Number(grant.per_tx_cap_usdc) + 1).toFixed(2);
      const scope = await evaluateGrantScope(grant, { destination_address: destinationAddress, amount_usdc: overCap });
      expect(scope.ok).toBe(false);
      expect(scope.reason).toBe("per_tx_cap");
    } finally {
      await pool.query("delete from agent_grants where id = $1", [grant.id]);
    }
  });

  it("denies an order once the grant's own already-reserved orders exceed its rolling cap", async () => {
    const userId = `test-grant-user-${randomUUID()}`;
    const grant = await freshGrant(userId);
    try {
      // Tighten this grant's rolling cap (independent of #orders-service's app-wide
      // daily cap, which reserveOrder() would otherwise also enforce and which isn't
      // what this test is about) and insert already-reserved orders scoped to this
      // grant directly, simulating prior purchases that already count toward it —
      // exactly what a real order does once #agent-route.reserveOrder() tags it with
      // this grant's id.
      await pool.query("update agent_grants set rolling_cap_usdc = $1 where id = $2", ["50.00", grant.id]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await pool.query(
          `insert into orders (user_id, sku, quantity, amount_usdc, destination_address, idempotency_key, agent_grant_id, status)
           values ($1, $2, 1, '40.00', $3, $4, $5, 'submitted')`,
          [userId, sku, destinationAddress, `test-grant-idem-${randomUUID()}`, grant.id],
        );
      }

      const tightened = await getAgentGrantById(grant.id);
      const scope = await evaluateGrantScope(tightened!, { destination_address: destinationAddress, amount_usdc: "10.00" });
      expect(scope.ok).toBe(false);
      expect(scope.reason).toBe("rolling_cap");
    } finally {
      await pool.query("delete from orders where user_id = $1", [userId]);
      await pool.query("delete from agent_grants where id = $1", [grant.id]);
    }
  });

  it("denies an order once the grant has expired", async () => {
    const userId = `test-grant-user-${randomUUID()}`;
    const grant = await freshGrant(userId);
    try {
      await pool.query("update agent_grants set expires_at = now() - interval '1 minute' where id = $1", [grant.id]);
      const expired = await getAgentGrantById(grant.id);
      const scope = await evaluateGrantScope(expired!, { destination_address: destinationAddress, amount_usdc: "5.00" });
      expect(scope.ok).toBe(false);
      expect(scope.reason).toBe("grant_expired");
    } finally {
      await pool.query("delete from agent_grants where id = $1", [grant.id]);
    }
  });

  it("denies an order once the grant is revoked, and revocation is scoped to its own owner", async () => {
    const userId = `test-grant-user-${randomUUID()}`;
    const otherUserId = `test-grant-other-user-${randomUUID()}`;
    const grant = await freshGrant(userId);
    try {
      const revokedByWrongOwner = await revokeAgentGrant(grant.id, otherUserId);
      expect(revokedByWrongOwner).toBeNull();

      const stillActive = await getAgentGrantById(grant.id);
      expect(stillActive?.revoked_at).toBeNull();

      const revoked = await revokeAgentGrant(grant.id, userId);
      expect(revoked?.revoked_at).not.toBeNull();

      // Idempotent: revoking again succeeds and keeps the original revoked_at.
      const revokedAgain = await revokeAgentGrant(grant.id, userId);
      expect(new Date(revokedAgain!.revoked_at!).getTime()).toBe(new Date(revoked!.revoked_at!).getTime());

      const scope = await evaluateGrantScope(revoked!, { destination_address: destinationAddress, amount_usdc: "5.00" });
      expect(scope.ok).toBe(false);
      expect(scope.reason).toBe("grant_revoked");
    } finally {
      await pool.query("delete from agent_grants where id = $1", [grant.id]);
    }
  });

  it("leaves a human (non-agent) order's agent_grant_id null and does not require a grant at all", async () => {
    const userId = `test-human-user-${randomUUID()}`;
    try {
      const reserved = await reserveOrder({
        userId,
        sku,
        quantity: 1,
        amountUsdc: 5,
        destinationAddress,
        clientIdempotencyKey: randomUUID(),
        // No agentGrantId — mirrors #checkout-route, which never sets one.
      });
      expect(reserved.isNew).toBe(true);
      expect(reserved.order?.agent_grant_id).toBeNull();
    } finally {
      await pool.query("delete from orders where user_id = $1", [userId]);
    }
  });
});
