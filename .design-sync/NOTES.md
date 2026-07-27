# design-sync NOTES — @workspace/uniliv-admin

This repo is an **app**, not a published component library. The design system is the
shadcn/ui component set at `artifacts/uniliv-admin/src/components/ui/*.tsx` (Radix + Tailwind v4,
CSS-variable tokens, brand "Sunset coral"). No `dist/`, no `.d.ts` — synced in **synth-entry mode**.

## Build prerequisites (re-run these on a fresh clone / re-sync)

- **Self-referential workspace symlink** (REQUIRED for synth mode). The converter sets
  `PKG_DIR = <node-modules>/<pkg>`, which doesn't exist for an app package. Create it so PKG_DIR
  resolves to the real package while esbuild still resolves `react` from the pnpm-linked tree:
  ```sh
  mkdir -p artifacts/uniliv-admin/node_modules/@workspace
  ln -sfn ../.. artifacts/uniliv-admin/node_modules/@workspace/uniliv-admin
  ```
  Without it: `ENOENT … node_modules/@workspace/uniliv-admin/package.json`. Gitignored (node_modules),
  so recreate per clone.
- **Compiled Tailwind stylesheet** = `cfg.cssEntry` (`ds-compiled.css`, gitignored, inside the pkg so
  it stays within cssEntry's PKG_DIR bound). All component styling is Tailwind utility classes, so the
  cssEntry must be a *compiled* stylesheet (utilities + `:root` token values), not the raw `src/index.css`.
  Regenerate with the Google-Fonts `@import` prepended (see fonts below):
  ```sh
  cd artifacts/uniliv-admin
  npx -y @tailwindcss/cli@4 -i src/index.css -o ds-compiled.body.css
  { printf '%s\n' '@import url("https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap");'; cat ds-compiled.body.css; } > ds-compiled.css
  rm -f ds-compiled.body.css
  ```
  The Tailwind CLI auto-scans `src/` so the output includes every utility the app (superset of the UI kit) uses.
- Converter deps live in `.ds-sync/` (isolated `npm i esbuild ts-morph @types/react playwright`); chromium via `npx playwright install chromium`.
- Build/validate commands (from repo root):
  ```sh
  node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules artifacts/uniliv-admin/node_modules --out ./ds-bundle
  node .ds-sync/package-validate.mjs ./ds-bundle
  ```
  Note: NO `--entry` (synth mode). `--node-modules` = the pkg's own node_modules (react resolves there).

## Scoping decisions

- Discovery finds all PascalCase exports → **299** (67 primaries + ~232 compound sub-parts like
  `DialogContent`, `SelectTrigger`). Curated to **65 primary cards** via `componentSrcMap` null-exclusions.
  Sub-parts stay importable on `window.UnilivUI` (the bundle `export *`s everything); they're just not
  standalone cards. Show them via composition inside each primary's authored preview.
- **`Toaster` excluded** (`componentSrcMap.Toaster = null`): both `sonner.tsx` and `toaster.tsx` export
  `Toaster`, so esbuild's `export *` made it ambiguous → dropped from the global (`[BUNDLE_EXPORT]`).
  The raw toast primitives (`Toast`, `ToastProvider`, … from `toast.tsx`) remain unambiguous in the bundle.
- `chart.tsx` primary = `ChartContainer` (no `Chart` export); `resizable.tsx` primary = `ResizablePanelGroup`.

## Fonts

- App loads DM Sans / Hanken Grotesk / JetBrains Mono from **Google Fonts CDN** (`<link>` in index.html);
  no local woff2 anywhere. Resolved by prepending the same Google-Fonts `@import` to `ds-compiled.css`
  → `[FONT_REMOTE]` (fonts load at runtime, matching the app exactly). See regen command above.

## Known render warns (triaged legitimate)

- `[TOKENS_MISSING]`: `--radix-navigation-menu-viewport-height/width` (Radix runtime vars), `--tw*`
  (Tailwind internal), `--spacing-4`, `--sidebar-accent` — all runtime/injected; components render styled. Non-blocking.
- `[FONT_REMOTE]` for the three brand families — expected (see Fonts).

## Preview authoring learnings (from solo calibration: Button, Card, Dialog)

- **Import pattern**: `import { X, XSubPart } from '@workspace/uniliv-admin'`. Bare pkg imports
  re-export the whole `window.UnilivUI` (all 299 exports incl. excluded sub-parts like `CardHeader`,
  `DialogContent`, `SelectItem`), so composition previews work. Subpath imports are limited to the 65 cards.
- **Layout idiom**: use the DS's Tailwind utility classes for preview layout glue (`flex flex-wrap
  items-center gap-3`, `grid`, `w-80`, `text-muted-foreground`, `text-success`) — they're in the compiled
  CSS and teach the design agent the idiom. Avoid inline styles.
- **Icons**: `import { Plus, Download } from 'lucide-react'` works in previews (esbuild tree-shakes).
- **Content**: use realistic UNILIV domain content (audits, properties, residents, maintenance, occupancy).
- **Overlays** (Dialog/AlertDialog/Sheet/Drawer/Popover/HoverCard/DropdownMenu/Select/Tooltip): set
  `cfg.overrides.<Name> = {"cardMode":"single","viewport":"WxH"}` and render the component **open**
  (`<Dialog open>…`). **Viewport width ≥ 640** so Tailwind `sm:` responsive footers render the desktop
  (horizontal) layout, not the mobile stacked layout.
- **Brand tokens**: coral (`accent`/`primary`) = primary action; `success` = green; `destructive` = red.
- `dtsPropsFor.<Name>` gives the design agent real prop types (synth mode emits loose `[key]:unknown`);
  added for high-value components as authored.

## Fan-out results (4 batches, 50 components + 3 solo = 53 authored, 12 floor)

All batches graded every cell "good"; **no batch required a config change**. Fixes were in-preview:
- **primary vs accent** (reconfirmed by every batch): coral = `accent`/`accent-strong`; `primary` is dark
  espresso (#241A15). Checkbox/Switch/RadioGroup/Slider/Progress fills, Tooltip bg, FileUpload icon all
  render **dark** — correct token usage, NOT a defect. Don't mark them "needs-work" for missing coral.
- **Precompiled CSS = no JIT at preview time**: utility classes absent from app source don't exist in
  `_ds_bundle.css`. Notables that are MISSING: `h-56`, `aspect-auto`. Present & fine: `h-48`, `top-1/2`,
  `-translate-y-1/2`, `-translate-x-1/2`, `basis-full`, all component-critical classes. Author previews
  with classes the app actually uses.
- **ChartContainer**: give a definite height (`h-48 w-full max-w-md`) so recharts `ResponsiveContainer`
  measures; renders fully (not a floor candidate). **ScrollArea**: `h-48` to bound/clip. **Carousel**:
  nav buttons repositioned below (the `-left-12` absolute nav clips against the cell's overflow:hidden).
  **ResizablePanelGroup**: wrap in a sized `<div className="h-48 max-w-lg">` (the lib hard-codes height:100%).
- **Overlays** (batch D): controlled `open` with no `onOpenChange` sits statically open; `Tooltip` needs
  `TooltipProvider`; `Select` needs `defaultValue` matching a `SelectItem`; `Drawer` needs
  `shouldScaleBackground={false}`. Pre-set viewports were all adequate.
- **Inline pickers** (DatePicker/DateTimePicker/TimePicker): controlled (`value` + no-op `onChange`),
  render as closed triggers (open state is internal useState, can't be forced) — accepted as good.
- External image URLs (pravatar/picsum) load in the capture env, so image avatars/photos render real imagery.

## Floor cards (unauthored, authorable on any re-sync)
Confetti, ConfirmDialog, FormModal, BoundedScroll, Sidebar, Form, Command, ContextMenu, Menubar,
NavigationMenu, Combobox, MultiCombobox. (Toaster excluded entirely — sonner/toaster name collision.)

## Re-sync risks (what can silently go stale)
- **`ds-compiled.css` is a precompiled, finite utility set** (scanned from app `src/`, 1605 rules). It
  covers all component + app classes, but NOT the full Tailwind universe — a design that invents a class
  the app never used renders unstyled. Improvement: add a broad `@source inline(...)` safelist. Re-sync
  regenerates it from current `src/` (see the regen command up top) — always rebuild it before the converter.
- **Fonts load from Google Fonts CDN at runtime** (`[FONT_REMOTE]`). If the design render env blocks
  external hosts, they fall back to system fonts. Improvement: self-contain by shipping woff2 via `cfg.extraFonts`.
- **Synth mode → loose `.d.ts` props** for all but the 9 components in `cfg.dtsPropsFor`. Improvement: a
  `tsc --emitDeclarationOnly` build over `src/components/ui` would give every component real prop types.
- **Self-ref symlink + `ds-compiled.css` are gitignored** — recreate both on a fresh clone (commands up top).
- **Concurrent edits**: another session was editing audit features (pages/api/db) during this sync; the UI
  primitives (`src/components/ui/*`) were untouched. On re-sync, confirm `src/components/ui/*` and
  `src/index.css` haven't changed in ways that move tokens/classes.
- Overlay previews depend on Radix's controlled-`open` API; some previews fetch external placeholder images.
