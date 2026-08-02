import { Router } from "express";
import {
  db,
  facilityAssetsTable,
  facilitySchedulesTable,
  facilityLogsTable,
  electricityTariffsTable,
  electricityMetersTable,
  electricityReadingsTable,
  residentAttendanceTable,
  outPassesTable,
  iotDevicesTable,
  iotReadingsTable,
  propertiesTable,
  residentsTable,
  roomsTable,
  ledgerEntriesTable,
} from "@workspace/db";
import { eq, and, desc, sql, gte, lte, lt } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { newId } from "../lib/id.js";
import { rateLimit } from "../middlewares/security.js";
import { randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";

/** Constant-time compare for the IoT device ingestion token (guards length first). */
function safeTokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Facility
export const facilityRouter: Router = Router();

facilityRouter.get("/assets", authenticate, authorize("FACILITY", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const where = propertyId ? eq(facilityAssetsTable.propertyId, propertyId) : undefined;
    const rows = await db.select({
      a: facilityAssetsTable,
      propertyName: propertiesTable.name,
    }).from(facilityAssetsTable)
      .leftJoin(propertiesTable, eq(facilityAssetsTable.propertyId, propertiesTable.id))
      .where(where)
      .orderBy(desc(facilityAssetsTable.createdAt));
    res.json({ success: true, data: rows.map((r) => ({ ...r.a, propertyName: r.propertyName })) });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

const assetSchema = z.object({
  propertyId: z.string().min(1),
  assetCode: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  location: z.string().nullish(),
  manufacturer: z.string().nullish(),
  modelNo: z.string().nullish(),
  installDate: z.string().nullish(),
  warrantyExpiry: z.string().nullish(),
  status: z.string().optional(),
  notes: z.string().nullish(),
});

facilityRouter.post("/assets", authenticate, authorize("FACILITY", "create"), async (req, res) => {
  try {
    const p = assetSchema.safeParse(req.body);
    if (!p.success) { res.status(400).json({ success: false, error: p.error.message }); return; }
    const b = p.data;
    const [row] = await db.insert(facilityAssetsTable).values({
      id: newId(),
      propertyId: b.propertyId,
      assetCode: b.assetCode,
      name: b.name,
      category: b.category,
      location: b.location ?? null,
      manufacturer: b.manufacturer ?? null,
      modelNo: b.modelNo ?? null,
      installDate: b.installDate ? new Date(b.installDate) : null,
      warrantyExpiry: b.warrantyExpiry ? new Date(b.warrantyExpiry) : null,
      status: b.status || "ACTIVE",
      notes: b.notes ?? null,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

facilityRouter.put("/assets/:id", authenticate, authorize("FACILITY", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["assetCode","name","category","location","manufacturer","modelNo","status","notes","propertyId"]) {
      if (b[k] !== undefined) update[k] = b[k];
    }
    if (b.installDate !== undefined) update["installDate"] = b.installDate ? new Date(b.installDate) : null;
    if (b.warrantyExpiry !== undefined) update["warrantyExpiry"] = b.warrantyExpiry ? new Date(b.warrantyExpiry) : null;
    const [row] = await db.update(facilityAssetsTable).set(update as Partial<typeof facilityAssetsTable.$inferInsert>).where(eq(facilityAssetsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

facilityRouter.delete("/assets/:id", authenticate, authorize("FACILITY", "delete"), async (req, res) => {
  try {
    await db.delete(facilityAssetsTable).where(eq(facilityAssetsTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

facilityRouter.get("/schedules", authenticate, authorize("FACILITY", "view"), async (req, res) => {
  try {
    const assetId = req.query["assetId"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const overdueOnly = req.query["overdueOnly"] === "true";
    const conditions = [];
    if (assetId) conditions.push(eq(facilitySchedulesTable.assetId, assetId));
    if (propertyId) conditions.push(eq(facilityAssetsTable.propertyId, propertyId));
    if (overdueOnly) conditions.push(lt(facilitySchedulesTable.nextDueDate, new Date()));
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db.select({
      s: facilitySchedulesTable,
      assetName: facilityAssetsTable.name,
      assetCode: facilityAssetsTable.assetCode,
      propertyId: facilityAssetsTable.propertyId,
      propertyName: propertiesTable.name,
    })
      .from(facilitySchedulesTable)
      .leftJoin(facilityAssetsTable, eq(facilitySchedulesTable.assetId, facilityAssetsTable.id))
      .leftJoin(propertiesTable, eq(facilityAssetsTable.propertyId, propertiesTable.id))
      .where(where)
      .orderBy(facilitySchedulesTable.nextDueDate);
    res.json({ success: true, data: rows.map((r) => ({ ...r.s, assetName: r.assetName, assetCode: r.assetCode, propertyId: r.propertyId, propertyName: r.propertyName })) });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

facilityRouter.post("/schedules", authenticate, authorize("FACILITY", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.assetId || !b.taskName || !b.frequencyDays || !b.nextDueDate) {
      res.status(400).json({ success: false, error: "assetId, taskName, frequencyDays, nextDueDate required" }); return;
    }
    const [row] = await db.insert(facilitySchedulesTable).values({
      id: newId(),
      assetId: b.assetId,
      taskName: b.taskName,
      frequencyDays: Number(b.frequencyDays),
      vendorId: b.vendorId ?? null,
      assignedTo: b.assignedTo ?? null,
      nextDueDate: new Date(b.nextDueDate),
      isActive: b.isActive !== false,
      notes: b.notes ?? null,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

facilityRouter.put("/schedules/:id", authenticate, authorize("FACILITY", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["taskName","vendorId","assignedTo","isActive","notes"]) if (b[k] !== undefined) update[k] = b[k];
    if (b.frequencyDays !== undefined) update["frequencyDays"] = Number(b.frequencyDays);
    if (b.nextDueDate !== undefined) update["nextDueDate"] = new Date(b.nextDueDate);
    const [row] = await db.update(facilitySchedulesTable).set(update as Partial<typeof facilitySchedulesTable.$inferInsert>).where(eq(facilitySchedulesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

facilityRouter.delete("/schedules/:id", authenticate, authorize("FACILITY", "delete"), async (req, res) => {
  try {
    await db.delete(facilitySchedulesTable).where(eq(facilitySchedulesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

facilityRouter.get("/logs", authenticate, authorize("FACILITY", "view"), async (req, res) => {
  try {
    const assetId = req.query["assetId"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const conditions = [];
    if (assetId) conditions.push(eq(facilityLogsTable.assetId, assetId));
    if (propertyId) conditions.push(eq(facilityAssetsTable.propertyId, propertyId));
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db.select({
      l: facilityLogsTable,
      assetName: facilityAssetsTable.name,
    }).from(facilityLogsTable)
      .leftJoin(facilityAssetsTable, eq(facilityLogsTable.assetId, facilityAssetsTable.id))
      .where(where)
      .orderBy(desc(facilityLogsTable.performedAt));
    res.json({ success: true, data: rows.map((r) => ({ ...r.l, assetName: r.assetName, cost: r.l.cost ? Number(r.l.cost) : null })) });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

facilityRouter.post("/logs", authenticate, authorize("FACILITY", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.assetId || !b.performedAt) { res.status(400).json({ success: false, error: "assetId and performedAt required" }); return; }
    const [row] = await db.insert(facilityLogsTable).values({
      id: newId(),
      assetId: b.assetId,
      scheduleId: b.scheduleId ?? null,
      performedAt: new Date(b.performedAt),
      performedBy: b.performedBy ?? req.user?.id ?? null,
      vendorId: b.vendorId ?? null,
      cost: b.cost != null ? String(b.cost) : null,
      outcome: b.outcome || "COMPLETED",
      notes: b.notes ?? null,
      attachment: b.attachment ?? null,
    }).returning();

    // Auto-roll schedule's nextDueDate
    if (b.scheduleId) {
      const [sch] = await db.select().from(facilitySchedulesTable).where(eq(facilitySchedulesTable.id, b.scheduleId));
      if (sch) {
        const next = new Date(new Date(b.performedAt).getTime() + sch.frequencyDays * 86400_000);
        await db.update(facilitySchedulesTable).set({ lastDoneAt: new Date(b.performedAt), nextDueDate: next, updatedAt: new Date() }).where(eq(facilitySchedulesTable.id, sch.id));
      }
    }
    res.status(201).json({ success: true, data: { ...row, cost: row.cost ? Number(row.cost) : null } });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

// Electricity
export const electricityRouter: Router = Router();

electricityRouter.get("/tariffs", authenticate, authorize("ELECTRICITY", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(electricityTariffsTable).orderBy(desc(electricityTariffsTable.effectiveFrom));
    res.json({ success: true, data: rows.map((r) => ({ ...r, ratePerUnit: Number(r.ratePerUnit), fixedCharge: Number(r.fixedCharge) })) });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

electricityRouter.post("/tariffs", authenticate, authorize("ELECTRICITY", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || b.ratePerUnit == null || !b.effectiveFrom) { res.status(400).json({ success: false, error: "name, ratePerUnit, effectiveFrom required" }); return; }
    const [row] = await db.insert(electricityTariffsTable).values({
      id: newId(),
      propertyId: b.propertyId ?? null,
      name: b.name,
      ratePerUnit: String(b.ratePerUnit),
      fixedCharge: String(b.fixedCharge ?? 0),
      effectiveFrom: new Date(b.effectiveFrom),
      isActive: b.isActive !== false,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: { ...row, ratePerUnit: Number(row.ratePerUnit), fixedCharge: Number(row.fixedCharge) } });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

electricityRouter.put("/tariffs/:id", authenticate, authorize("ELECTRICITY", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    if (b.name !== undefined) u["name"] = b.name;
    if (b.ratePerUnit !== undefined) u["ratePerUnit"] = String(b.ratePerUnit);
    if (b.fixedCharge !== undefined) u["fixedCharge"] = String(b.fixedCharge);
    if (b.effectiveFrom !== undefined) u["effectiveFrom"] = new Date(b.effectiveFrom);
    if (b.isActive !== undefined) u["isActive"] = !!b.isActive;
    if (b.propertyId !== undefined) u["propertyId"] = b.propertyId;
    const [row] = await db.update(electricityTariffsTable).set(u as Partial<typeof electricityTariffsTable.$inferInsert>).where(eq(electricityTariffsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, ratePerUnit: Number(row.ratePerUnit), fixedCharge: Number(row.fixedCharge) } });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

electricityRouter.get("/meters", authenticate, authorize("ELECTRICITY", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const where = propertyId ? eq(electricityMetersTable.propertyId, propertyId) : undefined;
    const rows = await db.select({
      m: electricityMetersTable,
      propertyName: propertiesTable.name,
      roomNumber: roomsTable.number,
      residentName: residentsTable.name,
      tariffName: electricityTariffsTable.name,
      ratePerUnit: electricityTariffsTable.ratePerUnit,
    }).from(electricityMetersTable)
      .leftJoin(propertiesTable, eq(electricityMetersTable.propertyId, propertiesTable.id))
      .leftJoin(roomsTable, eq(electricityMetersTable.roomId, roomsTable.id))
      .leftJoin(residentsTable, eq(electricityMetersTable.residentId, residentsTable.id))
      .leftJoin(electricityTariffsTable, eq(electricityMetersTable.tariffId, electricityTariffsTable.id))
      .where(where)
      .orderBy(desc(electricityMetersTable.createdAt));
    res.json({ success: true, data: rows.map((r) => ({
      ...r.m,
      propertyName: r.propertyName,
      roomNumber: r.roomNumber,
      residentName: r.residentName,
      tariffName: r.tariffName,
      ratePerUnit: r.ratePerUnit ? Number(r.ratePerUnit) : null,
    })) });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

electricityRouter.post("/meters", authenticate, authorize("ELECTRICITY", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.propertyId || !b.meterNo) { res.status(400).json({ success: false, error: "propertyId, meterNo required" }); return; }
    const [row] = await db.insert(electricityMetersTable).values({
      id: newId(),
      propertyId: b.propertyId,
      roomId: b.roomId ?? null,
      residentId: b.residentId ?? null,
      meterNo: b.meterNo,
      label: b.label ?? null,
      tariffId: b.tariffId ?? null,
      isActive: b.isActive !== false,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

electricityRouter.put("/meters/:id", authenticate, authorize("ELECTRICITY", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["meterNo","label","tariffId","roomId","residentId","isActive","propertyId"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(electricityMetersTable).set(u as Partial<typeof electricityMetersTable.$inferInsert>).where(eq(electricityMetersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

electricityRouter.delete("/meters/:id", authenticate, authorize("ELECTRICITY", "delete"), async (req, res) => {
  try {
    await db.delete(electricityMetersTable).where(eq(electricityMetersTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

async function computeReading(meterId: string, reading: number, readingDate: Date) {
  const [meter] = await db.select().from(electricityMetersTable).where(eq(electricityMetersTable.id, meterId));
  if (!meter) throw new Error("Meter not found");
  // Find previous reading
  const [prev] = await db.select().from(electricityReadingsTable)
    .where(and(eq(electricityReadingsTable.meterId, meterId), lt(electricityReadingsTable.readingDate, readingDate)))
    .orderBy(desc(electricityReadingsTable.readingDate)).limit(1);
  const prevReading = prev ? Number(prev.reading) : 0;
  const units = Math.max(0, reading - prevReading);
  let amount = 0;
  if (meter.tariffId) {
    const [t] = await db.select().from(electricityTariffsTable).where(eq(electricityTariffsTable.id, meter.tariffId));
    if (t) amount = units * Number(t.ratePerUnit) + Number(t.fixedCharge);
  }
  return { meter, prevReading, units, amount };
}

electricityRouter.get("/readings", authenticate, authorize("ELECTRICITY", "view"), async (req, res) => {
  try {
    const meterId = req.query["meterId"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const conditions = [];
    if (meterId) conditions.push(eq(electricityReadingsTable.meterId, meterId));
    if (propertyId) conditions.push(eq(electricityMetersTable.propertyId, propertyId));
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db.select({
      r: electricityReadingsTable,
      meterNo: electricityMetersTable.meterNo,
      label: electricityMetersTable.label,
      propertyId: electricityMetersTable.propertyId,
    }).from(electricityReadingsTable)
      .leftJoin(electricityMetersTable, eq(electricityReadingsTable.meterId, electricityMetersTable.id))
      .where(where)
      .orderBy(desc(electricityReadingsTable.readingDate))
      .limit(500);
    res.json({ success: true, data: rows.map((row) => ({
      ...row.r,
      meterNo: row.meterNo,
      label: row.label,
      propertyId: row.propertyId,
      reading: Number(row.r.reading),
      prevReading: row.r.prevReading != null ? Number(row.r.prevReading) : null,
      unitsConsumed: row.r.unitsConsumed != null ? Number(row.r.unitsConsumed) : null,
      amount: row.r.amount != null ? Number(row.r.amount) : null,
    })) });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

electricityRouter.post("/readings", authenticate, authorize("ELECTRICITY", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.meterId || b.reading == null) { res.status(400).json({ success: false, error: "meterId, reading required" }); return; }
    const date = b.readingDate ? new Date(b.readingDate) : new Date();
    const c = await computeReading(b.meterId, Number(b.reading), date);
    const [row] = await db.insert(electricityReadingsTable).values({
      id: newId(),
      meterId: b.meterId,
      readingDate: date,
      reading: String(b.reading),
      prevReading: String(c.prevReading),
      unitsConsumed: String(c.units),
      amount: String(c.amount),
      posted: false,
      notes: b.notes ?? null,
      recordedBy: req.user?.id ?? null,
    }).returning();
    res.status(201).json({ success: true, data: { ...row, reading: Number(row.reading), prevReading: Number(row.prevReading), unitsConsumed: Number(row.unitsConsumed), amount: Number(row.amount) } });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: (e as Error).message || "Internal" }); }
});

electricityRouter.post("/readings/bulk", authenticate, authorize("ELECTRICITY", "create"), async (req, res) => {
  try {
    const items: Array<{ meterId: string; reading: number; readingDate?: string; notes?: string }> = req.body?.items || [];
    let success = 0, failed = 0;
    const errors: string[] = [];
    for (const it of items) {
      try {
        const date = it.readingDate ? new Date(it.readingDate) : new Date();
        const c = await computeReading(it.meterId, Number(it.reading), date);
        await db.insert(electricityReadingsTable).values({
          id: newId(),
          meterId: it.meterId,
          readingDate: date,
          reading: String(it.reading),
          prevReading: String(c.prevReading),
          unitsConsumed: String(c.units),
          amount: String(c.amount),
          posted: false,
          notes: it.notes ?? null,
          recordedBy: req.user?.id ?? null,
        });
        success++;
      } catch (err) {
        failed++;
        errors.push((err as Error).message);
      }
    }
    res.json({ success: true, data: { success, failed, errors } });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

electricityRouter.post("/readings/:id/post", authenticate, authorize("ELECTRICITY", "edit"), async (req, res) => {
  try {
    const [reading] = await db.select().from(electricityReadingsTable).where(eq(electricityReadingsTable.id, req.params["id"]!));
    if (!reading) { res.status(404).json({ success: false, error: "Reading not found" }); return; }
    if (reading.posted) { res.status(400).json({ success: false, error: "Already posted" }); return; }
    const [meter] = await db.select().from(electricityMetersTable).where(eq(electricityMetersTable.id, reading.meterId));
    if (!meter?.residentId) { res.status(400).json({ success: false, error: "Meter has no resident; assign one before posting" }); return; }
    const amount = reading.amount ? Number(reading.amount) : 0;
    if (amount <= 0) { res.status(400).json({ success: false, error: "Amount is zero" }); return; }
    const ledger = await db.transaction(async (tx) => {
      const [entry] = await tx.insert(ledgerEntriesTable).values({
        id: newId(),
        residentId: meter.residentId!,
        type: "UTILITY",
        amount: String(amount),
        description: `Electricity • Meter ${meter.meterNo} • ${reading.unitsConsumed ?? 0} units`,
        isPaid: false,
        createdBy: req.user?.id,
        updatedAt: new Date(),
      }).returning();
      await tx.update(electricityReadingsTable).set({ posted: true, ledgerEntryId: entry.id }).where(eq(electricityReadingsTable.id, reading.id));
      return entry;
    });
    res.json({ success: true, data: { ledgerEntryId: ledger.id, amount } });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

electricityRouter.get("/summary", authenticate, authorize("ELECTRICITY", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    if (!propertyId) { res.json({ success: true, data: [] }); return; }
    const meters = await db.select().from(electricityMetersTable).where(eq(electricityMetersTable.propertyId, propertyId));
    const out: Array<{ meterId: string; meterNo: string; lastReading: number | null; totalUnits: number; totalAmount: number; postedAmount: number }> = [];
    for (const m of meters) {
      const readings = await db.select().from(electricityReadingsTable).where(eq(electricityReadingsTable.meterId, m.id));
      const totalUnits = readings.reduce((s, r) => s + (r.unitsConsumed ? Number(r.unitsConsumed) : 0), 0);
      const totalAmount = readings.reduce((s, r) => s + (r.amount ? Number(r.amount) : 0), 0);
      const postedAmount = readings.filter((r) => r.posted).reduce((s, r) => s + (r.amount ? Number(r.amount) : 0), 0);
      const last = readings.sort((a, b) => new Date(b.readingDate).getTime() - new Date(a.readingDate).getTime())[0];
      out.push({ meterId: m.id, meterNo: m.meterNo, lastReading: last ? Number(last.reading) : null, totalUnits, totalAmount, postedAmount });
    }
    res.json({ success: true, data: out });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

// Resident Attendance & Out-pass
export const residentAttendanceRouter: Router = Router();

residentAttendanceRouter.get("/", authenticate, authorize("RESIDENT_ATTENDANCE", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const date = req.query["date"] as string | undefined;
    if (!propertyId || !date) { res.status(400).json({ success: false, error: "propertyId and date required" }); return; }
    const residents = await db.select().from(residentsTable).where(and(eq(residentsTable.propertyId, propertyId), eq(residentsTable.status, "ACTIVE")));
    const records = await db.select().from(residentAttendanceTable).where(and(eq(residentAttendanceTable.propertyId, propertyId), eq(residentAttendanceTable.attendanceDate, date)));
    const map = new Map(records.map((r) => [r.residentId, r]));
    const data = residents.map((r) => ({
      residentId: r.id,
      residentName: r.name,
      roomId: r.roomId,
      record: map.get(r.id) || null,
    }));
    const present = records.filter((r) => r.status === "PRESENT").length;
    const absent = records.filter((r) => r.status === "ABSENT").length;
    const outPass = records.filter((r) => r.status === "OUT_PASS").length;
    res.json({ success: true, data, summary: { total: residents.length, marked: records.length, present, absent, outPass, pct: residents.length ? Math.round(present * 100 / residents.length) : 0 } });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

residentAttendanceRouter.post("/mark", authenticate, authorize("RESIDENT_ATTENDANCE", "create"), async (req, res) => {
  try {
    const items: Array<{ residentId: string; propertyId: string; attendanceDate: string; status: string; notes?: string }> = req.body?.items || [];
    let upserted = 0;
    for (const it of items) {
      const [existing] = await db.select().from(residentAttendanceTable)
        .where(and(eq(residentAttendanceTable.residentId, it.residentId), eq(residentAttendanceTable.attendanceDate, it.attendanceDate)));
      if (existing) {
        await db.update(residentAttendanceTable).set({ status: it.status, notes: it.notes ?? null, markedBy: req.user?.id ?? null, updatedAt: new Date() }).where(eq(residentAttendanceTable.id, existing.id));
      } else {
        await db.insert(residentAttendanceTable).values({
          id: newId(),
          residentId: it.residentId,
          propertyId: it.propertyId,
          attendanceDate: it.attendanceDate,
          status: it.status,
          notes: it.notes ?? null,
          markedBy: req.user?.id ?? null,
          updatedAt: new Date(),
        });
      }
      upserted++;
    }
    res.json({ success: true, data: { upserted } });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

residentAttendanceRouter.get("/history/:residentId", authenticate, authorize("RESIDENT_ATTENDANCE", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(residentAttendanceTable)
      .where(eq(residentAttendanceTable.residentId, req.params["residentId"]!))
      .orderBy(desc(residentAttendanceTable.attendanceDate))
      .limit(120);
    res.json({ success: true, data: rows });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

export const outPassRouter: Router = Router();

outPassRouter.get("/", authenticate, authorize("RESIDENT_ATTENDANCE", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const status = req.query["status"] as string | undefined;
    const residentId = req.query["residentId"] as string | undefined;
    const conditions = [];
    if (propertyId) conditions.push(eq(outPassesTable.propertyId, propertyId));
    if (status) conditions.push(eq(outPassesTable.status, status));
    if (residentId) conditions.push(eq(outPassesTable.residentId, residentId));
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db.select({
      o: outPassesTable,
      residentName: residentsTable.name,
      propertyName: propertiesTable.name,
    }).from(outPassesTable)
      .leftJoin(residentsTable, eq(outPassesTable.residentId, residentsTable.id))
      .leftJoin(propertiesTable, eq(outPassesTable.propertyId, propertiesTable.id))
      .where(where)
      .orderBy(desc(outPassesTable.leaveOn));
    res.json({ success: true, data: rows.map((r) => ({ ...r.o, residentName: r.residentName, propertyName: r.propertyName })) });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

outPassRouter.post("/", authenticate, authorize("RESIDENT_ATTENDANCE", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.residentId || !b.propertyId || !b.reason || !b.leaveOn || !b.expectedReturn) { res.status(400).json({ success: false, error: "Missing fields" }); return; }
    const [row] = await db.insert(outPassesTable).values({
      id: newId(),
      residentId: b.residentId,
      propertyId: b.propertyId,
      reason: b.reason,
      destination: b.destination ?? null,
      leaveOn: new Date(b.leaveOn),
      expectedReturn: new Date(b.expectedReturn),
      status: b.status || "PENDING",
      createdBy: req.user?.id ?? null,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

outPassRouter.put("/:id", authenticate, authorize("RESIDENT_ATTENDANCE", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["reason","destination","status","approverNote","parentNotified"]) if (b[k] !== undefined) u[k] = b[k];
    if (b.leaveOn !== undefined) u["leaveOn"] = new Date(b.leaveOn);
    if (b.expectedReturn !== undefined) u["expectedReturn"] = new Date(b.expectedReturn);
    if (b.actualReturn !== undefined) u["actualReturn"] = b.actualReturn ? new Date(b.actualReturn) : null;
    if (b.status === "APPROVED" || b.status === "REJECTED") u["approverId"] = req.user?.id ?? null;
    const [row] = await db.update(outPassesTable).set(u as Partial<typeof outPassesTable.$inferInsert>).where(eq(outPassesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

outPassRouter.post("/:id/return", authenticate, authorize("RESIDENT_ATTENDANCE", "edit"), async (req, res) => {
  try {
    const [row] = await db.update(outPassesTable).set({ status: "RETURNED", actualReturn: new Date(), updatedAt: new Date() }).where(eq(outPassesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

// IoT
export const iotRouter: Router = Router();

iotRouter.get("/devices", authenticate, authorize("IOT", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const roomId = req.query["roomId"] as string | undefined;
    const conditions = [];
    if (propertyId) conditions.push(eq(iotDevicesTable.propertyId, propertyId));
    if (roomId) conditions.push(eq(iotDevicesTable.roomId, roomId));
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db.select({
      d: iotDevicesTable,
      propertyName: propertiesTable.name,
      roomNumber: roomsTable.number,
    }).from(iotDevicesTable)
      .leftJoin(propertiesTable, eq(iotDevicesTable.propertyId, propertiesTable.id))
      .leftJoin(roomsTable, eq(iotDevicesTable.roomId, roomsTable.id))
      .where(where)
      .orderBy(desc(iotDevicesTable.createdAt));
    // Mask token in list view (last 4 chars only)
    res.json({ success: true, data: rows.map((r) => ({ ...r.d, propertyName: r.propertyName, roomNumber: r.roomNumber, ingestionToken: `••••${r.d.ingestionToken.slice(-4)}` })) });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

iotRouter.post("/devices", authenticate, authorize("IOT", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.propertyId || !b.name || !b.deviceType) { res.status(400).json({ success: false, error: "propertyId, name, deviceType required" }); return; }
    const token = randomBytes(24).toString("hex");
    const [row] = await db.insert(iotDevicesTable).values({
      id: newId(),
      propertyId: b.propertyId,
      roomId: b.roomId ?? null,
      name: b.name,
      deviceType: b.deviceType,
      adapter: b.adapter || "GENERIC",
      endpoint: b.endpoint ?? null,
      ingestionToken: token,
      config: b.config || {},
      status: b.status || "ACTIVE",
      registeredBy: req.user?.id ?? null,
      updatedAt: new Date(),
    }).returning();
    // Return full token on creation (only time it's shown)
    res.status(201).json({ success: true, data: row });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

iotRouter.put("/devices/:id", authenticate, authorize("IOT", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const u: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name","deviceType","adapter","endpoint","status","roomId","config"]) if (b[k] !== undefined) u[k] = b[k];
    const [row] = await db.update(iotDevicesTable).set(u as Partial<typeof iotDevicesTable.$inferInsert>).where(eq(iotDevicesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, ingestionToken: `••••${row.ingestionToken.slice(-4)}` } });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

iotRouter.post("/devices/:id/rotate-token", authenticate, authorize("IOT", "edit"), async (req, res) => {
  try {
    const token = randomBytes(24).toString("hex");
    const [row] = await db.update(iotDevicesTable).set({ ingestionToken: token, updatedAt: new Date() }).where(eq(iotDevicesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ingestionToken: token } });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

iotRouter.delete("/devices/:id", authenticate, authorize("IOT", "delete"), async (req, res) => {
  try {
    await db.delete(iotDevicesTable).where(eq(iotDevicesTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

iotRouter.get("/readings", authenticate, authorize("IOT", "view"), async (req, res) => {
  try {
    const deviceId = req.query["deviceId"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const roomId = req.query["roomId"] as string | undefined;
    const conditions = [];
    if (deviceId) conditions.push(eq(iotReadingsTable.deviceId, deviceId));
    if (propertyId) conditions.push(eq(iotDevicesTable.propertyId, propertyId));
    if (roomId) conditions.push(eq(iotDevicesTable.roomId, roomId));
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db.select({
      r: iotReadingsTable,
      deviceName: iotDevicesTable.name,
      deviceType: iotDevicesTable.deviceType,
    }).from(iotReadingsTable)
      .leftJoin(iotDevicesTable, eq(iotReadingsTable.deviceId, iotDevicesTable.id))
      .where(where)
      .orderBy(desc(iotReadingsTable.recordedAt))
      .limit(200);
    res.json({ success: true, data: rows.map((r) => ({ ...r.r, deviceName: r.deviceName, deviceType: r.deviceType, value: r.r.value != null ? Number(r.r.value) : null })) });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

iotRouter.get("/latest", authenticate, authorize("IOT", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const roomId = req.query["roomId"] as string | undefined;
    const conditions = [];
    if (propertyId) conditions.push(eq(iotDevicesTable.propertyId, propertyId));
    if (roomId) conditions.push(eq(iotDevicesTable.roomId, roomId));
    const where = conditions.length ? and(...conditions) : undefined;
    const devices = await db.select().from(iotDevicesTable).where(where);
    const out = [];
    for (const d of devices) {
      const [latest] = await db.select().from(iotReadingsTable).where(eq(iotReadingsTable.deviceId, d.id)).orderBy(desc(iotReadingsTable.recordedAt)).limit(1);
      out.push({
        deviceId: d.id,
        name: d.name,
        deviceType: d.deviceType,
        status: d.status,
        propertyId: d.propertyId,
        roomId: d.roomId,
        lastSeenAt: d.lastSeenAt,
        latest: latest ? { metric: latest.metric, value: latest.value != null ? Number(latest.value) : null, recordedAt: latest.recordedAt, raw: latest.rawPayload } : null,
      });
    }
    res.json({ success: true, data: out });
  } catch (e) { req.log.error(e); res.status(500).json({ success: false, error: "Internal" }); }
});

// Public ingestion endpoint — uses device-specific token, no JWT
export const iotIngestionRouter: Router = Router();

const ingestSchema = z.object({
  deviceId: z.string().min(1),
  metric: z.string().min(1),
  value: z.union([z.number(), z.string()]).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  recordedAt: z.string().optional(),
});

// Per-IP strict limiter for the unauthenticated ingest endpoint (write amplification / DB-exhaustion defence).
const ingestRateLimiter = rateLimit({ windowMs: 60_000, max: 120 });

iotIngestionRouter.post("/ingest", ingestRateLimiter, async (req, res) => {
  try {
    const auth = req.headers["authorization"] || req.headers["x-device-token"];
    const token = typeof auth === "string" ? (auth.startsWith("Bearer ") ? auth.slice(7) : auth) : null;
    if (!token) { res.status(401).json({ success: false, error: "Device token required" }); return; }

    const p = ingestSchema.safeParse(req.body);
    if (!p.success) { res.status(400).json({ success: false, error: p.error.message }); return; }
    const b = p.data;

    const [device] = await db.select().from(iotDevicesTable).where(eq(iotDevicesTable.id, b.deviceId));
    if (!device) { res.status(404).json({ success: false, error: "Device not found" }); return; }
    if (!safeTokenEqual(device.ingestionToken, token)) { res.status(403).json({ success: false, error: "Invalid device token" }); return; }
    if (device.status === "INACTIVE") { res.status(403).json({ success: false, error: "Device is inactive" }); return; }

    // Adapter: normalize value based on device.adapter
    let normalizedValue: string | null = null;
    if (b.value != null) normalizedValue = String(b.value);
    else if (device.adapter === "ENERGY_METER" && b.payload?.["kwh"] != null) normalizedValue = String(b.payload["kwh"]);
    else if (device.adapter === "TEMP_SENSOR" && b.payload?.["temp"] != null) normalizedValue = String(b.payload["temp"]);
    else if (device.adapter === "SMART_LOCK" && b.payload?.["state"] != null) normalizedValue = b.payload["state"] === "LOCKED" ? "1" : "0";

    const [row] = await db.insert(iotReadingsTable).values({
      id: newId(),
      deviceId: device.id,
      metric: b.metric,
      value: normalizedValue,
      rawPayload: b.payload || null,
      recordedAt: b.recordedAt ? new Date(b.recordedAt) : new Date(),
    }).returning();
    await db.update(iotDevicesTable).set({ lastSeenAt: new Date(), status: "ACTIVE", updatedAt: new Date() }).where(eq(iotDevicesTable.id, device.id));
    res.status(201).json({ success: true, data: { id: row.id, recordedAt: row.recordedAt } });
  } catch (e) { req.log?.error?.(e); res.status(500).json({ success: false, error: "Internal" }); }
});
