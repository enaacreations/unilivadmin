# UNILIV Audit & Inspection — Gap Analysis vs Product Owner Review Pack v1.2

**Scope:** 112 requirements · 18 FA areas · 11 binding decisions (D-1…D-11) · 4 rulings (C-1…C-4) · 457-item seeded question bank
**Target:** branch `dev`. Analysis ran against the then-uncommitted working tree on top of `18d6ed2`; **that tree was committed mid-analysis as `28c3188` "feat(audit): Review Queue hub, dialog-driven flows, and UI redesigns"**. The code analysed is therefore identical to current `HEAD` — but every "uncommitted / reversible with `git checkout`" statement below should be read as **"reversible with `git revert 28c3188` or a targeted `git checkout 18d6ed2 -- <path>`"**. The deletion is now history, not a staging-area decision.
**Method:** every claim carries a `file:line` or an explicit "not found" search. Where the requirement mapping and the adversarial verification disagreed, **the verification wins** and the status below is corrected.

> **Independently re-verified after the commit** (this session, against `28c3188`): `hasCriticalNc: false` hard-code ([audits.ts:1019](artifacts/api-server/src/routes/audits.ts:1019)); `reviewRequired` stripped server-side ([audit-templates.ts:549](artifacts/api-server/src/routes/audit-templates.ts:549)) while the switch still renders ([template-detail.tsx:266](artifacts/uniliv-admin/src/pages/audits/template-detail.tsx:266)); `maybeAutoCloseAudit` closes unconditionally without consulting `auto_close_days` ([audit-service.ts:281-288](artifacts/api-server/src/lib/audit-service.ts:281)); reminder job filters `state = 'SCHEDULED'` only ([audit-jobs.ts:404](artifacts/api-server/src/lib/audit-jobs.ts:404)); no `/audits/register` entry in [nav.ts:126-133](artifacts/uniliv-admin/src/lib/nav.ts:126) despite the comment above it promising "All Audits"; `CITY_HEAD`/`ZONAL_HEAD`/`SENIOR_VICE_PRESIDENT` hold only `AUDIT_DASHBOARD`/`AUDIT_REGISTER`/`AUDIT_REPORTS` view ([permissions.ts:98-120](artifacts/uniliv-admin/src/lib/permissions.ts:98)) → **one reachable nav item**. Seed totals re-computed by executing `SEED_TEMPLATES`: 141/428, 27/134, 288/1313 = 456 items.

---

# 1. Verdict

- **Weighted completeness ≈ 40 %** (BUILT = 1, PARTIAL = 0.5, REMOVED/MISSING = 0, offline deferrals excluded): 43 / 108 scorable requirements. On **Must**-priority alone it is **≈ 45 %** (34.5 / 76). Raw counts: **16 BUILT · 54 PARTIAL · 3 MISSING · 35 REMOVED · 4 DEFERRED**. Only **12 of 76 Must requirements are built end-to-end**.

- **The single biggest risk is not a missing feature — it is that 35 requirements (19 of them Must) were deleted from a working tree that has never been committed.** `git status` shows 7 deleted pages/routers and 46 modified files; `artifacts/api-server/src/routes/audit-ncs.ts`, `nc-board.tsx`, `nc-detail.tsx`, `my-findings.tsx`, `template-preview.tsx`, `trail-explorer.tsx`, `audit-dashboard.tsx` are all `D`. **This is now committed (`28c3188`) — still reversible, but via `git revert 28c3188` or `git checkout 18d6ed2 -- <path>`, not a working-tree discard.** The whole NC/CAPA subsystem (FRD-NCM-01…04, FRD-CAP-01…06 — 10 Must requirements) is gone at the *schema* level, not merely unwired, which means the next `pnpm --filter @workspace/db run push` **silently drops the tables and destroys any existing NC/CAPA rows** (Postgres will keep the orphaned `audit_evidence_kind` values `NC`/`CAPA` forever, but drops `audit_nc_state`/`audit_nc_severity` and all three tables).

- **The deletion directly contradicts binding ruling C-4**, which names NC/CAPA as launch scope alongside template versioning, the question bank and the scheduling engine. Three of four survive; NC/CAPA does not. C-4 as written is now false and must be formally retired or the code restored — leaving it ambiguous is what produces the leftover scaffolding catalogued in §2.

- **The most user-visible defect is a two-line nav deletion.** `git diff -- artifacts/uniliv-admin/src/lib/nav.ts` removed the `All Audits → /audits/register` item while the page, route, `AUDIT_REGISTER` module and *the surrounding comment promising it* (`nav.ts:114-117`) all survive. Consequence: **CITY_HEAD / ZONAL_HEAD / SENIOR_VICE_PRESIDENT see exactly one audit nav item ("Reports")**, and the app's *only* "New Audit" button lives at `register.tsx:125-127`, so **CUSTOMER_EXPERIENCE — the one non-admin persona with `AUDIT_EXECUTION.create` and the sole persona ruling C-3 makes responsible for ad-hoc CX audits — cannot create an audit without hand-typing a URL.**

- **The build is green and that is misleading.** `pnpm run typecheck` exits 0 across all 5 workspace projects (verified); `pnpm --filter @workspace/api-server run test` = 40/40; esbuild and vite both build. But `tsconfig.base.json:11` sets `noUnusedLocals: false`, and the 40 tests cover only two pure kernels (`audit-scoring`, `audit-state` transitions). **There is not one test for `resolveAuditAccess`, `computeSubmitBlockers`, the hash chain, any route, or any DB interaction.**

- **Four silently-broken controls ship to users today.** (a) `auto_close_days` is editable at `audit-admin.tsx:517` but `audit-reviews.ts:209` closes unconditionally on approve, bypassing the job's check at `audit-jobs.ts:463-467`. (b) The "Review required" switch (`template-detail.tsx:266`) POSTs a field `audit-templates.ts:549` strips, then shows a success toast. (c) `criticalFailGate` (`template-detail.tsx:250-258`, *"Any critical NC forces a FAIL result"*) can never fire — `audits.ts:1019` hard-codes `hasCriticalNc: false`. (d) The EMAIL share channel is accepted and stored (`audit-reports.ts:189-206`) with **no mailer call anywhere in the file** — it silently no-ops, which is worse than WhatsApp's honest `422 CHANNEL_NOT_ENABLED`.

- **Pre-occurrence reminders (FRD-NTF-02) can never fire early for scheduler-generated audits.** Verified on disk: the materializer writes future occurrences as `DRAFT` (`audit-jobs.ts:310` `const state = occurrence <= now ? "SCHEDULED" : "DRAFT"`), `flipDueDrafts` promotes only when `scheduledFor <= now` (`audit-jobs.ts:365-367`), and `runAuditReminders` selects **only** `state = 'SCHEDULED'` (`audit-jobs.ts:404`). The audit becomes reminder-eligible at the earliest moment it is already due.

- **The seeded question bank is an excellent reproduction with one systematic weighting defect.** Verified by execution: Property Audit 11 sections / 141 items / raw weight **428**; Unit Lead 1 / 27 / **134**; CX 39 / 288 / **1313**; total **456** items (the source is 457 — the difference is the deliberately dropped UL duplicate). Prompts are byte-identical to source apart from three Unicode-punctuation substitutions. But the Property Audit's 428 vs the document's stated **456** means **14 safety-critical items are under-weighted by 40 %** (w:3 instead of w:5).

---

# 2. The working-tree deletion — what it removed and what it broke

> **CORRECTION — this change was COMMITTED mid-analysis as `28c3188`.** When the agents ran, `git status` showed 7 deletions + 46 modifications + 3 untracked files staged in the working tree; those are now in `HEAD`. The analysis is still accurate about *what* changed, but the recovery move is `git revert 28c3188` (or `git checkout 18d6ed2 -- <path>` for a subset), not a working-tree discard. Every row below is still a decision the team can revisit — it just costs a commit now.
>
> **Build health: GREEN.** `pnpm run typecheck` → `tsc --build`, 5 projects, exit 0 (re-verified in this session). `pnpm --filter @workspace/api-server run test` → 4 files / 40 tests passed. esbuild → `dist/index.mjs` 6.6 MB. `vite build` → 5.50 s. **There are no dangling imports and no dead routes** — `App.tsx`, `nav.ts` and both `permissions.ts` matrices were updated in lockstep.

## 2.1 Deleted capability → requirements → ruling contradiction → dangling references

| Deleted capability | Requirements it satisfied | Ruling / PRD contradiction | Dangling references left behind |
|---|---|---|---|
| **NC / non-conformance entity** — `audit_non_conformances` table, `audit_nc_severity` + `audit_nc_state` pgEnums, `createNonConformance`, `POST /audits/:id/ncs` | FRD-NCM-01, NCM-02, NCM-03, NCM-04, EXE-07, TAU-07, REV-01 (NC list), REV-03, ANL-03 | **C-4** ("keep NC/CAPA in launch scope") — directly contradicted | `audit_evidence_kind` values `NC`/`CAPA` permanently in the pg enum (`schema/audit.ts:95`, documented orphan); `RunEvidence.kind` still enumerates them client-side (`lib.ts:501`); `optionsJson` doc comment still advertises `flagsNc` (`schema/audit.ts:251`) |
| **CAPA subsystem** — `audit_corrective_actions`, `audit_nc_extension_requests`, `audit_evidence.nc_id`/`corrective_action_id` + index | FRD-CAP-01…CAP-06 (6 reqs, 5 Must) | **C-4** | `AUDITEE` module role survives in `auditModuleRoleEnum` (`audit-config.ts:26`), is seeded (`seed-audit.ts:327`) and widens `scopeAuditsCondition`, but its documented purpose (NC ownership) is gone — `audit-access.ts:225` still explains the carve-out "a Unit Lead owns NCs" |
| **NC SLA clock + escalation chain** — `runNcSlaCheck`, `audit_severity_slas` (`escalation_chain_json`), `resolveEscalationAudience` | FRD-CAP-03, NTF-03, ADM-03 | **C-4**; PRD §9.6 "Escalation Reminder" event now has no implementation | `audit_event_kind` value `ESCALATION` has zero writers (`schema/audit.ts:112`); icon still ships at `audit-detail.tsx:37` |
| **Auto-NC rules** — `audit_questions.auto_nc_json`, `audit_question_bank_items.default_auto_nc_json`, `evaluateAutoNc` | FRD-TAU-07, EXE-07, QBK-01 (auto-NC leg) | **C-4** | `criticalFailGate` still stored (`schema/audit.ts:186`), still PATCHable (`audit-templates.ts:549`), still a Switch labelled *"Any critical NC forces a FAIL result"* (`template-detail.tsx:250-258`) — **permanently inert** because `audits.ts:1019` passes `hasCriticalNc: false`, and `audit-scoring.test.ts:134-147` still asserts the dead branch |
| **NC-conditional auto-close** — `NC_TERMINAL_STATES`, per-NC gate in `maybeAutoCloseAudit` | FRD-REV-04 | **C-4**; PRD §7.1 (Approved is meant to be a resting state) | `audit-service.ts:278-302` now closes any APPROVED audit with the fixed reason `"Closed after approval"`; `auto_close_days` becomes unenforceable (see §2.2) |
| **Trail explorer** — `GET /audit/admin/events`, `/facets`, `/verify-chain`, `/export`; `trail-explorer.tsx` (-259) | FRD-TRL-03; degrades TRL-02 to audit-only | NFR-11 (immutable logs) is no longer verifiable through the product | **`verifyChain()` (`audit-events.ts:193-240`) has zero callers** — dead code, and untested; `AUDIT_TRAIL` module removed from both matrices; TEMPLATE/SCHEDULE/GRANT events are still written and readable nowhere |
| **Admin console (9 of 12 tabs)** — severity/SLA, notification rules + test-send, attachment policies, numbering CRUD, feature toggles, master data, bank candidates, rating scales, trail | FRD-ADM-03, 04, 05, 06, 08, 09; degrades ADM-01; EXE-08 (D-4) | **D-4** (bank-candidate queue) not implemented | `getAttachmentPolicy` returns a hard-coded `{maxFiles:5, maxSizeMb:25}` for **every** level (`audit-service.ts:204-214`) — the seeded AUDIT=2 / SUBMISSION=1-file-10 MB caps are gone; `audit_numbering_schemes` + `allocateNumber` still run but are seed-only; `GET/POST/PUT /audit/admin/rating-scales` (`audit-admin.ts:241/261/309`) have **no remaining frontend caller**; orphan types `FeatureToggles`/`WeightMode`/`MasterData`/`LoadPreview` in `lib.ts:839-867` |
| **Reassign / bulk-reassign** — `POST /audits/:id/reassign`, `POST /audits/bulk-reassign` | FRD-ASG-04, ASG-05; degrades ASG-03, TRL-01 | — | `audit_event_kind` value `ASSIGNMENT` has zero writers; `register.tsx:64` still computes `const canBulkReassign = can("AUDIT_SCHEDULES","edit")` for a control that no longer exists; unused `UserCog`/`BellRing`/`Trash2`/`Textarea`/`useMutation`/`toast`/`qc` imports in the same file |
| **Manual nudge** — `POST /audits/:id/nudge` + `manual_nudge_per_hour` rate limit | FRD-NTF-04, REG-04 (reminder action) | — | `audit_event_kind` value `NOTIFY` has zero writers; key absent from `AUDIT_SETTING_DEFAULTS` (`audit-service.ts:307-313`) and the allowlist (`audit-admin.ts:452-458`) |
| **Comments thread** — `GET/POST /audits/:id/comments` | FRD-EXE-10, EXE-01 (Comments tab) | — | **`audit_comments` is a whole live table with zero code references** (`schema/audit.ts:501-514`); its only surviving mention is the seed's `TRUNCATE` list (`seed-audit.ts:145`); `audit_event_kind` value `COMMENT` never written |
| **Ad-hoc items during execution** — `POST /audits/:id/adhoc-questions`, `audit_bank_candidates`, `adhoc_default_weight` | FRD-EXE-08 | **D-4** ("ad-hoc items feed an Admin-reviewed bank-candidate queue") | Read path still live: `audit_questions.audit_id`/`ad_hoc` columns, `loadExecutionQuestions` still unions them (`audit-service.ts:186-193`), `audit-runner.tsx:482` still renders an `ad-hoc` badge nothing can produce |
| **Bulk answer** — `POST /audits/:id/responses/bulk` | FRD-EXE-09 | — | none |
| **Pause / resume / cancel / claim** — `POST /:id/pause`, `/resume`, `/cancel`, `POST /audit/reviews/:id/claim` | FRD-EXE-03 (pause/resume), REG-04 (delete) | PRD §7.1 statuses Paused / Cancelled / Under Review | `audit_state` values `PAUSED`, `UNDER_REVIEW`, `CANCELLED` unreachable; `audits.cancelled_at`/`cancel_reason` are dead columns still rendered at `audit-detail.tsx:382-383`; PAUSED still appears in 3 live filters (`audits.ts:488`, `:846`, `:943`) so a legacy PAUSED row renders read-only with **no way out** |
| **Second-person publish approval** — `POST /versions/:vid/submit-approval`, `/reject-approval`, `publish_co_approval_required` | FRD-TLB-04 | — | `audit_template_versions.submitted_by`/`submitted_at`/`approved_by` never written; `PENDING_APPROVAL` kept alive by a legacy escape (`audit-state.ts:66`) and a stale "In review" badge (`templates.tsx:40`) |
| **Template clone / import / export / sandbox preview** — `POST /:id/clone`, `/import`, `GET /export`, `POST /preview-score` + `template-preview.tsx` (-409) | FRD-TLB-06 (clone), TLB-07, TLB-08 | — | orphan `PreviewScore` type in `lib.ts`; `copyVersionContent` (`audit-templates.ts:153-194`) survives and would back a restored clone |
| **Per-template access scope** — `audit_templates.access_scope_json` | FRD-TLB-09 | — | none (and it was **never enforced even at HEAD** — `git grep -n accessScope HEAD` shows only the schema, the PATCH whitelist and the editor, with no read-path filter) |
| **Publish-time content hash** — `audit_template_versions.content_hash`, `computeContentHash` | FRD-TLB-03 (hash-verifiable AC) | — | Published-version immutability is now **service-enforced only**, with no hash to verify against |
| **Auditor load preview** — `GET /audit/schedules/view/load-preview` | FRD-SCH-07 | — | orphan `LoadPreview` type in `lib.ts:867`; never had a UI at HEAD either |
| **Oversight dashboard** — `audit-dashboard.tsx` (KPI tiles, recharts score trend, property/cluster leagues) | Degrades ANL-01, ANL-02, ANL-04, ANL-07 | — | **`GET /audit/reports/dashboard/summary` computes 7 KPIs + a 12-bucket score trend + volume-by-template that nothing renders.** Its only consumer is the 3-metric rail at `review-queue.tsx:129-150`, itself gated `enabled: !embedded` where `tabs.length === 1` is **never true** for any role holding `AUDIT_REVIEW` view. `apps.tsx:68-71` still comments that oversight roles "fall back to … the Audit Dashboard" |
| **Grant-expiry sweep + weekly digest jobs** — `runGrantExpirySweep`, `runAuditDigests` | Degrades ACC-02, ANL-05 | — | `audit_role_grants.expiry_event_at` has zero writers, doc comment still says *"Stamped by the daily sweep"*; **`runAuditDigests` was the only audit code path that ever sent EMAIL** — every surviving `notify()` call site is in-app only |
| **Auto-approve on submit for review-disabled templates** | FRD-REV-05 (D-2 leg) | **D-2** contradicted | `reviewRequired` hard-coded `true` at `audits.ts:304`, `:728`, `audit-jobs.ts:333`, `audit-templates.ts:642`, stripped from the PATCH whitelist at `audit-templates.ts:548-549` — yet the UI still offers the switch and posts it |
| **Register CSV/XLSX/PDF export** — *(see correction below)* | — | — | — |

