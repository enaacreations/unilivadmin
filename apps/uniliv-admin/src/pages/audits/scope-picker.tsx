import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eraser, Loader2, Minus, Search,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import type { ApiList, AuditScopeRule } from "./lib";

/* ────────────────────────────────────────────────────────────────────────────
   One searchable hierarchy, checkable at any depth.

   The previous picker asked for a LEVEL first and then showed a flat list at
   that level, which made "this cluster, but only two of its properties"
   unexpressible. Here a node is checked wholesale (expands live — anything
   added under it later is audited) or opened and narrowed (an explicit list,
   which deliberately freezes that branch). Those two readings are what the
   "all · live" / "some · fixed" badges name, and they map 1:1 onto the rule's
   `ids` and `within` — see lib/audit-scope.ts on the server.
   ──────────────────────────────────────────────────────────────────────────── */

type NodeKind = "zone" | "city" | "cluster" | "property" | "room";

interface ScopeOption {
  id: string;
  name: string;
  sublabel?: string | null;
  parentId?: string | null;
  roomCount?: number;
  floor?: number;
  wing?: string | null;
  roomType?: string;
}

interface Node {
  id: string;
  kind: NodeKind;
  name: string;
  sublabel?: string | null;
  parentId: string | null;
  children: Node[];
  /** Properties only — the leaf count for a ROOM template, without loading rooms. */
  roomCount: number;
}

interface ResolveResult {
  total: number;
  propertyCount: number;
  breakdown: { propertyId: string; propertyName: string; selected: number; total: number }[];
  breakdownTruncated: boolean;
}

const LEVEL_OF: Record<NodeKind, AuditScopeRule["level"]> = {
  zone: "ZONE", city: "CITY", cluster: "CLUSTER", property: "PROPERTY", room: "ROOM",
};
const ORDER: AuditScopeRule["level"][] = ["ZONE", "CITY", "CLUSTER", "PROPERTY", "ROOM"];

export interface ScopePickerProps {
  targetType: "PROPERTY" | "ROOM";
  /** Fires on every change: the rule to save, plus what it currently resolves to. */
  onChange: (rule: AuditScopeRule | null, resolved: ResolveResult | null) => void;
  /** Existing rule to open with, when editing a schedule. */
  initial?: AuditScopeRule | null;
}

