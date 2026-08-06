# Deployment — UNILIV Admin (Docker)

Production stack: a tiny **API** container (Node + a single bundled file, no
`node_modules`) and an **nginx** container that serves the static SPA and
reverse-proxies `/api`. **PostgreSQL stays on the host** and is reached over its
**Unix socket** (bind-mounted into the container) — nothing is exposed on TCP.

```
browser ──HTTPS──▶ [edge TLS] ──▶ nginx (web :80) ──/──▶ static SPA
                                          └──/api──▶ api (:8090) ──▶ host Postgres
```

---

## 0. Prerequisites

- A Linux host (x86-64 or arm64) with Docker Engine + Compose v2.
  > Build for the **same CPU architecture as your server**. The build runs on
  > Debian-slim (glibc) and is verified on both linux/amd64 and linux/arm64. To
  > target a specific arch from another builder, prefix:
  > `DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose build`.
- PostgreSQL already running on the host.
- DNS: `unilivues1.enaacreations.com` → this server.

## 1. Prepare host PostgreSQL (installed via apt, NOT in Docker)

We connect over the host's **Unix socket** — Postgres keeps
`listen_addresses = 'localhost'` and is **never exposed on the network**. The
compose file bind-mounts the host socket dir (`/var/run/postgresql`) into the
`api` and `tools` containers, so the only DB setup is a password role + one
`pg_hba` line.

**a) Give the `admin` role a password + create the database.** Socket
connections from the container can't use `peer` auth (the container's uid won't
map to the role), so the role needs a password. (The database is named `uniliv`
and owned by `admin`; rename it if you prefer.)

```bash
sudo -u postgres psql -c "ALTER USER admin WITH PASSWORD 'a-strong-password';"
sudo -u postgres psql -c "CREATE DATABASE uniliv OWNER admin;"
```

**b) Allow `admin` over the local socket with a password.** Insert a `local`
rule *above* the default `peer` catch-all (pg_hba is first-match), scoped to the
`uniliv` DB so other local logins (e.g. `sudo -u postgres psql`) are untouched:

```bash
PGHBA=$(dirname "$(sudo -u postgres psql -tAc 'SHOW config_file')")/pg_hba.conf
sudo sed -i "0,/^local/s//local   uniliv   admin   scram-sha-256\nlocal/" "$PGHBA"
sudo systemctl reload postgresql
```

That's it — **no `listen_addresses` change, nothing opened on TCP, no firewall
rule.** (Verify the rule landed above the `local all all … peer` line:
`grep -n '^local' "$PGHBA"`.)

> **Socket permissions:** Debian/Ubuntu ship a world-reachable socket
> (`/var/run/postgresql` dir mode `2775`, socket `0777`), so the container's
> non-root `node` user can connect out of the box. If you hardened
> `unix_socket_permissions`, make sure the socket is reachable by the container
> user. On **SELinux** hosts, add `:z` to the volume mount in `docker-compose.yml`.

`DATABASE_URL` (step 2) uses the socket:
`postgresql://admin:a-strong-password@/uniliv?host=/var/run/postgresql`

> **Alternative — TCP over the host gateway** (only if you can't share the
> socket): set `listen_addresses = '*'` (or `'localhost,172.17.0.1'`), add
> `host uniliv admin 172.16.0.0/12 scram-sha-256` to `pg_hba.conf`, restart
> Postgres, re-add `extra_hosts: ["host.docker.internal:host-gateway"]` to the
> `api`/`tools` services, and use
> `DATABASE_URL=postgresql://admin:pw@host.docker.internal:5432/uniliv`.

## 2. Configure env

```bash
cp .env.docker.example .env.docker
# edit .env.docker:
#   DATABASE_URL=postgresql://admin:a-strong-password@/uniliv?host=/var/run/postgresql
#   SESSION_SECRET=$(openssl rand -hex 48)
```

> **Password with special characters?** A `/`, `#`, `@`, `:`, space or `%` in the
> password breaks the URL parser (`TypeError: Invalid URL`). Either use a
> URL-safe password (`openssl rand -hex 24`), URL-encode the chars (`/`→`%2F`,
> `#`→`%23`, …), **or** skip `DATABASE_URL` and set the raw `PG*` vars instead:
> `PGHOST=/var/run/postgresql PGUSER=admin PGPASSWORD=… PGDATABASE=uniliv`
> (no encoding needed). Both are wired through to the api + tools containers.

