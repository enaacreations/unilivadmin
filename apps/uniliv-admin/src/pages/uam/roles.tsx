import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Plus, Paperclip } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { accessApi, accessKeys, ANCHOR_WORD, type AccessRole } from "@/lib/access-api";
import { UamPage, UamEmpty, UamVerdict, UamReason, UamAvatar, UamRoleMark } from "./shell";
import { SetPrivilegeSheet } from "./set-privilege";
import { CreateRoleModal, EditRoleSheet } from "./role-editor";
import { DisableRoleDialog } from "./disable-role";
import { WhatItAllows } from "./role-permissions";
import { HeldSets } from "./held-sets";
import { actionList, actionMeaning, permissionId, untilWords } from "./words";
import "./uam.css";

/**
 * Roles — a full-width list, then a full-width detail.
 *
 * This was master-detail, with the list pinned in a 300px rail. The rail cost a
 * third of the screen to show a column of names, while the detail — permission
 * cards grouped by module, which is the content anyone actually came for — was
 * squeezed into what was left. A role is read on its own, not compared
 * side-by-side, so the list hands over the whole page when you pick one.
 *
 * The detail leads with what the role ALLOWS, in plain English and grouped by
 * module — and then says what it does NOT include. On an access screen the
 * absence is half the answer, and a list of permissions alone never shows it.
 */
const TABS = ["What it allows", "Who holds it", "Privileges", "Status"] as const;

export default function RolesScreen({ roleKey }: { roleKey?: string }) {
  const [, navigate] = useLocation();
  const [tab, setTab] = React.useState<(typeof TABS)[number]>("What it allows");
  const [q, setQ] = React.useState("");
  const [writingPrivilege, setWritingPrivilege] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

  const roles = useQuery({ queryKey: accessKeys.roles(), queryFn: accessApi.roles });
  const list = (roles.data ?? []).filter((r) => {
    if (!q.trim()) return true;
    return r.label.toLowerCase().includes(q.toLowerCase());
  });
  const platform = list.filter((r) => !r.scopeModule);
  const personas = list.filter((r) => r.scopeModule);

  // The list keeps its own scroll; only the detail changes underneath it.
  React.useEffect(() => { setTab("What it allows"); }, [roleKey]);

  if (!roleKey) {
    return (
      <UamPage
        kicker="Roles · what each job allows"
        title="What can each job do?"
        lede="A role is a bundle of permissions. Everyone holding it gets the same thing, everywhere they work — a privilege is how one person or one place differs."
        actions={
          <button onClick={() => setCreating(true)} className="uam-btn uam-btn-primary h-10 gap-1.5 px-4 text-[14px]">
            <Plus className="h-4 w-4" /> Create Role
          </button>
        }
        width={980}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search roles"
          className="uam-input h-10 w-[280px] self-start text-[14px]"
        />

        {roles.isLoading ? (
          <Skeleton className="h-96 w-full rounded-xl" />
        ) : list.length === 0 ? (
          <UamEmpty align="center" title="No role by that name" text="Nothing here matches what you typed." />
        ) : (
          <>
            <Group title="Staff roles" rows={platform} onPick={(k) => navigate(`/uam/roles/${k}`)} />
            <Group title="Module personas" rows={personas} onPick={(k) => navigate(`/uam/roles/${k}`)} />
          </>
        )}

        {creating && <CreateRoleModal onClose={() => setCreating(false)} />}
      </UamPage>
    );
  }

  return (
    <div className="uam -mx-6 -mt-6 min-h-full sm:-mx-8">
      <RoleDetailPane
        roleKey={roleKey}
        tab={tab}
        onTab={setTab}
        onAddPrivilege={() => setWritingPrivilege(true)}
      />
      {creating && <CreateRoleModal onClose={() => setCreating(false)} />}
      {writingPrivilege && (
        <SetPrivilegeSheet defaultSubject={{ type: "ROLE", id: roleKey }} onClose={() => setWritingPrivilege(false)} />
      )}
    </div>
  );
}

