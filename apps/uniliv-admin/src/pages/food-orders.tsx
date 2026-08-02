import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format, isToday, isYesterday, parseISO } from "date-fns";
import { jsPDF } from "jspdf";
import {
  ChevronRight, Download, FileDown, FileText, PackageX, Plus, Search,
} from "lucide-react";
import { PropertyScopeBanner } from "@/components/property-scope-banner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  foodApi, foodKeys, orderPeople, MEAL_TYPES, BRANDS, ORDER_STATUSES, MEAL_LABEL, ORDER_STATUS_PILL, orderStatusPill,
  fmtQty, serviceDayKey, groupLabel,
  type FoodOrder,
} from "@/lib/food-api";
import { useQueryParam } from "@/lib/nav-helpers";
import { useScopedColumns } from "@/lib/use-scoped-columns";
import { usePermissions } from "@/lib/use-permissions";
import { isSuperAdminRole } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const ALL = "ALL";

/** Short, human note for a child row, derived from the order's status timing. */
function orderNote(o: FoodOrder, propertyLabel: string | null): string {
  const time = (iso: string | null) => (iso ? format(new Date(iso), "h:mm a") : "");
  let note: string;
  switch (o.status) {
    case "DELIVERED":
      note = o.deliveredAt ? `Received ${time(o.deliveredAt)}` : "Received";
      break;
    case "DISPATCHED":
      note = o.expectedDeliveryAt ? `ETA ${time(o.expectedDeliveryAt)}` : "On the way to your gate";
      break;
    case "ACCEPTED":
      note = "In the kitchen";
      break;
    case "PLACED":
      note = "Waiting for the kitchen to accept";
      break;
    case "CANCELLED":
      note = o.cancelReason || "Cancelled";
      break;
    case "REJECTED":
      note = o.rejectionReason || "Rejected by the kitchen";
      break;
    default:
      note = "";
  }
  return propertyLabel ? (note ? `${propertyLabel} · ${note}` : propertyLabel) : note;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Minimal client-side PDF table via jsPDF (same look as the shared DataTable export). */
function renderOrdersPdf(opts: {
  headers: string[];
  rows: string[][];
  propertyName: string | null;
  exportDate: Date;
}): Blob {
  const { headers, rows, propertyName, exportDate } = opts;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 36;
  const usableW = pageW - margin * 2;
  const colW = usableW / Math.max(1, headers.length);
  const rowH = 18;

  const fit = (text: string): string => {
    let s = text ?? "";
    while (s.length > 0 && doc.getTextWidth(s) > colW - 6) s = s.slice(0, -1);
    return s.length < (text ?? "").length ? s.slice(0, -1) + "…" : s;
  };

  let y = margin;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text("Food Orders", margin, y + 10);
  doc.setDrawColor(250, 115, 22);
  doc.setLineWidth(3);
  doc.line(margin, y + 16, margin + 48, y + 16);
  y += 28;
  const metaParts: string[] = [];
  if (propertyName) metaParts.push(`Property: ${propertyName}`);
  metaParts.push(`Exported: ${format(exportDate, "dd/MM/yyyy HH:mm")}`);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(107, 114, 128);
  doc.text(metaParts.join("    "), margin, y + 4);
  y += 18;

  const drawHeader = () => {
    doc.setFillColor(15, 23, 42);
    doc.rect(margin, y, usableW, rowH, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    headers.forEach((h, i) => doc.text(fit(h), margin + i * colW + 4, y + 12));
    y += rowH;
  };
  drawHeader();

  doc.setFont("helvetica", "normal");
  rows.forEach((row, idx) => {
    if (y + rowH > pageH - margin) {
      doc.addPage();
      y = margin;
      drawHeader();
      doc.setFont("helvetica", "normal");
    }
    if (idx % 2 === 0) {
      doc.setFillColor(245, 250, 252);
      doc.rect(margin, y, usableW, rowH, "F");
    }
    doc.setFontSize(8);
    doc.setTextColor(26, 31, 41);
    row.forEach((cell, i) => doc.text(fit(cell ?? ""), margin + i * colW + 4, y + 12));
    y += rowH;
  });

  return doc.output("blob");
}

type ExportCol = { accessorKey: string; header: string; text: (o: FoodOrder) => string };

type DayGroup = {
  serviceDate: string; label: string; dateStr: string; orders: FoodOrder[];
  /** The single group id shared by EVERY order in the day, else null (a day can
   *  span multiple batches — several properties, or a split placement). When set
   *  it's shown once in the header instead of repeated on every row. */
  batchNumber: string | null;
};

export default function FoodOrders() {
  const [, setLocation] = useLocation();
  // Data download/export is restricted to Super Admin (+ OPS parity).
  const { role } = usePermissions();
  const canExport = isSuperAdminRole(role);
  const paramProperty = useQueryParam("propertyId");
  const paramStatus = useQueryParam("status");

  const [status, setStatus] = React.useState<string>(paramStatus || ALL);
  const [propertyId, setPropertyId] = React.useState<string>(paramProperty || ALL);
  // When navigated here scoped to a property (?propertyId=), apply that filter.
  React.useEffect(() => { if (paramProperty) setPropertyId(paramProperty); }, [paramProperty]);
  // Deep-link can also pre-apply a status filter (e.g. ?status=DELIVERED).
  React.useEffect(() => { if (paramStatus) setStatus(paramStatus); }, [paramStatus]);
  const [brand, setBrand] = React.useState<string>(ALL);
  const [mealType, setMealType] = React.useState<string>(ALL);
  const [from, setFrom] = React.useState<string>("");
  const [to, setTo] = React.useState<string>("");
  const [searchInput, setSearchInput] = React.useState<string>("");
  const [search, setSearch] = React.useState<string>("");

  // Day cards the user explicitly toggled; the first (most recent) day defaults open.
  const [openDays, setOpenDays] = React.useState<Record<string, boolean>>({});

  // Debounce search by orderNumber.
  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data: lookups } = useQuery({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];

  const params = React.useMemo(
    () => ({
      status: status === ALL ? undefined : status,
      from: from || undefined,
      to: to || undefined,
      propertyId: propertyId === ALL ? undefined : propertyId,
      brand: brand === ALL ? undefined : brand,
      mealType: mealType === ALL ? undefined : mealType,
      search: search || undefined,
      limit: 100,
    }),
    [status, from, to, propertyId, brand, mealType, search],
  );

  const { data: res, isLoading } = useQuery({
    queryKey: foodKeys.orders(params),
    queryFn: () => foodApi.listOrders(params),
  });
  const orders: FoodOrder[] = res?.data ?? [];

  // Name of the property the page is currently scoped to (URL param or filter),
  // for the scope banner. Falls back gracefully until lookups resolve.
  const scopedPropertyName =
    propertyId === ALL ? null : (properties.find((p) => p.id === propertyId)?.name ?? "Selected property");
  const clearScope = () => {
    setPropertyId(ALL);
    if (paramProperty) setLocation("/food/orders"); // drop the ?propertyId= deep-link
  };

  const resetFilters = () => {
    setStatus(ALL); setPropertyId(ALL); setBrand(ALL); setMealType(ALL);
    setFrom(""); setTo(""); setSearchInput(""); setSearch("");
    if (paramProperty) setLocation("/food/orders");
  };
  const hasFilters =
    status !== ALL || propertyId !== ALL || brand !== ALL || mealType !== ALL || !!from || !!to || !!search;

  // Export columns mirror the old table view; scoping drops the Property column
  // for property-scoped viewers and Unit Lead for unit leads (same rules as before).
  const exportColsAll = React.useMemo<ExportCol[]>(
    () => [
      { accessorKey: "orderNumber", header: "Order ID", text: (o) => o.orderNumber },
      {
        accessorKey: "propertyId",
        header: "Property",
        text: (o) => o.propertyName ?? properties.find((p) => p.id === o.propertyId)?.name ?? "—",
      },
      { accessorKey: "unitLeadName", header: "Unit Lead", text: (o) => o.unitLeadName || "—" },
      { accessorKey: "mealType", header: "Meal", text: (o) => MEAL_LABEL[o.mealType] ?? o.mealType },
      { accessorKey: "residentsCount", header: "Residents", text: (o) => String(o.residentsCount) },
      { accessorKey: "staffCount", header: "Staff", text: (o) => String(o.staffCount ?? 0) },
      { accessorKey: "people", header: "Total", text: (o) => String(orderPeople(o)) },
      { accessorKey: "totalQuantity", header: "Quantity", text: (o) => fmtQty(o.totalQuantity) },
      {
        accessorKey: "serviceDate",
        header: "Service Date",
        text: (o) => format(parseISO(o.serviceDate), "dd MMM yyyy"),
      },
      {
        accessorKey: "createdAt",
        header: "Placed at Date",
        text: (o) => (o.createdAt ? format(new Date(o.createdAt), "dd MMM yyyy") : "—"),
      },
      { accessorKey: "status", header: "Status", text: (o) => o.status },
    ],
    [properties],
  );
  const exportCols = useScopedColumns(exportColsAll, {
    singleProperty: ["propertyId"],
    roles: { UNIT_LEAD: ["unitLeadName"] },
  });

  // Show a per-row property label only when the viewer can actually see several
  // properties and hasn't scoped the page down to one.
  const showProperty = propertyId === ALL && exportCols.some((c) => c.accessorKey === "propertyId");

  const exportCsv = () => {
    const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const now = new Date();
    const meta: string[] = ["Food Orders"];
    if (scopedPropertyName) meta.push(`Property: ${scopedPropertyName}`);
    meta.push(`Exported: ${format(now, "dd/MM/yyyy HH:mm")}`);
    const lines = [
      ...meta.map(escape),
      "",
      exportCols.map((c) => escape(c.header)).join(","),
      ...orders.map((o) => exportCols.map((c) => escape(c.text(o))).join(",")),
    ];
    downloadBlob(
      new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" }),
      `food-orders-${format(now, "yyyy-MM-dd")}.csv`,
    );
  };

  const exportPdf = () => {
    const now = new Date();
    const pdf = renderOrdersPdf({
      headers: exportCols.map((c) => c.header),
      rows: orders.map((o) => exportCols.map((c) => c.text(o))),
      propertyName: scopedPropertyName,
      exportDate: now,
    });
    downloadBlob(pdf, `food-orders-${format(now, "yyyy-MM-dd")}.pdf`);
  };

  // Group the fetched orders by service day, newest first; meals in day order.
  // serviceDate is a full timestamp, so normalise to the LOCAL calendar day —
  // otherwise two orders on the same day with different times split into
  // duplicate groups.
  const dayGroups = React.useMemo<DayGroup[]>(() => {
    const byDate = new Map<string, FoodOrder[]>();
    for (const o of orders) {
      const dayKey = serviceDayKey(o.serviceDate);
      const list = byDate.get(dayKey);
      if (list) list.push(o);
      else byDate.set(dayKey, [o]);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([serviceDate, dayOrders]) => {
        const d = parseISO(serviceDate);
        const near = isToday(d) || isYesterday(d);
        // Header batch only when EVERY order shares the same non-null batch (one
        // property, one placement). A mix of batches or any batch-less order →
        // null, so those days keep the per-row labels and nothing is hidden.
        const first = dayOrders[0]?.batchNumber ?? null;
        const sharedBatch = first && dayOrders.every((o) => o.batchNumber === first) ? first : null;
        return {
          serviceDate,
          label: isToday(d) ? "Today" : isYesterday(d) ? "Yesterday" : format(d, "EEE, d MMM"),
          dateStr: near ? format(d, "EEE, d MMM") : "",
          batchNumber: sharedBatch,
          orders: [...dayOrders].sort(
            (a, b) =>
              MEAL_TYPES.indexOf(a.mealType) - MEAL_TYPES.indexOf(b.mealType) ||
              a.orderNumber.localeCompare(b.orderNumber),
          ),
        };
      });
  }, [orders]);

  // All day groups start collapsed; the user expands the days they care about.
  const isOpen = (key: string) => openDays[key] ?? false;
  const toggleDay = (key: string) =>
    setOpenDays((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));

  const gridCols = "sm:grid-cols-[92px_96px_48px_minmax(0,1fr)_auto]";

  return (
    <div className="mx-auto flex max-w-[760px] animate-fade-up flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">All orders</h1>
          <p className="text-sm text-muted-foreground">
            Master list of food orders across properties and kitchens
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canExport && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9" disabled={isLoading || orders.length === 0}>
                  <Download className="mr-1.5 h-4 w-4" /> Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={exportCsv}>
                  <FileText className="mr-2 h-4 w-4" /> Download CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={exportPdf}>
                  <FileDown className="mr-2 h-4 w-4" /> Download PDF
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            className="h-9 rounded-[12px] bg-accent font-bold text-white hover:bg-accent/90"
            onClick={() => setLocation("/food/dashboard")}
          >
            <Plus className="mr-2 h-4 w-4" /> Place Order
          </Button>
        </div>
      </div>

      <PropertyScopeBanner propertyName={scopedPropertyName} onClear={clearScope} />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] max-w-[240px] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search order number..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-9 pl-9 text-[13px]"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-9 w-[124px] text-[13px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Statuses</SelectItem>
            {ORDER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{ORDER_STATUS_PILL[s].label.replace(/\s*✓$/, "")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="h-9 w-[144px] text-[13px]"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Properties</SelectItem>
            {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="h-9 w-[112px] text-[13px]"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Brands</SelectItem>
            {BRANDS.map((b) => (<SelectItem key={b} value={b}>{b}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={mealType} onValueChange={setMealType}>
          <SelectTrigger className="h-9 w-[118px] text-[13px]"><SelectValue placeholder="Meal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Meals</SelectItem>
            {MEAL_TYPES.map((m) => (<SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <Label className="whitespace-nowrap text-[11px] text-muted-foreground">From</Label>
          <DatePicker value={from} max={to} onChange={setFrom} className="h-9 w-[128px] text-[13px]" />
          <Label className="whitespace-nowrap text-[11px] text-muted-foreground">To</Label>
          <DatePicker value={to} min={from} onChange={setTo} className="h-9 w-[128px] text-[13px]" />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-9" onClick={resetFilters}>Clear</Button>
        )}
      </div>

      {/* Day-grouped orders */}
      {isLoading ? (
        <div className="overflow-hidden rounded-[14px] border border-border bg-card">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border px-[18px] py-4 last:border-b-0">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="ml-auto h-6 w-20 rounded-full" />
            </div>
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[14px] border border-border bg-card px-6 py-14 text-center">
          <PackageX className="h-8 w-8 text-muted-foreground" />
          <p className="font-display text-[15px] font-bold tracking-[-0.012em]">No orders found</p>
          <p className="text-[13px] text-muted-foreground">
            {hasFilters ? "Try adjusting or clearing the filters." : "Orders will appear here once they're placed."}
          </p>
          {hasFilters && (
            <Button variant="outline" size="sm" className="mt-2" onClick={resetFilters}>Clear filters</Button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-border bg-card">
          {dayGroups.map((day) => {
            const open = isOpen(day.serviceDate);
            return (
              <div key={day.serviceDate} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggleDay(day.serviceDate)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 px-[18px] py-3.5 text-left transition-colors hover:bg-muted/60"
                >
                  <ChevronRight
                    className={cn(
                      "h-4 w-4 flex-none text-muted-foreground transition-transform duration-200",
                      open && "rotate-90",
                    )}
                  />
                  <span className="flex flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-display text-[15px] font-bold tracking-[-0.012em]">{day.label}</span>
                    {day.dateStr && (
                      <span className="font-mono text-xs text-muted-foreground">{day.dateStr}</span>
                    )}
                    {day.batchNumber && (
                      <span
                        className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                        title="Group order ID — every meal placed together shares it"
                      >
                        {groupLabel(day.batchNumber)}
                      </span>
                    )}
                  </span>
                  <span className="flex-none rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground tabular-nums">
                    {day.orders.length} {day.orders.length === 1 ? "order" : "orders"}
                  </span>
                </button>

                {open && (
                  <div className="border-t border-border bg-background">
                    <div
                      className={cn(
                        "hidden gap-x-2.5 border-b border-border px-[18px] py-2 text-[10.5px] font-bold uppercase tracking-[0.08em] text-muted-foreground sm:grid",
                        gridCols,
                      )}
                    >
                      <span>Meal</span>
                      <span>Order</span>
                      <span className="text-right">People</span>
                      <span>Note</span>
                      <span className="text-right">Status</span>
                    </div>
                    {day.orders.map((o) => {
                      const pill = orderStatusPill(o.status);
                      const propertyLabel = showProperty
                        ? (o.propertyName ?? properties.find((p) => p.id === o.propertyId)?.name ?? null)
                        : null;
                      return (
                        <div
                          key={o.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setLocation(`/food/orders/${o.id}`)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setLocation(`/food/orders/${o.id}`);
                            }
                          }}
                          className={cn(
                            "flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-[18px] py-2.5 transition-colors last:border-b-0 hover:bg-muted/60 sm:grid",
                            gridCols,
                          )}
                        >
                          <span className="text-[13.5px] font-semibold">
                            {MEAL_LABEL[o.mealType] ?? o.mealType}
                          </span>
                          <span className="flex flex-col leading-tight">
                            <span className="font-mono text-xs text-accent-strong">{o.orderNumber}</span>
                            {/* Only per-row when the day spans MULTIPLE batches;
                                a single-batch day shows it once in the header. */}
                            {!day.batchNumber && o.batchNumber && (
                              <span className="font-mono text-[10px] text-muted-foreground" title="Group order ID">
                                {groupLabel(o.batchNumber)}
                              </span>
                            )}
                          </span>
                          <span className="font-mono text-[12.5px] tabular-nums sm:text-right">
                            {orderPeople(o)}
                          </span>
                          <span className="order-last w-full truncate text-[12.5px] text-muted-foreground sm:order-none sm:w-auto">
                            {orderNote(o, propertyLabel)}
                          </span>
                          <span className="ml-auto flex flex-none items-center justify-end gap-1.5 sm:ml-0">
                            <span
                              className={cn(
                                "rounded-full px-[9px] py-[3px] text-[11px] font-bold whitespace-nowrap",
                                pill.cls,
                              )}
                            >
                              {pill.label}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs font-semibold text-accent-strong hover:text-accent-strong"
                              onClick={(e) => {
                                e.stopPropagation();
                                setLocation(`/food/track?order=${encodeURIComponent(o.orderNumber)}`);
                              }}
                            >
                              Track
                            </Button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
