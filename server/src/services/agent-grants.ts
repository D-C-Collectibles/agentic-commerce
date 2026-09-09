// #agent-grants-service — an app-level, revocable, expiring "session key" scoped to an
// agent grant. This is explicitly NOT an on-chain session key: it's a Postgres-backed
// spend policy tied to a specific agent-grant JWT (via its `jti` claim), checked in
// addition to (not instead of) #orders-service's app-wide spend caps, right before
// #verify-route's settleVerifiedSession() charges an agent-initiated order. A prior
// architect/security review recommended real on-chain ERC-4337 session keys scoped to
// a Smart Contract Account so that even a compromised server/entity-secret is bounded
// by something the app can't unilaterally override — that requires a real Solidity
// module and an audit this pass doesn't have (see .paradigm/specs/wallet-checkout.md
// "Session-scoped agent grants" for the deferred on-chain follow-up and
// #wallet-service.walletAccountType() for the SCA-wallet groundwork). What ships here
// is the pre-chain groundwork: a policy the server itself enforces and can revoke.

import { log } from "@a-company/paradigm-logger";
import { pool } from "../db.js";
import { DAILY_CAP_USDC, PER_TX_CAP_USDC } from "./orders.js";

// How long a grant's scoped policy stays honored, independent of the agent-grant JWT's
// own (much longer, 365d — see #auth-service.AGENT_GRANT_TTL) lifetime. This is the
// "session" in session key: even if the JWT itself is never revoked or leaks, the
// scoped policy that lets it actually move money expires on its own and must be
// re-minted (a fresh POST /agent/grant) rather than silently renewing. Defaults to 24h.
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;

