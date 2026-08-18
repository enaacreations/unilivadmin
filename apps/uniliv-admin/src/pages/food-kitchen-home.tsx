import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, addDays, parseISO } from "date-fns";
import {
  ChevronLeft, ChevronRight, Check, AlertCircle, Truck, Soup, Inbox,
  Download, CookingPot,
} from "lucide-react";
import * as XLSX from "xlsx";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useConfetti } from "@/components/ui/confetti";
import { MealIcon, DishIcon } from "@/components/meal-icon";
import { FoodQueryError } from "@/components/food/query-error";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";
import {
  foodApi, foodKeys, orderPeople, MEAL_TYPES, MEAL_LABEL, ORDER_STATUS_PILL, shortMeal, fmtQty,
  type FoodOrder, type MealType, type KitchenSummaryDish, type KitchenItem, type DishIngredientRow,
} from "@/lib/food-api";
import { useDishCatalogue } from "@/components/food/use-food-masters";

/** Kitchen serve-by targets per meal (prototype schedule — not in the API).
 *  Kept in sync with food-kitchen-summary.tsx. */
const SERVE_BY: Record<MealType, string> = {
  BREAKFAST: "7:00 AM", LUNCH: "12:00 PM", SNACKS: "4:00 PM", DINNER: "7:30 PM",
};

/** The kitchen's journey state for one meal — drives tab tint + pill, in the
 *  same visual grammar as the unit lead's Food Overview meal states. */
type KState = "accept" | "dispatch" | "transit" | "quiet";

const STATE_TINT: Record<KState, string> = {
  accept: "var(--warning)",   // orders waiting to be accepted — act now
  dispatch: "var(--info)",    // accepted — dispatch when ready
  transit: "var(--success)",  // everything's on the road
  quiet: "var(--muted)",
};

const stateShort = (s: KState, n: number): string =>
  s === "accept" ? `${n} to accept`
  : s === "dispatch" ? "Ready to send"
  : s === "transit" ? "On the road"
  : "No orders";

/** The journey state of any bag of orders — one property, one meal, or the
 *  whole day. Earliest unfinished stage wins, so the card always shows the
 *  thing that still needs a hand. */
const kstateOf = (os: FoodOrder[]): KState =>
  os.some((o) => o.status === "PLACED") ? "accept"
  : os.some((o) => o.status === "ACCEPTED") ? "dispatch"
  : os.some((o) => o.status === "DISPATCHED") ? "transit"
  : "quiet";

/** Which properties' orders the page is working: `null` is the property
 *  picker (landing), ALL_SCOPE the combined board, otherwise one propertyId. */
const ALL_SCOPE = "ALL";
type Scope = string | null;

/** Narrow a meal's cook plan to a set of properties — one property when scoped
 *  to it, a kitchen's whole roster when a kitchen is picked. The summary already
 *  carries a per-property split per dish (and `byProperty.qty` is in
 *  `displayUnit`), so this is exact and costs no extra round-trip. */
function dishesForProperties(dishes: KitchenSummaryDish[], propertyIds: Set<string>): KitchenSummaryDish[] {
  return dishes.flatMap((d) => {
    const byProperty = d.byProperty.filter((bp) => propertyIds.has(bp.propertyId));
    const qty = byProperty.reduce((n, bp) => n + bp.qty, 0);
    return qty > 0 ? [{ ...d, displayQty: qty, byProperty }] : [];
  });
}

type Slot = {
  mealType: MealType;
  placed: FoodOrder[];
  accepted: FoodOrder[];
  dispatched: FoodOrder[];
  live: FoodOrder[];
  dishes: KitchenSummaryDish[];
  people: number;
  state: KState;
};

/** Column micro-heading (same primitive as Food Overview's ColumnHead). */
/** Kitchen summary downloads (generated client-side as real .xlsx via SheetJS
 *  from the same cook-plan data on screen — no server round-trip). */
function xlsxName(...parts: string[]) {
  return parts.map((p) => p.replace(/[^\w]+/g, "-").toLowerCase()).filter(Boolean).join("-") + ".xlsx";
}
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The Full-summary worksheet, one block per dish: the dish with its cook
 * quantity and property split, then one row per ingredient it calls for —
 * names only, no amounts (the ingredient scaling model is still being settled
 * with ops) — with the other dishes that share the ingredient. Dish-level
 * cells are merged across the block so the sheet prints as readable groups.
 * Replaces the old cook-plan, chef-summary and ingredients sheets.
 */
function fullSummarySheet(
  dishes: KitchenSummaryDish[],
  ingredientsByDish: Map<string, DishIngredientRow[]>,
): XLSX.WorkSheet {
  // Ingredient name → every dish in this plan that lists it ("Used in").
  const usedIn = new Map<string, string[]>();
  for (const d of dishes) {
    for (const r of ingredientsByDish.get(d.dishId) ?? []) {
      const name = r.ingredientName ?? "Ingredient";
      const ds = usedIn.get(name) ?? [];
      if (!ds.includes(d.dishName)) ds.push(d.dishName);
      usedIn.set(name, ds);
    }
  }
  const aoa: (string | number)[][] = [["Dish", "Quantity", "Unit", "Property", "Ingredients", "Used in"]];
  const merges: XLSX.Range[] = [];
  for (const d of dishes) {
    const rows = ingredientsByDish.get(d.dishId) ?? [];
    // byProperty.qty is already in displayUnit; one property needs no split.
    const property = d.byProperty.length === 1
      ? d.byProperty[0].propertyName
      : d.byProperty.map((bp) => `${bp.propertyName} — ${fmtQty(bp.qty, d.displayUnit || undefined)}`).join(", ");
    const start = aoa.length;
    if (rows.length === 0) {
      aoa.push([d.dishName, round3(d.displayQty), d.displayUnit.toLowerCase(), property, "—", "—"]);
      continue;
    }
    rows.forEach((r, i) => {
      const name = r.ingredientName ?? "Ingredient";
      aoa.push([
        i === 0 ? d.dishName : "",
        i === 0 ? round3(d.displayQty) : "",
        i === 0 ? d.displayUnit.toLowerCase() : "",
        i === 0 ? property : "",
        name,
        (usedIn.get(name) ?? [d.dishName]).join(", "),
      ]);
    });
    if (rows.length > 1) {
      for (let c = 0; c <= 3; c++) merges.push({ s: { r: start, c }, e: { r: start + rows.length - 1, c } });
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merges;
  ws["!cols"] = [{ wch: 26 }, { wch: 10 }, { wch: 8 }, { wch: 34 }, { wch: 32 }, { wch: 26 }];
  return ws;
}

/** Full summary for one meal on the board — a single Full-summary sheet. */
function downloadFullSummary(
  dishes: KitchenSummaryDish[],
  ingredientsByDish: Map<string, DishIngredientRow[]>,
  meal: MealType,
  day: string,
) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, fullSummarySheet(dishes, ingredientsByDish), "Full summary");
  XLSX.writeFile(wb, xlsxName("full-summary", meal, day));
}

/** Full summary for a whole day (the picker's property cards and combined
 *  card) — one sheet per meal that has dishes, named by meal. Sheet names use
 *  shortMeal because the long SNACKS label contains "/", which Excel forbids
 *  in sheet names. `scopeName` (a property or kitchen name) tags the file. */
function downloadFullSummaryDay(
  byMeal: { meal: MealType; dishes: KitchenSummaryDish[] }[],
  ingredientsByDish: Map<string, DishIngredientRow[]>,
  scopeName: string,
  day: string,
) {
  const wb = XLSX.utils.book_new();
  for (const m of byMeal) {
    XLSX.utils.book_append_sheet(wb, fullSummarySheet(m.dishes, ingredientsByDish), shortMeal(m.meal));
  }
  XLSX.writeFile(wb, xlsxName("full-summary", scopeName, day));
}

/** One ingredient's total for a meal, plus the dishes that call for it. */
type IngredientLine = { name: string; qty: number; unit: string; dishes: string[] };

/**
 * Raw ingredients a meal consumes.
 *
 * `dish_ingredients.quantity` is a PER-PERSON rate (2 slices of bread a head,
 * 80g of potato a head) — so a dish's requirement is that rate × the people
 * eating it, NOT × the dish's cooked quantity. Under the plate model everyone
 * at a property that ordered the dish is served it, so the dish's head count is
 * the people at the properties in its own per-property split. That keeps the
 * total right when only some properties ordered a dish.
 *
 * Grouped by (ingredient, unit) with NO unit conversion: a spice measured in
 * grams stays in grams, matching how the store issues it.
 */