## 2.2 Corrections to the requirement mapping (verification wins)

| ID | Mapping said | **Corrected** | Why |
|---|---|---|---|
| **FRD-REG-07** | MISSING | **PARTIAL** | Export exists at `audit-reports.ts:375-397` (`toCsv`/`toXls`/`toPdf` branches on `format=`) with the register's own columns (`audit-summary` key), the same `scopeAuditsCondition` + `auditType`/`propertyId`/`assigneeId`/`from`/`to` filters, and a working UI download (`reports.tsx:247-249`, buttons at `:315-330`). Verified on disk. Genuinely absent: the `q` free-text filter, multi-`state`, and a button in the **Register** toolbar. Wrong placement, not unimplemented. |
| **FRD-TAU-01** | BUILT | **PARTIAL** | The "Edit template" `FormModal` at `template-detail.tsx:611-639` is **dead code** — `setEditOpen` is only ever called with `false` (`:482`); nothing calls `setEditOpen(true)`. Its `meta` state is never seeded from the loaded template. The create modal has no description field (`templates.tsx:51-56`). Description is editable only in the builder on a DRAFT, so changing a published template's description **forks a whole new version** as a side effect (`template-detail.tsx:503-511`). |
| **FRD-TAU-03** | BUILT | **PARTIAL** | All 11 types render and answer, but `DATE` is in `NON_SCORED_TYPES` (`audit-scoring.ts:13`) and **nothing evaluates an expiry date against today** — grep for `expiry|expire` across `audit-scoring.ts`, `audit-service.ts`, `audit-runner.tsx` returns nothing. "date-expiry" is a type name, not a behaviour. |
| **FRD-TLB-01** | BUILT | **PARTIAL** | `audit-templates.ts:243` counts active schedules with `eq(templateVersionId, latest?.id)` — only the **latest** version. Publish v2 and every existing schedule drops out of the count while still generating audits. Also `limit=200` requested (`templates.tsx:60`) vs `getPagination` cap of 100 (`paginate.ts:3`), no paging control. |
| **FRD-TLB-02** | BUILT | **PARTIAL** | `PublishDialog` (`shared.tsx:307-375`) passes `onSave={() => publishMut.mutate()}` with **no empty-note guard**; `FormModal` only disables on `isSaving` — the mandatory note is server-only (422 after a round-trip). And "read-only view of *any* version" is false: `template-detail.tsx:148-166` offers "View" only for `PUBLISHED`; `DEPRECATED`/`ARCHIVED` content is unreachable from the UI. |
| **FRD-TLB-03** | BUILT | **PARTIAL** | `contentHash` deleted, so a published version is no longer tamper-evident. The fork inherits `criticalFailGate` into a permanently inert setting. |
| **FRD-TLB-05** | BUILT | **PARTIAL** | Functionally moot: the materializer **ignores the pinned version** and resolves the template's latest PUBLISHED version at generation time (`audit-jobs.ts:288-299`, `:320`). Migration changes only a bookkeeping column and needlessly deletes future DRAFT occurrences; where-used shows v1 "the schedules, 0 audits" and v2 "0 schedules, all the audits". |
| **FRD-SCH-02** | BUILT | **PARTIAL** | `schedule-form.tsx` (all 8 frequencies) has **no create entry point** — `/audits/schedules/new` is routed at `App.tsx:241` and linked nowhere. The only reachable create flow is `schedule-create-dialog.tsx` (untracked, 239 lines), which offers **4** frequencies, hard-codes `timeOfDay:"09:00"`, a 1-year window and `reminderOffsetMinutes: null`. |
| **FRD-SCH-03** | BUILT | **PARTIAL** | Cited evidence invalid: `schedules.tsx` is **79 lines** (verified `wc -l`) and contains no expansion — the wizard moved to the untracked `schedule-create-dialog.tsx`. Its template list filters `t.lifecycle === "PUBLISHED"` on the **latest** version, so clicking "Edit" on a template (which forks a DRAFT) makes it disappear from the wizard entirely. |
| **FRD-SCH-04** | BUILT | **PARTIAL** | Materialization + idempotency are real, but "Upcoming visibility" is not: `/audits/schedules/calendar` has **no link anywhere**, and `/audits/register` lost its nav entry (§1). |
| **FRD-SCR-01** | BUILT | **PARTIAL** | `audits.ts:1156` hard-codes `if (type === "RATING") return { optionId: "audit-opt-na" }` — the **seed's** option id. Templates created in-app use `DEFAULT_SCALE_SNAPSHOT` whose N/A id is `"na"` (`audit-templates.ts:89`); builder-edited scales use arbitrary ids. For those, `resolveMultiplier` finds no option, returns `{multiplierPct: null, isNa: false}`, and the line drops from **both** sums — silently inverting exactly what the `na_counts_against` admin toggle promises. RATING is the dominant question type. |
| **FRD-EXE-14** | BUILT | **PARTIAL** | GPS is **best-effort**: `use-geolocation.ts:41` resolves `null` on error, the runner sends geo only `if (geo)` (`audit-runner.tsx:806`, `:939`), and both handlers null it out. A denied GPS yields a fully valid start and submit. Coordinates are never corroborated (no `haversine|distance|geofence|radius` anywhere) yet `review-workspace.tsx:406` prints **"GPS matches property"** with a green check on the sole condition that they are non-null. Also `startedAt` is never re-stamped on rework/reopen (`audit-state.ts:127`), inflating `durationSeconds`. |
| **FRD-REV-06** | BUILT | **PARTIAL** | The endpoint and its full AC matrix are correct, but **there is no UI path**: the Reopen control exists only in the review workspace (`review-workspace.tsx:473-477`), reachable only from `review-queue.tsx:110`, whose list is hard-filtered to `eq(state,"SUBMITTED")` (`audit-reviews.ts:50`). `audit-detail.tsx` and `register.tsx` contain no reopen action. A CLOSED audit cannot be reopened without hand-typing the workspace URL. |
| **FRD-NTF-02** | BUILT | **PARTIAL** | Verified on disk this session — see §1 bullet 7. Working pre-occurrence reminders exist **only** for ad-hoc audits created via `/audits/new` with an explicit future `scheduledFor`. |
| **FRD-TRL-02** | BUILT | **PARTIAL** | Only the AUDIT entity has an Activity tab. `audit-detail.tsx:85` is the sole events-endpoint consumer in the frontend. TEMPLATE / TEMPLATE_VERSION / SCHEDULE / PERFORMANCE_BANDS / GRANT events are still written and readable nowhere since `trail-explorer.tsx` was deleted. |

---

# 3. Coverage scorecard

## 3.1 By FA area

| FA area | # reqs | Built | Partial | Missing | Removed | Deferred |
|---|---:|---:|---:|---:|---:|---:|
| ACC — Access & identity | 5 | 0 | 4 | 1 | 0 | 0 |
| QBK — Question bank | 4 | 2 | 2 | 0 | 0 | 0 |
| TAU — Template authoring | 9 | 4 | 4 | 0 | 1 | 0 |
| TLB — Template lifecycle | 9 | 0 | 5 | 0 | 4 | 0 |
| SCH — Scheduling | 7 | 0 | 6 | 0 | 1 | 0 |
| ASG — Assignment | 5 | 1 | 2 | 0 | 2 | 0 |
| REG — Registers & queues | 7 | 1 | 5 | 0 | 1 | 0 |
| EXE — Execution | 14 | 4 | 5 | 1 | 4 | 0 |
| SCR — Scoring | 4 | 1 | 3 | 0 | 0 | 0 |
| NCM — Non-conformance | 4 | 0 | 0 | 0 | **4** | 0 |
| CAP — Corrective actions | 6 | 0 | 0 | 0 | **6** | 0 |
| REV — Review | 6 | 1 | 3 | 0 | 2 | 0 |
| RPT — Reports | 4 | 1 | 3 | 0 | 0 | 0 |
| ANL — Analytics | 7 | 0 | 5 | 1 | 1 | 0 |
| NTF — Notifications | 4 | 0 | 2 | 0 | 2 | 0 |
| ADM — Admin config | 10 | 1 | 3 | 0 | **6** | 0 |
| TRL — Audit trail | 3 | 0 | 2 | 0 | 1 | 0 |
| OFF — Offline | 4 | 0 | 0 | 0 | 0 | **4** |
| **Total** | **112** | **16** | **54** | **3** | **35** | **4** |

## 3.2 Priority rollup

| Priority | # reqs | Built | Partial | Missing | Removed | Deferred | Weighted % |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Must** | 76 | 12 | 45 | 0 | 19 | 0 | **45 %** |
| **Should** | 26 | 3 | 8 | 1 | 14 | 0 | **27 %** |
| **Could** | 6 | 1 | 1 | 2 | 2 | 0 | **25 %** |
| **Won't (offline)** | 4 | 0 | 0 | 0 | 0 | 4 | n/a (D-8) |
| **Overall (scorable)** | 108 | 16 | 54 | 3 | 35 | — | **≈ 40 %** |

*Weighted % = (BUILT + 0.5 × PARTIAL) ÷ scorable. The 4 offline requirements are excluded as a sanctioned D-8 deferral.*

**19 Must requirements were REMOVED in commit `28c3188`**: TAU-07, ASG-04, REG-06, EXE-07, NCM-01…04, CAP-01/02/03/05/06, REV-04, NTF-03, ADM-03/04/05/06. Reverting the relevant paths recovers all 19 at near-zero build cost.

---

# 4. What's built — the spine that works

The happy path from template to report is real, cohesive and mostly well-guarded. Read this as: **template → version → schedule → audit → runner → score → review → report.**

## 4.1 Template → version

| Capability | Evidence |
|---|---|
| Template + empty v1 DRAFT created in one transaction, seeded with `DEFAULT_SCALE_SNAPSHOT` (100/75/50/25/0 + excluded N/A) | `audit-templates.ts:196-314`, snapshot at `:81-93` |
| **Ordered sections** — append-at-max on create, transactional `orderedIds` reorder, all DRAFT-gated | `audit-templates.ts:1035-1049`, `:1083-1107`; UI arrows `template-builder.tsx:754-764` |
| **11 question types** on both sides, all rendered and answerable (incl. pointer-drawn SIGNATURE canvas) | `audit-templates.ts:34-37` ≡ `schema/audit.ts:26-47`; runner `audit-runner.tsx:184-407` |
| **Per-question weight + mandatory, immutable once published (D-6)** | `audit-templates.ts:805-806`, `:1192-1200`; central `assertDraftVersion` 409 at `:51-57` reached from every content mutation via `loadDraftVersionForSection :1013-1022`; publish also rejects scored weight ≤ 0 at `:599-606` |
| **Evidence rule** per question — `NONE`/`OPTIONAL`/`REQUIRED_ON_FAIL`/`ALWAYS_REQUIRED`, enforced at conduct time | enum `schema/audit.ts:48-53`; enforced `audit-service.ts:84-147` |
| **Publish freezes content + rating-scale snapshot**, mandatory changelog note, `assertTransition` DRAFT→PUBLISHED only | `audit-templates.ts:577-663`; transitions `audit-state.ts:61-70` |
| **Fork-next-draft on edit**, copies sections/questions incl. `bankItemId` provenance, refuses a second concurrent draft | `audit-templates.ts:423-480`, `copyVersionContent :153-194` |
| **Archive/restore, no hard delete** anywhere — the only `router.delete` calls are draft sections (`:1071`) and draft questions (`:1219`) | `audit-templates.ts:483-516` ("delete is prohibited once instantiated") |
| **Live max-score model while authoring** — stacked share bar, per-section %, total possible points, pass-line stepper | `template-builder.tsx:824-836`, `:1026-1060` |

## 4.2 Question bank

| Capability | Evidence |
|---|---|
| **Copy-on-insert — bank edits provably cannot reach a published version** | `audit-templates.ts:1123-1144` copies content, keeps `bankItemId` as provenance only; bank PATCH touches only the bank row (`:982-988`); published versions are unmutatable |
| Full CRUD + archive/restore, no hard delete; 11 types, default weight/evidence/options/tags/numeric | `audit-templates.ts:817-828`, `:932-1007`; UI `question-bank.tsx:173-302` |
| Tag filter (jsonb containment), tag vocabulary endpoint, usage counts, archived toggle, `apiFetchAll` (no truncation) | `audit-templates.ts:841`, `:876-887`, `:857-866`; `question-bank.tsx:186` |
| **Near-duplicate detection** — normalize + Jaccard ≥ 0.7, top 5, advisory-only, 500 ms debounce, excludes the item being edited | `audit-templates.ts:894-930`; `shared.tsx:150-193`; wired in both the bank editor and the builder |

## 4.3 Schedule → audit

| Capability | Evidence |
|---|---|
| 8 recurrence types with month-length-safe anchoring and a hand-rolled 5-field cron matcher | `audit-jobs.ts:57-179`; schema `audit-schedules.ts:30-60` + semantic guards `:81-92` |
| **Bulk targeting** — one schedule × many targets → one audit per target per occurrence | `audit-schedules.ts:94-114`, `:230-241`; fan-out `audit-jobs.ts:303-353` |
| **Idempotent materialization** — unique `occurrenceKey = ${scheduleId}:${occurrenceISO}:${targetId}` + `onConflictDoNothing` + `lastMaterializedAt` watermark. Retries and restarts cannot duplicate | `audit-jobs.ts:308`, `:336`, `:356-359`; unique column `schema/audit.ts:334` |
| Ticket numbering allocated in-transaction via `UPDATE…RETURNING` | `audit-service.ts:33-55`; `audit_numbering_schemes` `audit-config.ts:82-91` |
| **Ruling C-3 enforced server-side** — CX templates rejected from scheduling with 422 | `audit-schedules.ts:76-79` |
| Edit/pause/resume/end affecting **future occurrences only**, with CONFIG_CHANGE before/after | `audit-schedules.ts:280-425` |
| Assignee resolved at materialization: explicit USER, `ROLE_AT_TARGET` UNIT_LEAD, or the property's cluster manager | `audit-jobs.ts:190-222` |

## 4.4 Runner → submit → score

