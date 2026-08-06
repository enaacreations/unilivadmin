/**
 * Audit & Inspection seed (run AFTER `seed` / `seed:food`, needs users + org):
 *   pnpm --filter @workspace/scripts run seed:audit
 *
 * Seeds, idempotently:
 *  1. Module configuration — rating scale (Excellent 100 / Good 94 / Average 79
 *     / Poor 0 / N/A excluded), performance bands, numbering schemes
 *     (UNI-AUD-{seq} from 4500) and app settings defaults.
 *  2. The 456-item question bank + 3 templates published as v1 (Appendix B,
 *     cleansed): Property Audit (CM), Unit Lead Room check list (UL/ROOM),
 *     CX Audit (CX). Copy-on-insert provenance links every template question
 *     to its bank item. reviewRequired: always true (PRD §8.5).
 *  3. Role grants derived from existing users (FRD §2.2 deployment model).
 *  4. Demo schedules (Property Audit monthly, UL rooms weekly) — the
 *     materializer generates tickets on next run. Never a CX schedule (C-3).
 */
import bcrypt from "bcryptjs";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  propertiesTable,
  roomsTable,
  citiesTable,
  clustersTable,
  userScopesTable,
  auditRatingScalesTable,
  auditRatingOptionsTable,
  auditPerformanceBandsTable,
  auditNumberingSchemesTable,
  auditAppSettingsTable,
  auditRoleGrantsTable,
  auditQuestionBankItemsTable,
  auditTemplatesTable,
  auditTemplateVersionsTable,
  auditSectionsTable,
  auditQuestionsTable,
  auditSchedulesTable,
  auditScheduleTargetsTable,
} from "@workspace/db";
import { randomUUID } from "crypto";
import { SEED_TEMPLATES, type SeedQuestion } from "./data/audit-question-bank";

const id = () => randomUUID();

/* ── 1. Configuration ──────────────────────────────────────────────────────── */

const SCALE_ID = "audit-scale-uniliv-standard";
const SCALE_OPTIONS = [
  { id: "audit-opt-excellent", label: "Excellent", color: "#157F5B", orderIndex: 0, multiplierPct: "100", isExcludedNa: false },
  { id: "audit-opt-good", label: "Good", color: "#4C9A2A", orderIndex: 1, multiplierPct: "94", isExcludedNa: false },
  { id: "audit-opt-average", label: "Average", color: "#9A6206", orderIndex: 2, multiplierPct: "79", isExcludedNa: false },
  { id: "audit-opt-poor", label: "Poor", color: "#C73B33", orderIndex: 3, multiplierPct: "0", isExcludedNa: false },
  { id: "audit-opt-na", label: "N/A", color: "#7C6E64", orderIndex: 4, multiplierPct: "0", isExcludedNa: true },
];

const BANDS = [
  { label: "Excellent", minPct: "90", maxPct: "100", color: "#157F5B", orderIndex: 0 },
  { label: "Good", minPct: "75", maxPct: "89.99", color: "#4C9A2A", orderIndex: 1 },
  { label: "Average", minPct: "60", maxPct: "74.99", color: "#9A6206", orderIndex: 2 },
  { label: "Poor", minPct: "0", maxPct: "59.99", color: "#C73B33", orderIndex: 3 },
];

const NUMBERING = [
  { objectType: "AUDIT", prefix: "UNI-AUD", nextSeq: 4500 },
  { objectType: "REPORT", prefix: "UNI-RPT", nextSeq: 1 },
];

const APP_SETTINGS: Record<string, unknown> = {
  na_counts_against: false,
  lookahead_days: 7,
  auto_close_days: 0,
  report_share_ttl_hours: 72,
  org_timezone: "Asia/Kolkata",
};

