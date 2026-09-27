import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { uamApi, accessApi, accessKeys, type UamUser } from "@/lib/access-api";
import { UamPage, UamNotice, UamEmpty, UamAvatar, UamSeg } from "./shell";
import { UamSelect } from "./select";
import { CreateUserWizard } from "./create-user";

/**
 * Users — WHO has an account. Not what they can do with it.
 *
 * The roles and the place they work used to be columns here, and they were the
 * wrong thing to put in a directory: both are answers to "what access does this
 * person have", which is the whole of the detail page and is meaningless
 * without the tree that explains it. Two role chips and a property name told
 * you neither — a person with five roles read the same as one with two.
 *
 * So this row identifies a PERSON: what to call them, how to reach them, what
 * they do, whether the account still works. Access is one click away, where it
 * has the room to be true.
 *
 * Dropping those columns also removed a detail fetch PER ROW — the holds and
 * privilege counts came from the detail endpoint, which meant opening this
 * screen fired one request per account.
 *
 * Gender and date of birth are deliberately absent: the columns would be empty
 * on every row today, and an empty column is worse than no column.
 *
 * The banner above the table stays. "Can sign in, sees nothing" is this
 * system's most common misconfiguration, and it is a fact about the page, not a
 * detail about a person.
 */
/** Person · Mobile · Role & title · Last seen · Status. */
const COLS = "minmax(0,1.9fr) 132px minmax(0,1.3fr) 110px 104px";

/** A last-login stamp as a person would say it, short enough for a column. */
function lastSeen(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" });
}

export default function UsersScreen() {
  const [, navigate] = useLocation();
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState<"all" | "active" | "inactive" | "noplace">("all");
  const [roleFilter, setRoleFilter] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const users = useQuery({
    queryKey: accessKeys.uamUsers({ limit: "200" }),
    queryFn: () => uamApi.users({ limit: "200" }),
  });
  const roles = useQuery({ queryKey: accessKeys.roles(), queryFn: accessApi.roles });
  const all = users.data?.data ?? [];
  const placeless = all.filter((u) => u.isActive && !u.propertyId);

  const rows = all.filter((u: UamUser) => {
    if (status === "active" && !u.isActive) return false;
    if (status === "inactive" && u.isActive) return false;
    if (status === "noplace" && (u.propertyId || !u.isActive)) return false;
    if (roleFilter && u.role !== roleFilter) return false;
    if (!q.trim()) return true;
    const n = q.toLowerCase();
    return [u.name, u.email, u.phone, u.username, u.designation, u.role]
      .some((v) => (v ?? "").toLowerCase().includes(n));
  });

  return (
    <UamPage
      kicker={`Users · ${all.length} accounts`}
      title="Who has an account?"
      actions={
        <button onClick={() => setCreating(true)} className="uam-btn uam-btn-primary h-10 px-4 text-[14px]">
          Create User
        </button>
      }
    >
      {placeless.length > 0 && status !== "noplace" && (
        <UamNotice
          action={
            <button onClick={() => setStatus("noplace")} className="uam-btn h-8 px-3 text-[13px]">
              Show
            </button>
          }
        >
          <strong className="font-semibold">
            {placeless.length} {placeless.length === 1 ? "person has" : "people have"} no property.
          </strong>{" "}
          They can sign in, but see nothing until they&rsquo;re given a place to work.
        </UamNotice>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, email, mobile or username"
          className="uam-input uam-input-fill h-[38px] min-w-0 flex-1"
          style={{ flexBasis: 260 }}
        />
        <UamSeg<typeof status>
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "Everyone" },
            { value: "active", label: "Active" },
            { value: "inactive", label: "Deactivated" },
          ]}
        />
        <div className="w-[220px]">
          <UamSelect
            value={roleFilter}
            onChange={setRoleFilter}
            placeholder="Any role"
            searchPlaceholder="Search roles…"
            emptyText="No role by that name."
            options={[
              { value: "", label: "Any role" },
              ...(roles.data ?? []).filter((r) => !r.scopeModule).map((r) => ({
                value: r.key,
                label: r.label,
                hint: r.holders === 1 ? "1 person" : `${r.holders} people`,
              })),
            ]}
          />
        </div>
        {status === "noplace" && (
          <button
            onClick={() => setStatus("all")}
            className="uam-chip"
            style={{ background: "var(--warn-soft)", borderColor: "var(--warn-line)" }}
          >
            Showing: no property <span style={{ color: "var(--ink3)" }}>×</span>
          </button>
        )}
      </div>

      {users.isLoading ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : rows.length === 0 ? (
        <UamEmpty
          title="Nobody matches"
          text="Try a different search, or clear the filters to see everyone with an account."
        />
      ) : (
        <div className="uam-card overflow-hidden">
          <div
            className="grid gap-4 px-[18px] py-2.5 text-[12.5px] font-medium"
            style={{ gridTemplateColumns: COLS, borderBottom: "1px solid var(--line)", color: "var(--ink3)" }}
          >
            <span>Person</span><span>Mobile</span><span>Role &amp; title</span><span>Last seen</span><span>Status</span>
          </div>
          {rows.map((u) => {
            const roleLabel = (roles.data ?? []).find((r) => r.key === u.role)?.label ?? u.role;
            return (
              <button
                key={u.id}
                onClick={() => navigate(`/uam/users/${u.id}`)}
                className="uam-row-link grid w-full gap-4 px-[18px] py-3 text-left"
                style={{ gridTemplateColumns: COLS, alignItems: "center", borderTop: "1px solid var(--line)", marginTop: -1 }}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <UamAvatar name={u.name} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[14.5px] font-medium">{u.name}</span>
                    <span className="truncate text-[12.5px]" style={{ color: "var(--ink3)" }}>{u.email}</span>
                  </span>
                </span>

                {/* Tabular figures so a column of numbers lines up rather than
                    wandering, which is the only way a phone column is scannable. */}
                <span className="truncate text-[14px]" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {u.phone ?? <span style={{ color: "var(--ink3)" }}>—</span>}
                </span>

                {/* Their job, then the name they sign in with. The single role
                    is the legacy primary — the full set lives on the detail
                    page, where the tree can say where each one applies. */}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px]">{u.designation ?? roleLabel}</span>
                  <span className="truncate text-[12.5px]" style={{ color: "var(--ink3)" }}>
                    {u.designation ? roleLabel : (u.username ?? u.email.split("@")[0])}
                  </span>
                </span>

                <span className="truncate text-[13.5px]" style={{ color: u.lastLogin ? "var(--ink2)" : "var(--ink3)" }}>
                  {lastSeen(u.lastLogin)}
                </span>

                <span className="flex items-center gap-[7px] text-[13.5px]">
                  <span
                    className="h-[7px] w-[7px] shrink-0 rounded-full"
                    style={u.isActive
                      ? { background: "var(--allow)" }
                      : { border: "1.5px solid var(--ink3)" }}
                  />
                  {u.isActive ? "Active" : "Deactivated"}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {creating && <CreateUserWizard onClose={() => setCreating(false)} />}
    </UamPage>
  );
}
