# Food Module — Exhaustive Manual Test Cases

Covers the UNILIV **Food Ordering & Kitchen Ops** module: order placement → kitchen
accept/reject/prepare → dispatch ("Load the van") → delivery confirmation → waste tracking,
plus masters (dishes, ingredients, menu rotation, composition rules, portion rules, cut-offs,
kitchens, brands, org hierarchy, agencies, user scopes), reports/analytics/exports, the public
menu-share link, RBAC, property scoping, and DB-level validation.

**API base:** all endpoints are under `/api/food` (both `food.ts` and `food-ops.ts` mount there).
Ad-hoc calls go through the proxy: `curl localhost:80/api/food/...`.

---

## 0. Test setup & reference data

### 0.1 Environment
- Default admin login: `admin@uniliv.com` / `Admin@123` (SUPER_ADMIN — org-wide).
- Servers run as Replit workflows (`API Server`, `web`). Never `pnpm dev` at root.
- DB inspection: query PostgreSQL directly (`food_orders`, `food_order_items`, `food_dispatches`,
  `food_order_events`, etc.). No migration files — schema applied via `drizzle-kit push`.

### 0.2 Seed data required before testing
| Item | Needed for |
|---|---|
| ≥2 properties, each with a **brand** and **kitchen** assigned (via pincode map or manual) | order placement, scoping |
| ≥1 property deliberately **without** brand/kitchen | "not configured" negatives |
| Active `food_brands` (e.g. `UNILIV`, `HUDDLE`) + one inactive brand | brand validation |
| Kitchens with unique `code`; `kitchen_pincodes` rows (6-digit, globally unique) | pincode → kitchen derivation |
| Dishes with `component`, `unit`, `brands[]`, `preparations[]` | menu, composition |
| `per_resident_rules` for the dishes (brand, mealType, dishId, qtyPerResident, unit) | quantity compute |
| `food_menu_rotation` rows (kitchen, brand, mealType, week, day, dish) | Kitchen Summary / preview |
| `food_cutoffs` row per brand (HH:MM) | cut-off enforcement |
| Agencies with vehicles + locations + `agency_kitchens` links | dispatch |
| Users of each role listed in §0.3 | permission tests |

### 0.3 Roles reference (Food)
| Role | Scope | Food access summary |
|---|---|---|
| SUPER_ADMIN, OPS_EXCELLENCE | org-wide | FULL on all 12 FOOD_* modules |
| AUDIT_READONLY | org-wide | VIEW on all FOOD_* |
| UNIT_LEAD | **property-scoped** | place/edit orders, confirm delivery, waste, all-orders VIEW, dashboard/reports VIEW; **no** kitchen-summary/dispatch/org |
| CLUSTER_MANAGER | org-wide (food self-scopes) | all-orders FULL, dispatch VIEW, receive/confirm/waste FULL; no kitchen-summary; no org/settings |
| CITY_HEAD, ZONAL_HEAD | org-wide | all-orders FULL, dispatch VIEW; no kitchen-summary/org/settings |
| SENIOR_VICE_PRESIDENT | org-wide | dispatch VIEW, kitchen-summary VIEW, place/confirm/waste VIEW, reports VIEW; **no FOOD_ALL_ORDERS** |
| FNB_SUPERVISOR | org-wide | kitchen-summary FULL, dispatch FULL; **no FOOD_ALL_ORDERS**; no settings/org |
| FNB_MANAGER | org-wide | kitchen-summary FULL, dispatch FULL, **FOOD_SETTINGS FULL**, RECIPES/MENU_PLANNING FULL; **no FOOD_ALL_ORDERS**, no FOOD_ORG; lands on `/food/kitchen-summary` |
| FNB_ZONAL_HEAD | org-wide | kitchen-summary FULL, dispatch FULL; no settings/org |
| Roles with **no** food access (negatives) | — | HR_MANAGER, OPERATIONS_MANAGER, PROCUREMENT_MANAGER, KITCHEN_MANAGER, PROJECTS_MANAGER, PROPERTY_ACQUISITION, FINANCE, SALES_EXECUTIVE, WARDEN, VENDOR_RESTRICTED, CUSTOMER_EXPERIENCE |

**FOOD_ORG** is granted **only** to SUPER_ADMIN / OPS_EXCELLENCE (FULL) and AUDIT_READONLY (VIEW).

### 0.4 State machines (reference for expected results)
**Order:** `PLACED → ACCEPTED → PREPARING → DISPATCHED → DELIVERED`; off-ramps
`PLACED/ACCEPTED → REJECTED`, `PLACED/ACCEPTED/PREPARING → CANCELLED`. Terminal:
DELIVERED / CANCELLED / REJECTED.

**Dispatch:** `LOADING → {IN_TRANSIT, CANCELLED}`; `IN_TRANSIT → {DELIVERED, PARTIAL, CANCELLED}`;
`PARTIAL → {DELIVERED, IN_TRANSIT}`; `DELIVERED` / `CANCELLED` terminal.

---

## A. Order Placement (Unit Lead / place-order)

`POST /api/food/orders` (single meal), `POST /api/food/order-batches` (multi-meal), draft APIs,
and the Food Overview place-order UI.

### A1. Happy path
| ID | Title | Steps | Expected |
|---|---|---|---|
| A1-01 | Place single-meal order (API) | As UNIT_LEAD, `POST /orders` with valid `propertyId`, `mealType=LUNCH`, `serviceDate` (future, before cut-off), `quantity=25` | `201`; `data.status=PLACED`, `unitLeadId`=caller, `totalQuantity=25`, `orderNumber` matches `ORD-YYYY-000001` format; `items[]` computed from per-resident rules; a `food_order_events` PLACED row exists |
| A1-02 | Place multi-meal batch | `POST /order-batches` with 3 meals for one property/date | `201`; one `food_order_batches` row (`BATCH-YYYY-######`), one `food_orders` row **per meal**, each PLACED; each linked via `batchId` |
| A1-03 | Item quantities auto-compute | Place order qty=10, dish rule `qtyPerResident=0.15 KG` | item `orderedQty = round(10 × 0.15 × 1000)/1000 = 1.5 KG` |
| A1-04 | Dish without per-resident rule is skipped | Menu has dish A (has rule) + dish B (no rule) | Order items include only dish A; dish B omitted |
| A1-05 | `expectedDeliveryAt` resolved | Property/brand has a meal window with serviceTime + leadTime | `expectedDeliveryAt = serviceDate@serviceTime + leadTimeMinutes` |
| A1-06 | Place order via UI | Food Overview → Tomorrow's order → set headcount → Send | Confetti + success toast; order appears in All Orders as PLACED |
| A1-07 | Per-item edit in UI | Pencil-edit a dish qty before sending | Only items with `orderedQty > 0` are submitted; edited qty persists |