async function seedConfig() {
  // Rating scale (upsert by stable id).
  const [scale] = await db.select().from(auditRatingScalesTable).where(eq(auditRatingScalesTable.id, SCALE_ID));
  if (!scale) {
    await db.insert(auditRatingScalesTable).values({ id: SCALE_ID, name: "UNILIV Standard 5-level", active: true });
  }
  await db.delete(auditRatingOptionsTable).where(eq(auditRatingOptionsTable.scaleId, SCALE_ID));
  await db.insert(auditRatingOptionsTable).values(SCALE_OPTIONS.map((o) => ({ ...o, scaleId: SCALE_ID })));

  // Performance bands (replace).
  await db.delete(auditPerformanceBandsTable);
  await db.insert(auditPerformanceBandsTable).values(BANDS.map((b) => ({ id: id(), ...b })));

  // Numbering — create only if missing (never rewind live sequences).
  for (const n of NUMBERING) {
    const [existing] = await db
      .select()
      .from(auditNumberingSchemesTable)
      .where(eq(auditNumberingSchemesTable.objectType, n.objectType));
    if (!existing) {
      await db.insert(auditNumberingSchemesTable).values({
        id: id(),
        objectType: n.objectType,
        prefix: n.prefix,
        pattern: "{prefix}-{seq}",
        nextSeq: n.nextSeq,
      });
    }
  }

  // App settings (insert-if-missing so admin edits survive reseeds).
  for (const [key, value] of Object.entries(APP_SETTINGS)) {
    const [existing] = await db.select().from(auditAppSettingsTable).where(eq(auditAppSettingsTable.key, key));
    if (!existing) {
      await db.insert(auditAppSettingsTable).values({ key, valueJson: value });
    }
  }
  console.log("✓ config: scale, bands, numbering, settings");
}

/* ── 2. Question bank + templates ──────────────────────────────────────────── */

function questionRow(q: SeedQuestion, sectionId: string, orderIndex: number, bankItemId: string) {
  return {
    id: id(),
    sectionId,
    prompt: q.prompt,
    helpText: null,
    type: q.type,
    weight: q.weight,
    mandatory: q.mandatory ?? false,
    evidenceRule: "OPTIONAL" as const,
    ratingScaleId: q.type === "RATING" ? SCALE_ID : null,
    optionsJson: null,
    numericUnit: q.numericUnit ?? null,
    numericMin: null,
    numericMax: null,
    bankItemId,
    orderIndex,
  };
}

async function seedBankAndTemplates() {
  // Domain reset (audit content only; the hash-chained trail is append-only
  // history and is deliberately left untouched).
  await pool.query(`
    TRUNCATE TABLE
      audit_report_shares, audit_reports, audit_comments,
      audit_evidence, audit_responses,
      audit_reviews, audits,
      audit_schedule_targets, audit_schedules,
      audit_questions, audit_sections, audit_template_versions,
      audit_templates, audit_question_bank_items
    CASCADE
  `);

  // Bank items — one per captured Item-master row (456 after cleansing).
  // Prompts repeating across sections/templates stay distinct entries, exactly
  // like the reference Item master; QBK-04 near-duplicate detection is a UI
  // assist, not a seed constraint. Keyed template::section::index for
  // provenance linking below.
  const bankIdByKey = new Map<string, string>();
  let bankCount = 0;
  for (const template of SEED_TEMPLATES) {
    for (const [si, section] of template.sections.entries()) {
      for (const [qi, q] of section.questions.entries()) {
        const key = `${template.name}::${si}::${qi}`;
        const bankId = id();
        bankIdByKey.set(key, bankId);
        await db.insert(auditQuestionBankItemsTable).values({
          id: bankId,
          prompt: q.prompt,
          helpText: null,
          type: q.type,
          defaultWeight: q.weight,
          defaultEvidenceRule: "OPTIONAL",
          tags: q.tags,
          numericUnit: q.numericUnit ?? null,
        });
        bankCount += 1;
      }
    }
  }

  // Scale snapshot shared by all three published v1s.
  const snapshot = {
    scaleId: SCALE_ID,
    name: "UNILIV Standard 5-level",
    options: SCALE_OPTIONS.map((o) => ({
      id: o.id,
      label: o.label,
      multiplierPct: Number(o.multiplierPct),
      isExcludedNa: o.isExcludedNa,
      color: o.color,
      orderIndex: o.orderIndex,
    })),
  };

  const summaries: string[] = [];
  for (const template of SEED_TEMPLATES) {
    const templateId = id();
    const versionId = id();
    await db.insert(auditTemplatesTable).values({
      id: templateId,
      name: template.name,
      auditType: template.auditType,
      targetType: template.targetType,
      category: template.category,
      description: template.description,
    });
    // Version row must exist before sections (FK).
    await db.insert(auditTemplateVersionsTable).values({
      id: versionId,
      templateId,
      versionNo: 1,
      lifecycle: "PUBLISHED",
      changelogNote: "Initial import from reference deployment (captured 04-Jul-2026, cleansed per FRD data-quality notes)",
      passThresholdPct: "80",
      criticalFailGate: false,
      reviewRequired: true, // PRD §8.5: every submitted audit is reviewed
      ratingScaleSnapshot: snapshot,
      publishedAt: new Date(),
    });

    let questionCount = 0;
    for (let si = 0; si < template.sections.length; si++) {
      const section = template.sections[si]!;
      const sectionId = id();
      await db.insert(auditSectionsTable).values({
        id: sectionId,
        templateVersionId: versionId,
        title: section.title,
        description: null,
        audience: section.audience ?? null,
        orderIndex: si,
      });
      const rows = section.questions.map((q, qi) =>
        questionRow(q, sectionId, qi, bankIdByKey.get(`${template.name}::${si}::${qi}`)!),
      );
      if (rows.length) await db.insert(auditQuestionsTable).values(rows);
      questionCount += rows.length;
    }

    summaries.push(`${template.name}: ${template.sections.length} sections / ${questionCount} questions (v1 published)`);
  }

  console.log(`✓ bank: ${bankCount} items`);
  for (const s of summaries) console.log(`✓ ${s}`);
  if (bankCount !== 456) {
    throw new Error(`Expected 456 bank items after cleansing, got ${bankCount}`);
  }
}

