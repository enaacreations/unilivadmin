/**
 * Audit & Inspection — shared types, constants and helpers for the P2 pages
 * (templates, builder, preview, question bank, schedules, calendar).
 * Pure TS only; shared components live in ./shared.tsx.
 */

import { apiFetch } from "@/lib/api-fetch";

export type ApiOne<T> = { success: boolean; data: T };
export type ApiList<T> = { success: boolean; data: T[]; meta?: { total: number } };

/**
 * Fetch every page of a paginated list endpoint. The API caps `limit` at 100,
 * so registers that want the whole set (e.g. the 456-item question bank)
 * page through: first request reveals meta.total, the rest run in parallel.
 */
export async function apiFetchAll<T>(basePath: string, pageSize = 100): Promise<T[]> {
  const sep = basePath.includes("?") ? "&" : "?";
  const first = await apiFetch<ApiList<T>>(`${basePath}${sep}limit=${pageSize}&page=1`);
  const total = first.meta?.total ?? first.data.length;
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return first.data;
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      apiFetch<ApiList<T>>(`${basePath}${sep}limit=${pageSize}&page=${i + 2}`),
    ),
  );
  return [first.data, ...rest.map((r) => r.data)].flat();
}

/** Error thrown by apiFetch — message plus optional HTTP status / details payload. */
export type ApiError = Error & { status?: number; details?: unknown };

export type BadgeVariant =
  | "default" | "secondary" | "destructive" | "outline"
  | "success" | "warning" | "info";

/* ── Audit types & lifecycle ─────────────────────────────────────────────── */

export type AuditType = "UL" | "CM" | "CX";
export type TargetType = "PROPERTY" | "ROOM";
export type Lifecycle = "DRAFT" | "PENDING_APPROVAL" | "PUBLISHED" | "DEPRECATED" | "ARCHIVED";

export const AUDIT_TYPES: AuditType[] = ["UL", "CM", "CX"];

export const AUDIT_TYPE_LABELS: Record<AuditType, string> = {
  UL: "Unit Lead",
  CM: "Cluster Manager",
  CX: "CX (ad-hoc)",
};

export const AUDIT_TYPE_BADGE: Record<AuditType, BadgeVariant> = {
  UL: "default",
  CM: "secondary",
  CX: "outline",
};

export const LIFECYCLE_BADGE: Record<Lifecycle, BadgeVariant> = {
  DRAFT: "secondary",
  PENDING_APPROVAL: "outline",
  PUBLISHED: "default",
  DEPRECATED: "destructive",
  ARCHIVED: "outline",
};

/* ── Question model ──────────────────────────────────────────────────────── */