export function ScopePicker({ targetType, onChange, initial }: ScopePickerProps) {
  /* The four levels above rooms load once and assemble into the tree; rooms
     stay lazy, because they are the only set that grows with the estate. */
  const optionsQuery = (level: "ZONE" | "CITY" | "CLUSTER" | "PROPERTY") => ({
    queryKey: ["/audit/schedules/view/scope-options", level],
    queryFn: () => apiFetch<ApiList<ScopeOption>>(`/audit/schedules/view/scope-options?level=${level}`),
  });

  const zonesQ = useQuery(optionsQuery("ZONE"));
  const citiesQ = useQuery(optionsQuery("CITY"));
  const clustersQ = useQuery(optionsQuery("CLUSTER"));
  const propsQ = useQuery(optionsQuery("PROPERTY"));

  const loading =
    zonesQ.isLoading || citiesQ.isLoading || clustersQ.isLoading || propsQ.isLoading;

  /* ── tree ──────────────────────────────────────────────────────────────── */

  const { roots, byId, parentOf } = React.useMemo(() => {
    const mk = (o: ScopeOption, kind: NodeKind): Node => ({
      id: o.id, kind, name: o.name, sublabel: o.sublabel ?? null,
      parentId: o.parentId ?? null, children: [], roomCount: o.roomCount ?? 0,
    });
    const zones = (zonesQ.data?.data ?? []).map((o) => mk(o, "zone"));
    const cities = (citiesQ.data?.data ?? []).map((o) => mk(o, "city"));
    const clusters = (clustersQ.data?.data ?? []).map((o) => mk(o, "cluster"));
    const properties = (propsQ.data?.data ?? []).map((o) => mk(o, "property"));

    const index = new Map<string, Node>();
    [...zones, ...cities, ...clusters, ...properties].forEach((n) => index.set(n.id, n));

    /* A child whose parent is missing (a cluster pointing at a retired city, a
       property in no cluster) would silently vanish from the tree. Surface it
       at the top instead — invisible is how scope drifts unnoticed. */
    const orphans: Node[] = [];
    const attach = (child: Node) => {
      const p = child.parentId ? index.get(child.parentId) : null;
      if (p) p.children.push(child);
      else orphans.push(child);
    };
    cities.forEach(attach);
    clusters.forEach(attach);
    properties.forEach(attach);

    const pOf = new Map<string, Node | null>();
    const walk = (ns: Node[], parent: Node | null) => {
      ns.forEach((n) => { pOf.set(n.id, parent); walk(n.children, n); });
    };
    const top = [...zones, ...orphans];
    walk(top, null);
    return { roots: top, byId: index, parentOf: pOf };
  }, [zonesQ.data, citiesQ.data, clustersQ.data, propsQ.data]);

  /* ── selection ─────────────────────────────────────────────────────────── */

  const [whole, setWhole] = React.useState<Set<string>>(new Set());
  const [roomPicks, setRoomPicks] = React.useState<Map<string, Set<string>>>(new Map());
  const [openIds, setOpenIds] = React.useState<Set<string>>(new Set());
  const [query, setQuery] = React.useState("");
  const [filters, setFilters] = React.useState<Record<string, { floor?: number; wing?: string; type?: string }>>({});
  /** Rooms of every property the planner has opened, so counts stay honest. */
  const [roomsBy, setRoomsBy] = React.useState<Map<string, ScopeOption[]>>(new Map());

  /* Seed from an existing rule once the tree is available (schedule editing).
     `ready` gates the first `onChange`: without it the picker would report its
     own empty selection before seeding, the parent would store that null back
     as `initial`, and opening a saved schedule would silently clear its scope. */
  const seeded = React.useRef(false);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    if (byId.size === 0) return;
    if (seeded.current || !initial) { setReady(true); return; }
    seeded.current = true;
    const w = new Set<string>();
    const rp = new Map<string, Set<string>>();
    const within = initial.within ?? {};
    const take = (id: string) => {
      const kids = within[id];
      const node = byId.get(id);
      if (!kids) { w.add(id); return; }
      if (node?.kind === "property") rp.set(id, new Set(kids));
      else kids.forEach(take);
    };
    if (initial.level === "ORG") roots.forEach((r) => w.add(r.id));
    else initial.ids.forEach(take);
    setWhole(w);
    setRoomPicks(rp);
    setReady(true);
  }, [initial, byId, roots]);

  /** Leaves under a node: properties, or rooms when the template is room-grain. */
  const leafCount = React.useCallback((n: Node): number => {
    if (n.kind === "property") return targetType === "ROOM" ? n.roomCount : 1;
    return n.children.reduce((a, c) => a + leafCount(c), 0);
  }, [targetType]);

  const ancestorWhole = React.useCallback((n: Node): boolean => {
    let p = parentOf.get(n.id) ?? null;
    while (p) { if (whole.has(p.id)) return true; p = parentOf.get(p.id) ?? null; }
    return false;
  }, [parentOf, whole]);

  const selectedCount = React.useCallback((n: Node): number => {
    if (whole.has(n.id) || ancestorWhole(n)) return leafCount(n);
    if (n.kind === "property") {
      return targetType === "ROOM" ? (roomPicks.get(n.id)?.size ?? 0) : 0;
    }
    return n.children.reduce((a, c) => a + selectedCount(c), 0);
  }, [whole, ancestorWhole, leafCount, roomPicks, targetType]);

  type NodeState = "none" | "partial" | "full";
  const stateOf = React.useCallback((n: Node): NodeState => {
    const total = leafCount(n);
    if (total === 0) return "none";
    const sel = selectedCount(n);
    if (sel === 0) return "none";
    return sel >= total ? "full" : "partial";
  }, [leafCount, selectedCount]);

  /** Push a wholesale ancestor down one level so siblings survive a narrowing. */
  const pushDown = (w: Set<string>, n: Node) => {
    const chain: Node[] = [];
    let p = parentOf.get(n.id) ?? null;
    while (p) { chain.push(p); p = parentOf.get(p.id) ?? null; }
    chain.forEach((a) => {
      if (!w.has(a.id)) return;
      w.delete(a.id);
      a.children.forEach((c) => w.add(c.id));
    });
  };

  const clearUnder = (w: Set<string>, rp: Map<string, Set<string>>, n: Node) => {
    w.delete(n.id);
    rp.delete(n.id);
    n.children.forEach((c) => clearUnder(w, rp, c));
  };

  const toggleNode = (n: Node, on: boolean) => {
    const w = new Set(whole);
    const rp = new Map(roomPicks);
    pushDown(w, n);
    clearUnder(w, rp, n);
    if (on) w.add(n.id);
    setWhole(w);
    setRoomPicks(rp);
  };

  const toggleRoom = (prop: Node, roomId: string, on: boolean) => {
    const w = new Set(whole);
    const rp = new Map(roomPicks);
    const all = roomsBy.get(prop.id) ?? [];
    /* Turning a live property into a narrowed one starts from every room it has,
       so unticking one room removes exactly that room. */
    let cur = new Set(rp.get(prop.id) ?? []);
    if (w.has(prop.id) || ancestorWhole(prop)) {
      pushDown(w, prop);
      w.delete(prop.id);
      cur = new Set(all.map((r) => r.id));
    }
    if (on) cur.add(roomId); else cur.delete(roomId);
    if (cur.size === 0) rp.delete(prop.id);
    else if (cur.size >= prop.roomCount) { rp.delete(prop.id); w.add(prop.id); }
    else rp.set(prop.id, cur);
    setWhole(w);
    setRoomPicks(rp);
  };

  const selectRooms = (prop: Node, ids: string[]) => {
    const w = new Set(whole);
    const rp = new Map(roomPicks);
    pushDown(w, prop);
    w.delete(prop.id);
    if (ids.length >= prop.roomCount) { rp.delete(prop.id); w.add(prop.id); }
    else rp.set(prop.id, new Set(ids));
    setWhole(w);
    setRoomPicks(rp);
  };

  /* ── selection → rule ──────────────────────────────────────────────────── */

  const rule = React.useMemo<AuditScopeRule | null>(() => {
    if (roots.length === 0) return null;

    const within: Record<string, string[]> = {};
    /** Highest fully-selected nodes; partial ones contribute a `within` entry. */
    const collect = (n: Node): string[] => {
      const st = stateOf(n);
      if (st === "none") return [];
      if (st === "full" && !roomPicks.has(n.id)) return [n.id];
      if (n.kind === "property") {
        const picked = roomPicks.get(n.id);
        if (!picked || picked.size === 0) return [];
        within[n.id] = [...picked];
        return [n.id];
      }
      const kids = n.children.flatMap(collect);
      if (kids.length === 0) return [];
      within[n.id] = kids;
      return [n.id];
    };

    let ids = roots.flatMap(collect);
    if (ids.length === 0) return null;

    /* Whole estate: every top-level node taken in full and nothing narrowed. */
    const allTop = roots.length > 0 && roots.every((r) => stateOf(r) === "full");
    if (allTop && Object.keys(within).length === 0) return { level: "ORG", ids: [] };

    /* Collapse a single-chain anchor so the saved rule reads as what the planner
       picked — "1 cluster" rather than "1 zone, narrowed" describing the same set. */
    let level: AuditScopeRule["level"] = LEVEL_OF[byId.get(ids[0]!)?.kind ?? "zone"];
    while (ids.length === 1 && within[ids[0]!]) {
      const only = ids[0]!;
      const next = within[only]!;
      delete within[only];
      ids = next;
      const kind = byId.get(next[0]!)?.kind;
      if (kind) level = LEVEL_OF[kind];
      if (next.length !== 1) break;
    }
    /* After collapsing, ids can still straddle levels (a whole zone plus a lone
       cluster). Anchor on the shallowest so `within` narrows downward only. */
    const levels = ids.map((id) => LEVEL_OF[byId.get(id)?.kind ?? "zone"]);
    level = levels.reduce((a, b) => (ORDER.indexOf(b) < ORDER.indexOf(a) ? b : a), levels[0]!);

    return Object.keys(within).length ? { level, ids, within } : { level, ids };
  }, [roots, byId, stateOf, roomPicks]);

  /* ── live resolve ──────────────────────────────────────────────────────── */

  const resolveQ = useQuery({
    queryKey: ["/audit/schedules/view/resolve-scope", JSON.stringify(rule), targetType],
    queryFn: () =>
      apiFetch<{ data: ResolveResult }>("/audit/schedules/view/resolve-scope", {
        method: "POST",
        body: JSON.stringify({ scope: rule, targetType }),
      }),
    enabled: !!rule,
    /* The estate does not move between keystrokes; without this the card
       flickers back to a skeleton on every tick of the tree. */
    placeholderData: (prev) => prev,
  });
  const resolved = rule ? (resolveQ.data?.data ?? null) : null;

  const emit = React.useRef(onChange);
  emit.current = onChange;
  React.useEffect(() => { if (ready) emit.current(rule, resolved); }, [ready, rule, resolved]);

  /* ── search ────────────────────────────────────────────────────────────── */

  const q = query.trim().toLowerCase();
  const hits = React.useCallback((n: Node): boolean => n.name.toLowerCase().includes(q), [q]);
  const subtreeHits = React.useCallback((n: Node): boolean => {
    if (!q) return true;
    if (hits(n)) return true;
    if (n.children.some(subtreeHits)) return true;
    /* Room numbers only match once their property has been opened; searching a
       room number therefore finds it in any property already expanded. */
    if (n.kind === "property") {
      return (roomsBy.get(n.id) ?? []).some((r) => r.name.toLowerCase().includes(q));
    }
    return false;
  }, [q, hits, roomsBy]);

  /* ── render ────────────────────────────────────────────────────────────── */

  const expandAll = () => {
    const s = new Set<string>();
    const walk = (ns: Node[]) => ns.forEach((n) => { if (n.children.length) { s.add(n.id); walk(n.children); } });
    walk(roots);
    setOpenIds(s);
  };

  if (loading) return <Skeleton className="h-[280px] w-full rounded-[11px]" />;

  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex min-w-[190px] flex-1 items-center">
          <Search className="pointer-events-none absolute left-3 h-[15px] w-[15px] text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search zones, cities, clusters, properties…"
            aria-label="Search the estate"
            className="h-9 w-full rounded-[9px] border border-border bg-card pl-[34px] pr-3 text-[13px] outline-none focus:border-accent"
          />
        </div>
        <div className="flex overflow-hidden rounded-[9px] border border-border bg-card">
          <IconBtn label="Expand all" onClick={expandAll}><ChevronsUpDown className="h-4 w-4" /></IconBtn>
          <IconBtn label="Collapse all" onClick={() => setOpenIds(new Set())} divide>
            <ChevronsDownUp className="h-4 w-4" />
          </IconBtn>
          <IconBtn
            label="Clear selection"
            danger
            divide
            onClick={() => { setWhole(new Set()); setRoomPicks(new Map()); }}
          >
            <Eraser className="h-4 w-4" />
          </IconBtn>
        </div>
      </div>

      <div className="max-h-[300px] overflow-y-auto rounded-[11px] border border-border bg-card">
        {roots.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            No zones or clusters are configured yet.
          </p>
        ) : (
          <Rows
            nodes={roots}
            depth={0}
            targetType={targetType}
            openIds={openIds}
            setOpenIds={setOpenIds}
            stateOf={stateOf}
            leafCount={leafCount}
            selectedCount={selectedCount}
            whole={whole}
            roomPicks={roomPicks}
            toggleNode={toggleNode}
            toggleRoom={toggleRoom}
            selectRooms={selectRooms}
            filters={filters}
            setFilters={setFilters}
            roomsBy={roomsBy}
            setRoomsBy={setRoomsBy}
            query={q}
            hits={hits}
            subtreeHits={subtreeHits}
          />
        )}
      </div>

      <ResolveCard
        targetType={targetType}
        rule={rule}
        resolved={resolved}
        loading={resolveQ.isFetching && !resolved}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */

