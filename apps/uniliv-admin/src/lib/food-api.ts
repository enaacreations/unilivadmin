/**
 * Food Ordering & Kitchen Operations — typed API client.
 *
 * Thin wrappers over apiFetch for the /api/food endpoints, plus shared types
 * and a query-key factory. Pages compose these with @tanstack/react-query
 * (useQuery / useMutation), matching the codebase's custom-endpoint convention.
 */
import { format, parseISO } from "date-fns";
import { apiFetch } from "@/lib/api-fetch";

// ─── Domain types ────────────────────────────────────────────────────────────
// Brands are now an admin-managed master list (food_brands), so a brand is just
// its code string. Read the live set with useActiveBrands() (components/food/
// use-food-masters). L10 — the old `BRANDS = ["UNILIV","HUDDLE"]` dev fallback
// is deleted rather than left unused: every board that filtered by it dropped
// the rows of any brand created since, and a constant that still exists is a
// constant the next filter will reach for.
export type FoodBrand = string;
export type MealType = "BREAKFAST" | "LUNCH" | "SNACKS" | "DINNER";
export type OrderStatus = "PLACED" | "ACCEPTED" | "REJECTED" | "DISPATCHED" | "DELIVERED" | "CANCELLED";
export type DispatchStatus = "LOADING" | "IN_TRANSIT" | "DELIVERED" | "PARTIAL" | "CANCELLED";

export const MEAL_TYPES: MealType[] = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"];
export const PREPARATIONS = ["VEG", "NON_VEG", "JAIN"] as const;
export type Preparation = (typeof PREPARATIONS)[number];
export const PREPARATION_LABEL: Record<string, string> = { VEG: "Veg", NON_VEG: "Non-veg", JAIN: "Jain" };
export const ORDER_STATUSES: OrderStatus[] = ["PLACED", "ACCEPTED", "REJECTED", "DISPATCHED", "DELIVERED", "CANCELLED"];

