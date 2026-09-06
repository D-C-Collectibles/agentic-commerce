// #payment-service — abstracts the actual money movement so both checkout paths share
// one implementation and the whole flow runs without Circle creds during development.
// PAYMENTS_MODE=mock (the default) settles instantly; PAYMENTS_MODE=circle routes
// through #wallet-service for a real Arc-testnet USDC transfer.

import { randomUUID } from "node:crypto";
import { getOrCreateUserWallet, transferUsdc } from "./wallet.js";
import { ORDER_STATUS, type OrderStatus } from "./orders.js";

export const PAYMENTS_MODE = {
  mock: "mock",
  circle: "circle",
} as const;
export type PaymentsMode = (typeof PAYMENTS_MODE)[keyof typeof PAYMENTS_MODE];

export function paymentsMode(): PaymentsMode {
  return process.env.PAYMENTS_MODE === PAYMENTS_MODE.circle ? PAYMENTS_MODE.circle : PAYMENTS_MODE.mock;
}

// Merchant payout address. Real mode requires it; mock mode falls back to a placeholder
// so the flow works with nothing configured.
export function merchantPayoutAddress(): string {
  const configured = process.env.MERCHANT_PAYOUT_ADDRESS;
  if (paymentsMode() === PAYMENTS_MODE.mock) return configured || "MOCK_MERCHANT";
  if (!configured) {
    throw new Error("MERCHANT_PAYOUT_ADDRESS is not set (see server/.env.example)");
  }
  return configured;
}

export interface PaymentRequest {
  userId: string;
  destinationAddress: string;
  amountUsdc: number;
  idempotencyKey: string;
}

export interface PaymentResult {
  transactionId: string;
  // The order status to persist. Mock settles synchronously (confirmed); a real Circle
  // transfer is only submitted here and the Circle webhook later flips it to
  // confirmed/failed (#circle-webhook-route).
  orderStatus: OrderStatus;
  state: string;
}

export async function executePayment(request: PaymentRequest): Promise<PaymentResult> {
  if (paymentsMode() === PAYMENTS_MODE.mock) {
    return { transactionId: `mock_${randomUUID()}`, orderStatus: ORDER_STATUS.confirmed, state: "COMPLETE" };
  }

  await getOrCreateUserWallet(request.userId);
  const transfer = await transferUsdc({
    userId: request.userId,
    destinationAddress: request.destinationAddress,
    amountUsdc: request.amountUsdc.toFixed(2),
    idempotencyKey: request.idempotencyKey,
  });
  return { transactionId: transfer.circleTransactionId, orderStatus: ORDER_STATUS.submitted, state: transfer.state };
}
