# Food Module — Knowledge Transfer

Handoff doc for the Food & Beverage (F&B) module: kitchen ops, order lifecycle,
dispatch. Read top-to-bottom once; the **Gotchas** section is where the pain is.

---

## 1. Mental model

Residential-property food ops. A **unit lead** at a property orders meals for its
residents; a central **kitchen** cooks them; a **delivery agency** drives them over.
The module is three roles cooperating around one order as it moves through a
lifecycle. Get the lifecycle (§3) and the permission split (§6) and the rest follows.

## 2. Personas — who does what

| Role | Does | Home screen |
|---|---|---|
| **Unit Lead** (`UNIT_LEAD`) | Places orders for their property, confirms delivery, logs waste | Food Overview (journey dashboard) |
| **F&B Manager** (`FNB_MANAGER`) | Runs ONE kitchen (one login per kitchen, KITCHEN-scoped): accept → cook → dispatch; owns recipes/menu/masters | Kitchen Home |
| **Admin** (`SUPER_ADMIN`) | Everything; the only role that sees "All Orders" | /apps launcher |

F&B owns the **middle** of the flow (accept → prepare → dispatch). The unit lead
owns the ends (place, receive). **One F&B login per kitchen** (FNB_MANAGER role + a
KITCHEN `user_scopes` row); the all-kitchens head is `OPS_EXCELLENCE`
(`opsexcellence@uniliv.com`). Kitchen-scoped demo logins: `fnb.koramangala@` /
`fnb.whitefield@` / `fnb.hinjewadi@uniliv.com` (Admin@123).

## 3. Order lifecycle (the core state machine)

```
PLACED ─accept→ ACCEPTED ─prepare→ PREPARING ─dispatch→ DISPATCHED ─deliver→ DELIVERED
   │                │                                                    
   └──reject────────┴──→ REJECTED            (any early state) ──→ CANCELLED
```

- Enforced server-side in **`artifacts/api-server/src/lib/order-transitions.ts`**
  (`ORDER_NEXT` table + `canTransition(from,to)`). Every transition must be legal —
  no skipping. Every transition writes a row to **`food_order_events`** (event-sourced
  timeline; the Track page renders it).
- Who triggers what: unit lead = PLACED / (DELIVERED via confirm); F&B = ACCEPTED,
  PREPARING (Kitchen board), DISPATCHED (Dispatch board).
- **Waste** is only editable for a window after delivery (`wasteEditableUntil`).

## 4. Frontend map (`artifacts/uniliv-admin/src/`)

| Page (`pages/`) | Purpose |
|---|---|
| `food-dashboard.tsx` | Unit lead's "journey" home — place/receive/waste inline per meal |
| `food-kitchen-home.tsx` | **F&B home (journey)** — day toggle, meal tabs, cook plan, accept/cook, review-&-dispatch dialog (editable preparedQty per dish) |
| `food-kitchen-summary.tsx` | Detailed cook-plan sheet with per-property splits + accept/prepare panel |
| `food-dispatch.tsx` | **"Load the van"** — group PREPARING orders into a trip, send |
| `food-track.tsx` | Per-order status timeline (from `food_order_events`) |
| `food-orders.tsx` / `food-order-detail.tsx` | "All Orders" list + detail (admin/order-read only) |
| `food-reports.tsx`, `food-waste-analytics.tsx` | Reporting |
| `food-organization.tsx`, `food-agencies.tsx`, `food-settings.tsx` | Config / masters |
| `menu-planning.tsx`, `recipes`/`kitchen.tsx`, `shared-menu.tsx` | Menu & recipes |

Key libs/components:
- **`lib/food-api.ts`** — the typed API client + shared types + status pill maps. Start here.
- **`lib/permissions.ts`** + **`lib/use-permissions.ts`** — `can(module, action)`, `homeForRole()`.
- **`lib/nav.ts`** — sidebar/launcher entries (`module` gates by grant, `hideFor` hides per-role).
- `components/meal-icon.tsx`, `property-options.tsx` (city-grouped picker), `property-scope-banner.tsx`.

## 5. Backend map (`artifacts/api-server/src/`)

| File | Purpose |
|---|---|
| `routes/food.ts` | Orders CRUD/list, dashboard, kitchen-summary aggregation, track, drafts, lookups |
| `routes/food-ops.ts` | **Dispatch/trips** (create, depart, deliver, cancel), waste |
| `lib/order-transitions.ts` | The state machine (`canTransition`) |
| `lib/food-service.ts` | Property-scope resolution (`resolveAccessiblePropertyIds`, broad-fallback set) |
| `lib/permissions.ts` | Server mirror of the role→module grant matrix (keep in sync with FE) |
| `middlewares/authorize.ts` | `authorize(module, perm)` and `authorizeAny([modules], perm)` |

