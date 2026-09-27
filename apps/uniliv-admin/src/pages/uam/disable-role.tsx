import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { accessApi, accessKeys, type RoleHolderImpact } from "@/lib/access-api";
import { UamAvatar } from "./shell";
import "./uam.css";

/**
 * Confirming a disable, with the people it reaches shown by name.
 *
 * A MODAL rather than a sheet, per the module's own rule: a sheet to edit one
 * thing, a modal when the change is wide. This one is wide by definition —
 * everybody holding the role stops getting anything from it at once, and they
 * get no notice of it.
 *
 * The list leads with the people the decision is actually about: those left
 * with no other live role, then those for whom this is their primary. A count
 * alone ("reaches 4 people") is the number you already guessed; the name of the
 * warden who will be locked out of their own property in the morning is not.
 */
export function DisableRoleDialog({
  roleKey, roleLabel, onConfirm, onClose, pending,
}: {
  roleKey: string;
  roleLabel: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  pending?: boolean;
}) {
  const [reason, setReason] = React.useState("");
  const impact = useQuery({
    queryKey: accessKeys.roleImpact(roleKey),
    queryFn: () => accessApi.roleImpact(roleKey),
  });

  const d = impact.data;
  const ready = reason.trim().length >= 4;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="uam-modal max-w-[640px] gap-0 overflow-hidden p-0">
        <div className="flex flex-col gap-1 px-5 py-4" style={{ borderBottom: "1px solid var(--line)" }}>
          <DialogTitle className="uam-title m-0" style={{ fontSize: 18 }}>
            Disable {roleLabel}?
          </DialogTitle>
          <DialogDescription className="m-0 text-[13.5px]" style={{ color: "var(--ink3)" }}>
            They keep the role on their account and simply stop getting anything from it,
            starting immediately. Nobody is told. It is reversible.
          </DialogDescription>
        </div>

        <div className="flex max-h-[54vh] flex-col gap-3 overflow-y-auto p-5">
          {impact.isLoading ? (
            <Skeleton className="h-40 w-full rounded-xl" />
          ) : !d ? (
            <p className="m-0 text-[13.5px]" style={{ color: "var(--block)" }}>
              Could not work out who this reaches. Disable anyway only if you are sure.
            </p>
          ) : d.counts.holders === 0 ? (
            <div className="uam-card p-4">
              <p className="m-0 text-[14px]">Nobody holds this role. Disabling it changes nothing today.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Stat n={d.counts.holders} label={d.counts.holders === 1 ? "person holds it" : "people hold it"} />
                <Stat n={d.counts.primary} label="have it as their primary role" tone={d.counts.primary ? "warn" : undefined} />
                <Stat
                  n={d.counts.losesEverything}
                  label="would be left with nothing"
                  tone={d.counts.losesEverything ? "block" : undefined}
                />
              </div>

              {d.counts.losesEverything > 0 && (
                <p className="m-0 text-[13px]" style={{ color: "var(--block)" }}>
                  {d.counts.losesEverything === 1 ? "One person has" : `${d.counts.losesEverything} people have`} no
                  other live role. They will be able to sign in and do nothing at all.
                </p>
              )}

              <div className="uam-card overflow-hidden">
                {d.holders.map((h) => (
                  <HolderRow key={h.id} h={h} />
                ))}
              </div>
            </>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-[13.5px] font-semibold">
              Why
              <span className="ml-1.5 text-[12.5px] font-normal" style={{ color: "var(--ink3)" }}>
                One sentence. It goes on the activity trail.
              </span>
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. replaced by the new shift roles from 1 Oct"
              className="uam-input uam-input-fill h-10 text-[14px]"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 py-4" style={{ borderTop: "1px solid var(--line)" }}>
          {d && d.counts.holders > 0 && (
            <button onClick={() => downloadCsv(d.roleKey, d.holders)} className="uam-btn h-9 px-3.5 text-[13.5px]">
              <Download className="h-4 w-4" />
              Download CSV
            </button>
          )}
          <span className="flex-1" />
          <button onClick={onClose} className="uam-btn h-9 px-3.5">Cancel</button>
          <button
            onClick={() => onConfirm(reason.trim())}
            disabled={!ready || pending}
            className="uam-btn uam-btn-danger-solid h-9 px-3.5"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Disable role"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: "warn" | "block" }) {
  const colour = tone === "block" ? "var(--block)" : tone === "warn" ? "var(--warn)" : "var(--ink)";
  return (
    <span className="uam-card flex items-baseline gap-1.5 px-3 py-2">
      <span className="text-[18px] font-semibold" style={{ color: colour }}>{n}</span>
      <span className="text-[13px]" style={{ color: "var(--ink2)" }}>{label}</span>
    </span>
  );
}

function HolderRow({ h }: { h: RoleHolderImpact }) {
  return (
    <div className="uam-row" style={{ opacity: h.isActive ? 1 : 0.6 }}>
      <UamAvatar name={h.name} size={28} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium">{h.name}</span>
        <span className="truncate text-[12.5px]" style={{ color: "var(--ink3)" }}>
          {h.otherRoles.length
            ? `Would still hold ${h.otherRoles.join(", ").toLowerCase().replace(/_/g, " ")}`
            : "No other live role"}
        </span>
      </span>
      {!h.isActive && <span className="uam-badge">deactivated</span>}
      {h.isPrimary && <span className="uam-badge uam-badge-warn shrink-0">primary role</span>}
      {h.losesEverything && <span className="uam-badge uam-badge-block shrink-0">left with nothing</span>}
    </div>
  );
}

/**
 * The same rows as the list, as a file someone can take to a conversation.
 *
 * Built in the browser from the payload already on screen rather than as a
 * second endpoint: a download link would have to carry the session, and the
 * file must say exactly what the operator was shown when they decided.
 */
function downloadCsv(roleKey: string, holders: RoleHolderImpact[]) {
  const esc = (v: string | boolean) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    ["name", "email", "account_active", "is_primary_role", "other_live_roles", "left_with_nothing"],
    ...holders.map((h) => [
      h.name, h.email, h.isActive, h.isPrimary, h.otherRoles.join(" | "), h.losesEverything,
    ].map(esc)),
  ];
  const csv = rows.map((r) => r.join(",")).join("\r\n");
  // BOM so Excel opens non-ASCII names correctly rather than as mojibake.
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${roleKey.toLowerCase()}-holders-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