function IconBtn({
  label, onClick, children, danger, divide,
}: {
  label: string; onClick: () => void; children: React.ReactNode; danger?: boolean; divide?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-9 w-9 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground",
        divide && "border-l border-border",
        danger && "hover:bg-danger-soft hover:text-danger",
      )}
    >
      {children}
    </button>
  );
}

function Box({ state, disabled, onClick, label }: {
  state: "none" | "partial" | "full"; disabled?: boolean; onClick: () => void; label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "full" ? "true" : state === "partial" ? "mixed" : "false"}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[4.5px] border-2 text-white",
        state === "none" ? "border-border bg-card" : "border-accent bg-accent",
        disabled && "opacity-40",
      )}
    >
      {state === "full" && <Check className="h-3 w-3" strokeWidth={3} />}
      {state === "partial" && <Minus className="h-3 w-3" strokeWidth={3} />}
    </button>
  );
}

function Tag({ kind }: { kind: "live" | "fixed" | "empty" }) {
  const map = {
    live: ["all · live", "bg-success-soft text-success", "Stays in sync — anything added here later is audited too"],
    fixed: ["some · fixed", "bg-warning-soft text-warning", "An explicit list — things added here later are NOT picked up"],
    empty: ["empty", "bg-danger-soft text-danger", "Nothing under this — it would create no audits"],
  } as const;
  const [text, cls, title] = map[kind];
  return (
    <span title={title} className={cn("shrink-0 rounded-full px-[7px] py-px text-[10px] font-bold uppercase tracking-wider", cls)}>
      {text}
    </span>
  );
}

