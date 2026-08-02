import { Router } from "express";
import {
  db,
  bookingsTable,
  propertiesTable,
  roomsTable,
  type PortfolioAttributes,
} from "@workspace/db";
import { and, eq, gt, lt, ne, desc, inArray, sql } from "drizzle-orm";
import { randomInt } from "crypto";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { assertPropertyAccess, scopedPropertyId } from "../lib/authz.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";

const router: Router = Router();

const ACTIVE_STATUSES = ["CONFIRMED", "CHECKED_IN"] as const;

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

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
}

function diffNights(checkIn: Date, checkOut: Date): number {
  const ms = checkOut.getTime() - checkIn.getTime();
  return Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

function pickRate(
  attrs: PortfolioAttributes | null | undefined,
  ratePeriod: "NIGHTLY" | "WEEKLY",
): number {
  if (!attrs) return 0;
  if (ratePeriod === "WEEKLY") return Number(attrs.weeklyRate || 0);
  return Number(attrs.nightlyRate || 0);
}

function computeInvoice(
  nights: number,
  ratePeriod: "NIGHTLY" | "WEEKLY",
  ratePerPeriod: number,
) {
  const units = ratePeriod === "WEEKLY" ? Math.max(1, Math.ceil(nights / 7)) : nights;
  const subtotal = units * ratePerPeriod;
  const taxAmount = 0;
  const totalAmount = subtotal + taxAmount;
  return { units, subtotal, taxAmount, totalAmount };
}

// List bookings, optionally filtered by property/room/status/date range.
router.get("/", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const roomId = req.query["roomId"] as string | undefined;
    const status = req.query["status"] as string | undefined;
    const from = parseDate(req.query["from"]);
    const to = parseDate(req.query["to"]);

    const conds = [];
    const scope = scopedPropertyId(req);
    if (scope) conds.push(eq(bookingsTable.propertyId, scope));
    if (propertyId) conds.push(eq(bookingsTable.propertyId, propertyId));
    if (roomId) conds.push(eq(bookingsTable.roomId, roomId));
    if (status) conds.push(eq(bookingsTable.status, status as never));
    if (from && to) {
      // overlap
      conds.push(lt(bookingsTable.checkInDate, to));
      conds.push(gt(bookingsTable.checkOutDate, from));
    }
    const where = conds.length ? and(...conds) : undefined;

    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bookingsTable)
      .where(where);

    const rows = await db
      .select()
      .from(bookingsTable)
      .where(where)
      .orderBy(desc(bookingsTable.checkInDate))
      .limit(limit)
      .offset(offset);

    const roomIds = Array.from(
      new Set(rows.map((r) => r.roomId).filter((v): v is string => !!v)),
    );
    const roomMap: Record<string, { number: string }> = {};
    if (roomIds.length) {
      const rs = await db
        .select({ id: roomsTable.id, number: roomsTable.number })
        .from(roomsTable)
        .where(inArray(roomsTable.id, roomIds));
      for (const r of rs) roomMap[r.id] = { number: r.number };
    }
    const data = rows.map((r) => ({
      ...r,
      roomNumber: r.roomId ? roomMap[r.roomId]?.number || null : null,
    }));
    res.json({ success: true, data, meta: buildMeta(countResult?.count ?? 0, page, limit) });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Availability: list bookings overlapping the requested window per room.
router.get("/availability", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const propertyId = req.query["propertyId"] as string | undefined;
    const from = parseDate(req.query["from"]);
    const to = parseDate(req.query["to"]);
    if (!propertyId || !from || !to) {
      res
        .status(400)
        .json({ success: false, error: "propertyId, from and to are required" });
      return;
    }
    assertPropertyAccess(req, propertyId);
    if (to <= from) {
      res
        .status(400)
        .json({ success: false, error: "to must be after from" });
      return;
    }

    const rooms = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.propertyId, propertyId))
      .orderBy(roomsTable.number);

    const overlapping = await db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.propertyId, propertyId),
          inArray(bookingsTable.status, ACTIVE_STATUSES as unknown as ("CONFIRMED" | "CHECKED_IN")[]),
          lt(bookingsTable.checkInDate, to),
          gt(bookingsTable.checkOutDate, from),
        ),
      );

    const byRoom: Record<string, typeof overlapping> = {};
    for (const b of overlapping) {
      if (!b.roomId) continue;
      (byRoom[b.roomId] ||= []).push(b);
    }

    const data = rooms.map((r) => ({
      roomId: r.id,
      number: r.number,
      floor: r.floor,
      type: r.type,
      capacity: r.capacity,
      bookings: (byRoom[r.id] || []).map((b) => ({
        id: b.id,
        bookingNo: b.bookingNo,
        guestName: b.guestName,
        checkInDate: b.checkInDate,
        checkOutDate: b.checkOutDate,
        status: b.status,
      })),
      available: !(byRoom[r.id] || []).length,
    }));
    res.json({ success: true, data });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/:id", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const [row] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, req.params["id"]!));
    if (!row) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }
    assertPropertyAccess(req, row.propertyId);
    let roomNumber: string | null = null;
    if (row.roomId) {
      const [r] = await db
        .select({ number: roomsTable.number })
        .from(roomsTable)
        .where(eq(roomsTable.id, row.roomId));
      roomNumber = r?.number ?? null;
    }
    res.json({ success: true, data: { ...row, roomNumber } });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/", authenticate, authorize("RESIDENTS", "create"), async (req, res) => {
  try {
    const b = req.body || {};
    const propertyId: string | undefined = b.propertyId;
    if (propertyId) assertPropertyAccess(req, propertyId);
    const roomId: string | undefined = b.roomId || undefined;
    const checkIn = parseDate(b.checkInDate);
    const checkOut = parseDate(b.checkOutDate);
    const ratePeriod: "NIGHTLY" | "WEEKLY" =
      b.ratePeriod === "WEEKLY" ? "WEEKLY" : "NIGHTLY";

    if (!propertyId || !b.guestName || !b.guestPhone) {
      res.status(400).json({
        success: false,
        error: "propertyId, guestName and guestPhone are required",
      });
      return;
    }
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      res.status(400).json({
        success: false,
        error: "checkInDate and checkOutDate must be valid and check-out must follow check-in",
      });
      return;
    }

    const [property] = await db
      .select()
      .from(propertiesTable)
      .where(eq(propertiesTable.id, propertyId));
    if (!property) {
      res.status(404).json({ success: false, error: "Property not found" });
      return;
    }

    // Resolve rate. Caller may override; otherwise use the property rate card.
    const cardRate = pickRate(property.portfolioAttributes, ratePeriod);
    const ratePerPeriod =
      typeof b.ratePerPeriod === "number" && b.ratePerPeriod > 0
        ? b.ratePerPeriod
        : cardRate;
    if (!ratePerPeriod || ratePerPeriod <= 0) {
      res.status(400).json({
        success: false,
        error:
          "No rate available. Set a nightly/weekly rate on the property or pass ratePerPeriod",
      });
      return;
    }

    // Availability check (only for confirmed/active overlaps on the same room).
    if (roomId) {
      const overlap = await db
        .select({ id: bookingsTable.id })
        .from(bookingsTable)
        .where(
          and(
            eq(bookingsTable.roomId, roomId),
            inArray(bookingsTable.status, ACTIVE_STATUSES as unknown as ("CONFIRMED" | "CHECKED_IN")[]),
            lt(bookingsTable.checkInDate, checkOut),
            gt(bookingsTable.checkOutDate, checkIn),
          ),
        )
        .limit(1);
      if (overlap.length) {
        res.status(409).json({
          success: false,
          error: "Room is already booked for the selected dates",
        });
        return;
      }
    }

    const nights = diffNights(checkIn, checkOut);
    const invoice = computeInvoice(nights, ratePeriod, ratePerPeriod);
    // Use a CSPRNG (randomInt) for the random suffix instead of Math.random,
    // and widen it to ~40 bits so references aren't predictable/collision-prone.
    const rand = (randomInt(0, 0xffffffff) * 0x100 + randomInt(0, 0xff))
      .toString(36)
      .toUpperCase()
      .padStart(8, "0");
    const bookingNo = `BK-${Date.now().toString(36).toUpperCase()}-${rand}`;

    const [row] = await db
      .insert(bookingsTable)
      .values({
        id: newId(),
        bookingNo,
        propertyId,
        roomId: roomId || null,
        guestName: b.guestName,
        guestEmail: b.guestEmail || null,
        guestPhone: b.guestPhone,
        guestCount: b.guestCount ?? 1,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        nights,
        ratePeriod,
        ratePerPeriod: String(ratePerPeriod),
        subtotal: String(invoice.subtotal),
        taxAmount: String(invoice.taxAmount),
        totalAmount: String(invoice.totalAmount),
        status: b.status || "CONFIRMED",
        notes: b.notes || null,
        createdBy: req.user?.id,
        updatedAt: new Date(),
      })
      .returning();

    let roomNumber: string | null = null;
    if (row.roomId) {
      const [r] = await db
        .select({ number: roomsTable.number })
        .from(roomsTable)
        .where(eq(roomsTable.id, row.roomId));
      roomNumber = r?.number ?? null;
    }
    res.status(201).json({ success: true, data: { ...row, roomNumber } });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/:id", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const b = req.body || {};
    const id = req.params["id"]!;
    const [existing] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, id));
    if (!existing) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }
    assertPropertyAccess(req, existing.propertyId);

    const checkIn = b.checkInDate ? parseDate(b.checkInDate) : existing.checkInDate;
    const checkOut = b.checkOutDate ? parseDate(b.checkOutDate) : existing.checkOutDate;
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      res.status(400).json({
        success: false,
        error: "Invalid check-in / check-out dates",
      });
      return;
    }

    const roomId =
      b.roomId === undefined ? existing.roomId : b.roomId || null;
    const status = b.status || existing.status;

    if (
      roomId &&
      (ACTIVE_STATUSES as readonly string[]).includes(status)
    ) {
      const overlap = await db
        .select({ id: bookingsTable.id })
        .from(bookingsTable)
        .where(
          and(
            eq(bookingsTable.roomId, roomId),
            ne(bookingsTable.id, id),
            inArray(bookingsTable.status, ACTIVE_STATUSES as unknown as ("CONFIRMED" | "CHECKED_IN")[]),
            lt(bookingsTable.checkInDate, checkOut),
            gt(bookingsTable.checkOutDate, checkIn),
          ),
        )
        .limit(1);
      if (overlap.length) {
        res.status(409).json({
          success: false,
          error: "Room is already booked for the selected dates",
        });
        return;
      }
    }

    const ratePeriod: "NIGHTLY" | "WEEKLY" =
      b.ratePeriod === "NIGHTLY" || b.ratePeriod === "WEEKLY"
        ? b.ratePeriod
        : (existing.ratePeriod as "NIGHTLY" | "WEEKLY");
    const ratePerPeriod =
      typeof b.ratePerPeriod === "number" && b.ratePerPeriod > 0
        ? b.ratePerPeriod
        : Number(existing.ratePerPeriod);

    const nights = diffNights(checkIn, checkOut);
    const invoice = computeInvoice(nights, ratePeriod, ratePerPeriod);

    const [row] = await db
      .update(bookingsTable)
      .set({
        roomId,
        guestName: b.guestName ?? existing.guestName,
        guestEmail: b.guestEmail !== undefined ? b.guestEmail : existing.guestEmail,
        guestPhone: b.guestPhone ?? existing.guestPhone,
        guestCount: b.guestCount ?? existing.guestCount,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        nights,
        ratePeriod,
        ratePerPeriod: String(ratePerPeriod),
        subtotal: String(invoice.subtotal),
        taxAmount: String(invoice.taxAmount),
        totalAmount: String(invoice.totalAmount),
        status,
        notes: b.notes !== undefined ? b.notes : existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(bookingsTable.id, id))
      .returning();

    let roomNumber: string | null = null;
    if (row.roomId) {
      const [r] = await db
        .select({ number: roomsTable.number })
        .from(roomsTable)
        .where(eq(roomsTable.id, row.roomId));
      roomNumber = r?.number ?? null;
    }
    res.json({ success: true, data: { ...row, roomNumber } });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.delete("/:id", authenticate, authorize("RESIDENTS", "delete"), async (req, res) => {
  try {
    const id = req.params["id"]!;
    const [existing] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, id));
    if (!existing) {
      res.status(404).json({ success: false, error: "Booking not found" });
      return;
    }
    assertPropertyAccess(req, existing.propertyId);
    const [row] = await db
      .update(bookingsTable)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(eq(bookingsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ success: false, error: "Booking not found" });
      return;
    }
    res.json({ success: true, message: "Cancelled", data: row });
  } catch (err) {
    if (sendAuthzError(err, res)) return;
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
