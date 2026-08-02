import { Router } from "express";
import crypto from "node:crypto";
import {
  db,
  kycRequestsTable,
  kycEventsTable,
  esignRequestsTable,
  esignEventsTable,
  residentsTable,
  propertiesTable,
  integrationStatusTable,
} from "@workspace/db";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { eq, desc, and } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { newId } from "../lib/id.js";
import {
  getKYCProvider,
  isDigiLockerConfigured,
  getDigiLockerAuthorizeUrl,
  exchangeDigiLockerCode,
} from "../lib/kyc-providers.js";
import { encryptNullable, decrypt, blindIndex } from "../lib/field-crypto.js";
import { renderAgreement, type AgreementData } from "../lib/agreement-template.js";

export const kycRouter: Router = Router();
export const esignRouter: Router = Router();
export const esignPublicRouter: Router = Router();

// ---------------------------------------------------------------------
// Government-ID masking — never echo a raw Aadhaar/PAN back to a client.
// ---------------------------------------------------------------------

/** Mask an Aadhaar to its last 4 digits, e.g. "XXXX XXXX 1234". */
function maskAadhaar(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  const digits = value.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  if (!last4) return "XXXX XXXX XXXX";
  return `XXXX XXXX ${last4}`;
}

/** Mask a PAN (or any other id) to its last 4 chars, e.g. "XXXXXX1234". */
function maskPan(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  const last4 = value.slice(-4);
  return `${"X".repeat(Math.max(0, value.length - 4))}${last4}`;
}

/** Mask the stored government-id number based on its idType. */
function maskIdNumber(idType: string | null | undefined, idNumber: string | null | undefined): string | null {
  if (!idNumber) return idNumber ?? null;
  return String(idType).toUpperCase() === "AADHAAR" ? maskAadhaar(idNumber) : maskPan(idNumber);
}

type KycRow = typeof kycRequestsTable.$inferSelect;

/**
 * List projection: mask the id number and drop raw document/selfie images.
 * The id number is decrypted first (legacy-tolerant) so masking always runs on
 * plaintext; the blind index is internal and never leaves the API.
 */
function kycListView(row: KycRow) {
  const {
    idImageFront: _f,
    idImageBack: _b,
    selfieImage: _s,
    providerData: _p,
    idNumberIndex: _ix,
    ...rest
  } = row;
  return { ...rest, idNumber: maskIdNumber(row.idType, decrypt(row.idNumber)) };
}

/**
 * Detail/create projection: mask the id number but keep document images.
 * All sensitive fields are decrypted on the way out (legacy plaintext passes
 * through unchanged), so the response shape is identical to before: masked
 * idNumber + decrypted image data URLs. The blind index is stripped.
 */
