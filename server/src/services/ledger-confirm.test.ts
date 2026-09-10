// Tests for #ledger-confirm-service: the approval lifecycle (request -> approve ->
// verify matches), and the failure modes a signed EIP-712 approval must reject (wrong
// signer, expired, already-resolved/replayed, tampered order fields). Uses a real
// `ethers.Wallet` to produce genuine signatures (no mocking of ethers itself) against
// the real dev Postgres in DATABASE_URL, matching the integration-test pattern in
// #orders-service's orders.test.ts / #agent-grants-service's agent-grants.test.ts (no
// DB mocking layer exists yet in this repo).

import { randomUUID } from "node:crypto";
import "dotenv/config";
import { Wallet } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../db.js";
import {
  buildApprovalTypedData,
  enrollDevice,
  getApprovalForOrder,
  requestApproval,
  verifyApproval,
  type ApprovalMessage,
} from "./ledger-confirm.js";
import { LedgerConfirmationRequiredError, executePayment } from "./payment.js";
import { ensureOrderSchema, reserveOrder, type OrderRow } from "./orders.js";

async function signApproval(wallet: Wallet, message: ApprovalMessage): Promise<string> {
  const { domain, types } = buildApprovalTypedData(message);
  return wallet.signTypedData(domain, types, message);
}

