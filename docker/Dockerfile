# Multi-stage build for the UNILIV Admin monorepo.
#
#   • base      – installs the full pnpm workspace once (shared, cached)
#   • api-build – esbuild-bundles the API into a single dist/index.mjs
#   • web-build – Vite-builds the static SPA into dist/public
#   • api       – tiny runtime: just Node + the self-contained API bundle
#   • web       – nginx serving the static SPA + reverse-proxying /api
#
# Build stages run on Debian-slim (glibc); verified on both linux/amd64 and
# linux/arm64. Build for the same CPU arch as your deployment server (or set
# DOCKER_DEFAULT_PLATFORM=linux/amd64). The runtime images are alpine.

# ─────────────────────────────────────────────────────────────────────────────
# Base: install dependencies for the whole workspace (cached on lockfile hash).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1
# Pin the exact pnpm that generated pnpm-lock.yaml (v9.0). Newer pnpm versions
# ignore the package.json `pnpm.overrides` field and would fail --frozen-lockfile.
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /repo

# Warm the pnpm store from the lockfile only — this layer is reused until the
# lockfile changes, so dependency downloads are cached across rebuilds.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# Bring in the rest of the monorepo and install from the warmed store (offline).
COPY . .
RUN pnpm install --frozen-lockfile --offline

# ─────────────────────────────────────────────────────────────────────────────
# API build — esbuild bundles all deps into one ESM file (no runtime node_modules).
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS api-build
RUN pnpm --filter @workspace/api-server run build

# ─────────────────────────────────────────────────────────────────────────────
# Web build — Vite outputs static assets to artifacts/uniliv-admin/dist/public.
# vite.config requires PORT + BASE_PATH at config-load time (even for `build`).
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS web-build
ENV NODE_ENV=production
ENV PORT=3000
ENV BASE_PATH=/
RUN pnpm --filter @workspace/uniliv-admin run build

# ─────────────────────────────────────────────────────────────────────────────
# API runtime — minimal: Node + the bundle. No node_modules, no source.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS api
ENV NODE_ENV=production
ENV PORT=8090
WORKDIR /app
COPY --from=api-build /repo/artifacts/api-server/dist ./dist
EXPOSE 8090
USER node
CMD ["node", "--enable-source-maps", "dist/index.mjs"]

# ─────────────────────────────────────────────────────────────────────────────
# Web runtime — nginx serving the SPA + proxying /api to the api service.
# ─────────────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /repo/artifacts/uniliv-admin/dist/public /usr/share/nginx/html
EXPOSE 80
