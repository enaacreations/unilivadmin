import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { accessApi, accessKeys, type PrivilegeSet } from "@/lib/access-api";
import { UamSeg } from "./shell";
import { UamSelect } from "./select";
import "./uam.css";

/**
 * Create or edit a privilege SET — a named group of permissions.
 *
 * ── Why editing is the dangerous half ─────────────────────────────────────
 * A set is a LIVE reference: assigning it stores a pointer, and the resolver
 * expands it on every request. So adding a permission here gives it to everyone
 * already holding the set, with no further action by anybody. That is the
 * feature — when "Night audit cover" gains a permission, the people covering the
 * night audit get it — and it is also the way somebody quietly widens access to
 * a dozen people while believing they edited a list.
 *
 * Hence the reach is stated next to the save button, not buried in a toast
 * afterwards, and the confirmation names the number. Same treatment a role edit
 * gets, for the same reason.
 */
export function PrivilegeSetSheet({ set, onClose }: { set: PrivilegeSet | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const editing = set != null;

  const [name, setName] = React.useState(set?.name ?? "");
  const [description, setDescription] = React.useState(set?.description ?? "");
  const [effect, setEffect] = React.useState<"GRANT" | "DENY">(set?.effect ?? "GRANT");
  const [isActive, setIsActive] = React.useState(set?.isActive ?? true);
  const [items, setItems] = React.useState<Array<{ functionality: string; action: string }>>(
    () => (set?.items ?? []).map((i) => ({ functionality: i.functionality, action: i.action })),
  );
  /**
   * The functionalities currently expanded for picking.
   *
   * Seeded from what the set already contains, so editing opens on the parts it
   * is actually made of instead of an empty picker the reader has to reconstruct.
   */
  const [open, setOpen] = React.useState<string[]>(
    () => [...new Set((set?.items ?? []).map((i) => i.functionality))],
  );

  const manifest = useQuery({ queryKey: accessKeys.manifest(), queryFn: accessApi.manifest });
  /**
   * WHO holds this set, by name.
   *
   * A count answers "is this risky?"; the names answer "is it risky for anyone
   * I should ask first?". Editing a live reference changes these people's access
   * the moment it saves, so they are worth reading before the form, not after.
   */
  const holders = useQuery({
    queryKey: accessKeys.setHolders(set?.id ?? ""),
    queryFn: () => accessApi.setHolders(set!.id),
    enabled: !!set && set.holders > 0,
  });
  const functionalities = manifest.data?.functionalities ?? [];
  const modules = manifest.data?.modules ?? [];
  const moduleLabel = (key: string) => modules.find((m) => m.key === key)?.label ?? key;

  const has = (f: string, a: string) => items.some((i) => i.functionality === f && i.action === a);
  const toggle = (f: string, a: string) =>
    setItems((prev) =>
      has(f, a) ? prev.filter((i) => !(i.functionality === f && i.action === a)) : [...prev, { functionality: f, action: a }],
    );

  /** The chosen permissions, grouped by module for the summary. */
  const grouped = React.useMemo(() => {
    const by = new Map<string, Array<{ i: { functionality: string; action: string }; f?: typeof functionalities[number]; a?: { key: string; label: string; description: string; id: string } }>>();
    for (const i of items) {
      const f = functionalities.find((x) => x.key === i.functionality);
      const a = f?.actions.find((x) => x.key === i.action);
      const mod = moduleLabel(f?.module ?? "—");
      by.set(mod, [...(by.get(mod) ?? []), { i, f, a }]);
    }
    return [...by.entries()];
  }, [items, functionalities, modules]);

  /** "3 modules · 5 functionalities" — the shape of the set at a glance. */
  const summary = React.useMemo(() => {
    const fns = new Set(items.map((i) => i.functionality));
    const mods = new Set(
      items.map((i) => functionalities.find((x) => x.key === i.functionality)?.module ?? "—"),
    );
    if (!items.length) return undefined;
    return `${mods.size} ${mods.size === 1 ? "module" : "modules"} · ${fns.size} ${fns.size === 1 ? "functionality" : "functionalities"}`;
  }, [items, functionalities]);

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), description: description.trim(), effect, items };
      return editing
        ? accessApi.updatePrivilegeSet(set!.id, { ...body, isActive })
        : accessApi.createPrivilegeSet(body);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: accessKeys.privilegeSets() });
      // Every holder's resolved access may have changed, so the screens that
      // show it are stale — including a person's page open in another tab.
      qc.invalidateQueries({ queryKey: ["access"] });
      const reached = (r as { holders?: number }).holders ?? 0;
      toast({
        variant: "success",
        title: editing ? "Set updated" : "Set created",
        description:
          editing && reached > 0
            ? `${reached} ${reached === 1 ? "person" : "people"} holding this set ${reached === 1 ? "has" : "have"} the new permissions now.`
            : `${items.length} ${items.length === 1 ? "permission" : "permissions"} in this set.`,
      });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const ready = name.trim().length >= 3 && description.trim().length >= 8 && items.length > 0;

  return (
    <div className="uam fixed inset-0 z-50 flex justify-end" style={{ background: "var(--scrim)" }} onClick={onClose}>
      <aside
        className="uam-sheet uam-sheet-enter flex h-full w-full max-w-[560px] flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="flex flex-col gap-1">
            <span className="uam-kicker">{editing ? "Edit set" : "Create Set"}</span>
            <span className="uam-title" style={{ fontSize: 18 }}>
              {editing ? set!.name : "Group permissions that belong together"}
            </span>
          </div>
          <button onClick={onClose} className="uam-btn h-8 w-8 justify-center border-transparent p-0">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          {editing && set!.holders > 0 && (
            // Stated before the form, not after the save. Somebody editing a set
            // needs to know it is not a private list before they change it.
            <div className="flex flex-col gap-2 rounded-[var(--r)] p-3 text-[13px]" style={{ background: "var(--sunk)", border: "1px solid var(--warn)" }}>
              <span>
                <strong className="font-semibold">{set!.holders}</strong>{" "}
                {set!.holders === 1 ? "person holds" : "people hold"} this set. Anything you add here, they get —
                anything you remove, they lose.
              </span>
              {holders.data && holders.data.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {holders.data.map((h) => (
                    <span
                      key={h.assignmentId}
                      className="uam-chip"
                      // A ROLE assignment reaches everyone in it, so the chip
                      // says which kind of subject it is rather than reading as
                      // one more person.
                      title={h.subjectType === "ROLE" ? "Everyone holding this role" : h.email ?? undefined}
                    >
                      {h.subjectType === "ROLE" ? `Role: ${h.name ?? h.subjectId}` : h.name ?? h.subjectId}
                      {h.nodeId ? " · at one place" : ""}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <Field label="Name" hint="What people will pick it by.">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Night audit cover"
              className="uam-input h-10 px-3 text-[14px]"
            />
          </Field>

          <Field label="What it is for" hint="Shown wherever the set is offered, so somebody can choose it without opening it.">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Lets somebody run the overnight audit while the regular auditor is away."
              rows={2}
              className="uam-input px-3 py-2 text-[14px]"
            />
          </Field>

          <Field label="Gives or takes away" hint="One direction for the whole set.">
            <UamSeg
              value={effect}
              onChange={(v) => setEffect(v as "GRANT" | "DENY")}
              options={[
                { value: "GRANT", label: "Enable" },
                { value: "DENY", label: "Disable" },
              ]}
            />
          </Field>

          <Field
            label="What is in it"
            hint="Add as many functionalities as you like — a set can mix actions from different modules."
          >
            {/* Picking ADDS rather than replaces.
                A set exists precisely because the permissions somebody needs do
                not sit in one place: covering the night audit is an audit
                action, a dispatch action and a ledger read. A single-select
                picker made that possible but invisible — you had to discover
                that switching functionality kept your earlier ticks. */}
            <UamSelect
              value=""
              onChange={(v) => v && setOpen((prev) => (prev.includes(v) ? prev : [...prev, v]))}
              placeholder="Add a functionality…"
              searchPlaceholder="Search across every module…"
              emptyText="No functionality by that name."
              options={functionalities
                .filter((f) => !open.includes(f.key))
                .map((f) => ({ value: f.key, label: f.label, hint: moduleLabel(f.module), group: moduleLabel(f.module) }))}
            />

            {open.length === 0 && (
              <p className="m-0 text-[12.5px]" style={{ color: "var(--ink3)" }}>
                Nothing added yet. Search above for the first functionality.
              </p>
            )}

            <div className="flex flex-col gap-2">
              {open.map((fk) => {
                const f = functionalities.find((x) => x.key === fk);
                if (!f) return null;
                const picked = items.filter((i) => i.functionality === fk).length;
                return (
                  <div key={fk} className="uam-card overflow-hidden">
                    <div
                      className="flex flex-wrap items-center gap-2 px-3 py-2"
                      style={{ background: "var(--sunk)", borderBottom: "1px solid var(--line)" }}
                    >
                      <span className="text-[13px] font-semibold">{f.label}</span>
                      <span className="text-[11.5px]" style={{ color: "var(--ink3)" }}>{moduleLabel(f.module)}</span>
                      <span className="ml-auto text-[11.5px]" style={{ color: picked ? "var(--accent)" : "var(--ink3)" }}>
                        {picked} of {f.actions.length}
                      </span>
                      <button
                        onClick={() => {
                          // Removing the functionality removes its permissions
                          // too — leaving them behind would put ticks in the set
                          // that nothing on screen accounts for.
                          setOpen((prev) => prev.filter((k) => k !== fk));
                          setItems((prev) => prev.filter((i) => i.functionality !== fk));
                        }}
                        className="uam-btn h-7 w-7 justify-center border-transparent p-0"
                        title={`Remove ${f.label} and its permissions`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="flex flex-col px-3">
                      {f.actions.map((a, i) => {
                        const id = `set-item-${f.key}-${a.key}`;
                        return (
                          <label
                            key={a.key}
                            htmlFor={id}
                            className="flex items-start gap-2.5 py-2"
                            style={i ? { borderTop: "1px solid var(--line)", cursor: "pointer" } : { cursor: "pointer" }}
                          >
                            <input
                              id={id}
                              type="checkbox"
                              checked={has(f.key, a.key)}
                              onChange={() => toggle(f.key, a.key)}
                              style={{ width: 16, height: 16, marginTop: 2, accentColor: "var(--accent)" }}
                            />
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <span className="flex flex-wrap items-baseline gap-x-2">
                                <span className="text-[14px]">{a.label}</span>
                                <span className="text-[11.5px]" style={{ color: "var(--ink3)", fontFamily: "var(--mono)" }}>
                                  {a.id}
                                </span>
                              </span>
                              {/* The one line saying what it allows, beside the
                                  box — this is the sentence somebody is
                                  agreeing to. */}
                              <span className="text-[12.5px]" style={{ color: "var(--ink3)" }}>{a.description}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </Field>

          {items.length > 0 && (
            <Field label={`In this set (${items.length})`} hint={summary}>
              {/* Grouped by module, because a set that spans several is exactly
                  the case worth reading carefully before it is handed out. A
                  flat row of chips makes "Edit property" and "Edit vendor" look
                  like the same decision. */}
              <div className="flex flex-col gap-2">
                {grouped.map(([mod, rows]) => (
                  <div key={mod} className="flex flex-col gap-1">
                    <span className="text-[11.5px] uppercase tracking-[0.04em]" style={{ color: "var(--ink3)" }}>
                      {mod}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {rows.map(({ i, f, a }) => (
                        <button
                          key={`${i.functionality}:${i.action}`}
                          onClick={() => toggle(i.functionality, i.action)}
                          className="uam-chip uam-chip-on"
                          title={a ? `${a.id} — ${a.description}` : `${i.functionality}.${i.action}`}
                        >
                          {f ? `${f.label}: ` : ""}{a?.label ?? i.action} <X className="ml-1 inline h-3 w-3" />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Field>
          )}

          {editing && (
            <Field label="Status" hint="Disabling stops the set granting, without unpicking who holds it.">
              <UamSeg
                value={isActive ? "on" : "off"}
                onChange={(v) => setIsActive(v === "on")}
                options={[
                  { value: "on", label: "Enabled" },
                  { value: "off", label: "Disabled" },
                ]}
              />
            </Field>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 px-5 py-4" style={{ borderTop: "1px solid var(--line)" }}>
          <span className="text-[12.5px]" style={{ color: "var(--ink3)" }}>
            {editing && set!.holders > 0
              ? `Reaches ${set!.holders} ${set!.holders === 1 ? "person" : "people"}`
              : "A set grants nothing until it is assigned"}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="uam-btn h-10 px-4 text-[14px]">Cancel</button>
            <button
              onClick={() => save.mutate()}
              disabled={!ready || save.isPending}
              className="uam-btn uam-btn-primary h-10 gap-1.5 px-4 text-[14px]"
            >
              <Check className="h-4 w-4" />
              {save.isPending ? "Saving…" : editing ? "Save set" : "Create set"}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {/* A <div>, not a <label>: a <button> is labelable, so a <label> here
          forwards a click on the heading to the first control inside — which is
          how clicking a field name came to open its dropdown. */}
      <div className="text-[13.5px] font-semibold">
        {label}
        {hint && <span className="ml-1.5 text-[12.5px] font-normal" style={{ color: "var(--ink3)" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}