export interface FoodOrder {
  id: string;
  orderNumber: string;
  propertyId: string;
  propertyName?: string;
  brand: FoodBrand;
  mealType: MealType;
  unitLeadId: string;
  unitLeadName?: string;
  residentsCount: number;
  /** Per-meal STAFF headcount. Staff eat the same food; people fed =
   *  residentsCount + staffCount. 0 on legacy orders (so total === residentsCount
   *  for them). Kept separate from residentsCount so analytics never double-count. */
  staffCount: number;
  totalQuantity: string | null;
  status: OrderStatus;
  serviceDate: string;
  notes: string | null;
  deliveryPartnerId: string | null;
  deliveryPartnerName?: string | null;
  dispatchStartedAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  deliveryRemarks: string | null;
  /** When the wastage window CLOSES — logging is open from delivery until here (M20). */
  wasteEditableUntil: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  batchId: string | null;
  /** Friendly group id (BATCH-2026-000123) shared by every meal placed together;
   *  joined in on order list/detail reads. null for legacy single-meal orders. */
  batchNumber?: string | null;
  kitchenId: string | null;
  dispatchId: string | null;
  expectedDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** People the kitchen actually cooks for on an order = residents + staff.
 *  staffCount is 0 on legacy orders, so this equals residentsCount for them.
 *  Use this for EVERY operational "N people / N ppl" display and every sum of
 *  order headcounts. Do NOT use it for analytics that must split the two. */
export const orderPeople = (
  o: { residentsCount?: number | null; staffCount?: number | null },
): number => (o.residentsCount ?? 0) + (o.staffCount ?? 0);

/** A multi-meal order batch (one Place Order action → one batch → up to 4 meal orders). */
export interface OrderBatch {
  id: string;
  batchNumber: string;
  propertyId: string;
  unitLeadId: string;
  brand: FoodBrand;
  serviceDate: string;
  residentsCount: number;
  notes: string | null;
}

export interface FoodOrderItem {
  id: string;
  orderId: string;
  dishId: string;
  dishName?: string;
  component?: string;
  unit: string;
  /** People THIS line was ordered for — a dish can be ordered for fewer than the
   *  meal. Null on legacy rows; `dishPeople()` reads it with the documented
   *  fallback to the order's own headcount. */
  personsCount: number | null;
  orderedQty: string;
  preparedQty: string | null;
  receivedQty: string | null;
  wastedQty: string | null;
}

export interface FoodOrderEvent {
  id: string;
  orderId: string;
  status: OrderStatus;
  note: string | null;
  actorId: string | null;
  actorName?: string | null;
  createdAt: string;
}

export interface AdditionalFoodItem { dishId: string; dishName: string | null; qty: number; unit: string }
export interface AdditionalFoodRequest {
  requestId: string;
  sourcePropertyId: string;
  sourcePropertyName: string | null;
  createdAt: string;
  items: AdditionalFoodItem[];
}
export interface OrderDetail extends FoodOrder {
  items: FoodOrderItem[];
  events: FoodOrderEvent[];
  kitchen?: Kitchen | null;
  dispatch?: Dispatch | null;
  additionalFood?: AdditionalFoodRequest[];
}

export interface Kpi { value: number; changePct: number | null }
/** Variance-order counts per period (FY = Apr–Mar). */
export interface VarianceCounts { m1: number; m3: number; m6: number; fy: number }
export type VariancePeriod = "m1" | "m3" | "m6" | "fy";
export interface DashboardData {
  kpis: { totalOrders: Kpi; active: Kpi; awaitingConfirmation: Kpi; variance: VarianceCounts };
  pendingActions: { awaitingDispatch: number; wastePending: number };
}
/** One DELIVERED order still inside its waste-edit window (dashboard table). */
export interface WastePendingRow {
  orderId: string;
  orderNumber: string;
  propertyName: string | null;
  mealType: MealType;
  deliveredAt: string | null;
  wasteEditableUntil: string | null;
}

/** One order item as the kitchen sees it: what was ordered vs what it sends. */
export interface KitchenItem {
  id: string; dishId: string | null; dishName: string | null; unit: string;
  orderedQty: number | null; preparedQty: number | null;
  /** People THIS dish line is for — a dish can be ordered for fewer than the
   *  meal (a pinned sweet for 5 of 40). Null on legacy rows placed before
   *  per-dish head counts existed; use `dishPeople()` to read it with the
   *  documented fallback to the order's own headcount. */
  personsCount: number | null;
}

/** People a single dish line feeds. `personsCount` is what the unit lead entered
 *  for that dish; legacy rows have none, and the schema's documented default
 *  there is the order's own headcount (food_order_items.persons_count), so fall
 *  back to it rather than showing a blank on a packing list. */
export const dishPeople = (
  it: { personsCount?: number | null },
  order: { residentsCount?: number | null; staffCount?: number | null },
): number => it.personsCount ?? orderPeople(order);

export interface KitchenSummaryDish {
  dishId: string;
  dishName: string;
  component: string;
  unit: string;
  totalQty: number;
  displayQty: number;
  displayUnit: string;
  byProperty: { propertyId: string; propertyName: string; qty: number }[];
}
export interface KitchenSummary { meals: { mealType: MealType; dishes: KitchenSummaryDish[] }[] }

export interface ReportsData {
  ordersPerDay: { date: string; count: number }[];
  mealTypeDistribution: { mealType: string; count: number }[];
  residentTrend: { date: string; residents: number }[];
  statusBreakdown: { status: string; count: number }[];
}

// WS11 — aggregated ordered-vs-delivered variance, grouped by meal type AND
// unit: kilograms and plates do not add up, so there is no single "total" and
// the server does not pretend there is (M7). `unconfirmed` is the ordered
// quantity on DELIVERED orders nobody has counted yet — kept OUT of
// ordered/received/variance so a trip-delivered order stops reading as a 100%
// shortfall against the kitchen (C3).
export interface VarianceRow {
  mealType: MealType; unit: string | null;
  ordered: number; received: number; wasted: number; variance: number;
  unconfirmed: number; unconfirmedOrders: number;
}
export interface VarianceTotals {
  unit: string | null; ordered: number; received: number; wasted: number; variance: number; unconfirmed: number;
}
export interface VarianceData {
  rows: VarianceRow[];
  totalsByUnit: VarianceTotals[];
  unconfirmedOrders: number;
}

// O15 — on-time delivery report (% on-time + per-day on-time/late trend).
export interface OnTimeReport {
  onTimePct: number;
  lateCount: number;
  onTimeCount: number;
  totalDelivered: number;
  toleranceMinutes: number;
  byDay: { date: string; onTime: number; late: number }[];
}
// O16 — global on-time tolerance (minutes after configured service time).
export interface OnTimeTolerance { minutes: number }

/** Global ordering headroom — how far above the derived headcount/quantity an
 *  order may go. `pct` is the setting (100 = up to double); `multiplier` is the
 *  same number pre-applied (1 + pct/100) so callers never re-derive it. */
export interface OrderHeadroom {
  pct: number;
  multiplier: number;
  defaultPct: number;
  maxPct: number;
}
/** Fallback while the setting is in flight or the user can't read it — matches
 *  FOOD_ORDER_HEADROOM_DEFAULT_PCT on the server. */
export const DEFAULT_ORDER_HEADROOM_MULTIPLIER = 2;
// O17 — ordered-vs-received variance per service-day (bar chart, filterable by
// meal). One row per (date, unit), NOT per date: a day with both KG and PLATE
// lines emits two rows, so anything that charts or counts these must collapse
// to days first (see collapseByDate in food-reports.tsx).
export interface VarianceByDayRow {
  date: string; unit: string | null;
  ordered: number; received: number; variance: number; wasted: number; unconfirmed: number;
}
export interface VarianceByDayData { rows: VarianceByDayRow[] }

export interface DishIngredientRow { id?: string; ingredientId: string; ingredientName?: string | null; quantity: string | number | null; unit: string | null }
/** A dish that may be served alongside another (see dish_side_options). */
export interface DishSideOptionRow {
  id: string; sideDishId: string; sideDishName: string | null;
  component: string | null; unit: string | null; sortOrder: number;
}
export interface Dish {
  id: string; name: string; component: string; unit: string;
  brands: string[];
  preparations: string[];
  photoUrl: string | null; isActive: boolean;
  /**
   * Pin this dish's people count at order time. When set, the order panel shows
   * a fixed count instead of a stepper — as a main and as anyone's side — and
   * the server re-derives the quantity at placement.
   */
  isQtyLocked?: boolean;
  lockedPersons?: number | null;
  /**
   * A star dish — one of the dishes the brand wants showcased. Any number of
   * dishes may carry it: it marks a POOL. The "only one" rule applies to the
   * PLATE — when the star-dish menu rule is on, each meal's rotation plate must
   * contain exactly one dish from this pool.
   */
  isStarDish?: boolean;
  ingredients?: DishIngredientRow[];
  /** Dishes configured as possible accompaniments. Present on list + detail. */
  sideDishIds?: string[];
  /** Detail view only — the same options joined to name/component. */
  sideOptions?: DishSideOptionRow[];
}
export interface Ingredient {
  id: string; name: string; unit: string; isActive: boolean;
  /** Dishes carrying this ingredient allowed per DAY. Null = no limit. */
  maxPerDay?: number | null;
}
export interface MenuRotationRow {
  id: string; brand: FoodBrand; kitchenId: string | null; kitchenName?: string | null;
  rotationWeek: number; dayOfWeek: number;
  mealType: MealType; dishId: string; dishName?: string; slotLabel: string | null;
  sortOrder: number; isActive: boolean;
  /** Set when this row is a side dish served with the referenced parent row. */
  parentRotationId?: string | null;
}
export interface PerResidentRule {
  id: string; brand: FoodBrand; mealType: MealType; dishId: string; dishName?: string;
  qtyPerResident: number; unit: string; isActive: boolean;
}
export interface DeliveryPartner { id: string; name: string; phone: string | null; vehicleNumber: string | null; isActive: boolean }
export type VehicleType = "VAN" | "BIKE" | "TRUCK" | "CAR" | "TEMPO" | "OTHER";
export interface AgencyVehicle { id: string; agencyId: string; locationId: string | null; vehicleNumber: string; vehicleType: VehicleType; isActive: boolean }
export interface AgencyLocation { id: string; agencyId: string; name: string; address: string | null; city: string | null; state: string | null; pincode: string | null; contactName: string | null; contactPhone: string | null; isActive: boolean }
export interface Agency { id: string; name: string; phone: string | null; contactName: string | null; email: string | null; isActive: boolean; vehicles?: AgencyVehicle[]; locations?: AgencyLocation[]; kitchenIds?: string[] }
/** Active kitchen linked to an agency (agency→kitchens junction view). */
export interface AgencyKitchenLink { id: string; name: string; code: string; linkId: string; linkedAt: string }
/** Active agency linked to a kitchen (reverse junction view). */
export interface KitchenAgencyLink { id: string; name: string; isActive: boolean; linkId: string; linkedAt: string }
export interface Zone { id: string; name: string; code: string | null; isActive: boolean }
export interface City { id: string; name: string; zoneId: string | null; isActive: boolean }
export interface Cluster { id: string; name: string; cityId: string; managerId: string | null; isActive: boolean }
export interface UserScope { id: string; userId: string; scopeLevel: string; zoneId: string | null; cityId: string | null; clusterId: string | null; kitchenId: string | null; propertyId: string | null; isActive: boolean }
export interface FoodUser { id: string; name: string; email: string; role: string; propertyId: string | null }
/** Assignable unit-leads (UNIT_LEAD/WARDEN) for the property form's tag multi-select. */
export interface AssignableUnitLead { id: string; name: string; email: string; role: string; propertyId: string | null }
export interface FoodBrandRow { id: string; code: string; name: string; isActive: boolean }
/**
 * A property photo. `url` is a fresh presigned R2 URL (~1h TTL) present only on
 * GET list + POST create responses; it is null when storage is unconfigured or a
 * presign fails. PATCH responses omit `url` entirely.
 */
export interface PropertyPhoto { id: string; url: string | null; caption: string | null; isHero: boolean; sortOrder: number }
/** Result of resolving a kitchen from a pincode. `kitchenId` is null when no kitchen serves it. */
export interface KitchenByPincode { kitchenId: string | null; kitchenName?: string; kitchenCode?: string }
/** Forward geocode (address text → coordinates). */
export interface GeocodeForward { lat: number; lon: number; displayName: string }
/** Reverse geocode (coordinates → formatted address + pincode). */
export interface GeocodeReverse { displayName: string; address: string; pincode: string }
export interface FoodLookups {
  properties: { id: string; name: string; city: string | null; brand: string | null; kitchenId: string | null; clusterId: string | null }[];
  /** Kitchens the caller's scope resolves to; null = all (admins/heads). */
  myKitchenIds?: string[] | null;
  deliveryPartners: { id: string; name: string }[];
  agencies: {
    id: string; name: string;
    vehicles: { id: string; agencyId: string; vehicleNumber: string; vehicleType: VehicleType; locationId: string | null }[];
    locations: { id: string; agencyId: string; name: string; city: string | null; state: string | null; pincode: string | null }[];
    kitchenIds: string[];
  }[];
  brands: { code: string; name: string }[];
  mealTypes: MealType[];
}

// ─── Phase 1–3 domain types ──────────────────────────────────────────────────
export interface Kitchen {
  id: string; name: string; code: string; brand: FoodBrand | null;
  address: string | null; city: string | null; state: string | null; pincode: string | null;
  contactName: string | null; contactPhone: string | null; contactEmail: string | null;
  cityId: string | null; clusterId: string | null; isActive: boolean;
}
export interface Dispatch {
  id: string; dispatchNumber: string; kitchenId: string | null; kitchenName?: string | null; kitchenCode?: string | null;
  deliveryPartnerId: string | null; partnerName?: string | null; vehicleId?: string | null; vehicleNumber: string | null;
  driverName: string | null; driverPhone: string | null; dispatchedAt: string | null;
  estimatedArrivalAt: string | null; status: DispatchStatus; notes: string | null; orderCount?: number;
}
/** One order row inside a dispatch detail, enriched with delivery + unit-lead contact. */
export type DispatchDetailOrder = FoodOrder & {
  propertyName?: string | null;
  deliveryAddress?: string | null;
  deliveryCity?: string | null;
  deliveryPincode?: string | null;
  unitLeadName?: string | null;
  unitLeadPhone?: string | null;
  unitLeadEmail?: string | null;
  residentsCount: number;
  totalQuantity: string | null;
};
export interface DispatchDetail extends Dispatch {
  kitchen?: Kitchen | null;
  orders: DispatchDetailOrder[];
  /** Stops on this trip the caller's scope does not reach — counted, not shown
   *  (M22), so a partially-scoped viewer is not sold a complete-looking sheet. */
  ordersOutOfScope?: number;
}
/** PATCH /dispatches/:id/status — the trip, plus how its orders actually landed. */
export interface DispatchStatusResult extends Dispatch {
  /** Orders this call closed. */
  ordersDelivered?: number;
  /** Orders left open because the caller cannot certify receipt (C3). */
  ordersAwaitingConfirmation?: number;
  /** Orders on the trip outside the caller's scope, left untouched. */
  ordersOutOfScope?: number;
}
/** One row of a dispatch's audit trail (status changes + actions). */
export interface DispatchEvent {
  id: string;
  dispatchId: string;
  status: DispatchStatus | string;
  note: string | null;
  actorId: string | null;
  actorName?: string | null;
  createdAt: string;
}
/** `propertyId: null` is the org-wide default row; a property row overrides it there. */
export interface MealConfig { id: string; mealType: MealType; propertyId: string | null; displayLabel: string; brand: FoodBrand | null; sortOrder: number; isEnabled: boolean }
export interface MealWindow { id: string; brand: FoodBrand; propertyId: string | null; mealType: MealType; cutoffTime: string | null; serviceTime: string | null; leadTimeMinutes: number; isActive: boolean }
export interface FoodCutoffConfig { id: string; brand: string; propertyId: string | null; cutoffTime: string; isActive: boolean }
export interface Cutoff { mealType: MealType; cutoffTime: string | null; serviceTime: string | null; cutoffAt: string | null; isPastCutoff: boolean }
export interface FoodDefaults { defaultCutoff: string; wasteWindowMinutes: number }
/**
 * The two "Variety & safety rules" switches on the Menu Rules tab. Both default
 * to true server-side when unset, so a missing row behaves as the rules did when
 * they were hard-coded.
 */
export interface MenuRuleSettings {
  /** Reject a rotation plate whose dishes share an ingredient (server-enforced). */
  ingredientClashBlocks: boolean;
  /** Show the "used Tue" hint while picking. Never blocks a save. */
  flagRepeatsWithin3Days: boolean;
  /**
   * How many days apart two servings of a dish stop counting as a repeat.
   * Editable under Menu Rules; 1–14 (the cycle is measured the short way round,
   * so 14 already reaches every other day in it). Defaults to 3.
   */
  repeatWithinDays: number;
  /**
   * Require exactly one star dish on every meal's plate. Defaults OFF — unlike
   * its two neighbours, which default ON because they were hard-coded before
   * they were switches. Turning this on when no star dish exists is refused by
   * the server (422, details.reason === "NO_STAR_DISH").
   */
  starDishRequired: boolean;
  /**
   * Rule 3 — flag a dish served twice within one rotation week.
   * Rule 4 — flag a dish on the same weekday in another rotation week.
   *
   * Both are HINTS: nothing on the save path reads them, exactly like
   * flagRepeatsWithin3Days. Both default OFF, and both are scoped per meal.
   */
  flagSameWeekRepeats: boolean;
  flagSameWeekdayRepeats: boolean;
  /**
   * Rule 2 — enforce each ingredient's own `maxPerDay` across every meal of a
   * day. BLOCKS on save, like ingredientClashBlocks; the limits themselves live
   * on the ingredients, not here. Defaults OFF, and is inert until an
   * ingredient actually carries a limit.
   */
  ingredientDayCapBlocks: boolean;
  /** Whether the catalogue holds a star dish at all — what the editor needs to
   *  explain a refused toggle without a second round-trip. */
  hasStarDish?: boolean;
  /**
   * Which scope the returned values were resolved at. Present on reads/writes
   * that named a propertyId or kitchenId; the values themselves are always the
   * RESOLVED answer (property → kitchen → org default), never the raw row.
   */
  scope?: "GLOBAL" | "KITCHEN" | "PROPERTY";
}
/* ── Waste percentage: two metrics, two names, never one label ────────────────
 * INVARIANT (mirrors the server's, apps/api-server/src/routes/food-ops.ts):
 * no surface renders a bare "Waste %". The two denominators are different
 * metrics on purpose and legitimately disagree on the same product:
 *
 *   wastePctOfReceived = wasted / received — of the food that ACTUALLY ARRIVED,
 *     how much went in the bin. Kitchen efficiency. Served by /waste-analytics.
 *   wastePctOfOrdered  = wasted / ordered (DELIVERED only) — of what the property
 *     ASKED FOR, how much went in the bin. Demand forecasting. Served by
 *     /analytics and /home-analytics.
 *
 * They differ exactly when received ≠ ordered — the delivery variance this
 * module exists to report — so labelling both "Waste %" destroys one signal.
 * Render them as "Waste % (of received)" / "Waste % (of ordered)".
 * ───────────────────────────────────────────────────────────────────────── */
/** Waste totals for ONE unit. There is no cross-unit total — kilograms and
 *  plates do not add up, and reporting their sum was the M7 defect. */
export interface WasteByUnit { unit: string | null; wasted: number; ordered: number; wastePctOfOrdered: number }
export interface AnalyticsData {
  period: string; range: { from: string; to: string };
  /** One point per (date, unit) — collapse or pivot before charting. */
  wastageTrend: { date: string; unit: string | null; wasted: number }[];
  topWasteItems: { dishId: string; dishName: string | null; unit: string; wasted: number; ordered: number; wastePctOfOrdered: number }[];
  delays: { date: string; delayed: number; total: number }[];
  summary: { byUnit: WasteByUnit[]; delayedOrders: number; deliveredOrders: number };
}
// B3-17 — cross-property waste analytics (geography-scoped; OPS_EXCELLENCE/SUPER_ADMIN see all).
export type WasteGranularity = "day" | "month";
// Every dimension below carries `unit` in its grouping key (M7), so a property
// or dish wasted in two units appears twice — label with the unit, or pin one
// unit, before charting or slicing a "top 10".
/** RECEIVED basis throughout — every percentage here is kitchen efficiency and
 *  must be labelled "Waste % (of received)". See the invariant note above. */
export interface WasteAnalyticsData {
  range: { from: string; to: string };
  granularity: WasteGranularity;
  summary: {
    /** `wastePctOfReceived` is computed on CONFIRMED lines only — numerator and
     *  denominator share one basis. `wastedOnUnconfirmed` is the waste logged
     *  against trip-delivered lines (receivedQty NULL), which the percentage
     *  cannot describe and which must therefore be shown next to it. */
    byUnit: { unit: string | null; totalWasted: number; totalReceived: number; totalOrdered: number; wastePctOfReceived: number; wastedOnUnconfirmed: number }[];
    ordersWithWaste: number;
  };
  byProperty: { propertyId: string; name: string; city: string | null; cluster: string | null; unit: string | null; wastedQty: number; receivedQty: number; wastePctOfReceived: number; wastedOnUnconfirmed: number }[];
  byDish: { dishId: string | null; name: string; unit: string | null; wastedQty: number }[];
  byMealType: { mealType: MealType; unit: string | null; wastedQty: number }[];
  byMenu: { brand: string; unit: string | null; wastedQty: number }[];
  trend: { period: string; unit: string | null; wastedQty: number }[];
}

// WS7 — Unit-Lead Home dashboard analytics (aggregate across accessible properties).
export interface HomeAnalytics {
  period: string;
  range: { from: string; to: string };
  prevRange: { from: string; to: string };
  peopleOrderedTrend: { date: string; people: number }[];
  peopleByProperty: { propertyId: string; propertyName: string; people: number }[];
  peopleComparison: { current: number; prior: number; currentLabel: string; priorLabel: string };
  /** One point per (date, unit) — collapse or pivot before charting. */
  wastageTrend: { date: string; unit: string | null; wasted: number }[];
  topWasteItems: { dishId: string; dishName: string | null; unit: string; wasted: number; ordered: number; wastePctOfOrdered: number }[];
  orderDelays: { date: string; delayed: number; total: number }[];
  activeResidentTrend: { date: string; residents: number }[];
  occupancy: { totalBeds: number; activeGuests: number; occupancyPct: number; monthlyCollections: number };
  newSignups: { current: number; prior: number } | null;   // residents who moved in during the period
  renewals: { current: number; prior: number } | null;     // proxy: lease term completes in the period
  summary: {
    totalPeopleOrdered: number;
    /** `totalOrderedDelivered`, NOT `totalOrdered`, is the percentage's denominator:
     *  totalOrdered spans every live order, and an order still in flight has wasted
     *  nothing. Rendering wasted + totalOrdered beside the percentage shows three
     *  numbers where the third cannot be derived from the first two. */
    byUnit: { unit: string | null; totalWasted: number; totalOrdered: number; totalOrderedDelivered: number; wastePctOfOrdered: number }[];
    delayedOrders: number; deliveredOrders: number; activeResidents: number;
  };
}
export interface GuestRow { id: string; name: string; phone: string; email: string; gender: string | null; roomNumber: string | null; propertyId: string; propertyName: string | null; checkInDate: string | null; status: string }
export interface PropertyOverview { id: string; name: string; address: string; city: string; state: string; pincode: string; totalBeds: number; occupied: number; activeGuests: number; occupancyPct: number; monthlyRevenue: number }
export interface MyPropertyCard {
  id: string; name: string; city: string | null; brand: string | null;
  kitchenId: string | null; kitchenName: string | null;
  totalBeds: number; occupied: number; activeGuests: number; occupancyPct: number; monthlyRevenue: number;
  activeOrders: number; awaitingDelivery: number; deliveredCount: number; configured: boolean;
  heroImageUrl?: string | null;
  images?: string[];
}
// ─── Next Orders board (multi-property command centre) ────────────────────────
export type NextOrderStatus = "NOT_ORDERED" | "PARTIAL" | "ORDERED" | "NO_MENU" | "NOT_CONFIGURED";
export interface NextOrderMeal { mealType: MealType; label: string; orderId: string; orderNumber: string; status: OrderStatus }
export interface NextOrderProperty {
  propertyId: string; name: string; city: string | null; brand: string | null;
  configured: boolean; activeGuests: number;
  serviceDate: string;            // yyyy-MM-dd — next orderable IST day for this property
  cutoffTime: string | null;      // "HH:MM"
  cutoffAt: string | null;        // ISO instant the cut-off elapses for serviceDate
  isPastCutoff: boolean;
  availableMeals: { mealType: MealType; label: string }[];
  orderedMeals: NextOrderMeal[];
  status: NextOrderStatus;
}

export interface RevenueData { months: { month: string; total: number }[] }
export interface FullMenuMeal { mealType: MealType; label: string; dishes: { dishId: string; dishName: string; component: string; unit: string; slotLabel: string | null; sortOrder: number }[] }
export interface FullMenu { brand: FoodBrand; date: string; meals: FullMenuMeal[] }

// ─── Org hierarchy (India → City → Kitchen → Property → Brand) ────────────────
export interface HierarchyProperty {
  id: string; name: string; brand: string | null; kitchenId: string | null;
  city: string | null; totalBeds: number; active: number;
}
export interface HierarchyKitchen extends Kitchen { properties: HierarchyProperty[] }
export interface HierarchyCity extends City { kitchens: HierarchyKitchen[] }
export interface HierarchyTree {
  cities: HierarchyCity[];
  kitchensNoCity: HierarchyKitchen[];
  propertiesNoKitchen: HierarchyProperty[];
}

// ─── Per-item order preview (editable persons + auto/overridable qty) ─────────
export interface OrderPreviewItem {
  dishId: string; dishName: string; component: string; unit: string;
  slotLabel: string | null; sortOrder: number;
  qtyPerResident: number; defaultPersons: number; defaultOrderedQty: number;
  /** Side served with another dish on the same plate — grouped under its parent in the UI. */
  parentDishId?: string | null;
  /** Dish-level quantity pin — these rows render read-only in the order panel. */
  isQtyLocked?: boolean;
  lockedPersons?: number | null;
}
export interface OrderPreviewMeal { mealType: MealType; label: string; items: OrderPreviewItem[] }

// ─── Menu-composition rule engine ─────────────────────────────────────────────
export interface CompositionSlot {
  id?: string; slotLabel: string | null; component: string | null; preparation: string | null;
  minCount: number; maxCount: number | null; sortOrder: number;
  /**
   * The star slot. Synthesised by the server from the star-dish menu rule rather
   * than stored, so it carries the sentinel id STAR_SLOT_ID and must never be
   * sent back in a rule save — it would outlive the switch being turned off.
   * Matches star dishes only, and counts across the whole plate instead of
   * claiming a dish the way the other slots do.
   */
  isStar?: boolean;
}
/** The id the server gives every synthesised star slot (STAR_SLOT_ID). */
export const STAR_SLOT_ID = "__star__";
export interface CompositionRule { id: string; brand: string; mealType: MealType; kitchenId: string | null; propertyId: string | null; name: string | null; isActive: boolean; slots: CompositionSlot[] }
export interface SlotValidation { slotId: string; slotLabel: string | null; component: string | null; preparation: string | null; minCount: number; maxCount: number | null; count: number; matchedDishIds: string[]; status: "OK" | "MISSING" | "UNDER" | "OVER" }
export interface SharedIngredient { ingredientId: string; name: string; dishIds: string[] }
// Machine-readable verdict for hard-blocking a menu/slot selection (B3-16).
export type CompositionViolationType = "SLOT_MISSING" | "SLOT_UNDER" | "SLOT_OVER" | "SHARED_INGREDIENT";
export interface CompositionViolation { type: CompositionViolationType; message: string; dishIds: string[] }
export interface RotationValidation { ruleId: string | null; ruleName: string | null; slots: SlotValidation[]; unmatchedDishIds: string[]; isComplete: boolean; sharedIngredients: SharedIngredient[]; ok: boolean; violations: CompositionViolation[] }
export interface AutoFillItem { dishId: string; slotLabel: string | null; sortOrder: number }
export interface OrderPreview {
  brand: string | null; kitchenId: string | null; configured: boolean; meals: OrderPreviewMeal[];
}

type Envelope<T> = { success: boolean; data: T; meta?: PageMeta };
export interface PageMeta { total: number; page: number; limit: number; totalPages: number }

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "" && v !== "ALL") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** The whole order set behind a filter, plus whether the walk was cut short. */
export interface AllOrders { orders: FoodOrder[]; total: number; truncated: boolean }

