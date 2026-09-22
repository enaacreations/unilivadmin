import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Search, Utensils } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { accessApi, accessKeys, type OrgNode } from "@/lib/access-api";
import { ScreenHeader, Card, CardHead, Badge, NodeType, EmptyState } from "./ui";

/**
 * Organization (PRD §30 → Organization).
 *
 * §30 lists Regions, Properties, Buildings, Floors, Rooms and Beds. Those are
 * node TYPES in one tree here rather than six tables, so the levels the PRD
 * names that have no data yet (Building, Floor, Bed) simply have no rows —
 * the screen renders what exists instead of mocking what does not.
 *
 * The second spine is ours, not the PRD's: a kitchen sits under a city but
 * SERVES properties that may sit in another cluster. It is the single most
 * confusing thing about our estate, so it is drawn rather than explained.
 */

/**
 * Levels expanded when the screen opens.
 *
 * Everything used to render at once — 80 nodes, 50 of them rooms, in one flat
 * indented list. A tree that cannot be closed is a list with extra whitespace,
 * and the estate shape (which this screen exists to show) was buried under its
 * own leaves. Opening down to CITY shows the shape; clusters and below are one
 * click away.
 */
const OPEN_BY_DEFAULT = new Set(["COMPANY", "ZONE", "REGION"]);

/** Plural label for a collapsed branch's summary. */
const TYPE_PLURAL: Record<string, string> = {
  ZONE: "zones", REGION: "regions", CITY: "cities", CLUSTER: "clusters",
  KITCHEN: "kitchens", PROPERTY: "properties", BUILDING: "buildings",
  FLOOR: "floors", ROOM: "rooms", BED: "beds",
};

