import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  AlertCircle, ChevronLeft, ChevronRight, Download, FileBarChart,
  FileSpreadsheet, FileText, Loader2, PackageX, RefreshCw, RotateCcw,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { DatePicker } from "@/components/ui/date-picker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, apiDownload } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import {
  NAMED_REPORTS, REPORT_STATUS_BADGE, fmtDateTime, titleCase,
  type ApiList, type ApiOne, type ApiPage, type AuditType,
  type NamedReportResult, type ReportRow,
} from "./lib";
import { TypeBadge } from "./shared";

const ALL = "__all__";
const PAGE_SIZE = 20;

function fmtSize(bytes: number | null): string {
  if (bytes == null) return "—";
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/* ── Registry tab (FRD-RPT-02) ───────────────────────────────────────────── */

function RegistryTab() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const [page, setPage] = React.useState(0);

  const listQuery = useQuery({
    queryKey: ["/audit/reports", page],
    queryFn: () => apiFetch<ApiPage<ReportRow>>(`/audit/reports?page=${page + 1}&limit=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  });

  const regenMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/audit/reports/${id}/generate`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      toast({ title: "Report regeneration queued" });
      qc.invalidateQueries({ queryKey: ["/audit/reports"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Regenerate failed", variant: "destructive" }),
  });

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.meta.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isAdmin = can("AUDIT_REPORTS", "edit");

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-card">
        <div className="w-full overflow-auto overscroll-contain" style={{ maxHeight: "62vh" }}>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card [&_tr]:border-b [&_tr]:border-border">
              <TableRow>
                <TableHead className="whitespace-nowrap">Report No</TableHead>
                <TableHead>Rev</TableHead>
                <TableHead className="whitespace-nowrap">Ticket</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Property</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="whitespace-nowrap">Generated</TableHead>
                <TableHead className="text-right">Size</TableHead>
                {isAdmin && <TableHead className="w-28" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {listQuery.isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: isAdmin ? 10 : 9 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-6 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : listQuery.isError ? (
                <TableRow>
                  <TableCell colSpan={10} className="h-32 text-center">
                    <div className="flex flex-col items-center justify-center gap-3 py-6 text-muted-foreground">
                      <AlertCircle className="h-8 w-8 text-destructive" />
                      <p className="text-sm">
                        {(listQuery.error as Error)?.message || "Failed to load reports."}
                      </p>
                      <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
                        <RotateCcw className="mr-2 h-3.5 w-3.5" /> Retry
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="h-32 text-center">
                    <div className="flex flex-col items-center justify-center gap-2 py-6 text-muted-foreground">
                      <PackageX className="h-8 w-8" />
                      <p className="text-sm">No reports yet — they generate as audits complete.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/audits/reports/${r.id}`)}
                  >
                    <TableCell className="whitespace-nowrap font-mono text-xs">{r.reportNo}</TableCell>
                    <TableCell className="tabular-nums">{r.revision}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{r.ticketNo}</TableCell>
                    <TableCell>
                      <span className="block max-w-[220px] truncate text-sm font-medium">{r.title}</span>
                    </TableCell>
                    <TableCell><TypeBadge type={r.auditType as AuditType} /></TableCell>
                    <TableCell>
                      <span className="block max-w-[160px] truncate text-sm">{r.propertyName ?? "—"}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={REPORT_STATUS_BADGE[r.status] ?? "outline"} title={r.error ?? undefined}>
                        {titleCase(r.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {fmtDateTime(r.generatedAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">
                      {fmtSize(r.sizeBytes)}
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        {r.status === "FAILED" && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={regenMut.isPending}
                            onClick={(e) => { e.stopPropagation(); regenMut.mutate(r.id); }}
                          >
                            <RefreshCw className="mr-1 h-3.5 w-3.5" /> Regenerate
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <span className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{total}</span> reports
        </span>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Page {page + 1} of {pageCount}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || listQuery.isFetching}
          >
            <ChevronLeft className="mr-1 h-4 w-4" /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={page + 1 >= pageCount || listQuery.isFetching}
          >
            Next <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Named reports tab (FRD-RPT-04) ──────────────────────────────────────── */

function NamedReportsTab() {
  const { toast } = useToast();
  const [reportKey, setReportKey] = React.useState(NAMED_REPORTS[0]!.key);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [auditType, setAuditType] = React.useState<string>(ALL);
  const [propertyId, setPropertyId] = React.useState<string>(ALL);
  const [downloading, setDownloading] = React.useState<string | null>(null);

  const typesQuery = useQuery({
    queryKey: ["/audits/visible-types"],
    queryFn: () => apiFetch<ApiOne<AuditType[]>>("/audits/visible-types"),
    staleTime: 5 * 60_000,
  });
  const propertiesQuery = useQuery({
    queryKey: ["/properties", "report-picker"],
    queryFn: () => apiFetch<ApiList<{ id: string; name: string }>>("/properties?limit=100"),
    staleTime: 5 * 60_000,
  });

  const filterQs = React.useMemo(() => {
    const sp = new URLSearchParams();
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    if (auditType !== ALL) sp.set("auditType", auditType);
    if (propertyId !== ALL) sp.set("propertyId", propertyId);
    return sp.toString();
  }, [from, to, auditType, propertyId]);

  const previewQuery = useQuery({
    queryKey: ["/audit/reports/named", reportKey, filterQs],
    queryFn: () =>
      apiFetch<ApiOne<NamedReportResult>>(
        `/audit/reports/named/${reportKey}${filterQs ? `?${filterQs}` : ""}`,
      ),
    placeholderData: keepPreviousData,
  });
  const result = previewQuery.data?.data;

  const download = async (format: "csv" | "xlsx" | "pdf") => {
    const ext = format === "xlsx" ? "xls" : format;
    setDownloading(format);
    try {
      await apiDownload(
        `/api/audit/reports/named/${reportKey}?${filterQs ? `${filterQs}&` : ""}format=${format}`,
        `${reportKey}.${ext}`,
      );
    } catch (e) {
      toast({ title: (e as Error).message || "Download failed", variant: "destructive" });
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Report picker cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {NAMED_REPORTS.map((r) => {
          const active = r.key === reportKey;
          return (
            <button
              key={r.key}
              type="button"
              onClick={() => setReportKey(r.key)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                active ? "border-primary bg-primary/5 ring-1 ring-primary" : "bg-card hover:border-primary/50"
              }`}
            >
              <p className="text-sm font-semibold">{r.title}</p>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{r.description}</p>
            </button>
          );
        })}
      </div>

      {/* Filters + downloads */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">From</Label>
          <DatePicker value={from} max={to || undefined} onChange={setFrom} clearable className="w-[150px]" />
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">To</Label>
          <DatePicker value={to} min={from || undefined} onChange={setTo} clearable className="w-[150px]" />
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Type</Label>
          <Select value={auditType} onValueChange={setAuditType}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All types</SelectItem>
              {(typesQuery.data?.data ?? []).map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Property</Label>
          <Select value={propertyId} onValueChange={setPropertyId}>
            <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All properties</SelectItem>
              {(propertiesQuery.data?.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="flex-1" />
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={downloading != null}
            onClick={() => void download("csv")}
          >
            {downloading === "csv" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={downloading != null}
            onClick={() => void download("xlsx")}
          >
            {downloading === "xlsx" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
            Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={downloading != null}
            onClick={() => void download("pdf")}
          >
            {downloading === "pdf" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
            PDF
          </Button>
        </div>
      </div>

      {/* JSON preview */}
      {previewQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : previewQuery.isError ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm">{(previewQuery.error as Error)?.message || "Failed to run the report."}</p>
          <Button variant="outline" size="sm" onClick={() => previewQuery.refetch()}>
            <RotateCcw className="mr-2 h-3.5 w-3.5" /> Retry
          </Button>
        </div>
      ) : result ? (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <p className="font-medium">{result.title}</p>
              <span className="text-sm text-muted-foreground">
                {result.rows.length.toLocaleString("en-IN")} rows
                {previewQuery.isFetching && <span className="ml-2 text-xs opacity-70">updating…</span>}
              </span>
            </div>
            {result.rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
                <FileBarChart className="h-8 w-8" />
                <p className="text-sm">No rows for these filters — the export would carry headers only.</p>
              </div>
            ) : (
              <div className="w-full overflow-auto overscroll-contain" style={{ maxHeight: "56vh" }}>
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-card [&_tr]:border-b [&_tr]:border-border">
                    <TableRow>
                      {result.headers.map((h) => (
                        <TableHead key={h} className="whitespace-nowrap">{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rows.map((row, i) => (
                      <TableRow key={i}>
                        {row.map((cell, j) => (
                          <TableCell key={j} className="whitespace-nowrap text-sm">
                            {cell === "" ? <span className="text-muted-foreground">—</span> : String(cell)}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────────── */

/** Also embedded as the "Reports" tab of the Audit Dashboard hub (`embedded`
 *  drops the page header). */
export function ReportsPanel({ embedded = false }: { embedded?: boolean }) {
  return (
    <div className={embedded ? "space-y-4" : "space-y-6"}>
      {!embedded && (
        <PageHeader
          title="Reports"
          subtitle="Per-audit PDF registry plus the five named operational reports."
          breadcrumbs={[{ label: "Audits" }, { label: "Reports" }]}
        />
      )}
      <Tabs defaultValue="registry">
        <TabsList>
          <TabsTrigger value="registry">Registry</TabsTrigger>
          <TabsTrigger value="named">Named Reports</TabsTrigger>
        </TabsList>
        <TabsContent value="registry" className="mt-4">
          <RegistryTab />
        </TabsContent>
        <TabsContent value="named" className="mt-4">
          <NamedReportsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function AuditReports() {
  return <ReportsPanel />;
}
