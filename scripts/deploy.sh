#!/usr/bin/env bash
# Deploy whatever branch is currently checked out on THIS host.
# The caller checks out the branch first, then runs this:
#
#   git fetch origin <branch> && git checkout -B <branch> origin/<branch>
#   ./scripts/deploy.sh
#
# Used by:
#   - dev  : the GitHub Action (.github/workflows/deploy-dev.yml), automatically
#   - uat  : run by hand on the UAT server
#   - main : run by hand on the PROD server
#
# Assumes docker compose + a local .env.docker are already set up on the host.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

echo "▶ Building images (api, web, tools)"
docker compose --profile tools build

echo "▶ Running DB migrations (must be additive / forward-compatible)"
docker compose run --rm tools "pnpm --filter @workspace/db run push-force"

echo "▶ Starting api + web"
docker compose up -d api web

echo "▶ Verifying"
sleep 3
PORT=$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
PORT=${PORT:-8080}
code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/food/orders" || true)
echo "  api gate (:${PORT}): ${code} (expect 401)"
docker compose ps

echo "✅ Deploy complete ($(git rev-parse --short HEAD))"
