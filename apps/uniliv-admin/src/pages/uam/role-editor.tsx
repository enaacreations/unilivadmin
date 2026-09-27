import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { accessApi, accessKeys, ANCHOR_WORD, type AccessRole, type AnchorLevel, type RoleDetail } from "@/lib/access-api";
import { UamSelect, type UamOption } from "./select";
import "./uam.css";

/**
 * Creating and renaming a role.
 *
 * Two surfaces, split by the module's own rule: a MODAL to create one (a new
 * role is a new thing in the system, it cannot be deleted afterwards, and the
 * choice of what to copy from decides a lot), a SHEET to edit the name and
 * details of one that already exists.
 *
 * ── No seniority field ────────────────────────────────────────────────────
 * There used to be a "Who may hand it out" tier here, writing roles.rank. It
 * asked the operator to answer a question the code had already answered: who
 * may assign a role is decided by ROLE_RANK in lib/authz.ts, and every
 * assignment path reads that constant, not the column. Two rank systems for one
 * question is one more than the product needs, so the field is gone and the
 * code-owned constant is the only answer.
 */

/** SCREAMING_SNAKE from whatever was typed — the key format the server demands. */
export function keyFromLabel(label: string): string {
  return label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^[^A-Z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 40);
}

/**
 * The rungs a role may be handed out on, widest first.
 *
 * Rooms and beds are absent because nobody is given access "to room 101", and
 * there is no company-wide entry because a role that spans the company needs no
 * place at all — that is what the empty option means.
 */
const ANCHOR_OPTIONS: UamOption[] = [
  { value: "", label: "No place of its own" },
  { value: "ZONE", label: "A zone" },
  { value: "CITY", label: "A city" },
  { value: "CLUSTER", label: "A cluster" },
  { value: "KITCHEN", label: "A kitchen" },
  { value: "PROPERTY", label: "One or more properties" },
];

