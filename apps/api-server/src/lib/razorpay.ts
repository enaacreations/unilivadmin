// ─────────────────────────────────────────────────────────────────────────────
// Razorpay payment-link service — GRACEFUL DEGRADE
//
// Reads its configuration from the environment. None of these are required for
// the app to boot; when they are absent the service refuses to act (throws a
// typed RazorpayNotConfiguredError) so callers can return 503 instead of
// crashing. Set all three to enable live payment links + webhook verification:
//
//   RAZORPAY_KEY_ID         — public key id (HTTP Basic username)
//   RAZORPAY_KEY_SECRET     — secret key   (HTTP Basic password)
//   RAZORPAY_WEBHOOK_SECRET — secret used to HMAC-verify inbound webhooks
//
// Uses the Node global `fetch` (Node 18+); no SDK dependency.
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac, timingSafeEqual } from "crypto";

const RAZORPAY_KEY_ID = process.env["RAZORPAY_KEY_ID"];
const RAZORPAY_KEY_SECRET = process.env["RAZORPAY_KEY_SECRET"];
const RAZORPAY_WEBHOOK_SECRET = process.env["RAZORPAY_WEBHOOK_SECRET"];

const API_BASE = "https://api.razorpay.com/v1";

/**
 * Thrown when a Razorpay operation is attempted without credentials. Routes
 * catch this and respond 503 "Payments not configured" rather than 500.
 */
export class RazorpayNotConfiguredError extends Error {
  statusCode = 503 as const;
  constructor(message = "Payments not configured") {
    super(message);
    this.name = "RazorpayNotConfiguredError";
  }
}

/** True only when key id + secret are both present (link creation possible). */
export function isRazorpayConfigured(): boolean {
  return !!RAZORPAY_KEY_ID && !!RAZORPAY_KEY_SECRET;
}

/** True when the webhook secret is present (signature verification possible). */
export function isRazorpayWebhookConfigured(): boolean {
  return !!RAZORPAY_WEBHOOK_SECRET;
}

function basicAuthHeader(): string {
  const token = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
  return `Basic ${token}`;
}

export interface CreatePaymentLinkInput {
  /** Amount in paise (integer). e.g. ₹500 -> 50000. */
  amountPaise: number;
  description: string;
  customer: { name?: string; contact?: string; email?: string };
  /** Channels Razorpay should auto-notify on. Defaults to none (we notify). */
  notify?: { sms?: boolean; email?: boolean };
  /** Link expiry as seconds-from-now. Razorpay needs an absolute epoch. */
  expireBySeconds?: number;
  /** Allow partial payments on the link (used by wallet top-ups). */
  acceptPartial?: boolean;
  /** Free-form key/value notes for later webhook correlation. */
  notes?: Record<string, string>;
}

export interface PaymentLink {
  id: string;
  shortUrl: string;
  status: string;
}

/**
 * Creates a Razorpay payment link. Throws RazorpayNotConfiguredError when keys
 * are missing; throws a plain Error (with the provider message) on API failure.
 */
export async function createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink> {
  if (!isRazorpayConfigured()) throw new RazorpayNotConfiguredError();

  const body: Record<string, unknown> = {
    amount: Math.round(input.amountPaise),
    currency: "INR",
    description: input.description,
    customer: {
      ...(input.customer.name ? { name: input.customer.name } : {}),
      ...(input.customer.contact ? { contact: input.customer.contact } : {}),
      ...(input.customer.email ? { email: input.customer.email } : {}),
    },
    notify: {
      sms: input.notify?.sms ?? false,
      email: input.notify?.email ?? false,
    },
    reminder_enable: true,
  };
  if (input.acceptPartial) body["accept_partial"] = true;
  if (input.expireBySeconds && input.expireBySeconds > 0) {
    // Razorpay expects an absolute UNIX timestamp (seconds).
    body["expire_by"] = Math.floor(Date.now() / 1000) + Math.floor(input.expireBySeconds);
  }
  if (input.notes && Object.keys(input.notes).length > 0) body["notes"] = input.notes;

  const res = await fetch(`${API_BASE}/payment_links`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const msg = json?.error?.description || `Razorpay error (HTTP ${res.status})`;
    throw new Error(msg);
  }

  return {
    id: json.id,
    shortUrl: json.short_url,
    status: json.status,
  };
}

/**
 * Verifies an inbound webhook's `X-Razorpay-Signature` against the raw request
 * body using HMAC-SHA256 with the configured webhook secret. Returns false when
 * the secret is unset (caller should treat as unconfigured / no-op) or on any
 * mismatch. Constant-time comparison.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
  if (!RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const expected = createHmac("sha256", RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Convert rupees (number/string) to integer paise for the Razorpay API. */
export function toPaise(rupees: number | string): number {
  return Math.round(Number(rupees) * 100);
}
