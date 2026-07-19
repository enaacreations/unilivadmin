# Contributing & Branching

Small team, three environments. One branch per environment, code always flows
**up** (dev → uat → main). Keep it simple.

## Branches & environments

| Branch | Environment            | Deploy            |
| ------ | ---------------------- | ----------------- |
| `dev`  | Our dev (the e2e box)  | **Auto** on push  |
| `uat`  | Client UAT             | Manual            |
| `main` | Client production      | Manual            |

- **Never commit or push directly to `uat` or `main`.** They only ever receive
  code by being promoted from the branch below.
- `dev` is where day-to-day work lands.

## Daily work: feature → dev

```bash
git checkout dev && git pull
git checkout -b feat/short-description   # or fix/... , chore/...
# ...work, commit...
git push -u origin feat/short-description
```

Open a PR into `dev`, get one teammate to glance at it, then **squash-merge**.
Merging to `dev` auto-deploys to our dev environment. Delete the branch after.

Keep feature branches short-lived (hours, not a week) — three people touch the
same files, so long branches = painful conflicts.

## Promote: dev → uat → main

Promotion is just merging the environment branch forward (a plain merge, **not**
squash), then deploying that environment by hand.

```bash
# dev -> uat
git checkout uat && git pull && git merge origin/dev && git push
# then on the UAT server:
#   cd ~/unilivadmin && git fetch origin uat && git checkout -B uat origin/uat && ./scripts/deploy.sh

# uat -> main (prod)
git checkout main && git pull && git merge origin/uat && git push
git tag v1.x.0 && git push --tags        # tag every prod release
# then on the PROD server:
#   cd ~/unilivadmin && git fetch origin main && git checkout -B main origin/main && ./scripts/deploy.sh
```

A promotion takes **everything** currently in the lower branch. So keep `dev`
releasable, or hide unfinished work behind a flag if it can't ship yet.

## Hotfix a production bug

Prod is broken and `dev` has unreleased work you can't promote yet:

```bash
git checkout main && git pull
git checkout -b hotfix/short-description
# ...fix, commit...
git checkout main && git merge hotfix/... && git push   # deploy prod
git tag v1.x.1 && git push --tags
# then merge the fix back DOWN so it isn't lost on the next promotion:
git checkout uat  && git merge origin/main && git push
git checkout dev  && git merge origin/main && git push
```

## Golden rules

1. **Features flow up, hotfixes flow down.**
2. **Migrations are additive / forward-compatible only.** Never rename or drop a
   column in the same change that stops using it — old code must tolerate the new
   schema during the window between environment promotions. Each environment has
   its own database; the migration runs when that environment deploys.
3. Never merge a feature branch straight into `uat` or `main`.
4. Tag every prod release (`v1.x.y`). Rollback = redeploy the previous tag.

## Migration checklist (when a change touches the DB schema)

- [ ] Change is additive (new table/column/index), or a safe two-step for
      renames/drops (add new → migrate → remove old in a later release).
- [ ] Ran locally against a dev DB.
- [ ] Whoever promotes to uat / main runs the deploy (which runs the migration)
      and confirms the app comes up.

## Deploying

- **dev** — automatic. Push to `dev` → GitHub Action SSHes into the box and runs
  `scripts/deploy.sh`.
- **uat / main** — run the two commands shown in the promotion section on that
  server. `scripts/deploy.sh` builds, runs migrations, restarts `api` + `web`,
  and prints a health check.

## Per-environment config

Each server keeps its own `.env.docker` (not in git). Notably
`DISABLE_SINGLE_SESSION=true` is a dev-only testing convenience — it must be
**off** on UAT and prod.
