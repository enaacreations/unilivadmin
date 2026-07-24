import * as React from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  AlertCircle, ChevronDown, ChevronLeft, ChevronRight, Kanban as KanbanIcon,
  LayoutGrid, List as ListIcon, MoreVertical, PackageX, RotateCcw,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { apiFetch } from "@/lib/api-fetch";
import {
  NC_LEGAL_TRANSITIONS, NC_SEVERITIES, NC_STATES, apiFetchAll, fmtDate, titleCase,
  type ApiPage, type NcRow, type NcSeverity, type NcState,
} from "./lib";
import {
  NcActionDialog, NcStateBadge, ReasonDialog, SeverityBadge, SlaCountdown, useNowTick,
} from "./shared";

const ALL = "__all__";
const PAGE_SIZES = [20, 50, 100];

/** Board columns — VERIFIED and CLOSED share a column (badge shows which). */
const COLUMNS: { key: string; title: string; states: NcState[] }[] = [
  { key: "OPEN", title: "Open", states: ["OPEN"] },
  { key: "IN_PROGRESS", title: "In Progress", states: ["IN_PROGRESS"] },
  { key: "EXTENSION_REQUESTED", title: "Extension Requested", states: ["EXTENSION_REQUESTED"] },
  { key: "RESOLVED", title: "Resolved", states: ["RESOLVED"] },
  { key: "REOPENED", title: "Reopened", states: ["REOPENED"] },
  { key: "CLOSED", title: "Closed", states: ["VERIFIED", "CLOSED"] },
  { key: "WAIVED", title: "Waived", states: ["WAIVED"] },
];

/** What a move to `target` means for this NC. */
type MovePlan =
  | { type: "start" }
  | { type: "resolve" }
  | { type: "verify" }
  | { type: "reject" }
  | { type: "waive" }
  | { type: "use-page" }
  | { type: "illegal" };

function planMove(state: NcState, target: NcState): MovePlan {
  if (!NC_LEGAL_TRANSITIONS[state]?.includes(target)) return { type: "illegal" };
  if (target === "IN_PROGRESS" && (state === "OPEN" || state === "REOPENED")) return { type: "start" };
  if (target === "RESOLVED" && state === "IN_PROGRESS") return { type: "resolve" };
  if (target === "VERIFIED" && state === "RESOLVED") return { type: "verify" };
  if (target === "REOPENED" && state === "RESOLVED") return { type: "reject" };
  if (target === "WAIVED") return { type: "waive" };
  // Legal but endpoint-specific (extensions) — handled on the detail page.
  return { type: "use-page" };
}

/** Actionable "Move to…" targets for the mobile card menu. */
function moveTargets(state: NcState): { target: NcState; label: string }[] {
  const labels: Partial<Record<NcState, string>> = {
    IN_PROGRESS: state === "REOPENED" ? "Start rework" : "Start work",
    RESOLVED: "Resolve…",
    VERIFIED: "Verify & close",
    REOPENED: "Reject resolution…",
    WAIVED: "Waive…",
  };
  return (NC_LEGAL_TRANSITIONS[state] ?? [])
    .filter((t) => planMove(state, t).type !== "use-page")
    .map((t) => ({ target: t, label: labels[t] ?? titleCase(t) }));
}

