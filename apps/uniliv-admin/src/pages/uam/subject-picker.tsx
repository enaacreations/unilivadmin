import * as React from "react";
import { UamSelect, type UamOption } from "./select";
import { UamAvatar, UamRoleMark } from "./shell";
import "./uam.css";

/**
 * Who a privilege is for — one searchable list, not a mode switch.
 *
 * It used to be two tabs (One person / Everyone in a role) above a plain
 * `<select>`. That made the reader answer a question they do not think in:
 * nobody opens this wanting "a role", they open it wanting *Suresh* or
 * *Warden*, and which of the two it is decides the answer rather than being
 * asked first. So the subject TYPE is now inferred from what was picked, and
 * one search runs across both lists.
 *
 * Everything below is a thin shaping layer over UamSelect — the popover
 * behaviour lives there, once, with every other picker in the module.
 */

export interface SubjectOption {
  type: "USER" | "ROLE";
  id: string;
}

/** How many of each kind the popover shows before anything is typed. */
const TOP_N = 3;

/** One string so the shared select can hold both kinds in one value. */
const encode = (s: SubjectOption) => `${s.type}:${s.id}`;
const decode = (v: string): SubjectOption => {
  const i = v.indexOf(":");
  return { type: v.slice(0, i) as "USER" | "ROLE", id: v.slice(i + 1) };
};

export function SubjectPicker({
  users, roles, value, onChange, disabled,
}: {
  users: Array<{ id: string; name: string; email: string }>;
  roles: Array<{ key: string; label: string; holders: number; isSystem: boolean; isActive: boolean }>;
  value: SubjectOption | null;
  onChange: (next: SubjectOption) => void;
  disabled?: boolean;
}) {
  const options: UamOption[] = React.useMemo(() => [
    // Roles lead, most-held first: those are what an operator reaches for, and
    // picking one is the consequential choice — it reaches everyone holding it.
    ...[...roles]
      .filter((r) => !r.isSystem)
      .sort((a, b) => b.holders - a.holders)
      .map((r) => ({
        value: encode({ type: "ROLE", id: r.key }),
        label: r.label,
        group: "Roles",
        kind: "role",
        icon: <UamRoleMark size={22} />,
        // A disabled role says so here rather than after the privilege is
        // written against it and quietly reaches nobody.
        hint: r.isActive === false
          ? "disabled"
          : r.holders === 1 ? "1 person" : `${r.holders} people`,
        muted: r.isActive === false,
      })),
    ...users.map((u) => ({
      value: encode({ type: "USER", id: u.id }),
      label: u.name,
      group: "Users",
      kind: "person",
      icon: <UamAvatar name={u.name} size={22} />,
      hint: u.email,
    })),
  ], [users, roles]);

  return (
    <UamSelect
      value={value ? encode(value) : ""}
      onChange={(v) => onChange(decode(v))}
      options={options}
      placeholder="Search users and roles…"
      emptyText="Nobody and no role by that name."
      topN={TOP_N}
      disabled={disabled}
    />
  );
}