export function buildIngredientLines(
  dishes: KitchenSummaryDish[],
  ingredientsByDish: Map<string, DishIngredientRow[]>,
  peopleByProperty: Map<string, number>,
): IngredientLine[] {
  const acc = new Map<string, IngredientLine>();
  for (const d of dishes) {
    const rows = ingredientsByDish.get(d.dishId) ?? [];
    if (!rows.length) continue;
    const people = d.byProperty.reduce((n, bp) => n + (peopleByProperty.get(bp.propertyId) ?? 0), 0);
    if (people <= 0) continue;
    for (const r of rows) {
      const perPerson = Number(r.quantity ?? 0);
      if (!Number.isFinite(perPerson) || perPerson <= 0) continue;
      const name = r.ingredientName ?? "Ingredient";
      const unit = r.unit ?? "";
      const key = `${name}|${unit}`;
      const line = acc.get(key) ?? { name, qty: 0, unit, dishes: [] };
      line.qty += perPerson * people;
      if (!line.dishes.includes(d.dishName)) line.dishes.push(d.dishName);
      acc.set(key, line);
    }
  }
  return [...acc.values()]
    .map((l) => ({ ...l, qty: Math.round(l.qty * 1000) / 1000 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Dispatch list = one block per order on the board (sent or still to go), one
 * row per dish on it: what's in the van, how much, and where it's headed.
 * Dish lines come from the order's kitchen items (prepared qty wins over
 * ordered, matching the board's accordion); order-level cells are merged
 * across the block.
 */
async function downloadDispatchList(
  rows: { o: FoodOrder; partner: string }[],
  fetchItems: (orderId: string) => Promise<KitchenItem[]>,
  meal: MealType,
  day: string,
) {
  const itemsByOrder = await Promise.all(rows.map((r) => fetchItems(r.o.id).catch(() => [] as KitchenItem[])));
  const aoa: (string | number)[][] = [["Dish", "Quantity", "Unit", "Property", "Order", "People", "Partner"]];
  const merges: XLSX.Range[] = [];
  rows.forEach((r, idx) => {
    const orderCells: (string | number)[] = [
      r.o.propertyName ?? "Property",
      r.o.orderNumber,
      orderPeople(r.o),
      r.partner,
    ];
    const items = itemsByOrder[idx];
    const start = aoa.length;
    if (items.length === 0) {
      aoa.push(["—", "", "", ...orderCells]);
      return;
    }
    items.forEach((it, i) => {
      const qty = it.preparedQty ?? it.orderedQty;
      aoa.push([
        it.dishName ?? "Item",
        qty == null ? "" : round3(qty),
        it.unit.toLowerCase(),
        ...(i === 0 ? orderCells : ["", "", "", ""]),
      ]);
    });
    if (items.length > 1) {
      for (let c = 3; c <= 6; c++) merges.push({ s: { r: start, c }, e: { r: start + items.length - 1, c } });
    }
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merges;
  ws["!cols"] = [{ wch: 26 }, { wch: 10 }, { wch: 8 }, { wch: 26 }, { wch: 18 }, { wch: 8 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Dispatch list");
  XLSX.writeFile(wb, xlsxName("dispatch-list", meal, day));
}

function ColumnHead({ icon, label, tone, right }: {
  icon: React.ReactNode; label: string; tone: string; right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-[7px]">
      <span style={{ color: tone }} className="flex">{icon}</span>
      <span className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: tone }}>
        {label}
      </span>
      <span className="flex-1" />
      {right}
    </div>
  );
}

/** One property · headcount row inside a pipeline column. Clicking the property
 *  name opens the order-details sheet. */
function OrderRow({ o, onOpen }: { o: FoodOrder; onOpen: (o: FoodOrder) => void }) {
  return (
    <div className="flex w-full items-center gap-2 border-b border-dashed border-border py-1.5 last:border-0">
      <button
        type="button"
        onClick={() => onOpen(o)}
        className="group flex min-w-0 flex-1 items-center gap-1 text-left"
      >
        <span className="min-w-0 truncate text-[13px] transition-colors group-hover:text-accent-strong">
          {o.propertyName ?? "Property"}
        </span>
        <ChevronRight className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
      </button>
      <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">
        {orderPeople(o)} ppl
      </span>
    </div>
  );
}

function ColumnEmpty({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-2 py-5 text-center text-[13px] text-muted-foreground">
      {text}
    </div>
  );
}

/**
 * One Dispatch-board row: property + per-property partner picker, expandable
 * into the order's dish breakdown. The quantities are what the property ordered
 * and are READ-ONLY here — once an order is placed it goes out as ordered, so
 * the board is a manifest, not an editor. Dispatched orders stay on the board
 * as a "done" row showing partner · batch · time.
 */
function DispatchRow({
  o, done, doneText, canDispatch, isPicked, onToggle, partners, partnerId, onPartner,
}: {
  o: FoodOrder;
  done: boolean;
  doneText: string;
  canDispatch: boolean;
  isPicked: boolean;
  onToggle: () => void;
  partners: { id: string; name: string }[];
  partnerId: string;
  onPartner: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const { data: items, isLoading } = useQuery({
    queryKey: ["food", "kitchen-items", o.id],
    queryFn: () => foodApi.kitchenItems(o.id),
    enabled: open,
    staleTime: 60_000,
  });
  const noPartner = !done && partners.length === 0;

  return (
    <div
      className={cn(
        "rounded-[10px] border transition-colors",
        done ? "border-success/40 bg-success-soft/40" : isPicked ? "border-accent bg-accent/5" : "border-border bg-card",
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {/* select / done */}
        {done ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-white">
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
          </span>
        ) : canDispatch ? (
          <button
            type="button"
            onClick={onToggle}
            disabled={noPartner}
            aria-label={isPicked ? `Unselect ${o.propertyName}` : `Select ${o.propertyName}`}
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border-2 transition-colors",
              isPicked ? "border-accent bg-accent text-white" : "border-border bg-background",
              noPartner && "cursor-not-allowed opacity-40",
            )}
          >
            {isPicked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
          </button>
        ) : null}

        {/* property — click to expand the dishes */}
        <button type="button" onClick={() => setOpen((v) => !v)} className="group min-w-0 flex-1 text-left">
          <span className="block truncate text-[15px] font-bold tracking-[-0.006em]">{o.propertyName ?? "Property"}</span>
          <span className="block truncate font-mono text-[12px] tabular-nums text-muted-foreground">
            {o.orderNumber} · {orderPeople(o)} people
          </span>
        </button>

        {/* right side: done summary, partner picker, or no-partner warning */}
        {done ? (
          <span className="shrink-0 text-right text-[13px] font-semibold text-success">{doneText}</span>
        ) : canDispatch ? (
          noPartner ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1.5 text-[11px] font-semibold text-warning">
              <AlertCircle className="h-3.5 w-3.5" /> No partner
            </span>
          ) : (
            <Select value={partnerId} onValueChange={onPartner}>
              <SelectTrigger className="h-8 w-auto min-w-[128px] gap-1.5 rounded-full border-border bg-card px-3 text-[12px] font-semibold">
                <Truck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {partners.map((a) => (<SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>))}
              </SelectContent>
            </Select>
          )
        ) : null}

        {/* accordion toggle — last thing on the row, after the partner select */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse dishes" : "Show dishes"}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90")} />
        </button>
      </div>

      {/* accordion content: the order's dishes, exactly as ordered — read-only */}
      {open && (
        <div className="border-t border-border/70 px-3 py-2.5">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : !items?.length ? (
            <div className="py-2 text-center text-[12px] text-muted-foreground">No dish breakdown on this order.</div>
          ) : (
            items.map((it) => (
              <div key={it.id} className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 last:border-0">
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <DishIcon name={it.dishName ?? ""} meal={o.mealType} size={26} />
                  <span className="min-w-0 truncate text-[13px]">{it.dishName ?? "Item"}</span>
                </span>
                <span className="shrink-0 font-mono text-[12.5px] font-semibold tabular-nums">
                  {fmtQty(it.preparedQty ?? it.orderedQty ?? 0)}{" "}
                  <span className="text-[10px] font-bold uppercase text-muted-foreground">{it.unit}</span>
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Kitchen switcher. Only rendered when this login actually runs more than one
 *  kitchen — a single-kitchen F&B manager has nothing to switch between, and
 *  their orders are already server-scoped. */
function KitchenSwitcher({ kitchens, value, onChange }: {
  kitchens: { id: string; name: string }[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <Select value={value ?? ALL_SCOPE} onValueChange={(v) => onChange(v === ALL_SCOPE ? null : v)}>
      <SelectTrigger
        aria-label="Switch kitchen"
        className="h-[34px] w-auto min-w-[190px] max-w-[260px] gap-1.5 rounded-[9px] border-border bg-card px-3 text-[13px] font-semibold"
      >
        <CookingPot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_SCOPE}>All kitchens</SelectItem>
        {kitchens.map((k) => (
          <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Yesterday / Today / Tomorrow stepper. Shared by the property picker and the
 *  scoped board so both views always work the same kitchen day. */
function DayStepper({ day, setDay, dayLabel, dayDate }: {
  day: number;
  setDay: React.Dispatch<React.SetStateAction<number>>;
  dayLabel: string;
  dayDate: Date;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={() => setDay((d) => Math.max(-1, d - 1))}
        aria-label="Previous day"
        disabled={day <= -1}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-border bg-card text-foreground disabled:text-border"
      >
        <ChevronLeft className="h-[15px] w-[15px]" />
      </button>
      <span className="min-w-[130px] text-center">
        <span className="block font-display text-sm font-bold tracking-[-0.012em]">{dayLabel}</span>
        <span className="block font-mono text-[11px] text-muted-foreground">{format(dayDate, "EEE, dd MMM")}</span>
      </span>
      <button
        type="button"
        onClick={() => setDay((d) => Math.min(1, d + 1))}
        aria-label="Next day"
        disabled={day >= 1}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-border bg-card text-foreground disabled:text-border"
      >
        <ChevronRight className="h-[15px] w-[15px]" />
      </button>
    </div>
  );
}

/** One property on the picker: who they are, where the day stands, a four-meal
 *  strip, and the two ways in — accept their waiting orders outright, or open
 *  their kitchen and work the meal. `onDownload` (when the day has dishes)
 *  saves the property's whole-day Full summary. */
function PropertyCard({ card, canKitchen, busy, onOpen, onAccept, onDownload }: {
  card: PropertyCardData;
  canKitchen: boolean;
  busy: string | null;
  onOpen: () => void;
  onAccept: () => void;
  onDownload?: (() => void) | null;
}) {
  const tint = STATE_TINT[card.state];
  const actionable = card.state === "accept" || card.state === "dispatch";
  return (
    <div
      className="flex flex-col gap-3 rounded-[14px] bg-card p-4"
      style={{ border: card.state === "accept" ? `1.5px solid ${tint}` : "1px solid var(--border)" }}
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onOpen}
            className="block max-w-full truncate text-left font-display text-base font-bold tracking-[-0.012em] transition-colors hover:text-accent-strong"
          >
            {card.name}
          </button>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {card.city ? `${card.city} · ` : ""}
            <span className="font-mono tabular-nums">{card.people} people today</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold"
            style={{ background: `color-mix(in srgb, ${tint} 16%, var(--card))`, color: tint }}
          >
            <span
              className={cn("h-[7px] w-[7px] rounded-full", actionable && "animate-pulse-dot")}
              style={{ background: tint }}
            />
            {stateShort(card.state, card.placed.length)}
          </span>
          {onDownload && (
            <button
              type="button"
              onClick={onDownload}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground"
            >
              <Download className="h-3 w-3" /> Full summary
            </button>
          )}
        </div>
      </div>

      {/* Four-meal strip — where each meal of this property's day stands */}
      <div className="flex gap-1.5">
        {card.meals.map((m) => {
          const mt = STATE_TINT[m.state];
          return (
            <div
              key={m.mealType}
              className="flex flex-1 flex-col items-center gap-0.5 rounded-[9px] px-1 py-1.5"
              style={{ background: `color-mix(in srgb, ${mt} 14%, var(--card))` }}
            >
              <span className="text-[10.5px] font-bold uppercase tracking-[.06em]" style={{ color: mt }}>
                {shortMeal(m.mealType)}
              </span>
              <span className="font-mono text-[11px] tabular-nums" style={{ color: mt }}>
                {m.live.length ? `${m.people}p` : "—"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-auto flex gap-2">
        {canKitchen && card.placed.length > 0 && (
          <button
            type="button"
            onClick={onAccept}
            disabled={!!busy}
            className="h-9 flex-1 rounded-[9px] bg-warning text-[13px] font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === `accept:prop:${card.id}` ? "Accepting…" : `Accept ${card.placed.length} →`}
          </button>
        )}
        <button
          type="button"
          onClick={onOpen}
          className="h-9 flex-1 rounded-[9px] border border-border bg-card text-[13px] font-bold transition-colors hover:border-accent hover:text-accent-strong"
        >
          Open kitchen →
        </button>
      </div>
    </div>
  );
}

type PropertyCardData = {
  id: string;
  name: string;
  city: string | null;
  people: number;
  placed: FoodOrder[];
  state: KState;
  meals: Slot[];
};

export default function FoodKitchenHome() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { confetti, fire } = useConfetti();
  const { can } = usePermissions();
  // Accept/prepare are FOOD_KITCHEN_SUMMARY edit; sending a van is
  // FOOD_DISPATCH edit — mirror the server so view-only roles (auditors,
  // leadership) get a read-only board instead of buttons that 403.
  const canKitchen = can("FOOD_KITCHEN_SUMMARY", "edit");
  const canDispatch = can("FOOD_DISPATCH", "edit");

  // ── Day navigation: yesterday / today / tomorrow ──────────────────────────
  const [day, setDay] = React.useState(0);
  const [pickedMeal, setPickedMeal] = React.useState<MealType | null>(null);
  // Which properties the board is working. The page opens on the picker so the
  // kitchen chooses a property (or the combined view) before working a meal —
  // a manager running four properties was otherwise stuck with one merged
  // board and no way to tell whose orders were whose.
  const [scope, setScope] = React.useState<Scope>(null);
  // Which kitchen the whole page is reading; null = every kitchen this login
  // can see. Only meaningful for multi-kitchen logins (heads/admins).
  const [kitchen, setKitchen] = React.useState<string | null>(null);
  React.useEffect(() => { setPickedMeal(null); }, [day, scope]);

  // The kitchen's day is an IST calendar day (order serviceDates are anchored
  // to IST server-side) — so "Today" follows Asia/Kolkata, not the viewer's
  // clock. A viewer west of IST would otherwise act on an already-finished day.
  const istTodayYmd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const dayDate = addDays(parseISO(istTodayYmd), day);
  const date = format(dayDate, "yyyy-MM-dd");
  const dayLabel = day === -1 ? "Yesterday" : day === 0 ? "Today" : "Tomorrow";

  // ── Data ──────────────────────────────────────────────────────────────────
  const summaryParams = { date };
  // The cook plan. A failed read empties `dishes`, and the panel then tells the
  // kitchen there is nothing to cook — the most consequential false empty on
  // this page.
  const { data: summary, isLoading: summaryLoading, isError: summaryError } = useQuery({
    queryKey: foodKeys.kitchenSummary(summaryParams),
    queryFn: () => foodApi.kitchenSummary(summaryParams),
  });

  // The DAY'S TOTAL, dispatched orders included. The cook plan above is what's
  // still to cook, so it empties as vans leave — and the downloads went with
  // it. The exports read this instead, so "what did we cook today" stays
  // answerable after everything has gone out.
  const totalParams = { date, includeDispatched: "true" };
  const { data: daySummary } = useQuery({
    queryKey: foodKeys.kitchenSummary(totalParams),
    queryFn: () => foodApi.kitchenSummary(totalParams),
  });

  // Whole dish catalogue with its per-person ingredient rates — shared with the
  // Service Set tabs, so react-query serves it from cache when they've loaded.
  const { data: dishCatalogue = [] } = useDishCatalogue();
  const ingredientsByDish = React.useMemo(() => {
    const m = new Map<string, DishIngredientRow[]>();
    for (const d of dishCatalogue) if (d.ingredients?.length) m.set(d.id, d.ingredients);
    return m;
  }, [dishCatalogue]);

  // The live pipeline for the day. serviceDate is the exact-day filter the
  // server supports; the status list matches the operational clamp for F&B.
  // The server caps `limit` at 100, so listAllOrders pages through until
  // meta.total is covered — otherwise a big day silently truncates and "Accept
  // all" would celebrate while unfetched PLACED orders remain. Bounded at 5
  // pages (500 live orders in one day means something else is wrong).
  const ordersParams = { serviceDate: date, status: "PLACED,ACCEPTED,DISPATCHED" };
  const {
    data: ordersPage, isLoading: ordersLoading, isError: ordersError, refetch: refetchOrders,
  } = useQuery({
    queryKey: foodKeys.orders(ordersParams),
    queryFn: () => foodApi.listAllOrders(ordersParams),
    refetchInterval: 60_000,
  });
  const orders: FoodOrder[] = ordersPage?.orders ?? [];
  const ordersTruncated = ordersPage?.truncated ?? false;
  const ordersTotal = ordersPage?.total ?? orders.length;

  const { data: lookups } = useQuery({ queryKey: foodKeys.lookups(), queryFn: () => foodApi.lookups() });
  const agencies = lookups?.agencies ?? [];
  const { data: kitchens = [] } = useQuery({ queryKey: foodKeys.kitchens(), queryFn: () => foodApi.listKitchens() });

  // ── Kitchen scope ─────────────────────────────────────────────────────────
  // `myKitchenIds` is what the SERVER already scopes this login to (null = all,
  // for heads/admins); the switcher narrows within that, never beyond it.
  const myKitchenIds = lookups?.myKitchenIds;
  const availableKitchens = React.useMemo(() => {
    const list = myKitchenIds == null ? kitchens : kitchens.filter((k) => myKitchenIds.includes(k.id));
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [kitchens, myKitchenIds]);

  // A picked kitchen that leaves the list (permissions changed, kitchen retired)
  // would silently filter everything to nothing — fall back to all kitchens.
  React.useEffect(() => {
    if (kitchen && availableKitchens.length > 0 && !availableKitchens.some((k) => k.id === kitchen)) {
      setKitchen(null);
      setScope(null);
    }
  }, [kitchen, availableKitchens]);

  // Switching kitchens invalidates the property scope (that property belongs to
  // the kitchen you just left), so drop back to the new kitchen's picker.
  const pickKitchen = (id: string | null) => { setKitchen(id); setScope(null); };

  // Every order carries its kitchen, so the switch is a pure client-side
  // narrowing of the day's orders — no refetch, and the picker stays instant.
  const kitchenOrders = kitchen ? orders.filter((o) => o.kitchenId === kitchen) : orders;

  const selectedKitchenName = kitchen ? availableKitchens.find((k) => k.id === kitchen)?.name ?? null : null;
  // Header identity: the picked kitchen, else what this login runs overall.
  const kitchenScopeLabel =
    selectedKitchenName
    ?? (myKitchenIds === null ? "All kitchens"
      : myKitchenIds && myKitchenIds.length === 1 ? kitchens.find((k) => k.id === myKitchenIds[0])?.name ?? "Your kitchen"
      : myKitchenIds && myKitchenIds.length > 1 ? `${myKitchenIds.length} kitchens`
      : null);

  // ── Property roster for the picker ────────────────────────────────────────
  // Only properties with live orders for the day appear — in every scope alike
  // (all kitchens, one picked kitchen, or a kitchen-bound login), so the picker
  // mirrors the day's real workload instead of padding a picked kitchen with
  // quiet "No orders" cards. `kitchenOrders` is already narrowed to the kitchen
  // scope, so membership needs no kitchen check of its own — and it follows the
  // ORDER's kitchen, so a mid-day reassignment stays with whoever cooks it.
  const propertyRoster = React.useMemo(() => {
    const ordered = new Set(kitchenOrders.map((o) => o.propertyId));
    const all = lookups?.properties ?? [];
    return all.filter((p) => ordered.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [lookups?.properties, kitchenOrders]);

  // Property ids the kitchen selection covers — the cook plan is reported per
  // property, so narrowing it needs the roster, not the kitchen id.
  const kitchenPropertyIds = React.useMemo(
    () => (kitchen ? new Set(propertyRoster.map((p) => p.id)) : null),
    [kitchen, propertyRoster],
  );

  // A scoped property that drops off the roster (day flip, order cancelled)
  // would otherwise strand the board on an empty scope — fall back to the picker.
  React.useEffect(() => {
    if (scope && scope !== ALL_SCOPE && lookups && !propertyRoster.some((p) => p.id === scope)) setScope(null);
  }, [scope, propertyRoster, lookups]);

  // ── Per-meal slots, narrowed to the current scope ─────────────────────────
  const scopedOrders = scope == null || scope === ALL_SCOPE
    ? kitchenOrders
    : kitchenOrders.filter((o) => o.propertyId === scope);

  // `propertyIds` narrows the cook plan; null leaves it whole (every property
  // the summary covers, which is already server-scoped to this login).
  const buildSlots = (os: FoodOrder[], propertyIds: Set<string> | null): Slot[] =>
    MEAL_TYPES.map((mealType) => {
      const live = os.filter((o) => o.mealType === mealType);
      const all = summary?.meals.find((m) => m.mealType === mealType)?.dishes ?? [];
      return {
        mealType,
        placed: live.filter((o) => o.status === "PLACED"),
        accepted: live.filter((o) => o.status === "ACCEPTED"),
        dispatched: live.filter((o) => o.status === "DISPATCHED"),
        live,
        dishes: propertyIds ? dishesForProperties(all, propertyIds) : all,
        people: live.reduce((s, o) => s + orderPeople(o), 0),
        state: kstateOf(live),
      };
    });

  const slots = buildSlots(
    scopedOrders,
    scope != null && scope !== ALL_SCOPE ? new Set([scope]) : kitchenPropertyIds,
  );

  // Per-property cards for the picker, and the combined card's meal chips
  // (the whole kitchen's day, regardless of which property is scoped).
  const propertyCards: PropertyCardData[] = propertyRoster.map((p) => {
    const mine = kitchenOrders.filter((o) => o.propertyId === p.id);
    return {
      id: p.id,
      name: p.name,
      city: p.city,
      people: mine.reduce((n, o) => n + orderPeople(o), 0),
      placed: mine.filter((o) => o.status === "PLACED"),
      state: kstateOf(mine),
      meals: buildSlots(mine, new Set([p.id])),
    };
  });
  const combinedSlots = buildSlots(kitchenOrders, kitchenPropertyIds);

  // Auto-focus the meal that needs a hand; a manual pick always wins.
  const selected: Slot =
    (pickedMeal && slots.find((s) => s.mealType === pickedMeal)) ||
    slots.find((s) => s.state === "accept") ||
    slots.find((s) => s.state === "dispatch") ||
    slots.find((s) => s.live.length > 0 || s.dishes.length > 0) ||
    slots[0];

  // Pin the auto-pick once data lands so nothing swaps the panel under the
  // user — not a background refetch, and not their own action either (after
  // accepting a meal they stay on it to cook and send it; user decision
  // 17-Jul). Only an explicit tab tap or a day flip moves the focus.
  const loadingAny = ordersLoading || summaryLoading;
  React.useEffect(() => {
    if (!pickedMeal && !loadingAny && selected) setPickedMeal(selected.mealType);
  }, [pickedMeal, loadingAny, selected?.mealType]);

  // ── Export data for the selected meal ─────────────────────────────────────
  // The day's total (dispatched included), narrowed by exactly the same
  // kitchen/property scope as the board — so a download always matches the
  // scope on screen, and keeps working once the vans have gone.
  const exportDishes = React.useMemo(() => {
    const all = daySummary?.meals.find((m) => m.mealType === selected?.mealType)?.dishes ?? [];
    const ids = scope != null && scope !== ALL_SCOPE ? new Set([scope]) : kitchenPropertyIds;
    return ids ? dishesForProperties(all, ids) : all;
  }, [daySummary, selected?.mealType, scope, kitchenPropertyIds]);

  // A slice of the whole day from the same dispatched-inclusive total — the
  // picker's Full summary downloads (one sheet per meal with dishes). `ids`
  // narrows to some properties; null/undefined means everything on the page.
  const dayMealsFor = (ids?: Set<string> | null) =>
    MEAL_TYPES.map((mealType) => {
      const all = daySummary?.meals.find((m) => m.mealType === mealType)?.dishes ?? [];
      return { meal: mealType, dishes: ids ? dishesForProperties(all, ids) : all };
    }).filter((m) => m.dishes.length > 0);

  // Hero counts follow the view: the picker totals the whole kitchen day, the
  // scoped board totals just what's in scope.
  const heroOrders = scope == null ? kitchenOrders : scopedOrders;
  const heroPlaced = heroOrders.filter((o) => o.status === "PLACED");
  const heroPeople = heroOrders.reduce((n, o) => n + orderPeople(o), 0);
  const placedPropertyCount = new Set(heroPlaced.map((o) => o.propertyId)).size;

  // Scope identity — the title/subtitle of the board, and the label the cook
  // plan sheet reports against.
  const scopeProperty = scope && scope !== ALL_SCOPE ? propertyRoster.find((p) => p.id === scope) : undefined;
  const scopeTitle = scope === ALL_SCOPE
    ? selectedKitchenName ?? "All properties — combined"
    : scopeProperty?.name ?? "Kitchen";
  const scopeLabel = scope === ALL_SCOPE
    ? kitchenScopeLabel ?? "All properties"
    : scopeProperty?.name ?? kitchenScopeLabel;

  // ── Actions ───────────────────────────────────────────────────────────────
  // One shared busy flag — the loops are sequential so each transition event
  // lands cleanly on the order timeline (same pattern as Kitchen Summary).
  const [busy, setBusy] = React.useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["food"] });

  const runAccept = async (targets: FoodOrder[], label: string, key: string) => {
    if (busy || targets.length === 0) return;
    setBusy(key);
    let ok = 0, fail = 0;
    for (const o of targets) {
      try { await foodApi.acceptOrder(o.id); ok++; } catch { fail++; }
    }
    // Await the refetch so the buttons re-enable against FRESH counts (no
    // re-click window on stale data). The focus stays on the acted-on meal —
    // the user carries it through cook and send before moving on.
    await invalidate();
    setBusy(null);
    if (fail === 0 && ordersTruncated) {
      // The board holds only part of the day, so this ran on a subset — report
      // that plainly instead of celebrating a complete run.
      toast({ title: `${ok} order${ok === 1 ? "" : "s"} accepted`, description: `This board shows ${orders.length} of ${ordersTotal} live orders — repeat to work through the rest.`, variant: "warning" });
    } else if (fail === 0) {
      fire();
      toast({ title: `${label} accepted`, description: `${ok} order${ok === 1 ? "" : "s"} moved to the kitchen queue.`, variant: "success" });
    } else {
      toast({ title: `${ok} accepted, ${fail} failed`, variant: fail > ok ? "destructive" : "warning" });
    }
  };

  const acceptMeal = (s: Slot) => runAccept(s.placed, shortMeal(s.mealType), `accept:${s.mealType}`);
  // The hero's "Accept all" takes whatever the hero is counting — the whole
  // kitchen day on the picker, the scope's orders on the board.
  const acceptEverything = () =>
    runAccept(heroPlaced, scope == null ? `${dayLabel}'s orders` : scopeTitle, "accept:ALL");
  const acceptProperty = (card: PropertyCardData) =>
    runAccept(card.placed, card.name, `accept:prop:${card.id}`);

  // ── Order-details sheet ───────────────────────────────────────────────────
  // Clicking a property NAME opens a right-side sheet with that order's dish
  // breakdown, so the kitchen sees exactly what was asked before acting.
  const [sheetOrder, setSheetOrder] = React.useState<FoodOrder | null>(null);
  // "Full summary" opens the selected meal's complete cook plan (every dish with
  // its per-property split) inline in a sheet, instead of routing to the
  // standalone Kitchen Summary page.
  const [summaryOpen, setSummaryOpen] = React.useState(false);
  React.useEffect(() => { setSummaryOpen(false); }, [selected?.mealType, day]);
  // "No dish breakdown on this order" is a statement about the order; a failed
  // read is not one.
  const { data: sheetItems, isLoading: sheetLoading, isError: sheetError } = useQuery({
    queryKey: ["food", "kitchen-items", sheetOrder?.id],
    queryFn: () => foodApi.kitchenItems(sheetOrder!.id),
    enabled: !!sheetOrder,
    staleTime: 60_000,
  });

  // ── Dispatch board ────────────────────────────────────────────────────────
  // One row per ready (ACCEPTED) order: pick its delivery partner, tick the
  // ones going out, and dispatch them together. Orders are grouped into trips
  // by (kitchen, partner) — for a single-kitchen manager that's just "one trip
  // per partner", so a mixed selection can go out across several partners at once.
  const partnersFor = (o: FoodOrder) =>
    o.kitchenId ? agencies.filter((a) => (a.kitchenIds ?? []).includes(o.kitchenId!)) : agencies;
  const defaultPartnerId = (o: FoodOrder) => partnersFor(o)[0]?.id ?? "";
  const [rowPartner, setRowPartner] = React.useState<Record<string, string>>({});
  const partnerIdOf = (o: FoodOrder) => rowPartner[o.id] ?? defaultPartnerId(o);
  const partnerNameOf = (o: FoodOrder) => agencies.find((a) => a.id === partnerIdOf(o))?.name ?? "";
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const toggleRow = (id: string) =>
    setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Keep the selection valid as the queue changes (dispatched orders drop out).
  React.useEffect(() => {
    const live = new Set(orders.filter((o) => o.status === "ACCEPTED").map((o) => o.id));
    setPicked((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [orders]);

  const dispatchable = selected?.accepted ?? [];
  const pickedOrders = dispatchable.filter((o) => picked.has(o.id) && !!partnerIdOf(o));
  const pickedPeople = pickedOrders.reduce((n, o) => n + orderPeople(o), 0);
  const pickedPartnerCount = new Set(pickedOrders.map((o) => partnerIdOf(o))).size;
  const dispatchedTotal = (selected?.dispatched.length ?? 0);
  const boardTotal = dispatchable.length + dispatchedTotal;

  const selectAllReady = () => {
    const loadable = dispatchable.filter((o) => !!partnerIdOf(o));
    const allOn = loadable.length > 0 && loadable.every((o) => picked.has(o.id));
    setPicked(allOn ? new Set() : new Set(loadable.map((o) => o.id)));
  };

  const dispatchSelected = async () => {
    if (busy || pickedOrders.length === 0) return;
    // Group into trips by (kitchen, partner) — the server allows one kitchen +
    // one agency per trip and validates the agency serves that kitchen.
    const groups = new Map<string, { agencyId: string; kitchenId: string | null; ids: string[] }>();
    for (const o of pickedOrders) {
      const agencyId = partnerIdOf(o);
      const key = `${o.kitchenId ?? "none"}::${agencyId}`;
      const g = groups.get(key) ?? { agencyId, kitchenId: o.kitchenId ?? null, ids: [] };
      g.ids.push(o.id);
      groups.set(key, g);
    }
    setBusy("dispatch");
    let ok = 0, fail = 0;
    for (const g of groups.values()) {
      try {
        await foodApi.createDispatch({ orderIds: g.ids, agencyId: g.agencyId, kitchenId: g.kitchenId ?? undefined });
        ok += g.ids.length;
      } catch { fail += g.ids.length; }
    }
    setPicked(new Set());
    await invalidate();
    setBusy(null);
    if (fail === 0) {
      fire();
      toast({ title: "Dispatched", description: `${ok} order${ok === 1 ? "" : "s"} sent across ${groups.size} trip${groups.size === 1 ? "" : "s"}.`, variant: "success" });
    } else {
      toast({ title: `${ok} dispatched, ${fail} failed`, variant: fail > ok ? "destructive" : "warning" });
    }
  };

  // Dispatched rows stay on the board as a "done" row showing partner · batch ·
  // time. A "batch" is one trip (createDispatch call); orders sharing a
  // dispatchId went out together, numbered 1..N by dispatch time within the meal.
  const dispatchedForMeal = selected?.dispatched ?? [];
  const batchNumOf = React.useMemo(() => {
    const trips = [...new Set(dispatchedForMeal.filter((o) => o.dispatchId).map((o) => o.dispatchId as string))]
      .map((id) => ({
        id,
        t: Math.min(...dispatchedForMeal.filter((o) => o.dispatchId === id).map((o) => (o.dispatchedAt ? Date.parse(o.dispatchedAt) : 0))),
      }))
      .sort((a, b) => a.t - b.t);
    return new Map(trips.map((x, i) => [x.id, i + 1] as const));
  }, [dispatchedForMeal]);
  const doneLabel = (o: FoodOrder) => {
    const partner = o.deliveryPartnerName ?? agencies.find((a) => a.id === o.deliveryPartnerId)?.name ?? "Dispatched";
    const batch = o.dispatchId ? batchNumOf.get(o.dispatchId) : undefined;
    const time = o.dispatchedAt ? format(parseISO(o.dispatchedAt), "h:mm a").toLowerCase() : "";
    return [partner, batch ? `batch ${batch}` : null, time || null].filter(Boolean).join(" · ");
  };

  // Everything on the board, ready and gone, as a downloadable manifest.
  const dispatchExportRows = [
    ...dispatchable.map((o) => ({ o, partner: partnerNameOf(o) || "—" })),
    ...dispatchedForMeal.map((o) => ({
      o,
      partner: o.deliveryPartnerName ?? agencies.find((a) => a.id === o.deliveryPartnerId)?.name ?? "—",
    })),
  ];

  // The dispatch list needs each order's dish lines — fetched through the query
  // cache so rows already opened on the board don't refetch.
  const [exporting, setExporting] = React.useState(false);
  const exportDispatchList = async () => {
    if (exporting || dispatchExportRows.length === 0) return;
    setExporting(true);
    try {
      await downloadDispatchList(
        dispatchExportRows,
        (orderId) => qc.fetchQuery({
          queryKey: ["food", "kitchen-items", orderId],
          queryFn: () => foodApi.kitchenItems(orderId),
          staleTime: 60_000,
        }),
        selected.mealType,
        dayLabel,
      );
    } finally {
      setExporting(false);
    }
  };

  const loading = ordersLoading || summaryLoading;
  const tint = STATE_TINT[selected?.state ?? "quiet"];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto flex max-w-[760px] animate-fade-up flex-col gap-6">
      {confetti}

      {/* Header. On the picker the title is the kitchen this login runs; once
          scoped it's the property (or the combined view) being worked, with a
          way back. The day stepper is shared, so both views work one day. */}
      {scope == null ? (
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[260px] flex-1">
            <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">
              {kitchenScopeLabel ?? "Kitchen Home"}
            </h1>
            <p className="text-sm text-muted-foreground">
              Your kitchen day — pick a property to run it, or work the combined view.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {availableKitchens.length > 1 && (
              <KitchenSwitcher kitchens={availableKitchens} value={kitchen} onChange={pickKitchen} />
            )}
            <DayStepper day={day} setDay={setDay} dayLabel={dayLabel} dayDate={dayDate} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Scope switcher — back to the picker, then jump straight between
              properties without going through it. */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setScope(null)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Properties
            </button>
            <span className="h-5 w-px bg-border" />
            {[{ id: ALL_SCOPE, name: "All properties" }, ...propertyRoster].map((p) => {
              const active = scope === p.id;
              const nPlaced = kitchenOrders.filter(
                (o) => o.status === "PLACED" && (p.id === ALL_SCOPE || o.propertyId === p.id),
              ).length;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setScope(p.id)}
                  className={cn(
                    "inline-flex items-center gap-[7px] rounded-full px-3.5 py-1.5 text-[13px] font-bold transition-colors",
                    active
                      ? "border-[1.5px] border-accent bg-accent/[.08] text-accent-strong"
                      : "border border-border bg-card text-muted-foreground hover:border-accent hover:text-foreground",
                  )}
                >
                  {p.name}
                  {!active && nPlaced > 0 && (
                    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-extrabold text-white">
                      {nPlaced}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-[260px] flex-1">
              <h1 className="mb-1 font-display text-[22px] font-bold tracking-[-0.012em]">{scopeTitle}</h1>
              <p className="text-sm text-muted-foreground">
                {scope === ALL_SCOPE
                  ? `Every property's orders${selectedKitchenName ? " in this kitchen" : ""} in one board — same flow, everything together.`
                  : `${scopeProperty?.city ? `${scopeProperty.city} · ` : ""}only this property's orders — accept, cook and send from here.`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {availableKitchens.length > 1 && (
                <KitchenSwitcher kitchens={availableKitchens} value={kitchen} onChange={pickKitchen} />
              )}
              <DayStepper day={day} setDay={setDay} dayLabel={dayLabel} dayDate={dayDate} />
            </div>
          </div>
        </div>
      )}

      {/* More live orders exist than this board holds — the Accept/Dispatch
          actions therefore cover a subset, so say it before they are used. */}
      {ordersTruncated && (
        <div className="rounded-[12px] border border-warning/40 bg-warning-soft px-4 py-3 text-[13px] text-warning">
          Showing {orders.length} of {ordersTotal} live orders for this day. Accept and dispatch
          apply only to what is listed here — repeat to work through the rest.
        </div>
      )}

      {/* Hero: what needs a hand — the whole day on the picker, the scope's
          orders once inside. A failed read is NOT an empty board: say it failed
          rather than rendering "nothing waiting". */}
      {ordersError ? (
        <FoodQueryError label="the day's orders" onRetry={() => refetchOrders()} />
      ) : ordersLoading ? (
        <Skeleton className="h-24 w-full rounded-[14px]" />
      ) : heroPlaced.length > 0 ? (
        <section className="rounded-[14px] bg-brand-gradient p-[2px]">
          <div className="flex flex-wrap items-center gap-[18px] rounded-[12px] bg-card px-6 py-5">
            <div className="min-w-[220px] flex-1">
              <div className="font-display text-lg font-bold tracking-[-0.012em]">
                {heroPlaced.length} order{heroPlaced.length === 1 ? "" : "s"} waiting
                {scope == null && placedPropertyCount > 1
                  ? ` across ${placedPropertyCount} properties`
                  : " for the kitchen"}
              </div>
              <div className="mt-1 text-[13px] text-muted-foreground">
                {dayLabel}, {format(dayDate, "EEEE, dd MMM")} ·{" "}
                <strong className="text-accent-strong">{heroPeople} people</strong> to feed
              </div>
            </div>
            {canKitchen && (
              <button
                type="button"
                onClick={acceptEverything}
                disabled={!!busy}
                className="h-[52px] rounded-[12px] bg-accent px-6 font-display text-base font-bold tracking-[-0.012em] text-white transition-[filter] hover:brightness-105 disabled:opacity-60"
              >
                {busy === "accept:ALL" ? "Accepting…" : "Accept all →"}
              </button>
            )}
          </div>
        </section>
      ) : heroOrders.length > 0 ? (
        <section className="flex items-center gap-3.5 rounded-[14px] bg-success-soft px-[22px] py-4">
          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-success">
            <Check className="h-4 w-4 text-white" strokeWidth={3} />
          </span>
          <div className="flex-1">
            <div className="font-display font-bold tracking-[-0.012em] text-success">
              Everything&rsquo;s accepted
            </div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              {format(dayDate, "EEEE, dd MMM")} · {heroPeople} people ·{" "}
              {scope == null ? "open a property below to cook and send the vans." : "send the vans below."}
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Property picker ─────────────────────────────────────────────── */}
      {scope == null ? (
        <>
          {/* Combined view — work every property's orders on one board. The
              card is a div wrapping the original full-size open button, so the
              day's Full summary download can float in the top-right corner
              without nesting buttons or changing the card's footprint. */}
          <div className="relative w-full rounded-[14px] border border-border bg-card transition-colors hover:border-accent">
            <button
              type="button"
              onClick={() => setScope(ALL_SCOPE)}
              className="flex w-full flex-wrap items-center gap-4 px-[22px] py-4 text-left"
            >
              {/* pr clears the floating download pill on narrow cards, where
                  the wrapped title would otherwise run underneath it. */}
              <div className="min-w-[240px] flex-1 pr-28 sm:pr-0">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-accent-strong">
                  Combined summary
                </div>
                <div className="font-display text-[17px] font-bold tracking-[-0.012em]">
                  All properties — one kitchen day
                </div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">
                  Accept, cook and dispatch everything together.
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {combinedSlots.map((s) => {
                  const t = STATE_TINT[s.state];
                  return (
                    <span
                      key={s.mealType}
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold"
                      style={{ background: `color-mix(in srgb, ${t} 16%, var(--card))`, color: t }}
                    >
                      <span
                        className={cn("h-[7px] w-[7px] rounded-full", s.state === "accept" && "animate-pulse-dot")}
                        style={{ background: t }}
                      />
                      {shortMeal(s.mealType)} · {stateShort(s.state, s.placed.length)}
                    </span>
                  );
                })}
              </div>
              <span className="font-display text-[15px] font-bold text-accent-strong">Open →</span>
            </button>
            {(() => {
              const dayMeals = dayMealsFor(kitchenPropertyIds);
              return dayMeals.length > 0 ? (
                <button
                  type="button"
                  onClick={() => downloadFullSummaryDay(dayMeals, ingredientsByDish, selectedKitchenName ?? "All properties", dayLabel)}
                  className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground"
                >
                  <Download className="h-3 w-3" /> Full summary
                </button>
              ) : null;
            })()}
          </div>

          <section>
            <div className="mb-3 flex items-baseline gap-2.5">
              <h2 className="font-display text-base font-bold tracking-[-0.012em]">Ordering today</h2>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {propertyCards.length} propert{propertyCards.length === 1 ? "y" : "ies"}
              </span>
            </div>
            {loading ? (
              <div className="grid gap-3.5 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-[184px] rounded-[14px]" />
                ))}
              </div>
            ) : propertyCards.length === 0 ? (
              <div className="rounded-[12px] border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
                {selectedKitchenName
                  ? `No properties ordered from ${selectedKitchenName} ${dayLabel.toLowerCase()} — cards appear as orders land.`
                  : `No properties ordered ${dayLabel.toLowerCase()} — cards appear as orders land.`}
              </div>
            ) : (
              <div className="grid gap-3.5 sm:grid-cols-2">
                {propertyCards.map((card) => {
                  const dayMeals = dayMealsFor(new Set([card.id]));
                  return (
                    <PropertyCard
                      key={card.id}
                      card={card}
                      canKitchen={canKitchen}
                      busy={busy}
                      onOpen={() => setScope(card.id)}
                      onAccept={() => acceptProperty(card)}
                      onDownload={dayMeals.length > 0
                        ? () => downloadFullSummaryDay(dayMeals, ingredientsByDish, card.name, dayLabel)
                        : null}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </>
      ) : (

      /* ── Scoped board: meal tabs + cook plan + accept + dispatch ─────── */
      <section>
        {/* Meal tabs */}
        {loading ? (
          <div className="mb-4 flex flex-wrap gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] min-w-[150px] flex-1 rounded-[14px]" />
            ))}
          </div>
        ) : (
          <div className="mb-4 flex flex-wrap gap-3">
            {slots.map((s) => {
              const t = STATE_TINT[s.state];
              const isSel = s.mealType === selected?.mealType;
              const actionable = s.state === "accept" || s.state === "dispatch";
              return (
                <button
                  key={s.mealType}
                  type="button"
                  onClick={() => setPickedMeal(s.mealType)}
                  className="flex min-w-[150px] flex-1 basis-[160px] flex-col items-start gap-[7px] rounded-[14px] px-4 py-3.5 text-left transition-shadow"
                  style={{
                    background: isSel ? `color-mix(in srgb, ${t} 12%, var(--card))` : "var(--card)",
                    border: isSel ? `1.5px solid ${t}` : "1px solid var(--border)",
                    boxShadow: isSel ? `0 6px 18px color-mix(in srgb, ${t} 16%, transparent)` : "none",
                  }}
                >
                  <span className="flex w-full items-center gap-2">
                    <MealIcon meal={s.mealType} size={26} />
                    <span className="flex-1 text-left font-display text-[15px] font-bold tracking-[-0.012em]">
                      {shortMeal(s.mealType)}
                    </span>
                    <span
                      className={cn("h-[9px] w-[9px] shrink-0 rounded-full", actionable && "animate-pulse-dot")}
                      style={{ background: t }}
                    />
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">by {SERVE_BY[s.mealType]}</span>
                  <span
                    className="self-start rounded-full px-[9px] py-[3px] text-[11px] font-bold"
                    style={{ background: `color-mix(in srgb, ${t} 16%, var(--card))`, color: t }}
                  >
                    {stateShort(s.state, s.placed.length)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Detail panel for the selected meal */}
        {loading ? (
          <Skeleton className="h-40 w-full rounded-2xl" />
        ) : selected ? (
          <div className="rounded-2xl border border-border bg-card p-[18px]">
            {/* Meal head */}
            <div className="mb-4 flex flex-wrap items-center gap-2.5">
              <span className="font-display text-[17px] font-bold tracking-[-0.012em]">
                {MEAL_LABEL[selected.mealType]}
              </span>
              <span className="font-mono text-xs text-muted-foreground">serve by {SERVE_BY[selected.mealType]}</span>
              <span className="flex-1" />
              <span
                className="rounded-full px-[11px] py-1 text-xs font-bold"
                style={{ background: `color-mix(in srgb, ${tint} 16%, var(--card))`, color: tint }}
              >
                {stateShort(selected.state, selected.placed.length)}
              </span>
              <button
                type="button"
                onClick={() => setSummaryOpen(true)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground"
              >
                <Soup className="h-3.5 w-3.5" /> Full summary
              </button>
            </div>

            {/* Cook plan */}
            <div className="mb-3 rounded-[12px] border border-border bg-background px-4 py-3.5">
              <ColumnHead
                icon={<Soup className="h-[13px] w-[13px]" strokeWidth={2.5} />}
                label="Cook plan"
                tone="var(--accent-strong)"
                right={
                  <div className="flex items-center gap-2">
                    {selected.people > 0 && (
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {selected.people} people
                      </span>
                    )}
                    {/* Download (real .xlsx): dish + quantity + property split +
                        ingredients + used-in, one sheet. It reads the DAY'S
                        TOTAL, not the remaining cook plan, so it stays available
                        before accepting, after accepting, and after everything
                        has been dispatched — when the plan above is empty. */}
                    {exportDishes.length > 0 && (
                      <button
                        type="button"
                        onClick={() => downloadFullSummary(exportDishes, ingredientsByDish, selected.mealType, dayLabel)}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground"
                      >
                        <Download className="h-3 w-3" /> Full summary
                      </button>
                    )}
                  </div>
                }
              />
              {summaryError ? (
                <div className="rounded-[9px] border border-destructive/40 bg-destructive/5 px-3 py-5 text-center text-[13px] text-destructive">
                  Could not load the cook plan — do not treat this as nothing to cook.
                </div>
              ) : selected.dishes.length === 0 ? (
                <div className="rounded-[9px] border border-dashed border-border px-3 py-5 text-center text-[13px] text-muted-foreground">
                  {exportDishes.length > 0
                    ? `All of ${shortMeal(selected.mealType).toLowerCase()} has gone out — the day's totals are still downloadable above.`
                    : `No cook plan for ${shortMeal(selected.mealType).toLowerCase()} ${dayLabel.toLowerCase()} — it fills in as orders land.`}
                </div>
              ) : (
                <div className="-mr-1 max-h-[320px] overflow-y-auto pr-1">
                  {/* Same dish-card language as the unit lead's Food Overview:
                      glass DishIcon + name + per-property meta + mono quantity. */}
                  <div className="grid gap-2.5 py-0.5 sm:grid-cols-2">
                    {selected.dishes.map((d) => (
                      <div
                        key={`${d.dishId}|${d.unit}`}
                        className="flex items-center gap-2.5 rounded-[12px] border border-border bg-card px-3 py-2.5"
                      >
                        <DishIcon name={d.dishName} meal={selected.mealType} size={40} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold">{d.dishName}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {d.byProperty.length === 0
                              ? "—"
                              : `${d.byProperty.length} propert${d.byProperty.length === 1 ? "y" : "ies"}`}
                          </div>
                        </div>
                        <span className="shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums">
                          {fmtQty(d.displayQty)}{" "}
                          <span className="text-[10.5px] font-bold uppercase text-muted-foreground">{d.displayUnit}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* New orders (left) + dispatch board (right): shown side-by-side
                50/50 when there are orders to accept; when nothing's waiting the
                New orders card is hidden and the dispatch board takes the full
                width. Stacks vertically on smaller screens. */}
            <div className={cn("grid items-stretch gap-3", selected.placed.length > 0 && "lg:grid-cols-2")}>
              {/* Accept — only rendered when orders are actually waiting */}
              {selected.placed.length > 0 && (
                <div className="flex flex-col rounded-[12px] border border-border bg-background px-4 py-3.5">
                  <ColumnHead
                    icon={<Inbox className="h-[13px] w-[13px]" strokeWidth={2.5} />}
                    label="New orders"
                    tone="var(--warning)"
                    right={
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{selected.placed.length}</span>
                    }
                  />
                  <div className="flex-1">
                    {selected.placed.map((o) => (
                      <OrderRow key={o.id} o={o} onOpen={setSheetOrder} />
                    ))}
                  </div>
                  {canKitchen && (
                    <button
                      type="button"
                      onClick={() => acceptMeal(selected)}
                      disabled={!!busy}
                      className="mt-3 h-10 w-full rounded-[9px] bg-warning text-[13px] font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busy === `accept:${selected.mealType}` ? "Accepting…" : `Accept all (${selected.placed.length})`}
                    </button>
                  )}
                </div>
              )}

              {/* Dispatch board — pick a partner per property, then dispatch one,
                  a few, or all together. */}
              <div className="flex flex-col rounded-[12px] border border-border bg-background px-4 py-3.5">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-success">Dispatch board</span>
                  {dispatchable.length > 0 && (
                    <span className="text-[12px] text-muted-foreground">
                      pick a partner per property, then send them out
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {boardTotal > 0 && (
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {dispatchedTotal} of {boardTotal} dispatched
                    </span>
                  )}
                  {/* The board as a manifest: every dish on every order, who
                      it's for, and the partner taking it. Stays available once
                      everything is out, which is when it's usually wanted. */}
                  {dispatchExportRows.length > 0 && (
                    <button
                      type="button"
                      onClick={exportDispatchList}
                      disabled={exporting}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Download className="h-3 w-3" /> {exporting ? "Preparing…" : "Dispatch list"}
                    </button>
                  )}
                </div>
              </div>

              {dispatchable.length === 0 && dispatchedForMeal.length === 0 ? (
                <ColumnEmpty text="Accepted orders appear here, ready to send out." />
              ) : (
                <>
                  {canDispatch && dispatchable.length > 0 && (
                    <div className="mb-2 flex justify-end">
                      <button
                        type="button"
                        onClick={selectAllReady}
                        className="text-[12px] font-semibold text-muted-foreground transition-colors hover:text-accent"
                      >
                        {dispatchable.every((o) => picked.has(o.id)) ? "Clear selection" : "Select all"}
                      </button>
                    </div>
                  )}

                  <div className="flex flex-col gap-2">
                    {/* ready orders first (actionable), then the dispatched ones (done) */}
                    {dispatchable.map((o) => (
                      <DispatchRow
                        key={o.id}
                        o={o}
                        done={false}
                        doneText=""
                        canDispatch={canDispatch}
                        isPicked={picked.has(o.id)}
                        onToggle={() => toggleRow(o.id)}
                        partners={partnersFor(o)}
                        partnerId={partnerIdOf(o)}
                        onPartner={(v) => setRowPartner((p) => ({ ...p, [o.id]: v }))}
                      />
                    ))}
                    {dispatchedForMeal.map((o) => (
                      <DispatchRow
                        key={o.id}
                        o={o}
                        done
                        doneText={doneLabel(o)}
                        canDispatch={canDispatch}
                        isPicked={false}
                        onToggle={() => {}}
                        partners={[]}
                        partnerId=""
                        onPartner={() => {}}
                      />
                    ))}
                  </div>

                  {/* Sticky dispatch bar — appears once something is selected */}
                  {canDispatch && pickedOrders.length > 0 && (
                    <div className="sticky bottom-3 z-10 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-border bg-card px-4 py-3 shadow-lg">
                      <span className="text-[13px] font-semibold">
                        {pickedOrders.length} selected · {pickedPeople} people
                      </span>
                      <button
                        type="button"
                        onClick={dispatchSelected}
                        disabled={!!busy}
                        className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-success px-5 text-sm font-bold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy === "dispatch"
                          ? "Dispatching…"
                          : `Dispatch ${pickedOrders.length} order${pickedOrders.length === 1 ? "" : "s"} · ${pickedPartnerCount} partner${pickedPartnerCount === 1 ? "" : "s"}`}
                        <span aria-hidden>→</span>
                      </button>
                    </div>
                  )}
                </>
              )}
              </div>
            </div>
          </div>
        ) : null}
      </section>
      )}

      {/* Order-details sheet — what this property ordered */}
      <Sheet open={!!sheetOrder} onOpenChange={(o) => { if (!o) setSheetOrder(null); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {sheetOrder && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2.5 font-display text-lg font-bold tracking-[-0.012em]">
                  <MealIcon meal={sheetOrder.mealType} size={26} />
                  {sheetOrder.propertyName ?? "Property"}
                </SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-xs tabular-nums">{sheetOrder.orderNumber}</span>
                  <span>· {MEAL_LABEL[sheetOrder.mealType]}</span>
                  <span>· {orderPeople(sheetOrder)} people</span>
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 flex flex-col gap-3">
                {ORDER_STATUS_PILL[sheetOrder.status] && (
                  <span
                    className={cn(
                      "self-start rounded-full px-[11px] py-1 text-xs font-bold",
                      ORDER_STATUS_PILL[sheetOrder.status].cls,
                    )}
                  >
                    {ORDER_STATUS_PILL[sheetOrder.status].label}
                  </span>
                )}

                <div className="rounded-[12px] border border-border bg-background px-4 py-3.5">
                  <ColumnHead
                    icon={<Soup className="h-[13px] w-[13px]" strokeWidth={2.5} />}
                    label="What they ordered"
                    tone="var(--accent-strong)"
                    right={sheetItems?.length ? (
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {sheetItems.length} dish{sheetItems.length === 1 ? "" : "es"}
                      </span>
                    ) : undefined}
                  />
                  {sheetLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : sheetError ? (
                    <div className="py-3 text-center text-[13px] text-destructive">
                      Could not load the dish breakdown.
                    </div>
                  ) : !sheetItems?.length ? (
                    <div className="py-3 text-center text-[13px] text-muted-foreground">
                      No dish breakdown on this order.
                    </div>
                  ) : (
                    sheetItems.map((it) => {
                      const sent = it.preparedQty ?? it.orderedQty ?? 0;
                      const adjusted = it.preparedQty != null && it.orderedQty != null && it.preparedQty !== it.orderedQty;
                      return (
                        <div
                          key={it.id}
                          className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 last:border-0"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <DishIcon name={it.dishName ?? ""} meal={sheetOrder.mealType} size={28} />
                            <span className="min-w-0 truncate text-[13px]">{it.dishName ?? "Item"}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12.5px] font-semibold tabular-nums">
                            {adjusted && (
                              <span className="text-[11px] text-muted-foreground line-through">
                                {fmtQty(it.orderedQty!)}
                              </span>
                            )}
                            {fmtQty(sent)}{" "}
                            <span className="text-[10px] font-bold uppercase text-muted-foreground">{it.unit}</span>
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>

                {sheetOrder.notes && (
                  <div className="rounded-[12px] border border-border bg-background px-4 py-3">
                    <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                      Note from the property
                    </div>
                    <p className="text-[13px]">{sheetOrder.notes}</p>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Full summary sheet — the meal's complete cook plan with per-property splits */}
      <Sheet open={summaryOpen} onOpenChange={setSummaryOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2.5 font-display text-lg font-bold tracking-[-0.012em]">
                  <MealIcon meal={selected.mealType} size={26} />
                  {MEAL_LABEL[selected.mealType]} · cook plan
                </SheetTitle>
                <SheetDescription>
                  {[
                    scopeLabel,
                    `${selected.people} people`,
                    (() => {
                      const props = new Set(exportDishes.flatMap((d) => d.byProperty.map((bp) => bp.propertyId)));
                      return props.size > 0 ? `${props.size} propert${props.size === 1 ? "y" : "ies"}` : null;
                    })(),
                  ].filter(Boolean).join(" · ")}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 flex flex-col gap-3">
                {summaryError ? (
                  <div className="rounded-[12px] border border-destructive/40 bg-destructive/5 px-4 py-8 text-center text-[13px] text-destructive">
                    Could not load the cook plan — do not treat this as nothing to cook.
                  </div>
                ) : exportDishes.length === 0 ? (
                  <div className="rounded-[12px] border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
                    No cook plan for {shortMeal(selected.mealType).toLowerCase()} {dayLabel.toLowerCase()} — it fills in as orders land.
                  </div>
                ) : (
                  exportDishes.map((d) => (
                    <div key={`${d.dishId}|${d.unit}`} className="rounded-[12px] border border-border bg-background px-4 py-3">
                      {/* dish head: icon + name + total */}
                      <div className="mb-2 flex items-center gap-2.5">
                        <DishIcon name={d.dishName} meal={selected.mealType} size={34} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-bold tracking-[-0.006em]">{d.dishName}</div>
                          {d.component && (
                            <div className="text-[11px] uppercase tracking-[.06em] text-muted-foreground">
                              {d.component.replace(/_/g, " ")}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 text-right font-mono text-[14px] font-bold tabular-nums">
                          {fmtQty(d.displayQty)}{" "}
                          <span className="text-[10.5px] font-bold uppercase text-muted-foreground">{d.displayUnit}</span>
                        </span>
                      </div>
                      {/* per-property split */}
                      {d.byProperty.map((bp) => (
                        <div
                          key={bp.propertyId}
                          className="flex items-center justify-between gap-2 border-t border-dashed border-border py-1.5"
                        >
                          <span className="min-w-0 truncate text-[13px] text-muted-foreground">{bp.propertyName}</span>
                          <span className="shrink-0 font-mono text-[12.5px] font-semibold tabular-nums">
                            {fmtQty(bp.qty)}{" "}
                            <span className="text-[10px] font-bold uppercase text-muted-foreground">{d.displayUnit}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