interface RowsProps {
  nodes: Node[];
  depth: number;
  targetType: "PROPERTY" | "ROOM";
  openIds: Set<string>;
  setOpenIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  stateOf: (n: Node) => "none" | "partial" | "full";
  leafCount: (n: Node) => number;
  selectedCount: (n: Node) => number;
  whole: Set<string>;
  roomPicks: Map<string, Set<string>>;
  toggleNode: (n: Node, on: boolean) => void;
  toggleRoom: (p: Node, roomId: string, on: boolean) => void;
  selectRooms: (p: Node, ids: string[]) => void;
  filters: Record<string, { floor?: number; wing?: string; type?: string }>;
  setFilters: React.Dispatch<React.SetStateAction<Record<string, { floor?: number; wing?: string; type?: string }>>>;
  roomsBy: Map<string, ScopeOption[]>;
  setRoomsBy: React.Dispatch<React.SetStateAction<Map<string, ScopeOption[]>>>;
  query: string;
  hits: (n: Node) => boolean;
  subtreeHits: (n: Node) => boolean;
}

function Rows(p: RowsProps) {
  return (
    <>
      {p.nodes.map((n) => {
        if (p.query && !p.subtreeHits(n)) return null;
        return <Row key={n.id} node={n} {...p} />;
      })}
    </>
  );
}

