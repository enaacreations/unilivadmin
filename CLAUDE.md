# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

UNILIV Admin Portal — a multi-property co-living management platform (operations, residents,
complaints, laundry, HR, procurement, kitchen/food-ops, sales CRM, finance, audits, analytics).
It is a **pnpm monorepo**: React + Vite web app, Express 5 + Drizzle API, PostgreSQL, plus a
BullMQ-based notification microservice.

## Commands

Package manager is **pnpm only** (a `preinstall` hook rejects npm/yarn). Uses a pnpm `catalog:`
for shared dependency versions — pin new shared deps in `pnpm-workspace.yaml`, not per-package.

```bash
pnpm install
pnpm run typecheck                                # full workspace typecheck (do this before finishing)
pnpm --filter @workspace/db run push              # apply Drizzle schema to PostgreSQL (drizzle-kit push; no migrations)
pnpm --filter @workspace/api-spec run codegen     # regen Zod + React Query hooks from openapi.yaml
pnpm --filter @workspace/api-server run test       # vitest (API server unit tests)
pnpm --filter @workspace/api-server run test -- audit-scoring   # run a single test file by name
```

Dev servers are run as **Replit workflows**, not from the workspace root (never run `pnpm dev` at root):

- `apps/api-server: API Server` → Express on its own port, served at `/api/*`
- `apps/uniliv-admin: web` → Vite dev server, served at `/`
- `apps/mockup-sandbox: Component Preview` → served at `/__mockup`

**Ad-hoc API calls go through the shared proxy on port 80, never the service port directly:**
```bash
curl localhost:80/api/healthz
```

Default login: `admin@uniliv.com` / `Admin@123`.

## Architecture

```
apps/
  api-server/      Express 5 + Drizzle + JWT API (the backend)
  uniliv-admin/    React 19 + Vite + TS web app (the frontend)
  notify-service/  Standalone BullMQ worker that delivers notifications
  mockup-sandbox/  Component preview / design canvas
lib/
  db/              Drizzle schema + pg client — the shared source of truth for data
  api-spec/        OpenAPI spec (openapi.yaml) + Orval codegen config
  api-zod/         Generated Zod schemas (output of codegen — do not hand-edit)
  api-client-react/ Generated TanStack Query hooks + custom-fetch (do not hand-edit)
  notify-core/     Shared notify() producer client (enqueues jobs + writes outbox)
  storage/         S3/asset storage helpers
```

### Data layer (`lib/db`)
Drizzle schema is split by domain under `lib/db/src/schema/` (`core`, `auth`, `hrms`,
`procurement`, `kitchen`, `food`, `finance`, `sales`, `operations`, `wallet`, `kyc`, `audit`,
`audit-config`, `lnd`, `system`). Schema changes are applied with `drizzle-kit push` — **there are
no migration files**. Import tables/`db`/`pool` from `@workspace/db`.

### API server (`apps/api-server`)
- Built with **esbuild** (`build.mjs` → `dist/index.mjs`), run with Node. Not tsx in prod.
- One router file per domain in `src/routes/`, all mounted in `src/routes/index.ts` under `/api`.
  Business logic that's reused lives in `src/lib/*-service.ts`.
- Every protected route chains middleware: `authenticate` (decodes JWT → `req.user =
  { id, email, role, propertyId, sid }`) then `authorize(MODULE, perm)` (RBAC gate).
  Use `authorizeAny([...modules], perm)` when one endpoint legitimately feeds several pages
  (keeps page-nav access decoupled from data access).
- **Property scoping / multi-tenancy:** use `scopedPropertyId(req)` (from `src/lib/authz.ts`) in
  list queries. It returns the user's `propertyId` for property-bound roles (WARDEN, UNIT_LEAD,
  etc.) and a no-op for org-wide roles — so scoping never restricts admins. Don't hand-roll this.
- Central error handler in `app.ts` honours a `{ statusCode, details }` convention thrown by the
  service layer (e.g. wallet insufficient-balance → 422). Never leaks stack traces in production.
- Background **schedulers** (SLA checks, billing cycles, audit materializer/reminders, report
  worker) are started in `index.ts` gated on `RUN_SCHEDULERS` — only one instance should run them.
- Config is **fail-closed** in `src/config/env.ts`: a non-`development` (or unset) `NODE_ENV`
  requires a strong `SESSION_SECRET`, forbids `DEV_OTP`, and disables dev-OTP backdoors. Read the
  header comment there before touching auth/secret/cookie behaviour.

### Web app (`apps/uniliv-admin`)
- React 19, **Wouter** for routing (see `src/App.tsx`), **Zustand** for global state
  (`src/lib/store.ts` — auth + global property filter), **TanStack Query** for server state,
  Tailwind + shadcn/ui (Radix) components under `src/components/ui`.
- Prefer the **generated hooks** from `@workspace/api-client-react` for OpenAPI-defined endpoints;
  custom/not-yet-specced endpoints use the fetch helpers in `src/lib/*-api.ts` (`api-fetch.ts`,
  `food-api.ts`, `bulk-api.ts`, `masters-api.ts`).
- Path alias `@/` → `src/`.

### API contract & codegen flow
`lib/api-spec/openapi.yaml` is the source of truth for specced endpoints. Running codegen
(`pnpm --filter @workspace/api-spec run codegen`) regenerates **both** the Zod schemas
(`lib/api-zod`) and the React Query hooks (`lib/api-client-react`). After editing `openapi.yaml`,
run codegen — never hand-edit the generated files. Note many routes are hand-written and not in the
spec; those are called via the manual fetch helpers instead.

### Notifications
Transactional-outbox + broker pattern. Producers call `notify()` from `@workspace/notify-core`,
which writes a durable `notification_outbox` row (Postgres, source of truth) **and** enqueues a
BullMQ job (Redis). The standalone `notify-service` worker consumes jobs and delivers across
channels (EMAIL, SMS, WHATSAPP, PUSH/FCM, WEBPUSH/VAPID, IN_APP). See `NOTIFICATION_ARCHITECTURE.md`.

## RBAC

The permission model is the backbone of this app: ~25 roles × dozens of modules. The matrix is
duplicated on both sides and **must be kept in sync**:
- Backend: `apps/api-server/src/lib/permissions.ts` (`ROLE_PERMISSIONS`, `can()`, `UserRole`,
  `Module`, `Permission`) + `middlewares/authorize.ts`.
- Frontend: `apps/uniliv-admin/src/lib/permissions.ts` + `src/lib/use-permissions.ts`.

Adding a module or role means editing the matrix in **both** places. The two large sub-domains —
**Food Ordering & Kitchen Ops** (`FOOD_*` modules, roles like UNIT_LEAD / FNB_MANAGER) and
**Audit & Inspection** (`AUDIT_*` modules) — have their own PRD/FRD-driven role sets; audit access
also has fine-grained per-audit-type/org-node grants resolved via `resolveAuditAccess` on top of
the coarse module gates.

## Reference docs

`DOCUMENTATION.md` is the detailed system reference (endpoints, modules, data model).
`NOTIFICATION_ARCHITECTURE.md`, `FOOD_DB_PLAN.md`, `UNIT_LEAD_V2_PLAN.md`, and `DEPLOYMENT.md`
cover specific subsystems. `replit.md` describes the Replit environment.
