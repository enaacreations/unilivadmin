# Food Ordering & Kitchen Ops — Database Plan (All Phases)

Implementation spec for the schema needed to close the gaps between the current
codebase and **Persona: Unit Lead** (48 stories) + **Notion PRD v1.0**.

Conventions (match existing `lib/db/src/schema/*`): text PKs, `snake_case`
columns, `pgEnum`, `numeric(12,3)` quantities, `defaultNow().notNull()`
timestamps. "Global default vs property override" = **nullable `propertyId`**
(see `perResidentRuleTable`). No FK from `core.ts` → `food.ts` (app-layer
integrity), per the existing `clusterId` note. Local schema is applied with
`drizzle-kit push`; hand-written SQL in `lib/db/migrations/` is prod-only.

**Locked design decisions (confirmed):**
1. Dispatch = **trip/manifest table** (`food_dispatches`), orders link via `dispatchId`.
2. Multi-meal order = **order-batch wrapper** (`food_order_batches`), one order per meal.
3. **Add explicit `ACCEPTED` / `REJECTED`** order states (kitchen acknowledge/decline).
4. PAN/Aadhaar search = **index + join `kyc_requests`** (no PII duplicated on residents).

---

## 0. Gaps that need NO schema (reuse + wire only)

| Requirement | Reuse |
|---|---|
| Property ID/Name/Address (st.42) | `propertiesTable` |
| Active guests / occupancy (st.43/44) | `residentsTable.status` + `propertiesTable.totalBeds` |
| Active-guest list (st.45) | `residentsTable` (gender, checkInDate already exist) |
| Ordered-vs-delivered diff (st.26) | computed from `foodOrderItems` orderedQty vs receivedQty |
| Item-wise dispatched email (st.23) | `foodOrderItems.preparedQty` in outbox payload |
| Wastage/delay analytics (st.33) | `foodOrderItems.wastedQty` + order timestamps + `expectedDeliveryAt` |
| Monthly revenue/property (st.48) | `paymentsTable`→`residents.propertyId` join |
| In-app bell content (st.35/36) | `notificationsTable` (needs writers) |
| Report/menu export (st.14/34/47) | generation concern (optional `report_jobs`) |

---

## 1. Enum changes

**`food.ts`**
- `food_dispatch_status` *(new)* — `LOADING`, `IN_TRANSIT`, `DELIVERED`, `PARTIAL`
- `food_order_status` *(alter)* — add `ACCEPTED`, `REJECTED`
  - New flow: `PLACED → ACCEPTED → PREPARING → DISPATCHED → DELIVERED`; `REJECTED` / `CANCELLED` are terminal.
- `food_menu_share_channel` *(new)* — `EMAIL`, `WHATSAPP`, `LINK`

**`system.ts`**
- `notification_channel` *(new)* — `EMAIL`, `SMS`, `PUSH`, `WHATSAPP`, `IN_APP`
- `notification_send_status` *(new)* — `PENDING`, `SENT`, `FAILED`, `SKIPPED`

**`auth.ts` (new file)**
- `otp_purpose` — `LOGIN`, `FORGOT_USERNAME`, `FORGOT_PASSWORD`, `MOBILE_VERIFY`
- `otp_status` — `PENDING`, `VERIFIED`, `CONSUMED`, `EXPIRED`, `LOCKED`

---

## 2. Column additions (ALTER existing tables)

### `usersTable` (core.ts) — Phase 1/2
| Column | Type | Story |
|---|---|---|
| `username` | `text` unique (nullable → backfill → required) | st.2/7 |
| `designation` | `text` | st.41 |
| `failedLoginAttempts` | `integer default 0 notNull` | st.6 |
| `lockedUntil` | `timestamp` | st.6 |
| `mobileVerifiedAt` | `timestamp` | OTP trust |

### `foodOrdersTable` (food.ts) — Phase 3
| Column | Type | Story |
|---|---|---|
| `batchId` | `text` → `food_order_batches.id` | st.16 |
| `kitchenId` | `text` → `kitchens.id` | st.24 |
| `dispatchId` | `text` → `food_dispatches.id` | st.24 |
| `expectedDeliveryAt` | `timestamp` | st.33 (delay baseline) |
| `acceptedAt` | `timestamp` | st.22 |
| `acceptedById` | `text` → `users.id` | st.22 |
| `rejectedAt` | `timestamp` | st.22 |
| `rejectionReason` | `text` | st.22 |

Existing per-order dispatch columns (`deliveryPartnerId`, `dispatchedById`,
`dispatchStartedAt`, `dispatchedAt`) stay for back-compat; the new flow reads
from the linked `food_dispatches` row. Migration: create one trip per already-
dispatched order and backfill `dispatchId`.

### `residentsTable` (core.ts) — Phase 2, st.46
No new columns. Add DB index `kyc_requests (id_type, id_number)`; resident
global search joins `kyc_requests` for PAN/Aadhaar and `rooms.number` for room.
Search fields become: name, email, phone, room no, PAN, Aadhaar.

### `paymentsTable` (core.ts) — Phase 2, st.48 *(optional)*
Optional denormalized `propertyId` for fast per-property revenue (else join via resident).

---

## 3. New tables

### Phase 1 — Auth / OTP

