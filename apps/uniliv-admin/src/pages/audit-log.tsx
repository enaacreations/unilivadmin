import * as React from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  Search, ScrollText, ChevronLeft, ChevronRight, Download, RotateCcw,
  ChevronDown, PackageX, AlertCircle,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api-fetch";

/* ── Types (backend contract) ────────────────────────────────────────────── */

interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  changes: unknown | null;
  createdAt: string;
  userId: string | null;
  userName: string | null;
}

interface AuditResponse {
  success: true;
  data: AuditEntry[];
  meta: { total: number; limit: number; offset: number };
}

interface FacetsResponse {
  success: true;
  data: { actions: string[]; entities: string[] };
}

/* ── Constants & helpers ─────────────────────────────────────────────────── */

const ALL = "__all__";
const PAGE_SIZE = 50;

/** Soft-coloured badge variant for an action, keyed on its verb. */
function actionVariant(action: string): React.ComponentProps<typeof Badge>["variant"] {
  const a = action.toUpperCase();
  if (/DELET|REMOV|REVOK|DISABLE/.test(a)) return "destructive";
  if (/CREAT|ADD|GRANT|ENABLE/.test(a)) return "success";
  if (/UPDAT|CHANG|EDIT|MODIF/.test(a)) return "warning";
  if (/LOGIN|VIEW|EXPORT|ACCESS/.test(a)) return "info";
  return "default";
}