export const QUESTION_TYPES = [
  "YES_NO_NA", "PASS_FAIL", "RATING", "SINGLE_CHOICE", "MULTI_CHOICE",
  "NUMERIC", "TEXT", "PHOTO", "SIGNATURE", "DATE", "INSTRUCTION",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Types that never contribute points (spec §6.1). */
export const NON_SCORED_TYPES: ReadonlySet<QuestionType> = new Set([
  "TEXT", "PHOTO", "SIGNATURE", "DATE", "INSTRUCTION",
]);

export const EVIDENCE_RULES = ["NONE", "OPTIONAL", "REQUIRED_ON_FAIL", "ALWAYS_REQUIRED"] as const;
export type EvidenceRule = (typeof EVIDENCE_RULES)[number];

export const NC_SEVERITIES = ["CRITICAL", "MAJOR", "MINOR"] as const;
export type NcSeverity = (typeof NC_SEVERITIES)[number];

export interface AutoNcRule {
  onAnswers: string[];
  severity: NcSeverity;
  ownerRule: "AUDITEE_OF_TARGET";
}

export interface ChoiceOption {
  id: string;
  label: string;
  multiplierPct: number;
}

/* ── Templates ───────────────────────────────────────────────────────────── */

export interface TemplateRow {
  id: string;
  name: string;
  auditType: AuditType;
  targetType: TargetType;
  category: string | null;
  description: string | null;
  archivedAt: string | null;
  latestVersionNo: number;
  latestVersionId: string;
  lifecycle: Lifecycle;
  activeSchedules: number;
  auditsGenerated: number;
  updatedAt: string;
}

export interface VersionSummary {
  id: string;
  templateId: string;
  versionNo: number;
  lifecycle: Lifecycle;
  changelogNote: string | null;
  /** numeric column → string in JSON */
  passThresholdPct: string | null;
  criticalFailGate: boolean;
  reviewRequired: boolean;
  contentHash: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface TemplateDetail {
  id: string;
  name: string;
  auditType: AuditType;
  targetType: TargetType;
  category: string | null;
  description: string | null;
  archivedAt: string | null;
  /** Visibility scoping; null/empty = unrestricted (PATCH /audit/templates/:id). */
  accessScopeJson?: AccessScope | null;
  versions: VersionSummary[];
}

export interface BuilderQuestion {
  id: string;
  prompt: string;
  helpText: string | null;
  type: QuestionType;
  weight: number;
  mandatory: boolean;
  evidenceRule: EvidenceRule;
  ratingScaleId: string | null;
  optionsJson: ChoiceOption[] | null;
  numericUnit: string | null;
  numericMin: string | null;
  numericMax: string | null;
  autoNcJson: AutoNcRule | null;
  bankItemId: string | null;
  orderIndex: number;
}

export interface BuilderSection {
  id: string;
  title: string;
  description: string | null;
  audience: string | null;
  orderIndex: number;
  questions: BuilderQuestion[];
}

export interface VersionDetail extends VersionSummary {
  sections: BuilderSection[];
}

export interface WhereUsed {
  schedules: { id: string; title: string; status: string; frequency: string }[];
  openAudits: number;
  totalAudits: number;
}

export interface VersionDiff {
  from: { versionNo: number; lifecycle?: Lifecycle };
  to: { versionNo: number; lifecycle?: Lifecycle };
  sectionsAdded: string[];
  sectionsRemoved: string[];
  questionsAdded: string[];
  questionsRemoved: string[];
  questionsChanged: { question: string; changes: Record<string, { from: unknown; to: unknown }> }[];
}

/* ── Question bank ───────────────────────────────────────────────────────── */

export interface BankItem {
  id: string;
  prompt: string;
  helpText: string | null;
  type: QuestionType;
  defaultWeight: number;
  defaultEvidenceRule: EvidenceRule;
  defaultAutoNcJson: unknown;
  /** Single/multi choice options seeded onto the question on insert. */
  defaultOptionsJson: ChoiceOption[] | null;
  tags: string[];
  numericUnit: string | null;
  /** numeric columns → string in JSON. */
  numericMin: string | null;
  numericMax: string | null;
  archivedAt: string | null;
  usageCount: number;
  updatedAt: string;
}

/* ── Schedules ───────────────────────────────────────────────────────────── */

export const FREQUENCIES = [
  "EVERY_N_DAYS", "WEEKLY", "FORTNIGHTLY", "MONTHLY",
  "QUARTERLY", "HALF_YEARLY", "ANNUALLY", "CRON",
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  EVERY_N_DAYS: "Every N days",
  WEEKLY: "Weekly",
  FORTNIGHTLY: "Fortnightly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  HALF_YEARLY: "Half-yearly",
  ANNUALLY: "Annually",
  CRON: "Cron expression",
};

export const DAYS_OF_WEEK = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

export type AssigneeRule =
  | { kind: "USER"; userId: string }
  | { kind: "ROLE_AT_TARGET"; role: "UNIT_LEAD" | "CLUSTER_MANAGER" };

export type ScheduleStatus = "ACTIVE" | "PAUSED" | "ENDED";

export const SCHEDULE_STATUS_BADGE: Record<ScheduleStatus, BadgeVariant> = {
  ACTIVE: "default",
  PAUSED: "secondary",
  ENDED: "outline",
};

export interface ScheduleRow {
  id: string;
  title: string;
  auditType: AuditType;
  frequency: Frequency;
  intervalDays: number | null;
  dayOfWeek: number | null;
  cron: string | null;
  timeOfDay: string;
  windowStart: string;
  windowEnd: string | null;
  reminderOffsetMinutes: number | null;
  assigneeRule: AssigneeRule;
  status: ScheduleStatus;
  templateName: string;
  templateVersionNo: number;
  templateId: string;
  targetCount: number;
  auditsGenerated: number;
  createdAt: string;
}

export interface ScheduleTarget {
  id: string;
  targetType: TargetType;
  propertyId: string | null;
  roomId: string | null;
  propertyName: string | null;
  roomNumber: string | null;
}

export interface ScheduleDetail extends ScheduleRow {
  targets: ScheduleTarget[];
}

/** "Monthly", "Every 2 days", "Weekly (Mon)", or the raw cron string. */
export function humanFrequency(
  s: Pick<ScheduleRow, "frequency" | "intervalDays" | "dayOfWeek" | "cron">,
): string {
  switch (s.frequency) {
    case "EVERY_N_DAYS":
      return s.intervalDays === 1 ? "Daily" : `Every ${s.intervalDays ?? "?"} days`;
    case "WEEKLY":
      return s.dayOfWeek != null
        ? `Weekly (${DAYS_OF_WEEK[s.dayOfWeek]?.slice(0, 3)})`
        : "Weekly";
    case "CRON":
      return s.cron || "Cron";
    default:
      return FREQUENCY_LABELS[s.frequency];
  }
}

export const REMINDER_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 30, label: "30 minutes before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 120, label: "2 hours before" },
  { minutes: 240, label: "4 hours before" },
  { minutes: 600, label: "10 hours before" },
];

/* ── Calendar ────────────────────────────────────────────────────────────── */

export interface CalendarAudit {
  id: string;
  ticketNo: string;
  title: string;
  state: string;
  isOverdue: boolean;
  auditType: AuditType;
  scheduledFor: string;
  propertyName: string | null;
  scheduleId: string | null;
}

export interface CalendarProjection {
  scheduleId: string;
  title: string;
  auditType: AuditType;
  occurrence: string;
  targetCount: number;
}

/** Chip colour classes per audit state (calendar + legend). */
export const AUDIT_STATE_CHIP: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SCHEDULED: "bg-blue-100 text-blue-800",
  IN_PROGRESS: "bg-amber-100 text-amber-800",
  PAUSED: "bg-orange-100 text-orange-800",
  SUBMITTED: "bg-violet-100 text-violet-800",
  UNDER_REVIEW: "bg-purple-100 text-purple-800",
  REJECTED: "bg-red-100 text-red-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  CLOSED: "bg-slate-200 text-slate-700",
  CANCELLED: "bg-muted text-muted-foreground line-through",
};

