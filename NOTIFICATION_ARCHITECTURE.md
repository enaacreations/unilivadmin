# UNILIV Notification Platform — Architecture & Rollout

Status: **approved direction** (decisions below), phased build.
Owners: platform. Last updated: 2026-06-20.

This document is the contract the build executes against. It supersedes the
inline best-effort `notify()` engine in `apps/api-server/src/lib/notification-service.ts`,
which it **evolves** rather than replaces — the existing tables (`notification_outbox`,
`notifications`, `notification_preferences`, `push_subscriptions`) and channel enum
(EMAIL · SMS · PUSH · WHATSAPP · IN_APP) are already the right shape and are kept.

---

## 1. Decisions (chosen)

| Axis | Decision |
|---|---|
| Service shape | **Dedicated microservice** (`@workspace/notify-service`) consuming a **Redis + BullMQ** queue. Independently deployable & scalable. |
| Producer | The API (and any service) calls a thin `notify()` client that **enqueues a BullMQ job** (and writes the durable `notification_outbox` row). No inline delivery. |
| Channels | EMAIL, SMS, WHATSAPP, PUSH (mobile/FCM), WEBPUSH (VAPID), IN_APP. Pluggable provider adapters. |
| Priority channels | **Web push (VAPID)**, **Mobile push (FCM)**, **India SMS (MSG91) + email deliverability (SES/Sendgrid)**. WhatsApp after. |
| Password reset | **SMS OTP _and_ an emailed single-use link** → dedicated `/reset-password/:token` page. |
| Forgot username | SMS OTP → emailed single-use link → dedicated `/recover-username/:token` page. |
| Durability | Postgres `notification_outbox` = source of truth/audit; Redis/BullMQ = the work queue. Outbox row id travels on the job for idempotency + reconciliation. |

**Why outbox _and_ BullMQ?** The outbox gives durability, audit, and a reconciliation
sweep (re-enqueue rows stuck PENDING) that survives a Redis flush; BullMQ gives
fast, retriable, rate-limited, observable async delivery. Belt and suspenders — the
standard "transactional outbox + broker" pattern.

---

## 2. Topology

```
┌──────────────┐   notify(event,to,data)    ┌──────────────────────────────┐
│  API server  │ ─────────────────────────► │ notify() client (in @workspace/notify-core)
│ (+ any svc)  │   1. INSERT outbox row      │  2. queue.add(job{outboxId})  │
└──────────────┘     (PENDING)               └──────────────┬───────────────┘
                                                            │ Redis (BullMQ)
                                          ┌─────────────────▼───────────────────┐
                                          │   notify-service (worker process)    │
                                          │   concurrency=N, rate-limited        │
                                          │  ┌────────────────────────────────┐  │
                                          │  │ resolve recipient + prefs +     │  │
                                          │  │ locale + quiet hours            │  │
                                          │  │ render template (per channel)   │  │
                                          │  │ dispatch via ChannelProvider    │  │
                                          │  └───────────┬────────────────────┘  │
                                          └──────────────┼──────────────────────┘
       ┌───────────────────────────────────────────────┼─────────────────────────────────┐
     EMAIL              SMS            WHATSAPP        PUSH(FCM)        WEBPUSH        IN_APP
   SES/Sendgrid      MSG91/Twilio    Meta Cloud      Android+iOS      VAPID          DB + SSE
   /SMTP                                                                              (live bell)
       │                │                │               │               │
       └──── success/fail → update outbox(status,attempts,providerMessageId,nextAttemptAt) ──┘
                                  exhausted → DLQ (failed queue) + alert
       ▲
   provider webhooks (SES SNS bounce/complaint, MSG91 DLR, WhatsApp status, FCM token-invalid)
       └────► delivery status + suppression list (hard bounces / opt-outs / dead tokens)
```

### Packages (pnpm workspace)
- `@workspace/notify-core` — shared: the `notify()` producer client, job/types, template
  registry, `ChannelProvider` interface, outbox helpers. Imported by the API **and** the worker.
- `@workspace/notify-service` — the deployable worker: BullMQ `Worker`, provider adapters,
  webhook HTTP endpoints (bounce/DLR/status), health, metrics.
- Reuses `@workspace/db` for the tables.

> Extraction path is trivial because the API never imports a provider — it only
> imports `notify-core` (enqueue). Providers live only in `notify-service`.

---

## 3. Data model (deltas to existing schema)

Existing kept as-is: `notifications`, `notification_outbox`, `notification_preferences`,
`push_subscriptions`. Add:

- **`notification_outbox`** — add: `dedupeKey text` (idempotency), `nextAttemptAt timestamp`
  (backoff), `maxAttempts int default 6`, `provider text`, `failedAt timestamp`. Add status
  values `RETRYING`, `DEAD` to `notification_send_status`.
- **`device_tokens`** (mobile push) — `id, userId, platform (ANDROID|IOS), token, appVersion,
  isActive, lastSeenAt`. (Web push already has `push_subscriptions`.)
- **`notification_templates`** — `key, channel, locale, version, subject, body (handlebars/MJML),
  active`. Code-seeded first; table allows non-deploy edits later.
- **`notification_suppressions`** — `channel, address, reason (HARD_BOUNCE|COMPLAINT|UNSUBSCRIBED|
  INVALID_TOKEN), createdAt`. Checked before every send.
- **`password_reset_tokens`** — `id, userId, tokenHash, expiresAt, usedAt, requestedIp`.
  (Username-recovery reuses the same table with a `purpose` column, or a sibling table.)
- **`notification_preferences`** — extend with `whatsappEnabled`, `smsEnabled`, `quietHoursStart/End`,
  `timezone`, plus keep per-`eventType` rows; add a category→default-channels map in code.

