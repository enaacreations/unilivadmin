import * as React from "react";
import { Lock } from "lucide-react";
import { actionLabel, actionMeaning, actionsOf, permissionId, resourceId } from "./words";
import "./uam.css";

/**
 * ONE renderer for "which permissions, on which functionalities".
 *
 * This replaced a four-column CRUD grid, for a reason worth keeping written
 * down: once actions are named PER FUNCTIONALITY, a grid has no columns. Rows
 * no longer share a vocabulary — `AUDIT_EXECUTION` has Start, Record answers,
 * Discard, Submit, Close and Reassign; `PROPERTIES` has Add, Edit and Delete.
 * Laying those over shared columns forces exactly the two things the rename
 * removed: a lowest-common-denominator verb set (so Submit and Close were
 * invisible and unsettable), and a sea of dashes where the grid asserts a cell
 * that cannot exist.
 *
 * A list instead: one row per permission, carrying its own name, its identifier
 * and the one line saying what it allows — the shape GCP and AWS both use, and
 * for the same reason. Nobody infers what "Record answers" permits from a tick
 * in a column headed "Update".
 */

export interface PermissionCellState {
  /**
   * false = the functionality does not define this action.
   *
   * Kept even though the list builds its rows FROM the manifest, because a
   * stored grant can name an action the manifest no longer has. Such a row is
   * shown, struck through, rather than dropped — a grant nobody can see is a
   * grant nobody will remove.
   */
  inManifest: boolean;
  on: boolean;
  /**
   * The state differs from the baseline this list is measured against — an
   * exception written for one person at one place. Marked, never silent.
   */
  exception?: boolean;
  title?: string;
}

export interface PermissionGroup {
  key: string;
  label: string;
  /** action → state. */
  cells: Record<string, PermissionCellState>;
  /** Only a super administrator may change this functionality. */
  locked?: boolean;
}

export interface PermissionSection {
  key: string;
  label: string;
  hint?: string;
  groups: PermissionGroup[];
  /** Right-aligned count, e.g. "9 of 13". */
  count?: React.ReactNode;
}

/** Manifest order, plus any stored action the manifest no longer names, last. */
function actionsToShow(functionality: string, cells: Record<string, PermissionCellState>): string[] {
  const known = actionsOf(functionality);
  const extra = Object.keys(cells).filter((a) => !known.includes(a));
  return [...known, ...extra];
}

export function PermissionList({
  sections, onToggle, readOnly = false,
}: {
  sections: PermissionSection[];
  onToggle?: (functionality: string, action: string, next: boolean) => void;
  readOnly?: boolean;
}) {
  return (
    <>
      {sections.map((sec) => (
        // shrink-0: dropped into a flex column with a max-height (the property
        // panel does exactly that), a section without it is squashed to a thin
        // strip — the rows stay in the DOM and simply stop being visible.
        <div key={sec.key} className="uam-card shrink-0 overflow-hidden">
          <div
            className="flex items-center justify-between gap-3 px-4 py-3"
            style={{ borderBottom: "1px solid var(--line)" }}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] font-medium">{sec.label}</span>
              {sec.hint && (
                <span className="truncate text-[12.5px]" style={{ color: "var(--ink3)" }}>{sec.hint}</span>
              )}
            </span>
            {sec.count != null && (
              <span className="whitespace-nowrap text-[12.5px]" style={{ color: "var(--ink3)" }}>
                {sec.count}
              </span>
            )}
          </div>

          {sec.groups.map((g) => (
            <div key={g.key}>
              {/* The functionality is a heading over its permissions, not a row
                  with ticks of its own — there is no such thing as holding a
                  functionality, only holding actions on one. */}
              <div
                className="flex items-center gap-2 px-4 py-2"
                style={{ borderTop: "1px solid var(--line)", background: "var(--sunk)" }}
              >
                <span className="text-[13px] font-semibold">{g.label}</span>
                {g.locked && (
                  <span
                    title="Only a super administrator can change this"
                    className="inline-flex items-center gap-1 text-[11.5px]"
                    style={{ color: "var(--warn)" }}
                  >
                    <Lock className="h-3 w-3" /> restricted
                  </span>
                )}
                {/* The identifier the label stands for. It is what goes in a
                    ticket or a log line, so it is on the screen rather than
                    only in the database. */}
                <span className="ml-auto truncate text-[11.5px]" style={{ color: "var(--ink3)", fontFamily: "var(--mono)" }}>
                  {resourceId(sec.key, g.key)}
                </span>
              </div>

              <ul className="m-0 list-none p-0">
                {actionsToShow(g.key, g.cells).map((a) => {
                  const cell = g.cells[a];
                  const stale = cell != null && !cell.inManifest;
                  const id = `${sec.key}:${g.key}:${a}`;
                  return (
                    <li
                      key={a}
                      className="flex items-start gap-3 px-4 py-2.5"
                      style={{ borderTop: "1px solid var(--line)" }}
                    >
                      <input
                        id={id}
                        type="checkbox"
                        checked={cell?.on ?? false}
                        readOnly={readOnly}
                        disabled={readOnly}
                        onChange={(e) => onToggle?.(g.key, a, e.target.checked)}
                        title={cell?.title}
                        style={{
                          width: 16, height: 16, marginTop: 2, flexShrink: 0,
                          // An exception is the one thing worth colouring
                          // differently: it is the tick somebody wrote by hand,
                          // not the one the role brought.
                          accentColor: cell?.exception ? "var(--warn)" : "var(--accent)",
                          cursor: readOnly ? "default" : "pointer",
                          opacity: readOnly && !cell?.on ? 0.45 : 1,
                        }}
                      />
                      {/* A <label> is deliberately NOT wrapped around the whole
                          row: the row carries its own <span>s, and a label that
                          contains them forwards a click on the descriptive text
                          to the checkbox — which is how reading a permission
                          came to toggle it. */}
                      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-0.5" style={{ cursor: readOnly ? "default" : "pointer" }}>
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span
                            className="text-[14px]"
                            style={stale ? { textDecoration: "line-through", color: "var(--ink3)" } : undefined}
                          >
                            {actionLabel(g.key, a)}
                          </span>
                          <span className="text-[11.5px]" style={{ color: "var(--ink3)", fontFamily: "var(--mono)" }}>
                            {permissionId(sec.key, g.key, a)}
                          </span>
                          {cell?.exception && (
                            <span className="text-[11.5px] font-medium" style={{ color: "var(--warn)" }}>
                              exception
                            </span>
                          )}
                          {stale && (
                            <span className="text-[11.5px]" style={{ color: "var(--warn)" }}>
                              no longer defined — granted, but nothing enforces it
                            </span>
                          )}
                        </span>
                        {/* The one line saying what it allows, on the screen
                            rather than behind a hover: a tooltip is invisible on
                            a touch screen and unscannable on any screen, and
                            this is the sentence somebody is agreeing to. */}
                        <span className="text-[12.5px]" style={{ color: "var(--ink3)" }}>
                          {actionMeaning(g.key, a)}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
