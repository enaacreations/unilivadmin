import { Router } from "express";
import { db } from "@workspace/db";
import {
  coursesTable,
  courseEnrollmentsTable,
  employeesTable,
  usersTable,
} from "@workspace/db";
import { eq, sql, ilike, and, inArray, desc } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { pick } from "../lib/authz.js";
import { notify } from "../lib/notification-service.js";
import { getPagination, buildMeta } from "../lib/paginate.js";
import { newId } from "../lib/id.js";

export const coursesRouter: Router = Router();

async function enrichCourse(c: typeof coursesTable.$inferSelect) {
  const [enr] = await db.select({ count: sql<number>`count(*)::int` }).from(courseEnrollmentsTable).where(eq(courseEnrollmentsTable.courseId, c.id));
  const [comp] = await db.select({ count: sql<number>`count(*)::int` }).from(courseEnrollmentsTable).where(and(eq(courseEnrollmentsTable.courseId, c.id), eq(courseEnrollmentsTable.completed, true)));
  const enrolled = enr.count, completed = comp.count;
  return { ...c, enrollmentCount: enrolled, completedCount: completed, completionRate: enrolled ? Math.round((completed / enrolled) * 1000) / 10 : 0 };
}

coursesRouter.get("/", authenticate, authorize("LND", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const search = req.query["search"] as string | undefined;
    const category = req.query["category"] as string | undefined;
    const mandatoryOnly = req.query["mandatoryOnly"] as string | undefined;
    const targetRole = req.query["targetRole"] as string | undefined;
    const conds = [];
    if (search) conds.push(ilike(coursesTable.title, `%${search}%`));
    if (category) conds.push(eq(coursesTable.category, category));
    if (mandatoryOnly === "true") conds.push(eq(coursesTable.isMandatory, true));
    if (targetRole) conds.push(sql`${coursesTable.targetRoles} @> ${JSON.stringify([targetRole])}::jsonb`);
    const where = conds.length ? and(...conds) : undefined;
    const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(coursesTable).where(where);
    const rows = await db.select().from(coursesTable).where(where).limit(limit).offset(offset).orderBy(desc(coursesTable.createdAt));
    const enriched = await Promise.all(rows.map(enrichCourse));
    res.json({ success: true, data: enriched, meta: buildMeta(c.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

coursesRouter.get("/stats", authenticate, authorize("LND", "view"), async (_req, res) => {
  try {
    // department-wise completion rate
    const allEmps = await db.select().from(employeesTable);
    const allEnrollments = await db.select().from(courseEnrollmentsTable);
    const empMap = new Map(allEmps.map((e) => [e.id, e]));
    const byDept: Record<string, { total: number; completed: number }> = {};
    for (const en of allEnrollments) {
      const emp = empMap.get(en.employeeId);
      const dept = emp?.department || "Unassigned";
      if (!byDept[dept]) byDept[dept] = { total: 0, completed: 0 };
      byDept[dept].total++;
      if (en.completed) byDept[dept].completed++;
    }
    const departmentCompletion = Object.entries(byDept).map(([dept, v]) => ({
      department: dept,
      total: v.total,
      completed: v.completed,
      rate: v.total ? Math.round((v.completed / v.total) * 1000) / 10 : 0,
    }));

    // mandatory compliance
    const mandatoryCourses = await db.select().from(coursesTable).where(eq(coursesTable.isMandatory, true));
    let mandTotal = 0, mandCompleted = 0;
    for (const mc of mandatoryCourses) {
      const enrs = await db.select().from(courseEnrollmentsTable).where(eq(courseEnrollmentsTable.courseId, mc.id));
      mandTotal += enrs.length;
      mandCompleted += enrs.filter((e) => e.completed).length;
    }
    const mandatoryComplianceRate = mandTotal ? Math.round((mandCompleted / mandTotal) * 1000) / 10 : 0;

    // certificates
    const certified = await db.select().from(courseEnrollmentsTable).where(and(eq(courseEnrollmentsTable.completed, true), sql`${courseEnrollmentsTable.score} IS NOT NULL`));
    const certificates = await Promise.all(certified.slice(0, 100).map(async (en) => {
      const [c] = await db.select({ title: coursesTable.title }).from(coursesTable).where(eq(coursesTable.id, en.courseId));
      const [e] = await db.select({ name: employeesTable.name, employeeCode: employeesTable.employeeCode }).from(employeesTable).where(eq(employeesTable.id, en.employeeId));
      return {
        enrollmentId: en.id,
        employeeName: e?.name || "—",
        employeeCode: e?.employeeCode || "—",
        courseTitle: c?.title || "—",
        score: en.score,
        completedAt: en.completedAt,
      };
    }));

    res.json({ success: true, data: { departmentCompletion, mandatoryComplianceRate, mandTotal, mandCompleted, certificates } });
  } catch (err) { _req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

coursesRouter.get("/:id", authenticate, authorize("LND", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(coursesTable).where(eq(coursesTable.id, req.params["id"]!));
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: await enrichCourse(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

coursesRouter.post("/", authenticate, authorize("LND", "create"), async (req, res) => {
  try {
    const body = req.body;
    const [row] = await db.insert(coursesTable).values({
      id: newId(),
      title: body.title,
      description: body.description,
      category: body.category,
      targetRoles: body.targetRoles || [],
      contentUrl: body.contentUrl,
      contentType: body.contentType,
      thumbnailUrl: body.thumbnailUrl,
      durationMinutes: body.durationMinutes,
      isMandatory: !!body.isMandatory,
      expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
      isActive: body.isActive !== false,
      quiz: body.quiz || null,
      passScore: body.passScore || 70,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json({ success: true, data: { ...row, enrollmentCount: 0, completedCount: 0, completionRate: 0 } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

coursesRouter.put("/:id", authenticate, authorize("LND", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, [
      "title", "description", "category", "targetRoles", "contentUrl", "contentType",
      "thumbnailUrl", "durationMinutes", "isMandatory", "expiryDate", "isActive", "quiz", "passScore",
    ]) as Record<string, unknown>;
    if (body["expiryDate"]) body["expiryDate"] = new Date(body["expiryDate"] as string);
    const [row] = await db.update(coursesTable).set({ ...body, updatedAt: new Date() }).where(eq(coursesTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: await enrichCourse(row) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

coursesRouter.delete("/:id", authenticate, authorize("LND", "delete"), async (req, res) => {
  try {
    await db.delete(courseEnrollmentsTable).where(eq(courseEnrollmentsTable.courseId, req.params["id"]!));
    await db.delete(coursesTable).where(eq(coursesTable.id, req.params["id"]!));
    res.json({ success: true, message: "Deleted" });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// course enrollments listing for a course (with employee info)
coursesRouter.get("/:id/enrollments", authenticate, authorize("LND", "view"), async (req, res) => {
  try {
    const rows = await db.select().from(courseEnrollmentsTable).where(eq(courseEnrollmentsTable.courseId, req.params["id"]!)).orderBy(desc(courseEnrollmentsTable.createdAt));
    const enriched = await Promise.all(rows.map(async (r) => {
      const [e] = await db.select({ name: employeesTable.name, employeeCode: employeesTable.employeeCode, department: employeesTable.department, role: employeesTable.designation }).from(employeesTable).where(eq(employeesTable.id, r.employeeId));
      return { ...r, employee: e || null };
    }));
    res.json({ success: true, data: enriched });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// bulk enroll
coursesRouter.post("/:id/enroll", authenticate, authorize("LND", "edit"), async (req, res) => {
  try {
    const courseId = req.params["id"]!;
    const { employeeIds } = req.body;
    if (!Array.isArray(employeeIds) || !employeeIds.length) { res.status(400).json({ success: false, error: "employeeIds[] required" }); return; }
    // dedupe — skip already enrolled
    const existing = await db.select().from(courseEnrollmentsTable).where(and(eq(courseEnrollmentsTable.courseId, courseId), inArray(courseEnrollmentsTable.employeeId, employeeIds)));
    const existingIds = new Set(existing.map((e) => e.employeeId));
    const toCreate = employeeIds.filter((id: string) => !existingIds.has(id));
    let created: typeof courseEnrollmentsTable.$inferSelect[] = [];
    if (toCreate.length) {
      created = await db.insert(courseEnrollmentsTable).values(toCreate.map((empId: string) => ({
        id: newId(), courseId, employeeId: empId, updatedAt: new Date(),
      }))).returning();
    }
    res.json({ success: true, data: { created: created.length, skipped: existingIds.size } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// send reminders to incomplete enrollments
coursesRouter.post("/:id/remind", authenticate, authorize("LND", "edit"), async (req, res) => {
  try {
    const courseId = req.params["id"]!;
    const incomplete = await db.select().from(courseEnrollmentsTable).where(and(eq(courseEnrollmentsTable.courseId, courseId), eq(courseEnrollmentsTable.completed, false)));
    const [course] = await db.select({ title: coursesTable.title }).from(coursesTable).where(eq(coursesTable.id, courseId));
    const courseTitle = course?.title || "your assigned training";

    // Resolve each incomplete enrollee's employee → user account (linked by email).
    const empIds = [...new Set(incomplete.map((e) => e.employeeId))];
    const emps = empIds.length
      ? await db.select({ id: employeesTable.id, email: employeesTable.email }).from(employeesTable).where(inArray(employeesTable.id, empIds))
      : [];
    const emails = [...new Set(emps.map((e) => e.email).filter(Boolean))];
    const users = emails.length
      ? await db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable).where(inArray(usersTable.email, emails))
      : [];
    const userByEmail = new Map(users.map((u) => [u.email, u.id]));
    const userIdByEmp = new Map(emps.map((e) => [e.id, userByEmail.get(e.email)]));

    let sent = 0;
    let failed = 0;
    for (const en of incomplete) {
      const userId = userIdByEmp.get(en.employeeId);
      if (!userId) { failed++; continue; }
      try {
        await notify({
          userId,
          title: "Training reminder",
          body: `Please complete "${courseTitle}".`,
          type: "LND_REMINDER",
          link: `/lnd/enrollments/${en.id}`,
          entityType: "course_enrollment",
          entityId: en.id,
          email: {
            subject: `Reminder: complete "${courseTitle}"`,
            text: `This is a reminder to complete your assigned training "${courseTitle}".`,
          },
        });
        sent++;
      } catch (e) {
        req.log.error(e);
        failed++;
      }
    }
    res.json({ success: true, data: { sent, failed, incomplete: incomplete.length } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// =====================================================
export const enrollmentsRouter: Router = Router();

enrollmentsRouter.get("/", authenticate, authorize("LND", "view"), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);
    const courseId = req.query["courseId"] as string | undefined;
    const employeeId = req.query["employeeId"] as string | undefined;
    const conds = [];
    if (courseId) conds.push(eq(courseEnrollmentsTable.courseId, courseId));
    if (employeeId) conds.push(eq(courseEnrollmentsTable.employeeId, employeeId));
    const where = conds.length ? and(...conds) : undefined;
    const [c] = await db.select({ count: sql<number>`count(*)::int` }).from(courseEnrollmentsTable).where(where);
    const rows = await db.select().from(courseEnrollmentsTable).where(where).limit(limit).offset(offset).orderBy(desc(courseEnrollmentsTable.createdAt));
    const enriched = await Promise.all(rows.map(async (r) => {
      const [c0] = await db.select({ title: coursesTable.title, contentType: coursesTable.contentType, contentUrl: coursesTable.contentUrl, thumbnailUrl: coursesTable.thumbnailUrl, isMandatory: coursesTable.isMandatory }).from(coursesTable).where(eq(coursesTable.id, r.courseId));
      const [e] = await db.select({ name: employeesTable.name }).from(employeesTable).where(eq(employeesTable.id, r.employeeId));
      return { ...r, courseTitle: c0?.title || null, contentType: c0?.contentType || null, contentUrl: c0?.contentUrl || null, thumbnailUrl: c0?.thumbnailUrl || null, isMandatory: c0?.isMandatory || false, employeeName: e?.name || null };
    }));
    res.json({ success: true, data: enriched, meta: buildMeta(c.count, page, limit) });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

enrollmentsRouter.post("/", authenticate, authorize("LND", "create"), async (req, res) => {
  try {
    const data = pick(req.body, ["courseId", "employeeId", "progress", "completed", "completedAt", "score", "attempts"]);
    const [row] = await db.insert(courseEnrollmentsTable).values({ id: newId(), ...data, updatedAt: new Date() }).returning();
    res.status(201).json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

enrollmentsRouter.put("/:id", authenticate, authorize("LND", "edit"), async (req, res) => {
  try {
    const body = pick(req.body, ["courseId", "employeeId", "progress", "completed", "completedAt", "score", "attempts"]) as Record<string, unknown>;
    if (body["completed"] && !body["completedAt"]) body["completedAt"] = new Date();
    const [row] = await db.update(courseEnrollmentsTable).set({ ...body, updatedAt: new Date() }).where(eq(courseEnrollmentsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// progress update — auto-flag completion when >= 80
enrollmentsRouter.post("/:id/progress", authenticate, authorize("LND", "edit"), async (req, res) => {
  try {
    const { progress } = req.body;
    const p = Math.max(0, Math.min(100, Number(progress)));
    const update: Record<string, unknown> = { progress: p, updatedAt: new Date() };
    if (p >= 80) { update["completed"] = true; update["completedAt"] = new Date(); }
    const [row] = await db.update(courseEnrollmentsTable).set(update).where(eq(courseEnrollmentsTable.id, req.params["id"]!)).returning();
    if (!row) { res.status(404).json({ success: false, error: "Not found" }); return; }
    res.json({ success: true, data: row });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});

// quiz submission — score MCQs, mark complete if pass
enrollmentsRouter.post("/:id/quiz", authenticate, authorize("LND", "edit"), async (req, res) => {
  try {
    const { answers } = req.body; // {questionIdx: selectedIdx}
    const id = req.params["id"]!;
    const [enr] = await db.select().from(courseEnrollmentsTable).where(eq(courseEnrollmentsTable.id, id));
    if (!enr) { res.status(404).json({ success: false, error: "Not found" }); return; }
    const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, enr.courseId));
    const quiz = (course?.quiz || {}) as { questions?: Array<{ correctIdx: number }> };
    const qs = quiz.questions || [];
    if (!qs.length) { res.status(400).json({ success: false, error: "Course has no quiz" }); return; }
    let correct = 0;
    qs.forEach((q, i) => { if (Number(answers?.[i]) === q.correctIdx) correct++; });
    const score = Math.round((correct / qs.length) * 100);
    const passScore = course?.passScore || 70;
    const passed = score >= passScore;
    const [row] = await db.update(courseEnrollmentsTable).set({
      score,
      attempts: enr.attempts + 1,
      completed: passed,
      completedAt: passed ? new Date() : null,
      progress: passed ? 100 : enr.progress,
      updatedAt: new Date(),
    }).where(eq(courseEnrollmentsTable.id, id)).returning();
    res.json({ success: true, data: { ...row, passed, passScore, totalQuestions: qs.length, correctAnswers: correct } });
  } catch (err) { req.log.error(err); res.status(500).json({ success: false, error: "Internal server error" }); }
});
