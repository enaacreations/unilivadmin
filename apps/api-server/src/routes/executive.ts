import { Router } from "express";
import { db, propertiesTable, residentsTable, complaintsTable, employeesTable, leavesTable, paymentsTable, leadsTable, usersTable } from "@workspace/db";
import { sql, eq, and, gte, lt, desc } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";

export const executiveRouter = Router();
executiveRouter.use(authenticate, authorize("EXECUTIVE_DASHBOARD", "view"));

executiveRouter.get("/kpis", async (_req, res) => {
  try {
    const [props] = await db.select({ count: sql<number>`count(*)::int` }).from(propertiesTable);
    const [residents] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(eq(residentsTable.status, "ACTIVE"));
    const [beds] = await db.select({ total: sql<number>`coalesce(sum(total_beds)::int, 0)` }).from(propertiesTable);
    const occupancy = beds.total ? Math.round((residents.count / beds.total) * 1000) / 10 : 0;

    const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
    const [revenue] = await db.select({ total: sql<number>`coalesce(sum(amount::numeric), 0)::float` }).from(paymentsTable).where(and(eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, start)));
    const [outstanding] = await db.select({ total: sql<number>`coalesce(sum(amount::numeric), 0)::float` }).from(paymentsTable).where(eq(paymentsTable.status, "PENDING"));
    const [openCmp] = await db.select({ count: sql<number>`count(*)::int` }).from(complaintsTable).where(sql`status NOT IN ('RESOLVED', 'CLOSED')`);

    res.json({ success: true, data: {
      totalProperties: props.count,
      totalResidents: residents.count,
      occupancy,
      revenueThisMonth: revenue.total,
      outstandingDues: outstanding.total,
      openComplaints: openCmp.count,
    }});
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

executiveRouter.get("/revenue-trend", async (_req, res) => {
  try {
    // NOTE: payments are not tagged by revenue source (rent/food/laundry) — the
    // payments table has no category column. The per-category split below is an
    // ESTIMATE produced by applying fixed ratios to the real monthly total; only
    // `total` is actual collected revenue. The response flags this via `estimated`.
    const RENT_RATIO = 0.7;
    const FOOD_RATIO = 0.2;
    const LAUNDRY_RATIO = 0.1;
    const months: Array<{ month: string; rent: number; food: number; laundry: number; total: number; estimated: boolean }> = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const [r] = await db.select({ total: sql<number>`coalesce(sum(amount::numeric), 0)::float` })
        .from(paymentsTable)
        .where(and(eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, monthStart), lt(paymentsTable.createdAt, monthEnd)));
      const total = r.total || 0;
      months.push({
        month: monthStart.toLocaleString("en", { month: "short", year: "2-digit" }),
        rent: Math.round(total * RENT_RATIO),
        food: Math.round(total * FOOD_RATIO),
        laundry: Math.round(total * LAUNDRY_RATIO),
        total,
        estimated: true,
      });
    }
    res.json({
      success: true,
      data: months,
      meta: {
        splitEstimated: true,
        note: "rent/food/laundry are estimated by applying fixed 70/20/10 ratios to the actual monthly total; payments are not tagged by revenue source. Only `total` is actual collected revenue.",
      },
    });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

executiveRouter.get("/occupancy-by-property", async (_req, res) => {
  try {
    const props = await db.select().from(propertiesTable);
    const data = await Promise.all(props.map(async (p) => {
      const [occ] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(and(eq(residentsTable.propertyId, p.id), eq(residentsTable.status, "ACTIVE")));
      const occupancy = p.totalBeds ? Math.round((occ.count / p.totalBeds) * 1000) / 10 : 0;
      return { property: p.name, occupied: occ.count, total: p.totalBeds, occupancy };
    }));
    res.json({ success: true, data });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

executiveRouter.get("/complaints-resolution", async (_req, res) => {
  try {
    const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
    const [total] = await db.select({ count: sql<number>`count(*)::int` }).from(complaintsTable).where(gte(complaintsTable.createdAt, start));
    const [resolved] = await db.select({ count: sql<number>`count(*)::int` }).from(complaintsTable).where(and(gte(complaintsTable.createdAt, start), sql`status IN ('RESOLVED', 'CLOSED')`));
    res.json({ success: true, data: { resolved: resolved.count, total: total.count, open: total.count - resolved.count, rate: total.count ? Math.round((resolved.count / total.count) * 1000) / 10 : 0 }});
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

executiveRouter.get("/lead-funnel", async (_req, res) => {
  try {
    const stages = ["NEW","CONTACTED","VISIT_SCHEDULED","VISIT_DONE","NEGOTIATING","CONVERTED"] as const;
    const out = [] as Array<{ stage: string; count: number }>;
    for (const s of stages) {
      const [r] = await db.select({ count: sql<number>`count(*)::int` }).from(leadsTable).where(eq(leadsTable.stage, s));
      out.push({ stage: s, count: r.count });
    }
    res.json({ success: true, data: out });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

executiveRouter.get("/headcount", async (_req, res) => {
  try {
    const rows = await db.select({ department: employeesTable.department, count: sql<number>`count(*)::int` })
      .from(employeesTable).where(eq(employeesTable.status, "ACTIVE"))
      .groupBy(employeesTable.department);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [leavesToday] = await db.select({ count: sql<number>`count(*)::int` }).from(leavesTable).where(and(eq(leavesTable.status, "APPROVED"), sql`${leavesTable.fromDate} <= ${today.toISOString()}`, sql`${leavesTable.toDate} >= ${today.toISOString()}`));
    res.json({ success: true, data: { byDept: rows, leavesToday: leavesToday.count }});
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

executiveRouter.get("/top-overdue", async (_req, res) => {
  try {
    const rows = await db.select({
      id: paymentsTable.id, residentId: paymentsTable.residentId, amount: paymentsTable.amount, dueDate: paymentsTable.createdAt,
      residentName: residentsTable.name, propertyId: residentsTable.propertyId,
    })
      .from(paymentsTable)
      .leftJoin(residentsTable, eq(paymentsTable.residentId, residentsTable.id))
      .where(eq(paymentsTable.status, "PENDING"))
      .orderBy(paymentsTable.createdAt)
      .limit(5);
    res.json({ success: true, data: rows });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

executiveRouter.get("/portfolio-breakdown", async (_req, res) => {
  try {
    const props = await db.select().from(propertiesTable);
    const map = new Map<string, { type: string; properties: number; totalBeds: number; occupied: number }>();
    for (const p of props) {
      const key = p.portfolioType || "CO_LIVING";
      const entry = map.get(key) || { type: key, properties: 0, totalBeds: 0, occupied: 0 };
      entry.properties += 1;
      entry.totalBeds += p.totalBeds || 0;
      const [r] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(residentsTable)
        .where(and(eq(residentsTable.propertyId, p.id), eq(residentsTable.status, "ACTIVE")));
      entry.occupied += r.count || 0;
      map.set(key, entry);
    }
    const data = Array.from(map.values()).map((e) => ({
      ...e,
      occupancy: e.totalBeds ? Math.round((e.occupied / e.totalBeds) * 1000) / 10 : 0,
    }));
    res.json({ success: true, data });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

executiveRouter.get("/top-sla-breached", async (_req, res) => {
  try {
    const rows = await db.select().from(complaintsTable).where(sql`status NOT IN ('RESOLVED', 'CLOSED')`).orderBy(desc(complaintsTable.createdAt)).limit(5);
    res.json({ success: true, data: rows });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