/** Roles an operator can meaningfully copy from. */
function copyChoices(roles: AccessRole[]): AccessRole[] {
  return [...roles]
    .filter((r) => !r.scopeModule)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function CreateRoleModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, force] = React.useState(0);

  const [label, setLabel] = React.useState("");
  const [key, setKey] = React.useState("");
  const [keyTouched, setKeyTouched] = React.useState(false);
  const [cloneFrom, setCloneFrom] = React.useState("");
  const [anchorLevel, setAnchorLevel] = React.useState<AnchorLevel | null>(null);
  const [reason, setReason] = React.useState("");

  const roles = useQuery({ queryKey: accessKeys.roles(), queryFn: accessApi.roles });
  const choices = copyChoices(roles.data ?? []);
  const effectiveKey = keyTouched ? key : keyFromLabel(label);

  const clash = (roles.data ?? []).some((r) => r.key === effectiveKey);
  const keyOk = /^[A-Z][A-Z0-9_.]*$/.test(effectiveKey);

  const create = useMutation({
    mutationFn: () =>
      accessApi.createRole({
        key: effectiveKey,
        label: label.trim(),
        cloneFrom: cloneFrom || undefined,
        anchorLevel,
        reason: reason.trim(),
      }),
    onSuccess: (d) => {
      toast({
        variant: "success",
        title: "Role created",
        description: d.clonedCells
          ? `${d.clonedCells} functionalit${d.clonedCells === 1 ? "y" : "ies"} copied across. Nobody holds it yet.`
          : "It allows nothing yet — set what it allows next.",
      });
      void qc.invalidateQueries({ queryKey: ["access"] });
      onClose();
    },
    onError: (e) => toast({ title: "Could not create it", description: (e as Error).message, variant: "destructive" }),
  });

  const ready = label.trim().length > 1 && keyOk && !clash && reason.trim().length >= 4;
  const source = (roles.data ?? []).find((r) => r.key === cloneFrom);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="uam max-h-[88vh] max-w-[560px] overflow-y-auto p-0"
        style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
      >
        <header className="px-6 pb-4 pt-6">
          <span className="uam-kicker font-medium">Create Role</span>
          <DialogTitle asChild>
            <h2 className="uam-title m-0 mt-1" style={{ fontSize: 18 }}>What job is this?</h2>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Create a role: its name, what it starts from, and who may hand it out.
          </DialogDescription>
        </header>

        <div className="flex flex-col gap-4 px-6 pb-2">
          <Field label="Name" hint="What people will call it.">
            <input
              autoFocus
              value={label}
              onChange={(e) => { setLabel(e.target.value); force((n) => n + 1); }}
              placeholder="Night Warden"
              className="uam-input uam-input-fill h-10"
            />
          </Field>

          <Field label="Code" hint="Fixed once created — grants and privileges point at it.">
            <input
              value={effectiveKey}
              onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toUpperCase()); }}
              placeholder="NIGHT_WARDEN"
              className="uam-input uam-input-fill h-10"
              style={{ fontFamily: "var(--mono)", fontSize: 13.5 }}
            />
            {effectiveKey && !keyOk && (
              <p className="m-0 mt-1.5 text-[12.5px]" style={{ color: "var(--block)" }}>
                Letters, numbers and underscores only, starting with a letter.
              </p>
            )}
            {clash && (
              <p className="m-0 mt-1.5 text-[12.5px]" style={{ color: "var(--block)" }}>
                A role with this code already exists.
              </p>
            )}
          </Field>

          <Field label="Start from" hint="Optional. Copies what that role allows; you can change it after.">
            <UamSelect
              value={cloneFrom}
              onChange={setCloneFrom}
              placeholder="Nothing — start empty"
              searchPlaceholder="Search roles…"
              emptyText="No role by that name."
              options={[
                { value: "", label: "Nothing — start empty" },
                ...choices.filter((r) => !r.computed).map((r) => ({
                  value: r.key,
                  label: r.label,
                  hint: r.cells !== null ? `${r.cells} functionalities` : undefined,
                })),
              ]}
            />
            {source && (
              <p className="m-0 mt-1.5 text-[12.5px]" style={{ color: "var(--ink3)" }}>
                Only what {source.label} allows is copied — not the people holding it, and not their places.
              </p>
            )}
          </Field>

          <Field
            label="Handed out at"
            hint="The rung of the org tree, not a place. Which one is asked when the role is given to somebody."
          >
            <UamSelect
              value={anchorLevel ?? ""}
              onChange={(v) => setAnchorLevel((v || null) as AnchorLevel | null)}
              placeholder="No place of its own"
              searchPlaceholder="Search levels…"
              emptyText="No level by that name."
              options={ANCHOR_OPTIONS}
            />
            <p className="m-0 mt-1.5 text-[12.5px]" style={{ color: "var(--ink3)" }}>
              {anchorLevel
                ? `Assigning this role will ask which ${ANCHOR_WORD[anchorLevel]}. Everything beneath it is included, and stays included as the estate grows.`
                : "The role carries no place — the person's own placement decides where it applies."}
            </p>
          </Field>

          <Field label="Why" hint="One sentence. It goes on the activity trail.">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Night shift needs the warden duties without resident billing"
              className="uam-input uam-input-fill h-10"
            />
          </Field>
        </div>

        <footer className="flex justify-end gap-2 px-6 pb-6 pt-3">
          <button onClick={onClose} className="uam-btn h-9 px-3.5">Cancel</button>
          <button
            disabled={!ready || create.isPending}
            onClick={() => create.mutate()}
            className="uam-btn uam-btn-primary h-9 px-4"
          >
            {create.isPending ? "Creating…" : "Create Role"}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