function Row({ node, ...p }: RowsProps & { node: Node }) {
  const st = p.stateOf(node);
  const total = p.leafCount(node);
  const isProperty = node.kind === "property";
  const roomGrain = p.targetType === "ROOM";
  const expandable = node.children.length > 0 || (isProperty && roomGrain && node.roomCount > 0);
  /* A search hit deep in the tree opens its ancestors so the match is visible
     without the planner having to guess which branch it is under. */
  const open = p.openIds.has(node.id) || (!!p.query && expandable && !p.hits(node));

  const toggleOpen = () =>
    p.setOpenIds((s) => {
      const x = new Set(s);
      x.has(node.id) ? x.delete(node.id) : x.add(node.id);
      return x;
    });

  const heading = node.kind === "zone" || node.kind === "city";

  return (
    <>
      <div
        className={cn(
          "flex min-h-[38px] items-center gap-2 border-b border-border pr-3 last:border-0",
          node.kind === "zone" && "bg-muted",
          node.kind === "city" && "bg-muted/40",
        )}
        style={{ paddingLeft: 8 + p.depth * 18 }}
      >
        <button
          type="button"
          onClick={expandable ? toggleOpen : undefined}
          aria-expanded={expandable ? open : undefined}
          aria-label={expandable ? `${open ? "Collapse" : "Expand"} ${node.name}` : undefined}
          className={cn(
            "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-muted-foreground",
            expandable ? "hover:bg-muted hover:text-foreground" : "invisible",
          )}
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        </button>

        <Box
          state={st}
          disabled={total === 0}
          label={node.name}
          onClick={() => p.toggleNode(node, st !== "full")}
        />

        <button
          type="button"
          onClick={() => (expandable ? toggleOpen() : total && p.toggleNode(node, st !== "full"))}
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            heading
              ? "font-display text-[11.5px] font-bold uppercase tracking-[0.07em] text-muted-foreground"
              : "text-[13px]",
            p.query && p.hits(node) && "text-accent-strong",
          )}
        >
          {node.name}
        </button>

        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {total === 0 ? "empty" : `${total} ${roomGrain ? "room" : "propert"}${total === 1 ? (roomGrain ? "" : "y") : roomGrain ? "s" : "ies"}`}
        </span>

        {total === 0 ? <Tag kind="empty" />
          : p.whole.has(node.id) ? <Tag kind="live" />
          : st === "partial" ? <Tag kind="fixed" />
          : null}
      </div>

      {open && isProperty && roomGrain && node.roomCount > 0 && (
        <RoomBlock node={node} {...p} />
      )}
      {open && node.children.length > 0 && (
        <Rows {...p} nodes={node.children} depth={p.depth + 1} />
      )}
    </>
  );
}

