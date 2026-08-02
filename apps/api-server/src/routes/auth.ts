/**
 * Authentication routes — username/email + password, then mobile OTP 2FA, plus
 * forgot-username / forgot-password recovery (Persona st.1–9). Lockout after
 * repeated bad passwords; OTP limits configured in system_config.
 */
import { Router, type Response } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable, refreshTokensTable } from "@workspace/db";
import { eq, or } from "drizzle-orm";
import { authenticate, signAccessToken, signRefreshToken } from "../middlewares/auth.js";
import { authRateLimiter } from "../middlewares/security.js";
import { COOKIE_SECURE, DISABLE_SINGLE_SESSION } from "../config/env.js";
import { newId } from "../lib/id.js";
import {
  createChallenge,
  resendChallenge,
  verifyChallenge,
  consumeVerificationToken,
  getUserPhone,
  lockoutConfig,
} from "../lib/otp-service.js";
import { notify } from "../lib/notification-service.js";

const router = Router();

type DbUser = typeof usersTable.$inferSelect;

/** Browser-facing origin used to build the emailed recovery links. */
const APP_BASE_URL = (process.env["APP_BASE_URL"] || "").replace(/\/+$/, "");

/** a••••@example.com — never echo a full address back to an unauthenticated caller. */
function maskEmail(email: string): string {
  const [u, d] = email.split("@");
  if (!d || !u) return "your email";
  const head = u.length <= 2 ? u.slice(0, 1) : u.slice(0, 2);
  return `${head}${"•".repeat(Math.max(2, u.length - head.length))}@${d}`;
}

function publicUser(user: DbUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    designation: user.designation,
    phone: user.phone,
    role: user.role,
    propertyId: user.propertyId,
    isActive: user.isActive,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
  };
}

export async function issueSession(res: Response, user: DbUser) {
  // Single active session: a new login rotates the session id and revokes every
  // other refresh token, so any other device's access/refresh tokens stop working.
  const sessionId = newId();
  const authUser = { id: user.id, email: user.email, role: user.role, propertyId: user.propertyId, sid: sessionId };
  const accessToken = signAccessToken(authUser);
  const refreshToken = signRefreshToken(user.id);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  // Atomic, serialized per user: lock the user row first so two near-simultaneous
  // logins can't interleave into an orphaned refresh token / sid mismatch (lockout).
  await db.transaction(async (tx) => {
    await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, user.id)).for("update");
    // Single-session: revoke every other device's refresh token on login. The
    // testing flag keeps them so several concurrent logins can coexist.
    if (!DISABLE_SINGLE_SESSION) {
      await tx.delete(refreshTokensTable).where(eq(refreshTokensTable.userId, user.id));
    }
    await tx.insert(refreshTokensTable).values({ id: newId(), userId: user.id, token: refreshToken, expiresAt });
    await tx.update(usersTable)
      .set({ currentSessionId: sessionId, lastLogin: new Date(), failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));
  });
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/", // explicit: sent to /api/auth/refresh regardless of which route set it
  });
  return accessToken;
}

async function findByIdentifier(identifier: string): Promise<DbUser | undefined> {
  const value = identifier.trim();
  const [user] = await db
    .select()
    .from(usersTable)
    .where(or(eq(usersTable.email, value), eq(usersTable.username, value)));
  return user;
}

