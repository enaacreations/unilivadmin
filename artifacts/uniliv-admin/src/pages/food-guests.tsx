import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Search, Download, Users, Building2, IndianRupee,
  UsersRound, ChevronLeft, ChevronRight, FileDown, FileText, FileSpreadsheet, MapPin,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAppStore } from "@/lib/store";
import { useQueryParam } from "@/lib/nav-helpers";
import { usePermissions } from "@/lib/use-permissions";
import { apiDownload } from "@/lib/api-fetch";
import { foodApi, foodKeys, type GuestRow } from "@/lib/food-api";

const PAGE_SIZE = 20;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return format(d, "dd MMM yyyy");
}

export default function FoodGuests() {
  // Scope to ?propertyId= when present (e.g. opened from a property card),
  // otherwise the global property scope from the sidebar.
  const paramProperty = useQueryParam("propertyId");
  const { propertyId: globalProperty, setPropertyId } = useAppStore();
  const propertyId = paramProperty ?? globalProperty ?? null;
  const { me } = usePermissions();
  const isSingleProperty = Boolean(me?.propertyId);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Accessible properties for the on-screen scope selector. Switching writes the
  // GLOBAL property scope (same store the sidebar uses) so it stays consistent
  // app-wide; an explicit ?propertyId= deep-link still takes precedence above.
  const { data: lookups } = useQuery({
    queryKey: foodKeys.lookups(),
    queryFn: () => foodApi.lookups(),
  });
  const properties = lookups?.properties ?? [];
  const ALL = "__all__";

  const [searchInput, setSearchInput] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);

  // Debounce search (~300ms) and reset to first page on change.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const overviewParams = { propertyId: propertyId ?? undefined };
  const { data: overview } = useQuery({
    queryKey: foodKeys.propertyOverview(overviewParams),
    queryFn: () => foodApi.propertyOverview(overviewParams),
  });

  const guestParams = {
    propertyId: propertyId ?? undefined,
    search: search || undefined,
    page,
    limit: PAGE_SIZE,
  };
  const { data: guestsRes, isLoading } = useQuery({
    queryKey: foodKeys.guests(guestParams),
    queryFn: () => foodApi.guests(guestParams),
  });

  const guests: GuestRow[] = guestsRes?.data ?? [];
  const meta = guestsRes?.meta;
  const totalPages = Math.max(1, meta?.totalPages ?? 1);

  const [exporting, setExporting] = React.useState<"csv" | "pdf" | "xls" | null>(null);

  // Property name embedded in the export filename (and document header server-side).
  const exportFilename = (ext: string) => {
    const name = overview?.name;
    const prop = name
      ? `-${name.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-")}`
      : "";
    return `active-guests${prop}-${format(new Date(), "yyyy-MM-dd")}.${ext}`;
  };

  async function handleExport(kind: "csv" | "pdf" | "xls") {
    const exportParams = { propertyId: propertyId ?? undefined, search: search || undefined };
    setExporting(kind);
    try {
      if (kind === "csv") {
        await apiDownload(foodApi.guestsExportCsvUrl(exportParams), exportFilename("csv"));
      } else if (kind === "xls") {
        await apiDownload(foodApi.guestsExportXlsUrl(exportParams), exportFilename("xls"));
      } else {
        await apiDownload(foodApi.guestsExportPdfUrl(exportParams), exportFilename("pdf"));
      }
      toast({ title: "Export ready", description: `${exportFilename(kind)} downloaded.` });
    } catch (e: any) {
      toast({ title: e?.message || "Export failed", variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }

  const exportAction = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={exporting !== null}>
          <Download className="h-4 w-4 mr-2" />
          {exporting ? "Exporting…" : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Download list</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => handleExport("csv")}>
          <FileDown className="h-4 w-4 mr-2 text-muted-foreground" />
          CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport("xls")}>
          <FileSpreadsheet className="h-4 w-4 mr-2 text-success" />
          Excel (.xls)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport("pdf")}>
          <FileText className="h-4 w-4 mr-2 text-destructive" />
          PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const occupancyPct = overview
    ? Math.max(0, Math.min(100, Math.round(overview.occupancyPct)))
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Active Guests"
        subtitle="Residents currently staying at your property"
        action={exportAction}
      />

      {/* Property overview band */}
      {overview && (
        <Card>
          <CardHeader className="pb-4">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
              <div>
                <CardTitle className="font-display text-xl text-primary">
                  {overview.name}
                </CardTitle>
                <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
                  <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    {[overview.address, overview.city, overview.state]
                      .filter(Boolean)
                      .join(", ")}
                    {overview.pincode && (
                      <>
                        {" "}
                        <span className="font-semibold text-foreground">
                          {overview.pincode}
                        </span>
                      </>
                    )}
                  </span>
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <StatCard
                title="Active Guests"
                value={overview.activeGuests.toLocaleString("en-IN")}
                icon={Users}
              />
              <Card className="overflow-hidden">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Occupancy
                  </CardTitle>
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <Building2 className="h-4 w-4 text-primary" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-display font-bold">
                    {overview.occupied}
                    <span className="text-muted-foreground font-normal text-lg">
                      /{overview.totalBeds}
                    </span>
                  </div>
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-accent transition-all"
                      style={{ width: `${occupancyPct}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {occupancyPct}% occupied
                  </p>
                </CardContent>
              </Card>
              <StatCard
                title="Monthly Revenue"
                value={`₹${overview.monthlyRevenue.toLocaleString("en-IN")}`}
                icon={IndianRupee}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Property scope + search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select
          value={propertyId ?? ALL}
          onValueChange={(v) => {
            setPropertyId(v === ALL ? null : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-64">
            <SelectValue placeholder="Property" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Properties</SelectItem>
            {properties.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative w-full sm:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name, mobile, room, PAN or Aadhaar…"
            className="pl-9"
          />
        </div>
      </div>

      {/* Guests table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Guest</TableHead>
                <TableHead>Mobile</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>Gender</TableHead>
                <TableHead>Guest Since</TableHead>
                {!isSingleProperty && <TableHead>Property</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Skeleton className="h-9 w-9 rounded-full" />
                        <div className="space-y-1.5">
                          <Skeleton className="h-3.5 w-32" />
                          <Skeleton className="h-3 w-20" />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    {!isSingleProperty && (
                      <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                    )}
                  </TableRow>
                ))
              ) : guests.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isSingleProperty ? 5 : 6} className="p-0">
                    <EmptyState
                      icon={UsersRound}
                      title="No guests found"
                      description={
                        search
                          ? "No active guests match your search. Try a different name, mobile or room."
                          : "There are no active guests at this property right now."
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                guests.map((g) => (
                  <TableRow
                    key={g.id}
                    className="cursor-pointer"
                    onClick={() => setLocation(`/residents/${g.id}`)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                          {initials(g.name)}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-foreground truncate">
                            {g.name}
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {shortId(g.id)}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {g.phone || "—"}
                    </TableCell>
                    <TableCell>
                      {g.roomNumber ? (
                        <Badge variant="secondary" className="font-mono">
                          {g.roomNumber}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {g.gender ? (
                        <span className="capitalize">{g.gender.toLowerCase()}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {fmtDate(g.checkInDate)}
                    </TableCell>
                    {!isSingleProperty && (
                      <TableCell className="text-muted-foreground">
                        {g.propertyName || "—"}
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      {!isLoading && guests.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {meta?.total != null && (
              <>
                {meta.total.toLocaleString("en-IN")} active guest
                {meta.total === 1 ? "" : "s"}
              </>
            )}
          </p>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
