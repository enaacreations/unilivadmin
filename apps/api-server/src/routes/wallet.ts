// ─────────────────────────────────────────────────────────────────────────────
// UNILIV Wallet — API Routes
// Mounted as router.use(walletRouter) in routes/index.ts (no prefix)
// All paths are relative to /api/
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import {
  db,
  walletsTable,
  walletTransactionsTable,
  walletConfigTable,
  residentsTable,
  propertiesTable,
  ledgerEntriesTable,
  paymentsTable,
} from "@workspace/db";
import { eq, desc, and, sql, inArray, asc } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { assertPropertyAccess, scopedPropertyId, httpError, isSuperAdmin } from "../lib/authz.js";
import { newId } from "../lib/id.js";
import {
  getOrCreateWallet,
  getWalletConfig,
  creditWallet,
  debitWallet,
  writeAuditLog,
} from "../lib/wallet-service.js";
import { notificationOutboxTable } from "@workspace/db";
import { enqueueDelivery, processDelivery, queueEnabled } from "@workspace/notify-core";
import {
  createPaymentLink,
  isRazorpayConfigured,
  toPaise,
  RazorpayNotConfiguredError,
} from "../lib/razorpay.js";

export const walletRouter: Router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Ad-hoc outbound message helper (shares the durable outbox + delivery pipeline).
// Used to share top-up payment links with the resident; userId is left null and
// toAddress is set explicitly. Best-effort/non-throwing.
// ─────────────────────────────────────────────────────────────────────────────
async function sendAdHoc(
  channel: "SMS" | "EMAIL",
  toAddress: string,
  body: string,
  opts: { subject?: string; entityType?: string; entityId?: string } = {},
): Promise<void> {
  try {
    const id = newId();
    await db.insert(notificationOutboxTable).values({
      id,
      userId: null,
      channel,
      toAddress,
      subject: opts.subject ?? null,
      body,
      entityType: opts.entityType ?? null,
      entityId: opts.entityId ?? null,
      status: "PENDING",
    });
    if (queueEnabled()) {
      const queued = await enqueueDelivery(id);
      if (!queued) await processDelivery(id);
    } else {
      await processDelivery(id);
    }
  } catch {
    // swallow — delivery failure must never break the API request
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency helper
// Money-mutating endpoints accept an optional `Idempotency-Key` header or
// `idempotencyKey` body field. When supplied, the key is persisted on the
// resulting wallet_transactions row via the existing `referenceId` column
// (namespaced with referenceType="IDEMPOTENCY") so a replayed request can be
// detected inside the locked transaction and the original result returned
// instead of applying the operation twice. No schema/migration is introduced.
// ─────────────────────────────────────────────────────────────────────────────
const IDEMPOTENCY_REF_TYPE = "IDEMPOTENCY";

function getIdempotencyKey(req: { headers: Record<string, unknown>; body?: any }): string | null {
  const header = req.headers["idempotency-key"];
  const raw =
    (typeof header === "string" && header) ||
    (Array.isArray(header) && typeof header[0] === "string" && header[0]) ||
    (req.body && typeof req.body.idempotencyKey === "string" && req.body.idempotencyKey) ||
    null;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}

/** Serialize a wallet transaction row to the API response shape. */
function serializeTxn(txn: {
  amount: unknown;
  balanceBefore: unknown;
  balanceAfter: unknown;
  [k: string]: unknown;
}) {
  return {
    ...txn,
    amount: Number(txn.amount),
    balanceBefore: Number(txn.balanceBefore),
    balanceAfter: Number(txn.balanceAfter),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet/residents/:residentId
// Wallet summary — lazily creates the wallet row on first access
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.get(
  "/wallet/residents/:residentId",
  authenticate,
  authorize("WALLET", "view"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const [resident] = await db
        .select({
          name: residentsTable.name,
          walletEnabled: residentsTable.walletEnabled,
          propertyId: residentsTable.propertyId,
        })
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
      assertPropertyAccess(req, resident.propertyId);
      const wallet = await getOrCreateWallet(residentId);
      const [txCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(walletTransactionsTable)
        .where(eq(walletTransactionsTable.walletId, wallet.id));
      res.json({
        success: true,
        data: {
          ...wallet,
          balance: Number(wallet.balance),
          residentName: resident.name,
          walletEnabled: resident.walletEnabled,
          transactionCount: txCount?.count ?? 0,
        },
      });
    } catch (err: any) {
      if (err?.statusCode === 403) {
        res.status(403).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet/residents/:residentId/transactions
// Paginated transaction history
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.get(
  "/wallet/residents/:residentId/transactions",
  authenticate,
  authorize("WALLET", "view"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
      const offset = Number(req.query["offset"] ?? 0);

      const [resident] = await db
        .select({ propertyId: residentsTable.propertyId })
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
      assertPropertyAccess(req, resident.propertyId);

      const wallet = await getOrCreateWallet(residentId);
      const rows = await db
        .select()
        .from(walletTransactionsTable)
        .where(eq(walletTransactionsTable.walletId, wallet.id))
        .orderBy(desc(walletTransactionsTable.createdAt))
        .limit(limit)
        .offset(offset);

      const [total] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(walletTransactionsTable)
        .where(eq(walletTransactionsTable.walletId, wallet.id));

      res.json({
        success: true,
        data: rows.map((r) => ({
          ...r,
          amount: Number(r.amount),
          balanceBefore: Number(r.balanceBefore),
          balanceAfter: Number(r.balanceAfter),
        })),
        meta: { total: total?.count ?? 0, limit, offset },
      });
    } catch (err: any) {
      if (err?.statusCode === 403) {
        res.status(403).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/residents/:residentId/topup
// Credit wallet — atomic, audited
// Body: { amount: number (max 50000), notes?: string }
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.post(
  "/wallet/residents/:residentId/topup",
  authenticate,
  authorize("WALLET", "create"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const body = req.body || {};
      const amount = Number(body.amount);

      if (!amount || amount <= 0) {
        res.status(400).json({ success: false, error: "amount must be a positive number" });
        return;
      }
      if (amount > 50000) {
        res.status(400).json({ success: false, error: "Maximum single top-up is ₹50,000" });
        return;
      }

      const [resident] = await db
        .select()
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
      assertPropertyAccess(req, resident.propertyId);
      if (!resident.walletEnabled) {
        res.status(400).json({ success: false, error: "Wallet is disabled for this resident" });
        return;
      }

      const wallet = await getOrCreateWallet(residentId);
      if (!wallet.isActive) {
        res.status(400).json({ success: false, error: "Wallet is inactive" });
        return;
      }

      const idempotencyKey = getIdempotencyKey(req);

      const result = await db.transaction(async (tx) => {
        // Idempotency: re-apply guard inside the locked path. If a prior txn
        // for this wallet already used this key, return it unchanged.
        if (idempotencyKey) {
          const [existing] = await tx
            .select()
            .from(walletTransactionsTable)
            .where(
              and(
                eq(walletTransactionsTable.walletId, wallet.id),
                eq(walletTransactionsTable.referenceType, IDEMPOTENCY_REF_TYPE),
                eq(walletTransactionsTable.referenceId, idempotencyKey)
              )
            );
          if (existing) return { txn: existing, balanceAfter: Number(existing.balanceAfter), replayed: true };
        }
        const r = await creditWallet(wallet.id, amount, "TOPUP", {
          description: `Cash top-up by ${req.user!.email}`,
          recordedBy: req.user!.id,
          propertyId: resident.propertyId,
          notes: body.notes ?? null,
          referenceId: idempotencyKey ?? null,
          referenceType: idempotencyKey ? IDEMPOTENCY_REF_TYPE : null,
        }, tx);
        return { ...r, replayed: false };
      });

      // Audit log (outside transaction — fire and forget). Skip on replay.
      if (!result.replayed) {
        writeAuditLog(req.user!.id, "TOPUP", "wallet", wallet.id, { amount, residentId });
      }

      res.json({
        success: true,
        data: {
          ...serializeTxn(result.txn),
          newBalance: result.balanceAfter,
        },
      });
    } catch (err: any) {
      if (err?.statusCode === 403) {
        res.status(403).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/:residentId/topup-link  (O29)
// Create a Razorpay payment link to top up the resident's wallet and share it
// via SMS/email. Link expires in 24h and allows partial payment.
// Body: { amount: number }. 503 when Razorpay is not configured.
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.post(
  "/wallet/:residentId/topup-link",
  authenticate,
  authorize("WALLET", "create"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const amount = Number((req.body || {}).amount);

      if (!amount || amount <= 0) {
        res.status(400).json({ success: false, error: "amount must be a positive number" });
        return;
      }

      const [resident] = await db
        .select()
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
      assertPropertyAccess(req, resident.propertyId);
      if (!resident.walletEnabled) {
        res.status(400).json({ success: false, error: "Wallet is disabled for this resident" });
        return;
      }

      if (!isRazorpayConfigured()) {
        res.status(503).json({ success: false, error: "Payments not configured" });
        return;
      }

      const link = await createPaymentLink({
        amountPaise: toPaise(amount),
        description: `Wallet top-up — ${resident.name}`,
        customer: { name: resident.name, contact: resident.phone, email: resident.email },
        expireBySeconds: 24 * 60 * 60, // 24 hours
        acceptPartial: true,
        notes: { kind: "WALLET_TOPUP", residentId, propertyId: resident.propertyId },
      });

      const smsText = `Top up your UNILIV wallet (₹${amount}): ${link.shortUrl} (valid 24h, partial payment allowed)`;
      const emailText = `Dear ${resident.name},\n\nTop up your wallet of ₹${amount} using the secure link below (valid 24 hours, partial payment allowed):\n\n${link.shortUrl}\n\nThank you.`;
      if (resident.phone) await sendAdHoc("SMS", resident.phone, smsText, { entityType: "WALLET_TOPUP_LINK", entityId: link.id });
      if (resident.email) await sendAdHoc("EMAIL", resident.email, emailText, { subject: "Wallet top-up link", entityType: "WALLET_TOPUP_LINK", entityId: link.id });

      res.status(201).json({ success: true, data: { shortUrl: link.shortUrl, id: link.id } });
    } catch (err: any) {
      if (err instanceof RazorpayNotConfiguredError) {
        res.status(503).json({ success: false, error: "Payments not configured" });
        return;
      }
      if (err?.statusCode === 403) {
        res.status(403).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/residents/:residentId/pay
// Pay one or more ledger entries fully from wallet (atomic)
// Body: { ledgerEntryIds: string[], notes?: string }
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.post(
  "/wallet/residents/:residentId/pay",
  authenticate,
  authorize("WALLET", "create"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const body = req.body || {};
      const ledgerEntryIds: string[] = Array.isArray(body.ledgerEntryIds) ? body.ledgerEntryIds : [];

      if (ledgerEntryIds.length === 0) {
        res.status(400).json({ success: false, error: "ledgerEntryIds must be a non-empty array" });
        return;
      }
      if (ledgerEntryIds.length > 50) {
        res.status(400).json({ success: false, error: "Cannot pay more than 50 entries at once" });
        return;
      }

      const [resident] = await db
        .select()
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
      assertPropertyAccess(req, resident.propertyId);
      if (!resident.walletEnabled) {
        res.status(400).json({ success: false, error: "Wallet is disabled for this resident" });
        return;
      }

      const wallet = await getOrCreateWallet(residentId);
      if (!wallet.isActive) {
        res.status(400).json({ success: false, error: "Wallet is inactive" });
        return;
      }

      const config = await getWalletConfig(resident.propertyId);
      const idempotencyKey = getIdempotencyKey(req);

      const result = await db.transaction(async (tx) => {
        // Idempotency: replay returns the original wallet txn + its payment.
        if (idempotencyKey) {
          const [existingTxn] = await tx
            .select()
            .from(walletTransactionsTable)
            .where(
              and(
                eq(walletTransactionsTable.walletId, wallet.id),
                eq(walletTransactionsTable.referenceType, IDEMPOTENCY_REF_TYPE),
                eq(walletTransactionsTable.notes, `idem:${idempotencyKey}`)
              )
            );
          if (existingTxn) {
            const [existingPayment] = existingTxn.referenceId
              ? await tx.select().from(paymentsTable).where(eq(paymentsTable.id, existingTxn.referenceId))
              : [];
            return {
              debitResult: { txn: existingTxn, balanceAfter: Number(existingTxn.balanceAfter) },
              payment: existingPayment ?? null,
              replayed: true as const,
            };
          }
        }

        // Re-verify ledger entries INSIDE the tx with row locks so concurrent
        // payments of the same entry can't both pass (finding: double-debit race).
        const entries = await tx
          .select()
          .from(ledgerEntriesTable)
          .where(inArray(ledgerEntriesTable.id, ledgerEntryIds))
          .for("update");

        if (entries.length !== ledgerEntryIds.length) {
          throw httpError(404, "One or more ledger entries not found");
        }
        if (entries.some((e) => e.residentId !== residentId)) {
          throw httpError(400, "All ledger entries must belong to this resident");
        }
        const alreadyPaid = entries.find((e) => e.isPaid);
        if (alreadyPaid) {
          throw httpError(400, `Ledger entry ${alreadyPaid.id} is already paid`);
        }

        const totalAmount = entries.reduce((sum, e) => sum + Number(e.amount), 0);

        // Debit wallet
        const debitResult = await debitWallet(
          wallet.id,
          totalAmount,
          "PAYMENT",
          {
            description: `Payment for ${entries.length} ledger entr${entries.length === 1 ? "y" : "ies"}`,
            recordedBy: req.user!.id,
            propertyId: resident.propertyId,
            notes: idempotencyKey ? `idem:${idempotencyKey}` : (body.notes ?? null),
          },
          config,
          tx
        );

        // Record payment
        const paymentId = newId();
        const [payment] = await tx
          .insert(paymentsTable)
          .values({
            id: paymentId,
            residentId,
            amount: String(totalAmount),
            mode: "WALLET",
            status: "SUCCESS",
            reference: debitResult.txn.id,
            notes: body.notes ?? null,
          })
          .returning();

        // Mark ledger entries paid — guarded on isPaid=false so a racing tx that
        // already paid them yields fewer affected rows and rolls this one back.
        const marked = await tx
          .update(ledgerEntriesTable)
          .set({ isPaid: true, paidOn: new Date(), updatedAt: new Date() })
          .where(and(inArray(ledgerEntriesTable.id, ledgerEntryIds), eq(ledgerEntriesTable.isPaid, false)))
          .returning({ id: ledgerEntriesTable.id });
        if (marked.length !== ledgerEntryIds.length) {
          throw httpError(409, "One or more ledger entries were already paid");
        }

        // Back-link wallet transaction to payment (and stamp idempotency marker).
        await tx
          .update(walletTransactionsTable)
          .set({
            referenceId: paymentId,
            referenceType: idempotencyKey ? IDEMPOTENCY_REF_TYPE : "PAYMENT",
          })
          .where(eq(walletTransactionsTable.id, debitResult.txn.id));

        return { debitResult, payment: payment!, replayed: false as const };
      });

      if (result.payment === null) {
        // Idempotent replay where the original payment row could not be reloaded.
        res.status(409).json({ success: false, error: "Duplicate request (idempotency key already used)" });
        return;
      }

      // Audit log (skip on idempotent replay)
      if (!result.replayed) {
        writeAuditLog(req.user!.id, "WALLET_PAY", "wallet", wallet.id, {
          amount: Number(result.debitResult.txn.amount),
          residentId,
          ledgerEntryIds,
          paymentId: result.payment.id,
        });
      }

      res.json({
        success: true,
        data: {
          payment: {
            ...result.payment,
            amount: Number(result.payment.amount),
          },
          walletTransaction: serializeTxn(result.debitResult.txn),
          newBalance: result.debitResult.balanceAfter,
          entriesPaid: ledgerEntryIds.length,
        },
      });
    } catch (err: any) {
      if (err?.statusCode === 422) {
        res.status(422).json({ success: false, error: err.message, details: err.details });
        return;
      }
      if (err?.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        res.status(err.statusCode).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/residents/:residentId/partial-pay
// Split payment: wallet covers walletAmount, another mode covers the rest
// Body: { walletAmount, otherAmount, otherMode, ledgerEntryIds, reference? }
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.post(
  "/wallet/residents/:residentId/partial-pay",
  authenticate,
  authorize("WALLET", "create"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const body = req.body || {};

      const walletAmount = Number(body.walletAmount);
      const otherAmount = Number(body.otherAmount);
      const otherMode: string = body.otherMode;
      const ledgerEntryIds: string[] = Array.isArray(body.ledgerEntryIds) ? body.ledgerEntryIds : [];
      const validOtherModes = ["UPI", "NETBANKING", "CARD", "CASH", "BANK_TRANSFER"];

      if (!walletAmount || walletAmount <= 0) {
        res.status(400).json({ success: false, error: "walletAmount must be positive" });
        return;
      }
      if (!otherAmount || otherAmount <= 0) {
        res.status(400).json({ success: false, error: "otherAmount must be positive" });
        return;
      }
      if (!validOtherModes.includes(otherMode)) {
        res.status(400).json({
          success: false,
          error: `otherMode must be one of: ${validOtherModes.join(", ")}`,
        });
        return;
      }
      if (ledgerEntryIds.length === 0) {
        res.status(400).json({ success: false, error: "ledgerEntryIds must be a non-empty array" });
        return;
      }

      const [resident] = await db
        .select()
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
      assertPropertyAccess(req, resident.propertyId);
      if (!resident.walletEnabled) {
        res.status(400).json({ success: false, error: "Wallet is disabled for this resident" });
        return;
      }

      const wallet = await getOrCreateWallet(residentId);
      if (!wallet.isActive) {
        res.status(400).json({ success: false, error: "Wallet is inactive" });
        return;
      }

      const config = await getWalletConfig(resident.propertyId);
      const idempotencyKey = getIdempotencyKey(req);

      const result = await db.transaction(async (tx) => {
        // Idempotency: replay returns the original wallet txn + payments.
        if (idempotencyKey) {
          const [existingTxn] = await tx
            .select()
            .from(walletTransactionsTable)
            .where(
              and(
                eq(walletTransactionsTable.walletId, wallet.id),
                eq(walletTransactionsTable.referenceType, IDEMPOTENCY_REF_TYPE),
                eq(walletTransactionsTable.notes, `idem:${idempotencyKey}`)
              )
            );
          if (existingTxn) {
            const linked = existingTxn.referenceId
              ? await tx.select().from(paymentsTable).where(eq(paymentsTable.id, existingTxn.referenceId))
              : [];
            return {
              debitResult: { txn: existingTxn, balanceAfter: Number(existingTxn.balanceAfter) },
              walletPayment: linked[0] ?? null,
              otherPayment: null,
              replayed: true as const,
            };
          }
        }

        // Verify entries INSIDE the tx with row locks (double-pay race fix).
        const entries = await tx
          .select()
          .from(ledgerEntriesTable)
          .where(inArray(ledgerEntriesTable.id, ledgerEntryIds))
          .for("update");

        if (entries.length !== ledgerEntryIds.length) {
          throw httpError(404, "One or more ledger entries not found");
        }
        if (entries.some((e) => e.residentId !== residentId)) {
          throw httpError(400, "All ledger entries must belong to this resident");
        }
        const alreadyPaid = entries.find((e) => e.isPaid);
        if (alreadyPaid) {
          throw httpError(400, `Ledger entry ${alreadyPaid.id} is already paid`);
        }

        const totalEntries = entries.reduce((s, e) => s + Number(e.amount), 0);
        const combinedAmount = walletAmount + otherAmount;
        if (Math.abs(combinedAmount - totalEntries) > 0.01) {
          throw httpError(422, "Amounts do not sum to ledger total", {
            walletAmount,
            otherAmount,
            combined: combinedAmount,
            ledgerTotal: totalEntries,
          });
        }

        // Debit wallet portion
        const debitResult = await debitWallet(
          wallet.id,
          walletAmount,
          "PARTIAL_PAYMENT",
          {
            description: `Partial wallet payment (₹${walletAmount}) for ${entries.length} ledger entr${entries.length === 1 ? "y" : "ies"}`,
            recordedBy: req.user!.id,
            propertyId: resident.propertyId,
            notes: idempotencyKey ? `idem:${idempotencyKey}` : (body.notes ?? null),
          },
          config,
          tx
        );

        // Wallet payment record
        const [walletPayment] = await tx
          .insert(paymentsTable)
          .values({
            id: newId(),
            residentId,
            amount: String(walletAmount),
            mode: "WALLET_PARTIAL",
            status: "SUCCESS",
            reference: debitResult.txn.id,
            notes: body.notes ?? null,
          })
          .returning();

        // Other mode payment record
        const [otherPayment] = await tx
          .insert(paymentsTable)
          .values({
            id: newId(),
            residentId,
            amount: String(otherAmount),
            mode: otherMode as any,
            status: "SUCCESS",
            reference: body.reference ?? null,
            notes: body.notes ?? null,
          })
          .returning();

        // Mark ledger entries paid — guarded on isPaid=false (concurrent-pay fix).
        const marked = await tx
          .update(ledgerEntriesTable)
          .set({ isPaid: true, paidOn: new Date(), updatedAt: new Date() })
          .where(and(inArray(ledgerEntriesTable.id, ledgerEntryIds), eq(ledgerEntriesTable.isPaid, false)))
          .returning({ id: ledgerEntriesTable.id });
        if (marked.length !== ledgerEntryIds.length) {
          throw httpError(409, "One or more ledger entries were already paid");
        }

        // Back-link wallet transaction to wallet payment (stamp idempotency marker).
        await tx
          .update(walletTransactionsTable)
          .set({
            referenceId: walletPayment!.id,
            referenceType: idempotencyKey ? IDEMPOTENCY_REF_TYPE : "PAYMENT",
          })
          .where(eq(walletTransactionsTable.id, debitResult.txn.id));

        return {
          debitResult,
          walletPayment: walletPayment!,
          otherPayment: otherPayment!,
          replayed: false as const,
        };
      });

      if (result.walletPayment === null) {
        res.status(409).json({ success: false, error: "Duplicate request (idempotency key already used)" });
        return;
      }

      if (!result.replayed) {
        writeAuditLog(req.user!.id, "WALLET_PARTIAL_PAY", "wallet", wallet.id, {
          walletAmount,
          otherAmount,
          otherMode,
          residentId,
          ledgerEntryIds,
        });
      }

      res.json({
        success: true,
        data: {
          walletPayment: {
            ...result.walletPayment,
            amount: Number(result.walletPayment.amount),
          },
          otherPayment: result.otherPayment
            ? {
                ...result.otherPayment,
                amount: Number(result.otherPayment.amount),
              }
            : null,
          walletTransaction: serializeTxn(result.debitResult.txn),
          newBalance: result.debitResult.balanceAfter,
        },
      });
    } catch (err: any) {
      if (err?.statusCode === 422) {
        res.status(422).json({ success: false, error: err.message, details: err.details });
        return;
      }
      if (err?.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        res.status(err.statusCode).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/residents/:residentId/checkout-refund
// Called during resident checkout:
//   1. Refuse if balance is negative (staff must collect the shortfall first)
//   2. Apply wallet to clear outstanding dues (PAYMENT transactions)
//   3. Refund any remaining positive balance (REFUND_WITHDRAWAL)
//   4. Deactivate the wallet
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.post(
  "/wallet/residents/:residentId/checkout-refund",
  authenticate,
  authorize("WALLET", "create"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };

      const [resident] = await db
        .select()
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
      assertPropertyAccess(req, resident.propertyId);

      const wallet = await getOrCreateWallet(residentId);
      const currentBalance = Number(wallet.balance);

      if (currentBalance < 0) {
        res.status(422).json({
          success: false,
          error: "Wallet balance is negative — collect shortfall before checkout",
          details: { negativeAmount: Math.abs(currentBalance) },
        });
        return;
      }

      const result = await db.transaction(async (tx) => {
        const transactions: object[] = [];
        const clearedEntryIds: string[] = [];
        // For checkout we allow draining to exactly 0
        const checkoutConfig = { minimumBalance: 0 };

        // Fetch + lock all unpaid ledger entries INSIDE the tx so a concurrent
        // payment can't double-settle the same entry (oldest first).
        const unpaidEntries = await tx
          .select()
          .from(ledgerEntriesTable)
          .where(
            and(
              eq(ledgerEntriesTable.residentId, residentId),
              eq(ledgerEntriesTable.isPaid, false)
            )
          )
          .orderBy(asc(ledgerEntriesTable.dueDate))
          .for("update");

        for (const entry of unpaidEntries) {
          // Re-read running balance from the locked wallet row
          const [current] = await tx
            .select()
            .from(walletsTable)
            .where(eq(walletsTable.id, wallet.id))
            .for("update");
          const runningBal = Number(current!.balance);
          if (runningBal <= 0) break;

          const entryAmt = Number(entry.amount);
          if (entryAmt > runningBal) break; // Can't partially pay an entry

          const debitResult = await debitWallet(
            wallet.id,
            entryAmt,
            "PAYMENT",
            {
              description: `Checkout payment for ledger entry ${entry.id}`,
              recordedBy: req.user!.id,
              propertyId: resident.propertyId,
            },
            checkoutConfig,
            tx
          );

          // Create a payment record
          const [payment] = await tx
            .insert(paymentsTable)
            .values({
              id: newId(),
              residentId,
              amount: String(entryAmt),
              mode: "WALLET",
              status: "SUCCESS",
              reference: debitResult.txn.id,
            })
            .returning();

          // Mark ledger entry paid — guarded on isPaid=false (concurrent-pay fix).
          const marked = await tx
            .update(ledgerEntriesTable)
            .set({ isPaid: true, paidOn: new Date(), updatedAt: new Date() })
            .where(and(eq(ledgerEntriesTable.id, entry.id), eq(ledgerEntriesTable.isPaid, false)))
            .returning({ id: ledgerEntriesTable.id });
          if (marked.length !== 1) {
            throw httpError(409, `Ledger entry ${entry.id} was already paid`);
          }

          // Back-link wallet txn → payment
          await tx
            .update(walletTransactionsTable)
            .set({ referenceId: payment!.id, referenceType: "PAYMENT" })
            .where(eq(walletTransactionsTable.id, debitResult.txn.id));

          clearedEntryIds.push(entry.id);
          transactions.push({
            ...debitResult.txn,
            amount: Number(debitResult.txn.amount),
            balanceBefore: Number(debitResult.txn.balanceBefore),
            balanceAfter: Number(debitResult.txn.balanceAfter),
          });
        }

        // Check remaining balance after clearing dues
        const [afterClearing] = await tx
          .select()
          .from(walletsTable)
          .where(eq(walletsTable.id, wallet.id))
          .for("update");
        const remainingBalance = Number(afterClearing!.balance);

        let refundAmount = 0;
        if (remainingBalance > 0) {
          const refundResult = await debitWallet(
            wallet.id,
            remainingBalance,
            "REFUND_WITHDRAWAL",
            {
              description: `Wallet refund on checkout — hand ₹${remainingBalance} to resident`,
              recordedBy: req.user!.id,
              propertyId: resident.propertyId,
            },
            checkoutConfig,
            tx
          );
          refundAmount = remainingBalance;
          transactions.push({
            ...refundResult.txn,
            amount: Number(refundResult.txn.amount),
            balanceBefore: Number(refundResult.txn.balanceBefore),
            balanceAfter: Number(refundResult.txn.balanceAfter),
          });
        }

        // Deactivate the wallet
        await tx
          .update(walletsTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(walletsTable.id, wallet.id));

        return { clearedEntryIds, refundAmount, transactions };
      });

      writeAuditLog(req.user!.id, "CHECKOUT_REFUND", "wallet", wallet.id, {
        residentId,
        duesCleared: result.clearedEntryIds.length,
        refundAmount: result.refundAmount,
      });

      res.json({
        success: true,
        data: {
          duesCleared: result.clearedEntryIds.length,
          clearedEntryIds: result.clearedEntryIds,
          refundAmount: result.refundAmount,
          transactions: result.transactions,
          message:
            result.refundAmount > 0
              ? `Hand back ₹${result.refundAmount} to resident`
              : "No refund due",
        },
      });
    } catch (err: any) {
      if (err?.statusCode === 422) {
        res.status(422).json({ success: false, error: err.message, details: err.details });
        return;
      }
      if (err?.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        res.status(err.statusCode).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/residents/:residentId/adjust
// Manual credit or debit adjustment
// Body: { type: "ADJUSTMENT_CREDIT"|"ADJUSTMENT_DEBIT", amount, description, notes? }
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.post(
  "/wallet/residents/:residentId/adjust",
  authenticate,
  authorize("WALLET", "create"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const body = req.body || {};
      const amount = Number(body.amount);
      const adjustType = body.type as "ADJUSTMENT_CREDIT" | "ADJUSTMENT_DEBIT";

      if (!amount || amount <= 0) {
        res.status(400).json({ success: false, error: "amount must be a positive number" });
        return;
      }
      if (!["ADJUSTMENT_CREDIT", "ADJUSTMENT_DEBIT"].includes(adjustType)) {
        res.status(400).json({ success: false, error: "type must be ADJUSTMENT_CREDIT or ADJUSTMENT_DEBIT" });
        return;
      }
      // O30 wallet debit lock: only SUPER_ADMIN may remove funds. A negative
      // adjustment (ADJUSTMENT_DEBIT) drains the wallet, so reject it for every
      // other role. Credits / add-funds remain available to all permitted roles.
      if (adjustType === "ADJUSTMENT_DEBIT" && !isSuperAdmin(req.user?.role)) {
        res.status(403).json({ success: false, error: "Removing funds is not permitted" });
        return;
      }
      if (!body.description) {
        res.status(400).json({ success: false, error: "description is required" });
        return;
      }

      const [resident] = await db
        .select()
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
      assertPropertyAccess(req, resident.propertyId);

      const wallet = await getOrCreateWallet(residentId);
      const config = await getWalletConfig(resident.propertyId);
      const idempotencyKey = getIdempotencyKey(req);

      const meta = {
        description: body.description,
        recordedBy: req.user!.id,
        propertyId: resident.propertyId,
        notes: body.notes ?? null,
        referenceId: idempotencyKey ?? null,
        referenceType: idempotencyKey ? IDEMPOTENCY_REF_TYPE : null,
      };

      const result = await db.transaction(async (tx) => {
        // Idempotency: replay returns the original adjustment unchanged.
        if (idempotencyKey) {
          const [existing] = await tx
            .select()
            .from(walletTransactionsTable)
            .where(
              and(
                eq(walletTransactionsTable.walletId, wallet.id),
                eq(walletTransactionsTable.referenceType, IDEMPOTENCY_REF_TYPE),
                eq(walletTransactionsTable.referenceId, idempotencyKey)
              )
            );
          if (existing) return { txn: existing, balanceAfter: Number(existing.balanceAfter), replayed: true as const };
        }
        const r =
          adjustType === "ADJUSTMENT_CREDIT"
            ? await creditWallet(wallet.id, amount, "ADJUSTMENT_CREDIT", meta, tx)
            : await debitWallet(wallet.id, amount, "ADJUSTMENT_DEBIT", meta, config, tx);
        return { ...r, replayed: false as const };
      });

      if (!result.replayed) {
        writeAuditLog(req.user!.id, adjustType, "wallet", wallet.id, { amount, residentId });
      }

      res.json({
        success: true,
        data: {
          ...serializeTxn(result.txn),
          newBalance: result.balanceAfter,
        },
      });
    } catch (err: any) {
      if (err?.statusCode === 422) {
        res.status(422).json({ success: false, error: err.message, details: err.details });
        return;
      }
      if (err?.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        res.status(err.statusCode).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallet/residents/:residentId/reversal
// Reverse a previous transaction (adds/subtracts the original amount)
// Body: { reversalOf: string (txn id), description?, notes? }
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.post(
  "/wallet/residents/:residentId/reversal",
  authenticate,
  authorize("WALLET", "create"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const body = req.body || {};

      const reversalOf: string | undefined = body.reversalOf;
      if (!reversalOf) {
        res.status(400).json({ success: false, error: "reversalOf (transaction id) is required" });
        return;
      }

      const wallet = await getOrCreateWallet(residentId);

      const result = await db.transaction(async (tx) => {
        // Lock the original transaction row so concurrent reversals of the same
        // id serialize here — this is what makes the already-reversed check safe.
        const [original] = await tx
          .select()
          .from(walletTransactionsTable)
          .where(eq(walletTransactionsTable.id, reversalOf))
          .for("update");
        if (!original) throw httpError(404, "Original transaction not found");
        if (original.residentId !== residentId) {
          throw httpError(400, "Transaction does not belong to this resident");
        }
        // A reversal cannot itself be reversed.
        if (original.type === "REVERSAL") {
          throw httpError(400, "A reversal transaction cannot be reversed");
        }

        // Idempotency / double-reversal guard: refuse if this transaction has
        // already been reversed (unlimited-money-creation fix).
        const [priorReversal] = await tx
          .select({ id: walletTransactionsTable.id })
          .from(walletTransactionsTable)
          .where(eq(walletTransactionsTable.reversalOf, original.id));
        if (priorReversal) {
          throw httpError(409, "Transaction has already been reversed");
        }

        const originalAmount = Number(original.amount);
        // Credit types: reversing them → debit; debit types: reversing them → credit
        const isCreditType = ["TOPUP", "ADJUSTMENT_CREDIT", "REFUND_WITHDRAWAL"].includes(original.type);
        const meta = {
          description: body.description || `Reversal of transaction ${original.id}`,
          recordedBy: req.user!.id,
          propertyId: original.propertyId ?? null,
          notes: body.notes ?? null,
          reversalOf: original.id,
        };

        // For property-scoped callers, ensure the reversed txn is in their scope.
        assertPropertyAccess(req, original.propertyId);

        if (isCreditType) {
          // Original was a credit → reversal is a debit (allow going negative for reversals)
          const [w] = await tx.select().from(walletsTable).where(eq(walletsTable.id, wallet.id)).for("update");
          const balanceBefore = Number(w!.balance);
          const balanceAfter = balanceBefore - originalAmount;
          await tx.update(walletsTable).set({ balance: String(balanceAfter), updatedAt: new Date() }).where(eq(walletsTable.id, wallet.id));
          const [txn] = await tx.insert(walletTransactionsTable).values({
            id: newId(), walletId: wallet.id, residentId,
            type: "REVERSAL", amount: String(originalAmount),
            balanceBefore: String(balanceBefore), balanceAfter: String(balanceAfter),
            ...meta,
          }).returning();
          return { txn: txn!, balanceAfter, originalAmount };
        }
        // Original was a debit → reversal is a credit
        const r = await creditWallet(wallet.id, originalAmount, "REVERSAL", meta, tx);
        return { ...r, originalAmount };
      });

      writeAuditLog(req.user!.id, "REVERSAL", "wallet", wallet.id, {
        reversalOf,
        amount: result.originalAmount,
      });

      res.json({
        success: true,
        data: {
          ...serializeTxn(result.txn),
          newBalance: result.balanceAfter,
        },
      });
    } catch (err: any) {
      if (err?.statusCode === 422) {
        res.status(422).json({ success: false, error: err.message, details: err.details });
        return;
      }
      if (err?.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        res.status(err.statusCode).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /wallet/residents/:residentId/toggle
// Enable or disable wallet for a resident
// Body: { walletEnabled: boolean }
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.patch(
  "/wallet/residents/:residentId/toggle",
  authenticate,
  authorize("WALLET", "edit"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const body = req.body || {};
      const [resident] = await db
        .select()
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
      assertPropertyAccess(req, resident.propertyId);
      const walletEnabled =
        typeof body.walletEnabled === "boolean" ? body.walletEnabled : !resident.walletEnabled;
      await db
        .update(residentsTable)
        .set({ walletEnabled, updatedAt: new Date() })
        .where(eq(residentsTable.id, residentId));
      res.json({ success: true, data: { residentId, walletEnabled } });
    } catch (err: any) {
      if (err?.statusCode === 403) {
        res.status(403).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet/config/:propertyId
// Fetch (or lazily create) wallet config for a property
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.get(
  "/wallet/config/:propertyId",
  authenticate,
  authorize("WALLET", "view"),
  async (req, res) => {
    try {
      const { propertyId } = req.params as { propertyId: string };
      assertPropertyAccess(req, propertyId);
      const [config] = await db
        .select()
        .from(walletConfigTable)
        .where(eq(walletConfigTable.propertyId, propertyId));

      if (!config) {
        const [property] = await db
          .select({ id: propertiesTable.id })
          .from(propertiesTable)
          .where(eq(propertiesTable.id, propertyId));
        if (!property) {
          res.status(404).json({ success: false, error: "Property not found" });
          return;
        }
        const [created] = await db
          .insert(walletConfigTable)
          .values({ id: newId(), propertyId })
          .returning();
        res.json({
          success: true,
          data: {
            ...created,
            minimumBalance: Number(created!.minimumBalance),
            lowBalanceAlert: Number(created!.lowBalanceAlert),
          },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          ...config,
          minimumBalance: Number(config.minimumBalance),
          lowBalanceAlert: Number(config.lowBalanceAlert),
        },
      });
    } catch (err: any) {
      if (err?.statusCode === 403) {
        res.status(403).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /wallet/config/:propertyId
// Update wallet config for a property
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.put(
  "/wallet/config/:propertyId",
  authenticate,
  authorize("WALLET", "edit"),
  async (req, res) => {
    try {
      const { propertyId } = req.params as { propertyId: string };
      assertPropertyAccess(req, propertyId);
      const body = req.body || {};

      const [existing] = await db
        .select()
        .from(walletConfigTable)
        .where(eq(walletConfigTable.propertyId, propertyId));

      if (!existing) {
        const [created] = await db
          .insert(walletConfigTable)
          .values({
            id: newId(),
            propertyId,
            minimumBalance: body.minimumBalance?.toString() ?? "-100",
            lowBalanceAlert: body.lowBalanceAlert?.toString() ?? "200",
            isEnabled: body.isEnabled ?? true,
            topupNotes: body.topupNotes ?? null,
          })
          .returning();
        res.json({
          success: true,
          data: {
            ...created,
            minimumBalance: Number(created!.minimumBalance),
            lowBalanceAlert: Number(created!.lowBalanceAlert),
          },
        });
        return;
      }

      const [updated] = await db
        .update(walletConfigTable)
        .set({
          minimumBalance:
            body.minimumBalance !== undefined
              ? body.minimumBalance.toString()
              : existing.minimumBalance,
          lowBalanceAlert:
            body.lowBalanceAlert !== undefined
              ? body.lowBalanceAlert.toString()
              : existing.lowBalanceAlert,
          isEnabled: body.isEnabled !== undefined ? body.isEnabled : existing.isEnabled,
          topupNotes: body.topupNotes !== undefined ? body.topupNotes : existing.topupNotes,
          updatedAt: new Date(),
        })
        .where(eq(walletConfigTable.propertyId, propertyId))
        .returning();

      res.json({
        success: true,
        data: {
          ...updated,
          minimumBalance: Number(updated!.minimumBalance),
          lowBalanceAlert: Number(updated!.lowBalanceAlert),
        },
      });
    } catch (err: any) {
      if (err?.statusCode === 403) {
        res.status(403).json({ success: false, error: err.message });
        return;
      }
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallet/overview
// All resident wallets with low-balance / negative flags and property totals
// Query: propertyId?, search?, limit?, offset?
// ─────────────────────────────────────────────────────────────────────────────
walletRouter.get(
  "/wallet/overview",
  authenticate,
  authorize("WALLET", "view"),
  async (req, res) => {
    try {
      const propertyId = req.query["propertyId"] as string | undefined;
      const search = req.query["search"] as string | undefined;
      const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
      const offset = Number(req.query["offset"] ?? 0);

      // Best-effort row scoping: property-bound callers (WARDEN/UNIT_LEAD) only
      // ever see their own property; org-wide roles are unaffected (scope=null).
      const scope = scopedPropertyId(req);

      // Build conditions
      const conditions = [];
      if (scope) conditions.push(eq(residentsTable.propertyId, scope));
      if (propertyId) conditions.push(eq(residentsTable.propertyId, propertyId));
      if (search) {
        const { ilike, or } = await import("drizzle-orm");
        conditions.push(
          or(
            ilike(residentsTable.name, `%${search}%`),
            ilike(residentsTable.email, `%${search}%`)
          )!
        );
      }

      const baseQuery = db
        .select({
          walletId: walletsTable.id,
          residentId: residentsTable.id,
          residentName: residentsTable.name,
          residentEmail: residentsTable.email,
          residentStatus: residentsTable.status,
          walletEnabled: residentsTable.walletEnabled,
          balance: walletsTable.balance,
          isActive: walletsTable.isActive,
          propertyId: residentsTable.propertyId,
          propertyName: propertiesTable.name,
          updatedAt: walletsTable.updatedAt,
        })
        .from(walletsTable)
        .innerJoin(residentsTable, eq(walletsTable.residentId, residentsTable.id))
        .leftJoin(propertiesTable, eq(residentsTable.propertyId, propertiesTable.id));

      const rows = await (conditions.length
        ? baseQuery.where(and(...conditions))
        : baseQuery
      )
        .orderBy(asc(walletsTable.balance)) // negatives first
        .limit(limit)
        .offset(offset);

      // Fetch all wallet configs to compute per-property thresholds
      const configs = await db.select().from(walletConfigTable);
      const configByProperty = new Map(
        configs.map((c) => [c.propertyId, Number(c.lowBalanceAlert)])
      );

      // Count totals (constrained to the caller's scope for property-bound roles)
      const countQuery = db
        .select({ count: sql<number>`count(*)::int` })
        .from(walletsTable)
        .innerJoin(residentsTable, eq(walletsTable.residentId, residentsTable.id));
      const [countRow] = await (scope
        ? countQuery.where(eq(residentsTable.propertyId, scope))
        : countQuery);

      const totalsQuery = db
        .select({
          negativeCount: sql<number>`count(*) filter (where ${walletsTable.balance}::numeric < 0)`,
          totalBalance: sql<number>`coalesce(sum(${walletsTable.balance}::numeric), 0)`,
        })
        .from(walletsTable)
        .innerJoin(residentsTable, eq(walletsTable.residentId, residentsTable.id));
      const [totalsRow] = await (scope
        ? totalsQuery.where(eq(residentsTable.propertyId, scope))
        : totalsQuery);

      res.json({
        success: true,
        data: rows.map((r) => {
          const bal = Number(r.balance);
          const alertThreshold = configByProperty.get(r.propertyId ?? "") ?? 200;
          return {
            ...r,
            balance: bal,
            isNegative: bal < 0,
            isLowBalance: bal >= 0 && bal < alertThreshold,
          };
        }),
        meta: {
          total: countRow?.count ?? 0,
          limit,
          offset,
          negativeCount: Number(totalsRow?.negativeCount ?? 0),
          totalBalance: Number(totalsRow?.totalBalance ?? 0),
        },
      });
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);