/* ── Audits (register / detail / execution — P3) ─────────────────────────── */

export const AUDIT_STATES = [
  "DRAFT", "SCHEDULED", "IN_PROGRESS", "PAUSED", "SUBMITTED",
  "UNDER_REVIEW", "REJECTED", "APPROVED", "CLOSED", "CANCELLED",
] as const;
export type AuditState = (typeof AUDIT_STATES)[number];

export const ACTIVE_AUDIT_STATES: AuditState[] = ["SCHEDULED", "IN_PROGRESS", "PAUSED", "REJECTED"];
export const COMPLETED_AUDIT_STATES: AuditState[] = ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "CLOSED"];

export const AUDIT_STATE_BADGE: Record<AuditState, BadgeVariant> = {
  DRAFT: "secondary",
  SCHEDULED: "info",
  IN_PROGRESS: "warning",
  PAUSED: "warning",
  SUBMITTED: "info",
  UNDER_REVIEW: "info",
  REJECTED: "destructive",
  APPROVED: "success",
  CLOSED: "outline",
  CANCELLED: "outline",
};

/** States a runner session makes sense for (assignee-side). */
export const RUNNABLE_STATES: AuditState[] = ["SCHEDULED", "IN_PROGRESS", "PAUSED", "REJECTED"];

/** Register row — audits table columns + enrich() denormalizations. */
export interface AuditRow {
  id: string;
  ticketNo: string;
  auditType: AuditType;
  templateVersionId: string;
  scheduleId: string | null;
  targetType: TargetType;
  propertyId: string;
  roomId: string | null;
  title: string;
  description: string | null;
  state: AuditState;
  isOverdue: boolean;
  assigneeId: string | null;
  scheduledFor: string | null;
  dueAt: string | null;
  subsetJson: unknown;
  reviewRequired: boolean;
  /** numeric columns → strings in JSON; Number() before math */
  maxScore: string | null;
  earnedScore: string | null;
  scorePct: string | null;
  result: "PASS" | "FAIL" | null;
  scoreBand: string | null;
  startedAt: string | null;
  startGeoLat: number | null;
  startGeoLng: number | null;
  submittedAt: string | null;
  submitGeoLat: number | null;
  submitGeoLng: number | null;
  durationSeconds: number | null;
  approvedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  reopenCount: number;
  createdAt: string;
  updatedAt: string;
  // enrich()
  propertyName: string | null;
  propertyCity: string | null;
  roomNumber: string | null;
  assigneeName: string | null;
  assigneeRole: string | null;
}

export interface AuditDetailRow extends AuditRow {
  templateVersion: {
    id: string;
    versionNo: number;
    templateId: string;
    templateName: string | null;
  } | null;
}

/** Paginated list envelope with the buildMeta() shape. */
export type ApiPage<T> = {
  success: boolean;
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
};

