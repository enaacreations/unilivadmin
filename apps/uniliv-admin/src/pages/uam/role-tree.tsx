import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronRight, Loader2, MapPin, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  accessApi, accessKeys, ANCHOR_WORD,
  type AnchorLevel, type OrgNode, type RoleTreeEntry,
} from "@/lib/access-api";
import { UamEmpty } from "./shell";
import { PermissionList } from "./permission-list";
import { UamSelect } from "./select";

/**
 * The Roles tab, as a tree: role → the place it was handed out at → the
 * properties that reach → what they may do at each one.
 *
 * The shape is the model. A ROLE never names a property — "Unit Lead" is one
 * role and which properties is a fact about the person holding it — so the
 * place hangs off the person's grant, one rung down from the role. Underneath
 * a cluster the properties are not stored at all: they are resolved through the
 * org tree every time this loads, which is why a property added to that cluster
 * next month simply appears here with nobody re-tagged.
 *
 * Each property opens onto the CRUD table, because "what can they do" only has
 * an answer once you say WHERE — that is the whole point of the per-user
 * placement, and a single flat list of functionalities would be the old
 * property-blind model wearing a tree's clothes.
 */

/** The four verbs, in the order the grid reads them. */
const CRUD = ["create", "view", "edit", "delete"] as const;

/** Column headers — the design's words, not the database's. */
const CRUD_LABEL: Record<string, string> = {
  create: "Create", view: "Read", edit: "Update", delete: "Delete",
};

