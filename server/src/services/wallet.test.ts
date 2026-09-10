// Tests for #wallet-service's sharding logic: deterministic shard assignment and the
// auto-sweep threshold. The Circle SDK is mocked (vi.mock below) rather than hit for
// real, following the mocking approach used for external calls elsewhere in this repo;
// Postgres (user_wallets/wallet_sets) is the real dev DATABASE_URL, matching the
// integration-test pattern in #orders-service's orders.test.ts (no DB mocking layer
// exists yet in this repo).

import { randomUUID } from "node:crypto";
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const circleMockState = vi.hoisted(() => ({
  balancesByWalletId: new Map<string, string>(),
  createTransactionCalls: [] as Array<{ walletId: string; destinationAddress: string; amount: string[] }>,
}));

vi.mock("@circle-fin/developer-controlled-wallets", () => ({
  initiateDeveloperControlledWalletsClient: vi.fn(() => ({
    createWalletSet: vi.fn(async () => ({ data: { walletSet: { id: `walletset_${randomUUID()}` } } })),
    createWallets: vi.fn(async () => ({
      data: { wallets: [{ id: `wallet_${randomUUID()}`, address: `0x${randomUUID().replace(/-/g, "")}` }] },
    })),
    getWalletTokenBalance: vi.fn(async ({ id }: { id: string }) => ({
      data: {
        tokenBalances: [
          { amount: circleMockState.balancesByWalletId.get(id) ?? "0", token: { symbol: "USDC", tokenAddress: "0xUSDC" } },
        ],
      },
    })),
    createTransaction: vi.fn(async (input: { walletId: string; destinationAddress: string; amount: string[] }) => {
      circleMockState.createTransactionCalls.push(input);
      return { data: { id: `circle_tx_${randomUUID()}`, state: "INITIATED" } };
    }),
    getTransaction: vi.fn(async () => ({ data: { transaction: { state: "COMPLETE" } } })),
  })),
}));

process.env.CIRCLE_API_KEY ||= "test-circle-api-key";
process.env.CIRCLE_ENTITY_SECRET ||= "test-circle-entity-secret";
process.env.TREASURY_ADDRESS = "0xTREASURY";

import { pool } from "../db.js";
import {
  ensureWalletSchema,
  shardCount,
  sweepShardBalances,
  sweepThresholdUsdc,
  walletShardId,
} from "./wallet.js";

