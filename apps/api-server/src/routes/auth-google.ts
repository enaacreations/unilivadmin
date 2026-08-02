/**
 * Google OAuth 2.0 sign-in — Authorization Code flow with PKCE.
 *
 * Sign-in is for EXISTING active users only, matched by their verified Google
 * email; there is NO auto-provisioning (accounts stay admin-created with their
 * assigned roles). On success we reuse `issueSession()` from auth.ts, so a
 * Google login behaves exactly like a password+OTP login: it rotates the
 * single-active-session id, sets the httpOnly refresh cookie, and revokes other
 * devices. Google is treated as the second factor, so the SMS OTP step is
 * skipped for this path.
 *
 * The whole feature activates only when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
 * and a redirect URI are configured; otherwise every route 404s and the login
 * page hides the button (via GET /auth/config).
 */
import { Router, type Response } from "express";
import crypto from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { issueSession } from "./auth.js";

const CLIENT_ID = process.env["GOOGLE_CLIENT_ID"] || "";
const CLIENT_SECRET = process.env["GOOGLE_CLIENT_SECRET"] || "";
const APP_BASE_URL = (process.env["APP_BASE_URL"] || "").replace(/\/+$/, "");
const REDIRECT_URI =
  process.env["GOOGLE_OAUTH_REDIRECT_URI"] ||
  (APP_BASE_URL ? `${APP_BASE_URL}/api/auth/google/callback` : "");
/** Optional: lock sign-in to one Google Workspace domain (e.g. "uniliv.com"). */
const ALLOWED_HD = (process.env["GOOGLE_ALLOWED_HD"] || "").trim().toLowerCase();
const IS_PROD = process.env["NODE_ENV"] === "production";

const STATE_COOKIE = "g_oauth";
const STATE_COOKIE_PATH = "/api/auth/google";
const STATE_TTL_MS = 10 * 60 * 1000;

export function googleEnabled(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

/** Browser-facing origin we send the user back to after the dance. */
function frontendBase(): string {
  if (APP_BASE_URL) return APP_BASE_URL;
  try {
    return new URL(REDIRECT_URI).origin;
  } catch {
    return "";
  }
}

/** Bounce back to the login screen with a status/error the page can explain. */
function backToLogin(res: Response, params: Record<string, string>): void {
  const qs = new URLSearchParams(params).toString();
  res.redirect(`${frontendBase()}/login${qs ? `?${qs}` : ""}`);
}

function newClient(): OAuth2Client {
  return new OAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
}

/** Constant-time string compare for the CSRF state token. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const router = Router();

/** Public: lets the login page decide whether to render the Google button. */
router.get("/config", (_req, res) => {
  res.json({ success: true, data: { google: googleEnabled() } });
});

/** Step 1 — start the flow: stash PKCE verifier + CSRF state in a short-lived
 *  httpOnly cookie, then redirect to Google's consent screen. */
router.get("/google", (req, res) => {
  if (!googleEnabled()) {
    res.status(404).json({ success: false, error: "Google sign-in is not configured" });
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const remember = req.query["remember"] === "0" ? "0" : "1";

  res.cookie(STATE_COOKIE, JSON.stringify({ state, codeVerifier, remember }), {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    maxAge: STATE_TTL_MS,
    path: STATE_COOKIE_PATH,
  });

  const url = newClient().generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
    prompt: "select_account",
    ...(ALLOWED_HD ? { hd: ALLOWED_HD } : {}),
  });
  res.redirect(url);
});

/** Step 2 — Google redirects back here. Verify state, exchange the code with
 *  PKCE, verify the ID token, match an existing active user by email, then mint
 *  our normal session and hand off to the login page (which silently refreshes). */
router.get("/google/callback", async (req, res) => {
  if (!googleEnabled()) {
    res.status(404).send("Google sign-in is not configured");
    return;
  }

  const raw = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: STATE_COOKIE_PATH });

  try {
    const code = typeof req.query["code"] === "string" ? req.query["code"] : "";
    const returnedState = typeof req.query["state"] === "string" ? req.query["state"] : "";
    if (req.query["error"]) return backToLogin(res, { error: "google_failed" });
    if (!raw || !code || !returnedState) return backToLogin(res, { error: "google_failed" });

    let saved: { state?: string; codeVerifier?: string; remember?: string };
    try {
      saved = JSON.parse(raw);
    } catch {
      return backToLogin(res, { error: "google_failed" });
    }
    if (!saved.state || !saved.codeVerifier || !safeEqual(saved.state, returnedState)) {
      return backToLogin(res, { error: "google_failed" });
    }

    const client = newClient();
    const { tokens } = await client.getToken({ code, codeVerifier: saved.codeVerifier });
    if (!tokens.id_token) return backToLogin(res, { error: "google_failed" });

    // verifyIdToken checks the signature (Google's JWKS), audience, issuer and expiry.
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();
    if (!payload || !email || payload.email_verified !== true) {
      return backToLogin(res, { error: "google_failed" });
    }
    // Workspace lock: require BOTH the signed hd claim and the email's own domain
    // to match (the hd claim alone can be present on a guest of a different domain).
    if (ALLOWED_HD && ((payload.hd || "").toLowerCase() !== ALLOWED_HD || email.split("@")[1] !== ALLOWED_HD)) {
      return backToLogin(res, { error: "google_domain" });
    }

    // Existing users only — match case-insensitively, but require a UNIQUE match.
    // Email has a case-sensitive unique constraint, so case-variant duplicates
    // ("a@x" vs "A@x") could coexist; picking an arbitrary row would be an
    // account-takeover vector, so an ambiguous match is denied. No auto-provisioning.
    const matches = await db.select().from(usersTable).where(sql`lower(${usersTable.email}) = ${email}`);
    if (matches.length > 1) req.log.error({ emailHash: email.length }, "google sign-in: ambiguous case-variant email — denied");
    const user = matches.length === 1 ? matches[0] : undefined;
    // One generic answer for "no account" and "inactive" — actionable for the user
    // without letting the login page enumerate which emails are active accounts.
    if (!user || !user.isActive) return backToLogin(res, { error: "google_denied" });

    await issueSession(res, user); // rotates single-session id + sets refresh cookie
    return backToLogin(res, { google: "ok", remember: saved.remember === "0" ? "0" : "1" });
  } catch (err) {
    req.log.error(err);
    return backToLogin(res, { error: "google_failed" });
  }
});

export default router;
