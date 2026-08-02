# Service Set redesign — what changed

Implements `Menu Prototype.dc.html` from the Claude Design project
*"Menu rotation and rule redesign"*. Four tabs of **Service Set** (Food → Service Set, route `/food/settings`) were
rebuilt. Nothing else on the page was touched.

The tab was renamed from **Settings** to **Service Set**, and the page-level
title and subtitle were dropped — each tab already opens with its own heading, so
the header only pushed the tab strip down and repeated the sidebar.

---

## The short version

| Tab | Before | After |
| --- | --- | --- |
| **Dishes** | Table of 8 columns; edit opened a modal | Card grid; edit opens a right-hand drawer that now also holds **portions** |
| **Ingredients** | Table: name / unit / status | Dense row grid that also shows **how many dishes use it** |
| **Menu Rotation** | Filtered table, **one dish per row** (~3,500 rows) | **Week board**: 4 meals × 7 days, one cell per plate, click to open a **plate composer** |
| **Menu Rules** | Stack of Component / Prep / Min / Max dropdown rows | **"A Uniliv Lunch is 1 Dal, 1–2 Sabzi…"** — the rule as a sentence with counts editable in place |
| **Portion Size Rules** | 5th primary tab | Moved into the Dishes drawer; the standalone tab now lives under **More** |

---

## 1. Menu Rotation — the biggest change

**Before:** to answer *"is next week finished?"* you filtered the table by
week, then read rows. Each row was one dish. A four-dish lunch was four rows.

**After:** a board. Rows are meals, columns are days, and each of the 28 cells is
one plate showing its dishes and a status line:

- `Complete` — the plate satisfies its meal's rule
- `Missing Bread` — a required course is unfilled
- `Shares Tomato` — two dishes on the plate use the same raw material

Above the board: a progress bar (*"5 of 28 meals complete"*), a warning pill, and
week tabs W1–W4.

### New actions

| Action | What it does |
| --- | --- |
| **Copy / paste a day** | Copy icon on a day header, then paste onto another day — moves all 4 meals |
| **Auto-fill N gaps** | Fills every empty or incomplete meal in the visible week |
| **Copy W1 → W2** | Duplicates the whole visible week onto the next |
| **Fill every empty meal** | (on Menu Rules) fills every gap across all 4 weeks |

Auto-fill varies its picks per day, so a filled week gets seven different menus
rather than the same plate seven times.

### The plate composer

Clicking a cell opens a drawer with **one card per course the rule requires**.
Each card shows what it still needs, what's on it, and the dishes that could fill
it. A dish that would clash is shown **greyed with the reason** (*"shares Aloo"*)
rather than hidden — so "why can't I pick this?" answers itself.

Also in the composer: side dishes are togglable per meal, dishes that no slot
asked for are listed as **"Off-rule extras"**, and Save is blocked while any
ingredient clash remains.

### One deviation from the prototype

The prototype had no kitchen dimension. The real table is keyed by
`(kitchen, brand, week, day, meal)` and the write endpoint requires a kitchen, so
the board carries a **kitchen picker** next to the brand toggle.

---

## 2. Menu Rules

The old form asked you to fill in a table. The new one states the rule as the
sentence it already was:

> **A Uniliv Lunch is** `Sabzi 1–2` `Dal 1` `Rice 1` `Bread 1` `Salad / Raita 1` `Dessert 0–1`

with `−` / `+` / `×` on each course and an **add course** row.

Three things sit underneath:

- **Impact line** — *"5 dishes minimum per plate · 196 slots to fill across 4 rotation weeks"*
- **Variety & safety rules** — states what the engine actually enforces
- **Dishes that qualify today** — a bar per course showing how many dishes could
  fill it, flagging any course with fewer than 3 (it will repeat heavily)

**Edits are explicit.** Changing a count shows *"Unsaved changes"* with
**Discard** / **Save rule**. A composition rule silently changing under a
half-built rotation is not a surprise worth having.

**Preserved:** `slotLabel`, `preparation` and the rule's name are carried through
on save — the sentence editor only moves counts and courses, so rules created in
the old form don't lose their other fields.

---

## 3. Dishes