describe("#wallet-service shard assignment", () => {
  const originalShardCount = process.env.SHARD_COUNT;
  afterAll(() => {
    process.env.SHARD_COUNT = originalShardCount;
  });

  it("defaults SHARD_COUNT to 1 when unset", () => {
    delete process.env.SHARD_COUNT;
    expect(shardCount()).toBe(1);
  });

  it("falls back to 1 for a non-positive or non-integer SHARD_COUNT", () => {
    process.env.SHARD_COUNT = "0";
    expect(shardCount()).toBe(1);
    process.env.SHARD_COUNT = "-3";
    expect(shardCount()).toBe(1);
    process.env.SHARD_COUNT = "2.5";
    expect(shardCount()).toBe(1);
  });

  it("assigns every user to shard 0 when SHARD_COUNT=1, unchanged from today", () => {
    process.env.SHARD_COUNT = "1";
    for (const userId of ["user-a", "user-b", randomUUID()]) {
      expect(walletShardId(userId)).toBe(0);
    }
  });

  it("is deterministic: the same user always maps to the same shard", () => {
    process.env.SHARD_COUNT = "8";
    const userId = randomUUID();
    const first = walletShardId(userId);
    const second = walletShardId(userId);
    const third = walletShardId(userId);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("always assigns a shard id within [0, SHARD_COUNT)", () => {
    process.env.SHARD_COUNT = "4";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const shardId = walletShardId(randomUUID());
      expect(shardId).toBeGreaterThanOrEqual(0);
      expect(shardId).toBeLessThan(4);
    }
  });

  it("spreads distinct users across more than one shard", () => {
    process.env.SHARD_COUNT = "4";
    const shardIds = new Set(Array.from({ length: 50 }, () => walletShardId(randomUUID())));
    expect(shardIds.size).toBeGreaterThan(1);
  });
});

describe("#wallet-service sweepThresholdUsdc", () => {
  const original = process.env.SWEEP_THRESHOLD_USDC;
  afterAll(() => {
    process.env.SWEEP_THRESHOLD_USDC = original;
  });

  it("is undefined (sweeping disabled) when unset", () => {
    delete process.env.SWEEP_THRESHOLD_USDC;
    expect(sweepThresholdUsdc()).toBeUndefined();
  });

  it("is undefined for a zero or negative threshold", () => {
    process.env.SWEEP_THRESHOLD_USDC = "0";
    expect(sweepThresholdUsdc()).toBeUndefined();
    process.env.SWEEP_THRESHOLD_USDC = "-10";
    expect(sweepThresholdUsdc()).toBeUndefined();
  });

  it("parses a positive threshold", () => {
    process.env.SWEEP_THRESHOLD_USDC = "100";
    expect(sweepThresholdUsdc()).toBe(100);
  });
});

describe("#wallet-service sweepShardBalances", () => {
  const shardId = 7;
  const testUsers = [`test-sweep-user-${randomUUID()}`, `test-sweep-user-${randomUUID()}`, `test-sweep-user-${randomUUID()}`];

  beforeEach(async () => {
    await ensureWalletSchema();
    circleMockState.balancesByWalletId.clear();
    circleMockState.createTransactionCalls.length = 0;
    process.env.SWEEP_THRESHOLD_USDC = "100";

    for (const userId of testUsers) {
      const walletId = `wallet_${userId}`;
      await pool.query(
        `insert into user_wallets (user_id, circle_wallet_id, address, wallet_shard_id)
         values ($1, $2, $3, $4)
         on conflict (user_id) do update set circle_wallet_id = excluded.circle_wallet_id, wallet_shard_id = excluded.wallet_shard_id`,
        [userId, walletId, `0xaddr_${userId}`, shardId],
      );
    }
  });

  afterAll(async () => {
    await pool.query("delete from user_wallets where user_id = any($1)", [testUsers]);
    await pool.end();
  });

  it("does not sweep a wallet at or under the threshold", async () => {
    circleMockState.balancesByWalletId.set(`wallet_${testUsers[0]}`, "100.00");
    const [result] = await sweepShardBalances(shardId).then((results) =>
      results.filter((entry) => entry.userId === testUsers[0]),
    );
    expect(result.sweptUsdc).toBeNull();
    expect(result.circleTransactionId).toBeNull();
  });

  it("sweeps the excess above the threshold to TREASURY_ADDRESS", async () => {
    circleMockState.balancesByWalletId.set(`wallet_${testUsers[1]}`, "150.00");
    const results = await sweepShardBalances(shardId);
    const result = results.find((entry) => entry.userId === testUsers[1]);

    expect(result?.sweptUsdc).toBe("50.00");
    expect(result?.circleTransactionId).not.toBeNull();

    const call = circleMockState.createTransactionCalls.find(
      (transaction) => transaction.walletId === `wallet_${testUsers[1]}`,
    );
    expect(call?.destinationAddress).toBe("0xTREASURY");
    expect(call?.amount).toEqual(["50.00"]);
  });

  it("is a no-op when SWEEP_THRESHOLD_USDC/TREASURY_ADDRESS is not configured", async () => {
    delete process.env.SWEEP_THRESHOLD_USDC;
    circleMockState.balancesByWalletId.set(`wallet_${testUsers[2]}`, "999.00");
    const results = await sweepShardBalances(shardId);
    expect(results).toEqual([]);
  });

  it("only sweeps wallets belonging to the requested shard", async () => {
    const otherUserId = `test-sweep-other-shard-${randomUUID()}`;
    await pool.query(
      "insert into user_wallets (user_id, circle_wallet_id, address, wallet_shard_id) values ($1, $2, $3, $4)",
      [otherUserId, `wallet_${otherUserId}`, `0xaddr_${otherUserId}`, shardId + 1],
    );
    circleMockState.balancesByWalletId.set(`wallet_${otherUserId}`, "999.00");

    try {
      const results = await sweepShardBalances(shardId);
      expect(results.some((entry) => entry.userId === otherUserId)).toBe(false);
    } finally {
      await pool.query("delete from user_wallets where user_id = $1", [otherUserId]);
    }
  });
});
