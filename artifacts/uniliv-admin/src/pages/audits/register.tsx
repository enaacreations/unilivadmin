import * as React from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  AlertCircle, BellRing, ChevronDown, ChevronLeft, ChevronRight, Eye,
  ListChecks, MoreHorizontal, PackageX, Plus, RefreshCw, RotateCcw, Search, Trash2,
  UserCog,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { DatePicker } from "@/components/ui/date-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormModal } from "@/components/ui/form-modal";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import {
  AUDIT_STATES, AUDIT_STATE_BADGE, COMPLETED_AUDIT_STATES,
  fmtDate, scoreColorClass, titleCase,
  type ApiError, type ApiList, type ApiOne, type ApiPage, type AuditRow, type AuditState, type AuditType,
} from "./lib";
import { TypeBadge } from "./shared";

const ALL = "__all__";
const PAGE_SIZES = [20, 50, 100];
type Segment = "all" | "active" | "completed";

/** Audit Register (FRD-REG-01/02/03) — server-paginated, scoped list of every audit. */
export default function AuditRegister() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { can } = usePermissions();

  const [segment, setSegment] = React.useState<Segment>("all");
  const [searchInput, setSearchInput] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [auditType, setAuditType] = React.useState<string>(ALL);
  const [states, setStates] = React.useState<AuditState[]>([]);
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [page, setPage] = React.useState(0); // zero-based
  const [pageSize, setPageSize] = React.useState(20);
  const [deleteTarget, setDeleteTarget] = React.useState<AuditRow | null>(null);
  const [reassignOpen, setReassignOpen] = React.useState(false);
  const [reassignFrom, setReassignFrom] = React.useState("");
  const [reassignTo, setReassignTo] = React.useState("");
  const [reassignReason, setReassignReason] = React.useState("");

  const canBulkReassign = can("AUDIT_SCHEDULES", "edit");

  // Debounce free-text search (400ms) and reset paging on change.
  React.useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0); }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);
  React.useEffect(() => { setPage(0); }, [segment, auditType, states, overdueOnly, from, to, pageSize]);

  const typesQuery = useQuery({
    queryKey: ["/audits/visible-types"],
    queryFn: () => apiFetch<ApiOne<AuditType[]>>("/audits/visible-types"),
    staleTime: 5 * 60_000,
  });
  const visibleTypes = typesQuery.data?.data ?? [];

  const queryString = React.useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page + 1));
    sp.set("limit", String(pageSize));
    if (segment !== "all") sp.set("segment", segment);
    if (auditType !== ALL) sp.set("auditType", auditType);
    if (states.length) sp.set("state", states.join(","));
    if (overdueOnly) sp.set("overdue", "true");
    if (search) sp.set("q", search);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    return sp.toString();
  }, [page, pageSize, segment, auditType, states, overdueOnly, search, from, to]);

  const listQuery = useQuery({
    queryKey: ["/audits", queryString],
    queryFn: () => apiFetch<ApiPage<AuditRow>>(`/audits?${queryString}`),
    placeholderData: keepPreviousData,
  });

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.meta.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rangeFrom = total === 0 ? 0 : page * pageSize + 1;
  const rangeTo = Math.min(total, (page + 1) * pageSize);

  const nudgeMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/audits/${id}/nudge`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => toast({ title: "Nudge sent to the assignee" }),
    onError: (e: ApiError) =>
      toast({
        title: e.status === 429 ? "Rate limited" : "Nudge failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/audits/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "Deleted from register" }),
      }),
    onSuccess: () => {
      toast({ title: "Audit deleted" });
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["/audits"] });
    },
    onError: (e: Error) => {
      setDeleteTarget(null);
      toast({ title: e.message || "Delete failed", variant: "destructive" });
    },
  });

  const usersQuery = useQuery({
    queryKey: ["/users", "bulk-reassign"],
    queryFn: () =>
      apiFetch<ApiList<{ id: string; name: string; role: string }>>("/users?limit=100"),
    enabled: reassignOpen,
  });

  const bulkReassignMut = useMutation({
    mutationFn: () =>
      apiFetch<ApiOne<{ reassigned: number }>>("/audits/bulk-reassign", {
        method: "POST",
        body: JSON.stringify({
          fromAssigneeId: reassignFrom,
          toAssigneeId: reassignTo,
          ...(reassignReason.trim() ? { reason: reassignReason.trim() } : {}),
        }),
      }),
    onSuccess: (res) => {
      toast({ title: `${res.data.reassigned} reassigned` });
      setReassignOpen(false);
      setReassignFrom(""); setReassignTo(""); setReassignReason("");
      qc.invalidateQueries({ queryKey: ["/audits"] });
    },
    onError: (e: Error) => toast({ title: e.message || "Bulk reassign failed", variant: "destructive" }),
  });

  const hasFilters =
    auditType !== ALL || states.length > 0 || overdueOnly || !!search || !!from || !!to;
  const resetFilters = () => {
    setAuditType(ALL); setStates([]); setOverdueOnly(false);
    setSearchInput(""); setSearch(""); setFrom(""); setTo(""); setPage(0);
  };

  const canDelete = can("AUDIT_EXECUTION", "delete");

  return (
    <div className="space-y-6">
      <PageHeader
        title="All Audits"
        subtitle="Every audit in your scope — search, segments and filters."
        breadcrumbs={[{ label: "Audits" }, { label: "All Audits" }]}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => listQuery.refetch()}
              disabled={listQuery.isFetching}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${listQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {canBulkReassign && (
              <Button variant="outline" size="sm" onClick={() => setReassignOpen(true)}>
                <UserCog className="mr-2 h-4 w-4" /> Bulk reassign
              </Button>
            )}
            {can("AUDIT_EXECUTION", "create") && (
              <Button asChild size="sm">
                <Link href="/audits/new">
                  <Plus className="mr-2 h-4 w-4" /> New Audit
                </Link>
              </Button>
            )}
          </div>
        }
      />

      {/* Segments */}
      <ToggleGroup
        type="single"
        variant="outline"
        value={segment}
        onValueChange={(v) => { if (v) setSegment(v as Segment); }}
        className="justify-start"
      >
        <ToggleGroupItem value="all">All</ToggleGroupItem>
        <ToggleGroupItem value="active">Active</ToggleGroupItem>
        <ToggleGroupItem value="completed">Completed</ToggleGroupItem>
      </ToggleGroup>

      {/* Filter row */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-[200px] max-w-xs flex-1">
          <Label className="mb-1 block text-xs text-muted-foreground">Search</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Ticket or title…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Type</Label>
          <Select value={auditType} onValueChange={setAuditType}>
            <SelectTrigger className="w-32"><SelectValue placeholder="Type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All types</SelectItem>
              {visibleTypes.map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
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
            <DropdownMenuContent align="start" className="w-52">
              {AUDIT_STATES.map((s) => (
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
          <Switch id="overdue-only" checked={overdueOnly} onCheckedChange={setOverdueOnly} />
          <Label htmlFor="overdue-only" className="cursor-pointer text-sm">Overdue only</Label>
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
        <div className="w-full overflow-auto overscroll-contain" style={{ maxHeight: "62vh" }}>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card [&_tr]:border-b [&_tr]:border-border">
              <TableRow>
                <TableHead className="whitespace-nowrap">Ticket</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="whitespace-nowrap">Scheduled</TableHead>
                <TableHead className="text-right">Score %</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {listQuery.isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 10 }).map((__, j) => (
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
                        {(listQuery.error as Error)?.message || "Failed to load the register."}
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
                      <p className="text-sm">No audits match these filters.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => {
                  const pct = r.scorePct != null ? Number(r.scorePct) : null;
                  const pending = r.state === "DRAFT" || r.state === "SCHEDULED";
                  const completed =
                    COMPLETED_AUDIT_STATES.includes(r.state) || r.state === "CANCELLED";
                  return (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/audits/${r.id}`)}
                    >
                      <TableCell className="whitespace-nowrap font-mono text-xs">{r.ticketNo}</TableCell>
                      <TableCell>
                        <span className="block max-w-[240px] truncate font-medium">{r.title}</span>
                      </TableCell>
                      <TableCell><TypeBadge type={r.auditType} /></TableCell>
                      <TableCell>
                        <span className="block max-w-[180px] truncate text-sm">
                          {r.propertyName ?? "—"}
                          {r.roomNumber && (
                            <span className="text-muted-foreground"> · Room {r.roomNumber}</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        {r.assigneeName ? (
                          <div className="max-w-[160px]">
                            <div className="truncate text-sm">{r.assigneeName}</div>
                            {r.assigneeRole && (
                              <div className="truncate text-xs text-muted-foreground">
                                {titleCase(r.assigneeRole)}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <Badge variant={AUDIT_STATE_BADGE[r.state] ?? "outline"}>
                            {titleCase(r.state)}
                          </Badge>
                          {r.isOverdue && (
                            <span
                              className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                              title="Overdue"
                            />
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {fmtDate(r.scheduledFor)}
                      </TableCell>
                      <TableCell className="text-right">
                        {pct != null ? (
                          <span className={`font-medium tabular-nums ${scoreColorClass(pct)}`}>
                            {pct.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.result ? (
                          <div>
                            <Badge variant={r.result === "PASS" ? "success" : "destructive"}>
                              {r.result}
                            </Badge>
                            {r.scoreBand && (
                              <div className="mt-0.5 text-xs text-muted-foreground">{r.scoreBand}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem onClick={() => navigate(`/audits/${r.id}`)}>
                              <Eye className="mr-2 h-4 w-4" /> View
                            </DropdownMenuItem>
                            {!completed && (
                              <DropdownMenuItem
                                disabled={nudgeMut.isPending}
                                onClick={() => nudgeMut.mutate(r.id)}
                              >
                                <BellRing className="mr-2 h-4 w-4" /> Nudge assignee
                              </DropdownMenuItem>
                            )}
                            {pending && canDelete && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setDeleteTarget(r)}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" /> Delete
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ListChecks className="h-4 w-4" />
          {total > 0 ? (
            <span>
              Showing <span className="font-medium text-foreground">{rangeFrom}</span>–
              <span className="font-medium text-foreground">{rangeTo}</span> of{" "}
              <span className="font-medium text-foreground">{total.toLocaleString("en-IN")}</span> audits
            </span>
          ) : (
            <span>No audits</span>
          )}
          {listQuery.isFetching && !listQuery.isLoading && (
            <span className="text-xs opacity-70">· updating…</span>
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

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title="Delete audit?"
        description={`${deleteTarget?.ticketNo ?? ""} — "${deleteTarget?.title ?? ""}" will be cancelled. Only pending audits can be deleted; this cannot be undone.`}
        onConfirm={() => cancelMut.mutate(deleteTarget!.id)}
        isConfirming={cancelMut.isPending}
        confirmLabel="Delete"
      />

      {/* Bulk reassign (moves every open audit from one auditor to another). */}
      <FormModal
        open={reassignOpen}
        onOpenChange={(o) => {
          setReassignOpen(o);
          if (!o) { setReassignFrom(""); setReassignTo(""); setReassignReason(""); }
        }}
        title="Bulk reassign audits"
        onSave={() => { if (reassignFrom && reassignTo && reassignFrom !== reassignTo) bulkReassignMut.mutate(); }}
        isSaving={bulkReassignMut.isPending}
        saveLabel="Reassign all"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Moves every open audit assigned to the source auditor over to the
            target auditor. Both are notified.
          </p>
          <div className="space-y-2">
            <Label>From auditor</Label>
            <Select value={reassignFrom} onValueChange={setReassignFrom}>
              <SelectTrigger>
                <SelectValue placeholder={usersQuery.isLoading ? "Loading users…" : "Pick the current auditor"} />
              </SelectTrigger>
              <SelectContent>
                {(usersQuery.data?.data ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.name} · {titleCase(u.role)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>To auditor</Label>
            <Select value={reassignTo} onValueChange={setReassignTo}>
              <SelectTrigger>
                <SelectValue placeholder={usersQuery.isLoading ? "Loading users…" : "Pick the new auditor"} />
              </SelectTrigger>
              <SelectContent>
                {(usersQuery.data?.data ?? [])
                  .filter((u) => u.id !== reassignFrom)
                  .map((u) => (
                    <SelectItem key={u.id} value={u.id}>{u.name} · {titleCase(u.role)}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Reason <span className="text-muted-foreground">(optional)</span></Label>
            <Textarea
              value={reassignReason}
              onChange={(e) => setReassignReason(e.target.value)}
              rows={2}
              placeholder="e.g. Auditor on leave"
            />
          </div>
        </div>
      </FormModal>
    </div>
  );
}
