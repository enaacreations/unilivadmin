import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { SESSION_SECRET, JWT_ISSUER, JWT_AUDIENCE, DISABLE_SINGLE_SESSION } from "../config/env.js";

// Single source of truth for the signing secret. Validated/fail-closed in
// config/env.ts — there is intentionally no insecure inline fallback here.
const JWT_SECRET = SESSION_SECRET;

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  propertyId?: string | null;
  /** Single-active-session id; must equal users.currentSessionId. */
  sid?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ success: false, error: "Authentication required" });
    return;
  }

  let payload: AuthUser & { typ?: string };
  try {
    payload = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as AuthUser & { typ?: string };
  } catch {
    res.status(401).json({ success: false, error: "Invalid or expired token" });
    return;
  }
  // A refresh token (typ:"refresh") must never be accepted as an access token.
  if (payload.typ && payload.typ !== "access") {
    res.status(401).json({ success: false, error: "Invalid or expired token" });
    return;
  }

  // Single active session + account-active check. The token's session id must
  // still match the user's current one; a newer login elsewhere rotates it and
  // invalidates this token immediately. (A null currentSessionId means the user
  // hasn't logged in since the feature shipped — grace, no enforcement yet.)
  try {
    const [u] = await db
      .select({ sid: usersTable.currentSessionId, isActive: usersTable.isActive })
      .from(usersTable)
      .where(eq(usersTable.id, payload.id));
    if (!u) {
      res.status(401).json({ success: false, error: "Invalid or expired token" });
      return;
    }
    if (!u.isActive) {
      res.status(401).json({ success: false, error: "Account is inactive" });
      return;
    }
    // DISABLE_SINGLE_SESSION (testing aid) skips the session-id match entirely,
    // so tokens from several concurrent logins of the same account all stay
    // valid. The account-active check above still applies.
    if (!DISABLE_SINGLE_SESSION) {
      if (u.sid) {
        if (payload.sid !== u.sid) {
          res.status(401).json({ success: false, error: "Signed in on another device", code: "SESSION_REPLACED" });
          return;
        }
      } else if (payload.sid) {
        // User has no active session but the token claims one → logged out / reset /
        // replaced. Reject. (Only genuinely pre-feature, sid-less tokens get grace.)
        res.status(401).json({ success: false, error: "Session ended. Please sign in again.", code: "SESSION_REPLACED" });
        return;
      }
    }
  } catch {
    res.status(500).json({ success: false, error: "Internal server error" });
    return;
  }

  req.user = payload;
  next();
}

export function authorize(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ success: false, error: "Authentication required" });
      return;
    }
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      res.status(403).json({ success: false, error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ ...user, typ: "access" }, JWT_SECRET, {
    expiresIn: "15m",
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ userId, typ: "refresh" }, JWT_SECRET, {
    expiresIn: "7d",
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}
