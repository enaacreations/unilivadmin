/**
 * Inbound provider webhooks. Currently: Amazon SES delivery events via SNS
 * (bounce / complaint). A permanent bounce or a complaint adds the address to
 * the notification suppression list, so the worker never sends to it again.
 *
 * SNS posts JSON (often as text/plain), so the body is read raw and parsed. The
 * SNS signature is verified (sns-validator) before any state change — an
 * unverified webhook could otherwise let anyone poison deliverability. In real
 * development only (NODE_ENV=development), SES_WEBHOOK_SKIP_VERIFY=1 bypasses
 * verification for local testing; every other NODE_ENV, including unset,
 * enforces it.
 */
import { Router, text as textBody, raw as rawBody, type Request, type Response } from "express";
import { suppress } from "@workspace/notify-core";
import { ENFORCE_PROD_SECURITY, IS_DEVELOPMENT } from "../config/env.js";
import {
  db,
  walletsTable,
  walletTransactionsTable,
  paymentsTable,
  ledgerEntriesTable,
  residentsTable,
} from "@workspace/db";
import { and, asc, eq, gte, or, sql } from "drizzle-orm";
import { newId } from "../lib/id.js";
import { creditWallet, isUniqueViolation, roundMoney, type TxClient } from "../lib/wallet-service.js";
import {
  isRazorpayWebhookConfigured,
  verifyWebhookSignature,
} from "../lib/razorpay.js";

const router = Router();

// Invariant (config/env.ts): a security backdoor is honoured ONLY in real
// development and fails closed for anything else — including an unset or
// unrecognised NODE_ENV, the historical bug that flipped several security
// switches at once. `!== "production"` inverted that: on staging, or on any box
// that simply forgot NODE_ENV, one env var disabled SNS signature verification
// outright and let anyone poison the suppression list.
const SKIP_VERIFY = IS_DEVELOPMENT && process.env["SES_WEBHOOK_SKIP_VERIFY"] === "1";

// Expected SNS topic ARN. sns-validator only proves the message is signed by
// *some* AWS SNS topic, not *our* topic, so without this any AWS account can
// forge a valid bounce/complaint and poison the suppression list. REQUIRED
// (fail closed) in every hardened environment — production AND an unset or
// unrecognised NODE_ENV, matching ENFORCE_PROD_SECURITY and the SKIP_VERIFY
// gate above. Only real development warns and proceeds, for local testing.
const EXPECTED_TOPIC_ARN = process.env["SES_SNS_TOPIC_ARN"];

/**
 * Outcome of SNS signature verification. `REJECTED` means the envelope itself is
 * bad (403). `INFRASTRUCTURE` means *we* are broken — the validator module did
 * not load, or its certificate fetch failed — and must never be answered like a
 * forged signature: collapsing the two into one silent `false` is exactly what
 * kept the unbundled-sns-validator defect invisible for three rounds, because a
 * broken build and an attacker produced byte-identical 403s.
 */
type SnsVerification =
  | { ok: true }
  | { ok: false; kind: "REJECTED" | "INFRASTRUCTURE"; reason: string; err: unknown };

/**
 * Envelope-level rejections sns-validator raises. These are the ONLY failures
 * attributable to the caller; anything else (a cert that could not be fetched, a
 * PEM that would not parse, a module that would not load) is our deployment
 * failing and is reported as such. Defaulting the unknown case to
 * INFRASTRUCTURE is deliberate: a wrong 403 hides a broken deployment, a wrong
 * 503 merely makes SNS retry.
 *
 * Known overlap: `SigningCertURL` is caller-supplied (constrained to an
 * https sns.<region>.amazonaws.com/*.pem URL), so a forged envelope naming a
 * .pem that 404s also lands in the INFRASTRUCTURE branch. That is the safe way
 * round — nothing is processed either way — and the logged `signingCertHost`
 * plus `topicArn` are what tell "our egress is broken" from "someone pointed us
 * at a dead AWS URL".
 */
const SNS_REJECTION_PATTERNS = [
  /missing required keys/i,
  /certificate is located on an invalid domain/i,
  /signature version .* is not supported/i,
  /message signature is invalid/i,
];

