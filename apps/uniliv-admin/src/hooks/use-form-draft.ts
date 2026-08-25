import * as React from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";
import { useMe } from "@/lib/use-permissions";
import {
  deleteRemoteDraft,
  fetchRemoteDraft,
  omitFields,
  readLocalDraft,
  removeLocalDraft,
  saveRemoteDraft,
  writeLocalDraft,
} from "@/lib/form-drafts";

/**
 * Autosave a react-hook-form and restore it after the app is closed and reopened.
 *
 * Lifecycle, once the form is `enabled` and `ready`:
 *  1. **Baseline** — snapshot `getValues()`. That is whatever the host form just
 *     reset to (blank for create, the record for edit), and it is the thing a
 *     draft is compared against. Values identical to the baseline are "nothing
 *     typed yet" and never get stored.
 *  2. **Restore** — read the local and server drafts, keep the newer, and if it
 *     differs from the baseline apply it and flip `restored`. The host renders a
 *     dismissible notice off that flag; `discardDraft()` puts the baseline back.
 *  3. **Save** — every change writes localStorage synchronously and schedules a
 *     debounced server write, also flushed when the tab is hidden.
 *
 * Call `clearDraft()` after a successful submit — the draft has become the saved
 * record and must not resurface the next time the form opens.
 *
 * `ready` matters for forms that `reset()` from an async query: pass the loaded
 * flag so the baseline isn't snapshotted (and a restore isn't clobbered) before
 * the record lands.
 */
export interface UseFormDraftOptions<V extends FieldValues, E> {
  /**
   * Stable identity of *this form for this record* — "vendor-form:new",
   * `vendor-form:${id}`. Null/undefined disables the hook entirely.
   */
  key: string | null | undefined;
  /** Whether the form is live; typically a modal's `open`. Defaults to true. */
  enabled?: boolean;
  /** Hold off until the host has finished its own async `reset()`. Defaults to true. */
  ready?: boolean;
  /** Field names never written to storage (files, one-time secrets). */
  omit?: readonly string[];
  /** Non-RHF state to persist alongside the fields (wizard step, chip arrays, …). */
  extra?: E;
  /** Re-apply persisted `extra` on restore. `discardDraft()` calls it with the baseline. */
  onRestoreExtra?: (extra: E | undefined) => void;
  /**
   * Fired with the restored values, just before they are applied. Two uses:
   * arming a one-shot guard for effects that derive one field from another (they
   * fire on the restored values too and would overwrite them), and pushing values
   * into editors that hold their own copy of the state — a rich-text editor won't
   * repaint just because the form field behind it changed.
   */
  onRestore?: (values: V) => void;
  /** Debounce before the server write. Default 1200ms. */
  debounceMs?: number;
}

export interface UseFormDraftResult {
  /** True once a draft has been applied and the user hasn't acknowledged it yet. */
  restored: boolean;
  /** When the restored draft was last saved (epoch ms), for the notice's timestamp. */
  restoredAt: number | null;
  /** Acknowledge the notice, keeping the restored values. */
  dismissRestored: () => void;
  /** Throw the draft away and put the baseline values back. */
  discardDraft: () => void;
  /** Delete the draft without touching the form — call after a successful submit. */
  clearDraft: () => void;
}