### A2. Negative / validation
| ID | Title | Steps | Expected |
|---|---|---|---|
| A2-01 | Missing required field | `POST /orders` without `quantity` | `400 "propertyId, mealType, serviceDate, quantity required"` |
| A2-02 | Invalid mealType | `mealType=BRUNCH` | `400 "Invalid mealType: BRUNCH"` |
| A2-03 | Zero / negative quantity | `quantity=0`, then `-5` | `400 "quantity must be a positive number"` |
| A2-04 | Non-numeric quantity | `quantity="abc"` | `400 "quantity must be a positive number"` |
| A2-05 | Unparseable serviceDate | `serviceDate="not-a-date"` | `400 "Invalid serviceDate"` |
| A2-06 | Property not accessible | UNIT_LEAD of property P1 orders for P2 | `403 "Property not accessible"` |
| A2-07 | Property missing brand/kitchen | Order for the unconfigured property | `422 "This property is not configured for ordering (missing brand or kitchen)."` |
| A2-08 | Past service date | `serviceDate` = yesterday | `422 "Cannot place an order for a past date."` |
| A2-09 | After cut-off | serviceDate=today, current time past cut-off | `422 "Ordering for DD/MM/YYYY is closed — the HH:MM cut-off has passed."` |
| A2-10 | Beyond next service day | serviceDate too far ahead | `422 "Orders can only be placed for the next service day (DD/MM/YYYY)."` |
| A2-11 | Duplicate meal (batch) | Place LUNCH, then batch containing LUNCH again same property/date | `409 "An order for the selected meal(s) already exists for this date."` |
| A2-12 | Batch missing meals | `POST /order-batches` with empty `meals` | `400 "propertyId, serviceDate and at least one meal required"` |
| A2-13 | Batch invalid serviceDate | bad date | `400 "Invalid serviceDate"` |
| A2-14 | Duplicate meal partial | Batch of LUNCH(exists)+DINNER(new) | `201`; only DINNER created, LUNCH silently skipped as already-ordered |

### A3. Edge cases
| ID | Title | Steps | Expected |
|---|---|---|---|
| A3-01 | Cancelled meal re-orderable | Place LUNCH → cancel it → place LUNCH again same date | Second placement succeeds (dedup ignores CANCELLED/REJECTED) |
| A3-02 | Order-number seq gap-proof | Delete highest order row, place new order | New `orderNumber` = max+1 (derived from max, not count) |
| A3-03 | Fractional headcount UI step | KG/L dish uses step 0.5; PLATE/PCS uses step 5/1 | Stepper honors unit-specific step |
| A3-04 | Headcount min 1 | UI stepper at 1, press minus | Stays at 1 (min enforced), no max |
| A3-05 | Large quantity | `quantity=100000` | Accepted; items scale (watch numeric(12,3) range) |
| A3-06 | Inactive brand on property | Property brand code deactivated | Placement should fail config/brand validation (verify behavior) |
| A3-07 | Menu empty for meal | Property configured but rotation has no dishes for that meal/day | Order created with **no items** or meal skipped — verify no crash |

### A4. Server-side drafts
| ID | Title | Steps | Expected |
|---|---|---|---|
| A4-01 | Save draft | `PUT /order-draft` `{propertyId, serviceDate(yyyy-MM-dd), payload}` | `200 {updatedAt}`; upsert on (userId, propertyId, serviceDate) |
| A4-02 | Read draft | `GET /order-draft?propertyId=..&serviceDate=yyyy-MM-dd` | Returns `{payload, updatedAt}` or `null` |
| A4-03 | Delete draft | `DELETE /order-draft?...` | `200 {data:null}`; row removed |
| A4-04 | Bad draft key | `GET /order-draft` no propertyId | `400 "propertyId required"` |
| A4-05 | Bad serviceDate format | `serviceDate=2026/07/17` | `400 "serviceDate must be yyyy-MM-dd"` |
| A4-06 | Oversize payload | `PUT` payload > 64 KB JSON | `413 "payload too large (max 64KB)"` |
| A4-07 | Draft property not accessible | Draft for a foreign property | `403 "Property not accessible"` |
| A4-08 | Draft isolation | User B reads user A's draft key | Returns null (drafts keyed per authenticated user) |
| A4-09 | Past-day cleanup | Save draft, advance day, save another | Prior past-day drafts opportunistically deleted |
| A4-10 | UI autosave | Type in place-order form | Debounced 800 ms autosave; restored on reload once; switching property resets |

---

## B. Kitchen accept / reject / prepare (order fulfillment)

### B1. Accept `POST /orders/:id/accept` (FOOD_KITCHEN_SUMMARY:edit)
| ID | Title | Steps | Expected |
|---|---|---|---|
| B1-01 | Accept PLACED order | FNB_MANAGER accepts a PLACED order | `200`; status ACCEPTED; `acceptedAt`, `acceptedById` stamped; ACCEPTED event; notify sent |
| B1-02 | Accept non-PLACED | Accept an ACCEPTED/PREPARING order | `422 "Only PLACED orders can be accepted"` |
| B1-03 | Accept missing order | `:id` nonexistent | `404 "Not found"` |
| B1-04 | Accept out-of-scope | Scoped user, order of foreign property | `403 "Order not accessible"` |
| B1-05 | Accept without permission | UNIT_LEAD (no kitchen-summary) | `403` (authorize gate) |

### B2. Reject `POST /orders/:id/reject`
| ID | Title | Steps | Expected |
|---|---|---|---|
| B2-01 | Reject PLACED with reason | `{reason:"kitchen closed"}` | `200`; status REJECTED; `rejectedAt`, `rejectionReason` set; event; notify with reason |
| B2-02 | Reject ACCEPTED | Reject an ACCEPTED order | `200` (PLACED/ACCEPTED both rejectable) |
| B2-03 | Reject PREPARING/DISPATCHED | | `422 "Only PLACED/ACCEPTED orders can be rejected"` |
| B2-04 | Reject no reason | omit `reason` | `200`; `rejectionReason` null |
| B2-05 | Reject terminal order | Reject a DELIVERED/CANCELLED | `422` |

### B3. Prepare `POST /orders/:id/prepare`
| ID | Title | Steps | Expected |
|---|---|---|---|
| B3-01 | Prepare ACCEPTED order | | `200`; status PREPARING; `preparingAt` set; each item `preparedQty = orderedQty` where null; PREPARING event |
| B3-02 | Prepare PLACED (not accepted) | | `422 "Cannot mark preparing — order is PLACED. It must be ACCEPTED first."` |
| B3-03 | Prepare DISPATCHED | | `422` (invalid transition) |
| B3-04 | preparedQty preserved | Manually set an item preparedQty, then prepare | Only null preparedQty items overwritten; existing kept |

---

## C. Dispatch — "Load the van"

`POST /dispatches` (create trip), `PATCH /dispatches/:id/status`, `PATCH /dispatches/:id/orders/:orderId`,
`POST /dispatches/:id/cancel`, `POST /orders/dispatch/bulk`, `POST /orders/:id/dispatch`.

