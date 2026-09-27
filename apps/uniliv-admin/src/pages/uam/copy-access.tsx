import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { accessApi, accessKeys } from "@/lib/access-api";
import { UamSelect } from "./select";
import { UamAvatar } from "./shell";
import { actionLabel } from "./words";
import "./uam.css";

/**
 * Copy one person's access onto another — the handover.
 *
 * Someone leaves and someone else picks up what they did. Rebuilding that by
 * hand means reading four screens and reproducing them without a mistake, and
 * the mistake is silent: the replacement quietly cannot do one thing until
 * somebody complains.
 *
 * It REPLACES rather than merges, because "take over from Priya" means the same
 * access, not a superset of two jobs. That is destructive, so nothing is
 * written until the exact list has been shown — the dry run names what arrives
 * AND what it displaces, and the copy needs a reason like every other change
 * that takes access away.
 */
export function CopyAccessDialog({
  toUserId, toName, defaultParts, onClose,
}: {
  toUserId: string;
  toName: string;
  /**
   * What is ticked when it opens. Launched from the Privileges tab it is
   * privileges only, because that is what the reader was looking at; from the
   * account card it is the whole handover. Same dialog either way — the
   * reader can still change their mind, and the dry run always tells the truth
   * about what is actually going to happen.
   */
  defaultParts?: { role: boolean; grants: boolean; overrides: boolean };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [fromUserId, setFromUserId] = React.useState("");
  const [parts, setParts] = React.useState(defaultParts ?? { role: true, grants: true, overrides: true });
  const [reason, setReason] = React.useState("");

  const users = useQuery({ queryKey: accessKeys.users(), queryFn: accessApi.users });
  const roles = useQuery({ queryKey: accessKeys.roles(), queryFn: accessApi.roles });
  const plan = useQuery({
    queryKey: accessKeys.clonePlan(fromUserId, toUserId),
    queryFn: () => accessApi.clonePlan(fromUserId, toUserId),
    enabled: !!fromUserId,
  });

  const label = (key: string) => roles.data?.find((r) => r.key === key)?.label ?? key;

  const apply = useMutation({
    mutationFn: () =>
      accessApi.cloneAccess({ fromUserId, toUserId, reason: reason.trim(), ...parts }),
    onSuccess: (d) => {
      toast({
        variant: "success",
        title: "Access copied",
        description: `${d.grants} ${d.grants === 1 ? "place" : "places"} and ${d.overrides} ${d.overrides === 1 ? "privilege" : "privileges"} now match.`,
      });
      void qc.invalidateQueries({ queryKey: ["uam"] });
      void qc.invalidateQueries({ queryKey: ["access"] });
      onClose();
    },
    onError: (e) => toast({ title: "Refused", description: (e as Error).message, variant: "destructive" }),
  });

  const p = plan.data;
  const nothingPicked = !parts.role && !parts.grants && !parts.overrides;
  const ready = !!fromUserId && !nothingPicked && reason.trim().length >= 4 && !!p;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="uam max-h-[88vh] max-w-[560px] overflow-y-auto p-0"
        style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
      >
        <header className="px-6 pb-3 pt-6">
          <span className="uam-kicker font-medium">Copy access</span>
          <DialogTitle asChild>
            <h2 className="uam-title m-0 mt-1" style={{ fontSize: 18 }}>
              Who is {toName} taking over from?
            </h2>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Copy another user's roles, places and privileges onto this one, replacing their own.
          </DialogDescription>
        </header>

        <div className="flex flex-col gap-4 px-6 pb-2">
          <Field label="Copy from">
            <UamSelect
              value={fromUserId}
              onChange={setFromUserId}
              placeholder="Search users…"
              emptyText="Nobody by that name."
              options={(users.data ?? [])
                // Copying onto yourself is a no-op the server refuses anyway.
                .filter((u) => u.id !== toUserId)
                .map((u) => ({
                  value: u.id,
                  label: u.name,
                  icon: <UamAvatar name={u.name} size={22} />,
                  hint: u.isActive ? u.email : "deactivated",
                  muted: !u.isActive,
                }))}
            />
          </Field>

          <Field label="What to copy" hint="Anything left on is replaced, not merged.">
            <div className="flex flex-wrap gap-1.5">
              {([
                ["role", "Roles"],
                ["grants", "Where they work"],
                ["overrides", "Privileges"],
              ] as const).map(([k, text]) => (
                <button
                  key={k}
                  onClick={() => setParts((s) => ({ ...s, [k]: !s[k] }))}
                  className={`uam-chip ${parts[k] ? "uam-chip-on" : ""}`}
                >
                  {parts[k] && <Check className="mr-1 inline h-3 w-3" />}
                  {text}
                </button>
              ))}
            </div>
            {nothingPicked && (
              <p className="m-0 mt-1 text-[12.5px]" style={{ color: "var(--block)" }}>
                Pick at least one thing to copy.
              </p>
            )}
          </Field>

          {fromUserId && (plan.isLoading ? (
            <Skeleton className="h-32 w-full rounded-xl" />
          ) : p ? (
            /* The dry run. Everything destructive is named here rather than
               discovered afterwards. */
            <div className="rounded-[var(--r)] p-3.5" style={{ background: "var(--sunk)", border: "1px solid var(--line)" }}>
              <div className="mb-2 text-[12.5px]" style={{ color: "var(--ink3)" }}>
                What this does to {p.to.name}
              </div>
              <div className="flex flex-col gap-2 text-[13.5px]">
                {parts.role && (
                  <Line
                    on={p.role.incoming.map(label).join(" + ") || "no roles"}
                    off={p.role.current.map(label).join(" + ") || "no roles"}
                    what="Roles"
                  />
                )}
                {parts.grants && (
                  <Line
                    on={`${p.grants.incoming.length} ${p.grants.incoming.length === 1 ? "place" : "places"}`}
                    off={`${p.grants.replacing.length} ${p.grants.replacing.length === 1 ? "place" : "places"}`}
                    what="Where they work"
                  />
                )}
                {parts.overrides && (
                  <Line
                    on={`${p.overrides.incoming.length} ${p.overrides.incoming.length === 1 ? "privilege" : "privileges"}`}
                    off={`${p.overrides.replacing.length} ${p.overrides.replacing.length === 1 ? "privilege" : "privileges"}`}
                    what="Privileges"
                  />
                )}
              </div>
              {parts.overrides && p.overrides.incoming.length > 0 && (
                <div className="mt-2.5 flex flex-col gap-1 text-[12.5px]" style={{ color: "var(--ink2)" }}>
                  {p.overrides.incoming.slice(0, 4).map((o, i) => (
                    <span key={i}>
                      {o.effect === "GRANT" ? "Enabled" : "Disabled"} ·{" "}
                      {actionLabel(o.functionality, o.action)}
                    </span>
                  ))}
                  {p.overrides.incoming.length > 4 && (
                    <span style={{ color: "var(--ink3)" }}>+{p.overrides.incoming.length - 4} more</span>
                  )}
                </div>
              )}
            </div>
          ) : null)}

          <Field label="Why" hint="One sentence. It goes on the activity trail and on every copied row.">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Taking over from Priya, who leaves on 30 Sep"
              className="uam-input uam-input-fill h-10"
            />
          </Field>
        </div>

        <footer className="flex justify-end gap-2 px-6 pb-6 pt-3">
          <button onClick={onClose} className="uam-btn h-9 px-3.5">Cancel</button>
          <button
            disabled={!ready || apply.isPending}
            onClick={() => apply.mutate()}
            className="uam-btn uam-btn-primary h-9 px-4"
          >
            {apply.isPending ? "Copying…" : "Copy access"}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** What arrives, and what it displaces — on one line, because both matter. */
function Line({ what, on, off }: { what: string; on: string; off: string }) {
  const same = on === off;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span style={{ color: "var(--ink3)", minWidth: 130 }}>{what}</span>
      {same ? (
        <span style={{ color: "var(--ink3)" }}>{on} — no change</span>
      ) : (
        <>
          <span style={{ color: "var(--ink3)", textDecoration: "line-through" }}>{off}</span>
          <span>→</span>
          <span className="font-medium">{on}</span>
        </>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13.5px] font-semibold">
        {label}
        {hint && <span className="ml-1.5 text-[12.5px] font-normal" style={{ color: "var(--ink3)" }}>{hint}</span>}
      </span>
      {children}
    </div>
  );
}
