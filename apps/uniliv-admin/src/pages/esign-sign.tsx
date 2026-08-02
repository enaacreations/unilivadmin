import * as React from "react";
import { useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, FileSignature, AlertCircle, Eraser } from "lucide-react";

type DocResp = {
  documentName: string;
  documentBody: string;
  status: string;
  expiresAt?: string;
  signedAt?: string;
  signerName?: string;
  signatureSvg?: string;
};

export default function EsignSignPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [doc, setDoc] = React.useState<DocResp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [signerName, setSignerName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [done, setDone] = React.useState(false);

  // Drawing canvas
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const drawingRef = React.useRef(false);
  const lastRef = React.useRef<{ x: number; y: number } | null>(null);
  const hasInkRef = React.useRef(false);

  const fetchDoc = React.useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/esign/sign/${token}`);
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        setError(json?.error || `Request failed (${res.status})`);
        return;
      }
      setDoc(json.data as DocResp);
      if (json.data?.status === "SIGNED") setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  }, [token]);

  React.useEffect(() => { fetchDoc(); }, [fetchDoc]);

  // Canvas init
  React.useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#0F172A";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, [doc]);

  const getPos = (e: PointerEvent | React.PointerEvent) => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * c.width,
      y: ((e.clientY - rect.top) / rect.height) * c.height,
    };
  };

  const onDown = (e: React.PointerEvent) => {
    drawingRef.current = true;
    lastRef.current = getPos(e);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    const p = getPos(e);
    const last = lastRef.current!;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    hasInkRef.current = true;
  };
  const onUp = () => { drawingRef.current = false; lastRef.current = null; };

  const clearSig = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    hasInkRef.current = false;
  };

  const submit = async () => {
    if (!signerName.trim()) { setError("Please type your full name."); return; }
    if (!hasInkRef.current) { setError("Please draw your signature."); return; }
    const c = canvasRef.current!;
    const dataUrl = c.toDataURL("image/png");
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/esign/sign/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signerName, signatureSvg: dataUrl }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        setError(json?.error || "Signing failed");
        setSubmitting(false);
        return;
      }
      setDone(true);
      fetchDoc();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  if (error && !doc) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" /> Cannot open document
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!doc) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading document…</div>;
  }

  return (
    <div className="min-h-screen bg-muted/30 py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <FileSignature className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-display font-bold text-primary">UNILIV Co-Living</h1>
            <p className="text-xs text-muted-foreground">Secure document signing</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>{doc.documentName}</span>
              <Badge variant={done ? "success" : "warning"}>{done ? "SIGNED" : doc.status}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm font-sans bg-muted/40 p-4 rounded-md max-h-96 overflow-y-auto" data-testid="esign-doc-body">
              {doc.documentBody}
            </pre>
          </CardContent>
        </Card>

        {done ? (
          <Card>
            <CardContent className="p-6 text-center space-y-3">
              <CheckCircle2 className="h-12 w-12 text-success mx-auto" />
              <h2 className="text-lg font-semibold text-primary">Thank you, {doc.signerName ?? signerName}!</h2>
              <p className="text-sm text-muted-foreground">
                Your signature has been recorded
                {doc.signedAt && ` on ${new Date(doc.signedAt).toLocaleString()}`}.
              </p>
              {doc.signatureSvg && (
                <div className="border rounded-md p-2 bg-card inline-block">
                  <img src={doc.signatureSvg} alt="signature" className="max-h-24" />
                </div>
              )}
              <p className="text-xs text-muted-foreground">You may now close this page.</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader><CardTitle>Sign here</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Full legal name *</Label>
                <Input
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  placeholder="As it appears on your ID"
                  data-testid="input-signer-name"
                />
              </div>
              <div>
                <Label>Draw your signature *</Label>
                <div className="mt-1 border-2 border-dashed border-secondary-border rounded-md bg-white">
                  <canvas
                    ref={canvasRef}
                    width={600}
                    height={200}
                    className="w-full h-48 touch-none cursor-crosshair"
                    onPointerDown={onDown}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                    onPointerLeave={onUp}
                    data-testid="signature-canvas"
                  />
                </div>
                <Button variant="ghost" size="sm" onClick={clearSig} className="mt-1">
                  <Eraser className="h-3 w-3 mr-1" /> Clear
                </Button>
              </div>

              {error && (
                <div className="text-sm text-destructive flex items-center gap-2">
                  <AlertCircle className="h-4 w-4" />{error}
                </div>
              )}

              <div className="flex justify-between items-center">
                <p className="text-xs text-muted-foreground">
                  By clicking Sign you agree this electronic signature has the same legal effect as a handwritten one.
                </p>
                <Button onClick={submit} disabled={submitting} data-testid="button-submit-signature">
                  {submitting ? "Signing…" : "Sign Document"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
