import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { accessApi, accessKeys, type PreviewAction } from "@/lib/access-api";
import { UamSeg } from "./shell";
import { UamSelect } from "./select";
import { actionLabel, actionList } from "./words";
import "./uam.css";

/**
 * What one person can actually do — resolved, not configured.
 *
 * This is the other half of a person's page. The Roles and Privileges tabs show
 * the INPUTS: two roles held, two privileges written. Turning those into an
 * answer means unioning role matrices, applying the manifest ceiling, layering
 * privileges by specificity, then scope and data scope — a ladder nobody should
 * run in their head, and whose result differs by PLACE.
 *
 * So this asks the server. Every answer comes from /access/preview, which runs
 * the same decide() the API enforces with — this explains the 403 a user is
 * actually getting rather than offering a second opinion about it.
 *
 * Refusals are rendered EXPLICITLY, each with its reason. An omitted row is not
 * an acceptable way to show a denial: "why can't they?" is the question this
 * view exists to answer, and an absence answers nothing.
 */
const DENY_WORDS: Record<string, string> = {
  DENY_ROLE_LACKS_CAPABILITY: "no role they hold allows it",
  DENY_USER_OVERRIDE: "blocked for this person specifically",
  DENY_ROLE_PRIVILEGE: "blocked for their role",
  DENY_NO_GRANT: "they are not placed anywhere",
  DENY_NODE_OUT_OF_SCOPE: "they do not work here",
  DENY_ACTION_NOT_ON_FUNCTIONALITY: "this has no such action",
  DENY_DATA_SCOPE: "they only see their own records",
  DENY_UNKNOWN_FUNCTIONALITY: "no such functionality",
};

export function AccessView({ userId }: { userId: string }) {
  const [nodeId, setNodeId] = React.useState("");
  const [show, setShow] = React.useState<"all" | "can" | "cannot">("all");

  const nodes = useQuery({ queryKey: accessKeys.nodes(), queryFn: accessApi.nodes });
  const preview = useQuery({
    queryKey: accessKeys.preview(userId, nodeId || null),
    queryFn: () => accessApi.preview(userId, nodeId || null),
    enabled: !!userId,
  });

  const properties = (nodes.data ?? []).filter((n) => n.nodeType === "PROPERTY" && n.isActive);
  const p = preview.data;

  /** Every (functionality, action) answer, flattened out of the module tree. */
  const allActions = p ? p.modules.flatMap((m) => m.functionalities.flatMap((f) => f.actions)) : [];
  const allowedCount = allActions.filter((a) => a.allow).length;
  // "Reachable" counts MODULES, which is the number a person can hold in their
  // head — "12 of 54 functionalities" is a number nobody can act on.
  const reachable = p ? p.modules.filter((m) => !m.noAccess).length : 0;
  const blockedByPrivilege = allActions.filter(
    (a) => a.reason === "DENY_USER_OVERRIDE" || a.reason === "DENY_ROLE_PRIVILEGE",
  ).length;
  const placeName = nodeId ? properties.find((n) => n.id === nodeId)?.name : null;

  if (preview.isLoading) return <Skeleton className="h-72 w-full rounded-xl" />;
  if (!p) return null;

  return (
    <>
      {/* The place axis is the whole reason this cannot be a static list: the
          same person resolves differently at each property they work at, and
          to nothing at all at one they do not. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="uam-lede m-0 max-w-[520px] text-[16px]">
          {placeName ? `At ${placeName}, ` : ""}
          <strong className="font-semibold">{p.subject.name}</strong> can do {allowedCount}{" "}
          {allowedCount === 1 ? "thing" : "things"} across {reachable}{" "}
          {reachable === 1 ? "module" : "modules"}. Everything else is refused
          {blockedByPrivilege > 0 ? `, including ${blockedByPrivilege} blocked by a privilege` : ""}. Each
          refusal is listed with its reason.
        </p>
        <div className="flex w-[240px] shrink-0 flex-col gap-2">
          <span className="text-[13px] font-medium" style={{ color: "var(--ink3)" }}>At</span>
          <UamSelect
            value={nodeId}
            onChange={setNodeId}
            placeholder="Anywhere they work"
            options={[
              { value: "", label: "Anywhere they work" },
              ...properties.map((n) => ({ value: n.id, label: n.name })),
            ]}
          />
        </div>
      </div>

      <UamSeg<typeof show>
        value={show}
        onChange={setShow}
        options={[
          { value: "all", label: "Everything" },
          { value: "can", label: "Can" },
          { value: "cannot", label: "Cannot" },
        ]}
      />

      {/* A card per MODULE, a row pair per FUNCTIONALITY inside it. The module
          header answers "can they into Audits at all, and how much of it"; the
          rows answer "which parts". Those are the two questions an administrator
          actually asks, and the flat list could only answer the second. */}
      <div className="flex flex-col gap-2.5">
        {p.modules
          .filter((m) =>
            show === "can" ? m.heldCount > 0 : show === "cannot" ? m.functionalities.some((f) => f.actions.some((a) => !a.allow)) : true,
          )
          .map((m) => (
            <div key={m.key} className="uam-card overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: "1px solid var(--line)" }}>
                <span className="text-[15px] font-medium">{m.label}</span>
                <span className="whitespace-nowrap text-[12.5px]" style={{ color: "var(--ink3)" }}>
                  {m.noAccess
                    ? "no access"
                    : `${m.heldCount} of ${m.totalCount} ${m.totalCount === 1 ? "functionality" : "functionalities"}`}
                </span>
              </div>

              {m.functionalities
                .filter((f) => (show === "can" ? f.actions.some((a) => a.allow) : show === "cannot" ? f.noAccess || f.actions.some((a) => !a.allow) : true))
                .map((f) => {
                  const can = f.actions.filter((a) => a.allow);
                  const cannot = f.actions.filter((a) => !a.allow);
                  return (
                    <React.Fragment key={f.key}>
                      {show !== "cannot" && can.length > 0 && (
                        <Line
                          allow
                          byPrivilege={can.some((a) => a.reason === "ALLOW_USER_OVERRIDE" || a.reason === "ALLOW_ROLE_PRIVILEGE")}
                          text={`Can: ${actionList(f.key, can.map((a) => a.action))}`}
                          why={
                            can.some((a) => a.reason === "ALLOW_USER_OVERRIDE")
                              ? "Given by a privilege, not a role."
                              : can.some((a) => a.reason === "ALLOW_ROLE_PRIVILEGE")
                                ? "Given by a privilege on one of their roles."
                                : `From ${p.subject.roleKey}.`
                          }
                        />
                      )}

                      {show !== "can" && cannot.length > 0 &&
                        groupByReason(cannot).map(([reason, actions]) => (
                          <Line
                            key={`${f.key}:${reason}`}
                            allow={false}
                            byPrivilege={reason === "DENY_USER_OVERRIDE" || reason === "DENY_ROLE_PRIVILEGE"}
                            text={`Cannot: ${actions.map((a) => actionLabel(f.key, a.action)).join(", ")}`}
                            why={DENY_WORDS[reason] ?? reason}
                          />
                        ))}
                    </React.Fragment>
                  );
                })}
            </div>
          ))}
      </div>
    </>
  );
}

