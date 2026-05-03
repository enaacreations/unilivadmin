import { Router } from "express";
import crypto from "node:crypto";
import {
  db,
  kycRequestsTable,
  kycEventsTable,
  esignRequestsTable,
  esignEventsTable,
  residentsTable,
  integrationStatusTable,
} from "@workspace/db";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { eq, desc, and } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { newId } from "../lib/id.js";
import { getKYCProvider } from "../lib/kyc-providers.js";

export const kycRouter: Router = Router();
export const esignRouter: Router = Router();
export const esignPublicRouter: Router = Router();

// =====================================================================
// KYC
// =====================================================================

// List for a resident — mounted as /residents/:id/kyc
kycRouter.get("/residents/:id/kyc", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(kycRequestsTable)
      .where(eq(kycRequestsTable.residentId, req.params["id"] as string))
      .orderBy(desc(kycRequestsTable.createdAt));
    res.json({ success: true, data: rows });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Create
kycRouter.post("/residents/:id/kyc", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const residentId = req.params["id"] as string;
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, residentId));
    if (!resident) {
      res.status(404).json({ success: false, error: "Resident not found" });
      return;
    }
    const { idType, idNumber, idImageFront, idImageBack, selfieImage, provider } = req.body || {};
    if (!idType || !idNumber) {
      res.status(400).json({ success: false, error: "idType and idNumber are required" });
      return;
    }
    const adapter = getKYCProvider(provider);
    const verifyResult = await adapter.verify({
      idType,
      idNumber,
      idImageFront,
      idImageBack,
      selfieImage,
      residentName: resident.name,
    });
    const [row] = await db
      .insert(kycRequestsTable)
      .values({
        id: newId(),
        residentId,
        idType,
        idNumber,
        idImageFront: idImageFront || null,
        idImageBack: idImageBack || null,
        selfieImage: selfieImage || null,
        status: verifyResult.status,
        provider: adapter.name,
        providerRef: verifyResult.providerRef || null,
        providerData: (verifyResult.providerData as object | null) || null,
        rejectionReason: verifyResult.rejectionReason || null,
        reviewedBy: verifyResult.status !== "PENDING" ? req.user?.id ?? null : null,
        reviewedAt: verifyResult.status !== "PENDING" ? new Date() : null,
        createdBy: req.user?.id ?? null,
        updatedAt: new Date(),
      })
      .returning();
    await logKycEvent(row.id, "CREATED", req.user?.id ?? null, clientIp(req), req.headers["user-agent"] ?? null, {
      idType, provider: adapter.name, status: verifyResult.status,
    });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Verify / reject — mounted as /kyc/:id/verify
