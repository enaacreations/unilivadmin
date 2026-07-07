import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Plus, Search, Pencil,
} from "lucide-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { PropertyScopeBanner } from "@/components/property-scope-banner";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  foodApi, foodKeys, MEAL_TYPES, BRANDS, ORDER_STATUSES, MEAL_LABEL, fmtQty,
  type FoodOrder,
} from "@/lib/food-api";
import { useQueryParam } from "@/lib/nav-helpers";
import { useScopedColumns } from "@/lib/use-scoped-columns";

const ALL = "ALL";

export default function FoodOrders() {
  const [, setLocation] = useLocation();
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
  const propName = (id?: string | null) =>
    id ? (properties.find((p) => p.id === id)?.name ?? "—") : "—";

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

  const cols = [
    {
      accessorKey: "orderNumber",
      header: "Order ID",
      cell: ({ row }: any) => (
        <span className="font-mono text-xs text-primary font-medium">{row.original.orderNumber}</span>
      ),
    },
    {
      accessorKey: "propertyId",
      header: "Property",
      cell: ({ row }: any) => <span className="font-medium">{propName(row.original.propertyId)}</span>,
    },
    {
      accessorKey: "unitLeadName",
      header: "Unit Lead",
      cell: ({ row }: any) => row.original.unitLeadName || <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: "mealType",
      header: "Meal",
      cell: ({ row }: any) => MEAL_LABEL[row.original.mealType as keyof typeof MEAL_LABEL] ?? row.original.mealType,
    },
    {
      accessorKey: "residentsCount",
      header: "Residents",
      cell: ({ row }: any) => <span className="tabular-nums">{row.original.residentsCount}</span>,
    },
    {
      accessorKey: "totalQuantity",
      header: "Quantity",
      cell: ({ row }: any) => <span className="tabular-nums">{fmtQty(row.original.totalQuantity)}</span>,
    },
    {
      accessorKey: "createdAt",
      header: "Placed at Date",
      cell: ({ row }: any) =>
        row.original.createdAt ? format(new Date(row.original.createdAt), "dd MMM yyyy") : "—",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }: any) => {
        // Edit lives on the detail page; only offer it while the order is still
        // editable (PLACED / PREPARING), mirroring the backend's PUT gating.
        const editable =
          row.original.status === "PLACED" || row.original.status === "PREPARING";
        if (!editable) return null;
        return (
          <Button
            size="icon"
            variant="ghost"
            title="Edit order"
            onClick={(e) => {
              e.stopPropagation();
              setLocation(`/food/orders/${row.original.id}`);
            }}
          >
            <Pencil className="w-4 h-4" />
          </Button>
        );
      },
    },
  ];

  // Property-scoped viewers only ever see their own property; unit leads only
  // ever see their own orders — drop the constant columns for them.
  const scopedColumns = useScopedColumns(cols as any, {
    singleProperty: ["propertyId"],
    roles: { UNIT_LEAD: ["unitLeadName"] },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="All Orders"
        subtitle="Master list of food orders across properties and kitchens"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setLocation("/food/place-order")}>
            <Plus className="w-4 h-4 mr-2" /> Place Order
          </Button>
        }
      />

      <PropertyScopeBanner propertyName={scopedPropertyName} onClear={clearScope} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search order number..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Statuses</SelectItem>
            {ORDER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Properties</SelectItem>
            {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Brands</SelectItem>
            {BRANDS.map((b) => (<SelectItem key={b} value={b}>{b}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={mealType} onValueChange={setMealType}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Meal" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Meals</SelectItem>
            {MEAL_TYPES.map((m) => (<SelectItem key={m} value={m}>{MEAL_LABEL[m]}</SelectItem>))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">From</Label>
          <DatePicker value={from} max={to} onChange={setFrom} className="w-[150px]" />
          <Label className="text-xs text-muted-foreground whitespace-nowrap">To</Label>
          <DatePicker value={to} min={from} onChange={setTo} className="w-[150px]" />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>Clear</Button>
        )}
      </div>

      <DataTable
        columns={scopedColumns as any}
        data={orders}
        isLoading={isLoading}
        onRowClick={(row: any) => setLocation(`/food/orders/${row.id}`)}
        exportFilename="food-orders"
        exportTitle="Food Orders"
        exportFormats="csv+pdf"
        exportPropertyName={scopedPropertyName}
      />
    </div>
  );
}
