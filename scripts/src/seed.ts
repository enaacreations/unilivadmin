import { db, pool } from "@workspace/db";
import {
  // core
  usersTable, propertiesTable, roomsTable, residentsTable,
  ledgerEntriesTable, paymentsTable, complaintsTable, complaintEventsTable,
  escalationsTable, laundryBatchesTable, messageTemplatesTable,
  communicationLogsTable, announcementsTable, bookingsTable,
  // hrms
  employeesTable, attendanceTable, leavesTable, leaveBalancesTable,
  performanceNotesTable, jobRequisitionsTable, candidatesTable,
  interviewsTable, offersTable, exitsTable, exitClearancesTable, exitAssetsTable,
  // procurement
  vendorsTable, rateContractsTable, vendorDocumentsTable,
  indentsTable, purchaseOrdersTable, grnTable, inventoryTable, stockMovementsTable,
  // kitchen
  recipesTable, menuPlansTable, dailyProductionTable, recipeFeedbackTable,
  // sales
  leadsTable, leadActivitiesTable, propertyLeadsTable,
  // lnd
  coursesTable, courseEnrollmentsTable,
  // system
  notificationsTable, auditLogTable, slaConfigTable,
  complaintRoutingTable, integrationStatusTable,
  // kyc
  kycRequestsTable, kycEventsTable, esignRequestsTable, esignEventsTable,
  // finance
  billingCyclesTable, billingRunsTable, reminderRulesTable, reminderLogsTable,
  bankImportsTable, bankStatementLinesTable, expenseCategoriesTable,
  expensesTable, expenseEventsTable,
  // operations
  facilityAssetsTable, facilitySchedulesTable, facilityLogsTable,
  electricityTariffsTable, electricityMetersTable, electricityReadingsTable,
  residentAttendanceTable, outPassesTable, iotDevicesTable, iotReadingsTable,
} from "@workspace/db";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

const id = () => randomUUID();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