function kycDetailView(row: KycRow) {
  const { idNumberIndex: _ix, ...rest } = row;
  return {
    ...rest,
    idNumber: maskIdNumber(row.idType, decrypt(row.idNumber)),
    idImageFront: decrypt(row.idImageFront),
    idImageBack: decrypt(row.idImageBack),
    selfieImage: decrypt(row.selfieImage),
  };
}

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
    res.json({ success: true, data: rows.map(kycListView) });
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
    // Encrypt sensitive fields at rest (WS5). idNumber is required, so its
    // envelope is always non-null; the blind index enables exact-match search.
    const [row] = await db
      .insert(kycRequestsTable)
      .values({
        id: newId(),
        residentId,
        idType,
        idNumber: encryptNullable(idNumber)!,
        idNumberIndex: blindIndex(idNumber),
        idImageFront: encryptNullable(idImageFront),
        idImageBack: encryptNullable(idImageBack),
        selfieImage: encryptNullable(selfieImage),
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
    res.status(201).json({ success: true, data: kycDetailView(row) });
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
    res.json({ success: true, data: kycDetailView(row) });
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

// ---------------------------------------------------------------------
// DigiLocker (O27)
//
// initiate: returns the OAuth2 authorize URL for an existing KYC request (state
// carries the kycRequestId). 503 when DigiLocker is not configured.
// callback:  PUBLIC (DigiLocker redirects the user-agent here with ?code&state,
// no bearer token). Exchanges the code for a token and marks the KYC request
// VERIFIED with provider='DIGILOCKER'. Never crashes when unconfigured.
// ---------------------------------------------------------------------

// GET /kyc/:id/digilocker/initiate  — authenticated
kycRouter.get("/kyc/:id/digilocker/initiate", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    if (!isDigiLockerConfigured()) {
      res.status(503).json({ success: false, error: "DigiLocker is not configured" });
      return;
    }
    const id = req.params["id"] as string;
    const [row] = await db.select().from(kycRequestsTable).where(eq(kycRequestsTable.id, id));
    if (!row) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }
    const authorizeUrl = getDigiLockerAuthorizeUrl(id);
    if (!authorizeUrl) {
      res.status(503).json({ success: false, error: "DigiLocker is not configured" });
      return;
    }
    await logKycEvent(id, "DIGILOCKER_INITIATED", req.user?.id ?? null, clientIp(req), req.headers["user-agent"] ?? null);
    res.json({ success: true, data: { authorizeUrl } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// GET /kyc/digilocker/callback  — PUBLIC (no auth; DigiLocker redirect target)
kycRouter.get("/kyc/digilocker/callback", async (req, res) => {
  try {
    if (!isDigiLockerConfigured()) {
      res.status(503).json({ success: false, error: "DigiLocker is not configured" });
      return;
    }
    const code = req.query["code"] as string | undefined;
    const state = req.query["state"] as string | undefined; // = kycRequestId
    const oauthError = req.query["error"] as string | undefined;
    if (oauthError) {
      res.status(400).json({ success: false, error: `DigiLocker returned an error: ${oauthError}` });
      return;
    }
    if (!code || !state) {
      res.status(400).json({ success: false, error: "Missing code or state" });
      return;
    }
    const [row] = await db.select().from(kycRequestsTable).where(eq(kycRequestsTable.id, state));
    if (!row) {
      res.status(404).json({ success: false, error: "Unknown KYC request" });
      return;
    }
    let token: { providerRef: string | null; raw: Record<string, unknown> };
    try {
      token = await exchangeDigiLockerCode(code);
    } catch (e) {
      req.log.error({ err: e }, "DigiLocker token exchange failed");
      await logKycEvent(state, "DIGILOCKER_FAILED", null, clientIp(req), req.headers["user-agent"] ?? null, {
        message: (e as Error).message,
      });
      res.status(502).json({ success: false, error: "DigiLocker verification failed" });
      return;
    }
    const [updated] = await db
      .update(kycRequestsTable)
      .set({
        status: "VERIFIED",
        provider: "DIGILOCKER",
        providerRef: token.providerRef,
        // Do NOT store the raw access token; keep only a non-sensitive marker.
        providerData: { source: "DIGILOCKER", verifiedAt: new Date().toISOString() },
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(kycRequestsTable.id, state))
      .returning();
    await logKycEvent(state, "VERIFIED", null, clientIp(req), req.headers["user-agent"] ?? null, {
      provider: "DIGILOCKER",
    });
    res.json({ success: true, data: kycDetailView(updated) });
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
    res.json({ success: true, data: kycDetailView(row) });
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

// ---------------------------------------------------------------------
// Rent Agreement generation (O26)
//
// The licensor (operating entity) name + address are sourced from env/config so
// they can be set per deployment without a code change. Defaults keep the
// interim document complete in dev.
// ---------------------------------------------------------------------

const LICENSOR_NAME = process.env["AGREEMENT_LICENSOR_NAME"] || "Uniliv (Operator)";
const LICENSOR_ADDRESS = process.env["AGREEMENT_LICENSOR_ADDRESS"] || null;

/** Canonical document name for the rent agreement esign request. */
export const RENT_AGREEMENT_DOC_NAME = "Rent Agreement";

type ResidentRow = typeof residentsTable.$inferSelect;
type PropertyRow = typeof propertiesTable.$inferSelect;

/** Build AgreementData from a resident + their property + env licensor. */
function buildAgreementData(resident: ResidentRow, property: PropertyRow): AgreementData {
  return {
    resident: {
      id: resident.id,
      name: resident.name,
      phone: resident.phone,
      email: resident.email,
      gender: resident.gender,
      dob: resident.dob,
      bedOrRoomNo: resident.roomId ?? null,
      checkInDate: resident.checkInDate,
      checkOutDate: resident.checkOutDate,
      monthlyRent: resident.monthlyRent,
      securityDeposit: resident.securityDeposit,
    },
    property: {
      name: property.name,
      code: property.code,
      address: property.address,
      city: property.city,
      state: property.state,
      pincode: property.pincode,
    },
    licensorName: LICENSOR_NAME,
    licensorAddress: LICENSOR_ADDRESS,
  };
}

/**
 * Create a PENDING 'Rent Agreement' esign request for a resident, with a freshly
 * rendered interim agreement body (encrypted at rest). Idempotent-friendly: the
 * caller decides whether to skip when an existing draft is present. Returns the
 * inserted row, or null when the resident has no property (cannot render).
 *
 * Reused by the dedicated esign endpoint below AND by resident-create
 * auto-generation in residents.ts, so signing logic is never duplicated — the
 * resident still signs via the existing public /sign/:token flow.
 */
export async function createRentAgreementEsign(
  residentId: string,
  createdBy: string | null,
  expiresInDays = 14,
): Promise<typeof esignRequestsTable.$inferSelect | null> {
  const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, residentId));
  if (!resident || !resident.propertyId) return null;
  const [property] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, resident.propertyId));
  if (!property) return null;

  const documentBody = renderAgreement(buildAgreementData(resident, property));
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000);
  const [row] = await db
    .insert(esignRequestsTable)
    .values({
      id: newId(),
      residentId,
      documentName: RENT_AGREEMENT_DOC_NAME,
      documentBody: encryptNullable(documentBody)!,
      signerEmail: resident.email || null,
      signerPhone: resident.phone || null,
      signerToken: token,
      status: "PENDING",
      expiresAt,
      createdBy,
      updatedAt: new Date(),
    })
    .returning();
  await logEvent(row.id, "CREATED", null, null, { documentName: RENT_AGREEMENT_DOC_NAME, auto: createdBy == null });
  return row;
}

// Generate a Rent Agreement esign request — mounted as
// POST /residents/:id/agreement. The resident then signs via the existing
// public /sign/:token flow (no new signing UI). Returns the signerUrl.
esignRouter.post("/residents/:id/agreement", authenticate, authorize("RESIDENTS", "edit"), async (req, res) => {
  try {
    const residentId = req.params["id"] as string;
    const [resident] = await db.select().from(residentsTable).where(eq(residentsTable.id, residentId));
    if (!resident) {
      res.status(404).json({ success: false, error: "Resident not found" });
      return;
    }
    if (!resident.propertyId) {
      res.status(400).json({ success: false, error: "Resident has no property; cannot render agreement" });
      return;
    }
    const row = await createRentAgreementEsign(residentId, req.user?.id ?? null);
    if (!row) {
      res.status(400).json({ success: false, error: "Could not render agreement (missing property data)" });
      return;
    }
    const origin = req.headers["origin"] || `${req.protocol}://${req.headers["host"]}`;
    res.status(201).json({
      success: true,
      data: { ...row, documentBody: undefined, signerUrl: `${origin}/esign/sign/${row.signerToken}` },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

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
        // documentBody is encrypted at rest (WS5); decrypted on every read path.
        documentBody: encryptNullable(documentBody)!,
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
    // Strip the bearer capability secret (signerToken) and the full base64 PDF.
    // The token is only surfaced inside the intentional signerUrl; the signed
    // PDF is served by the dedicated /esign/:id/pdf stream.
    const { signerToken: _t, signedPdf: _pdf, ...safeRow } = row;
    res.json({
      success: true,
      data: {
        ...safeRow,
        // documentBody is encrypted at rest (WS5); decrypt so the admin detail
        // view sees plaintext exactly as before. Legacy rows pass through.
        documentBody: decrypt(safeRow.documentBody),
        signerUrl: `${origin}/esign/sign/${row.signerToken}`,
        events,
      },
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
    // Decrypt at rest (WS5); legacy plaintext data URLs pass through unchanged.
    const signedPdf = decrypt(row.signedPdf) ?? "";
    const m = signedPdf.match(/^data:application\/pdf;base64,(.+)$/);
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
          documentBody: decrypt(row.documentBody),
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
        documentBody: decrypt(row.documentBody),
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
        // documentBody is stored encrypted (WS5); decrypt before rendering the PDF.
        documentBody: decrypt(row.documentBody) ?? "",
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
        // Encrypt the signed PDF data URL at rest (WS5); decrypted on the stream path.
        signedPdf: encryptNullable(signedPdfDataUrl),
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

/**
 * O25: true iff the resident has a SIGNED esign request whose documentName is the
 * canonical 'Rent Agreement'. This is a stricter, agreement-specific gate than
 * residentMeetsActivationRequirements (which accepts any signed esign).
 */
export async function hasSignedRentAgreement(residentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: esignRequestsTable.id })
    .from(esignRequestsTable)
    .where(
      and(
        eq(esignRequestsTable.residentId, residentId),
        eq(esignRequestsTable.documentName, RENT_AGREEMENT_DOC_NAME),
        eq(esignRequestsTable.status, "SIGNED"),
      ),
    )
    .limit(1);
  return !!row;
}
