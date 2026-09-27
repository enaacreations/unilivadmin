import * as React from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { uamApi, accessApi, accessKeys, ANCHOR_WORD } from "@/lib/access-api";
import { UamAvatar } from "./shell";
import { UamSelect } from "./select";
import "./uam.css";

/**
 * Add a person — a MODAL, per the design's rule: a sheet to edit one thing, a
 * modal when the change is wide or cannot be undone. Creating an account is
 * both.
 *
 * Four steps in the order the answers arrive: who they are, what they do, where
 * they do it, and a last look. The third step exists on its own because it is
 * the one people skip, and skipping it creates an account that can sign in and
 * see nothing — this system's most common misconfiguration.
 *
 * "Where" is asked PER ROLE, because a role never names a place: a Cluster
 * Manager is given a cluster and a Unit Lead one or more properties, and the
 * same person can hold both at different rungs. Asking once, globally, was the
 * old single-property model wearing a wizard step — it could not express the
 * requirement this module exists for. Roles with no anchor of their own say so
 * rather than silently taking the home property.
 */
/**
 * Three steps, not four.
 *
 * "Check" used to be the last one — a read-only summary you walked through
 * before submitting, which asked the operator to confirm what they had just
 * typed on the previous screen. The same summary is more useful AFTER the
 * account exists, next to the password they have to hand over, so it moved
 * there and is called Preview.
 *
 * Only the first step is required. Roles and places can be decided now or left
 * for later — an account with neither can sign in and do nothing, which is a
 * legitimate half-way state and better than a half-filled form nobody submits.
 */
const STEPS = ["Who", "What they do", "Where"] as const;

