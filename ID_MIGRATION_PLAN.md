# ID Migration: UUID text → auto-increment bigint

Status: **plan, not started.** Scoped as its own project, ahead of / forked from the Access Controls work
(`ACCESS_CONTROL_GAP_ANALYSIS.md`, `~/.claude/plans/based-on-this-please-gentle-mitten.md`).

## Context

Every table keys on `text("id").primaryKey()` filled by `newId()` = `randomUUID()`
(`apps/api-server/src/lib/id.ts`). Three problems with that, in the order they were raised:

1. **Readability/debuggability** — 36-char opaque strings in logs, URLs and `psql` output.
2. **Performance/storage** — 36-byte text keys in every index and every join, across 177 FK edges.
3. **Consistency** — `audit_events.seq` is already `bigserial` while everything else is UUID text.

Goal: integer keys everywhere, without breaking anything that works today.

### Scale

| | |
|---|---|
| Tables | 125 |
| `text("id").primaryKey()` | 137 |
| FK `.references()` | 177 |
| `newId()` call sites | 221, across 39 files |
| OpenAPI spec string fields | ~846 → regenerated Zod + React Query clients |

### What makes this tractable (verified)

- **Zero `.uuid()` validations** anywhere in the repo — no code asserts UUID shape. Ids are already treated
  as opaque strings, so the type is not baked into validation logic.
- **Public share links use a separate random `token` column** (`audit_report_shares.token`,
  `esign` links), never the row id. So the externally-reachable surface is not id-addressed today and does
  not become enumerable when ids become sequential.
- **Precedent for one-off data migrations exists**: `scripts/src/migrate-wallet-reference-namespace.ts`,
  `backfill-payment-property.ts`, `drop-dead-columns.ts`.

### What makes it dangerous

- **`drizzle-kit push` cannot perform this migration.** There are no migration files; the deploy
  (`scripts/deploy.sh`) runs `push-force` → `verify:schema` → restart, and requires changes to be additive
  because the previous release keeps serving during the push. `ALTER COLUMN id TYPE bigint` on a text PK
  with 177 dependent FKs fails outright — Postgres cannot cast `'a3f1…'` to an integer. **This project needs
  its own migration runner.**
- **Sequential ids make un-scoped endpoints enumerable.** 29 of 37 route files apply no property scoping
  today. See "Prerequisite" below — this is a hard gate, not a parallel task.
- **Entity ids live inside JSON columns**, where no FK analysis will find them. See §4.

---

## 1. Key design decision: one global sequence, not per-table `serial`

**All 125 tables draw from a single `global_id_seq`.** Not a per-table identity column.

```sql
CREATE SEQUENCE global_id_seq AS bigint START 1000 CACHE 100;
```
```ts
id: bigint("id", { mode: "number" }).primaryKey().default(sql`nextval('global_id_seq')`),
```

This delivers all three goals *and* keeps ids globally unique:

| Goal | Per-table `serial` | Global sequence |
|---|---|---|
| Readable (`4021` not `a3f1-…`) | ✅ | ✅ |
| 8 bytes, not 36 | ✅ | ✅ |
| One convention everywhere | ✅ | ✅ |
| **Globally unique** | ❌ `properties.id=1` and `rooms.id=1` collide | ✅ |

The last row is why. The access-control plan's **G1** — an org node's id *is* the entity's id — is what makes
`resolveAccess` a drop-in for the existing resolvers and leaves ~90 food/audit scoping call sites unchanged
at cutover. Per-table sequences destroy that; a global sequence preserves it exactly as `randomUUID()` did.

It also helps debugging beyond readability: a bare `4021` in a log line identifies exactly one row in the
entire system, so you never have to know which table it came from before you can look it up.

Cost: ids are not dense per table (properties might be `1003, 1017, 1042`). That is cosmetic, and mildly
useful — "next property is id+1" stops being true.

> **`bigint` with `mode: "number"`**, not `mode: "bigint"` — values stay JS `number`, so JSON serialization,
> the generated clients and every `===` comparison keep working. Safe to 2^53; a shared sequence across 125
> tables will not approach that.

