import crypto from "node:crypto";
import type { Channel, OutboxRow } from "./types.js";

export interface RenderedMessage {
  subject: string | null;
  body: string | null;
}

/**
 * One way to send on one channel. Adding a vendor = a new adapter object; the
 * registry picks the first configured one per channel (priority order). With no
 * configured vendor the channel falls back to the "log" transport in development
 * and FAILS CLOSED everywhere else (see `selectProvider`).
 */
export interface ChannelProvider {
  channel: Channel;
  name: string;
  isConfigured(): boolean;
  /** Returns the provider message id (used to reconcile webhooks → outbox rows). */
  send(to: string, msg: RenderedMessage): Promise<string>;
}

const FROM = () => process.env["EMAIL_FROM"] || process.env["SMTP_FROM"] || "Uniliv <no-reply@uniliv.com>";

/**
 * Mirrors the fail-closed rule in apps/api-server/src/config/env.ts: ONLY a
 * literal NODE_ENV=development is development; unset/staging/anything else is
 * treated as hardened. Read per call so it can never be frozen at import time.
 */
const isDevelopment = () => process.env["NODE_ENV"] === "development";

/** Email via Amazon SES (SESv2). Selected when EMAIL_PROVIDER=ses + a region is set. */
const sesProvider: ChannelProvider = {
  channel: "EMAIL",
  name: "ses",
  isConfigured: () =>
    process.env["EMAIL_PROVIDER"] === "ses" && !!(process.env["AWS_SES_REGION"] || process.env["AWS_REGION"]),
  async send(to, msg) {
    const region = process.env["AWS_SES_REGION"] || process.env["AWS_REGION"];
    // Literal specifier on purpose (same reasoning as smtpProvider below): the api
    // runtime image is a single esbuild bundle with no node_modules, and esbuild
    // cannot follow a VARIABLE specifier — it leaves it as a runtime import, which
    // turned EMAIL_PROVIDER=ses into ERR_MODULE_NOT_FOUND on every send. Because
    // sesProvider is first in REGISTRY.EMAIL, that also shadowed a working SMTP
    // config. Deferred (not top-level) so the SDK is only instantiated when used.
    const { SESv2Client, SendEmailCommand } = (await import("@aws-sdk/client-sesv2")) as any;
    const client = new SESv2Client({ region });
    const out = await client.send(
      new SendEmailCommand({
        FromEmailAddress: FROM(),
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: msg.subject || "" }, Body: { Text: { Data: msg.body || "" } } } },
        // A configuration set routes bounce/complaint/delivery events to SNS.
        ...(process.env["AWS_SES_CONFIGURATION_SET"]
          ? { ConfigurationSetName: process.env["AWS_SES_CONFIGURATION_SET"] }
          : {}),
      }),
    );
    return (out.MessageId as string) || `ses-${crypto.randomUUID()}`;
  },
};

/** Email via SMTP (nodemailer) — dev/staging or a fallback for SES. */
const smtpProvider: ChannelProvider = {
  channel: "EMAIL",
  name: "smtp",
  isConfigured: () => !!process.env["SMTP_HOST"],
  async send(to, msg) {
    // Literal specifier on purpose: the api runtime image is a single esbuild
    // bundle with no node_modules, so a variable specifier (which esbuild leaves
    // as a runtime import) turned "set SMTP_HOST" into ERR_MODULE_NOT_FOUND on
    // every send. Same reasoning as the @aws-sdk note in api-server/build.mjs.
    const mod: any = await import("nodemailer");
    const nodemailer = mod.default ?? mod;
    const transport = nodemailer.createTransport({
      host: process.env["SMTP_HOST"],
      port: Number(process.env["SMTP_PORT"] || 587),
      secure: process.env["SMTP_SECURE"] === "true",
      auth: process.env["SMTP_USER"] ? { user: process.env["SMTP_USER"], pass: process.env["SMTP_PASS"] } : undefined,
    });
    const info = await transport.sendMail({ from: FROM(), to, subject: msg.subject || "", text: msg.body || "" });
    return info.messageId;
  },
};

/**
 * SMS via Twilio, over its REST API rather than the `twilio` SDK: the api runtime
 * image ships no node_modules, so an unbundled vendor SDK is a guaranteed
 * ERR_MODULE_NOT_FOUND at first send. One authenticated POST needs no SDK.
 * Configured = all three of SID/TOKEN/FROM, so a half-set config fails selection
 * (and therefore fails closed) instead of throwing on every send.
 */
