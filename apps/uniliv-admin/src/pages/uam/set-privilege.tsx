import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Paperclip } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { accessApi, accessKeys } from "@/lib/access-api";
import { UamVerdict, UamSeg } from "./shell";
import { actionLabel, actionMeaning, permissionId, placeSelectOptions } from "./words";
import { SubjectPicker } from "./subject-picker";
import { UamSelect } from "./select";

/**
 * Create a privilege — a SIDE SHEET, per the design's own rule: a sheet to edit
 * one thing, a modal only when the change is wide or cannot be undone.
 *
 * A privilege is one line of access written on top of a role: this person (or
 * everyone in this role) may — or may not — do this one thing, at this one
 * place. The module says "privilege" everywhere; there is no second word for
 * the same object.
 *
 * Five questions in the order an administrator thinks them: who, what, where,
 * allowed or blocked, and why. The "why" is last and required because it is the
 * field that makes this reviewable in six months, and asking for it first would
 * read as bureaucracy before the person knows what they are writing about.
 */
export function SetPrivilegeSheet({
  defaultSubject,
  defaultNodeId,
  onClose,
}: {
  defaultSubject?: { type: "USER" | "ROLE"; id: string };
  defaultNodeId?: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [subjectType, setSubjectType] = React.useState<"USER" | "ROLE">(defaultSubject?.type ?? "USER");
  const [subjectId, setSubjectId] = React.useState(defaultSubject?.id ?? "");
  /**
   * What is being granted.
   *
   * A functionality and a privilege SET are the same kind of answer to "what can
   * they do", so they share one picker rather than one field and a separate
   * button. A set is not a different feature — it is a permission that happens
   * to have several parts, and putting it behind its own control made somebody
   * choose between two things that are the same choice.
   *
   * Exactly one of these is ever set.
   */
  const [functionality, setFunctionality] = React.useState("");
  // Several actions of one functionality can be granted at once. The server
  // still takes one cell per call (PUT /access/privileges is one row by design),
  // so a multi-action grant is N calls sharing the same reason, place and effect.
  const [actions, setActions] = React.useState<string[]>([]);
  const [setId, setSetId] = React.useState("");
  const [nodeId, setNodeId] = React.useState<string>(defaultNodeId ?? "");
  const [effect, setEffect] = React.useState<"GRANT" | "DENY">("GRANT");
  const [reason, setReason] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [approval, setApproval] = React.useState<{ dataUrl: string; filename: string } | null>(null);
  const [approvalError, setApprovalError] = React.useState("");
  const [expiry, setExpiry] = React.useState<ExpiryChoice>("none");
  const dateRef = React.useRef<HTMLInputElement>(null);

  /*
   * Picking "Pick a date" should open the calendar, not hand back an empty
   * dd/mm/yyyy to type into. showPicker() needs transient user activation,
   * which the click that got us here still carries; it throws where that has
   * lapsed or the browser does not implement it, so focus is the fallback.
   */
  React.useEffect(() => {
    if (expiry !== "custom") return;
    const el = dateRef.current;
    if (!el) return;
    try { el.showPicker(); } catch { el.focus(); }
  }, [expiry]);

  const users = useQuery({ queryKey: accessKeys.users(), queryFn: accessApi.users });
  const roles = useQuery({ queryKey: accessKeys.roles(), queryFn: accessApi.roles });
  const nodes = useQuery({ queryKey: accessKeys.nodes(), queryFn: accessApi.nodes });
  const manifest = useQuery({ queryKey: accessKeys.manifest(), queryFn: accessApi.manifest });
  const sets = useQuery({ queryKey: accessKeys.privilegeSets(), queryFn: accessApi.privilegeSets });
  const pickedSet = (sets.data ?? []).find((x) => x.id === setId);

  /** The picked functionality's metadata, from the flattened manifest list. */
  const fn = (manifest.data?.functionalities ?? []).find((f) => f.key === functionality);

  // Escape closes, because a sheet that traps you is a modal wearing a disguise.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = useMutation({
    // One form, two endpoints, because the two write different rows. A set
    // assignment is a POINTER that expands at read time; flattening it into
    // privileges here would lose the live reference that makes a set worth
    // having, and the holder would keep whatever the set said on the day.
    // Returns void: the two endpoints answer with different shapes and nothing
    // here reads either, so widening to their union would only make the caller
    // narrow a value it does not want.
    mutationFn: async (): Promise<void> => {
      if (pickedSet) {
        await accessApi.assignPrivilegeSet(pickedSet.id, {
          subjectType, subjectId,
          nodeId: nodeId || null, reason,
          expiresAt: expiresAt || null,
          approval,
        });
        return;
      }
      // One PUT per selected action — the endpoint writes one cell per call on
      // purpose, so each action becomes its own row carrying the same reason.
      for (const a of actions) {
        await accessApi.setPrivilege({
          subjectType, subjectId, functionality, action: a,
          nodeId: nodeId || null, effect, reason,
          expiresAt: expiresAt || null,
          approval,
        });
      }
    },
    onSuccess: () => {
      toast({
        variant: "success",
        title: pickedSet ? "Set granted" : "Privilege granted",
        description: pickedSet
          ? `${pickedSet.items.length} ${pickedSet.items.length === 1 ? "permission" : "permissions"}, on the activity trail with your reason.`
          : `${actions.length} ${actions.length === 1 ? "permission" : "permissions"} on the activity trail with your reason.`,
      });
      void qc.invalidateQueries({ queryKey: ["uam"] });
      void qc.invalidateQueries({ queryKey: ["access"] });
      onClose();
    },
    onError: (e) => toast({ title: "Refused", description: (e as Error).message, variant: "destructive" }),
  });

  const ready = subjectId && (setId || (functionality && actions.length > 0)) && reason.trim().length >= 4;
  // What is still stopping the grant, in words. A disabled button with no reason
  // reads as "broken"; naming the gap turns it into a to-do. Ordered the way the
  // form reads top-down, so the hint points at the next empty field.
  const missing = [
    !subjectId && "a person or role",
    !(setId || functionality) && "what they can do",
    functionality && actions.length === 0 && "an action to allow",
    reason.trim().length < 4 && "a reason",
  ].filter(Boolean) as string[];
  const subjectName =
    subjectType === "USER"
      ? users.data?.find((u) => u.id === subjectId)?.name
      : roles.data?.find((r) => r.key === subjectId)?.label;

  return (
    <div className="uam fixed inset-0 z-50 flex justify-end" style={{ background: "var(--scrim)" }} onClick={onClose}>
      <aside
        className="uam-sheet uam-sheet-enter flex h-full w-full max-w-[540px] flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="flex flex-col gap-1">
            <span className="uam-kicker">Grant Privilege</span>
            <span className="uam-title" style={{ fontSize: 18 }}>Give or take away one thing</span>
          </div>
          <button onClick={onClose} className="uam-btn h-8 w-8 justify-center border-transparent p-0">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          <Field label="Who is this for" hint="A person, or everyone in a role.">
            {/* One list, not a mode switch: the type is INFERRED from the pick.
                See subject-picker.tsx for why. */}
            <SubjectPicker
              users={users.data ?? []}
              roles={roles.data ?? []}
              value={subjectId ? { type: subjectType, id: subjectId } : null}
              onChange={(s) => { setSubjectType(s.type); setSubjectId(s.id); }}
              disabled={!!defaultSubject}
            />
            {subjectType === "ROLE" && subjectId && (
              <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--warn)" }}>
                This reaches everyone holding {subjectName}, not one person.
              </p>
            )}
          </Field>

          <Field label="What can they do" hint="A set, or one functionality and the action on it.">
            <UamSelect
              value={setId ? `set:${setId}` : functionality}
              onChange={(v) => {
                // `set:<id>` or a bare functionality key. One value, because
                // they are one choice: exactly one of the two can be in play.
                const isSet = v.startsWith("set:");
                setSetId(isSet ? v.slice(4) : "");
                setFunctionality(isSet ? "" : v);
                setActions([]);
              }}
              placeholder="Pick a set or a functionality…"
              searchPlaceholder="Search sets and functionalities…"
              emptyText="Nothing by that name."
              options={[
                // Sets FIRST, and named as what they are. A set is the unit
                // people actually ask for — "night audit cover", not six
                // permissions — so it should be the first thing offered, not a
                // thing you had to know to go looking for elsewhere.
                ...(sets.data ?? [])
                  .filter((x) => x.isActive)
                  .map((x) => ({
                    value: `set:${x.id}`,
                    label: x.name,
                    group: "Privilege sets",
                    hint: `${x.items.length} ${x.items.length === 1 ? "permission" : "permissions"}`,
                  })),
                // Then functionalities, grouped by MODULE: fifty-six flat is an
                // alphabet, and nobody looks for "Dispatch" without knowing it
                // is food. The module is how you find one, never what is
                // granted.
                ...(manifest.data?.modules ?? []).flatMap((m) =>
                  m.functionalities.map((f) => ({
                    value: f.key,
                    label: f.label,
                    group: m.label,
                    hint: f.protected ? "restricted" : undefined,
                  })),
                ),
              ]}
            />

            {/* A set needs no action step: the permissions ARE the set. Shown
                in full rather than as a count, because the failure mode of a
                bundle is somebody handing it over without reading it. */}
            {pickedSet && (
              <div className="mt-2 flex flex-col gap-1.5">
                <span className="text-[13px]" style={{ color: "var(--ink2)" }}>{pickedSet.description}</span>
                <div className="flex flex-wrap gap-1.5">
                  {pickedSet.items.map((it) => (
                    <span key={it.id} className="uam-chip" title={`${it.id} — ${it.description}`}>
                      {it.label}
                    </span>
                  ))}
                </div>
                <span className="text-[12px]" style={{ color: "var(--ink3)" }}>
                  A set is a live reference — if these change later, this person changes with them.
                </span>
              </div>
            )}
            {fn && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {/* The functionality's OWN permissions, named by the server.
                    Each chip is one permission, not a verb waiting for a noun —
                    "Record answers", "Reassign audit". The chips ARE the
                    manifest, so a functionality offers exactly what it defines.
                    Multi-select: pick any number, each becomes its own row. */}
                {fn.actions.map((a) => (
                  <button
                    key={a.key}
                    onClick={() =>
                      setActions((prev) =>
                        prev.includes(a.key) ? prev.filter((k) => k !== a.key) : [...prev, a.key],
                      )
                    }
                    className={`uam-chip ${actions.includes(a.key) ? "uam-chip-on" : ""}`}
                    title={a.description}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
            {/* The description beside the verb, the way AWS and GCP both do it.
                "Verify" and "Close" mean nothing on their own, and a tooltip is
                no use on a touch screen. The identifier underneath is what this
                privilege will actually be called in a log line or a ticket. */}
            {fn && actions.length > 0 && (
              <div className="mt-2 flex flex-col gap-2">
                {actions.map((a) => (
                  <div key={a} className="flex flex-col gap-0.5">
                    <span className="text-[13px]" style={{ color: "var(--ink2)" }}>
                      {actionMeaning(fn.key, a)}
                    </span>
                    <span className="text-[11.5px]" style={{ color: "var(--ink3)", fontFamily: "var(--mono)" }}>
                      {permissionId(fn.module, fn.key, a)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Field>

          <Field label="Where" hint="Leave as everywhere unless this is about one place.">
            <UamSelect
              value={nodeId}
              onChange={setNodeId}
              placeholder="Everywhere they work"
              searchPlaceholder="Search places…"
              emptyText="No place by that name."
              options={[
                { value: "", label: "Everywhere they work" },
                ...placeSelectOptions(nodes.data ?? []),
              ]}
            />
          </Field>

          {/* A set carries its OWN direction — one effect for the whole bundle,
              because a set mixing both reads as a rule nobody can predict. So
              the choice is stated rather than offered when a set is picked. */}
          <Field label="Enable or disable">
            {pickedSet ? (
              <span className="text-[13.5px]" style={{ color: "var(--ink2)" }}>
                {pickedSet.effect === "GRANT"
                  ? `“${pickedSet.name}” gives these permissions.`
                  : `“${pickedSet.name}” takes these permissions away.`}
              </span>
            ) : (
            <div className="flex gap-1.5">
              {(["GRANT", "DENY"] as const).map((e) => (
                <button
                  key={e}
                  onClick={() => setEffect(e)}
                  className={`uam-chip ${effect === e ? "uam-chip-on" : ""}`}
                  style={effect === e ? {
                    background: e === "GRANT" ? "var(--allow-soft)" : "var(--block-soft)",
                    borderColor: e === "GRANT" ? "var(--allow)" : "var(--block)",
                    color: e === "GRANT" ? "var(--allow)" : "var(--block)",
                  } : undefined}
                >
                  {e === "GRANT" ? "Enable" : "Disable"}
                </button>
              ))}
            </div>
            )}
          </Field>

          <Field label="Why" hint="One sentence. People reading the access check will see it.">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Covering the Baner warden until 30 Sep"
              className="uam-input uam-input-fill h-10"
            />
          </Field>

          {/*
            * The APPROVAL — usually the email that authorised this.
            *
            * "Why" is what the granter typed; this is the evidence behind it,
            * which is what an auditor actually asks for. Optional on purpose:
            * most privileges are routine cover, and demanding a file would only
            * teach people to attach a screenshot of nothing to get past the
            * form.
            */}
          <Field label="Approval" hint="Optional. The email or document this was agreed on.">
            {approval ? (
              <div className="flex items-center gap-2 rounded-[var(--r)] px-3 py-2.5" style={{ background: "var(--sunk)", border: "1px solid var(--line)" }}>
                <Paperclip className="h-4 w-4 shrink-0" style={{ color: "var(--ink3)" }} />
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{approval.filename}</span>
                <button
                  onClick={() => { setApproval(null); setApprovalError(""); }}
                  className="uam-btn h-7 px-2 text-[12.5px]"
                >
                  Remove
                </button>
              </div>
            ) : (
              <label className="uam-btn flex h-10 cursor-pointer items-center justify-center gap-2 px-4 text-[13.5px]">
                <Paperclip className="h-4 w-4" />
                Attach an approval
                <input
                  type="file"
                  accept=".eml,.msg,.pdf,.png,.jpg,.jpeg,.webp,.txt,message/rfc822,application/pdf,image/*,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setApprovalError("");
                    // 10MB is the server's limit; checked here too so the reader
                    // is told before a 10MB round trip comes back refused.
                    if (file.size > 10 * 1024 * 1024) {
                      setApprovalError("That file is larger than 10MB.");
                      return;
                    }
                    const reader = new FileReader();
                    reader.onerror = () => setApprovalError("That file could not be read.");
                    reader.onload = () => {
                      const dataUrl = String(reader.result ?? "");
                      // A .eml often arrives with no type from the OS; the server
                      // accepts message/rfc822, so name it rather than sending
                      // an empty mime it will refuse.
                      const fixed = dataUrl.startsWith("data:;")
                        ? dataUrl.replace("data:;", "data:message/rfc822;")
                        : dataUrl;
                      setApproval({ dataUrl: fixed, filename: file.name });
                    };
                    reader.readAsDataURL(file);
                  }}
                />
              </label>
            )}
            {approvalError && (
              <span className="text-[12.5px]" style={{ color: "var(--warn)" }}>{approvalError}</span>
            )}
          </Field>

          {/*
            * Presets, not a bare date box.
            *
            * A date field asks the writer to do arithmetic — "cover until the
            * warden is back" becomes a calendar lookup — and the path of least
            * resistance was leaving it empty. The common answers are one click
            * now, and the resolved date is printed so "30 days" is never a
            * guess about which day that actually is.
            */}
          <Field label="Until" hint="A privilege that never ends stops being an exception.">
            <UamSeg<ExpiryChoice>
              value={expiry}
              onChange={(v) => {
                setExpiry(v);
                setExpiresAt(v === "none" || v === "custom" ? "" : inDays(Number(v)));
              }}
              options={[
                { value: "none", label: "No end date" },
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
                { value: "custom", label: "Pick a date" },
              ]}
            />
            {expiry === "custom" && (
              <input
                ref={dateRef}
                type="date"
                // Tomorrow, not today: a date-only expiry of today resolves to
                // this morning, which is already past — the server would refuse
                // it and the writer would not know why.
                min={inDays(1)}
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="uam-input uam-date mt-1 h-10"
              />
            )}
            {expiresAt && (
              <p className="m-0 mt-0.5 text-[12.5px]" style={{ color: "var(--ink3)" }}>
                Ends on {dayWords(expiresAt)} — after that they are back on what their role allows.
              </p>
            )}
            {expiry === "none" && (
              <p className="m-0 mt-0.5 text-[12.5px]" style={{ color: "var(--warn)" }}>
                Nothing will take this away. Someone has to remember.
              </p>
            )}
          </Field>

          {ready && (
            <div className="rounded-[var(--r)] p-3.5" style={{ background: "var(--sunk)", border: "1px solid var(--line)" }}>
              <div className="mb-1.5 text-[12.5px]" style={{ color: "var(--ink3)" }}>This says</div>
              <div className="flex flex-wrap items-center gap-2 text-[14px]">
                <strong className="font-semibold">{subjectName}</strong>
                <UamVerdict allow={(pickedSet?.effect ?? effect) === "GRANT"} />
                {/* The permission's own name — "Record answers" — because the
                    noun now lives inside the label. Appending the functionality
                    to a generic verb is what produced "add food dashboard".
                    A set says its name and how much it carries: the members are
                    listed in full above, so repeating them here is noise. */}
                <span>
                  {pickedSet
                    ? `${pickedSet.name} (${pickedSet.items.length} ${pickedSet.items.length === 1 ? "permission" : "permissions"})`
                    : fn ? actions.map((a) => actionLabel(fn.key, a)).join(", ") : actions.join(", ")}
                </span>
                <span style={{ color: "var(--ink3)" }}>
                  {nodeId ? `at ${(nodes.data ?? []).find((n) => n.id === nodeId)?.name}` : "everywhere they work"}
                </span>
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 px-5 py-3.5" style={{ borderTop: "1px solid var(--line)" }}>
          {/* Why the button is disabled, so it reads as a to-do and not a bug. */}
          <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: "var(--ink3)" }}>
            {!ready && missing.length > 0 ? `Still needs ${joinWords(missing)}.` : ""}
          </span>
          <div className="flex shrink-0 gap-2">
            <button onClick={onClose} className="uam-btn h-9 px-3.5">Cancel</button>
            <button
              disabled={!ready || save.isPending}
              onClick={() => save.mutate()}
              className="uam-btn uam-btn-primary h-9 px-3.5"
            >
              {save.isPending ? "Granting…" : "Grant Privilege"}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

/**
 * A div rather than a label: half these fields hold a GROUP of controls (tabs,
 * action chips, allowed/blocked), and a <label> wrapping several controls binds
 * its text to the first one — so clicking the heading fired a button.
 */
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

/** "a, b and c" — a natural list, so the missing-fields hint reads as a sentence. */
function joinWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

type ExpiryChoice = "none" | "7" | "30" | "90" | "custom";

/** N days from now as the YYYY-MM-DD the date input and the API both expect. */
function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

/** "3 Oct 2026" — the date spelled out, so a preset is never a guess. */
function dayWords(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