---

## 2. Prerequisite (hard gate)

**Phase 0 of the access-control plan ships and is verified before Phase C of this one.**

Scope `rooms.ts`, `employees.ts` (+ the attendance sub-router) and `operations.ts`; add `authorize` to
`POST /food/orders/:id/cancel`; make `assertPropertyAccess(req, null)` throw.

Rationale: with UUIDs, a missing scope check needs a lucky guess to exploit. With sequential ids,
`GET /api/residents/1..N` walks the table — KYC data, wallets, ledger. The swap must not land while those
routes are open. This is not a scheduling preference; it is the condition that makes the change safe.

---

## 3. Migration strategy: expand → dual-run → swap → contract

Standard four-step, because there must exist a window where **both** the previous release (text ids) and the
new release (bigint ids) work against the same database — that window is the deploy itself.

### Phase A — Expand (additive; previous release unaffected)

Per table, in FK-dependency order (topological sort of the 177 edges):

1. `ALTER TABLE t ADD COLUMN id_bigint bigint;`
2. Backfill: `UPDATE t SET id_bigint = nextval('global_id_seq') WHERE id_bigint IS NULL;`
3. `CREATE UNIQUE INDEX CONCURRENTLY … ON t (id_bigint);`

Then per FK column:

4. `ALTER TABLE child ADD COLUMN parent_id_bigint bigint;`
5. Backfill by join: `UPDATE child c SET parent_id_bigint = p.id_bigint FROM parent p WHERE c.parent_id = p.id;`
6. `CREATE INDEX CONCURRENTLY … ON child (parent_id_bigint);`

Entirely additive: the old release ignores columns it doesn't know, `verify:schema` only reports what the
code needs and the DB lacks, so it stays green. **Idempotent and re-runnable** — every step is guarded.

### Phase B — Dual-run (one release)

Code becomes id-type-agnostic. The resolution helper, `apps/api-server/src/lib/id.ts`:

```ts
/** Resolve a route/param id that may be either a new bigint id or a legacy UUID. */
export function idFilter(table: AnyTable, raw: string): SQL {
  return /^\d+$/.test(raw) ? eq(table.id, Number(raw)) : eq(table.legacyId, raw);
}
```

- Writes populate **both** columns.
- Reads accept either form, so bookmarked URLs, cached clients, mobile apps mid-session, notification
  deep-links and anything holding an old id keep resolving.
- `newId()` keeps existing for the transition, then is deleted.

This release is the safety margin. It must be live and quiet before Phase C.

### Phase C — Swap (the only non-additive step)

Inside one transaction per table, in dependency order:

```sql
ALTER TABLE child DROP CONSTRAINT child_parent_id_fkey;
ALTER TABLE t     RENAME COLUMN id TO legacy_id;
ALTER TABLE t     RENAME COLUMN id_bigint TO id;
ALTER TABLE child RENAME COLUMN parent_id        TO parent_legacy_id;
ALTER TABLE child RENAME COLUMN parent_id_bigint TO parent_id;
ALTER TABLE t     DROP CONSTRAINT t_pkey, ADD PRIMARY KEY (id);
ALTER TABLE t     ALTER COLUMN id SET DEFAULT nextval('global_id_seq');
ALTER TABLE child ADD CONSTRAINT child_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES t(id);
```

`legacy_id` stays, indexed, so `idFilter`'s fallback keeps working.

### Phase D — Contract

One release after nothing reads legacy ids: retire `legacy_id` / `*_legacy_id` columns through the existing
`scripts/src/drop-dead-columns.ts` on its normal schedule. Delete `newId()` and `idFilter`.

### Tooling

New `scripts/src/id-migration/`, registered in `scripts/package.json` alongside the existing migration
scripts:

| Command | Does |
|---|---|
| `id:plan` | Reads the schema barrel, topologically sorts the FK graph, emits the ordered step list. Fails loudly on a cycle. |
| `id:expand` | Phase A. Idempotent, resumable, per-table progress table. |
| `id:verify` | Every FK edge: `COUNT(*) WHERE parent_id IS NOT NULL AND parent_id_bigint IS NULL` must be 0. Plus the JSON audit (§4). **Gate for Phase C.** |
| `id:swap` | Phase C, per-table transactions, with `--dry-run` printing the DDL. |
| `id:rollback` | Reverses a swap using the retained `legacy_id` columns. Valid until Phase D. |

