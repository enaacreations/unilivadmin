/**
 * The module's vocabulary.
 *
 * Operators are wardens and city heads, not engineers. Every helper here
 * resolves through the ACTION MANIFEST (`FUNCTIONALITY_ACTIONS` in
 * src/lib/permissions.ts), so an action's name, label and one-line meaning come
 * from one place and read the same wherever they appear — a column heading, a
 * chip, a tooltip, the sentence asking somebody to grant it.
 *
 * This replaced a set of GLOBAL verb tables. Thirteen verbs shared by fifty-six
 * functionalities could only ever say "create" and leave the reader to guess
 * what gets created — and produced cells that mean nothing at all, like
 * "delete dashboard". An action now belongs to the thing it acts on:
 * `operations.properties.delete_property`, "Remove a property for good".
 */
import { actionDef, namedActionsFor, type Functionality } from "@/lib/permissions";

/**
 * The action's label — "Add property", "Start audit".
 *
 * Falls back to the raw key rather than throwing: this is leaf display code
 * reached from half the module's rows, and a stale stored action (one the
 * manifest no longer names) must render as itself, not take the screen down.
 */
export function actionLabel(functionality: string, action: string): string {
  return actionDef(functionality as Functionality, action)?.label ?? humanise(action);
}

/** What the action MEANS, in one line — the sentence shown wherever access is granted or shown. */
export function actionMeaning(functionality: string, action: string): string {
  return actionDef(functionality as Functionality, action)?.description ?? humanise(action);
}

/** Last resort for a key the manifest does not name: `close_complaint` → `Close complaint`. */
function humanise(action: string): string {
  const words = action.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every action a functionality defines, in manifest order. */
export function actionsOf(functionality: string): string[] {
  return namedActionsFor(functionality as Functionality).map((d) => d.key);
}

/**
 * The permission as a stable identifier: `module.functionality.action`.
 *
 * GCP's shape (`compute.instances.start`) rather than a prose sentence,
 * because an identifier is the thing you paste into a ticket, grep the logs
 * for, or read back to somebody on a call. The action segment is the NAMED key,
 * so the id and the label describe the same thing — a stored legacy verb is
 * resolved through the manifest rather than printed as `properties.create`,
 * which is an id that no longer exists.
 */
export function permissionId(moduleKey: string, functionality: string, action: string): string {
  const key = actionDef(functionality as Functionality, action)?.key ?? action;
  return `${resourceId(moduleKey, functionality)}.${key.toLowerCase()}`;
}

/** The permission id minus the action — `module.functionality`. */
export function resourceId(moduleKey: string, functionality: string): string {
  return `${moduleKey.toLowerCase()}.${functionality.toLowerCase()}`;
}

/**
 * A set of actions on ONE functionality, as a sentence fragment.
 *
 * The noun now lives inside each label, so this no longer reads as a list of
 * verbs waiting for a noun to be appended — "See, create and edit" + "rooms"
 * became "View room, add room and edit room". Repetitive read aloud, but every
 * item names exactly one permission, which is what the reader is being asked to
 * check.
 */
export function actionList(functionality: string, actions: string[]): string {
  const words = actions
    .filter((a) => typeof a === "string" && a)
    .map((a, i) => {
      const label = actionLabel(functionality, a);
      return i === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
    });
  if (!words.length) return "nothing";
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** One sentence describing a person's reach, in words rather than counts. */
export function reachSentence(propertyCount: number | null, unrestricted: boolean): string {
  if (unrestricted) return "Works across every property";
  if (!propertyCount) return "Not placed anywhere yet";
  return propertyCount === 1 ? "Works at 1 property" : `Works at ${propertyCount} properties`;
}

/** A validity window, said the way a person would say it. */
export function untilWords(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const days = Math.ceil((d.getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return "expired";
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `until ${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
}

/**
 * The places a privilege may be written at.
 *
 * Every picker in this module draws from here, so they agree. Rooms are left
 * out on purpose: there are fifty of them, they are labelled with bare numbers
 * ("101", "2010") that mean nothing outside their own property, and access is
 * never granted per room — the smallest unit anyone works at is a property or
 * a kitchen. Everything above property stays, because a city-wide privilege is
 * a real thing and the resolver already inherits it downward.
 */
export function placeOptions<T extends { isActive: boolean; nodeType: string }>(nodes: T[]): T[] {
  return nodes.filter((n) => n.isActive && n.nodeType !== "ROOM");
}

/** Node-type → heading, in the order an operator reaches for them. */
const PLACE_GROUPS: Array<[string, string]> = [
  ["PROPERTY", "Properties"],
  ["KITCHEN", "Kitchens"],
  ["CLUSTER", "Clusters"],
  ["CITY", "Cities"],
  ["ZONE", "Zones"],
  ["ORG", "Organisation"],
];

/**
 * Places as grouped select options.
 *
 * Flat, the list was thirty names with no clue that "Bengaluru" is a city and
 * "UNILIV Baner" is a building — and picking the wrong rung of the tree is the
 * mistake this module most needs to prevent. Properties lead because they are
 * what nearly every privilege is about.
 */
export function placeSelectOptions<T extends { id: string; name: string; isActive: boolean; nodeType: string }>(
  nodes: T[],
): Array<{ value: string; label: string; group: string }> {
  const live = placeOptions(nodes);
  return PLACE_GROUPS.flatMap(([type, group]) =>
    live.filter((n) => n.nodeType === type).map((n) => ({ value: n.id, label: n.name, group })),
  );
}
