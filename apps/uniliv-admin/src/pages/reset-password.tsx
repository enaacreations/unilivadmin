import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { apiFetch } from "@/lib/api-fetch";
import { CheckCircle2, Eye, EyeOff, Loader2, Lock, ShieldCheck } from "lucide-react";

const INPUT = "w-full h-12 rounded-xl border border-white/10 bg-white/[0.05] pl-10 pr-10 text-sm text-white placeholder:text-white/35 focus:outline-none focus:border-accent/70 focus:ring-2 focus:ring-accent/25 transition-colors";
const PRIMARY = "w-full h-12 rounded-xl bg-accent text-white text-sm font-semibold inline-flex items-center justify-center gap-2 shadow-[0_10px_34px_-10px_rgba(232,96,44,0.75)] hover:bg-accent/90 active:scale-[0.99] transition disabled:opacity-60 disabled:pointer-events-none";

/** Public page opened from the emailed reset link: /reset-password/:token */
export default function ResetPasswordPage() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const token = (params as Record<string, string>).token;

  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setBusy(true);
    try {
      await apiFetch("/auth/reset-password", { method: "POST", body: JSON.stringify({ verificationToken: token, newPassword: password }) });
      setDone(true);
    } catch (err: any) {
      setError(err?.message || "This reset link is invalid or has expired. Please request a new one.");
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#0a0706] text-white p-5">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.035] p-7 sm:p-9 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl">
        {done ? (
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-success/15"><CheckCircle2 className="h-6 w-6 text-success" /></div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Secure access</div>
            <h1 className="mt-1 font-display text-2xl font-bold">Password updated</h1>
            <p className="mt-1.5 text-sm text-white/55">You've been signed out everywhere. Sign in with your new password.</p>
            <button onClick={() => setLocation("/login")} className={`${PRIMARY} mt-6`}>Continue to sign in</button>
          </div>
        ) : (
          <>
            <div className="space-y-1.5 mb-6">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Secure access</div>
              <h1 className="font-display text-2xl font-bold flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-accent" /> Set a new password</h1>
              <p className="text-sm text-white/55">Choose a strong password of at least 8 characters.</p>
            </div>

            {error && (
              <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100/90">{error}</div>
            )}

            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <label htmlFor="new-password" className="block text-sm font-semibold text-white/85 mb-1.5">New password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 pointer-events-none" />
                  <input id="new-password" autoFocus type={show ? "text" : "password"} placeholder="Enter a new password" className={INPUT}
                    value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-new-password" />
                  <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition-colors">
                    {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <button type="submit" disabled={busy || password.length < 8} className={PRIMARY} data-testid="button-update-password">
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : "Update password"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
