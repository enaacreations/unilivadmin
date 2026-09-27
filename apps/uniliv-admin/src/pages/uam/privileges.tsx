import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, FileText, Users2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { accessApi, accessKeys, type CataloguePermission, type PrivilegeSet } from "@/lib/access-api";
import { UamPage, UamEmpty } from "./shell";
import { UamSelect } from "./select";
import { SetPrivilegeSheet } from "./set-privilege";
import { PrivilegeSetSheet } from "./privilege-set-editor";
import "./uam.css";

/**
 * Privileges — what the system can grant at all, and the named bundles of it.
 *
 * Two questions, two tabs:
 *
 *   Privileges     every permission that EXISTS, with what grants it today.
 *                 This is the catalogue — the thing you search when somebody
 *                 asks "can we even let them do that?", and the thing that
 *                 shows a permission no role grants at all.
 *   Privilege sets the named bundles — "Night audit cover". The unit people
 *                 actually reason about, because nobody asks for
 *                 `audits.audit_execution.close_audit`; they ask for somebody to
 *                 cover the night audit, which is six permissions at once.
 *
 * Neither tab is a place access is GIVEN — that happens on a person or a role,
 * where there is a subject to give it to. Grant Privilege here opens the same
 * sheet the Users and Roles tabs open, with the subject still to be chosen.
 */
const TABS = ["Privileges", "Privilege sets"] as const;

export default function PrivilegesScreen() {
  const [tab, setTab] = React.useState<(typeof TABS)[number]>("Privileges");
  const [writing, setWriting] = React.useState(false);
  const [editingSet, setEditingSet] = React.useState<PrivilegeSet | "new" | null>(null);

  return (
    <UamPage
      kicker="Privileges · what can be granted"
      title="What can be granted?"
      lede="Every permission the system defines, and the named sets that bundle them. A privilege is how one person or one place differs from what their role gives."
      actions={
        <div className="flex gap-2">
          <button onClick={() => setEditingSet("new")} className="uam-btn h-10 gap-1.5 px-4 text-[14px]">
            <Plus className="h-4 w-4" /> Create Set
          </button>
          <button onClick={() => setWriting(true)} className="uam-btn uam-btn-primary h-10 gap-1.5 px-4 text-[14px]">
            <Plus className="h-4 w-4" /> Grant Privilege
          </button>
        </div>
      }
      width={980}
    >
      {/* aria-selected, not a class: that is what uam.css styles, and what a
          screen reader needs. The earlier `uam-tab-on` matched no rule at all,
          so these rendered as plain text with no active state. */}
      <div className="uam-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="uam-tab">
            {t}
          </button>
        ))}
      </div>

      {tab === "Privileges" ? <Catalogue /> : <Sets onEdit={setEditingSet} />}

      {writing && <SetPrivilegeSheet onClose={() => setWriting(false)} />}
      {editingSet && (
        <PrivilegeSetSheet
          set={editingSet === "new" ? null : editingSet}
          onClose={() => setEditingSet(null)}
        />
      )}
    </UamPage>
  );
}

/* ── Permissions ──────────────────────────────────────────────────────────── */

