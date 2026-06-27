/**
 * Food Ordering & Kitchen Operations — typed API client.
 *
 * Thin wrappers over apiFetch for the /api/food endpoints, plus shared types
 * and a query-key factory. Pages compose these with @tanstack/react-query
 * (useQuery / useMutation), matching the codebase's custom-endpoint convention.
 */
import { apiFetch } from "@/lib/api-fetch";

// ─── Domain types ────────────────────────────────────────────────────────────
// Brands are now an admin-managed master list (food_brands), so a brand is just
// its code string. Use foodApi.listBrands() for the live set; BRANDS below is a
// dev fallback only.
export type FoodBrand = string;
export type MealType = "BREAKFAST" | "LUNCH" | "SNACKS" | "DINNER";
export type OrderStatus = "PLACED" | "ACCEPTED" | "REJECTED" | "PREPARING" | "DISPATCHED" | "DELIVERED" | "CANCELLED";
export type DispatchStatus = "LOADING" | "IN_TRANSIT" | "DELIVERED" | "PARTIAL" | "CANCELLED";

export const MEAL_TYPES: MealType[] = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"];
export const PREPARATIONS = ["VEG", "NON_VEG", "JAIN"] as const;
export type Preparation = (typeof PREPARATIONS)[number];
export const PREPARATION_LABEL: Record<string, string> = { VEG: "Veg", NON_VEG: "Non-veg", JAIN: "Jain" };
export const BRANDS: FoodBrand[] = ["UNILIV", "HUDDLE"];
export const ORDER_STATUSES: OrderStatus[] = ["PLACED", "ACCEPTED", "REJECTED", "PREPARING", "DISPATCHED", "DELIVERED", "CANCELLED"];

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
  wasteEditableUntil: string | null;
  preparingAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  batchId: string | null;
  kitchenId: string | null;
  dispatchId: string | null;
  expectedDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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

