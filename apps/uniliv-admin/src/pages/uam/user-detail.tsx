import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Pencil, Paperclip } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { uamApi, accessApi, accessKeys, activityApi, activityKeys, ANCHOR_WORD, type HeldRole, type AccessRole } from "@/lib/access-api";
import { UamPage, UamEmpty, UamAvatar, UamVerdict, UamReason, UamNotice } from "./shell";
import { SetPrivilegeSheet } from "./set-privilege";
import { AccessView } from "./access-view";
import { CopyAccessDialog } from "./copy-access";
import { ProfileEditSheet } from "./profile-editor";
import { actionList, actionMeaning, permissionId, untilWords } from "./words";
import { HeldSets } from "./held-sets";
import { RoleTree, PlacesSheet } from "./role-tree";

/**
 * One person — four tabs, because access decomposes into four questions and
 * stacking them vertically is what made the previous screen unreadable.
 *
 * Roles first: it is the answer to "what can they do" 95% of the time, and the
 * privileges tab only matters for the few people who have any.
 */
// "Access" sits after the two tabs that CONFIGURE it, because it is their
// result: roles and privileges are the inputs, this is what the server decides
// from them. It used to be a screen of its own with its own person picker,
// which read as a second directory of people.
/**
 * Who they are, then what they hold, then what that resolves to, then the trail.
 *
 * Roles stays the landing tab even though Profile now leads: identity is the
 * context you read the rest against, but access is what this screen is for.
 */
const TABS = ["Profile", "Roles", "Privileges", "Access", "History"] as const;

