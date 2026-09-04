// #wallet-service — see .purpose in this directory.
//
// TODO: wire up @circle-fin/developer-controlled-wallets once CIRCLE_API_KEY /
// ENTITY_SECRET are registered (see server/.env.example). The developer must
// generate and register the entity secret themselves — do not do this on
// their behalf: https://developers.circle.com/wallets/dev-controlled/register-entity-secret

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

export async function getOrCreateUserWallet(_userId: string): Promise<{ address: string }> {
  throw new Error("not implemented: wire up Circle Developer-Controlled Wallets SDK");
}

export async function transferUsdc(_req: WalletTransferRequest): Promise<WalletTransferResult> {
  throw new Error("not implemented: wire up Circle Developer-Controlled Wallets SDK");
}
