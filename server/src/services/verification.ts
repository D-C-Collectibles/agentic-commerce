// #verification-service — the ^personhood-verified gate for agent-initiated purchases.
// Creates single-use, order-bound verification sessions and marks them verified.
//
// This is where World ID Selfie Check (Face Auth) plugs in later: today a mock endpoint
// (#verify-route) flips the session on a human click; the real integration renders the
// IDKit widget and calls markSessionVerified only after verifying the returned World ID
// proof. Everything else (session lifecycle, order binding, single-use) stays the same.

import { pool } from "../db.js";

export const VERIFICATION_STATUS = {
  pending: "pending",
  verified: "verified",
  expired: "expired",
  cancelled: "cancelled",
} as const;
export type VerificationStatus = (typeof VERIFICATION_STATUS)[keyof typeof VERIFICATION_STATUS];

// Short-lived so a fresh selfie is bound to this specific purchase, not a broad window.
const SESSION_TTL_MINUTES = 5;

// ponytail: CREATE TABLE IF NOT EXISTS instead of a migration framework — fine at hackathon scale.
// Callers must run ensureOrderSchema() first: this table references orders(id).
export async function ensureVerificationSchema(): Promise<void> {
  await pool.query(`
    create table if not exists verification_sessions (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null references orders(id),
      user_id text not null,
      status text not null default 'pending'
        check (status in ('pending','verified','expired','cancelled')),
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      verified_at timestamptz
    );
    create index if not exists verification_sessions_order_idx on verification_sessions (order_id, created_at);
  `);
}

export interface VerificationSession {
  id: string;
  order_id: string;
  user_id: string;
  status: VerificationStatus;
  expires_at: string;
  verified_at: string | null;
}

export async function createSession(orderId: string, userId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into verification_sessions (order_id, user_id, expires_at)
     values ($1, $2, now() + ($3 || ' minutes')::interval) returning id`,
    [orderId, userId, String(SESSION_TTL_MINUTES)],
  );
  return rows[0].id;
}

export async function getSession(sessionId: string): Promise<VerificationSession | null> {
  const { rows } = await pool.query<VerificationSession>(
    "select id, order_id, user_id, status, expires_at, verified_at from verification_sessions where id = $1",
    [sessionId],
  );
  return rows[0] ?? null;
}

// Latest session for an order, for status polling.
export async function getLatestSessionForOrder(orderId: string): Promise<VerificationSession | null> {
  const { rows } = await pool.query<VerificationSession>(
    `select id, order_id, user_id, status, expires_at, verified_at
     from verification_sessions where order_id = $1 order by created_at desc limit 1`,
    [orderId],
  );
  return rows[0] ?? null;
}

export type VerifyOutcome = "verified" | "already" | "expired" | "not_found";

// Transitions a pending, unexpired session to verified. The state change is a single
// atomic UPDATE so a double-click (or concurrent requests) can settle the order only
// once — exactly one caller gets "verified", the rest get "already".
export async function markSessionVerified(
  sessionId: string,
): Promise<{ outcome: VerifyOutcome; session: VerificationSession | null }> {
  const { rows } = await pool.query<VerificationSession>(
    `update verification_sessions
     set status = 'verified', verified_at = now()
     where id = $1 and status = 'pending' and expires_at > now()
     returning id, order_id, user_id, status, expires_at, verified_at`,
    [sessionId],
  );
  if (rows[0]) return { outcome: "verified", session: rows[0] };

  const session = await getSession(sessionId);
  if (!session) return { outcome: "not_found", session: null };
  if (session.status === VERIFICATION_STATUS.verified) return { outcome: "already", session };
  // Pending but past its TTL: record the expiry so status polls reflect it.
  if (session.status === VERIFICATION_STATUS.pending) {
    await pool.query("update verification_sessions set status = 'expired' where id = $1 and status = 'pending'", [sessionId]);
  }
  return { outcome: "expired", session };
}
