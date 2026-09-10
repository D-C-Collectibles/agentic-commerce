// #wallet-service — see .purpose in this directory.
//
// One Circle Developer-Controlled wallet per user (EOA by default, Arc testnet — see
// WALLET_ACCOUNT_TYPE below for opt-in SCA). Users are partitioned across SHARD_COUNT
// wallet shards (env, default 1) — each shard has its own Circle wallet set and CAN
// have its own scoped Circle API key/entity secret, so a compromised credential only
// exposes one shard's in-flight funds instead of every user's wallet (see
// .paradigm/specs/wallet-checkout.md "Sharding"). SHARD_COUNT=1 reproduces today's
// single-wallet-set behavior exactly, so this ships opt-in.

import { createHash, randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { log } from "@a-company/paradigm-logger";
import { getShardedSecret, SECRET_NAMES } from "../config/secrets.js";
import { pool } from "../db.js";

type CircleClient = ReturnType<typeof initiateDeveloperControlledWalletsClient>;

// ponytail: testnet only. Revisit before any mainnet rollout (see .paradigm/specs/wallet-checkout.md).
const BLOCKCHAIN = "ARC-TESTNET";
// Arc testnet USDC ERC-20 contract (per docs.arc.io/integrate/wallets), used only if the wallet's
// token balance lookup doesn't surface a USDC entry (e.g. a brand-new, unfunded wallet).
const ARC_TESTNET_USDC_FALLBACK = "0x3600000000000000000000000000000000000000";

// Circle's SDK accepts "EOA" (today's default, an externally-owned account with no
// on-chain policy of its own) or "SCA" (a Smart Contract Account) for `createWallets`.
// Opt-in via WALLET_ACCOUNT_TYPE so existing EOA-based deployments/tests are
// byte-for-byte unchanged unless a deployment explicitly asks for SCA wallets. SCA is
// a *prerequisite* for the on-chain session-key follow-up recommended in
// .paradigm/specs/wallet-checkout.md ("Session-scoped agent grants") — this flag alone
// only requests the account type from Circle; it does not attach any on-chain
// session-key policy module, which is out of scope for this pass (no contract/audit).
const WALLET_ACCOUNT_TYPES = ["EOA", "SCA"] as const;
type WalletAccountType = (typeof WALLET_ACCOUNT_TYPES)[number];

export function walletAccountType(): WalletAccountType {
  return process.env.WALLET_ACCOUNT_TYPE === "SCA" ? "SCA" : "EOA";
}

// Number of wallet shards. Defaults to 1 (single shard, today's behavior). Set via env
// once per-shard Circle credentials have been provisioned — see .paradigm/specs/wallet-checkout.md.
export function shardCount(): number {
  const configured = Number(process.env.SHARD_COUNT);
  return Number.isInteger(configured) && configured > 0 ? configured : 1;
}

// Deterministic shard assignment: sha256(userId) mod SHARD_COUNT. No randomness, so a
// given user always lands on the same shard across restarts/deploys/processes.
export function walletShardId(userId: string): number {
  const digest = createHash("sha256").update(userId).digest();
  return digest.readUInt32BE(0) % shardCount();
}

// Init each shard's Circle client lazily (on first use) rather than at import, so the
// server still boots to serve /products and /auth when no Circle creds are set — only
// the checkout path requires them. One client per shard, cached for the process lifetime.
const circleClients = new Map<number, CircleClient>();

function circleClientForShard(shardId: number): CircleClient {
  const existing = circleClients.get(shardId);
  if (existing) return existing;

  const apiKey = getShardedSecret(SECRET_NAMES.circleApiKey, shardId);
  const entitySecret = getShardedSecret(SECRET_NAMES.circleEntitySecret, shardId);
  if (!apiKey || !entitySecret) {
    throw new Error(
      `CIRCLE_API_KEY_${shardId}/CIRCLE_ENTITY_SECRET_${shardId} (or CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET) are required for wallet shard ${shardId} (see server/.env.example)`,
    );
  }
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  circleClients.set(shardId, client);
  return client;
}

export interface WalletTransferRequest {
  userId: string;
  destinationAddress: string;
  amountUsdc: string;
  idempotencyKey: string;
}

export interface WalletTransferResult {
  circleTransactionId: string;
  state: "INITIATED" | "QUEUED" | "SENT" | "CONFIRMED" | "COMPLETE" | "FAILED" | "DENIED" | "CANCELLED";
}

// ponytail: CREATE TABLE IF NOT EXISTS instead of a migration framework — fine at hackathon scale.
export async function ensureWalletSchema(): Promise<void> {
  await pool.query(`
    create table if not exists wallet_sets (
      id text primary key,
      circle_wallet_set_id text not null
    );
    create table if not exists user_wallets (
      user_id text primary key,
      circle_wallet_id text not null,
      address text not null,
      wallet_shard_id integer not null default 0,
      created_at timestamptz not null default now()
    );
    alter table user_wallets add column if not exists wallet_shard_id integer not null default 0;
  `);
}

// Shard 0 keeps the original 'default' wallet_sets row/key instead of a new 'shard-0'
// one, so an existing single-shard deployment (which already has a 'default' row) keeps
// reusing that same Circle wallet set rather than creating a second one for shard 0.
function walletSetKey(shardId: number): string {
  return shardId === 0 ? "default" : `shard-${shardId}`;
}

async function getOrCreateWalletSetId(shardId: number): Promise<string> {
  const key = walletSetKey(shardId);
  const { rows } = await pool.query<{ circle_wallet_set_id: string }>(
    "select circle_wallet_set_id from wallet_sets where id = $1",
    [key],
  );
  if (rows[0]) return rows[0].circle_wallet_set_id;

  const res = await circleClientForShard(shardId).createWalletSet({
    name: `agentic-commerce-shard-${shardId}`,
    idempotencyKey: randomUUID(),
  });
  const walletSetId = res.data?.walletSet?.id;
  if (!walletSetId) throw new Error(`Circle did not return a wallet set id for shard ${shardId}`);

  await pool.query(
    "insert into wallet_sets (id, circle_wallet_set_id) values ($1, $2) on conflict (id) do nothing",
    [key, walletSetId],
  );
  return walletSetId;
}

export async function getOrCreateUserWallet(userId: string): Promise<{ address: string }> {
  await ensureWalletSchema();

  const existing = await pool.query<{ address: string }>(
    "select address from user_wallets where user_id = $1",
    [userId],
  );
  if (existing.rows[0]) return { address: existing.rows[0].address };

  const shardId = walletShardId(userId);
  const walletSetId = await getOrCreateWalletSetId(shardId);
  const res = await circleClientForShard(shardId).createWallets({
    accountType: walletAccountType(),
    blockchains: [BLOCKCHAIN],
    count: 1,
    walletSetId,
    idempotencyKey: randomUUID(),
  });
  const wallet = res.data?.wallets?.[0];
  if (!wallet?.address || !wallet.id) throw new Error("Circle did not return a wallet");

  await pool.query(
    "insert into user_wallets (user_id, circle_wallet_id, address, wallet_shard_id) values ($1, $2, $3, $4) on conflict (user_id) do nothing",
    [userId, wallet.id, wallet.address, shardId],
  );
  log.component("#wallet-service").info("Created user wallet", { userId, shardId, address: wallet.address });
  return { address: wallet.address };
}

async function resolveUserShardId(userId: string): Promise<number> {
  const { rows } = await pool.query<{ wallet_shard_id: number }>(
    "select wallet_shard_id from user_wallets where user_id = $1",
    [userId],
  );
  // Falls back to the deterministic assignment if no wallet row exists yet — shouldn't
  // happen on the happy path (a wallet is always created before a transfer/status check
  // is attempted for a user), but keeps this resolvable rather than throwing.
  return rows[0]?.wallet_shard_id ?? walletShardId(userId);
}

async function getWalletUsdcInfo(
  shardId: number,
  walletId: string,
): Promise<{ tokenAddress: string; balanceUsdc: number }> {
  const res = await circleClientForShard(shardId).getWalletTokenBalance({ id: walletId });
  const usdc = (res.data?.tokenBalances ?? []).find((balance) => balance.token?.symbol === "USDC");
  return {
    tokenAddress: usdc?.token?.tokenAddress ?? ARC_TESTNET_USDC_FALLBACK,
    balanceUsdc: Number(usdc?.amount ?? "0"),
  };
}

export async function transferUsdc(req: WalletTransferRequest): Promise<WalletTransferResult> {
  await ensureWalletSchema();

  const { rows } = await pool.query<{ circle_wallet_id: string; wallet_shard_id: number }>(
    "select circle_wallet_id, wallet_shard_id from user_wallets where user_id = $1",
    [req.userId],
  );
  const walletRow = rows[0];
  if (!walletRow) throw new Error(`No wallet found for user ${req.userId}`);

  const { tokenAddress } = await getWalletUsdcInfo(walletRow.wallet_shard_id, walletRow.circle_wallet_id);

  const res = await circleClientForShard(walletRow.wallet_shard_id).createTransaction({
    walletId: walletRow.circle_wallet_id,
    tokenAddress,
    destinationAddress: req.destinationAddress,
    amount: [req.amountUsdc],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: req.idempotencyKey,
  });

  const tx = res.data;
  if (!tx?.id || !tx.state) throw new Error("Circle did not return a transaction id/state");

  return { circleTransactionId: tx.id, state: tx.state as WalletTransferResult["state"] };
}

export async function getTransactionState(
  userId: string,
  circleTransactionId: string,
): Promise<WalletTransferResult["state"]> {
  const shardId = await resolveUserShardId(userId);
  const res = await circleClientForShard(shardId).getTransaction({ id: circleTransactionId });
  const state = res.data?.transaction?.state;
  if (!state) throw new Error(`Circle returned no state for transaction ${circleTransactionId}`);
  return state as WalletTransferResult["state"];
}

// Sweep threshold (USDC). Undefined (unset/non-positive) disables sweeping entirely —
// sweepShardBalances() becomes a no-op rather than sweeping everything to zero.
export function sweepThresholdUsdc(): number | undefined {
  const configured = Number(process.env.SWEEP_THRESHOLD_USDC);
  return Number.isFinite(configured) && configured > 0 ? configured : undefined;
}

export interface SweepResult {
  userId: string;
  address: string;
  balanceUsdc: number;
  sweptUsdc: string | null;
  circleTransactionId: string | null;
}

async function sweepWallet(
  shardId: number,
  wallet: { user_id: string; circle_wallet_id: string; address: string },
  threshold: number,
  treasuryAddress: string,
): Promise<SweepResult> {
  const { tokenAddress, balanceUsdc } = await getWalletUsdcInfo(shardId, wallet.circle_wallet_id);
  if (balanceUsdc <= threshold) {
    return { userId: wallet.user_id, address: wallet.address, balanceUsdc, sweptUsdc: null, circleTransactionId: null };
  }

  const excessUsdc = (balanceUsdc - threshold).toFixed(2);
  const res = await circleClientForShard(shardId).createTransaction({
    walletId: wallet.circle_wallet_id,
    tokenAddress,
    destinationAddress: treasuryAddress,
    amount: [excessUsdc],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });
  const circleTransactionId = res.data?.id ?? null;
  log.component("#wallet-service").info("Swept shard wallet balance to treasury", {
    shardId,
    userId: wallet.user_id,
    excessUsdc,
    circleTransactionId,
  });
  return { userId: wallet.user_id, address: wallet.address, balanceUsdc, sweptUsdc: excessUsdc, circleTransactionId };
}

// #wallet-sharding sweep: for every wallet in `shardId` whose USDC balance exceeds
// SWEEP_THRESHOLD_USDC, transfers the excess down to that threshold into TREASURY_ADDRESS.
// Bounds a shard-key compromise's blast radius to at most (threshold * wallets-in-shard)
// of in-flight funds instead of every balance the shard has ever held.
//
// Callable, not cron-wired — this repo has no cron/scheduler infra. An ops cron job
// would call sweepShardBalances(shardId) for each of the SHARD_COUNT shards on an
// interval (e.g. every few minutes) once this ships to a real deployment.
export async function sweepShardBalances(shardId: number): Promise<SweepResult[]> {
  await ensureWalletSchema();

  const threshold = sweepThresholdUsdc();
  const treasuryAddress = process.env.TREASURY_ADDRESS;
  if (threshold === undefined || !treasuryAddress) {
    log.component("#wallet-service").warn("Sweep skipped: SWEEP_THRESHOLD_USDC/TREASURY_ADDRESS not configured", {
      shardId,
    });
    return [];
  }

  const { rows } = await pool.query<{ user_id: string; circle_wallet_id: string; address: string }>(
    "select user_id, circle_wallet_id, address from user_wallets where wallet_shard_id = $1",
    [shardId],
  );

  return Promise.all(rows.map((wallet) => sweepWallet(shardId, wallet, threshold, treasuryAddress)));
}
