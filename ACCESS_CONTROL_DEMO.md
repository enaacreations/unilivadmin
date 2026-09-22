# Access Control — running it, how it works, and how to demo it

## Running locally

Both servers are up right now. To restart from cold, start these two Browser-pane previews
(or your usual workflows):

| Workflow | Port |
|---|---|
| `uniliv-api` | 8090 |
| `uniliv-web` | 3000 |

Open **http://localhost:3000** → `admin@uniliv.com` / `Admin@123` → OTP `000000` →
left nav **ADMIN → RBAC**.

The API states its configuration at boot, so you can prove which engine is answering:

```
access resolver mode   configured: "next"   effective: "next"   orgNodes: 80
permission matrix loaded   matrixSource: "db"   matrixVersion: 3
```

`ACCESS_RESOLVER` lives in `.env.api`. Delete the line and it falls back to `auto`, which uses
the unified resolver only if the org projection exists. Nothing breaks either way — both
resolvers were verified to return identical answers for all 32 active users.

---

## What we built, in one paragraph

The PRD asks for a chain: **User → Role → Module → Action → Property Scope → Data Scope**, with
the principle that *a role decides WHAT you can do; the hierarchy decides WHERE*. We built that
as one engine. A single org tree holds every level (company → zone → city → cluster → property →
room, with buildings/floors/beds as node types waiting for data). A single grants table places
people on that tree. One resolver turns "who is this" into "what can they reach", and one
decision function turns that into allow or deny **with a reason**. Everything else — the preview,
the matrix editor, the audit trail — reads from those same four pieces, which is why the screens
can be trusted: they are not a second opinion about permissions, they are the permissions.

## How it works, in the order it runs

1. **A request arrives.** `authenticate` re-reads the user's role and property from the database
   on every request, so a revoked role takes effect immediately rather than when the 15-minute
   token expires.
2. **`authorize(module, action)`** asks one question: does this role hold this capability? That
   answer now comes from the database (`access_role_permissions`), served from a process
   snapshot so the ~200 call sites stay synchronous.
3. **`resolveAccess(user)`** turns grants into reach: it walks the org tree's closure table and
   returns the set of nodes the person can act on — `null` meaning unrestricted, `[]` meaning
   nothing. A grant naming a module role (`AUDIT.AUDITOR`) confers access *inside that module
   only* and deliberately does not widen the general scope.
4. **Route handlers scope their queries** to that set. All 518 mounted routes are classified, and
   a test fails the build if a new one is added without answering "does this need scoping?".
5. **Write actions check separation of duties** — the person who raised an indent cannot approve
   it, the party that dispatched a trip cannot certify its receipt.
6. **Anything that changed access is recorded** on a hash-chained trail with who, when, what,
   before, after, and why.

---

## The demo

Ten minutes, five screens, in this order. The through-line to keep saying: **"this screen is not
a report about permissions — it is the permissions."**

### 1. Access preview — "What can this person do, and why?" *(the headline, §31)*

Pick **Suresh Kumar — WARDEN**.

- The **verdict** answers first: *"Suresh Kumar can act at 1 property. 11 of 54 modules reachable
  there, under data scope ALL."*
- **Where** shows the resolved reach: 1 property, 13 nodes, 1 grant.
- **What** collapses 54 modules into 8 family rows with heat strips. Expand *Operations* → expand
  *Complaints* → every action with its own allow/deny **and the reason**.
- Toggle **Denied only**. Say: *this is the support view — someone says "I can't do X", you see
  why in one screen.*
- Change **Evaluate at node** to another property. Say: *"they can approve at A but not B" is the
  most common access question, and it is one click.*

Then pick **Ananya Rao — CUSTOMER_EXPERIENCE**. It reads *"No general scope — placed only within
specific modules: AUDIT.AUDITOR · org-wide."* Say: *that is correct, not a gap. A module grant
confers access inside that module only — which is what stops an audit grant reaching the food
estate.*

### 2. Permission matrix — "Who can do this?" *(§25 / §30)*

Say the number first: **22 roles × 54 modules × 13 actions is about 15,000 cells.** No grid
survives that. So it shows **one module with every role beneath it** — about forty cells, all
answering the same question.

- Pick **Complaints** in the left list. Toggle a cell for a role.
- The staged bar appears: *N unsaved changes*. Click **Review & save**.
- The dialog lists the change, the **guard rails**, and demands a **reason**.
- Save. The version moves, the cell count updates, and the change is on the trail.

Worth naming: you can only grant a capability you hold yourself; system roles are computed and
cannot be edited at all; separation-of-duties pairs are refused *with the rationale shown*; and
a change that would leave nobody able to administer access is refused.

### 3. Grants — "47 grants place 24 people" *(§30 → Scopes)*

- Point at the **`+kitchens`** badge. Say: *a kitchen sits under a city but serves properties in
  other clusters. Food grants follow that spine; audit grants do not. That difference used to
  live in two separate resolvers and now it is one visible flag.*
