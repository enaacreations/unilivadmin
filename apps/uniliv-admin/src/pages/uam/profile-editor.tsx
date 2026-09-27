import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { uamApi, type UamUserDetail } from "@/lib/access-api";
import { UamSelect } from "./select";
import "./uam.css";

/**
 * A person's details — a SIDE SHEET, per the module's rule: a sheet to edit one
 * thing, a modal when the change is wide or cannot be undone. Correcting a
 * phone number is neither.
 *
 * Only IDENTITY is editable here. What they can do (roles, privileges), where
 * they work, and whether they can sign in all have their own surfaces, each
 * with its own guard and its own reason prompt — folding them into one form
 * would mean a typo in a job title and a revoked role travelling as the same
 * change.
 */
export function ProfileEditSheet({ user, onClose }: { user: UamUserDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [form, setForm] = React.useState({
    name: user.name,
    email: user.email,
    phone: user.phone ?? "",
    designation: user.designation ?? "",
    // The API sends an ISO timestamp; the date input wants YYYY-MM-DD.
    dob: user.dob ? String(user.dob).slice(0, 10) : "",
    gender: user.gender ?? "",
    userType: user.userType ?? "INTERNAL",
  });

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: () =>
      uamApi.updateUser(user.id, {
        name: form.name.trim(),
        email: form.email.trim(),
        // Empty means "cleared", which is not the same as "unchanged" — the
        // server stores null rather than an empty string.
        phone: form.phone.trim() || null,
        designation: form.designation.trim() || null,
        dob: form.dob || null,
        gender: form.gender || null,
        userType: form.userType,
        reason: "Details edited from the user's page",
      }),
    onSuccess: () => {
      toast({ variant: "success", title: "Details saved" });
      void qc.invalidateQueries({ queryKey: ["uam"] });
      void qc.invalidateQueries({ queryKey: ["access"] });
      onClose();
    },
    onError: (e) => toast({ title: "Refused", description: (e as Error).message, variant: "destructive" }),
  });

  const emailOk = /.+@.+\..+/.test(form.email.trim());
  const ready = form.name.trim().length > 1 && emailOk;

  return (
    <div className="uam fixed inset-0 z-50 flex justify-end" style={{ background: "var(--scrim)" }} onClick={onClose}>
      <aside
        className="uam-sheet uam-sheet-enter flex h-full w-full max-w-[480px] flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="flex flex-col gap-1">
            <span className="uam-kicker">Edit details</span>
            <span className="uam-title" style={{ fontSize: 18 }}>Who they are</span>
          </div>
          <button onClick={onClose} className="uam-btn h-8 w-8 justify-center border-transparent p-0" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          <Field label="Full name">
            <input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="uam-input uam-input-fill h-10"
            />
          </Field>

          <Field label="Email" hint="They sign in with this.">
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="uam-input uam-input-fill h-10"
            />
            {form.email.trim() && !emailOk && (
              <p className="m-0 mt-1 text-[12.5px]" style={{ color: "var(--block)" }}>
                That is not an email address.
              </p>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone">
              <input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="uam-input uam-input-fill h-10"
              />
            </Field>
            <Field label="Job title">
              <input
                value={form.designation}
                onChange={(e) => setForm({ ...form, designation: e.target.value })}
                className="uam-input uam-input-fill h-10"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date of birth">
              <input
                type="date"
                max={new Date().toISOString().slice(0, 10)}
                value={form.dob}
                onChange={(e) => setForm({ ...form, dob: e.target.value })}
                className="uam-input uam-date h-10"
                style={{ width: "100%" }}
              />
            </Field>
            <Field label="Gender">
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
            </Field>
          </div>

          <Field label="Staff or resident">
            <div className="flex gap-1.5">
              {(["INTERNAL", "EXTERNAL"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setForm({ ...form, userType: t })}
                  className={`uam-chip ${form.userType === t ? "uam-chip-on" : ""}`}
                >
                  {t === "INTERNAL" ? "Staff" : "Resident"}
                </button>
              ))}
            </div>
          </Field>

          <p className="m-0 text-[13px]" style={{ color: "var(--ink3)" }}>
            Roles, privileges and whether they can sign in are changed on their own tabs — each
            asks for its own reason.
          </p>
        </div>

        <footer className="flex justify-end gap-2 px-5 py-3.5" style={{ borderTop: "1px solid var(--line)" }}>
          <button onClick={onClose} className="uam-btn h-9 px-3.5">Cancel</button>
          <button
            disabled={!ready || save.isPending}
            onClick={() => save.mutate()}
            className="uam-btn uam-btn-primary h-9 px-3.5"
          >
            {save.isPending ? "Saving…" : "Save details"}
          </button>
        </footer>
      </aside>
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
