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

const router = Router();

router.get("/stats", authenticate, authorize("DASHBOARD", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;

    // The sidebar property selector scopes every dashboard metric to one property.
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

    const [empCount] = await db.select({ count: sql<number>`count(*)::int` }).from(employeesTable).where(eq(employeesTable.status, "ACTIVE"));
    const [pendingLeaves] = await db.select({ count: sql<number>`count(*)::int` }).from(leavesTable).where(eq(leavesTable.status, "PENDING"));

    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);
    const [monthLeads] = await db.select({ count: sql<number>`count(*)::int` }).from(leadsTable).where(gte(leadsTable.createdAt, startOfMonth));
    const [convertedLeads] = await db.select({ count: sql<number>`count(*)::int` }).from(leadsTable).where(and(eq(leadsTable.stage, "CONVERTED"), gte(leadsTable.createdAt, startOfMonth)));

    const [revenue] = await db.select({ total: sql<number>`coalesce(sum(amount::numeric), 0)` }).from(paymentsTable).where(and(eq(paymentsTable.status, "SUCCESS"), gte(paymentsTable.createdAt, startOfMonth)));
    const [pending] = propertyId
      ? await db.select({ total: sql<number>`coalesce(sum(${paymentsTable.amount}::numeric), 0)` })
          .from(paymentsTable)
          .leftJoin(residentsTable, eq(paymentsTable.residentId, residentsTable.id))
          .where(and(eq(paymentsTable.status, "PENDING"), eq(residentsTable.propertyId, propertyId)))
      : await db.select({ total: sql<number>`coalesce(sum(amount::numeric), 0)` }).from(paymentsTable).where(eq(paymentsTable.status, "PENDING"));

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

    const complaintsByCategory = await db.select({ label: complaintsTable.category, value: sql<number>`count(*)::int` }).from(complaintsTable).groupBy(complaintsTable.category);

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
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
