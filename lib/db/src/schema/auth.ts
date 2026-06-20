/**
 * Authentication — mobile OTP & recovery
 * --------------------------------------
 * Backs the Unit-Lead login 2FA and account-recovery flows (Persona st.3–8):
 * password validation → OTP to registered mobile → validate → land on
 * dashboard, plus forgot-username / forgot-password by mobile + OTP.
 *
 * Configurable limits (resend ≥ 3, attempts ≥ 3) live in system_config; each
 * challenge snapshots the limits in force when it was created.
 */
import { pgTable, text, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { usersTable } from "./core";

export const otpPurposeEnum = pgEnum("otp_purpose", [
  "LOGIN",
  "FORGOT_USERNAME",
  "FORGOT_PASSWORD",
  "MOBILE_VERIFY",
]);

export const otpStatusEnum = pgEnum("otp_status", [
  "PENDING",
  "VERIFIED",
  "CONSUMED",
  "EXPIRED",
  "LOCKED",
]);

/**
 * One OTP challenge. The code is stored hashed (never plaintext). Lockout is
 * reached when attemptCount ≥ maxAttempts; regeneration is bounded by
 * resendCount ≤ maxResend. For FORGOT_PASSWORD, a successful verify issues a
 * one-time verificationToken that authorises the subsequent password reset.
 * userId is null for FORGOT_USERNAME (we resolve the user by phone).
 */
export const otpChallengesTable = pgTable("otp_challenges", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => usersTable.id),
  phone: text("phone").notNull(),
  purpose: otpPurposeEnum("purpose").notNull(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  resendCount: integer("resend_count").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  maxResend: integer("max_resend").default(3).notNull(),
  lastSentAt: timestamp("last_sent_at"),
  consumedAt: timestamp("consumed_at"),
  verificationToken: text("verification_token").unique(),
  status: otpStatusEnum("status").default("PENDING").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type OtpChallenge = typeof otpChallengesTable.$inferSelect;
export type NewOtpChallenge = typeof otpChallengesTable.$inferInsert;
