import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { Combobox } from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { accessApi, accessKeys } from "@/lib/access-api";
import { Card, CardHead, Badge, NodeType } from "./ui";

/**
 * Where one person works, and how to copy someone else's access onto them.
 *
 * Extracted so the Assignments tab and the Access preview can both mount it.
 * The preview already answers "what can this person do, and why" with a person
 * picker at the top — being told the answer is "nothing places them anywhere"
 * and then having to go to another tab to fix it is the kind of seam that only
 * makes sense to whoever drew the tabs.
 *
 * ONE implementation, two mounts: a second copy of this form would drift from
 * the first within a release, and the half that drifted would be the one
 * writing grants.
 */

/** Home property + additional properties for one person. */
export function AssignmentEditor({
  userId,
  onSaved,
  compact = false,
}: {
  userId: string;
  onSaved?: () => void;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [primary, setPrimary] = React.useState<string | null>(null);
  const [secondary, setSecondary] = React.useState<Set<string>>(new Set());
  const [reason, setReason] = React.useState("");
  const [dirty, setDirty] = React.useState(false);

  const nodes = useQuery({ queryKey: accessKeys.nodes(), queryFn: accessApi.nodes });
  const current = useQuery({
    queryKey: accessKeys.assignments(userId),
    queryFn: () => accessApi.assignments(userId),
    enabled: !!userId,
  });

  const properties = (nodes.data ?? []).filter((n) => n.nodeType === "PROPERTY" && n.isActive);

  // Load the stored assignment when the subject changes; local edits win after.
  React.useEffect(() => {
    if (!current.data) return;
    setPrimary(current.data.primary?.nodeId ?? null);
    setSecondary(new Set(current.data.secondary.map((s) => s.nodeId)));
    setDirty(false);
    setReason("");
  }, [current.data]);

  const save = useMutation({
    mutationFn: () =>
      accessApi.setAssignments(userId, {
        primaryNodeId: primary,
        secondaryNodeIds: [...secondary],
        reason,
      }),
    onSuccess: () => {
      toast({ title: "Assignment saved", description: "Recorded on the activity trail." });
      setDirty(false);
      setReason("");
      void qc.invalidateQueries({ queryKey: ["access"] });
      onSaved?.();
    },
    onError: (e) => {
      const err = e as { message?: string };
      toast({
        title: "Could not save",
        description: err.message ?? "The change was refused before anything was written.",
        variant: "destructive",
      });
    },
  });

  const toggleSecondary = (id: string) => {
    const next = new Set(secondary);
    next.has(id) ? next.delete(id) : next.add(id);
    // A property cannot be both home and additional.
    if (id === primary) setPrimary(null);
    setSecondary(next);
    setDirty(true);
  };

  if (current.isLoading) return <Skeleton className="h-56 w-full rounded-xl" />;

  return (
    <>
      <Card>
        <CardHead>Home property — one only</CardHead>
        <div className={cn("flex flex-col gap-1 p-2", compact && "max-h-[220px] overflow-y-auto")}>
          {properties.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setPrimary(p.id === primary ? null : p.id);
                const next = new Set(secondary);
                next.delete(p.id);
                setSecondary(next);
                setDirty(true);
              }}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]",
                primary === p.id ? "bg-[var(--coral-bg)] font-medium text-[var(--accent-strong)]" : "hover:bg-[var(--muted-bg)]",
              )}
            >
              <NodeType type="PROPERTY" />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {primary === p.id && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <CardHead>Also works at</CardHead>
        <div className="flex flex-wrap gap-2 p-3">
          {properties
            .filter((p) => p.id !== primary)
            .map((p) => (
              <button
                key={p.id}
                onClick={() => toggleSecondary(p.id)}
                className={cn(
                  "rounded-lg border px-2.5 py-1.5 text-[12.5px]",
                  secondary.has(p.id)
                    ? "border-[var(--accent)] bg-[var(--coral-bg)] font-medium text-[var(--accent-strong)]"
                    : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--bd2)]",
                )}
              >
                {p.name}
              </button>
            ))}
        </div>
      </Card>

      {dirty && (
        <Card className="p-4">
          <label className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
            Reason for this change (required)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Covering Whitefield while the warden is on leave — reverts 30 Sep."
            className="min-h-[70px] w-full resize-y rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[13px] outline-none"
          />
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2.5">
            <span className="mr-auto text-[11.5px] text-[var(--muted)]">
              {primary ? "" : "Without a home property this person is unrestricted under the legacy check."}
            </span>
            <button
              onClick={() => { void current.refetch(); setDirty(false); }}
              className="rounded-[9px] border border-[var(--bd2)] px-3.5 py-2 text-[12.5px]"
            >
              Discard
            </button>
            <button
              disabled={!reason.trim() || save.isPending}
              onClick={() => save.mutate()}
              className={cn(
                "rounded-[9px] px-4 py-2 text-[12.5px] font-semibold text-white",
                reason.trim() && !save.isPending ? "bg-[var(--accent)]" : "cursor-not-allowed bg-[var(--bd2)]",
              )}
            >
              {save.isPending ? "Saving…" : "Save assignment"}
            </button>
          </div>
        </Card>
      )}
    </>
  );
}