async function verifySns(envelope: unknown): Promise<SnsVerification> {
  if (SKIP_VERIFY) return { ok: true };

  let validator: { validate: (hash: unknown, cb: (err: unknown) => void) => void };
  try {
    // Literal specifier on purpose: the api runtime image is a single esbuild
    // bundle with no node_modules, and esbuild cannot follow a VARIABLE
    // specifier — `const pkg = "sns-validator"; import(pkg)` stayed a runtime
    // import, so every SNS bounce/complaint event 403'd in production. Same
    // reasoning as the SES/SMTP notes in notify-core/providers.ts. The missing
    // type declarations are supplied by src/types/sns-validator.d.ts.
    const mod = (await import("sns-validator")) as any;
    const Validator = mod.default || mod;
    validator = new Validator();
  } catch (err) {
    // Module missing from the bundle, or its export shape changed. Nothing about
    // the request caused this.
    return { ok: false, kind: "INFRASTRUCTURE", reason: "sns-validator failed to load", err };
  }

  try {
    await new Promise<void>((resolve, reject) =>
      validator.validate(envelope, (err: unknown) => (err ? reject(err) : resolve())),
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = SNS_REJECTION_PATTERNS.some((p) => p.test(message))
      ? ("REJECTED" as const)
      : ("INFRASTRUCTURE" as const);
    return { ok: false, kind, reason: message, err };
  }
}

/** Host of the envelope's SigningCertURL — the field a cert-fetch failure is about. */
function signingCertHost(envelope: any): string | null {
  try {
    return new URL(String(envelope?.SigningCertURL)).host;
  } catch {
    return null;
  }
}

/**
 * Only follow an SNS SubscriptionConfirmation SubscribeURL if it parses to an
 * https URL on an sns.<region>.amazonaws.com host. The URL is normally covered
 * by the SNS signature, but when SES_WEBHOOK_SKIP_VERIFY bypasses verification
 * in development it becomes attacker-controlled, so never derive an outbound
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

    const verification = await verifySns(envelope);
    if (!verification.ok) {
      // Log the discriminating detail (never the response body — the caller gets
      // no internals) so a broken deployment is distinguishable from a forgery
      // in the logs, which black-box probing of this endpoint cannot do.
      const context = {
        err: verification.err,
        kind: verification.kind,
        reason: verification.reason,
        messageId: envelope.MessageId ?? null,
        topicArn: envelope.TopicArn ?? null,
        signingCertHost: signingCertHost(envelope),
      };
      if (verification.kind === "INFRASTRUCTURE") {
        // Loud, and a 5xx: treating our own breakage as "attacker sent a bad
        // signature" is how this class of bug hides. 503 also makes SNS retry,
        // so a real bounce is not dropped while the deployment is repaired.
        req.log.error(context, "SES/SNS signature verification unavailable (deployment fault)");
        res.status(503).json({ success: false, error: "Signature verification unavailable" });
        return;
      }
      req.log.warn(context, "SES/SNS webhook rejected: signature verification failed");
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
    } else if (ENFORCE_PROD_SECURITY) {
      // Fail closed: without the allowlist any AWS account could forge a signed
      // bounce/complaint and poison the suppression list. Never process in a
      // hardened environment — which includes an unset/unknown NODE_ENV.
      req.log.error("SES_SNS_TOPIC_ARN is not set; rejecting SES/SNS webhook (set it to enable SES webhooks)");
      res.status(403).json({ success: false, error: "Webhook not configured" });
      return;
    } else {
      req.log.warn("SES_SNS_TOPIC_ARN is not set; skipping TopicArn allowlist check (development only)");
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
// Idempotent: a top-up credit is keyed off the Razorpay PAYMENT id, namespaced
// by referenceType (see RAZORPAY_REF_TYPE); a dues settlement is keyed off the
// COLLECTION (notes.linkRef), because the two events do not agree on a provider
// id (see settleResidentDues). Both keys are backed by a unique index.
// No-op gracefully (200) when the webhook secret is unconfigured.
// ─────────────────────────────────────────────────────────────────────────────

// Namespaces for the idempotency key. Both match the UNIQUE (reference_type,
// reference_id) constraint on wallet_transactions, so the dedupe SELECT and the
// DB constraint agree on exactly what "already settled" means.
const RAZORPAY_REF_TYPE = "RAZORPAY_PAYMENT";
const RAZORPAY_LINK_REF_TYPE = "RAZORPAY_LINK";

// The two DISJOINT provider keyspaces one collection can land in. `payment.captured`
// knows only the `pay_…` id and a `payment_link.paid` with no nested payment knows
// only the `plink_…` id, so on a legacy link (no notes.linkRef) the same collection
// is keyed two different ways. See the legacy-twin guard in settleResidentDues.
const PAY_ID_PREFIX = "pay_";
const LINK_ID_PREFIX = "plink_";

/** Razorpay retries an undelivered webhook for 24h, so a redelivery of the same
 *  collection cannot be older than that. Bounds the legacy-twin lookup. */
const REDELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Note token tying every credit back to the payment link that produced it.
 * Razorpay copies a link's `notes` onto each payment made against it, so this
 * is the only handle that survives into a `payment.captured` payload — that
 * event carries no link entity at all. Minted at link creation
 * (wallet.ts / residents.ts) as `notes.linkRef`.
 */
const linkNote = (linkRef: string): string => `razorpay_link:${linkRef}`;

export interface RazorpayCorrelation {
  kind?: string;
  residentId?: string;
  propertyId?: string;
  /** The single instalment this event's payment entity carries, in paise. */
  amountPaise: number;
  /** That instalment's Razorpay payment id — its idempotency key. */
  refId?: string;
  /** Total collected against the link so far, in paise. Link events only. */
  linkPaidPaise?: number;
  /** The Razorpay payment-link id — the reconciliation credit's idempotency key. */
  linkId?: string;
  /** Our own correlation token from the link's notes (see linkNote). */
  linkRef?: string;
}

// Invariant: the wallet is credited exactly what Razorpay collected, whichever
// of the two events the account happens to subscribe to (an unversioned
// dashboard setting this code cannot read). The two payloads mean different
// things and must be read differently: `payment.captured` reports ONE
// instalment, `payment_link.paid` reports the link TOTAL (`amount_paid`, the sum
// of every instalment when acceptPartial is on) with only the FINAL instalment
// nested under payload.payment. Inferring the amount from whichever key happens
// to be present therefore breaks one subscription or the other — reading the
// link entity double-credits a both-subscribed account, reading the payment
// entity under-credits a link-only one. So the event type decides the shape, and
// the two settle a shared ledger: each instalment is keyed on its own payment
// id, and the link event tops up only what those instalments did not cover.
// Exported so the tests drive the settle functions from real event payloads —
// which of the two shapes an event is read as is half of what has been wrong here.
export function correlationFromEntity(payload: any, type: string): RazorpayCorrelation {
  const pl = payload?.payment_link?.entity;
  const pay = payload?.payment?.entity;
  const notes = pl?.notes || pay?.notes || {};
  const c: RazorpayCorrelation = {
    kind: notes.kind,
    residentId: notes.residentId,
    propertyId: notes.propertyId,
    linkRef: notes.linkRef ? String(notes.linkRef) : undefined,
    amountPaise: Number(pay?.amount ?? 0),
    refId: pay?.id ? String(pay.id) : undefined,
  };
  if (type === "payment_link.paid" && pl?.id) {
    c.linkId = String(pl.id);
    c.linkPaidPaise = Number(pl.amount_paid ?? pl.amount ?? 0);
    // A link event with no nested payment (rare, but the entity is optional in
    // the contract) still has to settle: fall back to the link total.
    if (!c.refId) c.amountPaise = c.linkPaidPaise;
  }
  return c;
}

/**
 * What one webhook delivery did with the money it reported. `unresolved` means
 * some of a REAL payment could not be applied — the route logs those at error
 * level, because a silently dropped or silently under-credited collection is
 * indistinguishable from success and is the one failure mode nobody notices.
 */
interface SettlementResult {
  status: "settled" | "unresolved";
  reason: string;
  /** Rupees this delivery actually moved (0 when it deduped). */
  credited: number;
  /** Rupees reported by the provider that we did NOT apply. Must normally be 0. */
  unaccounted: number;
  /**
   * Rupees this delivery could neither credit nor DISPROVE. Deliberately not
   * `unaccounted`: that field means money we can prove never landed, and it
   * escalates to an error log. A legacy link carries no correlation token, so
   * its remainder may already be in the wallet under each instalment's own
   * payment id — calling that "unaccounted" fired "manual reconciliation
   * required" on money that was fully credited, and a money-path alarm that
   * cries wolf is one operators learn to ignore.
   */
  unverified?: number;
}

/** Whether (refType, refId) is already recorded — the per-row idempotency key. */
async function hasReference(tx: TxClient, refType: string, refId: string): Promise<boolean> {
  const [existing] = await tx
    .select({ id: walletTransactionsTable.id })
    .from(walletTransactionsTable)
    .where(
      and(
        eq(walletTransactionsTable.referenceType, refType),
        eq(walletTransactionsTable.referenceId, refId),
      ),
    );
  return !!existing;
}

/**
 * Credit one idempotent row through the shared money path, or no-op when
 * (refType, refId) already settled. Mirrors the wallet_transactions unique
 * constraint, which is what makes the guard survive two concurrent deliveries.
 * Returns what it actually credited so callers can report it.
 */
async function creditOnce(
  tx: TxClient,
  wallet: { id: string },
  amount: number,
  refType: string,
  refId: string,
  meta: { description: string; propertyId: string | null; notes: string | null },
): Promise<number> {
  if (amount <= 0) return 0;
  if (await hasReference(tx, refType, refId)) return 0;
  await creditWallet(wallet.id, amount, "TOPUP", {
    description: meta.description,
    recordedBy: "SYSTEM_RAZORPAY",
    propertyId: meta.propertyId,
    notes: meta.notes,
    referenceId: refId,
    referenceType: refType,
  }, tx);
  return amount;
}

/**
 * The single authoritative accounting for ONE payment link: how much of that
 * collection is already in the wallet, and whether a `payment_link.paid` has
 * already reconciled the link total.
 *
 * Invariant: the credits carrying a link's note sum to exactly what that link
 * collected. Both credit paths in settleWalletTopup read this — under the
 * wallet's FOR UPDATE lock — so they share one number instead of forming two
 * independent views, which is what let a reordered or retried payment.captured
 * re-credit an instalment the link reconciliation had already absorbed.
 */
async function linkAccounting(
  tx: TxClient,
  walletId: string,
  note: string,
): Promise<{ credited: number; reconciled: boolean }> {
  const [row] = await tx
    .select({
      credited: sql<string>`coalesce(sum(${walletTransactionsTable.amount}), 0)`,
      reconciliations: sql<string>`count(*) filter (where ${walletTransactionsTable.referenceType} = ${RAZORPAY_LINK_REF_TYPE})`,
    })
    .from(walletTransactionsTable)
    .where(
      and(
        eq(walletTransactionsTable.walletId, walletId),
        eq(walletTransactionsTable.notes, note),
      ),
    );
  return {
    credited: Number(row?.credited ?? 0),
    reconciled: Number(row?.reconciliations ?? 0) > 0,
  };
}

/** Exported so the credit accounting can be exercised without a signed webhook. */
export async function settleWalletTopup(c: RazorpayCorrelation): Promise<SettlementResult> {
  const residentId = c.residentId;
  if (!residentId) {
    return { status: "settled", reason: "no residentId in link notes", credited: 0, unaccounted: 0 };
  }
  const note = c.linkRef ? linkNote(c.linkRef) : null;
  const propertyId = c.propertyId ?? null;
  // What this payload reports: the link TOTAL (link events only) and the ONE
  // instalment nested under payload.payment. See correlationFromEntity.
  const collected = c.linkPaidPaise ? roundMoney(c.linkPaidPaise / 100) : 0;
  const instalment = c.refId ? roundMoney(c.amountPaise / 100) : 0;

  let credited = 0;
  let unaccounted = 0;
  let unverified = 0;
  let reason = "nothing to credit";

  try {
    await db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(walletsTable)
        .where(eq(walletsTable.residentId, residentId))
        .for("update");
      if (!wallet) {
        // Money collected with nowhere to land. Report it instead of returning
        // quietly — an unprovisioned wallet is recoverable, a lost credit is not.
        unaccounted = Math.max(collected, instalment);
        reason = "wallet not provisioned for resident";
        return;
      }

      const before = note ? await linkAccounting(tx, wallet.id, note) : null;

      // 1. The instalment this event carries, keyed on its own payment id so
      //    payment.captured and the payment nested in payment_link.paid dedupe
      //    against each other rather than each crediting the same money.
      if (c.refId) {
        if (before?.reconciled) {
          // Invariant: total credited for one link equals what that link
          // collected. A reconciliation row means payment_link.paid already
          // topped the wallet up to amount_paid — which INCLUDES every
          // instalment — so a late, reordered or redelivered payment.captured
          // is money already in the wallet, not new money.
          reason = "instalment already covered by the link reconciliation";
        } else {
          credited += await creditOnce(tx, wallet, instalment, RAZORPAY_REF_TYPE, c.refId, {
            description: `Online wallet top-up (Razorpay ${c.refId})`,
            propertyId,
            notes: note,
          });
          reason = credited > 0 ? "instalment credited" : "instalment already credited";
        }
      }

      // 2. Link reconciliation: whatever the link collected that the instalment
      //    rows do not account for. Top-up links accept partial payment
      //    (wallet.ts), so an account subscribed only to payment_link.paid never
      //    sees the earlier instalments and this is what credits them.
      if (c.linkId && collected > 0) {
        if (note) {
          // Re-read AFTER step 1 so the shortfall is measured against the same
          // ledger the instalment just wrote to — one accounting, not two.
          const after = await linkAccounting(tx, wallet.id, note);
          const shortfall = roundMoney(collected - after.credited);
          if (shortfall > 0) {
            credited += await creditOnce(tx, wallet, shortfall, RAZORPAY_LINK_REF_TYPE, c.linkId, {
              description: `Online wallet top-up — link settlement (Razorpay ${c.linkId})`,
              propertyId,
              notes: note,
            });
            reason = "link reconciled";
          } else if (shortfall < 0) {
            // Credited MORE than the link collected — impossible under this
            // accounting, so surface it rather than leaving it in the balance.
            unaccounted = shortfall;
            reason = "wallet credited more than the link collected";
          } else {
            reason = "link already fully credited";
          }
        } else if (await hasReference(tx, RAZORPAY_LINK_REF_TYPE, c.linkId)) {
          // Legacy link the pre-fix handler already settled: it credited the
          // whole link total keyed on the link id, which the namespace migration
          // (scripts/migrate-wallet-reference-namespace) moved into
          // RAZORPAY_LINK. Nothing is outstanding, so this is not an alarm.
          reason = "legacy link already reconciled under its link id";
        } else {
          // Legacy link minted before notes.linkRef existed. With no correlation
          // token we cannot tell which of the wallet's existing credits belong to
          // this link, so crediting the remainder could double it — it stays
          // uncredited and on the record rather than dropped silently.
          //
          // But it is UNVERIFIABLE, not proven missing, and the two are not the
          // same alarm: top-up links accept partial payment (wallet.ts), so on an
          // account subscribed to payment.captured every earlier instalment is
          // ALREADY in the wallet under its own payment id, and this branch has
          // no way to see those credits. `collected - instalment` therefore
          // reported the whole remainder as unaccounted and escalated "manual
          // reconciliation required" on money that was fully credited. Report it
          // as unverified (warn) and keep `unaccounted` for provable gaps.
          // (Deploy note: migrate the legacy RAZORPAY namespace first.)
          const remainder = roundMoney(collected - instalment);
          if (remainder > 0) {
            unverified = remainder;
            reason = "legacy link without notes.linkRef — remainder could not be verified";
          }
        }
      }
    });
  } catch (err) {
    // Lost the race with a concurrent delivery of the same payment: the unique
    // constraint rolled this whole transaction back, so the credit was applied
    // exactly once. Already settled is success, not a 500.
    if (!isUniqueViolation(err)) throw err;
    return { status: "settled", reason: "concurrent delivery already settled", credited: 0, unaccounted: 0 };
  }
  return { status: unaccounted !== 0 ? "unresolved" : "settled", reason, credited, unaccounted, unverified };
}