export interface OrderDetail extends FoodOrder {
  items: FoodOrderItem[];
  events: FoodOrderEvent[];
  kitchen?: Kitchen | null;
  dispatch?: Dispatch | null;
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

// WS11 — aggregated ordered-vs-delivered variance, grouped by meal type.
export interface VarianceRow { mealType: MealType; ordered: number; received: number; wasted: number; variance: number }
export interface VarianceData {
  rows: VarianceRow[];
  totals: { ordered: number; received: number; wasted: number; variance: number };
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
// O17 — ordered-vs-received variance per service-day (bar chart, filterable by meal).
export interface VarianceByDayRow { date: string; ordered: number; received: number; variance: number; wasted: number }
export interface VarianceByDayData { rows: VarianceByDayRow[] }

export interface DishIngredientRow { id?: string; ingredientId: string; ingredientName?: string | null; quantity: string | number | null; unit: string | null }
export interface Dish {
  id: string; name: string; component: string; unit: string;
  brands: string[];
  preparations: string[];
  photoUrl: string | null; isActive: boolean;
  ingredients?: DishIngredientRow[];
}
export interface Ingredient { id: string; name: string; unit: string; isActive: boolean }
export interface MenuRotationRow {
  id: string; brand: FoodBrand; kitchenId: string | null; kitchenName?: string | null;
  rotationWeek: number; dayOfWeek: number;
  mealType: MealType; dishId: string; dishName?: string; slotLabel: string | null;
  sortOrder: number; isActive: boolean;
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
export interface UserScope { id: string; userId: string; scopeLevel: string; zoneId: string | null; cityId: string | null; clusterId: string | null; kitchenId: string | null; propertyId: string | null }
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
  properties: { id: string; name: string; brand: string | null; kitchenId: string | null; clusterId: string | null }[];
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
export interface MealConfig { id: string; mealType: MealType; displayLabel: string; brand: FoodBrand | null; sortOrder: number; isEnabled: boolean }
export interface MealWindow { id: string; brand: FoodBrand; propertyId: string | null; mealType: MealType; cutoffTime: string | null; serviceTime: string | null; leadTimeMinutes: number; isActive: boolean }
export interface FoodCutoffConfig { id: string; brand: string; propertyId: string | null; cutoffTime: string; isActive: boolean }
export interface Cutoff { mealType: MealType; cutoffTime: string | null; serviceTime: string | null; cutoffAt: string | null; isPastCutoff: boolean }
export interface FoodDefaults { defaultCutoff: string; wasteWindowMinutes: number }
export interface AnalyticsData {
  period: string; range: { from: string; to: string };
  wastageTrend: { date: string; wasted: number }[];
  topWasteItems: { dishId: string; dishName: string | null; unit: string; wasted: number; ordered: number; wastePct: number }[];
  delays: { date: string; delayed: number; total: number }[];
  summary: { totalWasted: number; totalOrdered: number; wastePct: number; delayedOrders: number; deliveredOrders: number };
}
// B3-17 — cross-property waste analytics (geography-scoped; OPS_EXCELLENCE/SUPER_ADMIN see all).
export type WasteGranularity = "day" | "month";
export interface WasteAnalyticsData {
  range: { from: string; to: string };
  granularity: WasteGranularity;
  summary: { totalWasted: number; totalReceived: number; totalOrdered: number; wastePct: number; ordersWithWaste: number };
  byProperty: { propertyId: string; name: string; city: string | null; cluster: string | null; wastedQty: number; wastePct: number }[];
  byDish: { dishId: string | null; name: string; wastedQty: number }[];
  byMealType: { mealType: MealType; wastedQty: number }[];
  byMenu: { brand: string; wastedQty: number }[];
  trend: { period: string; wastedQty: number }[];
}

// WS7 — Unit-Lead Home dashboard analytics (aggregate across accessible properties).
export interface HomeAnalytics {
  period: string;
  range: { from: string; to: string };
  prevRange: { from: string; to: string };
  peopleOrderedTrend: { date: string; people: number }[];
  peopleByProperty: { propertyId: string; propertyName: string; people: number }[];
  peopleComparison: { current: number; prior: number; currentLabel: string; priorLabel: string };
  wastageTrend: { date: string; wasted: number }[];
  topWasteItems: { dishId: string; dishName: string | null; unit: string; wasted: number; ordered: number; wastePct: number }[];
  orderDelays: { date: string; delayed: number; total: number }[];
  activeResidentTrend: { date: string; residents: number }[];
  occupancy: { totalBeds: number; activeGuests: number; occupancyPct: number; monthlyCollections: number };
  newSignups: { current: number; prior: number } | null;   // residents who moved in during the period
  renewals: { current: number; prior: number } | null;     // proxy: lease term completes in the period
  summary: {
    totalPeopleOrdered: number; totalWasted: number; totalOrdered: number; wastePct: number;
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
}
export interface OrderPreviewMeal { mealType: MealType; label: string; items: OrderPreviewItem[] }

// ─── Menu-composition rule engine ─────────────────────────────────────────────
export interface CompositionSlot { id?: string; slotLabel: string | null; component: string | null; preparation: string | null; minCount: number; maxCount: number | null; sortOrder: number }
export interface CompositionRule { id: string; brand: string; mealType: MealType; kitchenId: string | null; name: string | null; isActive: boolean; slots: CompositionSlot[] }
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
  reportsVarianceByDay: (p: Record<string, unknown>) => ["food", "reports-variance-by-day", p] as const,
  dishes: (p: Record<string, unknown>) => ["food", "dishes", p] as const,
  dish: (id: string) => ["food", "dish", id] as const,
  ingredients: (p: Record<string, unknown> = {}) => ["food", "ingredients", p] as const,
  compositionRules: (p: Record<string, unknown> = {}) => ["food", "composition-rules", p] as const,
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
  mealConfig: () => ["food", "meal-config"] as const,
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
  reportsExportUrl: (p: Record<string, unknown> = {}) => `/api/food/reports/export${qs(p)}`,