> **Timezone — keep `TZ=Asia/Kolkata`.** The deployed `.env.docker` **must** set
> `TZ=Asia/Kolkata` (it ships set in `.env.docker.example`). The app's date logic —
> most importantly the food Place-Order cut-off — anchors to IST in code regardless
> of the host clock, so this is defense-in-depth: it keeps the container's wall
> clock (logs, any host-local `Date` math) in IST too. Do not change it.

## 3. Build

```bash
docker compose build           # on amd64 host
# or on a non-amd64 builder:
# DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose build
```

> **The api image carries no `node_modules`.** The runtime stage copies only
> `dist/`, so any dependency esbuild left as a runtime import is
> `ERR_MODULE_NOT_FOUND` the first time it is used — which is how SES email
> (`@aws-sdk/client-sesv2`) and SES/SNS bounce webhooks (`sns-validator`) both
> shipped broken while every health check stayed green. esbuild can only follow
> a **literal** import specifier; the `const pkg = "x"; await import(pkg)` idiom
> silently defeats it.
>
> `docker/Dockerfile` sets `API_BUNDLE_VERIFY=strict` in the api build stage, so
> a violation now fails the image build rather than warning. To assert the same
> thing outside Docker before deploying:
>
> ```bash
> API_BUNDLE_VERIFY=strict pnpm --filter @workspace/api-server run build
> ```
>
> It prints every module still resolved at runtime and fails on any that is not
> on the reviewed optional list (`bullmq`, `ioredis`, `web-push`, plus two
> third-party lazy probes) — each of which has a caller that catches the throw
> and degrades. This replaces the old `grep -c` recipe, which could count
> unbundled packages but never name one.

## 4. Create the database schema

```bash
# FRESH DATABASE ONLY. On a database with rows this DELETES DATA — see below.
docker compose run --rm tools "pnpm --filter @workspace/db run push-force"
```

This creates all tables on the host Postgres (idempotent on a fresh DB).

> ⚠️ **`push-force` is for a FRESH database only.** `--force` auto-accepts every
> destructive statement drizzle-kit proposes, without printing a prompt. On a
> database that already holds rows it will silently **`TRUNCATE payments`** —
> verified: plain `push` against a populated `payments` offers exactly
> `"Yes, I want to … truncate 1 table"`, because `payments.property_id` is NOT
> NULL with no default and a NOT NULL column cannot be added to a populated
> table, so emptying it is drizzle-kit's remedy — and **`DROP
> food_orders.preparing_at`**. Both are unrecoverable, and `--force` performs
> them without printing anything.
> To upgrade a database that has data, follow
> [Upgrading an existing database](#upgrading-an-existing-database) — it uses
> plain `push`, and runs the backfills and column drop that leave `push` with no
> destructive statement to propose at all.

### (Optional) seed reference + demo data
Required reference data (OTP limits, meal cut-off windows, kitchens) plus a
demo admin + sample orders:

```bash
docker compose run --rm tools "pnpm --filter @workspace/scripts run seed && \
  pnpm --filter @workspace/scripts run seed:food && \
  pnpm --filter @workspace/scripts run seed:food-extra"
```

> For a clean production DB you may skip the base `seed` and instead create your
> own admin user, but you **should** run `seed:food-extra` (it seeds
> `system_config` for OTP and the meal **cut-off windows** the app relies on).
> Seeded logins use password `Admin@123` — change them immediately.
>
> **OTP at login (production):** Twilio is the real OTP delivery provider — set
> `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` in `.env.docker`
> and login codes are sent as SMS. With Twilio unset the code is only logged
> (`docker compose logs api --since 2m | grep -i "OTP to"`), so a real production
> deployment must wire Twilio.
>
> The fixed `DEV_OTP` master code and the `devOtp` echo in API responses are a
> **development-only** convenience: they are honoured ONLY when
> `NODE_ENV=development` **and** `ALLOW_DEV_OTP=true`. In production they are
> always disabled — and **`DEV_OTP` must be unset**, or the API refuses to boot.
>
> **Required production env (fail-closed):** `NODE_ENV=production`, a strong
> `SESSION_SECRET` (`openssl rand -hex 48`), `ENCRYPTION_KEY` for KYC field
> encryption (`openssl rand -hex 32`), and `SES_SNS_TOPIC_ARN` for the SES
> bounce/complaint webhook (the webhook rejects all events in production when it
> is unset).

## 5. Start

```bash
docker compose up -d
docker compose ps
docker compose logs -f api
```

The site is served on port **80**. Verify:

```bash
curl -fsS http://localhost/api/healthz        # {"status":"ok"}
curl -fsSI http://localhost/                   # 200, serves index.html
```

## 6. TLS (important)

The app issues **`Secure` session cookies in production**, so users must reach
the site over **HTTPS** for token refresh to work. Terminate TLS upstream — pick
one:

- **Host reverse proxy** (recommended): run your existing host nginx / Caddy /
  Traefik with a Let's Encrypt cert for `unilivues1.enaacreations.com` and
  proxy to this container. Map the container to a non-80 port to avoid clashing:
  in `docker-compose.yml` set the `web` port to e.g. `"8080:80"`.
- **Certbot in the container**: mount certs into the `web` container and add a
  `listen 443 ssl;` server block to `docker/nginx.conf`.
- **Cloudflare** (Full/strict) in front.

## Operations

```bash
# Update to a new build (schema first — see below)
git pull && docker compose build && docker compose up -d

