import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { accessApi, accessKeys, type AccessGrantRow } from "@/lib/access-api";
import { ScreenHeader, Card, Badge, NodeType, GrantStatus, EmptyState } from "./ui";

/**
 * Grants (PRD §30 → Access Control → "Scopes").
 *
 * A grant is the only thing that creates access: a subject, a role, a node, a
 * reach, and a window of time. §24's ten scopes are this one row shape with
 * different values — which is why the form is five questions rather than ten
 * special cases.
 */

const DATA_SCOPES = [
  { key: "ALL", hint: "Everything at the node" },
  { key: "TEAM", hint: "Their reports' records" },
  { key: "ASSIGNED", hint: "Only what is assigned to them" },
  { key: "SELF", hint: "Only their own records" },
];

function statusOf(g: AccessGrantRow): "active" | "pending" | "expired" | "revoked" {
  if (g.revokedAt) return "revoked";
  if (g.expiresAt && new Date(g.expiresAt) < new Date()) return "expired";
  if (new Date(g.effectiveFrom) > new Date()) return "pending";
  return "active";
}

/** Why a live-looking grant grants nothing. */
function inertReason(g: AccessGrantRow): string | null {
  if (statusOf(g) !== "active") return null;
  if (g.nodeId && !g.nodeName) return "The node this grant points at no longer exists, so it resolves to nothing.";
  return null;
}

