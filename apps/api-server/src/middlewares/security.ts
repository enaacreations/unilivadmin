/**
 * Zero-dependency security middleware: hardening headers + an in-memory rate
 * limiter. Kept dependency-free on purpose — the production API ships as a single
 * esbuild bundle with no node_modules, so we avoid pulling helmet/express-rate-limit
 * and instead implement the small slice we need.
 */
import type { Request, Response, NextFunction } from "express";
import { IS_PRODUCTION, COOKIE_SECURE } from "../config/env.js";

/**
 * Conservative security headers (a helmet-equivalent subset). Applied globally.
 * No Content-Security-Policy here — the SPA is served by nginx, which owns CSP;
 * this API serves JSON only.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  // API responses are never a document; forbid caching of potentially sensitive JSON.
  res.setHeader("Cache-Control", "no-store");
  // Emit HSTS on any HTTPS deployment (production OR an HTTPS dev-mode box where
  // COOKIE_SECURE is set), not just NODE_ENV=production.
  if (IS_PRODUCTION || COOKIE_SECURE) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per key per window. */
  max: number;
  /** Optional message returned on limit. */
  message?: string;
  /** Derive the throttling key; defaults to client IP. */
  keyGenerator?: (req: Request) => string;
}

/**
 * Fixed-window in-memory rate limiter. Single-process only (good enough for the
 * current single-instance deployment); swap for a Redis store when scaling out.
 * A background sweep evicts stale buckets so memory stays bounded.
 */
export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, message = "Too many requests. Please slow down and try again later." } = opts;
  const keyOf = opts.keyGenerator ?? ((req: Request) => clientIp(req));
  const buckets = new Map<string, Bucket>();

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, windowMs).unref();
  // unref so the timer never keeps the process alive on shutdown.
  void sweeper;

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const key = keyOf(req);
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    const remaining = Math.max(0, max - b.count);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil((b.resetAt - now) / 1000)));
    if (b.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      res.status(429).json({ success: false, error: message });
      return;
    }
    next();
  };
}

/**
 * Best-effort client IP. Relies on Express's `req.ip`, which (with
 * `app.set('trust proxy', 1)`) resolves the correct rightmost-untrusted hop
 * behind the single nginx proxy. We deliberately do NOT parse `X-Forwarded-For`
 * ourselves: taking the leftmost value let an attacker rotate the header to dodge
 * the rate-limit buckets keyed off this value.
 */
export function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Strict limiter for credential/OTP endpoints (brute-force defence). Keyed by IP.
 * Backs the per-account DB lockout already in place with an IP-level cap so an
 * attacker can't spread attempts across many accounts from one host.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: "Too many authentication attempts. Please wait a few minutes and try again.",
});

/** Generous global limiter — a backstop against runaway clients / scraping. */
export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
});