### C1. Create trip — happy path (FOOD_DISPATCH:edit)
| ID | Title | Steps | Expected |
|---|---|---|---|
| C1-01 | Load van, one kitchen | `POST /dispatches` `{orderIds:[PREPARING orders, same kitchen], agencyId, vehicleId}` where agency serves that kitchen | `201`; one `food_dispatches` (`DISP-YYYY-000001`, status LOADING); each order → DISPATCHED with `dispatchId`, `dispatchedAt`; DISPATCHED event per order; notify per order; `dispatchedCount` = order count |
| C1-02 | Depart now | add `departNow:true` | Trip LOADING → IN_TRANSIT; extra dispatch event |
| C1-03 | UI trip builder | Queue → tap PREPARING cards → pick driver → "Send it off" | Confetti; auto-switch to Trips tab; van resets |
| C1-04 | Load all (same kitchen) | Van empty, click "Load all" | Loads only same-kitchen + null-kitchen orders |

### C2. Create trip — negative / business rules
| ID | Title | Steps | Expected |
|---|---|---|---|
| C2-01 | No orders | `orderIds:[]` | `400 "orderIds required"` |
| C2-02 | No agency | omit agencyId & deliveryPartnerId | `400 "agencyId required"` |
| C2-03 | Vehicle not in agency | `vehicleId` belongs to another agency | `422 "Vehicle does not belong to the selected agency"` |
| C2-04 | Vehicle already in use | vehicle already on a LOADING/IN_TRANSIT trip | `422 "Vehicle is already in use on an active dispatch"` |
| C2-05 | No dispatchable orders | all selected orders are PLACED/ACCEPTED (not PREPARING) | `422 "No dispatchable orders in selection — orders must be PREPARING."` |
| C2-06 | **Multiple kitchens** (one-kitchen-per-van) | select PREPARING orders from 2 different kitchens | `422 "All dispatchable orders must share one kitchen"` |
| C2-07 | Agency doesn't serve kitchen | agency has no active `agency_kitchens` link to the order kitchen | `422 "Agency does not serve this kitchen"` |
| C2-08 | Mixed dispatchable/not | 2 PREPARING + 1 PLACED, all one kitchen | `201`; only the 2 PREPARING dispatched; PLACED left untouched |
| C2-09 | UI: empty van send | Advanced drawer, no orders | "Select at least one order" |
| C2-10 | UI: no serving agency | kitchen has no serving agency | Driver select + Send replaced by warning; send impossible |
| C2-11 | UI: cross-kitchen locked | Van committed to kitchen K, other-kitchen cards | Cards disabled/dashed with tooltip; null-kitchen cards still joinable |

### C3. Dispatch status transitions `PATCH /dispatches/:id/status`
| ID | Title | Steps | Expected |
|---|---|---|---|
| C3-01 | LOADING → IN_TRANSIT | valid | `200`; status updated; dispatch event |
| C3-02 | IN_TRANSIT → DELIVERED | valid | `200`; **all linked DISPATCHED orders → DELIVERED**, `deliveredAt` + `wasteEditableUntil` set, `confirmedById` stamped, DELIVERED events |
| C3-03 | IN_TRANSIT → PARTIAL | valid | `200` |
| C3-04 | Invalid target status | `status="FLYING"` | `400 "Invalid status"` |
| C3-05 | Illegal transition | LOADING → DELIVERED | `422 "Cannot move from LOADING to DELIVERED"` |
| C3-06 | From terminal | DELIVERED → anything | `422` |
| C3-07 | Same-status no-op | set current status again | `200` (no-op allowed) |
| C3-08 | Not accessible / missing | scoped foreign / bad id | `403 "Dispatch not accessible"` / `404 "Not found"` |

### C4. Per-order delivery toggle `PATCH /dispatches/:id/orders/:orderId`
| ID | Title | Steps | Expected |
|---|---|---|---|
| C4-01 | Mark one order delivered | `{delivered:true}` | order → DELIVERED, waste window opens, `confirmedById` set, DELIVERED event |
| C4-02 | Revert delivered | `{delivered:false}` | order → DISPATCHED, `deliveredAt` cleared, "Delivery reverted" event |
| C4-03 | markTripDelivered all done | last order `{delivered:true, markTripDelivered:true}` | trip → DELIVERED (all active delivered) |
| C4-04 | markTripDelivered partial | some undelivered | trip → PARTIAL |
| C4-05 | Order not on trip | orderId not linked | `404 "Order not on this dispatch"` |
| C4-06 | Cancelled/rejected order | toggle a CANCELLED order | `422 "Cannot change a CANCELLED order"` |
| C4-07 | UI "Done" checkbox | tick per-order Done | calls toggle w/ markTripDelivered:true; disabled when busy/terminal |

### C5. Cancel dispatch `POST /dispatches/:id/cancel`
| ID | Title | Steps | Expected |
|---|---|---|---|
| C5-01 | Cancel LOADING trip | `{reason}` | trip → CANCELLED; each DISPATCHED order reverts to **PREPARING**, `dispatchId`/`dispatchedAt`/`vehicleId`/partner cleared, PREPARING event; unit-lead notified; `revertedCount` returned |
| C5-02 | Cancel IN_TRANSIT | valid | Same revert behavior |
| C5-03 | Cancel terminal trip | DELIVERED/CANCELLED | `422 "Cannot move from DELIVERED to CANCELLED"` |
| C5-04 | Not accessible / missing | | `403` / `404` |

### C6. Legacy dispatch paths
| ID | Title | Steps | Expected |
|---|---|---|---|
| C6-01 | Bulk dispatch | `POST /orders/dispatch/bulk` `{orderIds, deliveryPartnerId}` | `200`; per-order results: DISPATCHED / SKIPPED("Order is X (must be PREPARING)") / NOT_FOUND / FORBIDDEN |
| C6-02 | Bulk empty | `orderIds:[]` | `400 "orderIds required"` |
| C6-03 | Single order start | `POST /orders/:id/dispatch {action:"start"}` on PREPARING | `200`; `dispatchStartedAt` set; "Dispatch preparation started" event |
| C6-04 | Single start non-PREPARING | `action:"start"` on PLACED | `422 "Cannot start dispatch — order is PLACED. It must be PREPARING."` |
| C6-05 | Single dispatch no partner | `action:"dispatch"` no deliveryPartnerId | `400 "deliveryPartnerId required"` |
| C6-06 | Single dispatch non-PREPARING | | `422 "Cannot dispatch — order is X. It must be PREPARING."` |
| C6-07 | active-vehicles route | `GET /dispatches/active-vehicles` | Returns `{vehicleIds}` for LOADING/IN_TRANSIT trips; **not** matched as `/:id` |

