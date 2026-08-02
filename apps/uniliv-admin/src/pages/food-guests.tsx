import * as React from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Search, Download, UsersRound, ChevronLeft, ChevronRight,
  FileDown, FileText, FileSpreadsheet,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
import { isSuperAdminRole } from "@/lib/permissions";
import { apiDownload } from "@/lib/api-fetch";
import { foodApi, foodKeys, type GuestRow } from "@/lib/food-api";

const PAGE_SIZE = 20;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** "since Mar 2025" line under the guest name. */
function fmtSince(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return format(d, "MMM yyyy");
}

export default function FoodGuests() {
  // A ?propertyId= deep-link (e.g. from a My Properties card) SEEDS the global
  // scope once and is then stripped from the URL. If the param stayed, it would
  // permanently override the
  // on-page Select (which writes the global store), making "All Properties"
  // unreachable.
  const paramProperty = useQueryParam("propertyId");
  const { propertyId: globalProperty, setPropertyId } = useAppStore();
  const { me, role } = usePermissions();
  const canExport = isSuperAdminRole(role);
  const isSingleProperty = Boolean(me?.propertyId);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  React.useEffect(() => {
    if (paramProperty) {
      setPropertyId(paramProperty);
      setLocation("/food/guests", { replace: true });
    }
  }, [paramProperty, setPropertyId, setLocation]);
  const propertyId = paramProperty ?? globalProperty ?? null;

  // Accessible properties for the on-screen scope selector. Switching writes
  // the GLOBAL property scope (same store the sidebar uses) so it stays
  // consistent app-wide.
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

  // Overview only makes sense for ONE property — unscoped, the server would
  // return an arbitrary property's numbers above an all-properties list.
  const overviewParams = { propertyId: propertyId ?? undefined };
  const { data: overview } = useQuery({
    queryKey: foodKeys.propertyOverview(overviewParams),
    queryFn: () => foodApi.propertyOverview(overviewParams),
    enabled: !!propertyId,
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
      toast({ title: "Export ready", description: `${exportFilename(kind)} downloaded.`, variant: "success" });
    } catch (e: any) {
      toast({ title: e?.message || "Export failed", variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }

  const occupancyPct = overview
    ? Math.max(0, Math.min(100, Math.round(overview.occupancyPct)))
    : 0;
  const scopeName = overview?.name
    ?? properties.find((p) => p.id === propertyId)?.name
    ?? "your properties";

  return (
    <div className="mx-auto flex w-full max-w-[760px] animate-fade-up flex-col gap-6">
      {/* Title + Download */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <h1 className="mb-1 font-display text-2xl font-bold tracking-[-0.012em]">
            Active guests
          </h1>
          <p className="text-sm text-muted-foreground">
            Everyone currently staying at {scopeName}.
            {meta?.total != null && (
              <>
                {" "}
                <strong className="font-mono font-semibold tabular-nums text-foreground">
                  {meta.total.toLocaleString("en-IN")}
                </strong>{" "}
                {meta.total === 1 ? "person" : "people"} — this drives your meal counts.
              </>
            )}
          </p>
        </div>
        {canExport && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={exporting !== null} className="rounded-[10px]">
                <Download className="mr-2 h-4 w-4" />
                {exporting ? "Exporting…" : "Download CSV"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Download list</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleExport("csv")}>
                <FileDown className="mr-2 h-4 w-4 text-muted-foreground" />
                CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("xls")}>
                <FileSpreadsheet className="mr-2 h-4 w-4 text-success" />
                Excel (.xls)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("pdf")}>
                <FileText className="mr-2 h-4 w-4 text-destructive" />
                PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Property scope (multi-property users) + search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {!isSingleProperty && (
          <Select
            value={propertyId ?? ALL}
            onValueChange={(v) => {
              setPropertyId(v === ALL ? null : v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full rounded-[10px] sm:w-56">
              <SelectValue placeholder="Property" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Properties</SelectItem>
              {properties.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="relative w-full flex-1">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name, room or mobile…"
            aria-label="Search guests"
            className="h-11 rounded-[10px] pl-10"
          />
        </div>
      </div>

      {/* Property overview — compact stat strip */}
      {overview && (
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-[14px] border border-border bg-border">
          <div className="bg-card px-4 py-3.5">
            <div className="font-mono text-xl font-semibold tabular-nums">
              {overview.activeGuests.toLocaleString("en-IN")}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">active guests</div>
          </div>
          <div className="bg-card px-4 py-3.5">
            <div className="font-mono text-xl font-semibold tabular-nums text-success">
              {occupancyPct}%
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              occupancy · {overview.occupied}/{overview.totalBeds}
            </div>
          </div>
          <div className="bg-card px-4 py-3.5">
            <div className="font-mono text-xl font-semibold tabular-nums">
              {overview.totalBeds.toLocaleString("en-IN")}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">total beds</div>
          </div>
        </div>
      )}

      {/* Guest list */}
      <div className="overflow-hidden rounded-[14px] border border-border bg-card">
        {isLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div
              key={`sk-${i}`}
              className="flex items-center gap-3.5 border-b border-border px-4 py-3 last:border-b-0 sm:px-[18px]"
            >
              <Skeleton className="h-[38px] w-[38px] shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-3.5 w-24" />
            </div>
          ))
        ) : guests.length === 0 ? (
          <EmptyState
            icon={UsersRound}
            title="No guests found"
            description={
              search
                ? "No active guests match your search. Try a different name, mobile or room."
                : "There are no active guests at this property right now."
            }
            className="rounded-none border-0"
          />
        ) : (
          guests.map((g) => {
            const since = fmtSince(g.checkInDate);
            const subline = [
              g.roomNumber ? `Room ${g.roomNumber}` : null,
              since ? `since ${since}` : null,
              !isSingleProperty && g.propertyName ? g.propertyName : null,
            ].filter(Boolean).join(" · ");
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => setLocation(`/residents/${g.id}`)}
                className="flex w-full items-center gap-3.5 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50 sm:px-[18px]"
              >
                <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-muted font-display text-[13px] font-bold text-muted-foreground">
                  {initials(g.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {g.name}
                  </span>
                  <span className="mt-px block truncate text-xs text-muted-foreground">
                    {subline || "—"}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {g.phone || "—"}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {!isLoading && guests.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {meta?.total != null && (
              <>
                <span className="font-mono tabular-nums">{meta.total.toLocaleString("en-IN")}</span>{" "}
                active guest{meta.total === 1 ? "" : "s"}
              </>
            )}
          </p>
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm tabular-nums text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="rounded-[9px]"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded-[9px]"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Next
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
