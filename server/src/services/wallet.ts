// #wallet-service — see .purpose in this directory.
//
// One Circle Developer-Controlled wallet per user (EOA, Arc testnet). The
// wallet set and per-user wallet ids are persisted in Postgres so we don't
// create new Circle resources on every call.

import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { pool } from "../db.js";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
if (!apiKey || !entitySecret) {
  throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET are required (see server/.env.example)");
}

const circle = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

// ponytail: testnet only. Revisit before any mainnet rollout (see .paradigm/specs/wallet-checkout.md).
const BLOCKCHAIN = "ARC-TESTNET";
// Arc testnet USDC ERC-20 contract (per docs.arc.io/integrate/wallets), used only if the wallet's
// token balance lookup doesn't surface a USDC entry (e.g. a brand-new, unfunded wallet).
const ARC_TESTNET_USDC_FALLBACK = "0x3600000000000000000000000000000000000000";

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
async function ensureSchema(): Promise<void> {
  await pool.query(`
    create table if not exists wallet_sets (
      id text primary key,
      circle_wallet_set_id text not null
    );
    create table if not exists user_wallets (
      user_id text primary key,
      circle_wallet_id text not null,
      address text not null,
      created_at timestamptz not null default now()
    );
  `);
}

async function getOrCreateWalletSetId(): Promise<string> {
  const { rows } = await pool.query<{ circle_wallet_set_id: string }>(
    "select circle_wallet_set_id from wallet_sets where id = 'default'",
  );
  if (rows[0]) return rows[0].circle_wallet_set_id;

  const res = await circle.createWalletSet({ name: "agentic-commerce", idempotencyKey: randomUUID() });
  const walletSetId = res.data?.walletSet?.id;
  if (!walletSetId) throw new Error("Circle did not return a wallet set id");

  await pool.query(
    "insert into wallet_sets (id, circle_wallet_set_id) values ('default', $1) on conflict (id) do nothing",
    [walletSetId],
  );
  return walletSetId;
}

export async function getOrCreateUserWallet(userId: string): Promise<{ address: string }> {
  await ensureSchema();

  const existing = await pool.query<{ address: string }>(
    "select address from user_wallets where user_id = $1",
    [userId],
  );
  if (existing.rows[0]) return { address: existing.rows[0].address };

  const walletSetId = await getOrCreateWalletSetId();
  const res = await circle.createWallets({
    accountType: "EOA",
    blockchains: [BLOCKCHAIN],
    count: 1,
    walletSetId,
    idempotencyKey: randomUUID(),
  });
  const wallet = res.data?.wallets?.[0];
  if (!wallet?.address || !wallet.id) throw new Error("Circle did not return a wallet");

  await pool.query(
    "insert into user_wallets (user_id, circle_wallet_id, address) values ($1, $2, $3) on conflict (user_id) do nothing",
    [userId, wallet.id, wallet.address],
  );
  return { address: wallet.address };
}

async function getUsdcTokenAddress(walletId: string): Promise<string> {
  const res = await circle.getWalletTokenBalance({ id: walletId });
  const usdc = (res.data?.tokenBalances ?? []).find((b) => b.token?.symbol === "USDC");
  return usdc?.token?.tokenAddress ?? ARC_TESTNET_USDC_FALLBACK;
}

export async function transferUsdc(req: WalletTransferRequest): Promise<WalletTransferResult> {
  await ensureSchema();

  const { rows } = await pool.query<{ circle_wallet_id: string }>(
    "select circle_wallet_id from user_wallets where user_id = $1",
    [req.userId],
  );
  const walletId = rows[0]?.circle_wallet_id;
  if (!walletId) throw new Error(`No wallet found for user ${req.userId}`);

  const tokenAddress = await getUsdcTokenAddress(walletId);

  const res = await circle.createTransaction({
    walletId,
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

export async function getTransactionState(circleTransactionId: string): Promise<WalletTransferResult["state"]> {
  const res = await circle.getTransaction({ id: circleTransactionId });
  const state = res.data?.transaction?.state;
  if (!state) throw new Error(`Circle returned no state for transaction ${circleTransactionId}`);
  return state as WalletTransferResult["state"];
}
