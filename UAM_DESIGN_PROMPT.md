# Claude Design prompt — User & Access Management

Copy everything below the line into Claude Design.

---

Design the **User & Access Management** module for UNILIV, an operations platform for co-living
properties in India. Its users are operations staff — wardens, city heads, F&B managers — not
engineers. Most work on a laptop; some are on a mid-range Android phone in a hostel corridor.

## The one thing to get right

This module answers **"who can do what, and where?"** — and the current build fails because it
answers it all at once, on one screen, inline. Everything is a long list on a flat page.

**Design it as layers, not as a page.** The list view answers the question at a glance; the detail
opens when asked; the edit happens in a focused surface you can dismiss. Use the full component
vocabulary — side sheets/drawers, modals, tabs, accordions, popovers, segmented controls, command
palettes, inline chips — and pick the lightest one that fits each job. **Do not put a form, a
matrix, and a history on the same screen at the same time.**

Rule of thumb: if a screen needs a scrollbar to show one object, it is doing too much at once.

## The four concepts (in the words operators use)

1. **People** — someone with a login. 32 of them today. They are staff; residents are records, not
   logins, and a Resident role exists but is switched off.
2. **Roles** — a job's bundle of functionality. 22 of them (Warden, City Head, Kitchen Manager…),
   plus 6 audit personas (Auditor, Reviewer…). **A person can hold several roles at once, and what
   they can do is everything their roles allow, combined.** This is new and needs to read clearly.
3. **Privileges** — the exceptions. Something given to, or taken away from, one person or one role,
   optionally **only at one property**. Every privilege has a written reason and may expire.
4. **Places** — the estate, as a tree: Company → Zone → City → Cluster → Property → Room. 80 nodes.
   Kitchens sit under a city but serve properties in other clusters.

The killer scenario the design must make obvious: *one Unit Lead who can close complaints at
Property A but not at Property B — same person, same role, different place.*

## Screens to design

**1. People (list)** — 32 rows. Who they are, what they hold, where they work, are they active.
Search and filter. Opening someone should not feel like leaving the page.

**2. Person (detail)** — identity, the roles they hold, their privileges grouped by property, and
the history of changes to their access. Four distinct concerns; do not stack them vertically.

**3. Add a person** — a guided flow: who they are → which roles → which property → optionally
*copy the privileges of an existing colleague* → confirm. Ends by showing a temporary password
once. This flow prevents the most common mistake in the current system: creating someone with no
property, which silently gives them access to nothing.

**4. Roles (list)** and **5. Role (detail)** — what the role grants, who holds it, its
property-scoped privileges. A role can be switched off; that removes it from everyone at once, so
that action needs weight.

**6. Privileges** — the screen where the property axis leads. "At UNILIV Koramangala, these people
can do these things." Setting one is: pick the functionality, pick the place, allow or block, say
why, optionally set an expiry.

**7. Access check** — pick a person, optionally pick a property, and see exactly what they can do
and *why* — including refusals, each with its reason. This is the support tool; a denial must be
shown as a row with an explanation, never as an omission.

## What the data actually looks like

- 54 modules (Residents, Complaints, Laundry, Food Dashboard…) × up to 13 actions each
  (view, create, edit, delete, submit, approve, reject, assign, complete, verify, export,
  download, configure). That is ~700 possible permissions — **never render them as one grid.**
- A typical person holds 1–2 roles and 0–2 privileges. The heavy cases are rare; design for the
  common one and let the rare one expand.
- Reasons are free text, one sentence, e.g. *"Covering the Baner warden until 30 Sep."*

## Voice

Plain English, sentence case, no jargon. Say "can close complaints", not "holds COMPLAINTS:complete".
Say "works at 4 properties", not "scope: 4 nodes". Screen titles can be questions —
*"Who has an account, and what do they hold?"* — because that is what the reader arrived asking.

Never show a raw ID or a SCREAMING_SNAKE key as the primary label. Technical keys may appear as
quiet secondary text for engineers, never as the thing a reader must parse.

## Constraints

- **Light and dark**, both first-class.
- Warm, calm, professional. This is an administrative tool people use daily, not a dashboard to be
  impressed by. No gradients, no heavy shadows, no dense data-grid look.
- Destructive and wide-reaching actions (disable a role, block a permission, deactivate a person)
  must be visibly heavier than routine ones, and must always capture a reason.
- Expiring things should say when they expire, in words.
- Mobile: the list and detail views must work at 380px. The editing flows may assume a laptop.

## Deliver

Screens 1–7 above, in light and dark, plus the component set you used (buttons, chips, sheets,
modals, tabs, empty states, toasts) so it can be built consistently. Show at least one empty state
and one refusal/error state — they are most of the real experience in an access tool.