### C7. Dispatch listing & detail
| ID | Title | Steps | Expected |
|---|---|---|---|
| C7-01 | List dispatches | `GET /dispatches` | ≤100 newest first, enriched kitchenName/partnerName/orderCount; scoped |
| C7-02 | Dispatch detail | `GET /dispatches/:id` | trip + orders with delivery address, unit-lead contact |
| C7-03 | Dispatch events | `GET /dispatches/:id/events` | timeline + actorName, newest first; `403` if not accessible |

---

## D. Delivery confirmation & waste

### D1. Confirm delivery `POST /orders/:id/confirm-delivery` (FOOD_CONFIRM_DELIVERY:edit)
| ID | Title | Steps | Expected |
|---|---|---|---|
| D1-01 | Confirm exact | DISPATCHED order, `items:[{itemId, receivedQty=orderedQty}]` | `200`; status DELIVERED; `deliveredAt`, `wasteEditableUntil = now + window`, `confirmedById` set; DELIVERED event; notify |
| D1-02 | Confirm non-DISPATCHED | order PLACED/DELIVERED | `422 "Only DISPATCHED orders can be confirmed"` |
| D1-03 | Unknown itemId | `itemId` not on order | `400 "Unknown itemId <id>"` |
| D1-04 | receivedQty out of range | `receivedQty = orderedQty + 1` or negative | `400 "receivedQty for <id> must be between 0 and <orderedQty>"` |
| D1-05 | **Shortfall auto-complaint** | received < ordered on an item | `200`; a `complaints` row created (`TKT-NNNNN`, category FOOD, subCategory DELIVERY_VARIANCE, priority HIGH ≥50% / MEDIUM ≥20% / LOW, slaHours 24, orderId set); "Variance complaint <TKT> auto-created" event |
| D1-06 | Priority thresholds | Test 60% short (HIGH), 30% (MEDIUM), 10% (LOW) | Complaint priority matches band |
| D1-07 | Confirm via dashboard UI | Food Overview → confirm delivery; mismatch forces reason chip | Confirm disabled ("Pick a reason first") until reason chosen; received stepper max = sent qty |

### D2. Waste `POST /orders/:id/waste` (FOOD_WASTE_TRACKING:edit)
| ID | Title | Steps | Expected |
|---|---|---|---|
| D2-01 | Record waste inside the window | DELIVERED order, now ≤ `wasteEditableUntil`, `items:[{itemId, wastedQty}]` | `200`; item `wastedQty` set; "Waste recorded" event |
| D2-02 | Waste after the window closes | now > `wasteEditableUntil` (the CLOSING bound = deliveredAt + window) | `422 "The wastage window for this order has closed — it can only be logged within the hour after delivery"` |
| D2-03 | Waste on non-DELIVERED | | `422 "Waste can only be recorded for DELIVERED orders"` |
| D2-04 | Waste exceeds cap | `wastedQty > receivedQty + additional food` (cap = receivedQty, or orderedQty if null, plus any Additional Food for that dish) | `400 "wastedQty for <id> cannot exceed what was received, including additional food (<cap>)"` |
| D2-05 | Negative waste | `wastedQty=-1` | `400` (same message; `<0` rejected) |
| D2-06 | Zero waste | `wastedQty=0` | `200`; UI "Zero waste recorded" |
| D2-07 | Unknown item | bad itemId | `400 "Unknown itemId <id>"` |
| D2-08 | Waste window config | change `food_waste_edit_window_minutes` via system-config, confirm delivery | `wasteEditableUntil` reflects new window |
| D2-09 | Waste-pending surfacing | DELIVERED order still INSIDE the window with a null `wastedQty` item | Appears in `GET /waste-pending` and dashboard pendingActions; drops off once `wasteEditableUntil` passes (nothing can be logged after) |

---

## E. Edit / cancel / track order

### E1. Edit `PUT /orders/:id` (FOOD_PLACE_ORDER:edit)
| ID | Title | Steps | Expected |
|---|---|---|---|
| E1-01 | Edit headcount PLACED | `{residentsCount:30}` | `200`; totalQuantity updated; items deleted + recomputed |
| E1-02 | Edit notes only | `{notes:"..."}` | `200`; items unchanged if count unchanged |
| E1-03 | Edit disallowed status | order ACCEPTED or DELIVERED/CANCELLED | `422 "Order can only be edited while PLACED, PREPARING or DISPATCHED"` |
| E1-04 | Edit after dispatch | headcount change on DISPATCHED order | `200`; DISPATCHED audit event "People count changed after dispatch…"; notify (best-effort) |
| E1-05 | Invalid residentsCount | `residentsCount=0`/negative | `400 "residentsCount must be a positive number"` |
| E1-06 | Client item qty ignored | send `items` with tampered qty | Ignored; server recomputes from rules |
| E1-07 | UI edit gate | Order detail Edit button | Shown only PLACED/PREPARING/DISPATCHED + FOOD_PLACE_ORDER:edit; Save disabled unless people>0 |

### E2. Cancel `POST /orders/:id/cancel` (inline permission)
| ID | Title | Steps | Expected |
|---|---|---|---|
| E2-01 | Cancel pre-dispatch | PLACED/ACCEPTED/PREPARING order | `200`; status CANCELLED, `cancelledAt`, `cancelReason`; CANCELLED event; notify |
| E2-02 | Cancel dispatched+ | DISPATCHED/DELIVERED | `422 "Only orders that are not yet dispatched can be cancelled"` |
| E2-03 | Cancel without permission | role lacking both FOOD_PLACE_ORDER:edit and FOOD_KITCHEN_SUMMARY:edit | `403 "Forbidden — insufficient permissions"` |
| E2-04 | Cancel with kitchen perm | FNB_MANAGER (kitchen edit, no place-order) cancels PREPARING | `200` (inline check passes on FOOD_KITCHEN_SUMMARY:edit) |
| E2-05 | UI arm-twice cancel (track) | Food Track → Cancel → tap twice | First tap "Tap again to confirm"; second cancels |

### E3. Track & detail
| ID | Title | Steps | Expected |
|---|---|---|---|
| E3-01 | Track by orderNumber | `GET /orders/track?orderNumber=ORD-...` | `200`; full order + events + dispatch |
| E3-02 | Track by id | `GET /orders/track?id=...` | `200` |
| E3-03 | Track blank | no params | `400 "orderNumber or id required"` |
| E3-04 | Track not found | bad number | `404 "No order found for that number."` |
| E3-05 | Track not accessible | scoped foreign order | `403 "Order not accessible"` |
| E3-06 | Route precedence | `/orders/track` and `/orders/dispatch/bulk` before `/orders/:id` | "track"/"dispatch" not treated as an `:id` |
| E3-07 | Get order by id | `GET /orders/:id` | `200` full detail; `404` missing; `403` foreign |

---

## F. Order listing & Kitchen Summary

