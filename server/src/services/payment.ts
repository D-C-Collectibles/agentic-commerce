// #payment-service — abstracts the actual money movement so both checkout paths share
// one implementation and the whole flow runs without Circle creds during development.
// PAYMENTS_MODE=mock (the default) settles instantly; PAYMENTS_MODE=circle routes
// through #wallet-service for a real Arc-testnet USDC transfer.
//
// ^ledger-confirmed: executePayment() takes the full, DB-sourced order row (never
// discrete caller-supplied fields) and, for any user with an enrolled Ledger device
// (#ledger-confirm-service), re-checks the STORED ledger_approvals row for that exact
// order id is 'approved' before doing anything else. This is the single call site both
// checkout legs share, so there is no plain-argument path into transferUsdc() that
// skips it — see #checkout-route/#verify-route, which must call resolveLedgerGate()
// themselves first only to decide what to show the caller while waiting, not to gate
// this function (this function gates itself, redundantly, on purpose).

import { randomUUID } from "node:crypto";
import { log } from "@a-company/paradigm-logger";
import { getEnrolledDevice, getApprovalForOrder } from "./ledger-confirm.js";
import { getOrCreateUserWallet, transferUsdc } from "./wallet.js";
import { ORDER_STATUS, type OrderRow, type OrderStatus } from "./orders.js";

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
  // The authoritative order row (from #orders-service.reserveOrder()/getOrder()), never
  // hand-constructed fields — see the ^ledger-confirmed comment above.
  order: OrderRow;
}

export interface PaymentResult {
  transactionId: string;
  // The order status to persist. Mock settles synchronously (confirmed); a real Circle
  // transfer is only submitted here and the Circle webhook later flips it to
  // confirmed/failed (#circle-webhook-route).
  orderStatus: OrderStatus;
  state: string;
}

// Thrown when the order's user has an enrolled Ledger device but no approved
// ledger_approvals row exists for this exact order yet. Callers should have already
// called #ledger-confirm-service.resolveLedgerGate() to surface a friendlier
// pending/denied response before ever reaching here — this throw only fires if that
// call site's own gate is somehow bypassed, which is exactly what it must not be
// possible to do silently.
export class LedgerConfirmationRequiredError extends Error {
  constructor(public readonly orderId: string) {
    super(`ledger_confirmation_required:${orderId}`);
    this.name = "LedgerConfirmationRequiredError";
  }
}

export async function executePayment(request: PaymentRequest): Promise<PaymentResult> {
  const { order } = request;

  const device = await getEnrolledDevice(order.user_id);
  if (device) {
    const approval = await getApprovalForOrder(order.id);
    if (!approval || approval.status !== "approved") {
      log.gate("^ledger-confirmed").error("Payment blocked: no approved Ledger confirmation for this order", {
        orderId: order.id,
      });
      throw new LedgerConfirmationRequiredError(order.id);
    }
  }

  if (paymentsMode() === PAYMENTS_MODE.mock) {
    return { transactionId: `mock_${randomUUID()}`, orderStatus: ORDER_STATUS.confirmed, state: "COMPLETE" };
  }

  await getOrCreateUserWallet(order.user_id);
  const transfer = await transferUsdc({
    userId: order.user_id,
    destinationAddress: order.destination_address,
    amountUsdc: Number(order.amount_usdc).toFixed(2),
    idempotencyKey: order.idempotency_key,
  });
  return { transactionId: transfer.circleTransactionId, orderStatus: ORDER_STATUS.submitted, state: transfer.state };
}