/** Role · Functionalities · Handed out at · Holders · Status — the users table's shape. */
const ROLE_COLS = "minmax(0,1.9fr) 120px minmax(0,1.1fr) 104px 104px";

/**
 * One table per family, laid out like the Users list.
 *
 * It was a two-line list before: name over a sentence, with the holder count
 * floated right. That reads fine for five rows and stops scanning at thirty —
 * "which roles reach a whole city" and "which ones does nobody hold" were
 * answers you had to assemble line by line. Columns make them a glance down one.
 */
function Group({
  title, rows, onPick,
}: {
  title: string;
  rows: AccessRole[];
  onPick: (key: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <>
      <div className="pb-0.5 pt-1 text-[11.5px] font-medium uppercase tracking-[0.06em]" style={{ color: "var(--ink3)" }}>
        {title}
      </div>
      <div className="uam-card overflow-hidden">
        <div
          className="grid gap-4 px-[18px] py-2.5 text-[12.5px] font-medium"
          style={{ gridTemplateColumns: ROLE_COLS, borderBottom: "1px solid var(--line)", color: "var(--ink3)" }}
        >
          <span>Role</span><span>Allows</span><span>Handed out at</span><span>Holders</span><span>Status</span>
        </div>
        {rows.map((r) => (
          <button
            key={r.key}
            onClick={() => onPick(r.key)}
            className="uam-row-link grid w-full gap-4 px-[18px] py-3 text-left"
            style={{ gridTemplateColumns: ROLE_COLS, alignItems: "center", borderTop: "1px solid var(--line)", marginTop: -1 }}
          >
            <span className="flex min-w-0 items-center gap-3">
              <UamRoleMark size={28} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[14.5px] font-medium">{r.label}</span>
                {/* Only when there is something to say. The raw key is the label
                    in SCREAMING_SNAKE, so falling back to it would repeat the
                    line above and add nothing — the same reason the matrix
                    screen dropped it. Most roles have no description, and a
                    one-line row reads better than a padded one. */}
                {r.description && (
                  <span className="truncate text-[12.5px]" style={{ color: "var(--ink3)" }}>
                    {r.description}
                  </span>
                )}
              </span>
            </span>

            {/* A computed role's cells are worked out by rule, so a number here
                would be a lie — it has no stored ones to count. */}
            <span className="truncate text-[13.5px]" style={{ color: r.cells === null ? "var(--ink3)" : "var(--ink2)" }}>
              {r.cells === null ? "By rule" : r.cells === 1 ? "1 permission" : `${r.cells} permissions`}
            </span>

            <span className="truncate text-[13.5px]" style={{ color: r.anchorLevel ? "var(--ink2)" : "var(--ink3)" }}>
              {r.anchorLevel ? `A ${ANCHOR_WORD[r.anchorLevel]}` : "No place"}
            </span>

            <span className="truncate text-[13.5px]" style={{ color: r.holders ? "var(--ink2)" : "var(--ink3)" }}>
              {r.holders === 1 ? "1 person" : `${r.holders} people`}
            </span>

            <span className="flex items-center gap-[7px] text-[13.5px]">
              <span
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={r.isActive ? { background: "var(--allow)" } : { border: "1.5px solid var(--ink3)" }}
              />
              {r.isActive ? "Enabled" : "Disabled"}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function RoleDetailPane({
  roleKey, tab, onTab, onAddPrivilege,
}: {
  roleKey: string;
  tab: (typeof TABS)[number];
  onTab: (t: (typeof TABS)[number]) => void;
  onAddPrivilege: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [editingDetails, setEditingDetails] = React.useState(false);

  const role = useQuery({ queryKey: accessKeys.roleDetail(roleKey), queryFn: () => accessApi.roleDetail(roleKey) });
  const manifest = useQuery({ queryKey: accessKeys.manifest(), queryFn: accessApi.manifest });

  const [disabling, setDisabling] = React.useState(false);

  const toggle = useMutation({
    mutationFn: ({ enabled, reason }: { enabled: boolean; reason: string }) =>
      accessApi.setRoleEnabled(roleKey, enabled, reason),
    onSuccess: (_d, v) => {
      toast({
        variant: "success",
        title: v.enabled ? "Role enabled" : "Role disabled",
        description: v.enabled ? undefined : "Everyone holding it loses its permissions immediately.",
      });
      setDisabling(false);
      void qc.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (e) => toast({ title: "Refused", description: (e as Error).message, variant: "destructive" }),
  });

  if (role.isLoading) return <div className="p-8"><Skeleton className="h-96 w-full rounded-xl" /></div>;
  if (!role.data) return <div className="p-8 text-[14px]" style={{ color: "var(--ink2)" }}>No such role.</div>;

  const r = role.data;
  const mods = manifest.data?.modules ?? [];
  const modules = new Set(r.permissions.map((p) => p.module)).size;
  const fixed = r.isSystem || r.computed;

  return (
    <div className="mx-auto flex flex-col gap-[18px] px-6 py-7 sm:px-8" style={{ maxWidth: 980 }}>
      {/* Same header shape as a person: back link, mark inline with the name,
          status beside it, one subline, actions right. Two screens that answer
          "who is this and what do they hold" should not be laid out
          differently. */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-4" style={{ flexBasis: 320 }}>
            <UamRoleMark size={56} />
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="uam-title m-0">{r.label}</h1>
                {fixed ? (
                  <span
                    className="inline-flex h-6 shrink-0 items-center rounded-full px-[9px] text-[12.5px] font-medium"
                    style={{ border: "1px solid var(--line2)", color: "var(--ink2)" }}
                  >
                    Built in
                  </span>
                ) : r.isActive ? (
                  <span
                    className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-[9px] text-[12.5px] font-medium"
                    style={{ background: "var(--allow-soft)", color: "var(--allow)" }}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--allow)" }} /> Enabled
                  </span>
                ) : (
                  <span className="uam-badge uam-badge-block shrink-0">Disabled</span>
                )}
              </div>
              <p className="uam-lede m-0 text-[14.5px]">
                {r.description ? `${r.description} · ` : ""}
                {r.scopeModule ? "Module persona" : "Staff role"}
                {" · "}
                Held by {r.holders.length === 1 ? "1 person" : `${r.holders.length} people`}
                {" · "}
                {r.permissions.length} {r.permissions.length === 1 ? "permission" : "permissions"} across {modules} {modules === 1 ? "module" : "modules"}
              </p>
            </div>
          </div>

          {!fixed && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <button onClick={() => setEditingDetails(true)} className="uam-btn h-10 px-4 text-[14px]">Edit Role</button>
              <button onClick={onAddPrivilege} className="uam-btn uam-btn-primary h-10 px-4 text-[14px]">Grant Privilege</button>
            </div>
          )}
        </div>
      </div>

      <div className="uam-tabs">
        {TABS.map((t) => {
          const count =
            t === "What it allows" ? r.permissions.length
            : t === "Who holds it" ? r.holders.length
            : t === "Privileges" ? r.privileges.length
            : null;
          return (
            <button key={t} onClick={() => onTab(t)} aria-selected={tab === t} className="uam-tab">
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

      {tab === "What it allows" && <WhatItAllows role={r} modules={mods} />}

      {tab === "Who holds it" && (
        r.holders.length === 0 ? (
          <UamEmpty title="Nobody holds this role" text="Assign it from a person's page. A role with no holders changes nothing until someone has it." />
        ) : (
          <div className="uam-card overflow-hidden">
            {r.holders.map((h) => (
              <button
                key={h.id}
                onClick={() => navigate(`/uam/users/${h.id}`)}
                className="uam-row uam-row-link w-full text-left"
              >
                <UamAvatar name={h.name} size={30} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] font-medium">{h.name}</span>
                  <span className="truncate text-[12.5px]" style={{ color: "var(--ink3)" }}>{h.email}</span>
                </span>
                {!h.isActive && <span className="uam-badge uam-badge-block">deactivated</span>}
              </button>
            ))}
          </div>
        )
      )}

      {tab === "Privileges" && (
        <div className="flex flex-col gap-4">
          {/* A set assigned to a ROLE reaches everyone holding it — the same
              blast radius as editing the role's own permissions, so it belongs
              on the role's page rather than only on each person's. */}
          <HeldSets subjectId={r.key} />

          {r.privileges.length === 0 ? (
            <UamEmpty
              title="No privileges on this role"
              text="Everyone holding it gets exactly what it allows, everywhere they work."
              action={fixed ? undefined : <button onClick={onAddPrivilege} className="uam-btn h-9 px-3.5 text-[14px]">Grant Privilege</button>}
            />
          ) : (
          <div className="flex flex-col gap-2.5">
            {r.privileges.map((p) => (
              <div key={p.id} className="uam-card flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <UamVerdict allow={p.effect === "GRANT"} />
                  <span className="text-[15px] font-medium">{actionList(p.functionality, [p.action])}</span>
                  <span className="text-[13px]" style={{ color: "var(--ink3)" }}>
                    {p.nodeName ? `at ${p.nodeName}` : "everywhere"}
                  </span>
                </div>
                {/* What the permission means, and the identifier this row IS —
                    the same pair shown wherever access is displayed or asked
                    for. */}
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
                  <span>
                    Reaches everyone holding this role{untilWords(p.expiresAt) ? ` · ${untilWords(p.expiresAt)}` : ""}
                  </span>
                  {p.approvalFilename && (
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
        </div>
      )}

      {tab === "Status" && (
        <div className="uam-card flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
          <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <span className={`uam-badge ${r.isActive ? "uam-badge-allow" : "uam-badge-block"}`}>
              {r.isActive ? "Enabled" : "Disabled"}
            </span>
            <span className="text-[14px]" style={{ color: "var(--ink2)" }}>
              {r.isActive
                ? "Everyone holding this role gets what it allows."
                : "Nobody gets anything from this role, even while they still hold it."}
            </span>
          </div>
          <p className="m-0 text-[13px]" style={{ color: "var(--ink3)" }}>
            {fixed
              ? "This is a built-in role. What it allows is worked out by rule rather than stored, so it cannot be edited or switched off — that is what stops an administrator editing themselves out of the system."
              : `Disabling reaches ${r.holders.length === 1 ? "1 person" : `${r.holders.length} people`} at once, and takes effect immediately. It is reversible; deleting would not be, which is why it is not offered.`}
          </p>
          </div>
          {!fixed && (
            <button
              // Turning it OFF shows who it reaches first; turning it back on
              // only ever restores what the role already describes.
              onClick={() =>
                r.isActive
                  ? setDisabling(true)
                  : toggle.mutate({ enabled: true, reason: "Re-enabled from the roles screen" })
              }
              className={`uam-btn h-9 shrink-0 px-3.5 text-[14px] ${r.isActive ? "uam-btn-danger" : ""}`}
            >
              {r.isActive ? "Disable Role" : "Enable Role"}
            </button>
          )}
        </div>
      )}

      {editingDetails && <EditRoleSheet role={r} onClose={() => setEditingDetails(false)} />}

      {disabling && (
        <DisableRoleDialog
          roleKey={roleKey}
          roleLabel={r.label}
          pending={toggle.isPending}
          onConfirm={(reason) => toggle.mutate({ enabled: false, reason })}
          onClose={() => setDisabling(false)}
        />
      )}
    </div>
  );
}