### F1. All orders `GET /orders` (authorizeAny FOOD_ALL_ORDERS/FOOD_DISPATCH/FOOD_KITCHEN_SUMMARY:view)
| ID | Title | Steps | Expected |
|---|---|---|---|
| F1-01 | List with pagination | `GET /orders?page=1&limit=20` | `200`; `data[]` + `meta{count,page,limit}` |
| F1-02 | Filter by status CSV | `?status=PLACED,PREPARING` | Only those statuses |
| F1-03 | Filter serviceDate | `?serviceDate=2026-07-18` | Exact IST-day match |
| F1-04 | Filter property/brand/meal/search | combine filters | Correct intersection; search ilike on orderNumber |
| F1-05 | **Operational status clamp** | FNB role (no FOOD_ALL_ORDERS) lists orders | Results limited to PLACED/ACCEPTED/PREPARING/DISPATCHED only |
| F1-06 | Clamp to empty | FNB role asks `?status=DELIVERED` only | `200` empty `data:[]` (not widened) |
| F1-07 | Export CSV | `GET /reports/export.csv` (all orders reports) | attachment `food-orders-...csv` |

### F2. Kitchen Summary `GET /kitchen-summary` (FOOD_KITCHEN_SUMMARY:view)
| ID | Title | Steps | Expected |
|---|---|---|---|
| F2-01 | Aggregate view | `GET /kitchen-summary?date=...` | Orders in PLACED/PREPARING aggregated by meal → dish/unit with totalQty + per-property split |
| F2-02 | Unit conversion | dish qty ≥ 1000 G | Displayed as KG (÷1000, 3-dp); ML → LITRE similarly |
| F2-03 | Filters | brand/mealType/clusterId/propertyId | Correct subset |
| F2-04 | UI Start prep | Kitchen Summary → "Start prep" for a meal | Accepts + prepares all PLACED of that meal; confetti full / warning partial |
| F2-05 | UI Mark all preparing | bulk button | Disabled when 0 orders; processes all |
| F2-06 | Empty state | no orders that day | "No prep plan…" / "All caught up" |

---

## G. Masters — dishes, ingredients, rotation, rules, composition

### G1. Dishes `/dishes` (GET open; write = FOOD_SETTINGS)
| ID | Title | Steps | Expected |
|---|---|---|---|
| G1-01 | Create dish | `POST /dishes` `{name, component, unit, brands[], preparations[]}` | `201`; preparations sanitized to VEG/NON_VEG/JAIN whitelist |
| G1-02 | Create missing fields | omit unit | `400 "name, component, unit required"` |
| G1-03 | With ingredients | include `ingredients[]` | `dish_ingredients` rows replace-inserted |
| G1-04 | List filters | `?component=`, `?search=`, `?active=`, `?brand=`, `?sort=newest` | Correct filtering/sort |
| G1-05 | Get by id | `GET /dishes/:id` | dish + ingredients; `404` if missing |
| G1-06 | Update | `PUT /dishes/:id` partial | `200`; preparations re-sanitized; `404` missing |
| G1-07 | Soft delete | `DELETE /dishes/:id` | `isActive=false`, returns row; `404` if missing |
| G1-08 | Invalid preparation dropped | `preparations:["SPICY"]` | "SPICY" filtered out (not in whitelist) |

### G2. Ingredients `/ingredients`
| ID | Title | Steps | Expected |
|---|---|---|---|
| G2-01 | Create | `{name, unit}` | `201`; `400 "name and unit required"` if missing |
| G2-02 | Update / soft delete | `PUT`/`DELETE /:id` | `200`; soft delete `isActive=false`; `404` missing |

### G3. Menu rotation `/menu-rotation`
| ID | Title | Steps | Expected |
|---|---|---|---|
| G3-01 | Create rotation entry | `POST` `{kitchenId, brand, mealType, dishId, dayOfWeek}` | `201`; `400` if any missing |
| G3-02 | Bulk create | `POST /menu-rotation/bulk` `{..., items:[{dishId}]}` | `201`; `400 "No valid items"` if all lack dishId |
| G3-03 | Resolve menu | `GET /menu-rotation/resolve?brand=&mealType=&date=` | dishes for that day; `400` if missing brand/mealType/date |
| G3-04 | Rotation week cycling | Configure weeks 1–4, query different ISO weeks | Correct week picked: `weeks[(isoWeek-1) % numWeeks]` |
| G3-05 | Seasonal window | dish with `effectiveFrom/To` outside date | Excluded when date outside window |
| G3-06 | Slot replace-all | `PUT /menu-rotation/slot` `{kitchenId,brand,rotationWeek,dayOfWeek,mealType,items}` | replaces slot, **preserves each dish's effectiveFrom/To**; empty items → all removed |
| G3-07 | Update single | `PUT /menu-rotation/:id` | `200`; `404` missing |
| G3-08 | **Hard delete** | `DELETE /menu-rotation/:id` (also nonexistent id) | `200 {success:true}` even if id absent (no 404) |
| G3-09 | Export | `GET /menu-rotation/export.csv` / `.pdf` | attachment; static routes win over `/:id` |
| G3-10 | Validate menu | `GET /menu-rotation/validate?brand=&mealType=&dishIds=` | verdict with violations; `400` if missing brand/mealType |
| G3-11 | Auto-fill | `GET /menu-rotation/auto-fill?brand=&mealType=` | suggested dishes to satisfy rule |

### G4. Composition rules `/composition-rules`
| ID | Title | Steps | Expected |
|---|---|---|---|
| G4-01 | Create rule + slots | `POST` `{brand, mealType, slots[]}` | `201`; slots inserted (minCount default 1) |
| G4-02 | Missing fields | omit mealType | `400 "brand and mealType required"` |
| G4-03 | Update replaces slots | `PUT /:id {slots}` | old slots deleted + re-inserted |
| G4-04 | Hard delete | `DELETE /:id` | `200`, no 404 |
| G4-05 | **Validation MISSING/UNDER/OVER** | menu missing a required slot / below min / above max | verdict slot status MISSING/UNDER/OVER; `ok=false` |
| G4-06 | **Shared-ingredient block** | two menu dishes share an ingredient | verdict violation `SHARED_INGREDIENT`; `ok=false` |
| G4-07 | Complete menu | all slots satisfied, no shared ingredient | `ok=true`, `isComplete=true` |
| G4-08 | UI hard-block save | Menu Rotation add entry with `ok===false` | Save button disabled ("Resolve violations to save") |

### G5. Portion (per-resident) rules `/rules`
| ID | Title | Steps | Expected |
|---|---|---|---|
| G5-01 | Create rule | `POST` `{brand, mealType, dishId, qtyPerResident, unit}` | `201` |
| G5-02 | Missing fields | omit qtyPerResident | `400 "brand, mealType, dishId, qtyPerResident, unit required"` |
| G5-03 | **Duplicate rule** | same brand+mealType+dishId | `409 "A rule already exists for this brand, meal and dish"` |
| G5-04 | Update / delete | `PUT`/`DELETE /:id` | `200`; delete is hard (no 404) |
| G5-05 | qtyPerResident numeric | verify response returns `qtyPerResident` as Number | numeric, not string |