/**
 * Page through GET /food/orders until the server runs out of rows.
 *
 * Invariant: a board that offers a bulk action must hold the WHOLE set, or say
 * plainly that it doesn't. The server clamps `limit` to 100 (lib/paginate.ts),
 * so one request silently truncates a busy day and "Accept all" would celebrate
 * while unfetched orders remain. Bounded at `maxPages` as a runaway stop; when
 * that bound cuts the walk short `truncated` is true so callers can report a
 * partial result instead of a complete one.
 *
 * `truncated` is derived from a SHORT PAGE, never from `all.length >= total`:
 * this is offset paging over a live table, so an order accepted or placed
 * between two requests shifts the window — rows get skipped or repeated and
 * `total` itself moves. Counting to a moving total reported a complete walk
 * over an incomplete set, which is exactly the claim the honesty banners rest
 * on. A page shorter than the limit is the only end-of-set the server actually
 * proves; ids are deduped so a shifted window can't inflate the count either.
 */
const ORDERS_PAGE_SIZE = 100;

async function listAllOrders(
  p: Record<string, unknown> = {}, maxPages = 5,
): Promise<AllOrders> {
  const all: FoodOrder[] = [];
  const seen = new Set<string>();
  let total = 0;
  let complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const res = await apiFetch<Envelope<FoodOrder[]>>(`/food/orders${qs({ ...p, limit: ORDERS_PAGE_SIZE, page })}`);
    const batch = res.data ?? [];
    for (const o of batch) if (!seen.has(o.id)) { seen.add(o.id); all.push(o); }
    total = Math.max(total, res.meta?.total ?? 0);
    if (batch.length < ORDERS_PAGE_SIZE) { complete = true; break; }
  }
  // Never report fewer than what is in hand — `total` can lag a concurrent insert.
  return { orders: all, total: Math.max(total, all.length), truncated: !complete };
}

