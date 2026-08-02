import { Router } from "express";
import { db } from "@workspace/db";
import { residentsTable, ledgerEntriesTable, paymentsTable, propertiesTable, roomsTable, notificationOutboxTable } from "@workspace/db";
import { eq, sql, ilike, or, and, inArray, asc } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick, assertPropertyAccess, scopedPropertyId } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";
import {
  isKycGateEnabled,
  residentMeetsActivationRequirements,
  createRentAgreementEsign,
  hasSignedRentAgreement,
} from "./kyc-esign.js";
import {
  createPaymentLink,
  isRazorpayConfigured,
  toPaise,
  RazorpayNotConfiguredError,
} from "../lib/razorpay.js";
import { enqueueDelivery, processDelivery, queueEnabled } from "@workspace/notify-core";

// ─────────────────────────────────────────────────────────────────────────────
// Ad-hoc outbound message helper.
// notification-service.notify() resolves email/phone from a userId, but payment
// links must reach the resident's own phone/email and guardian (parentPhone /
// parentEmail) or an arbitrary contact — none of which are users. We therefore
// enqueue an outbox row directly (userId left null; toAddress set explicitly),
// reusing the same durable outbox + delivery pipeline. Best-effort/non-throwing.
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
    // swallow — a delivery failure must never break the API request
  }
}

