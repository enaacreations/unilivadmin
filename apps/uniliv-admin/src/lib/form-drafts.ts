import { apiFetch } from "./api-fetch";

/**
 * Draft persistence for in-progress forms — the storage half of `useFormDraft`.
 *
 * Two tiers, on purpose:
 *  - **localStorage** is synchronous, so it captures the very last keystroke even
 *    when the tab is killed. It is the fast path and the offline path.
 *  - **the server** (`/api/form-drafts`) is written on a debounce and is what
 *    makes a draft survive a cleared browser or follow the user to a second
 *    device.
 *
 * On load both are read and the newer `savedAt` wins. Every local key is
 * namespaced by user id so two people sharing a machine never inherit each
 * other's half-typed form; `clearLocalDrafts()` wipes them all at logout.
 *
 * Note on sensitivity: these payloads mirror whatever the form holds, which for
 * resident/employee/vendor forms includes PII and bank fields. Anything a form
 * shouldn't leave sitting in web storage must be listed in the hook's `omit`.
 */

const PREFIX = "uniliv_draft:";

export interface DraftEnvelope<V = unknown, E = unknown> {
  values: V;
  extra?: E;
  /** Epoch ms of the last local write; used to pick a winner against the server copy. */
  savedAt: number;
}

/** localStorage key for one user's draft of one form. */
function storageKey(userId: string, formKey: string): string {
  return `${PREFIX}${userId}:${formKey}`;
}

/* ── Local tier ──────────────────────────────────────────────────────────── */

export function readLocalDraft<V, E>(userId: string, formKey: string): DraftEnvelope<V, E> | null {
  try {
    const raw = localStorage.getItem(storageKey(userId, formKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftEnvelope<V, E>;
    // A hand-edited or half-written entry is treated as no draft rather than
    // being handed to form.reset(), which would throw deep inside RHF.
    if (!parsed || typeof parsed !== "object" || typeof parsed.savedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLocalDraft<V, E>(
  userId: string,
  formKey: string,
  envelope: DraftEnvelope<V, E>,
): void {
  try {
    localStorage.setItem(storageKey(userId, formKey), JSON.stringify(envelope));
  } catch {
    // Quota exceeded or storage disabled (private mode). Autosave is a
    // convenience — never let it break the form the user is typing into.
  }
}

export function removeLocalDraft(userId: string, formKey: string): void {
  try {
    localStorage.removeItem(storageKey(userId, formKey));
  } catch {
    /* ignore */
  }
}

/** Drop every draft in this browser. Called on logout so the next user starts clean. */
export function clearLocalDrafts(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/* ── Server tier ─────────────────────────────────────────────────────────── */

interface ServerDraftRow {
  formKey: string;
  payload: { values: unknown; extra?: unknown } | null;
  updatedAt: string;
}

/**
 * The server's copy of a draft, or null when there is none. Never throws: a
 * failed lookup degrades to "no remote draft" and the local copy is used.
 */
export async function fetchRemoteDraft<V, E>(formKey: string): Promise<DraftEnvelope<V, E> | null> {
  try {
    const res = await apiFetch<{ data: ServerDraftRow | null }>(
      `/form-drafts?key=${encodeURIComponent(formKey)}`,
    );
    const row = res?.data;
    if (!row?.payload) return null;
    return {
      values: row.payload.values as V,
      extra: row.payload.extra as E,
      savedAt: new Date(row.updatedAt).getTime(),
    };
  } catch {
    return null;
  }
}

/** Push a draft to the server. Never throws — the local copy already succeeded. */
export async function saveRemoteDraft(formKey: string, values: unknown, extra: unknown): Promise<void> {
  try {
    await apiFetch("/form-drafts", {
      method: "PUT",
      body: JSON.stringify({ key: formKey, payload: { values, extra } }),
    });
  } catch {
    /* ignore — localStorage still holds the draft */
  }
}

/** Delete a draft server-side. Never throws. */
export async function deleteRemoteDraft(formKey: string): Promise<void> {
  try {
    await apiFetch(`/form-drafts?key=${encodeURIComponent(formKey)}`, { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

/* ── Shared helpers ──────────────────────────────────────────────────────── */

/** Strip `omit` fields from a values object before it is persisted anywhere. */
export function omitFields<V extends Record<string, unknown>>(
  values: V,
  omit: readonly string[] | undefined,
): Partial<V> {
  if (!omit?.length) return values;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!omit.includes(k)) out[k] = v;
  }
  return out as Partial<V>;
}