// ─── Query-key factory (stable, structured) ──────────────────────────────────
export const foodKeys = {
  dashboard: (p: Record<string, unknown>) => ["food", "dashboard", p] as const,
  wastePending: (p: Record<string, unknown>) => ["food", "waste-pending", p] as const,
  orders: (p: Record<string, unknown>) => ["food", "orders", p] as const,
  order: (id: string) => ["food", "order", id] as const,
  kitchenSummary: (p: Record<string, unknown>) => ["food", "kitchen-summary", p] as const,
  reports: (p: Record<string, unknown>) => ["food", "reports", p] as const,
  reportsVariance: (p: Record<string, unknown>) => ["food", "reports-variance", p] as const,
  // O15/O16/O17 — on-time report, tolerance config, variance-by-day.
  reportsOnTime: (p: Record<string, unknown>) => ["food", "reports-ontime", p] as const,
  ontimeTolerance: () => ["food", "ontime-tolerance"] as const,
  orderHeadroom: () => ["food", "order-headroom"] as const,
  reportsVarianceByDay: (p: Record<string, unknown>) => ["food", "reports-variance-by-day", p] as const,
  dishes: (p: Record<string, unknown>) => ["food", "dishes", p] as const,
  dish: (id: string) => ["food", "dish", id] as const,
  ingredients: (p: Record<string, unknown> = {}) => ["food", "ingredients", p] as const,
  compositionRules: (p: Record<string, unknown> = {}) => ["food", "composition-rules", p] as const,
  /** Shared by the Menu Rules editor, the plate composer and the rotation board. */
  // Scoped: the same switches resolve differently per property/kitchen, so the
  // scope has to be part of the key or one property's answer would be served
  // from another's cache entry.
  menuRuleSettings: (p: Record<string, unknown> = {}) => ["food", "menu-rule-settings", p] as const,
  rotationValidate: (p: Record<string, unknown>) => ["food", "rotation-validate", p] as const,
  rotation: (p: Record<string, unknown>) => ["food", "menu-rotation", p] as const,
  rules: (p: Record<string, unknown>) => ["food", "rules", p] as const,
  partners: (p: Record<string, unknown>) => ["food", "delivery-partners", p] as const,
  agencies: (p: Record<string, unknown> = {}) => ["food", "agencies", p] as const,
  zones: () => ["food", "zones"] as const,
  cities: (zoneId?: string) => ["food", "cities", zoneId ?? "all"] as const,
  clusters: (cityId?: string) => ["food", "clusters", cityId ?? "all"] as const,
  scopes: (userId?: string) => ["food", "scopes", userId ?? "all"] as const,
  users: () => ["food", "users"] as const,
  assignableUnitLeads: () => ["properties", "assignable-unit-leads"] as const,
  propertyDetail: (id: string) => ["properties", "detail", id] as const,
  propertyPhotos: (id: string) => ["properties", "photos", id] as const,
  lookups: () => ["food", "lookups"] as const,
  brands: (p: Record<string, unknown> = {}) => ["food", "brands", p] as const,
  hierarchy: () => ["food", "hierarchy"] as const,
  orderPreview: (p: Record<string, unknown>) => ["food", "order-preview", p] as const,
  dispatches: () => ["food", "dispatches"] as const,
  dispatch: (id: string) => ["food", "dispatch", id] as const,
  dispatchEvents: (id: string) => ["food", "dispatch-events", id] as const,
  activeVehicles: () => ["food", "active-vehicles"] as const,
  agencyKitchens: (id: string) => ["food", "agency-kitchens", id] as const,
  kitchenAgencies: (id: string) => ["food", "kitchen-agencies", id] as const,
  kitchens: (p: Record<string, unknown> = {}) => ["food", "kitchens", p] as const,
  mealConfig: (p: Record<string, unknown> = {}) => ["food", "meal-config", p] as const,
  mealWindows: (p: Record<string, unknown> = {}) => ["food", "meal-windows", p] as const,
  cutoffConfig: (p: Record<string, unknown> = {}) => ["food", "cutoff-config", p] as const,
  cutoffs: (p: Record<string, unknown>) => ["food", "cutoffs", p] as const,
  analytics: (p: Record<string, unknown>) => ["food", "analytics", p] as const,
  // B3-17 — cross-property waste analytics dashboard.
  wasteAnalytics: (p: Record<string, unknown>) => ["food", "waste-analytics", p] as const,
  homeAnalytics: (p: Record<string, unknown>) => ["food", "home-analytics", p] as const,
  guests: (p: Record<string, unknown>) => ["food", "guests", p] as const,
  propertyOverview: (p: Record<string, unknown>) => ["food", "property-overview", p] as const,
  myProperties: () => ["food", "my-properties"] as const,
  nextOrders: () => ["food", "next-orders"] as const,
  revenue: (p: Record<string, unknown>) => ["food", "revenue", p] as const,
  fullMenu: (p: Record<string, unknown>) => ["food", "full-menu", p] as const,
  kitchenByPincode: (pincode: string) => ["food", "kitchen-by-pincode", pincode] as const,
  // WS9 — standalone order tracking by order number / id.
  trackOrder: (term: string) => ["food", "track", term] as const,
  orderDraft: (p: Record<string, unknown>) => ["food", "order-draft", p] as const,
};