- Open **New grant**: person → role → node → reach → data scope → validity. Five questions.
- The **role** list offers the six audit personas (Auditor, Reviewer, Auditee, …) and nothing else:
  a grant never names a *platform* role, because the person already has one — that is what the
  "General" option means.
- Note that selecting a **room** disables "include everything beneath" — §24 distinguishes
  "Specific Room" from a subtree, and this is where that distinction is enforced.
- **Revoke** demands a reason and keeps the grant restorable.

### 4. Personal exceptions — "same role, different person" *(beyond the PRD)*

Two flows, both on screens you are already showing:

**Access preview → any module → any action.** Every action row carries a three-state control:
**Role / Allow / Block**. Pick one and a dialog states exactly what is about to happen in a
sentence — *"This applies to Suresh Kumar alone. WARDEN is unchanged, and every other WARDEN
keeps having it."* A reason is required; an expiry is offered, because most exceptions should
have one.

The line worth saying out loud: **the role is not cloned**. Every cell this person did not
override still resolves from WARDEN, so editing the WARDEN row tomorrow still reaches them. That
is the difference between an exception and a fork, and it is why "who can approve?" stays a
question about roles rather than about 400 individuals.

A **Personal exceptions** card at the top of the preview lists everyone's divergences from their
role with the reason each was written for, and a one-click **Back to role**.

**Copy access from someone.** Onboarding's real question is "same as Priya", not "which of these
nine properties". Pick the person and you get a **dry run**: the role change, the grants, the
exceptions — and a line naming what it *replaces*, because it replaces rather than merges.
Nothing is written until you have seen the list and given a reason.

**Where — resolved reach → Change placement** opens both in a dialog: the copy panel and §27's
model itself — one home property, any number of additional ones, **per person**, so two people in
the same role can hold different property sets. That is the separation the whole design rests on:
the role says what, the assignment says where.

There used to be a separate Assignments tab for this. It is gone: being told "nothing places this
person anywhere" and then having to change tabs to act on it is a seam that only makes sense to
whoever drew the tabs. The "No placement" verdict now offers **Assign a property** directly, and
the reach card names the home property instead of only counting properties.

Both are enforced, not decorative: the `authorize()` gate consults the same exceptions, so a
blocked action returns a real 403, and the served capability list folds them in so the UI does
not offer a page the server will refuse.

### 5. Organization — "Two spines, one tree" *(§30)*

One tree replacing what used to be separate Zone / City / Cluster tables. Kitchens show a
`serves →` marker. Select a node to see **who has access here and via which grant**. The **drift**
panel reports real findings from live data.

Say: *Building, Floor and Bed are already valid node types — adding them needs no new table and
no resolver change.*

### 6. Activity trail — "Every change, with its reason" *(§29)*

- **Chain verified · N events** at the top.
- Expand the **Matrix changed** row from step 2: it shows the reason you typed, the before/after
  diff, and `chain ACCESS · seq N · <hash>`.

Say: *§29 asks for user, timestamp, action, entity, previous value, new value and a reason. All
seven are here, and access events are hash-chained so a gap or an edit is detectable.*

---

## Questions they will ask

**"Can we change permissions without engineering?"** Yes — that is the matrix editor, and role
cloning is there because "time to configure a new role" is one of your own success metrics. What
stays in code is the *vocabulary and the ceiling*: which modules and actions exist at all. Making
that editable too would turn privilege escalation into a single form submission.

**"Is this enforced, or just hidden in the UI?"** Enforced server-side on all 518 routes. The
frontend fails closed — an unmapped page is refused, not shown — but it is a hint, not the
boundary. The same sentence the API returns is what the screen displays.

**"What about beds, housekeeping, shifts, maintenance?"** Not built. They are the operational
half of the PRD and are a separate project. The access model already has the node types and the
event registry waiting for them.

**"How do we know it is right?"** Both old permission systems were reproduced exactly — 0
divergences across all 32 users, and 4752 matrix cells resolve identically between the database
and the previous hard-coded matrix. Those are tests, not one-off checks.

---

## Two things to expect on screen

- **`cx@uniliv.com` shows "no general scope."** Correct, and worth showing — see step 1.
- **Two kitchens are missing from the org tree** (Noida Sector 104, Jaipur Sitapura). They have
  no city, so no city or zone grant reaches them. Pre-existing data drift, and the Organization
  screen's drift panel reports it — which is arguably the better demo.

## What is honestly not done

The frontend enforcement, the matrix, grants, assignments, the tree and the trail are complete.
Not built: the four net-new modules (Bed, Housekeeping, Shift, Maintenance/Issue), which also
block six of §29's thirteen events and the Building/Floor/Bed levels of the tree. Those events
are registered with explicit blockers, and a test fails if a blocker outlives its cause.