---

## H. Config masters — meal config, cut-offs, kitchens, brands

### H1. Meal config `/meal-config`
| ID | Title | Steps | Expected |
|---|---|---|---|
| H1-01 | List (any user) | `GET /meal-config` | rows ordered by sortOrder |
| H1-02 | Update | `PUT /meal-config/:mealType {displayLabel, sortOrder, isEnabled}` (FOOD_SETTINGS:edit) | `200`; `404 "Not found"` for unknown mealType |
| H1-03 | Meal types fixed | UI has no add | only enable/edit label/sort |

### H2. Meal windows `/meal-windows`
| ID | Title | Steps | Expected |
|---|---|---|---|
| H2-01 | Create window | `POST {brand, mealType}` | `201`; `400 "brand and mealType required"` if missing |
| H2-02 | Update | `PUT /:id` | `200`; `404` missing |
| H2-03 | **Hard delete** | `DELETE /:id` (also nonexistent) | always `{success:true}` (no 404) |
| H2-04 | Filter | `GET ?brand=&propertyId=` | `propertyId IS NULL OR = propertyId` |

### H3. Cut-off config `/cutoff-config` & `/cutoffs`
| ID | Title | Steps | Expected |
|---|---|---|---|
| H3-01 | Create cut-off | `POST {brand, cutoffTime}` | `201` |
| H3-02 | **Duplicate cut-off** | same brand+property | `409 "A cut-off already exists for this brand/property"` |
| H3-03 | Missing fields | omit cutoffTime | `400 "brand and cutoffTime required"` |
| H3-04 | Update / hard delete | `PUT`/`DELETE /:id` | `200`; delete always success |
| H3-05 | Resolve cut-offs | `GET /cutoffs?brand=&propertyId=&date=` | per-meal `{cutoffAt, isPastCutoff}`; property override → brand → global 09:00 |
| H3-06 | Deadline anchoring | verify `cutoffAt` = day-before serviceDate at IST cut-off | correct anchor |

### H4. Kitchens `/kitchens`
| ID | Title | Steps | Expected |
|---|---|---|---|
| H4-01 | Create kitchen | `POST {name, code}` | `201`; `400 "name and code required"` |
| H4-02 | Duplicate code | reuse existing `code` | unique violation → error (code is UNIQUE) |
| H4-03 | Update / soft delete | `PUT`/`DELETE /:id` | `200`; delete `isActive=false`; `404` missing |
| H4-04 | Kitchen by pincode | `GET /kitchen-by-pincode?pincode=560001` | `{kitchenId,...}` or `{kitchenId:null}` (**200, not 404**) if unmapped |
| H4-05 | Bad pincode | `pincode=abc` / 5 digits | `400 "A valid 6-digit pincode is required"` |

### H5. Brands `/brands`
| ID | Title | Steps | Expected |
|---|---|---|---|
| H5-01 | Create brand | `POST {code, name}` | `201`; code normalized (trim/UPPER/spaces→`_`) |
| H5-02 | Missing fields | omit name | `400 "code and name required"` |
| H5-03 | Duplicate code | reuse code | `409 "Brand code already exists"` |
| H5-04 | Update / soft delete | `PUT`/`DELETE /:id` | `200`; soft delete; `404` missing |

### H6. System defaults & tolerance (SUPER_ADMIN-gated)
| ID | Title | Steps | Expected |
|---|---|---|---|
| H6-01 | Read food defaults | `GET /system-config/food-defaults` (any user) | `{defaultCutoff, wasteWindowMinutes}` |
| H6-02 | Update as non-super | `PUT /system-config/food-defaults` as FNB_MANAGER | `403 "Forbidden — SUPER_ADMIN only"` |
| H6-03 | Update as super | valid `{defaultCutoff:"09:30"}` | `200`; upsert system_config |
| H6-04 | Bad cutoff format | `defaultCutoff="9am"` | `400 "defaultCutoff must be HH:MM"` |
| H6-05 | Bad waste window | `wasteWindowMinutes=0`/negative | `400 "wasteWindowMinutes must be a positive number"` |
| H6-06 | Nothing to update | empty body | `400 "Nothing to update"` |
| H6-07 | On-time tolerance | `PUT /settings/ontime-tolerance {minutes:15}` as super | `200`; non-super `403`; out of 0–240 → `400 "minutes must be an integer between 0 and 240"` |

---

## I. Organization — hierarchy, agencies, scopes (FOOD_ORG: super-admin/OPS_EXCELLENCE only)

### I1. Geographic hierarchy
| ID | Title | Steps | Expected |
|---|---|---|---|
| I1-01 | Zones CRUD | `POST/PUT/DELETE /zones` | create `400 "name required"`; **hard delete** no 404 |
| I1-02 | Cities CRUD | `/cities` `{name, zoneId?}` | `400 "name required"` |
| I1-03 | Clusters CRUD | `/clusters` `{name, cityId}` | `400 "name, cityId required"` |
| I1-04 | Assign cluster | `POST /properties/:id/assign-cluster {clusterId}` | `200`; `404` if property missing |
| I1-05 | Hierarchy tree | `GET /hierarchy` (FOOD_DASHBOARD:view) | City→Kitchen→Property with active-guest counts; **no scoping** |
| I1-06 | Assign brand/kitchen | `POST /properties/:id/assign-brand`, `/assign-kitchen` | always `{success:true}`; null clears |

### I2. Agencies `/agencies` (FOOD_ORG)
| ID | Title | Steps | Expected |
|---|---|---|---|
| I2-01 | Create agency | `POST {name}` | `201`; `400 "name required"` |
| I2-02 | Soft delete | `DELETE /:id` | `isActive=false`; `404` missing |
| I2-03 | Locations | `POST /agencies/:id/locations {name}`; `PUT/DELETE /agency-locations/:id` | `400 "name required"`; location delete is **hard** |
| I2-04 | Vehicles | `POST /agencies/:id/vehicles {vehicleNumber, vehicleType}` | `400 "vehicleNumber required"`; type default VAN; hard delete |
| I2-05 | Set serving kitchens | `PUT /agencies/:id/kitchens {kitchenIds}` | replaces all links; de-duped; `404` if agency missing |
| I2-06 | Reverse lookup | `GET /kitchens/:id/agencies` | active agencies serving a kitchen |
| I2-07 | Unique agency-kitchen | link same kitchen twice | de-dup / unique constraint respected |
| I2-08 | UI read-only | FOOD_ORG:view without edit | add/edit/delete controls hidden or disabled |

