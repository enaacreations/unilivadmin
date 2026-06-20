/**
 * Food Ordering & Kitchen Operations — typed API client.
 *
 * Thin wrappers over apiFetch for the /api/food endpoints, plus shared types
 * and a query-key factory. Pages compose these with @tanstack/react-query
 * (useQuery / useMutation), matching the codebase's custom-endpoint convention.
 */
import { apiFetch } from "@/lib/api-fetch";

// ─── Domain types ────────────────────────────────────────────────────────────
export type FoodBrand = "UNILIV" | "HUDDLE";
export type MealType = "BREAKFAST" | "LUNCH" | "SNACKS" | "DINNER" | "NIGHT_MILK";
export type OrderStatus = "PLACED" | "ACCEPTED" | "REJECTED" | "PREPARING" | "DISPATCHED" | "DELIVERED" | "CANCELLED";
export type DispatchStatus = "LOADING" | "IN_TRANSIT" | "DELIVERED" | "PARTIAL";

export const MEAL_TYPES: MealType[] = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER", "NIGHT_MILK"];
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
export interface DashboardData {
  kpis: { totalOrders: Kpi; ordered: Kpi; dispatched: Kpi; delivered: Kpi };
  pendingActions: { awaitingDispatch: number; awaitingConfirmation: number; wastePending: number };
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

export interface Dish {
  id: string; name: string; component: string; unit: string;
  isVeg: boolean; photoUrl: string | null; isActive: boolean;
}
export interface MenuRotationRow {
  id: string; brand: FoodBrand; rotationWeek: number; dayOfWeek: number;
  mealType: MealType; dishId: string; dishName?: string; slotLabel: string | null;
  sortOrder: number; isActive: boolean;
}
export interface PerResidentRule {
  id: string; brand: FoodBrand; mealType: MealType; dishId: string; dishName?: string;
  propertyId: string | null; qtyPerResident: string; unit: string; isActive: boolean;
}
export interface DeliveryPartner { id: string; name: string; phone: string | null; vehicleNumber: string | null; isActive: boolean }
export interface Zone { id: string; name: string; code: string | null; isActive: boolean }
export interface City { id: string; name: string; zoneId: string; isActive: boolean }
export interface Cluster { id: string; name: string; cityId: string; managerId: string | null; isActive: boolean }
export interface UserScope { id: string; userId: string; scopeLevel: string; zoneId: string | null; cityId: string | null; clusterId: string | null; propertyId: string | null }
export interface FoodUser { id: string; name: string; email: string; role: string; propertyId: string | null }
export interface FoodLookups {
  properties: { id: string; name: string; clusterId: string | null }[];
  deliveryPartners: { id: string; name: string }[];
  brands: FoodBrand[];
  mealTypes: MealType[];
}

// ─── Phase 1–3 domain types ──────────────────────────────────────────────────
export interface Kitchen {
  id: string; name: string; code: string; brand: FoodBrand | null;
  address: string | null; city: string | null; state: string | null; pincode: string | null;
  contactName: string | null; contactPhone: string | null; clusterId: string | null; isActive: boolean;
}
export interface Dispatch {
  id: string; dispatchNumber: string; kitchenId: string | null; kitchenName?: string | null; kitchenCode?: string | null;
  deliveryPartnerId: string | null; partnerName?: string | null; vehicleNumber: string | null;
  driverName: string | null; driverPhone: string | null; dispatchedAt: string | null;
  estimatedArrivalAt: string | null; status: DispatchStatus; notes: string | null; orderCount?: number;
}
export interface DispatchDetail extends Dispatch {
  kitchen?: Kitchen | null;
  orders: (FoodOrder & { propertyName?: string | null })[];
}
export interface MealConfig { id: string; mealType: MealType; displayLabel: string; brand: FoodBrand | null; sortOrder: number; isEnabled: boolean }
export interface MealWindow { id: string; brand: FoodBrand; propertyId: string | null; mealType: MealType; cutoffTime: string; serviceTime: string | null; leadTimeMinutes: number; isActive: boolean }
export interface Cutoff { mealType: MealType; cutoffTime: string; serviceTime: string | null; cutoffAt: string | null; isPastCutoff: boolean }
export interface AnalyticsData {
  period: string; range: { from: string; to: string };
  wastageTrend: { date: string; wasted: number }[];
  topWasteItems: { dishId: string; dishName: string | null; unit: string; wasted: number; ordered: number; wastePct: number }[];
  delays: { date: string; delayed: number; total: number }[];
  summary: { totalWasted: number; totalOrdered: number; wastePct: number; delayedOrders: number; deliveredOrders: number };
}
export interface GuestRow { id: string; name: string; phone: string; email: string; gender: string | null; roomNumber: string | null; propertyId: string; propertyName: string | null; checkInDate: string | null; status: string }
export interface PropertyOverview { id: string; name: string; address: string; city: string; state: string; pincode: string; totalBeds: number; occupied: number; activeGuests: number; occupancyPct: number; monthlyRevenue: number }
export interface RevenueData { months: { month: string; total: number }[] }
export interface FullMenuMeal { mealType: MealType; label: string; dishes: { dishId: string; dishName: string; component: string; unit: string; slotLabel: string | null; sortOrder: number }[] }
export interface FullMenu { brand: FoodBrand; date: string; meals: FullMenuMeal[] }

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
  orders: (p: Record<string, unknown>) => ["food", "orders", p] as const,
  order: (id: string) => ["food", "order", id] as const,
  kitchenSummary: (p: Record<string, unknown>) => ["food", "kitchen-summary", p] as const,
  reports: (p: Record<string, unknown>) => ["food", "reports", p] as const,
  dishes: (p: Record<string, unknown>) => ["food", "dishes", p] as const,
  rotation: (p: Record<string, unknown>) => ["food", "menu-rotation", p] as const,
  rules: (p: Record<string, unknown>) => ["food", "rules", p] as const,
  partners: (p: Record<string, unknown>) => ["food", "delivery-partners", p] as const,
  zones: () => ["food", "zones"] as const,
  cities: (zoneId?: string) => ["food", "cities", zoneId ?? "all"] as const,
  clusters: (cityId?: string) => ["food", "clusters", cityId ?? "all"] as const,
  scopes: (userId?: string) => ["food", "scopes", userId ?? "all"] as const,
  users: () => ["food", "users"] as const,
  lookups: () => ["food", "lookups"] as const,
  dispatches: () => ["food", "dispatches"] as const,
  dispatch: (id: string) => ["food", "dispatch", id] as const,
  kitchens: (p: Record<string, unknown> = {}) => ["food", "kitchens", p] as const,
  mealConfig: () => ["food", "meal-config"] as const,
  mealWindows: (p: Record<string, unknown> = {}) => ["food", "meal-windows", p] as const,
  cutoffs: (p: Record<string, unknown>) => ["food", "cutoffs", p] as const,
  analytics: (p: Record<string, unknown>) => ["food", "analytics", p] as const,
  guests: (p: Record<string, unknown>) => ["food", "guests", p] as const,
  propertyOverview: (p: Record<string, unknown>) => ["food", "property-overview", p] as const,
  revenue: (p: Record<string, unknown>) => ["food", "revenue", p] as const,
  fullMenu: (p: Record<string, unknown>) => ["food", "full-menu", p] as const,
};

