import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { accessApi, accessKeys, type ManifestModule, type RoleDetail } from "@/lib/access-api";
import { UamEmpty } from "./shell";
import { PermissionList, type PermissionSection } from "./permission-list";
import { UamSelect } from "./select";
import "./uam.css";

/**
 * What a role allows — readable by default, editable in place.
 *
 * ── The shape of this screen IS the access model ──────────────────────────
 * A card is a MODULE ("Audits"). Inside it, a row is a FUNCTIONALITY ("Audit
 * register"), and a chip is an ACTION on that functionality ("see", "approve").
 * That is the whole vocabulary, and a role is granted at the middle level: which
 * functionalities of which modules, and which actions on each.
 *
 * This screen previously drew the 54 functionalities as flat cards and called
 * their actions "functionalities" — which is why "what can a Cluster Manager do
 * in Audits" took scrolling to answer. Grouping by module means the reader scans
 * ten cards and opens one.
 *
 * The read view is the one people look at, so it stays the primary: what the role
 * CAN do in words, and — the half a permission list always drops — what it is not
 * included in. Editing turns the same rows into toggles rather than opening a
 * separate screen, so the thing being changed never moves. Functionalities the
 * role does not touch are added deliberately from a picker instead of rendering
 * all fifty-odd at once: a wall of empty checkboxes is not an easier way to
 * answer "what should a Night Warden do".
 *
 * ── Why the guards are not mirrored here ─────────────────────────────────
 * The server refuses seven distinct classes of matrix change (system roles,
 * protected functionalities, out-ranking, privilege amplification, self-demotion,
 * separation of duties, and locking everyone out of access administration).
 * Re-implementing those in the browser would be a second copy of the rule that
 * can drift from the one that is enforced. The editor instead lets the change
 * be attempted and shows the server's own sentence, which names the reason.
 * Only the two that are properties of the data — a computed role, and a
 * protected functionality — are marked up front, because those never change per
 * actor.
 */
