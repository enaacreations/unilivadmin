import * as React from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, ExternalLink, Link2, Share2, Copy, Trash2, MessageCircleOff } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import {
  REPORT_STATUS_BADGE, fmtDateTime,
  type ApiOne, type ReportDetail, type ReportShare,
} from "./lib";

/** Absolute URL for a share token so it can be copied/pasted anywhere. */
function absoluteShareUrl(url: string): string {
  return url.startsWith("http") ? url : window.location.origin + url;
}

const TTL_OPTIONS = [
  { label: "24 hours", value: 24 },
  { label: "72 hours", value: 72 },
  { label: "7 days", value: 168 },
];

export default function ReportViewer() {
  const params = useParams<{ reportId: string }>();
  const reportId = params.reportId;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [shareOpen, setShareOpen] = React.useState(false);
  const [ttl, setTtl] = React.useState(72);

  const key = ["/audit/reports", reportId] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<ApiOne<ReportDetail>>(`/audit/reports/${reportId}`),
  });
  const report = query.data?.data;
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const createShare = useMutation({
    mutationFn: () =>
      apiFetch<ApiOne<ReportShare & { url: string }>>(`/audit/reports/${reportId}/shares`, {
        method: "POST",
        body: JSON.stringify({ channel: "LINK", ttlHours: ttl }),
      }),
    onSuccess: () => {
      toast({ title: "Share link created" });
      setShareOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Could not create link", variant: "destructive" }),
  });

  const revokeShare = useMutation({
    mutationFn: (sid: string) =>
      apiFetch(`/audit/reports/${reportId}/shares/${sid}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Link revoked" });
      invalidate();
    },
    onError: (e: Error) => toast({ title: e.message || "Revoke failed", variant: "destructive" }),
  });

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(absoluteShareUrl(url)).then(
      () => toast({ title: "Link copied" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[70vh] w-full" />
      </div>
    );
  }
  if (!report) {
    return (
      <div className="space-y-4">
        <PageHeader title="Report" breadcrumbs={[{ label: "Audits" }, { label: "Reports" }]} />
        <Card><CardContent className="py-16 text-center text-muted-foreground">Report not found.</CardContent></Card>
      </div>
    );
  }

  const activeShares = report.shares.filter((s) => !s.revokedAt);

  return (
    <div className="space-y-6">
      <PageHeader
        title={report.reportNo}
        subtitle={`Revision ${report.revision} · ${report.title}`}
        breadcrumbs={[{ label: "Audits" }, { label: "Reports", href: "/audits/reports" }, { label: report.reportNo }]}
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/audits/reports")}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Registry
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShareOpen(true)} disabled={report.status !== "COMPLETED"}>
              <Share2 className="mr-1 h-4 w-4" /> Share
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant={REPORT_STATUS_BADGE[report.status]}>{report.status}</Badge>
        <Link href={`/audits/${report.auditId}`} className="text-accent hover:underline tabular-nums">
          {report.ticketNo}
        </Link>
        <span className="text-muted-foreground">Generated {fmtDateTime(report.generatedAt)}</span>
        {report.sizeBytes != null && (
          <span className="text-muted-foreground">{Math.round(report.sizeBytes / 1024)} KB</span>
        )}
        {report.url && (
          <div className="ml-auto flex gap-2">
            <a href={report.url} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm"><ExternalLink className="mr-1 h-4 w-4" /> Open</Button>
            </a>
            <a href={report.url} download={`${report.reportNo}.pdf`}>
              <Button variant="outline" size="sm"><Download className="mr-1 h-4 w-4" /> Download</Button>
            </a>
          </div>
        )}
      </div>

      {report.status === "FAILED" && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-sm text-destructive">
            Report generation failed{report.error ? `: ${report.error}` : ""}. It will retry automatically, or an admin can regenerate it from the registry.
          </CardContent>
        </Card>
      )}

      {report.url ? (
        <div className="overflow-hidden rounded-lg border bg-muted">
          <iframe title={report.reportNo} src={report.url} className="h-[75vh] w-full" />
        </div>
      ) : (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            {report.status === "COMPLETED"
              ? "Report file is not reachable from this environment."
              : "Report is still generating — check back shortly."}
          </CardContent>
        </Card>
      )}

      {activeShares.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Active share links</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Channel</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Opens</TableHead>
                    <TableHead className="w-40" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeShares.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell><Badge variant="outline">{s.channel}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmtDateTime(s.expiresAt)}</TableCell>
                      <TableCell className="tabular-nums">{s.accessCount}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => copyUrl(`/api/audit-shared/${s.token}`)}>
                            <Copy className="mr-1 h-3.5 w-3.5" /> Copy
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => revokeShare.mutate(s.id)} disabled={revokeShare.isPending}>
                            <Trash2 className="mr-1 h-3.5 w-3.5" /> Revoke
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share report</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Expiring signed link</Label>
              <div className="flex items-center gap-2">
                <Select value={String(ttl)} onValueChange={(v) => setTtl(Number(v))}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TTL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={() => createShare.mutate()} disabled={createShare.isPending}>
                  <Link2 className="mr-1 h-4 w-4" /> Create link
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Anyone with the link can view the PDF until it expires. Access is logged.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              <MessageCircleOff className="h-4 w-4" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help">WhatsApp sharing — coming soon</span>
                </TooltipTrigger>
                <TooltipContent>Fast-follow — the WhatsApp Business gateway is pending (D-5).</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShareOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
