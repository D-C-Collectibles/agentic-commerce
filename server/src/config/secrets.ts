// #secrets-service — seam for secret retrieval.
//
// This is NOT a real secrets-manager integration (no AWS Secrets Manager, GCP Secret
// Manager, or Vault SDK is wired up here — that requires infra this repo doesn't have
// yet). By default every secret is still read from `process.env` under the hood,
// exactly like before. The point is that call sites (#wallet-service, #auth-service,
// #worldid-service) ask `getSecret()`/`requireSecret()` for a named secret instead of
// reading `process.env.X` directly, so swapping the body of this module for a real
// secrets-manager client later is a one-file change, not a grep-and-replace across the
// codebase.
//
// `SECRETS_BACKEND=ledger-ring` swaps that body for exactly that kind of backend: it
// shells out to the Ledger `wallet-cli ring decrypt --key <name>` command (no device
// present, network-only — see .paradigm/specs/wallet-checkout.md "Secrets backend") to
// retrieve a value that was encrypted at rest via a one-time, device-present
// `ring init` / `ring encrypt` ops step. That provisioning step is NOT scripted here —
// it requires a human with the physical Ledger device and is documented as a manual
// step in .env.example.

import { execFileSync } from "node:child_process";

export const SECRET_NAMES = {
  jwtSecret: "JWT_SECRET",
  circleApiKey: "CIRCLE_API_KEY",
  circleEntitySecret: "CIRCLE_ENTITY_SECRET",
  worldRpSigningKey: "WORLD_RP_SIGNING_KEY",
} as const;
export type SecretName = (typeof SECRET_NAMES)[keyof typeof SECRET_NAMES];

// Read lazily (never cached at import time) so routes that don't need a given secret
// still boot when it's unset — matches the existing per-service lazy-read pattern.
function readEnvSecret(name: string): string | undefined {
  return process.env[name];
}

function secretsBackend(): "env" | "ledger-ring" {
  return process.env.SECRETS_BACKEND === "ledger-ring" ? "ledger-ring" : "env";
}

// Per-key in-memory cache for the ledger-ring backend, so the (comparatively slow,
// network-dependent) `wallet-cli ring decrypt` shell-out only happens once per key per
// process — mirrors the existing lazy-but-cheap env read, just with an explicit cache
// since a shell-out isn't free like a process.env lookup.
const ledgerRingCache = new Map<string, string>();

// Deliberately swallows and never rethrows the underlying error's message/stdout/stderr
// — that could contain partial decrypted output or CLI diagnostics naming other keys in
// the ring. Only the secret *name* and a static hint are ever surfaced.
function readLedgerRingSecret(name: string): string | undefined {
  const cached = ledgerRingCache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  let stdout: string;
  try {
    stdout = execFileSync("wallet-cli", ["ring", "decrypt", "--key", name], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
  } catch {
    throw new Error(
      `Unable to retrieve secret "${name}" from the ledger-ring backend (wallet-cli ` +
        `not installed, the key is missing from the ring, or the decrypt command ` +
        `failed — see .paradigm/specs/wallet-checkout.md "Secrets backend").`,
    );
  }

  const value = stdout.trim();
  if (!value) {
    throw new Error(
      `Unable to retrieve secret "${name}" from the ledger-ring backend (empty ` +
        `output — see .paradigm/specs/wallet-checkout.md "Secrets backend").`,
    );
  }

  ledgerRingCache.set(name, value);
  return value;
}

export function getSecret(name: SecretName): string | undefined {
  if (secretsBackend() === "ledger-ring") {
    return readLedgerRingSecret(name);
  }
  return readEnvSecret(name);
}

export function requireSecret(name: SecretName, hint: string): string {
  const value = getSecret(name);
  if (!value) {
    throw new Error(`${name} is required (${hint})`);
  }
  return value;
}

// #wallet-sharding: a wallet shard CAN have its own scoped Circle credential —
// `${base}_${shardId}` (e.g. `CIRCLE_API_KEY_2`) — falling back to the single, unscoped
// `base` secret when no shard-specific one is set. That fallback is what keeps a
// SHARD_COUNT=1 deployment (and any shard before its own scoped key is provisioned in
// Circle's console) byte-for-byte the same credential lookup as before sharding existed.
export function getShardedSecret(base: SecretName, shardId: number): string | undefined {
  return readEnvSecret(`${base}_${shardId}`) ?? getSecret(base);
}