/** IST timestamp — Asia/Kolkata, "dd MMM yyyy, HH:mm:ss". */
function fmtIST(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

function shortId(id: string | null): string {
  if (!id) return "—";
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function changesToString(changes: unknown): string {
  if (changes === null || changes === undefined) return "";
  if (typeof changes === "string") return changes;
  try {
    return JSON.stringify(changes, null, 2);
  } catch {
    return String(changes);
  }
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

const csvEscape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/* ── Changes popover ─────────────────────────────────────────────────────── */

function ChangesCell({ entry }: { entry: AuditEntry }) {
  const text = changesToString(entry.changes);
  if (!text) return <span className="text-muted-foreground">—</span>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
          View <ChevronDown className="h-3 w-3 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[90vw] p-0">
        <div className="border-b px-3 py-2">
          <p className="text-xs font-medium text-foreground">Changes</p>
          <p className="text-[11px] text-muted-foreground">
            {entry.action} · {entry.entity}
          </p>
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {text}
        </pre>
      </PopoverContent>
    </Popover>
  );
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function AuditLog() {
  const [action, setAction] = React.useState<string>(ALL);
  const [entity, setEntity] = React.useState<string>(ALL);
  const [userInput, setUserInput] = React.useState<string>("");
  const [userId, setUserId] = React.useState<string>("");
  const [from, setFrom] = React.useState<string>("");
  const [to, setTo] = React.useState<string>("");
  const [page, setPage] = React.useState<number>(0); // zero-based page index

  // Debounce the user-id search and reset to first page on change.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setUserId(userInput.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [userInput]);

  // Reset to first page whenever a non-search filter changes.
  React.useEffect(() => { setPage(0); }, [action, entity, from, to]);

  // Distinct actions/entities for the filter selects.
  const { data: facets } = useQuery({
    queryKey: ["/settings/audit-log/facets"],
    queryFn: () => apiFetch<FacetsResponse>("/settings/audit-log/facets"),
    staleTime: 5 * 60_000,
  });
  const actions = facets?.data.actions ?? [];
  const entities = facets?.data.entities ?? [];

  const params = React.useMemo(() => {
    const sp = new URLSearchParams();
    if (action !== ALL) sp.set("action", action);
    if (entity !== ALL) sp.set("entity", entity);
    if (userId) sp.set("userId", userId);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    sp.set("limit", String(PAGE_SIZE));
    sp.set("offset", String(page * PAGE_SIZE));
    return sp;
  }, [action, entity, userId, from, to, page]);

  const queryString = params.toString();

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ["/settings/audit-log", queryString],
    queryFn: () => apiFetch<AuditResponse>(`/settings/audit-log?${queryString}`),
    placeholderData: keepPreviousData,
  });

  const rows: AuditEntry[] = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeFrom = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeTo = Math.min(total, (page + 1) * PAGE_SIZE);

  const hasFilters = action !== ALL || entity !== ALL || !!userId || !!from || !!to;
  const resetFilters = () => {
    setAction(ALL); setEntity(ALL); setUserInput(""); setUserId("");
    setFrom(""); setTo(""); setPage(0);
  };

  // Client-side CSV of the current page (the endpoint has no export format).
  const exportCsv = React.useCallback(() => {
    const headers = ["Time (IST)", "User", "User ID", "Action", "Entity", "Entity ID", "Changes"];
    const lines = [
      headers.map(csvEscape).join(","),
      ...rows.map((r) =>
        [
          fmtIST(r.createdAt),
          r.userName ?? "",
          r.userId ?? "",
          r.action,
          r.entity,
          r.entityId ?? "",
          changesToString(r.changes).replace(/\s+/g, " ").trim(),
        ]
          .map(csvEscape)
          .join(","),
      ),
    ];
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(
      new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }),
      `audit-log-${stamp}.csv`,
    );
  }, [rows]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Log"
        subtitle="Compliance trail of every change across the platform"
        action={
          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={isLoading || rows.length === 0}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        }
      />

      {/* Filter row */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-[200px] flex-1 max-w-xs">
          <Label className="mb-1 block text-xs text-muted-foreground">User ID</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter by actor id…"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Action</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Action" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All actions</SelectItem>
              {actions.map((a) => (<SelectItem key={a} value={a}>{a}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Entity</Label>
          <Select value={entity} onValueChange={setEntity}>
            <SelectTrigger className="w-40"><SelectValue placeholder="Entity" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All entities</SelectItem>
              {entities.map((e) => (<SelectItem key={e} value={e}>{e}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">From</Label>
          <DatePicker value={from} max={to || undefined} onChange={setFrom} clearable className="w-[150px]" />
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">To</Label>
          <DatePicker value={to} min={from || undefined} onChange={setTo} clearable className="w-[150px]" />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            <RotateCcw className="mr-2 h-3.5 w-3.5" /> Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border bg-card">
        <div className="w-full overflow-auto overscroll-contain [&>div]:overflow-visible" style={{ maxHeight: "62vh" }}>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card [&_tr]:border-b [&_tr]:border-border">
              <TableRow>
                <TableHead className="whitespace-nowrap">Time (IST)</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Entity ID</TableHead>
                <TableHead className="text-right">Changes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-6 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : isError ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <div className="flex flex-col items-center justify-center gap-3 py-6 text-muted-foreground">
                      <AlertCircle className="h-8 w-8 text-destructive" />
                      <p className="text-sm">
                        {(error as Error)?.message || "Failed to load the audit log."}
                      </p>
                      <Button variant="outline" size="sm" onClick={() => refetch()}>
                        <RotateCcw className="mr-2 h-3.5 w-3.5" /> Retry
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <div className="flex flex-col items-center justify-center gap-2 py-6 text-muted-foreground">
                      <PackageX className="h-8 w-8" />
                      <p className="text-sm">No audit entries match these filters.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {fmtIST(r.createdAt)}
                    </TableCell>
                    <TableCell>
                      {r.userName ? (
                        <span className="font-medium text-foreground">{r.userName}</span>
                      ) : (
                        <span className="text-muted-foreground">{r.userId ? shortId(r.userId) : "System"}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={actionVariant(r.action)}>{r.action}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{r.entity}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground" title={r.entityId ?? undefined}>
                        {shortId(r.entityId)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <ChangesCell entry={r} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ScrollText className="h-4 w-4" />
          {total > 0 ? (
            <span>
              Showing <span className="font-medium text-foreground">{rangeFrom}</span>–
              <span className="font-medium text-foreground">{rangeTo}</span> of{" "}
              <span className="font-medium text-foreground">{total.toLocaleString("en-IN")}</span> entries
            </span>
          ) : (
            <span>No entries</span>
          )}
          {isFetching && !isLoading && <span className="text-xs opacity-70">· updating…</span>}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium">Page {page + 1} of {pageCount}</span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0 || isFetching}
            >
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={page + 1 >= pageCount || isFetching}
            >
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
