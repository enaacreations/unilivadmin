import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Home, Search, ChevronRight, ChevronDown, UserCog } from "lucide-react";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  accessApi, accessKeys, activityApi, activityKeys,
  type AccessPreview, type PreviewAction, type UserOverride,
} from "@/lib/access-api";
import {
  ScreenHeader, Card, CardHead, Badge, NodeType, Verdict, StatGrid,
  HeatStrip, EmptyState, type CellState,
} from "./ui";
import { AssignmentEditor, CopyAccessPanel } from "./assignment-editor";

/**
 * Access preview — "What can this person do, and why?"
 *
 * The redesign's central move: answer first, evidence second. The old version
 * rendered ~400 action pills in one flat table and left the reader to assemble
 * the verdict themselves. Here a sentence states it, a reach summary says
 * WHERE, and the capability detail is folded behind families → modules →
 * actions, so nothing is lost but almost none of it is on screen at once.
 */

const DENY_LABEL: Record<string, string> = {
  DENY_USER_OVERRIDE: "Withheld from this person",
  DENY_ROLE_LACKS_CAPABILITY: "Role lacks capability",
  DENY_NO_GRANT: "No grant anywhere",
  DENY_NODE_OUT_OF_SCOPE: "Outside granted scope",
  DENY_ACTION_NOT_ON_MODULE: "Action not on module",
  DENY_UNKNOWN_MODULE: "Unknown module",
  DENY_DATA_SCOPE: "Data scope too narrow",
};

function cellStateFor(a: PreviewAction, onModule: boolean): CellState {
  if (!onModule) return "unavailable";
  return a.allow ? "held" : "not-held";
}

/** The one-sentence answer, derived from the resolved surface. */
function verdictFor(p: AccessPreview, allowedModules: number, totalModules: number) {
  const moduleScoped = p.grants.length > 0 && (p.scope.nodeIds?.length ?? 0) === 0 && !p.scope.unrestricted;

  if (p.scope.unrestricted) {
    return {
      tone: "warn" as const,
      kicker: "Unrestricted",
      line: `${p.subject.name} can act across every property.`,
      sub: `${allowedModules} of ${totalModules} modules reachable, with no node restriction. Only the parity roles should resolve this way.`,
    };
  }
  if (moduleScoped) {
    return {
      tone: "neutral" as const,
      kicker: "Module-scoped",
      line: `${p.subject.name} is placed only inside specific modules.`,
      // The state that used to read as an error and is not one.
      sub: "A grant naming a module role confers access inside that module only, and deliberately does not widen the general scope. This is what stops an audit grant reaching the food estate.",
    };
  }
  if ((p.scope.propertyIds?.length ?? 0) === 0 && p.grants.length === 0) {
    return {
      tone: "danger" as const,
      kicker: "No placement",
      line: `Nothing places ${p.subject.name} anywhere — they will see nothing.`,
      sub: "A role on its own grants nothing. Access begins when a grant attaches the role to a node in the org tree.",
    };
  }
  const n = p.scope.propertyIds?.length ?? 0;
  return {
    tone: "ok" as const,
    kicker: "Scoped",
    line: `${p.subject.name} can act at ${n} ${n === 1 ? "property" : "properties"}.`,
    sub: `${allowedModules} of ${totalModules} modules reachable there, under data scope ${p.scope.dataScope}.`,
  };
}

/** The live exception on one cell, if this person carries one. */
function liveOverride(list: UserOverride[] | undefined, module: string, action: string) {
  return list?.find((o) => o.module === module && o.action === action && o.live);
}

type PendingOverride = {
  module: string;
  moduleLabel: string;
  action: string;
  effect: "GRANT" | "DENY" | "INHERIT";
  /** What the role says, so the dialog can name what is actually changing. */
  roleAllows: boolean;
};

/**
 * Three-state control for one cell: follow the role, or override it either way.
 *
 * Deliberately shown on EVERY action rather than only on the overridden ones —
 * an exception mechanism you have to already know about is one that gets used
 * by the few people who were told it exists.
 */
