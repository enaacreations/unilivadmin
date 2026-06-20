import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuthStore } from "@/lib/store";
import { apiFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { can, type UserRole } from "@/lib/permissions";
import { ArrowLeft, Eye, EyeOff, Loader2, ShieldCheck, Smartphone, UtensilsCrossed } from "lucide-react";

/** Where to land a user after login, based on what their role can actually view. */
function homeForRole(role?: string): string {
  const r = role as UserRole | undefined;
  if (can(r, "DASHBOARD", "view")) return "/";
  if (can(r, "FOOD_DASHBOARD", "view")) return "/food/dashboard";
  return "/";
}

type View = "login" | "otp" | "forgot-username" | "forgot-password" | "reset" | "username-result";
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
    apiFetch<{ data: { username: string } }>("/auth/forgot-username/verify", { method: "POST", body: JSON.stringify({ challengeId, code }) }),
  forgotPassword: (identifier: string) =>
    apiFetch<{ data: ChallengeData }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ identifier }) }),
  forgotPasswordVerify: (challengeId: string, code: string) =>
    apiFetch<{ data: { verificationToken: string } }>("/auth/forgot-password/verify", { method: "POST", body: JSON.stringify({ challengeId, code }) }),
  resetPassword: (verificationToken: string, newPassword: string) =>
    apiFetch<{ success: boolean }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ verificationToken, newPassword }) }),
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