export function RoleTree({
  userId, action,
}: {
  userId: string;
  /** Slot for the caller's own per-role control (taking the role away). It
   *  stays with the screen that owns the reason prompt for a revoke. */
  action?: (roleKey: string) => React.ReactNode;
}) {
  const qc = useQueryClient();
  const tree = useQuery({
    queryKey: accessKeys.userTree(userId),
    queryFn: () => accessApi.userTree(userId),
  });
  const [scoping, setScoping] = React.useState<RoleTreeEntry | null>(null);

  if (tree.isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;

  const roles = tree.data?.roles ?? [];
  if (!roles.length) {
    return <UamEmpty title="No roles" text="They can sign in and do nothing at all until they hold at least one role." />;
  }

  /**
   * Placements made for the PERSON, not under any role.
   *
   * A `*` grant applies whatever the person holds, so the server returns it
   * under every role — which put a property chip inside a role badged "given a
   * kitchen" and left a small "all roles" badge to explain the contradiction.
   * It is one placement, so it is shown once, above the roles it applies to.
   *
   * Deduped by node: the same `*` grant arrives once per role held.
   */
  const general = [...new Map(
    roles.flatMap((r) => r.anchors.filter((a) => !a.scopedToRole).map((a) => [a.id, a] as const)),
  ).values()];

  return (
    <div className="flex flex-col gap-3">
      {general.length > 0 && (
        <div className="uam-card overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" style={{ borderBottom: "1px solid var(--line)" }}>
            <span className="text-[15px] font-semibold">Works here, whatever their role</span>
            <span className="uam-badge" title="Given to the person rather than under one of their roles, so it applies to all of them.">
              all roles
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
            {general.map((a) => (
              <span key={a.id} className="uam-chip" style={{ cursor: "default" }}>
                <MapPin className="h-3.5 w-3.5" style={{ color: "var(--ink3)" }} />
                {a.name}
                <span style={{ color: "var(--ink3)" }}>{a.nodeType.toLowerCase()}</span>
              </span>
            ))}
          </div>
          <p className="m-0 px-4 pb-3 text-[12.5px]" style={{ color: "var(--ink3)" }}>
            Every role below reaches these places too. "Change places" on a role only edits that
            role's own placements, never these.
          </p>
        </div>
      )}

      {roles.map((r) => (
        <RoleBlock key={r.roleKey} userId={userId} role={r} action={action} onChangePlaces={() => setScoping(r)} />
      ))}
      {scoping && scoping.anchorLevel && (
        <PlacesSheet
          roleLabel={scoping.label}
          level={scoping.anchorLevel}
          initial={scoping.anchors.filter((a) => a.scopedToRole).map((a) => a.id)}
          onSave={async (nodeIds, reason) => {
            await accessApi.setRoleScope(userId, { roleKey: scoping.roleKey, nodeIds, reason });
            await qc.invalidateQueries({ queryKey: accessKeys.userTree(userId) });
          }}
          onClose={() => setScoping(null)}
        />
      )}
    </div>
  );
}

/* ── One role, its anchors, and the properties beneath ────────────────────── */

function RoleBlock({
  userId, role, action, onChangePlaces,
}: {
  userId: string;
  role: RoleTreeEntry;
  action?: (roleKey: string) => React.ReactNode;
  onChangePlaces: () => void;
}) {
  /** Only the placements made UNDER this role — the ones "Change places" edits. */
  const own = role.anchors.filter((a) => a.scopedToRole);
  const [open, setOpen] = React.useState<string | null>(null);

  return (
    <div className="uam-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" style={{ borderBottom: "1px solid var(--line)" }}>
        <span className="text-[15px] font-semibold">{role.label}</span>
        {role.anchorLevel ? (
          <span className="uam-badge">given a {ANCHOR_WORD[role.anchorLevel]}</span>
        ) : (
          <span className="uam-badge" title="This role carries no place — it applies wherever the person already works.">
            no place of its own
          </span>
        )}
        <span className="flex-1" />
        {!role.isSystem && role.anchorLevel && (
          <button onClick={onChangePlaces} className="uam-btn h-8 shrink-0 px-3 text-[13px]">
            Change places
          </button>
        )}
        {action?.(role.roleKey)}
      </div>

      {/* The anchors themselves — the cluster/zone/city they were given. Shown
          even when they are properties, because "which" is the whole answer. */}
      {/* THIS role's own placements. General (`*`) ones are lifted to their own
          card above: repeating them here made a kitchen-anchored role appear to
          be placed at a property, which is the contradiction the small "all
          roles" badge was left to resolve. */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5" style={{ borderBottom: "1px solid var(--line)" }}>
        {own.length === 0 ? (
          <span className="text-[13px]" style={{ color: "var(--ink3)" }}>
            {role.anchors.length > 0
              ? "No place of its own — it applies wherever they already work, above."
              : "Nowhere yet — this role gives them nothing until a place is set."}
          </span>
        ) : (
          own.map((a) => (
            <span key={a.id} className="uam-chip" style={{ cursor: "default" }}>
              <MapPin className="h-3.5 w-3.5" style={{ color: "var(--ink3)" }} />
              {a.name}
              <span style={{ color: "var(--ink3)" }}>{a.nodeType.toLowerCase()}</span>
            </span>
          ))
        )}
      </div>

      {role.properties.length === 0 ? (
        <p className="m-0 px-4 py-3 text-[13px]" style={{ color: "var(--ink3)" }}>
          No properties resolve under {role.anchors.length ? "those places" : "this role"} yet.
          {role.anchors.length > 0 && " Properties added to them later will appear here on their own."}
        </p>
      ) : (
        role.properties.map((p) => {
          const isOpen = open === p.id;
          return (
            <div key={p.id}>
              <button
                onClick={() => setOpen(isOpen ? null : p.id)}
                aria-expanded={isOpen}
                className="uam-row uam-row-link w-full text-left"
              >
                <ChevronRight
                  className="h-4 w-4 shrink-0 transition-transform"
                  style={{ color: "var(--ink3)", transform: isOpen ? "rotate(90deg)" : "none" }}
                />
                <Building2 className="h-4 w-4 shrink-0" style={{ color: "var(--ink3)" }} />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{p.name}</span>
                {p.viaType !== "PROPERTY" && (
                  <span className="shrink-0 text-[12.5px]" style={{ color: "var(--ink3)" }}>
                    via {p.viaName}
                  </span>
                )}
              </button>
              {isOpen && <Grid userId={userId} roleKey={role.roleKey} nodeId={p.id} propertyName={p.name} />}
            </div>
          );
        })
      )}
    </div>
  );
}

/* ── The CRUD table for one property ──────────────────────────────────────── */

type Pending = Record<string, boolean>;
const cellKey = (functionality: string, action: string) => `${functionality}:${action}`;

function Grid({
  userId, roleKey, nodeId, propertyName,
}: {
  userId: string; roleKey: string; nodeId: string; propertyName: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = React.useState<Pending>({});
  const [reason, setReason] = React.useState("");

  const grid = useQuery({
    queryKey: accessKeys.userGrid(userId, roleKey, nodeId),
    queryFn: () => accessApi.userGrid(userId, roleKey, nodeId),
  });

  const save = useMutation({
    mutationFn: async () => {
      // One call per cell, deliberately: each becomes its own line on the
      // activity trail with its own reason, which a single bulk write could
      // never reconstruct afterwards.
      for (const [key, allowed] of Object.entries(pending)) {
        const [functionality, action] = key.split(":") as [string, string];
        await accessApi.setGridCell(userId, { roleKey, nodeId, functionality, action, allowed, reason: reason.trim() });
      }
    },
    onSuccess: async () => {
      const n = Object.keys(pending).length;
      setPending({});
      setReason("");
      await qc.invalidateQueries({ queryKey: accessKeys.userGrid(userId, roleKey, nodeId) });
      await qc.invalidateQueries({ queryKey: accessKeys.privileges("USER", userId) });
      toast({ variant: "success", title: n === 1 ? "1 change saved" : `${n} changes saved`, description: "Each one is on the activity trail with your reason." });
    },
    onError: (e: Error) => toast({ title: "Nothing was saved", description: e.message, variant: "destructive" }),
  });

  if (grid.isLoading) {
    return (
      <div className="px-4 py-4" style={{ background: "var(--sunk)" }}>
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  // Keep the module grouping: the grid is long, and a section header every few
  // rows is what makes "what can they do in Food here" scannable.
  const modules = (grid.data?.modules ?? [])
    .map((m) => ({ ...m, functionalities: m.functionalities.filter((f) => f.cells.some((c) => c.inManifest)) }))
    .filter((m) => m.functionalities.length > 0);
  const changes = Object.keys(pending).length;
  const ready = changes > 0 && reason.trim().length >= 4;

  return (
    <div className="flex flex-col gap-3 px-4 py-4" style={{ background: "var(--sunk)", borderBottom: "1px solid var(--line)" }}>
      <p className="m-0 text-[12.5px]" style={{ color: "var(--ink3)" }}>
        What they may do at {propertyName}. A permission that differs from the role is an
        exception written for this person, at this property only.
      </p>

      <div className="flex max-h-[460px] flex-col gap-3 overflow-y-auto">
        <PermissionList
          sections={modules.map((mod) => ({
            key: mod.key,
            label: mod.label,
            groups: mod.functionalities.map((f) => ({
              key: f.functionality,
              label: f.label,
              cells: Object.fromEntries(
                f.cells.map((c) => {
                  const k = cellKey(f.functionality, c.action);
                  const on = k in pending ? pending[k]! : c.allowed;
                  return [c.action, {
                    inManifest: c.inManifest,
                    on,
                    // An exception is a tick that does not match what the role
                    // alone gives — the one written by hand for this person here.
                    exception: on !== c.roleAllows,
                    title: on !== c.roleAllows
                      ? `Differs from what ${mod.label} gives in this role — ${c.detail || "written for this person here"}`
                      : c.detail,
                  }];
                }),
              ),
            })),
          }))}
          onToggle={(functionality: string, action: string, next: boolean) =>
            setPending((p) => {
              const f = modules.flatMap((m) => m.functionalities).find((x) => x.functionality === functionality);
              const current = f?.cells.find((c) => c.action === action)?.allowed ?? false;
              const k = cellKey(functionality, action);
              const copy = { ...p };
              // Toggling back to where it started is not a change.
              if (next === current) delete copy[k];
              else copy[k] = next;
              return copy;
            })
          }
        />
      </div>

      {changes > 0 && (
        <div className="uam-card flex flex-wrap items-center gap-2 p-3">
          <span className="text-[13.5px] font-medium">
            {changes === 1 ? "1 change" : `${changes} changes`}
          </span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why? e.g. covering the Baner warden until 30 Sep"
            className="uam-input min-w-[240px] flex-1 text-[13.5px]"
          />
          <button onClick={() => { setPending({}); setReason(""); }} className="uam-btn h-9 px-3 text-[13.5px]">
            Discard
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={!ready || save.isPending}
            className="uam-btn uam-btn-primary h-9 px-3.5 text-[13.5px]"
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </div>
  );
}


/* ── Changing WHERE a role applies ────────────────────────────────────────── */

/**
 * The picker only offers nodes of the role's own rung. A Cluster Manager is
 * given a cluster; offering them a property here would quietly invent a second
 * meaning for the same role, which is exactly what the anchor level exists to
 * stop. The server checks it again — this is the courtesy, not the guard.
 */
export function PlacesSheet({
  roleLabel, level, initial, kicker, onSave, onClose,
}: {
  roleLabel: string;
  level: AnchorLevel;
  initial: string[];
  kicker?: string;
  onSave: (nodeIds: string[], reason: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const nodes = useQuery({ queryKey: accessKeys.nodes(), queryFn: () => accessApi.nodes() });

  const [picked, setPicked] = React.useState<string[]>(initial);
  const [reason, setReason] = React.useState("");
  const all = ((nodes.data ?? []) as OrgNode[])
    .filter((n) => n.isActive && n.nodeType === level)
    .sort((a, b) => a.name.localeCompare(b.name));
  const byId = new Map(all.map((n) => [n.id, n]));

  const save = useMutation({
    mutationFn: () => onSave(picked, reason.trim()),
    onSuccess: () => {
      toast({
        variant: "success",
        title: "Places updated",
        description: `${roleLabel} now applies at ${picked.length === 1 ? "1 place" : `${picked.length} places`}.`,
      });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Nothing changed", description: e.message, variant: "destructive" }),
  });

  const ready = reason.trim().length >= 4;

  return (
    <div className="uam-scrim uam-scrim-enter fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="uam-sheet uam-sheet-enter flex h-full w-full max-w-[480px] flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="flex flex-col gap-1">
            <span className="uam-kicker">{kicker ?? roleLabel}</span>
            <span className="uam-title" style={{ fontSize: 18 }}>
              Which {ANCHOR_WORD[level]}
              {picked.length === 1 ? "" : "s"}?
            </span>
          </div>
          <button onClick={onClose} className="uam-btn h-8 w-8 justify-center border-transparent p-0">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
          <p className="m-0 text-[13px]" style={{ color: "var(--ink3)" }}>
            Everything beneath what you pick is included, and stays included — a property
            added to {picked.length === 1 ? "it" : "them"} later needs no change here.
          </p>

          {/* The module's picker, as everywhere else. It replaced a search box
              over a checkbox list: two controls doing one job, and a list that
              grew without bound as the estate did. Picking ADDS; what is chosen
              reads back as chips, which is also the only view that stays short
              when the list behind it is long. */}
          {nodes.isLoading ? (
            <Skeleton className="h-10 w-full rounded-lg" />
          ) : (
            <UamSelect
              value=""
              onChange={(id) => setPicked((p) => (p.includes(id) ? p : [...p, id]))}
              placeholder={picked.length ? `Add another ${ANCHOR_WORD[level]}…` : `Pick a ${ANCHOR_WORD[level]}…`}
              searchPlaceholder={`Search ${ANCHOR_WORD[level]}s…`}
              emptyText={`No ${ANCHOR_WORD[level]} by that name.`}
              options={all
                .filter((n) => !picked.includes(n.id))
                .map((n) => ({ value: n.id, label: n.name }))}
            />
          )}

          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {picked.map((id) => (
                <span key={id} className="uam-chip uam-chip-on">
                  {byId.get(id)?.name ?? id}
                  <button
                    onClick={() => setPicked((p) => p.filter((x) => x !== id))}
                    aria-label={`Remove ${byId.get(id)?.name ?? id}`}
                    className="ml-0.5 opacity-60 hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-[13.5px] font-semibold">
              Why<span className="ml-1.5 text-[12.5px] font-normal" style={{ color: "var(--ink3)" }}>One sentence. It lands on the activity trail.</span>
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. taking over Koramangala from 1 Oct"
              className="uam-input uam-input-fill text-[14px]"
            />
          </div>

          {picked.length === 0 && (
            <p className="m-0 text-[12.5px]" style={{ color: "var(--warn)" }}>
              With no place, this role gives them nothing at all.
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-4" style={{ borderTop: "1px solid var(--line)" }}>
          <button onClick={onClose} className="uam-btn h-9 px-3.5">Cancel</button>
          <button
            onClick={() => save.mutate()}
            disabled={!ready || save.isPending}
            className="uam-btn uam-btn-primary h-9 px-3.5"
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save places"}
          </button>
        </footer>
      </div>
    </div>
  );
}
