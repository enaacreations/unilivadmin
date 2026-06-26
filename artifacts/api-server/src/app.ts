import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors, { type CorsOptions } from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { CORS_ORIGINS, BODY_LIMIT, IS_DEVELOPMENT, IS_PRODUCTION } from "./config/env.js";
import { securityHeaders, globalRateLimiter } from "./middlewares/security.js";

const app: Express = express();

// Behind nginx (one hop): trust the proxy so req.ip / X-Forwarded-* are correct,
// which the rate limiter and cookie Secure handling rely on.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(securityHeaders);

// CORS: explicit allowlist (CORS_ORIGINS / APP_BASE_URL). Never reflect an
// arbitrary origin with credentials — that combination is a cross-site data-theft
// vector. Requests with no Origin header (same-origin, curl, server-to-server) are
// allowed. In development we reflect the origin for convenience only.
const corsOrigin: CorsOptions["origin"] = (origin, cb) => {
  if (!origin) return cb(null, true);
  const normalized = origin.replace(/\/+$/, "");
  if (CORS_ORIGINS.includes(normalized)) return cb(null, true);
  // Reflect an arbitrary origin ONLY in development AND only when no allowlist is
  // configured at all. With CORS_ORIGINS/APP_BASE_URL set, the allowlist is
  // enforced regardless of NODE_ENV (so a dev-mode HTTPS deploy is not wide open).
  if (IS_DEVELOPMENT && CORS_ORIGINS.length === 0) return cb(null, true);
  return cb(null, false);
};
app.use(cors({ origin: corsOrigin, credentials: true }));

app.use(cookieParser());
// Capture the raw request bytes (req.rawBody) during JSON parsing so webhook
// routes that need byte-exact HMAC verification (e.g. Razorpay) can recover the
// original payload even though the global parser consumes the stream.
const jsonParser = express.json({ limit: BODY_LIMIT, verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } });
// Property-photo uploads carry larger base64 image bodies and are parsed by a
// route-local 12 MB JSON parser (routes/properties.ts). Bypass the small global limit
// for that single route so the body isn't rejected with 413 before it reaches the
// handler; every other route keeps the conservative BODY_LIMIT.
const PHOTO_UPLOAD_RE = /^\/api\/properties\/[^/]+\/photos\/?$/;
app.use((req, res, next) => {
  if (req.method === "POST" && PHOTO_UPLOAD_RE.test(req.path)) return next();
  return jsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

app.use(globalRateLimiter);

app.use("/api", router);

// JSON 404 for anything that fell through the router.
app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// Centralised error handler. Honours the { statusCode, details } convention used
// by the service layer (e.g. wallet insufficient-balance → 422). Never leaks a
// stack trace or raw error message to clients in production.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const e = err as { statusCode?: number; status?: number; details?: unknown; message?: string };
  const status = e?.statusCode ?? e?.status ?? 500;
  if (status >= 500) req.log?.error({ err });
  else req.log?.warn({ err: e?.message });
  const body: Record<string, unknown> = {
    success: false,
    error: status >= 500 ? "Internal server error" : e?.message || "Request failed",
  };
  if (e?.details != null) body["details"] = e.details;
  if (!IS_PRODUCTION && status >= 500 && e?.message) body["debug"] = e.message;
  res.status(status).json(body);
});

export default app;