export default function Login() {
  const [, setLocation] = useLocation();
  const { setToken } = useAuthStore();
  const { toast } = useToast();

  const [view, setView] = useState<View>("login");
  const [busy, setBusy] = useState(false);

  // login
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // otp
  const [flow, setFlow] = useState<OtpFlow>("LOGIN");
  const [challenge, setChallenge] = useState<ChallengeData | null>(null);
  const [code, setCode] = useState("");
  const resend = useCountdown();

  // recovery
  const [recoverPhone, setRecoverPhone] = useState("");
  const [recoverId, setRecoverId] = useState("");
  const [resultUsername, setResultUsername] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");

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
        setToken(res.accessToken);
        toast({ title: `Welcome back, ${res.user?.name?.split(" ")[0] ?? ""}`.trim() });
        setLocation(homeForRole(res.user?.role));
      } else if (flow === "FORGOT_USERNAME") {
        const res = await auth.forgotUsernameVerify(challenge.challengeId, c);
        setResultUsername(res.data.username);
        setView("username-result");
      } else {
        const res = await auth.forgotPasswordVerify(challenge.challengeId, c);
        setResetToken(res.data.verificationToken);
        setView("reset");
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

  const onReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) { toast({ title: "Password must be at least 8 characters", variant: "destructive" }); return; }
    setBusy(true);
    try {
      await auth.resetPassword(resetToken, newPassword);
      toast({ title: "Password updated — please sign in" });
      setView("login"); setPassword(""); setNewPassword("");
    } catch (err: any) {
      toast({ title: err?.message || "Reset failed", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const backToLogin = () => { setView("login"); setCode(""); setChallenge(null); };

  return (
    <div className="min-h-screen w-full flex bg-background">
      {/* Brand panel */}
      <div className="hidden lg:flex w-1/2 bg-primary text-primary-foreground flex-col justify-between p-12 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: "radial-gradient(circle at 2px 2px, white 1px, transparent 0)", backgroundSize: "32px 32px" }} />
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 rounded bg-accent flex items-center justify-center text-accent-foreground font-display font-bold text-xl shadow-lg">U</div>
          <span className="font-display font-bold text-xl tracking-tight">Uniliv Admin</span>
        </div>
        <div className="relative z-10 max-w-md">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary-foreground/10 px-3 py-1 text-xs font-medium mb-6">
            <UtensilsCrossed className="w-3.5 h-3.5" /> Food Ordering & Kitchen Operations
          </div>
          <h1 className="text-4xl font-display font-bold tracking-tight mb-4 leading-tight">
            The operations command center for co-living
          </h1>
          <p className="text-primary-foreground/70 text-lg">
            Place orders, coordinate kitchens, track every dispatch and cut food wastage — from one secure, unified portal.
          </p>
        </div>
        <div className="relative z-10 flex items-center gap-2 text-sm text-primary-foreground/50">
          <ShieldCheck className="w-4 h-4" /> Secured with two-factor authentication
        </div>
      </div>

      {/* Form panel */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8 bg-surface">
        <div className="w-full max-w-md space-y-8">
          <div className="lg:hidden w-12 h-12 rounded bg-accent flex items-center justify-center text-accent-foreground font-display font-bold text-xl shadow-lg mx-auto">U</div>

          {view === "login" && (
            <>
              <div className="space-y-2">
                <h2 className="text-3xl font-display font-bold tracking-tight text-primary">Welcome back</h2>
                <p className="text-muted-foreground">Sign in with your username or email to continue</p>
              </div>
              <form onSubmit={onLogin} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="identifier">Username or Email</Label>
                  <Input id="identifier" autoFocus placeholder="unitlead1 or you@uniliv.com" className="h-11"
                    value={identifier} onChange={(e) => setIdentifier(e.target.value)} data-testid="input-identifier" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">Password</Label>
                    <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={() => { setRecoverId(identifier); setView("forgot-password"); }}>
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <Input id="password" type={showPassword ? "text" : "password"} placeholder="••••••••" className="h-11 pr-10"
                      value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-password" />
                    <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <Button type="submit" className="w-full h-11 text-base font-semibold" disabled={busy} data-testid="button-submit-login">
                  {busy && <Loader2 className="w-5 h-5 animate-spin mr-2" />} Continue
                </Button>
                <button type="button" className="w-full text-center text-sm text-muted-foreground hover:text-foreground" onClick={() => { setRecoverPhone(""); setView("forgot-username"); }}>
                  Forgot your username?
                </button>
              </form>
            </>
          )}

          {view === "otp" && challenge && (
            <div className="space-y-6">
              <button onClick={backToLogin} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <div className="space-y-2">
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center"><Smartphone className="w-6 h-6 text-accent" /></div>
                <h2 className="text-2xl font-display font-bold tracking-tight text-primary">Verify it's you</h2>
                <p className="text-muted-foreground">We sent a 6-digit code to <span className="font-medium text-foreground">{challenge.maskedPhone}</span></p>
              </div>
              <div className="flex justify-center py-2">
                <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={(v) => onVerify(v)} data-testid="input-otp">
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} className="h-12 w-11 text-lg" />)}
                  </InputOTPGroup>
                </InputOTP>
              </div>
              {challenge.devOtp && (
                <div className="text-center text-xs text-muted-foreground bg-muted rounded-md py-2">
                  Dev code (test mode): <span className="font-mono font-semibold text-foreground tracking-wider">{challenge.devOtp}</span>
                </div>
              )}
              <Button className="w-full h-11" disabled={busy || code.length < 6} onClick={() => onVerify()} data-testid="button-verify-otp">
                {busy && <Loader2 className="w-5 h-5 animate-spin mr-2" />} Verify
              </Button>
              <div className="text-center text-sm text-muted-foreground">
                Didn't get it?{" "}
                <button className="font-medium text-accent hover:underline disabled:text-muted-foreground disabled:no-underline" disabled={resend.seconds > 0} onClick={onResend}>
                  {resend.seconds > 0 ? `Resend in ${resend.seconds}s` : "Resend code"}
                </button>
              </div>
            </div>
          )}

          {view === "forgot-username" && (
            <div className="space-y-6">
              <button onClick={backToLogin} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /> Back to sign in</button>
              <div className="space-y-2">
                <h2 className="text-2xl font-display font-bold tracking-tight text-primary">Find your username</h2>
                <p className="text-muted-foreground">Enter your registered mobile number and we'll send a verification code.</p>
              </div>
              <form onSubmit={onForgotUsername} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="recover-phone">Registered mobile number</Label>
                  <Input id="recover-phone" autoFocus placeholder="9876500000" className="h-11" value={recoverPhone} onChange={(e) => setRecoverPhone(e.target.value)} />
                </div>
                <Button type="submit" className="w-full h-11" disabled={busy || !recoverPhone}>{busy && <Loader2 className="w-5 h-5 animate-spin mr-2" />} Send code</Button>
              </form>
            </div>
          )}

          {view === "username-result" && (
            <div className="space-y-6 text-center">
              <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto"><ShieldCheck className="w-6 h-6 text-success" /></div>
              <div className="space-y-2">
                <h2 className="text-2xl font-display font-bold tracking-tight text-primary">Your username</h2>
                <p className="text-muted-foreground">Use this to sign in.</p>
              </div>
              <div className="text-xl font-mono font-semibold text-foreground bg-muted rounded-lg py-4">{resultUsername}</div>
              <Button className="w-full h-11" onClick={() => { setIdentifier(resultUsername); backToLogin(); }}>Continue to sign in</Button>
            </div>
          )}

          {view === "forgot-password" && (
            <div className="space-y-6">
              <button onClick={backToLogin} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /> Back to sign in</button>
              <div className="space-y-2">
                <h2 className="text-2xl font-display font-bold tracking-tight text-primary">Reset your password</h2>
                <p className="text-muted-foreground">Enter your username or email — we'll send a code to your registered mobile.</p>
              </div>
              <form onSubmit={onForgotPassword} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="recover-id">Username or Email</Label>
                  <Input id="recover-id" autoFocus placeholder="unitlead1 or you@uniliv.com" className="h-11" value={recoverId} onChange={(e) => setRecoverId(e.target.value)} />
                </div>
                <Button type="submit" className="w-full h-11" disabled={busy || !recoverId}>{busy && <Loader2 className="w-5 h-5 animate-spin mr-2" />} Send code</Button>
              </form>
            </div>
          )}

          {view === "reset" && (
            <div className="space-y-6">
              <div className="space-y-2">
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center"><ShieldCheck className="w-6 h-6 text-accent" /></div>
                <h2 className="text-2xl font-display font-bold tracking-tight text-primary">Set a new password</h2>
                <p className="text-muted-foreground">Choose a strong password of at least 8 characters.</p>
              </div>
              <form onSubmit={onReset} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="new-password">New password</Label>
                  <div className="relative">
                    <Input id="new-password" autoFocus type={showPassword ? "text" : "password"} placeholder="••••••••" className="h-11 pr-10" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                    <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <Button type="submit" className="w-full h-11" disabled={busy || newPassword.length < 8}>{busy && <Loader2 className="w-5 h-5 animate-spin mr-2" />} Update password</Button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
