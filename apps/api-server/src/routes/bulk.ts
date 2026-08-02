import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { residentsTable, usersTable, roomsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { assertCanAssignRole, assertPropertyAccess, scopedPropertyId } from "../lib/authz.js";
import { newId } from "../lib/id.js";
import { isKycGateEnabled } from "./kyc-esign.js";

const router = Router();

/** Render typed authz errors (e.g. assertPropertyAccess -> 403) with their
 *  intended status instead of letting the generic catch mask them as 500. */
function sendAuthzError(err: unknown, res: import("express").Response): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (typeof status === "number") {
    const message = (err as { message?: string }).message || "Forbidden";
    res.status(status).json({ success: false, error: message });
    return true;
  }
  return false;
}

// ── Row schemas (mirror the single-create handlers) ─────────────────────────
// Errors are reported with a 0-BASED `index` into the submitted `rows` array.

const dateLike = z.union([z.string(), z.number(), z.coerce.date()]);

/** Mirrors POST /api/residents required + optional fields. roomNo is a
 *  human-readable room number resolved to a roomId within the property. */
const residentRowSchema = z.object({
  name: z.string().min(1, "name is required"),
  email: z.string().min(1, "email is required"),
  phone: z.string().min(1, "phone is required"),
  propertyId: z.string().min(1, "propertyId is required"),
  roomId: z.string().nullish(),
  roomNo: z.union([z.string(), z.number()]).nullish(),
  dob: dateLike.nullish(),
  gender: z.string().nullish(),
  college: z.string().nullish(),
  course: z.string().nullish(),
  parentName: z.string().nullish(),
  parentPhone: z.string().nullish(),
  parentEmail: z.string().nullish(),
  dietaryPref: z.array(z.string()).nullish(),
  allergies: z.array(z.string()).nullish(),
  checkInDate: dateLike.nullish(),
  checkOutDate: dateLike.nullish(),
  planType: z.string().nullish(),
  monthlyRent: z.coerce.number().nullish(),
  securityDeposit: z.coerce.number().nullish(),
  status: z.enum(["ACTIVE", "CHECKED_OUT", "NOTICE_PERIOD"]).nullish(),
});

/** Mirrors POST /api/users. propertyId is required when role is a
 *  property-bound role (UNIT_LEAD / WARDEN). */
const userRowSchema = z
  .object({
    name: z.string().min(1, "name is required"),
    email: z.string().min(1, "email is required"),
    role: z.string().min(1, "role is required"),
    propertyId: z.string().nullish(),
    username: z.string().nullish(),
    designation: z.string().nullish(),
    phone: z.string().nullish(),
    password: z.string().nullish(),
    isActive: z.coerce.boolean().nullish(),
  })
  .refine(
    (r) => !(["UNIT_LEAD", "WARDEN"].includes(r.role) && !r.propertyId),
    { message: "propertyId is required for UNIT_LEAD/WARDEN", path: ["propertyId"] },
  );

type RowError = { index: number; message: string };

function firstZodMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  return issue ? issue.message : "Invalid row";
}

const TEMP_PASSWORD = "TempPass@123";

