import * as React from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ShieldCheck, ShieldAlert, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { apiFetch, apiDownload } from "@/lib/api-fetch";
import { fmtDateTime, type ApiOne, type ApiList, type TrailEvent, type ChainVerification } from "./lib";

const KIND_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  STATE_CHANGE: "default",
  CONFIG_CHANGE: "secondary",
  GRANT_CHANGE: "secondary",
  SCORE_FREEZE: "outline",
  ASSIGNMENT: "outline",
  DENIED_ATTEMPT: "destructive",
  ESCALATION: "destructive",
  REMINDER: "outline",
  NOTIFY: "outline",
  SHARE: "outline",
  COMMENT: "outline",
};

const PAGE_SIZE = 50;

export function TrailExplorerPanel({ embedded = false }: { embedded?: boolean }) {
  const [entityType, setEntityType] = React.useState("ALL");
  const [kind, setKind] = React.useState("ALL");
  const [entityId, setEntityId] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [detail, setDetail] = React.useState<TrailEvent | null>(null);

  const chain = useQuery({
    queryKey: ["/audit/admin/events/verify-chain"],
    queryFn: () => apiFetch<ApiOne<ChainVerification>>("/audit/admin/events/verify-chain"),
  });
  const facets = useQuery({
    queryKey: ["/audit/admin/events/facets"],
    queryFn: () => apiFetch<ApiOne<{ entityTypes: string[]; kinds: string[] }>>("/audit/admin/events/facets"),
  });

  const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (entityType !== "ALL") qs.set("entityType", entityType);
  if (kind !== "ALL") qs.set("kind", kind);
  if (entityId.trim()) qs.set("entityId", entityId.trim());
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);

  const events = useQuery({
    queryKey: ["/audit/admin/events", qs.toString()],
    queryFn: () => apiFetch<ApiList<TrailEvent>>(`/audit/admin/events?${qs}`),
    placeholderData: keepPreviousData,
  });
  const rows = events.data?.data ?? [];
  const total = events.data?.meta?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetPage = () => setPage(1);

  const download = () => {
    const dqs = new URLSearchParams();
    if (entityType !== "ALL") dqs.set("entityType", entityType);
    if (from) dqs.set("from", from);
    if (to) dqs.set("to", to);
    apiDownload(`/api/audit/admin/events/export${dqs.toString() ? `?${dqs}` : ""}`, "audit-trail.csv");
  };

  const cv = chain.data?.data;

  return (
    <div className={embedded ? "space-y-4" : "space-y-6"}>
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">The append-only, hash-chained record of every state and configuration change.</p>
          <Button variant="outline" size="sm" onClick={download}><Download className="mr-1 h-4 w-4" /> Export CSV</Button>
        </div>
      ) : (
        <PageHeader
          title="Trail Explorer"
          subtitle="The append-only, hash-chained record of every state and configuration change."
          breadcrumbs={[{ label: "Audits" }, { label: "Trail Explorer" }]}
          action={<Button variant="outline" size="sm" onClick={download}><Download className="mr-1 h-4 w-4" /> Export CSV</Button>}
        />
      )}

      {/* Chain-verify banner (FR-AD-09). */}
      {chain.isLoading ? (
        <Skeleton className="h-14 w-full" />
      ) : cv ? (
        <Card className={cv.valid ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5"}>
          <CardContent className="flex items-center gap-3 py-4">
            {cv.valid ? <ShieldCheck className="h-5 w-5 text-success" /> : <ShieldAlert className="h-5 w-5 text-destructive" />}
            <div className="text-sm">
              {cv.valid ? (
                <>
                  <span className="font-medium text-success">Chain intact</span>
                  {" — "}{cv.checked.toLocaleString()} events verified at {fmtDateTime(cv.verifiedAt)}.
                </>
              ) : (
                <>
                  <span className="font-medium text-destructive">Chain broken</span>
                  {" — first mismatch at seq "}{cv.firstBrokenSeq}. Tampering or corruption is suspected.
                </>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Filters. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Entity type</Label>
          <Select value={entityType} onValueChange={(v) => { setEntityType(v); resetPage(); }}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All entities</SelectItem>
              {(facets.data?.data.entityTypes ?? []).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Kind</Label>
          <Select value={kind} onValueChange={(v) => { setKind(v); resetPage(); }}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All kinds</SelectItem>
              {(facets.data?.data.kinds ?? []).map((k) => <SelectItem key={k} value={k}>{k.replace(/_/g, " ")}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Entity id</Label>
          <Input value={entityId} onChange={(e) => { setEntityId(e.target.value); resetPage(); }} placeholder="uuid…" className="w-56" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); resetPage(); }} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); resetPage(); }} className="w-40" />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Seq</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Transition</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Hash</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.isLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}><TableCell colSpan={8}><Skeleton className="h-5 w-full" /></TableCell></TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">No events match these filters.</TableCell></TableRow>
                ) : (
                  rows.map((e) => (
                    <TableRow key={e.id} className="cursor-pointer" onClick={() => setDetail(e)}>
                      <TableCell className="tabular-nums text-muted-foreground">{e.seq}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{fmtDateTime(e.createdAt)}</TableCell>
                      <TableCell className="text-sm">{e.entityType}</TableCell>
                      <TableCell className="text-sm">
                        {e.actorName ?? "System"}
                        {e.actorRole && <span className="block text-xs text-muted-foreground">{e.actorRole.replace(/_/g, " ")}</span>}
                      </TableCell>
                      <TableCell><Badge variant={KIND_BADGE[e.kind] ?? "outline"}>{e.kind.replace(/_/g, " ")}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {e.fromState || e.toState ? `${e.fromState ?? "—"} → ${e.toState ?? "—"}` : ""}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-sm">{e.reason}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{e.hash.slice(0, 10)}…</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">{total.toLocaleString()} events</span>
            <div className="flex items-center gap-2">
              <span>Page {page} of {totalPages}</span>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Event #{detail?.seq} — {detail?.kind.replace(/_/g, " ")}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div><span className="text-muted-foreground">Entity:</span> {detail.entityType} {detail.entityId.slice(0, 12)}…</div>
                <div><span className="text-muted-foreground">Actor:</span> {detail.actorName ?? "System"}</div>
                <div><span className="text-muted-foreground">Time:</span> {fmtDateTime(detail.createdAt)}</div>
                <div><span className="text-muted-foreground">Transition:</span> {detail.fromState ?? "—"} → {detail.toState ?? "—"}</div>
              </div>
              {detail.reason && <div><span className="text-muted-foreground">Reason:</span> {detail.reason}</div>}
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Before</div>
                  <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(detail.beforeJson ?? null, null, 2)}</pre>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">After</div>
                  <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(detail.afterJson ?? null, null, 2)}</pre>
                </div>
              </div>
              <div className="font-mono text-xs text-muted-foreground">
                <div>hash: {detail.hash}</div>
                <div>prev: {detail.prevHash}</div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function TrailExplorer() {
  return <TrailExplorerPanel />;
}
