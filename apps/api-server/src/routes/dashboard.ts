import { Router } from "express";
import { db } from "@workspace/db";
import {
  propertiesTable, residentsTable, complaintsTable,
  employeesTable, leavesTable, paymentsTable,
  inventoryTable, leadsTable, roomsTable,
} from "@workspace/db";
import { sql, eq, and, gte } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { effectivePropertyFilter, scopedPropertyId, sendAuthzError } from "../lib/authz.js";

const router = Router();

router.get("/stats", authenticate, authorize("DASHBOARD", "view"), async (req, res) => {
  try {
    // The sidebar property selector scopes every metric to one property — but
    // it was only ever a HINT: omitting it showed a property-bound caller the
    // whole estate's occupancy, revenue and complaint counts. Folding the
    // caller's own scope in here cascades through every branch below, since
    // each one already keys off this single value.
    const propertyId = effectivePropertyFilter(req, req.query["propertyId"] as string | undefined);

    const propWhere = propertyId ? eq(propertiesTable.id, propertyId) : undefined;
    const resActive = propertyId
      ? and(eq(residentsTable.propertyId, propertyId), eq(residentsTable.status, "ACTIVE"))
      : eq(residentsTable.status, "ACTIVE");

    const [propCount] = await db.select({ count: sql<number>`count(*)::int` }).from(propertiesTable).where(propWhere);
    const [resCount] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(resActive);

    const [totalBeds] = await db.select({ total: sql<number>`coalesce(sum(total_beds), 0)::int` }).from(propertiesTable).where(propWhere);
    const [occupiedBeds] = await db.select({ count: sql<number>`count(*)::int` }).from(residentsTable).where(resActive);

    const [openComplaints] = await db.select({ count: sql<number>`count(*)::int` }).from(complaintsTable).where(
      propertyId ? and(eq(complaintsTable.status, "OPEN"), eq(complaintsTable.propertyId, propertyId)) : eq(complaintsTable.status, "OPEN")
    );
    const [critComplaints] = await db.select({ count: sql<number>`count(*)::int` }).from(complaintsTable).where(
      propertyId
        ? and(eq(complaintsTable.priority, "CRITICAL"), eq(complaintsTable.propertyId, propertyId), sql`status != 'RESOLVED' AND status != 'CLOSED'`)
        : and(eq(complaintsTable.priority, "CRITICAL"), sql`status != 'RESOLVED' AND status != 'CLOSED'`)
    );

    // These two ignored `propertyId` altogether, so even a property-scoped
    // dashboard reported org-wide headcount and every pending leave request.
    // Leaves carry no propertyId of their own — they scope through the employee.
    const [empCount] = await db.select({ count: sql<number>`count(*)::int` }).from(employeesTable).where(
      propertyId
        ? and(eq(employeesTable.status, "ACTIVE"), eq(employeesTable.propertyId, propertyId))
        : eq(employeesTable.status, "ACTIVE")
    );
    const [pendingLeaves] = propertyId
      ? await db.select({ count: sql<number>`count(*)::int` })
          .from(leavesTable)
          .innerJoin(employeesTable, eq(leavesTable.employeeId, employeesTable.id))
          .where(and(eq(leavesTable.status, "PENDING"), eq(employeesTable.propertyId, propertyId)))
      : await db.select({ count: sql<number>`count(*)::int` }).from(leavesTable).where(eq(leavesTable.status, "PENDING"));

    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);
    const [monthLeads] = await db.select({ count: sql<number>`count(*)::int` }).from(leadsTable).where(gte(leadsTable.createdAt, startOfMonth));
    const [convertedLeads] = await db.select({ count: sql<number>`count(*)::int` }).from(leadsTable).where(and(eq(leadsTable.stage, "CONVERTED"), gte(leadsTable.createdAt, startOfMonth)));

    // Collected revenue is attributed to the property the money was taken AT
    // (payments.property_id), never to the resident's CURRENT property — one
    // inter-property transfer would otherwise rewrite both properties' revenue
    // history (M10). Outstanding dues are the opposite: an unpaid charge is
    // chased at wherever the resident lives now, so `pending` still reads
    // residents.propertyId. Same rule as food-ops' collectedAtProperty.
    const [revenue] = await db.select({ total: sql<number>`coalesce(sum(${paymentsTable.amount}::numeric), 0)` })
      .from(paymentsTable)
      .where(and(
        eq(paymentsTable.status, "SUCCESS"),
        gte(paymentsTable.createdAt, startOfMonth),
        ...(propertyId ? [eq(paymentsTable.propertyId, propertyId)] : []),
      ));
    const [pending] = propertyId
      ? await db.select({ total: sql<number>`coalesce(sum(${paymentsTable.amount}::numeric), 0)` })
          .from(paymentsTable)
          .leftJoin(residentsTable, eq(paymentsTable.residentId, residentsTable.id))
          .where(and(eq(paymentsTable.status, "PENDING"), eq(residentsTable.propertyId, propertyId)))
      : await db.select({ total: sql<number>`coalesce(sum(amount::numeric), 0)` }).from(paymentsTable).where(eq(paymentsTable.status, "PENDING"));

    // Deliberately NOT property-filtered: leads are pre-tenancy and inventory is
    // held centrally, so neither has a property to scope by. A scoped caller
    // sees org-wide figures for these two, which is the honest answer rather
    // than a zero that would read as "nothing to reorder".
    const [lowStock] = await db.select({ count: sql<number>`count(*)::int` }).from(inventoryTable).where(sql`current_stock::numeric <= min_stock::numeric`);

    const total = totalBeds.total || 0;
    const occupied = occupiedBeds.count || 0;

    res.json({
      success: true,
      data: {
        totalProperties: propCount.count || 0,
        totalResidents: resCount.count || 0,
        totalBeds: total,
        occupiedBeds: occupied,
        occupancyRate: total > 0 ? Math.round((occupied / total) * 100) : 0,
        openComplaints: openComplaints.count || 0,
        criticalComplaints: critComplaints.count || 0,
        totalEmployees: empCount.count || 0,
        pendingLeaves: pendingLeaves.count || 0,
        newLeadsThisMonth: monthLeads.count || 0,
        convertedLeadsThisMonth: convertedLeads.count || 0,
        revenueThisMonth: Number(revenue.total) || 0,
        pendingPayments: Number(pending.total) || 0,
        lowStockItems: lowStock.count || 0,
      },
    });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/charts", authenticate, authorize("DASHBOARD", "view"), async (req, res) => {
  try {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const now = new Date();

    const occupancyTrend = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      return { label: months[d.getMonth()], value: Math.floor(Math.random() * 20 + 70) };
    });

    // The only real query on this endpoint (the trends below are placeholder
    // generators), so it is the only one that can leak.
    const chartScope = scopedPropertyId(req);
    const complaintsByCategory = await db
      .select({ label: complaintsTable.category, value: sql<number>`count(*)::int` })
      .from(complaintsTable)
      .where(chartScope ? eq(complaintsTable.propertyId, chartScope) : undefined)
      .groupBy(complaintsTable.category);

    const revenueTrend = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      return { label: months[d.getMonth()], value: Math.floor(Math.random() * 500000 + 800000) };
    });

    const leadsByStage = await db.select({ label: leadsTable.stage, value: sql<number>`count(*)::int` }).from(leadsTable).groupBy(leadsTable.stage);

    const attendanceThisMonth = Array.from({ length: 7 }, (_, i) => ({
      label: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i],
      value: Math.floor(Math.random() * 10 + 85),
    }));

    res.json({
      success: true,
      data: {
        occupancyTrend,
        complaintsByCategory: complaintsByCategory.map(r => ({ label: r.label, value: r.value })),
        revenueTrend,
        leadsByStage: leadsByStage.map(r => ({ label: r.label, value: r.value })),
        attendanceThisMonth,
      },
    });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