| Capability | Evidence |
|---|---|
| Accordion execution grid; only the open section renders (NFR-02); per-section weight chip and answered/total counters | `audit-runner.tsx:1121-1190` |
| **Autosave** — 500 ms debounce per question, rev-stamped save dot with tap-to-retry, `flushPendingSaves()` before the submit sheet and before submit | `audit-runner.tsx:62-84`, `:636-705`, `:919-951` |
| Server-side multiplier resolution at write time against the frozen snapshot; `ON CONFLICT (auditId,questionId) DO UPDATE`; post-submit freeze via `assertAnswerable` | `audits.ts:759-831`, `:751-757` |
| **Live camera capture with GPS watermark** (IST timestamp + lat/lng ± accuracy + auditor name) | `camera-capture.tsx:70-141` |
| **D-9 live geotagged submission photo, gallery blocked** — server requires `isLiveCapture`, numeric geo, `capturedAt` within 15 min, else `422 LIVE_PHOTO_REQUIRED`; client hides the file input entirely for `purpose="submission-proof"` and disables the shutter until GPS locks | `audits.ts:880-892`; `camera-capture.tsx:178-180`, `:296-315` |
| **Submission gate enforced twice** — advisory `GET /:id/submit-check`, authoritative re-run inside submit; blockers are **named, tappable rows** that close the sheet, open the owning section, scroll to the question and ring-flash it for 2.5 s | `audits.ts:957-967`, `:980-986`; `audit-service.ts:84-147`; `audit-runner.tsx:908-934`, `:1281-1302` |
| **Atomic submit** — one transaction freezes every response (weight/multiplier/earned/max), stamps state + timestamps + geo + duration + proof pointer + score/result/band, appends SCORE_FREEZE + STATE_CHANGE, allocates report revision max+1, then notifies reviewers post-commit | `audits.ts:970-1151` |
| **Scoring engine (D-3, no overrides)** — `earnedRaw = (multiplierPct/100) × weight`; stored lines round half-up 2dp; **aggregates sum the unrounded raw**; `pct = Σearned / Σmax × 100`. Pure, no I/O, no recompute path | `audit-scoring.ts:66-133`, `:175-295`; the only writers of `scorePct`/`earnedScore`/`result` are inside the submit transaction |
| **D-1 N/A handling** — excluded from numerator **and** denominator by default; org flag flips to earned 0 / max = weight | `audit-scoring.ts:198-221`; flag `audits.ts:1000`, default `audit-service.ts:308`; **tested both branches** at `audit-scoring.test.ts:92-115` |
| Pass/fail vs version threshold; performance bands matched on the 2dp-rounded pct, contiguity-validated 0→100 in the admin editor | `audit-scoring.ts:273-286`; `audit-admin.ts:380-446` |

## 4.5 Review → report

| Capability | Evidence |
|---|---|
| SUBMITTED-only queue, oldest first, type-filter pills with counts | `audit-reviews.ts:44-80`; `review-queue.tsx:26-166` |
| Read-only workspace: full sections with tone chips derived from `multiplierPct`, notes, signature thumbnails, evidence lightbox, per-section score bars recomputed from frozen lines, submission-proof card, prior verdict history | `audit-reviews.ts:87-172`; `review-workspace.tsx:41-160`, `:286-456` |
| **Reject with mandatory comment** — 422 on empty; single transaction applies SUBMITTED→REJECTED→IN_PROGRESS so answers are preserved and the audit lands back with the auditor; `audit_reviews` row stored; assignee notified with a deep link | `audit-reviews.ts:216-255` |
| **D-11: only SUPER_ADMIN + OPS_EXCELLENCE hold `AUDIT_REVIEW.edit`**; reopen adds an explicit `isSuperAdmin()` check | `permissions.ts:58-68`, `:129-140`; `audit-reviews.ts:265-269`; `authz.ts:108-110` |
| Per-audit **PDF report** via pdf-lib: metadata + performed-by + duration + GPS, score summary with band, last-5 trend, rating distribution, per-section item tables with notes, sign-off block embedding the geotagged live photo, WinAnsi sanitisation, org-timezone rendering | `audit-report-service.ts:217-406` |
| Revisioned reports (UNIQUE `audit_id,revision`), async worker sweeping PENDING/FAILED/stale-RUNNING with attempts < 3 | `schema/audit.ts:517-540`; `audit-report-service.ts:477-495` |
| **Expiring signed share links** — 24-byte base64url token, TTL from `report_share_ttl_hours` clamped 1 h…30 d, SHARE trail event, revoke, pre-auth public router with 404/410 on revoked/expired + access telemetry | `audit-reports.ts:170-247`, `:504-554` |
| **All five named PRD reports**, role-scoped, in json/csv/xls/pdf, with real aggregation (not row dumps) | `audit-reports.ts:249-401`; `export-service.ts:1-30` |

## 4.6 Access & trail (the parts that hold)

| Capability | Evidence |
|---|---|
| **`resolveAuditAccess`** — module role × audit types × org node, fail-closed on malformed rows, effective/expiry dated with an immediate-effect time predicate | `audit-access.ts:55-93` |
| Org-node expansion GLOBAL/ZONE/CITY/CLUSTER/PROPERTY → concrete property sets | `audit-access.ts:96-145` |
| **`scopeAuditsCondition` folded into the WHERE — including COUNT queries** — on register, visible-types, detail, events, run, report registry, report detail, all 5 named reports (incl. every export) and the dashboard | `audits.ts:104-108,138-146,164-165,509-511,556-557,682-683`; `audit-reports.ts:49-50,127-128,267-271,411-413` |
| Conduct gate on ad-hoc create writing a `DENIED_ATTEMPT` event; illegal transitions likewise | `audits.ts:250-263`, `:600-625` |
| **Hash-chained append-only trail** — `sha256(prevHash ‖ canonicalJson(payload))` over 11 fields + `createdAt`, GENESIS seed, appends serialized by `pg_advisory_xact_lock(74441001)` inside the caller's transaction. Verified insert-only: no UPDATE or DELETE against `auditEventsTable` anywhere | `audit-events.ts:24-140` |
| Human-readable per-audit Activity tab with actor + role, action, from→to badges, `'System'` for null actors | `audits.ts:543-577`; `audit-detail.tsx:432-473` |

---

# 5. The full requirement ledger — every non-BUILT requirement

96 rows. Sorted **Must → Should → Could → Deferred**, then by area. This is the build backlog.

## 5.1 MUST (64 rows: 45 partial, 19 removed)

| ID | Prio | Status | What's missing | Effort |
|---|---|---|---|---|
| FRD-ACC-01 | M | PARTIAL | "No local passwords" unmet — bcrypt login (`auth.ts:98,123`) + SMS OTP is the default and only always-available path; Google OAuth is env-gated and 404s when unconfigured (`auth-google.ts:37`). Host-platform change. | L |
| FRD-ACC-02 | M | PARTIAL | Bulk CSV grant import with a row-level validation report — `POST /grants/bulk` existed at `HEAD:audit-admin.ts:222`, deleted; never had a UI. Also the grant-expiry sweep job (leaving `expiry_event_at` writerless). | M |
| FRD-ACC-03 | M | PARTIAL | Denial logging is thin: only 2 `DENIED_ATTEMPT` writers (`audits.ts:259`, `:613`). Module-gate 403s (`authorize.ts:11,38`) and per-row view-scope 403s (`audits.ts:511,557,683`; `audit-reports.ts:128`) write nothing to the trail; no host-level denial log. | S |
| FRD-ACC-05 | M | PARTIAL | Three unscoped surfaces + notifications: review queue/workspace, schedules list + calendar (org-wide, limit 2000), templates/bank routers — no `resolveAuditAccess` in any of the three files. Notification audiences are not grant-resolved (`audits.ts:1129-1136` fans out to *every* OPS_EXCELLENCE user). Note OPS_EXCELLENCE short-circuits all scoping via `isSuperAdmin()` (`authz.ts:108-110`). | M |
| FRD-QBK-01 | M | PARTIAL | `default_auto_nc_json` deleted with the NC subsystem. Meaningful only alongside FRD-TAU-07. | L |
| FRD-TAU-01 | M | PARTIAL | Edit-metadata modal is dead code (`setEditOpen` never called with `true`, `template-detail.tsx:447/482`); create modal has no description field; description editable only on a DRAFT, so editing it forks a version. | S |
| FRD-TAU-03 | M | PARTIAL | `DATE` is capture-only — in `NON_SCORED_TYPES` (`audit-scoring.ts:13`), nothing evaluates expiry vs today. "date-expiry" behaviour not built. | M |
| FRD-TAU-06 | M | PARTIAL | Insert-from-bank picker capped at 100: requests `limit=500` (`template-builder.tsx:297`) but `getPagination` caps at 100 (`paginate.ts:3`), then filters client-side. With a 456-item bank, 356 items are unreachable from the builder. Needs server-side search/pagination in the dialog. | S |
| FRD-TAU-07 | M | **REMOVED** | Auto-NC rule per question — `auto_nc_json`, `default_auto_nc_json`, `evaluateAutoNc`. Nothing can express "this answer raises a finding". Blocked on NCM-01. | L |
| FRD-TAU-09 | M | PARTIAL | Critical-fail gate is permanently inert — `audits.ts:1019` hard-codes `hasCriticalNc: false`. Needs a non-NC critical signal (e.g. per-question zero-tolerance flag) wired into `scoreAudit`. | L |
| FRD-TLB-01 | M | PARTIAL | `activeSchedules` counts only schedules on the **latest** version (`audit-templates.ts:243`) → reports 0 for any re-versioned template; `limit=200` silently truncates to 100 with no paging control. | S |
| FRD-TLB-02 | M | PARTIAL | No client-side changelog guard (server-only 422 after round-trip); `DEPRECATED`/`ARCHIVED` versions have no "View" control (`template-detail.tsx:148-205`). | S |
| FRD-TLB-03 | M | PARTIAL | `contentHash` deleted — a published version is no longer tamper-evident; immutability is service-enforced only. | S |
| FRD-TLB-05 | M | PARTIAL | Migration is cosmetic: the materializer ignores the pinned version (`audit-jobs.ts:288-299`). Where-used is misleading after any re-version. Decide: honour the pin, or drop the migration UI and relabel where-used. | M |
| FRD-TLB-06 | M | PARTIAL | Template **clone** deleted (`HEAD:audit-templates.ts:495`); `copyVersionContent` still exists to back a restore. Add route + "Duplicate" action. | S |
| FRD-SCH-01 | M | PARTIAL | (a) Attachments at creation never existed. (b) Section/question **subset picker** and **assignee chooser** removed from the form — it now always self-assigns (`new-audit.tsx:140-141`), leaving `GET /audits/template-version/:vid` with zero consumers. (c) `/audits/new` has no nav item and its only CTA is the register toolbar → URL-only for CX. | M |
| FRD-SCH-02 | M | PARTIAL | Reachable create flow offers 4 of 8 frequencies, hard-codes time-of-day/window/reminder (`schedule-create-dialog.tsx:15-20,92-95`); `/audits/schedules/new` is linked nowhere. | S |
| FRD-SCH-03 | M | PARTIAL | Expansion is client-side only (no "all properties in cluster X" endpoint). Wizard filters on the **latest** version's lifecycle, so any template with an open DRAFT vanishes from the picker. `audit_schedule_targets_uq` is NULLS DISTINCT → duplicate PROPERTY targets are not actually prevented (`schema/audit.ts:300-318`). | M |
| FRD-SCH-04 | M | PARTIAL | Upcoming visibility unreachable: no nav to `/audits/register`, no link at all to `/audits/schedules/calendar`. Backend is correct. | S |
| FRD-SCH-06 | M | PARTIAL | (1) No pause/resume/end UI at all. (2) **PATCH parses `templateVersionId` but never writes it** — `.set()` at `audit-schedules.ts:318-335` omits it, so re-pointing silently no-ops. (3) `validateScheduleInput` runs **only when `body.targets` is an array** (`:310-313`) — an edit without targets skips the PUBLISHED check, the C-3 CX rejection, `isValidCron` and the intervalDays/windowEnd requirements. | M |
| FRD-ASG-02 | M | PARTIAL | One-off assignee cascade (Me / Role-at-target / Specific user) removed from `/audits/new`; `POST /audits` still accepts `assigneeId` + `assigneeRule`. UI-only rebuild. | S |
| FRD-ASG-03 | M | PARTIAL | **No screen calls `PATCH /audits/:id`** — the rename endpoint is unreachable from the app. Assignee not editable at all. Route also lacks `assertAssignee` and any scope check (any `AUDIT_EXECUTION.edit` holder can rename any pending audit org-wide). | S |
| FRD-ASG-04 | M | **REMOVED** | `POST /audits/:id/reassign` (pre-submission guard, ASSIGNMENT event, dual notification) + the detail-page action. Assignees are fixed at creation/materialization forever. | M |
| FRD-REG-01 | M | PARTIAL | No column chooser (never existed). Server `sort` is supported (`audits.ts:138-140`) but not exposed — `TableHead` cells have no `onClick`. No nav entry to the register. | M |
| FRD-REG-03 | M | PARTIAL | Filters are an inline row, not a drawer. No assignee picker (API supports `q.assigneeId`), no frequency tree, no location/property tree (both need new server predicates). | M |
| FRD-REG-04 | M | PARTIAL | Only "View" survives. Manual reminder (`HEAD:audits.ts:820-873` + rate limit) and Pending-only delete (`HEAD:audits.ts:667-681`) both deleted. `cancelled_at`/`cancel_reason`/`CANCELLED` are dead until cancel returns. | M |
| FRD-REG-05 | M | PARTIAL | (a) No per-row overdue badge — `statusOf()` never emits one (`my-audits.tsx:46-58`). (b) No offline badge (never built, D-8). (c) **Live defect:** `/audits/my` returns only 4 open states (`audits.ts:488`) while `my-audits.tsx:41-42,97,118-120` buckets APPROVED/CLOSED/SUBMITTED — so the progress ring is permanently 0 %, "X of Y done" always 0, and the "Last approved" report banner never appears. | M |
| FRD-REG-06 | M | **REMOVED** | Auditee "My findings" queue grouped by SLA state — page, `audit-ncs.ts`, all 3 NC tables, the route and both `AUDIT_FINDINGS`/`AUDIT_NCS` matrix entries. | L |
| FRD-EXE-01 | M | PARTIAL | Comments tab removed (see EXE-10). No attachments/evidence list on the detail page. The report "tile" is inert text with no link (`audit-detail.tsx:421-427`). | M |
| FRD-EXE-03 | M | PARTIAL | Pause/Resume endpoints + actions deleted. Residual hazard: a legacy PAUSED row appears in `/my` and passes evidence-state checks, but the runner treats only IN_PROGRESS as editable (`audit-runner.tsx:598`) and `notStarted` covers only SCHEDULED/REJECTED (`:1002`) — such an audit renders read-only with no way out. | S |
| FRD-EXE-04 | M | PARTIAL | Per-section **live score chips** removed (`HEAD:audit-runner.tsx:1406,1434-1437,1596-1604`). Row shows weight only, never a score. `resolveMultiplierClient` still exists unused at `lib.ts:558-617`. | S |
| FRD-EXE-06 | M | PARTIAL | (1) The ≤2-per-audit and 1-file/10 MB submission caps are gone — `getAttachmentPolicy` returns a fixed `{maxFiles:5, maxSizeMb:25}` for every level (`audit-service.ts:204-214`). (2) No evidence viewer shows uploaded-by/uploaded-when — `uploadedBy` is stored (`audits.ts:925`) but never joined or returned. | M |
| FRD-EXE-07 | M | **REMOVED** | Auto-NC prompt on a tripping answer (severity/owner pre-filled, evidence enforced). Needs the rule columns, the evaluator, the NC entity and the runner prompt. | L |
| FRD-EXE-14 | M | PARTIAL | GPS is best-effort and never corroborated; `review-workspace.tsx:406` asserts **"GPS matches property"** on non-null coordinates alone. `startedAt` not re-stamped on rework/reopen → inflated "time on site". Not surfaced in any named report or KPI. | M |
| FRD-SCR-01 | M | PARTIAL | `naAnswerFor` hard-codes the seed's `"audit-opt-na"` (`audits.ts:1156`) — for any non-seed template the N/A line falls into the unresolvable branch and is dropped from **both** sums regardless of the `na_counts_against` flag. Also: section scores are never persisted; the reviewer's section % is recomputed from **rounded** stored lines (`audit-reviews.ts:141-152`). | S |
| FRD-SCR-03 | M | PARTIAL | Critical-fail gate can never fire (same root cause as TAU-09). Threshold + bands are solid. | M |
| FRD-NCM-01 | M | **REMOVED** | Raise NC auto/manual with severity, category, description, owner, SLA due date, evidence, numbering. Tables, enums, rule engine, `POST /audits/:id/ncs`, NC evidence upload. | L |
| FRD-NCM-02 | M | **REMOVED** | NC lifecycle Open→InProgress→Resolved→Verified→Closed + Reopened/Waived/Overdue; `NC_TRANSITIONS`, `applyNcTransition`. | M |
| FRD-NCM-03 | M | **REMOVED** | NC kanban board + filterable register + `slaStateOf()` (DUE_SOON/OVERDUE/ON_TRACK/AWAITING_VERIFICATION). `nc-board.tsx` (-648), `nc-detail.tsx` (-670). | L |
| FRD-NCM-04 | M | **REMOVED** | Severity → CAPA due-date stamp from admin SLA config, reviewer-only severity change with re-stamp + CONFIG_CHANGE event. Depends on `audit_severity_slas`. | M |
| FRD-CAP-01 | M | **REMOVED** | 1..n corrective actions per NC (description, evidence, completion date); last action → Resolved. `audit_corrective_actions` + `POST /audit/ncs/:id/actions`. | M |
| FRD-CAP-02 | M | **REMOVED** | Resolution-evidence gate (`resolutionNeedsEvidence`: severity CRITICAL, or question `REQUIRED_ON_FAIL`/`ALWAYS_REQUIRED`) + the `nc_id`/`corrective_action_id` linkage columns it counted. | S |
| FRD-CAP-03 | M | **REMOVED** | SLA clock: due-soon reminders with per-severity lead, breach flagging, ordered escalation chain with `escalationLevelSent` step tracking. Only audit-level overdue survives. | L |
| FRD-CAP-05 | M | **REMOVED** | Verification: verify → Verified/Closed; reject → Reopened with mandatory comment + `reopenCount` bump. | M |
| FRD-CAP-06 | M | **REMOVED** | Waiver with mandatory justification + authority, `waiver_reason`/`waived_by` columns, and the `"WAIVED (risk accepted)"` report rendering. | M |
| FRD-REV-01 | M | PARTIAL | **NC list missing** from both the workspace payload (`HEAD:audit-reviews.ts:127-131,175`) and the UI — a reviewer cannot see findings raised on the audit. Blocked on NCM-01. | S |
| FRD-REV-04 | M | **REMOVED** | Auto-close conditional on every NC being Verified/Closed/Waived; the close reason no longer names the findings that unblocked it. `audit-service.ts:278-302` now closes unconditionally. | S |
| FRD-REV-05 | M | PARTIAL | **D-2 removed**: per-template review toggle has no effect; `reviewRequired` hard-coded true in 4 places. Dead UI: `template-detail.tsx:266-269` still renders the switch, `:95` still posts it, server silently drops it, toast says "saved". | S |
| FRD-REV-06 | M | PARTIAL | Endpoint + AC matrix complete, **but no UI path**: Reopen lives only in the review workspace, reachable only from the SUBMITTED-only queue. Needs a reopen action on audit-detail or the register. | S |
| FRD-RPT-01 | M | PARTIAL | (a) NC & CAPA summary block deleted from the PDF. (b) **Per-item evidence photo thumbnails never existed** — the only embedded image in the whole PDF is the sign-off submission proof (`audit-report-service.ts:393-394`). | M |
| FRD-RPT-02 | M | PARTIAL | (1) EMAIL channel accepted and stored with **no mailer call anywhere in the file** and no UI entry point. (2) WhatsApp deferred (422, D-5). (3) No per-row download in the report registry — rows only navigate to the viewer. | M |
| FRD-ANL-01 | M | PARTIAL | Backend-only. `statusCounts` (all 10 states, zero-filled) computed at `audit-reports.ts:431-435`; **nothing in the shipped app renders it** — `lib.ts:742` is a type declaration only. Needs a donut/table + filter bar against the existing endpoint. | S |
| FRD-NTF-01 | M | PARTIAL | Channels hard-coded per call site (in-app + opportunistic web-push); no rule matrix; **no EMAIL/SMS on any audit event**; no WhatsApp; no "started" notification. NC/SLA/escalation events unimplementable until NCM returns. | M |
| FRD-NTF-02 | M | PARTIAL | Reminder can never fire pre-occurrence for scheduler-generated audits (DRAFT → SCHEDULED only at due time; job selects SCHEDULED only). Wizard also sends `reminderOffsetMinutes: null`, excluded by the `IS NOT NULL` guard. | S |
| FRD-NTF-03 | M | **REMOVED** | Severity-based escalation chains at configured triggers — `resolveEscalationAudience`, `runNcSlaCheck`, `escalation_chain_json`. | L |
| FRD-ADM-01 | M | PARTIAL | Admin "Rating Scales" tab deleted; per-version editor has **no colour input** (`template-builder.tsx:430-470`) although the runner renders option colour (`audit-runner.tsx:254-257`). Colour is settable only by direct API call or seed. | S |
| FRD-ADM-03 | M | **REMOVED** | Severity & SLA editor (due windows, reminder lead, escalation chains, org/template overrides) — table, routes, tab, consuming job. Gated on NCM returning. | L |
| FRD-ADM-04 | M | **REMOVED** | Notification rules matrix (event × channel × audience), message templates, test-send. Rebuild requires re-wiring every `notify()` call site through a rule resolver. | M |
| FRD-ADM-05 | M | **REMOVED** | Attachment policy per level. Enforced but not configurable — swap the constant in `getAttachmentPolicy` for a lookup. | S |
| FRD-ADM-06 | M | **REMOVED** | Numbering-scheme editor. Table + `allocateNumber` untouched; schemes are seed-only. Restore `GET/PUT /audit/admin/numbering` + a tab. | S |
| FRD-ADM-07 | M | PARTIAL | Look-ahead and auto-close delay work. Missing (never existed): auto-close **basis** selector (creation-time vs TAT) and an overdue **offset/grace** — `runAuditOverdueCheck` flags strictly at `dueAt` and `dueAt == occurrence` (`audit-jobs.ts:328,479-511`). | M |
| FRD-ADM-10 | M | PARTIAL | **`PATCH /audit/templates/versions/:vid` writes no event** (`audit-templates.ts:540-570`) — pass threshold, critical-fail gate and the entire rating-scale snapshot are untracked. Same for every bank and builder mutation (`:932-1254`). Pre-existing at HEAD. | S |
| FRD-TRL-01 | M | PARTIAL | Two of five named legs unwritten: **assignment** (no reassign route exists) and **notification-send** (only pre-occurrence reminders emit REMINDER; approve/reject/close/report-ready emit nothing). `ESCALATION` lost its writer with `runNcSlaCheck`. | M |
| FRD-TRL-02 | M | PARTIAL | Only the AUDIT entity has an Activity tab. TEMPLATE_VERSION / SCHEDULE / RATING_SCALE / PERFORMANCE_BANDS / SETTING / GRANT events are written to the same chain and readable nowhere. | S |

