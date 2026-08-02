# UNILIV Admin Portal

A multi-property co-living management platform covering operations, residents, complaints, laundry,
HR, procurement, kitchen, sales CRM, finance, and analytics — built as a pnpm monorepo with React +
Vite (web), Express + Drizzle ORM (API), and PostgreSQL.

## Architecture

```
apps/
  uniliv-admin/    React + Vite + TS web app
  api-server/      Express + Drizzle + JWT API
  mockup-sandbox/  Component preview / design canvas
lib/
  db/              Drizzle schema + client (shared)
  api-spec/        OpenAPI spec + Zod schemas
  api-client-react/  Generated React Query hooks
```

## Setup

```bash
pnpm install
pnpm --filter @workspace/db run push        # apply schema to PostgreSQL
pnpm --filter @workspace/api-server run seed # seed demo data (if available)
```

Workflows are managed by Replit:

- `apps/api-server: API Server` → Express on `:8080`, served at `/api`
- `apps/uniliv-admin: web` → Vite dev server, served at `/`

For ad-hoc requests use the shared proxy: `curl localhost:80/api/healthz`.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | JWT signing secret |
| `PORT` | Yes | API port (set by workflow) |
| `RAZORPAY_KEY_ID` | No | Enables Razorpay integration in Settings |
| `TWILIO_AUTH_TOKEN` | No | Enables Twilio SMS integration |
| `SMTP_HOST` | No | Enables SMTP integration |

## Default Login

```
Email:    admin@uniliv.com
Password: Admin@123
```

## Modules

| Module | Description |
| --- | --- |
| Dashboard | Property-scoped operational KPIs |
| Executive Dashboard | Org-wide KPIs, revenue trend, occupancy, funnel, HR snapshot |
| Properties / Rooms | Property catalog and room inventory |
| Residents | Lifecycle: onboard → ledger → checkout |
| Complaints | Tickets, SLA tracking, escalations |
| Laundry | Pickups, deliveries, charges |
| Communications | Announcements, message templates |
| Employees / Attendance / Leaves | HRMS core |
| Recruitment | Job postings, applicants |
| L&D | Courses and enrollments |
| Vendors / Indents / POs / GRN / Inventory | Procurement |
| Recipes / Menu Planning | Kitchen |
| Sales CRM / Property Leads | Growth |
| Ledger / Payments | Finance |
| Users & Roles | RBAC management |
| Settings | SLA, routing, notifications, integrations |

## RBAC Matrix

12 roles, 25 modules. Defined in:

- Backend: `apps/api-server/src/lib/permissions.ts` + `middlewares/authorize.ts`
- Frontend: `apps/uniliv-admin/src/lib/permissions.ts` + `lib/use-permissions.ts`

| Role | Modules |
| --- | --- |
| SUPER_ADMIN | All (full) |
| HR_MANAGER | Employees, Recruitment, L&D, Users, Settings (view) |
| OPERATIONS_MANAGER | Properties, Residents, Complaints, Laundry, Communications |
| PROCUREMENT_MANAGER | Vendors, Indents, POs, GRN, Inventory |
| KITCHEN_MANAGER | Recipes, Menu Planning, Inventory (view) |
| PROJECTS_MANAGER | Property Leads, Finance (view), Procurement (view) |
| PROPERTY_ACQUISITION | Property Leads |
| FINANCE | Executive, Residents (view), Ledger, Payments, Procurement (view) |
| SALES_EXECUTIVE | Sales CRM, Sales Dashboard, Property Leads (view) |
| WARDEN | Properties (view), Residents, Complaints, Laundry, Communications |
| VENDOR_RESTRICTED | Dashboard placeholder |
| AUDIT_READONLY | All (view-only) |

## Notification System

Auto-generated per-user notifications: `COMPLAINT_SLA_BREACH`, `PAYMENT_OVERDUE`,
`LEAVE_APPROVAL_PENDING`, `INDENT_APPROVAL_PENDING`, `LOW_STOCK`, `DOCUMENT_EXPIRY`,
`LEASE_RENEWAL`. The bell in the topbar polls `/api/notifications` every 30 seconds.

API:

- `GET /api/notifications` — last 20 + unread count
- `PATCH /api/notifications/:id/read`
- `PATCH /api/notifications/read-all`

## Health Check

```
GET /api/healthz → { status: "ok" }
```

## Deployment

Replit autoscale deployment configured via the artifact toml files. Build + start are managed per
artifact; the shared proxy multiplexes `/api/*` to the API server and everything else to the web
app. Set `DATABASE_URL` and `SESSION_SECRET` in Replit Secrets before publishing.