# Logs / restart / stop
docker compose logs -f api web
docker compose restart api
docker compose down
```

## Upgrading an existing database

A release that only adds nullable columns needs nothing but `push`. This release
does more than that, and the steps below are **ordered**: each one exists because
the next one fails without it. Run them all from the `tools` container, with the
new images built but the API **still serving the old build** (`docker compose
build`, not yet `up -d`).

> **Never use `push-force` here.** See the warning in §4 — on a populated
> database `--force` truncates `payments` and drops `food_orders.preparing_at`
> without asking.
>
> **The stop rule for step 6, and it has no exceptions.** Steps 1–5 exist so
> that by the time `push` runs there is nothing destructive left for it to
> propose: the backfill creates `payments.property_id` itself, and step 5 drops
> the dead column `push` would otherwise offer to delete. So a correct step 6
> prints no `Found data-loss statements` banner at all. **If `push` shows that
> banner — for a truncate, a column drop, anything — choose `No, abort` and stop
> the upgrade.** There is no "expected" data-loss prompt to wave through and no
> judgement call to make: a banner means a step above did not run, or the
> database is not what this release expects.

```bash
T() { docker compose run --rm tools "$1"; }

# 1. Duplicates that block the new unique indexes. Report first, then collapse.
T "pnpm --filter @workspace/scripts run dedupe:food"
T "pnpm --filter @workspace/scripts run dedupe:food -- --yes"

# 2. payments.property_id — adds the column nullable and fills it. `push` CANNOT
#    do this itself: the column is NOT NULL with no default, which Postgres
#    rejects outright on a populated table.
T "pnpm --filter @workspace/scripts run backfill:payment-property"

# 3. user_scopes — the fail-closed scope resolver. Report first, then write.
T "pnpm --filter @workspace/scripts run backfill:user-scopes"
T "pnpm --filter @workspace/scripts run backfill:user-scopes -- --apply"

# 4. Wallet reference namespace. MUST precede the new API image.
T "pnpm --filter @workspace/scripts run migrate:wallet-namespace"
T "pnpm --filter @workspace/scripts run migrate:wallet-namespace -- --apply"

# 5. Columns this release removed from the schema. Report first, then drop.
#    `push` cannot drop a column without a data-loss prompt, and step 6's rule
#    is that ANY data-loss prompt means abort — so the drop happens here.
T "pnpm --filter @workspace/scripts run drop:dead-columns"
T "pnpm --filter @workspace/scripts run drop:dead-columns -- --yes"

# 6. Only now is the schema push safe. It must print NO data-loss banner.
T "pnpm --filter @workspace/db run push"