### I3. User scopes `/scopes` (FOOD_ORG:edit)
| ID | Title | Steps | Expected |
|---|---|---|---|
| I3-01 | Create scope | `POST {userId, scopeLevel:"CITY", cityId}` | `201` |
| I3-02 | Missing fields | omit scopeLevel | `400 "userId, scopeLevel required"` |
| I3-03 | **Self-grant blocked** | userId = caller | `403 "Cannot grant an access scope to yourself"` |
| I3-04 | **GLOBAL by non-super** | scopeLevel GLOBAL as non-super/non-OPS | `403 "Only SUPER_ADMIN or OPS_EXCELLENCE may grant a GLOBAL scope"` |
| I3-05 | Missing level field | scopeLevel CITY without cityId | `400 "cityId required for CITY scope"` |
| I3-06 | Invalid level | scopeLevel `FOO` | `400 "Invalid scopeLevel FOO"` |
| I3-07 | Hard delete | `DELETE /scopes/:id` | `200`, no 404 |
| I3-08 | Food users list | `GET /food-users` | only food roles returned |

---

## J. Reports, analytics & exports (FOOD_REPORTS:view)

| ID | Title | Steps | Expected |
|---|---|---|---|
| J-01 | Reports summary | `GET /reports` | ordersPerDay, mealTypeDistribution, residentTrend, statusBreakdown |
| J-02 | Analytics | `GET /analytics?period=month` | wastageTrend, topWasteItems, delays, summary |
| J-03 | Waste analytics | `GET /waste-analytics?from=&to=&brand=` | summary, byProperty, byDish, byMealType, byMenu, trend |
| J-04 | Waste export formats | `GET /waste-analytics/export.:fmt?widget=` | csv/xlsx/pdf; `400` bad fmt; `400 "widget must be one of property, dish, mealtype, menu, trend"` |
| J-05 | Home analytics | `GET /home-analytics?period=` | people/wastage/delay/occupancy panels |
| J-06 | Variance report | `GET /reports/variance` | DELIVERED grouped by meal: ordered/received/wasted/variance |
| J-07 | On-time report | `GET /reports/on-time` | onTimePct, byDay, tolerance |
| J-08 | Variance-by-day | `GET /reports/variance-by-day?mealType=LUNCH` | per-day variance; `400 "Invalid mealType"` for bad meal |
| J-09 | Unified export | `GET /reports/export.:fmt?report=` | `400 "fmt must be csv, pdf or xls"`; `400 "report must be one of orders, variance, waste, ontime"` |
| J-10 | Literal export routes | `GET /reports/export.csv/.pdf/.xls` | matched before `export.:fmt` |
| J-11 | Report scoping | scoped user filter `?propertyId=` foreign | `403 "Property not accessible"` |
| J-12 | UI period presets | Reports page Week/Month/Quarter/Year | 7/30/90/365-day windows; `aria-pressed` |
| J-13 | UI download matrix | 4 reports × 3 formats | correct file per combo; disabled while downloading |

---

## K. Unit-Lead home & guests

| ID | Title | Steps | Expected |
|---|---|---|---|
| K-01 | My properties | `GET /my-properties` (FOOD_DASHBOARD:view) | per-property cards: occupancy, monthlyRevenue, activeOrders, awaitingDelivery, deliveredCount, photos |
| K-02 | Next orders board | `GET /next-orders` (FOOD_PLACE_ORDER:view) | per-property next orderable day + status (NOT_CONFIGURED/NO_MENU/NOT_ORDERED/PARTIAL/ORDERED) |
| K-03 | Cut-off rollover | tomorrow's cut-off passed | next orderable day = day-after |
| K-04 | Property overview | `GET /property-overview` | target property details or null |
| K-05 | Revenue | `GET /revenue` | last 6 months SUCCESS payments |
| K-06 | Guests list | `GET /guests?propertyId=&search=` | ACTIVE residents, paginated; `403` foreign property |
| K-07 | Guest PAN/Aadhaar search | search exact PAN | HMAC blind-index exact match; degrades gracefully if key unset |
| K-08 | Guests export | `GET /guests/export.csv/.pdf/.xls` | attachment honoring filters; `403` propagates |

---

## L. Menu share (public link)

| ID | Title | Steps | Expected |
|---|---|---|---|
| L-01 | Share to guests | `POST /menu/share {propertyId, brand, channel, recipientType:"GUESTS"}` (FOOD_PLACE_ORDER:view) | `201`; `food_menu_shares` row with `shareToken`; active residents resolved; per-recipient notify best-effort |
| L-02 | Missing fields | omit brand | `400 "propertyId, brand, channel required"` |
| L-03 | Property not accessible | foreign property | `403 "Property not accessible"` |
| L-04 | **Public link (no auth)** | `GET /menu/shared/:token` unauthenticated | `200` read-only menu, no PII |
| L-05 | Invalid token | bad token | `404 "This menu link is invalid or has expired."` |
| L-06 | Full menu | `GET /menu/full?propertyId=&date=` | `{brand, date, meals}`; empty if unconfigured |

---

## M. Permissions & RBAC matrix

For each, log in as the role and hit the endpoint / open the page.

| ID | Title | Role | Action | Expected |
|---|---|---|---|---|
| M-01 | No-food role blocked | HR_MANAGER | any `/api/food/*` authorize'd route | `403` |
| M-02 | UNIT_LEAD cannot reach kitchen-summary | UNIT_LEAD | `GET /kitchen-summary` | `403` (no FOOD_KITCHEN_SUMMARY) |
| M-03 | UNIT_LEAD cannot dispatch | UNIT_LEAD | `POST /dispatches` | `403` (no FOOD_DISPATCH) |
| M-04 | FNB roles cannot list all-orders unclamped | FNB_MANAGER | `GET /orders?status=DELIVERED` | empty (operational clamp) |
| M-05 | FOOD_ORG super-only | CLUSTER_MANAGER | `GET /agencies` / `/zones` / `/scopes` | `403` |
| M-06 | FOOD_SETTINGS write gate | FNB_SUPERVISOR (no settings) | `POST /dishes` | `403` |
| M-07 | FNB_MANAGER has settings | FNB_MANAGER | `POST /dishes` | `201` |
| M-08 | AUDIT_READONLY view-only | AUDIT_READONLY | `GET` any food route → OK; any `POST/PUT/DELETE` | reads `200`; writes `403` |
| M-09 | SVP no all-orders | SENIOR_VICE_PRESIDENT | `GET /orders/:id` (FOOD_ALL_ORDERS) | `403`; dashboard shows "no order-level tracking" panel |
| M-10 | Dispatch VIEW vs EDIT | CLUSTER_MANAGER (dispatch VIEW) | `GET /dispatches` OK; `POST /dispatches` | list `200`; create `403` |
| M-11 | Cancel inline perm | role without place/kitchen edit | `POST /orders/:id/cancel` | `403 "Forbidden — insufficient permissions"` |
| M-12 | Landing page | FNB_MANAGER login | — | lands on `/food/kitchen-summary`; Food Overview nav hidden |
| M-13 | Auth-only masters GET | any logged-in role | `GET /dishes`, `/lookups`, `/menu-rotation/resolve` | `200` (no authorize) |
| M-14 | Unauthenticated | no JWT | any protected route | `401` |
| M-15 | Frontend nav gating | each role | check nav shows only permitted items | matches `PATH_TO_MODULE` |
| M-16 | Dispatch UI no client guard | CLUSTER_MANAGER (VIEW) | click Send in dispatch UI | server `403` → error toast (not silent success) |