function NcCard({
  nc, nowMs, draggable, onOpen, onMove,
}: {
  nc: NcRow;
  nowMs: number;
  draggable: boolean;
  onOpen: () => void;
  onMove?: (target: NcState) => void;
}) {
  const targets = onMove ? moveTargets(nc.state) : [];
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", nc.id)}
      onClick={onOpen}
      className="cursor-pointer space-y-1.5 rounded-md border bg-card p-2.5 transition-colors hover:border-primary"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">{nc.ncNo}</span>
        <span className="flex items-center gap-1">
          <SeverityBadge severity={nc.severity} />
          {(nc.state === "VERIFIED" || nc.state === "CLOSED") && <NcStateBadge state={nc.state} />}
          {targets.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Move to…"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                {targets.map((t) => (
                  <DropdownMenuItem key={t.target} onClick={() => onMove!(t.target)}>
                    {t.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-snug">{nc.description}</p>
      <p className="truncate text-xs text-muted-foreground">
        <span className="font-mono">{nc.ticketNo}</span>
        {nc.propertyName && <span> · {nc.propertyName}</span>}
      </p>
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <span className="truncate text-xs text-muted-foreground">{nc.ownerName ?? "—"}</span>
        <SlaCountdown state={nc.state} dueAt={nc.dueAt} slaState={nc.slaState} nowMs={nowMs} />
      </div>
    </div>
  );
}

/** NC Board (FRD-NCM-03) — kanban + register of findings with SLA countdowns.
 *  Also embedded as the "Findings" tab of the All Audits / My Audits hubs
 *  (`embedded` swaps the page header for a slim toolbar). */
export function NcBoardPanel({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const nowMs = useNowTick();

  const [view, setView] = React.useState<"board" | "list">("board");
  const [severity, setSeverity] = React.useState<string>(ALL);
  const [states, setStates] = React.useState<NcState[]>([]);
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  const [mine, setMine] = React.useState(false);
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(20);
  const [mobileTab, setMobileTab] = React.useState<string>("OPEN");

  React.useEffect(() => { setPage(0); }, [severity, states, overdueOnly, mine, pageSize, view]);

  const filterQs = React.useMemo(() => {
    const sp = new URLSearchParams();
    if (severity !== ALL) sp.set("severity", severity);
    if (states.length) sp.set("state", states.join(","));
    if (overdueOnly) sp.set("overdue", "true");
    if (mine) sp.set("mine", "true");
    return sp.toString();
  }, [severity, states, overdueOnly, mine]);

  // Board pulls the whole filtered set; list stays server-paginated.
  const boardQuery = useQuery({
    queryKey: ["/audit/ncs", "board", filterQs],
    queryFn: () => apiFetchAll<NcRow>(`/audit/ncs${filterQs ? `?${filterQs}` : ""}`),
    enabled: view === "board",
  });
  const listQuery = useQuery({
    queryKey: ["/audit/ncs", "list", filterQs, page, pageSize],
    queryFn: () =>
      apiFetch<ApiPage<NcRow>>(
        `/audit/ncs?${filterQs ? `${filterQs}&` : ""}page=${page + 1}&limit=${pageSize}`,
      ),
    enabled: view === "list",
    placeholderData: keepPreviousData,
  });

  const boardRows = React.useMemo(() => boardQuery.data ?? [], [boardQuery.data]);
  const byColumn = React.useMemo(() => {
    const map = new Map<string, NcRow[]>();
    for (const col of COLUMNS) map.set(col.key, []);
    for (const nc of boardRows) {
      const col = COLUMNS.find((c) => c.states.includes(nc.state));
      if (col) map.get(col.key)!.push(nc);
    }
    return map;
  }, [boardRows]);

  /* — Move machinery — */
  const [resolveFor, setResolveFor] = React.useState<NcRow | null>(null);
  const [verifyFor, setVerifyFor] = React.useState<NcRow | null>(null);
  const [rejectFor, setRejectFor] = React.useState<NcRow | null>(null);
  const [waiveFor, setWaiveFor] = React.useState<NcRow | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["/audit/ncs"] });

  const startMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/audit/ncs/${id}/start`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => { toast({ title: "Corrective work started" }); invalidate(); },
    onError: (e: Error) => toast({ title: e.message || "Could not start", variant: "destructive" }),
  });
  const verifyMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/audit/ncs/${id}/verify`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      toast({ title: "Finding verified & closed" });
      setVerifyFor(null);
      invalidate();
    },
    onError: (e: Error) => {
      setVerifyFor(null);
      toast({ title: e.message || "Verify failed", variant: "destructive" });
    },
  });
  const rejectMut = useMutation({
    mutationFn: ({ id, comment }: { id: string; comment: string }) =>
      apiFetch(`/audit/ncs/${id}/reject`, { method: "POST", body: JSON.stringify({ comment }) }),
    onSuccess: () => {
      toast({ title: "Resolution rejected — finding reopened" });
      setRejectFor(null);
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Reject failed", variant: "destructive" }),
  });
  const waiveMut = useMutation({
    mutationFn: ({ id, justification }: { id: string; justification: string }) =>
      apiFetch(`/audit/ncs/${id}/waive`, { method: "POST", body: JSON.stringify({ justification }) }),
    onSuccess: () => {
      toast({ title: "Finding waived" });
      setWaiveFor(null);
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Waive failed", variant: "destructive" }),
  });

  const executeMove = React.useCallback(
    (nc: NcRow, target: NcState) => {
      const plan = planMove(nc.state, target);
      switch (plan.type) {
        case "start": startMut.mutate(nc.id); break;
        case "resolve": setResolveFor(nc); break;
        case "verify": setVerifyFor(nc); break;
        case "reject": setRejectFor(nc); break;
        case "waive": setWaiveFor(nc); break;
        case "use-page":
          toast({ title: "Use the finding's page", description: `${titleCase(nc.state)} → ${titleCase(target)} needs the extension flow on the finding.` });
          break;
        case "illegal":
          toast({
            title: "Move not allowed",
            description: `${titleCase(nc.state)} → ${titleCase(target)} is not a legal transition.`,
            variant: "destructive",
          });
          break;
      }
    },
    [startMut, toast],
  );

  const onDropToColumn = (e: React.DragEvent, colKey: string) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    const nc = boardRows.find((r) => r.id === id);
    if (!nc) return;
    const col = COLUMNS.find((c) => c.key === colKey)!;
    if (col.states.includes(nc.state)) return; // dropped on its own column
    const target: NcState =
      colKey === "CLOSED" ? (nc.state === "RESOLVED" ? "VERIFIED" : "CLOSED") : (colKey as NcState);
    executeMove(nc, target);
  };

  const openNc = (id: string) => navigate(`/audits/ncs/${id}`);

  /* — List paging derived — */
  const listRows = listQuery.data?.data ?? [];
  const total = listQuery.data?.meta.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const boardError = view === "board" && boardQuery.isError;

  const viewToggle = (
    <div className="flex gap-2">
      <Button
        variant={view === "board" ? "default" : "outline"}
        size="sm"
        onClick={() => setView("board")}
      >
        <LayoutGrid className="mr-2 h-4 w-4" /> Board
      </Button>
      <Button
        variant={view === "list" ? "default" : "outline"}
        size="sm"
        onClick={() => setView("list")}
      >
        <ListIcon className="mr-2 h-4 w-4" /> List
      </Button>
    </div>
  );

  return (
    <div className={embedded ? "space-y-4" : "space-y-6"}>
      {embedded ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Findings by state with severity and SLA countdowns — drag to move.</p>
          {viewToggle}
        </div>
      ) : (
        <PageHeader
          title="NC Board"
          subtitle="Findings by state with severity and SLA countdowns — drag to move."
          breadcrumbs={[{ label: "Audits" }, { label: "NC Board" }]}
          action={viewToggle}
        />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Severity</Label>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All severities</SelectItem>
              {NC_SEVERITIES.map((s) => (
                <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">State</Label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-40 justify-between font-normal">
                <span className="truncate">
                  {states.length === 0 ? "All states" : `${states.length} selected`}
                </span>
                <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {NC_STATES.map((s) => (
                <DropdownMenuCheckboxItem
                  key={s}
                  checked={states.includes(s)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) =>
                    setStates((prev) => (checked ? [...prev, s] : prev.filter((x) => x !== s)))
                  }
                >
                  {titleCase(s)}
                </DropdownMenuCheckboxItem>
              ))}
              {states.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setStates([])}>Clear states</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex h-10 items-center gap-2 pb-0.5">
          <Switch id="nc-overdue" checked={overdueOnly} onCheckedChange={setOverdueOnly} />
          <Label htmlFor="nc-overdue" className="cursor-pointer text-sm">Overdue only</Label>
        </div>
        <div className="flex h-10 items-center gap-2 pb-0.5">
          <Switch id="nc-mine" checked={mine} onCheckedChange={setMine} />
          <Label htmlFor="nc-mine" className="cursor-pointer text-sm">Mine</Label>
        </div>
      </div>

      {boardError ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm">{(boardQuery.error as Error)?.message || "Failed to load findings."}</p>
          <Button variant="outline" size="sm" onClick={() => boardQuery.refetch()}>
            <RotateCcw className="mr-2 h-3.5 w-3.5" /> Retry
          </Button>
        </div>
      ) : view === "board" && isMobile ? (
        /* ── Mobile board: state tab strip + card list + Move-to menus ── */
        <div className="space-y-3">
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {COLUMNS.map((col) => {
              const count = byColumn.get(col.key)?.length ?? 0;
              const active = mobileTab === col.key;
              return (
                <button
                  key={col.key}
                  type="button"
                  onClick={() => setMobileTab(col.key)}
                  className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm ${
                    active ? "border-primary bg-primary text-primary-foreground" : "bg-card"
                  }`}
                >
                  {col.title}
                  <span className={`text-xs tabular-nums ${active ? "opacity-80" : "text-muted-foreground"}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          {boardQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
            </div>
          ) : (
            <div className="space-y-2">
              {(byColumn.get(mobileTab) ?? []).map((nc) => (
                <NcCard
                  key={nc.id}
                  nc={nc}
                  nowMs={nowMs}
                  draggable={false}
                  onOpen={() => openNc(nc.id)}
                  onMove={(t) => executeMove(nc, t)}
                />
              ))}
              {(byColumn.get(mobileTab) ?? []).length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No findings in {COLUMNS.find((c) => c.key === mobileTab)?.title}.
                </p>
              )}
            </div>
          )}
        </div>
      ) : view === "board" ? (
        /* ── Desktop board: 7 drag/drop columns ── */
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((col) => {
            const items = byColumn.get(col.key) ?? [];
            return (
              <div
                key={col.key}
                className="w-64 shrink-0 rounded-lg bg-muted/30 p-2"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDropToColumn(e, col.key)}
              >
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-xs font-medium">{col.title}</span>
                  <Badge variant="outline" className="text-xs tabular-nums">{items.length}</Badge>
                </div>
                <div className="space-y-2">
                  {boardQuery.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : (
                    items.map((nc) => (
                      <NcCard
                        key={nc.id}
                        nc={nc}
                        nowMs={nowMs}
                        draggable
                        onOpen={() => openNc(nc.id)}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── List: server-paginated register ── */
        <>
          <div className="rounded-md border bg-card">
            <div className="w-full overflow-auto overscroll-contain" style={{ maxHeight: "62vh" }}>
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card [&_tr]:border-b [&_tr]:border-border">
                  <TableRow>
                    <TableHead className="whitespace-nowrap">NC No</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Ticket</TableHead>
                    <TableHead>Property</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead className="whitespace-nowrap">Due</TableHead>
                    <TableHead className="whitespace-nowrap">Raised</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listQuery.isLoading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 9 }).map((__, j) => (
                          <TableCell key={j}><Skeleton className="h-6 w-full" /></TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : listQuery.isError ? (
                    <TableRow>
                      <TableCell colSpan={9} className="h-32 text-center">
                        <div className="flex flex-col items-center justify-center gap-3 py-6 text-muted-foreground">
                          <AlertCircle className="h-8 w-8 text-destructive" />
                          <p className="text-sm">
                            {(listQuery.error as Error)?.message || "Failed to load findings."}
                          </p>
                          <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
                            <RotateCcw className="mr-2 h-3.5 w-3.5" /> Retry
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : listRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="h-32 text-center">
                        <div className="flex flex-col items-center justify-center gap-2 py-6 text-muted-foreground">
                          <PackageX className="h-8 w-8" />
                          <p className="text-sm">No findings match these filters.</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    listRows.map((nc) => (
                      <TableRow key={nc.id} className="cursor-pointer" onClick={() => openNc(nc.id)}>
                        <TableCell className="whitespace-nowrap font-mono text-xs">{nc.ncNo}</TableCell>
                        <TableCell><SeverityBadge severity={nc.severity} /></TableCell>
                        <TableCell><NcStateBadge state={nc.state} /></TableCell>
                        <TableCell>
                          <span className="block max-w-[280px] truncate text-sm">{nc.description}</span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">{nc.ticketNo}</TableCell>
                        <TableCell>
                          <span className="block max-w-[160px] truncate text-sm">{nc.propertyName ?? "—"}</span>
                        </TableCell>
                        <TableCell>
                          <span className="block max-w-[140px] truncate text-sm">{nc.ownerName ?? "—"}</span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <SlaCountdown state={nc.state} dueAt={nc.dueAt} slaState={nc.slaState} nowMs={nowMs} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          {fmtDate(nc.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Pagination */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <KanbanIcon className="h-4 w-4" />
              {total > 0 ? (
                <span>
                  <span className="font-medium text-foreground">{total.toLocaleString("en-IN")}</span> findings
                </span>
              ) : (
                <span>No findings</span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
                <SelectTrigger className="h-8 w-[110px] text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((n) => (
                    <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm font-medium">Page {page + 1} of {pageCount}</span>
              <div className="flex items-center gap-2">
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
        </>
      )}

      {/* Move dialogs */}
      <NcActionDialog
        ncId={resolveFor?.id ?? ""}
        open={resolveFor != null}
        onOpenChange={(o) => { if (!o) setResolveFor(null); }}
        resolveDefault
      />
      <ConfirmDialog
        open={verifyFor != null}
        onOpenChange={(o) => { if (!o) setVerifyFor(null); }}
        title="Verify resolution?"
        description={`${verifyFor?.ncNo ?? ""} will be marked Verified and closed immediately. This cannot be undone.`}
        onConfirm={() => verifyFor && verifyMut.mutate(verifyFor.id)}
        isConfirming={verifyMut.isPending}
        confirmLabel="Verify & close"
        variant="default"
      />
      <ReasonDialog
        open={rejectFor != null}
        onOpenChange={(o) => { if (!o) setRejectFor(null); }}
        title={`Reject resolution — ${rejectFor?.ncNo ?? ""}`}
        description="The finding reopens and the owner is notified. A comment is required (FRD-CAP-05)."
        label="Comment"
        placeholder="Why is this resolution not acceptable?"
        saveLabel="Reject & reopen"
        isSaving={rejectMut.isPending}
        onSave={(comment) => rejectFor && rejectMut.mutate({ id: rejectFor.id, comment })}
      />
      <ReasonDialog
        open={waiveFor != null}
        onOpenChange={(o) => { if (!o) setWaiveFor(null); }}
        title={`Waive finding — ${waiveFor?.ncNo ?? ""}`}
        description="Waiving closes the finding without corrective action. A justification is required."
        label="Justification"
        placeholder="Why is this finding being waived?"
        saveLabel="Waive"
        isSaving={waiveMut.isPending}
        onSave={(justification) => waiveFor && waiveMut.mutate({ id: waiveFor.id, justification })}
      />
    </div>
  );
}

export default function NcBoard() {
  return <NcBoardPanel />;
}