/* ── 3. Role grants (FRD §2.2 deployment model) ────────────────────────────── */

async function seedGrants() {
  await pool.query(`TRUNCATE TABLE audit_role_grants`);

  const users = await db
    .select()
    .from(usersTable)
    .where(
      and(
        inArray(usersTable.role, [
          "UNIT_LEAD",
          "CLUSTER_MANAGER",
          "CUSTOMER_EXPERIENCE",
          "CITY_HEAD",
          "ZONAL_HEAD",
          "SENIOR_VICE_PRESIDENT",
        ]),
        eq(usersTable.isActive, true),
      ),
    );
  // Live grants only. These rows are turned into audit_role_grants below, so a
  // soft-revoked food grant (H5 revokes by flipping isActive, never by deleting)
  // would otherwise be laundered into audit access nobody granted.
  const scopes = await db.select().from(userScopesTable).where(eq(userScopesTable.isActive, true));
  const clusters = await db.select().from(clustersTable);
  const cities = await db.select().from(citiesTable);

  // Which cities/zones actually contain properties (property → cluster → city →
  // zone). Used to keep oversight-viewer grants non-empty despite incomplete
  // org linkage in the base data.
  const propsWithCluster = await db
    .select({ clusterId: propertiesTable.clusterId })
    .from(propertiesTable)
    .where(eq(propertiesTable.status, "ACTIVE"));
  const cityById = new Map(cities.map((c) => [c.id, c]));
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const citiesWithProperties = new Set<string>();
  const zonesWithProperties = new Set<string>();
  for (const p of propsWithCluster) {
    if (!p.clusterId) continue;
    const cluster = clusterById.get(p.clusterId);
    if (!cluster) continue;
    citiesWithProperties.add(cluster.cityId);
    const city = cityById.get(cluster.cityId);
    if (city?.zoneId) zonesWithProperties.add(city.zoneId);
  }

  const rows: (typeof auditRoleGrantsTable.$inferInsert)[] = [];
  const grant = (
    userId: string,
    moduleRole: "ADMIN" | "SCHEDULER" | "AUDITOR" | "AUDITEE" | "REVIEWER" | "VIEWER",
    auditTypes: string[],
    scope: { scopeLevel: "GLOBAL" | "ZONE" | "CITY" | "CLUSTER" | "PROPERTY"; zoneId?: string | null; cityId?: string | null; clusterId?: string | null; propertyId?: string | null },
  ) =>
    rows.push({
      id: id(),
      userId,
      moduleRole,
      auditTypes,
      scopeLevel: scope.scopeLevel,
      zoneId: scope.zoneId ?? null,
      cityId: scope.cityId ?? null,
      clusterId: scope.clusterId ?? null,
      propertyId: scope.propertyId ?? null,
      // Set explicitly to a real instant (round-trips as UTC) instead of the
      // column's defaultNow(), which writes server-local wall-clock into a
      // no-tz `timestamp` and reads back +5.5h — making the grant look
      // future-dated to resolveAuditAccess's `effectiveFrom <= new Date()`.
      effectiveFrom: new Date(),
      grantedBy: null, // seed-created
    });

  for (const user of users) {
    const userScopes = scopes.filter((s) => s.userId === user.id);
    switch (user.role) {
      case "UNIT_LEAD": {
        if (user.propertyId) {
          grant(user.id, "AUDITOR", ["UL"], { scopeLevel: "PROPERTY", propertyId: user.propertyId });
          grant(user.id, "AUDITEE", ["UL", "CM", "CX"], { scopeLevel: "PROPERTY", propertyId: user.propertyId });
        }
        break;
      }
      case "CLUSTER_MANAGER": {
        const managed = clusters.filter((c) => c.managerId === user.id).map((c) => c.id);
        const scoped = userScopes.filter((s) => s.scopeLevel === "CLUSTER" && s.clusterId).map((s) => s.clusterId as string);
        const clusterIds = [...new Set([...managed, ...scoped])];
        for (const clusterId of clusterIds) {
          grant(user.id, "AUDITOR", ["CM", "UL"], { scopeLevel: "CLUSTER", clusterId }); // C-1
          grant(user.id, "VIEWER", ["CX"], { scopeLevel: "CLUSTER", clusterId }); // C-1 read-only CX
        }
        break;
      }
      case "CUSTOMER_EXPERIENCE": {
        grant(user.id, "AUDITOR", ["CX"], { scopeLevel: "GLOBAL" }); // C-3 ad-hoc only
        break;
      }
      case "CITY_HEAD": {
        // Scope to the head's cities — but if a configured city has no
        // properties yet (incomplete org data), fall back to GLOBAL so the
        // oversight-viewer persona still sees the program (view-only, UL+CM).
        const cityIds = userScopes.filter((s) => s.scopeLevel === "CITY" && s.cityId).map((s) => s.cityId as string);
        const usable = cityIds.filter((c) => citiesWithProperties.has(c));
        if (usable.length === 0) grant(user.id, "VIEWER", ["UL", "CM"], { scopeLevel: "GLOBAL" });
        for (const cityId of usable) grant(user.id, "VIEWER", ["UL", "CM"], { scopeLevel: "CITY", cityId }); // C-2 no CX
        break;
      }
      case "ZONAL_HEAD": {
        const zoneIds = userScopes.filter((s) => s.scopeLevel === "ZONE" && s.zoneId).map((s) => s.zoneId as string);
        const usable = zoneIds.filter((z) => zonesWithProperties.has(z));
        if (usable.length === 0) grant(user.id, "VIEWER", ["UL", "CM"], { scopeLevel: "GLOBAL" });
        for (const zoneId of usable) grant(user.id, "VIEWER", ["UL", "CM"], { scopeLevel: "ZONE", zoneId }); // C-2 no CX
        break;
      }
      case "SENIOR_VICE_PRESIDENT": {
        grant(user.id, "VIEWER", ["UL", "CM"], { scopeLevel: "GLOBAL" }); // C-2 no CX
        break;
      }
    }
  }

  if (rows.length) await db.insert(auditRoleGrantsTable).values(rows);
  console.log(`✓ grants: ${rows.length} rows across ${users.length} users`);
}