describe("#ledger-confirm-service", () => {
  const sku = `test-ledger-sku-${randomUUID()}`;
  const destinationAddress = "TEST_MERCHANT";

  beforeAll(async () => {
    await ensureOrderSchema();
    await pool.query(
      "insert into products (sku, name, price_usdc) values ($1, $2, $3)",
      [sku, "Test Ledger Product", "25.00"],
    );
  });

  afterAll(async () => {
    await pool.query("delete from products where sku = $1", [sku]);
    await pool.end();
  });

  async function freshOrder(userId: string): Promise<OrderRow> {
    const reserved = await reserveOrder({
      userId,
      sku,
      quantity: 1,
      amountUsdc: 25,
      destinationAddress,
      clientIdempotencyKey: randomUUID(),
    });
    return reserved.order!;
  }

  async function cleanup(userId: string, orderId: string) {
    await pool.query("delete from ledger_approvals where order_id = $1", [orderId]);
    await pool.query("delete from orders where id = $1", [orderId]);
    await pool.query("delete from ledger_devices where user_id = $1", [userId]);
  }

  it("approves and verifies a correctly-signed approval, matching the stored order snapshot", async () => {
    const userId = `test-ledger-user-${randomUUID()}`;
    const device = Wallet.createRandom();
    await enrollDevice(userId, device.address);
    const order = await freshOrder(userId);
    try {
      const approval = await requestApproval(order);
      expect(approval.status).toBe("pending");
      expect(approval.order_snapshot.orderId).toBe(order.id);
      expect(approval.order_snapshot.amountUsdc).toBe(order.amount_usdc);
      expect(approval.order_snapshot.destinationAddress).toBe(order.destination_address);

      const signature = await signApproval(device, approval.order_snapshot);
      const outcome = await verifyApproval(approval.id, device.address, signature);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.approval.status).toBe("approved");
      }

      const stored = await getApprovalForOrder(order.id);
      expect(stored?.status).toBe("approved");
    } finally {
      await cleanup(userId, order.id);
    }
  });

  it("reuses the same approval row on a repeated requestApproval() call for the same order", async () => {
    const userId = `test-ledger-user-${randomUUID()}`;
    const device = Wallet.createRandom();
    await enrollDevice(userId, device.address);
    const order = await freshOrder(userId);
    try {
      const first = await requestApproval(order);
      const second = await requestApproval(order);
      expect(second.id).toBe(first.id);
      expect(second.nonce).toBe(first.nonce);
    } finally {
      await cleanup(userId, order.id);
    }
  });

  it("rejects a signature from a signer other than the enrolled device", async () => {
    const userId = `test-ledger-user-${randomUUID()}`;
    const device = Wallet.createRandom();
    const impostor = Wallet.createRandom();
    await enrollDevice(userId, device.address);
    const order = await freshOrder(userId);
    try {
      const approval = await requestApproval(order);
      const signature = await signApproval(impostor, approval.order_snapshot);
      const outcome = await verifyApproval(approval.id, impostor.address, signature);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe("signer_mismatch");

      const stored = await getApprovalForOrder(order.id);
      expect(stored?.status).toBe("pending");
    } finally {
      await cleanup(userId, order.id);
    }
  });

  it("rejects an expired approval", async () => {
    const userId = `test-ledger-user-${randomUUID()}`;
    const device = Wallet.createRandom();
    await enrollDevice(userId, device.address);
    const order = await freshOrder(userId);
    try {
      const approval = await requestApproval(order);
      await pool.query("update ledger_approvals set expires_at = now() - interval '1 minute' where id = $1", [approval.id]);

      const signature = await signApproval(device, approval.order_snapshot);
      const outcome = await verifyApproval(approval.id, device.address, signature);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe("expired");

      const stored = await getApprovalForOrder(order.id);
      expect(stored?.status).toBe("expired");
    } finally {
      await cleanup(userId, order.id);
    }
  });

  it("rejects a replay against an already-resolved approval", async () => {
    const userId = `test-ledger-user-${randomUUID()}`;
    const device = Wallet.createRandom();
    await enrollDevice(userId, device.address);
    const order = await freshOrder(userId);
    try {
      const approval = await requestApproval(order);
      const signature = await signApproval(device, approval.order_snapshot);

      const first = await verifyApproval(approval.id, device.address, signature);
      expect(first.ok).toBe(true);

      const replay = await verifyApproval(approval.id, device.address, signature);
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.reason).toBe("already_resolved");
    } finally {
      await cleanup(userId, order.id);
    }
  });

  it("rejects a signature produced over tampered order fields (amount/destination mismatch)", async () => {
    const userId = `test-ledger-user-${randomUUID()}`;
    const device = Wallet.createRandom();
    await enrollDevice(userId, device.address);
    const order = await freshOrder(userId);
    try {
      const approval = await requestApproval(order);
      // Sign a message that differs from the STORED snapshot (attacker-controlled
      // amount/destination) — verifyApproval always reconstructs the hash from the
      // stored snapshot, so this signature won't recover to the enrolled device there.
      const tamperedMessage: ApprovalMessage = {
        ...approval.order_snapshot,
        amountUsdc: "0.01",
        destinationAddress: "ATTACKER_ADDRESS",
      };
      const signature = await signApproval(device, tamperedMessage);

      const outcome = await verifyApproval(approval.id, device.address, signature);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe("signature_invalid");

      const stored = await getApprovalForOrder(order.id);
      expect(stored?.status).toBe("pending");
    } finally {
      await cleanup(userId, order.id);
    }
  });

  it("returns no_enrolled_device when the order's user has no enrolled device", async () => {
    const userId = `test-ledger-user-${randomUUID()}`;
    const order = await freshOrder(userId);
    try {
      const approval = await requestApproval(order);
      const someWallet = Wallet.createRandom();
      const signature = await signApproval(someWallet, approval.order_snapshot);
      const outcome = await verifyApproval(approval.id, someWallet.address, signature);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe("no_enrolled_device");
    } finally {
      await cleanup(userId, order.id);
    }
  });

  it("cannot reach executePayment()/transferUsdc() for an enrolled-device user without a verified approval", async () => {
    const userId = `test-ledger-user-${randomUUID()}`;
    const device = Wallet.createRandom();
    await enrollDevice(userId, device.address);
    const order = await freshOrder(userId);
    try {
      // No approval requested/approved at all yet — the structural gate inside
      // executePayment() itself (not just the route layer) must block this.
      await expect(executePayment({ order })).rejects.toThrow(LedgerConfirmationRequiredError);

      // Still blocked once an approval exists but hasn't been approved yet.
      await requestApproval(order);
      await expect(executePayment({ order })).rejects.toThrow(LedgerConfirmationRequiredError);

      // Only proceeds once genuinely approved.
      const approval = await requestApproval(order);
      const signature = await signApproval(device, approval.order_snapshot);
      const verified = await verifyApproval(approval.id, device.address, signature);
      expect(verified.ok).toBe(true);

      const payment = await executePayment({ order });
      expect(payment.transactionId).toBeTruthy();
    } finally {
      await cleanup(userId, order.id);
    }
  });
});