## 5.2 SHOULD (23 rows: 8 partial, 1 missing, 14 removed)

| ID | Prio | Status | What's missing | Effort |
|---|---|---|---|---|
| FRD-ACC-04 | S | **MISSING** | Workspace location/org-node scope switcher. Never existed (the global PropertyScope was already removed at HEAD, `layout.tsx:205-208`). No audit page reads the Zustand `propertyId`; the register has no property filter at all. | M |
| FRD-QBK-02 | S | PARTIAL | No full-text search (plain `prompt ILIKE` only — `helpText` and tags not searched, no tsvector). Authorship is stored (`createdBy`) but never joined to a user, displayed or filterable. | S |
| FRD-TAU-08 | S | BUILT* | *(counted BUILT)* Nit: per-section figure is a % share, not absolute points; no server-side max-score endpoint since the preview was deleted. | – |
| FRD-TLB-04 | S | **REMOVED** | Second-person publish approval — `submit-approval`, `reject-approval`, `publish_co_approval_required` setting + toggle, submitter≠publisher check. Orphaned `submitted_by`/`submitted_at`/`approved_by` columns remain. | M |
| FRD-TLB-07 | S | **REMOVED** | JSON import/export deleted; **CSV/XLSX never existed in either direction**. Requirement was only ever partially met. | M |
| FRD-TLB-08 | S | **REMOVED** | Sandbox preview + scoring dry-run — `POST /versions/:vid/preview-score` and `template-preview.tsx` (-409). Can reuse `scoreAudit` unchanged. | M |
| FRD-SCH-05 | S | PARTIAL | No week view (month only, `schedule-calendar.tsx:27-45`) and **no filters at all** — endpoint accepts only `from`/`to`. No access scoping (org-wide, limit 2000). No link to the page from anywhere. | M |
| FRD-ASG-05 | S | **REMOVED** | Bulk reassignment (leaver scenario). With ASG-04 also gone, a leaver's open audits cannot be moved at all. | M |
| FRD-REG-02 | S | BUILT* | *(counted BUILT)* Nit: 2 of 4 `ACTIVE_STATES` (PAUSED, REJECTED) are unreachable, so Active can only contain SCHEDULED/IN_PROGRESS. | S |
| FRD-REG-07 | S | PARTIAL | **Corrected from MISSING.** Export works on the Reports surface (`audit-reports.ts:375-397` + `reports.tsx:247-330`) with the register's columns and the same scope. Missing: the `q` free-text filter, multi-`state`, and a download control **in the Register toolbar**. | S |
| FRD-EXE-08 | S | **REMOVED** | Ad-hoc items during execution + bank-candidate queue (**D-4**). Read path still merges ad-hoc rows and the runner still renders an `ad-hoc` badge nothing can produce. | M |
| FRD-EXE-09 | S | **REMOVED** | Bulk answer (same-type section rows, answer + notes only) + runner selection mode. | M |
| FRD-EXE-10 | S | **REMOVED** | Comment thread with attachments + participant notification. **The `audit_comments` table is still there**, so this is API + UI work only. | M |
| FRD-SCR-04 | S | PARTIAL | Live provisional score during execution removed; helper `resolveMultiplierClient` still present but unused. Re-wire into the runner dock and section headers, or add a server preview endpoint. | S |
| FRD-CAP-04 | S | **REMOVED** | Extension request with justification + reviewer approve/deny + SLA reset on approve. Table + both endpoints. | M |
| FRD-REV-03 | S | **REMOVED** | Reviewer-raised missed findings (`POST /audit/reviews/:id/findings`). Depends on `createNonConformance`. | M |
| FRD-RPT-03 | S | PARTIAL | "Report generated on" exists in the report registry, the viewer and the PDF footer — but **not on the audit register**. `GET /api/audits` never joins `audit_reports`. Needs a join + column. | S |
| FRD-ANL-02 | S | PARTIAL | No zone/city/cluster aggregation at all (`rg zoneId|cityId|clusterId audit-reports.ts` → no hits); no per-template score-over-time; no true TAT metric (submit→approve / approve→close) — only on-site `durationSeconds`. The monthly `scoreTrend` is computed but has no renderer since the recharts chart was deleted. | M |
| FRD-ANL-03 | S | **REMOVED** | NC analytics — `bySeverity`, `capaClosureRate`, `topFailingQuestions`, SLA breaches. Blocked on the whole NC subsystem. | L |
| FRD-ANL-05 | S | PARTIAL | Exports built. **Weekly scheduled email digest job deleted** (`HEAD:audit-jobs.ts:777-836`) — it was the only audit path that ever sent EMAIL. Restore `runAuditDigests` (minus NC counts) + re-register in `index.ts`. | S |
| FRD-ANL-07 | S | PARTIAL | KPIs computed but **invisible**: the 3-metric rail is unreachable for every persona that can open `/audits/review` (`enabled: !embedded` where `tabs.length === 1` is never true); 4 of 7 KPIs have no renderer anywhere. Failed-audit alerts never built. | S |
| FRD-NTF-04 | S | **REMOVED** | Manual nudge — route, `manual_nudge_per_hour` setting, NOTIFY trail event, UI trigger. Small rebuild. | S |
| FRD-ADM-02 | S | BUILT* | *(counted BUILT)* Contiguity-validated, evented, consumed at submit. No gap. | – |
| FRD-ADM-08 | S | **REMOVED** | Feature toggles (weightage display, % vs numeric, verify-stage default, reopen, zero-tolerance, create-form fields). Orphan `FeatureToggles`/`WeightMode` types remain in `lib.ts:839-848`. | M |
| FRD-ADM-09 | S | **REMOVED** | Read-only master-data browser with per-node audit volume + sync status. Only the flat id/name org-node picker survives. Quick-create passthrough never existed. | S |
| FRD-TRL-03 | S | **REMOVED** | Trail explorer — event list, facets, chain-verify, CSV export + `trail-explorer.tsx`. **`verifyChain()` is now dead code with zero callers.** | M |

## 5.3 COULD (4 rows: 1 partial, 2 missing, 2 removed — QBK-04 is BUILT)

| ID | Prio | Status | What's missing | Effort |
|---|---|---|---|---|
| FRD-TLB-09 | C | **REMOVED** | Per-template access scoping — column, editor and (crucially) a **read-path filter that never existed even at HEAD**. Needs all three. | L |
| FRD-SCH-07 | C | **REMOVED** | Auditor load preview. Rebuild the projection endpoint **and** give it a UI — it never had one. | M |
| FRD-EXE-02 | C | **MISSING** | Target 360 context panel. Never existed. Needs a cross-module aggregation endpoint (complaints/laundry/food/maintenance per property or room) + a side panel. | L |
| FRD-ANL-04 | C | PARTIAL | Backend built (`volumeByTemplate`, `audit-reports.ts:466-480`); **no renderer ever existed**. Pure rendering task. | S |
| FRD-ANL-06 | C | **MISSING** | Favourite widgets / per-user layout / self-serve pivot. Needs a preferences store + a generic pivot surface. | L |

## 5.4 DEFERRED (4 rows — sanctioned under D-8)

| ID | Prio | Status | Note | Effort |
|---|---|---|---|---|
| FRD-OFF-01 | W | DEFERRED_OK | No service worker fetch/cache logic, no IndexedDB (`public/sw.js` is push-only). Correctly deferred. | L |
| FRD-OFF-02 | W | DEFERRED_OK | No version/vector column on `audit_responses`; PUT is a blind `ON CONFLICT DO UPDATE`. | L |
| FRD-OFF-03 | W | DEFERRED_OK | Submit is a single online transaction with no idempotency key and no queue. | L |
| FRD-OFF-04 | W | DEFERRED_OK | No storage-pressure or availability badges. Depends entirely on OFF-01. | M |

---

# 6. Binding decisions & rulings

