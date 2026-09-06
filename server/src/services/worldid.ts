// #worldid-service — real World ID Selfie Check integration behind the
// ^personhood-verified gate. VERIFICATION_MODE=mock (default) keeps the click-through
// mock; =world mints an RP signature with the secret signing key (so the SPA can render
// the IDKit Selfie Check widget) and verifies the returned proof against the World
// Developer Portal. Swapped in behind a flag so the mock flow keeps working untouched.

import { signRequest } from "@worldcoin/idkit-core/signing";

export const VERIFICATION_MODE = {
  mock: "mock",
  world: "world",
} as const;
export type VerificationMode = (typeof VERIFICATION_MODE)[keyof typeof VERIFICATION_MODE];

// Selfie Check credential id (World ID v4). Kept explicit so the SPA requests the same one.
export const WORLD_CREDENTIAL = "selfie" as const;

// Where World verifies a submitted proof; the rp_id is part of the path.
const WORLD_VERIFY_ENDPOINT = "https://developer.world.org/api/v4/verify";

export function verificationMode(): VerificationMode {
  return process.env.VERIFICATION_MODE === VERIFICATION_MODE.world
    ? VERIFICATION_MODE.world
    : VERIFICATION_MODE.mock;
}

interface WorldConfig {
  appId: string;
  rpId: string;
  signingKey: string;
}

function worldConfig(): WorldConfig {
  const appId = process.env.WORLD_APP_ID;
  const rpId = process.env.WORLD_RP_ID;
  const signingKey = process.env.WORLD_RP_SIGNING_KEY;
  if (!appId || !rpId || !signingKey) {
    throw new Error(
      "WORLD_APP_ID, WORLD_RP_ID and WORLD_RP_SIGNING_KEY are required for " +
        "VERIFICATION_MODE=world (see server/.env.example)",
    );
  }
  return { appId, rpId, signingKey };
}

// The World ID action binds a proof to this specific purchase, so a proof from one
// session can't authorize another. Backend and SPA must use the same action string.
export function verificationAction(sessionId: string): string {
  return `agentic-purchase:${sessionId}`;
}

// Mirrors IDKit's RpContext ({ rp_id, nonce, created_at, expires_at, signature }).
export interface RpContext {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
}

export interface VerificationContext {
  mode: VerificationMode;
  credential: typeof WORLD_CREDENTIAL;
  appId?: string;
  action?: string;
  rpContext?: RpContext;
}

// What the SPA needs to render the Selfie Check widget for a session. In mock mode it
// carries no World config (the SPA shows the mock confirm instead).
export function buildVerificationContext(sessionId: string): VerificationContext {
  if (verificationMode() === VERIFICATION_MODE.mock) {
    return { mode: VERIFICATION_MODE.mock, credential: WORLD_CREDENTIAL };
  }
  const { appId, rpId, signingKey } = worldConfig();
  const action = verificationAction(sessionId);
  const signature = signRequest({ signingKeyHex: signingKey, action });
  return {
    mode: VERIFICATION_MODE.world,
    credential: WORLD_CREDENTIAL,
    appId,
    action,
    rpContext: {
      rp_id: rpId,
      nonce: signature.nonce,
      created_at: signature.createdAt,
      expires_at: signature.expiresAt,
      signature: signature.sig,
    },
  };
}

// Verifies an IDKit proof response with the World Developer Portal. The payload is
// forwarded verbatim (no field remapping). Returns true iff World accepts it.
export async function verifyWorldProof(idkitResponse: unknown): Promise<boolean> {
  const { rpId } = worldConfig();
  const res = await fetch(`${WORLD_VERIFY_ENDPOINT}/${rpId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(idkitResponse),
  });
  return res.ok;
}