---

## N. Property scoping / multi-tenancy

| ID | Title | Steps | Expected |
|---|---|---|---|
| N-01 | UNIT_LEAD sees own only | UNIT_LEAD of P1 | `GET /orders` | only P1 orders |
| N-02 | Foreign detail blocked | UNIT_LEAD of P1 | `GET /orders/:id` for P2 order | `403 "Order not accessible"` |
| N-03 | Org-wide sees all | SUPER_ADMIN | `GET /orders` | all properties |
| N-04 | Scope rows expand | CITY_HEAD with CITY scope | list orders | city → kitchens → properties expanded |
| N-05 | **Empty scope sees nothing** | user with scope rows resolving to empty set | `GET /orders` | `data:[]` (NOT all) |
| N-06 | Zero scope fallback | BROAD_FALLBACK role (FNB_MANAGER) with no scope rows & no propertyId | list | falls back to all properties |
| N-07 | UNIT_LEAD no fallback | UNIT_LEAD with no scope rows | list | property-scoped (never all) |
| N-08 | GLOBAL scope override | user with a GLOBAL user_scope row | list | sees all |
| N-09 | Dispatch scoping | scoped user | `GET /dispatches` | only trips including an accessible order |
| N-10 | Report scoping | scoped user | `GET /waste-analytics` | only accessible properties aggregated |

---

## O. API response format & route mechanics

| ID | Title | Steps | Expected |
|---|---|---|---|
| O-01 | Success envelope | any success | `{success:true, data:...}` |
| O-02 | Create returns 201 | any POST create | `201` |
| O-03 | Validation error shape | bad body | `400 {success:false, error:"Invalid request", details:<zod flatten>}` |
| O-04 | Internal error | force a 500 | `{success:false, error:"Internal server error"}`, no stack trace |
| O-05 | Passthrough bodies | send extra keys | ignored, request still valid |
| O-06 | Numeric coercion | qty fields | returned as Number not string (e.g. totalQuantity, qtyPerResident) |
| O-07 | Soft vs hard delete | dishes/ingredients/brands/agencies (soft, 404 if missing) vs rotation/rules/composition/zones/cities/clusters/scopes/agency-locations/agency-vehicles/meal-windows/cutoff-config (hard, no 404) | delete semantics per §F/G/H/I |
| O-08 | Route-order traps | `/orders/track`, `/orders/dispatch/bulk`, `/dispatches/active-vehicles`, `/menu-rotation/{resolve,slot,validate,auto-fill,export.*,bulk}`, `/reports/export.csv` | static/literal routes win over `:id`/`:fmt` |

---

## P. Database validation

Since there are **no DB CHECK constraints**, verify the **app layer** rejects bad values and the DB
integrity/uniqueness holds.

| ID | Title | Steps | Expected |
|---|---|---|---|
| P-01 | orderNumber unique | attempt two orders with same number (or force collision) | UNIQUE violation; app retries number gen (5 attempts → `500 "Failed to generate order number"`) |
| P-02 | Unique constraints | duplicate `food_brands.code`, `kitchens.code`, `kitchen_pincodes.pincode`, `food_dispatches.dispatchNumber`, `food_order_batches.batchNumber`, `food_menu_shares.shareToken` | DB rejects duplicate |
| P-03 | Composite uniques | `agency_kitchens(agencyId,kitchenId)`, `food_cutoffs(brand,propertyId)`, `food_order_drafts(userId,propertyId,serviceDate)`, `food_meal_config.mealType` | duplicate rejected |
| P-04 | **Cascade: delete order** | delete a `food_orders` row | its `food_order_items` + `food_order_events` removed |
| P-05 | Cascade: delete agency | delete agency | locations, vehicles, kitchen links removed |
| P-06 | Cascade: delete user | delete a user | `user_scopes` + `food_order_drafts` removed |
| P-07 | NOT NULL enforcement | insert `food_order_items` without `orderedQty` | DB rejects (NOT NULL) |
| P-08 | Enum enforcement | insert `food_orders.status='FOO'` directly | DB rejects (pgEnum) |
| P-09 | App invariant wastedQty | via API `wastedQty > cap` | app `400` (DB itself would accept — app must guard) |
| P-10 | pincode global uniqueness | map same pincode to two kitchens | second insert rejected (pincode UNIQUE) → deterministic derivation |
| P-11 | serviceDate day-anchoring | drafts / order dedup use 00:00 IST anchor | same-day rows match; different day distinct |
| P-12 | Order events append-only | perform lifecycle transitions | one `food_order_events` row per transition, none mutated |
| P-13 | Dispatch events append-only | dispatch lifecycle | one `food_dispatch_events` row per status change |
| P-14 | totalQuantity consistency | after edit headcount | `food_orders.totalQuantity` = sum of recomputed item orderedQty |
| P-15 | wasteEditableUntil set | after confirm-delivery | column = deliveredAt + configured window ms |

---

## Q. End-to-end lifecycle (integration)

| ID | Title | Flow | Expected |
|---|---|---|---|
| Q-01 | Full happy lifecycle | Place → Accept → Prepare → Load van → Depart → Deliver → Waste | each transition succeeds, events logged, notifications fired, DB consistent |
| Q-02 | Reject path | Place → Reject | REJECTED terminal; no dispatch possible |
| Q-03 | Cancel pre-dispatch | Place → Accept → Cancel | CANCELLED; slot re-orderable |
| Q-04 | Dispatch cancel reverts | Prepare → Load → Cancel trip | orders revert to PREPARING, dispatch fields cleared, re-dispatchable |
| Q-05 | Partial delivery | trip with 2 orders, deliver 1 | trip PARTIAL; delivered order DELIVERED, other DISPATCHED |
| Q-06 | Shortfall → complaint | Deliver with received < ordered | auto complaint TKT created, variance event, waste window opens |
| Q-07 | Multi-meal batch lifecycle | Batch of 3 meals, advance each independently | each order own lifecycle; batchId shared |
| Q-08 | Edit after dispatch notifies | Dispatch → edit headcount | items recomputed, notify kitchen, audit event |

---

### Coverage notes
- **Happy path:** A1, B, C1, D1-01, E1, Q-01.
- **Negative:** A2, B*/-02/-03, C2, D1-02..04, D2-02..05, E1-03/05, E2-02/03, G/H/I `400/404/409`.
- **Edge:** A3, A4, C2-08, C4-02/04, G3-04/05/06, N-05, P-01/11.
- **Permissions:** §M (matrix) + inline gates (E2-03, D1, C, I3-03/04).
- **API responses:** §O + every `Expected` status/message column.
- **DB validation:** §P.
