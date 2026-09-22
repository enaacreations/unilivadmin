import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  pgEnum,
  doublePrecision,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const employeeStatusEnum = pgEnum("employee_status", [
  "ACTIVE",
  "INACTIVE",
  "ON_LEAVE",
  "EXITED",
]);
export const attendanceStatusEnum = pgEnum("attendance_status", [
  "PRESENT",
  "ABSENT",
  "HALF_DAY",
  "WFH",
  "ON_LEAVE",
  // PRD §16's nine states. ON_LEAVE is our spelling of "Leave"; WFH has no PRD
  // equivalent but is in use. Appended, never substituted.
  "LATE",
  "WEEKLY_OFF",
  "HOLIDAY",
  "ON_DUTY",
]);
export const leaveTypeEnum = pgEnum("leave_type", [
  "CL",
  "SL",
  "EL",
  "PL",
  "COMP_OFF",
]);
export const leaveStatusEnum = pgEnum("leave_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);

export const employeesTable = pgTable("employees", {
  id: text("id").primaryKey(),
  employeeCode: text("employee_code").notNull().unique(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull(),
  dob: timestamp("dob"),
  gender: text("gender"),
  photo: text("photo"),
  department: text("department").notNull(),
  designation: text("designation").notNull(),
  propertyId: text("property_id"),
  managerId: text("manager_id"),
  /**
   * Link to the login identity (users.id). Nullable, no FK — the same
   * core↔domain decoupling properties.clusterId already uses, and an employee
   * legitimately may have no login. Backfilled by unique-email match; an
   * unmatched user simply gets no TEAM scope, which fails closed.
   */
  userId: text("user_id"),
  joiningDate: timestamp("joining_date").notNull(),
  ctc: numeric("ctc"),
  basic: numeric("basic"),
  hra: numeric("hra"),
  specialAllowance: numeric("special_allowance"),
  bankAccount: text("bank_account"),
  ifscCode: text("ifsc_code"),
  panNumber: text("pan_number"),
  pfNumber: text("pf_number"),
  esicNumber: text("esic_number"),
  status: employeeStatusEnum("status").default("ACTIVE").notNull(),
  exitedAt: timestamp("exited_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // One employee per login. Partial so the many rows with no login stay valid;
  // plain column + plain IS NOT NULL predicate keeps `push` round-trippable.
  uniqueIndex("employees_user_id_uq").on(t.userId).where(sql`user_id is not null`),
]);

export const leaveBalancesTable = pgTable("leave_balances", {
  id: text("id").primaryKey(),
  employeeId: text("employee_id").notNull().references(() => employeesTable.id),
  year: integer("year").notNull(),
  type: leaveTypeEnum("type").notNull(),
  total: doublePrecision("total").notNull(),
  used: doublePrecision("used").default(0).notNull(),
});

export const performanceNotesTable = pgTable("performance_notes", {
  id: text("id").primaryKey(),
  employeeId: text("employee_id").notNull().references(() => employeesTable.id),
  type: text("type").notNull(),
  text: text("text").notNull(),
  date: timestamp("date").defaultNow().notNull(),
  addedBy: text("added_by"),
});

export const interviewsTable = pgTable("interviews", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id").notNull(),
  scheduledAt: timestamp("scheduled_at").notNull(),
  panel: text("panel"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const offersTable = pgTable("offers", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id").notNull(),
  ctc: numeric("ctc").notNull(),
  joiningDate: timestamp("joining_date").notNull(),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
});

export const exitsTable = pgTable("exits", {
  id: text("id").primaryKey(),
  employeeId: text("employee_id").notNull().references(() => employeesTable.id),
  exitType: text("exit_type").notNull(),
  exitDate: timestamp("exit_date").notNull(),
  reason: text("reason"),
  status: text("status").default("IN_PROGRESS").notNull(),
  finalSettlement: numeric("final_settlement"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const exitClearancesTable = pgTable("exit_clearances", {
  id: text("id").primaryKey(),
  exitId: text("exit_id").notNull().references(() => exitsTable.id),
  department: text("department").notNull(),
  status: text("status").default("PENDING").notNull(),
  clearedBy: text("cleared_by"),
  clearedAt: timestamp("cleared_at"),
});

export const exitAssetsTable = pgTable("exit_assets", {
  id: text("id").primaryKey(),
  exitId: text("exit_id").notNull().references(() => exitsTable.id),
  asset: text("asset").notNull(),
  returned: boolean("returned").default(false).notNull(),
});

export const attendanceTable = pgTable("attendance", {
  id: text("id").primaryKey(),
  employeeId: text("employee_id")
    .notNull()
    .references(() => employeesTable.id),
  date: timestamp("date").notNull(),
  status: attendanceStatusEnum("status").notNull(),
  inTime: timestamp("in_time"),
  outTime: timestamp("out_time"),
  notes: text("notes"),
  /**
   * PRD §16: self-service check-in/out, corrections, and manager approval.
   *
   * A correction is recorded as a PROPOSED value beside the original rather
   * than overwriting it — §29 requires the previous value, and an attendance
   * edit is one of the thirteen events it names. The original stays in
   * status/inTime/outTime until a manager approves.
   */
  selfCheckedIn: boolean("self_checked_in").default(false).notNull(),
  correctionRequestedAt: timestamp("correction_requested_at"),
  correctionRequestedBy: text("correction_requested_by"),
  correctionReason: text("correction_reason"),
  proposedStatus: attendanceStatusEnum("proposed_status"),
  proposedInTime: timestamp("proposed_in_time"),
  proposedOutTime: timestamp("proposed_out_time"),
  approvalState: text("approval_state").default("NONE").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const leavesTable = pgTable("leaves", {
  id: text("id").primaryKey(),
  employeeId: text("employee_id")
    .notNull()
    .references(() => employeesTable.id),
  type: leaveTypeEnum("type").notNull(),
  fromDate: timestamp("from_date").notNull(),
  toDate: timestamp("to_date").notNull(),
  days: doublePrecision("days").notNull(),
  reason: text("reason").notNull(),
  status: leaveStatusEnum("status").default("PENDING").notNull(),
  approvedBy: text("approved_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const jobRequisitionsTable = pgTable("job_requisitions", {
  id: text("id").primaryKey(),
  role: text("role").notNull(),
  department: text("department").notNull(),
  headcount: integer("headcount").notNull(),
  status: text("status").default("OPEN").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const candidatesTable = pgTable("candidates", {
  id: text("id").primaryKey(),
  jobRequisitionId: text("job_requisition_id"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  resumeUrl: text("resume_url"),
  source: text("source"),
  stage: text("stage").default("APPLIED").notNull(),
  bgvStatus: text("bgv_status"),
  offerStatus: text("offer_status"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Employee = typeof employeesTable.$inferSelect;
export type InsertEmployee = typeof employeesTable.$inferInsert;
export type Attendance = typeof attendanceTable.$inferSelect;
export type InsertAttendance = typeof attendanceTable.$inferInsert;
export type Leave = typeof leavesTable.$inferSelect;
export type InsertLeave = typeof leavesTable.$inferInsert;
export type JobRequisition = typeof jobRequisitionsTable.$inferSelect;
export type Candidate = typeof candidatesTable.$inferSelect;
export type LeaveBalance = typeof leaveBalancesTable.$inferSelect;
export type PerformanceNote = typeof performanceNotesTable.$inferSelect;
export type Interview = typeof interviewsTable.$inferSelect;
export type Offer = typeof offersTable.$inferSelect;
export type Exit = typeof exitsTable.$inferSelect;
export type ExitClearance = typeof exitClearancesTable.$inferSelect;
export type ExitAsset = typeof exitAssetsTable.$inferSelect;
