import { Router } from "express";
import { db } from "@workspace/db";
import {
  employeesTable, attendanceTable, leavesTable, jobRequisitionsTable, candidatesTable,
  leaveBalancesTable, performanceNotesTable, interviewsTable, offersTable,
  exitsTable, exitClearancesTable, exitAssetsTable,
} from "@workspace/db";
import { eq, sql, ilike, or, and, inArray, gte, lte } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick, forbidden } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId, withUniqueRetry } from "../lib/id.js";
import { csvEsc } from "../lib/export-service.js";

const router = Router();

async function nextEmpCode(): Promise<string> {
  const [r] = await db.select({ max: sql<string | null>`MAX(${employeesTable.employeeCode})` }).from(employeesTable);
  const last = r?.max || "EMP-0100";
  const n = parseInt(last.replace(/[^0-9]/g, ""), 10) || 100;
  return `EMP-${String(n + 1).padStart(4, "0")}`;
}

// Employees
router.get("/", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const department = req.query["department"] as string | undefined;
    const status = req.query["status"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;

    const conditions = [];
    if (department) conditions.push(eq(employeesTable.department, department));
    if (status) conditions.push(eq(employeesTable.status, status as "ACTIVE" | "INACTIVE" | "ON_LEAVE" | "EXITED"));
    if (propertyId) conditions.push(eq(employeesTable.propertyId, propertyId));
    if (search) conditions.push(or(ilike(employeesTable.name, `%${search}%`), ilike(employeesTable.email, `%${search}%`), ilike(employeesTable.employeeCode, `%${search}%`))!);

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(employeesTable).where(where);
    const rows = await db.select().from(employeesTable).where(where).limit(limit).offset(offset).orderBy(employeesTable.createdAt);
    res.json({ success: true, data: rows.map(r => ({ ...r, ctc: r.ctc ? Number(r.ctc) : null })), meta: buildMeta(countResult.count, page, limit) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/", authenticate, authorize("EMPLOYEES", "create"), async (req, res) => {
  try {
    const body = pick(req.body, [
      "name", "email", "phone", "dob", "gender", "photo", "department", "designation",
      "propertyId", "managerId", "joiningDate", "ctc", "basic", "hra", "specialAllowance",
      "bankAccount", "ifscCode", "panNumber", "pfNumber", "esicNumber", "status",
    ]) as Record<string, any>;
    const row = await withUniqueRetry(async () => {
      const [r] = await db.insert(employeesTable).values({
      id: newId(),
      employeeCode: await nextEmpCode(),
      name: body.name,
      email: body.email,
      phone: body.phone,
      dob: body.dob ? new Date(body.dob) : undefined,
      gender: body.gender,
      photo: body.photo,
      department: body.department,
      designation: body.designation,
      propertyId: body.propertyId,
      managerId: body.managerId,
      joiningDate: new Date(body.joiningDate),
      ctc: body.ctc?.toString(),
      basic: body.basic?.toString(),
      hra: body.hra?.toString(),
      specialAllowance: body.specialAllowance?.toString(),
      bankAccount: body.bankAccount,
      ifscCode: body.ifscCode,
      panNumber: body.panNumber,
      pfNumber: body.pfNumber,
      esicNumber: body.esicNumber,
      status: body.status || "ACTIVE",
      updatedAt: new Date(),
      }).returning();
      return r;
    });
    // Seed default leave balances for current year
    const year = new Date().getFullYear();
    const defaults = [{ type: "CL" as const, total: 12 }, { type: "SL" as const, total: 12 }, { type: "EL" as const, total: 15 }, { type: "PL" as const, total: 0 }];
    for (const d of defaults) {
      await db.insert(leaveBalancesTable).values({ id: newId(), employeeId: row.id, year, type: d.type, total: d.total, used: 0 });
    }
    res.status(201).json({ success: true, data: { ...row, ctc: row.ctc ? Number(row.ctc) : null } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/:id", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(employeesTable).where(eq(employeesTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, ctc: row.ctc ? Number(row.ctc) : null } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/:id", authenticate, authorize("EMPLOYEES", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, [
      "name", "email", "phone", "dob", "gender", "photo", "department", "designation",
      "propertyId", "managerId", "joiningDate", "ctc", "basic", "hra", "specialAllowance",
      "bankAccount", "ifscCode", "panNumber", "pfNumber", "esicNumber", "status",
    ]) as Record<string, unknown>;
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(body)) {
      if (k === "dob" && v) updateData["dob"] = new Date(v as string);
      else if (k === "joiningDate" && v) updateData["joiningDate"] = new Date(v as string);
      else if (k === "ctc") updateData["ctc"] = v?.toString();
      else updateData[k] = v;
    }
    const [row] = await db.update(employeesTable).set(updateData as Partial<typeof employeesTable.$inferInsert>).where(eq(employeesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, ctc: row.ctc ? Number(row.ctc) : null } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.delete("/:id", authenticate, authorize("EMPLOYEES", "delete"), async (req, res) => {
  try {
    await db.delete(employeesTable).where(eq(employeesTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Employee leave balances
router.get("/:id/leave-balances", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const year = parseInt(req.query["year"] as string || String(new Date().getFullYear()), 10);
    const rows = await db.select().from(leaveBalancesTable).where(and(eq(leaveBalancesTable.employeeId, req.params["id"]!), eq(leaveBalancesTable.year, year)));
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Employee attendance for a month
router.get("/:id/attendance", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const year = parseInt(req.query["year"] as string || String(new Date().getFullYear()), 10);
    const month = parseInt(req.query["month"] as string || String(new Date().getMonth() + 1), 10);
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);
    const rows = await db.select().from(attendanceTable)
      .where(and(eq(attendanceTable.employeeId, req.params["id"]!), gte(attendanceTable.date, start), lte(attendanceTable.date, end)));
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Performance notes
router.get("/:id/performance", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(performanceNotesTable).where(eq(performanceNotesTable.employeeId, req.params["id"]!)).orderBy(performanceNotesTable.date);
    res.json({ success: true, data: rows });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

router.post("/:id/performance", authenticate, authorize("EMPLOYEES", "create"), async (req, res) => {
  try {
    const [row] = await db.insert(performanceNotesTable).values({
      id: newId(), employeeId: req.params["id"]!, type: req.body.type, text: req.body.text,
      date: req.body.date ? new Date(req.body.date) : new Date(), addedBy: req.user?.id,
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Exits
router.post("/:id/exit", authenticate, authorize("EMPLOYEES", "create"), async (req, res) => {
  try {
    const empId = req.params["id"]!;
    const [exit] = await db.insert(exitsTable).values({
      id: newId(), employeeId: empId, exitType: req.body.exitType, exitDate: new Date(req.body.exitDate),
      reason: req.body.reason, status: "IN_PROGRESS",
    }).returning();
    const depts = ["IT", "ADMIN", "FINANCE", "ASSETS"];
    for (const d of depts) {
      await db.insert(exitClearancesTable).values({ id: newId(), exitId: exit.id, department: d, status: "PENDING" });
    }
    const assets = ["LAPTOP", "ID_CARD", "KEYS", "ACCESS_CARDS", "UNIFORM"];
    for (const a of assets) {
      await db.insert(exitAssetsTable).values({ id: newId(), exitId: exit.id, asset: a, returned: false });
    }
    res.status(201).json({ success: true, data: exit });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

router.get("/:id/exit", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const [exit] = await db.select().from(exitsTable).where(eq(exitsTable.employeeId, req.params["id"]!)).orderBy(sql`${exitsTable.createdAt} DESC`).limit(1);
    if (!exit) { res.json({ success: true, data: null }); return; }
    const clearances = await db.select().from(exitClearancesTable).where(eq(exitClearancesTable.exitId, exit.id));
    const assets = await db.select().from(exitAssetsTable).where(eq(exitAssetsTable.exitId, exit.id));
    res.json({ success: true, data: { ...exit, clearances, assets, finalSettlement: exit.finalSettlement ? Number(exit.finalSettlement) : null } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

router.put("/exit-clearances/:cid", authenticate, authorize("EMPLOYEES", "edit"), async (req, res) => {
  try {
    const [row] = await db.update(exitClearancesTable).set({
      status: req.body.status || "CLEARED", clearedBy: req.user?.id, clearedAt: new Date(),
    }).where(eq(exitClearancesTable.id, req.params["cid"]!)).returning();
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

router.put("/exit-assets/:aid", authenticate, authorize("EMPLOYEES", "edit"), async (req, res) => {
  try {
    const [row] = await db.update(exitAssetsTable).set({ returned: !!req.body.returned })
      .where(eq(exitAssetsTable.id, req.params["aid"]!)).returning();
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

router.post("/exits/:eid/finalize", authenticate, authorize("EMPLOYEES", "edit"), async (req, res) => {
  try {
    const eid = req.params["eid"]!;
    const clearances = await db.select().from(exitClearancesTable).where(eq(exitClearancesTable.exitId, eid));
    const allCleared = clearances.every(c => c.status === "CLEARED");
    if (!allCleared) { res.status(400).json({ success: false, error: "All clearances must be CLEARED" }); return; }
    const [exit] = await db.update(exitsTable).set({
      status: "COMPLETED", finalSettlement: req.body.finalSettlement?.toString(),
    }).where(eq(exitsTable.id, eid)).returning();
    await db.update(employeesTable).set({ status: "EXITED", exitedAt: exit.exitDate, updatedAt: new Date() })
      .where(eq(employeesTable.id, exit.employeeId));
    res.json({ success: true, data: exit });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Stats
router.get("/stats/overview", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const all = await db.select().from(employeesTable);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const totalActive = all.filter(e => e.status === "ACTIVE").length;
    const joinedThisMonth = all.filter(e => new Date(e.joiningDate) >= monthStart).length;
    const exitedThisMonth = all.filter(e => e.exitedAt && new Date(e.exitedAt) >= monthStart).length;
    // on leave today
    const leaves = await db.select().from(leavesTable).where(and(
      eq(leavesTable.status, "APPROVED"),
      lte(leavesTable.fromDate, new Date()),
      gte(leavesTable.toDate, today),
    ));
    const onLeaveToday = new Set(leaves.map(l => l.employeeId)).size;
    res.json({ success: true, data: { totalActive, joinedThisMonth, exitedThisMonth, onLeaveToday } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export { router as employeeRouter };

// Attendance
const attendanceRouter = Router();

attendanceRouter.get("/", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const employeeId = req.query["employeeId"] as string | undefined;

    const where = employeeId ? eq(attendanceTable.employeeId, employeeId) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(attendanceTable).where(where);
    const rows = await db.select().from(attendanceTable).where(where).limit(limit).offset(offset).orderBy(attendanceTable.date);

    const enriched = await Promise.all(rows.map(async (r) => {
      const [emp] = await db.select({ name: employeesTable.name }).from(employeesTable).where(eq(employeesTable.id, r.employeeId));
      return { ...r, employeeName: emp?.name || null };
    }));
    res.json({ success: true, data: enriched, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Bulk mark attendance
attendanceRouter.post("/bulk", authenticate, authorize("EMPLOYEES", "create"), async (req, res) => {
  try {
    const { employeeIds, date, status } = req.body;
    if (!Array.isArray(employeeIds) || !date || !status) {
      res.status(400).json({ success: false, error: "employeeIds, date, status required" }); return;
    }
    const d = new Date(date);
    let inserted = 0;
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    for (const eid of employeeIds) {
      const existing = await db.select().from(attendanceTable).where(and(
        eq(attendanceTable.employeeId, eid),
        gte(attendanceTable.date, dayStart),
        lte(attendanceTable.date, dayEnd),
      ));
      if (existing.length > 0) {
        // Update first record; delete any duplicates to keep data consistent
        await db.update(attendanceTable).set({ status, date: dayStart }).where(eq(attendanceTable.id, existing[0].id));
        for (let i = 1; i < existing.length; i++) {
          await db.delete(attendanceTable).where(eq(attendanceTable.id, existing[i].id));
        }
      } else {
        await db.insert(attendanceTable).values({ id: newId(), employeeId: eid, date: dayStart, status });
      }
      inserted++;
    }
    res.json({ success: true, data: { count: inserted } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Attendance for a specific date (all employees)
attendanceRouter.get("/by-date", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const date = req.query["date"] as string;
    if (!date) { res.status(400).json({ success: false, error: "date required" }); return; }
    const d = new Date(date);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
    const employees = await db.select().from(employeesTable).where(eq(employeesTable.status, "ACTIVE"));
    const records = await db.select().from(attendanceTable).where(and(gte(attendanceTable.date, start), lte(attendanceTable.date, end)));
    const byEmp: Record<string, typeof attendanceTable.$inferSelect> = {};
    for (const r of records) byEmp[r.employeeId] = r;
    const result = employees.map(e => ({
      employeeId: e.id, employeeCode: e.employeeCode, employeeName: e.name, department: e.department,
      record: byEmp[e.id] || null,
    }));
    res.json({ success: true, data: result });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Export attendance CSV for a month
attendanceRouter.get("/export-csv", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const year = parseInt(req.query["year"] as string || String(new Date().getFullYear()), 10);
    const month = parseInt(req.query["month"] as string || String(new Date().getMonth() + 1), 10);
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);
    const employees = await db.select().from(employeesTable);
    const records = await db.select().from(attendanceTable).where(and(gte(attendanceTable.date, start), lte(attendanceTable.date, end)));
    const daysInMonth = new Date(year, month, 0).getDate();
    const map: Record<string, Record<number, string>> = {};
    for (const r of records) {
      const day = new Date(r.date).getDate();
      if (!map[r.employeeId]) map[r.employeeId] = {};
      map[r.employeeId][day] = r.status;
    }
    const headers = ["Employee Code", "Name", "Department", ...Array.from({ length: daysInMonth }, (_, i) => String(i + 1))];
    const lines = [headers.map(csvEsc).join(",")];
    for (const e of employees) {
      const row = [e.employeeCode, e.name, e.department];
      for (let i = 1; i <= daysInMonth; i++) row.push((map[e.id]?.[i] || "").charAt(0) || "-");
      lines.push(row.map(csvEsc).join(","));
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=attendance-${year}-${month}.csv`);
    res.send(lines.join("\n"));
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

attendanceRouter.post("/", authenticate, authorize("EMPLOYEES", "create"), async (req, res) => {
  try {
    const body = req.body;
    const [row] = await db.insert(attendanceTable).values({
      id: newId(),
      employeeId: body.employeeId,
      date: new Date(body.date),
      status: body.status,
      inTime: body.inTime ? new Date(body.inTime) : undefined,
      outTime: body.outTime ? new Date(body.outTime) : undefined,
      notes: body.notes,
    }).returning();
    const [emp] = await db.select({ name: employeesTable.name }).from(employeesTable).where(eq(employeesTable.id, row.employeeId));
    res.status(201).json({ success: true, data: { ...row, employeeName: emp?.name || null } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

attendanceRouter.put("/:id", authenticate, authorize("EMPLOYEES", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, ["employeeId", "date", "status", "inTime", "outTime", "notes"]) as Record<string, any>;
    const [row] = await db.update(attendanceTable).set({ ...body, date: body.date ? new Date(body.date) : undefined }).where(eq(attendanceTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [emp] = await db.select({ name: employeesTable.name }).from(employeesTable).where(eq(employeesTable.id, row.employeeId));
    res.json({ success: true, data: { ...row, employeeName: emp?.name || null } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export { attendanceRouter };

// Leaves
const leavesRouter = Router();

leavesRouter.get("/", authenticate, authorize("EMPLOYEES", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const employeeId = req.query["employeeId"] as string | undefined;
    const status = req.query["status"] as string | undefined;

    const conditions = [];
    if (employeeId) conditions.push(eq(leavesTable.employeeId, employeeId));
    if (status) conditions.push(eq(leavesTable.status, status as "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(leavesTable).where(where);
    const rows = await db.select().from(leavesTable).where(where).limit(limit).offset(offset).orderBy(leavesTable.createdAt);
    const enriched = await Promise.all(rows.map(async (r) => {
      const [emp] = await db.select({ name: employeesTable.name }).from(employeesTable).where(eq(employeesTable.id, r.employeeId));
      return { ...r, employeeName: emp?.name || null };
    }));
    res.json({ success: true, data: enriched, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

leavesRouter.post("/", authenticate, authorize("EMPLOYEES", "create"), async (req, res) => {
  try {
    const body = req.body;
    const [row] = await db.insert(leavesTable).values({
      id: newId(),
      employeeId: body.employeeId,
      type: body.type,
      fromDate: new Date(body.fromDate),
      toDate: new Date(body.toDate),
      days: body.days,
      reason: body.reason,
      updatedAt: new Date(),
    }).returning();
    const [emp] = await db.select({ name: employeesTable.name }).from(employeesTable).where(eq(employeesTable.id, row.employeeId));
    res.status(201).json({ success: true, data: { ...row, employeeName: emp?.name || null } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

leavesRouter.put("/:id", authenticate, authorize("EMPLOYEES", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, ["type", "fromDate", "toDate", "days", "reason", "status", "approvedBy"]) as Record<string, any>;
    const [prev] = await db.select().from(leavesTable).where(eq(leavesTable.id, req.params["id"]!));
    if (!prev) { res.status(404).json({ success: false, error: "Not found" }); return; }
    // Block self-approval/rejection: a user may not approve or reject their own leave request.
    if (body.status === "APPROVED" || body.status === "REJECTED") {
      const [emp] = await db.select({ id: employeesTable.id, email: employeesTable.email })
        .from(employeesTable).where(eq(employeesTable.id, prev.employeeId));
      if (emp && (emp.id === req.user?.id || (!!req.user?.email && emp.email === req.user.email))) {
        throw forbidden("You cannot approve or reject your own leave request");
      }
    }
    const updateData: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.fromDate) updateData["fromDate"] = new Date(body.fromDate);
    if (body.toDate) updateData["toDate"] = new Date(body.toDate);
    const [row] = await db.update(leavesTable).set(updateData as Partial<typeof leavesTable.$inferInsert>).where(eq(leavesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    // Reconcile balances: subtract prev contribution if it was APPROVED, then add new contribution if now APPROVED.
    const adjust = async (employeeId: string, year: number, type: string, delta: number) => {
      const [bal] = await db.select().from(leaveBalancesTable).where(and(
        eq(leaveBalancesTable.employeeId, employeeId), eq(leaveBalancesTable.year, year), eq(leaveBalancesTable.type, type as never),
      ));
      if (bal) await db.update(leaveBalancesTable).set({ used: Math.max(0, bal.used + delta) }).where(eq(leaveBalancesTable.id, bal.id));
    };
    if (prev.status === "APPROVED") {
      await adjust(prev.employeeId, new Date(prev.fromDate).getFullYear(), prev.type, -prev.days);
    }
    if (row.status === "APPROVED") {
      await adjust(row.employeeId, new Date(row.fromDate).getFullYear(), row.type, row.days);
    }
    const [emp] = await db.select({ name: employeesTable.name }).from(employeesTable).where(eq(employeesTable.id, row.employeeId));
    res.json({ success: true, data: { ...row, employeeName: emp?.name || null } });
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status) { res.status(status).json({ success: false, error: (err as Error).message }); return; }
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export { leavesRouter };

// Recruitment
const recruitmentRouter = Router();

recruitmentRouter.get("/job-requisitions", authenticate, authorize("RECRUITMENT", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(jobRequisitionsTable);
    const rows = await db.select().from(jobRequisitionsTable).limit(limit).offset(offset).orderBy(jobRequisitionsTable.createdAt);
    const enriched = await Promise.all(rows.map(async (r) => {
      const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(candidatesTable).where(eq(candidatesTable.jobRequisitionId, r.id));
      return { ...r, candidateCount: c.count || 0 };
    }));
    res.json({ success: true, data: enriched, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

recruitmentRouter.post("/job-requisitions", authenticate, authorize("RECRUITMENT", "create"), async (req, res) => {
  try {
    const body = pick(req.body, ["role", "department", "headcount", "status"]);
    const [row] = await db.insert(jobRequisitionsTable).values({ id: newId(), ...body, updatedAt: new Date() } as typeof jobRequisitionsTable.$inferInsert).returning();
    res.status(201).json({ success: true, data: { ...row, candidateCount: 0 } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

recruitmentRouter.get("/candidates", authenticate, authorize("RECRUITMENT", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const stage = req.query["stage"] as string | undefined;

    const conditions = [];
    if (stage) conditions.push(eq(candidatesTable.stage, stage));
    if (search) conditions.push(or(ilike(candidatesTable.name, `%${search}%`), ilike(candidatesTable.email, `%${search}%`))!);
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(candidatesTable).where(where);
    const rows = await db.select().from(candidatesTable).where(where).limit(limit).offset(offset).orderBy(candidatesTable.createdAt);
    res.json({ success: true, data: rows, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

recruitmentRouter.post("/candidates", authenticate, authorize("RECRUITMENT", "create"), async (req, res) => {
  try {
    const body = pick(req.body, ["jobRequisitionId", "name", "email", "phone", "resumeUrl", "source", "stage", "bgvStatus", "offerStatus", "notes"]);
    const [row] = await db.insert(candidatesTable).values({ id: newId(), ...body, updatedAt: new Date() } as typeof candidatesTable.$inferInsert).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

recruitmentRouter.put("/candidates/:id", authenticate, authorize("RECRUITMENT", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, ["jobRequisitionId", "name", "email", "phone", "resumeUrl", "source", "stage", "bgvStatus", "offerStatus", "notes"]);
    const [row] = await db.update(candidatesTable).set({ ...body, updatedAt: new Date() }).where(eq(candidatesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

recruitmentRouter.get("/candidates/:id", authenticate, authorize("RECRUITMENT", "view"), async (req, res) => {
  try {
    const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, req.params["id"]!));
    if (!c) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const interviews = await db.select().from(interviewsTable).where(eq(interviewsTable.candidateId, c.id));
    const offers = await db.select().from(offersTable).where(eq(offersTable.candidateId, c.id));
    res.json({ success: true, data: { ...c, interviews, offers: offers.map(o => ({ ...o, ctc: Number(o.ctc) })) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

recruitmentRouter.post("/candidates/:id/interviews", authenticate, authorize("RECRUITMENT", "create"), async (req, res) => {
  try {
    const [row] = await db.insert(interviewsTable).values({
      id: newId(), candidateId: req.params["id"]!, scheduledAt: new Date(req.body.scheduledAt),
      panel: req.body.panel, notes: req.body.notes,
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

recruitmentRouter.post("/candidates/:id/offers", authenticate, authorize("RECRUITMENT", "create"), async (req, res) => {
  try {
    const [row] = await db.insert(offersTable).values({
      id: newId(), candidateId: req.params["id"]!, ctc: req.body.ctc?.toString(), joiningDate: new Date(req.body.joiningDate),
    }).returning();
    await db.update(candidatesTable).set({ stage: "OFFER", updatedAt: new Date() }).where(eq(candidatesTable.id, req.params["id"]!));
    res.status(201).json({ success: true, data: { ...row, ctc: Number(row.ctc) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

export { recruitmentRouter };
export default router;
