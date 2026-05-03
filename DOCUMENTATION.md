# UNILIV Admin Portal — Full Project Documentation

A multi-property co-living management platform covering operations, residents, complaints,
laundry, HRMS, recruitment, learning & development, procurement, kitchen, sales CRM, finance, and
executive analytics. Built as a pnpm monorepo with React + Vite (web), Express + Drizzle (API), and
PostgreSQL.

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Repository Layout](#2-repository-layout)
3. [Tech Stack](#3-tech-stack)
4. [Local Setup & Dev Workflow](#4-local-setup--dev-workflow)
5. [Environment Variables](#5-environment-variables)
6. [Authentication & Sessions](#6-authentication--sessions)
7. [Role-Based Access Control](#7-role-based-access-control)
8. [Database Schema](#8-database-schema)
9. [API Reference](#9-api-reference)
10. [Frontend Routes](#10-frontend-routes)
11. [Modules — Functional Specs](#11-modules--functional-specs)
12. [Notification System](#12-notification-system)
13. [Executive Dashboard](#13-executive-dashboard)
14. [Settings & Configuration](#14-settings--configuration)
15. [Conventions & Patterns](#15-conventions--patterns)
16. [Deployment](#16-deployment)
17. [Operations & Troubleshooting](#17-operations--troubleshooting)

---

## 1. Architecture

```
                         ┌─────────────────────────┐
                         │  Replit shared proxy    │
                         │  ($REPLIT_DEV_DOMAIN)   │
                         └────────────┬────────────┘
                                      │
                ┌─────────────────────┴─────────────────────┐
                │                                           │
        path:/api/*                                 path: / (everything else)
                │                                           │
                ▼                                           ▼
   ┌────────────────────────┐                ┌──────────────────────────┐
   │  Express API server    │                │  Vite-built React SPA    │
   │  (artifacts/api-server)│                │  (artifacts/uniliv-admin)│
   │  JWT auth, RBAC,       │                │  TanStack Query,         │
   │  Drizzle ORM           │                │  Wouter, Zustand         │
   └───────────┬────────────┘                └──────────────────────────┘
               │
               ▼
       ┌────────────────┐
       │  PostgreSQL    │
       │  (DATABASE_URL)│
       └────────────────┘
```

The shared proxy multiplexes by URL path. Both artifacts read `PORT` from the environment (assigned
per artifact by Replit). The web app uses relative URLs (`/api/...`) so the same code works in dev
and production.

---

## 2. Repository Layout

```
artifacts-monorepo/
├── artifacts/
│   ├── uniliv-admin/        React + Vite + TS web app (UI)
│   │   └── src/
│   │       ├── pages/       Route-level page components (35 pages)
│   │       ├── components/  Reusable UI (Layout, DataTable, modals, etc.)
│   │       ├── lib/         api-fetch, store, permissions, hooks
│   │       └── App.tsx      Wouter router + ProtectedRoute + PageGuard
│   ├── api-server/          Express + Drizzle + JWT API (19 route modules)
│   │   └── src/
│   │       ├── routes/      Per-domain Express routers
│   │       ├── middlewares/ authenticate, authorize, error handling
│   │       └── lib/         id generator, permissions, utilities
│   └── mockup-sandbox/      Component preview server (design canvas)
├── lib/
│   ├── db/                  Drizzle schema + connection (shared package)
│   │   └── src/schema/      core, hrms, procurement, kitchen, sales, lnd, system
│   ├── api-spec/            OpenAPI spec + Zod schemas
│   ├── api-zod/             Zod helpers
│   └── api-client-react/    Generated TanStack Query hooks (Orval)
├── scripts/                 Shared utility scripts (@workspace/scripts)
├── pnpm-workspace.yaml      Workspace + catalog + overrides
├── tsconfig.base.json       Strict TS defaults
├── tsconfig.json            Solution config (libs only)
└── README.md                Quick-start
```

---

## 3. Tech Stack

| Layer       | Technology |
|-------------|------------|
| Frontend    | React 18, Vite, TypeScript, Tailwind, shadcn/ui (Radix), Wouter, Zustand, TanStack Query, Recharts, react-hot-toast, lucide-react, jsPDF, Leaflet |
| Backend     | Node.js, Express 5, Drizzle ORM, Zod, jsonwebtoken, bcrypt, Pino logger, esbuild |
| Database    | PostgreSQL (Replit-managed) accessed via `pg` driver |
| Tooling     | pnpm workspaces, drizzle-kit (push), Orval (codegen), tsc (typecheck), Vitest |

---

## 4. Local Setup & Dev Workflow

### First-time setup

```bash
pnpm install
pnpm --filter @workspace/db run push   # apply schema to PostgreSQL
```

### Workflows (managed by Replit)

| Workflow                                       | Command                                      | Path served |
|-----------------------------------------------|----------------------------------------------|-------------|
| `artifacts/api-server: API Server`            | `pnpm --filter @workspace/api-server run dev` | `/api/*`    |
| `artifacts/uniliv-admin: web`                 | `pnpm --filter @workspace/uniliv-admin run dev` | `/`       |
| `artifacts/mockup-sandbox: Component Preview` | `pnpm --filter @workspace/mockup-sandbox run dev` | `/__mockup` |

> Never run `pnpm dev` at the workspace root. Use the configured workflows instead.

### Common commands

```bash
pnpm run typecheck                              # full workspace typecheck
pnpm --filter @workspace/db run push            # push Drizzle schema
pnpm --filter @workspace/api-spec run codegen   # regen Zod + React Query hooks
```

### Ad-hoc API testing

Always go through the shared proxy at `localhost:80`, never the service port directly:

```bash
curl localhost:80/api/healthz
curl -X POST localhost:80/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@uniliv.com","password":"Admin@123"}'
```

---

## 5. Environment Variables

| Variable             | Required | Description                                              |
|----------------------|----------|----------------------------------------------------------|
| `DATABASE_URL`       | Yes      | PostgreSQL connection string (provided by Replit)        |
| `SESSION_SECRET`     | Yes      | JWT signing secret                                       |
| `PORT`               | Yes      | Per-artifact port (auto-assigned by workflow)            |
| `NODE_ENV`           | No       | `development` (default) or `production`                  |
| `RAZORPAY_KEY_ID`    | No       | Enables Razorpay integration in Settings → Integrations |
| `RAZORPAY_KEY_SECRET`| No       | Razorpay secret key                                      |
| `TWILIO_AUTH_TOKEN`  | No       | Enables Twilio SMS integration                           |
| `SMTP_HOST`          | No       | Enables SMTP integration                                 |

---

## 6. Authentication & Sessions

- **Login**: `POST /api/auth/login` returns `{ accessToken, refreshToken, user }`
- **Access token**: JWT, 15-minute expiry, stored in `localStorage` under `uniliv_token`
- **Refresh token**: 7-day expiry, sent as `httpOnly` cookie
- **Refresh**: `POST /api/auth/refresh` rotates the access token
- **Logout**: `POST /api/auth/logout` invalidates the refresh token
- **Identity**: `GET /api/auth/me` returns the current user (used by `usePermissions()` on the FE)

The `authenticate` middleware decodes the JWT and populates `req.user = { id, email, role, propertyId }`.
All non-public routes require authentication. The default seeded admin is:

```
Email:    admin@uniliv.com
Password: Admin@123
```

---

## 7. Role-Based Access Control

A 12-role × 25-module permission matrix is shared between FE and BE.

### Roles

`SUPER_ADMIN`, `HR_MANAGER`, `OPERATIONS_MANAGER`, `PROCUREMENT_MANAGER`, `KITCHEN_MANAGER`,
`PROJECTS_MANAGER`, `PROPERTY_ACQUISITION`, `FINANCE`, `SALES_EXECUTIVE`, `WARDEN`,
`VENDOR_RESTRICTED`, `AUDIT_READONLY`.

### Modules

`DASHBOARD`, `EXECUTIVE_DASHBOARD`, `PROPERTIES`, `RESIDENTS`, `COMPLAINTS`, `LAUNDRY`,
`COMMUNICATIONS`, `EMPLOYEES`, `RECRUITMENT`, `LND`, `VENDORS`, `INDENTS`, `PURCHASE_ORDERS`, `GRN`,
`INVENTORY`, `RECIPES`, `MENU_PLANNING`, `SALES_LEADS`, `SALES_DASHBOARD`, `PROPERTY_LEADS`,
`LEDGER`, `PAYMENTS`, `USERS`, `SETTINGS`, `AUDIT_LOG`.

### Per-role module access (summary)

| Role                  | Allowed modules                                                                       |
|-----------------------|---------------------------------------------------------------------------------------|
| SUPER_ADMIN           | All — full CRUD                                                                       |
| HR_MANAGER            | Employees, Recruitment, L&D, Users, Settings (view)                                   |
| OPERATIONS_MANAGER    | Properties, Residents, Complaints, Laundry, Communications (own property)             |
| PROCUREMENT_MANAGER   | Vendors, Indents, POs, GRN, Inventory                                                 |
| KITCHEN_MANAGER       | Recipes, Menu Planning, Inventory (view)                                              |
| PROJECTS_MANAGER      | Property Leads, Finance (view), Procurement (view)                                    |
| PROPERTY_ACQUISITION  | Property Leads only                                                                   |
| FINANCE               | Executive Dashboard, Residents (view), Ledger, Payments, Procurement (view)           |
| SALES_EXECUTIVE       | Sales CRM (own leads), Sales Dashboard, Property Leads (view)                         |
| WARDEN                | Properties (view), Residents, Complaints, Laundry, Communications (own property)      |
| VENDOR_RESTRICTED     | Dashboard placeholder                                                                 |
| AUDIT_READONLY        | All modules — read only                                                               |

### Backend enforcement

```ts
// artifacts/api-server/src/middlewares/authorize.ts
import { authorize } from "../middlewares/authorize.js";

router.get("/", authenticate, authorize("SETTINGS", "view"), handler);
router.post("/", authenticate, authorize("SETTINGS", "create"), handler);

// or for an entire router:
router.use(authenticate, authorize("EXECUTIVE_DASHBOARD", "view"));
```

`authorize(module, perm)` returns `403 Forbidden` for users whose role lacks the permission.

### Frontend enforcement

```ts
// artifacts/uniliv-admin/src/lib/use-permissions.ts
const { can, role, propertyId } = usePermissions();

if (can("RESIDENTS", "create")) { /* show button */ }
```

- The `Layout` sidebar is filtered: items the user cannot view are hidden.
- `PageGuard` (in `Layout`) checks the current route against `moduleForPath()` and renders the
  `Forbidden` page if access is denied.
- Action buttons should be wrapped with `can(module, perm)` checks.

### Property scoping

Users with a non-null `propertyId` are restricted to their own property in operational modules.
`SUPER_ADMIN` and roles with multi-property access bypass scoping. Scoping is enforced server-side
in the relevant route handlers.

---

## 8. Database Schema

Schema lives in `lib/db/src/schema/` and is split into 7 files:

### core.ts
`properties`, `rooms`, `users`, `refreshTokens`, `residents`, `ledgerEntries`, `payments`,
`complaints`, `complaintEvents`, `escalations`, `laundryBatches`, `messageTemplates`,
`announcements`, `communicationLogs`.

### hrms.ts
`employees`, `attendance`, `leaves`, `leaveBalances`, `performanceNotes`, `jobRequisitions`,
`candidates`, `interviews`, `offers`, `exits`, `exitClearances`, `exitAssets`.

### procurement.ts
`vendors`, `vendorDocuments`, `rateContracts`, `indents`, `purchaseOrders`, `grns`,
`stockMovements`, `inventory`.

### kitchen.ts
`recipes`, `menuPlans`, `dailyProduction`, `recipeFeedback`.

### sales.ts
`leads`, `leadActivities`, `propertyLeads`.

### lnd.ts
`courses`, `courseEnrollments`.

### system.ts
`notifications`, `auditLog`, `slaConfig`, `complaintRouting`, `integrationStatus`.

### Enums

`property_status`, `room_type`, `room_status`, `user_role`, `resident_status`, `ledger_type`,
`payment_mode`, `payment_status`, `complaint_category`, `complaint_status`, `priority`,
`laundry_status`.

### Conventions

- All numeric currency amounts are stored as `text` (Drizzle `numeric` columns) to avoid
  floating-point precision issues. The API casts them to `Number()` in responses.
- IDs are `text` primary keys generated via `newId()` (nanoid-style).
- Every table has `createdAt` and `updatedAt` timestamps.

### Schema migration

```bash
pnpm --filter @workspace/db run push        # interactive
pnpm --filter @workspace/db run push-force  # CI / force apply
```

---

## 9. API Reference

All routes are prefixed with `/api`. Responses use a uniform shape:

```json
{ "success": true, "data": <payload>, "meta": { /* optional */ } }
{ "success": false, "error": "<message>" }
```

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST   | `/auth/login`    | Email/password login |
| POST   | `/auth/refresh`  | Rotate access token |
| POST   | `/auth/logout`   | Invalidate refresh token |
| GET    | `/auth/me`       | Current user identity |

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/healthz` | `{ status: "ok" }` — for load balancers |

### Dashboard (operational)

`GET /dashboard/stats` — property-scoped KPIs (residents, occupancy, complaints, employees, revenue, low stock).

### Executive Dashboard

All routes guarded by `authorize("EXECUTIVE_DASHBOARD", "view")`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/executive/kpis`                  | 6 top-line KPIs |
| GET | `/executive/revenue-trend`         | 12-month stacked revenue |
| GET | `/executive/occupancy-by-property` | Per-property occupancy |
| GET | `/executive/complaints-resolution` | MTD resolution rate |
| GET | `/executive/lead-funnel`           | Lead stage counts |
| GET | `/executive/headcount`             | Headcount by department + leaves today |
| GET | `/executive/top-overdue`           | Top 5 overdue residents |
| GET | `/executive/top-sla-breached`      | Top 5 breached complaints |

### Notifications

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/notifications`           | Last 20 + `meta.unreadCount` |
| PATCH  | `/notifications/:id/read`  | Mark one as read |
| PATCH  | `/notifications/read-all`  | Mark all as read |

### Settings

All read endpoints require `SETTINGS:view`; writes require `SETTINGS:edit` or `SETTINGS:delete`.

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/settings/sla`             | SLA hours per complaint category |
| PUT    | `/settings/sla/:category`   | Upsert SLA hours |
| GET    | `/settings/routing`         | Complaint routing rules |
| POST   | `/settings/routing`         | Add routing rule |
| DELETE | `/settings/routing/:id`     | Remove routing rule |
| GET    | `/settings/integrations`    | Razorpay / Twilio / SMTP status |
| GET    | `/settings/audit-log`       | Last 200 audit entries (`AUDIT_LOG:view`) |

### Properties / Rooms / Residents

`/properties`, `/rooms`, `/residents` — full CRUD, plus:

- `POST /residents/bulk-rent` — bulk rent charging
- `POST /residents/:id/checkout` — checkout flow
- `POST /residents/:id/ledger` — manual ledger entry
- `POST /residents/:id/payments` — record payment
- `GET  /residents/:id/ledger` — ledger entries
- `GET  /residents/:id/payments` — payment history

### Complaints

`/complaints` CRUD plus:

- `POST /complaints/:id/audit` — audit trail entry
- `POST /escalations` — escalate a complaint
- `GET  /complaints/:id/timeline`

### Laundry, Communications

`/laundry` CRUD; `/communications`, `/announcements`, `/message-templates` for templates and
broadcast messages, including `POST /communications/preview` and `POST /communications/bulk-send`.

### HRMS — `/employees`, `/attendance`, `/leaves`

- `GET /employees/:id/attendance|leave-balances|performance|exit|documents`
- `POST /employees/:id/performance|exit|documents`
- `POST /attendance/bulk` — bulk mark attendance
- `POST /leaves/:id/approve|reject` — leave decisions
- Recruitment under `/job-requisitions`, `/candidates`:
  - `POST /candidates/:id/interviews|offers`
  - `PUT  /candidates/:id`
- Exit management:
  - `PUT /exit-clearances/:cid`, `PUT /exit-assets/:aid`
  - `POST /exits/:eid/finalize`

### Procurement — `/vendors`, `/indents`, `/purchase-orders`, `/grn`, `/inventory`

- `POST /vendors/:id/rate-contracts`
- `POST /vendors/:id/documents`
- `POST /indents/:id/approve|reject`
- `POST /indents/:id/generate-indent` — auto-generate from menu plan
- `GET  /inventory/alerts` — items below min stock
- `GET  /inventory/:id/movements`
- `POST /inventory/:id/consume`

### Kitchen — `/recipes`, `/menu-plans`, `/daily-production`, `/kitchen-analytics`

- `POST /menu-plans/:id/copy` — copy a weekly plan
- `POST /menu-plans/:id/publish`
- `POST /recipes/:id/feedback`
- `GET  /kitchen-analytics/feedback-trends|wastage-trends|menu-diversity`

### Sales — `/leads`, `/property-leads`

- `POST /leads/:id/activities|follow-up|schedule-visit|visit-outcome|convert|mark-lost`
- `GET  /leads/export-csv`
- `GET  /leads/charts`

### Learning & Development — `/courses`, `/enrollments`

- `POST /courses/:id/enroll|publish`
- `POST /enrollments/:id/progress|quiz`

### Users — `/users`, `/announcements`

- Full user CRUD; `PUT /users/:id` for role/property/active changes.

> The full per-route surface is generated from `lib/api-spec/openapi.yaml`. Run codegen to
> refresh React Query hooks: `pnpm --filter @workspace/api-spec run codegen`.

---

## 10. Frontend Routes

Routes are defined in `artifacts/uniliv-admin/src/App.tsx` (Wouter). Every protected route is
wrapped in `<ProtectedRoute>` (auth check) → `<Layout>` (chrome) → `<PageGuard>` (RBAC).

| Path | Component | Module |
|------|-----------|--------|
| `/login`                     | `pages/login`              | (public) |
| `/`                          | `pages/dashboard`          | DASHBOARD |
| `/dashboard/executive`       | `pages/executive-dashboard`| EXECUTIVE_DASHBOARD |
| `/properties`, `/properties/:id` | `pages/properties` + detail | PROPERTIES |
| `/rooms`                     | `pages/rooms`              | PROPERTIES |
| `/residents`, `/residents/:id` | `pages/residents` + detail | RESIDENTS |
| `/complaints`, `/complaints/:id` | `pages/complaints` + detail | COMPLAINTS |
| `/laundry`                   | `pages/laundry`            | LAUNDRY |
| `/communications`            | `pages/communications`     | COMMUNICATIONS |
| `/employees`, `/employees/:id` | `pages/employees` + detail | EMPLOYEES |
| `/attendance`                | `pages/attendance`         | EMPLOYEES |
| `/leaves`                    | `pages/leaves`             | EMPLOYEES |
| `/recruitment`               | `pages/recruitment`        | RECRUITMENT |
| `/courses`, `/courses/:id`   | `pages/courses` + detail   | LND |
| `/vendors`, `/vendors/:id`   | `pages/vendors` + detail   | VENDORS |
| `/indents`                   | `pages/indents`            | INDENTS |
| `/purchase-orders`           | `pages/purchase-orders`    | PURCHASE_ORDERS |
| `/grn`                       | `pages/grn`                | GRN |
| `/inventory`                 | `pages/inventory`          | INVENTORY |
| `/recipes` (`/kitchen` redirect) | `pages/kitchen`         | RECIPES |
| `/menu-planning`             | `pages/menu-planning`      | MENU_PLANNING |
| `/leads`                     | `pages/leads`              | SALES_LEADS |
| `/sales/dashboard`           | `pages/sales-dashboard`    | SALES_DASHBOARD |
| `/property-leads`            | `pages/property-leads`     | PROPERTY_LEADS |
| `/ledger`                    | `pages/ledger`             | LEDGER |
| `/payments`                  | `pages/payments`           | PAYMENTS |
| `/users`                     | `pages/users`              | USERS |
| `/settings`                  | `pages/settings`           | SETTINGS |
| `/403`                       | `pages/forbidden`          | (any) |
| `*`                          | `pages/not-found`          | (any) |

---

## 11. Modules — Functional Specs

### Operations

- **Properties**: Property catalog with capacity, occupancy %, address, status. Property leads
  pipeline tracks acquisition (sourcing → due diligence → onboarded).
- **Rooms**: Room inventory per property with type (single/double/triple/quad), bed count, status.
- **Residents**: Multi-step onboarding (personal → KYC → room assignment → agreement). Per-resident
  ledger, payment history, complaints. Bulk rent charging across a property. Client-side PDF
  generation for agreements and receipts (jsPDF). Checkout flow with security-deposit
  reconciliation.
- **Complaints**: Tickets with category, priority, SLA tracking, escalation timeline,
  routing rules from Settings. Auto-generates SLA-breach notifications.
- **Laundry**: Pickup/delivery batches, charges fed into the resident ledger.
- **Communications**: Templated messaging with merge fields, broadcast to property/all-residents,
  preview before send, delivery logs.

### People

- **Employees / Attendance / Leaves**: Headcount, attendance with bulk-mark, leave balances with
  atomic reconciliation, performance notes.
- **Recruitment**: Job requisitions, candidate pipeline, interviews, offer letters with PDF
  generation.
- **Exit management**: Clearance checklists, asset returns, finalization workflow.
- **Learning & Development**: Course library, enrollments, progress tracking, quizzes, secure
  PDF/video viewer.

### Supply Chain

- **Vendors**: Master with rate contracts and compliance documents.
- **Indents**: Internal purchase requisitions (auto-generatable from menu plans), approval workflow.
- **Purchase Orders**: Generated from approved indents, sent to vendors.
- **GRN**: Goods receipt with transactional stock updates and movement records.
- **Inventory**: Per-property stock with min/max thresholds, stock movements, low-stock alerts.

### Food

- **Recipes**: Recipe master with ingredients, yields, cost rollups.
- **Menu Planning**: Weekly menu per property with auto-computed indent quantities.
- **Daily Production**: Actuals vs. planned, wastage tracking, feedback.
- **Kitchen Analytics**: Feedback trends, wastage trends, menu diversity score.

### Growth

- **Sales CRM**: 7-stage Kanban + list, activity log, follow-ups, visits, conversion to resident
  with security deposit. CSV export.
- **Property Leads**: Acquisition pipeline with viability calculator and Leaflet map.

### Finance

- **Ledger**: Per-resident debit/credit ledger across rent, food, laundry, utilities, deposits.
- **Payments**: Manual entry + Razorpay-ready (gated by env vars). Status transitions PENDING →
  SUCCESS / FAILED / REFUNDED.

---

## 12. Notification System

### Schema (`notifications` table)

`{ id, userId, title, body, type, link, isRead, createdAt }`

### Notification types (auto-generated)

| Type                       | Trigger                                  | Recipient                     |
|----------------------------|------------------------------------------|-------------------------------|
| `COMPLAINT_SLA_BREACH`     | Complaint older than SLA hours           | Assignee + manager            |
| `PAYMENT_OVERDUE`          | Daily 9am job                            | Operations manager (property) |
| `LEAVE_APPROVAL_PENDING`   | Employee submits leave                   | Reporting manager             |
| `INDENT_APPROVAL_PENDING`  | Indent submitted                         | Procurement manager           |
| `LOW_STOCK`                | Inventory ≤ min stock                    | Procurement manager           |
| `DOCUMENT_EXPIRY`          | Vendor compliance doc < 30 days to expiry| Admin                         |
| `LEASE_RENEWAL`            | Property agreement < 60 days to expiry   | Property acquisition          |

### Producer

```ts
import { createNotification } from "../routes/notifications.js";
await createNotification(userId, {
  title: "Complaint #1234 SLA breached",
  body: "Plumbing complaint at Cluster A",
  type: "COMPLAINT_SLA_BREACH",
  link: "/complaints/1234",
});
```

### Consumer

The topbar `<NotificationBell />` (`src/components/notification-bell.tsx`) polls
`GET /api/notifications` every 30 seconds via TanStack Query (`refetchInterval: 30_000`). The badge
shows unread count; clicking an entry marks it read and navigates to `link`.

---

## 13. Executive Dashboard

Visible to `SUPER_ADMIN` and `FINANCE`. Layout:

- **Row 1**: 6 KPI cards (Properties, Residents, Occupancy %, Revenue MTD, Outstanding, Open
  Complaints).
- **Row 2**: Stacked area chart — last 12 months of revenue split by rent / food / laundry.
- **Row 3**:
  - Horizontal bar — Occupancy by Property
  - Donut — MTD Complaint Resolution rate
  - Funnel — Lead Conversion (NEW → CONTACTED → VISIT_SCHEDULED → VISIT_DONE → NEGOTIATING → CONVERTED)
- **Row 4**: Headcount by department (bar) + on-leave-today count.
- **Row 5**: Top 5 overdue residents and Top 5 SLA-breached complaints.

Implementation: `artifacts/uniliv-admin/src/pages/executive-dashboard.tsx` consuming
`/api/executive/*` endpoints.

---

## 14. Settings & Configuration

Settings page (`/settings`) has 5 tabs:

| Tab            | Function |
|----------------|----------|
| General        | Org name, currency, timezone, support email |
| SLA            | Editable hours per complaint category |
| Routing        | Property × category → assignee dropdown |
| Notifications  | Toggle which notification types are active (localStorage) |
| Integrations   | Razorpay / Twilio / SMTP status (driven by env vars) |

`SUPER_ADMIN`-only audit log is exposed at `GET /api/settings/audit-log` for future inclusion in
Settings → Audit tab.

---

## 15. Conventions & Patterns

### API contract

- All responses follow `{ success, data, meta? }` or `{ success: false, error }`.
- The web app's `apiFetch()` (in `src/lib/api-fetch.ts`) throws on `!ok || success === false`.
- OpenAPI-defined endpoints have generated TanStack Query hooks via Orval; custom endpoints use
  raw `apiFetch`.

### Logging

Server code uses Pino. **Never use `console.log`** in server code:

```ts
req.log.info({ userId }, "user logged in");
req.log.error(err);
```

### IDs

```ts
import { newId } from "../lib/id.js";
const id = newId();   // nanoid-style 21-char URL-safe ID
```

### Numeric / currency fields

Stored as `text` (Drizzle `numeric`), converted to `Number()` in API responses.

### Forms & feedback

- Submit buttons disable + spinner during in-flight mutations.
- `react-hot-toast` for success / error toasts.
- Modals close on Escape (Radix default).

### Frontend store

`src/lib/store.ts` exposes:

- `useAuthStore` — `{ token, setToken, isAuthenticated }`
- `useAppStore` — `{ propertyId, setPropertyId }` (global property filter)

User identity is loaded via TanStack Query (`useMe()` in `use-permissions.ts`), not the store, so it
auto-refreshes and survives page reloads.

### Routing patterns (dev)

- Web URLs: `/path` (relative, served by Vite via the shared proxy)
- API URLs: `/api/path` (always relative — `apiFetch` prepends `/api`)
- Never call service ports directly; always go through `localhost:80` (the shared proxy)

### Theming / dark mode

`<ThemeToggle />` flips a `dark` class on `<html>` and persists to `localStorage` under
`uniliv_theme`. Tailwind's `dark:` variants apply across the design system.

---

## 16. Deployment

### Replit Autoscale (recommended)

Each artifact has its own `.replit-artifact/artifact.toml` describing build/run commands and
service routing. Publishing the project from the Replit UI:

1. Build runs per artifact (`pnpm -r --if-present run build`).
2. Each service is started behind the shared proxy.
3. Path-based routing routes `/api/*` to the API and `/*` to the SPA.
4. TLS, health checks, and the `.replit.app` (or custom) domain are managed by Replit.

### Required Replit Secrets

`DATABASE_URL`, `SESSION_SECRET`. Optional integrations: `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `SMTP_HOST`.

### Health check

`GET /api/healthz → { status: "ok" }` is the canonical liveness probe.

### Production database push

For schema changes, push to the production database with the Replit Database tool / production
connection string. Never push schema during a hot deployment without a pre-publish snapshot.

---

## 17. Operations & Troubleshooting

### Workflow restarts

Use the `restart_workflow` tool (or the Replit UI) when:

- Code in `artifacts/api-server/src/**` changes (esbuild rebuilds & restarts on dev).
- A new dependency is added to a workspace package.

The web app uses Vite HMR — most changes are picked up instantly.

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 from API in browser | `localStorage` token expired | Refresh page → app calls `/auth/refresh` |
| 403 on API call | RBAC denial | Verify role has the module permission in `lib/permissions.ts` |
| Sidebar item missing | Role can't view that module | Expected — change role or permission matrix |
| TS errors `req.params: string \| string[]` | Express 5 type quirk | Cast: `req.params["id"] as string` |
| Schema change not reflected | Forgot to push | `pnpm --filter @workspace/db run push` |
| Generated hooks missing | Forgot codegen | `pnpm --filter @workspace/api-spec run codegen` |
| Empty preview pane | API or web workflow not running | `restart_workflow` and check logs |

### Logs

- API server: `/tmp/logs/artifactsapi-server_API_Server_*.log`
- Web app: `/tmp/logs/artifactsuniliv-admin_web_*.log`
- Browser console: `/tmp/logs/browser_console_*.log`

Use `refresh_all_logs` (Replit tool) to capture and rotate logs.

### Default admin credentials

```
Email:    admin@uniliv.com
Password: Admin@123
```

Change this immediately in any non-development environment.

---

## Appendix — Useful File Paths

| Concern | File |
|---------|------|
| FE permissions matrix | `artifacts/uniliv-admin/src/lib/permissions.ts` |
| FE permission hook    | `artifacts/uniliv-admin/src/lib/use-permissions.ts` |
| FE API fetch helper   | `artifacts/uniliv-admin/src/lib/api-fetch.ts` |
| FE state store        | `artifacts/uniliv-admin/src/lib/store.ts` |
| FE layout / sidebar   | `artifacts/uniliv-admin/src/components/layout.tsx` |
| FE notification bell  | `artifacts/uniliv-admin/src/components/notification-bell.tsx` |
| FE 403 page           | `artifacts/uniliv-admin/src/pages/forbidden.tsx` |
| BE permissions matrix | `artifacts/api-server/src/lib/permissions.ts` |
| BE authorize mw       | `artifacts/api-server/src/middlewares/authorize.ts` |
| BE auth mw            | `artifacts/api-server/src/middlewares/auth.ts` |
| BE id helper          | `artifacts/api-server/src/lib/id.ts` |
| BE route registry     | `artifacts/api-server/src/routes/index.ts` |
| Drizzle schema entry  | `lib/db/src/schema/index.ts` |
| OpenAPI spec          | `lib/api-spec/openapi.yaml` |