/** Compute a resident's current outstanding dues (sum of unpaid ledger amounts). */
async function outstandingDues(residentId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntriesTable.amount}::numeric), 0)` })
    .from(ledgerEntriesTable)
    .where(and(eq(ledgerEntriesTable.residentId, residentId), eq(ledgerEntriesTable.isPaid, false)));
  return Number(row?.total ?? 0);
}

const router = Router();

// Render typed authz errors (e.g. assertPropertyAccess -> 403) with their
// intended status instead of letting the generic catch mask them as 500.
// Returns true if it handled the error.
function sendAuthzError(err: unknown, res: import("express").Response): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (typeof status === "number") {
    const message = (err as { message?: string }).message || "Forbidden";
    res.status(status).json({ success: false, error: message });
    return true;
  }
  return false;
}

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

router.get("/", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const propertyId = req.query["propertyId"] as string | undefined;
    const status = req.query["status"] as string | undefined;

    const conditions = [];
    const scope = scopedPropertyId(req);
    if (scope) conditions.push(eq(residentsTable.propertyId, scope));
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

router.post("/", authenticate, authorize("RESIDENTS", "create"), async (req, res) => {
  try {
    const body = req.body;
    // Property scoping: a scoped caller (WARDEN/UNIT_LEAD) can only create within
    // their own property; org-wide callers must target a property they may access.
    const scope = scopedPropertyId(req);
    if (scope) body.propertyId = scope;
    if (!body.propertyId) { res.status(400).json({ success: false, error: "propertyId is required" }); return; }
    assertPropertyAccess(req, body.propertyId);
    const requestedStatus = body.status || "ACTIVE";
    if (requestedStatus === "ACTIVE" && (await isKycGateEnabled())) {
      res.status(400).json({
        success: false,
        error: "KYC gate is enabled: new residents cannot be created with status ACTIVE. Create with status NOTICE_PERIOD or CHECKED_OUT, then complete KYC + e-sign before activating.",
      });
      return;
    }
    // O25: activation always requires a SIGNED Rent Agreement. A brand-new
    // resident has none yet, so creating directly as ACTIVE is rejected (this
    // gate applies regardless of the KYC-gate toggle).
    if (requestedStatus === "ACTIVE") {
      res.status(400).json({ success: false, error: "A signed rent agreement is required before activation." });
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
    // O26/O25: auto-generate the interim Rent Agreement esign draft so a
    // PENDING agreement always exists for the resident to sign. Best-effort —
    // a generation failure (e.g. missing property data) must not fail the
    // resident create; the draft can be (re)generated via the esign endpoint.
    try {
      await createRentAgreementEsign(row.id, req.user?.id ?? null);
    } catch (e) {
      req.log.error({ err: e }, "Failed to auto-generate rent agreement");
    }
    res.status(201).json({ success: true, data: await enrichResident(row) });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/:id", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(residentsTable).where(eq(residentsTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, row.propertyId);
    res.json({ success: true, data: await enrichResident(row) });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/:id", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const [existing] = await db.select().from(residentsTable).where(eq(residentsTable.id, req.params["id"]!));
    if (!existing) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, existing.propertyId);

    const body = pick(req.body, [
      "name", "email", "phone", "dob", "gender", "college", "course",
      "parentName", "parentPhone", "parentEmail", "dietaryPref", "allergies",
      "checkInDate", "checkOutDate", "planType", "monthlyRent", "securityDeposit",
      "roomId", "status", "propertyId",
    ]);
    // Block a scoped warden from moving a resident into another property: the
    // target propertyId (when changed) must also be within their scope.
    if (body.propertyId !== undefined && body.propertyId !== existing.propertyId) {
      assertPropertyAccess(req, body.propertyId);
    }
    if (body?.status === "ACTIVE") {
      // O25: a SIGNED 'Rent Agreement' is always required to activate.
      if (!(await hasSignedRentAgreement(req.params["id"]!))) {
        res.status(400).json({ success: false, error: "A signed rent agreement is required before activation." });
        return;
      }
      // Existing KYC-gate behavior still applies when the gate is enabled
      // (e.g. requires a VERIFIED KYC on file as well). Both gates apply.
      if (await isKycGateEnabled()) {
        const check = await residentMeetsActivationRequirements(req.params["id"]!);
        if (!check.ok) {
          res.status(400).json({ success: false, error: `Cannot activate resident: ${check.reason}` });
          return;
        }
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
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.delete("/:id", authenticate, authorize("RESIDENTS", "delete"), async (req, res) => {
  try {
    const [existing] = await db.select().from(residentsTable).where(eq(residentsTable.id, req.params["id"]!));
    if (!existing) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, existing.propertyId);
    await db.delete(residentsTable).where(eq(residentsTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Ledger
router.get("/:id/ledger", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, req.params["id"]!));
    if (!resident) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, resident.propertyId);
    const rows = await db.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.residentId, req.params["id"]!)).orderBy(ledgerEntriesTable.createdAt);
    res.json({ success: true, data: rows.map(r => ({ ...r, amount: Number(r.amount) })) });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// POST /residents/:id/ledger
// Two modes:
//   (a) Charge/debit (default): records a normal ledger entry (RENT/UTILITY/…).
//   (b) Collection credit (O24): pass entryType="CREDIT" to record cash physically
//       collected. A CREDIT entry (isPaid=true, collectionDate set) is inserted and
//       the oldest unpaid charges are auto-marked paid up to the collected amount —
//       reducing outstanding. Whole-entry settlement only (no partial split). All
//       in one transaction.
router.post("/:id/ledger", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const residentId = req.params["id"]!;
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, residentId));
    if (!resident) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, resident.propertyId);
    const body = req.body;
    if (body?.amount == null || Number.isNaN(Number(body.amount)) || Number(body.amount) <= 0) {
      res.status(400).json({ success: false, error: "amount is required and must be a positive number" });
      return;
    }

    const isCollection = String(body.entryType ?? "").toUpperCase() === "CREDIT";

    if (isCollection) {
      const collectedAmount = Number(body.amount);
      const collectionDate = body.collectionDate ? new Date(body.collectionDate) : new Date();

      const result = await db.transaction(async (tx) => {
        // Record the collection itself as a paid CREDIT entry. We reuse the
        // ledger `type` enum (default ADJUSTMENT) since there is no credit/debit
        // column; the row is identified as a collection by collectionDate != null.
        const [credit] = await tx.insert(ledgerEntriesTable).values({
          id: newId(),
          residentId,
          type: body.type ?? "ADJUSTMENT",
          amount: collectedAmount.toString(),
          description: body.description ?? `Cash collected ₹${collectedAmount}`,
          isPaid: true,
          paidOn: collectionDate,
          collectionDate,
          reference: body.reference,
          createdBy: req.user?.id,
          updatedAt: new Date(),
        }).returning();

        // Auto-settle: oldest unpaid charges first (by dueDate, then createdAt),
        // whole-entry only, up to the collected amount. Best-effort.
        const unpaid = await tx
          .select()
          .from(ledgerEntriesTable)
          .where(and(eq(ledgerEntriesTable.residentId, residentId), eq(ledgerEntriesTable.isPaid, false)))
          .orderBy(asc(ledgerEntriesTable.dueDate), asc(ledgerEntriesTable.createdAt))
          .for("update");

        let remaining = collectedAmount;
        const settledIds: string[] = [];
        for (const entry of unpaid) {
          const amt = Number(entry.amount);
          if (amt <= 0) continue;
          if (amt > remaining + 0.001) continue; // can't fully cover this one
          await tx.update(ledgerEntriesTable)
            .set({ isPaid: true, paidOn: collectionDate, updatedAt: new Date() })
            .where(and(eq(ledgerEntriesTable.id, entry.id), eq(ledgerEntriesTable.isPaid, false)));
          remaining -= amt;
          settledIds.push(entry.id);
          if (remaining <= 0.001) break;
        }

        return { credit: credit!, settledIds };
      });

      res.status(201).json({
        success: true,
        data: {
          ...result.credit,
          amount: Number(result.credit.amount),
          settledEntryIds: result.settledIds,
          settledCount: result.settledIds.length,
        },
      });
      return;
    }

    // Default: ordinary charge/debit entry (unchanged behavior).
    const [row] = await db.insert(ledgerEntriesTable).values({
      id: newId(),
      residentId,
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
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// POST /residents/:id/payment-link  (O23)
// Create a 7-day Razorpay payment link for the resident's dues and share it via
// SMS/email to the chosen recipients. Body:
//   { amount?: number, recipients?: Array<'resident'|'guardian'|{phone?,email?}> }
// Default amount = current outstanding dues. Default recipient = 'resident'.
// 503 when Razorpay is not configured. Property-scoped.
router.post("/:id/payment-link", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const residentId = req.params["id"]!;
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, residentId));
    if (!resident) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, resident.propertyId);

    if (!isRazorpayConfigured()) {
      res.status(503).json({ success: false, error: "Payments not configured" });
      return;
    }

    const body = req.body || {};
    const amount = body.amount != null ? Number(body.amount) : await outstandingDues(residentId);
    if (!amount || Number.isNaN(amount) || amount <= 0) {
      res.status(400).json({ success: false, error: "No outstanding dues to collect (or amount invalid)" });
      return;
    }

    // Resolve recipients to concrete phone/email targets.
    const requested: Array<"resident" | "guardian" | { phone?: string; email?: string }> =
      Array.isArray(body.recipients) && body.recipients.length ? body.recipients : ["resident"];
    const targets: Array<{ phone?: string | null; email?: string | null }> = [];
    for (const r of requested) {
      if (r === "resident") targets.push({ phone: resident.phone, email: resident.email });
      else if (r === "guardian") targets.push({ phone: resident.parentPhone, email: resident.parentEmail });
      else if (r && typeof r === "object") targets.push({ phone: r.phone, email: r.email });
    }

    const link = await createPaymentLink({
      amountPaise: toPaise(amount),
      description: `Dues payment — ${resident.name}`,
      customer: { name: resident.name, contact: resident.phone, email: resident.email },
      expireBySeconds: 7 * 24 * 60 * 60, // 7 days
      notes: { kind: "RESIDENT_DUES", residentId, propertyId: resident.propertyId },
    });

    const smsText = `Hi, pay your dues of ₹${amount} for ${resident.name}: ${link.shortUrl} (valid 7 days)`;
    const emailText = `Dear ${resident.name},\n\nPlease pay your outstanding dues of ₹${amount} using the secure link below (valid 7 days):\n\n${link.shortUrl}\n\nThank you.`;
    for (const t of targets) {
      if (t.phone) await sendAdHoc("SMS", t.phone, smsText, { entityType: "PAYMENT_LINK", entityId: link.id });
      if (t.email) await sendAdHoc("EMAIL", t.email, emailText, { subject: "Payment link for your dues", entityType: "PAYMENT_LINK", entityId: link.id });
    }

    res.status(201).json({ success: true, data: { shortUrl: link.shortUrl, id: link.id } });
  } catch (err) {
    if (err instanceof RazorpayNotConfiguredError) {
      res.status(503).json({ success: false, error: "Payments not configured" });
      return;
    }
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Payments
router.get("/:id/payments", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, req.params["id"]!));
    if (!resident) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, resident.propertyId);
    const rows = await db.select().from(paymentsTable).where(eq(paymentsTable.residentId, req.params["id"]!)).orderBy(paymentsTable.createdAt);
    res.json({ success: true, data: rows.map(r => ({ ...r, amount: Number(r.amount) })) });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/:id/payments", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, req.params["id"]!));
    if (!resident) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, resident.propertyId);
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
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Check-out resident
router.post("/:id/checkout", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const { checkoutDate, reason, deductions, refundAmount, keyReturned, roomConditionNote } = req.body;
    const residentId = req.params["id"]!;
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, residentId));
    if (!resident) { res.status(404).json({ success: false, error: "Not found" }); return; }
    assertPropertyAccess(req, resident.propertyId);

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
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Bulk rent charge for a property + month
router.post("/bulk-rent", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const { propertyId, month, year } = req.body;
    if (!propertyId || month == null || year == null) {
      res.status(400).json({ success: false, error: "propertyId, month, year required" });
      return;
    }
    assertPropertyAccess(req, propertyId);
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
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
