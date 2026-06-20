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
- DNS: `unilivues.sleebit.com` → this server.

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

## 3. Build

```bash
docker compose build           # on amd64 host
# or on a non-amd64 builder:
# DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose build
```

## 4. Create the database schema

```bash
docker compose run --rm tools "pnpm --filter @workspace/db run push-force"
```

This creates all tables on the host Postgres (idempotent on a fresh DB).

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
> **OTP at login:** without an SMS provider, set `DEV_OTP=000000` in `.env.docker`
> (a fixed code that always passes) — or read the real per-login code from
> `docker compose logs api --since 2m | grep -i "OTP to"`. Unset `DEV_OTP` once
> Twilio is wired for real production.

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
  Traefik with a Let's Encrypt cert for `unilivues.sleebit.com` and
  proxy to this container. Map the container to a non-80 port to avoid clashing:
  in `docker-compose.yml` set the `web` port to e.g. `"8080:80"`.
- **Certbot in the container**: mount certs into the `web` container and add a
  `listen 443 ssl;` server block to `docker/nginx.conf`.
- **Cloudflare** (Full/strict) in front.

## Operations

```bash
# Update to a new build
git pull && docker compose build && docker compose up -d

# Apply new schema after a release (additive migrations are safe)
docker compose run --rm tools "pnpm --filter @workspace/db run push-force"

# Logs / restart / stop
docker compose logs -f api web
docker compose restart api
docker compose down
```

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
| `web` fails: `bind host port 0.0.0.0:80: address already in use` | A host web server already owns :80. Run the container on another port (`echo 'WEB_PORT=8080' >> .env && docker compose up -d`) and reverse-proxy `unilivues.sleebit.com` → `127.0.0.1:8080` from your host nginx (terminate TLS there). See §6. |