function RoomBlock({ node, ...p }: RowsProps & { node: Node }) {
  const depth = p.depth;
  const roomsQ = useQuery({
    queryKey: ["/audit/schedules/view/scope-options", "ROOM", node.id],
    queryFn: () =>
      apiFetch<ApiList<ScopeOption>>(`/audit/schedules/view/scope-options?level=ROOM&propertyId=${node.id}`),
  });

  const rooms = React.useMemo(() => roomsQ.data?.data ?? [], [roomsQ.data]);
  const setRoomsBy = p.setRoomsBy;
  React.useEffect(() => {
    if (!rooms.length) return;
    setRoomsBy((m) => (m.get(node.id) === rooms ? m : new Map(m).set(node.id, rooms)));
  }, [rooms, node.id, setRoomsBy]);

  const f = p.filters[node.id] ?? {};
  const visible = rooms.filter((r) => {
    if (f.floor !== undefined && r.floor !== f.floor) return false;
    if (f.wing !== undefined && r.wing !== f.wing) return false;
    if (f.type !== undefined && r.roomType !== f.type) return false;
    if (p.query && !p.hits(node)) return r.name.toLowerCase().includes(p.query);
    return true;
  });

  const picked = p.roomPicks.get(node.id);
  const wholeProp = p.whole.has(node.id);
  const isOn = (id: string) => wholeProp || (picked?.has(id) ?? false);

  const set = (key: "floor" | "wing" | "type", v: number | string) =>
    p.setFilters((s) => {
      const cur = s[node.id] ?? {};
      const next = { ...cur };
      if (cur[key] === v) delete next[key];
      else (next[key] as number | string) = v;
      return { ...s, [node.id]: next };
    });

  const floors = [...new Set(rooms.map((r) => r.floor).filter((x): x is number => x != null))].sort((a, b) => a - b);
  const wings = [...new Set(rooms.map((r) => r.wing).filter((x): x is string => !!x))].sort();
  const types = [...new Set(rooms.map((r) => r.roomType).filter((x): x is string => !!x))].sort();

  if (roomsQ.isLoading) {
    return (
      <div className="flex items-center gap-2 border-b border-border py-2 text-[12px] text-muted-foreground"
        style={{ paddingLeft: 8 + (depth + 1) * 18 + 26 }}>
        <Loader2 className="h-3 w-3 animate-spin" /> Loading rooms…
      </div>
    );
  }

  return (
    <>
      {/* Filter first: at estate scale, picking "every third-floor room" is the
          only workable interaction — ticking 13 boxes per property is not. */}
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 py-2 pr-3"
        style={{ paddingLeft: 8 + (depth + 1) * 18 + 26 }}
      >
        <span className="mr-0.5 font-display text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
          Filter
        </span>
        {floors.map((v) => <Chip key={`f${v}`} on={f.floor === v} onClick={() => set("floor", v)}>{`Floor ${v}`}</Chip>)}
        {wings.map((v) => <Chip key={`w${v}`} on={f.wing === v} onClick={() => set("wing", v)}>{`Wing ${v}`}</Chip>)}
        {types.map((v) => (
          <Chip key={`t${v}`} on={f.type === v} onClick={() => set("type", v)}>
            {v.charAt(0) + v.slice(1).toLowerCase()}
          </Chip>
        ))}
        <button
          type="button"
          onClick={() => p.selectRooms(node, visible.map((r) => r.id))}
          disabled={visible.length === 0}
          className="rounded-full border border-accent bg-accent/10 px-2.5 py-[3px] font-display text-[12px] font-semibold text-accent-strong disabled:opacity-50"
        >
          Select these {visible.length}
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="border-b border-border py-3 text-center text-[12.5px] text-muted-foreground">
          No rooms match that filter.
        </div>
      ) : (
        visible.map((r) => (
          <div
            key={r.id}
            className="flex min-h-[34px] items-center gap-2 border-b border-border pr-3 last:border-0"
            style={{ paddingLeft: 8 + (depth + 1) * 18 }}
          >
            <span className="h-[22px] w-[22px] shrink-0" />
            <Box
              state={isOn(r.id) ? "full" : "none"}
              label={`Room ${r.name}`}
              onClick={() => p.toggleRoom(node, r.id, !isOn(r.id))}
            />
            <span className="min-w-0 flex-1 truncate text-[13px]">{r.name}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              Floor {r.floor} · Wing {r.wing ?? "—"} ·{" "}
              {(r.roomType ?? "").charAt(0) + (r.roomType ?? "").slice(1).toLowerCase()}
            </span>
          </div>
        ))
      )}
    </>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-[3px] font-display text-[12px] font-semibold",
        on ? "border-accent bg-accent text-white" : "border-border bg-card text-muted-foreground hover:border-accent/50",
      )}
    >
      {children}
    </button>
  );
}