export function EditRoleSheet({ role, onClose }: { role: RoleDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [label, setLabel] = React.useState(role.label);
  const [description, setDescription] = React.useState(role.description ?? "");
  const [anchorLevel, setAnchorLevel] = React.useState<AnchorLevel | null>(role.anchorLevel ?? null);
  const [reason, setReason] = React.useState("");

  const roles = useQuery({ queryKey: accessKeys.roles(), queryFn: accessApi.roles });
  const choices = copyChoices(roles.data ?? []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: () =>
      accessApi.updateRole(role.key, {
        label: label.trim(),
        description: description.trim(),
        anchorLevel,
        reason: reason.trim() || "Role details updated",
      }),
    onSuccess: () => {
      toast({ variant: "success", title: "Role updated" });
      void qc.invalidateQueries({ queryKey: ["access"] });
      onClose();
    },
    onError: (e) => toast({ title: "Refused", description: (e as Error).message, variant: "destructive" }),
  });

  const changed = label.trim() !== role.label || description.trim() !== (role.description ?? "") || anchorLevel !== (role.anchorLevel ?? null);
  const ready = label.trim().length > 1 && changed;

  return (
    <div className="uam fixed inset-0 z-50 flex justify-end" style={{ background: "var(--scrim)" }} onClick={onClose}>
      <aside
        className="uam-sheet uam-sheet-enter flex h-full w-full max-w-[480px] flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="flex flex-col gap-1">
            <span className="uam-kicker">Edit Role</span>
            <span className="uam-title" style={{ fontSize: 18 }}>How this role reads</span>
          </div>
          <button onClick={onClose} className="uam-btn h-8 w-8 justify-center border-transparent p-0">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          <Field label="Name">
            <input value={label} onChange={(e) => setLabel(e.target.value)} className="uam-input uam-input-fill h-10" />
          </Field>

          <Field label="Code" hint="Cannot change — everything already points at it.">
            <div
              className="flex h-10 items-center rounded-[var(--r-sm)] px-3 text-[13.5px]"
              style={{ background: "var(--sunk)", border: "1px solid var(--line)", color: "var(--ink3)", fontFamily: "var(--mono)" }}
            >
              {role.key}
            </div>
          </Field>

          <Field label="Description" hint="Optional. Shown under the name on this screen.">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Runs one property overnight."
              className="uam-input uam-input-fill py-2"
              style={{ height: "auto", resize: "vertical" }}
            />
          </Field>

          <Field
            label="Handed out at"
            hint="The rung of the org tree, not a place. Which one is asked when the role is given to somebody."
          >
            <UamSelect
              value={anchorLevel ?? ""}
              onChange={(v) => setAnchorLevel((v || null) as AnchorLevel | null)}
              placeholder="No place of its own"
              searchPlaceholder="Search levels…"
              emptyText="No level by that name."
              options={ANCHOR_OPTIONS}
            />
            <p className="m-0 mt-1.5 text-[12.5px]" style={{ color: "var(--ink3)" }}>
              {anchorLevel
                ? `Assigning this role will ask which ${ANCHOR_WORD[anchorLevel]}. Everything beneath it is included, and stays included as the estate grows.`
                : "The role carries no place — the person's own placement decides where it applies."}
            </p>
          </Field>

          <Field label="Why" hint="Optional for a rename; goes on the activity trail either way.">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Renamed to match the new shift pattern"
              className="uam-input uam-input-fill h-10"
            />
          </Field>
        </div>

        <footer className="flex justify-end gap-2 px-5 py-3.5" style={{ borderTop: "1px solid var(--line)" }}>
          <button onClick={onClose} className="uam-btn h-9 px-3.5">Cancel</button>
          <button
            disabled={!ready || save.isPending}
            onClick={() => save.mutate()}
            className="uam-btn uam-btn-primary h-9 px-3.5"
          >
            {save.isPending ? "Saving…" : "Update Role"}
          </button>
        </footer>
      </aside>
    </div>
  );
}

/**
 * A div rather than a label: these fields hold a GROUP of controls, or a
 * combobox whose trigger is a <button> — and <button> is a labelable element,
 * so a wrapping <label> forwards a click on the heading straight into it.
 * Clicking the words "Handed out at" opened the dropdown.
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