/**
 * "Give this person the same access as…" — role, grants and exceptions at once.
 *
 * Shows the DRY RUN before anything is written, because the request is made
 * from memory of what the other person does, not from knowledge of what they
 * hold — and because it REPLACES rather than merges, which is only safe if what
 * goes away is named first.
 */
export function CopyAccessPanel({ userId, onDone }: { userId: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [copyFrom, setCopyFrom] = React.useState<string | null>(null);
  const [copyReason, setCopyReason] = React.useState("");
  const [parts, setParts] = React.useState({ role: true, grants: true, overrides: true });

  const users = useQuery({ queryKey: accessKeys.users(), queryFn: accessApi.users });
  const plan = useQuery({
    queryKey: accessKeys.clonePlan(copyFrom ?? "", userId),
    queryFn: () => accessApi.clonePlan(copyFrom!, userId),
    enabled: !!copyFrom && !!userId,
  });

  const clone = useMutation({
    mutationFn: () =>
      accessApi.cloneAccess({ fromUserId: copyFrom!, toUserId: userId, reason: copyReason, ...parts }),
    onSuccess: (d) => {
      toast({
        title: "Access copied",
        description: `${d.grants} grants and ${d.overrides} exceptions applied${d.role ? ", role changed" : ""}.`,
      });
      setCopyFrom(null);
      setCopyReason("");
      void qc.invalidateQueries({ queryKey: ["access"] });
      onDone?.();
    },
    onError: (e) =>
      toast({ title: "Refused", description: (e as Error).message ?? "Nothing was copied.", variant: "destructive" }),
  });

  return (
    <Card>
      <CardHead
        right={
          copyFrom && (
            <button
              onClick={() => { setCopyFrom(null); setCopyReason(""); }}
              className="rounded-[7px] border border-[var(--border)] px-2.5 py-1 text-[11.5px] text-[var(--muted)]"
            >
              Cancel
            </button>
          )
        }
      >
        Copy access from someone
      </CardHead>
      <div className="px-[18px] py-3.5">
        <Combobox
          options={(users.data ?? [])
            .filter((u) => u.id !== userId)
            .map((u) => ({ value: u.id, label: `${u.name} — ${u.role}`, keywords: [u.email, u.role] }))}
          value={copyFrom}
          onChange={(v) => setCopyFrom(v)}
          placeholder="Give this person the same access as…"
          searchPlaceholder="Search by name, email or role…"
          allowClear
        />

        {copyFrom && plan.isLoading && <Skeleton className="mt-3 h-32 w-full rounded-xl" />}

        {plan.data && (
          <div className="mt-3.5 flex flex-col gap-2.5">
            <div className="rounded-[10px] border border-dashed border-[var(--bd2)] px-3 py-2.5 text-[12px] text-[var(--muted)] [text-wrap:pretty]">
              This <strong className="font-semibold text-[var(--ink)]">replaces</strong> {plan.data.to.name}&rsquo;s
              current access — {plan.data.grants.replacing.length} grant
              {plan.data.grants.replacing.length === 1 ? "" : "s"} and {plan.data.overrides.replacing.length} exception
              {plan.data.overrides.replacing.length === 1 ? "" : "s"} are removed, not added to.
            </div>

            <label className="flex items-start gap-2.5 rounded-[10px] border border-[var(--border)] px-3 py-2.5">
              <input
                type="checkbox"
                className="mt-1"
                checked={parts.role}
                onChange={(e) => setParts((p) => ({ ...p, role: e.target.checked }))}
              />
              <span className="min-w-0 flex-1">
                <span className="text-[13px] font-medium">Role</span>
                <span className="block text-[11.5px] text-[var(--muted)]">
                  {plan.data.role.changes
                    ? `${plan.data.role.current} → ${plan.data.role.incoming}`
                    : `Both are already ${plan.data.role.current}`}
                </span>
              </span>
              {plan.data.role.changes && <Badge tone="warn">changes</Badge>}
            </label>

            <label className="flex items-start gap-2.5 rounded-[10px] border border-[var(--border)] px-3 py-2.5">
              <input
                type="checkbox"
                className="mt-1"
                checked={parts.grants}
                onChange={(e) => setParts((p) => ({ ...p, grants: e.target.checked }))}
              />
              <span className="min-w-0 flex-1">
                <span className="text-[13px] font-medium">
                  Where they work — {plan.data.grants.incoming.length} grant
                  {plan.data.grants.incoming.length === 1 ? "" : "s"}
                </span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {plan.data.grants.incoming.map((g, i) => (
                    <Badge key={i} tone={g.assignmentKind === "PRIMARY" ? "coral" : "neutral"}>
                      {g.nodeName ?? "unknown node"}
                    </Badge>
                  ))}
                  {plan.data.grants.incoming.length === 0 && (
                    <span className="text-[11.5px] text-[var(--danger)]">
                      Nothing places {plan.data.from.name} anywhere — copying this leaves {plan.data.to.name} with no reach.
                    </span>
                  )}
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5 rounded-[10px] border border-[var(--border)] px-3 py-2.5">
              <input
                type="checkbox"
                className="mt-1"
                checked={parts.overrides}
                onChange={(e) => setParts((p) => ({ ...p, overrides: e.target.checked }))}
              />
              <span className="min-w-0 flex-1">
                <span className="text-[13px] font-medium">
                  Personal exceptions — {plan.data.overrides.incoming.length}
                </span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {plan.data.overrides.incoming.map((o, i) => (
                    <Badge key={i} tone={o.effect === "GRANT" ? "ok" : "danger"}>
                      {o.label} · {o.action}
                    </Badge>
                  ))}
                  {plan.data.overrides.incoming.length === 0 && (
                    <span className="text-[11.5px] text-[var(--muted)]">
                      {plan.data.from.name} follows their role exactly — nothing to copy.
                    </span>
                  )}
                </span>
              </span>
            </label>

            <label className="mt-1 block text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
              Reason for this change (required)
            </label>
            <input
              value={copyReason}
              onChange={(e) => setCopyReason(e.target.value)}
              placeholder="Onboarding — same desk as Priya"
              className="w-full rounded-[9px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[13px] outline-none focus:border-[var(--accent)]"
            />
            <button
              disabled={copyReason.trim().length < 4 || clone.isPending}
              onClick={() => clone.mutate()}
              className="inline-flex items-center gap-1.5 self-start rounded-[9px] bg-[var(--accent)] px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
            >
              <Copy className="h-3.5 w-3.5" />
              {clone.isPending ? "Copying…" : `Copy onto ${plan.data.to.name}`}
            </button>
          </div>
        )}

        {!copyFrom && (
          <p className="mt-2.5 text-[11.5px] text-[var(--muted)] [text-wrap:pretty]">
            Copies the role, the property assignments and any personal exceptions — the three things
            &ldquo;the same access as&rdquo; actually means. You see the full list before anything is written.
          </p>
        )}
      </div>
    </Card>
  );
}
