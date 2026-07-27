# UNILIV Admin UI — how to build with this design system

A shadcn/ui + Radix component library styled with **Tailwind v4** and CSS-variable design tokens.
Brand look: **"Sunset coral"** — warm espresso ink on soft warm-neutral surfaces, coral for actions,
flat hairline borders (not shadows). Components are imported from `window.UnilivUI.*` and styled with
Tailwind utility classes that resolve to the tokens below.

## Setup & wrapping

- **No global theme provider.** Tokens are plain CSS variables on `:root` (shipped in `styles.css`), so
  components are styled the moment that stylesheet is present — just render them. Dark mode is the same
  tokens under a `.dark` ancestor.
- **Per-component context** (only these need a wrapper):
  - `Tooltip` must be inside `TooltipProvider`.
  - `Form` is `react-hook-form`'s `FormProvider` — drive it from `useForm()` and compose `FormField`/`FormItem`/`FormControl`.
  - `Sidebar` must be inside `SidebarProvider`.
  - Radix overlays (`Dialog`, `Sheet`, `Drawer`, `Popover`, `DropdownMenu`, `Select`, …) carry their own
    context — just compose the root with its parts (`Dialog` → `DialogTrigger` + `DialogContent` + `DialogHeader`/`DialogFooter`).

## The styling idiom — Tailwind utilities bound to tokens

Style with utility classes, not inline styles. Class → token families (all defined in the shipped CSS):

| Utility family | Use |
|---|---|
| `bg-background` `text-foreground` | page surface (warm off-white) + ink |
| `bg-card` `text-card-foreground`, `border` | cards/panels — flat, hairline `border`, `rounded-xl` |
| **`bg-accent` `text-accent-foreground`** | **primary ACTION = brand coral** (this is the main CTA color) |
| `bg-primary` `text-primary-foreground` | dark espresso neutral (NOT the brand color — see note) |
| `bg-secondary` `text-secondary-foreground` `border-secondary-border` | secondary buttons/surfaces |
| `bg-muted` `text-muted-foreground` | subtle fills + secondary text |
| `bg-destructive` / `text-destructive` | danger/delete |
| `text-success` `text-warning` `text-info` (+ `bg-*-soft`) | semantic text + tinted status-pill backgrounds |
| `text-pop` | violet accent (the gradient's far pole — use sparingly) |
| `rounded-sm|md|lg|xl` | radii (base `--radius` = 10px) |
| `font-sans` `font-display` `font-mono` | DM Sans / Hanken Grotesk / JetBrains Mono |
| `ring-ring` `border-input` | focus ring + input borders |

**Critical:** `primary` is the dark neutral ink; the **brand/action color is `accent` (coral)**. Primary buttons,
active nav, and links use `accent`. Don't reach for `bg-primary` expecting the brand color.

## Where the truth lives

- **Tokens & utilities**: the shipped `styles.css` (imports `_ds_bundle.css`) — grep it for the exact
  `--color-*`/`--radius`/`--font-*` values and available utilities before inventing a class.
- **Per-component API & usage**: each component's `<Name>.d.ts` (props) and `<Name>.prompt.md` (usage), plus
  the preview card showing a real composition. Compound parts (`CardHeader`, `SelectItem`, `TableRow`, …) are
  importable from the bundle even though they aren't separate cards.

## One idiomatic example

```tsx
const { Card, CardHeader, CardTitle, CardDescription, CardContent, Button, Badge } = window.UnilivUI;

<Card className="w-80">
  <CardHeader>
    <div className="flex items-center justify-between">
      <CardTitle>Maintenance request</CardTitle>
      <Badge variant="secondary">Open</Badge>
    </div>
    <CardDescription>Room 214 · Leaking tap</CardDescription>
  </CardHeader>
  <CardContent className="flex gap-2">
    <Button>Resolve</Button>
    <Button variant="outline">Reassign</Button>
  </CardContent>
</Card>
```

Layout glue is the DS's own Tailwind (`flex`, `gap-2`, `w-80`, `text-muted-foreground`); the control is the
real library component. Primary action = default `Button` (coral); secondary = `variant="outline"`/`"secondary"`.