/* ── 4. Demo schedules ─────────────────────────────────────────────────────── */

async function seedSchedules() {
  const [propertyTemplate] = await db
    .select({ versionId: auditTemplateVersionsTable.id })
    .from(auditTemplateVersionsTable)
    .innerJoin(auditTemplatesTable, eq(auditTemplatesTable.id, auditTemplateVersionsTable.templateId))
    .where(eq(auditTemplatesTable.name, "Property Audit"));
  const [ulTemplate] = await db
    .select({ versionId: auditTemplateVersionsTable.id })
    .from(auditTemplateVersionsTable)
    .innerJoin(auditTemplatesTable, eq(auditTemplatesTable.id, auditTemplateVersionsTable.templateId))
    .where(eq(auditTemplatesTable.name, "Unit Lead Room check list"));

  const properties = await db
    .select({ id: propertiesTable.id })
    .from(propertiesTable)
    .where(eq(propertiesTable.status, "ACTIVE"))
    .limit(3);

  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // today 00:00
  const windowEnd = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

  if (propertyTemplate && properties.length) {
    const scheduleId = id();
    await db.insert(auditSchedulesTable).values({
      id: scheduleId,
      title: "Monthly Property Audit",
      templateVersionId: propertyTemplate.versionId,
      auditType: "CM",
      frequency: "MONTHLY",
      timeOfDay: "09:00",
      windowStart,
      windowEnd,
      reminderOffsetMinutes: 30,
      assigneeRule: { kind: "ROLE_AT_TARGET", role: "CLUSTER_MANAGER" },
    });
    await db.insert(auditScheduleTargetsTable).values(
      properties.map((p) => ({
        id: id(),
        scheduleId,
        targetType: "PROPERTY" as const,
        propertyId: p.id,
        roomId: null,
      })),
    );
    console.log(`✓ schedule: Monthly Property Audit × ${properties.length} properties`);
  }

  if (ulTemplate) {
    // Rooms from an active property that has a UNIT_LEAD, so the materializer's
    // ROLE_AT_TARGET rule resolves an assignee (FRD-ASG-02).
    const rooms = await db
      .select({ id: roomsTable.id, propertyId: roomsTable.propertyId })
      .from(roomsTable)
      .innerJoin(propertiesTable, eq(propertiesTable.id, roomsTable.propertyId))
      .innerJoin(
        usersTable,
        and(eq(usersTable.propertyId, roomsTable.propertyId), eq(usersTable.role, "UNIT_LEAD")),
      )
      .where(eq(propertiesTable.status, "ACTIVE"))
      .limit(2);
    if (rooms.length) {
      const scheduleId = id();
      await db.insert(auditSchedulesTable).values({
        id: scheduleId,
        title: "Weekly Unit Lead Room Check",
        templateVersionId: ulTemplate.versionId,
        auditType: "UL",
        frequency: "WEEKLY",
        dayOfWeek: 1, // Mondays
        timeOfDay: "10:00",
        windowStart,
        windowEnd,
        reminderOffsetMinutes: 60,
        assigneeRule: { kind: "ROLE_AT_TARGET", role: "UNIT_LEAD" },
      });
      await db.insert(auditScheduleTargetsTable).values(
        rooms.map((r) => ({
          id: id(),
          scheduleId,
          targetType: "ROOM" as const,
          propertyId: r.propertyId,
          roomId: r.id,
        })),
      );
      console.log(`✓ schedule: Weekly Unit Lead Room Check × ${rooms.length} rooms`);
    }
  }
}

/**
 * Ensure a Customer Experience user exists (the CX-team persona, FRD §2.2).
 * Without one, CX audits — which are ad-hoc-only (C-3) — could never be created.
 * Idempotent: created once, reused thereafter; grants are derived from it.
 */
async function seedCxUser() {
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.role, "CUSTOMER_EXPERIENCE"));
  if (existing) return;
  const hash = await bcrypt.hash("Admin@123", 10);
  await db.insert(usersTable).values({
    id: id(),
    name: "Ananya Rao",
    email: "cx@uniliv.com",
    role: "CUSTOMER_EXPERIENCE",
    passwordHash: hash,
    isActive: true,
    updatedAt: new Date(),
  });
  console.log("✓ CX-team user created: cx@uniliv.com");
}

async function main() {
  await seedConfig();
  await seedBankAndTemplates();
  await seedCxUser();
  await seedGrants();
  await seedSchedules();
  console.log("Audit & Inspection seed complete.");
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