function ResolveCard({ targetType, rule, resolved, loading }: {
  targetType: "PROPERTY" | "ROOM";
  rule: AuditScopeRule | null;
  resolved: ResolveResult | null;
  loading: boolean;
}) {
  const noun = targetType === "ROOM" ? "room audit" : "property audit";

  if (!rule) {
    return (
      <div className="rounded-[11px] border border-border bg-background px-[13px] py-[11px]">
        <div className="font-display text-[19px] font-extrabold text-muted-foreground">No targets yet</div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Tick anything above. A whole branch stays live, so sites added to it later are audited automatically.
        </p>
      </div>
    );
  }

  if (loading || !resolved) {
    return (
      <div className="flex items-center gap-2 rounded-[11px] border border-border bg-background px-[13px] py-[15px] text-[13px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working out what this covers…
      </div>
    );
  }

  /* Zero is the case worth shouting about: a cluster with no properties saves
     happily and then produces nothing, which used to be invisible until the
     first cycle came and went. */
  const zero = resolved.total === 0;
  return (
    <div className={cn(
      "rounded-[11px] border px-[13px] py-[11px]",
      zero ? "border-danger bg-danger-soft" : "border-border bg-background",
    )}>
      <div className={cn(
        "font-display text-[22px] font-extrabold",
        zero ? "text-danger" : "text-accent-strong",
      )}>
        {zero
          ? "Nothing in scope"
          : `${resolved.total.toLocaleString()} ${noun}${resolved.total === 1 ? "" : "s"} per cycle`}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {zero
          ? "Everything picked is empty, so this schedule would create no audits. Widen the scope before saving."
          : `Across ${resolved.propertyCount} ${resolved.propertyCount === 1 ? "property" : "properties"} · re-checked every cycle, so new sites are picked up automatically`}
      </div>
      {!zero && targetType === "ROOM" && resolved.breakdown.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {resolved.breakdown.slice(0, 8).map((b) => (
            <span key={b.propertyId} className="rounded-[6px] bg-muted px-2 py-px font-mono text-[11px] text-muted-foreground">
              {b.propertyName} — {b.selected}/{b.total}
            </span>
          ))}
          {(resolved.breakdown.length > 8 || resolved.breakdownTruncated) && (
            <span className="rounded-[6px] bg-muted px-2 py-px font-mono text-[11px] text-muted-foreground">
              +{resolved.propertyCount - Math.min(8, resolved.breakdown.length)} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}