export function agentGrantSessionTtlSeconds(): number {
  const configured = Number(process.env.AGENT_GRANT_SESSION_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SESSION_TTL_SECONDS;
}

// Same rolling window #orders-service's daily cap uses, so the grant-scoped rolling
// cap reads the same intuitive "per day" as the app-wide one it layers on top of.
const ROLLING_WINDOW_SECONDS = 24 * 60 * 60;

// ponytail: CREATE TABLE IF NOT EXISTS instead of a migration framework — fine at hackathon scale.
export async function ensureAgentGrantSchema(): Promise<void> {
  await pool.query(`
    create table if not exists agent_grants (
      id uuid primary key default gen_random_uuid(),
      grant_jti text not null unique,
      user_id text not null,
      destination_address text not null,
      per_tx_cap_usdc numeric(12,2) not null,
      rolling_cap_usdc numeric(12,2) not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index if not exists agent_grants_user_idx on agent_grants (user_id, created_at);
  `);
}

const AGENT_GRANT_COLUMNS_SQL = `id, grant_jti, user_id, destination_address, per_tx_cap_usdc,
  rolling_cap_usdc, expires_at, revoked_at, created_at`;

export interface AgentGrantRow {
  id: string;
  grant_jti: string;
  user_id: string;
  destination_address: string;
  per_tx_cap_usdc: string;
  rolling_cap_usdc: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface RecordAgentGrantInput {
  userId: string;
  grantJti: string;
  // Always the server-side merchant payout address, never client-supplied — the
  // scope's whole point is to bound *where* an agent-initiated transfer can go, so
  // letting a caller pick this would defeat it. #agent-route passes
  // merchantPayoutAddress() here, the same source #orders-service.reserveOrder uses.
  destinationAddress: string;
}

// Mints the scoped policy row for a freshly-signed agent grant. Called once, at the
// same time #agent-route.signAgentGrant() mints the JWT, so a grant and its policy
// always exist together.
export async function recordAgentGrant(input: RecordAgentGrantInput): Promise<AgentGrantRow> {
  await ensureAgentGrantSchema();
  const ttlSeconds = agentGrantSessionTtlSeconds();
  const { rows } = await pool.query<AgentGrantRow>(
    `insert into agent_grants
       (grant_jti, user_id, destination_address, per_tx_cap_usdc, rolling_cap_usdc, expires_at)
     values ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval)
     returning ${AGENT_GRANT_COLUMNS_SQL}`,
    [input.grantJti, input.userId, input.destinationAddress, PER_TX_CAP_USDC, DAILY_CAP_USDC, String(ttlSeconds)],
  );
  log.component("#agent-grants-service").info("Recorded scoped agent grant", {
    grantId: rows[0].id,
    userId: input.userId,
    expiresAt: rows[0].expires_at,
  });
  return rows[0];
}

export async function getAgentGrantByJti(grantJti: string): Promise<AgentGrantRow | null> {
  await ensureAgentGrantSchema();
  const { rows } = await pool.query<AgentGrantRow>(
    `select ${AGENT_GRANT_COLUMNS_SQL} from agent_grants where grant_jti = $1`,
    [grantJti],
  );
  return rows[0] ?? null;
}

export async function getAgentGrantById(grantId: string): Promise<AgentGrantRow | null> {
  await ensureAgentGrantSchema();
  const { rows } = await pool.query<AgentGrantRow>(
    `select ${AGENT_GRANT_COLUMNS_SQL} from agent_grants where id = $1`,
    [grantId],
  );
  return rows[0] ?? null;
}

// Revokes a grant early — the mechanism for cutting off a leaked/compromised agent
// grant without waiting out its (long, 365d) JWT lifetime or even its session TTL.
// Scoped to `userId` so only the human who minted a grant can revoke it. Idempotent:
// revoking an already-revoked grant keeps its original revoked_at and still succeeds.
// Returns null if no grant with that id belongs to this user (never reveals whether a
// grant id exists for someone else's account).
export async function revokeAgentGrant(grantId: string, userId: string): Promise<AgentGrantRow | null> {
  await ensureAgentGrantSchema();
  const { rows } = await pool.query<AgentGrantRow>(
    `update agent_grants
     set revoked_at = coalesce(revoked_at, now())
     where id = $1 and user_id = $2
     returning ${AGENT_GRANT_COLUMNS_SQL}`,
    [grantId, userId],
  );
  return rows[0] ?? null;
}

export type GrantScopeDenialReason =
  | "grant_not_found"
  | "grant_revoked"
  | "grant_expired"
  | "destination_mismatch"
  | "per_tx_cap"
  | "rolling_cap";

export interface GrantScopeResult {
  ok: boolean;
  reason?: GrantScopeDenialReason;
}

// A queryable is either the shared pool or a checked-out client — mirrors
// #orders-service.evaluateSpendPolicy's Queryable seam, though this call site
// (settleVerifiedSession) doesn't currently run inside a transaction of its own.
type Queryable = Pick<typeof pool, "query">;

// The actual "session key" check: does this specific order fall within the scoped
// policy its originating grant recorded? Checked at settlement time (not just at
// /agent/checkout initiation) so a grant revoked *between* initiation and the human
// completing the personhood check still blocks the charge.
export async function evaluateGrantScope(
  grant: AgentGrantRow,
  order: { destination_address: string; amount_usdc: string },
  queryable: Queryable = pool,
): Promise<GrantScopeResult> {
  if (grant.revoked_at) {
    log.gate("^grant-scope-valid").warn("Agent grant scope denied: revoked", { grantId: grant.id });
    return { ok: false, reason: "grant_revoked" };
  }
  if (new Date(grant.expires_at).getTime() <= Date.now()) {
    log.gate("^grant-scope-valid").warn("Agent grant scope denied: expired", { grantId: grant.id });
    return { ok: false, reason: "grant_expired" };
  }
  if (order.destination_address !== grant.destination_address) {
    log.gate("^grant-scope-valid").warn("Agent grant scope denied: destination mismatch", { grantId: grant.id });
    return { ok: false, reason: "destination_mismatch" };
  }
  const amountUsdc = Number(order.amount_usdc);
  if (amountUsdc > Number(grant.per_tx_cap_usdc)) {
    log.gate("^grant-scope-valid").warn("Agent grant scope denied: per-tx cap", { grantId: grant.id, amountUsdc });
    return { ok: false, reason: "per_tx_cap" };
  }

  const { rows } = await queryable.query<{ total: string | null }>(
    `select sum(amount_usdc) as total from orders
     where agent_grant_id = $1 and status not in ('failed', 'denied', 'cancelled')
       and created_at > now() - interval '${ROLLING_WINDOW_SECONDS} seconds'`,
    [grant.id],
  );
  const rollingTotal = Number(rows[0]?.total ?? 0);
  if (rollingTotal > Number(grant.rolling_cap_usdc)) {
    log.gate("^grant-scope-valid").warn("Agent grant scope denied: rolling cap", {
      grantId: grant.id,
      rollingTotal,
    });
    return { ok: false, reason: "rolling_cap" };
  }
  return { ok: true };
}
