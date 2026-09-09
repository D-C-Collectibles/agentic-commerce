// #ledger-route — enrolls a human's Ledger device and lets it answer pending
// ^ledger-confirmed approval requests raised by #checkout-route/#verify-route (via
// #ledger-confirm-service). All routes require the caller's own ^authenticated user
// token (never an agent grant) — a human enrolls their own device and only their own
// device can answer their own approvals.
//   GET  /ledger/enroll-nonce            — issue a one-time nonce to sign for enrollment
//   POST /ledger/enroll                  — bind a signerAddress to the caller, proven by
//                                          a signature over that nonce
//   GET  /ledger/pending-approvals       — the caller's own pending, unexpired approvals
//                                          (typed-data payload to sign)
//   POST /ledger/approvals/:approvalId   — submit a device signature, verified against
//                                          the STORED order snapshot
//   GET  /ledger/mock/:approvalId        — LEDGER_CONFIRM_MODE=mock only: click-through
//                                          auto-approve (mirrors #worldid-service's mock
//                                          verification page), for demoing without
//                                          hardware. Disabled (409) outside mock mode.

import { Router, type Request } from "express";
import { log } from "@a-company/paradigm-logger";
import { asyncHandler } from "../async-handler.js";
import { GRANT_AUDIENCE, verifyBearer } from "../services/auth.js";
import {
  buildApprovalTypedData,
  enrollDevice,
  getApprovalById,
  getPendingApprovalsForUser,
  issueEnrollNonce,
  LEDGER_CONFIRM_MODE,
  ledgerConfirmMode,
  mockApproveApproval,
  verifyApproval,
  verifyEnrollSignature,
} from "../services/ledger-confirm.js";

export const ledgerRouter = Router();

function requireUser(req: Request) {
  return verifyBearer(req.header("authorization"), GRANT_AUDIENCE.user);
}

ledgerRouter.get(
  "/ledger/enroll-nonce",
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json(issueEnrollNonce(user.userId));
  }),
);

ledgerRouter.post(
  "/ledger/enroll",
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { signerAddress, signature } = (req.body ?? {}) as { signerAddress?: unknown; signature?: unknown };
    if (typeof signerAddress !== "string" || !signerAddress || typeof signature !== "string" || !signature) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    if (!verifyEnrollSignature(user.userId, signerAddress, signature)) {
      log.gate("^ledger-confirmed").warn("Ledger enrollment rejected: nonce signature invalid/expired", {
        userId: user.userId,
      });
      res.status(401).json({ error: "invalid_signature" });
      return;
    }
    const device = await enrollDevice(user.userId, signerAddress);
    // !ledger-device-enrolled
    res.status(201).json({ signerAddress: device.signerAddress, enrolledAt: device.enrolledAt });
  }),
);

ledgerRouter.get(
  "/ledger/pending-approvals",
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const approvals = await getPendingApprovalsForUser(user.userId);
    res.json({
      approvals: approvals.map((approval) => ({
        approvalId: approval.id,
        orderId: approval.order_id,
        expiresAt: approval.expires_at,
        typedData: buildApprovalTypedData(approval.order_snapshot),
      })),
    });
  }),
);

ledgerRouter.post(
  "/ledger/approvals/:approvalId",
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { signerAddress, signature } = (req.body ?? {}) as { signerAddress?: unknown; signature?: unknown };
    if (typeof signerAddress !== "string" || !signerAddress || typeof signature !== "string" || !signature) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const approval = await getApprovalById(req.params.approvalId);
    // Never reveals whether an approvalId exists for someone else's account.
    if (!approval || approval.user_id !== user.userId) {
      res.status(404).json({ error: "unknown_approval" });
      return;
    }

    const outcome = await verifyApproval(req.params.approvalId, signerAddress, signature);
    if (!outcome.ok) {
      res.status(outcome.reason === "not_found" ? 404 : 409).json({ error: outcome.reason });
      return;
    }
    // !ledger-approval-verified
    res.json({ approvalId: outcome.approval.id, orderId: outcome.approval.order_id, status: outcome.approval.status });
  }),
);

// LEDGER_CONFIRM_MODE=mock only — click-through approval page, no signature required.
// Mirrors #worldid-service's VERIFICATION_MODE=mock page. Never available in `ledger`
// mode, so it can't be used to bypass a real device.
ledgerRouter.get(
  "/ledger/mock/:approvalId",
  asyncHandler(async (req, res) => {
    if (ledgerConfirmMode() !== LEDGER_CONFIRM_MODE.mock) {
      res.status(409).json({ error: "mock_mode_only" });
      return;
    }
    const outcome = await mockApproveApproval(req.params.approvalId);
    if (!outcome.ok) {
      res.status(outcome.reason === "not_found" ? 404 : 409).json({ error: outcome.reason });
      return;
    }
    res.json({ approvalId: outcome.approval.id, orderId: outcome.approval.order_id, status: outcome.approval.status });
  }),
);