export interface AuditEventRow {
  id: string;
  kind: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  actorId: string | null;
  actorRole: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface AuditCommentRow {
  id: string;
  auditId: string;
  authorId: string | null;
  body: string;
  createdAt: string;
  authorName: string | null;
  authorRole: string | null;
  /** Image/PDF attachments (≤5), present when the comment carries evidence. */
  attachments?: CommentAttachment[];
}

/* ── Runner payload (GET /audits/:id/run) ────────────────────────────────── */

export interface ScaleSnapshotOption {
  id: string;
  label: string;
  multiplierPct: number;
  isExcludedNa: boolean;
  color?: string | null;
  orderIndex?: number;
}

export interface ScaleSnapshot {
  scaleId: string;
  name: string;
  options: ScaleSnapshotOption[];
}

export interface RunQuestion {
  id: string;
  sectionId: string;
  auditId: string | null;
  adHoc: boolean;
  prompt: string;
  helpText: string | null;
  type: QuestionType;
  weight: number;
  mandatory: boolean;
  evidenceRule: EvidenceRule;
  optionsJson: ChoiceOption[] | null;
  numericUnit: string | null;
  numericMin: string | null;
  numericMax: string | null;
  autoNcJson: { onAnswers?: string[]; belowMultiplierPct?: number; severity: NcSeverity } | null;
  orderIndex: number;
}

export interface RunSection {
  id: string;
  title: string;
  description: string | null;
  audience: string | null;
  orderIndex: number;
  questions: RunQuestion[];
}

export interface RunResponse {
  id: string;
  auditId: string;
  questionId: string;
  answerJson: unknown;
  isNa: boolean;
  multiplierPct: string | null;
  weight: string | null;
  earnedScore: string | null;
  maxScore: string | null;
  notes: string | null;
  answeredAt: string | null;
}

export interface RunEvidence {
  id: string;
  kind: "AUDIT" | "RESPONSE" | "NC" | "CAPA" | "SUBMISSION_PROOF";
  responseId: string | null;
  url: string | null;
  thumbUrl: string | null;
  mime: string;
  originalName: string | null;
  geoLat: number | null;
  geoLng: number | null;
  geoAccuracyM: string | null;
  capturedAt: string | null;
  isLiveCapture: boolean;
  createdAt: string;
}

export interface RunNc {
  id: string;
  ncNo: string;
  responseId: string | null;
  questionId: string | null;
  severity: NcSeverity;
  state: string;
  description: string;
}

export interface AttachmentPolicy {
  maxFiles: number;
  maxSizeMb: number;
  allowedMime: string[];
}

export interface RunPayload {
  audit: AuditRow;
  version: {
    id: string;
    versionNo: number;
    passThresholdPct: string | null;
    criticalFailGate: boolean;
    reviewRequired: boolean;
  };
  scaleSnapshot: ScaleSnapshot | null;
  sections: RunSection[];
  responses: RunResponse[];
  evidence: RunEvidence[];
  ncs: RunNc[];
  policies: {
    response: AttachmentPolicy;
    audit: AttachmentPolicy;
    submission: AttachmentPolicy;
  };
}

export interface SubmitBlocker {
  kind: "UNANSWERED_MANDATORY" | "MISSING_EVIDENCE" | "LIVE_PHOTO_REQUIRED" | "UNRESOLVED_SAVE";
  questionId?: string;
  sectionId?: string;
  prompt?: string;
}

export interface SubmitCheck {
  blockers: SubmitBlocker[];
  canSubmit: boolean;
}

/**
 * Client mirror of the server's resolveMultiplier (audit-scoring.ts) — powers
 * the live provisional score chip. Returns the % multiplier for an answer,
 * isNa for N/A-style answers (excluded from both sums by default).
 */
export function resolveMultiplierClient(
  question: Pick<RunQuestion, "type" | "optionsJson" | "numericMin" | "numericMax">,
  answerJson: unknown,
  snapshot: ScaleSnapshot | null,
): { multiplierPct: number | null; isNa: boolean } {
  if (NON_SCORED_TYPES.has(question.type)) return { multiplierPct: null, isNa: false };
  const a = (answerJson ?? {}) as Record<string, unknown>;
  switch (question.type) {
    case "YES_NO_NA": {
      const v = String(a["value"] ?? "").toUpperCase();
      if (v === "YES") return { multiplierPct: 100, isNa: false };
      if (v === "NO") return { multiplierPct: 0, isNa: false };
      if (v === "NA") return { multiplierPct: null, isNa: true };
      return { multiplierPct: null, isNa: false };
    }
    case "PASS_FAIL": {
      const v = String(a["value"] ?? "").toUpperCase();
      if (v === "PASS") return { multiplierPct: 100, isNa: false };
      if (v === "FAIL") return { multiplierPct: 0, isNa: false };
      return { multiplierPct: null, isNa: false };
    }
    case "RATING": {
      const optionId = a["optionId"] != null ? String(a["optionId"]) : null;
      const option = optionId ? snapshot?.options.find((o) => o.id === optionId) : undefined;
      if (!option) return { multiplierPct: null, isNa: false };
      if (option.isExcludedNa) return { multiplierPct: null, isNa: true };
      return { multiplierPct: Number(option.multiplierPct), isNa: false };
    }
    case "SINGLE_CHOICE": {
      const optionId = a["optionId"] != null ? String(a["optionId"]) : null;
      const option = (question.optionsJson ?? []).find((o) => o.id === optionId);
      return option ? { multiplierPct: Number(option.multiplierPct), isNa: false } : { multiplierPct: null, isNa: false };
    }
    case "MULTI_CHOICE": {
      const ids = Array.isArray(a["optionIds"]) ? (a["optionIds"] as unknown[]).map(String) : [];
      const options = (question.optionsJson ?? []).filter((o) => ids.includes(o.id));
      if (options.length === 0) return { multiplierPct: null, isNa: false };
      const avg = options.reduce((s, o) => s + Number(o.multiplierPct), 0) / options.length;
      return { multiplierPct: avg, isNa: false };
    }
    case "NUMERIC": {
      const value = a["value"];
      if (value == null || value === "" || Number.isNaN(Number(value))) {
        return { multiplierPct: null, isNa: false };
      }
      const n = Number(value);
      const min = question.numericMin != null ? Number(question.numericMin) : null;
      const max = question.numericMax != null ? Number(question.numericMax) : null;
      if (min == null && max == null) return { multiplierPct: 100, isNa: false };
      const inRange = (min == null || n >= min) && (max == null || n <= max);
      return { multiplierPct: inRange ? 100 : 0, isNa: false };
    }
    default:
      return { multiplierPct: null, isNa: false };
  }
}

/** Tailwind text-colour class for a score percentage (band-ish traffic light). */
export function scoreColorClass(pct: number | null | undefined): string {
  if (pct == null || Number.isNaN(pct)) return "text-muted-foreground";
  if (pct >= 90) return "text-emerald-600";
  if (pct >= 75) return "text-lime-600";
  if (pct >= 50) return "text-amber-600";
  return "text-red-600";
}

/** "1h 24m" from seconds. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0 && m === 0) return "<1m";
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ── Rating scales & bands (admin) ───────────────────────────────────────── */

export interface RatingScaleOption {
  id: string;
  label: string;
  color: string | null;
  orderIndex: number;
  /** numeric column → string in JSON; Number() before math */
  multiplierPct: string | number;
  isExcludedNa: boolean;
}

export interface RatingScale {
  id: string;
  name: string;
  active: boolean;
  options: RatingScaleOption[];
}

export interface PerformanceBand {
  id: string;
  label: string;
  minPct: string | number;
  maxPct: string | number;
  color: string | null;
  orderIndex: number;
}

/* ── Preview scoring ─────────────────────────────────────────────────────── */

export interface PreviewScore {
  lines: {
    questionId: string;
    sectionId: string;
    earned: number | null;
    max: number | null;
    multiplierPct: number | null;
    isNa: boolean;
  }[];
  sections: { sectionId: string; earnedRaw: number; maxRaw: number; pct: number | null }[];
  overall: { earnedRaw: number; maxRaw: number; pct: number | null };
  result: "PASS" | "FAIL" | null;
  band: string | null;
  scaleSnapshot: {
    scaleId: string;
    name: string;
    options: {
      id: string;
      label: string;
      multiplierPct: number;
      isExcludedNa: boolean;
      color?: string | null;
      orderIndex?: number;
    }[];
  } | null;
}

/* ── Non-conformances & CAPA (P4) ────────────────────────────────────────── */

export const NC_STATES = [
  "OPEN", "IN_PROGRESS", "EXTENSION_REQUESTED", "RESOLVED",
  "VERIFIED", "REOPENED", "WAIVED", "CLOSED",
] as const;
export type NcState = (typeof NC_STATES)[number];

/** Terminal NC states — SLA countdowns hide, evidence/severity freeze. */
export const NC_TERMINAL_STATES: readonly NcState[] = ["VERIFIED", "CLOSED", "WAIVED"];

/** Legal transitions (mirror of the server's NC state machine). */
export const NC_LEGAL_TRANSITIONS: Record<NcState, NcState[]> = {
  OPEN: ["IN_PROGRESS", "WAIVED"],
  IN_PROGRESS: ["RESOLVED", "EXTENSION_REQUESTED", "WAIVED"],
  EXTENSION_REQUESTED: ["IN_PROGRESS"],
  RESOLVED: ["VERIFIED", "REOPENED"],
  VERIFIED: ["CLOSED"],
  REOPENED: ["IN_PROGRESS"],
  WAIVED: [],
  CLOSED: [],
};

export const NC_SEVERITY_BADGE: Record<NcSeverity, BadgeVariant> = {
  CRITICAL: "destructive",
  MAJOR: "warning",
  MINOR: "secondary",
};

export const NC_STATE_BADGE: Record<NcState, BadgeVariant> = {
  OPEN: "info",
  IN_PROGRESS: "warning",
  EXTENSION_REQUESTED: "outline",
  RESOLVED: "default",
  VERIFIED: "success",
  REOPENED: "destructive",
  WAIVED: "secondary",
  CLOSED: "outline",
};

export type SlaState = "DUE_SOON" | "OVERDUE" | "ON_TRACK" | "AWAITING_VERIFICATION" | null;

/** Register row — audit_non_conformances + enrich (GET /audit/ncs). */
export interface NcRow {
  id: string;
  ncNo: string;
  auditId: string;
  responseId: string | null;
  questionId: string | null;
  severity: NcSeverity;
  category: string | null;
  description: string;
  ownerId: string;
  dueAt: string;
  state: NcState;
  isOverdue: boolean;
  source: string;
  waiverReason: string | null;
  waivedBy: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  reopenCount: number;
  createdBy: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // enrich()
  ticketNo: string;
  auditTitle: string;
  propertyId: string;
  propertyName: string | null;
  ownerName: string | null;
  slaState: SlaState;
}

export interface NcAction {
  id: string;
  ncId: string;
  description: string;
  completedAt: string | null;
  submittedBy: string | null;
  createdAt: string;
  submittedByName: string | null;
}

export interface NcExtensionRequest {
  id: string;
  ncId: string;
  requestedBy: string | null;
  requestedDueAt: string;
  justification: string;
  status: "PENDING" | "APPROVED" | "DENIED";
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  createdAt: string;
  requestedByName: string | null;
}

export interface NcEvidence {
  id: string;
  kind: "NC" | "CAPA";
  url: string | null;
  thumbUrl: string | null;
  correctiveActionId: string | null;
  mime: string;
  originalName: string | null;
  capturedAt: string | null;
  isLiveCapture: boolean;
  createdAt: string;
}

/** GET /audit/ncs/:id — nc columns + names + origin audit + timeline. */
export interface NcDetailData {
  id: string;
  ncNo: string;
  auditId: string;
  responseId: string | null;
  questionId: string | null;
  severity: NcSeverity;
  category: string | null;
  description: string;
  ownerId: string;
  dueAt: string;
  state: NcState;
  isOverdue: boolean;
  source: string;
  waiverReason: string | null;
  reopenCount: number;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  ownerName: string | null;
  createdByName: string | null;
  audit: {
    id: string;
    ticketNo: string;
    title: string;
    propertyId: string;
    propertyName: string | null;
  };
  questionPrompt: string | null;
  questionType: QuestionType | null;
  actions: NcAction[];
  extensionRequests: NcExtensionRequest[];
  evidence: NcEvidence[];
}

/** "3h" / "2d" / "45m" until (or since) `dueAt`. */
export function fmtTimeLeft(dueAt: string, nowMs: number): { overdue: boolean; text: string } {
  const diff = new Date(dueAt).getTime() - nowMs;
  const mins = Math.max(1, Math.round(Math.abs(diff) / 60_000));
  const text =
    mins < 60 ? `${mins}m`
    : mins < 48 * 60 ? `${Math.round(mins / 60)}h`
    : `${Math.round(mins / (60 * 24))}d`;
  return { overdue: diff < 0, text };
}

/* ── Reports (P5) ────────────────────────────────────────────────────────── */

export type ReportStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export const REPORT_STATUS_BADGE: Record<ReportStatus, BadgeVariant> = {
  PENDING: "secondary",
  RUNNING: "info",
  COMPLETED: "success",
  FAILED: "destructive",
};

/** Registry row — audit_reports + enrich (GET /audit/reports). */
export interface ReportRow {
  id: string;
  reportNo: string;
  auditId: string;
  revision: number;
  status: ReportStatus;
  sizeBytes: number | null;
  attempts: number;
  error: string | null;
  generatedAt: string | null;
  createdAt: string;
  ticketNo: string;
  title: string;
  auditState: AuditState;
  auditType: AuditType;
  propertyName: string | null;
}

export interface ReportShare {
  id: string;
  reportId: string;
  token: string;
  channel: string;
  recipient: string | null;
  expiresAt: string;
  revokedAt: string | null;
  accessCount: number;
  lastAccessAt: string | null;
  createdAt: string;
}

/** GET /audit/reports/:id — report + ticket + resolved url + shares. */
export interface ReportDetail {
  id: string;
  reportNo: string;
  auditId: string;
  revision: number;
  status: ReportStatus;
  sizeBytes: number | null;
  error: string | null;
  generatedAt: string | null;
  createdAt: string;
  ticketNo: string;
  title: string;
  /** May be a data: URL in dev (inline storage). */
  url: string | null;
  shares: ReportShare[];
}

export const NAMED_REPORTS: { key: string; title: string; description: string }[] = [
  { key: "audit-summary", title: "Audit Summary", description: "Every audit in scope with status, score and result." },
  { key: "property-compliance", title: "Property Compliance", description: "Per-property audit counts, average score and compliance %." },
  { key: "auditor-performance", title: "Auditor Performance", description: "Completions, on-time % and average duration per auditor." },
  { key: "failed-audits", title: "Failed Audits", description: "Audits whose frozen result is FAIL." },
  { key: "overdue-audits", title: "Overdue Audits", description: "Open audits past their due date." },
];

export interface NamedReportResult {
  title: string;
  headers: string[];
  rows: (string | number)[][];
}

/** GET /audit/reports/dashboard/summary. */
export interface DashboardSummary {
  statusCounts: Record<string, number>;
  kpis: {
    completionRate: number;
    averageScore: number;
    onTimePct: number;
    overdueCount: number;
    compliancePct: number;
    activeAuditors: number;
    totalAudits: number;
  };
  ncAnalytics: {
    bySeverity: { severity: NcSeverity; state: NcState; count: number }[];
    total: number;
    capaClosureRate: number;
    topFailingQuestions: { prompt: string; count: number }[];
  };
  scoreTrend: { month: string; avgScore: number; count: number }[];
  volumeByTemplate?: { templateId: string; templateName: string; auditType: AuditType; count: number }[];
}

/* ── Review workspace (P5) ───────────────────────────────────────────────── */

export interface WorkspaceEvidence extends RunEvidence {
  ncId?: string | null;
}

export interface WorkspaceNc {
  id: string;
  ncNo: string;
  questionId: string | null;
  severity: NcSeverity;
  state: NcState;
  description: string;
  ownerId: string;
  dueAt: string;
  source: string;
  createdAt: string;
}

export interface WorkspaceReview {
  id: string;
  verdict: string;
  comments: string | null;
  reviewerName: string | null;
  createdAt: string;
}

/** GET /audit/reviews/:id/workspace. */
export interface ReviewWorkspaceData {
  audit: AuditRow;
  template: { id: string; name: string } | null;
  version: {
    id: string;
    versionNo: number;
    passThresholdPct: string | null;
    criticalFailGate: boolean;
  } | null;
  target: { propertyName: string | null; roomNumber: string | null };
  assignee: { id: string; name: string; role: string } | null;
  scaleSnapshot: ScaleSnapshot | null;
  sections: RunSection[];
  responses: RunResponse[];
  evidence: WorkspaceEvidence[];
  submissionProof: WorkspaceEvidence | null;
  ncs: WorkspaceNc[];
  sectionScores: { sectionId: string; title: string; earned: number; possible: number; pct: number | null }[];
  reviews: WorkspaceReview[];
}

/** Human answer label for a read-only response (review workspace). */
export function answerLabel(
  question: Pick<RunQuestion, "type" | "optionsJson" | "numericUnit">,
  answerJson: unknown,
  snapshot: ScaleSnapshot | null,
): string | null {
  if (answerJson == null) return null;
  const a = answerJson as Record<string, unknown>;
  switch (question.type) {
    case "YES_NO_NA": {
      const v = String(a["value"] ?? "").toUpperCase();
      return v === "NA" ? "N/A" : v ? titleCase(v) : null;
    }
    case "PASS_FAIL": {
      const v = String(a["value"] ?? "").toUpperCase();
      return v ? titleCase(v) : null;
    }
    case "RATING": {
      const option = snapshot?.options.find((o) => o.id === String(a["optionId"] ?? ""));
      return option?.label ?? null;
    }
    case "SINGLE_CHOICE": {
      const option = (question.optionsJson ?? []).find((o) => o.id === String(a["optionId"] ?? ""));
      return option?.label ?? null;
    }
    case "MULTI_CHOICE": {
      const ids = Array.isArray(a["optionIds"]) ? (a["optionIds"] as unknown[]).map(String) : [];
      const labels = (question.optionsJson ?? []).filter((o) => ids.includes(o.id)).map((o) => o.label);
      return labels.length ? labels.join(", ") : null;
    }
    case "NUMERIC": {
      const v = a["value"];
      if (v == null || v === "") return null;
      return `${v}${question.numericUnit ? ` ${question.numericUnit}` : ""}`;
    }
    case "TEXT":
      return a["value"] != null && a["value"] !== "" ? String(a["value"]) : null;
    case "DATE":
      return a["value"] != null ? fmtDate(String(a["value"])) : null;
    case "SIGNATURE":
      return a["dataUrl"] ? "Signed" : null;
    case "PHOTO":
      return "Photo attached";
    default:
      return null;
  }
}

/* ── Trail explorer (P5) ─────────────────────────────────────────────────── */

export interface TrailEvent {
  id: string;
  seq: number;
  entityType: string;
  entityId: string;
  auditId: string | null;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  kind: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  firstBrokenSeq?: number;
  verifiedAt: string;
}

/* ── New-audit creation & subset picker (ad-hoc / CX) ────────────────────── */

/** Section/question tree returned by GET /audit/templates/versions/:vid. */
export interface VersionSubsetSection {
  id: string;
  title: string;
  questions: { id: string; prompt: string; type: QuestionType; weight: number }[];
}

export interface VersionSubset {
  sections: VersionSubsetSection[];
}

/** A comment attachment (image/pdf) round-tripped by the comments endpoints. */
export interface CommentAttachment {
  mime: string;
  originalName: string | null;
  url: string;
  thumbUrl: string | null;
}

/* ── Admin feature toggles (GET/PUT /audit/admin/feature-toggles) ────────── */

export type WeightMode = "numeric" | "percentage";

export interface FeatureToggles {
  show_weightage: boolean;
  score_display: boolean;
  show_priority_column: boolean;
  weight_mode: WeightMode;
  verify_stage_default: boolean;
  allow_reopen: boolean;
  zero_tolerance_default: boolean;
  create_form_show_description: boolean;
  create_form_show_assignee: boolean;
  create_form_show_schedule: boolean;
}

/* ── Master-data browser (GET /audit/admin/master-data) ──────────────────── */

export interface MasterData {
  sync: { status: string; source: string; lastSyncedAt: string | null };
  counts: { zones: number; cities: number; clusters: number; properties: number; rooms: number };
  properties: { id: string; name: string; clusterId: string | null; city: string | null; auditsGenerated: number }[];
  zones: { id: string; name: string }[];
  cities: { id: string; name: string; zoneId: string | null }[];
  clusters: { id: string; name: string; cityId: string | null }[];
}

/* ── Auditor load preview (GET /audit/schedules/view/load-preview) ───────── */

export interface LoadPreview {
  window: { from: string; to: string };
  byAuditor: { assigneeId: string; assigneeName: string; assigneeRole: string; count: number }[];
  unassignedByRule: number;
}

/* ── Near-duplicate detection (GET /audit/bank/check-duplicate) ──────────── */

export interface DuplicateMatch {
  id: string;
  prompt: string;
  similarity: number;
}

export interface DuplicateCheck {
  duplicates: DuplicateMatch[];
}

/* ── Per-template access scoping (PATCH /audit/templates/:id) ─────────────── */

export interface AccessScope {
  clusterIds?: string[];
  cityIds?: string[];
  roles?: string[];
}

/* ── Formatting helpers ──────────────────────────────────────────────────── */

export function fmtDate(d: string | null | undefined): string {
  return d ? new Date(d).toLocaleDateString("en-IN") : "—";
}

export function fmtDateTime(d: string | null | undefined): string {
  return d
    ? new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Total possible points of a section = Σ weight of scorable questions. */
export function sectionPoints(questions: { type: QuestionType; weight: number }[]): number {
  return questions.reduce(
    (sum, q) => sum + (NON_SCORED_TYPES.has(q.type) ? 0 : q.weight),
    0,
  );
}
