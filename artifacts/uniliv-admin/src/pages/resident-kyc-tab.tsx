import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { FormModal } from "@/components/ui/form-modal";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, Plus } from "lucide-react";

type KycRow = {
  id: string;
  idType: string;
  idNumber: string;
  idImageFront?: string | null;
  idImageBack?: string | null;
  selfieImage?: string | null;
  status: "PENDING" | "VERIFIED" | "REJECTED";
  provider?: string | null;
  rejectionReason?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
};

type KycEvent = { id: string; type: string; ip: string | null; userAgent: string | null; createdAt: string };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("File read failed"));
    r.readAsDataURL(file);
  });
}

const ID_TYPES = ["AADHAAR", "PAN", "PASSPORT", "DRIVING_LICENSE", "VOTER_ID", "COLLEGE_ID"];

function statusVariant(s: string): "success" | "destructive" | "warning" {
  if (s === "VERIFIED") return "success";
  if (s === "REJECTED") return "destructive";
  return "warning";
}

export function ResidentKycTab({ residentId }: { residentId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [rejectFor, setRejectFor] = React.useState<string | null>(null);
  const [rejectReason, setRejectReason] = React.useState("");

  const { data, isLoading } = useQuery<{ data: KycRow[] }>({
    queryKey: ["kyc", residentId],
    queryFn: () => apiFetch(`/residents/${residentId}/kyc`),
  });
  const rows = data?.data || [];

  const verify = useMutation({
    mutationFn: ({ id, status, rejectionReason }: { id: string; status: string; rejectionReason?: string }) =>
      apiFetch(`/kyc/${id}/verify`, { method: "POST", body: JSON.stringify({ status, rejectionReason }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kyc", residentId] });
      toast({ title: "KYC updated" });
      setRejectFor(null); setRejectReason("");
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Identity verification documents and provider checks.</p>
        <Button onClick={() => setCreateOpen(true)} data-testid="button-new-kyc">
          <Plus className="h-4 w-4 mr-2" />New KYC Request
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <ShieldCheck className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No KYC requests yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Card key={r.id} data-testid={`kyc-row-${r.id}`}>
              <CardContent className="p-4 flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-primary">{r.idType.replace(/_/g, " ")}</p>
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                    {r.provider && <Badge variant="outline" className="text-xs">{r.provider}</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 font-mono">{r.idNumber}</p>
                  {r.rejectionReason && <p className="text-xs text-destructive mt-1">Rejected: {r.rejectionReason}</p>}
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Submitted {new Date(r.createdAt).toLocaleString()}
                    {r.reviewedAt && ` · Reviewed ${new Date(r.reviewedAt).toLocaleString()}`}
                  </p>
                  {(r.idImageFront || r.idImageBack || r.selfieImage) && (
                    <div className="flex gap-2 mt-2">
                      {r.idImageFront && <img src={r.idImageFront} alt="ID front" className="h-16 rounded border" data-testid={`kyc-img-front-${r.id}`} />}
                      {r.idImageBack && <img src={r.idImageBack} alt="ID back" className="h-16 rounded border" />}
                      {r.selfieImage && <img src={r.selfieImage} alt="Selfie" className="h-16 rounded border" />}
                    </div>
                  )}
                  <KycEventsList kycId={r.id} />
                </div>
                {r.status !== "VERIFIED" && (
                  <Button
                    size="sm"
                    onClick={() => verify.mutate({ id: r.id, status: "VERIFIED" })}
                    data-testid={`button-verify-${r.id}`}
                  >
                    Verify
                  </Button>
                )}
                {r.status !== "REJECTED" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRejectFor(r.id)}
                    data-testid={`button-reject-${r.id}`}
                  >
                    Reject
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateKycModal open={createOpen} onOpenChange={setCreateOpen} residentId={residentId} />

      <FormModal
        open={!!rejectFor}
        onOpenChange={(o) => !o && setRejectFor(null)}
        title="Reject KYC"
        onSave={() => rejectFor && verify.mutate({ id: rejectFor, status: "REJECTED", rejectionReason: rejectReason })}
        isSaving={verify.isPending}
        saveLabel="Reject"
      >
        <Label>Reason *</Label>
        <Textarea rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
      </FormModal>
    </div>
  );
}

function CreateKycModal({
  open,
  onOpenChange,
  residentId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  residentId: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [idType, setIdType] = React.useState("AADHAAR");
  const [idNumber, setIdNumber] = React.useState("");
  const [idImageFront, setIdImageFront] = React.useState<string | null>(null);
  const [idImageBack, setIdImageBack] = React.useState<string | null>(null);
  const [selfieImage, setSelfieImage] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setIdType("AADHAAR"); setIdNumber("");
      setIdImageFront(null); setIdImageBack(null); setSelfieImage(null);
    }
  }, [open]);

  const handleFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
    setter: (s: string | null) => void,
  ) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) {
      toast({ title: "File too large (max 4 MB)", variant: "destructive" });
      return;
    }
    setter(await readFileAsDataUrl(f));
  };

  const create = useMutation({
    mutationFn: () =>
      apiFetch(`/residents/${residentId}/kyc`, {
        method: "POST",
        body: JSON.stringify({ idType, idNumber, idImageFront, idImageBack, selfieImage, provider: "MANUAL" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kyc", residentId] });
      toast({ title: "KYC request created" });
      onOpenChange(false);
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title="New KYC Request"
      onSave={() => {
        if (!idNumber.trim()) { toast({ title: "ID number required", variant: "destructive" }); return; }
        create.mutate();
      }}
      isSaving={create.isPending}
      saveLabel="Submit"
    >
      <div className="space-y-3">
        <div>
          <Label>ID Type *</Label>
          <Select value={idType} onValueChange={setIdType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ID_TYPES.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>ID Number *</Label>
          <Input
            value={idNumber}
            onChange={(e) => setIdNumber(e.target.value)}
            placeholder="e.g. XXXX-XXXX-1234"
            data-testid="input-id-number"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">ID Front</Label>
            <Input type="file" accept="image/*" onChange={(e) => handleFile(e, setIdImageFront)} data-testid="input-id-image-front" />
            {idImageFront && <img src={idImageFront} alt="front" className="mt-1 h-14 rounded border" />}
          </div>
          <div>
            <Label className="text-xs">ID Back</Label>
            <Input type="file" accept="image/*" onChange={(e) => handleFile(e, setIdImageBack)} />
            {idImageBack && <img src={idImageBack} alt="back" className="mt-1 h-14 rounded border" />}
          </div>
          <div>
            <Label className="text-xs">Selfie</Label>
            <Input type="file" accept="image/*" onChange={(e) => handleFile(e, setSelfieImage)} />
            {selfieImage && <img src={selfieImage} alt="selfie" className="mt-1 h-14 rounded border" />}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Default provider is <strong>Manual</strong> — request stays Pending until an admin verifies. DigiLocker / Aadhaar OTP provider can be plugged in later.
        </p>
      </div>
    </FormModal>
  );
}

function KycEventsList({ kycId }: { kycId: string }) {
  const [open, setOpen] = React.useState(false);
  const { data } = useQuery<{ data: KycEvent[] }>({
    queryKey: ["kyc-events", kycId],
    queryFn: () => apiFetch(`/kyc/${kycId}/events`),
    enabled: open,
  });
  return (
    <div className="mt-2">
      <button
        type="button"
        className="text-[11px] text-primary underline"
        onClick={() => setOpen((o) => !o)}
        data-testid={`button-kyc-events-${kycId}`}
      >
        {open ? "Hide audit trail" : "Show audit trail"}
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {(data?.data || []).map((e) => (
            <div key={e.id} className="text-[11px] border-l-2 border-primary pl-2">
              <span className="font-medium">{e.type}</span>{" · "}
              <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
              {e.ip && <span className="text-muted-foreground"> · {e.ip}</span>}
            </div>
          ))}
          {(data?.data || []).length === 0 && <p className="text-[11px] text-muted-foreground">No events.</p>}
        </div>
      )}
    </div>
  );
}