// ── POST /api/bulk/:resource ────────────────────────────────────────────────
// resource ∈ { residents, users }. Body: { rows: [...], dryRun?: boolean }.
//   dryRun === true  -> validate only, never insert: { total, valid, invalid, errors }
//   dryRun falsey    -> all-or-nothing insert in one tx; any invalid row => 422,
//                       nothing inserted: { total, inserted, errors }
router.post(
  "/:resource",
  authenticate,
  (req, res, next) => {
    const resource = req.params["resource"];
    if (resource === "residents") return authorize("RESIDENTS", "create")(req, res, next);
    if (resource === "users") return authorize("USERS", "create")(req, res, next);
    res.status(404).json({ success: false, error: "Unknown bulk resource" });
  },
  async (req, res) => {
    try {
      const resource = req.params["resource"];
      const body = req.body ?? {};
      const rows: unknown = body.rows;
      const dryRun = body.dryRun === true;
      if (!Array.isArray(rows)) {
        res.status(400).json({ success: false, error: "rows must be an array" });
        return;
      }
      const total = rows.length;

      if (resource === "residents") {
        await handleResidents(req, res, rows, dryRun, total);
        return;
      }
      // resource === "users"
      await handleUsers(req, res, rows, dryRun, total);
    } catch (err) {
      if (sendAuthzError(err, res)) return;
      req.log.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

// ── Residents ───────────────────────────────────────────────────────────────
async function handleResidents(
  req: import("express").Request,
  res: import("express").Response,
  rows: unknown[],
  dryRun: boolean,
  total: number,
) {
  const scope = scopedPropertyId(req);
  const kycGate = await isKycGateEnabled();

  type Prepared = z.infer<typeof residentRowSchema>;
  const errors: RowError[] = [];
  const prepared: Prepared[] = [];

  for (let i = 0; i < rows.length; i++) {
    const parsed = residentRowSchema.safeParse(rows[i]);
    if (!parsed.success) {
      errors.push({ index: i, message: firstZodMessage(parsed.error) });
      continue;
    }
    const row = parsed.data;
    // Property scoping mirrors POST /api/residents: a scoped caller's rows are
    // forced to their own propertyId; reject any row aimed at another property.
    if (scope) {
      if (row.propertyId && row.propertyId !== scope) {
        errors.push({ index: i, message: "Outside your property scope" });
        continue;
      }
      row.propertyId = scope;
    } else {
      try {
        assertPropertyAccess(req, row.propertyId);
      } catch (err) {
        errors.push({ index: i, message: (err as { message?: string }).message || "Outside your property scope" });
        continue;
      }
    }
    // Mirror the KYC activation gate from the single-create handler.
    const requestedStatus = row.status || "ACTIVE";
    if (requestedStatus === "ACTIVE" && kycGate) {
      errors.push({
        index: i,
        message: "KYC gate is enabled: create with status NOTICE_PERIOD or CHECKED_OUT, then complete KYC + e-sign before activating",
      });
      continue;
    }
    prepared.push(row);
  }

  if (dryRun) {
    res.json({
      success: true,
      data: { total, valid: prepared.length, invalid: errors.length, errors },
    });
    return;
  }

  if (errors.length > 0) {
    res.status(422).json({ success: true, data: { total, inserted: 0, errors } });
    return;
  }

  // All rows valid: insert atomically. roomNo (when given without roomId) is
  // resolved to a roomId by number within the resident's property.
  const roomCache = new Map<string, string | null>();
  async function resolveRoomId(
    tx: typeof db,
    propertyId: string,
    roomId: string | null | undefined,
    roomNo: string | number | null | undefined,
  ): Promise<string | null | undefined> {
    if (roomId) return roomId;
    if (roomNo == null || roomNo === "") return undefined;
    const key = `${propertyId}:${roomNo}`;
    if (roomCache.has(key)) return roomCache.get(key)!;
    const [room] = await tx
      .select({ id: roomsTable.id })
      .from(roomsTable)
      .where(and(eq(roomsTable.propertyId, propertyId), eq(roomsTable.number, String(roomNo))));
    const resolved = room?.id ?? null;
    roomCache.set(key, resolved);
    return resolved ?? undefined;
  }

  let inserted = 0;
  await db.transaction(async (tx) => {
    for (const row of prepared) {
      const resolvedRoomId = await resolveRoomId(tx as unknown as typeof db, row.propertyId, row.roomId, row.roomNo);
      await tx.insert(residentsTable).values({
        id: newId(),
        propertyId: row.propertyId,
        roomId: resolvedRoomId ?? undefined,
        name: row.name,
        email: row.email,
        phone: row.phone,
        dob: row.dob ? new Date(row.dob) : undefined,
        gender: row.gender ?? undefined,
        college: row.college ?? undefined,
        course: row.course ?? undefined,
        parentName: row.parentName ?? undefined,
        parentPhone: row.parentPhone ?? undefined,
        parentEmail: row.parentEmail ?? undefined,
        dietaryPref: row.dietaryPref ?? [],
        allergies: row.allergies ?? [],
        checkInDate: row.checkInDate ? new Date(row.checkInDate) : undefined,
        checkOutDate: row.checkOutDate ? new Date(row.checkOutDate) : undefined,
        planType: row.planType ?? undefined,
        monthlyRent: row.monthlyRent != null ? row.monthlyRent.toString() : undefined,
        securityDeposit: row.securityDeposit != null ? row.securityDeposit.toString() : undefined,
        status: row.status || "ACTIVE",
        updatedAt: new Date(),
      });
      inserted++;
    }
  });

  res.json({ success: true, data: { total, inserted, errors: [] } });
}

// ── Users ────────────────────────────────────────────────────────────────────
async function handleUsers(
  req: import("express").Request,
  res: import("express").Response,
  rows: unknown[],
  dryRun: boolean,
  total: number,
) {
  const callerRole = req.user!.role;

  type Prepared = z.infer<typeof userRowSchema>;
  const errors: RowError[] = [];
  const prepared: Prepared[] = [];

  for (let i = 0; i < rows.length; i++) {
    const parsed = userRowSchema.safeParse(rows[i]);
    if (!parsed.success) {
      errors.push({ index: i, message: firstZodMessage(parsed.error) });
      continue;
    }
    const row = parsed.data;
    // Mirror the single-create role-rank guard (anti privilege-escalation).
    try {
      assertCanAssignRole(callerRole, row.role);
    } catch (err) {
      errors.push({ index: i, message: (err as { message?: string }).message || "Forbidden role assignment" });
      continue;
    }
    prepared.push(row);
  }

  if (dryRun) {
    res.json({
      success: true,
      data: { total, valid: prepared.length, invalid: errors.length, errors },
    });
    return;
  }

  if (errors.length > 0) {
    res.status(422).json({ success: true, data: { total, inserted: 0, errors } });
    return;
  }

  // Pre-hash passwords (bcrypt is async) before opening the transaction.
  const withHashes = await Promise.all(
    prepared.map(async (row) => ({
      row,
      passwordHash: await bcrypt.hash(row.password || TEMP_PASSWORD, 12),
    })),
  );

  let inserted = 0;
  await db.transaction(async (tx) => {
    for (const { row, passwordHash } of withHashes) {
      await tx.insert(usersTable).values({
        id: newId(),
        name: row.name,
        email: row.email,
        username: row.username ?? undefined,
        designation: row.designation ?? undefined,
        phone: row.phone ?? undefined,
        role: row.role as typeof usersTable.$inferInsert.role,
        propertyId: row.propertyId ?? undefined,
        isActive: row.isActive ?? undefined,
        passwordHash,
        updatedAt: new Date(),
      });
      inserted++;
    }
  });

  res.json({ success: true, data: { total, inserted, errors: [] } });
}

export default router;
