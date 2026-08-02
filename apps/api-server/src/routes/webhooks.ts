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
import { Router, text as textBody, raw as rawBody, type Request, type Response } from "express";
import { suppress } from "@workspace/notify-core";
import { IS_PRODUCTION } from "../config/env.js";
import {
  db,
  walletsTable,
  walletTransactionsTable,
  paymentsTable,
  ledgerEntriesTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { newId } from "../lib/id.js";
import {
  isRazorpayWebhookConfigured,
  verifyWebhookSignature,
} from "../lib/razorpay.js";

const router = Router();

const SKIP_VERIFY = process.env["NODE_ENV"] !== "production" && process.env["SES_WEBHOOK_SKIP_VERIFY"] === "1";

// Expected SNS topic ARN. sns-validator only proves the message is signed by
// *some* AWS SNS topic, not *our* topic, so without this any AWS account can
// forge a valid bounce/complaint and poison the suppression list. REQUIRED in
// production (fail closed): when unset in prod the endpoint rejects requests.
// In non-production only we warn and proceed for local testing.
const EXPECTED_TOPIC_ARN = process.env["SES_SNS_TOPIC_ARN"];

async function verifySns(envelope: unknown): Promise<boolean> {
  if (SKIP_VERIFY) return true;
  try {
    // Indirect specifier: keeps TS from statically resolving the (untyped)
    // module and erroring on the missing declaration file.
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
 * Only follow an SNS SubscriptionConfirmation SubscribeURL if it parses to an
 * https URL on an sns.<region>.amazonaws.com host. The URL is normally covered
 * by the SNS signature, but when SES_WEBHOOK_SKIP_VERIFY bypasses verification
 * in non-prod it becomes attacker-controlled, so never derive an outbound
 * request target from an unvalidated field (SSRF guard).
 */
function isTrustedSubscribeUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname);
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

    // The signature only proves the envelope came from some AWS SNS topic, not
    // ours. Enforce an exact TopicArn match so a validly-signed message from a
    // foreign topic cannot forge bounce/complaint suppression.
    if (EXPECTED_TOPIC_ARN) {
      if (envelope.TopicArn !== EXPECTED_TOPIC_ARN) {
        req.log.warn({ topicArn: envelope.TopicArn }, "SES/SNS webhook rejected: unexpected TopicArn");
        res.status(403).json({ success: false, error: "Unexpected SNS topic" });
        return;
      }
    } else if (IS_PRODUCTION) {
      // Fail closed: without the allowlist any AWS account could forge a signed
      // bounce/complaint and poison the suppression list. Never process in prod.
      req.log.error("SES_SNS_TOPIC_ARN is not set; rejecting SES/SNS webhook in production");
      res.status(403).json({ success: false, error: "Webhook not configured" });
      return;
    } else {
      req.log.warn("SES_SNS_TOPIC_ARN is not set; skipping TopicArn allowlist check (non-production)");
    }

    // One-time subscription handshake when wiring the SNS topic to this endpoint.
    if (envelope.Type === "SubscriptionConfirmation" && envelope.SubscribeURL) {
      if (!isTrustedSubscribeUrl(envelope.SubscribeURL)) {
        req.log.warn("SES/SNS subscription rejected: untrusted SubscribeURL");
        res.status(400).json({ success: false, error: "Invalid SubscribeURL" });
        return;
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhooks/razorpay
// Razorpay sends payment events here. We verify the HMAC-SHA256 signature
// (X-Razorpay-Signature) against the RAW body, then on payment_link.paid /
// payment.captured we settle the correlated entity. Correlation uses the link's
// `notes` (kind=RESIDENT_DUES|WALLET_TOPUP + residentId) captured at creation.
//
// Raw-body note: the global express.json() runs before the router, so to verify
// the signature reliably we register a route-level express.raw() parser. When an
// upstream parser has already consumed the stream, req.body arrives as an object
// and we fall back to its JSON serialization (best-effort) for the HMAC.
//
// Idempotent: a top-up/dues settlement keyed off the Razorpay payment/link id is
// applied at most once (guarded via wallet_transactions.referenceId / payments).
// No-op gracefully (200) when the webhook secret is unconfigured.
// ─────────────────────────────────────────────────────────────────────────────
function correlationFromEntity(payload: any): {
  kind?: string;
  residentId?: string;
  amountPaise?: number;
  refId?: string;
} {
  const pl = payload?.payment_link?.entity;
  const pay = payload?.payment?.entity;
  const notes = pl?.notes || pay?.notes || {};
  return {
    kind: notes.kind,
    residentId: notes.residentId,
    amountPaise: Number(pl?.amount_paid ?? pl?.amount ?? pay?.amount ?? 0),
    refId: pl?.id || pay?.id,
  };
}

async function settleWalletTopup(residentId: string, amountPaise: number, refId: string): Promise<void> {
  const amount = amountPaise / 100;
  if (!residentId || amount <= 0) return;
  await db.transaction(async (tx) => {
    const [wallet] = await tx
      .select()
      .from(walletsTable)
      .where(eq(walletsTable.residentId, residentId))
      .for("update");
    if (!wallet) return; // wallet not provisioned — nothing to credit
    // Idempotency: skip if a txn already references this Razorpay id.
    const [existing] = await tx
      .select({ id: walletTransactionsTable.id })
      .from(walletTransactionsTable)
      .where(and(eq(walletTransactionsTable.walletId, wallet.id), eq(walletTransactionsTable.referenceId, refId)));
    if (existing) return;
    const balanceBefore = Number(wallet.balance);
    const balanceAfter = balanceBefore + amount;
    await tx.update(walletsTable).set({ balance: String(balanceAfter), updatedAt: new Date() }).where(eq(walletsTable.id, wallet.id));
    await tx.insert(walletTransactionsTable).values({
      id: newId(),
      walletId: wallet.id,
      residentId,
      type: "TOPUP",
      amount: String(amount),
      balanceBefore: String(balanceBefore),
      balanceAfter: String(balanceAfter),
      description: `Online wallet top-up (Razorpay ${refId})`,
      recordedBy: "SYSTEM_RAZORPAY",
      referenceId: refId,
      referenceType: "RAZORPAY",
    });
  });
}

async function settleResidentDues(residentId: string, amountPaise: number, refId: string): Promise<void> {
  const amount = amountPaise / 100;
  if (!residentId || amount <= 0) return;
  await db.transaction(async (tx) => {
    // Idempotency: a payment already referencing this Razorpay id means we're done.
    const [paid] = await tx
      .select({ id: paymentsTable.id })
      .from(paymentsTable)
      .where(and(eq(paymentsTable.residentId, residentId), eq(paymentsTable.reference, refId)));
    if (paid) return;
    await tx.insert(paymentsTable).values({
      id: newId(),
      residentId,
      amount: String(amount),
      mode: "UPI",
      status: "SUCCESS",
      razorpayPayId: refId,
      reference: refId,
      notes: "Razorpay payment-link settlement",
    });
    // Auto-settle oldest unpaid charges up to the collected amount (whole-entry).
    const unpaid = await tx
      .select()
      .from(ledgerEntriesTable)
      .where(and(eq(ledgerEntriesTable.residentId, residentId), eq(ledgerEntriesTable.isPaid, false)))
      .orderBy(asc(ledgerEntriesTable.dueDate), asc(ledgerEntriesTable.createdAt))
      .for("update");
    let remaining = amount;
    for (const entry of unpaid) {
      const amt = Number(entry.amount);
      if (amt <= 0) continue;
      if (amt > remaining + 0.001) continue;
      await tx.update(ledgerEntriesTable)
        .set({ isPaid: true, paidOn: new Date(), updatedAt: new Date() })
        .where(and(eq(ledgerEntriesTable.id, entry.id), eq(ledgerEntriesTable.isPaid, false)));
      remaining -= amt;
      if (remaining <= 0.001) break;
    }
  });
}

router.post("/webhooks/razorpay", rawBody({ type: () => true }), async (req: Request, res: Response) => {
  try {
    // Gracefully no-op if the webhook secret is not configured.
    if (!isRazorpayWebhookConfigured()) {
      res.status(200).json({ success: true, skipped: "not configured" });
      return;
    }

    // Recover the EXACT raw body for HMAC. The global express.json() verify hook
    // (app.ts) stashes the original bytes on req.rawBody, so we get a byte-exact
    // payload even though the upstream parser consumed the stream. Fall back to
    // the route-level raw Buffer / string / serialization only if rawBody is absent.
    const captured = (req as unknown as { rawBody?: Buffer }).rawBody;
    const raw =
      Buffer.isBuffer(captured) ? captured.toString("utf8")
        : Buffer.isBuffer(req.body) ? req.body.toString("utf8")
          : typeof req.body === "string" ? req.body
            : JSON.stringify(req.body ?? {});

    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    if (!verifyWebhookSignature(raw, signature)) {
      res.status(403).json({ success: false, error: "Invalid signature" });
      return;
    }

    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      res.status(400).json({ success: false, error: "Invalid payload" });
      return;
    }

    const type = event?.event as string | undefined;
    if (type === "payment_link.paid" || type === "payment.captured") {
      const c = correlationFromEntity(event?.payload || {});
      if (c.refId && c.amountPaise && c.residentId) {
        if (c.kind === "WALLET_TOPUP") {
          await settleWalletTopup(c.residentId, c.amountPaise, c.refId);
        } else if (c.kind === "RESIDENT_DUES") {
          await settleResidentDues(c.residentId, c.amountPaise, c.refId);
        }
      }
    }

    // Always 200 so Razorpay does not retry once we've accepted the event.
    res.status(200).json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
