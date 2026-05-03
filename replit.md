# UNILIV ADMIN - Compressed Overview

## Overview

UNILIV Admin is a comprehensive multi-property co-living management platform designed as a full-stack monorepo web application. It serves as an operations command center for student and young-professional co-living properties, integrating over 12 operational modules including Properties, Rooms, Residents, Complaints, HRMS, Procurement, Kitchen, Sales/CRM, L&D, Property Acquisition, Users, and Announcements. The platform aims to streamline property management, enhance resident experience, optimize operational efficiency, and drive business growth in the co-living sector.

## User Preferences

- The AI assistant should communicate in clear, concise language.
- I prefer an iterative development approach with regular updates and feedback points.
- Please ask for confirmation before implementing major architectural changes or significant feature modifications.
- Focus on delivering functional components that align with the outlined feature specifications.

## System Architecture

UNILIV Admin is built as a full-stack monorepo.

### Stack
-   **Frontend**: React with Vite and TypeScript, styled using Tailwind CSS and shadcn/ui. State management is handled by Zustand for authentication, and TanStack Query for data fetching. Routing is managed by `wouter`, and charts are rendered with Recharts. Lucide icons are used for iconography.
-   **Backend**: Express 5, using Drizzle ORM with a PostgreSQL database. JWT-based authentication is implemented using `jsonwebtoken` and `bcryptjs`.
-   **API Client**: Orval generates React Query hooks from an OpenAPI specification, providing a type-safe and efficient way to interact with the backend API.

### Monorepo Structure
The project is organized into `artifacts/` for deployable applications (API server and frontend), `lib/` for shared libraries (DB schema, OpenAPI spec, generated Zod schemas, API client), and `scripts/` for utilities like database seeding.

### Database Schema (PostgreSQL via Drizzle)
The Drizzle ORM schema is modularized into `core.ts`, `hrms.ts`, `procurement.ts`, `kitchen.ts`, `sales.ts`, and `lnd.ts`, covering all major operational domains with specific tables and fields for properties, residents, employees, inventory, leads, courses, and more. Key additions include detailed fields for kitchen recipes and menu planning, comprehensive sales lead tracking with activity logs, and detailed L&D course management with progress tracking and quizzes.

### UI/UX and Design System
The application features a dark navy sidebar (240px wide) with 8 grouped navigation sections and a topbar for global actions. The design system leverages CSS variables for a consistent color palette (primary, accent, success, warning, danger), Google Fonts (Sora for display, DM Sans for body, JetBrains Mono for code), and reusable components for common UI patterns (e.g., `PageHeader`, `DataTable`, `StatCard`, `FormModal`).

