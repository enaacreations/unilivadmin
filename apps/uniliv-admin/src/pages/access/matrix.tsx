import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { accessApi, accessKeys, type ManifestModule } from "@/lib/access-api";
import { ScreenHeader, Badge, Cell, type CellState } from "./ui";
import { useCan } from "@/components/access/can";

/**
 * Permission matrix — "Who can do this?"
 *
 * The scale problem, solved by inverting the axes: 22 roles × 53 modules × 13
 * actions is ~15,000 cells, and no grid survives that. Pivoting to ONE MODULE
 * at a time puts every role beneath it — about forty cells, all of them about
 * the same question. You never see the other 14,960.
 *
 * Changes stage locally and save as one batch against the version the screen
 * loaded, so two admins editing at once conflict rather than silently
 * overwrite. Every save carries a reason and lands on the tamper-evident chain.
 */

const ACTION_ABBR: Record<string, string> = {
  view: "vw", create: "cr", edit: "ed", delete: "dl", submit: "sb",
  approve: "ap", reject: "rj", assign: "as", complete: "cp", verify: "vf",
  export: "ex", download: "dn", configure: "cf",
};

type Staged = Map<string, boolean>; // "roleKey|module|action" -> allowed
const stageKey = (r: string, m: string, a: string) => `${r}|${m}|${a}`;