// ─── API surface ─────────────────────────────────────────────────────────────
export const foodApi = {
  // Dashboard / summary / reports
  dashboard: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<DashboardData>>(`/food/dashboard${qs(p)}`).then((r) => r.data),
  kitchenSummary: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<KitchenSummary>>(`/food/kitchen-summary${qs(p)}`).then((r) => r.data),
  reports: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<ReportsData>>(`/food/reports${qs(p)}`).then((r) => r.data),
  reportsExportUrl: (p: Record<string, unknown> = {}) => `/api/food/reports/export${qs(p)}`,

  // Orders
  listOrders: (p: Record<string, unknown> = {}) =>
    apiFetch<Envelope<FoodOrder[]>>(`/food/orders${qs(p)}`),
  getOrder: (id: string) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}`).then((r) => r.data),
  placeOrder: (body: Record<string, unknown>) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
  updateOrder: (id: string, body: Record<string, unknown>) =>
    apiFetch<Envelope<OrderDetail>>(`/food/orders/${id}`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.data),
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

  // Lookups + master data
  lookups: () => apiFetch<Envelope<FoodLookups>>(`/food/lookups`).then((r) => r.data),
  foodUsers: () => apiFetch<Envelope<FoodUser[]>>(`/food/food-users`).then((r) => r.data),

  listDishes: (p: Record<string, unknown> = {}) => apiFetch<Envelope<Dish[]>>(`/food/dishes${qs(p)}`).then((r) => r.data),
  createDish: (b: Record<string, unknown>) => apiFetch<Envelope<Dish>>(`/food/dishes`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateDish: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<Dish>>(`/food/dishes/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteDish: (id: string) => apiFetch<Envelope<unknown>>(`/food/dishes/${id}`, { method: "DELETE" }),

  listRotation: (p: Record<string, unknown> = {}) => apiFetch<Envelope<MenuRotationRow[]>>(`/food/menu-rotation${qs(p)}`).then((r) => r.data),
  createRotation: (b: Record<string, unknown>) => apiFetch<Envelope<MenuRotationRow>>(`/food/menu-rotation`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateRotation: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<MenuRotationRow>>(`/food/menu-rotation/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteRotation: (id: string) => apiFetch<Envelope<unknown>>(`/food/menu-rotation/${id}`, { method: "DELETE" }),
  resolveMenu: (p: { brand: string; mealType: string; date: string }) => apiFetch<Envelope<unknown[]>>(`/food/menu-rotation/resolve${qs(p)}`).then((r) => r.data),

  listRules: (p: Record<string, unknown> = {}) => apiFetch<Envelope<PerResidentRule[]>>(`/food/rules${qs(p)}`).then((r) => r.data),
  createRule: (b: Record<string, unknown>) => apiFetch<Envelope<PerResidentRule>>(`/food/rules`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateRule: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<PerResidentRule>>(`/food/rules/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteRule: (id: string) => apiFetch<Envelope<unknown>>(`/food/rules/${id}`, { method: "DELETE" }),

  listPartners: (p: Record<string, unknown> = {}) => apiFetch<Envelope<DeliveryPartner[]>>(`/food/delivery-partners${qs(p)}`).then((r) => r.data),
  createPartner: (b: Record<string, unknown>) => apiFetch<Envelope<DeliveryPartner>>(`/food/delivery-partners`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updatePartner: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<DeliveryPartner>>(`/food/delivery-partners/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deletePartner: (id: string) => apiFetch<Envelope<unknown>>(`/food/delivery-partners/${id}`, { method: "DELETE" }),

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
  createDispatch: (b: Record<string, unknown>) => apiFetch<Envelope<Dispatch>>(`/food/dispatches`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateDispatchStatus: (id: string, status: DispatchStatus) => apiFetch<Envelope<Dispatch>>(`/food/dispatches/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }).then((r) => r.data),

  // Kitchen accept / reject
  acceptOrder: (id: string) => apiFetch<Envelope<FoodOrder>>(`/food/orders/${id}/accept`, { method: "POST", body: "{}" }).then((r) => r.data),
  rejectOrder: (id: string, reason?: string) => apiFetch<Envelope<FoodOrder>>(`/food/orders/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }).then((r) => r.data),

  // Multi-meal batch
  placeOrderBatch: (b: Record<string, unknown>) => apiFetch<Envelope<{ batch: any; orders: FoodOrder[] }>>(`/food/order-batches`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),

  // Meal config + cut-off windows
  mealConfig: () => apiFetch<Envelope<MealConfig[]>>(`/food/meal-config`).then((r) => r.data),
  updateMealConfig: (mealType: string, b: Record<string, unknown>) => apiFetch<Envelope<MealConfig>>(`/food/meal-config/${mealType}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  listMealWindows: (p: Record<string, unknown> = {}) => apiFetch<Envelope<MealWindow[]>>(`/food/meal-windows${qs(p)}`).then((r) => r.data),
  createMealWindow: (b: Record<string, unknown>) => apiFetch<Envelope<MealWindow>>(`/food/meal-windows`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),
  updateMealWindow: (id: string, b: Record<string, unknown>) => apiFetch<Envelope<MealWindow>>(`/food/meal-windows/${id}`, { method: "PUT", body: JSON.stringify(b) }).then((r) => r.data),
  deleteMealWindow: (id: string) => apiFetch<Envelope<unknown>>(`/food/meal-windows/${id}`, { method: "DELETE" }),
  cutoffs: (p: Record<string, unknown> = {}) => apiFetch<Envelope<Cutoff[]>>(`/food/cutoffs${qs(p)}`).then((r) => r.data),

  // Menu (full day + share)
  fullMenu: (p: Record<string, unknown> = {}) => apiFetch<Envelope<FullMenu>>(`/food/menu/full${qs(p)}`).then((r) => r.data),
  shareMenu: (b: Record<string, unknown>) => apiFetch<Envelope<{ recipientCount: number }>>(`/food/menu/share`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.data),

  // Analytics
  analytics: (p: Record<string, unknown> = {}) => apiFetch<Envelope<AnalyticsData>>(`/food/analytics${qs(p)}`).then((r) => r.data),

  // Unit-Lead home insights
  propertyOverview: (p: Record<string, unknown> = {}) => apiFetch<Envelope<PropertyOverview | null>>(`/food/property-overview${qs(p)}`).then((r) => r.data),
  revenue: (p: Record<string, unknown> = {}) => apiFetch<Envelope<RevenueData>>(`/food/revenue${qs(p)}`).then((r) => r.data),
  guests: (p: Record<string, unknown> = {}) => apiFetch<Envelope<GuestRow[]>>(`/food/guests${qs(p)}`),

  // Export URLs (open in a new tab / anchor download)
  reportsExportXlsxUrl: (p: Record<string, unknown> = {}) => `/api/food/reports/export.xlsx${qs(p)}`,
  reportsExportPdfUrl: (p: Record<string, unknown> = {}) => `/api/food/reports/export.pdf${qs(p)}`,
  guestsExportXlsxUrl: (p: Record<string, unknown> = {}) => `/api/food/guests/export.xlsx${qs(p)}`,
  guestsExportPdfUrl: (p: Record<string, unknown> = {}) => `/api/food/guests/export.pdf${qs(p)}`,
};

// ─── Display helpers ─────────────────────────────────────────────────────────
export const MEAL_LABEL: Record<MealType, string> = {
  BREAKFAST: "Breakfast", LUNCH: "Lunch", SNACKS: "Snacks", DINNER: "Dinner", NIGHT_MILK: "Night Milk",
};
export const DAY_LABEL = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export function fmtQty(qty: number | string | null | undefined, unit?: string): string {
  if (qty === null || qty === undefined || qty === "") return "—";
  const n = typeof qty === "string" ? Number(qty) : qty;
  if (Number.isNaN(n)) return "—";
  const rounded = Math.round(n * 1000) / 1000;
  return unit ? `${rounded} ${unit.toLowerCase()}` : String(rounded);
}
