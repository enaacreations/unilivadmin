import { apiFetch } from "./api-fetch";

export type PushState = "unsupported" | "denied" | "subscribed" | "default";

export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** VAPID public keys are URL-safe base64; the Push API wants a Uint8Array. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function registerSW(): Promise<ServiceWorkerRegistration> {
  const base = import.meta.env.BASE_URL || "/";
  await navigator.serviceWorker.register(`${base}sw.js`);
  return navigator.serviceWorker.ready;
}

export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub ? "subscribed" : "default";
  } catch {
    return "default";
  }
}

/** Request permission, subscribe via the VAPID key, and register with the server. */
export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!isPushSupported()) return { ok: false, reason: "unsupported" };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: perm };

  const res = await apiFetch<{ data: { enabled: boolean; publicKey: string | null } }>("/push/vapid-public-key");
  if (!res.data.enabled || !res.data.publicKey) return { ok: false, reason: "server-disabled" };

  const reg = await registerSW();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(res.data.publicKey) as BufferSource,
  });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await apiFetch("/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }) });
  return { ok: true };
}

export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await apiFetch("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {
    /* best-effort */
  }
}