export default function MatrixScreen() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = React.useState<string>("");
  const [modFilter, setModFilter] = React.useState("");
  const [staged, setStaged] = React.useState<Staged>(new Map());
  const [showSave, setShowSave] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [refusal, setRefusal] = React.useState<{ kind: string; title: string; why: string } | null>(null);
  const [conflict, setConflict] = React.useState<{ yours: number; current: number } | null>(null);

  const canConfigure = useCan("ACCESS_CONTROL", "configure");
  const manifest = useQuery({ queryKey: accessKeys.manifest(), queryFn: accessApi.manifest });
  const roles = useQuery({ queryKey: accessKeys.roles(), queryFn: accessApi.roles });
  const matrix = useQuery({ queryKey: accessKeys.matrix(), queryFn: () => accessApi.matrix() });

  const modules = manifest.data?.modules ?? [];
  React.useEffect(() => {
    if (!selected && modules.length) setSelected(modules[0]!.key);
  }, [modules, selected]);

  const mod: ManifestModule | undefined = modules.find((m) => m.key === selected);

  /** Held cells, indexed for O(1) lookup while rendering ~40 cells. */
  const held = React.useMemo(() => {
    const s = new Set<string>();
    for (const c of matrix.data?.cells ?? []) s.add(stageKey(c.roleKey, c.module, c.action));
    return s;
  }, [matrix.data]);

  const computedRoles = React.useMemo(
    () => new Set((roles.data ?? []).filter((r) => r.computed).map((r) => r.key)),
    [roles.data],
  );

  /** Module picker, grouped by family and filtered. */
  const picker = React.useMemo(() => {
    const needle = modFilter.trim().toUpperCase();
    const byFamily = new Map<string, ManifestModule[]>();
    for (const m of modules) {
      if (needle && !m.label.toUpperCase().includes(needle) && !m.key.includes(needle)) continue;
      const list = byFamily.get(m.family) ?? [];
      list.push(m);
      byFamily.set(m.family, list);
    }
    return (manifest.data?.families ?? [...byFamily.keys()])
      .filter((f) => byFamily.has(f))
      .map((f) => ({ name: f, items: byFamily.get(f)! }));
  }, [modules, modFilter, manifest.data]);

  const cellState = (roleKey: string, action: string): CellState => {
    if (!mod) return "unavailable";
    // Without ACCESS_CONTROL:configure the grid is a read-only view. Rendering
    // cells as editable and failing on save would be a worse way to find out.
    if (!canConfigure) return held.has(stageKey(roleKey, mod.key, action)) ? "held" : "not-held";
    if (mod.protected) return "protected";
    if (computedRoles.has(roleKey)) return "inherited";
    const k = stageKey(roleKey, mod.key, action);
    if (staged.has(k)) return staged.get(k) ? "held" : "not-held";
    return held.has(k) ? "held" : "not-held";
  };

  const toggleCell = (roleKey: string, action: string) => {
    if (!mod) return;
    const k = stageKey(roleKey, mod.key, action);
    const current = staged.has(k) ? staged.get(k)! : held.has(k);
    const next = new Map(staged);
    // Toggling back to the stored value un-stages it, so the staged count is
    // net change rather than click count.
    if (held.has(k) === !current) next.delete(k);
    else next.set(k, !current);
    setStaged(next);
  };

  const stagedList = [...staged.entries()].map(([k, allowed]) => {
    const [roleKey, module, action] = k.split("|");
    return { roleKey: roleKey!, module: module!, action: action!, allowed };
  });

  const save = useMutation({
    mutationFn: () =>
      accessApi.saveMatrix({
        version: matrix.data?.version ?? 0,
        reason,
        changes: stagedList,
      }),
    onSuccess: (d) => {
      toast({ title: `Saved ${d.applied} change${d.applied === 1 ? "" : "s"}`, description: `Matrix is now v${d.version}.` });
      setStaged(new Map());
      setShowSave(false);
      setReason("");
      void qc.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (e) => {
      const err = e as { status?: number; details?: Record<string, unknown>; message?: string };
      const code = err.details?.["code"] as string | undefined;
      setShowSave(false);
      if (code === "STALE_MATRIX_VERSION") {
        setConflict({ yours: err.details?.["yours"] as number, current: err.details?.["current"] as number });
        return;
      }
      // Every guard returns a machine code plus a sentence; show the sentence,
      // and the rationale where the guard supplies one (SoD does).
      setRefusal({
        kind: (code ?? "REFUSED").replace(/_/g, " ").toLowerCase(),
        title: err.message ?? "That change was refused",
        why: (err.details?.["rationale"] as string) ?? "The change was rejected by a guard before anything was written.",
      });
    },
  });

  if (manifest.isLoading || roles.isLoading || matrix.isLoading) {
    return (
      <>
        <ScreenHeader kicker="Permission matrix" title="Who can do this?" />
        <div className="p-8"><Skeleton className="h-96 w-full rounded-xl" /></div>
      </>
    );
  }

  // Module roles (Auditor, Audit Viewer, …) are personas a GRANT names, not
  // capability holders — they own no cells, so a row of permanently empty
  // checkboxes would be worse than no row. They are configured on Grants.
  const roleRows = (roles.data ?? []).filter((r) => r.isActive !== false && !r.scopeModule);

  return (
    <>
      <ScreenHeader
        kicker="Permission matrix"
        title="Who can do this?"
        sub={`One module at a time, all ${roleRows.length} roles beneath it. Roughly 15,000 cells exist; you only ever look at forty.`}
        actions={
          <span className="font-mono text-[11px] text-[var(--muted)]">
            v{matrix.data?.version} · {matrix.data?.source === "db" ? "editable" : "code fallback"}
          </span>
        }
      />

      <div className="grid items-start [grid-template-columns:minmax(0,262px)_minmax(0,1fr)]">
        {/* ── Module picker ─────────────────────────────────────────── */}
        <div className="sticky top-0 max-h-screen min-h-[calc(100vh-128px)] overflow-auto border-r border-[var(--border)] bg-[var(--card)]">
          <div className="sticky top-0 border-b border-[var(--border)] bg-[var(--card)] p-3">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-[var(--muted)]" />
              <Input
                className="h-8 pl-7 text-[12.5px]"
                placeholder={`Search ${modules.length} modules…`}
                value={modFilter}
                onChange={(e) => setModFilter(e.target.value)}
              />
            </div>
          </div>
          <div className="px-2 pb-5 pt-1.5">
            {picker.map((g) => (
              <div key={g.name} className="mb-1.5">
                <div className="px-2 pb-1 pt-[7px] text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[var(--ink3)]">
                  {g.name}
                </div>
                {g.items.map((m) => {
                  const active = m.key === selected;
                  const n = (matrix.data?.cells ?? []).filter((c) => c.module === m.key).length;
                  return (
                    <button
                      key={m.key}
                      onClick={() => setSelected(m.key)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px]",
                        active ? "bg-[var(--coral-bg)] font-medium text-[var(--accent-strong)]" : "hover:bg-[var(--muted-bg)]",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{m.label}</span>
                      {m.protected && (
                        <span title="Protected — super admin only" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--pop)]" />
                      )}
                      <span className="font-mono text-[9.5px] text-[var(--ink3)]">{n}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* ── Grid ──────────────────────────────────────────────────── */}
        <div className="min-w-0 pb-32">
          {mod && (
            <>
              <div className="flex flex-wrap items-start gap-4 border-b border-[var(--border)] px-6 pb-4 pt-[18px]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-display text-[21px] font-semibold tracking-[-0.015em]">{mod.label}</h2>
                    {mod.protected && <Badge tone="violet">Protected</Badge>}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-[var(--muted)]">
                    {mod.key} · {mod.family} · {mod.actions.length} actions
                  </div>
                </div>
                <div className="ml-auto flex max-w-[420px] flex-wrap gap-3.5 text-[10.5px] text-[var(--muted)]">
                  <span className="flex items-center gap-1.5"><span className="h-3.5 w-3.5 rounded bg-[var(--accent)]" />held</span>
                  <span className="flex items-center gap-1.5"><span className="h-3.5 w-3.5 rounded border border-[var(--bd2)]" />not held</span>
                  <span className="flex items-center gap-1.5"><span className="hatch h-3.5 w-3.5 rounded border border-[var(--bd2)]" />inherited, never stored</span>
                </div>
              </div>

              {mod.protected && (
                <div className="mx-6 mt-4 rounded-[11px] border border-[var(--pop)] bg-[var(--violet-bg)] px-4 py-3 text-[12.5px] text-[var(--muted)] [text-wrap:pretty]">
                  <span className="font-semibold text-[var(--pop)]">This module is protected.</span>{" "}
                  Only the parity roles hold its cells, and those are computed rather than stored. Nothing here is editable — including by you.
                </div>
              )}

              {conflict && (
                <div className="mx-6 mt-4 flex items-start gap-3 rounded-[11px] border border-[var(--danger)] bg-[var(--danger-bg)] px-4 py-3.5">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--danger)]" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-semibold text-[var(--danger)]">Someone else saved while you were editing</div>
                    <div className="mt-1 text-[12.5px] text-[var(--muted)] [text-wrap:pretty]">
                      The matrix moved from <span className="font-mono">v{conflict.yours}</span> to{" "}
                      <span className="font-mono">v{conflict.current}</span>. Your staged changes were not applied.
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={() => { setConflict(null); void qc.invalidateQueries({ queryKey: ["access"] }); }}
                        className="rounded-lg bg-[var(--danger)] px-3 py-1.5 text-[12px] font-semibold text-white"
                      >
                        Reload their change
                      </button>
                      <button onClick={() => setConflict(null)} className="rounded-lg border border-[var(--bd2)] px-3 py-1.5 text-[12px]">
                        Keep mine staged
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {refusal && (
                <div className="mx-6 mt-4 rounded-[11px] border border-[var(--warning)] bg-[var(--warning-bg)] px-4 py-3.5">
                  <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--warning)]">
                    Refused — {refusal.kind}
                  </div>
                  <div className="mb-1 font-display text-[15.5px] font-semibold [text-wrap:pretty]">{refusal.title}</div>
                  <div className="max-w-[80ch] text-[12.5px] text-[var(--muted)] [text-wrap:pretty]">{refusal.why}</div>
                  <button onClick={() => setRefusal(null)} className="mt-3 rounded-lg border border-[var(--bd2)] px-3 py-1.5 text-[12px]">
                    Understood
                  </button>
                </div>
              )}

              <div className="mt-4 overflow-x-auto border-t border-[var(--border)]">
                <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-6 py-2">
                  <div className="min-w-[190px] flex-1 text-[10px] uppercase tracking-[0.06em] text-[var(--ink3)]">Role</div>
                  <div className="flex shrink-0 gap-1.5">
                    {mod.actions.map((a) => (
                      <div key={a} title={a} className="w-[26px] text-center font-mono text-[9px] uppercase text-[var(--ink3)]">
                        {ACTION_ABBR[a] ?? a.slice(0, 2)}
                      </div>
                    ))}
                  </div>
                </div>

                {roleRows.map((r) => (
                  <div key={r.key} className="flex items-center gap-3 border-b border-[var(--border)] px-6 py-2.5 last:border-b-0 hover:bg-[var(--muted-bg)]">
                    <div className="min-w-[190px] flex-1">
                      <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
                        <span className="truncate text-[13px] font-medium">{r.label}</span>
                        {r.computed && <Badge>computed</Badge>}
                      </div>
                      {/* The raw key is dropped: it is the label in SCREAMING_SNAKE,
                          so it repeats the line above it without adding anything.
                          Rank and holder count stay — they are what tells an admin
                          whether a change is theoretical or moves twelve people. */}
                      <div className="truncate font-mono text-[9.5px] text-[var(--ink3)]">
                        rank {r.rank} · {r.holders} {r.holders === 1 ? "holder" : "holders"}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {mod.actions.map((a) => (
                        <Cell
                          key={a}
                          state={cellState(r.key, a)}
                          mark={cellState(r.key, a) === "held" ? "✓" : ""}
                          title={`${r.label} · ${mod.key}:${a}`}
                          onClick={canConfigure ? () => toggleCell(r.key, a) : undefined}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Staged bar ──────────────────────────────────────────────── */}
      {staged.size > 0 && (
        <div className="fixed bottom-5 left-1/2 z-30 flex max-w-[calc(100vw-60px)] -translate-x-1/2 items-center gap-4 rounded-2xl border border-[var(--bd2)] bg-[var(--card)] py-2.5 pl-4 pr-3 shadow-[var(--overlay-shadow)]">
          <div className="min-w-0">
            <div className="font-display text-[13.5px] font-semibold">
              {staged.size} unsaved change{staged.size === 1 ? "" : "s"}
            </div>
            <div className="max-w-[46ch] truncate font-mono text-[11px] text-[var(--muted)]">
              {stagedList.slice(0, 3).map((s) => `${s.allowed ? "+" : "−"}${s.roleKey}:${s.action}`).join("  ")}
              {stagedList.length > 3 ? ` +${stagedList.length - 3}` : ""}
            </div>
          </div>
          <button onClick={() => setStaged(new Map())} className="rounded-[9px] border border-[var(--border)] px-3 py-2 text-[12.5px] text-[var(--muted)]">
            Discard
          </button>
          <button onClick={() => setShowSave(true)} className="rounded-[9px] bg-[var(--accent)] px-4 py-2 text-[12.5px] font-semibold text-white">
            Review &amp; save
          </button>
        </div>
      )}

      {/* ── Save dialog ─────────────────────────────────────────────── */}
      {showSave && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--scrim)] p-6">
          <div className="max-h-[88vh] w-[min(620px,100%)] overflow-auto rounded-2xl border border-[var(--bd2)] bg-[var(--card)] shadow-[var(--overlay-shadow)]">
            <div className="border-b border-[var(--border)] px-[22px] pb-3.5 pt-5">
              <div className="font-display text-[19px] font-semibold tracking-[-0.015em]">
                Save {staged.size} change{staged.size === 1 ? "" : "s"} to {mod?.label}
              </div>
              <div className="mt-1 text-[12.5px] text-[var(--muted)]">
                Written against <span className="font-mono">v{matrix.data?.version}</span> and appended to the access chain. Every save needs a reason.
              </div>
            </div>
            <div className="flex flex-col gap-1.5 px-[22px] py-4">
              {stagedList.map((s) => (
                <div key={`${s.roleKey}|${s.action}`} className="flex items-center gap-2.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[12.5px]">
                  <Badge tone={s.allowed ? "ok" : "danger"}>{s.allowed ? "grant" : "revoke"}</Badge>
                  <span className="font-mono text-[11.5px]">{s.module}:{s.action}</span>
                  <span className="ml-auto text-[11.5px] text-[var(--muted)]">{s.roleKey}</span>
                </div>
              ))}
            </div>
            <div className="px-[22px] pb-4">
              <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
                <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">Guard rails</div>
                <ul className="flex flex-col gap-1.5 text-[12.5px] text-[var(--muted)]">
                  <li>You may only grant a capability you hold yourself.</li>
                  <li>System roles are computed and cannot be edited.</li>
                  <li>Separation-of-duties pairs are refused with their rationale.</li>
                  <li>A change leaving nobody able to administer access is refused.</li>
                </ul>
              </div>
            </div>
            <div className="px-[22px] pb-5">
              <label className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
                Reason for this change (required)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Wardens now close complaints without a Unit Lead step — agreed in Ops review, 12 Sep."
                className="min-h-[74px] w-full resize-y rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[13px] outline-none"
              />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-[var(--border)] px-[22px] py-3">
              <span className="mr-auto text-[11.5px] text-[var(--muted)]">
                {reason.trim() ? "Recorded on the access chain." : "A reason is required."}
              </span>
              <button onClick={() => setShowSave(false)} className="rounded-[9px] border border-[var(--bd2)] px-3.5 py-2 text-[12.5px]">
                Cancel
              </button>
              <button
                disabled={!reason.trim() || save.isPending}
                onClick={() => save.mutate()}
                className={cn(
                  "rounded-[9px] px-4 py-2 text-[12.5px] font-semibold text-white",
                  reason.trim() && !save.isPending ? "bg-[var(--accent)]" : "cursor-not-allowed bg-[var(--bd2)]",
                )}
              >
                {save.isPending ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