/** Refusals that share a reason are one line — twelve identical rows is noise. */
function groupByReason(actions: PreviewAction[]): Array<[string, PreviewAction[]]> {
  const m = new Map<string, PreviewAction[]>();
  for (const a of actions) m.set(a.reason, [...(m.get(a.reason) ?? []), a]);
  return [...m.entries()];
}

/**
 * One access row.
 *
 * The tint is the view's core idea and it encodes PROVENANCE, not verdict:
 * a tinted row means a privilege touched this, a plain row means a role
 * decided it. Colouring by yes/no instead would make the whole page stripey and
 * say nothing — the verdict is already in the icon.
 */
function Line({
  allow, byPrivilege, text, why, quote, meta,
}: {
  allow: boolean;
  byPrivilege: boolean;
  text: string;
  why: string | null;
  quote?: string | null;
  meta?: string | null;
}) {
  const rowBg = !byPrivilege ? "transparent" : allow ? "var(--allow-soft)" : "var(--block-soft)";
  return (
    <div
      className="grid gap-3 px-4 pb-2.5 pt-2"
      style={{ gridTemplateColumns: "22px minmax(0,1fr)", background: rowBg, borderTop: "1px solid var(--line)" }}
    >
      <span
        className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full font-bold"
        style={
          allow
            ? { background: "var(--allow-soft)", color: "var(--allow)", fontSize: 12 }
            : {
                // On a tinted refusal the icon flips to the card surface, or it
                // disappears into the row it is sitting on.
                background: byPrivilege ? "var(--surface)" : "var(--block-soft)",
                color: "var(--block)",
                border: "1px solid var(--block-line)",
                fontSize: 11,
              }
        }
      >
        {allow ? "✓" : "✕"}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[14.5px] font-medium">{text}</span>
        {why && <span className="text-[13.5px] leading-[1.45]" style={{ color: "var(--ink2)" }}>{why}</span>}
        {quote && (
          <span className="text-[14.5px] leading-[1.45]" style={{ fontStyle: "italic" }}>
            &ldquo;{quote}&rdquo;
          </span>
        )}
        {meta && <span className="text-[12.5px]" style={{ color: "var(--ink3)" }}>{meta}</span>}
      </span>
    </div>
  );
}