/* ── Step 1: validate credentials → issue OTP challenge ─────────────────── */
router.post("/login", authRateLimiter, async (req, res) => {
  try {
    const { identifier, email, password } = req.body || {};
    const id = identifier || email; // accept legacy {email}
    if (!id || !password) {
      res.status(400).json({ success: false, error: "Username/email and password are required" });
      return;
    }

    const user = await findByIdentifier(id);
    // Generic message to avoid user enumeration.
    if (!user) {
      res.status(401).json({ success: false, error: "Invalid credentials" });
      return;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      res.status(423).json({ success: false, error: `Account locked. Try again in ${mins} minute(s).` });
      return;
    }
    if (!user.isActive) {
      res.status(401).json({ success: false, error: "Account is inactive" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      const { maxAttempts, lockoutMinutes } = await lockoutConfig();
      const attempts = (user.failedLoginAttempts ?? 0) + 1;
      const lock = attempts >= maxAttempts;
      await db.update(usersTable).set({
        failedLoginAttempts: lock ? 0 : attempts,
        lockedUntil: lock ? new Date(Date.now() + lockoutMinutes * 60000) : null,
        updatedAt: new Date(),
      }).where(eq(usersTable.id, user.id));
      res.status(401).json({
        success: false,
        error: lock
          ? `Too many failed attempts. Account locked for ${lockoutMinutes} minutes.`
          : "Invalid credentials",
      });
      return;
    }

    const challenge = await createChallenge({
      userId: user.id,
      phone: user.phone,
      purpose: "LOGIN",
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });

    res.json({
      success: true,
      data: {
        otpRequired: true,
        ...challenge,
        name: user.name,
      },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ── Step 2: verify OTP → issue tokens ──────────────────────────────────── */
router.post("/verify-otp", authRateLimiter, async (req, res) => {
  try {
    const { challengeId, code } = req.body || {};
    if (!challengeId || !code) {
      res.status(400).json({ success: false, error: "challengeId and code required" });
      return;
    }
    const result = await verifyChallenge(challengeId, String(code), "LOGIN");
    if (!result.ok) {
      res.status(401).json({ success: false, error: result.error, attemptsLeft: result.attemptsLeft });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, result.userId!));
    if (!user) {
      res.status(404).json({ success: false, error: "User not found" });
      return;
    }
    const accessToken = await issueSession(res, user);
    res.json({ success: true, accessToken, user: publicUser(user) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/resend-otp", authRateLimiter, async (req, res) => {
  try {
    const { challengeId } = req.body || {};
    if (!challengeId) {
      res.status(400).json({ success: false, error: "challengeId required" });
      return;
    }
    const result = await resendChallenge(challengeId);
    if (!result.ok) {
      res.status(429).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, data: result });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ── Forgot username ────────────────────────────────────────────────────── */
router.post("/forgot-username", authRateLimiter, async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) {
      res.status(400).json({ success: false, error: "Registered mobile number required" });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, String(phone).trim()));
    if (!user) {
      res.status(404).json({ success: false, error: "No account found for this mobile number" });
      return;
    }
    const challenge = await createChallenge({
      userId: user.id,
      phone: user.phone,
      purpose: "FORGOT_USERNAME",
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });
    res.json({ success: true, data: { ...challenge } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/forgot-username/verify", authRateLimiter, async (req, res) => {
  try {
    const { challengeId, code } = req.body || {};
    const result = await verifyChallenge(challengeId, String(code), "FORGOT_USERNAME");
    if (!result.ok) {
      res.status(401).json({ success: false, error: result.error, attemptsLeft: result.attemptsLeft });
      return;
    }
    // OTP confirms the phone; we then email a single-use link to a dedicated page
    // that reveals the username — the reveal never happens inline in the login UI.
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, result.userId!));
    if (user?.email && result.verificationToken) {
      const link = `${APP_BASE_URL}/recover-username/${result.verificationToken}`;
      await notify({
        userId: user.id,
        title: "Recover your username",
        type: "AUTH_USERNAME_RECOVERY",
        skipInApp: true,
        email: {
          subject: "Recover your UNILIV username",
          text: `We received a request to recover your UNILIV username.\n\nOpen this secure link to view it:\n${link}\n\nThe link works once and expires shortly. If you didn't request this, you can ignore this email.`,
        },
      });
    }
    res.json({ success: true, data: { emailSent: true, maskedEmail: user?.email ? maskEmail(user.email) : null } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/** Redeems the emailed single-use link and returns the username (dedicated page). */
router.post("/recover-username", authRateLimiter, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) { res.status(400).json({ success: false, error: "token required" }); return; }
    const result = await consumeVerificationToken(String(token), "FORGOT_USERNAME");
    if (!result.ok || !result.userId) {
      res.status(401).json({ success: false, error: result.error || "This link is invalid or has expired." });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, result.userId));
    res.json({ success: true, data: { username: user?.username ?? user?.email ?? null } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ── Forgot password ────────────────────────────────────────────────────── */
router.post("/forgot-password", authRateLimiter, async (req, res) => {
  try {
    const { identifier, email } = req.body || {};
    const idv = identifier || email;
    if (!idv) {
      res.status(400).json({ success: false, error: "Username or email required" });
      return;
    }
    const user = await findByIdentifier(idv);
    if (!user) {
      res.status(404).json({ success: false, error: "No account found" });
      return;
    }
    const phone = await getUserPhone(user.id);
    const challenge = await createChallenge({
      userId: user.id,
      phone,
      purpose: "FORGOT_PASSWORD",
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });
    res.json({ success: true, data: { ...challenge } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/forgot-password/verify", authRateLimiter, async (req, res) => {
  try {
    const { challengeId, code } = req.body || {};
    const result = await verifyChallenge(challengeId, String(code), "FORGOT_PASSWORD");
    if (!result.ok) {
      res.status(401).json({ success: false, error: result.error, attemptsLeft: result.attemptsLeft });
      return;
    }
    // OTP confirms the phone; we then email a single-use link to a dedicated
    // reset page. The new-password form never appears inline in the login UI.
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, result.userId!));
    if (user?.email && result.verificationToken) {
      const link = `${APP_BASE_URL}/reset-password/${result.verificationToken}`;
      await notify({
        userId: user.id,
        title: "Reset your password",
        type: "AUTH_PASSWORD_RESET",
        skipInApp: true,
        email: {
          subject: "Reset your UNILIV password",
          text: `We received a request to reset your UNILIV password.\n\nOpen this secure link to choose a new password:\n${link}\n\nThe link works once and expires shortly. If you didn't request this, you can safely ignore this email — your password won't change.`,
        },
      });
    }
    res.json({ success: true, data: { emailSent: true, maskedEmail: user?.email ? maskEmail(user.email) : null } });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/reset-password", authRateLimiter, async (req, res) => {
  try {
    const { verificationToken, newPassword } = req.body || {};
    if (!verificationToken || !newPassword) {
      res.status(400).json({ success: false, error: "verificationToken and newPassword required" });
      return;
    }
    if (String(newPassword).length < 8) {
      res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
      return;
    }
    const result = await consumeVerificationToken(verificationToken, "FORGOT_PASSWORD");
    if (!result.ok || !result.userId) {
      res.status(401).json({ success: false, error: result.error || "Invalid verification" });
      return;
    }
    const passwordHash = await bcrypt.hash(String(newPassword), 12);
    // A password reset logs out every device: clear the session and drop all refresh tokens.
    await db.transaction(async (tx) => {
      await tx.update(usersTable)
        .set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null, currentSessionId: null, updatedAt: new Date() })
        .where(eq(usersTable.id, result.userId!));
      await tx.delete(refreshTokensTable).where(eq(refreshTokensTable.userId, result.userId!));
    });
    res.json({ success: true, message: "Password updated. Please sign in." });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/* ── Session ────────────────────────────────────────────────────────────── */
// NOTE: deliberately NOT behind authRateLimiter. A reload now always hits
// /refresh (the access token is in-memory), so many legitimate sessions behind
// one NAT/egress IP would otherwise share the strict 50/15min credential bucket
// and get 429-logged-out. The app-wide globalRateLimiter (600/min) still applies.
router.post("/refresh", async (req, res) => {
  try {
    const token = req.cookies?.["refreshToken"];
    if (!token) { res.status(401).json({ success: false, error: "No refresh token" }); return; }
    const [rt] = await db.select().from(refreshTokensTable).where(eq(refreshTokensTable.token, token));
    if (!rt || rt.expiresAt < new Date()) {
      res.status(401).json({ success: false, error: "Invalid or expired refresh token" });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, rt.userId));
    if (!user) { res.status(401).json({ success: false, error: "User not found" }); return; }
    if (!user.isActive) { res.status(401).json({ success: false, error: "Account is inactive" }); return; }
    // No active session (logged out / reset / replaced) → don't mint a token.
    if (!user.currentSessionId) { res.status(401).json({ success: false, error: "Session ended. Please sign in again." }); return; }
    // Reuse the user's current session id (only login rotates it) so the renewed
    // access token still matches the single active session.
    const authUser = { id: user.id, email: user.email, role: user.role, propertyId: user.propertyId, sid: user.currentSessionId };
    const accessToken = signAccessToken(authUser);

    // Rotate the refresh token: mint a fresh value and atomically replace the old
    // DB row. A leaked/stolen refresh token is then single-use — once the legit
    // client refreshes, the old token no longer matches any row. The conditional
    // delete (by the presented token) preserves the single-active-session model:
    // if a concurrent login already replaced this row, no new row is inserted.
    const newRefreshToken = signRefreshToken(user.id);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    // Atomic single-use rotation. Only the request whose DELETE actually matched
    // the presented token performs the INSERT and writes the new cookie. A
    // concurrent refresh of the SAME token (e.g. two tabs restoring on boot share
    // one httpOnly cookie) finds nothing to delete and is served a fresh access
    // token WITHOUT clobbering the cookie — the browser keeps the rotated value
    // the winning request committed to the DB instead of an orphaned one. (A
    // truly stale/stolen token is already rejected by the lookup above, since its
    // row no longer exists.)
    let rotated = false;
    await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(refreshTokensTable)
        .where(eq(refreshTokensTable.token, token))
        .returning({ id: refreshTokensTable.id });
      if (deleted.length) {
        await tx.insert(refreshTokensTable).values({ id: newId(), userId: user.id, token: newRefreshToken, expiresAt });
        rotated = true;
      }
    });
    if (rotated) {
      res.cookie("refreshToken", newRefreshToken, {
        httpOnly: true,
        secure: COOKIE_SECURE,
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/",
      });
    }

    res.json({ success: true, accessToken, user: publicUser(user) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/logout", authenticate, async (req, res) => {
  try {
    const token = req.cookies?.["refreshToken"];
    if (token) await db.delete(refreshTokensTable).where(eq(refreshTokensTable.token, token));
    res.clearCookie("refreshToken");
    res.json({ success: true, message: "Logged out" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/me", authenticate, async (req, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id));
    if (!user) { res.status(404).json({ success: false, error: "User not found" }); return; }
    res.json({ success: true, data: publicUser(user) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