# 7. Cut over.
docker compose up -d
```

**Why each step is where it is**

| # | Step | Skipping it costs |
|---|------|-------------------|
| 1 | `dedupe:food` | `push` aborts creating a unique index and names the index, not the rows. Money and live-order duplicates are **reported, never deleted** — `--yes` only collapses config tables. Resolve a reported `payments` / `wallet_transactions` / `food_orders` duplicate through the app (void, reverse, cancel) before continuing. |
| 2 | `backfill:payment-property` | `push` cannot add a NOT NULL column to a populated table and offers to **truncate `payments`** instead. The script adds the column nullable, fills it from the resident's property, and exits non-zero on anything it cannot attribute. |
| 3 | `backfill:user-scopes` | Scope resolution is now fail-closed, and an empty scope answers 200-with-nothing rather than 403, so the loss is silent. **ZONAL_HEAD, CITY_HEAD, CLUSTER_MANAGER, FNB_SUPERVISOR, FNB_ZONAL_HEAD** hold `FOOD_*` modules and lose the food module itself. **KITCHEN_MANAGER holds no `FOOD_*` module at all** (`permissions.ts`: DASHBOARD, RECIPES, MENU_PLANNING, INVENTORY, INDENTS·create) — food ordering 403s for it with or without a grant, so do not expect a scope to open that; what it loses to an empty scope is **Kitchen Operations** (menu plans, production logs, kitchen analytics, recipe feedback) and the property list Menu Planning reads. The script grants only what existing data already states (home property, single cluster ownership, single kitchen contact), and passes only when **every** at-risk account resolves to at least one property — holding a grant is not the test, since a grant on an empty or deactivated geography resolves to nothing. It prints the accounts an operator must grant by hand in **Food → Organization** (which lists KITCHEN_MANAGER — `FOOD_USER_ROLES` now includes it) and exits non-zero until none are left, **including** accounts whose only grants are revoked: those are never re-granted automatically, and the run does not report success while they see nothing. An account with several derivable targets (a manager named on nine clusters) is reported rather than granted all nine; add `--allow-multi-target` to the `--apply` run only if that width is intended. |
| 4 | `migrate:wallet-namespace` | The old webhook wrote `reference_type = 'RAZORPAY'`; the new one dedupes on `RAZORPAY_PAYMENT` / `RAZORPAY_LINK`. A Razorpay **redelivery of any pre-deploy event** would not match the guard and would credit the wallet a second time. This is the one step that costs real money if skipped, and it must land **before** the new API serves traffic. |
| 5 | `drop:dead-columns` | `push` proposes `DROP food_orders.preparing_at` (the column behind the dead `PREPARING` state) on every database that holds orders, and it can only propose it behind a data-loss confirmation. That single expected prompt is what made step 6's abort rule impossible to follow — an operator cannot be asked to tell it apart from `TRUNCATE payments` inside the same two-line banner. Dropping it here removes the prompt instead of asking anyone to judge it. The script drops a column only when it is entirely NULL, and exits non-zero (dropping nothing) if it is not. |
| 6 | `push` | Now has only `SET NOT NULL` and index creation left to do — **no data-loss banner**. If one appears, abort. |

Every script is idempotent and safe to re-run, and each exits non-zero when it
leaves work an operator has to finish — so a pipeline stops instead of shipping
a lockout. Steps 1, 3, 4 and 5 default to a dry run; the `--yes` / `--apply` form
is the one that writes.

**Note on `push` convergence.** After a successful upgrade, a second `push`
reports `No changes detected`, so "push says nothing to do" IS a usable drift
signal — treat any output from a repeat push as real drift and investigate it.

Getting there needed three FK constraints named explicitly: drizzle derived
names longer than Postgres's 63-character identifier limit for
`audit_schedules.template_version_id`, `audit_sections.template_version_id` and
`bank_statement_lines.matched_ledger_entry_id`, so the catalogue held a
truncated name that never matched on the next diff and every push re-emitted a
drop + immediate re-add of the same constraint. They now carry explicit short
names in `lib/db/src/schema/audit.ts` and `finance.ts`. **Any new FK whose
`<table>_<column>_<reftable>_<refcolumn>_fk` name would exceed 63 characters
must be named the same way**, or the signal degrades again.

## Footprint & internals

- **api** image: `node:22-alpine` + one bundled `dist/index.mjs` (esbuild bundles
  express, pg, drizzle, bcryptjs, jwt, pdf-lib, pino) — **no `node_modules`** at
  runtime. ~60–80 MB.
- **web** image: `nginx:1.27-alpine` + static assets only. ~20–40 MB.
- **tools** image (schema/seed) is built on demand and never runs as a service.
- The API binds `0.0.0.0:8090` inside its container (not published to the host);
  only nginx (`web`) is exposed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| API can't reach DB | Confirm the socket exists (`ls /var/run/postgresql/.s.PGSQL.5432`), `DATABASE_URL` ends with `?host=/var/run/postgresql`, the `local uniliv admin scram-sha-256` pg_hba rule is **above** the `peer` catch-all, and `admin`'s password matches. `docker compose logs api`. |
| `peer authentication failed` for admin | Your pg_hba `local … peer` rule is matching first — move the `scram-sha-256` line above it and `sudo systemctl reload postgresql`. |
| Build fails on a native binary (rollup/oxide/lightningcss) | Build for your server's arch, e.g. `DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose build`. |
| Login works but session drops after 15 min | Serve over **HTTPS** (Secure cookies); see §6. |
| 502 from nginx | API unhealthy — `docker compose logs api`, check DB connectivity. |
| `web` fails: `bind host port 0.0.0.0:80: address already in use` | A host web server already owns :80. Run the container on another port (`echo 'WEB_PORT=8080' >> .env && docker compose up -d`) and reverse-proxy `unilivues1.enaacreations.com` → `127.0.0.1:8080` from your host nginx (terminate TLS there). See §6. |
