import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { FcGoogle } from "react-icons/fc";
import { useAuthStore } from "@/lib/store";
import { apiFetch, refreshSession } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { homeForRole, type UserRole } from "@/lib/permissions";
import { useQueryParam } from "@/lib/nav-helpers";
import { AlertTriangle, ArrowLeft, ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, ShieldCheck, Smartphone, User } from "lucide-react";

type View = "login" | "otp" | "forgot-username" | "forgot-password" | "email-sent";
type OtpFlow = "LOGIN" | "FORGOT_USERNAME" | "FORGOT_PASSWORD";

interface ChallengeData {
  challengeId: string;
  maskedPhone: string;
  devOtp?: string;
  expiresInSeconds: number;
  name?: string;
}

const auth = {
  login: (identifier: string, password: string) =>
    apiFetch<{ data: ChallengeData & { otpRequired: boolean } }>("/auth/login", {
      method: "POST", body: JSON.stringify({ identifier, password }),
    }),
  verifyOtp: (challengeId: string, code: string) =>
    apiFetch<{ accessToken: string; user: { name: string; role: string } }>("/auth/verify-otp", {
      method: "POST", body: JSON.stringify({ challengeId, code }),
    }),
  resendOtp: (challengeId: string) =>
    apiFetch<{ data: ChallengeData }>("/auth/resend-otp", { method: "POST", body: JSON.stringify({ challengeId }) }),
  forgotUsername: (phone: string) =>
    apiFetch<{ data: ChallengeData }>("/auth/forgot-username", { method: "POST", body: JSON.stringify({ phone }) }),
  forgotUsernameVerify: (challengeId: string, code: string) =>
    apiFetch<{ data: { emailSent: boolean; maskedEmail: string | null } }>("/auth/forgot-username/verify", { method: "POST", body: JSON.stringify({ challengeId, code }) }),
  forgotPassword: (identifier: string) =>
    apiFetch<{ data: ChallengeData }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ identifier }) }),
  forgotPasswordVerify: (challengeId: string, code: string) =>
    apiFetch<{ data: { emailSent: boolean; maskedEmail: string | null } }>("/auth/forgot-password/verify", { method: "POST", body: JSON.stringify({ challengeId, code }) }),
};

function useCountdown() {
  const [seconds, setSeconds] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const start = (s: number) => {
    setSeconds(s);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => setSeconds((v) => {
      if (v <= 1 && timer.current) clearInterval(timer.current);
      return v - 1;
    }), 1000);
  };
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  return { seconds: Math.max(0, seconds), start };
}

// Shared dark-glass styles (this page is always dark, independent of app theme).
const INPUT = "w-full h-12 rounded-xl border border-white/10 bg-white/[0.05] pl-10 pr-3 text-sm text-white placeholder:text-white/35 focus:outline-none focus:border-accent/70 focus:ring-2 focus:ring-accent/25 transition-colors";
const LABEL = "block text-sm font-semibold text-white/85 mb-1.5";
const PRIMARY = "group w-full h-12 rounded-xl bg-accent text-white text-sm font-semibold inline-flex items-center justify-center gap-2 shadow-[0_10px_34px_-10px_rgba(232,96,44,0.75)] hover:bg-accent/90 active:scale-[0.99] transition disabled:opacity-60 disabled:pointer-events-none";
const LINK = "text-accent hover:text-accent/80 font-medium transition-colors";
const BACK = "inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white/85 transition-colors";
const ICON = "absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 pointer-events-none";