`verify-schema.ts` needs a transition mode: between A and C the barrel declares `bigint` while the DB still
has `text` on the live column. Add an `--allow-id-transition` flag that tolerates exactly that one
divergence on columns named `id`/`*_id`, and remove the flag at Phase D.

---

## 4. The part that will bite: ids that FK analysis cannot see

> **Verified against dev data, 2026-09-19.** Everything below was checked with
> `pnpm -C scripts run id:json-audit`, which samples real rows, walks every
> json/jsonb payload, and resolves each id it finds against all 136 text-id
> tables. Rows are marked **VERIFIED-FROM-DATA** (observed in real payloads) or
> **STILL-INFERRED** (the column holds no such data yet — classified from the
> writer code, and named here so nobody mistakes it for an observation).
>
> The section as originally written was right about the *principle* — rewriting
> a historical record is falsification, not migration — and wrong about roughly
> half the inventory. It also looks in one place when there are three. The
> corrections are called out explicitly rather than folded in silently.

FK analysis finds 177 edges. It does not find ids embedded in json, ids in text
columns that carry no constraint, or ids concatenated into composite keys —
and all three break **silently** after the swap: no constraint violation, just a
lookup that stops matching.

The machine-readable form of everything below is
`scripts/src/id-migration/manifest.ts`. `id:migrate` re-derives the surface from
the live catalogue at run time and **refuses to run** if it meets a uuid-bearing
column the manifest does not classify, so this inventory cannot silently go
stale.

### 4.1 Surface one — ids inside `json` / `jsonb`

**Live config — MUST be rewritten:**

| Column | JSON path(s) | Points at | Evidence |
|---|---|---|---|
| `audit_schedules.scope_json` | `$.ids[*]`, **`$.within.{key}`**, `$.within.{*}[*]` | properties, rooms | VERIFIED — 5 ids in 2 rows |
| `audit_schedules.subset_json` | `$.sectionIds[*]`, `$.questionIds[*]` | audit_sections, audit_questions | STILL-INFERRED — NULL in all 7 rows |
| `audits.subset_json` | `$.sectionIds[*]`, `$.questionIds[*]` | audit_sections, audit_questions | STILL-INFERRED — NULL in all 33 rows |
| `audit_schedules.assignee_rule` | `$.userId` | users | STILL-INFERRED — all 7 rows are `{kind:"ROLE_AT_TARGET", role}`, no id |
| `menu_plans.slots` | `$.{*}.{*}` (`{DAY:{MEAL:recipeId}}`) | recipes | VERIFIED — 30 ids in 10 rows |
| `daily_production.dispatches` | `$[*].recipeId` | recipes | VERIFIED — 30 ids in 30 rows |
| `daily_production.wastage` | `$[*].recipeId` | recipes | VERIFIED — 30 ids in 30 rows |
| `daily_production.receivings` | `$[*].recipeId` | recipes | STILL-INFERRED — empty in all 30 rows |
| `food_menu_shares.recipients` | `$[*]` (lenient) | **residents**, not users | STILL-INFERRED — `[]` in both rows |

**Historical record — MUST NOT be rewritten:**

| Column | Ids observed | Evidence |
|---|---|---|
| `audit_events.before_json` / `after_json` | 30 / 38 uuid leaves | VERIFIED — 36 / 85 rows |
| `audit_log.changes` | 10 (`$.after.id`, `$.before.id`, `$.residentId`, `$.reversalOf`) | VERIFIED — 61 rows |
| `communication_logs.recipient_filter` | 1391 (`$.residentId`, `$.ruleId`, `$.ledgerEntryId`) | VERIFIED — 500 of 533 rows sampled |
| `audit_template_versions.rating_scale_snapshot` | 6 at `$.scaleId` | VERIFIED — 17 rows |
| `audit_responses.answer_json` | **none** | VERIFIED — 500 rows sampled, 0 ids |

