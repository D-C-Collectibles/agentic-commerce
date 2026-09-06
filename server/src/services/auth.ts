// #auth-service — see .purpose in this directory.
//
// Email + password accounts for the storefront demo. Passwords are bcrypt-hashed;
// a successful login/signup issues a signed JWT (the `sub` claim is the user id).
// The JWT replaces the earlier Bearer=userId stand-in as the ^authenticated proof.
//
// ponytail: tech-demo auth. Real hardening (email verification, password reset,
// rate limiting, refresh tokens, rotating secret) is out of scope for the hackathon.

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const BCRYPT_ROUNDS = 10;
const TOKEN_TTL = "7d";
// Long-lived so an agent can be authorized once and keep acting; revocation is a
// later feature (see ponytail in .purpose).
const AGENT_GRANT_TTL = "365d";

// Which principal a token authorizes. A `user` token is a human's browser session
// (the ungated checkout path); an `agent` token is a grant the human minted for an
// AI agent (the ^personhood-verified checkout path). The distinction is carried in
// the JWT `aud` claim so it can't be forged by the caller — an agent can't present
// itself as a human to skip the selfie check.
export const GRANT_AUDIENCE = {
  user: "user",
  agent: "agent",
} as const;
export type GrantAudience = (typeof GRANT_AUDIENCE)[keyof typeof GRANT_AUDIENCE];

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthResult {
  token: string;
  user: AuthUser;
}

export interface VerifiedToken {
  userId: string;
  email: string;
  audience: GrantAudience;
}

// Read lazily (not at import) so unauthenticated routes like GET /products still
// boot when JWT_SECRET is unset. Only the auth path requires it.
function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set (see server/.env.example)");
  }
  return secret;
}

// ponytail: CREATE TABLE IF NOT EXISTS instead of a migration framework — fine at hackathon scale.
async function ensureSchema(): Promise<void> {
  await pool.query(`
    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      password_hash text not null,
      created_at timestamptz not null default now()
    );
  `);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Deliberately loose — a real system would verify deliverability, not shape.
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function signToken(user: AuthUser): string {
  return jwt.sign({ email: user.email }, jwtSecret(), {
    subject: user.id,
    audience: GRANT_AUDIENCE.user,
    expiresIn: TOKEN_TTL,
  });
}

// Mints an agent grant for an already-authenticated user. The holder (an MCP server
// on the user's machine) can query and initiate purchases on the user's behalf, but
// every purchase it starts is forced down the ^personhood-verified path.
export function signAgentGrant(user: AuthUser): string {
  return jwt.sign({ email: user.email }, jwtSecret(), {
    subject: user.id,
    audience: GRANT_AUDIENCE.agent,
    expiresIn: AGENT_GRANT_TTL,
  });
}

// Returns the user id + which principal the token authorizes, or null if it is
// missing/invalid/expired. Tokens issued before audiences existed (no `aud`) are
// treated as user tokens for backward compatibility.
export function verifyToken(token: string | undefined): VerifiedToken | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret());
    if (typeof payload !== "object" || payload === null) return null;
    const sub = payload.sub;
    if (typeof sub !== "string" || !sub) return null;
    const audience = payload.aud === GRANT_AUDIENCE.agent ? GRANT_AUDIENCE.agent : GRANT_AUDIENCE.user;
    const email = typeof payload.email === "string" ? payload.email : "";
    return { userId: sub, email, audience };
  } catch {
    return null;
  }
}

// Pulls a bearer token out of an Authorization header and verifies it, optionally
// requiring a specific audience. Centralized so every route enforces the same shape.
export function verifyBearer(
  authHeader: string | undefined,
  requiredAudience?: GrantAudience,
): VerifiedToken | null {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  const verified = verifyToken(token || undefined);
  if (!verified) return null;
  if (requiredAudience && verified.audience !== requiredAudience) return null;
  return verified;
}

export async function createUser(rawEmail: string, password: string): Promise<AuthResult> {
  await ensureSchema();
  const email = normalizeEmail(rawEmail);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const { rows } = await pool.query<{ id: string; email: string }>(
    `insert into users (email, password_hash) values ($1, $2)
     on conflict (email) do nothing
     returning id, email`,
    [email, passwordHash],
  );

  const row = rows[0];
  if (!row) {
    // conflict → email already registered
    const err = new Error("email_taken") as Error & { code?: string };
    err.code = "email_taken";
    throw err;
  }

  const user: AuthUser = { id: row.id, email: row.email };
  return { token: signToken(user), user };
}

export async function authenticateUser(rawEmail: string, password: string): Promise<AuthResult | null> {
  await ensureSchema();
  const email = normalizeEmail(rawEmail);

  const { rows } = await pool.query<{ id: string; email: string; password_hash: string }>(
    "select id, email, password_hash from users where email = $1",
    [email],
  );
  const row = rows[0];
  if (!row) return null;

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return null;

  const user: AuthUser = { id: row.id, email: row.email };
  return { token: signToken(user), user };
}
