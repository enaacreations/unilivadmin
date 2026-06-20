const TOKEN_KEY = "uniliv_token";
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY);
/** Persist a (refreshed) token to whichever storage the "remember me" choice implies. */
function persistToken(token: string): void {
  const remember = localStorage.getItem("uniliv_remember") !== "0";
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  (remember ? sessionStorage : localStorage).removeItem(TOKEN_KEY);
}
function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

function loginPath(): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  return `${base}/login` || "/login";
}

let redirecting = false;
/** Session is unrecoverable — drop the token and bounce to login, optionally
 *  with a `reason` ("replaced" | "expired") the login screen explains to the user. */
export function redirectToLogin(reason?: string): void {
  clearToken();
  const path = loginPath();
  if (redirecting || window.location.pathname === path) return;
  redirecting = true;
  window.location.assign(reason ? `${path}?reason=${reason}` : path);
}

// A single in-flight refresh shared by every concurrent 401 (avoids a storm
// of refreshes when the whole page's queries 401 at once after token expiry).
let refreshPromise: Promise<string | null> | null = null;
/** Renew the access token using the httpOnly refresh cookie. Returns the new token, or null. */
export function refreshSession(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    })
      .then(async (r) => {
        if (!r.ok) return null;
        const j = await r.json().catch(() => null);
        const t = j?.accessToken as string | undefined;
        if (t) { persistToken(t); return t; }
        return null;
      })
      .catch(() => null)
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

/** Recover from a 401: refresh silently; if that fails, go to login. True if a fresh token is now available. */
export async function handleUnauthorized(): Promise<boolean> {
  const t = await refreshSession();
  if (t) return true;
  redirectToLogin("expired");
  return false;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const doFetch = (token: string | null) =>
    fetch(`/api${path}`, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });

  let res = await doFetch(getToken());

  // 401 on a protected endpoint. If the session was replaced (logged in elsewhere),
  // don't bother refreshing — go straight to login. Otherwise try to renew once.
  if (res.status === 401 && !path.startsWith("/auth/")) {
    const body = await res.clone().json().catch(() => null);
    if (body?.code === "SESSION_REPLACED") {
      redirectToLogin("replaced");
      throw new Error(body?.error || "Signed in on another device. Please sign in again.");
    }
    const token = await refreshSession();
    if (token) {
      res = await doFetch(token);
    } else {
      redirectToLogin("expired");
      throw new Error("Your session has expired. Please sign in again.");
    }
  }

  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.success === false)) {
    throw new Error(json?.error || `Request failed (${res.status})`);
  }
  return json as T;
}

/**
 * Fetches a binary file from the API with the auth header and triggers a
 * browser download. `path` is an absolute "/api/..." URL (as returned by the
 * *ExportUrl helpers). Throws on a non-OK response.
 */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const download = (token: string | null) =>
    fetch(path, {
      credentials: "include",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });

  let res = await download(getToken());
  if (res.status === 401) {
    const token = await refreshSession();
    if (token) res = await download(token);
    else { redirectToLogin("expired"); throw new Error("Your session has expired. Please sign in again."); }
  }
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try { const j = await res.json(); msg = j?.error || msg; } catch { /* binary */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