function OverrideControl({
  current,
  onPick,
  disabled,
}: {
  current: "GRANT" | "DENY" | undefined;
  onPick: (effect: "GRANT" | "DENY" | "INHERIT") => void;
  disabled?: boolean;
}) {
  const opts: Array<{ key: "INHERIT" | "GRANT" | "DENY"; label: string; title: string }> = [
    { key: "INHERIT", label: "Role", title: "Follow the role — no exception for this person" },
    { key: "GRANT", label: "Allow", title: "Give this person this permission, whatever the role says" },
    { key: "DENY", label: "Block", title: "Withhold it from this person, whatever the role says" },
  ];
  const active = current ?? "INHERIT";
  return (
    <span className="flex shrink-0 overflow-hidden rounded-[7px] border border-[var(--border)]">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          title={o.title}
          disabled={disabled || o.key === active}
          onClick={() => onPick(o.key)}
          className={cn(
            "px-1.5 py-0.5 text-[10px] font-medium transition-colors",
            o.key === active
              ? o.key === "GRANT"
                ? "bg-[var(--success-bg)] text-[var(--success)]"
                : o.key === "DENY"
                  ? "bg-[var(--danger-bg)] text-[var(--danger)]"
                  : "bg-[var(--muted-bg)] text-[var(--ink)]"
              : "text-[var(--muted)] hover:bg-[var(--muted-bg)] disabled:opacity-40",
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

export default function PreviewScreen({ onGoGrants }: { onGoGrants: () => void }) {
  const [userId, setUserId] = React.useState("");
  const [nodeId, setNodeId] = React.useState("");
  const [deniedOnly, setDeniedOnly] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [openFamilies, setOpenFamilies] = React.useState<Set<string>>(new Set());
  const [openModules, setOpenModules] = React.useState<Set<string>>(new Set());
  const [reachOpen, setReachOpen] = React.useState(false);
  const [placementOpen, setPlacementOpen] = React.useState(false);
  const [pending, setPending] = React.useState<PendingOverride | null>(null);
  const [overrideReason, setOverrideReason] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");

  const qc = useQueryClient();
  const { toast } = useToast();
  const users = useQuery({ queryKey: accessKeys.users(), queryFn: accessApi.users });
  const nodes = useQuery({ queryKey: accessKeys.nodes(), queryFn: accessApi.nodes });
  const manifest = useQuery({ queryKey: accessKeys.manifest(), queryFn: accessApi.manifest });
  const preview = useQuery({
    queryKey: accessKeys.preview(userId, nodeId || null),
    queryFn: () => accessApi.preview(userId, nodeId || null),
    enabled: !!userId,
  });
  const overrides = useQuery({
    queryKey: accessKeys.overrides(userId),
    queryFn: () => accessApi.overrides(userId),
    enabled: !!userId,
  });
  // Shares its cache with the editor below, so mounting both costs one request.
  const placement = useQuery({
    queryKey: accessKeys.assignments(userId),
    queryFn: () => accessApi.assignments(userId),
    enabled: !!userId,
  });
  // "Why does she have this?" is usually answered by what changed last week, and
  // that answer lived one tab away behind a search. The trail already filters by
  // entity, so this is the same rows, pre-filtered to the person on screen.
  const history = useQuery({
    queryKey: activityKeys.list({ entityId: userId, limit: "25" }),
    queryFn: () => activityApi.list({ entityId: userId, limit: "25" }),
    enabled: !!userId,
  });

  // A preview is a READ. This card says "Recent changes", and on a heavily
  // supported user the preview events outnumber the real ones several to one —
  // which turns the card into a log of people looking rather than a record of
  // what happened. Fetch a wider window and drop them, rather than asking the
  // API for an exclusion filter no other caller wants.
  const changes = (history.data?.data ?? [])
    .filter((e) => e.event !== "ACCESS_PREVIEWED" && e.event !== "ACCESS_DENIED")
    .slice(0, 5);

  const setOverride = useMutation({
    mutationFn: () =>
      accessApi.setOverride(userId, {
        module: pending!.module,
        action: pending!.action,
        effect: pending!.effect,
        reason: overrideReason,
        expiresAt: expiresAt || null,
      }),
    onSuccess: (_d, _v) => {
      toast({
        title: pending!.effect === "INHERIT" ? "Back to the role" : "Permission changed for this person",
        description: "Recorded on the activity trail with your reason.",
      });
      setPending(null); setOverrideReason(""); setExpiresAt("");
      // The preview is a server answer, so it must be refetched rather than
      // patched locally — that is the whole premise of this screen.
      void qc.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (e) =>
      toast({
        title: "Refused",
        description: (e as Error).message ?? "The change was refused before anything was written.",
        variant: "destructive",
      }),
  });

  const liveOverrides = (overrides.data ?? []).filter((o) => o.live);

  const properties = (nodes.data ?? []).filter((n) => n.nodeType === "PROPERTY");
  const modMeta = React.useMemo(
    () => new Map((manifest.data?.modules ?? []).map((m) => [m.key, m])),
    [manifest.data],
  );

  /** Group the preview's modules by family, keeping the manifest's order. */
  const families = React.useMemo(() => {
    const p = preview.data;
    if (!p || !manifest.data) return [];
    const needle = q.trim().toUpperCase();
    const byFamily = new Map<string, typeof p.modules>();
    for (const m of p.modules) {
      const meta = modMeta.get(m.key);
      // A module the manifest does not describe still belongs somewhere, or it
      // vanishes from the preview silently — the one outcome this screen must
      // never produce.
      const family = meta?.family ?? "Other";
      if (!meta) {
        const list = byFamily.get(family) ?? [];
        list.push(m);
        byFamily.set(family, list);
        continue;
      }
      const label = (meta.label ?? m.key).toUpperCase();
      if (needle && !label.includes(needle) && !m.key.includes(needle)) continue;
      if (deniedOnly && !m.actions.some((a) => !a.allow)) continue;
      const list = byFamily.get(family) ?? [];
      list.push(m);
      byFamily.set(family, list);
    }
    const order = manifest.data.families?.length
      ? manifest.data.families
      : [...byFamily.keys()].sort();
    return order
      .filter((f) => byFamily.has(f))
      .map((f) => ({ name: f, modules: byFamily.get(f)! }));
  }, [preview.data, manifest.data, modMeta, q, deniedOnly]);

  const allowedCount = preview.data?.modules.filter((m) => !m.noAccess).length ?? 0;
  const totalModules = manifest.data?.modules.length ?? 0;
  const verdict = preview.data ? verdictFor(preview.data, allowedCount, totalModules) : null;

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    apply(next);
  };

  return (
    <>
      <ScreenHeader
        kicker="Access preview"
        title="What can this person do, and why?"
        sub="Resolved server-side by the same decision function the API uses — so this explains the 403 a user is actually getting, rather than offering a second opinion about it."
      />

      <div className="flex flex-col gap-[18px] px-6 pb-16 pt-5 sm:px-8">
        <div className="grid items-start gap-[18px] [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          {/* ── Subject rail ─────────────────────────────────────────
              Sticky, because the capability detail on the right is long and
              "who am I looking at" is the one thing you need at every scroll
              position. Everything here is ABOUT the person; everything on the
              right is about their access. */}
          <div className="flex max-w-[340px] flex-col gap-[18px] lg:sticky lg:top-4">
          <Card className="p-[18px]">
            <div className="space-y-1.5">
              <label className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
                Person
              </label>
              <Combobox
                options={(users.data ?? []).map((u) => ({
                  value: u.id,
                  label: `${u.name} — ${u.role}`,
                  keywords: [u.email, u.role],
                }))}
                value={userId || null}
                onChange={(v) => setUserId(v ?? "")}
                placeholder="Select a person…"
                searchPlaceholder="Search by name, email or role…"
              />
            </div>

            {preview.data && (
              <>
                <div className="mt-4 flex items-center gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--muted-bg)] font-display text-[15px] font-bold text-[var(--muted)]">
                    {preview.data.subject.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                  </div>
                  <div className="min-w-0">
                    <div className="font-display text-[17px] font-semibold tracking-[-0.01em]">
                      {preview.data.subject.name}
                    </div>
                    <div className="truncate text-[12px] text-[var(--muted)]">{preview.data.subject.email}</div>
                  </div>
                </div>
                <div className="mt-3.5 flex flex-wrap gap-1.5">
                  <Badge tone="coral">{preview.data.subject.roleKey}</Badge>
                  <Badge>data scope {preview.data.scope.dataScope}</Badge>
                  {!preview.data.subject.isActive && <Badge tone="danger">inactive</Badge>}
                </div>
              </>
            )}

            <div className="my-4 h-px bg-[var(--border)]" />
            <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
              Evaluate at node
            </div>
            {/* Re-running the whole matrix at one property answers "they can
                approve at A but not B", which is the most common support call. */}
            <Combobox
              options={properties.map((n) => ({ value: n.id, label: n.name }))}
              value={nodeId || null}
              onChange={(v) => setNodeId(v ?? "")}
              placeholder="Anywhere in scope"
              searchPlaceholder="Search properties…"
              allowClear
            />
          </Card>

          {userId && (
            <>
              {/* Two writes, one place. Both open the same dialog the removed
                  Assignments tab used to hold. */}
              <Card className="p-[18px]">
                <div className="mb-2.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
                  Change this person&rsquo;s access
                </div>
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => setPlacementOpen(true)}
                    className="rounded-[9px] border border-[var(--border)] px-3 py-2 text-left text-[12.5px] hover:border-[var(--bd2)]"
                  >
                    Change where they work
                    <span className="mt-0.5 block text-[11px] text-[var(--muted)]">
                      {placement.data?.primary
                        ? `Home: ${placement.data.primary.nodeName}${placement.data.secondary.length ? ` +${placement.data.secondary.length}` : ""}`
                        : "No home property set"}
                    </span>
                  </button>
                  <button
                    onClick={() => setPlacementOpen(true)}
                    className="rounded-[9px] border border-[var(--border)] px-3 py-2 text-left text-[12.5px] hover:border-[var(--bd2)]"
                  >
                    Copy access from someone
                    <span className="mt-0.5 block text-[11px] text-[var(--muted)]">
                      Role, placement and exceptions at once
                    </span>
                  </button>
                </div>
                <div className="mt-2.5 border-t border-dashed border-[var(--bd2)] pt-2.5 text-[11px] text-[var(--muted)] [text-wrap:pretty]">
                  Per-permission exceptions are set on the action rows below — every one of them
                  carries a <span className="font-medium text-[var(--ink)]">Role / Allow / Block</span> control.
                </div>
              </Card>

              {/* The trail, pre-filtered to this person. Answers "what changed,
                  and who did it" without a tab switch and a search. */}
              <Card className="p-[18px]">
                <div className="mb-2.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
                  Recent changes
                </div>
                {history.isLoading ? (
                  <Skeleton className="h-24 w-full rounded-lg" />
                ) : changes.length === 0 ? (
                  <p className="text-[11.5px] text-[var(--muted)] [text-wrap:pretty]">
                    Nothing has changed for this person yet. Every role change, placement and
                    exception lands here with its reason.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2.5">
                    {changes.map((e) => (
                      <li key={e.id} className="border-l-2 border-[var(--bd2)] pl-2.5">
                        <div className="text-[12px] font-medium leading-snug">
                          {e.event.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}
                        </div>
                        <div className="text-[10.5px] text-[var(--muted)]">
                          {new Date(e.occurredAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                          {" · "}
                          {e.actorName ?? "System"}
                        </div>
                        {e.reason && (
                          <div className="mt-0.5 text-[11px] text-[var(--ink3)] [text-wrap:pretty]" title={e.reason}>
                            &ldquo;{e.reason.length > 70 ? `${e.reason.slice(0, 70)}…` : e.reason}&rdquo;
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          )}
          </div>

          <div className="flex min-w-0 flex-col gap-[18px]">
            {!userId && (
              <Card className="px-5 py-10 text-center text-[13px] text-[var(--muted)]">
                Pick a person to see exactly what they can do, and why.
              </Card>
            )}
            {userId && preview.isLoading && <Skeleton className="h-52 w-full rounded-xl" />}

            {verdict && preview.data && (
              <>
                <Verdict tone={verdict.tone} kicker={verdict.kicker} line={verdict.line} sub={verdict.sub}>
                  {verdict.tone === "danger" && (
                    <span className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setPlacementOpen(true)}
                        className="rounded-[9px] bg-[var(--accent)] px-4 py-2 text-[12.5px] font-semibold text-white"
                      >
                        Assign a property
                      </button>
                      <button
                        onClick={onGoGrants}
                        className="rounded-[9px] border border-[var(--bd2)] px-4 py-2 text-[12.5px] font-medium"
                      >
                        Create a grant instead
                      </button>
                    </span>
                  )}
                </Verdict>

                {/* ── EXCEPTIONS ────────────────────────────────────── */}
                {liveOverrides.length > 0 && (
                  <Card>
                    <CardHead>
                      Personal exceptions — differs from {preview.data.subject.roleKey}
                    </CardHead>
                    <div className="flex flex-col gap-2 px-[18px] py-3.5">
                      {liveOverrides.map((o) => (
                        <div key={o.id} className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-[var(--border)] px-3 py-2.5">
                          <Badge tone={o.effect === "GRANT" ? "ok" : "danger"}>
                            {o.effect === "GRANT" ? "extra" : "withheld"}
                          </Badge>
                          <span className="text-[13px] font-medium">{o.label}</span>
                          <span className="font-mono text-[11px] text-[var(--muted)]">{o.action}</span>
                          {/* The reason is the point: an exception nobody can
                              account for later is the failure mode. */}
                          <span className="min-w-[120px] flex-1 truncate text-[11.5px] text-[var(--muted)]" title={o.reason}>
                            {o.reason}
                          </span>
                          {o.expiresAt && (
                            <Badge tone="info">
                              until {new Date(o.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                            </Badge>
                          )}
                          <button
                            onClick={() =>
                              setPending({ module: o.module, moduleLabel: o.label, action: o.action, effect: "INHERIT", roleAllows: o.effect === "DENY" })
                            }
                            className="rounded-[7px] border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--ink)]"
                          >
                            Back to role
                          </button>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {/* ── WHERE ─────────────────────────────────────────── */}
                <Card>
                  <CardHead
                    right={
                      <span className="flex items-center gap-1.5">
                        {(preview.data.nodes?.length ?? 0) > 0 && (
                          <button
                            onClick={() => setReachOpen((v) => !v)}
                            className="rounded-[7px] border border-[var(--border)] px-2.5 py-1 text-[11.5px] text-[var(--muted)]"
                          >
                            {reachOpen ? "Hide nodes" : "Show nodes"}
                          </button>
                        )}
                      </span>
                    }
                  >
                    Where — resolved reach
                  </CardHead>
                  <div className="px-[18px] py-4">
                    {preview.data.scope.unrestricted ? (
                      <div className="flex items-center gap-2 text-[13px]">
                        <Globe className="h-4 w-4 text-[var(--muted)]" /> Unrestricted — every property
                      </div>
                    ) : (
                      <>
                        <StatGrid
                          items={[
                            { n: preview.data.scope.propertyIds?.length ?? 0, label: "Properties" },
                            { n: preview.data.nodes?.length ?? 0, label: "Nodes" },
                            { n: preview.data.grants.length, label: "Grants" },
                            { n: allowedCount, label: "Modules" },
                          ]}
                        />
                        {/* Which property is HOME, named. The stat row counts
                            reach; this says where the person actually sits,
                            which is what the editor below changes. */}
                        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-dashed border-[var(--bd2)] pt-3 text-[12.5px]">
                          <Home className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                          {placement.data?.primary ? (
                            <>
                              <span className="font-medium">{placement.data.primary.nodeName}</span>
                              <Badge tone="coral">home</Badge>
                            </>
                          ) : (
                            <span className="text-[var(--danger)]">
                              No home property — the legacy scope check reads this as unrestricted.
                            </span>
                          )}
                          {(placement.data?.secondary.length ?? 0) > 0 && (
                            <>
                              <span className="text-[var(--muted)]">also at</span>
                              {placement.data!.secondary.map((sn) => (
                                <Badge key={sn.id}>{sn.nodeName}</Badge>
                              ))}
                            </>
                          )}
                          {/* The fix belongs where the problem is stated — this
                              screen is where an admin learns someone is placed
                              wrongly. One control, on the line it changes. */}
                          <button
                            onClick={() => setPlacementOpen(true)}
                            className="ml-auto rounded-[7px] border border-[var(--border)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--muted)] hover:border-[var(--bd2)] hover:text-[var(--ink)]"
                          >
                            Change placement
                          </button>
                        </div>

                        {reachOpen && (preview.data.nodes?.length ?? 0) > 0 && (
                          <div className="mt-3.5 flex flex-wrap gap-1.5 border-t border-dashed border-[var(--bd2)] pt-3">
                            {preview.data.nodes!.map((n) => (
                              <span key={n.id} className="inline-flex items-center gap-1 rounded-md bg-[var(--muted-bg)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
                                <NodeType type={n.level} />
                                {n.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </Card>

                {/* ── GRANTS ────────────────────────────────────────── */}
                <Card>
                  <CardHead>Grants that place this person</CardHead>
                  {preview.data.grants.length === 0 ? (
                    <div className="p-4">
                      <EmptyState
                        title="Nothing places this person anywhere"
                        sub="A role on its own grants nothing. Access begins when a grant attaches the role to a node in the org tree."
                        action={
                          <button
                            onClick={onGoGrants}
                            className="rounded-[9px] bg-[var(--accent)] px-3.5 py-2 text-[12.5px] font-semibold text-white"
                          >
                            Create first grant
                          </button>
                        }
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2.5 px-[18px] py-3.5">
                      {preview.data.grants.map((g, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-3 rounded-[10px] border border-[var(--border)] px-3 py-2.5">
                          <Badge tone={g.roleKey === "*" ? "neutral" : "violet"}>
                            {g.roleKey === "*" ? "general" : g.roleKey}
                          </Badge>
                          <div className="min-w-[160px] flex-1">
                            <div className="text-[13px] font-medium">
                              {g.nodeIds === null ? "Organization-wide" : `${g.propertyIds?.length ?? 0} properties`}
                            </div>
                            <div className="font-mono text-[11px] text-[var(--muted)]">
                              {g.dataScope}
                              {g.qualifiers.length ? ` · ${g.qualifiers.join(",")}` : ""}
                            </div>
                          </div>
                          {g.assignmentKind !== "GRANT" && <Badge tone="info">{g.assignmentKind}</Badge>}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </>
            )}
          </div>
        </div>

        {/* ── WHAT ──────────────────────────────────────────────────── */}
        {preview.data && manifest.data && (
          <Card>
            <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-[18px] py-[13px]">
              <div className="mr-auto text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                What — {allowedCount} of {totalModules} modules reachable
              </div>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-[var(--muted)]" />
                <Input
                  className="h-8 w-[170px] pl-7 text-[12.5px]"
                  placeholder="Filter modules…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <button
                onClick={() => setDeniedOnly((v) => !v)}
                className={cn(
                  "rounded-lg border px-2.5 py-1.5 text-[12px] font-medium",
                  deniedOnly
                    ? "border-[var(--accent)] bg-[var(--coral-bg)] text-[var(--accent-strong)]"
                    : "border-[var(--border)] text-[var(--muted)]",
                )}
              >
                Denied only
              </button>
              <div className="flex items-center gap-3 text-[10.5px] text-[var(--muted)]">
                <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] bg-[var(--accent)]" />allowed</span>
                <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] border border-[var(--bd2)]" />denied</span>
                <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] bg-[var(--muted-bg)]" />not on module</span>
              </div>
            </div>

            {families.map((f) => {
              const open = openFamilies.has(f.name);
              const held = f.modules.filter((m) => !m.noAccess).length;
              return (
                <div key={f.name} className="border-b border-[var(--border)] last:border-b-0">
                  <button
                    onClick={() => toggle(openFamilies, f.name, setOpenFamilies)}
                    className="flex w-full items-center gap-3 px-[18px] py-3 text-left hover:bg-[var(--muted-bg)]"
                  >
                    {open ? <ChevronDown className="h-3 w-3 text-[var(--ink3)]" /> : <ChevronRight className="h-3 w-3 text-[var(--ink3)]" />}
                    <span className="flex-1 font-display text-[14.5px] font-semibold">{f.name}</span>
                    <HeatStrip
                      cells={f.modules.slice(0, 13).map((m) => ({
                        state: (m.noAccess ? "not-held" : "held") as CellState,
                        title: m.key,
                      }))}
                    />
                    <span className="w-14 text-right font-mono text-[11px] text-[var(--muted)]">
                      {held}/{f.modules.length}
                    </span>
                  </button>

                  {open && (
                    <div className="border-t border-[var(--border)] bg-[var(--surface)]">
                      {f.modules.map((m) => {
                        const meta = modMeta.get(m.key) ?? { key: m.key, label: m.key, family: "Other", actions: m.actions.map((a) => a.action), protected: false };
                        const mOpen = openModules.has(m.key);
                        const denials = [...new Set(m.actions.filter((a) => !a.allow).map((a) => DENY_LABEL[a.reason] ?? a.reason))];
                        return (
                          <div key={m.key}>
                            <button
                              onClick={() => toggle(openModules, m.key, setOpenModules)}
                              className="flex w-full items-center gap-3 px-[18px] py-2.5 text-left hover:bg-[var(--card)]"
                            >
                              <span className="min-w-0 flex-1 truncate">
                                <span className="text-[13px] font-medium">{meta.label}</span>
                                <span className="ml-2 font-mono text-[9.5px] text-[var(--ink3)]">{m.key}</span>
                              </span>
                              <HeatStrip
                                cells={meta.actions.map((act) => {
                                  const a = m.actions.find((x) => x.action === act);
                                  return {
                                    state: a ? cellStateFor(a, true) : ("unavailable" as CellState),
                                    title: a ? `${act} — ${a.detail}` : `${act} — not on this module`,
                                  };
                                })}
                              />
                              {m.noAccess ? (
                                <Badge className="w-[78px] justify-center">no access</Badge>
                              ) : (
                                <span className="w-[78px] text-right font-mono text-[10.5px] text-[var(--muted)]">
                                  {m.actions.filter((a) => a.allow).length}/{meta.actions.length}
                                </span>
                              )}
                            </button>

                            {mOpen && (
                              <div className="border-y border-[var(--border)] bg-[var(--card)] px-[18px] pb-3.5">
                                <div className="mt-3 grid gap-px overflow-hidden rounded-[9px] border border-[var(--border)] bg-[var(--border)] [grid-template-columns:repeat(auto-fill,minmax(262px,1fr))]">
                                  {m.actions.map((a) => {
                                    const ov = liveOverride(overrides.data, m.key, a.action);
                                    return (
                                      <div key={a.action} className="flex items-start gap-2.5 bg-[var(--card)] px-3 py-2.5">
                                        <span
                                          className={cn(
                                            "mt-1 h-2 w-2 shrink-0 rounded-full",
                                            a.allow ? "bg-[var(--success)]" : "bg-[var(--bd2)]",
                                          )}
                                        />
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-1.5">
                                            <span className="text-[12.5px] font-medium">{a.action}</span>
                                            {ov && (
                                              <span title={ov.reason} className="inline-flex items-center gap-1 rounded bg-[var(--violet-bg)] px-1 py-px text-[9.5px] font-semibold uppercase tracking-[0.04em] text-[var(--pop)]">
                                                <UserCog className="h-2.5 w-2.5" /> exception
                                              </span>
                                            )}
                                          </div>
                                          {/* The reason is the whole point of the screen. */}
                                          <div className="text-[11.5px] text-[var(--muted)] [text-wrap:pretty]">{a.detail}</div>
                                        </div>
                                        {/* Only cells the module actually defines can be overridden —
                                            the server enforces the same ceiling. */}
                                        {a.reason !== "DENY_ACTION_NOT_ON_MODULE" && a.reason !== "DENY_UNKNOWN_MODULE" && (
                                          <OverrideControl
                                            current={ov?.effect}
                                            disabled={setOverride.isPending}
                                            onPick={(effect) =>
                                              setPending({
                                                module: m.key,
                                                moduleLabel: meta.label,
                                                action: a.action,
                                                effect,
                                                roleAllows: a.reason === "ALLOW_ROLE_CAPABILITY" || a.reason === "ALLOW_IMPLIED_CAPABILITY",
                                              })
                                            }
                                          />
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {!mOpen && denials.length > 0 && (
                              <div className="px-[18px] pb-2 text-[11px] text-[var(--ink3)]">{denials.join(" · ")}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {families.length === 0 && (
              <div className="px-5 py-9 text-center text-[13px] text-[var(--muted)]">Nothing matches that filter.</div>
            )}
          </Card>
        )}
      </div>

      {/* ── Placement editor ───────────────────────────────────────────
          A dialog, not an inline section: this screen's job is to ANSWER a
          question, and a form unfolding in the middle of the answer pushes the
          evidence off screen just as you start acting on it. Same component the
          Assignments tab mounts — one implementation, two ways in. */}
      <Dialog open={placementOpen} onOpenChange={setPlacementOpen}>
        <DialogContent className="max-h-[86vh] max-w-[580px] overflow-y-auto bg-[var(--surface)] p-0">
          <DialogHeader className="border-b border-[var(--border)] bg-[var(--card)] px-5 py-4">
            <DialogTitle className="font-display text-[17px] font-semibold tracking-[-0.01em]">
              Where does {preview.data?.subject.name ?? "this person"} work?
            </DialogTitle>
            <DialogDescription className="text-[12px] text-[var(--muted)]">
              One home property, any number of additional ones. The role says what; this says where.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3.5 p-5">
            <CopyAccessPanel userId={userId} onDone={() => setPlacementOpen(false)} />
            <AssignmentEditor userId={userId} compact />
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Reason dialog ──────────────────────────────────────────────
          Every write passes through here because the API requires a reason on
          all three transitions, including the one that REMOVES an exception —
          "why is she back on the role" is as much a question as why she left it. */}
      {pending && preview.data && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4">
          <div className="w-full max-w-[420px] rounded-[14px] border border-[var(--border)] bg-[var(--card)] p-5 shadow-[var(--overlay-shadow)]">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
              {pending.effect === "INHERIT" ? "Remove exception" : "Personal exception"}
            </div>
            <div className="mt-1 font-display text-[17px] font-semibold tracking-[-0.01em] [text-wrap:pretty]">
              {pending.effect === "GRANT" && `Give ${preview.data.subject.name} ${pending.action} on ${pending.moduleLabel}`}
              {pending.effect === "DENY" && `Withhold ${pending.action} on ${pending.moduleLabel} from ${preview.data.subject.name}`}
              {pending.effect === "INHERIT" && `Return ${pending.action} on ${pending.moduleLabel} to the role`}
            </div>
            <p className="mt-2 text-[12px] text-[var(--muted)] [text-wrap:pretty]">
              {pending.effect === "INHERIT"
                ? `${preview.data.subject.roleKey} decides this again — ${pending.roleAllows ? "which allows it" : "which does not allow it"}.`
                : `This applies to ${preview.data.subject.name} alone. ${preview.data.subject.roleKey} is unchanged, and every other ${preview.data.subject.roleKey} keeps ${pending.roleAllows ? "" : "not "}having it.`}
            </p>

            <label className="mt-4 block text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
              Reason
            </label>
            <Input
              autoFocus
              className="mt-1.5 text-[13px]"
              placeholder="Covering the Baner warden until 30 Sep"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
            />

            {pending.effect !== "INHERIT" && (
              <>
                <label className="mt-3 block text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
                  Expires <span className="normal-case tracking-normal text-[var(--ink3)]">— optional, and the reason most exceptions should have one</span>
                </label>
                <Input
                  type="date"
                  className="mt-1.5 text-[13px]"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => { setPending(null); setOverrideReason(""); setExpiresAt(""); }}
                className="rounded-[9px] border border-[var(--border)] px-3.5 py-2 text-[12.5px] font-medium text-[var(--muted)]"
              >
                Cancel
              </button>
              <button
                disabled={overrideReason.trim().length < 4 || setOverride.isPending}
                onClick={() => setOverride.mutate()}
                className="rounded-[9px] bg-[var(--accent)] px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
              >
                {setOverride.isPending ? "Saving…" : pending.effect === "INHERIT" ? "Remove exception" : "Apply to this person"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