const twilioProvider: ChannelProvider = {
  channel: "SMS",
  name: "twilio",
  isConfigured: () =>
    !!(process.env["TWILIO_AUTH_TOKEN"] && process.env["TWILIO_ACCOUNT_SID"] && process.env["TWILIO_FROM"]),
  async send(to, msg) {
    const sid = process.env["TWILIO_ACCOUNT_SID"]!;
    const auth = Buffer.from(`${sid}:${process.env["TWILIO_AUTH_TOKEN"]}`).toString("base64");
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: process.env["TWILIO_FROM"]!, To: to, Body: msg.body || "" }),
    });
    const out: any = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`twilio ${resp.status}: ${out?.message || resp.statusText}`);
    return (out.sid as string) || `twilio-${crypto.randomUUID()}`;
  },
};

/** Dev-only transport: records the rendered message, reports success. */
function logProvider(channel: Channel): ChannelProvider {
  return {
    channel,
    name: "log",
    isConfigured: () => true,
    async send(to, msg) {
      console.info(`[notify:${channel}] to=${to || "-"} :: ${(msg.body ?? "").slice(0, 600)}`);
      return `log-${crypto.randomUUID()}`;
    },
  };
}

/** What an operator has to set to turn a channel on — quoted in the failure. */
const CHANNEL_SETUP: Partial<Record<Channel, string>> = {
  EMAIL: "set EMAIL_PROVIDER=ses + AWS_SES_REGION, or SMTP_HOST",
  SMS: "set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM",
};

/**
 * Marks an error that retrying cannot fix. No amount of backoff makes an
 * unconfigured channel configured, and the inline path runs inside the caller's
 * request — so retrying one costs the user ~1.2s of blocking sleep and ~9 extra
 * queries per notification, for an outcome that is decided in advance.
 */
export const NON_RETRYABLE = Symbol.for("uniliv.notify.nonRetryable");

/** True when `err` is a failure no retry can resolve (see NON_RETRYABLE). */
export function isNonRetryable(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as unknown as Record<symbol, unknown>)[NON_RETRYABLE] === true;
}

/**
 * Fail-closed stand-in for a channel with no configured provider. It throws, so
 * processDelivery records the row PENDING with the reason in lastError — never
 * SENT (it becomes FAILED only once the shared MAX_DELIVERY_ATTEMPTS budget is
 * spent). Invariant: the outbox is an audit trail, so it must not claim a
 * delivery that only ever reached stdout (the log transport is a development
 * aid, not a transport).
 *
 * The throw is tagged NON_RETRYABLE: the row still lands PENDING and is still
 * picked up by the sweep (which is where it will succeed, once someone
 * configures a provider), but the request path stops sleeping between attempts
 * that cannot possibly differ.
 */
function unconfiguredProvider(channel: Channel): ChannelProvider {
  return {
    channel,
    name: "unconfigured",
    isConfigured: () => false,
    async send() {
      const err = new Error(
        `no ${channel} provider configured — ${CHANNEL_SETUP[channel] ?? "configure a provider"} ` +
          `(the log transport only runs when NODE_ENV=development)`,
      );
      (err as unknown as Record<symbol, unknown>)[NON_RETRYABLE] = true;
      throw err;
    },
  };
}

const REGISTRY: Partial<Record<Channel, ChannelProvider[]>> = {
  EMAIL: [sesProvider, smtpProvider],
  SMS: [twilioProvider],
};

/** The provider that will handle this channel given current config. */
export function selectProvider(channel: Channel): ChannelProvider {
  const candidates = REGISTRY[channel] ?? [];
  const configured = candidates.find((p) => p.isConfigured());
  if (configured) return configured;
  // Fail closed outside development (mirrors config/env.ts): an unconfigured
  // channel must be recorded FAILED with a reason, not SENT via console.info.
  return isDevelopment() ? logProvider(channel) : unconfiguredProvider(channel);
}

/** Deliver one outbox row through the selected provider; returns its message id. */
export async function deliver(row: OutboxRow): Promise<string> {
  const provider = selectProvider(row.channel);
  return provider.send(row.toAddress ?? "", { subject: row.subject, body: row.body });
}