// ─── API surface ─────────────────────────────────────────────────────────────
export const foodApi = {
  // Dashboard / summary / reports
  dashboard: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<DashboardData>>(`/food/dashboard${qs(p)}`).then((r) => r.data),
  wastePending: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<WastePendingRow[]>>(`/food/waste-pending${qs(p)}`).then((r) => r.data),
  kitchenSummary: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<KitchenSummary>>(`/food/kitchen-summary${qs(p)}`).then((r) => r.data),
  reports: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<ReportsData>>(`/food/reports${qs(p)}`).then((r) => r.data),
  // WS11 — aggregated ordered-vs-delivered variance table.
  reportsVariance: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<VarianceData>>(`/food/reports/variance${qs(p)}`).then((r) => r.data),
  // O15 — on-time delivery report (% on-time + per-day on-time/late trend).
  reportsOnTime: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<OnTimeReport>>(`/food/reports/on-time${qs(p)}`).then((r) => r.data),
  // O17 — ordered-vs-received variance per service-day (filterable by mealType).
  reportsVarianceByDay: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<VarianceByDayData>>(`/food/reports/variance-by-day${qs(p)}`).then((r) => r.data),
  // O16 — global on-time tolerance (read: any food user; write: SUPER_ADMIN).
  ontimeTolerance: () =>
    apiFetch<Envelope<OnTimeTolerance>>(`/food/settings/ontime-tolerance`).then((r) => r.data),
  updateOntimeTolerance: (minutes: number | string) =>
    apiFetch<Envelope<OnTimeTolerance>>(`/food/settings/ontime-tolerance`, { method: "PUT", body: JSON.stringify({ minutes }) }).then((r) => r.data),
  // Global ordering headroom (read: anyone who can place/see orders; write:
  // SUPER_ADMIN + OPS_EXCELLENCE).
  orderHeadroom: () =>
    apiFetch<Envelope<OrderHeadroom>>(`/food/settings/order-headroom`).then((r) => r.data),
  updateOrderHeadroom: (pct: number | string) =>
    apiFetch<Envelope<OrderHeadroom>>(`/food/settings/order-headroom`, { method: "PUT", body: JSON.stringify({ pct }) }).then((r) => r.data),
  reportsExportUrl: (p: Record<string, unknown> = {}) => `/api/food/reports/export${qs(p)}`,

  // Orders
  // Optional filters: serviceDate (exact "yyyy-MM-dd"), status (single e.g. "PLACED"
  // or CSV e.g. "PLACED,ACCEPTED"), plus propertyId/brand/mealType/from/to/search/page/limit.
  listOrders: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<FoodOrder[]>>(`/food/orders${qs(p)}`),
  listAllOrders: (p: Record<string, unknown> = {}, maxPages = 5) => listAllOrders(p, maxPages),
  getOrder: (id: string) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}`).then((r) => r.data),
  // WS9 — standalone tracking lookup by human order number OR raw id (scoped to accessible properties).
  trackOrder: (term: string) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/track${qs({ orderNumber: term })}`).then((r) => r.data),
  placeOrder: (body: Record<string, unknown>) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
  // Server-side place-order drafts — per (user, property, serviceDate) so a
  // half-built order follows the unit lead across browsers/devices.
  orderDraft: (p: { propertyId: string; serviceDate: string }) =>
    apiFetch<Envelope<{ payload: unknown; updatedAt: string } | null>>(`/food/order-draft${qs(p)}`).then((r) => r.data),
  saveOrderDraft: (body: { propertyId: string; serviceDate: string; payload: unknown }) =>
    apiFetch<Envelope<{ updatedAt: string }>>(`/food/order-draft`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.data),
  deleteOrderDraft: (p: { propertyId: string; serviceDate: string }) =>
    apiFetch<Envelope<null>>(`/food/order-draft${qs(p)}`, { method: "DELETE" }).then((r) => r.data),
  updateOrder: (id: string, body: Record<string, unknown>) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.data),
  // B3-6 — edit an order's people count (the only editable quantity input). Item
  // quantities + totalQuantity are recomputed server-side from this; never sent by
  // the client. `notes` is optionally editable. Allowed while PLACED/ACCEPTED/DISPATCHED.
  editOrderPeople: (id: string, residentsCount: number, staffCount: number, notes?: string | null) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}`, {
      method: "PUT",
      body: JSON.stringify(
        notes !== undefined
          ? { residentsCount, staffCount, notes }
          : { residentsCount, staffCount },
      ),
    }).then((r) => r.data),
  // Dish-level edit of a placed order — the payload the ordering grid produces,
  // so a correction goes through the same screen (and the same server-side menu +
  // portion-rule validation) as the original order. The list sent IS the order's
  // new line-up: a dish left out is dropped, a dish added back is inserted.
  // PLACED-only and pre-cut-off, enforced server-side.
  editOrderItems: (
    id: string,
    body: {
      residentsCount: number;
      staffCount: number;
      items: Array<{ dishId: string; personsCount: number; orderedQty: number }>;
    },
  ) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.data),
  cancelOrder: (id: string, reason?: string) =>
    apiFetch<Envelope<FoodOrder>>(`/food/orders/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }).then((r) => r.data),
  // Kitchen items: ordered vs prepared per dish — the pre-dispatch review on
  // Kitchen Home. PATCH adjusts what the kitchen actually sends (ACCEPTED only).
  kitchenItems: (orderId: string) =>
    apiFetch<Envelope<KitchenItem[]>>(`/food/orders/${orderId}/kitchen-items`).then((r) => r.data),
  updateKitchenItems: (orderId: string, items: { id: string; preparedQty: number }[], reason: string) =>
    apiFetch<Envelope<{ updated: number }>>(`/food/orders/${orderId}/kitchen-items`, {
      method: "PATCH", body: JSON.stringify({ items, reason }),
    }).then((r) => r.data),
  dispatchOrder: (id: string, body: { deliveryPartnerId?: string; action?: "start" | "dispatch" }) =>
    apiFetch<Envelope<FoodOrder>>(`/food/orders/${id}/dispatch`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
  bulkDispatch: (orderIds: string[], deliveryPartnerId: string) =>
    apiFetch<Envelope<unknown>>(`/food/orders/dispatch/bulk`, { method: "POST", body: JSON.stringify({ orderIds, deliveryPartnerId }) }).then((r) => r.data),
  confirmDelivery: (id: string, items: { itemId: string; receivedQty: number }[], remarks?: string) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}/confirm-delivery`, { method: "POST", body: JSON.stringify({ items, remarks }) }).then((r) => r.data),
  recordWaste: (id: string, items: { itemId: string; wastedQty: number }[]) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}/waste`, { method: "POST", body: JSON.stringify({ items }) }).then((r) => r.data),
  // Additional Food — log top-up sourced from another property after receipt.
  // `requestId` is the idempotency key: mint ONE per dialog open and send it on
  // every retry, so a double-click replays onto the same rows instead of
  // double-counting food that arrived once (M18). `duplicate` says which happened.
  addAdditionalFood: (orderId: string, body: { sourcePropertyId: string; requestId: string; items: { dishId: string; qty: number }[] }) =>
    apiFetch<Envelope<{ requestId: string; duplicate: boolean }>>(`/food/orders/${orderId}/additional-food`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
  propertyOptions: () =>
    apiFetch<Envelope<{ id: string; name: string; city: string | null }[]>>(`/food/property-options`).then((r) => r.data),

  // Resolve the kitchen that serves a pincode (read-only kitchen on the property form)
  kitchenByPincode: (pincode: string) =>
    apiFetch<Envelope<KitchenByPincode>>(`/food/kitchen-by-pincode${qs({ pincode })}`).then((r) => r.data),

  // Bidirectional geocoding (server-side via OSM/Nominatim; provider-swappable).
  // forward: address text → coordinates; reverse: coordinates → address + pincode.
  geocodeForward: (q: string) =>
    apiFetch<Envelope<GeocodeForward>>(`/geocode/forward${qs({ q })}`).then((r) => r.data),
  geocodeReverse: (lat: number, lon: number) =>
    apiFetch<Envelope<GeocodeReverse>>(`/geocode/reverse${qs({ lat, lon })}`).then((r) => r.data),

  // Lookups + master data
  lookups: () => apiFetch<Envelope<FoodLookups>>(`/food/lookups`).then((r) => r.data),
  foodUsers: () => apiFetch<Envelope<FoodUser[]>>(`/food/food-users`).then((r) => r.data),
  // Unit-leads taggable to a property (property-form multi-select; /properties scope).
  assignableUnitLeads: () => apiFetch<Envelope<AssignableUnitLead[]>>(`/properties/assignable-unit-leads`).then((r) => r.data),
  // Property detail incl. form-prefill extras (tagged unit-leads + cut-off override).
  propertyDetail: (id: string) =>
    apiFetch<Envelope<{ code: string | null; unitLeadIds: string[]; cutoffTime: string | null }>>(`/properties/${id}`).then((r) => r.data),

  // Property photos (gallery + hero). All under /properties/:id (PROPERTIES scope).
  // url fields are fresh presigned R2 URLs (~1h TTL) — re-fetch to refresh.
  listPropertyPhotos: (propertyId: string) =>
    apiFetch<Envelope<PropertyPhoto[]>>(`/properties/${propertyId}/photos`).then((r) => r.data),
  // dataUrl: "data:image/<jpeg|png|webp|gif>;base64,<...>" — keep the payload under
  // ~1mb (downscale client-side); decoded image hard-capped at 8MB server-side.
  createPropertyPhoto: (propertyId: string, body: { dataUrl: string; caption?: string; isHero?: boolean }) =>
    apiFetch<Envelope<PropertyPhoto>>(`/properties/${propertyId}/photos`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
  updatePropertyPhoto: (propertyId: string, photoId: string, body: { isHero?: boolean; sortOrder?: number; caption?: string | null }) =>
    apiFetch<Envelope<Omit<PropertyPhoto, "url">>>(`/properties/${propertyId}/photos/${photoId}`, { method: "PATCH", body: JSON.stringify(body) }).then((r) => r.data),
  deletePropertyPhoto: (propertyId: string, photoId: string) =>
    apiFetch<{ success: boolean; message: string }>(`/properties/${propertyId}/photos/${photoId}`, { method: "DELETE" }),

  // Brands master (admin-managed list)
  listBrands: (p: Record<string, unknown> = {}) => apiFetch<Envelope<FoodBrandRow[]>>(`/food/brands${qs(p)}`).then((r) => r.data),
  createBrand: (b: Record<string, unknown>) => apiFetch<Envelope<FoodBrandRow>>(`/food/brands`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateBrand: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<FoodBrandRow>>(`/food/brands/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteBrand: (id: string) => apiFetch<Envelope<unknown>>(`/food/brands/${id}`, { method: "DELETE" }),

  // Org hierarchy tree (India → City → Kitchen → Property)
  hierarchy: () => apiFetch<Envelope<HierarchyTree>>(`/food/hierarchy`).then((r) => r.data),
  assignBrand: (propertyId: string, brand: string | null) => apiFetch<Envelope<unknown>>(`/food/properties/${propertyId}/assign-brand`, { method: "POST", body: JSON.stringify({ brand }) }),
  assignKitchen: (propertyId: string, kitchenId: string | null) => apiFetch<Envelope<unknown>>(`/food/properties/${propertyId}/assign-kitchen`, { method: "POST", body: JSON.stringify({ kitchenId }) }),

  listDishes: (p: Record<string, unknown> = {}) => apiFetch<Envelope<Dish[]>>(`/food/dishes${qs(p)}`).then((r) => r.data),
  getDish: (id: string) => apiFetch<Envelope<Dish>>(`/food/dishes/${id}`).then((r) => r.data),
  createDish: (b: Record<string, unknown>) => apiFetch<Envelope<Dish>>(`/food/dishes`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  /**
   * Un-pairing a side cascades into the rotation (a chosen side is stored as a
   * rotation row), so the server reports how many planned plates it had to strip
   * — the drawer surfaces that rather than letting plates change silently.
   */
  updateDish: (id: string, b: Record<string, unknown>) =>
    apiFetch<Envelope<Dish> & { meta?: { rotationSidesRemoved?: number } }>(`/food/dishes/${id}`, { method: "PUT", body: JSON.stringify(b) })
      .then((r) => ({ dish: r.data, rotationSidesRemoved: r.meta?.rotationSidesRemoved ?? 0 })),
  deleteDish: (id: string) => apiFetch<Envelope<unknown>>(`/food/dishes/${id}`, { method: "DELETE" }),

  // Ingredients master
  listIngredients: (p: Record<string, unknown> = {}) => apiFetch<Envelope<Ingredient[]>>(`/food/ingredients${qs(p)}`).then((r) => r.data),
  createIngredient: (b: Record<string, unknown>) => apiFetch<Envelope<Ingredient>>(`/food/ingredients`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateIngredient: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<Ingredient>>(`/food/ingredients/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteIngredient: (id: string) => apiFetch<Envelope<unknown>>(`/food/ingredients/${id}`, { method: "DELETE" }),

  listRotation: (p: Record<string, unknown> = {}) => apiFetch<Envelope<MenuRotationRow[]>>(`/food/menu-rotation${qs(p)}`).then((r) => r.data),
  createRotation: (b: Record<string, unknown>) => apiFetch<Envelope<MenuRotationRow>>(`/food/menu-rotation`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  createRotationBulk: (b: Record<string, unknown>) => apiFetch<Envelope<MenuRotationRow[]>>(`/food/menu-rotation/bulk`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  replaceRotationSlot: (b: Record<string, unknown>) => apiFetch<Envelope<MenuRotationRow[]>>(`/food/menu-rotation/slot`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  validateRotation: (p: Record<string, unknown> = {}) => apiFetch<Envelope<RotationValidation>>(`/food/menu-rotation/validate${qs(p)}`).then((r) => r.data),
  // B3-16 — validate a dish selection against the composition rule + shared-ingredient
  // check. Returns the full RotationValidation including the machine-readable
  // `ok` / `violations` verdict to HARD-BLOCK a menu/slot save. Pass dishIds as an
  // array (qs() serializes it) plus brand + mealType (and optional kitchenId).
  // `sideDishIds` are excluded from composition-slot counting server-side (a
  // paired Bhature must not fill the meal's "1 BREAD" slot) but still checked
  // for shared ingredients.
  validateComposition: (p: { brand: string; mealType: MealType | string; kitchenId?: string | null; dishIds: string[]; sideDishIds?: string[] }) =>
    apiFetch<Envelope<RotationValidation>>(`/food/menu-rotation/validate${qs({ ...p, dishIds: p.dishIds.join(","), sideDishIds: (p.sideDishIds ?? []).join(",") })}`).then((r) => r.data),
  autoFillRotation: (p: Record<string, unknown> = {}) => apiFetch<Envelope<AutoFillItem[]>>(`/food/menu-rotation/auto-fill${qs(p)}`).then((r) => r.data),
  // Menu-composition rules
  listCompositionRules: (p: Record<string, unknown> = {}) => apiFetch<Envelope<CompositionRule[]>>(`/food/composition-rules${qs(p)}`).then((r) => r.data),
  createCompositionRule: (b: Record<string, unknown>) => apiFetch<Envelope<CompositionRule>>(`/food/composition-rules`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateCompositionRule: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<CompositionRule>>(`/food/composition-rules/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteCompositionRule: (id: string) => apiFetch<Envelope<unknown>>(`/food/composition-rules/${id}`, { method: "DELETE" }),
  updateRotation: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<MenuRotationRow>>(`/food/menu-rotation/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteRotation: (id: string) => apiFetch<Envelope<unknown>>(`/food/menu-rotation/${id}`, { method: "DELETE" }),
  resolveMenu: (p: { brand?: string; kitchenId?: string; propertyId?: string; mealType: string; date: string }) => apiFetch<Envelope<unknown[]>>(`/food/menu-rotation/resolve${qs(p)}`).then((r) => r.data),

  listRules: (p: Record<string, unknown> = {}) => apiFetch<Envelope<PerResidentRule[]>>(`/food/rules${qs(p)}`).then((r) => r.data),
  createRule: (b: Record<string, unknown>) => apiFetch<Envelope<PerResidentRule>>(`/food/rules`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateRule: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<PerResidentRule>>(`/food/rules/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteRule: (id: string) => apiFetch<Envelope<unknown>>(`/food/rules/${id}`, { method: "DELETE" }),

  listPartners: (p: Record<string, unknown> = {}) => apiFetch<Envelope<DeliveryPartner[]>>(`/food/delivery-partners${qs(p)}`).then((r) => r.data),
  createPartner: (b: Record<string, unknown>) => apiFetch<Envelope<DeliveryPartner>>(`/food/delivery-partners`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updatePartner: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<DeliveryPartner>>(`/food/delivery-partners/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deletePartner: (id: string) => apiFetch<Envelope<unknown>>(`/food/delivery-partners/${id}`, { method: "DELETE" }),

  // Delivery agencies (→ locations + vehicles)
  listAgencies: (p: Record<string, unknown> = {}) => apiFetch<Envelope<Agency[]>>(`/food/agencies${qs(p)}`).then((r) => r.data),
  createAgency: (b: Record<string, unknown>) => apiFetch<Envelope<Agency>>(`/food/agencies`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateAgency: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<Agency>>(`/food/agencies/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteAgency: (id: string) => apiFetch<Envelope<unknown>>(`/food/agencies/${id}`, { method: "DELETE" }),
  createAgencyLocation: (agencyId: string, b: Record<string, unknown>) => apiFetch<Envelope<AgencyLocation>>(`/food/agencies/${agencyId}/locations`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateAgencyLocation: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<AgencyLocation>>(`/food/agency-locations/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteAgencyLocation: (id: string) => apiFetch<Envelope<unknown>>(`/food/agency-locations/${id}`, { method: "DELETE" }),
  createAgencyVehicle: (agencyId: string, b: Record<string, unknown>) => apiFetch<Envelope<AgencyVehicle>>(`/food/agencies/${agencyId}/vehicles`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateAgencyVehicle: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<AgencyVehicle>>(`/food/agency-vehicles/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteAgencyVehicle: (id: string) => apiFetch<Envelope<unknown>>(`/food/agency-vehicles/${id}`, { method: "DELETE" }),
  // Agency ↔ kitchen serving links. `search` filters by agency name; `vehicleSearch`
  // matches agencies owning a vehicle whose number ilike-matches.
  getAgencyKitchens: (agencyId: string) => apiFetch<Envelope<AgencyKitchenLink[]>>(`/food/agencies/${agencyId}/kitchens`).then((r) => r.data),
  setAgencyKitchens: (agencyId: string, kitchenIds: string[]) =>
    apiFetch<Envelope<{ agencyId: string; kitchenIds: string[] }>>(`/food/agencies/${agencyId}/kitchens`, { method: "PUT", body: JSON.stringify({ kitchenIds }) }).then((r) => r.data),
  getKitchenAgencies: (kitchenId: string) => apiFetch<Envelope<KitchenAgencyLink[]>>(`/food/kitchens/${kitchenId}/agencies`).then((r) => r.data),

  // ─── Org spine: zone → city → cluster → properties.clusterId ───────────────
  // Every one of these rows is load-bearing for access, not a reporting tag:
  // resolveAccessiblePropertyIds walks exactly this chain (skipping any node
  // whose isActive is false), so an edit here is an access change. The delete
  // endpoints hard-delete and answer 409 with a `details` string naming what is
  // still attached — surface it rather than a generic failure.
  listZones: () => apiFetch<Envelope<Zone[]>>(`/food/zones`).then((r) => r.data),
  createZone: (b: Record<string, unknown>) => apiFetch<Envelope<Zone>>(`/food/zones`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateZone: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<Zone>>(`/food/zones/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteZone: (id: string) => apiFetch<Envelope<unknown>>(`/food/zones/${id}`, { method: "DELETE" }),
  listCities: (zoneId?: string) => apiFetch<Envelope<City[]>>(`/food/cities${qs({ zoneId })}`).then((r) => r.data),
  createCity: (b: Record<string, unknown>) => apiFetch<Envelope<City>>(`/food/cities`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateCity: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<City>>(`/food/cities/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteCity: (id: string) => apiFetch<Envelope<unknown>>(`/food/cities/${id}`, { method: "DELETE" }),
  listClusters: (cityId?: string) => apiFetch<Envelope<Cluster[]>>(`/food/clusters${qs({ cityId })}`).then((r) => r.data),
  createCluster: (b: Record<string, unknown>) => apiFetch<Envelope<Cluster>>(`/food/clusters`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateCluster: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<Cluster>>(`/food/clusters/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteCluster: (id: string) => apiFetch<Envelope<unknown>>(`/food/clusters/${id}`, { method: "DELETE" }),
  // `clusterId` is nullable only for org-wide callers — the server refuses to
  // strand a property for a scoped one. No UI offers the clear.
  assignCluster: (propertyId: string, clusterId: string | null) => apiFetch<Envelope<unknown>>(`/food/properties/${propertyId}/assign-cluster`, { method: "POST", body: JSON.stringify({ clusterId }) }),

  /** Live grants only; pass includeRevoked to see the revocation history too. */
  listScopes: (userId?: string, includeRevoked?: boolean) =>
    apiFetch<Envelope<UserScope[]>>(`/food/scopes${qs({ userId, includeRevoked: includeRevoked ? "true" : undefined })}`).then((r) => r.data),
  createScope: (b: Record<string, unknown>) => apiFetch<Envelope<UserScope>>(`/food/scopes`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  deleteScope: (id: string) => apiFetch<Envelope<unknown>>(`/food/scopes/${id}`, { method: "DELETE" }),

  // ─── Phase 1–3 ─────────────────────────────────────────────────────────────
  // Kitchens
  listKitchens: (p: Record<string, unknown> = {}) => apiFetch<Envelope<Kitchen[]>>(`/food/kitchens${qs(p)}`).then((r) => r.data),
  createKitchen: (b: Record<string, unknown>) => apiFetch<Envelope<Kitchen>>(`/food/kitchens`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateKitchen: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<Kitchen>>(`/food/kitchens/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteKitchen: (id: string) => apiFetch<Envelope<unknown>>(`/food/kitchens/${id}`, { method: "DELETE" }),

  // Dispatch trips
  listDispatches: () => apiFetch<Envelope<Dispatch[]>>(`/food/dispatches`).then((r) => r.data),
  getDispatch: (id: string) => apiFetch<Envelope<DispatchDetail>>(`/food/dispatches/${id}`).then((r) => r.data),
  // Vehicle ids currently on an ACTIVE trip — LOADING/IN_TRANSIT/PARTIAL (to
  // disable in-use vehicles in the picker). A PARTIAL trip still has the van out.
  getActiveVehicles: () => apiFetch<Envelope<{ vehicleIds: string[] }>>(`/food/dispatches/active-vehicles`).then((r) => r.data.vehicleIds),
  // Audit trail for one dispatch, newest-first.
  getDispatchEvents: (id: string) => apiFetch<Envelope<DispatchEvent[]>>(`/food/dispatches/${id}/events`).then((r) => r.data),
  // Create a LOADING dispatch from selected orders. Pass departNow:true to send it
  // straight to IN_TRANSIT. Throws on 400 (missing orderIds/agency) / 422 (vehicle or
  // kitchen validation) with the server's error message.
  createDispatch: (b: Record<string, unknown>) => apiFetch<Envelope<Dispatch & { dispatchedCount: number }>>(`/food/dispatches`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  // Status transition. A 422 (`Cannot move from X to Y`) propagates as a thrown Error
  // whose message is the server's transition explanation. `note` is optional audit text.
  //
  // Completing the TRIP no longer closes its orders for a caller who cannot
  // certify receipt (C3), so the response reports the split: how many stops
  // actually closed, how many are waiting on the receiving property, and how
  // many were outside the caller's scope. Ignoring these makes "Trip marked
  // Delivered" a lie — the orders can all still be open.
  updateDispatchStatus: (id: string, status: DispatchStatus, note?: string) =>
    apiFetch<Envelope<DispatchStatusResult>>(`/food/dispatches/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify(note !== undefined ? { status, note } : { status }),
    }).then((r) => r.data),
  // Convenience: move a LOADING dispatch to IN_TRANSIT (depart now).
  departDispatch: (id: string, note?: string) =>
    apiFetch<Envelope<Dispatch>>(`/food/dispatches/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify(note !== undefined ? { status: "IN_TRANSIT", note } : { status: "IN_TRANSIT" }),
    }).then((r) => r.data),
  // Cancel a dispatch, reverting its DISPATCHED orders back to ACCEPTED.
  cancelDispatch: (id: string, reason?: string) =>
    apiFetch<Envelope<Dispatch & { revertedCount: number; deliveredCount: number }>>(`/food/dispatches/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }).then((r) => r.data),
  // Mark a single order on a dispatch delivered (or undo). markTripDelivered rolls the
  // whole trip to DELIVERED/PARTIAL once all active orders are delivered. Returns the
  // (possibly transitioned) dispatch.
  setOrderDelivered: (id: string, orderId: string, b: { delivered: boolean; remarks?: string; markTripDelivered?: boolean }) =>
    apiFetch<Envelope<Dispatch>>(`/food/dispatches/${id}/orders/${orderId}`, { method: "PATCH", body: JSON.stringify(b) }).then((r) => r.data),

  // Kitchen accept / reject
  acceptOrder: (id: string) => apiFetch<Envelope<FoodOrder>>(`/food/orders/${id}/accept`, { method: "POST", body: "{}" }).then((r) => r.data),
  rejectOrder: (id: string, reason?: string) => apiFetch<Envelope<FoodOrder>>(`/food/orders/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }).then((r) => r.data),

  // Per-item order preview (editable persons + auto/overridable qty) + multi-meal batch
  orderPreview: (p: Record<string, unknown> = {}) => apiFetch<Envelope<OrderPreview>>(`/food/order-preview${qs(p)}`).then((r) => r.data),
  placeOrderBatch: (b: Record<string, unknown>) => apiFetch<Envelope<{ batch: OrderBatch; orders: FoodOrder[] }>>(`/food/order-batches`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),

  // Meal config + cut-off windows
  // Pass `propertyId` to narrow to one property's rows plus the org defaults they
  // override; omit it for every row (which properties have diverged).
  mealConfig: (p: Record<string, unknown> = {}) => apiFetch<Envelope<MealConfig[]>>(`/food/meal-config${qs(p)}`).then((r) => r.data),
  // `propertyId` in the body picks the scope written: absent/null edits the
  // org-wide default, set upserts that property's override.
  updateMealConfig: (mealType: string, b: Record<string, unknown>) => apiFetch<Envelope<MealConfig>>(`/food/meal-config/${mealType}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  /** Drops a property's override so the meal falls back to the org-wide default. */
  deleteMealConfigOverride: (mealType: string, propertyId: string) => apiFetch<Envelope<{ id: string }>>(`/food/meal-config/${mealType}${qs({ propertyId })}`, { method: "DELETE" }).then((r) => r.data),
  listMealWindows: (p: Record<string, unknown> = {}) => apiFetch<Envelope<MealWindow[]>>(`/food/meal-windows${qs(p)}`).then((r) => r.data),
  createMealWindow: (b: Record<string, unknown>) => apiFetch<Envelope<MealWindow>>(`/food/meal-windows`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateMealWindow: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<MealWindow>>(`/food/meal-windows/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteMealWindow: (id: string) => apiFetch<Envelope<unknown>>(`/food/meal-windows/${id}`, { method: "DELETE" }),
  // Single cut-off per brand (applies to all meals; property-overridable)
  listCutoffConfig: (p: Record<string, unknown> = {}) => apiFetch<Envelope<FoodCutoffConfig[]>>(`/food/cutoff-config${qs(p)}`).then((r) => r.data),
  createCutoffConfig: (b: Record<string, unknown>) => apiFetch<Envelope<FoodCutoffConfig>>(`/food/cutoff-config`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateCutoffConfig: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<FoodCutoffConfig>>(`/food/cutoff-config/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteCutoffConfig: (id: string) => apiFetch<Envelope<unknown>>(`/food/cutoff-config/${id}`, { method: "DELETE" }),
  cutoffs: (p: Record<string, unknown> = {}) => apiFetch<Envelope<Cutoff[]>>(`/food/cutoffs${qs(p)}`).then((r) => r.data),

  // Global food defaults (system_config) — read by any food user, written by SUPER_ADMIN.
  foodDefaults: () => apiFetch<Envelope<FoodDefaults>>(`/food/system-config/food-defaults`).then((r) => r.data),
  updateFoodDefaults: (b: { defaultCutoff?: string; wasteWindowMinutes?: number }) =>
    apiFetch<Envelope<FoodDefaults>>(`/food/system-config/food-defaults`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),

  // Menu rule switches (system_config) — read and written by FOOD_SETTINGS holders.
  // Both take an optional scope. Omit it for the org-wide values; pass
  // propertyId (or kitchenId) to read the RESOLVED answer for that scope, or to
  // write an override there. On write, an explicit null on a setting clears the
  // override so it inherits again.
  menuRuleSettings: (p: { propertyId?: string; kitchenId?: string } = {}) =>
    apiFetch<Envelope<MenuRuleSettings>>(`/food/system-config/menu-rules${qs(p)}`).then((r) => r.data),
  updateMenuRuleSettings: (
    b: Partial<Record<"ingredientClashBlocks" | "flagRepeatsWithin3Days", boolean | null>>
      & { repeatWithinDays?: number | null; propertyId?: string | null; kitchenId?: string | null },
  ) =>
    apiFetch<Envelope<MenuRuleSettings>>(`/food/system-config/menu-rules`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),

  // Menu (full day + share)
  fullMenu: (p: Record<string, unknown> = {}) => apiFetch<Envelope<FullMenu>>(`/food/menu/full${qs(p)}`).then((r) => r.data),
  shareMenu: (b: Record<string, unknown>) => apiFetch<Envelope<{ recipientCount: number }>>(`/food/menu/share`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),

  // Analytics
  analytics: (p: Record<string, unknown> = {}) => apiFetch<Envelope<AnalyticsData>>(`/food/analytics${qs(p)}`).then((r) => r.data),
  // B3-17 — cross-property waste analytics (geography-scoped). Filters: from/to/propertyId/clusterId/cityId/brand/granularity.
  wasteAnalytics: (p: Record<string, unknown> = {}) => apiFetch<Envelope<WasteAnalyticsData>>(`/food/waste-analytics${qs(p)}`).then((r) => r.data),
  homeAnalytics: (p: Record<string, unknown> = {}) => apiFetch<Envelope<HomeAnalytics>>(`/food/home-analytics${qs(p)}`).then((r) => r.data),

  // Unit-Lead home insights
  myProperties: () => apiFetch<Envelope<MyPropertyCard[]>>(`/food/my-properties`).then((r) => r.data),
  nextOrders: () => apiFetch<Envelope<NextOrderProperty[]>>(`/food/next-orders`).then((r) => r.data),
  propertyOverview: (p: Record<string, unknown> = {}) => apiFetch<Envelope<PropertyOverview | null>>(`/food/property-overview${qs(p)}`).then((r) => r.data),
  revenue: (p: Record<string, unknown> = {}) => apiFetch<Envelope<RevenueData>>(`/food/revenue${qs(p)}`).then((r) => r.data),
  guests: (p: Record<string, unknown> = {}) => apiFetch<Envelope<GuestRow[]>>(`/food/guests${qs(p)}`),

  // Export URLs (open in a new tab / anchor download).
  // WS11: CSV + PDF + XLS (Excel) — same endpoints, .xls suffix mirrors .csv/.pdf.
  reportsExportCsvUrl: (p: Record<string, unknown> = {}) => `/api/food/reports/export.csv${qs(p)}`,
  reportsExportPdfUrl: (p: Record<string, unknown> = {}) => `/api/food/reports/export.pdf${qs(p)}`,
  reportsExportXlsUrl: (p: Record<string, unknown> = {}) => `/api/food/reports/export.xls${qs(p)}`,
  // O20 — report-aware export URL builder. fmt ∈ csv|pdf|xls; the `report` filter
  // (orders|variance|waste|ontime) selects the widget being exported.
  reportsExportFmtUrl: (fmt: "csv" | "pdf" | "xls", p: Record<string, unknown> = {}) => `/api/food/reports/export.${fmt}${qs(p)}`,
  guestsExportCsvUrl: (p: Record<string, unknown> = {}) => `/api/food/guests/export.csv${qs(p)}`,
  guestsExportPdfUrl: (p: Record<string, unknown> = {}) => `/api/food/guests/export.pdf${qs(p)}`,
  guestsExportXlsUrl: (p: Record<string, unknown> = {}) => `/api/food/guests/export.xls${qs(p)}`,
  rotationExportCsvUrl: (p: Record<string, unknown> = {}) => `/api/food/menu-rotation/export.csv${qs(p)}`,
  rotationExportPdfUrl: (p: Record<string, unknown> = {}) => `/api/food/menu-rotation/export.pdf${qs(p)}`,

  // B3-17 — per-widget waste-analytics export. fmt ∈ csv|xlsx|pdf (xlsx → Excel via
  // xls encoder); the `widget` param (property|dish|mealtype|menu|trend) selects the
  // dataset, alongside the same filters as wasteAnalytics().
  wasteAnalyticsExportUrl: (fmt: "csv" | "xlsx" | "pdf", widget: string, p: Record<string, unknown> = {}) =>
    `/api/food/waste-analytics/export.${fmt}${qs({ ...p, widget })}`,
};

// ─── Display helpers ─────────────────────────────────────────────────────────
export const MEAL_LABEL: Record<MealType, string> = {
  BREAKFAST: "Breakfast", LUNCH: "Lunch", SNACKS: "High Tea / Evening Snacks", DINNER: "Dinner",
};
/** Canonical order-status pill (label + soft-token tone) — one source of truth
 *  for every status badge across the food pages. */
export const ORDER_STATUS_PILL: Record<OrderStatus, { label: string; cls: string }> = {
  PLACED:    { label: "Placed",     cls: "bg-info-soft text-info" },
  ACCEPTED:  { label: "Accepted",   cls: "bg-info-soft text-info" },
  DISPATCHED:{ label: "Dispatched", cls: "bg-warning-soft text-warning" },
  DELIVERED: { label: "Received ✓", cls: "bg-success-soft text-success" },
  CANCELLED: { label: "Cancelled",  cls: "bg-muted text-muted-foreground" },
  REJECTED:  { label: "Rejected",   cls: "bg-danger-soft text-destructive" },
};
/** Safe pill lookup — never throws on an unknown/legacy status (e.g. a retired
 *  enum value like PREPARING lingering on an old row); falls back to a neutral
 *  pill showing the raw status text. */
export const orderStatusPill = (status: string): { label: string; cls: string } =>
  ORDER_STATUS_PILL[status as OrderStatus] ?? {
    label: status ? status.charAt(0) + status.slice(1).toLowerCase() : "—",
    cls: "bg-muted text-muted-foreground",
  };
/** Normalise a serviceDate ISO timestamp to its LOCAL calendar-day key ("yyyy-MM-dd"). */
export const serviceDayKey = (iso: string) => format(parseISO(iso), "yyyy-MM-dd");
/** Short display name — "High Tea / Evening Snacks" → "High Tea". */
export const shortMeal = (m: MealType): string => MEAL_LABEL[m].split(" /")[0];
/** User-facing label for a group order id. The stored token is "BATCH-YYYY-…"
 *  (internal); users see "GROUP-YYYY-…" — same running number, friendlier word. */
export const groupLabel = (batchNumber: string): string => batchNumber.replace(/^BATCH-/i, "GROUP-");
// Meal/dish glyphs are now crisp SVGs — see MealIcon / DishIcon in
// components/meal-icon.tsx (replaced the old MEAL_EMOJI/dishEmoji maps).
/** True for units ordered in fractional steps (0.5) with 1-decimal display.
 *  Unit values are the DB enum: G/KG/ML/LITRE/PCS/PLATE/SERVING. */
export const isFractionalUnit = (u: string): boolean => /^(kg|litre)$/i.test(u.trim());
/** Axis tick formatter for a QUANTITY axis (wasted / ordered / received).
 *
 *  Quantities are numeric(12,3) and are routinely fractional — 0.3 kg wasted is
 *  a real weighing, not a rounding artefact. These axes therefore must NOT be
 *  given recharts' `allowDecimals={false}`: that snaps the tick domain onto
 *  whole numbers, so a 0–0.8 kg range is drawn against ticks 0,1,2,3,4 and every
 *  real bar collapses onto the floor. The data was right and the chart said
 *  zero. Counting axes (people, residents, orders) keep allowDecimals={false} —
 *  half a resident is not a reading.
 *
 *  The trim to 3dp is because recharts' "nice" fractional ticks (0.075, 0.225…)
 *  otherwise print binary-float tails. */
export const qtyAxisTick = (v: number | string): string => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v);
};
export const DAY_LABEL = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export function fmtQty(qty: number | string | null | undefined, unit?: string): string {
  if (qty === null || qty === undefined || qty === "") return "—";
  const n = typeof qty === "string" ? Number(qty) : qty;
  if (Number.isNaN(n)) return "—";
  const rounded = Math.round(n * 1000) / 1000;
  return unit ? `${rounded} ${unit.toLowerCase()}` : String(rounded);
}
