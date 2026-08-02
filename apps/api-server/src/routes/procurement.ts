import { Router } from "express";
import { db } from "@workspace/db";
import {
  vendorsTable, indentsTable, purchaseOrdersTable, grnTable, inventoryTable,
  rateContractsTable, vendorDocumentsTable, stockMovementsTable, complaintsTable,
} from "@workspace/db";
import { eq, sql, ilike, and, desc, lte, gte, lt } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";

const VENDOR_FIELDS = ["name", "gstin", "pan", "phone", "email", "address", "categories", "bankAccount", "ifscCode", "rating", "status"] as const;
const RATE_CONTRACT_FIELDS = ["itemName", "unit", "rate", "validFrom", "validTo", "notes"] as const;

const num = (v: unknown) => v === null || v === undefined || v === "" ? null : Number(v);

// =================== PROCUREMENT (shared) ===================
export const procurementRouter = Router();

// Distinct, non-empty, alphabetically-sorted item names used across procurement,
// for powering creatable item-name comboboxes in indent/PO forms.
// Line items live in JSON `items` arrays on indents/purchase_orders (each entry has
// an `itemName` key); rate_contracts has a real `item_name` text column. UNION all.
procurementRouter.get("/item-suggestions", authenticate, authorize("INVENTORY", "view"), async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT DISTINCT name FROM (
        SELECT TRIM(elem->>'itemName') AS name
          FROM ${indentsTable}, json_array_elements(${indentsTable.items}) AS elem
        UNION
        SELECT TRIM(elem->>'itemName') AS name
          FROM ${purchaseOrdersTable}, json_array_elements(${purchaseOrdersTable.items}) AS elem
        UNION
        SELECT TRIM(${rateContractsTable.itemName}) AS name FROM ${rateContractsTable}
      ) AS names
      WHERE name IS NOT NULL AND name <> ''
      ORDER BY name ASC
    `);
    const data = (result.rows as Array<{ name: string }>).map((r) => r.name);
    res.json({ success: true, data });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// =================== VENDORS ===================
export const vendorRouter = Router();

vendorRouter.get("/", authenticate, authorize("VENDORS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const status = req.query["status"] as string | undefined;
    const category = req.query["category"] as string | undefined;
    const conditions = [];
    if (search) conditions.push(ilike(vendorsTable.name, `%${search}%`));
    if (status) conditions.push(eq(vendorsTable.status, status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(vendorsTable).where(where);
    let rows = await db.select().from(vendorsTable).where(where).limit(limit).offset(offset).orderBy(desc(vendorsTable.createdAt));
    if (category) rows = rows.filter(r => (r.categories as string[]).includes(category));
    // Active POs count per vendor
    const enriched = await Promise.all(rows.map(async (r) => {
      const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(purchaseOrdersTable).where(and(
        eq(purchaseOrdersTable.vendorId, r.id),
        sql`${purchaseOrdersTable.status} IN ('SENT','ACKNOWLEDGED','PARTIAL_DELIVERY')`,
      ));
      return { ...r, activePOs: c?.count || 0 };
    }));
    res.json({ success: true, data: enriched, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

vendorRouter.post("/", authenticate, authorize("VENDORS", "create"), async (req, res) => {
  try {
    const data = pick(req.body, VENDOR_FIELDS);
    const [row] = await db.insert(vendorsTable).values({ id: newId(), ...data, categories: req.body.categories || [], updatedAt: new Date() } as typeof vendorsTable.$inferInsert).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

vendorRouter.get("/:id", authenticate, authorize("VENDORS", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

vendorRouter.put("/:id", authenticate, authorize("VENDORS", "edit"), async (req, res) => {
  try {
    const data = pick(req.body, VENDOR_FIELDS);
    const [row] = await db.update(vendorsTable).set({ ...data, updatedAt: new Date() }).where(eq(vendorsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Vendor Rate Contracts
vendorRouter.get("/:id/rate-contracts", authenticate, authorize("VENDORS", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(rateContractsTable).where(eq(rateContractsTable.vendorId, req.params["id"]!)).orderBy(desc(rateContractsTable.createdAt));
    res.json({ success: true, data: rows.map(r => ({ ...r, rate: Number(r.rate) })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

vendorRouter.post("/:id/rate-contracts", authenticate, authorize("VENDORS", "edit"), async (req, res) => {
  try {
    const b = req.body;
    const [row] = await db.insert(rateContractsTable).values({
      id: newId(), vendorId: req.params["id"]!, itemName: b.itemName, unit: b.unit,
      rate: String(b.rate), validFrom: new Date(b.validFrom), validTo: new Date(b.validTo), notes: b.notes,
    }).returning();
    res.status(201).json({ success: true, data: { ...row, rate: Number(row.rate) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

vendorRouter.put("/rate-contracts/:rcId", authenticate, authorize("VENDORS", "edit"), async (req, res) => {
  try {
    // Allow-list writable columns only (block mass-assignment of id/vendorId/createdAt).
    const b = pick(req.body, RATE_CONTRACT_FIELDS);
    if (b.rate !== undefined) b.rate = String(b.rate);
    if (b.validFrom) b.validFrom = new Date(b.validFrom);
    if (b.validTo) b.validTo = new Date(b.validTo);
    const [row] = await db.update(rateContractsTable).set(b).where(eq(rateContractsTable.id, req.params["rcId"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, rate: Number(row.rate) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

vendorRouter.delete("/rate-contracts/:rcId", authenticate, authorize("VENDORS", "delete"), async (req, res) => {
  try {
    await db.delete(rateContractsTable).where(eq(rateContractsTable.id, req.params["rcId"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Vendor Documents
vendorRouter.get("/:id/documents", authenticate, authorize("VENDORS", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(vendorDocumentsTable).where(eq(vendorDocumentsTable.vendorId, req.params["id"]!));
    const now = new Date();
    const enriched = rows.map(r => {
      let expiringSoon = false;
      if (r.expiryDate) {
        const daysLeft = Math.floor((new Date(r.expiryDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        expiringSoon = daysLeft >= 0 && daysLeft <= 30;
      }
      return { ...r, expiringSoon };
    });
    res.json({ success: true, data: enriched });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

vendorRouter.post("/:id/documents", authenticate, authorize("VENDORS", "edit"), async (req, res) => {
  try {
    const b = req.body;
    const [row] = await db.insert(vendorDocumentsTable).values({
      id: newId(), vendorId: req.params["id"]!, docType: b.docType, fileUrl: b.fileUrl,
      expiryDate: b.expiryDate ? new Date(b.expiryDate) : null, notes: b.notes,
    }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

vendorRouter.delete("/documents/:docId", authenticate, authorize("VENDORS", "delete"), async (req, res) => {
  try {
    await db.delete(vendorDocumentsTable).where(eq(vendorDocumentsTable.id, req.params["docId"]!));
    res.json({ success: true });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Vendor performance metrics — derived from POs/GRNs
vendorRouter.get("/:id/performance", authenticate, authorize("VENDORS", "view"), async (req, res) => {
  try {
    const vendorId = req.params["id"]!;
    // Last 4 quarters
    const now = new Date();
    const quarters: Array<{ label: string; deliveryAccuracy: number; qualityScore: number; complaints: number }> = [];
    for (let i = 3; i >= 0; i--) {
      const qStart = new Date(now.getFullYear(), now.getMonth() - 3 * i - 2, 1);
      const qEnd = new Date(now.getFullYear(), now.getMonth() - 3 * i + 1, 0, 23, 59, 59);
      const pos = await db.select().from(purchaseOrdersTable).where(and(
        eq(purchaseOrdersTable.vendorId, vendorId),
        gte(purchaseOrdersTable.createdAt, qStart),
        lte(purchaseOrdersTable.createdAt, qEnd),
      ));
      const delivered = pos.filter(p => p.status === "DELIVERED").length;
      const total = pos.length;
      // Quality: average qcPass across GRNs for these POs
      let qualityScore = 100;
      if (pos.length > 0) {
        const grns = await db.select().from(grnTable).where(sql`${grnTable.poId} IN (${sql.join(pos.map(p => sql`${p.id}`), sql`, `)})`);
        if (grns.length > 0) qualityScore = Math.round((grns.filter(g => g.qcPass).length / grns.length) * 100);
      }
      // Complaints in this quarter linked to vendor's GRNs (subCategory = VENDOR_QUALITY + GRN number in title)
      let complaintsCount = 0;
      if (pos.length > 0) {
        const grns = await db.select({ grnNumber: grnTable.grnNumber }).from(grnTable).where(sql`${grnTable.poId} IN (${sql.join(pos.map(p => sql`${p.id}`), sql`, `)})`);
        if (grns.length > 0) {
          const grnNumbers = grns.map(g => g.grnNumber);
          const cs = await db.select({ title: complaintsTable.title }).from(complaintsTable).where(and(
            gte(complaintsTable.createdAt, qStart),
            lte(complaintsTable.createdAt, qEnd),
            sql`${complaintsTable.subCategory} = 'VENDOR_QUALITY'`,
          ));
          complaintsCount = cs.filter(c => grnNumbers.some(g => c.title.includes(g))).length;
        }
      }
      const qLabel = `Q${Math.floor(qStart.getMonth() / 3) + 1} ${qStart.getFullYear()}`;
      quarters.push({
        label: qLabel,
        deliveryAccuracy: total > 0 ? Math.round((delivered / total) * 100) : 0,
        qualityScore,
        complaints: complaintsCount,
      });
    }
    res.json({ success: true, data: quarters });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Vendor POs list (for detail page)
vendorRouter.get("/:id/purchase-orders", authenticate, authorize("VENDORS", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.vendorId, req.params["id"]!)).orderBy(desc(purchaseOrdersTable.createdAt));
    res.json({ success: true, data: rows.map(r => ({ ...r, totalAmount: Number(r.totalAmount), subtotal: Number(r.subtotal), gstAmount: Number(r.gstAmount) })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// =================== INDENTS ===================
export const indentRouter = Router();

type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
const nextIndentNumber = async (d: DbLike = db): Promise<string> => {
  const [row] = await d.select({ max: sql<string>`MAX(${indentsTable.indentNumber})` }).from(indentsTable);
  const next = row?.max ? parseInt(row.max.replace(/\D/g, ""), 10) + 1 : 1001;
  return `IND-${String(next).padStart(5, "0")}`;
};

indentRouter.get("/", authenticate, authorize("INDENTS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const department = req.query["department"] as string | undefined;
    const status = req.query["status"] as string | undefined;
    const conditions = [];
    if (propertyId) conditions.push(eq(indentsTable.propertyId, propertyId));
    if (department) conditions.push(eq(indentsTable.department, department));
    if (status) conditions.push(eq(indentsTable.status, status as any));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(indentsTable).where(where);
    const rows = await db.select().from(indentsTable).where(where).limit(limit).offset(offset).orderBy(desc(indentsTable.createdAt));
    res.json({
      success: true,
      data: rows.map(r => ({ ...r, totalEstimatedValue: Number(r.totalEstimatedValue) })),
      meta: buildMeta(countResult.count, page, limit),
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

indentRouter.get("/:id", authenticate, authorize("INDENTS", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(indentsTable).where(eq(indentsTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, totalEstimatedValue: Number(row.totalEstimatedValue) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

indentRouter.post("/", authenticate, authorize("INDENTS", "create"), async (req, res) => {
  try {
    const b = req.body;
    const items = (b.items || []) as Array<Record<string, unknown>>;
    const total = items.reduce((s, it) => s + (Number(it["quantity"]) || 0) * (Number(it["estUnitPrice"]) || 0), 0);
    const status = b.status || "DRAFT";
    const row = await withUniqueRetry(async () => {
      const [r] = await db.insert(indentsTable).values({
        id: newId(),
        indentNumber: await nextIndentNumber(),
        propertyId: b.propertyId,
        department: b.department,
        items,
        totalEstimatedValue: String(total),
        urgency: b.urgency || "NORMAL",
        purpose: b.purpose,
        budgetHead: b.budgetHead,
        status,
        submittedAt: status === "SUBMITTED" ? new Date() : null,
        createdBy: req.user!.id,
        updatedAt: new Date(),
      }).returning();
      return r;
    });
    res.status(201).json({ success: true, data: { ...row, totalEstimatedValue: Number(row.totalEstimatedValue) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

indentRouter.put("/:id", authenticate, authorize("INDENTS", "edit"), async (req, res) => {
  try {
    const b = { ...req.body };
    if (b.items) {
      const items = b.items as Array<Record<string, unknown>>;
      b.totalEstimatedValue = String(items.reduce((s, it) => s + (Number(it["quantity"]) || 0) * (Number(it["estUnitPrice"]) || 0), 0));
    }
    if (b.status === "SUBMITTED") b.submittedAt = new Date();
    const [row] = await db.update(indentsTable).set({ ...b, updatedAt: new Date() }).where(eq(indentsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, totalEstimatedValue: Number(row.totalEstimatedValue) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

indentRouter.post("/:id/approve", authenticate, authorize("INDENTS", "edit"), async (req, res) => {
  try {
    const [row] = await db.update(indentsTable).set({
      status: "APPROVED", approvedBy: req.user!.id, approvedAt: new Date(), updatedAt: new Date(),
    }).where(eq(indentsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, totalEstimatedValue: Number(row.totalEstimatedValue) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

indentRouter.post("/:id/reject", authenticate, authorize("INDENTS", "edit"), async (req, res) => {
  try {
    const reason = req.body?.reason || "";
    if (!reason) { res.status(400).json({ success: false, error: "reason required" }); return; }
    const [row] = await db.update(indentsTable).set({
      status: "REJECTED", rejectionReason: reason, updatedAt: new Date(),
    }).where(eq(indentsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, totalEstimatedValue: Number(row.totalEstimatedValue) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// =================== PURCHASE ORDERS ===================
export const poRouter = Router();

const nextPoNumber = async (d: DbLike = db): Promise<string> => {
  const [row] = await d.select({ max: sql<string>`MAX(${purchaseOrdersTable.poNumber})` }).from(purchaseOrdersTable);
  const next = row?.max ? parseInt(row.max.replace(/\D/g, ""), 10) + 1 : 1001;
  const today = new Date();
  const yyyymmdd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  return `PO-${yyyymmdd}-${String(next).padStart(3, "0")}`;
};

poRouter.get("/", authenticate, authorize("PURCHASE_ORDERS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const status = req.query["status"] as string | undefined;
    const vendorId = req.query["vendorId"] as string | undefined;
    const conditions = [];
    if (status) conditions.push(eq(purchaseOrdersTable.status, status as any));
    if (vendorId) conditions.push(eq(purchaseOrdersTable.vendorId, vendorId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(purchaseOrdersTable).where(where);
    const rows = await db.select().from(purchaseOrdersTable).where(where).limit(limit).offset(offset).orderBy(desc(purchaseOrdersTable.createdAt));
    const enriched = await Promise.all(rows.map(async (r) => {
      const [v] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, r.vendorId));
      return {
        ...r,
        totalAmount: Number(r.totalAmount), subtotal: Number(r.subtotal), gstAmount: Number(r.gstAmount),
        vendorName: v?.name || null, vendorEmail: v?.email || null, vendorPhone: v?.phone || null,
        vendorGstin: v?.gstin || null, vendorAddress: v?.address || null,
      };
    }));
    res.json({ success: true, data: enriched, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

poRouter.get("/:id", authenticate, authorize("PURCHASE_ORDERS", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [v] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId));
    const grns = await db.select().from(grnTable).where(eq(grnTable.poId, row.id)).orderBy(desc(grnTable.createdAt));
    res.json({
      success: true,
      data: {
        ...row,
        totalAmount: Number(row.totalAmount), subtotal: Number(row.subtotal), gstAmount: Number(row.gstAmount),
        vendor: v || null,
        grns,
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

poRouter.post("/", authenticate, authorize("PURCHASE_ORDERS", "create"), async (req, res) => {
  try {
    const b = req.body;
    const items = (b.items || []) as Array<Record<string, unknown>>;
    const subtotal = items.reduce((s, it) => s + (Number(it["quantity"]) || 0) * (Number(it["rate"]) || 0), 0);
    const gstApplicable = !!b.gstApplicable;
    const gstAmount = gstApplicable ? subtotal * 0.18 : 0;
    const total = subtotal + gstAmount;
    const row = await withUniqueRetry(async () => {
      const [r] = await db.insert(purchaseOrdersTable).values({
      id: newId(),
      poNumber: await nextPoNumber(),
      vendorId: b.vendorId,
      propertyId: b.propertyId,
      indentId: b.indentId,
      items,
      subtotal: String(subtotal),
      gstApplicable,
      gstAmount: String(gstAmount),
      totalAmount: String(total),
      paymentTerms: b.paymentTerms,
      status: b.status || "DRAFT",
      deliveryDate: b.deliveryDate ? new Date(b.deliveryDate) : null,
      notes: b.notes,
      updatedAt: new Date(),
    }).returning();
      return r;
    });
    // If created from indent, mark indent as PO_RAISED
    if (b.indentId) {
      await db.update(indentsTable).set({ status: "PO_RAISED", poId: row.id, updatedAt: new Date() }).where(eq(indentsTable.id, b.indentId));
    }
    const [v] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId));
    res.status(201).json({
      success: true,
      data: {
        ...row, totalAmount: Number(row.totalAmount), subtotal: Number(row.subtotal), gstAmount: Number(row.gstAmount),
        vendorName: v?.name || null,
      },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

poRouter.put("/:id", authenticate, authorize("PURCHASE_ORDERS", "edit"), async (req, res) => {
  try {
    const b = { ...req.body };
    if (b.items) {
      const items = b.items as Array<Record<string, unknown>>;
      const subtotal = items.reduce((s, it) => s + (Number(it["quantity"]) || 0) * (Number(it["rate"]) || 0), 0);
      const gstApplicable = !!b.gstApplicable;
      b.subtotal = String(subtotal);
      b.gstAmount = String(gstApplicable ? subtotal * 0.18 : 0);
      b.totalAmount = String(subtotal + (gstApplicable ? subtotal * 0.18 : 0));
    }
    if (b.deliveryDate) b.deliveryDate = new Date(b.deliveryDate);
    const [row] = await db.update(purchaseOrdersTable).set({ ...b, updatedAt: new Date() }).where(eq(purchaseOrdersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, totalAmount: Number(row.totalAmount), subtotal: Number(row.subtotal), gstAmount: Number(row.gstAmount) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

poRouter.post("/:id/send", authenticate, authorize("PURCHASE_ORDERS", "edit"), async (req, res) => {
  try {
    const [row] = await db.update(purchaseOrdersTable).set({
      status: "SENT", sentAt: new Date(), updatedAt: new Date(),
    }).where(eq(purchaseOrdersTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { ...row, totalAmount: Number(row.totalAmount), subtotal: Number(row.subtotal), gstAmount: Number(row.gstAmount) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// =================== GRN ===================
export const grnRouter = Router();

const nextGrnNumber = async (d: DbLike = db): Promise<string> => {
  const [row] = await d.select({ max: sql<string>`MAX(${grnTable.grnNumber})` }).from(grnTable);
  const next = row?.max ? parseInt(row.max.replace(/\D/g, ""), 10) + 1 : 1001;
  return `GRN-${String(next).padStart(5, "0")}`;
};

grnRouter.get("/", authenticate, authorize("GRN", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const propertyId = req.query["propertyId"] as string | undefined;
    const where = propertyId ? eq(grnTable.propertyId, propertyId) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(grnTable).where(where);
    const rows = await db.select().from(grnTable).where(where).limit(limit).offset(offset).orderBy(desc(grnTable.createdAt));
    const enriched = await Promise.all(rows.map(async (r) => {
      const [po] = await db.select({ poNumber: purchaseOrdersTable.poNumber, vendorId: purchaseOrdersTable.vendorId }).from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, r.poId));
      let vendorName: string | null = null;
      if (po?.vendorId) {
        const [v] = await db.select({ name: vendorsTable.name }).from(vendorsTable).where(eq(vendorsTable.id, po.vendorId));
        vendorName = v?.name || null;
      }
      return { ...r, poNumber: po?.poNumber || null, vendorName };
    }));
    res.json({ success: true, data: enriched, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// Retry helper for unique-constraint races on auto-generated numbers
async function withUniqueRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      if (e?.code !== "23505") throw e; // not a unique violation
      // brief jitter then retry
      await new Promise(r => setTimeout(r, 10 + Math.floor(Math.random() * 30)));
    }
  }
  throw lastErr;
}

grnRouter.post("/", authenticate, authorize("GRN", "create"), async (req, res) => {
  try {
    const b = req.body;
    if (!b.poId) { res.status(400).json({ success: false, error: "poId required" }); return; }
    const items = (b.items || []) as Array<Record<string, unknown>>;
    const userId = req.user!.id;

    // Atomic GRN flow: insert GRN, upsert inventory with SQL increment, write stock movements,
    // advance PO status — all inside a single transaction.
    const result = await withUniqueRetry(() => db.transaction(async (tx) => {
      const [po] = await tx.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, b.poId)).for("update");
      if (!po) throw Object.assign(new Error("PO not found"), { httpStatus: 404 });

      const grnNumber = await nextGrnNumber(tx);
      const [row] = await tx.insert(grnTable).values({
        id: newId(),
        grnNumber,
        poId: b.poId,
        propertyId: b.propertyId || po.propertyId || "",
        items,
        invoiceNumber: b.invoiceNumber,
        invoicePhotoUrl: b.invoicePhotoUrl,
        qcPass: b.qcPass !== false,
        qcNotes: b.qcNotes,
        status: "RECEIVED",
        photos: b.photos || [],
        receivedBy: userId,
        updatedAt: new Date(),
      }).returning();

      let anyDamage = false;
      let anyShort = false;
      const damageNotes: string[] = [];

      for (const it of items) {
        const qty = Number(it["qtyReceived"]) || 0;
        const condition = String(it["condition"] || "GOOD").toUpperCase();
        const itemName = String(it["itemName"] || "");
        const unit = String(it["unit"] || "");
        const inventoryId = it["inventoryId"] as string | undefined;
        if (condition === "DAMAGED") { anyDamage = true; damageNotes.push(`${itemName}: ${it["damageNotes"] || "damaged"}`); }
        if (condition === "SHORT" || (Number(it["qtyOrdered"]) || 0) > qty) anyShort = true;
        if (qty <= 0) continue;

        // Find existing inventory row (lock it FOR UPDATE so concurrent GRN/consume can't race).
        let inv: typeof inventoryTable.$inferSelect | undefined;
        if (inventoryId) {
          const [found] = await tx.select().from(inventoryTable).where(eq(inventoryTable.id, inventoryId)).for("update");
          inv = found;
        }
        if (!inv && itemName) {
          const conds = [eq(inventoryTable.name, itemName)];
          if (po.propertyId) conds.push(eq(inventoryTable.propertyId, po.propertyId));
          const [found] = await tx.select().from(inventoryTable).where(and(...conds)).for("update");
          inv = found;
        }
        if (!inv) {
          const [created] = await tx.insert(inventoryTable).values({
            id: newId(),
            propertyId: po.propertyId,
            name: itemName,
            category: String(it["category"] || "Other"),
            unit,
            currentStock: String(qty),
            minStock: "0",
            unitCost: it["rate"] ? String(it["rate"]) : null,
            updatedAt: new Date(),
          }).returning();
          inv = created;
        } else {
          // Atomic SQL increment
          await tx.update(inventoryTable).set({
            currentStock: sql`${inventoryTable.currentStock} + ${qty}`,
            updatedAt: new Date(),
          }).where(eq(inventoryTable.id, inv.id));
        }
        await tx.insert(stockMovementsTable).values({
          id: newId(),
          inventoryId: inv.id,
          type: "IN",
          quantity: String(qty),
          reference: row.grnNumber,
          notes: `Received via GRN ${row.grnNumber}`,
          createdBy: userId,
        });
      }

      const allFull = items.every(it => (Number(it["qtyReceived"]) || 0) >= (Number(it["qtyOrdered"]) || 0));
      await tx.update(purchaseOrdersTable).set({
        status: allFull ? "DELIVERED" : "PARTIAL_DELIVERY",
        grnId: row.id,
        updatedAt: new Date(),
      }).where(eq(purchaseOrdersTable.id, po.id));

      return { row, po, anyDamage, anyShort, damageNotes };
    }));

    // Side effect (non-critical): vendor complaint auto-create on damage/short — outside the tx
    // so a complaint failure can't roll back the GRN.
    if ((result.anyDamage || result.anyShort) && result.po.propertyId) {
      try {
        const [vendor] = await db.select({ name: vendorsTable.name }).from(vendorsTable).where(eq(vendorsTable.id, result.po.vendorId));
        await db.insert(complaintsTable).values({
          id: newId(),
          ticketNo: `VC-${Date.now().toString().slice(-6)}`,
          propertyId: result.po.propertyId,
          category: "OTHER",
          subCategory: "VENDOR_QUALITY",
          title: `Vendor issue: GRN ${result.row.grnNumber} (${vendor?.name || "vendor"})`,
          description: `Issues found during GRN ${result.row.grnNumber} for PO ${result.po.poNumber}: ${result.damageNotes.join("; ") || "Short delivery"}`,
          priority: "MEDIUM",
          status: "OPEN",
          updatedAt: new Date(),
        });
      } catch (e) { req.log.warn({ err: e }, "Could not auto-create vendor complaint"); }
    }

    res.status(201).json({ success: true, data: result.row });
  } catch (err: any) {
    if (err?.httpStatus === 404) { res.status(404).json({ success: false, error: err.message }); return; }
    req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" });
  }
});

grnRouter.get("/:id", authenticate, authorize("GRN", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(grnTable).where(eq(grnTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [po] = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, row.poId));
    let poEnriched: Record<string, unknown> | null = null;
    if (po) {
      const [v] = await db.select({ name: vendorsTable.name }).from(vendorsTable).where(eq(vendorsTable.id, po.vendorId));
      poEnriched = { ...po, totalAmount: Number(po.totalAmount), vendorName: v?.name || null };
    }
    res.json({ success: true, data: { ...row, po: poEnriched } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// =================== INVENTORY ===================
export const inventoryRouter = Router();

const computeStatus = (item: typeof inventoryTable.$inferSelect): string => {
  const cs = Number(item.currentStock);
  const ms = Number(item.minStock);
  if (cs <= 0) return "OUT_OF_STOCK";
  if (cs <= ms) return "LOW_STOCK";
  if (item.expiryDate) {
    const days = Math.floor((new Date(item.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (days < 0) return "EXPIRED";
    if (days <= 7) return "EXPIRING_SOON";
  }
  return "OK";
};

inventoryRouter.get("/", authenticate, authorize("INVENTORY", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const category = req.query["category"] as string | undefined;
    const statusFilter = req.query["status"] as string | undefined;
    const conditions = [];
    if (propertyId) conditions.push(eq(inventoryTable.propertyId, propertyId));
    if (category) conditions.push(eq(inventoryTable.category, category));
    if (search) conditions.push(ilike(inventoryTable.name, `%${search}%`));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(inventoryTable).where(where);
    const rows = await db.select().from(inventoryTable).where(where).limit(limit).offset(offset).orderBy(desc(inventoryTable.createdAt));
    let mapped = rows.map(r => ({
      ...r,
      currentStock: Number(r.currentStock), minStock: Number(r.minStock),
      unitCost: num(r.unitCost),
      isLowStock: Number(r.currentStock) <= Number(r.minStock),
      stockStatus: computeStatus(r),
    }));
    if (statusFilter) mapped = mapped.filter(r => r.stockStatus === statusFilter);
    res.json({ success: true, data: mapped, meta: buildMeta(countResult.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

inventoryRouter.get("/stats", authenticate, authorize("INVENTORY", "view"), async (req, res) => {
  try {
    const all = await db.select().from(inventoryTable);
    const totalSkus = all.length;
    let lowStock = 0, outOfStock = 0, expiringSoon = 0;
    for (const r of all) {
      const s = computeStatus(r);
      if (s === "OUT_OF_STOCK") outOfStock++;
      else if (s === "LOW_STOCK") lowStock++;
      if (s === "EXPIRING_SOON") expiringSoon++;
    }
    res.json({ success: true, data: { totalSkus, lowStock, outOfStock, expiringSoon } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

inventoryRouter.get("/alerts", authenticate, authorize("INVENTORY", "view"), async (req, res) => {
  try {
    const all = await db.select().from(inventoryTable);
    const lowStock = all.filter(r => Number(r.currentStock) <= Number(r.minStock));
    const sevenDays = new Date(); sevenDays.setDate(sevenDays.getDate() + 7);
    const expiring = all.filter(r => r.expiryDate && new Date(r.expiryDate) <= sevenDays && new Date(r.expiryDate) >= new Date());
    const fmt = (r: typeof inventoryTable.$inferSelect) => ({
      ...r, currentStock: Number(r.currentStock), minStock: Number(r.minStock), unitCost: num(r.unitCost),
    });
    res.json({ success: true, data: { lowStock: lowStock.map(fmt), expiring: expiring.map(fmt) } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

inventoryRouter.get("/:id", authenticate, authorize("INVENTORY", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(inventoryTable).where(eq(inventoryTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({
      success: true,
      data: { ...row, currentStock: Number(row.currentStock), minStock: Number(row.minStock), unitCost: num(row.unitCost), stockStatus: computeStatus(row) },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

inventoryRouter.post("/", authenticate, authorize("INVENTORY", "create"), async (req, res) => {
  try {
    const b = req.body;
    const [row] = await db.insert(inventoryTable).values({
      id: newId(),
      propertyId: b.propertyId,
      name: b.name,
      sku: b.sku,
      category: b.category,
      unit: b.unit,
      currentStock: b.currentStock !== undefined ? String(b.currentStock) : "0",
      minStock: b.minStock !== undefined ? String(b.minStock) : "0",
      expiryDate: b.expiryDate ? new Date(b.expiryDate) : null,
      unitCost: b.unitCost !== undefined ? String(b.unitCost) : null,
      location: b.location,
      isAsset: !!b.isAsset,
      assetTag: b.assetTag,
      condition: b.condition,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({
      success: true,
      data: { ...row, currentStock: Number(row.currentStock), minStock: Number(row.minStock), unitCost: num(row.unitCost), stockStatus: computeStatus(row) },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

inventoryRouter.put("/:id", authenticate, authorize("INVENTORY", "edit"), async (req, res) => {
  try {
    const b = { ...req.body };
    if (b.currentStock !== undefined) b.currentStock = String(b.currentStock);
    if (b.minStock !== undefined) b.minStock = String(b.minStock);
    if (b.unitCost !== undefined) b.unitCost = b.unitCost === null ? null : String(b.unitCost);
    if (b.expiryDate) b.expiryDate = new Date(b.expiryDate);
    const [row] = await db.update(inventoryTable).set({ ...b, updatedAt: new Date() }).where(eq(inventoryTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({
      success: true,
      data: { ...row, currentStock: Number(row.currentStock), minStock: Number(row.minStock), unitCost: num(row.unitCost), stockStatus: computeStatus(row) },
    });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

inventoryRouter.get("/:id/movements", authenticate, authorize("INVENTORY", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(stockMovementsTable).where(eq(stockMovementsTable.inventoryId, req.params["id"]!)).orderBy(desc(stockMovementsTable.createdAt));
    res.json({ success: true, data: rows.map(r => ({ ...r, quantity: Number(r.quantity) })) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

inventoryRouter.post("/:id/consume", authenticate, authorize("INVENTORY", "edit"), async (req, res) => {
  try {
    const b = req.body;
    const qty = Number(b.quantity);
    if (!qty || qty <= 0) { res.status(400).json({ success: false, error: "quantity required" }); return; }
    const id = req.params["id"]!;
    const userId = req.user!.id;
    const result = await db.transaction(async (tx) => {
      const [inv] = await tx.select().from(inventoryTable).where(eq(inventoryTable.id, id)).for("update");
      if (!inv) return null;
      const actualOut = Math.min(qty, Number(inv.currentStock));
      // Atomic decrement clamped at zero
      await tx.update(inventoryTable).set({
        currentStock: sql`GREATEST(${inventoryTable.currentStock} - ${qty}, 0)`,
        updatedAt: new Date(),
      }).where(eq(inventoryTable.id, inv.id));
      const [mv] = await tx.insert(stockMovementsTable).values({
        id: newId(), inventoryId: inv.id, type: "OUT", quantity: String(actualOut),
        reference: b.purpose || "Consumption", notes: b.notes, createdBy: userId,
      }).returning();
      const newStock = Math.max(0, Number(inv.currentStock) - qty);
      return { mv, newStock };
    });
    if (!result) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.status(201).json({ success: true, data: { ...result.mv, quantity: Number(result.mv.quantity), newStock: result.newStock } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

inventoryRouter.post("/:id/audit", authenticate, authorize("INVENTORY", "edit"), async (req, res) => {
  try {
    const physical = Number(req.body?.physicalCount);
    if (Number.isNaN(physical)) { res.status(400).json({ success: false, error: "physicalCount required" }); return; }
    const id = req.params["id"]!;
    const userId = req.user!.id;
    const result = await db.transaction(async (tx) => {
      const [inv] = await tx.select().from(inventoryTable).where(eq(inventoryTable.id, id)).for("update");
      if (!inv) return null;
      const variance = physical - Number(inv.currentStock);
      await tx.update(inventoryTable).set({ currentStock: String(physical), updatedAt: new Date() }).where(eq(inventoryTable.id, inv.id));
      await tx.insert(stockMovementsTable).values({
        id: newId(), inventoryId: inv.id, type: "ADJUSTMENT", quantity: String(variance),
        reference: "Stock Audit", notes: req.body?.notes || `Variance: ${variance}`, createdBy: userId,
      });
      return { variance };
    });
    if (!result) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: { variance: result.variance, newStock: physical } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// silence unused import warnings on `lt`
void lt;