  // Orders
  // Optional filters: serviceDate (exact "yyyy-MM-dd"), status (single e.g. "PLACED"
  // or CSV e.g. "PLACED,PREPARING"), plus propertyId/brand/mealType/from/to/search/page/limit.
  listOrders: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<FoodOrder[]>>(`/food/orders${qs(p)}`),
  getOrder: (id: string) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}`).then((r) => r.data),
  // WS9 — standalone tracking lookup by human order number OR raw id (scoped to accessible properties).
  trackOrder: (term: string) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/track${qs({ orderNumber: term })}`).then((r) => r.data),
  placeOrder: (body: Record<string, unknown>) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
  updateOrder: (id: string, body: Record<string, unknown>) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.data),
  // B3-6 — edit an order's people count (the only editable quantity input). Item
  // quantities + totalQuantity are recomputed server-side from this; never sent by
  // the client. `notes` is optionally editable. Allowed while PLACED/PREPARING/DISPATCHED.
  editOrderPeople: (id: string, residentsCount: number, notes?: string | null) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}`, {
      method: "PUT",
      body: JSON.stringify(notes !== undefined ? { residentsCount, notes } : { residentsCount }),
    }).then((r) => r.data),
  cancelOrder: (id: string, reason?: string) =>
    apiFetch<Envelope<FoodOrder>>(`/food/orders/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }).then((r) => r.data),
  prepareOrder: (id: string) =>
    apiFetch<Envelope<FoodOrder>>(`/food/orders/${id}/prepare`, { method: "POST", body: "{}" }).then((r) => r.data),
  dispatchOrder: (id: string, body: { deliveryPartnerId?: string; action?: "start" | "dispatch" }) =>
    apiFetch<Envelope<FoodOrder>>(`/food/orders/${id}/dispatch`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
  bulkDispatch: (orderIds: string[], deliveryPartnerId: string) =>
    apiFetch<Envelope<unknown>>(`/food/orders/dispatch/bulk`, { method: "POST", body: JSON.stringify({ orderIds, deliveryPartnerId }) }).then((r) => r.data),
  confirmDelivery: (id: string, items: { itemId: string; receivedQty: number }[], remarks?: string) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}/confirm-delivery`, { method: "POST", body: JSON.stringify({ items, remarks }) }).then((r) => r.data),
  recordWaste: (id: string, items: { itemId: string; wastedQty: number }[]) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}/waste`, { method: "POST", body: JSON.stringify({ items }) }).then((r) => r.data),

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
  updateDish: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<Dish>>(`/food/dishes/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
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
  validateComposition: (p: { brand: string; mealType: MealType | string; kitchenId?: string | null; dishIds: string[] }) =>
    apiFetch<Envelope<RotationValidation>>(`/food/menu-rotation/validate${qs({ ...p, dishIds: p.dishIds.join(",") })}`).then((r) => r.data),
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

  listZones: () => apiFetch<Envelope<Zone[]>>(`/food/zones`).then((r) => r.data),
  createZone: (b: Record<string, unknown>) => apiFetch<Envelope<Zone>>(`/food/zones`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  listCities: (zoneId?: string) => apiFetch<Envelope<City[]>>(`/food/cities${qs({ zoneId })}`).then((r) => r.data),
  createCity: (b: Record<string, unknown>) => apiFetch<Envelope<City>>(`/food/cities`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  listClusters: (cityId?: string) => apiFetch<Envelope<Cluster[]>>(`/food/clusters${qs({ cityId })}`).then((r) => r.data),
  createCluster: (b: Record<string, unknown>) => apiFetch<Envelope<Cluster>>(`/food/clusters`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  assignCluster: (propertyId: string, clusterId: string) => apiFetch<Envelope<unknown>>(`/food/properties/${propertyId}/assign-cluster`, { method: "POST", body: JSON.stringify({ clusterId }) }),

  listScopes: (userId?: string) => apiFetch<Envelope<UserScope[]>>(`/food/scopes${qs({ userId })}`).then((r) => r.data),
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
  // Vehicle ids currently on a LOADING/IN_TRANSIT trip (to disable in-use vehicles in the picker).
  getActiveVehicles: () => apiFetch<Envelope<{ vehicleIds: string[] }>>(`/food/dispatches/active-vehicles`).then((r) => r.data.vehicleIds),
  // Audit trail for one dispatch, newest-first.
  getDispatchEvents: (id: string) => apiFetch<Envelope<DispatchEvent[]>>(`/food/dispatches/${id}/events`).then((r) => r.data),
  // Create a LOADING dispatch from selected orders. Pass departNow:true to send it
  // straight to IN_TRANSIT. Throws on 400 (missing orderIds/agency) / 422 (vehicle or
  // kitchen validation) with the server's error message.
  createDispatch: (b: Record<string, unknown>) => apiFetch<Envelope<Dispatch & { dispatchedCount: number }>>(`/food/dispatches`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  // Status transition. A 422 (`Cannot move from X to Y`) propagates as a thrown Error
  // whose message is the server's transition explanation. `note` is optional audit text.
  updateDispatchStatus: (id: string, status: DispatchStatus, note?: string) =>
    apiFetch<Envelope<Dispatch>>(`/food/dispatches/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify(note !== undefined ? { status, note } : { status }),
    }).then((r) => r.data),
  // Convenience: move a LOADING dispatch to IN_TRANSIT (depart now).
  departDispatch: (id: string, note?: string) =>
    apiFetch<Envelope<Dispatch>>(`/food/dispatches/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify(note !== undefined ? { status: "IN_TRANSIT", note } : { status: "IN_TRANSIT" }),
    }).then((r) => r.data),
  // Cancel a dispatch, reverting its DISPATCHED orders back to PREPARING.
  cancelDispatch: (id: string, reason?: string) =>
    apiFetch<Envelope<Dispatch & { revertedCount: number }>>(`/food/dispatches/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }).then((r) => r.data),
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
  mealConfig: () => apiFetch<Envelope<MealConfig[]>>(`/food/meal-config`).then((r) => r.data),
  updateMealConfig: (mealType: string, b: Record<string, unknown>) => apiFetch<Envelope<MealConfig>>(`/food/meal-config/${mealType}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
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
export const DAY_LABEL = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export function fmtQty(qty: number | string | null | undefined, unit?: string): string {
  if (qty === null || qty === undefined || qty === "") return "—";
  const n = typeof qty === "string" ? Number(qty) : qty;
  if (Number.isNaN(n)) return "—";
  const rounded = Math.round(n * 1000) / 1000;
  return unit ? `${rounded} ${unit.toLowerCase()}` : String(rounded);
}