## 6. Permissions model (important + non-obvious)

- **Modules** (`FOOD_KITCHEN_SUMMARY`, `FOOD_DISPATCH`, `FOOD_ALL_ORDERS`, …) are granted
  per role in `permissions.ts` — mirrored on **both** FE and BE; edit both.
- **The key split:** F&B roles get the operational boards (Kitchen, Dispatch) but **not**
  `FOOD_ALL_ORDERS` (no "All Orders" page, no per-order tracking). But the Dispatch queue
  and Kitchen board both read from the shared `GET /food/orders` endpoint, so it's gated
  with **`authorizeAny([FOOD_ALL_ORDERS, FOOD_DISPATCH, FOOD_KITCHEN_SUMMARY])`** — and it
  **clamps** non-`FOOD_ALL_ORDERS` callers to live statuses (PLACED/ACCEPTED/PREPARING/
  DISPATCHED) so they can't pull terminal history. `GET /food/orders/:id` and `/orders/track`
  stay `FOOD_ALL_ORDERS`-only. **If you add a food surface for F&B, respect this split.**
- **Scope:** results are property-scoped via `resolveAccessiblePropertyIds`, but F&B roles
  are in the *broad-fallback* set — an unscoped F&B user sees all properties until scope rows exist.

## 7. Data model (key tables — `lib/db/src/schema/food.ts`)

- **`food_orders`** — the order (status, meal_type, service_date [IST day], kitchen_id, dispatch_id…)
- **`food_order_events`** — append-only lifecycle log (drives Track)
- **`food_dispatches`** — a trip (agency, kitchen, vehicle, status LOADING→IN_TRANSIT→DELIVERED)
- **`agency_kitchens`** — which delivery agency serves which kitchen. **A kitchen with no active
  link here can't be dispatched** (see Gotchas).
- **`kitchens`**, **`user_scopes`** (zone/city/cluster/property scoping), `agencies`, `properties`.

## 8. Gotchas (read this)

1. **A van is ONE kitchen.** Dispatch enforces single-kitchen trips; the server *derives* the
   kitchen from the orders (`food-ops.ts` POST /dispatches) and validates the agency serves it —
   don't trust a client-sent kitchenId.
2. **`agency_kitchens` must be linked** or dispatch shows a "no partner — link in Masters" warning
   and can't send. Seed/prod data has had kitchens with zero agencies (fixed Noida/Jaipur; also
   watch for **duplicate kitchen rows** per city — one real, one empty).
3. **Dates are IST.** `service_date` is a timestamp anchored to IST day-start; the place-order
   cut-off is IST in code regardless of `TZ`. Filter with the half-open IST day window.
4. **Schema is `drizzle-kit push`, not migrations.** `pnpm --filter @workspace/db run push`
   syncs the DB to the code schema. No versioned SQL migration files.
5. **Seeds order matters:** `seed` → `seed:food` → **`seed:food-extra` (after food; now-relative dates)** → `seed:audit`.
6. **No dotenv.** Apps read env from the process; `set -a; source .env; set +a` before running.
   API & Web both throw if `PORT` unset; Web also needs `BASE_PATH` + `API_PROXY_TARGET`.
7. **Keep FE/BE `permissions.ts` in sync** — they're two copies of the same matrix.

## 9. Run & verify locally

See `docs/…setup` (or the README). Short version: Node 22, pnpm 10.30.3, local Postgres `uniliv`,
`.env` at root, `pnpm install` → `db push` → seeds → run API (`PORT=8090 … api-server dev`) +
Web (`PORT=5173 BASE_PATH=/ API_PROXY_TARGET=http://localhost:8090 … uniliv-admin dev`).
Login `admin@uniliv.com` / `Admin@123`, OTP `000000` (`ALLOW_DEV_OTP=true`).

## 10. Recent work & open items

**Recently shipped** (see `git log` around the "food-dispatch" / "food-ops" / "food" commits):
gamified redesign of the whole Food module; "Load the van" dispatch builder; end-to-end order-
lifecycle enforcement; F&B order-list access fix (authorizeAny + status clamp).

**Open / product-gated:** gamified Audits Home (needs endpoints), Reports date-range/status filters,
sidebar nav badge counts, duplicate-kitchen cleanup (Noida/Jaipur), optional `FOOD_DELIVERY_TRACKING`
gating to open Track to F&B personas.