function Catalogue() {
  const [q, setQ] = React.useState("");
  const [module, setModule] = React.useState("");
  const [only, setOnly] = React.useState<"all" | "ungranted" | "exceptions">("all");

  const cat = useQuery({ queryKey: accessKeys.catalogue(), queryFn: accessApi.catalogue });
  const all = cat.data?.permissions ?? [];

  const modules = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of all) seen.set(p.module, p.moduleLabel);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [all]);

  const rows = all.filter((p) => {
    if (module && p.module !== module) return false;
    if (only === "ungranted" && p.roles.length) return false;
    if (only === "exceptions" && !p.exceptions) return false;
    if (!q.trim()) return true;
    const hay = `${p.id} ${p.label} ${p.description} ${p.functionalityLabel}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  if (cat.isLoading) return <Skeleton className="h-64 w-full" />;

  const ungranted = all.filter((p) => !p.roles.length).length;

  return (
    <div className="flex flex-col gap-3">
      {/* Not a decorative stat: a permission no role grants is either dead
          weight or something people need and have been working around. It is
          the one number on this screen worth acting on, so it is a filter. */}
      {ungranted > 0 && (
        <button
          onClick={() => setOnly(only === "ungranted" ? "all" : "ungranted")}
          className="uam-card flex items-center gap-2 px-4 py-2.5 text-left text-[13.5px]"
          style={only === "ungranted" ? { borderColor: "var(--accent)" } : undefined}
        >
          <span className="font-medium">{ungranted}</span>
          <span style={{ color: "var(--ink2)" }}>
            of {all.length} permissions are granted by no role at all.
          </span>
          <span className="ml-auto text-[12.5px]" style={{ color: "var(--accent)" }}>
            {only === "ungranted" ? "Show all" : "Show them"}
          </span>
        </button>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, id or what it allows…"
          className="uam-input h-10 flex-1 min-w-[240px] px-3 text-[14px]"
        />
        <div className="w-[200px]">
          <UamSelect
            value={module}
            onChange={setModule}
            placeholder="Every module"
            searchPlaceholder="Search modules…"
            emptyText="No module by that name."
            options={[{ value: "", label: "Every module" }, ...modules]}
          />
        </div>
        <button
          onClick={() => setOnly(only === "exceptions" ? "all" : "exceptions")}
          className={`uam-chip ${only === "exceptions" ? "uam-chip-on" : ""}`}
        >
          Has exceptions
        </button>
      </div>

      <div className="text-[12.5px]" style={{ color: "var(--ink3)" }}>
        {rows.length} of {all.length} permissions
      </div>

      {rows.length === 0 ? (
        <UamEmpty title="Nothing matches" text="Try a different word, or clear the module filter." />
      ) : (
        <div className="uam-card overflow-hidden">
          {rows.map((p, i) => (
            <PermissionRow key={p.id} p={p} first={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function PermissionRow({ p, first }: { p: CataloguePermission; first: boolean }) {
  return (
    <div
      className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3"
      style={first ? undefined : { borderTop: "1px solid var(--line)" }}
    >
      {/* min-w-0 with a flex BASIS rather than a min-width: a 260px floor
          could not shrink, so at a narrow pane the right-hand column was
          squeezed to nothing and its text ran back over the permission id. */}
      <span className="flex min-w-0 flex-1 basis-[260px] flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {/* Read-only catalogue: no switch here, because nothing on this screen
            is granted to anyone — it lists what the system CAN grant. The
            meaning still hangs off the name, as it does on the lists that do
            toggle, so the two read the same way. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="text-[14px] font-medium"
              style={{ textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3, textDecorationColor: "var(--line)" }}
            >
              {p.label}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px]">{p.description}</TooltipContent>
        </Tooltip>
        {/* break-all: an id is one unbroken token, so it overflows instead of
            wrapping unless it is allowed to break mid-word. */}
        <span className="break-all text-[11.5px]" style={{ color: "var(--ink3)", fontFamily: "var(--mono)" }}>
          {p.id}
        </span>
      </span>

      <span className="flex shrink-0 flex-col items-end gap-0.5 text-[12.5px]">
        {p.roles.length === 0 ? (
          <span style={{ color: "var(--warn)" }}>No role grants this</span>
        ) : (
          <span
            style={{ color: "var(--ink2)" }}
            title={p.roles.join(", ")}
          >
            {p.roles.length} {p.roles.length === 1 ? "role" : "roles"}
          </span>
        )}
        {p.exceptions > 0 && (
          <span style={{ color: "var(--warn)" }}>
            {p.exceptions} {p.exceptions === 1 ? "exception" : "exceptions"}
          </span>
        )}
        <span style={{ color: "var(--ink3)" }}>{p.moduleLabel} · {p.functionalityLabel}</span>
      </span>
    </div>
  );
}

/* ── Sets ─────────────────────────────────────────────────────────────────── */

function Sets({ onEdit }: { onEdit: (s: PrivilegeSet) => void }) {
  const sets = useQuery({ queryKey: accessKeys.privilegeSets(), queryFn: accessApi.privilegeSets });

  if (sets.isLoading) return <Skeleton className="h-48 w-full" />;
  const rows = sets.data ?? [];

  if (!rows.length) {
    return (
      <UamEmpty
        title="No sets yet"
        text="A set groups permissions that belong together — 'Night audit cover' is six permissions one person needs for a fortnight. Assign the set instead of six separate privileges."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="uam-lede m-0 text-[13.5px]">
        A set is a live reference, not a copy: change what is in it and everyone holding it changes with
        it. That is what makes it worth using — and why an edit says how many people it reaches.
      </p>

      {rows.map((s) => (
        <button key={s.id} onClick={() => onEdit(s)} className="uam-card w-full px-4 py-3.5 text-left">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
            <span className="flex min-w-[240px] flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-medium">{s.name}</span>
                <span className={`uam-badge ${s.effect === "DENY" ? "uam-badge-warn" : ""}`}>
                  {s.effect === "DENY" ? "Takes away" : "Gives"}
                </span>
                {!s.isActive && <span className="uam-badge uam-badge-warn">Disabled</span>}
              </span>
              <span className="text-[12.5px]" style={{ color: "var(--ink3)" }}>{s.description}</span>
              <span className="text-[11.5px]" style={{ color: "var(--ink3)", fontFamily: "var(--mono)" }}>
                {s.key}
              </span>
            </span>
            <span className="flex flex-col items-end gap-0.5 text-[12.5px]" style={{ color: "var(--ink2)" }}>
              <span className="inline-flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                {s.items.length} {s.items.length === 1 ? "permission" : "permissions"}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Users2 className="h-3.5 w-3.5" />
                {s.holders === 0 ? "Nobody holds it" : `${s.holders} ${s.holders === 1 ? "holder" : "holders"}`}
              </span>
            </span>
          </div>

          {/* The members, named. A set is only trustworthy if what is inside it
              is visible without opening it — the whole risk of a bundle is
              somebody assigning one without reading it. */}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {s.items.map((it) => (
              <span
                key={it.id}
                className="uam-chip"
                title={`${it.id} — ${it.description}`}
                style={it.inManifest ? undefined : { textDecoration: "line-through", opacity: 0.6 }}
              >
                {it.label}
              </span>
            ))}
          </div>
        </button>
      ))}
    </div>
  );
}
