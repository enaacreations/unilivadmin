/**
 * Realistic 18-month historical DEMO seed.
 * ------------------------------------------------------------------------------
 * Goal: after running this, EVERY dashboard / chart / report across all modules
 * has rich data spanning ~18 months so Week / Month / Quarter / FY filters all
 * populate with non-trivial numbers.
 *
 * Runs AFTER the base seeds (seed.ts, seed-food.ts, seed-food-extra.ts) which
 * already created the 5 base properties, food brands, kitchens, kitchen_pincodes,
 * dishes / rotation / rules / cut-offs, ~50 residents, etc. This script is:
 *
 *   • AUGMENT-ON-TOP — it never truncates or wipes base data.
 *   • IDEMPOTENT     — every row uses a STABLE prefixed id (demo_*) and inserts
 *                      with .onConflictDoNothing() (or onConflictDoUpdate for the
 *                      2 new properties), so a second run is a clean no-op.
 *
 * Run:  set -a; . ./.env; set +a
 *       pnpm --filter @workspace/scripts run seed:demo
 */
import { db, pool } from "@workspace/db";
import {
  // core
  propertiesTable, roomsTable, usersTable, residentsTable,
  ledgerEntriesTable, paymentsTable, complaintsTable, complaintEventsTable,
  escalationsTable, laundryBatchesTable, bookingsTable,
  kitchenPincodesTable,
  // hrms
  employeesTable, attendanceTable, leavesTable,
  // sales
  leadsTable,
  // procurement
  inventoryTable, purchaseOrdersTable, grnTable, indentsTable,
  // finance
  expensesTable, billingCyclesTable,
  // food
  dishesTable, foodOrdersTable, foodOrderItemsTable, foodOrderEventsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";

/* ────────────────────────────────────────────────────────────────────────────
 * Density / window configuration
 * ──────────────────────────────────────────────────────────────────────────── */
const WINDOW_DAYS = 548;   // ~18 months of history
const DENSE_DAYS = 365;    // last ~12 months get 4 food orders/property/day
const FOOD_SPARSE_EVERY = 3; // beyond DENSE_DAYS, place a meal every Nth day
const RENT_MONTHS = 18;    // ledger + payments per ACTIVE resident-month
const FOOD_ITEMS_MIN = 2;  // items per food order
const FOOD_ITEMS_MAX = 4;
const BATCH = 500;         // rows per insert chunk

const NOW = new Date();
const TODAY_Y = NOW.getFullYear();
const TODAY_M = NOW.getMonth();
const TODAY_D = NOW.getDate();

/* ────────────────────────────────────────────────────────────────────────────
 * Deterministic PRNG (so re-runs that DO re-derive values are stable, and the
 * data shape is reproducible). Mulberry32 seeded from a string.
 * ──────────────────────────────────────────────────────────────────────────── */
function makeRng(seedStr: string) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng("uniliv-demo-v1");
const rint = (min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min;
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
/** Weighted pick: entries of [value, weight]. */
function wpick<T>(entries: readonly [T, number][]): T {
  const total = entries.reduce((s, e) => s + e[1], 0);
  let r = rng() * total;
  for (const [v, w] of entries) { if ((r -= w) <= 0) return v; }
  return entries[entries.length - 1]![0];
}

/* Date helpers — IST handled by using date-only strings for serviceDate. */
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const atTime = (d: Date, h: number, m: number) => {
  const x = new Date(d);
  x.setHours(h, m, Math.floor(rng() * 60), 0);
  return x;
};
/** "yyyy-MM-dd" date-only for food serviceDate (IST, no tz drift). */
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/**
 * IST midnight instant for a yyyy-MM-dd — mirrors the API's ymdToIstDayStart so a
 * food order buckets on the right IST service day. serviceDate must be the DAY
 * START, not the meal-hour moment: an evening (>=18:30 IST) timestamp would
 * otherwise leak into the next day's "next order" window.
 */
const istDayStart = (ymdStr: string) => {
  const [y, m, d] = ymdStr.split("-").map(Number);
  return new Date(Date.UTC(y!, (m! - 1), d!, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
};

/** Chunked batch insert with onConflictDoNothing. */
async function insertChunked<T extends Record<string, unknown>>(
  table: any,
  rows: T[],
  label: string,
) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    if (chunk.length) await db.insert(table).values(chunk).onConflictDoNothing();
  }
  console.log(`  ✓ ${label}: ${rows.length} rows (existing skipped)`);
}

const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna",
  "Ishaan", "Rohan", "Ananya", "Diya", "Saanvi", "Aadhya", "Pari", "Anika",
  "Riya", "Myra", "Sara", "Aarohi", "Kabir", "Dhruv", "Kiaan", "Aryan",
  "Neha", "Priya", "Pooja", "Sneha", "Kavya", "Meera", "Tanvi", "Isha",
  "Rahul", "Karan", "Nikhil", "Varun", "Siddharth", "Manish", "Gaurav", "Deepak",
];
const LAST_NAMES = [
  "Sharma", "Verma", "Patel", "Gupta", "Reddy", "Nair", "Iyer", "Menon",
  "Rao", "Singh", "Kumar", "Joshi", "Mehta", "Desai", "Pillai", "Bhat",
  "Kulkarni", "Saxena", "Agarwal", "Khanna", "Mukherjee", "Bose", "Ghosh", "Das",
];
const fullName = (seed: string) => {
  const r = makeRng(seed);
  return `${FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]}`;
};

/* ────────────────────────────────────────────────────────────────────────────
 * MAIN
 * ──────────────────────────────────────────────────────────────────────────── */
async function main() {
  console.log("🌱 Seeding realistic 18-month DEMO data (augment-on-top, idempotent)...");

  const ADMIN_ID = "b6193468-fe90-4e58-91ed-ca23f0232533"; // existing admin (createdBy refs)
  // Fallback: resolve admin dynamically if the hard-coded id is missing.
  const adminRow = (await pool.query(
    `SELECT id FROM users WHERE email='admin@uniliv.com' LIMIT 1`,
  )).rows[0] as { id: string } | undefined;
  const adminId = adminRow?.id ?? ADMIN_ID;

  /* ── 1. PROPERTIES (+2 Pune, upsert) + kitchen_pincodes ──────────────────── */
  console.log("• properties (+2 Pune)...");
  const PUNE_KITCHEN = "kitchen_kit_pun_hinj";
  const PUNE_CLUSTER = "cluster_pune_hinjewadi";
  const newProps = [
    {
      id: "demo_prop_pune2", name: "UNILIV Kharadi", address: "EON IT Park, Kharadi",
      city: "Pune", state: "Maharashtra", pincode: "411014", totalBeds: 90,
      brand: "HUDDLE",
    },
    {
      id: "demo_prop_pune3", name: "UNILIV Wakad", address: "Hinjewadi-Wakad Link Rd",
      city: "Pune", state: "Maharashtra", pincode: "411057", totalBeds: 70,
      brand: "HUDDLE",
    },
  ];
  for (const p of newProps) {
    await db
      .insert(propertiesTable)
      .values({
        id: p.id, name: p.name, address: p.address, city: p.city, state: p.state,
        pincode: p.pincode, totalBeds: p.totalBeds, status: "ACTIVE",
        portfolioType: "CO_LIVING",
        portfolioAttributes: { gender: "COED", mealPlanIncluded: true },
        brand: p.brand, kitchenId: PUNE_KITCHEN, clusterId: PUNE_CLUSTER,
        phone: `98220${String(rint(10000, 99999))}`,
        email: `${p.name.split(" ").pop()!.toLowerCase()}@uniliv.com`,
        amenities: ["WiFi", "Laundry", "Gym", "Cafeteria", "CCTV"],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: propertiesTable.id,
        set: {
          brand: p.brand, kitchenId: PUNE_KITCHEN, clusterId: PUNE_CLUSTER,
          status: "ACTIVE", totalBeds: p.totalBeds, updatedAt: new Date(),
        },
      });
  }
  // kitchen_pincodes for the new pincodes (411014 + 411057 → Pune kitchen).
  await db
    .insert(kitchenPincodesTable)
    .values([
      { id: "demo_kp_411014", kitchenId: PUNE_KITCHEN, pincode: "411014", isActive: true, updatedAt: new Date() },
      { id: "demo_kp_411057", kitchenId: PUNE_KITCHEN, pincode: "411057", isActive: true, updatedAt: new Date() },
    ])
    .onConflictDoNothing();
  console.log("  ✓ 2 Pune properties (upsert) + kitchen_pincodes");

  // Resolve the FULL residential property set (base + new) with bed counts & brand.
  const allProps = (await pool.query(
    `SELECT id, name, total_beds, COALESCE(brand,'UNILIV') AS brand, kitchen_id, pincode
       FROM properties WHERE total_beds > 0 ORDER BY id`,
  )).rows as Array<{ id: string; name: string; total_beds: number; brand: string; kitchen_id: string | null; pincode: string }>;
  console.log(`  ✓ ${allProps.length} residential properties in scope`);
  // Stable per-property index (allProps is ORDER BY id) so demo order numbers can be
  // derived deterministically from (date, meal, property) — making the seed re-run-safe
  // (the unique order_number then always maps to the same row as the deterministic PK).
  const propIdx = new Map(allProps.map((pp, i) => [pp.id, i]));

  /* ── 2. ROOMS (~ceil(beds/2) per property) ───────────────────────────────── */
  console.log("• rooms...");
  const roomTypes = ["SINGLE", "DOUBLE", "TRIPLE"] as const;
  const roomCap = { SINGLE: 1, DOUBLE: 2, TRIPLE: 3 } as const;
  type RoomRow = typeof roomsTable.$inferInsert;
  const roomRows: RoomRow[] = [];
  // roomsByProp[propId] = list of demo room ids (for resident assignment)
  const roomsByProp: Record<string, string[]> = {};
  for (const p of allProps) {
    roomsByProp[p.id] = [];
    const count = Math.ceil(p.total_beds / 2);
    for (let i = 0; i < count; i++) {
      const rid = `demo_room_${p.id}_${i}`;
      roomsByProp[p.id]!.push(rid);
      const floor = (i % 4) + 1;
      const type = roomTypes[i % 3]!;
      roomRows.push({
        id: rid, propertyId: p.id,
        number: `${floor}${String((i % 25) + 1).padStart(2, "0")}`,
        floor, wing: i % 2 === 0 ? "A" : "B",
        type, capacity: roomCap[type],
        status: i % 5 === 0 ? "VACANT" : "OCCUPIED",
        updatedAt: new Date(),
      });
    }
  }
  await insertChunked(roomsTable, roomRows, "rooms");

  /* ── 3. USERS (employee logins + UNIT_LEAD for new Pune props) ───────────── */
  console.log("• users (employee logins + unit leads)...");
  const bcrypt = (await import("bcryptjs")).default;
  const pwd = await bcrypt.hash("Admin@123", 10);
  type UserRow = typeof usersTable.$inferInsert;
  const userRows: UserRow[] = [];
  const EMP_USER_ROLES = [
    "OPERATIONS_MANAGER", "HR_MANAGER", "FINANCE", "SALES_EXECUTIVE",
    "PROCUREMENT_MANAGER", "KITCHEN_MANAGER", "WARDEN", "AUDIT_READONLY",
  ] as const;
  for (let i = 0; i < 30; i++) {
    userRows.push({
      id: `demo_user_emp_${i}`,
      name: fullName(`empuser_${i}`),
      email: `demo.emp${i}@uniliv.com`,
      username: `demo_emp${i}`,
      phone: `97${String(1000000 + i).slice(-8)}`,
      passwordHash: pwd,
      role: EMP_USER_ROLES[i % EMP_USER_ROLES.length]!,
      isActive: true,
      updatedAt: new Date(),
    });
  }
  // 3 UNIT_LEADs bound to the new Pune properties (+ one extra on pune2).
  const unitLeadBindings: Array<{ id: string; prop: string }> = [
    { id: "demo_user_ul_pune2", prop: "demo_prop_pune2" },
    { id: "demo_user_ul_pune3", prop: "demo_prop_pune3" },
    { id: "demo_user_ul_pune2b", prop: "demo_prop_pune2" },
  ];
  unitLeadBindings.forEach((b, i) => {
    userRows.push({
      id: b.id,
      name: fullName(`ul_${i}`),
      email: `demo.unitlead${i}@uniliv.com`,
      username: `demo_ul${i}`,
      phone: `96${String(2000000 + i).slice(-8)}`,
      passwordHash: pwd,
      role: "UNIT_LEAD",
      propertyId: b.prop,
      isActive: true,
      updatedAt: new Date(),
    });
  });
  await insertChunked(usersTable, userRows, "users");

  // Per-property unit-lead id, used for food orders. Resolve a real UNIT_LEAD
  // already bound to each residential property (base seed bound base props).
  const ulByProp: Record<string, string> = {};
  const ulRows = (await pool.query(
    `SELECT id, property_id FROM users WHERE role='UNIT_LEAD' AND property_id IS NOT NULL`,
  )).rows as Array<{ id: string; property_id: string }>;
  for (const r of ulRows) if (!ulByProp[r.property_id]) ulByProp[r.property_id] = r.id;
  // Fallback unit lead for any property lacking a bound UNIT_LEAD.
  const anyUnitLead = (await pool.query(
    `SELECT id FROM users WHERE role='UNIT_LEAD' ORDER BY id LIMIT 1`,
  )).rows[0]?.id as string | undefined;
  const fnbSup = (await pool.query(
    `SELECT id FROM users WHERE role IN ('FNB_SUPERVISOR','FNB_MANAGER','KITCHEN_MANAGER') ORDER BY id LIMIT 1`,
  )).rows[0]?.id as string | undefined ?? anyUnitLead;

  /* ── 4. RESIDENTS (fill ~75-85% of beds, cohorts across 18 months) ───────── */
  console.log("• residents (cohorts across 18 months)...");
  type ResidentRow = typeof residentsTable.$inferInsert;
  const residentRows: ResidentRow[] = [];
  // Track ACTIVE residents (for ledger/payments/food) with their rent & prop.
  const activeResidents: Array<{ id: string; propId: string; rent: number; checkIn: Date }> = [];

  for (const p of allProps) {
    const fillPct = 0.75 + rng() * 0.1; // 75–85%
    const target = Math.floor(p.total_beds * fillPct);
    const rooms = roomsByProp[p.id]!;
    for (let i = 0; i < target; i++) {
      const rid = `demo_res_${p.id}_${i}`;
      // Check-in spread EVENLY across the full 18-month window so every FY/
      // quarter month has a resident cohort (and thus a full run of rent
      // entries). Index i maps proportionally to a month-offset 0..RENT_MONTHS-1,
      // jittered ±1 month so cohorts aren't perfectly uniform.
      const base = Math.floor((i / Math.max(1, target)) * RENT_MONTHS);
      const monthBack = Math.min(RENT_MONTHS - 1, Math.max(0, base + rint(-1, 1)));
      const checkIn = monthsAgo(monthBack, rint(1, 27));
      // status mix: 85% ACTIVE / 10% NOTICE_PERIOD / 5% CHECKED_OUT
      const status = wpick<"ACTIVE" | "NOTICE_PERIOD" | "CHECKED_OUT">([
        ["ACTIVE", 85], ["NOTICE_PERIOD", 10], ["CHECKED_OUT", 5],
      ]);
      const rent = rint(8000, 22000);
      const checkOut = status === "CHECKED_OUT" ? daysAgo(rint(1, 90)) : null;
      const gender = i % 2 === 0 ? "MALE" : "FEMALE";
      residentRows.push({
        id: rid, propertyId: p.id,
        roomId: rooms[i % rooms.length] ?? null,
        name: fullName(rid),
        email: `${rid}@example.com`,
        phone: `90${String(3000000 + residentRows.length).slice(-8)}`,
        gender,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        monthlyRent: String(rent),
        securityDeposit: String(rent * 2),
        planType: pick(["MONTHLY", "QUARTERLY"]),
        status,
        updatedAt: new Date(),
      });
      if (status === "ACTIVE") activeResidents.push({ id: rid, propId: p.id, rent, checkIn });
    }
  }
  await insertChunked(residentsTable, residentRows, "residents");
  console.log(`  ✓ ${activeResidents.length} ACTIVE residents drive ledger/payments/food`);

  /* ── 5. EMPLOYEES + ATTENDANCE + LEAVES ──────────────────────────────────── */
  console.log("• employees + attendance + leaves...");
  const DEPARTMENTS = ["Operations", "Housekeeping", "Kitchen", "Security", "Admin", "Maintenance"];
  const DESIGNATIONS = ["Executive", "Supervisor", "Manager", "Associate", "Lead"];
  type EmpRow = typeof employeesTable.$inferInsert;
  const empRows: EmpRow[] = [];
  const empIds: string[] = [];
  const propIdList = allProps.map((p) => p.id);
  for (let i = 0; i < 40; i++) {
    const eid = `demo_emp_${i}`;
    empIds.push(eid);
    const ctc = rint(240000, 720000);
    empRows.push({
      id: eid,
      employeeCode: `DEMO-EMP-${String(i).padStart(3, "0")}`,
      name: fullName(`emp_${i}`),
      email: `demo.employee${i}@uniliv.com`,
      phone: `95${String(4000000 + i).slice(-8)}`,
      department: DEPARTMENTS[i % DEPARTMENTS.length]!,
      designation: DESIGNATIONS[i % DESIGNATIONS.length]!,
      propertyId: propIdList[i % propIdList.length]!,
      joiningDate: monthsAgo(rint(2, 30), rint(1, 27)),
      ctc: String(ctc),
      basic: String(Math.floor(ctc * 0.5)),
      hra: String(Math.floor(ctc * 0.2)),
      specialAllowance: String(Math.floor(ctc * 0.3)),
      status: "ACTIVE",
      updatedAt: new Date(),
    });
  }
  await insertChunked(employeesTable, empRows, "employees");

  // Attendance: daily rows for last 75 days (mostly PRESENT).
  type AttRow = typeof attendanceTable.$inferInsert;
  const attRows: AttRow[] = [];
  for (let d = 0; d < 75; d++) {
    const day = daysAgo(d);
    const dow = day.getDay();
    if (dow === 0) continue; // skip Sundays
    for (const eid of empIds) {
      const status = wpick<"PRESENT" | "ABSENT" | "ON_LEAVE" | "HALF_DAY">([
        ["PRESENT", 86], ["ABSENT", 6], ["ON_LEAVE", 5], ["HALF_DAY", 3],
      ]);
      attRows.push({
        id: `demo_att_${eid}_${d}`,
        employeeId: eid,
        date: day,
        status,
        inTime: status === "PRESENT" || status === "HALF_DAY" ? atTime(day, 9, rint(0, 30)) : null,
        outTime: status === "PRESENT" ? atTime(day, 18, rint(0, 45)) : status === "HALF_DAY" ? atTime(day, 13, 30) : null,
        createdAt: day,
      });
    }
  }
  await insertChunked(attendanceTable, attRows, "attendance");

  // Leaves: ~25, mix of PENDING / APPROVED, some spanning today.
  type LeaveRow = typeof leavesTable.$inferInsert;
  const leaveRows: LeaveRow[] = [];
  const LEAVE_TYPES = ["CL", "SL", "EL", "PL", "COMP_OFF"] as const;
  for (let i = 0; i < 25; i++) {
    const eid = empIds[i % empIds.length]!;
    const spanToday = i % 4 === 0;
    const from = spanToday ? daysAgo(rint(1, 3)) : daysAgo(rint(5, 120));
    const days = rint(1, 4);
    const to = new Date(from.getTime() + days * 86_400_000);
    const status = wpick<"PENDING" | "APPROVED" | "REJECTED">([
      ["APPROVED", 60], ["PENDING", 30], ["REJECTED", 10],
    ]);
    leaveRows.push({
      id: `demo_leave_${i}`,
      employeeId: eid,
      type: LEAVE_TYPES[i % LEAVE_TYPES.length]!,
      fromDate: from, toDate: to, days,
      reason: pick(["Personal", "Medical", "Family function", "Travel", "Festival"]),
      status,
      approvedBy: status === "APPROVED" ? adminId : null,
      createdAt: daysAgo(rint(1, 130)),
      updatedAt: new Date(),
    });
  }
  await insertChunked(leavesTable, leaveRows, "leaves");

  /* ── 6. LEADS (~120 across 18mo, ≥15 this month) ─────────────────────────── */
  console.log("• leads...");
  type LeadRow = typeof leadsTable.$inferInsert;
  const leadRows: LeadRow[] = [];
  const LEAD_SOURCES = ["WEBSITE", "WHATSAPP", "INSTAGRAM", "COLD_CALL", "REFERRAL", "COLLEGE", "OTHER"] as const;
  const LEAD_STAGES = ["NEW", "CONTACTED", "VISIT_SCHEDULED", "VISIT_DONE", "NEGOTIATING", "CONVERTED", "LOST"] as const;
  for (let i = 0; i < 120; i++) {
    // ≥18 of them THIS calendar month; rest spread across the window.
    const thisMonth = i < 18;
    const created = thisMonth ? thisMonthDay(rint(1, Math.max(1, TODAY_D))) : daysAgo(rint(20, WINDOW_DAYS));
    let stage: (typeof LEAD_STAGES)[number];
    if (thisMonth && i < 6) stage = "CONVERTED";
    else if (thisMonth) stage = pick(["NEW", "CONTACTED", "VISIT_SCHEDULED", "NEGOTIATING"]);
    else stage = pick(LEAD_STAGES);
    const isConverted = stage === "CONVERTED";
    const isLost = stage === "LOST";
    leadRows.push({
      id: `demo_lead_${i}`,
      name: fullName(`lead_${i}`),
      phone: `93${String(5000000 + i).slice(-8)}`,
      email: `demo.lead${i}@example.com`,
      source: LEAD_SOURCES[i % LEAD_SOURCES.length]!,
      propertyId: propIdList[i % propIdList.length]!,
      stage,
      assignedTo: adminId,
      budgetMin: String(rint(6, 10) * 1000),
      budgetMax: String(rint(12, 22) * 1000),
      moveInDate: daysAgo(rint(-30, 60)),
      visitDone: ["VISIT_DONE", "NEGOTIATING", "CONVERTED"].includes(stage),
      lostReason: isLost ? pick(["Budget", "Chose competitor", "Location", "No response"]) : null,
      convertedAt: isConverted ? created : null,
      createdAt: created,
      updatedAt: new Date(),
    });
  }
  await insertChunked(leadsTable, leadRows, "leads");

  /* ── 7. BOOKINGS (~80, unique bookingNo, status mix) ─────────────────────── */
  console.log("• bookings...");
  type BookingRow = typeof bookingsTable.$inferInsert;
  const bookingRows: BookingRow[] = [];
  const BOOKING_STATUSES = ["CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"] as const;
  for (let i = 0; i < 80; i++) {
    const p = allProps[i % allProps.length]!;
    const checkIn = daysAgo(rint(-30, WINDOW_DAYS));
    const nights = rint(1, 14);
    const checkOut = new Date(checkIn.getTime() + nights * 86_400_000);
    const rate = rint(1500, 3500);
    const subtotal = rate * nights;
    const tax = Math.floor(subtotal * 0.12);
    bookingRows.push({
      id: `demo_booking_${i}`,
      bookingNo: `DEMO-BKG-${String(50000 + i)}`,
      propertyId: p.id,
      roomId: roomsByProp[p.id]?.[i % roomsByProp[p.id]!.length] ?? null,
      guestName: fullName(`guest_${i}`),
      guestEmail: `demo.guest${i}@example.com`,
      guestPhone: `92${String(6000000 + i).slice(-8)}`,
      guestCount: rint(1, 3),
      checkInDate: checkIn, checkOutDate: checkOut, nights,
      ratePeriod: "NIGHTLY",
      ratePerPeriod: String(rate),
      subtotal: String(subtotal), taxAmount: String(tax),
      totalAmount: String(subtotal + tax),
      status: wpick<(typeof BOOKING_STATUSES)[number]>([
        ["CHECKED_OUT", 35], ["CONFIRMED", 25], ["CHECKED_IN", 20], ["CANCELLED", 12], ["NO_SHOW", 8],
      ]),
      createdBy: adminId,
      createdAt: daysAgo(rint(0, WINDOW_DAYS)),
      updatedAt: new Date(),
    });
  }
  await insertChunked(bookingsTable, bookingRows, "bookings");

  /* ── 8. LEDGER + PAYMENTS (revenue engine) ───────────────────────────────── */
  console.log("• ledger + payments (revenue engine)...");
  type LedgerRow = typeof ledgerEntriesTable.$inferInsert;
  type PaymentRow = typeof paymentsTable.$inferInsert;
  const ledgerRows: LedgerRow[] = [];
  const paymentRows: PaymentRow[] = [];
  const PAY_MODES = ["UPI", "CARD", "NETBANKING", "CASH", "WALLET"] as const;

  for (const res of activeResidents) {
    // How many rent months: from check-in month up to current month, capped.
    const monthsSinceCheckin = monthsBetween(res.checkIn, NOW);
    const rentMonths = Math.min(RENT_MONTHS, Math.max(1, monthsSinceCheckin + 1));
    for (let m = 0; m < rentMonths; m++) {
      const due = monthsAgo(m, 5); // rent due on the 5th
      const ym = `${due.getFullYear()}${String(due.getMonth() + 1).padStart(2, "0")}`;
      const ledgerId = `demo_led_${res.id}_${ym}`;
      // Payment status: 88% SUCCESS / 8% PENDING / 4% FAILED|REFUNDED.
      const payStatus = wpick<"SUCCESS" | "PENDING" | "FAILED" | "REFUNDED">([
        ["SUCCESS", 88], ["PENDING", 8], ["FAILED", 2], ["REFUNDED", 2],
      ]);
      const isPaid = payStatus === "SUCCESS";
      // PENDING entries from older months drive top-overdue lists.
      const paidOn = isPaid ? atTime(due, rint(8, 20), rint(0, 59)) : null;
      ledgerRows.push({
        id: ledgerId,
        residentId: res.id,
        type: "RENT",
        amount: String(res.rent),
        description: `Rent for ${due.toLocaleString("en-IN", { month: "long", year: "numeric" })}`,
        dueDate: due,
        isPaid,
        paidOn,
        reference: `RENT-${ym}`,
        createdBy: adminId,
        createdAt: monthsAgo(m, 1),
        updatedAt: new Date(),
      });
      // One payment per rent entry. createdAt bucketed into the rent month.
      const payCreated = isPaid
        ? paidOn!
        : payStatus === "PENDING"
          ? atTime(due, 10, 0) // pending: created at due time (older = overdue)
          : atTime(due, 12, 0);
      paymentRows.push({
        id: `demo_pay_${res.id}_${ym}`,
        residentId: res.id,
        amount: String(res.rent),
        mode: PAY_MODES[(ledgerRows.length) % PAY_MODES.length]!,
        status: payStatus,
        reference: `RENT-${ym}`,
        notes: `Rent payment ${due.toLocaleString("en-IN", { month: "short", year: "numeric" })}`,
        createdAt: payCreated,
        updatedAt: new Date(),
      });
    }
    // Scattered non-rent ledger entries (FOOD/LAUNDRY/UTILITY/PENALTY) ~ every 3rd resident.
    if (rng() < 0.35) {
      const types = ["FOOD", "LAUNDRY", "UTILITY", "PENALTY"] as const;
      const t = pick(types);
      const m = rint(0, Math.min(RENT_MONTHS - 1, monthsSinceCheckin));
      const due = monthsAgo(m, rint(10, 25));
      const amt = t === "PENALTY" ? rint(500, 2000) : rint(300, 1500);
      ledgerRows.push({
        id: `demo_led_${res.id}_${t}_${m}`,
        residentId: res.id,
        type: t,
        amount: String(amt),
        description: `${t[0]}${t.slice(1).toLowerCase()} charge`,
        dueDate: due,
        isPaid: rng() < 0.6,
        paidOn: rng() < 0.6 ? atTime(due, 14, 0) : null,
        reference: `${t}-${res.id.slice(-4)}`,
        createdBy: adminId,
        createdAt: due,
        updatedAt: new Date(),
      });
    }
  }
  await insertChunked(ledgerEntriesTable, ledgerRows, "ledger_entries");
  await insertChunked(paymentsTable, paymentRows, "payments");

  /* ── 9. COMPLAINTS (~150, all 8 categories, ≥20 this month) ──────────────── */
  console.log("• complaints (+ events/escalations)...");
  type ComplaintRow = typeof complaintsTable.$inferInsert;
  const complaintRows: ComplaintRow[] = [];
  const CATEGORIES = ["ELECTRICAL", "PLUMBING", "HOUSEKEEPING", "INTERNET", "SECURITY", "FOOD", "LAUNDRY", "OTHER"] as const;
  const C_STATUSES = ["OPEN", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "CLOSED", "REOPENED"] as const;
  const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
  // residents grouped by property for residentId references
  const resByProp: Record<string, string[]> = {};
  for (const r of residentRows) {
    (resByProp[r.propertyId as string] ??= []).push(r.id as string);
  }
  for (let i = 0; i < 150; i++) {
    const p = allProps[i % allProps.length]!;
    const thisMonth = i < 22;
    const created = thisMonth ? thisMonthDay(rint(1, Math.max(1, TODAY_D))) : daysAgo(rint(15, WINDOW_DAYS));
    const category = CATEGORIES[i % CATEGORIES.length]!; // guarantees all 8 covered
    // status mix: ~40% RESOLVED/CLOSED, ~30% OPEN, rest ASSIGNED/IN_PROGRESS/REOPENED
    const status = wpick<(typeof C_STATUSES)[number]>([
      ["RESOLVED", 25], ["CLOSED", 15], ["OPEN", 30], ["ASSIGNED", 12], ["IN_PROGRESS", 13], ["REOPENED", 5],
    ]);
    const resolved = status === "RESOLVED" || status === "CLOSED";
    // some CRITICAL unresolved
    const priority = !resolved && i % 11 === 0 ? "CRITICAL" : pick(PRIORITIES);
    const slaHours = priority === "CRITICAL" ? 4 : priority === "HIGH" ? 8 : 24;
    const slaDeadline = new Date(created.getTime() + slaHours * 3_600_000);
    const slaBreach = !resolved && created.getTime() + slaHours * 3_600_000 < NOW.getTime() && i % 7 === 0;
    const propRes = resByProp[p.id] ?? [];
    complaintRows.push({
      id: `demo_complaint_${i}`,
      propertyId: p.id,
      residentId: propRes.length ? propRes[i % propRes.length]! : null,
      ticketNo: `DEMO-TKT-${String(60000 + i)}`,
      category,
      title: `${category[0]}${category.slice(1).toLowerCase()} issue #${i}`,
      description: `Reported ${category.toLowerCase()} problem requiring attention.`,
      status,
      priority,
      assignedTo: status === "OPEN" ? null : adminId,
      slaHours,
      slaDeadline,
      slaBreach,
      resolvedAt: resolved ? new Date(created.getTime() + rint(2, slaHours * 2) * 3_600_000) : null,
      resolutionNote: resolved ? "Issue addressed and verified." : null,
      rating: resolved ? rint(3, 5) : null,
      createdAt: created,
      updatedAt: new Date(),
    });
  }
  await insertChunked(complaintsTable, complaintRows, "complaints");

  // complaint_events: a created + (optional) resolved event per complaint.
  type CEventRow = typeof complaintEventsTable.$inferInsert;
  const cEventRows: CEventRow[] = [];
  type EscRow = typeof escalationsTable.$inferInsert;
  const escRows: EscRow[] = [];
  complaintRows.forEach((c, i) => {
    cEventRows.push({
      id: `demo_cevt_${c.id}_create`,
      complaintId: c.id as string,
      type: "CREATED",
      toValue: "OPEN",
      note: "Complaint created.",
      actorId: adminId,
      actorName: "Super Admin",
      createdAt: c.createdAt as Date,
    });
    if (c.resolvedAt) {
      cEventRows.push({
        id: `demo_cevt_${c.id}_resolve`,
        complaintId: c.id as string,
        type: "STATUS_CHANGE",
        fromValue: "IN_PROGRESS",
        toValue: c.status as string,
        note: "Resolved by ops team.",
        actorId: adminId,
        actorName: "Super Admin",
        createdAt: c.resolvedAt as Date,
      });
    }
    // A few escalations on breached/critical unresolved complaints.
    if (c.slaBreach || (c.priority === "CRITICAL" && !c.resolvedAt)) {
      escRows.push({
        id: `demo_esc_${c.id}`,
        complaintId: c.id as string,
        level: 1,
        escalatedTo: adminId,
        reason: "SLA breach / critical priority.",
        createdAt: new Date((c.createdAt as Date).getTime() + 6 * 3_600_000),
      });
    }
  });
  await insertChunked(complaintEventsTable, cEventRows, "complaint_events");
  await insertChunked(escalationsTable, escRows, "escalations");

  /* ── 10. LAUNDRY (~120 batches, last 90 days) ────────────────────────────── */
  console.log("• laundry...");
  type LaundryRow = typeof laundryBatchesTable.$inferInsert;
  const laundryRows: LaundryRow[] = [];
  const L_STATUSES = ["RECEIVED", "IN_WASH", "READY", "PICKED_UP", "DAMAGED"] as const;
  const allResidentList = residentRows.map((r) => ({ id: r.id as string, propId: r.propertyId as string }));
  for (let i = 0; i < 120; i++) {
    const res = allResidentList[i % allResidentList.length]!;
    const drop = daysAgo(rint(0, 90));
    const status = wpick<(typeof L_STATUSES)[number]>([
      ["PICKED_UP", 45], ["READY", 20], ["IN_WASH", 18], ["RECEIVED", 12], ["DAMAGED", 5],
    ]);
    laundryRows.push({
      id: `demo_laundry_${i}`,
      batchNo: `DEMO-LND-${String(70000 + i)}`,
      residentId: res.id,
      propertyId: res.propId,
      dropDate: drop,
      commitTatDays: 2,
      items: { shirts: rint(2, 6), trousers: rint(1, 4), bedsheets: rint(1, 2), towels: rint(1, 3) },
      status,
      pickedUpAt: status === "PICKED_UP" ? new Date(drop.getTime() + 2 * 86_400_000) : null,
      createdBy: adminId,
      createdAt: drop,
      updatedAt: new Date(),
    });
  }
  await insertChunked(laundryBatchesTable, laundryRows, "laundry_batches");

  /* ── 11. PROCUREMENT (inventory / expenses / PO / GRN / indents) ─────────── */
  console.log("• procurement...");
  // Resolve existing vendors + expense categories.
  const vendors = (await pool.query(`SELECT id, name FROM vendors ORDER BY id`)).rows as Array<{ id: string; name: string }>;
  const expCats = (await pool.query(`SELECT id, name FROM expense_categories ORDER BY name`)).rows as Array<{ id: string; name: string }>;

  // Inventory ~60 items, ~8-10 at/below min_stock (low-stock alert).
  type InvRow = typeof inventoryTable.$inferInsert;
  const invRows: InvRow[] = [];
  const INV_CATS = ["Groceries", "Housekeeping", "Maintenance", "Stationery", "Toiletries", "Linen"];
  const INV_UNITS = ["KG", "L", "PCS", "BOX", "PKT"];
  const INV_NAMES = [
    "Rice", "Wheat Flour", "Cooking Oil", "Detergent", "Phenyl", "Toilet Paper",
    "Hand Wash", "Bedsheets", "Pillow Covers", "Light Bulbs", "Tube Lights",
    "Bath Towels", "Cleaning Cloth", "Garbage Bags", "Sugar", "Tea Powder",
    "Salt", "Spices Mix", "Dishwash Liquid", "Floor Cleaner",
  ];
  for (let i = 0; i < 60; i++) {
    const lowStock = i < 9; // first 9 are at/below min
    const minStock = rint(10, 30);
    const current = lowStock ? rint(0, minStock) : rint(minStock + 5, minStock + 100);
    invRows.push({
      id: `demo_inv_${i}`,
      propertyId: propIdList[i % propIdList.length]!,
      name: `${INV_NAMES[i % INV_NAMES.length]}${i >= INV_NAMES.length ? ` (${INV_CATS[i % INV_CATS.length]})` : ""}`,
      sku: `DEMO-SKU-${String(i).padStart(4, "0")}`,
      category: INV_CATS[i % INV_CATS.length]!,
      unit: INV_UNITS[i % INV_UNITS.length]!,
      currentStock: String(current),
      minStock: String(minStock),
      unitCost: String(rint(20, 500)),
      location: `Store ${(i % 3) + 1}`,
      updatedAt: new Date(),
    });
  }
  await insertChunked(inventoryTable, invRows, "inventory");

  // Expenses ~300 across 18 months, mixed categories.
  type ExpRow = typeof expensesTable.$inferInsert;
  const expRows: ExpRow[] = [];
  const EXP_STATUSES = ["SUBMITTED", "APPROVED", "REJECTED", "PAID"] as const;
  for (let i = 0; i < 300; i++) {
    const cat = expCats[i % expCats.length];
    const date = daysAgo(rint(0, WINDOW_DAYS));
    const status = wpick<(typeof EXP_STATUSES)[number]>([
      ["PAID", 50], ["APPROVED", 25], ["SUBMITTED", 18], ["REJECTED", 7],
    ]);
    expRows.push({
      id: `demo_exp_${i}`,
      categoryId: cat?.id ?? null,
      propertyId: propIdList[i % propIdList.length]!,
      vendor: vendors.length ? vendors[i % vendors.length]!.name : "Misc Vendor",
      amount: String(rint(500, 50000)),
      expenseDate: date,
      description: `${cat?.name ?? "Misc"} expense #${i}`,
      reference: `DEMO-EXP-${i}`,
      status,
      submittedBy: adminId,
      reviewedBy: status === "SUBMITTED" ? null : adminId,
      reviewedAt: status === "SUBMITTED" ? null : new Date(date.getTime() + 86_400_000),
      paidAt: status === "PAID" ? new Date(date.getTime() + 3 * 86_400_000) : null,
      createdAt: date,
      updatedAt: new Date(),
    });
  }
  await insertChunked(expensesTable, expRows, "expenses");

  // Indents ~30, PO ~40, GRN ~30 — lifecycle statuses mixed, linked to vendors/properties.
  type IndentRow = typeof indentsTable.$inferInsert;
  const indentRows: IndentRow[] = [];
  const INDENT_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "PO_RAISED", "DELIVERED"] as const;
  for (let i = 0; i < 30; i++) {
    const created = daysAgo(rint(0, WINDOW_DAYS));
    const status = pick(INDENT_STATUSES);
    indentRows.push({
      id: `demo_indent_${i}`,
      indentNumber: `DEMO-IND-${String(i).padStart(4, "0")}`,
      propertyId: propIdList[i % propIdList.length]!,
      department: pick(DEPARTMENTS),
      items: [
        { name: pick(INV_NAMES), qty: rint(5, 50), unit: pick(INV_UNITS) },
        { name: pick(INV_NAMES), qty: rint(5, 50), unit: pick(INV_UNITS) },
      ],
      totalEstimatedValue: String(rint(2000, 60000)),
      status,
      urgency: pick(["LOW", "NORMAL", "HIGH"]),
      purpose: "Routine restock",
      approvedBy: ["APPROVED", "PO_RAISED", "DELIVERED"].includes(status) ? adminId : null,
      approvedAt: ["APPROVED", "PO_RAISED", "DELIVERED"].includes(status) ? new Date(created.getTime() + 86_400_000) : null,
      submittedAt: status !== "DRAFT" ? created : null,
      createdBy: adminId,
      createdAt: created,
      updatedAt: new Date(),
    });
  }
  await insertChunked(indentsTable, indentRows, "indents");

  type PORow = typeof purchaseOrdersTable.$inferInsert;
  const poRows: PORow[] = [];
  const PO_STATUSES = ["DRAFT", "SENT", "ACKNOWLEDGED", "PARTIAL_DELIVERY", "DELIVERED", "CANCELLED"] as const;
  for (let i = 0; i < 40; i++) {
    const vendor = vendors[i % Math.max(1, vendors.length)];
    const created = daysAgo(rint(0, WINDOW_DAYS));
    const status = pick(PO_STATUSES);
    const subtotal = rint(5000, 80000);
    const gst = Math.floor(subtotal * 0.18);
    poRows.push({
      id: `demo_po_${i}`,
      poNumber: `DEMO-PO-${String(i).padStart(4, "0")}`,
      vendorId: vendor?.id ?? null as never,
      propertyId: propIdList[i % propIdList.length]!,
      indentId: i < 30 ? `demo_indent_${i}` : null,
      items: [
        { name: pick(INV_NAMES), qty: rint(10, 100), rate: rint(20, 500) },
        { name: pick(INV_NAMES), qty: rint(10, 100), rate: rint(20, 500) },
      ],
      subtotal: String(subtotal),
      gstApplicable: true,
      gstAmount: String(gst),
      totalAmount: String(subtotal + gst),
      paymentTerms: pick(["NET 15", "NET 30", "ADVANCE"]),
      status,
      approvedBy: status === "DRAFT" ? null : adminId,
      deliveryDate: new Date(created.getTime() + 7 * 86_400_000),
      sentAt: status === "DRAFT" ? null : new Date(created.getTime() + 86_400_000),
      createdAt: created,
      updatedAt: new Date(),
    });
  }
  await insertChunked(purchaseOrdersTable, poRows, "purchase_orders");

  type GRNRow = typeof grnTable.$inferInsert;
  const grnRows: GRNRow[] = [];
  for (let i = 0; i < 30; i++) {
    const created = daysAgo(rint(0, WINDOW_DAYS - 7));
    const qcPass = i % 8 !== 0;
    grnRows.push({
      id: `demo_grn_${i}`,
      grnNumber: `DEMO-GRN-${String(i).padStart(4, "0")}`,
      poId: `demo_po_${i}`,
      propertyId: propIdList[i % propIdList.length]!,
      items: [
        { name: pick(INV_NAMES), orderedQty: rint(10, 100), receivedQty: rint(8, 100) },
      ],
      invoiceNumber: `DEMO-INV-${String(i).padStart(4, "0")}`,
      qcPass,
      qcNotes: qcPass ? "All items received in good condition." : "Some items damaged; partial acceptance.",
      status: qcPass ? "ACCEPTED" : "PENDING_QC",
      receivedBy: adminId,
      createdAt: created,
      updatedAt: new Date(),
    });
  }
  await insertChunked(grnTable, grnRows, "grns");

  /* ── 12. FOOD ORDERS + ITEMS (CRITICAL for food analytics) ───────────────── */
  console.log("• food orders + items (this is the heaviest table)...");
  // Resolve dishes per (brand-agnostic) component for item generation.
  const dishes = (await pool.query(
    `SELECT id, component, unit FROM dishes WHERE id LIKE 'dish_%' AND is_active = true ORDER BY id`,
  )).rows as Array<{ id: string; component: string; unit: string }>;
  // Prefer "main" components so items look like real meal lines.
  const MAIN_COMPONENTS = ["HOT_FOOD", "SABZI", "DAL", "RICE", "BREAD", "DESSERT", "SNACK"];
  const mainDishes = dishes.filter((d) => MAIN_COMPONENTS.includes(d.component));
  const dishPool = mainDishes.length >= 4 ? mainDishes : dishes;

  const MEALS = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;
  // service time of day per meal (for deliveredAt / expectedDeliveryAt).
  const MEAL_HOUR = { BREAKFAST: 8, LUNCH: 12, SNACKS: 17, DINNER: 20 } as const;
  type OrderStatus = "PLACED" | "ACCEPTED" | "REJECTED" | "PREPARING" | "DISPATCHED" | "DELIVERED" | "CANCELLED";
  const ORDER_STATUS_WEIGHTS: readonly [OrderStatus, number][] = [
    ["DELIVERED", 80], ["DISPATCHED", 8], ["PLACED", 5], ["PREPARING", 2], ["ACCEPTED", 1], ["CANCELLED", 2], ["REJECTED", 2],
  ];

  type FOrderRow = typeof foodOrdersTable.$inferInsert;
  type FItemRow = typeof foodOrderItemsTable.$inferInsert;
  type FEventRow = typeof foodOrderEventsTable.$inferInsert;
  const orderRows: FOrderRow[] = [];
  const itemRows: FItemRow[] = [];
  const eventRows: FEventRow[] = [];
  let orderSeq = 0;

  for (const p of allProps) {
    const unitLeadId = ulByProp[p.id] ?? anyUnitLead;
    if (!unitLeadId) continue; // cannot create an order without a unit lead FK
    const kitchenId = p.kitchen_id;
    const residentsCount = Math.max(10, Math.floor(p.total_beds * 0.7));
    for (let d = 0; d < WINDOW_DAYS; d++) {
      const dense = d < DENSE_DAYS;
      if (!dense && d % FOOD_SPARSE_EVERY !== 0) continue; // sparser beyond dense window
      const serviceDateObj = daysAgo(d);
      const serviceDateStr = ymd(serviceDateObj);
      for (const meal of MEALS) {
        // In sparse region, only place LUNCH + DINNER to cap volume.
        if (!dense && (meal === "BREAKFAST" || meal === "SNACKS")) continue;
        orderSeq += 1;
        const orderId = `demo_order_${p.id}_${serviceDateStr.replace(/-/g, "")}_${meal}`;
        const status = wpick<OrderStatus>(ORDER_STATUS_WEIGHTS);
        const isDelivered = status === "DELIVERED";
        const isDispatched = status === "DISPATCHED" || isDelivered;
        const isPreparing = status === "PREPARING" || isDispatched;
        const isCancelled = status === "CANCELLED";
        const isRejected = status === "REJECTED";

        const svcHour = MEAL_HOUR[meal];
        const serviceMoment = atTime(serviceDateObj, svcHour, 0);
        const expectedDeliveryAt = new Date(serviceMoment.getTime());
        // ~15% late vs expected
        const late = isDelivered && rng() < 0.15;
        const deliveredAt = isDelivered
          ? new Date(expectedDeliveryAt.getTime() + (late ? rint(20, 90) : -rint(0, 20)) * 60_000)
          : null;
        const createdAt = new Date(serviceDateObj.getTime() - 12 * 3_600_000); // placed day before/morning of

        // Build 2-4 items.
        const nItems = rint(FOOD_ITEMS_MIN, FOOD_ITEMS_MAX);
        let totalQty = 0;
        const chosen: typeof dishPool = [];
        for (let k = 0; k < nItems; k++) chosen.push(dishPool[(orderSeq + k) % dishPool.length]!);
        for (let k = 0; k < chosen.length; k++) {
          const dish = chosen[k]!;
          const orderedQty = Math.round(residentsCount * (0.1 + rng() * 0.1) * 1000) / 1000;
          totalQty += orderedQty;
          const preparedQty = isDispatched ? orderedQty : null;
          // received ≈ ordered, occasionally less; wasted non-zero on ~30% of items
          const shortfall = isDelivered && rng() < 0.2 ? Math.round(orderedQty * (rng() * 0.1) * 1000) / 1000 : 0;
          const receivedQty = isDelivered ? Math.round((orderedQty - shortfall) * 1000) / 1000 : null;
          const wasted = isDelivered && rng() < 0.3 ? Math.round(orderedQty * (0.02 + rng() * 0.08) * 1000) / 1000 : (isDelivered ? 0 : null);
          itemRows.push({
            id: `${orderId}_item_${k}`,
            orderId,
            dishId: dish.id,
            unit: dish.unit as never,
            orderedQty: String(orderedQty),
            personsCount: residentsCount,
            preparedQty: preparedQty !== null ? String(preparedQty) : null,
            receivedQty: receivedQty !== null ? String(receivedQty) : null,
            wastedQty: wasted !== null ? String(wasted) : null,
            createdAt,
            updatedAt: new Date(),
          });
        }

        orderRows.push({
          id: orderId,
          // Deterministic + unique per (date, meal, property) → re-run-safe (no volatile
          // counter that could shift across runs and collide on the unique constraint).
          orderNumber: `DEMO-${serviceDateStr.replace(/-/g, "")}-${meal.slice(0, 3)}-P${String(propIdx.get(p.id) ?? 0).padStart(3, "0")}`,
          propertyId: p.id,
          brand: p.brand,
          mealType: meal,
          unitLeadId,
          residentsCount,
          totalQuantity: String(Math.round(totalQty * 1000) / 1000),
          status,
          serviceDate: istDayStart(serviceDateStr),
          notes: null,
          dispatchedById: isDispatched ? (fnbSup ?? unitLeadId) : null,
          dispatchStartedAt: isDispatched ? new Date(serviceMoment.getTime() - 2 * 3_600_000) : null,
          dispatchedAt: isDispatched ? new Date(serviceMoment.getTime() - 90 * 60_000) : null,
          confirmedById: isDelivered ? unitLeadId : null,
          deliveredAt,
          deliveryRemarks: isDelivered ? "Delivered, verified by unit lead." : null,
          wasteEditableUntil: deliveredAt ? new Date(deliveredAt.getTime() + 3_600_000) : null,
          preparingAt: isPreparing ? new Date(serviceMoment.getTime() - 4 * 3_600_000) : null,
          cancelledAt: isCancelled ? createdAt : null,
          cancelReason: isCancelled ? "Resident count dropped." : null,
          rejectedAt: isRejected ? createdAt : null,
          rejectionReason: isRejected ? "Kitchen capacity exceeded." : null,
          acceptedById: status === "ACCEPTED" || isPreparing ? (fnbSup ?? unitLeadId) : null,
          acceptedAt: status === "ACCEPTED" || isPreparing ? new Date(serviceMoment.getTime() - 6 * 3_600_000) : null,
          kitchenId,
          expectedDeliveryAt,
          createdById: unitLeadId,
          createdAt,
          updatedAt: new Date(),
        });

        // Lifecycle events (lightweight: placed + terminal).
        eventRows.push({ id: `${orderId}_e_placed`, orderId, status: "PLACED", note: "Order placed.", actorId: unitLeadId, createdAt });
        if (isDelivered) eventRows.push({ id: `${orderId}_e_delivered`, orderId, status: "DELIVERED", note: "Delivered.", actorId: unitLeadId, createdAt: deliveredAt! });
        else if (isCancelled) eventRows.push({ id: `${orderId}_e_cancelled`, orderId, status: "CANCELLED", note: "Cancelled.", actorId: unitLeadId, createdAt });
        else if (isRejected) eventRows.push({ id: `${orderId}_e_rejected`, orderId, status: "REJECTED", note: "Rejected.", actorId: fnbSup ?? unitLeadId, createdAt });
      }
    }
  }
  console.log(`  … generated ${orderRows.length} orders / ${itemRows.length} items in memory; inserting…`);
  await insertChunked(foodOrdersTable, orderRows, "food_orders");
  await insertChunked(foodOrderItemsTable, itemRows, "food_order_items");
  await insertChunked(foodOrderEventsTable, eventRows, "food_order_events");

  /* ── 13. FINANCE billing_cycles ──────────────────────────────────────────── */
  console.log("• finance billing_cycles...");
  type CycleRow = typeof billingCyclesTable.$inferInsert;
  const cycleRows: CycleRow[] = [
    {
      id: "demo_cycle_global_rent",
      name: "Global Monthly Rent",
      propertyId: null,
      cadence: "MONTHLY",
      dayOfMonth: 5,
      ledgerType: "RENT",
      descriptionTemplate: "Rent for {{month}}",
      isActive: true,
      lastRunAt: daysAgo(rint(1, 25)),
      createdBy: adminId,
      createdAt: daysAgo(WINDOW_DAYS),
      updatedAt: new Date(),
    },
  ];
  // a couple per-property cycles
  for (let i = 0; i < 2 && i < allProps.length; i++) {
    const p = allProps[i]!;
    cycleRows.push({
      id: `demo_cycle_prop_${p.id}`,
      name: `${p.name} Monthly Rent`,
      propertyId: p.id,
      cadence: "MONTHLY",
      dayOfMonth: 1,
      ledgerType: "RENT",
      descriptionTemplate: "Rent for {{month}}",
      isActive: true,
      lastRunAt: daysAgo(rint(1, 25)),
      createdBy: adminId,
      createdAt: daysAgo(WINDOW_DAYS - 30),
      updatedAt: new Date(),
    });
  }
  await insertChunked(billingCyclesTable, cycleRows, "billing_cycles");

  /* ── Property photos — every property card should show an image ───────────── */
  console.log("• property photos (ensure every property has a hero image)...");
  // Reuse already-uploaded property photos (from import:uniliv) as the hero for any
  // property that has none, so all cards show an image. No-op (graceful) if there's
  // no photo pool yet — run import:uniliv first to populate real photos.
  await pool.query(`
    WITH heroes AS (SELECT storage_key, content_type, row_number() OVER (ORDER BY id) rn FROM property_photos WHERE is_hero),
    hc AS (SELECT count(*) c FROM heroes),
    photoless AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM properties p WHERE NOT EXISTS (SELECT 1 FROM property_photos pp WHERE pp.property_id=p.id))
    INSERT INTO property_photos (id, property_id, storage_key, content_type, is_hero, sort_order, source_url, created_at)
    SELECT gen_random_uuid()::text, pl.id, h.storage_key, h.content_type, true, 0, 'demo-reuse', now()
    FROM photoless pl CROSS JOIN hc JOIN heroes h ON h.rn = ((pl.rn - 1) % NULLIF(hc.c, 0)) + 1`);
  // Ensure every property that has photos has exactly one hero (so heroImageUrl resolves).
  await pool.query(`
    WITH pick AS (SELECT DISTINCT ON (pp.property_id) pp.id FROM property_photos pp
      WHERE NOT EXISTS (SELECT 1 FROM property_photos h WHERE h.property_id = pp.property_id AND h.is_hero)
      ORDER BY pp.property_id, pp.sort_order, pp.id)
    UPDATE property_photos SET is_hero = true WHERE id IN (SELECT id FROM pick)`);
  const { rows: photoGap } = await pool.query(`SELECT count(*)::int c FROM properties p WHERE NOT EXISTS (SELECT 1 FROM property_photos pp WHERE pp.property_id = p.id)`);
  console.log(`  ✓ property photos ensured (${(photoGap[0] as { c: number }).c} still without a photo — run import:uniliv to populate the pool)`);

  console.log("✅ Demo data seeded.");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Calendar helpers (defined after main for readability; hoisted)
 * ──────────────────────────────────────────────────────────────────────────── */
/** N months ago, on the given day-of-month (clamped), local time. */
function monthsAgo(n: number, day: number): Date {
  const d = new Date(TODAY_Y, TODAY_M - n, 1, 10, 0, 0, 0);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}
/** A day in the CURRENT calendar month. */
function thisMonthDay(day: number): Date {
  const lastDay = new Date(TODAY_Y, TODAY_M + 1, 0).getDate();
  return new Date(TODAY_Y, TODAY_M, Math.min(day, lastDay), 11, 0, 0, 0);
}
/** Whole months between a and b (a <= b). */
function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Demo seed failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });

// keep `sql` import referenced (used implicitly if needed); avoids unused-var lint
void sql;