export default function Login() {
  const [, setLocation] = useLocation();
  const { setToken } = useAuthStore();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const reason = useQueryParam("reason"); // "replaced" | "expired" — why we were bounced here
  const googleStatus = useQueryParam("google"); // "ok" after a successful Google round-trip
  const googleErrorCode = useQueryParam("error"); // google_no_account | google_inactive | google_domain | google_failed
  const rememberParam = useQueryParam("remember"); // remember choice carried through the redirect

  const [view, setView] = useState<View>("login");
  const [busy, setBusy] = useState(false);
  const [googleReady, setGoogleReady] = useState(false); // is Google sign-in configured on the server?
  const googleHandled = useRef(false);

  // login
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);

  // otp
  const [flow, setFlow] = useState<OtpFlow>("LOGIN");
  const [challenge, setChallenge] = useState<ChallengeData | null>(null);
  const [code, setCode] = useState("");
  const resend = useCountdown();

  // recovery
  const [recoverPhone, setRecoverPhone] = useState("");
  const [recoverId, setRecoverId] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null); // masked email the link was sent to

  const startOtp = (data: ChallengeData, f: OtpFlow) => {
    setChallenge(data); setFlow(f); setCode(""); setView("otp"); resend.start(30);
  };

  const onLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier || !password) return;
    setBusy(true);
    try {
      const res = await auth.login(identifier, password);
      startOtp(res.data, "LOGIN");
    } catch (err: any) {
      toast({ title: err?.message || "Sign in failed", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const onVerify = async (value?: string) => {
    const c = value ?? code;
    if (!challenge || c.length < 6) return;
    setBusy(true);
    try {
      if (flow === "LOGIN") {
        const res = await auth.verifyOtp(challenge.challengeId, c);
        queryClient.clear(); // never inherit a previous user's cached identity/data
        setToken(res.accessToken, remember);
        toast({ title: `Welcome back, ${res.user?.name?.split(" ")[0] ?? ""}`.trim() });
        setLocation(homeForRole(res.user?.role as UserRole | undefined));
      } else if (flow === "FORGOT_USERNAME") {
        const res = await auth.forgotUsernameVerify(challenge.challengeId, c);
        setSentTo(res.data.maskedEmail);
        setView("email-sent");
      } else {
        const res = await auth.forgotPasswordVerify(challenge.challengeId, c);
        setSentTo(res.data.maskedEmail);
        setView("email-sent");
      }
    } catch (err: any) {
      toast({ title: err?.message || "Verification failed", variant: "destructive" });
      setCode("");
    } finally { setBusy(false); }
  };

  const onResend = async () => {
    if (!challenge || resend.seconds > 0) return;
    try {
      const res = await auth.resendOtp(challenge.challengeId);
      setChallenge((c) => ({ ...(c as ChallengeData), ...res.data }));
      setCode(""); resend.start(30);
      toast({ title: "A new code has been sent" });
    } catch (err: any) {
      toast({ title: err?.message || "Could not resend", variant: "destructive" });
    }
  };

  const onForgotUsername = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await auth.forgotUsername(recoverPhone);
      startOtp(res.data, "FORGOT_USERNAME");
    } catch (err: any) {
      toast({ title: err?.message || "No account found", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const onForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await auth.forgotPassword(recoverId);
      startOtp(res.data, "FORGOT_PASSWORD");
    } catch (err: any) {
      toast({ title: err?.message || "No account found", variant: "destructive" });
    } finally { setBusy(false); }
  };

  // Is Google sign-in configured on the server? Controls whether we show the button.
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.data?.google) setGoogleReady(true); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Returned from a successful Google round-trip: the refresh cookie is set, so
  // mint an access token, load the profile, and land on the right home — exactly
  // like the OTP path does.
  useEffect(() => {
    if (googleStatus !== "ok" || googleHandled.current) return;
    googleHandled.current = true;
    (async () => {
      setBusy(true);
      try {
        const remember = rememberParam !== "0";
        localStorage.setItem("uniliv_remember", remember ? "1" : "0");
        const token = await refreshSession();
        if (!token) {
          toast({ title: "Google sign-in didn't complete", description: "Please try again.", variant: "destructive" });
          return;
        }
        queryClient.clear(); // never inherit a previous user's cached data
        setToken(token, remember);
        const me = await apiFetch<{ data: { name?: string; role?: string } }>("/auth/me");
        toast({ title: `Welcome back, ${me.data?.name?.split(" ")[0] ?? ""}`.trim() });
        setLocation(homeForRole(me.data?.role as UserRole | undefined));
      } catch (err: any) {
        toast({ title: err?.message || "Google sign-in failed", variant: "destructive" });
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleStatus]);

  const onGoogle = () => {
    // Persist the remember choice so it survives the full-page redirect to Google.
    localStorage.setItem("uniliv_remember", remember ? "1" : "0");
    window.location.assign(`/api/auth/google?remember=${remember ? "1" : "0"}`);
  };

  const googleError = googleErrorCode
    ? (({
        google_denied: "This Google account isn't authorized to sign in. Please contact your administrator.",
        google_domain: "Please sign in with your UNILIV Google Workspace account.",
        google_failed: "Google sign-in didn't complete. Please try again.",
      } as Record<string, string>)[googleErrorCode] ?? "Google sign-in didn't complete. Please try again.")
    : null;

  const backToLogin = () => { setView("login"); setCode(""); setChallenge(null); };

  const Eyebrow = () => <div className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Secure access</div>;

  return (
    <div className="min-h-screen w-full flex bg-[#0a0706] text-white">
      {/* ── Left brand panel ── */}
      <div className="hidden lg:flex w-1/2 relative overflow-hidden flex-col justify-between p-14 bg-[#0e0a08]">
        <div className="absolute inset-0" style={{ background: "radial-gradient(58% 50% at 26% 64%, rgba(232,96,44,0.17), transparent 70%)" }} />
        <div className="absolute inset-0" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px)", backgroundSize: "46px 46px", WebkitMaskImage: "radial-gradient(72% 72% at 32% 50%, black, transparent)", maskImage: "radial-gradient(72% 72% at 32% 50%, black, transparent)" }} />
        <div className="absolute inset-0" style={{ background: "linear-gradient(120deg, rgba(0,0,0,0) 38%, rgba(0,0,0,0.45))" }} />

        <div className="relative z-10">
          <img src="/brand/uniliv-logo.svg" alt="Uniliv" className="h-10 w-auto select-none" draggable={false} />
          <div className="mt-2.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/45">Property operations platform</div>
        </div>

        <div className="relative z-10 max-w-md">
          <h1 className="font-display text-5xl font-bold leading-[1.04] tracking-tight text-white">Property ops,<br />made clear.</h1>
          <p className="mt-5 text-lg text-white/55">Residents, complaints, food and finance — every property in one secure place.</p>
          <div className="mt-9 grid grid-cols-3 gap-3">
            {[{ k: "Properties", v: "Live view" }, { k: "Complaints", v: "SLA-tracked" }, { k: "Food", v: "Zero waste" }].map((f) => (
              <div key={f.k} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-white/40">{f.k}</div>
                <div className="mt-1 text-sm font-semibold text-white">{f.v}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-10 inline-flex items-center gap-2 text-sm text-white/40">
          <ShieldCheck className="w-4 h-4" /> Secured with two-factor authentication
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-5 sm:p-8">
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.035] p-7 sm:p-9 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl">
          <div className="lg:hidden mb-6 flex items-center justify-center">
            <img src="/brand/uniliv-logo.svg" alt="Uniliv" className="h-9 w-auto select-none" draggable={false} />
          </div>

          {reason && (
            <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/90">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-400" />
              <span>
                {reason === "replaced"
                  ? "You were signed out because your account was signed in on another device. Only one active session is allowed at a time."
                  : "Your session has expired. Please sign in again."}
              </span>
            </div>
          )}

          {googleError && (
            <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100/90">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-red-400" />
              <span>{googleError}</span>
            </div>
          )}

          {view === "login" && (
            <>
              <div className="space-y-1.5 mb-6">
                <Eyebrow />
                <h2 className="font-display text-3xl font-bold text-white">Welcome back</h2>
                <p className="text-sm text-white/55">Sign in to manage properties, residents, complaints and food operations.</p>
              </div>

              {googleReady && (
                <>
                  <button type="button" onClick={onGoogle} disabled={busy} className="w-full h-12 rounded-xl border border-white/10 bg-white/[0.05] hover:bg-white/[0.09] text-white text-sm font-medium inline-flex items-center justify-center gap-2.5 transition-colors disabled:opacity-60 disabled:pointer-events-none">
                    <FcGoogle className="h-5 w-5" /> Continue with Google
                  </button>

                  <div className="my-5 flex items-center gap-3">
                    <div className="h-px flex-1 bg-white/10" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-white/35">or continue with email</span>
                    <div className="h-px flex-1 bg-white/10" />
                  </div>
                </>
              )}

              <form onSubmit={onLogin} className="space-y-4">
                <div>
                  <label htmlFor="identifier" className={LABEL}>Email or Username</label>
                  <div className="relative">
                    <User className={ICON} />
                    <input id="identifier" autoFocus placeholder="Enter your email or username" className={INPUT}
                      value={identifier} onChange={(e) => setIdentifier(e.target.value)} data-testid="input-identifier" />
                  </div>
                </div>
                <div>
                  <label htmlFor="password" className={LABEL}>Password</label>
                  <div className="relative">
                    <Lock className={ICON} />
                    <input id="password" type={showPassword ? "text" : "password"} placeholder="Enter your password" className={`${INPUT} pr-10`}
                      value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-password" />
                    <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition-colors">
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-0.5">
                  <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer select-none">
                    <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 rounded border-white/20 bg-white/5 accent-[#E8602C]" />
                    Remember me
                  </label>
                  <button type="button" className={LINK} onClick={() => { setRecoverId(identifier); setView("forgot-password"); }}>Forgot password?</button>
                </div>
                <button type="submit" disabled={busy} className={PRIMARY} data-testid="button-submit-login">
                  {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <>Sign in <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" /></>}
                </button>
              </form>

              <p className="mt-6 text-center text-sm text-white/45">
                Can't remember your username?{" "}
                <button type="button" className={LINK} onClick={() => { setRecoverPhone(""); setView("forgot-username"); }}>Recover it</button>
              </p>
            </>
          )}

          {view === "otp" && challenge && (
            <div>
              <button onClick={backToLogin} className={BACK}><ArrowLeft className="w-4 h-4" /> Back</button>
              <div className="mt-5 space-y-1.5">
                <Eyebrow />
                <h2 className="font-display text-2xl font-bold text-white flex items-center gap-2"><Smartphone className="w-5 h-5 text-accent" /> Verify it's you</h2>
                <p className="text-sm text-white/55">We sent a 6-digit code to <span className="font-medium text-white">{challenge.maskedPhone}</span></p>
              </div>
              <div className="flex justify-center py-7">
                <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={(v) => onVerify(v)} data-testid="input-otp">
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} className="h-12 w-11 text-lg bg-white/[0.05] border-white/15 text-white" />)}
                  </InputOTPGroup>
                </InputOTP>
              </div>
              <button onClick={() => onVerify()} disabled={busy || code.length < 6} className={PRIMARY} data-testid="button-verify-otp">
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : "Verify"}
              </button>
              <div className="mt-5 text-center text-sm text-white/45">
                Didn't get it?{" "}
                <button className={`${LINK} disabled:text-white/30 disabled:no-underline`} disabled={resend.seconds > 0} onClick={onResend}>
                  {resend.seconds > 0 ? `Resend in ${resend.seconds}s` : "Resend code"}
                </button>
              </div>
            </div>
          )}

          {view === "forgot-username" && (
            <div>
              <button onClick={backToLogin} className={BACK}><ArrowLeft className="w-4 h-4" /> Back to sign in</button>
              <div className="mt-5 space-y-1.5 mb-6">
                <Eyebrow />
                <h2 className="font-display text-2xl font-bold text-white">Find your username</h2>
                <p className="text-sm text-white/55">Enter your registered mobile number and we'll send a verification code.</p>
              </div>
              <form onSubmit={onForgotUsername} className="space-y-4">
                <div>
                  <label htmlFor="recover-phone" className={LABEL}>Registered mobile number</label>
                  <div className="relative">
                    <Smartphone className={ICON} />
                    <input id="recover-phone" autoFocus inputMode="numeric" placeholder="9876500000" className={INPUT} value={recoverPhone} onChange={(e) => setRecoverPhone(e.target.value)} />
                  </div>
                </div>
                <button type="submit" disabled={busy || !recoverPhone} className={PRIMARY}>{busy ? <Loader2 className="w-5 h-5 animate-spin" /> : "Send code"}</button>
              </form>
            </div>
          )}

          {view === "email-sent" && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent/15"><Mail className="h-6 w-6 text-accent" /></div>
              <Eyebrow />
              <h2 className="mt-1 font-display text-2xl font-bold text-white">Check your email</h2>
              <p className="mt-1.5 text-sm text-white/55">
                We've sent a secure link{sentTo ? <> to <span className="font-medium text-white">{sentTo}</span></> : ""}. Open it to continue — it works once and expires shortly.
              </p>
              <button className={`${PRIMARY} mt-6`} onClick={backToLogin}>Back to sign in</button>
            </div>
          )}

          {view === "forgot-password" && (
            <div>
              <button onClick={backToLogin} className={BACK}><ArrowLeft className="w-4 h-4" /> Back to sign in</button>
              <div className="mt-5 space-y-1.5 mb-6">
                <Eyebrow />
                <h2 className="font-display text-2xl font-bold text-white">Reset your password</h2>
                <p className="text-sm text-white/55">Enter your username or email — we'll send a code to your registered mobile.</p>
              </div>
              <form onSubmit={onForgotPassword} className="space-y-4">
                <div>
                  <label htmlFor="recover-id" className={LABEL}>Email or Username</label>
                  <div className="relative">
                    <Mail className={ICON} />
                    <input id="recover-id" autoFocus placeholder="Enter your email or username" className={INPUT} value={recoverId} onChange={(e) => setRecoverId(e.target.value)} />
                  </div>
                </div>
                <button type="submit" disabled={busy || !recoverId} className={PRIMARY}>{busy ? <Loader2 className="w-5 h-5 animate-spin" /> : "Send code"}</button>
              </form>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