| ID | Ruling | Implemented? | Evidence / gap |
|---|---|---|---|
| **D-1** | N/A excluded from numerator + denominator by default; org flag flips to count-against | ✅ **YES** (with a caveat) | `audit-scoring.ts:198-222` implements both branches; flag read `audits.ts:1000`; default `false` in `AUDIT_SETTING_DEFAULTS`; admin-editable `audit-admin.tsx:515`; **tested both branches** `audit-scoring.test.ts:92-115`. ⚠️ Caveat (FRD-SCR-01): `naAnswerFor` hard-codes `"audit-opt-na"` (`audits.ts:1156`), so on any non-seed rating scale the flag is a silent no-op for RATING. |
| **D-2** | Per-template review toggle; non-review templates complete on submit | ❌ **NO — deliberately reversed, dead UI left behind** | `reviewRequired: true // PRD §8.5` hard-coded at `audits.ts:304`, `:728`, `audit-jobs.ts:333`, `audit-templates.ts:642`; struck from the PATCH whitelist `audit-templates.ts:548-549`. HEAD branched on it (`HEAD:audits.ts:1541`). **But** `template-detail.tsx:260-269` still renders the switch and `:95` still posts it → silent discard + success toast. Also unreachable copy at `audit-detail.tsx:411`, `audit-runner.tsx:1254`. |
| **D-3** | No manual score override, ever | ✅ **YES** | Score computed exactly once inside the submit transaction (`audits.ts:1030-1084`), frozen via a SCORE_FREEZE event whose reason literally reads *"(D-3: no overrides)"* (`:1100`). Verified by searching every writer of `scorePct`/`earnedScore`/`result` — all inside that transaction. No score field on any response-write endpoint. |
| **D-4** | Ad-hoc field items feed an Admin-reviewed bank-candidate queue | ❌ **NO — existed at HEAD, deleted** | `audit_bank_candidates` dropped; `POST /audits/:id/adhoc-questions` deleted (`HEAD:audits.ts:1146`); `adhoc_default_weight` removed; admin accept/reject tab gone. Vestige: `ad_hoc` column + read path + runner badge survive. |
| **D-5** | Expiring signed link **+ email + WhatsApp** | ⚠️ **PARTIAL** | Link ✅ complete (`audit-reports.ts:170-247`: token, TTL, SHARE event, revoke, public consumer `:504-554`). WhatsApp ⛔ documented deferral — honest `422 CHANNEL_NOT_ENABLED` (`:184-188`). **EMAIL ⛔ silently broken** — `:189` accepts the channel and `:204` stores the recipient, but the file has **no mailer and no `notify()` call at all**; the recipient is never contacted, and the UI only ever posts `channel:"LINK"` (`report-viewer.tsx:60`). |
| **D-6** | Weights locked at publish | ✅ **YES** | `assertDraftVersion` (`audit-templates.ts:51-57`, 409 *"Published versions are immutable — edits fork the next draft"*) gates version PATCH (`:547`), question create/patch/delete (`:1020,1033,1092`), sections + reorder (`:1013-1033,1091`). No weight field on any execution endpoint (bulk-answer, which D-6 called out, is gone). |
| **D-7** | One template version per audit | ✅ **YES** | Single scalar FK `audits.templateVersionId` (`schema/audit.ts:329-331`); `buildScaleSnapshot` enforces the same spirit — 422 *"A version may reference only one rating scale"* (`audit-templates.ts:110-112`). |
| **D-8** | Offline deferred to a later phase | ✅ **YES (as a deferral)** | Zero offline/service-worker/IndexedDB code in `pages/audits` or `api-server`; `public/sw.js` is push-only. FRD-OFF-01…04 correctly marked DEFERRED. |
| **D-9** | Live geotagged submission photo mandatory (no gallery) | ✅ **YES** | Upload: `audits.ts:881-893` requires `isLiveCapture===true`, numeric geo, `capturedAt` within 15 min → 422. Gate: `audit-service.ts:122-137` requires a SUBMISSION_PROOF row created after `startedAt`. Submit: re-queried at `audits.ts:1031-1044`, stamped to `submissionEvidenceId`. Client: no upload fallback for `purpose="submission-proof"`, shutter disabled until GPS locks (`camera-capture.tsx:178-180,296-315`). ⚠️ Client-attested by design — no server-side provenance check. |
| **D-10** | Audit-type scoping first-class + 7-role deployment model incl. oversight viewers | ✅ **YES** | `audit-access.ts` end-to-end: `canConduct :171`, `canView :183`, `conductableAuditTypes :193`, `visibleAuditTypes :221`, `scopeAuditsCondition :239`. Grants = moduleRole × auditTypes × org node × validity (`audit-config.ts:100-125`), expanded Zone→City→Cluster→Property (`:96-136`). All 7 PRD roles exist and are identical in both matrices (`api-server/permissions.ts:95-176` ≡ `uniliv-admin/permissions.ts:77-149`). There is no 8th "Oversight Viewer" role — oversight is modelled as a VIEWER grant. |
| **D-11** | Operations Excellence is the sole review/approve/reopen authority | ✅ **YES** | Every review route gated `authorize("AUDIT_REVIEW", …)`: queue/workspace view (`audit-reviews.ts:47,90`), approve/reject edit (`:178,218`), reopen edit **plus** `isSuperAdmin()` (`:265-267`). Only SUPER_ADMIN + OPS_EXCELLENCE hold `AUDIT_REVIEW.edit`; `AUDIT_READONLY` is VIEW-only. |
| **C-1** | CM conducts **CM + UL**; views CX read-only | ✅ **YES** (grant-driven) | `seed-audit.ts:336-337`: `grant(AUDITOR,["CM","UL"],CLUSTER) // C-1` + `grant(VIEWER,["CX"]) // C-1 read-only CX`. Enforced by `canConduct` (AUDITOR/ADMIN only) vs `canView` (any role). |
| **C-2** | No CX visibility for City Head / Zonal Head / SVP | ✅ **YES** | `seed-audit.ts:352,359,363` — all three seed `VIEWER ["UL","CM"] // C-2 no CX`. Enforced by `scopeCovers`' type check (`audit-access.ts:165`). ⚠️ Theoretical hole: `scopeAuditsCondition` always ORs own-assignment (`:242`) — unreachable in practice since these roles lack `AUDIT_EXECUTION`. |
| **C-3** | CX ad-hoc only, never scheduler-generated | ⚠️ **PARTIAL — enforced but not usable** | Backend ✅: `audit-schedules.ts:77-78` throws 422 *"CX audits are ad-hoc only and cannot be scheduled (ruling C-3)"*; `POST /audits` is documented as the sole CX path (`audits.ts:170-171`); wizard filters CX out. Frontend ⛔: the only "New Audit" button is `register.tsx:125-127`, and **CUSTOMER_EXPERIENCE has no nav link to the register** — so the persona the ruling exists for cannot exercise it. |
| **C-4** | Keep in launch scope: **NC/CAPA**, template versioning + question bank, scheduling engine | ⚠️ **PARTIAL — 3 of 4; NC/CAPA deleted** | Versioning ✅ (`audit_template_versions` + `assertDraftVersion` + per-version snapshot); question bank ✅ (`audit_question_bank_items` + `bankRouter` + `question-bank.tsx`); scheduling ✅ (`audit_schedules` + `runAuditMaterializer` + wizard). **NC/CAPA ❌** — `audit-ncs.ts` (797 lines), `nc-board.tsx` (648), `nc-detail.tsx` (670), `my-findings.tsx` (175) deleted; `NC_TRANSITIONS` removed from `audit-state.ts`; 4 tables + 2 enums dropped; `runNcSlaCheck` unwired. **C-4 as written is now false — either restore the code or formally retire the ruling.** Leaving it ambiguous is what keeps producing dead scaffolding (§2.1). |

### PRD §7.1 status mapping — does **not** map 1:1

PRD §10 lists six statuses. The enum has ten (`schema/audit.ts:69-80`); the live map is `audit-state.ts:43-54`.

| PRD status | Impl. | Reachable as a **resting** state? |
|---|---|---|
| Draft | `DRAFT` | ⚠️ Yes but semantically different — set **only** by the materializer for future occurrences (`audit-jobs.ts:310`), auto-flipped by `flipDueDrafts`. The UI calls it "Upcoming". The PRD's "Draft" (partially-answered checklist) is this system's `IN_PROGRESS`. |
| In Progress | `IN_PROGRESS` | ✅ Yes |
| Submitted | `SUBMITTED` | ✅ Yes (`audits.ts:1029` hard-codes it) |
| **Approved** | `APPROVED` | ❌ **Transient** — `audit-reviews.ts:209` calls `maybeAutoCloseAudit` in the same request; `audit-service.ts:281-288` closes unconditionally. Approved exists for microseconds. |
| **Rejected** | `REJECTED` | ❌ **Transient** — both hops applied inside one `db.transaction` (`audit-reviews.ts:226-231`). No row is ever committed in REJECTED. Yet the UI ships a red "Rejected" badge (`lib.ts:334,358`) and lists it in `ACTIVE_AUDIT_STATES`/`RUNNABLE_STATES` (`:348,365`) — filters that can never match. |
| Closed | `CLOSED` | ✅ Yes |
| — | **`SCHEDULED`** | ⚠️ **Undocumented 7th status**, and the primary resting state for assigned-but-not-started work. |
| — | `PAUSED`, `UNDER_REVIEW`, `CANCELLED` | ❌ Unreachable — no writer for any of them. |

🔴 **Consequence:** `auto_close_days` is an exposed admin setting (`audit-admin.tsx:517`, *"Days after approval before the audit auto-closes. 0 = immediate"*) that **cannot take effect** — the job honours it (`audit-jobs.ts:454-470`) but the approve handler closes first.

---

# 7. Question bank verification

## 7.1 Headline verdict

**The seeded bank is a faithful, near-verbatim reproduction of the source document at the level of content, and a systematically wrong reproduction at the level of weighting.**

Verified by executing `SEED_TEMPLATES` in this session:

| Template | Sections | Items (seed) | Items (doc) | Raw Σweight (seed) | Doc stated total |
|---|---:|---:|---:|---:|---:|
| Property Audit | 11 | **141** | 141 ✅ | **428** | **456** ❌ |
| Unit Lead Room check list | 1 | **27** | 28 (⚠️ intentional) | **134** | 139 (incl. duplicate) |
| CX Audit | 39 | **288** | 288 ✅ | **1313** | *(no per-section totals given)* |
| **TOTAL** | **51** | **456** | **457** | | |

The seed hard-asserts this: `scripts/src/seed-audit.ts:246` — `if (bankCount !== 456) throw new Error(...)`. **The 457 → 456 delta is entirely the deliberately dropped UL duplicate.**