export default function TreeScreen() {
  const [q, setQ] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [openSeeded, setOpenSeeded] = React.useState(false);

  const nodes = useQuery({ queryKey: accessKeys.nodes(), queryFn: accessApi.nodes });
  const grants = useQuery({ queryKey: accessKeys.grants(), queryFn: () => accessApi.grants() });

  const byParent = React.useMemo(() => {
    const m = new Map<string | null, OrgNode[]>();
    for (const n of nodes.data ?? []) {
      const list = m.get(n.parentId) ?? [];
      list.push(n);
      m.set(n.parentId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [nodes.data]);

  const byId = React.useMemo(
    () => new Map((nodes.data ?? []).map((n) => [n.id, n])),
    [nodes.data],
  );

  /** What sits beneath a node, by type — what a collapsed branch reports. */
  const summary = React.useMemo(() => {
    const out = new Map<string, Map<string, number>>();
    const walk = (id: string): Map<string, number> => {
      const cached = out.get(id);
      if (cached) return cached;
      const counts = new Map<string, number>();
      for (const kid of byParent.get(id) ?? []) {
        counts.set(kid.nodeType, (counts.get(kid.nodeType) ?? 0) + 1);
        for (const [t, c] of walk(kid.id)) counts.set(t, (counts.get(t) ?? 0) + c);
      }
      out.set(id, counts);
      return counts;
    };
    for (const n of nodes.data ?? []) walk(n.id);
    return out;
  }, [nodes.data, byParent]);

  // Open the top of the tree once the data arrives — the shape of the estate is
  // the point of this screen; its 50 rooms are not.
  React.useEffect(() => {
    if (openSeeded || !nodes.data?.length) return;
    setOpen(new Set(nodes.data.filter((n) => OPEN_BY_DEFAULT.has(n.nodeType)).map((n) => n.id)));
    setOpenSeeded(true);
  }, [nodes.data, openSeeded]);

  const needle = q.trim().toLowerCase();
  const matches = (n: OrgNode) => !needle || n.name.toLowerCase().includes(needle) || n.nodeType.toLowerCase().includes(needle);

  /** Ids on the path to a search hit — a match nobody can see is not a match. */
  const forcedOpen = React.useMemo(() => {
    const ids = new Set<string>();
    if (!needle) return ids;
    for (const n of nodes.data ?? []) {
      if (!matches(n)) continue;
      let p = n.parentId;
      while (p) {
        ids.add(p);
        p = byId.get(p)?.parentId ?? null;
      }
    }
    return ids;
  }, [needle, nodes.data, byId]);

  const isOpen = (id: string) => open.has(id) || forcedOpen.has(id);
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const sel = (nodes.data ?? []).find((n) => n.id === selected) ?? null;

  /** Ancestors of the selected node, root first — "where am I" in one line. */
  const selPath = React.useMemo(() => {
    const out: OrgNode[] = [];
    let p = sel?.parentId ?? null;
    while (p) {
      const node = byId.get(p);
      if (!node) break;
      out.unshift(node);
      p = node.parentId;
    }
    return out;
  }, [sel, byId]);

  /** Grants that place someone at this exact node. */
  const accessHere = (grants.data ?? []).filter((g) => g.nodeId === selected && !g.revokedAt);

  /** Drift the PRD's §30 org view should surface, computed from real rows. */
  const drift = React.useMemo(() => {
    const out: Array<{ title: string; detail: string }> = [];
    const all = nodes.data ?? [];
    const orphanKitchens = all.filter((n) => n.nodeType === "KITCHEN" && !all.some((p) => p.id === n.parentId && p.nodeType === "CITY"));
    if (orphanKitchens.length) {
      out.push({
        title: `${orphanKitchens.length} kitchen${orphanKitchens.length === 1 ? "" : "s"} sit outside a city`,
        detail: `${orphanKitchens.map((k) => k.name).join(", ")} — unreachable by any city or zone grant.`,
      });
    }
    const inactive = all.filter((n) => !n.isActive);
    if (inactive.length) {
      out.push({
        title: `${inactive.length} inactive node${inactive.length === 1 ? "" : "s"}`,
        detail: "Scope expansion stops dead at an inactive node — nothing beneath one is reachable.",
      });
    }
    const dead = (grants.data ?? []).filter((g) => !g.revokedAt && g.nodeId && !all.some((n) => n.id === g.nodeId));
    if (dead.length) {
      out.push({
        title: `${dead.length} grant${dead.length === 1 ? "" : "s"} point at a node that no longer exists`,
        detail: "These resolve to nothing and will never grant access.",
      });
    }
    return out;
  }, [nodes.data, grants.data]);

  /**
   * One level of the tree.
   *
   * Nesting is POSITIONAL — each level renders its children inside itself —
   * rather than computed from a nodeType→depth table. A kitchen parented
   * somewhere unexpected then draws where it actually sits instead of where the
   * table assumed it would, which is precisely the drift this screen reports.
   *
   * The vertical rule on each child list is the "nests in" edge the legend
   * names; before this, the legend described lines that were never drawn.
   */
  const renderLevel = (parentId: string | null, depth: number): React.ReactNode => {
    const kids = byParent.get(parentId) ?? [];
    const rows = kids
      .map((n) => {
        const childNodes = renderLevel(n.id, depth + 1);
        const hasKids = (byParent.get(n.id) ?? []).length > 0;
        const self = matches(n);
        // Keep a branch whose descendant matches, or filtering hides the path to it.
        if (needle && !self && !React.Children.count(childNodes)) return null;

        const expanded = isOpen(n.id);
        const counts = summary.get(n.id);
        const beneath = counts
          ? [...counts.entries()]
              .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
              .slice(0, 2)
              .map(([t, c]) => `${c} ${c === 1 ? (TYPE_PLURAL[t] ?? t).replace(/(ie)?s$/, (m) => (m === "ies" ? "y" : "")) : TYPE_PLURAL[t] ?? t}`)
              .join(" · ")
          : "";

        return (
          <li key={n.id} className="relative">
            <div
              className={cn(
                "group flex items-center gap-1.5 rounded-[7px] pr-2 transition-colors",
                selected === n.id ? "bg-[var(--coral-bg)]" : "hover:bg-[var(--muted-bg)]",
              )}
            >
              {/* The tick joining this row to its parent's rule. */}
              {depth > 0 && <span aria-hidden className="h-px w-2.5 shrink-0 bg-[var(--bd2)]" />}

              {hasKids ? (
                <button
                  onClick={() => toggle(n.id)}
                  aria-label={expanded ? `Collapse ${n.name}` : `Expand ${n.name}`}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--ink3)] hover:bg-[var(--card)] hover:text-[var(--ink)]"
                >
                  {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
              ) : (
                <span className="h-5 w-5 shrink-0" />
              )}

              <button
                onClick={() => setSelected(n.id)}
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-[13px]"
              >
                <NodeType type={n.nodeType} />
                <span className={cn("min-w-0 truncate", !n.isActive && "text-[var(--muted)] line-through")}>
                  {n.name}
                </span>
                {/* What a closed branch is hiding — otherwise collapsing trades
                    clutter for ignorance. */}
                {!expanded && hasKids && beneath && (
                  <span className="shrink-0 text-[10.5px] text-[var(--ink3)]">{beneath}</span>
                )}
                {!n.isActive && <Badge tone="warn">inactive</Badge>}
              </button>

              {n.nodeType === "KITCHEN" && (
                <span
                  title="Serves properties across clusters — the second spine"
                  className="flex shrink-0 items-center gap-1 rounded bg-[var(--violet-bg)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.04em] text-[var(--pop)]"
                >
                  <Utensils className="h-2.5 w-2.5" /> serves
                </span>
              )}
            </div>
            {expanded && childNodes}
          </li>
        );
      })
      .filter(Boolean);

    if (!rows.length) return null;
    return (
      <ul className={cn("flex flex-col", depth > 0 && "ml-[13px] border-l border-[var(--bd2)] pl-0")}>
        {rows}
      </ul>
    );
  };

  if (nodes.isLoading) return <div className="p-8"><Skeleton className="h-96 w-full rounded-xl" /></div>;

  return (
    <>
      <ScreenHeader
        kicker="Organization"
        title="Two spines, one tree"
        sub="Geography nests. Kitchens cut across it — a kitchen sits under a city but serves properties that may sit in another cluster."
      />

      {/* The tree is the content, not a sidebar — give it the room. The detail
          panel is a fixed-width companion, so auto-fit's equal columns left the
          tree cramped and the panel padded with air. */}
      <div className="grid items-start gap-5 px-6 pb-16 pt-5 sm:px-8 [grid-template-columns:minmax(0,1fr)] lg:[grid-template-columns:minmax(0,1.7fr)_minmax(300px,1fr)]">
        <Card className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2.5">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-[var(--muted)]" />
              <Input
                className="h-8 w-[200px] pl-7 text-[12.5px]"
                placeholder={`Search ${nodes.data?.length ?? 0} nodes…`}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={() => setOpen(new Set((nodes.data ?? []).map((n) => n.id)))}
                className="rounded-[7px] border border-[var(--border)] px-2.5 py-1.5 text-[11.5px] text-[var(--muted)] hover:text-[var(--ink)]"
              >
                Expand all
              </button>
              <button
                onClick={() => setOpen(new Set())}
                className="rounded-[7px] border border-[var(--border)] px-2.5 py-1.5 text-[11.5px] text-[var(--muted)] hover:text-[var(--ink)]"
              >
                Collapse all
              </button>
            </div>
            <div className="ml-auto flex flex-wrap gap-3 text-[10.5px] text-[var(--muted)]">
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-px bg-[var(--bd2)]" />nests in
              </span>
              <span className="flex items-center gap-1.5">
                <Utensils className="h-2.5 w-2.5 text-[var(--pop)]" />serves
              </span>
            </div>
          </div>
          <div className="max-h-[70vh] overflow-auto p-2">{renderLevel(null, 0)}</div>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHead>Selected node</CardHead>
            {sel ? (
              <>
                <div className="border-b border-[var(--border)] px-4 py-3.5">
                  {/* Where this node sits, not just what it is called. Two
                      clusters named "Central" in different cities are a real
                      thing, and the name alone cannot tell them apart. */}
                  {selPath.length > 0 && (
                    <div className="mb-1 flex flex-wrap items-center gap-1 text-[11px] text-[var(--muted)]">
                      {selPath.map((p, i) => (
                        <React.Fragment key={p.id}>
                          {i > 0 && <span className="text-[var(--ink3)]">/</span>}
                          <button onClick={() => setSelected(p.id)} className="hover:text-[var(--ink)] hover:underline">
                            {p.name}
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                  <div className="font-display text-[17px] font-semibold tracking-[-0.01em] [text-wrap:pretty]">
                    {sel.name}
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-[var(--muted)]">
                    {sel.nodeType} · depth {sel.depth} · {sel.isActive ? "active" : "inactive"}
                  </div>
                  {(byParent.get(sel.id) ?? []).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {[...(summary.get(sel.id) ?? new Map()).entries()]
                        .sort((a, b) => b[1] - a[1])
                        .map(([t, c]) => (
                          <Badge key={t}>{c} {TYPE_PLURAL[t] ?? t.toLowerCase()}</Badge>
                        ))}
                    </div>
                  )}
                </div>
                <div className="px-4 py-3.5">
                  <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
                    Who has access here
                  </div>
                  {accessHere.length === 0 ? (
                    <EmptyState title="No grants here yet" sub="Nobody has been placed at this node." />
                  ) : (
                    <div className="flex flex-col gap-2">
                      {accessHere.map((g) => (
                        <div key={g.id} className="rounded-[9px] border border-[var(--border)] px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                              {g.userName ?? g.subjectId}
                            </span>
                            <Badge tone={g.roleKey === "*" ? "neutral" : "violet"}>
                              {g.roleKey === "*" ? "general" : g.roleKey}
                            </Badge>
                          </div>
                          <div className="mt-1 font-mono text-[10.5px] text-[var(--muted)]">
                            {g.assignmentKind} · {g.dataScope}
                            {g.followLinks ? " · +kitchens" : ""}
                            {!g.includeDescendants ? " · exact" : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="px-4 py-8 text-center text-[12.5px] text-[var(--muted)]">
                Select a node to see who can reach it.
              </div>
            )}
          </Card>

          {drift.length > 0 && (
            <div className="rounded-xl border border-[var(--warning)] bg-[var(--warning-bg)] px-4 py-3.5">
              <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--warning)]">
                Drift — {drift.length} finding{drift.length === 1 ? "" : "s"}
              </div>
              <div className="flex flex-col gap-2.5">
                {drift.map((d, i) => (
                  <div key={i} className="text-[12.5px] [text-wrap:pretty]">
                    <div className="font-medium">{d.title}</div>
                    <div className="text-[11.5px] text-[var(--muted)]">{d.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