export function useFormDraft<V extends FieldValues, E = undefined>(
  form: UseFormReturn<V>,
  options: UseFormDraftOptions<V, E>,
): UseFormDraftResult {
  const {
    key,
    enabled = true,
    ready = true,
    omit,
    extra,
    onRestoreExtra,
    onRestore,
    debounceMs = 1200,
  } = options;

  const { data: me } = useMe();
  const userId = me?.data?.id ?? null;
  const active = !!key && !!userId && enabled;

  const [restored, setRestored] = React.useState(false);
  const [restoredAt, setRestoredAt] = React.useState<number | null>(null);

  // Values captured at step 1, and the gate that lets step 3 start. Refs, not
  // state: the save subscription reads them and must not be re-created per edit.
  const baselineRef = React.useRef<V | null>(null);
  // `extra` is often an array/object, so "untouched" can't be an === check
  // against undefined — it is compared as JSON against its own baseline.
  const extraBaselineRef = React.useRef<E | undefined>(undefined);
  const extraBaselineJsonRef = React.useRef<string>("null");
  const loadedRef = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = React.useRef<{ values: unknown; extra: unknown } | null>(null);

  // `extra` and the restore callback change identity every render; the effects
  // below read them through refs so they don't re-subscribe on each keystroke.
  const extraRef = React.useRef<E | undefined>(extra);
  extraRef.current = extra;
  const onRestoreExtraRef = React.useRef(onRestoreExtra);
  onRestoreExtraRef.current = onRestoreExtra;
  const onRestoreRef = React.useRef(onRestore);
  onRestoreRef.current = onRestore;
  const omitRef = React.useRef(omit);
  omitRef.current = omit;

  /** Send whatever the debounce is holding, right now. */
  const flushRemote = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending && key) {
      pendingRef.current = null;
      void saveRemoteDraft(key, pending.values, pending.extra);
    }
  }, [key]);

  /* — Steps 1 & 2: baseline, then restore the newer of local/server — */
  React.useEffect(() => {
    if (!active || !ready || !key || !userId) return;
    let cancelled = false;

    // Snapshot before anything async, so a keystroke during the fetch can't
    // become the baseline.
    const baseline = form.getValues();
    baselineRef.current = baseline;
    extraBaselineRef.current = extraRef.current;
    extraBaselineJsonRef.current = JSON.stringify(extraRef.current ?? null);

    (async () => {
      const local = readLocalDraft<Partial<V>, E>(userId, key);
      const remote = await fetchRemoteDraft<Partial<V>, E>(key);
      if (cancelled) return;

      const draft =
        local && remote ? (local.savedAt >= remote.savedAt ? local : remote) : (local ?? remote);

      // Open the save gate no matter what — a form with no draft still needs to
      // start recording one.
      loadedRef.current = true;
      if (!draft?.values) return;

      const baselineComparable = omitFields(baseline as Record<string, unknown>, omitRef.current);
      const draftComparable = omitFields(draft.values as Record<string, unknown>, omitRef.current);
      const sameAsBaseline =
        JSON.stringify(draftComparable) === JSON.stringify(baselineComparable) &&
        JSON.stringify(draft.extra ?? null) === extraBaselineJsonRef.current;
      if (sameAsBaseline) return;

      // Omitted fields were never stored, so take them from the baseline rather
      // than blanking them out.
      const merged = { ...baseline, ...(draft.values as Partial<V>) } as V;
      // Host hooks run *before* the reset, so any guard they arm is in place for
      // the effects the reset sets off.
      onRestoreRef.current?.(merged);
      form.reset(merged);
      if (draft.extra !== undefined) onRestoreExtraRef.current?.(draft.extra);
      setRestored(true);
      setRestoredAt(draft.savedAt);
    })();

    return () => {
      cancelled = true;
    };
    // `form` is a stable RHF instance; re-running on it would reload mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ready, key, userId]);

  /**
   * Write one snapshot: localStorage now, server on a debounce. Shared by the
   * field subscription and the `extra` effect so both agree on what "untouched"
   * means — otherwise toggling a chip back to its starting state would leave a
   * draft behind that pops a restore notice on the next open.
   */
  const persist = React.useCallback(
    (values: unknown) => {
      // Never write before the restore pass has run, or the empty defaults would
      // land on top of the draft we are about to read.
      if (!loadedRef.current || !key || !userId) return;

      const kept = omitFields(values as Record<string, unknown>, omitRef.current);
      const currentExtra = extraRef.current;
      const baselineComparable = omitFields(
        (baselineRef.current ?? {}) as Record<string, unknown>,
        omitRef.current,
      );
      const untouched =
        JSON.stringify(kept) === JSON.stringify(baselineComparable) &&
        JSON.stringify(currentExtra ?? null) === extraBaselineJsonRef.current;

      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      if (untouched) {
        // Back at square one (or the user cleared everything) — drop the draft
        // instead of storing a no-op that would trigger a restore notice later.
        removeLocalDraft(userId, key);
        pendingRef.current = null;
        void deleteRemoteDraft(key);
        return;
      }

      writeLocalDraft(userId, key, { values: kept, extra: currentExtra, savedAt: Date.now() });

      pendingRef.current = { values: kept, extra: currentExtra };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const p = pendingRef.current;
        if (!p) return;
        pendingRef.current = null;
        void saveRemoteDraft(key, p.values, p.extra);
      }, debounceMs);
    },
    [key, userId, debounceMs],
  );

  /* — Step 3: persist on every field change — */
  React.useEffect(() => {
    if (!active || !key || !userId) return;

    const sub = form.watch((values) => persist(values));

    // Closing the app is the case this whole feature exists for: getting the
    // debounced server write out before the tab dies is what makes the draft
    // available on the *next* device rather than only in this browser.
    const onHide = () => {
      if (document.visibilityState === "hidden") flushRemote();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushRemote);

    return () => {
      sub.unsubscribe();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushRemote);
      flushRemote();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, userId, debounceMs, flushRemote]);

  /* — `extra` lives outside RHF, so changes to it need their own trigger — */
  const extraSignature = JSON.stringify(extra ?? null);
  React.useEffect(() => {
    if (!active) return;
    persist(form.getValues());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraSignature, active, persist]);

  /* — Reset the per-open flags when the form closes, so reopening re-restores — */
  React.useEffect(() => {
    if (active) return;
    loadedRef.current = false;
    baselineRef.current = null;
    extraBaselineRef.current = undefined;
    extraBaselineJsonRef.current = "null";
    setRestored(false);
    setRestoredAt(null);
  }, [active]);

  const clearDraft = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    // Block the watch subscription from immediately re-saving the values that
    // are still sitting in the form while the modal animates closed.
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
    if (baseline) form.reset(baseline);
    // Back to what the host had before the draft landed — for a create form
    // that's the empty state, for an edit form the record's own values.
    onRestoreExtraRef.current?.(extraBaselineRef.current);
    // Recording can resume from the baseline the user just went back to.
    loadedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearDraft]);

  const dismissRestored = React.useCallback(() => setRestored(false), []);

  return { restored, restoredAt, dismissRestored, discardDraft, clearDraft };
}