kycRouter.post("/kyc/:id/verify", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const id = req.params["id"] as string;
    const { status, rejectionReason } = req.body || {};
    if (!["VERIFIED", "REJECTED", "PENDING"].includes(status)) {
      res.status(400).json({ success: false, error: "status must be VERIFIED, REJECTED, or PENDING" });
      return;
    }
    if (status === "REJECTED" && !rejectionReason) {
      res.status(400).json({ success: false, error: "rejectionReason required when rejecting" });
      return;
    }
    const [row] = await db
      .update(kycRequestsTable)
      .set({
        status,
        rejectionReason: status === "REJECTED" ? rejectionReason : null,
        reviewedBy: req.user?.id ?? null,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(kycRequestsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }
    await logKycEvent(
      id,
      status === "VERIFIED" ? "VERIFIED" : status === "REJECTED" ? "REJECTED" : "REOPENED",
      req.user?.id ?? null,
      clientIp(req),
      req.headers["user-agent"] ?? null,
      { rejectionReason: rejectionReason ?? null },
    );
    res.json({ success: true, data: row });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

kycRouter.get("/kyc/:id/events", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const id = req.params["id"] as string;
    const events = await db
      .select()
      .from(kycEventsTable)
      .where(eq(kycEventsTable.kycRequestId, id))
      .orderBy(desc(kycEventsTable.createdAt));
    res.json({ success: true, data: events });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

kycRouter.get("/kyc/:id", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const [row] = await db.select().from(kycRequestsTable).where(eq(kycRequestsTable.id, req.params["id"] as string));
    if (!row) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }
    res.json({ success: true, data: row });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// =====================================================================
// E-Sign — admin
// =====================================================================

async function logKycEvent(
  kycRequestId: string,
  type: string,
  actorId: string | null,
  ip: string | null,
  userAgent: string | null,
  payload?: unknown,
) {
  await db.insert(kycEventsTable).values({
    id: newId(),
    kycRequestId,
    type,
    actorId,
    ip,
    userAgent,
    payload: (payload as object | null) ?? null,
  });
}

function clientIp(req: import("express").Request): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]!.trim();
  return req.ip ?? null;
}

async function logEvent(
  esignRequestId: string,
  type: string,
  ip: string | null,
  userAgent: string | null,
  payload?: unknown,
) {
  await db.insert(esignEventsTable).values({
    id: newId(),
    esignRequestId,
    type,
    ip,
    userAgent,
    payload: (payload as object | null) ?? null,
  });
}

// List for a resident — mounted as /residents/:id/esign
esignRouter.get("/residents/:id/esign", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(esignRequestsTable)
      .where(eq(esignRequestsTable.residentId, req.params["id"] as string))
      .orderBy(desc(esignRequestsTable.createdAt));
    res.json({ success: true, data: rows.map((r) => ({ ...r, documentBody: undefined })) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Create — mounted as /residents/:id/esign
esignRouter.post("/residents/:id/esign", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const residentId = req.params["id"] as string;
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, residentId));
    if (!resident) {
      res.status(404).json({ success: false, error: "Resident not found" });
      return;
    }
    const { documentName, documentBody, signerEmail, signerPhone, expiresInDays } = req.body || {};
    if (!documentName || !documentBody) {
      res.status(400).json({ success: false, error: "documentName and documentBody are required" });
      return;
    }
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + (Number(expiresInDays) || 14) * 86400000);
    const [row] = await db
      .insert(esignRequestsTable)
      .values({
        id: newId(),
        residentId,
        documentName,
        documentBody,
        signerEmail: signerEmail || resident.email || null,
        signerPhone: signerPhone || resident.phone || null,
        signerToken: token,
        status: "PENDING",
        expiresAt,
        createdBy: req.user?.id ?? null,
        updatedAt: new Date(),
      })
      .returning();
    await logEvent(row.id, "CREATED", clientIp(req), req.headers["user-agent"] ?? null, {
      by: req.user?.id,
      documentName,
    });
    const origin =
      req.headers["origin"] ||
      `${req.protocol}://${req.headers["host"]}`;
    res.status(201).json({
      success: true,
      data: { ...row, documentBody: undefined, signerUrl: `${origin}/esign/sign/${token}` },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Get one with events — mounted as /esign/:id
esignRouter.get("/esign/:id", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const id = req.params["id"] as string;
    const [row] = await db.select().from(esignRequestsTable).where(eq(esignRequestsTable.id, id));
    if (!row) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }
    const events = await db
      .select()
      .from(esignEventsTable)
      .where(eq(esignEventsTable.esignRequestId, id))
      .orderBy(desc(esignEventsTable.createdAt));
    const origin =
      req.headers["origin"] || `${req.protocol}://${req.headers["host"]}`;
    res.json({
      success: true,
      data: { ...row, signerUrl: `${origin}/esign/sign/${row.signerToken}`, events },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Download signed PDF — mounted as /esign/:id/pdf
esignRouter.get("/esign/:id/pdf", authenticate, authorize("RESIDENTS", "view"), async (req, res) => {
  try {
    const id = req.params["id"] as string;
    const [row] = await db.select().from(esignRequestsTable).where(eq(esignRequestsTable.id, id));
    if (!row || !row.signedPdf) {
      res.status(404).json({ success: false, error: "No signed PDF available" });
      return;
    }
    const m = row.signedPdf.match(/^data:application\/pdf;base64,(.+)$/);
    if (!m) {
      res.status(500).json({ success: false, error: "Stored PDF malformed" });
      return;
    }
    const buf = Buffer.from(m[1]!, "base64");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${row.documentName.replace(/[^a-z0-9_\-]+/gi, "_")}-signed.pdf"`);
    res.send(buf);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Cancel / void — mounted as /esign/:id/void
esignRouter.post("/esign/:id/void", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const id = req.params["id"] as string;
    const [row] = await db
      .update(esignRequestsTable)
      .set({ status: "VOIDED", updatedAt: new Date() })
      .where(eq(esignRequestsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }
    await logEvent(id, "VOIDED", clientIp(req), req.headers["user-agent"] ?? null, { by: req.user?.id });
    res.json({ success: true, data: { ...row, documentBody: undefined } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// =====================================================================
// E-Sign — public signer endpoints (NO auth, token-gated)
// =====================================================================

esignPublicRouter.get("/sign/:token", async (req, res) => {
  try {
    const token = req.params["token"] as string;
    const [row] = await db.select().from(esignRequestsTable).where(eq(esignRequestsTable.signerToken, token));
    if (!row) {
      res.status(404).json({ success: false, error: "Invalid signing link" });
      return;
    }
    if (row.status === "SIGNED") {
      res.json({
        success: true,
        data: {
          documentName: row.documentName,
          documentBody: row.documentBody,
          status: row.status,
          signedAt: row.signedAt,
          signerName: row.signerName,
          signatureSvg: row.signatureSvg,
        },
      });
      return;
    }
    if (row.status === "VOIDED") {
      res.status(410).json({ success: false, error: "This signing link has been voided" });
      return;
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      if (row.status !== "EXPIRED") {
        await db.update(esignRequestsTable).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(esignRequestsTable.id, row.id));
        await logEvent(row.id, "EXPIRED", clientIp(req), req.headers["user-agent"] ?? null);
      }
      res.status(410).json({ success: false, error: "This signing link has expired" });
      return;
    }
    // mark first-view
    if (row.status === "PENDING") {
      await db
        .update(esignRequestsTable)
        .set({ status: "VIEWED", viewedAt: new Date(), updatedAt: new Date() })
        .where(eq(esignRequestsTable.id, row.id));
      await logEvent(row.id, "VIEWED", clientIp(req), req.headers["user-agent"] ?? null);
    }
    res.json({
      success: true,
      data: {
        documentName: row.documentName,
        documentBody: row.documentBody,
        status: row.status === "PENDING" ? "VIEWED" : row.status,
        expiresAt: row.expiresAt,
      },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

async function buildSignedPdf(opts: {
  documentName: string;
  documentBody: string;
  signerName: string;
  signedAt: Date;
  signerIp: string | null;
  signatureDataUrl: string;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  const margin = 50;
  let y = 800;
  page.drawText(opts.documentName, { x: margin, y, size: 18, font: fontBold, color: rgb(0, 0, 0) });
  y -= 30;
  const lines = opts.documentBody.split(/\r?\n/);
  const wrap = (t: string, max = 90): string[] => {
    const out: string[] = [];
    for (const ln of t.split("\n")) {
      if (ln.length <= max) { out.push(ln); continue; }
      const words = ln.split(" "); let cur = "";
      for (const w of words) {
        if ((cur + " " + w).trim().length > max) { out.push(cur); cur = w; } else { cur = (cur ? cur + " " : "") + w; }
      }
      if (cur) out.push(cur);
    }
    return out;
  };
  for (const raw of lines) {
    for (const ln of wrap(raw)) {
      if (y < 120) { page = pdf.addPage([595, 842]); y = 800; }
      page.drawText(ln, { x: margin, y, size: 11, font, color: rgb(0.1, 0.1, 0.1) });
      y -= 16;
    }
  }
  if (y < 200) { page = pdf.addPage([595, 842]); y = 800; }
  y -= 20;
  page.drawText("Signature:", { x: margin, y, size: 11, font: fontBold });
  y -= 80;
  try {
    const m = opts.signatureDataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
    if (m) {
      const bytes = Buffer.from(m[2]!, "base64");
      const img = m[1] === "png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const w = 200, h = 70;
      page.drawImage(img, { x: margin, y, width: w, height: h });
    }
  } catch { /* ignore signature embed errors */ }
  y -= 10;
  page.drawText(`Signed by: ${opts.signerName}`, { x: margin, y, size: 11, font: fontBold });
  y -= 16;
  page.drawText(`At: ${opts.signedAt.toISOString()}`, { x: margin, y, size: 10, font });
  y -= 14;
  if (opts.signerIp) {
    page.drawText(`IP: ${opts.signerIp}`, { x: margin, y, size: 10, font });
  }
  return await pdf.save();
}

esignPublicRouter.post("/sign/:token", async (req, res) => {
  try {
    const token = req.params["token"] as string;
    const { signerName, signatureSvg } = req.body || {};
    if (!signerName || !signatureSvg) {
      res.status(400).json({ success: false, error: "signerName and signatureSvg are required" });
      return;
    }
    const [row] = await db.select().from(esignRequestsTable).where(eq(esignRequestsTable.signerToken, token));
    if (!row) {
      res.status(404).json({ success: false, error: "Invalid signing link" });
      return;
    }
    if (row.status === "SIGNED") {
      res.status(409).json({ success: false, error: "Document already signed" });
      return;
    }
    if (row.status === "VOIDED") {
      res.status(410).json({ success: false, error: "This signing link has been voided" });
      return;
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      res.status(410).json({ success: false, error: "This signing link has expired" });
      return;
    }
    const ip = clientIp(req);
    const ua = req.headers["user-agent"] ?? null;
    const now = new Date();
    let signedPdfDataUrl: string | null = null;
    try {
      const pdfBytes = await buildSignedPdf({
        documentName: row.documentName,
        documentBody: row.documentBody,
        signerName,
        signedAt: now,
        signerIp: ip,
        signatureDataUrl: signatureSvg,
      });
      signedPdfDataUrl = `data:application/pdf;base64,${Buffer.from(pdfBytes).toString("base64")}`;
    } catch (e) {
      req.log.error({ err: e }, "PDF generation failed");
    }
    const [updated] = await db
      .update(esignRequestsTable)
      .set({
        status: "SIGNED",
        signedAt: now,
        signerName,
        signatureSvg,
        signerIp: ip,
        signerUserAgent: ua,
        signedPdf: signedPdfDataUrl,
        updatedAt: now,
      })
      .where(eq(esignRequestsTable.id, row.id))
      .returning();
    await logEvent(row.id, "SIGNED", ip, ua, { signerName, pdfGenerated: !!signedPdfDataUrl });
    res.json({
      success: true,
      data: {
        documentName: updated.documentName,
        status: updated.status,
        signedAt: updated.signedAt,
        signerName: updated.signerName,
      },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// =====================================================================
// KYC gate toggle (uses integration_status row "KYC_GATE")
// =====================================================================

export async function isKycGateEnabled(): Promise<boolean> {
  const [row] = await db
    .select()
    .from(integrationStatusTable)
    .where(eq(integrationStatusTable.name, "KYC_GATE"));
  return !!row?.enabled;
}

export async function residentMeetsActivationRequirements(residentId: string): Promise<{ ok: boolean; reason?: string }> {
  const [kyc] = await db
    .select()
    .from(kycRequestsTable)
    .where(and(eq(kycRequestsTable.residentId, residentId), eq(kycRequestsTable.status, "VERIFIED")))
    .limit(1);
  if (!kyc) return { ok: false, reason: "No verified KYC on file" };
  const [esign] = await db
    .select()
    .from(esignRequestsTable)
    .where(and(eq(esignRequestsTable.residentId, residentId), eq(esignRequestsTable.status, "SIGNED")))
    .limit(1);
  if (!esign) return { ok: false, reason: "No signed agreement on file" };
  return { ok: true };
}