export default function GrantsScreen() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [showNew, setShowNew] = React.useState(false);
  const [revoking, setRevoking] = React.useState<AccessGrantRow | null>(null);
  const [revokeReason, setRevokeReason] = React.useState("");

  // New-grant form
  const [subjectId, setSubjectId] = React.useState<string | null>(null);
  const [roleKey, setRoleKey] = React.useState("*");
  const [nodeId, setNodeId] = React.useState<string | null>(null);
  const [includeDescendants, setIncludeDescendants] = React.useState(true);
  const [followLinks, setFollowLinks] = React.useState(false);
  const [dataScope, setDataScope] = React.useState("ALL");
  const [expiresAt, setExpiresAt] = React.useState("");

  const grants = useQuery({ queryKey: accessKeys.grants(), queryFn: () => accessApi.grants() });
  const users = useQuery({ queryKey: accessKeys.users(), queryFn: accessApi.users });
  const nodes = useQuery({ queryKey: accessKeys.nodes(), queryFn: accessApi.nodes });
  const roles = useQuery({ queryKey: accessKeys.roles(), queryFn: accessApi.roles });

  // Only module roles are grantable; see the picker below.
  const moduleRoles = (roles.data ?? []).filter((r) => r.scopeModule && r.isActive !== false);
  const selectedRole = moduleRoles.find((r) => r.key === roleKey);
  const selectedNode = (nodes.data ?? []).find((n) => n.id === nodeId);
  const isLeaf = selectedNode?.nodeType === "ROOM" || selectedNode?.nodeType === "BED";

  const reset = () => {
    setSubjectId(null); setRoleKey("*"); setNodeId(null);
    setIncludeDescendants(true); setFollowLinks(false);
    setDataScope("ALL"); setExpiresAt("");
  };

  const create = useMutation({
    mutationFn: () =>
      accessApi.createGrant({
        subjectId: subjectId!,
        roleKey,
        nodeId,
        // A room or bed grant cannot include descendants — the API refuses it,
        // so do not offer it either.
        includeDescendants: isLeaf ? false : includeDescendants,
        followLinks,
        dataScope,
        expiresAt: expiresAt || null,
      }),
    onSuccess: () => {
      toast({ title: "Grant created" });
      setShowNew(false); reset();
      void qc.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (e) => {
      const err = e as { message?: string; details?: Record<string, unknown> };
      toast({
        title: "Refused",
        // Every guard returns a sentence plus a machine code; show the sentence.
        description: err.message ?? "The grant was refused before anything was written.",
        variant: "destructive",
      });
    },
  });

  const revoke = useMutation({
    mutationFn: () => accessApi.revokeGrant(revoking!.id, revokeReason),
    onSuccess: () => {
      toast({ title: "Grant revoked", description: "Recorded on the activity trail." });
      setRevoking(null); setRevokeReason("");
      void qc.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (e) => toast({ title: "Could not revoke", description: (e as Error).message, variant: "destructive" }),
  });

  const restore = useMutation({
    mutationFn: (g: AccessGrantRow) => accessApi.restoreGrant(g.id, "Restored from the grants screen"),
    onSuccess: () => {
      toast({ title: "Grant restored" });
      void qc.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (e) => toast({ title: "Could not restore", description: (e as Error).message, variant: "destructive" }),
  });

  const rows = (grants.data ?? []).filter((g) => {
    if (status && statusOf(g) !== status) return false;
    if (!q.trim()) return true;
    const n = q.toLowerCase();
    return [g.userName, g.userEmail, g.nodeName, g.roleKey].some((v) => (v ?? "").toLowerCase().includes(n));
  });

  const people = new Set((grants.data ?? []).filter((g) => !g.revokedAt).map((g) => g.subjectId)).size;

  return (
    <>
      <ScreenHeader
        kicker="Grants"
        title={`${(grants.data ?? []).filter((g) => !g.revokedAt).length} grants place ${people} people`}
        sub="A grant is the only thing that creates access: a role, a node, a reach, and a window of time."
        actions={
          <button
            onClick={() => setShowNew(true)}
            className="rounded-[9px] bg-[var(--accent)] px-4 py-2 text-[12.5px] font-semibold text-white"
          >
            New grant
          </button>
        }
      />

      <div className="flex flex-col gap-4 px-6 pb-16 pt-5 sm:px-8">
        <Card>
          <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-[var(--muted)]" />
              <Input
                className="h-8 w-[230px] pl-7 text-[12.5px]"
                placeholder="Search person, role or node…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {["", "active", "pending", "expired", "revoked"].map((s) => (
                <button
                  key={s || "all"}
                  onClick={() => setStatus(s)}
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 text-[12px]",
                    status === s
                      ? "border-[var(--accent)] bg-[var(--coral-bg)] font-medium text-[var(--accent-strong)]"
                      : "border-[var(--border)] text-[var(--muted)]",
                  )}
                >
                  {s || "All"}
                </button>
              ))}
            </div>
            <span className="ml-auto font-mono text-[11.5px] text-[var(--muted)]">{rows.length} shown</span>
          </div>

          {grants.isLoading ? (
            <div className="p-4"><Skeleton className="h-64 w-full" /></div>
          ) : rows.length === 0 ? (
            <div className="p-5"><EmptyState title="No grants match" sub="Try a different filter." /></div>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex min-w-[880px] items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-[10px] uppercase tracking-[0.06em] text-[var(--ink3)]">
                <div className="min-w-[140px] flex-[2]">Person</div>
                <div className="min-w-[120px] flex-[2]">Role</div>
                <div className="min-w-[150px] flex-[2.4]">Scope node</div>
                <div className="w-[96px] shrink-0">Data</div>
                <div className="w-[120px] shrink-0">Validity</div>
                <div className="w-[150px] shrink-0 text-right">Status</div>
              </div>
              {rows.map((g) => {
                const st = statusOf(g);
                const inert = inertReason(g);
                return (
                  <div key={g.id} className="border-b border-[var(--border)] px-4 py-3 last:border-b-0">
                    <div className="flex min-w-[880px] items-center gap-3">
                      <div className="min-w-[140px] flex-[2]">
                        <div className="text-[13px] font-medium">{g.userName ?? g.subjectId}</div>
                        <div className="text-[10.5px] text-[var(--muted)]">{g.userEmail}</div>
                      </div>
                      <div className="flex min-w-[120px] flex-[2] flex-col items-start gap-1">
                        <Badge tone={g.roleKey === "*" ? "neutral" : "violet"}>
                          {g.roleKey === "*" ? "general" : g.roleKey}
                        </Badge>
                        {g.assignmentKind !== "GRANT" && (
                          <span className="font-mono text-[9.5px] text-[var(--ink3)]">{g.assignmentKind}</span>
                        )}
                      </div>
                      <div className="min-w-[150px] flex-[2.4]">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {g.nodeId ? <NodeType type={g.nodeType ?? "?"} /> : null}
                          <span className="text-[12.5px]">{g.nodeId ? (g.nodeName ?? g.nodeId) : "Organization-wide"}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {/* The kitchen spine, made visible — it is the one
                              difference between a food grant and an audit one.
                              Compact by necessity, so the sentence is on hover. */}
                          {g.followLinks && (
                            <Badge
                              tone="violet"
                              title="Also reaches properties served by kitchens under this node, including ones in other clusters"
                            >
                              +kitchens
                            </Badge>
                          )}
                          {!g.includeDescendants && <Badge>exact</Badge>}
                        </div>
                      </div>
                      <div className="w-[96px] shrink-0"><Badge>{g.dataScope}</Badge></div>
                      <div className="w-[120px] shrink-0 font-mono text-[11px] text-[var(--muted)]">
                        {g.expiresAt ? `→ ${new Date(g.expiresAt).toLocaleDateString("en-IN")}` : "no expiry"}
                      </div>
                      <div className="flex w-[150px] shrink-0 items-center justify-end gap-2">
                        <GrantStatus status={st} />
                        {st === "revoked" ? (
                          <button
                            onClick={() => restore.mutate(g)}
                            className="rounded-[7px] border border-[var(--bd2)] px-2.5 py-1 text-[11px] text-[var(--muted)]"
                          >
                            Restore
                          </button>
                        ) : (
                          <button
                            onClick={() => setRevoking(g)}
                            className="rounded-[7px] border border-[var(--bd2)] px-2.5 py-1 text-[11px] text-[var(--muted)]"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    </div>
                    {inert && (
                      <div className="mt-2 rounded-lg bg-[var(--muted-bg)] px-3 py-2 text-[11.5px] text-[var(--muted)] [text-wrap:pretty]">
                        <span className="font-semibold text-[var(--ink)]">Inert.</span> {inert}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* ── New grant ───────────────────────────────────────────────── */}
      {showNew && (
        <div className="fixed inset-0 z-40 flex justify-end bg-[var(--scrim)]">
          <div className="flex h-full w-[min(560px,100%)] flex-col overflow-auto border-l border-[var(--bd2)] bg-[var(--card)]">
            <div className="border-b border-[var(--border)] px-[22px] pb-4 pt-5">
              <div className="font-display text-[20px] font-semibold tracking-[-0.015em]">New grant</div>
              <div className="mt-1 text-[12.5px] text-[var(--muted)] [text-wrap:pretty]">
                {subjectId && nodeId
                  ? `${users.data?.find((u) => u.id === subjectId)?.name} will act at ${selectedNode?.name}${isLeaf ? "" : includeDescendants ? " and everything beneath it" : " only"}.`
                  : "A role, a node, a reach, and a window of time."}
              </div>
            </div>

            <div className="flex flex-1 flex-col gap-5 px-[22px] py-5">
              <div>
                <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">1 · Person</div>
                <Combobox
                  options={(users.data ?? []).map((u) => ({ value: u.id, label: `${u.name} — ${u.role}`, keywords: [u.email] }))}
                  value={subjectId}
                  onChange={setSubjectId}
                  placeholder="Select a person…"
                  searchPlaceholder="Search…"
                />
              </div>

              <div>
                <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">2 · Role</div>
                <Combobox
                  options={[
                    { value: "*", label: "General — the person's own role" },
                    // MODULE roles only. A grant never names a PLATFORM role:
                    // the person already has one, and "*" means exactly that.
                    // Offering WARDEN here would imply a grant can change what
                    // someone is, which is the users screen's job, not this one.
                    ...moduleRoles.map((r) => ({
                      value: r.key,
                      label: `${r.label} — ${r.scopeModule}`,
                      keywords: [r.key, r.description ?? ""],
                    })),
                  ]}
                  value={roleKey}
                  onChange={(v) => setRoleKey(v ?? "*")}
                  placeholder="General"
                  searchPlaceholder="Search roles…"
                />
                <div className="mt-2 text-[11.5px] text-[var(--muted)] [text-wrap:pretty]">
                  {selectedRole
                    ? `${selectedRole.description ?? selectedRole.label} — inside ${selectedRole.scopeModule} only. It does not widen their general scope.`
                    : "General places the person's own role at this node. A module role (e.g. Auditor) confers access inside that module only, and does not widen general scope."}
                </div>
              </div>

              <div>
                <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">3 · Node</div>
                <Combobox
                  options={(nodes.data ?? []).filter((n) => n.isActive).map((n) => ({
                    value: n.id, label: `${n.name}`, keywords: [n.nodeType],
                  }))}
                  value={nodeId}
                  onChange={setNodeId}
                  placeholder="Select a node…"
                  searchPlaceholder="Search the org tree…"
                  allowClear
                />
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button
                    onClick={() => setIncludeDescendants((v) => !v)}
                    disabled={isLeaf}
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 text-[12px]",
                      isLeaf && "cursor-not-allowed opacity-50",
                      includeDescendants && !isLeaf
                        ? "border-[var(--accent)] bg-[var(--coral-bg)] text-[var(--accent-strong)]"
                        : "border-[var(--border)] text-[var(--muted)]",
                    )}
                  >
                    Include everything beneath
                  </button>
                  <button
                    onClick={() => setFollowLinks((v) => !v)}
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 text-[12px]",
                      followLinks
                        ? "border-[var(--pop)] bg-[var(--violet-bg)] text-[var(--pop)]"
                        : "border-[var(--border)] text-[var(--muted)]",
                    )}
                  >
                    Include kitchen-served properties
                  </button>
                </div>
                <div className="mt-2 text-[11.5px] text-[var(--muted)] [text-wrap:pretty]">
                  {isLeaf
                    ? "A room or bed has nothing beneath it, so this grant covers that node exactly."
                    : followLinks
                      ? "Also reaches properties served by kitchens under this node, even where they sit in another cluster. Food scoping does this; audit scoping does not."
                      : "Geographic reach only — a kitchen under this node feeds properties in other clusters, and those are not included."}
                </div>
              </div>

              <div>
                <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">4 · Data scope</div>
                <div className="flex flex-wrap gap-2">
                  {DATA_SCOPES.map((d) => (
                    <button
                      key={d.key}
                      onClick={() => setDataScope(d.key)}
                      className={cn(
                        "flex flex-col items-start rounded-lg border px-3 py-2 text-left",
                        dataScope === d.key
                          ? "border-[var(--accent)] bg-[var(--coral-bg)]"
                          : "border-[var(--border)]",
                      )}
                    >
                      <span className="text-[12.5px] font-semibold">{d.key}</span>
                      <span className="text-[10.5px] text-[var(--muted)]">{d.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">5 · Validity</div>
                <label className="mb-1 block text-[10.5px] text-[var(--muted)]">Expires at (blank = never)</label>
                <input
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 font-mono text-[12.5px] outline-none"
                />
              </div>
            </div>

            <div className="sticky bottom-0 flex justify-end gap-2.5 border-t border-[var(--border)] bg-[var(--card)] px-[22px] py-3.5">
              <button onClick={() => { setShowNew(false); reset(); }} className="rounded-[9px] border border-[var(--bd2)] px-3.5 py-2 text-[12.5px]">
                Cancel
              </button>
              <button
                disabled={!subjectId || create.isPending}
                onClick={() => create.mutate()}
                className={cn(
                  "rounded-[9px] px-4 py-2 text-[12.5px] font-semibold text-white",
                  subjectId && !create.isPending ? "bg-[var(--accent)]" : "cursor-not-allowed bg-[var(--bd2)]",
                )}
              >
                {create.isPending ? "Creating…" : "Create grant"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Revoke ──────────────────────────────────────────────────── */}
      {revoking && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--scrim)] p-6">
          <div className="w-[min(500px,100%)] rounded-2xl border border-[var(--bd2)] bg-[var(--card)] shadow-[var(--overlay-shadow)]">
            <div className="border-b border-[var(--border)] px-[22px] pb-3.5 pt-5">
              <div className="font-display text-[19px] font-semibold tracking-[-0.015em]">Revoke this grant</div>
              <div className="mt-1 text-[12.5px] text-[var(--muted)] [text-wrap:pretty]">
                {revoking.userName} loses access at {revoking.nodeName ?? "this node"} immediately. The grant is kept and can be restored.
              </div>
            </div>
            <div className="px-[22px] pb-5 pt-4">
              <label className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
                Reason (required)
              </label>
              <textarea
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                placeholder="e.g. Transferred to Mumbai cluster — access moved, not removed."
                className="min-h-[70px] w-full resize-y rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[13px] outline-none"
              />
            </div>
            <div className="flex justify-end gap-2.5 border-t border-[var(--border)] px-[22px] py-3.5">
              <button onClick={() => { setRevoking(null); setRevokeReason(""); }} className="rounded-[9px] border border-[var(--bd2)] px-3.5 py-2 text-[12.5px]">
                Cancel
              </button>
              <button
                disabled={!revokeReason.trim() || revoke.isPending}
                onClick={() => revoke.mutate()}
                className={cn(
                  "rounded-[9px] px-4 py-2 text-[12.5px] font-semibold text-white",
                  revokeReason.trim() && !revoke.isPending ? "bg-[var(--danger)]" : "cursor-not-allowed bg-[var(--bd2)]",
                )}
              >
                {revoke.isPending ? "Revoking…" : "Revoke"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