async function main() {
  console.log("🌱 Seeding database with 50+ rows per table...");

  // ─── TRUNCATE ALL TABLES (reverse FK order) ───────────────────────────────
  // This makes the script safe to re-run: clean state every time.
  console.log("  truncating existing data...");
  await pool.query(`
    TRUNCATE TABLE
      iot_readings, iot_devices,
      out_passes, resident_attendance,
      electricity_readings, electricity_meters, electricity_tariffs,
      facility_logs, facility_schedules, facility_assets,
      expense_events, expenses, expense_categories,
      bank_statement_lines, bank_imports,
      reminder_logs, reminder_rules,
      billing_runs, billing_cycles,
      esign_events, esign_requests,
      kyc_events, kyc_requests,
      integration_status, complaint_routing, sla_config,
      audit_log, notifications,
      course_enrollments, courses,
      lead_activities, leads, property_leads,
      recipe_feedback, daily_production, menu_plans, recipes,
      stock_movements, inventory, grns,
      purchase_orders, indents,
      vendor_documents, rate_contracts, vendors,
      exit_assets, exit_clearances, exits,
      candidates, job_requisitions,
      interviews, offers,
      performance_notes, leave_balances, leaves, attendance,
      employees,
      bookings, announcements, communication_logs, message_templates,
      laundry_batches, escalations, complaint_events, complaints,
      payments, ledger_entries,
      residents, rooms, properties,
      refresh_tokens, users
    RESTART IDENTITY CASCADE
  `);

  // ─── USERS ────────────────────────────────────────────────────────────────
  console.log("  users...");
  const adminId       = id();
  const financeUserId = id();
  const hrUserId      = id();
  const opsUserId     = id();
  const salesUserId   = id();
  const procUserId    = id();
  const kitchenUserId = id();
  const wardenUserId  = id();

  const adminHash = await bcrypt.hash("Admin@123", 10);
  await db.insert(usersTable).values([
    { id: adminId,       name: "Super Admin",    email: "admin@uniliv.com",   role: "SUPER_ADMIN" as const,           passwordHash: adminHash, isActive: true, updatedAt: new Date() },
    { id: financeUserId, name: "Ravi Shankar",   email: "finance@uniliv.com", role: "FINANCE" as const,               passwordHash: adminHash, isActive: true, updatedAt: new Date() },
    { id: hrUserId,      name: "Lakshmi Iyer",   email: "hr@uniliv.com",      role: "HR_MANAGER" as const,            passwordHash: adminHash, isActive: true, updatedAt: new Date() },
    { id: opsUserId,     name: "Priya Sharma",   email: "ops@uniliv.com",     role: "OPERATIONS_MANAGER" as const,    passwordHash: adminHash, isActive: true, updatedAt: new Date() },
    { id: salesUserId,   name: "Dev Malhotra",   email: "sales@uniliv.com",   role: "SALES_EXECUTIVE" as const,       passwordHash: adminHash, isActive: true, updatedAt: new Date() },
    { id: procUserId,    name: "Ramesh Hegde",   email: "proc@uniliv.com",    role: "PROCUREMENT_MANAGER" as const,   passwordHash: adminHash, isActive: true, updatedAt: new Date() },
    { id: kitchenUserId, name: "Anita Desai",    email: "kitchen@uniliv.com", role: "KITCHEN_MANAGER" as const,       passwordHash: adminHash, isActive: true, updatedAt: new Date() },
    { id: wardenUserId,  name: "Suresh Kumar",   email: "warden@uniliv.com",  role: "WARDEN" as const,                passwordHash: adminHash, isActive: true, updatedAt: new Date() },
    { id: id(),          name: "Vikram Bose",    email: "vikram@uniliv.com",  role: "OPERATIONS_MANAGER" as const,    passwordHash: adminHash, isActive: true, updatedAt: new Date() },
    { id: id(),          name: "Kavya Nambiar",  email: "kavya@uniliv.com",   role: "AUDIT_READONLY" as const,        passwordHash: adminHash, isActive: true, updatedAt: new Date() },
  ]);

  // ─── PROPERTIES ───────────────────────────────────────────────────────────
  console.log("  properties...");
  const prop1Id = id(), prop2Id = id(), prop3Id = id(), prop4Id = id(), prop5Id = id();
  await db.insert(propertiesTable).values([
    { id: prop1Id, name: "UNILIV Koramangala", address: "14, 5th Block, Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560034", totalBeds: 120, status: "ACTIVE", portfolioType: "CO_LIVING",          portfolioAttributes: { gender: "COED", mealPlanIncluded: true }, phone: "9876543210", email: "koramangala@uniliv.com", amenities: ["WiFi","Laundry","Gym","Cafeteria","CCTV"], updatedAt: new Date() },
    { id: prop2Id, name: "UNILIV Whitefield",  address: "23, ITPL Main Road",         city: "Bengaluru", state: "Karnataka", pincode: "560066", totalBeds: 80,  status: "ACTIVE", portfolioType: "STUDENT_HOUSING",    portfolioAttributes: { institutionAffiliation: "ITPL Colleges", academicYear: "2024-25", gender: "MALE" }, phone: "9876543211", email: "whitefield@uniliv.com", amenities: ["WiFi","Laundry","AC Rooms"], updatedAt: new Date() },
    { id: prop3Id, name: "UNILIV Baner",       address: "7, Baner Road",              city: "Pune",      state: "Maharashtra", pincode: "411045", totalBeds: 60, status: "ACTIVE", portfolioType: "PG",                portfolioAttributes: { gender: "FEMALE", mealPlanIncluded: false }, phone: "9876543212", email: "baner@uniliv.com", amenities: ["WiFi","Laundry","Gym"], updatedAt: new Date() },
    { id: prop4Id, name: "UNILIV Skyview SA",  address: "88, Residency Road",         city: "Bengaluru", state: "Karnataka", pincode: "560025", totalBeds: 40,  status: "ACTIVE", portfolioType: "SERVICED_APARTMENTS", portfolioAttributes: { nightlyRate: 2500, weeklyRate: 15000, leaseTermMonths: 1 }, phone: "9876543213", email: "skyview@uniliv.com", amenities: ["WiFi","Housekeeping","Breakfast"], updatedAt: new Date() },
    { id: prop5Id, name: "UNILIV CoWork Hub",  address: "12, MG Road",                city: "Bengaluru", state: "Karnataka", pincode: "560001", totalBeds: 0,   status: "ACTIVE", portfolioType: "COWORKING",           portfolioAttributes: { deskCapacity: 80, privateOfficeCount: 10, seatCapacity: 120 }, phone: "9876543214", email: "mgroad@uniliv.com", amenities: ["WiFi","Pantry","Meeting Rooms"], updatedAt: new Date() },
  ]).onConflictDoNothing();
  const propIds = [prop1Id, prop2Id, prop3Id, prop4Id, prop5Id];

  // ─── ROOMS ────────────────────────────────────────────────────────────────
  console.log("  rooms...");
  const roomTypes = ["SINGLE","DOUBLE","TRIPLE","DORMITORY"] as const;
  const roomStatuses = ["OCCUPIED","OCCUPIED","OCCUPIED","VACANT","MAINTENANCE"] as const;
  const roomIds: string[] = [];
  const roomRows = [];
  for (let i = 0; i < 50; i++) {
    const rId = id();
    roomIds.push(rId);
    const propId = propIds[i % 4]!; // skip prop5 (coworking has no beds)
    roomRows.push({
      id: rId, propertyId: propId,
      number: `${Math.floor(i / 10) + 1}0${(i % 10) + 1}`,
      floor: Math.floor(i / 10) + 1, wing: i % 2 === 0 ? "A" : "B",
      type: roomTypes[i % 4]!, capacity: [1,2,3,6][i % 4]!,
      status: roomStatuses[i % 5]!, updatedAt: new Date(),
    });
  }
  await db.insert(roomsTable).values(roomRows).onConflictDoNothing();

  // ─── RESIDENTS ────────────────────────────────────────────────────────────
  console.log("  residents...");
  const residentNames = [
    "Arjun Mehta","Sneha Rao","Karan Singh","Divya Nair","Rahul Gupta",
    "Priya Patel","Aditya Sharma","Meera Krishnan","Rohan Verma","Sunita Joshi",
    "Amit Kumar","Pooja Iyer","Vikram Das","Deepa Menon","Siddharth Reddy",
    "Ananya Sen","Nikhil Joshi","Ritu Agarwal","Varun Nair","Shruti Pillai",
    "Tarun Bhat","Kavita Rao","Mohit Saxena","Poonam Singh","Rajesh Dubey",
    "Madhuri Deshpande","Vivek Goyal","Swati Kulkarni","Harish Tiwari","Nalini Bose",
    "Suraj Pandey","Asha Puri","Gaurav Mishra","Tanya Srivastava","Rajan Khanna",
    "Bhavna Choudhary","Abhinav Jain","Smita Ghosh","Piyush Bajaj","Reena Malhotra",
    "Shyam Verma","Nandini Kapoor","Alok Trivedi","Chitra Mukherjee","Dinesh Patil",
    "Prerna Sharma","Kiran Yadav","Manoj Tomar","Jyoti Prakash","Lalit Agnihotri",
  ];
  const residentIds: string[] = [];
  const residentPropIds: string[] = [];
  for (let i = 0; i < 50; i++) {
    const rId = id();
    residentIds.push(rId);
    const propId = propIds[i % 4]!;
    residentPropIds.push(propId);
    const roomId = roomIds[i] ?? null;
    const statuses = ["ACTIVE","ACTIVE","ACTIVE","ACTIVE","NOTICE_PERIOD","CHECKED_OUT"] as const;
    await db.insert(residentsTable).values({
      id: rId, propertyId: propId, roomId,
      name: residentNames[i]!, email: `resident${i + 1}@example.com`,
      phone: `98100${String(i).padStart(5,"0")}`,
      gender: i % 3 === 0 ? "Female" : "Male",
      college: ["IIT Bengaluru","BITS Pilani","NIT Karnataka","Christ University","PES University"][i % 5]!,
      course: ["B.Tech CS","MBA","B.Com","M.Tech","BBA"][i % 5]!,
      parentName: `Parent of ${residentNames[i]}`,
      parentPhone: `97200${String(i).padStart(5,"0")}`,
      checkInDate: daysAgo(300 - i * 3),
      monthlyRent: String(10000 + (i % 5) * 2500),
      securityDeposit: String(20000 + (i % 3) * 5000),
      status: statuses[i % 6]!,
      dietaryPref: i % 3 === 0 ? ["Vegetarian"] : ["Non-Vegetarian"],
      allergies: [], updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── LEDGER ENTRIES ───────────────────────────────────────────────────────
  console.log("  ledger entries...");
  const ledgerIds: string[] = [];
  const ledgerTypes = ["RENT","FOOD","LAUNDRY","UTILITY","PENALTY","DEPOSIT"] as const;
  for (let i = 0; i < 50; i++) {
    const lid = id();
    ledgerIds.push(lid);
    const lType = ledgerTypes[i % 6]!;
    const isPaid = i % 3 !== 0;
    await db.insert(ledgerEntriesTable).values({
      id: lid, residentId: residentIds[i % 50]!,
      type: lType, amount: String(5000 + (i % 10) * 1000),
      description: `${lType} charge — ${["Jan","Feb","Mar","Apr","May"][i % 5]} 2026`,
      dueDate: daysAgo(30 - i), isPaid,
      paidOn: isPaid ? daysAgo(25 - i) : null,
      reference: isPaid ? `TXN${100000 + i}` : null,
      createdBy: adminId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── PAYMENTS ─────────────────────────────────────────────────────────────
  console.log("  payments...");
  const payModes = ["UPI","NETBANKING","CARD","CASH","BANK_TRANSFER"] as const;
  const payStatuses = ["SUCCESS","SUCCESS","SUCCESS","PENDING","FAILED"] as const;
  for (let i = 0; i < 50; i++) {
    await db.insert(paymentsTable).values({
      id: id(), residentId: residentIds[i % 50]!,
      amount: String(5000 + (i % 8) * 1500),
      mode: payModes[i % 5]!, status: payStatuses[i % 5]!,
      reference: `PAY-${200000 + i}`,
      notes: `Payment ${i + 1} for ${["January","February","March","April","May"][i % 5]} 2026`,
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── COMPLAINTS ───────────────────────────────────────────────────────────
  console.log("  complaints...");
  const cats = ["ELECTRICAL","PLUMBING","HOUSEKEEPING","INTERNET","SECURITY","FOOD","LAUNDRY","OTHER"] as const;
  const cStatuses = ["OPEN","ASSIGNED","IN_PROGRESS","RESOLVED","CLOSED"] as const;
  const prios = ["LOW","MEDIUM","HIGH","CRITICAL"] as const;
  const complaintIds: string[] = [];
  for (let i = 0; i < 50; i++) {
    const cId = id();
    complaintIds.push(cId);
    const cat = cats[i % 8]!;
    const status = cStatuses[i % 5]!;
    await db.insert(complaintsTable).values({
      id: cId, propertyId: propIds[i % 5]!, residentId: residentIds[i % 50]!,
      ticketNo: `TKT-${20000 + i}`, category: cat,
      title: [
        "Power outage in room","Leaking tap in washroom","Common area not cleaned",
        "WiFi not working","Gate lock broken","Food quality poor",
        "Laundry items missing","AC not functioning",
      ][i % 8]!,
      description: `Resident reported issue on ${daysAgo(i).toDateString()}. Needs urgent attention.`,
      priority: prios[i % 4]!, status,
      slaHours: [4,8,24,48][i % 4]!,
      slaDeadline: daysFromNow(1),
      slaBreach: i % 7 === 0,
      resolvedAt: status === "RESOLVED" || status === "CLOSED" ? daysAgo(1) : null,
      resolutionNote: status === "CLOSED" ? "Issue resolved and verified by resident." : null,
      rating: status === "CLOSED" ? (3 + (i % 3)) : null,
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── COMPLAINT EVENTS ─────────────────────────────────────────────────────
  console.log("  complaint events...");
  for (let i = 0; i < 50; i++) {
    await db.insert(complaintEventsTable).values({
      id: id(), complaintId: complaintIds[i % 50]!,
      type: ["CREATED","STATUS_CHANGE","ASSIGNED","COMMENT","RESOLVED"][i % 5]!,
      fromValue: ["OPEN","ASSIGNED"][i % 2],
      toValue: ["ASSIGNED","IN_PROGRESS","RESOLVED"][i % 3],
      note: `Event ${i + 1}: Status updated by operations team.`,
      actorId: adminId, actorName: "Super Admin",
    }).onConflictDoNothing();
  }

  // ─── ESCALATIONS ──────────────────────────────────────────────────────────
  console.log("  escalations...");
  for (let i = 0; i < 10; i++) {
    await db.insert(escalationsTable).values({
      id: id(), complaintId: complaintIds[i]!,
      level: (i % 3) + 1,
      escalatedTo: adminId,
      reason: ["SLA breach","No response","Resident escalation","Repeat complaint"][i % 4]!,
    }).onConflictDoNothing();
  }

  // ─── LAUNDRY BATCHES ──────────────────────────────────────────────────────
  console.log("  laundry batches...");
  const laundryStatuses = ["RECEIVED","IN_WASH","READY","PICKED_UP"] as const;
  for (let i = 0; i < 50; i++) {
    await db.insert(laundryBatchesTable).values({
      id: id(), batchNo: `LAU-${30000 + i}`,
      residentId: residentIds[i % 50]!, propertyId: propIds[i % 4]!,
      dropDate: daysAgo(10 - (i % 10)),
      commitTatDays: 2,
      items: { shirts: 2 + (i % 3), pants: 1 + (i % 2), bedsheets: i % 3 },
      status: laundryStatuses[i % 4]!,
      pickedUpAt: laundryStatuses[i % 4] === "PICKED_UP" ? daysAgo(1) : null,
      createdBy: wardenUserId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── MESSAGE TEMPLATES ────────────────────────────────────────────────────
  console.log("  message templates...");
  for (let i = 0; i < 10; i++) {
    await db.insert(messageTemplatesTable).values({
      id: id(),
      name: ["Rent Reminder","Welcome Message","Maintenance Notice","Event Invite","Payment Received","Complaint Update","Checkout Reminder","SLA Breach","Monthly Newsletter","Festival Greetings"][i]!,
      channel: ["EMAIL","SMS","WHATSAPP","EMAIL","EMAIL"][i % 5]!,
      body: `Hi {{name}}, this is a message from UNILIV ${i + 1}. {{body}}`,
      variables: ["name","body"],
      createdBy: adminId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────
  console.log("  announcements...");
  const announcementTitles = [
    "Water Supply Disruption - 10 May","Fire Drill on 15 May","New Gym Equipment Installed",
    "Visitor Policy Update","Upcoming Maintenance - Lifts","Festive Celebration - 20 May",
    "Internet Upgrade Complete","New Cafeteria Menu","Security Camera Upgrade","Weekend Events",
  ];
  for (let i = 0; i < 10; i++) {
    await db.insert(announcementsTable).values({
      id: id(), title: announcementTitles[i]!,
      content: `Dear residents, ${announcementTitles[i]}. Please note and plan accordingly. For queries, contact the warden.`,
      propertyId: i % 3 === 0 ? null : propIds[i % 5]!,
      targetRoles: ["WARDEN","OPERATIONS_MANAGER"],
      createdBy: adminId,
    }).onConflictDoNothing();
  }

  // ─── BOOKINGS (Serviced Apartments) ───────────────────────────────────────
  console.log("  bookings...");
  const bookingStatuses = ["CONFIRMED","CHECKED_IN","CHECKED_OUT","CANCELLED"] as const;
  const saRoomIds = roomIds.slice(12, 16); // 4 rooms tied to prop4 area
  for (let i = 0; i < 20; i++) {
    const checkIn = daysAgo(30 - i * 2);
    const nights = 3 + (i % 7);
    const checkOut = new Date(checkIn.getTime() + nights * 86_400_000);
    const rate = 2500;
    const subtotal = nights * rate;
    const tax = Math.round(subtotal * 0.12);
    await db.insert(bookingsTable).values({
      id: id(), bookingNo: `BKG-${40000 + i}`,
      propertyId: prop4Id, roomId: saRoomIds[i % saRoomIds.length] ?? null,
      guestName: residentNames[i]!, guestEmail: `guest${i + 1}@example.com`,
      guestPhone: `96000${String(i).padStart(5,"0")}`,
      guestCount: 1 + (i % 2), checkInDate: checkIn, checkOutDate: checkOut,
      nights, ratePeriod: "NIGHTLY", ratePerPeriod: String(rate),
      subtotal: String(subtotal), taxAmount: String(tax), totalAmount: String(subtotal + tax),
      status: bookingStatuses[i % 4]!, notes: i % 3 === 0 ? "Early check-in requested" : null,
      createdBy: adminId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── EMPLOYEES ────────────────────────────────────────────────────────────
  console.log("  employees...");
  const depts = ["Operations","Housekeeping","Kitchen","Security","HR","Finance","IT","Maintenance"];
  const designations: Record<string, string[]> = {
    Operations: ["Operations Head","Property Manager","Facility Coordinator"],
    Housekeeping: ["Housekeeping Lead","Housekeeper","Laundry Attendant"],
    Kitchen: ["Head Chef","Cook","Kitchen Assistant"],
    Security: ["Security Head","Security Guard","CCTV Operator"],
    HR: ["HR Manager","HR Executive","Recruiter"],
    Finance: ["Finance Manager","Finance Executive","Accounts Assistant"],
    IT: ["IT Manager","Network Engineer","Support Engineer"],
    Maintenance: ["Maintenance Head","Plumber","Electrician"],
  };
  const empIds: string[] = [];
  const empRows = [];
  for (let i = 0; i < 50; i++) {
    const eId = id();
    empIds.push(eId);
    const dept = depts[i % 8]!;
    const desigs = designations[dept]!;
    empRows.push({
      id: eId, employeeCode: `EMP-${1001 + i}`,
      name: residentNames[i]!.replace("Mehta","Singh").replace("Rao","Kumar"),
      email: `emp${i + 1}@uniliv.com`,
      phone: `98500${String(i).padStart(5,"0")}`,
      department: dept, designation: desigs[i % desigs.length]!,
      propertyId: propIds[i % 5]!,
      joiningDate: daysAgo(365 - i * 3), ctc: String(300000 + i * 12000),
      status: (i === 48 ? "EXITED" : i === 49 ? "ON_LEAVE" : "ACTIVE") as "ACTIVE"|"EXITED"|"ON_LEAVE",
      updatedAt: new Date(),
    });
  }
  await db.insert(employeesTable).values(empRows);

  // ─── ATTENDANCE ───────────────────────────────────────────────────────────
  console.log("  attendance...");
  const attStatuses = ["PRESENT","PRESENT","PRESENT","ABSENT","HALF_DAY","WFH","ON_LEAVE"] as const;
  for (let i = 0; i < 50; i++) {
    await db.insert(attendanceTable).values({
      id: id(), employeeId: empIds[i % 50]!,
      date: daysAgo(i % 30),
      status: attStatuses[i % 7]!,
      inTime: attStatuses[i % 7] === "PRESENT" ? new Date(`2026-04-${String((i % 28) + 1).padStart(2,"0")}T09:00:00`) : null,
      outTime: attStatuses[i % 7] === "PRESENT" ? new Date(`2026-04-${String((i % 28) + 1).padStart(2,"0")}T18:00:00`) : null,
    }).onConflictDoNothing();
  }

  // ─── LEAVE BALANCES ───────────────────────────────────────────────────────
  console.log("  leave balances...");
  const leaveTypes = ["CL","SL","EL"] as const;
  for (let i = 0; i < 50; i++) {
    for (const lt of leaveTypes) {
      await db.insert(leaveBalancesTable).values({
        id: id(), employeeId: empIds[i % 50]!,
        year: 2026, type: lt, total: 12, used: i % 5,
      }).onConflictDoNothing();
    }
  }

  // ─── LEAVES ───────────────────────────────────────────────────────────────
  console.log("  leaves...");
  const leaveStatuses = ["APPROVED","PENDING","REJECTED","CANCELLED"] as const;
  for (let i = 0; i < 50; i++) {
    const from = daysAgo(30 - i);
    const to = new Date(from.getTime() + 2 * 86_400_000);
    await db.insert(leavesTable).values({
      id: id(), employeeId: empIds[i % 50]!,
      type: leaveTypes[i % 3]!, fromDate: from, toDate: to, days: 2,
      reason: ["Personal work","Medical leave","Family function","Annual vacation","Sick"][i % 5]!,
      status: leaveStatuses[i % 4]!,
      approvedBy: leaveStatuses[i % 4] === "APPROVED" ? adminId : null,
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── PERFORMANCE NOTES ────────────────────────────────────────────────────
  console.log("  performance notes...");
  for (let i = 0; i < 30; i++) {
    await db.insert(performanceNotesTable).values({
      id: id(), employeeId: empIds[i % 50]!,
      type: ["COMMENDATION","WARNING","DEVELOPMENT","APPRAISAL"][i % 4]!,
      text: ["Excellent resident feedback","Attendance improvement needed","Enrolled in safety course","Promoted to senior level"][i % 4]!,
      date: daysAgo(i * 5), addedBy: hrUserId,
    }).onConflictDoNothing();
  }

  // ─── JOB REQUISITIONS & CANDIDATES ───────────────────────────────────────
  console.log("  job requisitions & candidates...");
  const jrIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const jrId = id();
    jrIds.push(jrId);
    await db.insert(jobRequisitionsTable).values({
      id: jrId,
      role: ["Property Manager","Head Chef","Security Guard","HR Executive","IT Support","Finance Executive","Maintenance Technician","Housekeeping Lead","Operations Executive","Warden"][i]!,
      department: depts[i % 8]!,
      headcount: 1 + (i % 3),
      status: i < 7 ? "OPEN" : "CLOSED",
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  for (let i = 0; i < 50; i++) {
    const cId = id();
    const stages = ["APPLIED","SCREENING","INTERVIEW","OFFER","JOINED","REJECTED"];
    await db.insert(candidatesTable).values({
      id: cId, jobRequisitionId: jrIds[i % 10]!,
      name: `Candidate ${i + 1}`,
      email: `candidate${i + 1}@gmail.com`,
      phone: `97100${String(i).padStart(5,"0")}`,
      source: ["NAUKRI","LINKEDIN","REFERRAL","WALK_IN"][i % 4]!,
      stage: stages[i % 6]!,
      notes: `Good candidate for ${["Operations","Kitchen","Security"][i % 3]} role.`,
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── EXITS ────────────────────────────────────────────────────────────────
  console.log("  exits...");
  const exitId = id();
  await db.insert(exitsTable).values({
    id: exitId, employeeId: empIds[48]!,
    exitType: "RESIGNATION", exitDate: daysFromNow(30),
    reason: "Pursuing higher studies", status: "IN_PROGRESS", finalSettlement: "45000",
  }).onConflictDoNothing();
  await db.insert(exitClearancesTable).values([
    { id: id(), exitId, department: "IT",          status: "CLEARED",  clearedBy: adminId, clearedAt: new Date() },
    { id: id(), exitId, department: "Finance",     status: "PENDING",  clearedBy: null, clearedAt: null },
    { id: id(), exitId, department: "HR",          status: "PENDING",  clearedBy: null, clearedAt: null },
    { id: id(), exitId, department: "Operations",  status: "CLEARED",  clearedBy: opsUserId, clearedAt: new Date() },
  ]).onConflictDoNothing();
  await db.insert(exitAssetsTable).values([
    { id: id(), exitId, asset: "Laptop",      returned: true  },
    { id: id(), exitId, asset: "Access Card", returned: false },
    { id: id(), exitId, asset: "Uniform",     returned: true  },
  ]).onConflictDoNothing();

  // ─── VENDORS & RATE CONTRACTS ─────────────────────────────────────────────
  console.log("  vendors & rate contracts...");
  const vendorData = [
    { name: "Reliance Fresh Supplies", cats: ["Groceries","Vegetables"], phone: "9900112201" },
    { name: "CleanCo Housekeeping",    cats: ["Housekeeping","Laundry"], phone: "9900112202" },
    { name: "TechNet ISP",             cats: ["Internet","IT"],          phone: "9900112203" },
    { name: "SafeGuard Security",      cats: ["Security"],               phone: "9900112204" },
    { name: "AquaPure Water",          cats: ["Water","Utilities"],      phone: "9900112205" },
    { name: "Electra Power",           cats: ["Electrical"],             phone: "9900112206" },
    { name: "GreenLeaf Organics",      cats: ["Groceries"],              phone: "9900112207" },
    { name: "BuildRight Maintenance",  cats: ["Maintenance"],            phone: "9900112208" },
    { name: "FoodCraft Catering",      cats: ["Kitchen","Food"],         phone: "9900112209" },
    { name: "PrintMaster Office",      cats: ["Stationery"],             phone: "9900112210" },
  ];
  const vendorIds: string[] = [];
  for (const v of vendorData) {
    const vId = id();
    vendorIds.push(vId);
    await db.insert(vendorsTable).values({
      id: vId, name: v.name, phone: v.phone,
      categories: v.cats, rating: 3.5 + Math.random() * 1.5,
      status: "ACTIVE", updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  // Rate contracts
  for (let i = 0; i < 30; i++) {
    await db.insert(rateContractsTable).values({
      id: id(), vendorId: vendorIds[i % vendorIds.length]!,
      itemName: ["Rice 25kg","Cooking Oil 15L","Detergent 5L","Toilet Cleaner","LAN Cable","Bedsheet Set","Light Bulb LED"][i % 7]!,
      unit: ["Bag","Can","Bottle","Bottle","Meter","Set","Unit"][i % 7]!,
      rate: String(500 + i * 100),
      validFrom: daysAgo(90), validTo: daysFromNow(275),
    }).onConflictDoNothing();
  }
  // Vendor docs
  for (let i = 0; i < 20; i++) {
    await db.insert(vendorDocumentsTable).values({
      id: id(), vendorId: vendorIds[i % vendorIds.length]!,
      docType: ["GST","PAN","FSSAI","Insurance","Trade License"][i % 5]!,
      expiryDate: daysFromNow(60 + i * 10),
    }).onConflictDoNothing();
  }

  // ─── INDENTS ──────────────────────────────────────────────────────────────
  console.log("  indents...");
  const indentIds: string[] = [];
  const indentStatuses = ["DRAFT","SUBMITTED","APPROVED","REJECTED","PO_RAISED"] as const;
  for (let i = 0; i < 20; i++) {
    const iId = id();
    indentIds.push(iId);
    await db.insert(indentsTable).values({
      id: iId, indentNumber: `IND-${50000 + i}`,
      propertyId: propIds[i % 5]!,
      department: depts[i % 8]!,
      items: [{ name: "Item A", qty: 5, unit: "Kg", estimatedRate: 100 }],
      totalEstimatedValue: String(500 + i * 200),
      status: indentStatuses[i % 5]!,
      urgency: ["NORMAL","URGENT","CRITICAL"][i % 3]!,
      purpose: `Replenishment for ${depts[i % 8]}`,
      createdBy: adminId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── PURCHASE ORDERS ──────────────────────────────────────────────────────
  console.log("  purchase orders...");
  const poIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const pId = id();
    poIds.push(pId);
    const subtotal = 2000 + i * 500;
    const gst = Math.round(subtotal * 0.18);
    await db.insert(purchaseOrdersTable).values({
      id: pId, poNumber: `PO-${60000 + i}`,
      vendorId: vendorIds[i % vendorIds.length]!,
      propertyId: propIds[i % 5]!, indentId: indentIds[i % 20]!,
      items: [{ name: "Item A", qty: 5, unit: "Kg", rate: subtotal / 5, amount: subtotal }],
      subtotal: String(subtotal), gstApplicable: true, gstAmount: String(gst),
      totalAmount: String(subtotal + gst),
      status: ["DRAFT","SENT","ACKNOWLEDGED","DELIVERED"][i % 4] as "DRAFT"|"SENT"|"ACKNOWLEDGED"|"DELIVERED",
      deliveryDate: daysFromNow(10 + i), updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── GRNs ─────────────────────────────────────────────────────────────────
  console.log("  grns...");
  for (let i = 0; i < 10; i++) {
    await db.insert(grnTable).values({
      id: id(), grnNumber: `GRN-${70000 + i}`,
      poId: poIds[i]!, propertyId: propIds[i % 5]!,
      items: [{ name: "Item A", orderedQty: 5, receivedQty: 5, unit: "Kg" }],
      invoiceNumber: `INV-${80000 + i}`,
      qcPass: i % 5 !== 0, qcNotes: i % 5 === 0 ? "Minor quality issue observed" : null,
      status: "COMPLETED", receivedBy: adminId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── INVENTORY ────────────────────────────────────────────────────────────
  console.log("  inventory...");
  const inventoryItems = [
    { name: "Rice (Basmati 25kg)", cat: "Groceries", unit: "Bags",    curr: 3,  min: 5,  cost: 1800 },
    { name: "Cooking Oil 15L",     cat: "Groceries", unit: "Cans",    curr: 10, min: 8,  cost: 2200 },
    { name: "Detergent 5L",        cat: "Cleaning",  unit: "Bottles", curr: 6,  min: 10, cost: 450  },
    { name: "Hand Soap 1L",        cat: "Consumables",unit:"Bottles", curr: 8,  min: 20, cost: 120  },
    { name: "Bed Linen Set",       cat: "Housekeeping",unit:"Sets",   curr: 45, min: 20, cost: 850  },
    { name: "Pillow Covers",       cat: "Housekeeping",unit:"Pairs",  curr: 60, min: 30, cost: 120  },
    { name: "Toilet Cleaner 1L",   cat: "Cleaning",  unit: "Bottles", curr: 15, min: 10, cost: 80   },
    { name: "LAN Cable 20m",       cat: "IT",        unit: "Rolls",   curr: 5,  min: 3,  cost: 350  },
    { name: "CCTV Camera",         cat: "Security",  unit: "Units",   curr: 16, min: 16, cost: 8500 },
    { name: "Fire Extinguisher",   cat: "Safety",    unit: "Units",   curr: 8,  min: 8,  cost: 3500 },
  ];
  const inventoryIds: string[] = [];
  for (let i = 0; i < 50; i++) {
    const invId = id();
    inventoryIds.push(invId);
    const item = inventoryItems[i % inventoryItems.length]!;
    await db.insert(inventoryTable).values({
      id: invId, propertyId: propIds[i % 5]!,
      name: `${item.name} (${i < 10 ? "P1" : i < 20 ? "P2" : i < 30 ? "P3" : i < 40 ? "P4" : "P5"})`,
      category: item.cat, unit: item.unit,
      currentStock: String(item.curr + (i % 3)),
      minStock: String(item.min),
      unitCost: String(item.cost),
      isAsset: item.cat === "Security" || item.cat === "Safety",
      assetTag: item.cat === "Security" ? `CCTV-${100 + i}` : null,
      condition: item.cat === "Security" ? "GOOD" : null,
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── STOCK MOVEMENTS ──────────────────────────────────────────────────────
  console.log("  stock movements...");
  for (let i = 0; i < 30; i++) {
    await db.insert(stockMovementsTable).values({
      id: id(), inventoryId: inventoryIds[i % inventoryIds.length]!,
      type: ["GRN_IN","CONSUMPTION","ADJUSTMENT","TRANSFER"][i % 4]!,
      quantity: String(1 + (i % 10)),
      reference: `REF-${90000 + i}`,
      notes: `Stock movement ${i + 1}`,
      createdBy: adminId,
    }).onConflictDoNothing();
  }

  // ─── RECIPES ──────────────────────────────────────────────────────────────
  console.log("  recipes...");
  const recipeData = [
    { name: "Jeera Rice",        cat: "Rice",       meal: "LUNCH",   veg: true  },
    { name: "Dal Tadka",         cat: "Dal",        meal: "LUNCH",   veg: true  },
    { name: "Paneer Butter Masala",cat:"Curries",   meal: "DINNER",  veg: true  },
    { name: "Chicken Curry",     cat: "Curries",    meal: "DINNER",  veg: false },
    { name: "Poha",              cat: "Breakfast",  meal: "BREAKFAST",veg: true },
    { name: "Idli Sambhar",      cat: "Breakfast",  meal: "BREAKFAST",veg: true },
    { name: "Rajma Chawal",      cat: "Rice",       meal: "LUNCH",   veg: true  },
    { name: "Egg Bhurji",        cat: "Egg",        meal: "BREAKFAST",veg: false},
    { name: "Veg Biryani",       cat: "Rice",       meal: "LUNCH",   veg: true  },
    { name: "Fish Fry",          cat: "Seafood",    meal: "DINNER",  veg: false },
  ];
  const recipeIds: string[] = [];
  for (let i = 0; i < 30; i++) {
    const rcId = id();
    recipeIds.push(rcId);
    const r = recipeData[i % recipeData.length]!;
    await db.insert(recipesTable).values({
      id: rcId, name: `${r.name} ${Math.floor(i / 10) > 0 ? "v" + (Math.floor(i / 10) + 1) : ""}`,
      category: r.cat, mealType: r.meal, isVeg: r.veg, isActive: true,
      ingredients: [{ name: "Ingredient A", qty: 100, unit: "g" }],
      allergens: r.veg ? [] : ["Gluten"],
      method: `Step 1: Prepare ingredients. Step 2: Cook for 20 minutes. Step 3: Serve hot.`,
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── MENU PLANS ───────────────────────────────────────────────────────────
  console.log("  menu plans...");
  for (let i = 0; i < 10; i++) {
    const weekStart = daysAgo(7 * (5 - i));
    await db.insert(menuPlansTable).values({
      id: id(), propertyId: propIds[i % 5]!,
      weekStart, status: i < 7 ? "PUBLISHED" : "DRAFT",
      publishedAt: i < 7 ? weekStart : null,
      slots: { MON: { BREAKFAST: recipeIds[0], LUNCH: recipeIds[1], DINNER: recipeIds[2] } },
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── DAILY PRODUCTION ─────────────────────────────────────────────────────
  console.log("  daily production...");
  for (let i = 0; i < 30; i++) {
    await db.insert(dailyProductionTable).values({
      id: id(), propertyId: propIds[i % 5]!,
      date: daysAgo(i),
      dispatches: [{ recipeId: recipeIds[i % 10], quantity: 50 + i, unit: "portions" }],
      wastage: [{ recipeId: recipeIds[i % 10], quantity: 2, unit: "portions", reason: "Overproduction" }],
      receivings: [], updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── RECIPE FEEDBACK ──────────────────────────────────────────────────────
  console.log("  recipe feedback...");
  for (let i = 0; i < 50; i++) {
    await db.insert(recipeFeedbackTable).values({
      id: id(), recipeId: recipeIds[i % recipeIds.length]!,
      propertyId: propIds[i % 5]!, rating: 2 + (i % 4),
      comment: ["Great taste!","Could be better","Too spicy","Perfectly cooked","Needs more salt"][i % 5]!,
      weekStart: daysAgo(7 * (i % 5)),
    }).onConflictDoNothing();
  }

  // ─── LEADS ────────────────────────────────────────────────────────────────
  console.log("  sales leads...");
  const leadSources = ["WEBSITE","WHATSAPP","INSTAGRAM","COLD_CALL","REFERRAL","COLLEGE"] as const;
  const leadStages = ["NEW","CONTACTED","VISIT_SCHEDULED","VISIT_DONE","NEGOTIATING","CONVERTED","LOST"] as const;
  const leadIds: string[] = [];
  for (let i = 0; i < 50; i++) {
    const lId = id();
    leadIds.push(lId);
    const stage = leadStages[i % 7]!;
    await db.insert(leadsTable).values({
      id: lId, name: `Lead ${i + 1} - ${residentNames[i % 50]}`,
      phone: `95000${String(i).padStart(5,"0")}`,
      email: `lead${i + 1}@example.com`,
      source: leadSources[i % 6]!, propertyId: propIds[i % 5]!,
      stage, assignedTo: salesUserId,
      budgetMin: String(8000 + (i % 5) * 1000),
      budgetMax: String(15000 + (i % 5) * 2000),
      visitDone: ["VISIT_DONE","NEGOTIATING","CONVERTED","LOST"].includes(stage),
      visitDate: ["VISIT_DONE","NEGOTIATING","CONVERTED"].includes(stage) ? daysAgo(i % 10) : null,
      lostReason: stage === "LOST" ? ["Budget constraint","Chose competitor","No show","Location issue"][i % 4]! : null,
      followUpAt: stage === "CONTACTED" ? daysFromNow(2) : null,
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── LEAD ACTIVITIES ──────────────────────────────────────────────────────
  console.log("  lead activities...");
  for (let i = 0; i < 50; i++) {
    await db.insert(leadActivitiesTable).values({
      id: id(), leadId: leadIds[i % 50]!,
      type: ["STAGE_CHANGE","NOTE","CALL","VISIT_SCHEDULED","FOLLOWUP_SET"][i % 5]!,
      note: `Activity ${i + 1}: ${["Called and discussed requirements","Sent property brochure","Scheduled site visit","Follow-up done","Negotiation in progress"][i % 5]}`,
      createdBy: salesUserId,
    }).onConflictDoNothing();
  }

  // ─── PROPERTY LEADS (Acquisition) ─────────────────────────────────────────
  console.log("  property leads...");
  const plStages = ["SCOUTING","SITE_VISIT","DUE_DILIGENCE","NEGOTIATION","LOI_SIGNED","ONBOARDED","DROPPED"];
  const propLeadNames = [
    "Brigade Residency Indiranagar","Adarsh Apartments HSR","Mantri Pride JP Nagar",
    "Sobha Forest View","Prestige Oaks Sarjapur","Godrej Aqua Hebbal","Purva Fountain Square",
    "Manyata Residency","Salarpuria Estate","Nitesh Residency MG Road",
  ];
  for (let i = 0; i < 10; i++) {
    await db.insert(propertyLeadsTable).values({
      id: id(), name: propLeadNames[i]!,
      address: `${100 + i}, Main Road`, city: ["Bengaluru","Pune","Hyderabad"][i % 3]!,
      ownerName: `Owner ${i + 1}`, ownerPhone: `9988776${600 + i}`,
      bedCount: 40 + i * 10, askingRent: String(50000 + i * 5000),
      stage: plStages[i % plStages.length]!,
      documents: [], photos: [], updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── L&D COURSES ──────────────────────────────────────────────────────────
  console.log("  courses & enrollments...");
  const courseData = [
    { title: "Fire Safety & Evacuation",     cat: "Safety",      type: "VIDEO",    mandatory: true  },
    { title: "Customer Service Excellence",  cat: "Soft Skills", type: "DOCUMENT", mandatory: false },
    { title: "Food Safety & Hygiene",        cat: "Compliance",  type: "VIDEO",    mandatory: true  },
    { title: "POSH Awareness",               cat: "Compliance",  type: "DOCUMENT", mandatory: true  },
    { title: "Excel for Operations",         cat: "Tech Skills", type: "VIDEO",    mandatory: false },
    { title: "Housekeeping Best Practices",  cat: "Operations",  type: "VIDEO",    mandatory: true  },
    { title: "Security Protocols",           cat: "Safety",      type: "DOCUMENT", mandatory: true  },
    { title: "Financial Literacy Basics",    cat: "Finance",     type: "VIDEO",    mandatory: false },
    { title: "Complaint Handling",           cat: "Soft Skills", type: "VIDEO",    mandatory: true  },
    { title: "Digital Literacy",             cat: "Tech Skills", type: "DOCUMENT", mandatory: false },
  ];
  const crsIds: string[] = [];
  for (const c of courseData) {
    const cId = id();
    crsIds.push(cId);
    await db.insert(coursesTable).values({
      id: cId, title: c.title, description: `${c.title} for all UNILIV staff.`,
      category: c.cat, contentType: c.type, isMandatory: c.mandatory,
      isActive: true, targetRoles: ["WARDEN","OPERATIONS_MANAGER"], durationMinutes: 30 + crsIds.length * 5,
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  for (let i = 0; i < 50; i++) {
    const prog = Math.min(100, (i * 7) % 110);
    await db.insert(courseEnrollmentsTable).values({
      id: id(), courseId: crsIds[i % crsIds.length]!, employeeId: empIds[i % 50]!,
      progress: prog, completed: prog >= 100,
      completedAt: prog >= 100 ? daysAgo(i % 15) : null,
      score: prog >= 100 ? 70 + (i % 30) : null,
      attempts: 1 + (i % 3), updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── NOTIFICATIONS ────────────────────────────────────────────────────────
  console.log("  notifications...");
  const notifTypes = ["COMPLAINT_SLA_BREACH","PAYMENT_OVERDUE","LEAVE_APPROVAL_PENDING","LOW_STOCK","INDENT_APPROVAL_PENDING"];
  for (let i = 0; i < 30; i++) {
    await db.insert(notificationsTable).values({
      id: id(), userId: adminId,
      title: ["SLA Breach on TKT-20001","Rent overdue for 3 residents","Leave pending approval","Low stock: Rice Basmati","Indent IND-50001 submitted"][i % 5]!,
      body: `Action required. Please review and take action promptly.`,
      type: notifTypes[i % 5]!, link: ["/complaints","/residents","/leaves","/inventory","/indents"][i % 5]!,
      isRead: i % 3 === 0,
    }).onConflictDoNothing();
  }

  // ─── AUDIT LOG ────────────────────────────────────────────────────────────
  console.log("  audit log...");
  const auditActions = ["CREATE","UPDATE","DELETE","LOGIN","APPROVE","REJECT"];
  const auditEntities = ["RESIDENT","COMPLAINT","EMPLOYEE","PURCHASE_ORDER","LEAVE","EXPENSE"];
  for (let i = 0; i < 50; i++) {
    await db.insert(auditLogTable).values({
      id: id(), userId: adminId,
      action: auditActions[i % 6]!, entity: auditEntities[i % 6]!,
      entityId: id(),
      changes: { field: "status", from: "PENDING", to: "APPROVED" },
    }).onConflictDoNothing();
  }

  // ─── SLA CONFIG ───────────────────────────────────────────────────────────
  console.log("  sla config...");
  const slaRows = [
    { cat: "ELECTRICAL", hrs: 4 }, { cat: "PLUMBING", hrs: 8 }, { cat: "HOUSEKEEPING", hrs: 12 },
    { cat: "INTERNET", hrs: 4 }, { cat: "SECURITY", hrs: 2 }, { cat: "FOOD", hrs: 24 },
    { cat: "LAUNDRY", hrs: 48 }, { cat: "OTHER", hrs: 24 },
  ];
  for (const s of slaRows) {
    await db.insert(slaConfigTable).values({ id: id(), category: s.cat, slaHours: s.hrs, updatedAt: new Date() }).onConflictDoNothing();
  }

  // ─── INTEGRATION STATUS ───────────────────────────────────────────────────
  console.log("  integration status...");
  const integrations = [
    { name: "RAZORPAY", enabled: false }, { name: "TWILIO", enabled: false },
    { name: "SMTP", enabled: false }, { name: "KYC_GATE", enabled: false },
  ];
  for (const ig of integrations) {
    await db.insert(integrationStatusTable).values({ id: id(), name: ig.name, enabled: ig.enabled, updatedAt: new Date() }).onConflictDoNothing();
  }

  // ─── KYC REQUESTS & EVENTS ────────────────────────────────────────────────
  console.log("  kyc requests & events...");
  const kycStatuses = ["PENDING","VERIFIED","REJECTED","PENDING"];
  const kycIds: string[] = [];
  for (let i = 0; i < 50; i++) {
    const kId = id();
    kycIds.push(kId);
    const kStat = kycStatuses[i % 4]!;
    await db.insert(kycRequestsTable).values({
      id: kId, residentId: residentIds[i]!,
      idType: ["AADHAAR","PAN","PASSPORT","VOTER_ID"][i % 4]!,
      idNumber: `ID${String(100000 + i)}`,
      status: kStat,
      provider: "MANUAL",
      reviewedBy: kStat !== "PENDING" ? adminId : null,
      reviewedAt: kStat !== "PENDING" ? daysAgo(i % 10) : null,
      rejectionReason: kStat === "REJECTED" ? "ID blurry or invalid" : null,
      createdBy: adminId, updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(kycEventsTable).values({
      id: id(), kycRequestId: kId, type: "CREATED",
      actorId: adminId, ip: "127.0.0.1", userAgent: "seed-script",
      payload: { note: "KYC created during seeding" },
    }).onConflictDoNothing();
    if (kStat !== "PENDING") {
      await db.insert(kycEventsTable).values({
        id: id(), kycRequestId: kId, type: kStat,
        actorId: adminId, ip: "127.0.0.1", userAgent: "seed-script",
        payload: { rejectionReason: kStat === "REJECTED" ? "ID blurry" : null },
      }).onConflictDoNothing();
    }
  }

  // ─── ESIGN REQUESTS & EVENTS ──────────────────────────────────────────────
  console.log("  esign requests & events...");
  const esignStatuses = ["PENDING","SIGNED","PENDING","VOIDED"] as const;
  for (let i = 0; i < 50; i++) {
    const eId = id();
    const token = `tok-${id().replace(/-/g,"")}`;
    const eStat = esignStatuses[i % 4]!;
    await db.insert(esignRequestsTable).values({
      id: eId, residentId: residentIds[i]!,
      documentName: ["Rent Agreement","House Rules Acknowledgment","NOC Form","KYC Consent","Exit Form"][i % 5]!,
      documentBody: `This agreement is entered into on ${daysAgo(i).toDateString()} between UNILIV and the resident.`,
      signerToken: token, status: eStat,
      expiresAt: daysFromNow(30),
      signedAt: eStat === "SIGNED" ? daysAgo(i % 7) : null,
      signerName: eStat === "SIGNED" ? residentNames[i % 50] : null,
      signerIp: eStat === "SIGNED" ? "192.168.1.1" : null,
      createdBy: adminId, updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(esignEventsTable).values({
      id: id(), esignRequestId: eId, type: "CREATED",
      ip: "127.0.0.1", userAgent: "seed-script",
    }).onConflictDoNothing();
    if (eStat === "SIGNED") {
      await db.insert(esignEventsTable).values({
        id: id(), esignRequestId: eId, type: "SIGNED",
        ip: "192.168.1.1", userAgent: "Mozilla/5.0",
        payload: { signerName: residentNames[i % 50] },
      }).onConflictDoNothing();
    }
  }

  // ─── BILLING CYCLES & RUNS ────────────────────────────────────────────────
  console.log("  billing cycles & runs...");
  const cycleIds: string[] = [];
  const cycleData = [
    { name: "Monthly Rent - Koramangala", propId: prop1Id, cadence: "MONTHLY" },
    { name: "Monthly Rent - Whitefield",  propId: prop2Id, cadence: "MONTHLY" },
    { name: "Monthly Rent - Baner",       propId: prop3Id, cadence: "MONTHLY" },
    { name: "Weekly Utility - All Props", propId: null,    cadence: "WEEKLY"  },
    { name: "Food Charges - Monthly",     propId: null,    cadence: "MONTHLY" },
  ];
  for (const c of cycleData) {
    const cId = id();
    cycleIds.push(cId);
    await db.insert(billingCyclesTable).values({
      id: cId, name: c.name, propertyId: c.propId, cadence: c.cadence,
      dayOfMonth: 1, ledgerType: c.name.includes("Utility") ? "UTILITY" : c.name.includes("Food") ? "FOOD" : "RENT",
      descriptionTemplate: "Charge for {{month}}", isActive: true,
      lastRunAt: daysAgo(5), createdBy: adminId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  for (let i = 0; i < 20; i++) {
    await db.insert(billingRunsTable).values({
      id: id(), cycleId: cycleIds[i % cycleIds.length]!,
      triggeredBy: i % 5 === 0 ? "SCHEDULER" : adminId,
      periodLabel: ["Jan 2026","Feb 2026","Mar 2026","Apr 2026","May 2026"][i % 5]!,
      successCount: 40 + i, failedCount: i % 3, skippedCount: 0,
      totalEligible: 50,
    }).onConflictDoNothing();
  }

  // ─── REMINDER RULES & LOGS ────────────────────────────────────────────────
  console.log("  reminder rules & logs...");
  const reminderRuleIds: string[] = [];
  const reminderData = [
    { name: "3-day pre-due reminder", offset: -3, channel: "EMAIL"  },
    { name: "Due day alert",          offset:  0, channel: "INAPP"  },
    { name: "5-day overdue alert",    offset:  5, channel: "SMS"    },
    { name: "15-day overdue alert",   offset: 15, channel: "EMAIL"  },
  ];
  for (const r of reminderData) {
    const rId = id();
    reminderRuleIds.push(rId);
    await db.insert(reminderRulesTable).values({
      id: rId, name: r.name, offsetDays: r.offset, channel: r.channel,
      templateSubject: `Rent Reminder: ${r.name}`,
      templateBody: `Dear {{name}}, your rent of ₹{{amount}} is due on {{due_date}}.`,
      isActive: true, createdBy: adminId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  for (let i = 0; i < 30; i++) {
    await db.insert(reminderLogsTable).values({
      id: id(), ruleId: reminderRuleIds[i % reminderRuleIds.length]!,
      ruleName: reminderData[i % 4]!.name, residentId: residentIds[i % 50]!,
      channel: reminderData[i % 4]!.channel,
      subject: `Rent Reminder — ${["Jan","Feb","Mar"][i % 3]} 2026`,
      body: `Dear resident, your rent is due. Please pay at the earliest.`,
      status: i % 10 === 0 ? "FAILED" : "SENT",
      triggeredBy: i % 5 === 0 ? "SCHEDULER" : adminId,
    }).onConflictDoNothing();
  }

  // ─── BANK IMPORTS & STATEMENT LINES ───────────────────────────────────────
  console.log("  bank imports & statement lines...");
  const bankImportIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const biId = id();
    bankImportIds.push(biId);
    await db.insert(bankImportsTable).values({
      id: biId, fileName: `statement_${["jan","feb","mar","apr","may"][i]}_2026.csv`,
      accountLabel: `HDFC Current A/c - Property ${i + 1}`,
      totalLines: 20, matchedLines: 15 + i,
      status: i < 3 ? "RECONCILED" : "PENDING",
      uploadedBy: financeUserId,
    }).onConflictDoNothing();
  }
  for (let i = 0; i < 50; i++) {
    await db.insert(bankStatementLinesTable).values({
      id: id(), importId: bankImportIds[i % bankImportIds.length]!,
      txnDate: daysAgo(30 - i % 30),
      description: `NEFT from ${residentNames[i % 50]} / Rent`,
      reference: `NEFT${String(100000 + i)}`,
      amount: String(10000 + (i % 5) * 2500),
      direction: "CREDIT",
      status: i % 3 === 0 ? "MATCHED" : i % 5 === 0 ? "IGNORED" : "UNMATCHED",
      matchedResidentId: i % 3 === 0 ? residentIds[i % 50]! : null,
      reconciledAt: i % 3 === 0 ? daysAgo(i % 5) : null,
      reconciledBy: i % 3 === 0 ? financeUserId : null,
    }).onConflictDoNothing();
  }

  // ─── EXPENSES ─────────────────────────────────────────────────────────────
  console.log("  expense categories & expenses...");
  const expCatIds: string[] = [];
  const expCatNames = ["Utilities","Maintenance","Groceries","Housekeeping","IT","Marketing","Travel","Miscellaneous"];
  for (const name of expCatNames) {
    const ecId = id();
    expCatIds.push(ecId);
    await db.insert(expenseCategoriesTable).values({ id: ecId, name, description: `${name} expenses`, isActive: true }).onConflictDoNothing();
  }
  const expStatuses = ["SUBMITTED","APPROVED","REJECTED","PAID"] as const;
  const expenseIds: string[] = [];
  for (let i = 0; i < 50; i++) {
    const expId = id();
    expenseIds.push(expId);
    const eStat = expStatuses[i % 4]!;
    await db.insert(expensesTable).values({
      id: expId, categoryId: expCatIds[i % expCatIds.length]!,
      propertyId: propIds[i % 5]!,
      vendor: vendorData[i % vendorData.length]!.name,
      amount: String(500 + i * 300),
      expenseDate: daysAgo(i % 30),
      description: `Expense #${i + 1} for ${expCatNames[i % expCatNames.length]}`,
      reference: `EXP-REF-${i + 1}`,
      status: eStat,
      submittedBy: opsUserId,
      reviewedBy: eStat !== "SUBMITTED" ? financeUserId : null,
      reviewedAt: eStat !== "SUBMITTED" ? daysAgo(i % 5) : null,
      paidAt: eStat === "PAID" ? daysAgo(i % 3) : null,
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(expenseEventsTable).values({
      id: id(), expenseId: expId, type: "CREATED",
      actorId: opsUserId, actorName: "Priya Sharma",
      note: "Expense submitted",
    }).onConflictDoNothing();
    if (eStat !== "SUBMITTED") {
      await db.insert(expenseEventsTable).values({
        id: id(), expenseId: expId, type: eStat,
        actorId: financeUserId, actorName: "Ravi Shankar",
        note: eStat === "REJECTED" ? "Duplicate expense" : "Reviewed and approved",
      }).onConflictDoNothing();
    }
  }

  // ─── FACILITY ASSETS, SCHEDULES, LOGS ────────────────────────────────────
  console.log("  facility assets, schedules & logs...");
  const assetCategories = ["LIFT","GENSET","WATER_TANK","HVAC","FIRE_SAFETY","DG","STP","OTHER"];
  const facilityAssetIds: string[] = [];
  for (let i = 0; i < 30; i++) {
    const faId = id();
    facilityAssetIds.push(faId);
    await db.insert(facilityAssetsTable).values({
      id: faId, propertyId: propIds[i % 5]!,
      assetCode: `ASSET-${String(i + 1).padStart(3,"0")}`,
      name: `${assetCategories[i % 8]} Unit ${Math.floor(i / 8) + 1}`,
      category: assetCategories[i % 8]!,
      location: ["Ground Floor","Terrace","Basement","2nd Floor"][i % 4]!,
      manufacturer: ["Otis","Cummins","Sintex","Voltas","Minimax"][i % 5]!,
      installDate: daysAgo(365 * 2),
      warrantyExpiry: daysFromNow(365),
      status: i % 10 === 0 ? "UNDER_MAINTENANCE" : "ACTIVE",
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  const facilityScheduleIds: string[] = [];
  for (let i = 0; i < 30; i++) {
    const fsId = id();
    facilityScheduleIds.push(fsId);
    await db.insert(facilitySchedulesTable).values({
      id: fsId, assetId: facilityAssetIds[i % facilityAssetIds.length]!,
      taskName: ["Quarterly Service","Monthly Inspection","Annual AMC","Weekly Check","Oil Change"][i % 5]!,
      frequencyDays: [7,30,90,180,365][i % 5]!,
      vendorId: vendorIds[i % vendorIds.length]!,
      nextDueDate: daysFromNow(30 - (i % 30)),
      lastDoneAt: daysAgo(i % 60),
      isActive: true, updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  for (let i = 0; i < 30; i++) {
    await db.insert(facilityLogsTable).values({
      id: id(), scheduleId: facilityScheduleIds[i % facilityScheduleIds.length]!,
      assetId: facilityAssetIds[i % facilityAssetIds.length]!,
      performedAt: daysAgo(i % 30),
      performedBy: `Technician ${(i % 5) + 1}`,
      vendorId: vendorIds[i % vendorIds.length]!,
      cost: String(500 + i * 200),
      outcome: i % 7 === 0 ? "PARTIAL" : "COMPLETED",
      notes: `Maintenance log ${i + 1} — all checks passed.`,
    }).onConflictDoNothing();
  }

  // ─── ELECTRICITY TARIFFS, METERS, READINGS ────────────────────────────────
  console.log("  electricity tariffs, meters & readings...");
  const tariffIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const tId = id();
    tariffIds.push(tId);
    await db.insert(electricityTariffsTable).values({
      id: tId, propertyId: propIds[i]!,
      name: `Tariff ${i + 1} — ${propIds[i]}`,
      ratePerUnit: String(6 + (i * 0.5)), fixedCharge: "150",
      effectiveFrom: daysAgo(180), isActive: true, updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  const meterIds: string[] = [];
  for (let i = 0; i < 30; i++) {
    const mId = id();
    meterIds.push(mId);
    await db.insert(electricityMetersTable).values({
      id: mId, propertyId: propIds[i % 5]!,
      roomId: roomIds[i % roomIds.length]!,
      residentId: residentIds[i % 50]!,
      meterNo: `MTR-${String(1000 + i).padStart(4,"0")}`,
      label: `Room ${roomIds[i % roomIds.length]?.slice(0,8)} Meter`,
      tariffId: tariffIds[i % 5]!,
      isActive: true, updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  for (let i = 0; i < 50; i++) {
    const reading = 1000 + i * 25;
    const prev = reading - 25;
    const units = 25;
    await db.insert(electricityReadingsTable).values({
      id: id(), meterId: meterIds[i % meterIds.length]!,
      readingDate: daysAgo(30 - i % 30),
      reading: String(reading), prevReading: String(prev),
      unitsConsumed: String(units), amount: String(units * 6.5),
      posted: i % 3 === 0, recordedBy: opsUserId,
    }).onConflictDoNothing();
  }

  // ─── RESIDENT ATTENDANCE ──────────────────────────────────────────────────
  console.log("  resident attendance...");
  const raStatuses = ["PRESENT","PRESENT","PRESENT","ABSENT","OUT_PASS"];
  for (let i = 0; i < 50; i++) {
    const dateStr = daysAgo(i % 30).toISOString().split("T")[0]!;
    await db.insert(residentAttendanceTable).values({
      id: id(), residentId: residentIds[i % 50]!, propertyId: propIds[i % 5]!,
      attendanceDate: dateStr,
      status: raStatuses[i % 5]!,
      markedBy: wardenUserId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── OUT PASSES ───────────────────────────────────────────────────────────
  console.log("  out passes...");
  const opStatuses = ["PENDING","APPROVED","REJECTED","RETURNED","OVERDUE"] as const;
  for (let i = 0; i < 30; i++) {
    const leaveOn = daysAgo(10 - (i % 10));
    const expected = new Date(leaveOn.getTime() + 2 * 86_400_000);
    await db.insert(outPassesTable).values({
      id: id(), residentId: residentIds[i % 50]!, propertyId: propIds[i % 5]!,
      reason: ["Home visit","Medical appointment","College event","Family function","Travel"][i % 5]!,
      destination: ["Mysuru","Chennai","Pune","Mumbai","Hyderabad"][i % 5]!,
      leaveOn, expectedReturn: expected,
      actualReturn: opStatuses[i % 5] === "RETURNED" ? new Date(expected.getTime() + 3_600_000) : null,
      status: opStatuses[i % 5]!,
      approverId: opStatuses[i % 5] !== "PENDING" ? wardenUserId : null,
      createdBy: wardenUserId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  // ─── IoT DEVICES & READINGS ───────────────────────────────────────────────
  console.log("  iot devices & readings...");
  const iotDeviceIds: string[] = [];
  const devTypes = ["SMART_LOCK","ENERGY_METER","TEMP_SENSOR","OCCUPANCY","LEAK"];
  for (let i = 0; i < 20; i++) {
    const dId = id();
    iotDeviceIds.push(dId);
    await db.insert(iotDevicesTable).values({
      id: dId, propertyId: propIds[i % 5]!,
      roomId: roomIds[i % roomIds.length]!,
      name: `${devTypes[i % 5]} - Room ${(i % 10) + 1}`,
      deviceType: devTypes[i % 5]!,
      adapter: "GENERIC",
      ingestionToken: `iot-token-${id().slice(0,12)}`,
      config: { interval: 60, threshold: 80 },
      status: i % 6 === 0 ? "OFFLINE" : "ACTIVE",
      lastSeenAt: daysAgo(i % 5),
      registeredBy: adminId, updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  for (let i = 0; i < 50; i++) {
    await db.insert(iotReadingsTable).values({
      id: id(), deviceId: iotDeviceIds[i % iotDeviceIds.length]!,
      metric: ["temperature","humidity","power_kw","occupancy","leak_detected"][i % 5]!,
      value: String((20 + (i % 30)).toFixed(2)),
      rawPayload: { raw: i * 1.5, unit: "Celsius", ts: Date.now() },
      recordedAt: daysAgo(i % 10),
    }).onConflictDoNothing();
  }

  console.log("✅ Seed complete! All tables populated with 50+ rows.");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