### Technical Implementations and Feature Specifications
-   **Authentication**: JWT-based with an access token (15min) and a refresh token (7d, httpOnly cookie). Access tokens are stored in `localStorage`. All API routes are protected by an `authenticate` middleware.
-   **Kitchen Operations**: Includes recipe management (CRUD), weekly menu planning per property with ingredient auto-computation for indents, daily production tracking, and analytics.
-   **Sales CRM**: Features a Kanban and List view for lead management across 7 stages, detailed lead tracking with activity logs, CSV export, and a sales dashboard with funnel charts. Property acquisition tracking includes a viability calculator and map integration.
-   **Learning & Development**: Manages a course library with enrollment and completion tracking. Course content viewing includes secure video and PDF viewers with progress tracking and quizzes.
-   **Properties & Residents**: Manages property listings with occupancy, room inventory, and resident directories. Features a multi-step resident onboarding, ledger management, payment processing, and a check-out flow. Bulk rent charging and client-side PDF generation for agreements and receipts are supported.
-   **HRMS**: Comprehensive employee management including attendance, leave management, performance tracking, recruitment pipeline with interviews and offers, and an exit management workflow with clearance checklists. Atomic updates are used for attendance and leave balance reconciliation.
-   **Procurement & Inventory**: Manages vendors, rate contracts, purchase orders, goods receipt notes (GRN), and inventory. GRN processing is fully transactional, ensuring atomic stock updates and movements. Auto-generated numbers for indents and POs are implemented with unique retry mechanisms to prevent race conditions. Inventory includes stock alerts and audit capabilities.
-   **API Design**: All API routes are prefixed with `/api/`. Custom endpoints are used for specific functionalities not covered by OpenAPI codegen (e.g., bulk operations, detailed HRMS and Procurement sub-routes).
-   **Operations (Facility, Electricity, Resident Attendance, Out-Pass, IoT)**: Facility module covers assets, preventive maintenance schedules, and maintenance logs. Electricity module includes tariffs, meters with room/resident assignment, readings (with bulk upload mapping meterNo→meterId), and post-to-ledger conversion. Resident Attendance supports daily roster with bulk mark via items[] payload and 120-day history. Out-Pass workflow covers create, approve/reject via PUT, and return marking. IoT module manages devices, latest snapshots (with property/room joins), and an ingestion endpoint. All operations endpoints have full OpenAPI coverage with generated React Query hooks (useGet*) used for queries; mutations use apiFetch.
-   **Data Handling**: Drizzle `numeric` columns are converted to `Number()` in API responses. All numeric DB fields are stored as `text` in the database to prevent precision issues but are returned as `number` by the API.
-   **Phase 8 (RBAC + Notifications + Executive Dashboard)**: 12-role × 25-module permission matrix shared between FE (`src/lib/permissions.ts`, `use-permissions.ts`) and BE (`src/lib/permissions.ts`, `middlewares/authorize.ts`). Sidebar items, page routes (`PageGuard`), and action buttons are filtered/blocked based on `can(module, perm)`. Backend `/api/executive/*` and `/api/settings/*` are guarded with `authorize()`. New tables: `notifications`, `audit_log`, `sla_config`, `complaint_routing`, `integration_status`. Bell in topbar polls `/api/notifications` every 30s. Executive Dashboard at `/dashboard/executive` (SUPER_ADMIN + FINANCE) renders KPIs, revenue trend, occupancy, complaint resolution donut, lead funnel, headcount, and SLA-breach / overdue tables. Settings page now has tabs: General | SLA | Routing | Notifications | Integrations. Dark mode toggle in topbar persists to localStorage. README.md documents setup, env vars, RBAC matrix, and modules.
-   **Portfolio sub-types (Task #1)**: Properties carry a `portfolio_type` enum (CO_LIVING, STUDENT_HOUSING, SERVICED_APARTMENTS, PG, COLLEGE_HOSTEL, COWORKING, MANAGED_OFFICE) and a `portfolio_attributes` JSON column for type-specific fields (institution, academic year, gender, meal plan, nightly/weekly rate, desk/private offices, seat capacity, lease term). Surfaced via portfolio selector + conditional fields in the property form, a Type column + filter on the properties list, a type-specific Details card on property detail, and a Portfolio Breakdown chart on the executive dashboard (`GET /executive/portfolio-breakdown`). Helper at `src/lib/portfolio-types.ts`.
-   **Finance automation (Task #2)**: Recurring billing cycles (MONTHLY/WEEKLY/CUSTOM_DAYS) with scheduler catch-up for missed runs; reminder rules dispatched via INAPP/EMAIL/SMS into `notifications` + `communication_logs`; smart banking with CSV import, statement-line reconciliation against ledger entries (auto-flips to RECONCILED); expense management with category, approval state machine, and audit. New finance pages: `billing-cycles`, `reminders`, `banking`, `expenses`, plus per-resident reminders tab. Auto badge on ledger entries created by recurring runs. Migration `0002_finance_automation.sql`.
-   **E-sign & Digital KYC (Task #4)**: KYC requests (`kyc_requests`) with admin verify flow, optional ID front/back/selfie image upload (4MB cap, stored as base64 dataURLs with thumbnail rendering), pluggable provider adapter (`lib/kyc-providers.ts`, ManualKYCProvider stub), and an audit log (`kyc_events`) of CREATED/VERIFIED/REJECTED/REOPENED. E-sign requests (`esign_requests`) with token-gated public signer page (`/esign/sign/:token`) using HTML5 canvas (mouse + touch); on sign, a PDF is generated via `pdf-lib` (document body + embedded signature image + signer name/IP/timestamp), stored as base64 on `signed_pdf`, and downloadable via `GET /esign/:id/pdf`. Configurable activation gate (`integration_status` row "KYC_GATE", toggle in Settings) blocks setting a resident to ACTIVE on both POST and PUT `/residents` unless they have a verified KYC and at least one signed e-sign agreement. KYC/E-sign compliance badges on the residents list.
-   **Bookings for nightly/weekly stays (Task #7)**: New `bookings` table with `booking_status` and `rate_period` enums. `/bookings` routes provide list/get/create/update/cancel and a 14-day availability endpoint. Overlap protection uses exclusive bounds (allows back-to-back same-day stays) and only considers CONFIRMED + CHECKED_IN. Invoice computation pulls nightly/weekly rates from the property's `portfolio_attributes`. Cancel is a soft DELETE → status=CANCELLED to preserve audit. Admin UI exposes a Bookings tab on property-detail visible only when `portfolio_type = SERVICED_APARTMENTS`, with booking list, availability calendar, and a BookingFormModal with live invoice preview. Migration `0004_bookings.sql`.

## External Dependencies

-   **PostgreSQL**: Primary database for all application data, accessed via Drizzle ORM.
-   **Nominatim OpenStreetMap**: Used for geocoding addresses in the Properties module.
-   **OpenStreetMap (iframe embed)**: Used for displaying property locations without requiring an API key.
-   **Leaflet**: JavaScript library for interactive maps, specifically used in the Property Leads module.
-   **jsPDF**: Client-side library for generating PDF documents (e.g., resident agreements, payment receipts, offer letters).
-   **Razorpay**: Payment gateway (currently stubbed in UI, requiring API keys for activation).