**`auth.ts` › `otp_challenges`** — st.3–8
```
id, userId(nullable), phone, purpose(otp_purpose),
codeHash, expiresAt, attemptCount(0), resendCount(0),
maxAttempts, maxResend, lastSentAt, consumedAt,
verificationToken(unique, nullable),   -- one-time token for password reset step
status(otp_status), ip, userAgent, createdAt
```
OTP never stored in plaintext. Lockout = attemptCount ≥ maxAttempts. Regenerate
limited by resendCount ≤ maxResend. Forgot-username resolves user by `phone`.

### Phase 1 — Config + notification/email engine (`system.ts`)

**`system_config`** — everything "configurable" (st.5/6)
```
id, key(unique), value(json), description, updatedAt
```
Seeds: `otp.maxResend=3`, `otp.maxAttempts=3`, `otp.length=6`,
`otp.ttlSeconds=300`, `login.maxFailed=5`, `login.lockoutMinutes=15`.

**`notification_outbox`** — multi-channel send queue + audit (st.17/18/22/23)
```
id, userId(nullable), channel(notification_channel),
toAddress, templateKey, subject, body, payload(json),
entityType, entityId, status(notification_send_status),
attempts(0), lastError, providerMessageId, scheduledFor, sentAt, createdAt
```
Bell keeps reading `notificationsTable`; outbox handles EMAIL/SMS/PUSH with
retry + delivery proof. One dispatch service writes both.

**`push_subscriptions`** — real web-push (st.17)
```
id, userId, endpoint(unique), p256dh, auth, userAgent, isActive(true), lastUsedAt, createdAt
```

**`notification_preferences`** *(optional)*
```
id, userId, eventType, emailEnabled, pushEnabled, inAppEnabled, updatedAt
```

### Phase 2 — Export *(optional)*

**`system.ts` › `report_jobs`** — only if XLS/PDF generation goes async
```
id, requestedById, kind, format(XLS|PDF|CSV), params(json),
status, fileUrl, error, createdAt, completedAt
```

### Phase 3 — Kitchen / dispatch / cut-off / batches / menu share (`food.ts`)

**`kitchens`** — st.24 (Kitchen ID / Location / Address + PINCODE)
```
id, name, code(unique), brand(food_brand, nullable),
address, city, state, pincode, lat, lng,
contactName, contactPhone, clusterId(nullable),
isActive(true), createdAt, updatedAt
```

**`food_dispatches`** — trip/manifest, st.24 (van/driver/ETA)
```
id, dispatchNumber(unique), kitchenId, deliveryPartnerId,
vehicleNumber, driverName, driverPhone,
dispatchedById, dispatchedAt, estimatedArrivalAt,
status(food_dispatch_status), notes, createdAt, updatedAt
```
One trip → many orders (orders carry `dispatchId`). Supports bulk dispatch.

**`food_order_batches`** — st.16 (all meals together)
```
id, batchNumber(unique), propertyId, unitLeadId, brand,
serviceDate, residentsCount, notes, createdAt
```
One submission → 1 batch + N per-meal orders, each with its own lifecycle.

**`food_meal_config`** — st.27 (configurable order types + "High Tea" label)
```
id, mealType(food_meal_type, unique), displayLabel,
brand(nullable), sortOrder, isEnabled(true), createdAt, updatedAt
```
Overlay on the enum: relabel SNACKS → "High Tea / Evening Snacks", enable/disable
without an invasive enum→FK migration.

**`food_meal_windows`** — st.11 cut-off (+ st.33 delay baseline)
```
id, brand(nullable), propertyId(nullable=global default),
mealType, cutoffTime("HH:MM"), serviceTime("HH:MM"),
leadTimeMinutes(int), isActive(true), createdAt, updatedAt
```
`expectedDeliveryAt` on the order is computed from the applicable window at
placement; delay = `deliveredAt > expectedDeliveryAt`.

**`food_menu_shares`** — st.15 (share menu with active guests) + audit
```
id, sharedById, propertyId, brand, mealType(nullable),
menuDate, channel(food_menu_share_channel),
recipientType(GUESTS|CUSTOM), recipients(json),
shareToken(unique, nullable), sharedAt, createdAt
```

---

## 4. Tally

| | Items |
|---|---|
| New tables (9 + 2 opt) | otp_challenges, system_config, notification_outbox, push_subscriptions, kitchens, food_dispatches, food_order_batches, food_meal_config, food_meal_windows, food_menu_shares · *opt:* notification_preferences, report_jobs |
| Altered tables (3) | users (+5), foodOrders (+8), residents (index/join only) |
| New enums (7) | food_dispatch_status, food_menu_share_channel, notification_channel, notification_send_status, otp_purpose, otp_status, + ACCEPTED/REJECTED on food_order_status |
| New schema files (1) | `auth.ts` |

## 5. Rollout order
1. **Enums + config** (`system_config`, enum changes) — no dependents break.
2. **Auth** (`auth.ts`, users ALTERs) — Phase 1 login/OTP.
3. **Notification engine** (`notification_outbox`, `push_subscriptions`) — Phase 1 comms.
4. **Food Phase 3 tables** (`kitchens`, `food_dispatches`, `food_order_batches`, `food_meal_config`, `food_meal_windows`, `food_menu_shares`) + `foodOrders` ALTERs.
5. **Indexes** (`kyc_requests`, search) — Phase 2.
6. Update `scripts` seeds: `system_config`, `food_meal_config` (labels), default `food_meal_windows`, sample `kitchens`.
