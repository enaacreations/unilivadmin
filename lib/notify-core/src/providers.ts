import crypto from "node:crypto";
import type { Channel, OutboxRow } from "./types.js";

export interface RenderedMessage {
  subject: string | null;
  body: string | null;
}

/**
 * One way to send on one channel. Adding a vendor = a new adapter object; the
 * registry picks the first configured one per channel (priority order), falling
 * back to a dev "log" transport so the pipeline always completes.
 */
export interface ChannelProvider {
  channel: Channel;
  name: string;
  isConfigured(): boolean;
  /** Returns the provider message id (used to reconcile webhooks → outbox rows). */
  send(to: string, msg: RenderedMessage): Promise<string>;
}

const FROM = () => process.env["EMAIL_FROM"] || process.env["SMTP_FROM"] || "Uniliv <no-reply@uniliv.com>";

/** Email via Amazon SES (SESv2). Selected when EMAIL_PROVIDER=ses + a region is set. */
const sesProvider: ChannelProvider = {
  channel: "EMAIL",
  name: "ses",
  isConfigured: () =>
    process.env["EMAIL_PROVIDER"] === "ses" && !!(process.env["AWS_SES_REGION"] || process.env["AWS_REGION"]),
  async send(to, msg) {
    const region = process.env["AWS_SES_REGION"] || process.env["AWS_REGION"];
    // Dynamic import so the SDK is only loaded when SES is actually configured.
    const pkg = "@aws-sdk/client-sesv2";
    const { SESv2Client, SendEmailCommand } = (await import(pkg)) as any;
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
    const pkg = "nodemailer";
    const nodemailer = (await import(pkg)) as any;
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

/** SMS via Twilio. */
const twilioProvider: ChannelProvider = {
  channel: "SMS",
  name: "twilio",
  isConfigured: () => !!process.env["TWILIO_AUTH_TOKEN"],
  async send(to, msg) {
    const pkg = "twilio";
    const twilioMod = (await import(pkg)) as any;
    const client = twilioMod.default(process.env["TWILIO_ACCOUNT_SID"]!, process.env["TWILIO_AUTH_TOKEN"]!);
    const sent = await client.messages.create({ from: process.env["TWILIO_FROM"]!, to, body: msg.body || "" });
    return sent.sid;
  },
};

/** Always-available dev transport: records the rendered message, reports success. */
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

const REGISTRY: Partial<Record<Channel, ChannelProvider[]>> = {
  EMAIL: [sesProvider, smtpProvider],
  SMS: [twilioProvider],
};

/** The provider that will handle this channel given current config. */
export function selectProvider(channel: Channel): ChannelProvider {
  const candidates = REGISTRY[channel] ?? [];
  return candidates.find((p) => p.isConfigured()) ?? logProvider(channel);
}

/** Deliver one outbox row through the selected provider; returns its message id. */
export async function deliver(row: OutboxRow): Promise<string> {
  const provider = selectProvider(row.channel);
  return provider.send(row.toAddress ?? "", { subject: row.subject, body: row.body });
}
