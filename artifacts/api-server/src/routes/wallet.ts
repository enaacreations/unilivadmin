import { Router } from "express";
import {
  db,
  walletsTable,
  walletTransactionsTable,
  walletConfigTable,
  residentsTable,
  propertiesTable,
} from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { newId } from "../lib/id.js";

export const walletRouter: Router = Router();

// ──────────────────────────────────────────────
// Helper — get or lazily create a wallet row
// ──────────────────────────────────────────────
async function getOrCreateWallet(residentId: string) {
  const [existing] = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.residentId, residentId));
  if (existing) return existing;
  const [created] = await db
    .insert(walletsTable)
    .values({ id: newId(), residentId, balance: "0", isActive: true })
    .returning();
  return created!;
}

// ──────────────────────────────────────────────
// GET /wallet/residents/:residentId
// Returns wallet summary for a resident
// ──────────────────────────────────────────────
walletRouter.get(
  "/wallet/residents/:residentId",
  authenticate,
  authorize("WALLET", "view"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const [resident] = await db
        .select({ name: residentsTable.name, walletEnabled: residentsTable.walletEnabled })
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
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
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ──────────────────────────────────────────────
// GET /wallet/residents/:residentId/transactions
// Paginated transaction history
// ──────────────────────────────────────────────
walletRouter.get(
  "/wallet/residents/:residentId/transactions",
  authenticate,
  authorize("WALLET", "view"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
      const offset = Number(req.query["offset"] ?? 0);

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
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ──────────────────────────────────────────────
// POST /wallet/residents/:residentId/topup
// Add funds to wallet
// ──────────────────────────────────────────────
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
      const [resident] = await db
        .select()
        .from(residentsTable)
        .where(eq(residentsTable.id, residentId));
      if (!resident) {
        res.status(404).json({ success: false, error: "Resident not found" });
        return;
      }
      if (!resident.walletEnabled) {
        res.status(400).json({ success: false, error: "Wallet is disabled for this resident" });
        return;
      }

      const wallet = await getOrCreateWallet(residentId);
      const balanceBefore = Number(wallet.balance);
      const balanceAfter = balanceBefore + amount;

      await db
        .update(walletsTable)
        .set({ balance: balanceAfter.toString(), updatedAt: new Date() })
        .where(eq(walletsTable.id, wallet.id));

      const [txn] = await db
        .insert(walletTransactionsTable)
        .values({
          id: newId(),
          walletId: wallet.id,
          residentId,
          type: "TOPUP",
          amount: amount.toString(),
          balanceBefore: balanceBefore.toString(),
          balanceAfter: balanceAfter.toString(),
          description: body.description || `Cash top-up by staff`,
          referenceId: body.referenceId ?? null,
          referenceType: body.referenceType ?? null,
          recordedBy: req.user!.id,
          notes: body.notes ?? null,
          propertyId: resident.propertyId ?? null,
        })
        .returning();

      res.json({
        success: true,
        data: {
          ...txn,
          amount: Number(txn!.amount),
          balanceBefore: Number(txn!.balanceBefore),
          balanceAfter: Number(txn!.balanceAfter),
          newBalance: balanceAfter,
        },
      });
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ──────────────────────────────────────────────
// POST /wallet/residents/:residentId/adjust
// Manual credit or debit adjustment
// ──────────────────────────────────────────────
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

      const wallet = await getOrCreateWallet(residentId);
      const balanceBefore = Number(wallet.balance);
      const balanceAfter =
        adjustType === "ADJUSTMENT_CREDIT"
          ? balanceBefore + amount
          : balanceBefore - amount;

      await db
        .update(walletsTable)
        .set({ balance: balanceAfter.toString(), updatedAt: new Date() })
        .where(eq(walletsTable.id, wallet.id));

      const [txn] = await db
        .insert(walletTransactionsTable)
        .values({
          id: newId(),
          walletId: wallet.id,
          residentId,
          type: adjustType,
          amount: amount.toString(),
          balanceBefore: balanceBefore.toString(),
          balanceAfter: balanceAfter.toString(),
          description: body.description,
          recordedBy: req.user!.id,
          notes: body.notes ?? null,
          propertyId: resident.propertyId ?? null,
        })
        .returning();

      res.json({
        success: true,
        data: {
          ...txn,
          amount: Number(txn!.amount),
          balanceBefore: Number(txn!.balanceBefore),
          balanceAfter: Number(txn!.balanceAfter),
          newBalance: balanceAfter,
        },
      });
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ──────────────────────────────────────────────
// POST /wallet/residents/:residentId/pay
// Deduct from wallet (payment)
// ──────────────────────────────────────────────
walletRouter.post(
  "/wallet/residents/:residentId/pay",
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
      if (!resident.walletEnabled) {
        res.status(400).json({ success: false, error: "Wallet is disabled for this resident" });
        return;
      }

      const wallet = await getOrCreateWallet(residentId);

      const [config] = await db
        .select()
        .from(walletConfigTable)
        .where(eq(walletConfigTable.propertyId, resident.propertyId));
      const minimumBalance = config ? Number(config.minimumBalance) : -100;

      const balanceBefore = Number(wallet.balance);
      const balanceAfter = balanceBefore - amount;
      if (balanceAfter < minimumBalance) {
        res.status(400).json({
          success: false,
          error: `Insufficient wallet balance. Current: ${balanceBefore}, Minimum allowed: ${minimumBalance}`,
        });
        return;
      }

      await db
        .update(walletsTable)
        .set({ balance: balanceAfter.toString(), updatedAt: new Date() })
        .where(eq(walletsTable.id, wallet.id));

      const [txn] = await db
        .insert(walletTransactionsTable)
        .values({
          id: newId(),
          walletId: wallet.id,
          residentId,
          type: "PAYMENT",
          amount: amount.toString(),
          balanceBefore: balanceBefore.toString(),
          balanceAfter: balanceAfter.toString(),
          description: body.description,
          referenceId: body.referenceId ?? null,
          referenceType: body.referenceType ?? null,
          recordedBy: req.user!.id,
          notes: body.notes ?? null,
          propertyId: resident.propertyId ?? null,
        })
        .returning();

      res.json({
        success: true,
        data: {
          ...txn,
          amount: Number(txn!.amount),
          balanceBefore: Number(txn!.balanceBefore),
          balanceAfter: Number(txn!.balanceAfter),
          newBalance: balanceAfter,
        },
      });
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ──────────────────────────────────────────────
// POST /wallet/residents/:residentId/reversal
// Reverse a previous transaction
// ──────────────────────────────────────────────
walletRouter.post(
  "/wallet/residents/:residentId/reversal",
  authenticate,
  authorize("WALLET", "create"),
  async (req, res) => {
    try {
      const { residentId } = req.params as { residentId: string };
      const body = req.body || {};
      if (!body.reversalOf) {
        res.status(400).json({ success: false, error: "reversalOf (transaction id) is required" });
        return;
      }

      const [original] = await db
        .select()
        .from(walletTransactionsTable)
        .where(eq(walletTransactionsTable.id, body.reversalOf));
      if (!original) {
        res.status(404).json({ success: false, error: "Original transaction not found" });
        return;
      }
      if (original.residentId !== residentId) {
        res.status(400).json({ success: false, error: "Transaction does not belong to this resident" });
        return;
      }

      const wallet = await getOrCreateWallet(residentId);
      const balanceBefore = Number(wallet.balance);
      const originalAmount = Number(original.amount);
      const isCreditType = ["TOPUP", "ADJUSTMENT_CREDIT", "REFUND_WITHDRAWAL"].includes(original.type);
      const balanceAfter = isCreditType
        ? balanceBefore - originalAmount
        : balanceBefore + originalAmount;

      await db
        .update(walletsTable)
        .set({ balance: balanceAfter.toString(), updatedAt: new Date() })
        .where(eq(walletsTable.id, wallet.id));

      const [txn] = await db
        .insert(walletTransactionsTable)
        .values({
          id: newId(),
          walletId: wallet.id,
          residentId,
          type: "REVERSAL",
          amount: originalAmount.toString(),
          balanceBefore: balanceBefore.toString(),
          balanceAfter: balanceAfter.toString(),
          description: body.description || `Reversal of transaction ${body.reversalOf}`,
          reversalOf: body.reversalOf,
          recordedBy: req.user!.id,
          notes: body.notes ?? null,
          propertyId: original.propertyId ?? null,
        })
        .returning();

      res.json({
        success: true,
        data: {
          ...txn,
          amount: Number(txn!.amount),
          balanceBefore: Number(txn!.balanceBefore),
          balanceAfter: Number(txn!.balanceAfter),
          newBalance: balanceAfter,
        },
      });
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ──────────────────────────────────────────────
// PATCH /wallet/residents/:residentId/toggle
// Enable or disable wallet for a resident
// ──────────────────────────────────────────────
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
      const walletEnabled = typeof body.walletEnabled === "boolean" ? body.walletEnabled : !resident.walletEnabled;
      await db
        .update(residentsTable)
        .set({ walletEnabled, updatedAt: new Date() })
        .where(eq(residentsTable.id, residentId));
      res.json({ success: true, data: { residentId, walletEnabled } });
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ──────────────────────────────────────────────
// GET /wallet/config/:propertyId
// ──────────────────────────────────────────────
walletRouter.get(
  "/wallet/config/:propertyId",
  authenticate,
  authorize("WALLET", "view"),
  async (req, res) => {
    try {
      const { propertyId } = req.params as { propertyId: string };
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
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ──────────────────────────────────────────────
// PUT /wallet/config/:propertyId
// ──────────────────────────────────────────────
walletRouter.put(
  "/wallet/config/:propertyId",
  authenticate,
  authorize("WALLET", "edit"),
  async (req, res) => {
    try {
      const { propertyId } = req.params as { propertyId: string };
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
          minimumBalance: body.minimumBalance !== undefined ? body.minimumBalance.toString() : existing.minimumBalance,
          lowBalanceAlert: body.lowBalanceAlert !== undefined ? body.lowBalanceAlert.toString() : existing.lowBalanceAlert,
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
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

// ──────────────────────────────────────────────
// GET /wallet/overview
// Summary across all properties — for the wallet list page
// ──────────────────────────────────────────────
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

      let query = db
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

      const conditions = [];
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

      const rows = await (conditions.length
        ? query.where(and(...conditions))
        : query
      )
        .orderBy(desc(walletsTable.updatedAt))
        .limit(limit)
        .offset(offset);

      const [totalRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(walletsTable)
        .innerJoin(residentsTable, eq(walletsTable.residentId, residentsTable.id));

      res.json({
        success: true,
        data: rows.map((r) => ({ ...r, balance: Number(r.balance) })),
        meta: { total: totalRow?.count ?? 0, limit, offset },
      });
    } catch (err) {
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);