export function WhatItAllows({ role, modules }: { role: RoleDetail; modules: ManifestModule[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = React.useState(false);
  /** functionality key → the actions held on it. The stored, enforced unit. */
  const [held, setHeld] = React.useState<Map<string, Set<string>>>(new Map());
  const [reason, setReason] = React.useState("");
  const [adding, setAdding] = React.useState("");

  // The matrix version is the concurrency token: the save is refused if anyone
  // else changed the matrix since this screen loaded.
  const matrix = useQuery({
    queryKey: accessKeys.matrix(role.key),
    queryFn: () => accessApi.matrix(role.key),
    enabled: editing,
  });

  /** Flat lookup for a functionality's metadata, from the manifest tree. */
  const meta = React.useMemo(() => {
    const m = new Map<string, { label: string; module: string; actions: string[]; protected: boolean }>();
    for (const mod of modules) {
      for (const f of mod.functionalities) {
        m.set(f.key, { label: f.label, module: mod.key, actions: f.actions.map((a) => a.key), protected: f.protected });
      }
    }
    return m;
  }, [modules]);

  const original = React.useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of role.permissions) {
      const s = m.get(p.functionality) ?? new Set<string>();
      s.add(p.action);
      m.set(p.functionality, s);
    }
    return m;
  }, [role.permissions]);

  const startEditing = () => {
    setHeld(new Map([...original].map(([k, v]) => [k, new Set(v)])));
    setReason("");
    setAdding("");
    setEditing(true);
  };

  const changes = React.useMemo(() => {
    const out: Array<{ roleKey: string; functionality: string; action: string; allowed: boolean }> = [];
    const seen = new Set([...original.keys(), ...held.keys()]);
    for (const f of seen) {
      const was = original.get(f) ?? new Set<string>();
      const now = held.get(f) ?? new Set<string>();
      for (const a of now) if (!was.has(a)) out.push({ roleKey: role.key, functionality: f, action: a, allowed: true });
      for (const a of was) if (!now.has(a)) out.push({ roleKey: role.key, functionality: f, action: a, allowed: false });
    }
    return out;
  }, [original, held, role.key]);

  const save = useMutation({
    mutationFn: () =>
      accessApi.saveMatrix({
        version: matrix.data!.version,
        reason: reason.trim(),
        changes,
      }),
    onSuccess: (d) => {
      toast({
        variant: "success",
        title: "What it allows was changed",
        description: `${d.applied} change${d.applied === 1 ? "" : "s"} saved, and on the activity trail.`,
      });
      void qc.invalidateQueries({ queryKey: ["access"] });
      setEditing(false);
    },
    onError: (e) => toast({ title: "Refused", description: (e as Error).message, variant: "destructive" }),
  });

  const shown = editing ? held : original;

  /**
   * The held functionalities, grouped into their modules and in manifest order.
   *
   * Driven by `modules` rather than by the held map, so the sections always come
   * out in the same order regardless of what the role happens to hold — a list
   * whose order depends on the data is one nobody can scan twice.
   */
  const sections = React.useMemo(
    () =>
      modules
        .map((mod) => ({
          module: mod,
          rows: mod.functionalities
            .filter((f) => shown.has(f.key))
            .map((f) => ({ f, actions: shown.get(f.key)! })),
        }))
        .filter((s) => s.rows.length > 0),
    [modules, shown],
  );

  /**
   * The same sections as grid input. Read and edit differ only in whether the
   * ticks are clickable — they used to be a sentence and a row of long chips,
   * two languages for one table.
   */
  const permissionSections = React.useMemo<PermissionSection[]>(
    () =>
      sections.map(({ module: mod, rows }) => ({
        key: mod.key,
        label: mod.label,
        hint: mod.description,
        count: `${rows.length} of ${mod.functionalities.length}`,
        groups: rows.map(({ f, actions }) => {
          // The functionality's OWN permissions, from the manifest — there is no
          // module-wide column set to lay over them any more. A stored action the
          // manifest no longer names is still listed (inManifest: false), because
          // a grant nobody can see is a grant nobody will remove.
          const defined = meta.get(f.key)?.actions ?? [];
          const keys = [...new Set([...defined, ...actions])];
          return {
            key: f.key,
            label: f.label,
            locked: meta.get(f.key)?.protected,
            cells: Object.fromEntries(
              keys.map((a) => [a, { inManifest: defined.includes(a), on: actions.has(a) }]),
            ),
          };
        }),
      })),
    [sections, meta],
  );

  /** Functionalities the role does not touch at all, for the picker. */
  const untouched = React.useMemo(
    () => modules.flatMap((mod) => mod.functionalities.filter((f) => !shown.has(f.key)).map((f) => ({ f, mod }))),
    [modules, shown],
  );

  /** Modules the role holds nothing in — named in one sentence, not fifty rows. */
  const untouchedModules = React.useMemo(
    () => modules.filter((mod) => !mod.functionalities.some((f) => shown.has(f.key))),
    [modules, shown],
  );

  /* ── Read ──────────────────────────────────────────────────────────── */
  if (!editing) {
    return (
      <>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[13.5px]" style={{ color: "var(--ink3)" }}>
            {role.computed
              ? "Worked out by rule, so it cannot be edited."
              : "What everyone holding this role can do, everywhere they work."}
          </span>
          {!role.computed && !role.isSystem && (
            <button onClick={startEditing} className="uam-btn h-9 px-3.5 text-[14px]">Edit Permissions</button>
          )}
        </div>

        {original.size === 0 ? (
          <UamEmpty
            title="This role allows nothing yet"
            text="Someone holding only this role can sign in and see nothing. Give it something to do."
            action={
              role.computed || role.isSystem ? undefined : (
                <button onClick={startEditing} className="uam-btn h-9 px-3.5 text-[14px]">Edit Permissions</button>
              )
            }
          />
        ) : (
          <>
            <PermissionList sections={permissionSections} readOnly />
            {untouchedModules.length > 0 && (
              <p className="uam-lede m-0 text-[14px]">
                Nothing at all in {untouchedModules.map((m) => m.label).join(", ")}. People who need those get
                another role, or a privilege.
              </p>
            )}
          </>
        )}
      </>
    );
  }

  /* ── Edit ──────────────────────────────────────────────────────────── */
  const toggle = (functionality: string, action: string) => {
    setHeld((prev) => {
      const next = new Map([...prev].map(([k, v]) => [k, new Set(v)]));
      const s = next.get(functionality) ?? new Set<string>();
      if (s.has(action)) s.delete(action); else s.add(action);
      next.set(functionality, s);
      return next;
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="uam-badge uam-badge-warn">Editing</span>
        <span className="text-[13.5px]" style={{ color: "var(--ink2)" }}>
          Tick a permission to turn it on or off. Nothing is saved until you say so.
        </span>
      </div>

      <PermissionList
        sections={permissionSections}
        onToggle={(functionality: string, action: string) => toggle(functionality, action)}
      />

      {untouched.length > 0 && (
        <div className="flex max-w-[360px] flex-col gap-2">
          <span className="text-[13.5px] font-semibold">
            Add a functionality
            <span className="ml-1.5 text-[12.5px] font-normal" style={{ color: "var(--ink3)" }}>
              {untouched.length} the role does not touch yet
            </span>
          </span>
          {/* Grouped by module, so the picker reads as "what in Audits is
              missing" rather than as an alphabet of fifty keys. */}
          <UamSelect
            value={adding}
            onChange={(k) => {
              if (!k) return;
              setHeld((prev) => new Map(prev).set(k, new Set()));
              setAdding("");
            }}
            placeholder="Pick a functionality…"
            searchPlaceholder="Search functionalities…"
            emptyText="Nothing by that name."
            options={untouched.map(({ f, mod }) => ({
              value: f.key,
              label: f.label,
              group: mod.label,
              hint: f.protected ? "restricted" : undefined,
            }))}
          />
        </div>
      )}

      <div
        className="sticky bottom-0 flex flex-wrap items-center gap-2.5 rounded-[var(--r)] p-3.5"
        style={{ background: "var(--sunk)", border: "1px solid var(--line)" }}
      >
        <span className="text-[13.5px] font-semibold">
          {changes.length === 0
            ? "No changes yet"
            : `${changes.length} change${changes.length === 1 ? "" : "s"}`}
        </span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why — one sentence, it goes on the trail"
          className="uam-input h-9 min-w-[220px] flex-1"
        />
        <button onClick={() => setEditing(false)} className="uam-btn h-9 px-3.5">Cancel</button>
        <button
          disabled={changes.length === 0 || reason.trim().length < 4 || !matrix.data || save.isPending}
          onClick={() => save.mutate()}
          className="uam-btn uam-btn-primary h-9 px-3.5"
        >
          {save.isPending ? "Saving…" : "Update Permissions"}
        </button>
      </div>

      {changes.length > 0 && (
        <p className="uam-lede m-0 text-[13.5px]">
          This reaches {role.holders.length === 1 ? "1 person" : `${role.holders.length} people`} the moment it is
          saved.
        </p>
      )}
    </>
  );
}
