import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { FormModal } from "@/components/ui/form-modal";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { FileSignature, Plus, Copy, ExternalLink, X, Download, FileCheck2, ShieldAlert } from "lucide-react";

/** Canonical document name the backend uses for the rent agreement esign request. */
const RENT_AGREEMENT_DOC_NAME = "Rent Agreement";

export type EsignRow = {
  id: string;
  documentName: string;
  status: "PENDING" | "VIEWED" | "SIGNED" | "EXPIRED" | "VOIDED";
  signerEmail?: string | null;
  signerPhone?: string | null;
  signerToken: string;
  signerName?: string | null;
  signedAt?: string | null;
  viewedAt?: string | null;
  expiresAt: string;
  createdAt: string;
};

function statusVariant(s: string): "success" | "destructive" | "warning" | "info" | "secondary" {
  if (s === "SIGNED") return "success";
  if (s === "EXPIRED" || s === "VOIDED") return "destructive";
  if (s === "VIEWED") return "info";
  if (s === "PENDING") return "warning";
  return "secondary";
}

export function ResidentEsignTab({ residentId, residentName }: { residentId: string; residentName: string }) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);

  const { data, isLoading } = useQuery<{ data: EsignRow[] }>({
    queryKey: ["esign", residentId],
    queryFn: () => apiFetch(`/residents/${residentId}/esign`),
  });
  const rows = data?.data || [];

  // O26/O25 — the rent agreement is the most recent (non-voided) 'Rent Agreement'
  // esign request. The signed copy gates resident activation.
  const agreement = rows
    .filter((r) => r.documentName === RENT_AGREEMENT_DOC_NAME && r.status !== "VOIDED")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  return (
    <div className="space-y-4">
      <RentAgreementBanner residentId={residentId} agreement={agreement} onOpenDetail={setDetailId} />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Send agreements, NOCs, and other documents for signature. Signers receive a token-gated link.
        </p>
        <Button onClick={() => setCreateOpen(true)} data-testid="button-new-esign">
          <Plus className="h-4 w-4 mr-2" />Request Signature
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <FileSignature className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No e-sign requests yet.</p>
          </CardContent>
        </Card>
      ) : (
        <BoundedScroll size="md" className="-mx-1 px-1">
          <div className="space-y-2">
          {rows.map((r) => (
            <Card key={r.id} data-testid={`esign-row-${r.id}`}>
              <CardContent className="p-4 flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-primary">{r.documentName}</p>
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Created {new Date(r.createdAt).toLocaleString()} · Expires {new Date(r.expiresAt).toLocaleDateString()}
                    {r.signedAt && ` · Signed ${new Date(r.signedAt).toLocaleString()} by ${r.signerName ?? ""}`}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setDetailId(r.id)} data-testid={`button-esign-detail-${r.id}`}>
                  Details
                </Button>
              </CardContent>
            </Card>
          ))}
          </div>
        </BoundedScroll>
      )}

      <CreateEsignModal open={createOpen} onOpenChange={setCreateOpen} residentId={residentId} residentName={residentName} />
      {detailId && <EsignDetailSheet id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

/**
 * O26/O25 — Rent Agreement summary banner. Surfaces the one esign request that
 * gates resident activation: generate it when none exists, otherwise show its
 * status, a copy/open sign link, and the signed PDF once signed.
 */
export function RentAgreementBanner({
  residentId,
  agreement,
  onOpenDetail,
}: {
  residentId: string;
  agreement: EsignRow | undefined;
  onOpenDetail: (id: string) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const generate = useMutation<{ data: EsignRow & { signerUrl: string } }, Error, void>({
    mutationFn: () => apiFetch(`/residents/${residentId}/agreement`, { method: "POST" }),
    onSuccess: (resp) => {
      qc.invalidateQueries({ queryKey: ["esign", residentId] });
      toast({ title: "Agreement generated", description: "Signing link copied to clipboard." });
      try { navigator.clipboard?.writeText(resp.data.signerUrl); } catch { /* noop */ }
    },
    onError: (e) => toast({ title: e.message, variant: "destructive" }),
  });

  const signed = agreement?.status === "SIGNED";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const signerUrl = agreement ? `${origin}/esign/sign/${agreement.signerToken}` : "";

  const copyLink = () => {
    if (!signerUrl) return;
    navigator.clipboard?.writeText(signerUrl);
    toast({ title: "Sign link copied" });
  };

  return (
    <Card
      className={signed ? "bg-success/5 border-success/20" : "bg-warning/5 border-warning/20"}
      data-testid="rent-agreement-banner"
    >
      <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          {signed
            ? <FileCheck2 className="h-5 w-5 text-success mt-0.5 shrink-0" />
            : <ShieldAlert className="h-5 w-5 text-warning mt-0.5 shrink-0" />}
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-medium text-primary">Rent Agreement</p>
              {agreement && <Badge variant={statusVariant(agreement.status)}>{agreement.status}</Badge>}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {signed
                ? `Signed ${agreement?.signedAt ? `on ${new Date(agreement.signedAt).toLocaleString()}` : ""}${agreement?.signerName ? ` by ${agreement.signerName}` : ""}.`
                : agreement
                  ? "A signed rent agreement is required before the resident can be activated."
                  : "No rent agreement yet — generate one to send for signature. Required before activation."}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!agreement ? (
            <Button
              size="sm"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              data-testid="button-generate-agreement"
            >
              <FileSignature className="h-4 w-4 mr-2" />
              {generate.isPending ? "Generating…" : "Generate Agreement"}
            </Button>
          ) : (
            <>
              {!signed && (
                <>
                  <Button variant="outline" size="sm" onClick={copyLink} data-testid="button-copy-agreement-link">
                    <Copy className="h-4 w-4 mr-2" /> Copy sign link
                  </Button>
                  <a href={signerUrl} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" title="Open sign page">
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </a>
                </>
              )}
              {signed && (
                <a
                  href={`/api/esign/${agreement.id}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="link-agreement-pdf"
                >
                  <Button variant="outline" size="sm">
                    <Download className="h-4 w-4 mr-2" /> Signed PDF
                  </Button>
                </a>
              )}
              <Button variant="ghost" size="sm" onClick={() => onOpenDetail(agreement.id)} data-testid="button-agreement-detail">
                Details
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CreateEsignModal({
  open, onOpenChange, residentId, residentName,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; residentId: string; residentName: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [documentName, setDocumentName] = React.useState("");
  const [documentBody, setDocumentBody] = React.useState("");
  const [expiresInDays, setExpiresInDays] = React.useState(14);

  React.useEffect(() => {
    if (open) {
      setDocumentName("Tenancy Agreement");
      setDocumentBody(
        `TENANCY AGREEMENT\n\nThis agreement is between UNILIV Co-Living and ${residentName}.\n\nBy signing below, the resident acknowledges the house rules, payment schedule, and notice period as set out in the on-boarding pack.\n\n— UNILIV Co-Living`,
      );
      setExpiresInDays(14);
    }
  }, [open, residentName]);

  const create = useMutation<
    { data: EsignRow & { signerUrl: string } },
    Error,
    void
  >({
    mutationFn: () =>
      apiFetch(`/residents/${residentId}/esign`, {
        method: "POST",
        body: JSON.stringify({ documentName, documentBody, expiresInDays }),
      }),
    onSuccess: (resp) => {
      qc.invalidateQueries({ queryKey: ["esign", residentId] });
      toast({ title: "Signature requested", description: "Signing link generated." });
      try { navigator.clipboard?.writeText(resp.data.signerUrl); } catch { /* noop */ }
      onOpenChange(false);
    },
    onError: (e) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title="Request Signature"
      onSave={() => {
        if (!documentName.trim() || !documentBody.trim()) {
          toast({ title: "Document name and body required", variant: "destructive" });
          return;
        }
        create.mutate();
      }}
      isSaving={create.isPending}
      saveLabel="Send"
    >
      <div className="space-y-3">
        <div>
          <Label>Document Name *</Label>
          <Input
            value={documentName}
            onChange={(e) => setDocumentName(e.target.value)}
            data-testid="input-doc-name"
          />
        </div>
        <div>
          <Label>Document Body *</Label>
          <Textarea
            rows={10}
            value={documentBody}
            onChange={(e) => setDocumentBody(e.target.value)}
            className="font-mono text-xs"
            data-testid="input-doc-body"
          />
        </div>
        <div>
          <Label>Expires in (days)</Label>
          <Input
            type="number"
            min={1}
            max={90}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(Number(e.target.value) || 14)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          A token-gated signing link will be generated and copied to your clipboard. Share it with the resident over WhatsApp/email.
        </p>
      </div>
    </FormModal>
  );
}

function EsignDetailSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // Note: list query is keyed by ["esign", residentId]; we invalidate the prefix.
  const { data } = useQuery<{
    data: EsignRow & {
      signerUrl: string;
      signatureSvg?: string | null;
      signerIp?: string | null;
      signerUserAgent?: string | null;
      events: Array<{ id: string; type: string; ip: string | null; userAgent: string | null; createdAt: string }>;
    };
  }>({
    queryKey: ["esign-detail", id],
    queryFn: () => apiFetch(`/esign/${id}`),
  });
  const r = data?.data;

  const voidMut = useMutation({
    mutationFn: () => apiFetch(`/esign/${id}/void`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["esign-detail", id] });
      qc.invalidateQueries({ queryKey: ["esign"], exact: false });
      toast({ title: "Request voided" });
    },
  });

  const copy = () => {
    if (!r?.signerUrl) return;
    navigator.clipboard?.writeText(r.signerUrl);
    toast({ title: "Link copied" });
  };

  return (
    <Sheet open={true} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between">
            <span>{r?.documentName ?? "E-sign Request"}</span>
            <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
          </SheetTitle>
        </SheetHeader>
        {!r ? (
          <p className="text-sm text-muted-foreground mt-4">Loading…</p>
        ) : (
          <div className="mt-4 space-y-4 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
              <span className="text-xs text-muted-foreground">
                Expires {new Date(r.expiresAt).toLocaleDateString()}
              </span>
            </div>

            <div>
              <Label>Signing link</Label>
              <div className="flex gap-2 mt-1">
                <Input value={r.signerUrl} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={copy} title="Copy"><Copy className="h-4 w-4" /></Button>
                <a href={r.signerUrl} target="_blank" rel="noreferrer">
                  <Button variant="outline" size="icon" title="Open"><ExternalLink className="h-4 w-4" /></Button>
                </a>
              </div>
            </div>

            {r.status === "SIGNED" && r.signatureSvg && (
              <div>
                <Label>Signature</Label>
                <div className="mt-1 border rounded-md p-2 bg-card">
                  <img src={r.signatureSvg} alt="signature" className="max-h-32 mx-auto" />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Signed by <strong>{r.signerName}</strong> on {new Date(r.signedAt!).toLocaleString()}
                </p>
                {r.signerIp && <p className="text-[11px] text-muted-foreground">IP: {r.signerIp}</p>}
                <a
                  href={`/api/esign/${id}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 mt-2 text-xs text-primary underline"
                  data-testid={`link-download-pdf-${id}`}
                >
                  <Download className="h-3 w-3" /> Download signed PDF
                </a>
              </div>
            )}

            <div>
              <Label>Audit trail</Label>
              <div className="mt-1 space-y-2 max-h-72 overflow-y-auto">
                {r.events.map((e) => (
                  <div key={e.id} className="text-xs border-l-2 border-primary pl-3 py-1">
                    <div className="font-medium">{e.type}</div>
                    <div className="text-muted-foreground text-[11px]">
                      {new Date(e.createdAt).toLocaleString()}
                      {e.ip && ` · ${e.ip}`}
                    </div>
                    {e.userAgent && <div className="text-[10px] text-muted-foreground truncate">{e.userAgent}</div>}
                  </div>
                ))}
              </div>
            </div>

            {r.status !== "SIGNED" && r.status !== "VOIDED" && (
              <Button variant="outline" onClick={() => voidMut.mutate()} disabled={voidMut.isPending}>
                Void request
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