export default function UserDetailScreen({ id }: { id: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [tab, setTab] = React.useState<(typeof TABS)[number]>("Roles");
  const [adding, setAdding] = React.useState(false);
  const [writingPrivilege, setWritingPrivilege] = React.useState(false);
  const [revoking, setRevoking] = React.useState<HeldRole | null>(null);
  const [deactivating, setDeactivating] = React.useState(false);
  const [copying, setCopying] = React.useState<null | "all" | "privileges">(null);
  const [editingProfile, setEditingProfile] = React.useState(false);

  const user = useQuery({ queryKey: accessKeys.uamUser(id), queryFn: () => uamApi.user(id) });
  const roles = useQuery({ queryKey: accessKeys.roles(), queryFn: accessApi.roles });
  const nodes = useQuery({ queryKey: accessKeys.nodes(), queryFn: accessApi.nodes });
  const privs = useQuery({
    queryKey: accessKeys.privileges("USER", id),
    queryFn: () => accessApi.privileges("USER", id),
  });
  const history = useQuery({
    queryKey: activityKeys.list({ entityId: id, limit: "25" }),
    queryFn: () => activityApi.list({ entityId: id, limit: "25" }),
    enabled: tab === "History",
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["uam"] });
    void qc.invalidateQueries({ queryKey: ["access"] });
    // Every write on this page produces a trail entry, so the History tab is
    // stale the moment one lands — without this it only caught up on reload.
    void qc.invalidateQueries({ queryKey: ["activity"] });
  };
  const fail = (e: unknown) => toast({ title: "Refused", description: (e as Error).message, variant: "destructive" });

  const [attaching, setAttaching] = React.useState<AccessRole | null>(null);
  const addRole = useMutation({
    mutationFn: (roleKey: string) => uamApi.addRole(id, roleKey, "Assigned from the person's page"),
    onSuccess: () => { toast({ variant: "success", title: "Role assigned" }); setAdding(false); refresh(); },
    onError: fail,
  });
  const setRole = useMutation({
    mutationFn: ({ roleKey, on, reason }: { roleKey: string; on: boolean; reason?: string }) =>
      on
        ? uamApi.addRole(id, roleKey, "Given back from the person's page")
        : uamApi.removeRole(id, roleKey, reason!),
    onSuccess: (_d, v) => {
      toast({
        variant: "success",
        title: v.on ? "Role given back" : "Role taken away",
        description: v.on ? undefined : "The membership is kept, switched off, with your reason on it.",
      });
      setRevoking(null);
      refresh();
    },
    onError: fail,
  });
  const deactivate = useMutation({
    mutationFn: (reason: string) => uamApi.deactivateUser(id, reason),
    onSuccess: () => {
      toast({ variant: "success", title: "Deactivated", description: "Their sessions were ended. The account is kept." });
      setDeactivating(false);
      refresh();
    },
    onError: fail,
  });
  // Deactivation is reversible by design — the row survives so residents,
  // audits and orders keep their reference. Without this the UI made it
  // one-way, which is the opposite of what the endpoint promises.
  const reactivate = useMutation({
    mutationFn: () => uamApi.updateUser(id, { isActive: true, reason: "Reactivated from the person's page" }),
    onSuccess: () => { toast({ variant: "success", title: "Reactivated", description: "They can sign in again, with the roles they still hold." }); refresh(); },
    onError: fail,
  });

  if (user.isLoading) return <div className="uam p-8"><Skeleton className="h-96 w-full rounded-xl" /></div>;
  if (!user.data) return <div className="uam p-8">No such person.</div>;

  const u = user.data;
  const held = new Set(u.roles.map((r) => r.roleKey));
  const assignable = (roles.data ?? []).filter((r) => !r.scopeModule && r.isActive !== false && !held.has(r.key));
  // An inherited row names the role it came from; the API sends the key, and a
  // key is not what anyone calls the job.
  const roleLabel = (key: string) => roles.data?.find((r) => r.key === key)?.label ?? key;
  // A node id IS the property id (see the org tree), so the placement resolves
  // against the same list every place picker in the module uses.
  const placeName = (id: string) => nodes.data?.find((n) => n.id === id)?.name ?? "a property";
  const own = (privs.data?.privileges ?? []).filter((p) => !p.inherited);
  const inherited = (privs.data?.privileges ?? []).filter((p) => p.inherited);

  return (
    <UamPage
      width={920}
      header={
        /*
         * One header block: back link, then the person on the left and their
         * actions on the right, then the tabs. The avatar sits INLINE with the
         * name and the status pill rides beside it, so identity reads as one
         * line instead of a title stacked over a separate identity card.
         */
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 flex-1 items-center gap-4" style={{ flexBasis: 320 }}>
              <span
                className="grid h-[56px] w-[56px] shrink-0 place-items-center rounded-full text-[18px] font-semibold"
                style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
              >
                {u.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="uam-title m-0">{u.name}</h1>
                  {u.isActive ? (
                    <span
                      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-[9px] text-[12.5px] font-medium"
                      style={{ background: "var(--allow-soft)", color: "var(--allow)" }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--allow)" }} /> Active
                    </span>
                  ) : (
                    <span
                      className="inline-flex h-6 shrink-0 items-center rounded-full px-[9px] text-[12.5px] font-medium"
                      style={{ border: "1px solid var(--line2)", color: "var(--ink2)" }}
                    >
                      Deactivated
                    </span>
                  )}
                </div>
                {/* Roles and placement together: what they hold is only half the
                    answer, because a role only applies where they work. */}
                <p className="uam-lede m-0 text-[14.5px]">
                  {u.roles.filter((r) => r.held).map((r) => r.label ?? r.roleKey).join(" + ") || "No roles"}
                  {" · "}
                  {u.propertyId ? `Works at ${placeName(u.propertyId)}` : "No property yet"}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap gap-2">
              {/* Deactivation lives at the bottom of Profile, not up here.
                  It is the one irreversible-feeling action on the page, and a
                  header button sits a mis-click away from everything else. */}
              <button
                onClick={() => setWritingPrivilege(true)}
                className="uam-btn uam-btn-primary h-10 px-4 text-[14px]"
              >
                Grant Privilege
              </button>
            </div>
          </div>
        </div>
      }
    >
      {/* Only while they can actually sign in — for a deactivated account the
          placement is not what is stopping them. */}
      {!u.propertyId && u.isActive && (
        <UamNotice>
          <strong className="font-semibold">{u.name.split(" ")[0]} can sign in but sees nothing.</strong>{" "}
          Roles only apply where a person works, and no place has been set.
        </UamNotice>
      )}

      <div className="uam-tabs">
        {TABS.map((t) => {
          const count = t === "Roles" ? u.roles.filter((r) => r.held).length : t === "Privileges" ? own.length : null;
          return (
            <button key={t} onClick={() => setTab(t)} aria-selected={tab === t} className="uam-tab">
              {t}
              {count !== null && (
                <span className="uam-count">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "Roles" && (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="uam-lede m-0 text-[14px]">
              {u.roles.length > 1
                ? "They hold several roles. What they can do is everything these allow, combined."
                : "What they can do comes from this role."}
            </p>
            <button onClick={() => setAdding((v) => !v)} className="uam-btn h-9 shrink-0 px-3.5 text-[13.5px]">
              Assign Role
            </button>
          </div>

          {adding && (
            <div className="uam-card flex flex-wrap items-center gap-2 p-3">
              {assignable.length === 0 ? (
                <span className="text-[13.5px]" style={{ color: "var(--ink3)" }}>They already hold every assignable role.</span>
              ) : (
                assignable.map((r) => (
                  <button
                    key={r.key}
                    // An anchored role is meaningless without its place, so the
                    // place is asked for here rather than left to be discovered
                    // later on a person who appears to hold a role that reaches
                    // nothing.
                    onClick={() => (r.anchorLevel ? setAttaching(r) : addRole.mutate(r.key))}
                    className="uam-chip"
                  >
                    {r.label}
                    {r.anchorLevel && (
                      <span style={{ color: "var(--ink3)" }}>· pick a {ANCHOR_WORD[r.anchorLevel]}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}

          {/* The tree IS the list now: a role on its own says nothing until you
              know where it applies, and "where" is the per-user fact the whole
              module turns on. The revoke control rides along in the header so
              the reason prompt stays on this screen, which owns it. */}
          <RoleTree
            userId={id}
            action={(roleKey) => {
              const r = u.roles.find((x) => x.roleKey === roleKey);
              if (!r) return null;
              const lastHeld = u.roles.filter((x) => x.held).length <= 1 && r.held;
              return (
                <span className="flex shrink-0 items-center gap-2">
                  {!r.live && <span className="uam-badge uam-badge-warn">not in effect</span>}
                  {r.expiresAt && <span className="uam-badge">{untilWords(r.expiresAt)}</span>}
                  <Switch
                    checked
                    disabled={lastHeld || setRole.isPending}
                    title={lastHeld ? "Their only role — deactivate the person instead" : `Take ${r.label ?? roleKey} away`}
                    onCheckedChange={() => setRevoking(r)}
                    aria-label={`Take ${r.label ?? roleKey} away`}
                  />
                </span>
              );
            }}
          />

          {/* Roles they used to hold, with the reason they lost them. Kept off
              the tree because they reach nothing — but "did she have Warden in
              March?" is exactly the question this answers. */}
          {u.roles.some((r) => !r.held) && (
            <div className="uam-card overflow-hidden">
              <div className="px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--ink3)", borderBottom: "1px solid var(--line)" }}>
                Previously held
              </div>
              {u.roles.filter((r) => !r.held).map((r) => (
                <div key={r.roleKey} className="uam-row" style={{ opacity: 0.75 }}>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <button
                      onClick={() => navigate(`/uam/roles/${r.roleKey}`)}
                      className="min-w-0 text-left text-[14.5px] font-medium hover:opacity-70"
                    >
                      {r.label ?? r.roleKey}
                    </button>
                    {r.revokedReason && (
                      <span className="truncate text-[12.5px]" style={{ color: "var(--ink3)" }}>
                        Taken away — &ldquo;{r.revokedReason}&rdquo;
                      </span>
                    )}
                  </span>
                  <Switch
                    checked={false}
                    disabled={setRole.isPending}
                    onCheckedChange={() => setRole.mutate({ roleKey: r.roleKey, on: true })}
                    aria-label={`Give ${r.label ?? r.roleKey} back`}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "Privileges" && (
        <>
          {/* The header already carries Grant Privilege. Repeating it here and
              again in the empty state put three of the same button on one
              screen. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="uam-lede m-0 max-w-[520px] text-[14px]">
              Things this person can or cannot do regardless of their roles — optionally only at one place.
            </p>
            {/* The same dialog as the account card, opened with only privileges
                ticked — this tab is where someone thinks "give them what she
                had", and the full handover lives on Profile with the rest of
                the account-level actions. */}
            <button
              onClick={() => setCopying("privileges")}
              className="uam-btn h-9 shrink-0 px-3.5 text-[13.5px]"
            >
              Copy from someone
            </button>
          </div>

          {/* Sets first: a set is a decision about a JOB, and the individual
              privileges below are decisions about single permissions. Reading
              the bundles first is how somebody makes sense of the loose ones. */}
          <HeldSets subjectId={id} />

          {own.length === 0 ? (
            <UamEmpty
              align="center"
              title="No privileges"
              text="They get exactly what their roles allow, everywhere they work. That is the state to be in."
            />
          ) : (
            <div className="flex flex-col gap-2.5">
              {own.map((p) => (
                <div key={p.id} className="uam-card flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <UamVerdict allow={p.effect === "GRANT"} />
                    <span className="text-[15px] font-medium">{actionList(p.functionality, [p.action])}</span>
                    <span className="text-[13px]" style={{ color: "var(--ink3)" }}>
                      {p.nodeName ? `at ${p.nodeName}` : "everywhere they work"}
                    </span>
                  </div>
                  {/* What the verb means, and the identifier this row IS — the
                      same pair shown wherever access is displayed or asked for,
                      so "close" never has to be guessed at from the word. */}
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                    <span className="text-[12.5px]" style={{ color: "var(--ink2)" }}>
                      {actionMeaning(p.functionality, p.action)}
                    </span>
                    <span className="text-[11.5px]" style={{ color: "var(--ink3)", fontFamily: "var(--mono)" }}>
                      {permissionId(p.module, p.functionality, p.action)}
                    </span>
                  </div>
                  <UamReason>{p.reason}</UamReason>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]" style={{ color: "var(--ink3)" }}>
                    {untilWords(p.expiresAt) && <span>{untilWords(p.expiresAt)}</span>}
                    {p.approvalFilename && (
                      // The evidence behind the reason. "Why" is what the
                      // granter typed; this is what an auditor asks for.
                      <a
                        href={p.approvalUrl ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5"
                        style={{ color: p.approvalUrl ? "var(--accent)" : "var(--ink3)" }}
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                        {p.approvalFilename}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {inherited.length > 0 && (
            <>
              <p className="uam-lede m-0 mt-1 text-[14px]">
                From the roles they hold — change these on the role, not here.
              </p>
              <div className="flex flex-col gap-2.5">
                {inherited.map((p) => (
                  <div key={p.id} className="uam-card flex flex-col gap-2 p-4">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <UamVerdict allow={p.effect === "GRANT"} />
                      <span className="text-[15px] font-medium">{actionList(p.functionality, [p.action])}</span>
                      {/* The place matters most on an inherited row: it is the
                          whole reason a role privilege exists rather than a
                          matrix cell. */}
                      <span className="text-[13px]" style={{ color: "var(--ink3)" }}>
                        {p.nodeName ? `at ${p.nodeName}` : "everywhere they work"}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                      <span className="text-[12.5px]" style={{ color: "var(--ink2)" }}>
                        {actionMeaning(p.functionality, p.action)}
                      </span>
                      <span className="text-[11.5px]" style={{ color: "var(--ink3)", fontFamily: "var(--mono)" }}>
                        {permissionId(p.module, p.functionality, p.action)}
                      </span>
                    </div>
                    <UamReason>{p.reason}</UamReason>
                    <span className="text-[12.5px]" style={{ color: "var(--ink3)" }}>
                      Everyone holding {roleLabel(p.subjectId)} gets this
                      {untilWords(p.expiresAt) ? ` · ${untilWords(p.expiresAt)}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {tab === "Access" && <AccessView userId={id} />}

      {tab === "Profile" && (
        <>
        <div className="uam-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 py-3" style={{ borderBottom: "1px solid var(--line)" }}>
            <span className="text-[14px] font-medium">Details</span>
            <button
              onClick={() => setEditingProfile(true)}
              title="Edit details"
              aria-label="Edit details"
              className="uam-btn h-8 gap-1.5 px-2.5 text-[13px]"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          </div>
          <div className="grid gap-x-8 gap-y-4 p-5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
          {([
            ["Email", u.email],
            ["Phone", u.phone ?? "—"],
            ["Designation", u.designation ?? "—"],
            ["Type", u.userType === "INTERNAL" ? "Staff" : "Resident"],
            ["Date of birth", u.dob ? new Date(u.dob).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—"],
            ["Gender", u.gender ? u.gender[0]! + u.gender.slice(1).toLowerCase() : "—"],
            ["Last signed in", u.lastLogin ? new Date(u.lastLogin).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Never"],
            ["Status", u.isActive ? "Active" : "Deactivated"],
          ] as Array<[string, string]>).map(([k, v]) => (
            <div key={k}>
              <div className="text-[12px]" style={{ color: "var(--ink3)" }}>{k}</div>
              <div className="text-[14.5px]">{v}</div>
            </div>
          ))}
          </div>
        </div>

        <div className="uam-card flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
          <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
            <span className="text-[14px]" style={{ color: "var(--ink2)" }}>
              Taking over from someone
            </span>
            <p className="m-0 text-[13px]" style={{ color: "var(--ink3)" }}>
              Copies another user's roles, places and privileges onto {u.name.split(" ")[0]}, replacing
              their own. You see the exact list before anything is written.
            </p>
          </div>
          <button
            onClick={() => setCopying("all")}
            className="uam-btn h-9 shrink-0 px-3.5 text-[14px]"
          >
            Copy Access
          </button>
        </div>

        {/* State on the left, the action that changes it on the right — the
            same row, like the notice banner. Stacked, the button read as a
            third paragraph. */}
        <div className="uam-card flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
          <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2.5">
              <span className={`uam-badge ${u.isActive ? "uam-badge-allow" : "uam-badge-block"}`}>
                {u.isActive ? "Active" : "Deactivated"}
              </span>
              <span className="text-[14px]" style={{ color: "var(--ink2)" }}>
                {u.isActive
                  ? "They can sign in and use everything their roles allow."
                  : "They cannot sign in. Their roles and privileges are untouched."}
              </span>
            </div>
            <p className="m-0 text-[13px]" style={{ color: "var(--ink3)" }}>
              Deactivating ends their sessions immediately and keeps the account, so residents,
              audits and orders that reference them still resolve. It is reversible.
            </p>
          </div>
          {u.isActive ? (
            <button
              onClick={() => setDeactivating(true)}
              className="uam-btn uam-btn-danger h-9 shrink-0 px-3.5 text-[14px]"
            >
              Deactivate User
            </button>
          ) : (
            <button
              onClick={() => reactivate.mutate()}
              disabled={reactivate.isPending}
              className="uam-btn h-9 shrink-0 px-3.5 text-[14px]"
            >
              Reactivate User
            </button>
          )}
        </div>
        </>
      )}

      {tab === "History" && (
        history.isLoading ? (
          <Skeleton className="h-48 w-full rounded-xl" />
        ) : (history.data?.data.length ?? 0) === 0 ? (
          <UamEmpty title="Nothing has changed yet" text="Role changes, placement and privileges all land here with the reason they were given." />
        ) : (
          <div className="uam-card overflow-hidden">
            {history.data!.data.map((e) => (
              <div key={e.id} className="uam-row flex-col items-start gap-1">
                <span className="text-[14px] font-medium">
                  {e.event.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}
                </span>
                <span className="text-[12.5px]" style={{ color: "var(--ink3)" }}>
                  {new Date(e.occurredAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · {e.actorName ?? "System"}
                </span>
                {e.reason && <UamReason>{e.reason}</UamReason>}
              </div>
            ))}
          </div>
        )
      )}

      {attaching?.anchorLevel && (
        <PlacesSheet
          kicker={`Assign ${attaching.label}`}
          roleLabel={attaching.label}
          level={attaching.anchorLevel}
          initial={[]}
          onSave={async (nodeIds, reason) => {
            await uamApi.addRole(id, attaching.key, reason, nodeIds);
            await qc.invalidateQueries({ queryKey: accessKeys.userTree(id) });
            setAdding(false);
            refresh();
          }}
          onClose={() => setAttaching(null)}
        />
      )}

      {writingPrivilege && (
        <SetPrivilegeSheet defaultSubject={{ type: "USER", id }} onClose={() => setWritingPrivilege(false)} />
      )}

      {editingProfile && <ProfileEditSheet user={u} onClose={() => setEditingProfile(false)} />}

      {copying && (
        <CopyAccessDialog
          toUserId={id}
          toName={u.name}
          defaultParts={copying === "privileges"
            ? { role: false, grants: false, overrides: true }
            : { role: true, grants: true, overrides: true }}
          onClose={() => setCopying(null)}
        />
      )}

      {deactivating && (
        <ReasonDialog
          kicker="Deactivate a user"
          title={`Why is ${u.name} being deactivated?`}
          note="They stop being able to sign in immediately. The account, their roles and their privileges are all kept, so this can be undone."
          placeholder="Left the company on 30 Sep"
          confirmLabel="Deactivate"
          pendingLabel="Deactivating…"
          pending={deactivate.isPending}
          onCancel={() => setDeactivating(false)}
          onConfirm={(reason) => deactivate.mutate(reason)}
        />
      )}

      {revoking && (
        <ReasonDialog
          kicker="Take a role away"
          title={`Why is ${u.name} losing ${revoking.label ?? revoking.roleKey}?`}
          note="They stop getting anything from it immediately. The membership is kept and switched off, so the record still shows they held it."
          placeholder="Moved off the night shift"
          confirmLabel="Take it away"
          pendingLabel="Taking away…"
          pending={setRole.isPending}
          onCancel={() => setRevoking(null)}
          onConfirm={(reason) => setRole.mutate({ roleKey: revoking.roleKey, on: false, reason })}
        />
      )}
    </UamPage>
  );
}

/**
 * A confirmation that will not proceed without a reason.
 *
 * Taking access away is the change most likely to be questioned later, and an
 * unexplained one is indistinguishable from a mistake. The reason is stored on
 * the record itself and on the activity trail, so the answer to "why did she
 * lose Warden in March" outlives whoever answered it.
 *
 * One component for both the role revoke and the deactivation: the shape of the
 * decision is identical, and two near-copies would drift.
 */
function ReasonDialog({
  kicker, title, note, placeholder, confirmLabel, pendingLabel, pending, onCancel, onConfirm,
}: {
  kicker: string;
  title: string;
  note: string;
  placeholder: string;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState("");
  const ready = reason.trim().length >= 4;

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="uam max-w-[480px] p-0"
        style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
      >
        <header className="px-6 pb-3 pt-6">
          <span className="uam-kicker font-medium">{kicker}</span>
          <DialogTitle asChild>
            <h2 className="uam-title m-0 mt-1" style={{ fontSize: 18 }}>{title}</h2>
          </DialogTitle>
          <DialogDescription className="sr-only">{note}</DialogDescription>
        </header>

        <div className="flex flex-col gap-2 px-6 pb-2">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && ready && !pending) onConfirm(reason.trim()); }}
            placeholder={placeholder}
            className="uam-input uam-input-fill h-10"
          />
          <p className="m-0 text-[13px]" style={{ color: "var(--ink3)" }}>{note}</p>
        </div>

        <footer className="flex justify-end gap-2 px-6 pb-6 pt-3">
          <button onClick={onCancel} className="uam-btn h-9 px-3.5">Cancel</button>
          <button
            disabled={!ready || pending}
            onClick={() => onConfirm(reason.trim())}
            className="uam-btn uam-btn-danger-solid h-9 px-4"
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