**Opaque — the migration ABORTS rather than guess:**
`food_order_drafts.payload` and `form_drafts.payload` are documented as opaque to
the server, so no path can be derived; `--drop-drafts` deletes them, which is the
only honest treatment of a transient UI convenience.
`bank_statement_lines.suggestion_payload` and `report_jobs.params` hold no rows
in dev and touch money and report filters respectively.

**Verified to hold no ids (36 columns):** the plan's list
(`properties.amenities`, `residents.dietaryPref`/`allergies`, `complaints.photos`,
`announcements.targetRoles`, `audit_role_grants.auditTypes`,
`message_templates.variables`) is **confirmed**, and 30 further columns join it —
see `JSON_COLUMNS` in the manifest. Four of the six are confirmed from populated
rows; `complaints.photos` and `residents.allergies` are empty in dev and so
remain inferred.

#### Where this contradicts the section above

1. **`message_templates.recipientFilter` does not exist.** The column is
   `communication_logs.recipient_filter`, and it is a **historical record, not
   live config** — each row is one already-sent message, holding the
   `{residentId, ruleId, ledgerEntryId}` that triggered that send. It was in the
   MUST-be-rewritten table; rewriting it would falsify 533 delivery records.
2. **`notification_outbox` payloads contain nothing.** The column is NULL in all
   535 rows and the only writer (`notification-service.ts:68-86`) never sets it —
   it is a dead column, and a candidate for `drop-dead-columns.ts`. The ids the
   entry is reaching for live in the plain `entity_id` column (79 FOOD_ORDER
   uuids, no FK) and in `notifications.link` (`/food/orders/<uuid>`, 217 rows).
   Both are historical; see 4.2 and 4.3.
3. **`scope_json` ids are not only in `ids[]`.** The narrowing map is
   `{within: {"<anchorId>": ["<roomId>", …]}}` — half its ids are **object
   keys**. A rewriter that walks values leaves every anchor key stale and the map
   resolves to nothing. `JsonPathRule.kind: "key"` exists for this.
4. **`rating_scale_snapshot` does contain a real entity id.** Correctly listed as
   a snapshot to preserve, but the reason given ("an explicit snapshot") reads as
   though it holds no ids: `$.scaleId` defaults to the version's own id
   (`audit-templates.ts:579`) and 6 of 17 rows carry one. Nothing looks it up, so
   preserving it is right — but `id:verify` has to whitelist the path explicitly
   or every clean run reports it as a missed rewrite.
5. **`audit_responses.answer_json` holds no ids at all.** Preserving it is still
   correct (it is frozen post-submit), but it is not part of the id surface:
   `$.optionId` is a slug (`audit-opt-poor`).
6. **Five columns were missing entirely:** `menu_plans.slots`,
   `daily_production.dispatches` / `wastage` / `receivings`, and
   `bank_statement_lines.suggestion_payload`.

### 4.2 Surface two — text columns with no FK constraint (NOT IN THE PLAN)

**69 text columns hold entity ids with no foreign key at all — 61 of them real
pointers**, against the 177 constrained edges the plan counts. They are entity
pointers in everything but the catalogue: `residents.room_id`,
`complaints.resident_id`, `payments.property_id`, `employees.property_id`,
`purchase_orders.indent_id`, `properties.cluster_id` and `properties.kitchen_id`
are all in this set. The plan's Phase A step 5 backfills "per FK column", driven
from `.references()`, so every one of these would be left holding a dead id
after the swap.

Four of the 61 hold **no uuid-shaped value at all** — their ids are readable
seeded strings (`cluster_blr_koramangala`, `user_food_ops`) — so a uuid-pattern
sweep reports them clean. They surfaced only once `id:migrate`'s preflight
started testing membership in the live id set rather than testing shape. See
4.4.

