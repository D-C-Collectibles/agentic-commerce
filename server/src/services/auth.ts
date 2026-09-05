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

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthResult {
  token: string;
  user: AuthUser;
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
  return jwt.sign({ email: user.email }, jwtSecret(), { subject: user.id, expiresIn: TOKEN_TTL });
}

// Returns the user id (JWT `sub`) or null if the token is missing/invalid/expired.
export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret());
    const sub = typeof payload === "object" ? payload.sub : undefined;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    return null;
  }
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
