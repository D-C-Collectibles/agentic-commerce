// #ledger-confirm-service — the ^ledger-confirmed gate. A physical Ledger device signs
// an EIP-712 typed-data struct binding {orderId, sku, quantity, amountUsdc,
// destinationAddress, nonce, expiresAt, chainId} to authorize a specific order; this
// service never itself submits the on-chain Circle transfer (that's still
// #payment-service/#wallet-service) — it only decides whether the ^ledger-confirmed
// gate is satisfied before #payment-service.executePayment() is allowed to run.
//
// A human runs a separate companion process (the `ledger-approver/` daemon — NOT built
// in this pass, see .paradigm/specs/wallet-checkout.md "Ledger confirmation gate") that
// polls GET /ledger/pending-approvals and posts a device signature back to POST
// /ledger/approvals/:approvalId. LEDGER_CONFIRM_MODE=mock (default, mirroring this
// repo's PAYMENTS_MODE/VERIFICATION_MODE pattern) additionally exposes a click-through
// auto-approve so the flow is demoable without hardware; =ledger requires a real
// signature recovered via `ethers` and checked against the enrolled device.
//
// Every order-authorizing field is reconstructed from the STORED order row / STORED
// approval snapshot, never from anything a caller echoes back — see requestApproval()
// and verifyApproval().

import { randomUUID } from "node:crypto";
import { verifyMessage, verifyTypedData, type TypedDataDomain, type TypedDataField } from "ethers";
import { log } from "@a-company/paradigm-logger";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import type { OrderRow } from "./orders.js";

export const LEDGER_CONFIRM_MODE = {
  mock: "mock",
  ledger: "ledger",
} as const;
export type LedgerConfirmMode = (typeof LEDGER_CONFIRM_MODE)[keyof typeof LEDGER_CONFIRM_MODE];

export function ledgerConfirmMode(): LedgerConfirmMode {
  return process.env.LEDGER_CONFIRM_MODE === LEDGER_CONFIRM_MODE.ledger
    ? LEDGER_CONFIRM_MODE.ledger
    : LEDGER_CONFIRM_MODE.mock;
}