export function CreateUserWizard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [step, setStep] = React.useState(0);

  const [form, setForm] = React.useState({
    name: "", email: "", phone: "", designation: "",
    userType: "INTERNAL" as "INTERNAL" | "EXTERNAL",
    dob: "", gender: "",
  });
  const [roles, setRoles] = React.useState<string[]>([]);
  const [propertyId, setPropertyId] = React.useState("");
  /** roleKey → the nodes that role is handed out at, for anchored roles only. */
  const [roleNodes, setRoleNodes] = React.useState<Record<string, string[]>>({});
  const [copyFrom, setCopyFrom] = React.useState("");
  const [done, setDone] = React.useState<{ id?: string; email: string; generatedPassword?: string; copiedPrivileges: number } | null>(null);

  const roleList = useQuery({ queryKey: accessKeys.roles(), queryFn: accessApi.roles });
  const nodes = useQuery({ queryKey: accessKeys.nodes(), queryFn: accessApi.nodes });
  const users = useQuery({ queryKey: accessKeys.users(), queryFn: accessApi.users });

  const properties = (nodes.data ?? []).filter((n) => n.nodeType === "PROPERTY" && n.isActive);
  // Module personas are granted, not held as an identity — offering them here
  // would be two ways to say one thing.
  const assignable = (roleList.data ?? []).filter((r) => !r.scopeModule && r.isActive !== false);
  const selected = assignable.filter((r) => roles.includes(r.key));
  const anchoredRoles = selected.filter((r) => r.anchorLevel);

  /** Roles still on offer, grouped by the rung they are handed out on. */
  const ANCHOR_GROUP_ORDER = ["ZONE", "CITY", "CLUSTER", "KITCHEN", "PROPERTY"] as const;
  const roleOptions = assignable
    .filter((r) => !roles.includes(r.key))
    .map((r) => ({
      value: r.key,
      label: r.label,
      hint: r.holders === 1 ? "1 person" : `${r.holders} people`,
      group: r.anchorLevel ? `Given a ${ANCHOR_WORD[r.anchorLevel]}` : "No place of its own",
    }))
    .sort((a, b) => {
      const rank = (g: string) => {
        const i = ANCHOR_GROUP_ORDER.findIndex((lvl) => g === `Given a ${ANCHOR_WORD[lvl]}`);
        return i === -1 ? ANCHOR_GROUP_ORDER.length : i;
      };
      return rank(a.group) - rank(b.group) || a.label.localeCompare(b.label);
    });
  const placelessRoles = selected.filter((r) => !r.anchorLevel);

  const create = useMutation({
    mutationFn: () =>
      uamApi.createUser({
        ...form,
        dob: form.dob || null,
        gender: form.gender || null,
        roles,
        propertyId: propertyId || null,
        // Only the roles still selected — deselecting a role in step 2 must not
        // leave its places behind to be written for a role they do not hold.
        roleNodes: Object.fromEntries(
          roles.map((r) => [r, roleNodes[r] ?? []]).filter(([, n]) => (n as string[]).length),
        ),
        copyPrivilegesFrom: copyFrom || null,
      }),
    onSuccess: (d) => {
      setDone({ id: d.id, email: d.email, generatedPassword: d.generatedPassword, copiedPrivileges: d.copiedPrivileges });
      void qc.invalidateQueries({ queryKey: ["uam"] });
      void qc.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (e) => toast({ title: "Could not add them", description: (e as Error).message, variant: "destructive" }),
  });

  /** Only identity is required. Everything after it is optional by design. */
  const basicsOk = form.name.trim().length > 1 && /.+@.+\..+/.test(form.email);
  const canGo = step === 0 ? basicsOk : true;
  const isLast = step === STEPS.length - 1;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="uam max-h-[88vh] max-w-[580px] overflow-hidden p-0" style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
        <header className="px-6 pb-4 pt-6">
          <span className="uam-kicker font-medium">{done ? "Preview" : "Create User"}</span>
          <DialogTitle asChild>
            <h2 className="uam-title m-0 mt-1" style={{ fontSize: 18 }}>
              {done ? "Here is what was created" : "Who are you adding?"}
            </h2>
          </DialogTitle>
          <DialogDescription className="sr-only">
            {done
              ? "The account was created. Copy the temporary password before closing."
              : "Add a person: their details, the roles they hold, and where they work."}
          </DialogDescription>
        </header>

        {done ? (
          <div className="flex flex-col gap-3 px-6 pb-6">
            <div className="uam-card flex items-center gap-3 p-3.5">
              <UamAvatar name={form.name} />
              <span className="flex min-w-0 flex-col">
                <span className="text-[14.5px] font-medium">{form.name}</span>
                <span className="text-[12.5px]" style={{ color: "var(--ink3)" }}>{done.email}</span>
              </span>
            </div>
            {done.generatedPassword && (
              <div>
                <div className="mb-1.5 text-[13px] font-semibold">
                  Temporary password
                  <span className="ml-1.5 font-normal" style={{ color: "var(--ink3)" }}>shown once — hand it over now</span>
                </div>
                <div
                  className="flex items-center gap-2 rounded-[var(--r-sm)] px-3 py-2.5"
                  style={{ background: "var(--accent-soft)", border: "1px solid var(--accent)" }}
                >
                  <code className="min-w-0 flex-1 truncate text-[14px]" style={{ fontFamily: "var(--mono)" }}>
                    {done.generatedPassword}
                  </code>
                  <button
                    onClick={() => { void navigator.clipboard?.writeText(done.generatedPassword!); toast({ variant: "success", title: "Copied" }); }}
                    className="uam-btn h-7 px-2"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )}
            {/* The summary that used to be a "Check" step before submitting.
                It reads better here: the same facts, but about an account that
                now exists, beside the one-time password and the gaps still to
                fill. */}
            <div className="uam-card flex flex-col gap-2.5 p-4 text-[14px]">
              <Row k="Type" v={form.userType === "INTERNAL" ? "Staff" : "Resident"} />
              {form.phone && <Row k="Mobile" v={form.phone} />}
              <div className="flex gap-3">
                <span className="w-[110px] shrink-0 text-[12.5px]" style={{ color: "var(--ink3)" }}>Roles</span>
                <span className="flex min-w-0 flex-wrap gap-1.5">
                  {roles.length === 0 ? (
                    <span className="text-[13.5px]" style={{ color: "var(--warn)" }}>None yet</span>
                  ) : (
                    roles.map((r) => (
                      <span key={r} className="uam-badge">{assignable.find((x) => x.key === r)?.label ?? r}</span>
                    ))
                  )}
                </span>
              </div>
              {anchoredRoles.map((r) => (
                <Row
                  key={r.key}
                  k={r.label}
                  v={
                    (roleNodes[r.key] ?? [])
                      .map((id) => (nodes.data ?? []).find((n) => n.id === id)?.name)
                      .filter(Boolean)
                      .join(", ") || `No ${ANCHOR_WORD[r.anchorLevel!]} yet`
                  }
                />
              ))}
              <Row k="Home property" v={properties.find((p) => p.id === propertyId)?.name ?? "Nowhere yet"} />
            </div>

            {(roles.length === 0 || !propertyId) && (
              <p className="m-0 text-[13.5px]" style={{ color: "var(--warn)" }}>
                {roles.length === 0
                  ? "They hold no roles yet, so they can sign in and do nothing. Open their page to give them roles and a place."
                  : "They have no property yet, so they will see nothing until one is given."}
              </p>
            )}
            {done.copiedPrivileges > 0 && (
              <p className="m-0 text-[13.5px]" style={{ color: "var(--ink2)" }}>
                {done.copiedPrivileges} privilege{done.copiedPrivileges === 1 ? "" : "s"} copied across.
              </p>
            )}
            <div className="mt-1 flex items-center justify-end gap-2">
              {done.id && (
                <button
                  onClick={() => { onClose(); navigate(`/uam/users/${done.id}`); }}
                  className="uam-btn h-9 px-3.5"
                >
                  Open their page
                </button>
              )}
              <button onClick={onClose} className="uam-btn uam-btn-primary h-9 px-4">Done</button>
            </div>
          </div>
        ) : (
          <>
            {/* A real stepper: numbered beads joined by a rule, so "where am I
                and how much is left" is answerable at a glance. A completed
                step is clickable — going back to change an answer is normal,
                and the only thing gating forward movement is step one. */}
            <ol className="flex items-center gap-0 px-6 pb-4" style={{ listStyle: "none", margin: 0 }}>
              {STEPS.map((label, i) => {
                const state = i === step ? "current" : i < step ? "done" : "todo";
                const reachable = i < step || (i === step + 1 && canGo);
                return (
                  <li key={label} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none">
                    <button
                      type="button"
                      disabled={!reachable && state !== "current"}
                      onClick={() => reachable && setStep(i)}
                      aria-current={state === "current" ? "step" : undefined}
                      className="flex shrink-0 items-center gap-2 rounded-full py-1 pr-1 text-[12.5px]"
                      style={{ cursor: reachable ? "pointer" : "default" }}
                    >
                      <span
                        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold"
                        style={
                          state === "done"
                            ? { background: "var(--allow)", color: "#fff" }
                            : state === "current"
                              ? { background: "var(--accent)", color: "#fff" }
                              : { border: "1.5px solid var(--line)", color: "var(--ink3)" }
                        }
                      >
                        {state === "done" ? <Check className="h-3 w-3" /> : i + 1}
                      </span>
                      <span
                        className="truncate"
                        style={{
                          color: state === "todo" ? "var(--ink3)" : "var(--ink)",
                          fontWeight: state === "current" ? 600 : 400,
                        }}
                      >
                        {label}
                      </span>
                    </button>
                    {i < STEPS.length - 1 && (
                      <span
                        aria-hidden
                        className="h-px min-w-[12px] flex-1"
                        style={{ background: i < step ? "var(--allow)" : "var(--line)" }}
                      />
                    )}
                  </li>
                );
              })}
            </ol>

            <div className="flex max-h-[52vh] flex-col gap-4 overflow-y-auto px-6 pb-5">
              {step === 0 && (
                <>
                  <F label="Full name"><input className="uam-input uam-input-fill h-10" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></F>
                  <F label="Email"><input type="email" className="uam-input uam-input-fill h-10" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></F>
                  <div className="grid grid-cols-2 gap-3">
                    <F label="Phone"><input className="uam-input uam-input-fill h-10" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></F>
                    <F label="Job title"><input className="uam-input uam-input-fill h-10" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} /></F>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <F label="Date of birth"><input type="date" className="uam-input uam-input-fill h-10" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} /></F>
                    <F label="Gender">
                      <UamSelect
                        value={form.gender}
                        onChange={(v) => setForm({ ...form, gender: v })}
                        placeholder="Prefer not to say"
                        options={[
                          { value: "", label: "Prefer not to say" },
                          ...["MALE", "FEMALE", "OTHER"].map((g) => ({
                            value: g,
                            label: g[0]! + g.slice(1).toLowerCase(),
                          })),
                        ]}
                      />
                    </F>
                  </div>
                  <F label="Staff or resident">
                    <div className="flex gap-1.5">
                      {(["INTERNAL", "EXTERNAL"] as const).map((t) => (
                        <button key={t} onClick={() => setForm({ ...form, userType: t })} className={`uam-chip ${form.userType === t ? "uam-chip-on" : ""}`}>
                          {t === "INTERNAL" ? "Staff" : "Resident"}
                        </button>
                      ))}
                    </div>
                  </F>
                </>
              )}

              {step === 1 && (
                <F label="Which roles" hint="Optional, and they can hold several. What they can do is everything these allow, combined.">
                  {/* The module's own picker rather than a thirty-item list:
                      searchable, and grouped by the rung each role is handed
                      out on — which is exactly what the next step will ask for,
                      so the grouping previews the question instead of just
                      sorting the list. Picking ADDS; the chips below are the
                      answer, and removing one is a click on its cross. */}
                  <UamSelect
                    value=""
                    onChange={(k) => setRoles((prev) => (prev.includes(k) ? prev : [...prev, k]))}
                    placeholder={roles.length ? "Add another role…" : "Pick a role…"}
                    searchPlaceholder="Search roles…"
                    emptyText="No role by that name."
                    options={roleOptions}
                  />

                  {roles.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {roles.map((k) => {
                        const r = assignable.find((x) => x.key === k);
                        return (
                          <span key={k} className="uam-chip uam-chip-on">
                            {r?.label ?? k}
                            <button
                              onClick={() => setRoles((prev) => prev.filter((x) => x !== k))}
                              aria-label={`Remove ${r?.label ?? k}`}
                              className="ml-0.5 opacity-60 hover:opacity-100"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <p className="m-0 text-[12.5px]" style={{ color: "var(--ink3)" }}>
                    {roles.length === 0
                      ? "Leave this empty to create the account now and decide roles later."
                      : anchoredRoles.length > 0
                        ? `Next you'll say which ${anchoredRoles.map((r) => ANCHOR_WORD[r.anchorLevel!]).join(" and ")} ${anchoredRoles.length === 1 ? "it applies to" : "they apply to"}.`
                        : "None of these carry a place of their own."}
                  </p>
                </F>
              )}

              {step === 2 && (
                <>
                  {/* One block per anchored role. Everything beneath what is
                      picked is included and STAYS included — a property added
                      to that cluster later needs no change here. */}
                  {anchoredRoles.map((r) => {
                    const level = r.anchorLevel!;
                    const picked = roleNodes[r.key] ?? [];
                    const options = (nodes.data ?? []).filter((n) => n.isActive && n.nodeType === level);
                    return (
                      <F
                        key={r.key}
                        label={`${r.label} — which ${ANCHOR_WORD[level]}?`}
                        hint={`Everything under it is included, and stays included as the estate grows.`}
                      >
                        {options.length === 0 ? (
                          <span className="text-[13px]" style={{ color: "var(--warn)" }}>
                            No {ANCHOR_WORD[level]} exists yet — this role will reach nothing.
                          </span>
                        ) : (
                          <>
                            {/* Same picker as everywhere else in the module.
                                A flat row of every cluster is unsearchable and
                                grows with the estate; this stays one control
                                whether there are nine of them or ninety. */}
                            <UamSelect
                              value=""
                              onChange={(id) =>
                                setRoleNodes((p) => {
                                  const cur = p[r.key] ?? [];
                                  return cur.includes(id) ? p : { ...p, [r.key]: [...cur, id] };
                                })
                              }
                              placeholder={picked.length ? `Add another ${ANCHOR_WORD[level]}…` : `Pick a ${ANCHOR_WORD[level]}…`}
                              searchPlaceholder={`Search ${ANCHOR_WORD[level]}s…`}
                              emptyText={`No ${ANCHOR_WORD[level]} by that name.`}
                              options={options
                                .filter((n) => !picked.includes(n.id))
                                .map((n) => ({ value: n.id, label: n.name }))}
                            />

                            {picked.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {picked.map((id) => {
                                  const n = options.find((o) => o.id === id);
                                  return (
                                    <span key={id} className="uam-chip uam-chip-on">
                                      {n?.name ?? id}
                                      <button
                                        onClick={() =>
                                          setRoleNodes((p) => ({ ...p, [r.key]: (p[r.key] ?? []).filter((x) => x !== id) }))
                                        }
                                        aria-label={`Remove ${n?.name ?? id}`}
                                        className="ml-0.5 opacity-60 hover:opacity-100"
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </span>
                                  );
                                })}
                              </div>
                            )}

                            {picked.length === 0 && (
                              <p className="m-0 text-[12.5px]" style={{ color: "var(--warn)" }}>
                                With no {ANCHOR_WORD[level]}, {r.label} gives them nothing at all.
                              </p>
                            )}
                          </>
                        )}
                      </F>
                    );
                  })}

                  {placelessRoles.length > 0 && (
                    <p className="m-0 text-[13px]" style={{ color: "var(--ink3)" }}>
                      {placelessRoles.map((r) => r.label).join(", ")}{" "}
                      {placelessRoles.length === 1 ? "carries" : "carry"} no place of its own — where
                      it applies is decided by the home property below.
                    </p>
                  )}

                  <F label="Home property" hint="Where they are based. Used by the screens that still work one property at a time.">
                    <UamSelect
                      value={propertyId}
                      onChange={setPropertyId}
                      placeholder="Nowhere yet"
                      options={[
                        { value: "", label: "Nowhere yet" },
                        ...properties.map((p) => ({ value: p.id, label: p.name })),
                      ]}
                    />
                  </F>
                  <F label="Copy someone's privileges" hint="Optional. Only their privileges — roles and place stay as you set them above.">
                    <UamSelect
                      value={copyFrom}
                      onChange={setCopyFrom}
                      placeholder="Nobody — start clean"
                      searchPlaceholder="Search users…"
                      emptyText="Nobody by that name."
                      options={[
                        { value: "", label: "Nobody — start clean" },
                        ...(users.data ?? []).map((u) => ({
                          value: u.id,
                          label: u.name,
                          icon: <UamAvatar name={u.name} size={22} />,
                          hint: u.email,
                        })),
                      ]}
                    />
                  </F>
                </>
              )}

            </div>

            <footer className="flex items-center gap-2 px-6 py-4" style={{ borderTop: "1px solid var(--line)" }}>
              <button onClick={() => (step === 0 ? onClose() : setStep(step - 1))} className="uam-btn h-9 px-3.5">
                {step === 0 ? "Cancel" : "Back"}
              </button>
              <span className="flex-1" />
              {/* Everything after step one is optional, so it must be possible to
                  stop here. Without this the only way out of a form you do not
                  yet have the answers for is to abandon it. */}
              {!isLast && (
                <button
                  onClick={() => create.mutate()}
                  disabled={!basicsOk || create.isPending}
                  className="uam-btn h-9 px-3.5"
                  title="Create the account now and set roles and places later"
                >
                  {create.isPending ? "Creating…" : "Create now"}
                </button>
              )}
              <button
                disabled={!canGo || create.isPending}
                onClick={() => (isLast ? create.mutate() : setStep(step + 1))}
                className="uam-btn uam-btn-primary h-9 px-3.5"
              >
                {isLast ? (create.isPending ? "Creating…" : "Create User") : "Continue"}
              </button>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A div rather than a label: these fields hold a GROUP of controls, or a
 * combobox whose trigger is a <button> — and <button> is a labelable element,
 * so a wrapping <label> forwards a click on the heading straight into it.
 * Clicking the words "Handed out at" opened the dropdown.
 */
function F({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-[110px] shrink-0 text-[12.5px]" style={{ color: "var(--ink3)" }}>{k}</span>
      <span className="min-w-0 flex-1">{v}</span>
    </div>
  );
}
