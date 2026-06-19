import { Router } from "express";
import { db } from "@workspace/db";
import { residentsTable, ledgerEntriesTable, paymentsTable, propertiesTable, roomsTable } from "@workspace/db";
import { eq, sql, ilike, or, and, inArray } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import { isKycGateEnabled, residentMeetsActivationRequirements } from "./kyc-esign.js";

const router = Router();

async function enrichResident(r: typeof residentsTable.$inferSelect) {
  let propertyName: string | null = null;
  let roomNumber: string | null = null;
  if (r.propertyId) {
    const [p] = await db.select({ name: propertiesTable.name }).from(propertiesTable).where(eq(propertiesTable.id, r.propertyId));
    propertyName = p?.name || null;
  }
  if (r.roomId) {
    const [rm] = await db.select({ number: roomsTable.number }).from(roomsTable).where(eq(roomsTable.id, r.roomId));
    roomNumber = rm?.number || null;
  }
  return { ...r, monthlyRent: r.monthlyRent ? Number(r.monthlyRent) : null, securityDeposit: r.securityDeposit ? Number(r.securityDeposit) : null, propertyName, roomNumber };
}

router.get("/", authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const status = req.query["status"] as string | undefined;

    const conditions = [];
    if (propertyId) conditions.push(eq(residentsTable.propertyId, propertyId));
    if (status) conditions.push(eq(residentsTable.status, status as "ACTIVE" | "CHECKED_OUT" | "NOTICE_PERIOD"));
    if (search) conditions.push(or(ilike(residentsTable.name, `%${search}%`), ilike(residentsTable.email, `%${search}%`), ilike(residentsTable.phone, `%${search}%`))!);

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(where);
    const rows = await db.select().from(residentsTable).where(where).limit(limit).offset(offset).orderBy(residentsTable.createdAt);

    const enriched = await Promise.all(rows.map(enrichResident));
    res.json({ success: true, data: enriched, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/", authenticate, async (req, res) => {
  try {
    const body = req.body;
    const requestedStatus = body.status || "ACTIVE";
    if (requestedStatus === "ACTIVE" && (await isKycGateEnabled())) {
      res.status(400).json({
        success: false,
        error: "KYC gate is enabled: new residents cannot be created with status ACTIVE. Create with status NOTICE_PERIOD or CHECKED_OUT, then complete KYC + e-sign before activating.",
      });
      return;
    }
    const [row] = await db.insert(residentsTable).values({
      id: newId(),
      propertyId: body.propertyId,
      roomId: body.roomId,
      name: body.name,
      email: body.email,
      phone: body.phone,
      dob: body.dob ? new Date(body.dob) : undefined,
      gender: body.gender,
      college: body.college,
      course: body.course,
      parentName: body.parentName,
      parentPhone: body.parentPhone,
      parentEmail: body.parentEmail,
      dietaryPref: body.dietaryPref || [],
      allergies: body.allergies || [],
      checkInDate: body.checkInDate ? new Date(body.checkInDate) : undefined,
      checkOutDate: body.checkOutDate ? new Date(body.checkOutDate) : undefined,
      planType: body.planType,
      monthlyRent: body.monthlyRent?.toString(),
      securityDeposit: body.securityDeposit?.toString(),
      status: requestedStatus,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: await enrichResident(row) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/:id", authenticate, async (req, res) => {
  try {
    const [row] = await db.select().from(residentsTable).where(eq(residentsTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: await enrichResident(row) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/:id", authenticate, async (req, res) => {
  try {
    const body = req.body;
    if (body?.status === "ACTIVE" && (await isKycGateEnabled())) {
      const check = await residentMeetsActivationRequirements(req.params["id"]!);
      if (!check.ok) {
        res.status(400).json({ success: false, error: `Cannot activate resident: ${check.reason}` });
        return;
      }
    }
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(body)) {
      if (["dob","checkInDate","checkOutDate"].includes(k) && v) updateData[k === "dob" ? "dob" : k === "checkInDate" ? "checkInDate" : "checkOutDate"] = new Date(v as string);
      else if (["monthlyRent","securityDeposit"].includes(k)) updateData[k] = v?.toString();
      else updateData[k] = v;
    }
    const [row] = await db.update(residentsTable).set(updateData as Partial<typeof residentsTable.$inferInsert>).where(eq(residentsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: await enrichResident(row) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.delete("/:id", authenticate, async (req, res) => {
  try {
    await db.delete(residentsTable).where(eq(residentsTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Ledger
router.get("/:id/ledger", authenticate, async (req, res) => {
  try {
    const rows = await db.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.residentId, req.params["id"]!)).orderBy(ledgerEntriesTable.createdAt);
    res.json({ success: true, data: rows.map(r => ({ ...r, amount: Number(r.amount) })) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/:id/ledger", authenticate, async (req, res) => {
  try {
    const body = req.body;
    if (body?.amount == null || Number.isNaN(Number(body.amount))) {
      res.status(400).json({ success: false, error: "amount is required and must be a number" });
      return;
    }
    const [row] = await db.insert(ledgerEntriesTable).values({
      id: newId(),
      residentId: req.params["id"]!,
      type: body.type,
      amount: body.amount.toString(),
      description: body.description,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      isPaid: body.isPaid || false,
      reference: body.reference,
      createdBy: req.user?.id,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: { ...row, amount: Number(row.amount) } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Payments
router.get("/:id/payments", authenticate, async (req, res) => {
  try {
    const rows = await db.select().from(paymentsTable).where(eq(paymentsTable.residentId, req.params["id"]!)).orderBy(paymentsTable.createdAt);
    res.json({ success: true, data: rows.map(r => ({ ...r, amount: Number(r.amount) })) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/:id/payments", authenticate, async (req, res) => {
  try {
    const body = req.body;
    if (body?.amount == null || Number.isNaN(Number(body.amount))) {
      res.status(400).json({ success: false, error: "amount is required and must be a number" });
      return;
    }
    const [row] = await db.insert(paymentsTable).values({
      id: newId(),
      residentId: req.params["id"]!,
      amount: body.amount.toString(),
      mode: body.mode,
      status: body.status || "PENDING",
      reference: body.reference,
      notes: body.notes,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: { ...row, amount: Number(row.amount) } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Check-out resident
router.post("/:id/checkout", authenticate, async (req, res) => {
  try {
    const { checkoutDate, reason, deductions, refundAmount, keyReturned, roomConditionNote } = req.body;
    const residentId = req.params["id"]!;
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, residentId));
    if (!resident) { res.status(404).json({ success: false, error: "Not found" }); return; }

    // Record refund + deductions in ledger
    const notes = [reason, keyReturned === false ? "Key NOT returned" : null, roomConditionNote].filter(Boolean).join(" | ");

    // Atomic: resident status, room vacate, and ledger entries must all succeed together.
    await db.transaction(async (tx) => {
      // Mark resident checked out
      await tx.update(residentsTable).set({
        status: "CHECKED_OUT",
        checkOutDate: checkoutDate ? new Date(checkoutDate) : new Date(),
        updatedAt: new Date(),
      }).where(eq(residentsTable.id, residentId));

      // Free up room
      if (resident.roomId) {
        await tx.update(roomsTable).set({ status: "VACANT", updatedAt: new Date() }).where(eq(roomsTable.id, resident.roomId));
      }

      if (deductions && Number(deductions) > 0) {
        await tx.insert(ledgerEntriesTable).values({
          id: newId(), residentId, type: "ADJUSTMENT",
          amount: Number(deductions).toString(),
          description: `Check-out deductions: ${notes || "—"}`,
          isPaid: true, createdBy: req.user?.id, updatedAt: new Date(),
        });
      }
      if (refundAmount && Number(refundAmount) > 0) {
        await tx.insert(ledgerEntriesTable).values({
          id: newId(), residentId, type: "DEPOSIT",
          amount: (-Number(refundAmount)).toString(),
          description: `Security deposit refund`,
          isPaid: true, createdBy: req.user?.id, updatedAt: new Date(),
        });
      }
    });

    const [row] = await db.select().from(residentsTable).where(eq(residentsTable.id, residentId));
    res.json({ success: true, data: await enrichResident(row!) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Bulk rent charge for a property + month
router.post("/bulk-rent", authenticate, async (req, res) => {
  try {
    const { propertyId, month, year } = req.body;
    if (!propertyId || month == null || year == null) {
      res.status(400).json({ success: false, error: "propertyId, month, year required" });
      return;
    }
    const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
    const dueDate = new Date(year, month - 1, 5);
    const activeResidents = await db.select().from(residentsTable).where(
      and(eq(residentsTable.propertyId, propertyId), eq(residentsTable.status, "ACTIVE"))
    );
    let success = 0, failed = 0;
    for (const r of activeResidents) {
      try {
        if (!r.monthlyRent || Number(r.monthlyRent) <= 0) { failed++; continue; }
        await db.insert(ledgerEntriesTable).values({
          id: newId(), residentId: r.id, type: "RENT",
          amount: r.monthlyRent.toString(),
          description: `Rent for ${monthLabel}`,
          dueDate, isPaid: false, createdBy: req.user?.id, updatedAt: new Date(),
        });
        success++;
      } catch { failed++; }
    }
    res.json({ success: true, data: { success, failed, total: activeResidents.length, month: monthLabel } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
