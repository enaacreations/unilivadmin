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
# `-C lib/db`, NOT `--filter @workspace/db`: pnpm exits 0 when a --filter matches
# no project ("No projects matched the filters"), so a push that never ran was
# indistinguishable from one that succeeded and `set -e` had nothing to trip on.
# That is how the dev box ended up serving new code against a database missing
# the `dishes.color` column — every catalogue read 500'd while this script had
# printed "Deploy complete". `-C` fails non-zero on a missing dir OR script.
docker compose run --rm tools "pnpm -C lib/db run push-force"

# Gate the rollout on the schema the new code is about to query. Exit status from
# the push only says the tool ran, not that it reached this database or applied
# everything — so compare the Drizzle schema against the live catalogue and stop
# BEFORE the containers restart. A failure here leaves the previous release
# serving, which is the correct outcome: stale-but-working beats new-but-500ing.
echo "▶ Verifying the schema matches the code"
docker compose run --rm tools "pnpm -C scripts run verify:schema"

echo "▶ Starting api + web"
docker compose up -d api web

echo "▶ Verifying"
PORT=$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
PORT=${PORT:-8080}
# Poll rather than `sleep 3` and hope: a cold start that takes four seconds used
# to report 000 and still print "Deploy complete", because the status code was
# swallowed by `|| true` and never asserted. 401 is the pass condition — the
# route exists and its auth gate answered, which is all an unauthenticated
# request can prove. (Schema correctness is the gate above, not this one.)
code=""
for _ in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/food/orders" || true)
  [ "$code" = "401" ] && break
  sleep 2
done
echo "  api gate (:${PORT}): ${code} (expect 401)"
docker compose ps
if [ "$code" != "401" ]; then
  echo "✖ API did not come up (last status: ${code:-none}). Containers left running for inspection:" >&2
  echo "    docker compose logs api --tail 100" >&2
  exit 1
fi

echo "✅ Deploy complete ($(git rev-parse --short HEAD))"
