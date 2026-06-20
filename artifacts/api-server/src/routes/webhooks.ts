/**
 * Inbound provider webhooks. Currently: Amazon SES delivery events via SNS
 * (bounce / complaint). A permanent bounce or a complaint adds the address to
 * the notification suppression list, so the worker never sends to it again.
 *
 * SNS posts JSON (often as text/plain), so the body is read raw and parsed. The
 * SNS signature is verified (sns-validator) before any state change — an
 * unverified webhook could otherwise let anyone poison deliverability. In
 * non-production only, SES_WEBHOOK_SKIP_VERIFY=1 bypasses verification for local
 * testing; it is ignored in production.
 */
import { Router, text as textBody, type Request, type Response } from "express";
import { suppress } from "@workspace/notify-core";

const router = Router();

const SKIP_VERIFY = process.env["NODE_ENV"] !== "production" && process.env["SES_WEBHOOK_SKIP_VERIFY"] === "1";

async function verifySns(envelope: unknown): Promise<boolean> {
  if (SKIP_VERIFY) return true;
  try {
    const pkg = "sns-validator";
    const mod = (await import(pkg)) as any;
    const Validator = mod.default || mod;
    const validator = new Validator();
    await new Promise<void>((resolve, reject) =>
      validator.validate(envelope, (err: unknown) => (err ? reject(err) : resolve())),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Suppress the recipients of a permanent bounce or a complaint. Exported so the
 * suppression logic is unit-testable independent of SNS signature verification.
 */
export async function handleSesNotification(message: any): Promise<{ suppressed: string[] }> {
  const suppressed: string[] = [];
  const type = message?.notificationType || message?.eventType;

  if (type === "Bounce" && message?.bounce?.bounceType === "Permanent") {
    for (const r of message.bounce.bouncedRecipients ?? []) {
      if (r?.emailAddress) {
        await suppress("EMAIL", r.emailAddress, "HARD_BOUNCE", message.bounce.bounceSubType ?? null);
        suppressed.push(r.emailAddress);
      }
    }
  } else if (type === "Complaint") {
    for (const r of message.complaint?.complainedRecipients ?? []) {
      if (r?.emailAddress) {
        await suppress("EMAIL", r.emailAddress, "COMPLAINT", message.complaint?.complaintFeedbackType ?? null);
        suppressed.push(r.emailAddress);
      }
    }
  }
  return { suppressed };
}

router.post("/webhooks/ses", textBody({ type: () => true }), async (req: Request, res: Response) => {
  try {
    const envelope = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!envelope || typeof envelope !== "object") {
      res.status(400).json({ success: false, error: "Invalid payload" });
      return;
    }

    if (!(await verifySns(envelope))) {
      res.status(403).json({ success: false, error: "Invalid SNS signature" });
      return;
    }

    // One-time subscription handshake when wiring the SNS topic to this endpoint.
    if (envelope.Type === "SubscriptionConfirmation" && envelope.SubscribeURL) {
      await fetch(envelope.SubscribeURL).catch(() => {});
      req.log.info("SES/SNS subscription confirmed");
      res.json({ success: true, confirmed: true });
      return;
    }

    if (envelope.Type === "Notification") {
      let message: any = {};
      try {
        message = JSON.parse(envelope.Message);
      } catch {
        message = {};
      }
      const result = await handleSesNotification(message);
      if (result.suppressed.length) {
        req.log.info({ count: result.suppressed.length }, "SES bounce/complaint → addresses suppressed");
      }
      res.json({ success: true, ...result });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