// Approval TTL (seconds) — short-lived so a signing request is bound to this specific
// checkout attempt, not a broad window. Env-configurable, default 5 minutes.
const DEFAULT_APPROVAL_TTL_SECONDS = 5 * 60;
export function ledgerApprovalTtlSeconds(): number {
  const configured = Number(process.env.LEDGER_APPROVAL_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_APPROVAL_TTL_SECONDS;
}

// Arc testnet chain id (see .paradigm/specs/wallet-checkout.md "Custody model"). Bound
// into the signed MESSAGE itself (not just the EIP-712 domain), per the architect
// design, so the chain is anchored independent of the domain object.
const ARC_TESTNET_CHAIN_ID = 5042002;
export function ledgerConfirmChainId(): number {
  const configured = Number(process.env.LEDGER_CONFIRM_CHAIN_ID);
  return Number.isInteger(configured) && configured > 0 ? configured : ARC_TESTNET_CHAIN_ID;
}

const APPROVAL_DOMAIN_NAME = "agentic-commerce-ledger-confirm";
const APPROVAL_DOMAIN_VERSION = "1";

const APPROVAL_TYPES: Record<string, TypedDataField[]> = {
  Approval: [
    { name: "orderId", type: "string" },
    { name: "sku", type: "string" },
    { name: "quantity", type: "uint256" },
    { name: "amountUsdc", type: "string" },
    { name: "destinationAddress", type: "string" },
    { name: "nonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
    { name: "chainId", type: "uint256" },
  ],
};

// The exact fields a Ledger device Clear-Signs. Snapshotted into ledger_approvals at
// requestApproval() time from the STORED order row, and never re-derived from anything
// the caller sends back — see .paradigm/specs/wallet-checkout.md for the Clear Signing
// spike this needs before relying on a real device.
export interface ApprovalMessage {
  orderId: string;
  sku: string;
  quantity: number;
  amountUsdc: string;
  destinationAddress: string;
  nonce: string;
  expiresAt: number;
  chainId: number;
}

function approvalDomain(): TypedDataDomain {
  return { name: APPROVAL_DOMAIN_NAME, version: APPROVAL_DOMAIN_VERSION, chainId: ledgerConfirmChainId() };
}

export function buildApprovalTypedData(message: ApprovalMessage): {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  message: ApprovalMessage;
} {
  return { domain: approvalDomain(), types: APPROVAL_TYPES, message };
}

export type LedgerApprovalStatus = "pending" | "approved" | "expired" | "rejected";

export interface LedgerApprovalRow {
  id: string;
  order_id: string;
  user_id: string;
  nonce: string;
  order_snapshot: ApprovalMessage;
  status: LedgerApprovalStatus;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
}

// ponytail: CREATE TABLE IF NOT EXISTS instead of a migration framework — matches the
// pattern used throughout server/src/services/*. Callers must have already run
// #orders-service.ensureOrderSchema() (ledger_approvals FK-references orders(id)) —
// same convention #verification-service documents for verification_sessions.
export async function ensureLedgerSchema(): Promise<void> {
  await pool.query(`
    create table if not exists ledger_devices (
      user_id text primary key,
      signer_address text not null,
      enrolled_at timestamptz not null default now()
    );
    create table if not exists ledger_approvals (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null unique references orders(id),
      user_id text not null,
      nonce text not null,
      order_snapshot jsonb not null,
      status text not null default 'pending'
        check (status in ('pending','approved','expired','rejected')),
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      resolved_at timestamptz
    );
    create index if not exists ledger_approvals_user_idx on ledger_approvals (user_id, created_at);
  `);
}

const LEDGER_APPROVAL_COLUMNS_SQL = `id, order_id, user_id, nonce, order_snapshot, status, expires_at, created_at, resolved_at`;

// A queryable is either the shared pool or a checked-out client inside a transaction —
// mirrors #orders-service.evaluateSpendPolicy's Queryable seam.
type Queryable = Pick<PoolClient, "query">;

export interface EnrolledDevice {
  userId: string;
  signerAddress: string;
  enrolledAt: string;
}

export async function getEnrolledDevice(userId: string, queryable: Queryable = pool): Promise<EnrolledDevice | null> {
  await ensureLedgerSchema();
  const { rows } = await queryable.query<{ user_id: string; signer_address: string; enrolled_at: string }>(
    "select user_id, signer_address, enrolled_at from ledger_devices where user_id = $1",
    [userId],
  );
  const row = rows[0];
  return row ? { userId: row.user_id, signerAddress: row.signer_address, enrolledAt: row.enrolled_at } : null;
}

export async function enrollDevice(userId: string, signerAddress: string): Promise<EnrolledDevice> {
  await ensureLedgerSchema();
  const { rows } = await pool.query<{ user_id: string; signer_address: string; enrolled_at: string }>(
    `insert into ledger_devices (user_id, signer_address) values ($1, $2)
     on conflict (user_id) do update set signer_address = excluded.signer_address, enrolled_at = now()
     returning user_id, signer_address, enrolled_at`,
    [userId, signerAddress],
  );
  log.component("#ledger-confirm-service").info("Enrolled Ledger device", { userId, signerAddress });
  return { userId: rows[0].user_id, signerAddress: rows[0].signer_address, enrolledAt: rows[0].enrolled_at };
}

// One-time enrollment nonce, in-memory (never persisted — losing it on a restart just
// means the caller re-requests one; nothing money-moving depends on it surviving a
// restart, unlike ledger_approvals). Single-use: consumed on the first verify attempt
// regardless of outcome, so a captured nonce+signature can't be replayed.
const ENROLL_NONCE_TTL_SECONDS = 5 * 60;
const enrollNonces = new Map<string, { nonce: string; expiresAt: number }>();

function enrollMessage(nonce: string): string {
  return `agentic-commerce Ledger enrollment\nnonce: ${nonce}`;
}

export interface EnrollNonce {
  nonce: string;
  message: string;
  expiresAt: number;
}

export function issueEnrollNonce(userId: string): EnrollNonce {
  const nonce = randomUUID();
  const expiresAt = Date.now() + ENROLL_NONCE_TTL_SECONDS * 1000;
  enrollNonces.set(userId, { nonce, expiresAt });
  return { nonce, message: enrollMessage(nonce), expiresAt };
}

// Verifies a signature over the nonce issued by issueEnrollNonce() for this user. The
// nonce is consumed on first use whether or not the signature checks out.
export function verifyEnrollSignature(userId: string, signerAddress: string, signature: string): boolean {
  const pending = enrollNonces.get(userId);
  enrollNonces.delete(userId);
  if (!pending || pending.expiresAt <= Date.now()) return false;
  try {
    const recovered = verifyMessage(enrollMessage(pending.nonce), signature);
    return recovered.toLowerCase() === signerAddress.toLowerCase();
  } catch {
    return false;
  }
}

// Mints (or reuses) the pending approval request for an order. Idempotent by design:
// a second call for the same order_id (e.g. a resubmission of a checkout that's still
// waiting on confirmation) reuses whatever row already exists — approved, still-pending,
// expired, or rejected — rather than minting a second signing request or silently
// resetting a fail-closed outcome back to pending. #resolveLedgerGate is what decides
// what an 'expired'/'rejected' (or lazily-expired-but-still-labeled-pending) row means
// for the order.
export async function requestApproval(order: OrderRow): Promise<LedgerApprovalRow> {
  await ensureLedgerSchema();
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Advisory lock keyed on the order id so two concurrent requests for the same order
    // can't both decide "no existing row" and both insert.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`ledger-approval:${order.id}`]);

    const { rows: existingRows } = await client.query<LedgerApprovalRow>(
      `select ${LEDGER_APPROVAL_COLUMNS_SQL} from ledger_approvals where order_id = $1`,
      [order.id],
    );
    if (existingRows[0]) {
      await client.query("commit");
      return existingRows[0];
    }

    const nonce = randomUUID();
    const ttlSeconds = ledgerApprovalTtlSeconds();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const message: ApprovalMessage = {
      orderId: order.id,
      sku: order.sku,
      quantity: order.quantity,
      amountUsdc: order.amount_usdc,
      destinationAddress: order.destination_address,
      nonce,
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
      chainId: ledgerConfirmChainId(),
    };

    const { rows } = await client.query<LedgerApprovalRow>(
      `insert into ledger_approvals (order_id, user_id, nonce, order_snapshot, status, expires_at)
       values ($1, $2, $3, $4, 'pending', $5)
       returning ${LEDGER_APPROVAL_COLUMNS_SQL}`,
      [order.id, order.user_id, nonce, JSON.stringify(message), expiresAt],
    );
    await client.query("commit");
    log.component("#ledger-confirm-service").info("Requested Ledger approval", {
      orderId: order.id,
      approvalId: rows[0].id,
    });
    return rows[0];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getApprovalForOrder(orderId: string): Promise<LedgerApprovalRow | null> {
  await ensureLedgerSchema();
  const { rows } = await pool.query<LedgerApprovalRow>(
    `select ${LEDGER_APPROVAL_COLUMNS_SQL} from ledger_approvals where order_id = $1`,
    [orderId],
  );
  return rows[0] ?? null;
}

export async function getApprovalById(approvalId: string): Promise<LedgerApprovalRow | null> {
  await ensureLedgerSchema();
  const { rows } = await pool.query<LedgerApprovalRow>(
    `select ${LEDGER_APPROVAL_COLUMNS_SQL} from ledger_approvals where id = $1`,
    [approvalId],
  );
  return rows[0] ?? null;
}

export async function getPendingApprovalsForUser(userId: string): Promise<LedgerApprovalRow[]> {
  await ensureLedgerSchema();
  const { rows } = await pool.query<LedgerApprovalRow>(
    `select ${LEDGER_APPROVAL_COLUMNS_SQL} from ledger_approvals
     where user_id = $1 and status = 'pending' and expires_at > now()
     order by created_at desc`,
    [userId],
  );
  return rows;
}

export type VerifyApprovalFailureReason =
  | "not_found"
  | "already_resolved"
  | "expired"
  | "no_enrolled_device"
  | "signer_mismatch"
  | "signature_invalid";

export type VerifyApprovalOutcome =
  | { ok: true; approval: LedgerApprovalRow }
  | { ok: false; reason: VerifyApprovalFailureReason };

type PendingApprovalHandler = (
  client: PoolClient,
  approval: LedgerApprovalRow,
) => Promise<VerifyApprovalOutcome>;

// Shared row-locked-transaction shape for both verifyApproval() and the mock
// auto-approve helper: locks the approval row, rejects anything not still 'pending',
// lazily transitions a TTL-elapsed 'pending' row to 'expired' (mirrors
// #verification-service.markSessionVerified's lazy-expiry pattern), then hands the
// still-valid, still-locked row to `handler` to decide the final outcome — all inside
// one transaction, so the pending -> approved transition (nonce consumption) is atomic.
async function withPendingApproval(approvalId: string, handler: PendingApprovalHandler): Promise<VerifyApprovalOutcome> {
  await ensureLedgerSchema();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<LedgerApprovalRow>(
      `select ${LEDGER_APPROVAL_COLUMNS_SQL} from ledger_approvals where id = $1 for update`,
      [approvalId],
    );
    const approval = rows[0];
    if (!approval) {
      await client.query("commit");
      return { ok: false, reason: "not_found" };
    }
    if (approval.status !== "pending") {
      await client.query("commit");
      return { ok: false, reason: "already_resolved" };
    }
    if (new Date(approval.expires_at).getTime() <= Date.now()) {
      await client.query(
        "update ledger_approvals set status = 'expired', resolved_at = now() where id = $1",
        [approvalId],
      );
      await client.query("commit");
      return { ok: false, reason: "expired" };
    }

    const outcome = await handler(client, approval);
    await client.query("commit");
    return outcome;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// Reconstructs the EIP-712 hash from the STORED approval/order snapshot — never from
// anything the caller sends in the request body — recovers the signer, and checks it
// matches the enrolled device for the approval's own user. Marks the row 'approved'
// (nonce consumed) atomically in the same transaction as that check.
export async function verifyApproval(
  approvalId: string,
  signerAddress: string,
  signature: string,
): Promise<VerifyApprovalOutcome> {
  return withPendingApproval(approvalId, async (client, approval) => {
    const device = await getEnrolledDevice(approval.user_id, client);
    if (!device) return { ok: false, reason: "no_enrolled_device" };
    if (device.signerAddress.toLowerCase() !== signerAddress.toLowerCase()) {
      return { ok: false, reason: "signer_mismatch" };
    }

    const { domain, types, message } = buildApprovalTypedData(approval.order_snapshot);
    let recovered: string;
    try {
      recovered = verifyTypedData(domain, types, message, signature);
    } catch {
      return { ok: false, reason: "signature_invalid" };
    }
    // A signature produced over different (tampered) order fields recovers to a
    // different address than the one that signed the real, stored snapshot — this is
    // what rejects a tampered-fields replay without needing a separate special case.
    if (recovered.toLowerCase() !== device.signerAddress.toLowerCase()) {
      return { ok: false, reason: "signature_invalid" };
    }

    const { rows } = await client.query<LedgerApprovalRow>(
      `update ledger_approvals set status = 'approved', resolved_at = now() where id = $1
       returning ${LEDGER_APPROVAL_COLUMNS_SQL}`,
      [approval.id],
    );
    log.gate("^ledger-confirmed").info("Ledger approval verified", {
      approvalId: approval.id,
      orderId: approval.order_id,
    });
    return { ok: true, approval: rows[0] };
  });
}

// LEDGER_CONFIRM_MODE=mock only — mirrors VERIFICATION_MODE=mock's click-through page:
// approves without any signature so the flow is demoable without real hardware.
export async function mockApproveApproval(approvalId: string): Promise<VerifyApprovalOutcome> {
  if (ledgerConfirmMode() !== LEDGER_CONFIRM_MODE.mock) {
    throw new Error("mockApproveApproval() is only available when LEDGER_CONFIRM_MODE=mock");
  }
  return withPendingApproval(approvalId, async (client, approval) => {
    const { rows } = await client.query<LedgerApprovalRow>(
      `update ledger_approvals set status = 'approved', resolved_at = now() where id = $1
       returning ${LEDGER_APPROVAL_COLUMNS_SQL}`,
      [approval.id],
    );
    log.gate("^ledger-confirmed").info("Mock Ledger approval auto-approved", {
      approvalId: approval.id,
      orderId: approval.order_id,
    });
    return { ok: true, approval: rows[0] };
  });
}

export type LedgerGateStatus = "not_required" | "pending" | "approved" | "denied";

export interface LedgerGateResult {
  status: LedgerGateStatus;
  approvalId?: string;
}

// The call site both #checkout-route and #verify-route use to decide whether
// ^ledger-confirmed is satisfied for an order. "not_required": the order's user has no
// enrolled device (unchanged behavior). "pending": a signing request exists and hasn't
// timed out — the caller should surface this the same way ^personhood-verified's
// pending_verification state works, NOT charge, and NOT fail the order (mirrors an
// in-flight, not-yet-decided verification session). "approved": ^ledger-confirmed is
// satisfied. "denied": the approval was explicitly rejected, OR its TTL elapsed with no
// decision (an unreachable/timed-out device) — fails closed rather than silently
// re-issuing a fresh request or leaving the order pending forever (security requirement:
// timeout/decline/unreachable must deny, never dangle).
export async function resolveLedgerGate(order: OrderRow): Promise<LedgerGateResult> {
  const device = await getEnrolledDevice(order.user_id);
  if (!device) return { status: "not_required" };

  const approval = await requestApproval(order);
  if (approval.status === "approved") {
    return { status: "approved", approvalId: approval.id };
  }
  if (approval.status === "pending") {
    if (new Date(approval.expires_at).getTime() > Date.now()) {
      return { status: "pending", approvalId: approval.id };
    }
    // TTL elapsed but no explicit decision was ever recorded — lazily transition (same
    // pattern as withPendingApproval/#verification-service) then fail closed.
    await pool.query(
      "update ledger_approvals set status = 'expired', resolved_at = now() where id = $1 and status = 'pending'",
      [approval.id],
    );
    return { status: "denied", approvalId: approval.id };
  }
  // 'expired' or 'rejected' — an already-resolved non-approval outcome.
  return { status: "denied", approvalId: approval.id };
}
