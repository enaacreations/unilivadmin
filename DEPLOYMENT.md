# Deployment — UNILIV Admin (Docker)

Production stack: a tiny **API** container (Node + a single bundled file, no
`node_modules`) and an **nginx** container that serves the static SPA and
reverse-proxies `/api`. **PostgreSQL stays on the host** and is reached from the
API container over the Docker host gateway.

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
- DNS: `unilivadmin.enaacreations.com` → this server.

## 1. Prepare host PostgreSQL

Create the database + user, and allow the Docker network to connect.

```sql
CREATE USER uniliv WITH PASSWORD 'a-strong-password';
CREATE DATABASE uniliv OWNER uniliv;
```

Let containers reach Postgres on the host:

```ini
# postgresql.conf
listen_addresses = '*'          # or add the docker0 bridge IP

# pg_hba.conf  (Docker bridge subnets)
host  all  all  172.16.0.0/12   scram-sha-256
```

```bash
sudo systemctl restart postgresql
```

## 2. Configure env

```bash
cp .env.docker.example .env.docker
# edit .env.docker:
#   DATABASE_URL=postgresql://uniliv:a-strong-password@host.docker.internal:5432/uniliv
#   SESSION_SECRET=$(openssl rand -hex 48)
```

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
  Traefik with a Let's Encrypt cert for `unilivadmin.enaacreations.com` and
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
| API can't reach DB | Check `DATABASE_URL` uses `host.docker.internal`; verify `listen_addresses` + `pg_hba.conf` allow the docker subnet; `docker compose logs api`. |
| Build fails on a native binary (rollup/oxide/lightningcss) | Build for your server's arch, e.g. `DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose build`. |
| Login works but session drops after 15 min | Serve over **HTTPS** (Secure cookies); see §6. |
| 502 from nginx | API unhealthy — `docker compose logs api`, check DB connectivity. |
