import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { accessApi, accessKeys, type HeldPrivilegeSet } from "@/lib/access-api";
import { UamReason } from "./shell";
import { untilWords } from "./words";
import "./uam.css";

/**
 * The privilege SETS a person or a role holds, and the way to give them one.
 *
 * Shown beside the individual privileges rather than merged into them, because
 * the two answer different questions. A privilege is a decision somebody made
 * about one permission; a set is a decision about a JOB — "cover the night
 * audit" — that happens to be six permissions. Flattening the set into its
 * members would lose the only part worth reviewing: that a named, reusable thing
 * was handed over, and by whom.
 */
export function HeldSets({ subjectId }: { subjectId: string }) {
  const held = useQuery({
    queryKey: accessKeys.heldSets(subjectId),
    queryFn: () => accessApi.heldSets(subjectId),
  });
  const rows = held.data ?? [];

  // Nothing to say when there are none. This used to carry its own "Assign a
  // set" button and an empty-state paragraph, which made a set look like a
  // separate feature — it is one of the things Grant Privilege grants, and it
  // is offered there, in the same picker as a functionality.
  if (!rows.length) return null;

  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-[13.5px] font-semibold">Privilege sets</span>
      {rows.map((s) => <HeldSetRow key={s.assignmentId} s={s} subjectId={subjectId} />)}
    </div>
  );
}

function HeldSetRow({ s, subjectId }: { s: HeldPrivilegeSet; subjectId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const revoke = useMutation({
    mutationFn: () => accessApi.revokePrivilegeSet(s.assignmentId, `Removed from ${s.name}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accessKeys.heldSets(subjectId) });
      qc.invalidateQueries({ queryKey: ["access"] });
      toast({ variant: "success", title: "Set removed", description: `${s.name} no longer applies.` });
    },
    onError: (e: Error) => toast({ title: "Could not remove", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="uam-card flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={`uam-badge ${s.effect === "DENY" ? "uam-badge-warn" : ""}`}>
          {s.effect === "DENY" ? "Takes away" : "Gives"}
        </span>
        <span className="text-[15px] font-medium">{s.name}</span>
        <span className="text-[13px]" style={{ color: "var(--ink3)" }}>
          {s.nodeId ? "at one place" : "everywhere they work"}
        </span>
        {!s.isActive && <span className="uam-badge uam-badge-warn">Set disabled</span>}
        <button
          onClick={() => revoke.mutate()}
          disabled={revoke.isPending}
          className="uam-btn ml-auto h-8 px-2.5 text-[12.5px]"
        >
          Remove
        </button>
      </div>

      <span className="text-[12.5px]" style={{ color: "var(--ink2)" }}>{s.description}</span>

      {/* The members, named. Somebody reviewing this needs to see what the
          bundle actually contains without opening the set — the whole risk of a
          set is that it is assigned unread. */}
      <div className="flex flex-wrap gap-1.5">
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

      <UamReason>{s.reason}</UamReason>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]" style={{ color: "var(--ink3)" }}>
        {untilWords(s.expiresAt) && <span>{untilWords(s.expiresAt)}</span>}
        {s.approvalFilename && (
          // The evidence behind the decision. A link, because the point of
          // attaching it was that somebody can go and read it.
          <a
            href={s.approvalUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5"
            style={{ color: s.approvalUrl ? "var(--accent)" : "var(--ink3)" }}
          >
            <Paperclip className="h-3.5 w-3.5" />
            {s.approvalFilename}
          </a>
        )}
      </div>
    </div>
  );
}