Four more are **not** entity ids and must never be rewritten — they only look
like ids because they are also `randomUUID()` output:
`otp_challenges.verification_token` (421 rows, a live secret),
`users.current_session_id` (rewriting it logs out every user),
`food_menu_shares.share_token` (the public `/m/<token>` link), and
`notification_outbox.provider_message_id` (`log-<uuid>`, the provider's id).

Five more are **hash-chain inputs or historical logs** and are preserved:
`audit_events.entity_id` / `audit_id` / `actor_id`, `audit_log.entity_id`,
`notification_outbox.entity_id`.

> **The chain claim in this plan is understated.** `appendAuditEvent` hashes
> `entityId`, `auditId` and `actorId` alongside `beforeJson`/`afterJson`
> (`audit-events.ts:104-117`). Rewriting any of those three breaks `verifyChain()`
> exactly as badly as rewriting the JSON — and none of the three carries an FK,
> so a blanket "convert every `*_id` column" pass hits all of them. The event's
> own `id` is *not* hashed and migrates freely.

### 4.3 Surface three — ids concatenated into idempotency keys (NOT IN THE PLAN)

The quietest failure mode here, and the one with money attached. An id
interpolated into a string that is then used to answer *"have I already done
this?"*. Change the id and the answer flips to no.

| Key | Built as | What leaving it does |
|---|---|---|
| `ledger_entries.reference` | `AUTO:${cycle.id}:${period}` (`finance.ts:121,130,137`) | `finance.ts:170` skips a resident whose ledger already holds that exact string. Post-swap the tag no longer matches and **every resident is re-billed for the current period.** 230 rows. |
| `wallet_transactions.reference_id` | `${wallet.id}:${clientKey}` under `reference_type='IDEMPOTENCY'` (`wallet.ts:114`) | A client retrying a topup or payment across the cutover presents the same key, the scoped key no longer matches, and **the credit is written twice** — the identical failure `migrate-wallet-reference-namespace.ts` exists to prevent. |
| `audits.occurrence_key` | `${schedule.id}:${occurrenceISO}:${targetId}` with `onConflictDoNothing` (`audit-jobs.ts:323,367`) | The materializer **re-creates every occurrence still inside its catch-up window** — duplicate audits, assignments, reminders. 23 rows. |
| `org_nodes.path` | `${parentPath}${node.id}/` (`org-tree.ts:115`) | A materialized ancestry path queried with `LIKE '<ancestorPath>%'`. 55 of 80 rows embed a property uuid. Leave it and **every descendant query resolves to nothing.** |

All four are rewritten by `id:migrate`, segment by segment rather than by uuid
regex — see the note on non-uuid ids below. `notifications.link`,
`audit_events.reason`, `wallet_transactions.description` and
`electricity_tariffs.name` also embed ids and are **preserved**: a delivered
notification and a ledger narration are historical, and `idFilter()` resolves the
legacy uuid in a route param, which is this plan's own argument for retaining
`legacy_id`.

### 4.4 Two corrections that land outside §4

Flagged here rather than edited into the sections they belong to, because they
change a design decision rather than an inventory.

**§1 — a global sequence does not preserve G1 by itself.** §1 says the single
sequence "preserves G1 exactly as `randomUUID()` did". That reads the invariant
backwards. `randomUUID()` never *preserved* anything — the application
deliberately writes the **same string** as `properties.id` and as the
`org_nodes.id` of that property's node. G1 needs two rows in two tables to
**share** an id, which is precisely what a uniqueness guarantee does not give
you. Drawing `nextval()` per table, as §1's `ADD COLUMN … UPDATE … nextval()`
sketch does, hands the property and its org node two different numbers and G1 is
gone — silently, with the ~90 scoping call sites the plan says "change by zero
lines" now resolving against a node that is no longer the entity.

Dev has **82 shared id strings across 164 rows**: `org_nodes` ↔
zones / cities / clusters / properties, plus `agencies` ↔ `delivery_partners`.
The fix is one line of intent: allocate **per distinct id string**, not per row.
`id:migrate` claims a number in the id map first and every row carrying that
string takes it, so the aliasing survives by construction. Verified on the
restored snapshot: 12 664 distinct ids → 12 746 rows, and all five
`org_nodes.id = properties.id` pairs still hold afterwards.

**Not every id is a uuid.** Seeded rows carry readable ids — `user_food_unit2`,
`dish_curd`, `audit-scale-uniliv-standard`, `org-root` — so 59 of the 70
`access_grants.subject_id` values are not uuid-shaped, and neither are several
`org_nodes.path` segments. Every rewrite in `id:migrate` therefore keys off
**membership in the id map**, never uuid shape; shape is used only where there is
no map to consult (discovery, and the verifier's belt-and-braces leftover check).
A shape-driven rewriter walks straight past these and leaves live-config pointers
that resolve to nothing.

### 4.5 Tooling

| Command | Does |
|---|---|
| `id:json-audit` | Regenerates the evidence above from live data. Read-only. Exits non-zero if any column is unclassified. |
| `id:migrate` | Expand + rewrite + swap, in one transaction. Dry-run by default; refuses a protected database name. |
| `id:verify` | Seven assertion passes (§6). Read-only, exits non-zero on failure. |

---

## 5. Application surface

| Area | Change |
|---|---|
| Schema (`lib/db/src/schema/*.ts`) | 137 PKs + 177 FK columns → `bigint`, `mode: "number"` |
| `newId()` (221 sites, 39 files) | Deleted — the DB default supplies the id. Most call sites just drop `id: newId(),`. `withUniqueRetry` **stays**: it serves the human-readable business codes (`ticketNo`, `employeeCode`, `PROP-BLR-001`), which are unaffected. |
| OpenAPI (`lib/api-spec/openapi.yaml`) | id fields `type: string` → `type: integer, format: int64`; then `pnpm --filter @workspace/api-spec run codegen` regenerates `lib/api-zod` + `lib/api-client-react` |
| Web — generated clients (~40 files) | Types change automatically; fix resulting type errors |
| Web — manual clients (79 files) | Hand-declared interfaces in `src/lib/*-api.ts` and `src/pages/audits/lib.ts` need id fields widened. During Phase B use `string \| number`. |
| Route params | `req.params.id` is always a string off the wire — `idFilter()` handles both forms |
| Query keys | TanStack keys embedding ids keep working (values, not types) |

**Access-control plan interaction:** G1 survives intact (§1), so `org_nodes.id` still *is* the entity id and
the ~90 food/audit call sites still change by zero lines. The closure table gets meaningfully cheaper —
`(bigint, bigint, int, enum)` rows instead of two 36-char text columns in a composite PK.

---

## 6. Verification

```bash
pnpm run typecheck
pnpm --filter @workspace/api-server run test
pnpm -C scripts run id:plan          # ordered steps; must report no FK cycles
pnpm -C scripts run id:verify        # gate before swap; 0 orphans, 0 stale JSON ids
```

Rehearse the whole sequence on a **restored copy of e2e data**, not a seed — seeds have clean referential
integrity and will not surface the rows that actually break. Then:

1. Row counts per table identical before and after the swap.
2. Every FK edge: zero orphans.
3. `pnpm -C lib/db run push` twice — second run reports no changes (the drift signal must survive).
4. Spot-check each domain in the UI: a resident detail, a food order, an audit run, a wallet ledger.
5. Hit a **legacy UUID URL** and confirm it still resolves via `legacy_id`.
6. `verifyChain()` on `audit_events` still passes — proof the historical JSON was left alone.

## 7. Sequencing

| Step | Gate to proceed |
|---|---|
| Access-plan Phase 0 (scope the open routes) | **Hard prerequisite** — §2 |
| Build `id-migration/` tooling + JSON inventory | `id:plan` clean on the real FK graph |
| Rehearse A→C on restored e2e data | All of §6 green |
| Phase A expand (deploy) | Additive; old release unaffected |
| Phase B dual-run (deploy) | Live and quiet for one full release |
| Phase C swap (deploy) | `id:verify` green; `id:rollback` tested |
| Phase D contract | One release later |

Honest estimate: this is a multi-week project with a full-repo type change and a live-data migration at the
end of it. The access-control work should fork behind Phase B — building new tables on bigint keys is free,
but rebasing an in-flight resolver across the swap is not.