/** Exported alongside settleWalletTopup, for the same reason. */
export async function settleResidentDues(c: RazorpayCorrelation): Promise<SettlementResult> {
  const residentId = c.residentId;
  const amount = roundMoney(c.amountPaise / 100);
  // Dues links do NOT accept partial payment (residents.ts), so one link yields
  // exactly ONE collection and both events describe that same collection. They
  // do NOT agree on a provider id, though: payment.captured carries no link
  // entity, and a payment_link.paid can arrive with no nested payment. Keying on
  // `refId ?? linkId` therefore let those two shapes insert two SUCCESS rows and
  // run the ledger auto-settle loop twice for money collected once.
  //
  // Invariant: one collection → at most one SUCCESS payment row. `notes.linkRef`
  // is the only identifier BOTH payloads always carry, so it is the collection
  // key, and it goes in razorpay_pay_id because uq_payments_razorpay_pay_id is
  // what makes single-insert a database guarantee rather than a SELECT-then-
  // INSERT two concurrent deliveries can both pass. `reference` keeps the
  // human-readable provider id for the finance screens.
  //
  // A LEGACY link (minted before notes.linkRef existed) has no collection key and
  // falls back to the provider id, which is exact only while both events agree on
  // one — i.e. whenever the link event carries its nested payment. The remaining
  // shape (legacy link event with NO nested payment plus its captured sibling)
  // keys the same collection as `plink_…` and `pay_…`; the legacy-twin guard below
  // closes it. No link created from now on can be in that shape at all.
  const providerId = c.refId ?? c.linkId;
  const collectionKey = c.linkRef ? `link:${c.linkRef}` : providerId;
  if (!residentId || !collectionKey || amount <= 0) {
    return { status: "settled", reason: "event carries no settleable collection", credited: 0, unaccounted: 0 };
  }
  let credited = 0;
  let unaccounted = 0;
  let reason = "already settled";
  try {
    await db.transaction(async (tx) => {
      // Idempotency: a payment already recorded under this collection key means
      // we're done. The provider id is checked too, so a row written by an
      // earlier deploy (which keyed on the payment id) is still recognised.
      const [paid] = await tx
        .select({ id: paymentsTable.id })
        .from(paymentsTable)
        .where(
          providerId && providerId !== collectionKey
            ? or(
                eq(paymentsTable.razorpayPayId, collectionKey),
                eq(paymentsTable.razorpayPayId, providerId),
              )
            : eq(paymentsTable.razorpayPayId, collectionKey),
        );
      if (paid) return;

      // Legacy-twin guard. Invariant: one collection → at most one SUCCESS
      // payment row, and the ledger auto-settle below runs once for it.
      // uq_payments_razorpay_pay_id enforces that per KEY, and on a legacy link
      // the same collection has two keys in two disjoint namespaces (see
      // providerId above) — so both deliveries inserted a SUCCESS row and the
      // loop ran twice, marking a second batch of ledger entries paid for money
      // nobody collected. Silently forgiving real dues is the worst outcome on
      // this path, so it is closed here rather than left as a documented residual.
      //
      // Deliberately narrow, because a false match under-settles: LEGACY events
      // only (anything minted with notes.linkRef is keyed exactly), matched only
      // ACROSS the two namespaces — never pay_→pay_, which the exact key already
      // dedupes — same resident, same amount, inside the redelivery window.
      if (!c.linkRef) {
        const twinPrefix = collectionKey.startsWith(LINK_ID_PREFIX) ? PAY_ID_PREFIX : LINK_ID_PREFIX;
        const recent = await tx
          .select({ payId: paymentsTable.razorpayPayId, amount: paymentsTable.amount })
          .from(paymentsTable)
          .where(
            and(
              eq(paymentsTable.residentId, residentId),
              eq(paymentsTable.status, "SUCCESS"),
              gte(paymentsTable.createdAt, new Date(Date.now() - REDELIVERY_WINDOW_MS)),
            ),
          );
        // Amount is compared in JS, not SQL: `payments.amount` is an unbounded
        // numeric and older rows may be stored as "500.00" against this event's
        // "500", which a text-parameter equality would miss.
        const twin = recent.find(
          (r) => r.payId?.startsWith(twinPrefix) && roundMoney(Number(r.amount)) === amount,
        );
        if (twin) {
          reason = "legacy link — collection already settled under its sibling provider id";
          return;
        }
      }

      // Property AS OF the payment, so a later transfer cannot re-attribute the
      // collection (M10). The link's notes carry it from creation time; a link
      // minted before that note existed falls back to the resident's property,
      // which is what the (now-retired) coalesce used to do at read time.
      let propertyId = c.propertyId ?? null;
      if (!propertyId) {
        const [resident] = await tx
          .select({ propertyId: residentsTable.propertyId })
          .from(residentsTable)
          .where(eq(residentsTable.id, residentId));
        if (!resident) {
          // Real money against a resident we cannot resolve. Never dropped
          // quietly — the route escalates this to an error log.
          unaccounted = amount;
          reason = "unknown residentId — dues not settled";
          return;
        }
        propertyId = resident.propertyId;
      }
      await tx.insert(paymentsTable).values({
        id: newId(),
        residentId,
        propertyId,
        amount: String(amount),
        mode: "UPI",
        status: "SUCCESS",
        razorpayPayId: collectionKey,
        reference: providerId ?? collectionKey,
        notes: "Razorpay payment-link settlement",
      });
      credited = amount;
      reason = "dues settled";
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
  } catch (err) {
    // Same race as the top-up path: uq_payments_razorpay_pay_id rejected the
    // duplicate, so the dues were settled exactly once. Treat as done — an
    // already-applied settlement is an idempotent success, not a 500.
    if (!isUniqueViolation(err)) throw err;
    return { status: "settled", reason: "concurrent delivery already settled", credited: 0, unaccounted: 0 };
  }
  return { status: unaccounted !== 0 ? "unresolved" : "settled", reason, credited, unaccounted };
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
      // Same invariant as the SES/SNS path above: a rejected webhook must leave a
      // log line saying WHY, or a misconfigured proxy that strips the signature
      // header is indistinguishable from a forgery. No infrastructure branch is
      // needed here — the check is a local HMAC with no module load and no
      // network, and the unconfigured-secret case returns 200 above.
      req.log.warn(
        { hasSignature: !!signature, bodyBytes: raw.length },
        "Razorpay webhook rejected: signature mismatch",
      );
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
    // Both events stay handled — which of the two a Razorpay account subscribes
    // to is an unversioned dashboard setting. Safety comes from the shared
    // payment-id key (correlationFromEntity), not from handling only one of them:
    // whichever arrives first settles, the other dedupes.
    if (type === "payment_link.paid" || type === "payment.captured") {
      const c = correlationFromEntity(event?.payload || {}, type);
      // Every money event leaves a trace. A webhook that returns 200 having done
      // nothing is indistinguishable from one that settled correctly, so the
      // three "did nothing" outcomes — uncorrelated, unknown kind, and a
      // settlement that could not be fully applied — are all logged explicitly.
      const ctx = {
        event: type,
        kind: c.kind,
        residentId: c.residentId,
        paymentId: c.refId,
        linkId: c.linkId,
      };
      if (!c.residentId || (!c.refId && !c.linkId)) {
        req.log.warn(ctx, "razorpay webhook: event could not be correlated to a resident");
      } else if (c.kind === "WALLET_TOPUP" || c.kind === "RESIDENT_DUES") {
        const result =
          c.kind === "WALLET_TOPUP" ? await settleWalletTopup(c) : await settleResidentDues(c);
        if (result.status === "unresolved") {
          req.log.error(
            { ...ctx, ...result },
            "razorpay webhook: collection not fully applied — manual reconciliation required",
          );
        } else if (result.unverified) {
          // On the record, but NOT the error-level alarm: a legacy link's
          // remainder is usually money the instalment credits already hold.
          req.log.warn(
            { ...ctx, ...result },
            "razorpay webhook: settled — legacy link remainder could not be verified against this wallet",
          );
        } else {
          req.log.info({ ...ctx, ...result }, "razorpay webhook settled");
        }
      } else {
        req.log.warn(ctx, "razorpay webhook: unrecognised notes.kind, nothing settled");
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