All emails normalized to lowercase at write time (also closes the case-variant auth issue).

---

## 4. The `notify()` contract (producer API)

```ts
await notify({
  event: "password_reset",            // maps to template(s) + default channels
  to: { userId } | { email, phone },  // recipient (resolved → contacts + prefs)
  data: { resetUrl, name },           // template variables
  channels?: ["email"],               // override default routing
  dedupeKey?: "pwreset:<userId>:<ts>",// idempotency (no double-send on retry)
  category?: "SECURITY",              // for preferences/quiet-hours rules
});
```
Returns immediately after enqueue. Delivery, retries, and tracking happen in the worker.
Security/transactional events (OTP, reset) ignore quiet hours and marketing opt-outs.

---

## 5. Channel providers (adapter per vendor)

```ts
interface ChannelProvider {
  channel: Channel;
  name: string;                 // "ses" | "msg91" | "fcm" | "vapid" | "meta-wa" | "smtp"
  isConfigured(): boolean;      // env present?
  send(msg: Rendered, to: Recipient): Promise<{ providerMessageId: string }>;
  parseWebhook?(req): DeliveryUpdate[];   // bounce/DLR/status → outbox
}
```
Registry picks the configured provider per channel (priority + failover). Adding a vendor =
a new adapter file. Planned adapters: **Email** SES/Sendgrid (prod) + SMTP (dev/fallback);
**SMS** MSG91 (India) + Twilio (intl); **WhatsApp** Meta Cloud API (approved templates);
**Push** FCM (Android+iOS); **WebPush** `web-push` (VAPID); **In-app** DB row + SSE broadcast.

---

## 6. Reliability & scale
- **Retries**: BullMQ exponential backoff (e.g. 6 attempts, 30s→…→hours); on exhaustion →
  `DEAD` + failed queue + alert. Outbox mirrors `attempts/nextAttemptAt/status`.
- **Idempotency**: `dedupeKey` unique guard + BullMQ jobId so a re-enqueue never double-sends.
- **Rate limiting**: per-provider limiter (WhatsApp/Twilio caps) via BullMQ limiter.
- **Reconciliation**: cron sweep re-enqueues outbox rows `PENDING/RETRYING` past `nextAttemptAt`
  (covers a Redis loss). 
- **Concurrency**: worker scales horizontally (BullMQ shares one Redis); stateless.
- **Observability**: counts by channel/provider/status, DLQ size, age; `/health`; structured logs.
- **Real-time in-app**: SSE stream per user replaces bell polling; web push wakes background tabs.

---

## 7. Security
- Reset/username tokens: 32-byte random, **hashed at rest**, single-use, ≤30-min TTL,
  rate-limited per identifier+IP. The OTP step still gates issuance.
- Anti-enumeration: forgot-* always returns a neutral "if an account exists…".
- Reset success **revokes all sessions** (delete refresh tokens + null `currentSessionId`).
- Webhook endpoints verify provider signatures (SES SNS, Meta, MSG91).
- Provider secrets via env/secret manager; never logged. PII minimized in logs.
- Email links are origin-fixed (`APP_BASE_URL`), token-only — no user-controlled redirect.

---

## 8. Environment (new)
```
REDIS_URL=redis://localhost:6379
# Email (pick one prod provider; SMTP is dev/fallback)
EMAIL_PROVIDER=ses|sendgrid|smtp
AWS_SES_REGION= / SENDGRID_API_KEY= / SMTP_* (existing)
EMAIL_FROM="UNILIV <no-reply@unilivues1.enaacreations.com>"
# SMS
SMS_PROVIDER=msg91|twilio
MSG91_AUTH_KEY= / MSG91_SENDER_ID= / TWILIO_* (existing)
# Web push
VAPID_PUBLIC_KEY= / VAPID_PRIVATE_KEY= / VAPID_SUBJECT=mailto:ops@uniliv.com
# Mobile push
FCM_PROJECT_ID= / FCM_SERVICE_ACCOUNT_JSON=(path or base64)
# WhatsApp
META_WA_PHONE_NUMBER_ID= / META_WA_TOKEN= / META_WA_VERIFY_TOKEN=
NOTIFY_WORKER_CONCURRENCY=10
```

---

## 9. Phased rollout

- **Phase 1 — Recovery flows (no new infra).** Rework password-reset & forgot-username to
  **OTP → emailed single-use link → dedicated page** on the *current* engine. Adds
  `password_reset_tokens`, the email templates, the two public pages/routes, session
  revocation. Fully verifiable now (dev log transport shows the email). ← **start here**
- **Phase 2 — Service + queue.** Stand up `@workspace/notify-core` + `@workspace/notify-service`,
  Redis + BullMQ, migrate `notify()` to enqueue, worker with retries/backoff/DLQ + reconciliation
  sweep, move Phase-1 emails onto it. (Needs Redis.)
- **Phase 3 — Deliverability + India SMS.** SES/Sendgrid adapter + bounce/complaint webhooks +
  suppression list; MSG91 adapter + DLR. SPF/DKIM/DMARC for the domain.
- **Phase 4 — Push.** Web push (VAPID) end-to-end (subscribe UI + SW + send); FCM mobile push
  + `device_tokens` register/unregister + invalid-token cleanup. Real-time bell via SSE.
- **Phase 5 — WhatsApp + preferences + ops.** Meta Cloud API with approved templates + status
  webhooks; preferences UI (per-category/channel, quiet hours); delivery dashboard + alerting;
  extract worker to its own deploy.

Each phase ships independently and is gated by its env (absent creds → channel dormant,
exactly like Google sign-in today).