Cards instead of table rows. Each card shows the dish, its course and unit, its
ingredients, its portions, its side-dish count, and **whether the rotation
actually uses it** (`In 37 plates` / `Not in the rotation` — the latter in
warning colour, surfacing dead catalogue entries that were previously invisible).

### The drawer

- Course / Served as / Preparation / Brands are now **chip groups**, not dropdowns
- Ingredients are one **searchable multi-select** (was: a stack of Select + Qty +
  Unit rows). Typing a new name offers **Create "…"** inline.
- A live warning: *"Using Aloo means this dish can never share a plate with Aloo
  Methi or Aloo Paratha."*
- **Portion per resident** — a meal × brand grid, with **Copy Uniliv → Huddle**

### Portions moved here

This is the one structural change to the tab layout. Previously **Portion Size
Rules** was a 5th primary tab, kept there because *a dish without a portion rule
is a dish the kitchen is never told to cook*. That reason is gone now that
portions are edited on the dish itself, so the standalone tab was demoted to
**More → Portion Size Rules**, where it remains useful for reviewing and
bulk-fixing portions across many dishes.

Saving a dish **diffs** the grid against the existing `per_resident_rules`:
filling a blank creates a rule, changing a number updates it, clearing a cell
deletes it. Ingredient quantities and side-dish options are carried through
untouched.

---

## 4. Ingredients

Same data, denser layout, plus a usage count per row (`in 13 dishes` /
`unused`) so it's obvious which are safe to delete. Delete now warns you how many
dishes will lose the ingredient. Editor moved from a modal to a drawer.

---

## 5. The one backend change

`GET /food/dishes` now returns each dish's **`ingredients`** array, joined in one
batched query alongside the `sideDishIds` it already returned.

**Why:** the plate composer greys out every candidate dish that would clash, live
as you type. That needs the whole catalogue's ingredients on the client — a
per-dish fetch (~57 requests) or a server round-trip per keystroke can't do it.

**Risk:** low. Purely additive — same shape the detail endpoint already returns,
no existing field changed, one extra query per list call.

---

## Where the code lives

```
apps/uniliv-admin/src/components/food/
  menu-lib.ts            plate/slot logic, clash detection, auto-fill (pure, testable)
  use-food-masters.ts    shared master-data queries
  rotation-board.tsx     the week board
  plate-composer.tsx     the per-meal drawer
  menu-rules.tsx         the sentence editor + "fill every empty meal"
  dishes-catalogue.tsx   the card grid
  dish-drawer.tsx        the dish editor incl. portions
  ingredients-grid.tsx   the ingredient rows + editor
```

`food-settings.tsx` lost ~1,000 lines (the four old tab bodies) and now just
mounts these. The other eight tabs are unchanged.

### A note on validation

The board and composer score plates **on the client** so 28 cells can render a
verdict at once and candidates can re-rank per keystroke. The server remains the
authority: `PUT /food/menu-rotation/slot` runs the same composition and
shared-ingredient checks and rejects a bad plate regardless of what the UI showed.

---

## What you should look at

**The shared-ingredient rule is stricter than the data.** The board flags **23 of
28 meals** in the seeded Bengaluru/Huddle week — because onion, tomato and garam
masala appear in nearly every Indian dish, and the rule is *"no two dishes may
share **any** ingredient"*. That rule is pre-existing and enforced by the backend
on save; the redesign only made it visible.

Worth deciding whether the constraint should apply to **hero ingredients only**
(paneer, aloo, rajma) rather than every base and spice. That's a backend change
and out of scope here, but the board makes it hard to ignore.

---

## Verified against the running app

Local Postgres, 57 dishes, 47 ingredients, 3,470 rotation rows, 8 composition rules.

- All four tabs render with live data
- Composer opens with real slots, dishes, ingredients, sides and 6 real clashes
- **Rotation write** — saved a High Tea plate; 3 dishes preserved, row count unchanged
- **Portion sync** — added a Huddle Breakfast portion (created a rule), then
  cleared it (deleted the rule); back to 145 rules, ingredient quantities and
  side options intact
- `pnpm run typecheck` clean; no console errors

Screenshots could not be captured in this environment (the capture tool timed
out; the page itself stayed responsive), so verification was done through the DOM
and the database.
