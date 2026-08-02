/**
 * Mobile OTP service — backs login 2FA and account recovery (Persona st.3–8).
 *
 * Codes are stored hashed; limits (resend ≥ 3, attempts ≥ 3, TTL, lockout) come
 * from `system_config` with safe fallbacks. In non-production the freshly
 * generated code is returned as `devOtp` so the flow can be exercised without a
 * live SMS provider; production never returns it.
 */
import { randomInt, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { otpChallengesTable, systemConfigTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { newId } from "./id.js";
import { notify } from "./notification-service.js";
import { ALLOW_DEV_OTP, IS_PRODUCTION } from "../config/env.js";

export type OtpPurpose =
  | "LOGIN"
  | "FORGOT_USERNAME"
  | "FORGOT_PASSWORD"
  | "MOBILE_VERIFY";

const DEFAULTS = {
  otpLength: 6,
  ttlMinutes: 10,
  maxAttempts: 3,
  maxResend: 3,
  lockoutMinutes: 15,
};

/** bcrypt work factor for OTP code hashes. */
const OTP_BCRYPT_COST = 10;
/** Minimum interval between OTP sends for a single challenge. */
const RESEND_COOLDOWN_MS = 30_000;
/** TTL for a verification token once a challenge is VERIFIED (independent of OTP TTL). */
const VERIFICATION_TOKEN_TTL_MS = 15 * 60_000;

/** Reads numeric config from system_config, tolerating plain or wrapped values. */
async function readConfig(): Promise<typeof DEFAULTS> {
  const keys = {
    otpLength: "OTP_LENGTH",
    ttlMinutes: "OTP_EXPIRY_MINUTES",
    maxAttempts: "OTP_MAX_ATTEMPTS",
    maxResend: "OTP_MAX_RESEND",
    lockoutMinutes: "LOGIN_LOCKOUT_MINUTES",
  } as const;
  const rows = await db.select().from(systemConfigTable);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const num = (raw: unknown, fallback: number): number => {
    if (raw == null) return fallback;
    if (typeof raw === "number") return raw;
    if (typeof raw === "object") {
      const v = Object.values(raw as Record<string, unknown>)[0];
      return typeof v === "number" ? v : fallback;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    otpLength: num(byKey.get(keys.otpLength), DEFAULTS.otpLength),
    ttlMinutes: num(byKey.get(keys.ttlMinutes), DEFAULTS.ttlMinutes),
    maxAttempts: num(byKey.get(keys.maxAttempts), DEFAULTS.maxAttempts),
    maxResend: num(byKey.get(keys.maxResend), DEFAULTS.maxResend),
    lockoutMinutes: num(byKey.get(keys.lockoutMinutes), DEFAULTS.lockoutMinutes),
  };
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "your registered mobile";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "•••• " + digits;
  return "•••••• " + digits.slice(-4);
}

function genCode(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String(randomInt(0, 10));
  return s;
}

export interface ChallengeResult {
  challengeId: string;
  maskedPhone: string;
  /** Only present in non-production, to drive the flow without live SMS. */
  devOtp?: string;
  expiresInSeconds: number;
}

async function sendOtpSms(userId: string | null, phone: string | null, code: string, purpose: OtpPurpose) {
  const action =
    purpose === "FORGOT_PASSWORD" ? "reset your password"
    : purpose === "FORGOT_USERNAME" ? "retrieve your username"
    : "sign in";
  const text = `Your Uniliv OTP to ${action} is ${code}. It expires shortly. Do not share it.`;
  if (userId) {
    // In-app skipped; SMS via the outbox (logs in dev).
    await notify({ userId, title: "OTP", type: "AUTH_OTP", sms: text, skipInApp: true });
  } else if (phone) {
    // No user yet (e.g. forgot-username path still resolves a user, so this is rare).
  }
}

/** Creates an OTP challenge and dispatches the code. */
export async function createChallenge(args: {
  userId: string | null;
  phone: string | null;
  purpose: OtpPurpose;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ChallengeResult> {
  const cfg = await readConfig();
  const code = genCode(cfg.otpLength);
  const codeHash = await bcrypt.hash(code, OTP_BCRYPT_COST);
  const expiresAt = new Date(Date.now() + cfg.ttlMinutes * 60_000);
  const id = newId();

  await db.insert(otpChallengesTable).values({
    id,
    userId: args.userId,
    phone: args.phone ?? "",
    purpose: args.purpose,
    codeHash,
    expiresAt,
    attemptCount: 0,
    resendCount: 0,
    maxAttempts: cfg.maxAttempts,
    maxResend: cfg.maxResend,
    lastSentAt: new Date(),
    status: "PENDING",
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
  });

  await sendOtpSms(args.userId, args.phone, code, args.purpose);

  return {
    challengeId: id,
    maskedPhone: maskPhone(args.phone),
    ...(ALLOW_DEV_OTP ? { devOtp: code } : {}),
    expiresInSeconds: cfg.ttlMinutes * 60,
  };
}

export interface ResendResult extends ChallengeResult {
  resendsLeft: number;
}

/** Regenerates the code for an existing challenge (bounded by maxResend). */
export async function resendChallenge(challengeId: string): Promise<
  { ok: true } & ResendResult | { ok: false; error: string }
> {
  const [ch] = await db.select().from(otpChallengesTable).where(eq(otpChallengesTable.id, challengeId));
  if (!ch) return { ok: false, error: "Challenge not found" };
  if (ch.status !== "PENDING") return { ok: false, error: "This code can no longer be resent" };
  if (ch.resendCount >= ch.maxResend) {
    return { ok: false, error: `Maximum ${ch.maxResend} resends reached. Please start again.` };
  }
  if (ch.lastSentAt) {
    const sinceLast = Date.now() - new Date(ch.lastSentAt).getTime();
    if (sinceLast < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000);
      return { ok: false, error: `Please wait ${wait}s before requesting another code.` };
    }
  }
  const cfg = await readConfig();
  const code = genCode(cfg.otpLength);
  const codeHash = await bcrypt.hash(code, OTP_BCRYPT_COST);
  const expiresAt = new Date(Date.now() + cfg.ttlMinutes * 60_000);
  await db
    .update(otpChallengesTable)
    .set({
      codeHash,
      expiresAt,
      resendCount: ch.resendCount + 1,
      // Attempt budget is cumulative across the whole challenge lifecycle: a
      // resend issues a new code but does NOT reset attemptCount, so an attacker
      // cannot reset their guess budget to 0 by repeatedly resending.
      lastSentAt: new Date(),
      status: "PENDING",
    })
    .where(eq(otpChallengesTable.id, challengeId));

  await sendOtpSms(ch.userId, ch.phone, code, ch.purpose as OtpPurpose);

  return {
    ok: true,
    challengeId,
    maskedPhone: maskPhone(ch.phone),
    ...(ALLOW_DEV_OTP ? { devOtp: code } : {}),
    expiresInSeconds: cfg.ttlMinutes * 60,
    resendsLeft: ch.maxResend - (ch.resendCount + 1),
  };
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  attemptsLeft?: number;
  userId?: string | null;
  /** One-time token authorising a follow-up reset (FORGOT_PASSWORD). */
  verificationToken?: string;
}

/** Verifies a code; on success marks the challenge VERIFIED and returns a token. */
export async function verifyChallenge(
  challengeId: string,
  code: string,
  purpose: OtpPurpose,
): Promise<VerifyResult> {
  const [ch] = await db.select().from(otpChallengesTable).where(eq(otpChallengesTable.id, challengeId));
  if (!ch || ch.purpose !== purpose) return { ok: false, error: "Invalid request" };
  if (ch.status === "VERIFIED" || ch.status === "CONSUMED") return { ok: false, error: "This code was already used" };
  if (ch.status === "LOCKED") return { ok: false, error: "Too many attempts. Please request a new code." };
  if (new Date() > ch.expiresAt) {
    await db.update(otpChallengesTable).set({ status: "EXPIRED" }).where(eq(otpChallengesTable.id, challengeId));
    return { ok: false, error: "This code has expired. Please request a new one." };
  }

  // Opt-in development master OTP: when DEV_OTP is set, that fixed code always
  // verifies (in addition to the real one). Gated on ALLOW_DEV_OTP, which is only
  // ever true in real development (NODE_ENV=development) with an explicit opt-in,
  // and is forced false in any hardened (non-development) environment.
  const masterOtp = process.env["DEV_OTP"];
  const valid =
    (ALLOW_DEV_OTP && !IS_PRODUCTION && !!masterOtp && String(code) === masterOtp) ||
    (await bcrypt.compare(String(code), ch.codeHash));
  if (!valid) {
    const attempts = ch.attemptCount + 1;
    const locked = attempts >= ch.maxAttempts;
    await db
      .update(otpChallengesTable)
      .set({ attemptCount: attempts, status: locked ? "LOCKED" : "PENDING" })
      .where(eq(otpChallengesTable.id, challengeId));
    return {
      ok: false,
      error: locked ? "Too many incorrect attempts. Please request a new code." : "Incorrect code",
      attemptsLeft: Math.max(0, ch.maxAttempts - attempts),
    };
  }

  const verificationToken = randomUUID();
  await db
    .update(otpChallengesTable)
    .set({ status: "VERIFIED", consumedAt: new Date(), verificationToken })
    .where(eq(otpChallengesTable.id, challengeId));

  return { ok: true, userId: ch.userId, verificationToken };
}

/** Consumes a previously-issued verification token (one-time, for reset). */
export async function consumeVerificationToken(
  token: string,
  purpose: OtpPurpose,
): Promise<{ ok: boolean; userId?: string | null; error?: string }> {
  const [ch] = await db
    .select()
    .from(otpChallengesTable)
    .where(eq(otpChallengesTable.verificationToken, token));
  if (!ch || ch.purpose !== purpose || ch.status !== "VERIFIED") {
    return { ok: false, error: "Invalid or expired verification" };
  }
  // The token must not be redeemable forever: enforce a short TTL from the
  // moment the challenge was verified (consumedAt), independent of the OTP TTL.
  const verifiedAt = ch.consumedAt ? new Date(ch.consumedAt).getTime() : null;
  if (verifiedAt == null || Date.now() - verifiedAt > VERIFICATION_TOKEN_TTL_MS) {
    await db
      .update(otpChallengesTable)
      .set({ status: "EXPIRED", verificationToken: null })
      .where(eq(otpChallengesTable.id, ch.id));
    return { ok: false, error: "expired" };
  }
  await db
    .update(otpChallengesTable)
    .set({ status: "CONSUMED", verificationToken: null })
    .where(eq(otpChallengesTable.id, ch.id));
  return { ok: true, userId: ch.userId };
}

/** Resolves a user's phone for OTP dispatch. */
export async function getUserPhone(userId: string): Promise<string | null> {
  const [u] = await db.select({ phone: usersTable.phone }).from(usersTable).where(eq(usersTable.id, userId));
  return u?.phone ?? null;
}

export async function lockoutConfig() {
  const cfg = await readConfig();
  return { maxAttempts: cfg.maxAttempts, lockoutMinutes: cfg.lockoutMinutes };
}
