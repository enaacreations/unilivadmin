import * as React from "react";
import { useMe } from "@/lib/use-permissions";
import {
  deleteRemoteDraft,
  fetchRemoteDraft,
  readLocalDraft,
  removeLocalDraft,
  saveRemoteDraft,
  writeLocalDraft,
} from "@/lib/form-drafts";
import type { UseFormDraftResult } from "@/hooks/use-form-draft";

/**
 * `useFormDraft` for editors that hold their state in plain `useState` rather
 * than react-hook-form — which is the whole food module.
 *
 * Same two-tier storage, same lifecycle, same result shape. The one real
 * difference is the change signal: RHF hands `useFormDraft` a `watch()`
 * subscription for free, whereas here the caller passes its current value in on
 * every render and this hook diffs it. That makes `value` the contract — it has
 * to be the complete editable state, or whatever it leaves out won't come back.
 *
 * The debounce machinery below is deliberately not shared with `useFormDraft`.
 * The two differ in what "unchanged" means (a whole value here; fields plus an
 * `extra` bag and an `omit` list there), and a common abstraction would need to
 * be parameterised on precisely the part that differs.
 */
export interface UseStateDraftOptions<T> {
  /** Identity of this editor for this record — `dish-form:${id}`. Null disables. */
  key: string | null | undefined;
  /** Whether the editor is live; for a null-when-closed state, `!!value`. */
  enabled?: boolean;
  /** Hold off until the host has finished seeding `value` from an async read. */
  ready?: boolean;
  /** Apply a restored value. Also called by `discardDraft()` with the baseline. */
  onRestore: (value: T) => void;
  /** Debounce before the server write. Default 1200ms. */
  debounceMs?: number;
}

export function useStateDraft<T>(
  value: T,
  options: UseStateDraftOptions<T>,
): UseFormDraftResult {
  const { key, enabled = true, ready = true, onRestore, debounceMs = 1200 } = options;

  const { data: me } = useMe();
  const userId = me?.data?.id ?? null;
  const active = !!key && !!userId && enabled;

  const [restored, setRestored] = React.useState(false);
  const [restoredAt, setRestoredAt] = React.useState<number | null>(null);

  const baselineRef = React.useRef<T | null>(null);
  const baselineJsonRef = React.useRef<string>("null");
  const loadedRef = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = React.useRef<unknown>(null);

  const valueRef = React.useRef(value);
  valueRef.current = value;
  const onRestoreRef = React.useRef(onRestore);
  onRestoreRef.current = onRestore;

  /** Send whatever the debounce is holding, right now. */
  const flushRemote = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current !== null && key) {
      const p = pendingRef.current;
      pendingRef.current = null;
      void saveRemoteDraft(key, p, undefined);
    }
  }, [key]);

  /* — Baseline, then restore the newer of local/server — */
  React.useEffect(() => {
    if (!active || !ready || !key || !userId) return;
    let cancelled = false;

    const baseline = valueRef.current;
    baselineRef.current = baseline;
    baselineJsonRef.current = JSON.stringify(baseline ?? null);

    (async () => {
      const local = readLocalDraft<T, undefined>(userId, key);
      const remote = await fetchRemoteDraft<T, undefined>(key);
      if (cancelled) return;

      const draft =
        local && remote ? (local.savedAt >= remote.savedAt ? local : remote) : (local ?? remote);

      loadedRef.current = true;
      if (!draft || draft.values === undefined) return;
      // Identical to what the editor opened with — nothing was actually typed,
      // so restoring would only raise a notice about a no-op.
      if (JSON.stringify(draft.values ?? null) === baselineJsonRef.current) return;

      onRestoreRef.current(draft.values);
      setRestored(true);
      setRestoredAt(draft.savedAt);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ready, key, userId]);

  /* — Persist on every change to `value` — */
  const valueSignature = JSON.stringify(value ?? null);
  React.useEffect(() => {
    if (!active || !key || !userId || !loadedRef.current) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (valueSignature === baselineJsonRef.current) {
      // Back to the state the editor opened in — drop the draft rather than
      // store a no-op that would raise a restore notice on the next open.
      removeLocalDraft(userId, key);
      pendingRef.current = null;
      void deleteRemoteDraft(key);
      return;
    }

    writeLocalDraft(userId, key, { values: value, savedAt: Date.now() });
    pendingRef.current = value;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (pendingRef.current === null) return;
      const p = pendingRef.current;
      pendingRef.current = null;
      void saveRemoteDraft(key, p, undefined);
    }, debounceMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueSignature, active, key, userId, debounceMs]);

  /* — Closing the app is the case this exists for: get the debounced write out — */
  React.useEffect(() => {
    if (!active) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") flushRemote();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushRemote);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushRemote);
      flushRemote();
    };
  }, [active, flushRemote]);

  /* — Reset the per-open flags on close, so reopening re-restores — */
  React.useEffect(() => {
    if (active) return;
    loadedRef.current = false;
    baselineRef.current = null;
    baselineJsonRef.current = "null";
    setRestored(false);
    setRestoredAt(null);
  }, [active]);

  const clearDraft = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    // Stop the change effect re-saving the values still sitting in state while
    // the editor closes.
    loadedRef.current = false;
    setRestored(false);
    setRestoredAt(null);
    if (!key) return;
    if (userId) removeLocalDraft(userId, key);
    void deleteRemoteDraft(key);
  }, [key, userId]);

  const discardDraft = React.useCallback(() => {
    const baseline = baselineRef.current;
    clearDraft();
    if (baseline !== null) onRestoreRef.current(baseline);
    loadedRef.current = true;
  }, [clearDraft]);

  const dismissRestored = React.useCallback(() => setRestored(false), []);

  return { restored, restoredAt, dismissRestored, discardDraft, clearDraft };
}
