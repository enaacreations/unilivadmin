import { useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { apiFetch } from "@/lib/api-fetch";
import { Loader2, UserRound } from "lucide-react";

const PRIMARY = "w-full h-12 rounded-xl bg-accent text-white text-sm font-semibold inline-flex items-center justify-center gap-2 shadow-[0_10px_34px_-10px_rgba(232,96,44,0.75)] hover:bg-accent/90 active:scale-[0.99] transition disabled:opacity-60 disabled:pointer-events-none";

/** Public page opened from the emailed recovery link: /recover-username/:token */
export default function RecoverUsernamePage() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const token = (params as Record<string, string>).token;

  const [username, setUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // single-use token: redeem exactly once
    ran.current = true;
    (async () => {
      try {
        const res = await apiFetch<{ data: { username: string | null } }>("/auth/recover-username", { method: "POST", body: JSON.stringify({ token }) });
        setUsername(res.data?.username ?? null);
      } catch (err: any) {
        setError(err?.message || "This link is invalid or has expired. Please request a new one.");
      } finally { setLoading(false); }
    })();
  }, [token]);

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#0a0706] text-white p-5">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.035] p-7 sm:p-9 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl text-center">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Secure access</div>
        {loading ? (
          <div className="flex flex-col items-center gap-2 py-8 text-white/55">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-sm">Retrieving your username…</span>
          </div>
        ) : error ? (
          <>
            <h1 className="mt-1 font-display text-2xl font-bold">Link unavailable</h1>
            <p className="mt-1.5 text-sm text-white/55">{error}</p>
            <button onClick={() => setLocation("/login")} className={`${PRIMARY} mt-6`}>Back to sign in</button>
          </>
        ) : (
          <>
            <div className="mx-auto my-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent/15"><UserRound className="h-6 w-6 text-accent" /></div>
            <h1 className="font-display text-2xl font-bold">Your username</h1>
            <p className="mt-1.5 text-sm text-white/55">Use this to sign in.</p>
            <div className="my-5 rounded-xl border border-white/10 bg-white/[0.05] py-4 text-xl font-mono font-semibold text-white break-all px-4">{username ?? "—"}</div>
            <button onClick={() => setLocation("/login")} className={PRIMARY}>Continue to sign in</button>
          </>
        )}
      </div>
    </div>
  );
}