Textual fidelity is excellent: a line-by-line diff of all 141 Property Audit prompts produced **three** differences, all cosmetic (an en dash for a hyphen in Terrace #4; a Unicode ellipsis in two prompts). An automated string-equality diff of all 210 CX §1-20 prompts found **zero** differences — byte-identical including em dashes, area prefixes and "(mark NA if …)" parentheticals. CX §21-39 matched apart from three Unicode-punctuation substitutions.

**Provenance note:** `scripts/src/data/audit-question-bank.ts` is **NOT** in `git status` — it is byte-identical to HEAD (`db38cd7`). Only `scripts/src/seed-audit.ts` was trimmed (−181 lines: severity SLAs, notification rules, attachment policies, NC seeding). The bank-loading path (456 items → 3 published v1 templates with copy-on-insert provenance) is intact.

## 7.2 Section-count reconciliation

**All 51 section counts match the source exactly, in order, with the source's titles.** The only item-count mismatch is the sanctioned UL duplicate drop.

| Template | Result |
|---|---|
| Property Audit (11 sections) | ✅ **All match** — Entrance-Reception 25 · Common Washroom 6 · Common Area 13 · Staircase 2 · Corridors 14 · CCTV 2 · Dining 35 · Kitchen 16 · Room 18 · Elevator 3 · Terrace 7 |
| CX Audit §1-20 | ✅ **All match** — 3/12/26/14/35/22/15/5/7/6/9/9/4/3/7/6/8/9/4/6 = 210 |
| CX Audit §21-39 | ✅ **All match** — 3/3/5/3/4/4/7/4/5/4/4/3/3/4/6/5/4/6/1 = 78 |
| Unit Lead Room check list | ⚠️ **doc = 28, seed = 27** — the duplicate mattress item, dropped intentionally (see §7.4) |

## 7.3 Discrepancy list by severity

### HIGH — weighting (7 findings, all in Property Audit)

Every shortfall is **even** and they sum to exactly **28**, which is precisely what you get if **14 unmarked items carry w:5 in the source form** and were flattened to the documented default of w:3 (+2 each). Five sections reconcile to the penny (Common Washroom 18, Staircase 6, CCTV 10, Kitchen 48, Room 54), which **proves the seed's default-weight-3 assumption is correct** and isolates the defect to those 14 specific items.

| Section | File | Seed Σw | Doc | Shortfall | Implied w:5 items | Likely candidates |
|---|---|---:|---:|---:|---:|---|
| Entrance-Reception | `audit-question-bank.ts:107-133` | 79 | 85 | 6 | 3 | safety-critical (undeterminable from the excerpt) |
| Common Area | `:142-156` | 36 | 42 | 6 | 3 | *(note: 13×3 = 39 ≠ 42 under any uniform default — confirms 3 items are w:5)* |
| Corridors | `:161-176` | 42 | 48 | 6 | 3 | #14 "fire extinguishers present and not expired" + 2 |
| Dining Area | `:181-217` | 105 | 111 | 6 | 3 | fire-extinguisher / food-temperature / pest items |
| Elevator | `:256-260` | 9 | 11 | 2 | 1 | #3 "emergency instructions and valid lift safety certificate" |
| Terrace | `:261-269` | 21 | 23 | 2 | 1 | #5 or #6 (overhead water tank) |
| **Property Audit TOTAL** | | **428** | **456** | **28** | **14** | |

**Impact:** because scoring is ratio-based (`audit-scoring.ts:273`), a 100 %-correct audit still scores 428/428 and percentages are unaffected. But **safety-critical items are under-weighted by 40 % relative to the source**, so per-item and per-section weighting is skewed and scores are **not comparable across the migration**.

**What to change:** obtain the raw source form and identify which 14 items carry w:5, then set them explicitly in `audit-question-bank.ts`. Until then, PO sign-off is required to ship with a 428-point Property Audit.

### MEDIUM — typing and structure (7 findings)

| # | Where | Finding | What to change |
|---|---|---|---|
| M-1 | All 7 NUMERIC items | `scripts/src/seed-audit.ts:133-134` hard-nulls `numericMin`/`numericMax`. `audit-scoring.ts:117-128` returns **`multiplierPct: 100` unconditionally** when both are null → **35 raw weight points of guaranteed credit** across the bank (30 in CX §1-20, 5 in Electricals). | Seed real ranges (see §8) or set weight 0. |
| M-2 | CX §19 #3 `How long have you been staying here? (months)` | Unmarked doc item (implies scored rating at w:5) retyped to NUMERIC with null range → 5 free points. | Weight 0 (pure demographic capture). |
| M-3 | CX §19 #4 `Room Type (Single, Double, Triple)` | Typed `TEXT`, which is in `NON_SCORED_TYPES` → contributes 0. Combined with M-2, **§19's engine-scored max is 5 instead of the doc-implied 10**, and the enumerated option set is lost. | `SINGLE_CHOICE` + `ROOM_TYPE` options, weight 0. |
| M-4 | CX §24, §30, §36 (5 items) | Every "rate 1 to 5" prompt is `RATING`, and `seed-audit.ts` binds **all** RATING questions to the single seeded scale (Excellent 100 / Good 94 / Average 79 / Poor 0). The resident is never offered 1-5; the doc's anchors (1=Very Poor … 5=Excellent) are **unrepresentable**. Interview scores are not comparable with the legacy system. | `SINGLE_CHOICE` + `LIKERT_1_5` (see §8). |
| M-5 | CX §29 Wrap-Up, §34, §36, §37 | Doc weights on `[i]` rows are **dead** — `NON_SCORED_TYPES` drops TEXT/SIGNATURE/DATE. Real maxima: Wrap-Up **5** (not 20), Open Feedback **3** (not 6), FOOD & DINING **16** (not 20), Room Info **0** (not 20). | Set weight 0 on non-scored rows (as already done for INSTRUCTION). |
| M-6 | UL Balcony items 26-28 | The doc gives **no weight and no section total** for these three; the seed **invents 4** (`audit-question-bank.ts:309-312`). Every other maintenance item is 5/6/7; housekeeping items are 4. If the source used 5, the section max is understated by 3 (134 vs 137). | **PO confirmation required** — the only value in either template with no derivable basis. |
| M-7 | UL structural grouping | The prefixes `Maintenance Checklist – Room:` / `– Washroom:` / `Balcony – Additional Checks:` are moved into `SeedQuestion.tags`, but **`audit_questions` has no `tags` column** (`schema/audit.ts:232-268`) and `seed-audit.ts:120-138` does not copy tags or helpText. The seed also emits **one flat section**. Auditors see bare fragments ("Main door functioning properly", "All lights functioning") with the grouping entirely absent. | Emit 3 sub-sections, or carry the prefix into `helpText`. |
| M-8 | CX §21/§27/§37/§38 | Per-room sheets flattened into the single PROPERTY-target CX template, while §1 still instructs *"Audit at least 1 room per floor using the Room Audit sheet (Sheet 2)"* — a sheet that does not exist. `audits` carries one target and one response per question, so **only one room's answers can ever be recorded**. | Product decision: sub-audits, or drop the sampling instruction. |
| M-9 | CX §39 | **SOURCE DOC IS TRUNCATED**: *"SAFETY RED FLAG — Did resident report fe"*. The seed completes it as *"…feeling unsafe?"* (RATING, w:1) — plausible but **unverifiable**. The section heading also does not describe its single question (reproduced from source). | Obtain the raw form. |

### LOW — fidelity nits and inherited source defects (11 findings)

| # | Where | Finding |
|---|---|---|
| L-1 | PA Terrace #4 | En dash for the doc's ASCII hyphen (`audit-question-bank.ts:265`). Punctuation only. |
| L-2 | CX §24 #1, §34 #1/#2, §35 #1 | Unicode `…` / `–` where the doc has `...` / `-`. Will break exact-string reconciliation against a source export. |
| L-3 | PA Kitchen #7 (`:225`), PA Common Area #13 (`:155`) | Truncation reproduced **verbatim** from the source. Faithful, but the seeded questions are unanswerable as written and will ship to auditors that way. |
| L-4 | PA Common Area #13 | The item promises an *"embedded link"* that does not exist (no link, no `help_text`), and the 5 resident interactions it asks for are **never recorded anywhere** in the Property Audit template. A dangling pointer. |
| L-5 | CX §1 Rooms #1 | Only weight mismatch in all 210 §1-20 items: seed w:0 vs doc w:4. **No scoring impact** (INSTRUCTION is non-scored and `scoreAudit:180` also skips weight ≤ 0) — but the wrong `defaultWeight` would be inherited if an admin re-typed the bank item. |
| L-6 | UL #16 `Does room have seepage issue` (w:7) | Negative polarity left untouched while #28 was normalized. On the 5-level scale a room **with** seepage must be graded "Poor" to score 0 — backwards against the prompt. It is the **highest-weighted item in the template**. Faithful to the doc (which flagged only #28); raising as a data-quality follow-up. |
| L-7 | Whole bank | 17 exact-duplicate prompts within Property Audit alone get 17 separate bank rows (deliberate, `seed-audit.ts:155-158`, mirrors the reference Item master). Consequence: the bank browser is noisy and **QBK-04 near-duplicate detection will light up on seed data**. |
| L-8 | PA + UL | The file header claims *"★ mandatory marker converted to a structured mandatory flag"* (`:11`), but **no PA or UL item carries `mandatory:true`** — the only mandatory item in the whole 456-item bank is CX §19 "Room Number" (`:567`). Consistent with the excerpt; unverifiable without the raw form. |
| L-9 | CX §29 Wrap-Up #2/#3/#4 | Sign-off rows (critical-issues flag, auditor signature, Unit Lead acknowledgement) are **not mandatory**, so a CX audit can be submitted with no signature and no acknowledgement. Literally faithful (no ★ in the doc), but a real operational gap. |
| L-10 | CX §37 vs §19; §23 vs Reception/§28 | Source duplication reproduced without reconciliation: §37 re-asks Room Number / Resident name / Room type already captured in §19, **with an inconsistent `mandatory` flag between the two copies**. CCTV items are verbatim duplicates of the Property Audit CCTV section. Auditors answer the same fact 2-3× per audit and it is scored 2-3×. |
| L-11 | CX §33 #3, §39 #1, §34 #1/#4 | Risk-inverted weights faithfully copied: the actual infestation check ("No active signs of cockroaches…") is **w:1** while the paperwork item is w:5; SAFETY RED FLAG is w:1. Verified value-for-value against the doc — **not a reproduction defect**, but a source-data error the migration silently inherits. |
| L-12 | CX §2 #7, §14 #3, §19/§20 audience, §24/§39 audience | Unsourced inference: Approach #7 is the only Approach item with no weight marker (seed applies the CX default 5, not 2 like its neighbours); TDS unit `ppm` added; `audience: "resident-interview"` added to §19/§20/§24/§39 where the doc marks only five sections. All defensible, all additions rather than reproductions. |

## 7.4 The two explicit questions

**Q: Is dropping the UL duplicate (28 → 27) the right call?**

**Yes — but it must be a signed-off deviation, not a silent one.** The source document *itself* annotates item #9 (*"Mattress is firm and in good condition"*, w:5) as **"DUPLICATE in the live template — data-quality finding"**, and the drop is documented in three places (`audit-question-bank.ts:17` header, the template description, and the FRD data-quality note). Keeping a duplicate would double-count one physical check and inflate both the numerator and the denominator.

The consequence must be recorded: **the section max moves from 139 to 134** (verified: seed raw Σweight = 134). Any score comparison against the legacy system for the Unit Lead template is therefore **not like-for-like** — a room scoring 120/139 (86.3 %) in the old system scores 120/134 (89.6 %) here if the duplicate answer matched, or 115/134 (85.8 %) if it did not. Publish this delta with the migration.

**Q: Does the seed's max-score arithmetic match the doc's stated section point totals?**

**Partially — 5 of 11 Property Audit sections reconcile exactly; 6 do not, and the total is 28 points short (428 vs 456).**

| Section | Doc | Seed | ✓/✗ |
|---|---:|---:|:--:|
| Entrance-Reception | 85 | 79 | ✗ −6 |
| Common Washroom | 18 | 18 | ✅ |
| Common Area | 42 | 36 | ✗ −6 |
| Staircase | 6 | 6 | ✅ |
| Corridors | 48 | 42 | ✗ −6 |
| CCTV | 10 | 10 | ✅ |
| Dining Area | 111 | 105 | ✗ −6 |
| Kitchen | 48 | 48 | ✅ |
| Room | 54 | 54 | ✅ |
| Elevator | 11 | 9 | ✗ −2 |
| Terrace | 23 | 21 | ✗ −2 |
| **Total** | **456** | **428** | **✗ −28** |

For **CX** the source gives **no per-section point totals at all**, so the arithmetic can only be validated against the documented default of 5 for unmarked rows — which it satisfies. Every explicitly marked CX weight was verified value-for-value and matches. For **Unit Lead** the doc gives no section total either; the seed's 134 is derivable from the per-item weights except for the three invented Balcony 4s (M-6).

---

# 8. Answer-type auto-derivation

## 8.1 Ground truth that constrains every rule

| # | Fact | Evidence |
|---|---|---|
| G1 | 11 enum values | `schema/audit.ts:34-46` |
| G2 | Non-scored = `TEXT, PHOTO, SIGNATURE, DATE, INSTRUCTION` — excluded from numerator **and** denominator; a weight on them is dead | `audit-scoring.ts:14-20`, `:180` |
| G3 | `scoreAudit` also skips **any** question with `weight <= 0`, for every type | `audit-scoring.ts:180` |
| G4 | **But the publish gate rejects it**: `weightless = questions.filter(q => !NON_SCORED_TYPES.has(q.type) && q.weight <= 0)` → 422 | `audit-templates.ts:599-606` |
| G5 | `RATING` reads **only** the version `ratingScaleSnapshot`; `SINGLE_CHOICE`/`MULTI_CHOICE` read **only** `optionsJson`. **Disjoint code paths — per-question options do not override the scale** | `audit-scoring.ts:86-113`; runner `audit-runner.tsx:222-313` |
| G6 | A version may reference **exactly one** rating scale (422 otherwise). So a 4-level operational scale and a 1-5 resident scale **cannot coexist as RATING** in one CX version | `audit-templates.ts:105-112` |
| G7 | `NUMERIC` with both bounds null → **`multiplierPct: 100` unconditionally** | `audit-scoring.ts:117-128` |
| G8 | `choiceOptionSchema` is `{id,label,multiplierPct}` — **no `isExcludedNa`, no `color`** — and zod **strips** unknown keys at all four write paths | `audit-templates.ts:794-798`, `:977-981`, `:1201-1205` |
| G9 | The runner has **no "mark N/A" affordance** for any type; it never sends `isNa:true` | grep `isNa` in `audit-runner.tsx` |
| G10 | `INSTRUCTION` renders a bare info card — no input, **no notes box**, no evidence strip | `audit-runner.tsx:433-447` |
| G11 | `audit_question_bank_items` has **no `mandatory` column**; copy-on-insert hard-codes `mandatory: false` | `schema/audit.ts:132-152`; `audit-templates.ts:1136` |
| G13 | Seeded scale: Excellent 100 / Good 94 / Average 79 / Poor 0 / N-A (excluded), ids `audit-opt-*` | `seed-audit.ts:49-56` |
| G14 | The codebase's own default 5-point scale is **100/75/50/25/0** | `audit-templates.ts:81-93` |
| G15 | `isFailingAnswer` (drives `REQUIRED_ON_FAIL`) = `multiplierPct < 50` | `audit-service.ts:140-147` |
| G16 | `naAnswerFor` hard-codes `"audit-opt-na"` | `audits.ts:1154-1158` |
| G17 | Answer payloads are **not** type-validated (`z.unknown().nullish()`) — re-typing does not invalidate stored answers | `audits.ts:745-749` |

## 8.2 The rule table

**Pre-pass:** `normalize(p)` (curly quotes → straight, en/em dash → hyphen, `…` → `...`, collapse whitespace); `stripAreaPrefix(p)` = `/^([A-Z][^-]{1,40}?)\s-\s(.+)$/ → $2`. Used **only for anchored matching** — the persisted prompt is always the original byte-for-byte, preserving the byte-identical reproduction property.
`isInterrogative(p)` = `/^(is|are|do|does|did|was|were|have|has|can|should|would|will)\b/i`.

**Rule P0 — polarity guard (pre-emptive, runs first).**
`NEGATIVE = /\b(unsafe|unresolved|issue|issues|problem|complaint|clogged|infestation|leak(ing)?|broken|damaged)\b/i` and **not** preceded within 4 tokens by `no|not|free of|without`.
Effect: **no type change**, emits `warning: POLARITY`, and **blocks R8 / PASS_FAIL** (both hard-code YES=100 / PASS=100).
Rationale: *"Did resident report feeling unsafe?"* as `YES_NO_NA` would award **full marks for a safety red flag**. Hits exactly 3 items. The negation veto correctly spares *"Are there no signs of cobwebs?"*, *"No active signs of cockroaches…"*.

| # | Rule | Trigger (normalized/stripped) | Derived config | Conf. |
|---|---|---|---|---|
| **R1** | SIGNATURE | `/\bsignature\b/i` \|\| `/\bsign (?:off\|here)\b/i` | `{type:"SIGNATURE", weight:0, evidenceRule:"NONE"}` | HIGH |
| **R2** | DATE | `/\bdate\b/i` && `!isInterrogative` && `!/\bexpir(y\|ation)\b/i` | `{type:"DATE", weight:0, evidenceRule:"NONE"}` | HIGH |
| **R3** | NUMERIC + unit | unit table below | `{type:"NUMERIC", numericUnit, numericMin, numericMax, weight: capture?0:keep}` | HIGH type / MED range |
| **R4** | Likert 1-5 | `/\brate\s*1\s*(?:to\|-\|through)\s*5\b/i` \|\| `/\(\s*1\s*=[^)]*5\s*=/` | `{type:"SINGLE_CHOICE", options: LIKERT_1_5, weight: keep}` | HIGH |
| **R5** | Enumerated set | trailing `/\(([^()]{2,60})\)\s*$/` splitting on `,` into 2-6 `^[A-Za-z][A-Za-z /-]*$` tokens, **no stop-word** (`no,not,proper,and,or,with,if,none,all`), **and** the head matches `/\b(type\|category\|class\|status\|kind)\b/i` | `{type:"SINGLE_CHOICE", options: TitleCase(tokens) @100%, weight:0}` | HIGH |
| **R6** | TEXT capture | `/\bin remarks\b/i` \|\| `/\bnotes? verbatim\b/i` \|\| `/^note\b/i` \|\| `/\bnote (?:the )?time\b/i` \|\| identity noun-phrase `/^(resident name\|room number\|room no\.?\|bed number)\b/i` \|\| `/\broom number\/bed number\b/i` | `{type:"TEXT", weight:0, evidenceRule:"NONE"}` | HIGH |
| **R7** | INSTRUCTION | `/^(audit\|brief\|pick\|perform\|conduct\|complete\|fill\|speak to\|verify with)\b/i` \|\| `/\bfill the form\b\|\bembedded link\b\|\busing the .{0,30}sheet\b/i` | `{type:"INSTRUCTION", weight:0, evidenceRule:"NONE"}` | HIGH |
| **R8** | Compliance → YES_NO_NA | `(RECORD \|\| WINDOW \|\| NOTICE \|\| WITNESS) && !CONDITION_VETO && !P0` | `{type:"YES_NO_NA", weight: keep, evidenceRule: SAFETY?REQUIRED_ON_FAIL:OPTIONAL}` | HIGH / MED (WITNESS) |
| **R9** | Default | — | `{type:"RATING", weight: keep, evidenceRule: SAFETY?REQUIRED_ON_FAIL:OPTIONAL}` | — |

**Ordering matters twice.** R7 above R8 so *"Have you spoken to Residents? (…fill the form…)"* derives INSTRUCTION, not YES_NO_NA. **R6 above R7** so *"Pick 3-5 staff for spot interview (note names/roles in Remarks)"* derives **TEXT** — correct because of G10: an INSTRUCTION card renders no input *and no notes box*, so under the current seeding the staff names have literally nowhere to go.

**R3 unit table**

| Trigger | unit | min | max | weight | Note |
|---|---|---:|---:|---|---|
| `/\bMbps\b/i` | `Mbps` | **10** | null | keep | `min` alone suffices (`inRange = n >= 10`); no max so a 1 Gbps link isn't penalised |
| `/record[^.?)]{0,20}°\s?C/i` | `°C` | **−25** | **−15** | keep | `COMPOUND_PROMPT` — the prompt says "deep freezer **and** freezer"; one field cannot gate frozen ≤ −18 °C *and* chilled ≤ 5 °C. Recommend splitting the source item |
| `/\bTDS\b/i` | `ppm` | **50** | **300** | keep | `RANGE_UNVERIFIED` — BIS IS 10500 permissible is 500 mg/L; 50-300 is the palatability band. **PO sign-off required** |
| `/\(months\)/i` | `months` | 0 | 120 | **0** | Demographic capture; no pass criterion exists |

*Guard proof:* `record` alone never triggers R3. *"…record your details in the visitor register"* (`:115`) and *"…record visitor entry"* (`:346`) contain `record` but no unit token → no false positive; both correctly fall to R8.

**R8 lexicons**

```
RECORD         = /\b(on file|records? available|records? up to date|up to date|register|log ?books?|logged|checklist|certificates?|licen[cs]es?|NOC|AMC|FSSAI|KYC|police verification|agreements?|contracted?|contract)\b/i
WINDOW         = /\bwithin (?:the )?last \d+ (?:days|months|hrs|hours)\b|\bwithin \d+ (?:days|months)\b|\b(?:at least|minimum of) \d+ (?:days|months)\b/i
NOTICE         = /\bemergency contact list\b|\bevacuation route map\b|\bfire exit signage\b/i
WITNESS        = /^(?:were you|did the|did they|was your|were the)\b/i          // anchored, post-strip
CONDITION_VETO = /\b(clean|cleaned|cleanliness|neat|tidy|damaged|undamaged|cobwebs?|seepage|odou?r|smell|fragranced|well[- ]groomed|well[- ]lit|working|functional|functioning|adequate|firm|intact|stained?|comfortable|dust[- ]free|overflowing)\b/i
SAFETY         = /\b(fire|extinguisher|smoke detector|evacuation|LPG|gas leak|exposed wiring|railing|parapet|police verification|CCTV|first aid|lift safety|medical fitness|pest|rodent|expired)\b/i
```

**Why `YES_NO_NA` and not `RATING` for compliance items:** (1) A Fire NOC is on file and valid or it isn't — there is no "Good" AMC, and grading "we have it but it expires next month" as *Average* converts a compliance breach into a **79 % pass**. (2) N/A is not lost — `YES_NO_NA`→NA resolves to `{multiplierPct: null, isNa: true}` (`audit-scoring.ts:74-79`), identical semantics to `isExcludedNa`, honouring D-1 through the same branch. (3) Evidence gating improves — NO = 0 < 50 trips `REQUIRED_ON_FAIL`; "Average" (79) never does. (4) **Zero build cost** — the runner already renders `YES_NO_NA` as a segmented control (`audit-runner.tsx:185-221`) and **the type is used by zero questions in the entire 456-item bank**. (5) **No max-score change** — weights are untouched; only multiplier resolution changes.

**Why the veto matters:** *"Are all log books neat, complete…?"* matches `RECORD` but "neat" is a degree → stays RATING. Also vetoed: `:502` (clean), `:523` (functional), `:586` (adequate), `:688` (clean/working). Note `\bclean\b` does **not** match `cleaning`, so `:514` and `:532` correctly stay in R8.

**Explicitly out of scope:** the much larger class of binary *function* checks (*"Is the elevator in working condition?"*, *"Are all lights working?"*, *"Is a dustbin present?"*). ~150 items, also mis-graded on a 4-level scale, but converting them is a migration decision with a large blast radius on legacy comparability — needs PO sign-off, not a regex.

**Orthogonal modifiers**

| Mod | Trigger | Effect |
|---|---|---|
| M-A mandatory (marker) | `/★/` \|\| `/\((?:mandatory\|required)\)/i` | `mandatory:true`, marker stripped from the prompt |
| M-B mandatory (identity key) | `!isInterrogative` && `/\b(room number\|bed number)\b/i` | `mandatory:true`, MEDIUM — resolves the §19-vs-§37 inconsistency (L-10) |
| M-C naRequired | `/\bmark (?:NA\|N\/A\|Not Applicable)\b/i` \|\| `(if applicable)` \|\| `where applicable` \|\| `(if available)` \|\| `(if occupied)` \|\| `(mark NA if …)` | Asserts the bound scale has an `isExcludedNa` option. On `SINGLE_CHOICE` → emit `NA_ON_CHOICE` **and** append `NA_CHOICE_OPTION` (**requires §8.4 schema extension**). On non-scored types → no-op |
| M-D weight | derived type ∈ non-scored, or capture-shaped `SINGLE_CHOICE`/`NUMERIC` | `weight: 0` — clears phantom `defaultWeight` landmines. **No score change** (already excluded) |
| M-E evidenceRule | non-scored → `NONE`; `SAFETY` → `REQUIRED_ON_FAIL`; `/\b(photograph\|capture (?:an )?image)\b/i` → `ALWAYS_REQUIRED`; else `OPTIONAL` | The corpus contains **zero** `ALWAYS_REQUIRED` triggers |
| M-F truncation | `/\.{3}\s*[?)]?$/` \|\| mid-sentence `…` | `TRUNCATED_PROMPT` — hits PA Kitchen #7 and PA Common Area #13 |

## 8.3 The fix list — every question that must NOT be its current type

**Totals: 30 → `YES_NO_NA` · 13 → `SINGLE_CHOICE` (11 Likert + 2 Room Type) · 7 NUMERIC gain a real range or weight 0 · 14 non-scored rows lose phantom weight · 1 `INSTRUCTION` → `TEXT` · 9 `naRequired` flags · 3 `POLARITY` warnings.**

### A. Currently `RATING` → **`YES_NO_NA`** (30 items)

| Line | Where | Prompt (abridged) | w | evidenceRule | Rule |
|---|---|---|---|---|---|
| 115 | PA Entrance-Reception #8 | Were you asked to show a valid ID card and record your details in the **visitor register**? | 3 | OPTIONAL | R8 RECORD+WITNESS |
| 132 | PA Entrance-Reception #25 | Is the **emergency contact list** (fire, ambulance, Unit Lead) available at reception? | 3 | OPTIONAL | R8 NOTICE |
| 259 | PA Elevator #3 | Are emergency instructions and a valid **lift safety certificate** displayed inside? | 3 | **REQUIRED_ON_FAIL** | R8+M-E |
| 342 | CX §2 #8 | Parking **register maintained**? | 5 | OPTIONAL | R8 |
| 346 | CX §2 #12 | **Did the guard** ask for your ID and record visitor entry? | 5 | OPTIONAL | R8 WITNESS |
| 353 | CX §3 #5 | **Were you** greeted with a smile? | 5 | OPTIONAL | R8 WITNESS · *MEDIUM* |
| 372 | CX §3 #24 | **Emergency contact list** available? | 5 | OPTIONAL | R8 NOTICE |
| 373 | CX §3 #25 | Valid **licenses (Trade, FSSAI, Fire NOC, Police Verification)** displayed? | 5 | **REQUIRED_ON_FAIL** | R8+M-E |
| 374 | CX §3 #26 | **Evacuation route map and fire exit signage** displayed and visible? | 5 | **REQUIRED_ON_FAIL** | R8 NOTICE+M-E |
| 423 | CX §5 #31 | Food sample preserved (**FSSAI** requirement) for 48 hrs? | 5 | OPTIONAL | R8 |
| 434 | CX §6 #5 | All kitchen staff have valid **medical fitness certificates**? | 5 | **REQUIRED_ON_FAIL** | R8+M-E |
| 451 | CX §6 #22 | **Pest control records up to date** (last service **within 30 days**)? | 5 | **REQUIRED_ON_FAIL** | R8 |
| 473 | CX §8 #3 | Emergency instructions + **lift safety certificate** displayed? | 3 | **REQUIRED_ON_FAIL** | R8 |
| 475 | CX §8 #5 | **AMC contract** for elevator current and last service **logged**? | 3 | OPTIONAL | R8 |
| 491 | CX §10 #5 | Laundry **register**/booking system maintained? | 5 | OPTIONAL | R8 |
| 514 | CX §12 #9 | Cleaning **checklist/log** signed by housekeeping displayed? | 5 | OPTIONAL | R8 |
| 520 | CX §13 #4 | Router **AMC**/ISP contact displayed at reception? | 5 | OPTIONAL | R8 |
| 528 | CX §15 #1 | Trade **License**, **FSSAI**, Fire **NOC**, Lift Safety **Certificate** all valid? | 5 | **REQUIRED_ON_FAIL** | R8 |
| 529 | CX §15 #2 | Last fire drill **within 6 months**, first aid training **within 12 months**? | 5 | **REQUIRED_ON_FAIL** | R8 WINDOW |
| 530 | CX §15 #3 | All staff **police verification on file**? | 5 | **REQUIRED_ON_FAIL** | R8 |
| 531 | CX §15 #4 | All **AMCs** (Pest, Lift, CCTV, Garbage) **on file** and active? | 5 | **REQUIRED_ON_FAIL** | R8 |
| 532 | CX §15 #5 | Water tank cleaning **records** (last 90 days) **on file**? | 5 | OPTIONAL | R8 |
| 533 | CX §15 #6 | All operational **registers up to date**? | 5 | OPTIONAL | R8 |
| 534 | CX §15 #7 | Resident **KYC**, **agreements**, police intimation, consent docs **on file**? | 5 | OPTIONAL | R8 |
| 551 | CX §17 #7 | Room inventory matches handover **checklist**? | 4 | OPTIONAL | R8 |
| 587 | CX §22 #3 | Inverter battery health checked and last service **logged**? | 5 | OPTIONAL | R8 |
| 592 | CX §23 #3 | CCTV retention **at least 30 days**, verified on DVR/NVR? | 5 | OPTIONAL | R8 WINDOW |
| 610 | CX §26 #3 | Equipment safety checks done and **logged**? | 5 | OPTIONAL | R8 |
| 650 | CX §32 #3 | Garbage vendor **contracted** and pickup **logged** daily? | 5 | OPTIONAL | R8 |
| 653 | CX §33 #1 | Pest control **within last 30 days** (**records available**)? | 5 | **REQUIRED_ON_FAIL** | R8 |

### B. Currently `RATING` → **`SINGLE_CHOICE` + `LIKERT_1_5`** (11 items)

Generated option set (**100 / 75 / 50 / 25 / 0 — the codebase's own `DEFAULT_SCALE_SNAPSHOT`, not the seeded 100/94/79/0**, so the product keeps one 5-point convention). Array order **is** display order for choices (`audit-runner.tsx:276` does not sort), so 5-first matches the rating layout. With G15, a 1 or 2 trips `REQUIRED_ON_FAIL`; a 3 does not.

| order | id | label | multiplierPct | color |
|---|---|---|---:|---|
| 0 | `lk5` | `5 — Excellent` | 100 | `#157F5B` |
| 1 | `lk4` | `4 — Good` | 75 | `#4C9A2A` |
| 2 | `lk3` | `3 — Average` | 50 | `#9A6206` |
| 3 | `lk2` | `2 — Poor` | 25 | `#E07A2F` |
| 4 | `lk1` | `1 — Very Poor` | 0 | `#C73B33` |
| 5 | `lkna` | `N/A` | 0 | `#7C6E64` | **`isExcludedNa: true`** — appended only when M-C fires |

| Line | Where | Prompt | w | Extra |
|---|---|---|---|---|
| 572 | CX §20 #1 | Wi-Fi reliability and speed — rate 1 to 5 | 5 | |
| 573 | CX §20 #2 | Power backup — rate 1 to 5 | 5 | |
| 574 | CX §20 #3 | Water supply (pressure, hot water) — rate 1 to 5 | 4 | |
| 575 | CX §20 #4 | Laundry service — rate 1 to 5 | 5 | |
| 576 | CX §20 #5 | Study room/library **(if available)** — rate 1 to 5 | 5 | **+ N/A option**, `NA_ON_CHOICE` |
| 577 | CX §20 #6 | Gym/fitness area **(if available)** — rate 1 to 5 | 5 | **+ N/A option**, `NA_ON_CHOICE` |
| 597 | CX §24 #1 | Overall satisfaction — rate 1 to 5 (1=Very Poor … 5=Excellent) | 3 | |
| 636 | CX §30 #1 | Cleanliness of your room — rate 1 to 5 | 5 | |
| 637 | CX §30 #2 | Cleanliness of common areas — rate 1 to 5 | 5 | |
| 672 | CX §36 #1 | Quality of food/meals — rate 1 to 5 | 4 | |
| 673 | CX §36 #2 | Variety of the menu — rate 1 to 5 | 4 | |

### C. Currently `TEXT` → **`SINGLE_CHOICE` + `ROOM_TYPE`** (2 items)

| order | id | label | multiplierPct |
|---|---|---|---:|
| 0 | `rt-single` | `Single` | 100 |
| 1 | `rt-double` | `Double` | 100 |
| 2 | `rt-triple` | `Triple` | 100 |

Labels Title-Cased so `(Single, Double, Triple)` and `(single, double, triple)` normalize to the **same** set and group in reports. `weight: 0` (classification capture). **The prompt keeps the parenthetical byte-for-byte.**

| Line | Where | Prompt | w change |
|---|---|---|---|
| 569 | CX §19 #4 | `Room Type (Single, Double, Triple)` | 5 → **0** |
| 681 | CX §37 #3 | `Room type (single, double, triple)` | 5 → **0** |

### D. `NUMERIC` — ranges added or weight zeroed (7 items, closes G7's 35 free points)

| Line | Where | unit | min | max | w | Warning |
|---|---|---|---:|---:|---|---|
| 437 | CX §6 #8 (freezer) | `°C` | −25 | −15 | 5, **REQUIRED_ON_FAIL** | `COMPOUND_PROMPT` |
| 482 | CX §9 #5 (study Wi-Fi) | `Mbps` | 10 | — | 5 | |
| 517 | CX §13 #1 (lobby Wi-Fi) | `Mbps` | 10 | — | 5 | |
| 518 | CX §13 #2 (farthest room) | `Mbps` | 10 | — | 5 | |
| 525 | CX §14 #3 (TDS) | `ppm` | 50 | 300 | 5 | `RANGE_UNVERIFIED` |
| 690 | CX §38 #6 (room Wi-Fi) | `Mbps` | 10 | — | 5 | |
| 568 | CX §19 #3 (tenure) | `months` | 0 | 120 | 5 → **0** | capture-only |

### E. Non-scored rows losing phantom weight (14) + 1 type correction + 9 naRequired + 3 POLARITY

| Line | Where | Change |
|---|---|---|
| 331 | CX §1 #2 (note room numbers) | TEXT w1 → **0** |
| 335 | CX §2 #1 (note time of arrival) | TEXT w5 → **0** |
| 566 | CX §19 #1 (Resident Name) | TEXT w5 → **0** |
| 567 | CX §19 #2 (Room Number) | TEXT w5 → **0**, `mandatory:true` kept (M-A) |
| 631 | CX §29 #3 (Auditor signature) | SIGNATURE w5 → **0** *(recommend `mandatory:true` — policy, off by default)* |
| 632 | CX §29 #4 (PM/UL acknowledgement) | SIGNATURE w5 → **0** |
| 633 | CX §29 #5 (note audit duration) | TEXT w5 → **0** |
| 658 | CX §34 #1 (Top 1-3 LIKE) | TEXT w1 → **0** |
| 659 | CX §34 #2 (Top 1-3 IMPROVED) | TEXT w2 → **0** |
| 676 | CX §36 #5 (food concerns) | TEXT w4 → **0** |
| 679 | CX §37 #1 (Room/Bed number) | TEXT w5 → **0**, **`mandatory:true`** (M-B) |
| 680 | CX §37 #2 (Resident name) | TEXT w5 → **0** |
| 682 | CX §37 #4 (last housekeeping date) | DATE w5 → **0** |
| 330 | CX §1 #1 (audit 1 room per floor) | INSTRUCTION, evidenceRule → NONE |
| **664** | **CX §35 #1** (Pick 3-5 staff, note names/roles in Remarks) | **`INSTRUCTION` → `TEXT`, w0 — the only true type correction, forced by G10 (an INSTRUCTION card has no notes box, so the names have nowhere to go)** |
| 237, 265 (PA); 310 (UL); 495, 498, 500, 503 (CX §11); 576, 577 (CX §20) | | `naRequired` flag (M-C) — 9 items |
| 300 (UL #16 seepage, **w:7**), 639 (CX §30 #4 unresolved issues), 693 (CX §39 SAFETY RED FLAG) | | `warning: POLARITY`, **R8 suppressed** |
| 155, 225 (PA) | | `warning: TRUNCATED_PROMPT` (M-F) |

**Net scoring impact — precisely:** every section maximum is **unchanged except one** — CX §19 goes from an engine-scored max of **5 → 0**. 35 raw NUMERIC points stop being free (30 range-gated, 5 removed). 53 points of phantom `defaultWeight` on non-scored rows are cleared with **zero score change** (already excluded), removing the "editor re-types the row and inherits a wrong maximum" landmine. **RATING weights are never touched** — the Property Audit 428-vs-456 deficit (§7.3) is a separate fix.

## 8.4 Code changes required

### New shared package — `lib/audit-derive` *(new)*

Required because **both** `@workspace/scripts` (the seeder) and `@workspace/api-server` (the suggest endpoint) need the same rules; duplicating them guarantees drift. `lib/*` is already a workspace glob (`pnpm-workspace.yaml:1-5`) and sibling packages export source directly.

```
lib/audit-derive/
  package.json   { "name":"@workspace/audit-derive", "type":"module",
                   "exports": {".":"./src/index.ts"} }   // zero runtime deps
  tsconfig.json
  src/index.ts        deriveAnswerConfig / deriveAnswerConfigs / normalizePrompt /
                      stripAreaPrefix / LIKERT_1_5_OPTIONS / ROOM_TYPE_OPTIONS /
                      NA_CHOICE_OPTION / DERIVATION_RULES
  src/rules.ts
  src/options.ts
  src/__tests__/derive.test.ts
```

Add `"@workspace/audit-derive": "workspace:*"` to `scripts/package.json` and `artifacts/api-server/package.json`.

### API — advisory suggest endpoint

`artifacts/api-server/src/routes/audit-templates.ts`, in the bank block near `/check-duplicate` (`:910`), registered **before** `bankRouter.post("/:id/archive")`:

```ts
bankRouter.post("/suggest", authenticate, authorize("AUDIT_TEMPLATES", "view"), …)
```
Mounted at **`POST /api/audit/bank/suggest`** via the existing `routes/index.ts:99` — no change to `index.ts`. `POST`, not `GET`, because prompts contain `?`, `—`, `°` and can be batched (`prompts[]`, max 200).

### 🔴 Schema change #1 — `optionsJson` gains `color` + `isExcludedNa` *(no DDL)*

`optionsJson` is a `json` column, so **no migration is needed** — but `choiceOptionSchema` (`audit-templates.ts:794-798`) strips unknown keys and the code reassigns the **parsed** value (`:977-981`, `:1201-1205`), so the fields are silently dropped at all four write paths today (G8). One schema edit fixes all four:

```ts
const choiceOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().max(200),
  multiplierPct: z.number().min(0).max(100),
  color: z.string().max(16).nullish(),
  isExcludedNa: z.boolean().optional(),   // same semantics as a rating option (D-1)
});
```

Then: `audit-scoring.ts` `case "SINGLE_CHOICE"` returns `{multiplierPct: null, isNa: true}` on `isExcludedNa`; `case "MULTI_CHOICE"` excludes such options from the average; widen `ScoringQuestion.optionsJson` (`:27`); mirror in the client scorer (`lib.ts:559-620`) and `ChoiceOption` (`lib.ts:82-86`); runner renders the option with the muted/dashed treatment already used for the rating N/A (`audit-runner.tsx:249-251`); `ChoiceOptionsEditor` (`shared.tsx:216-296`) gains a colour swatch + an "N/A (excluded)" toggle.

**Fix the coupled defect while here** — `audits.ts:1154-1158` `naAnswerFor` must take the question + snapshot and find the `isExcludedNa` option dynamically instead of hard-coding `"audit-opt-na"` (G16). This is the root cause of the FRD-SCR-01 downgrade.

### 🔴 Publish gate — allow weight 0 on capture-shaped scorable types

Without this, **`Room Type` and the tenure NUMERIC cannot be published at weight 0** (G4), and the only alternatives are score inflation or losing the enumeration.

`audit-templates.ts:599-606`:
```ts
const WEIGHT_REQUIRED_TYPES = new Set(["RATING", "YES_NO_NA", "PASS_FAIL"]);
const weightless = content.questions.filter(q => WEIGHT_REQUIRED_TYPES.has(q.type) && q.weight <= 0);
```
*(Alternative if the team prefers an explicit signal: add `informational boolean default false` to `audit_questions` + `audit_question_bank_items` — but that is a schema change for something `scoreAudit` already models with `weight <= 0`.)*

### 🔴 Schema change #2 — `audit_question_bank_items.default_mandatory` *(DDL, additive)*

`audit_question_bank_items` has **no mandatory column** (`schema/audit.ts:132-152`) and copy-on-insert hard-codes `mandatory: false` (`audit-templates.ts:1136`), so a derived `mandatory:true` cannot survive a bank round-trip (G11).

```ts
// lib/db/src/schema/audit.ts — auditQuestionBankItemsTable
defaultMandatory: boolean("default_mandatory").default(false).notNull(),
```
Then add `defaultMandatory` to `bankItemSchema` (`:817`), the POST values (`:940`) and the PATCH `pick()` (`:971`); change copy-on-insert to `mandatory: item.defaultMandatory`. Apply with `pnpm --filter @workspace/db run push` (additive; no migration files in this repo).
**This is a prerequisite for shipping M-A/M-B through the UI.** A seed-only rollout can defer it (the seed writes `audit_questions` directly) — but say so, rather than shipping a button that silently drops its own suggestion.

### Seed integration — a codemod, not runtime derivation

`scripts/src/seed-audit.ts` `questionRow` (`:120-138`) and the bank insert (`:167-176`) currently hard-null `helpText`, `optionsJson`, `numericMin`, `numericMax` and never write `defaultOptionsJson`. Change both to carry `q.helpText`, `q.options`, `q.numericMin`, `q.numericMax`, `q.evidenceRule`, `q.mandatory`. Extend `SeedQuestion` in `audit-question-bank.ts` with `options?`, `numericMin?`, `numericMax?`, `evidenceRule?`, `helpText?`.

**Do not run derivation at seed time.** Add a one-shot codemod so the 77 changes land as a reviewable diff and the bank stays declarative:

`scripts/src/derive-audit-bank.ts` → `"derive:audit-bank": "tsx ./src/derive-audit-bank.ts"`, with `--check` (CI, fails on drift) and `--write`.

**Golden test** (`lib/audit-derive/src/__tests__/derive.test.ts`): every one of the 456 prompts derives the type committed in the bank file (drift guard); the fix list above asserted item by item; **explicit negative assertions** for each documented false-positive guard (§8.5).

### UI affordance

`lib.ts`: `suggestAnswerConfig()`, `applySuggestion()`, `suggestionDiff()`.
`shared.tsx`: new `<SuggestStrip>` — 400 ms debounce (same pattern as `useDuplicatePrompts`), renders nothing when the suggestion equals the current config, otherwise a one-line strip (`Suggested: Yes / No / N/A · weight 0 · evidence on fail` + Apply + Dismiss) with warning chips and a confidence badge. **Never auto-applies**; always shows `suggestionDiff` on hover.
Mount under the prompt input in `question-bank.tsx:379-386` (next to `<DuplicateWarning/>`) and under `QuestionPromptField` in `template-builder.tsx:160-165`. Optional bulk: "Suggest for all questions in this section" using the batch form + an approve-per-row review sheet.

## 8.5 Where the derivation misfires — guards and residual risk

| # | Misfire | Guard | Residual |
|---|---|---|---|
| R-1 | **Polarity inversion** — the derivation *creating* a scoring inversion that did not exist | **P0 runs first, hard-blocks R8/PASS_FAIL**; hits exactly 3 items | Those 3 remain wrong under RATING too (Excellent = 100 for a red flag) — a source-data defect the warning surfaces |
| R-2 | Record-noun steals a quality judgement | `CONDITION_VETO` (20 tokens); 5 verified vetoes | `\bclean\b` deliberately does not match `cleaning` — any new veto token must be re-checked against `:514`/`:532` |
| R-3 | R5 eats a spec parenthetical (`(no cracks/chips, proper drainage)`) | **Two** independent guards: stop-word rejection **and** a classification-noun head | R5 will only ever hit "Room Type"; broadening it needs a curated dictionary |
| R-4 | `record` without a unit → NUMERIC | R3 requires a **unit token**, never the verb alone | "record the count" falls through to RATING — a missed suggestion beats a wrong one |
| R-5 | `SINGLE_CHOICE` has no N/A, so "(if available)" becomes unmarkable | M-C emits `NA_ON_CHOICE` + appends `NA_CHOICE_OPTION` — **this is why the §8.4 schema edit is not optional** | Today's accidental escape hatch (`isNa` → `naAnswerFor` → null → both sums) takes the *unresolvable* branch and **ignores `na_counts_against` entirely** |
| R-6 | A section can reach zero scored weight (§19: 5 → 0). `scoreAudit:243-252` only emits a `SectionScore` when `max != null`, so a fully non-scored section **disappears** from `ScoreResult.sections` | Not a rule-table concern — a downstream rendering contract | Verify the scorecard/report renders a missing section as "Not scored". CX §37 already has max 0, so the path is presumably exercised — confirm before shipping |
| R-7 | Re-typing a published question orphans stored answers (G17): a `{optionId:"audit-opt-good"}` RATING answer silently drops from **both** sums after a `SINGLE_CHOICE` retype | Published versions are immutable, so this can only happen on a new draft whose audits are new; the seed truncates and re-inserts | **Never run the codemod against a database with in-flight audits.** `derive:audit-bank` edits source, not the DB |
| R-8 | Twin prompts diverge (PA Kitchen #16 stays RATING while its CX twin becomes NUMERIC) | By design — deriving from anything but the prompt is guessing; `ruleId` + `confidence` make it visible | Add `derive:audit-bank --report` grouping near-duplicate prompts (reuse `jaccard`/`normalizePrompt` from `audit-templates.ts:894-908`) and flagging pairs with divergent types |
| R-9 | Invented numeric ranges become scoring policy | `RANGE_UNVERIFIED` / `COMPOUND_PROMPT` warnings; every range is a reviewable diff line requiring PO confirmation | **The status quo is provably worse** — G7 makes all of these unconditionally 100 % today |
| R-10 | `WITNESS` over-reaches (*"Were you greeted with a smile?"*) | MEDIUM confidence, anchored regex → exactly 3 items in 456, all listed for sign-off | If the PO rejects it, delete `WITNESS`; the table loses exactly rows `:115`, `:346`, `:353` |
| R-11 | `mandatory` cannot round-trip through the bank (G11) | Not guardable in the rule table | **§8.4 schema change #2 is a prerequisite** for the UI affordance |

---

# 9. Recommended build sequence

Sequenced by dependency and PRD priority. Effort is engineer-weeks, rough.

## Phase 0 — Decide, don't build *(0 weeks; blocks everything below)*

The single highest-leverage action in this report. **A targeted `git checkout 18d6ed2 -- <path>` is nearly free; rebuilding is not.**

1. **Ratify or revert the NC/CAPA deletion.** It contradicts **ruling C-4** and accounts for **19 Must requirements (25 % of the Must set)**. Restoring those paths returns FRD-NCM-01…04, CAP-01…06, TAU-07, EXE-07, REV-03, REV-04, ANL-03, NTF-03, ADM-03, REG-06 at essentially zero cost. Rebuilding from scratch is **L-effort across ~15 requirements ≈ 8-12 weeks**.
2. **If ratified: retire C-4 in writing** and delete the leftover scaffolding in the same commit (see Phase 1). Leaving the ruling ambiguous is what keeps producing dead controls.
3. **Do not run `drizzle-kit push` against any database holding NC/CAPA rows** until (1) is decided — the tables will be dropped silently.
4. **Confirm the Property Audit weighting** (§7.3): obtain the raw source form and identify the 14 w:5 items, or sign off on a 428-point template.
5. **Sign off two invented values**: UL Balcony w:4 (§7.3 M-6) and the CX numeric ranges (§8.3 D).

## Phase 1 — Launch blockers: reachability + silently-broken controls *(≈ 1.5 weeks)*

Nothing here is a new feature. All of it is *shipped code that lies to users*.

| # | Fix | Files |
|---|---|---|
| 1 | **Restore the "All Audits" nav item** (or add an equivalent). Unblocks oversight personas (currently 1 nav item) **and** the only "New Audit" button — without it **ruling C-3 is enforced but unusable for CUSTOMER_EXPERIENCE**. | `nav.ts:126-133` |
| 2 | Add a "New Audit" CTA to `my-audits.tsx` so CX never depends on the register | `my-audits.tsx` |
| 3 | **Make `auto_close_days` work** — gate `maybeAutoCloseAudit` on it, or remove the setting | `audit-reviews.ts:209`, `audit-service.ts:278-302`, `audit-admin.tsx:517` |
| 4 | **Remove the D-2 "Review required" switch** and the unreachable auto-approve copy | `template-detail.tsx:95,260-269`; `audit-detail.tsx:411`; `audit-runner.tsx:1254` |
| 5 | **Remove the `criticalFailGate` toggle** (or wire a non-NC critical signal). It cannot fire and its label names a deleted concept | `template-detail.tsx:250-258`; `audits.ts:1019` |
| 6 | **EMAIL share: send it or 422 it** like WhatsApp. Silent no-op is the worst option | `audit-reports.ts:189-206` |
| 7 | **Fix `naAnswerFor`** to resolve the N/A option from the snapshot (closes FRD-SCR-01 / D-1 caveat) | `audits.ts:1154-1158` |
| 8 | **Fix `/audits/my`** to return completed states so the progress ring, "X of Y done" and the report banner stop being permanently zero (FRD-REG-05c) | `audits.ts:488` |
| 9 | **Fix `PATCH /audit/schedules/:id`** — write `templateVersionId`, and run `validateScheduleInput` unconditionally (a schedule can currently be edited into a garbage cron) | `audit-schedules.ts:310-335` |
| 10 | **Remove the "GPS matches property" assertion** until a real geofence check exists, or implement the check | `review-workspace.tsx:406` |
| 11 | **Link `/audits/schedules/calendar`** and `/audits/schedules/new` from the schedules page | `schedules.tsx` |
| 12 | Delete dead scaffolding: `audit_comments` table, `canBulkReassign`, unused nav icons, orphan `lib.ts` types, orphaned rating-scale admin routes, stale comments in `apps.tsx:68-71` / `nav.ts:110-124` | multiple |

## Phase 2 — Restore the deleted spine *(≈ 2 weeks if the tree is reverted; ≈ 6 if rebuilt)*

Assumes Phase 0 chose **revert** for NC/CAPA (now a revert of `28c3188`'s deletions, not a working-tree discard). If it chose **ratify**, skip the NC rows and run only the non-NC restorations.

| Restore | Reqs | Effort |
|---|---|---|
| NC/CAPA subsystem (`git checkout 18d6ed2 --` of `audit-ncs.ts`, `nc-board.tsx`, `nc-detail.tsx`, `my-findings.tsx`, schema tables/enums, `runNcSlaCheck`, auto-NC columns) | NCM-01…04, CAP-01…06, TAU-07, EXE-07, REV-03, REV-04, ANL-03, NTF-03, ADM-03, REG-06 | 2 w (revert + re-test) |
| Reassign + bulk-reassign | ASG-04, ASG-05, ASG-03, TRL-01 (assignment leg) | 1 w |
| Manual nudge + `manual_nudge_per_hour` | NTF-04, REG-04 | 0.5 w |
| Comments thread (**table still exists** — API + UI only) | EXE-10, EXE-01 | 1 w |
| Cancel (pending-only) + pause/resume | REG-04, EXE-03 | 0.5 w |
| Trail explorer + chain-verify endpoint (**gives `verifyChain()` a caller — NFR-11**) | TRL-03, TRL-02 | 1 w |
| Admin tabs: attachment policies, numbering, feature toggles, master data, rating scales | ADM-05, 06, 08, 09, 01 | 1.5 w |
| Bulk CSV grant import + grant-expiry sweep | ACC-02 | 1 w |
| Weekly email digest (`runAuditDigests` minus NC counts) | ANL-05 | 0.5 w |
| Template clone; JSON import/export; sandbox preview (reuses `scoreAudit` unchanged) | TLB-06, TLB-07, TLB-08 | 1.5 w |

## Phase 3 — Question bank correctness *(≈ 2 weeks; independent of Phases 1-2, can run in parallel)*

Launch-credible content is a prerequisite for a launch-credible module.

1. Apply the 14 Property Audit w:5 corrections once the raw form arrives (**456-point template**).
2. Build `lib/audit-derive` + the golden test (456-prompt drift guard).
3. **Schema change #1** — `optionsJson` gains `color` + `isExcludedNa`; scorer, runner and editor updated. *(No DDL.)*
4. **Publish-gate change** — allow weight 0 on `SINGLE_CHOICE`/`MULTI_CHOICE`/`NUMERIC`.
5. **Schema change #2 (DDL)** — `audit_question_bank_items.default_mandatory`; `drizzle-kit push`.
6. Run `derive:audit-bank --write`, review the 77-row diff, reseed. **Closes 35 points of free NUMERIC credit** and makes the Likert prompts answerable as 1-5.
7. Fix the UL grouping (3 sub-sections or `helpText` prefixes) — M-7.
8. Resolve the 3 truncated prompts and the CX §39 completion against the source.
9. Ship the `<SuggestStrip>` UI affordance in the bank editor + builder.

## Phase 4 — Close the Must gaps *(≈ 5 weeks)*

| Work | Reqs |
|---|---|
| Access scoping on review queue/workspace, schedules list, calendar, templates/bank; grant-resolved notification audiences | ACC-05 |
| `DENIED_ATTEMPT` on module-gate and view-scope 403s | ACC-03 |
| Evidence: per-level attachment policy restored; uploaded-by/when in the viewer | EXE-06 |
| Register: sortable headers, filter drawer, assignee filter, export button in the toolbar, report-generated column | REG-01, REG-03, REG-07, RPT-03 |
| One-off form: subset picker + assignee cascade restored | SCH-01, ASG-02 |
| `PATCH /audits/:id` reachable from the UI, with `assertAssignee` + scope check | ASG-03 |
| Reopen action on audit-detail / register (endpoint already complete) | REV-06 |
| `startedAt` re-stamped on rework/reopen; GPS surfaced in named reports | EXE-14 |
| Reminder job: allow DRAFT rows, or flip earlier by the offset | NTF-02 |
| Trail events on version-settings PATCH, bank and builder mutations | ADM-10, TRL-01 |
| Materializer: honour the pinned version (or drop the migration UI) | TLB-05 |
| Wizard: all 8 frequencies, time-of-day, window, reminder | SCH-02, SCH-06 |
| Auto-close basis + overdue grace settings | ADM-07 |
| Live provisional score in the runner; live section chips | SCR-04, EXE-04 |
| Notification rules matrix + EMAIL/SMS wiring | NTF-01, ADM-04 |
| Per-item evidence thumbnails in the PDF; per-row report download | RPT-01, RPT-02 |

## Phase 5 — Analytics & polish *(≈ 3 weeks)*

Almost entirely **rendering against endpoints that already compute the data** — the highest ratio of value to effort left in the module.

| Work | Reqs |
|---|---|
| Rebuild an oversight dashboard: status donut, 6-KPI grid, monthly score-trend chart, volume-by-template. **All four payload keys already exist** in `dashboard/summary`; the rail is currently unreachable for every persona | ANL-01, ANL-04, ANL-07, ANL-02 (partial) |
| Zone/city/cluster aggregation + true TAT metrics (submit→approve, approve→close) | ANL-02 |
| Calendar: week view + region/template/auditor/status filters + access scoping | SCH-05 |
| Bank full-text search (tsvector over prompt + helpText + tags) + authorship display | QBK-02 |
| Publish-time `contentHash` restored (makes a published version tamper-evident again) | TLB-03 |
| Second-person publish approval | TLB-04 |
| Auditor load preview + UI | SCH-07 |
| Workspace org-node scope switcher | ACC-04 |
| Column chooser | REG-01 |

## Phase 6 — Test the security and integrity boundaries *(≈ 1.5 weeks; do not defer past launch)*

40 green tests today cover exactly two pure kernels. Nothing that touches the database, authz or the request lifecycle is tested.

1. **`resolveAuditAccess` / `scopeAuditsCondition` / `canView` / `canConduct`** — 252 lines, the entire multi-tenant boundary, **zero tests**. This is where the documented `effectiveFrom` timezone bug bit before.
2. **The hash chain** — `appendAuditEvent` and `verifyChain()` are untested. NFR-11 rests on untested code whose only verifier currently has no caller.
3. **`computeSubmitBlockers`** — the D-9 compliance gate.
4. **The compound review transition** — reject's `SUBMITTED→REJECTED→IN_PROGRESS` in one transaction, and approve's unconditional close.
5. **Materializer idempotency**, the C-3 CX rejection, and latest-published-version resolution.
6. Remove or re-point `audit-scoring.test.ts:134-147`, which currently guards dead code (`hasCriticalNc`) and reads as false coverage.

---

### What "launch-credible" costs

**Phase 0 + 1 + 3 ≈ 4 weeks** buys: a module every persona can actually navigate, no controls that silently lie, correct N/A scoring on non-seed templates, a 456-point Property Audit and a question bank whose answer types match its prompts. **Phase 2 (≈ 2 weeks if reverted) restores 19 Must requirements** and satisfies ruling C-4. Phases 4-6 (≈ 9.5 weeks) close the remaining Must gaps and make the security boundary testable. **Total ≈ 15.5 weeks — of which ~2 weeks is a `git checkout` decision, not engineering.**