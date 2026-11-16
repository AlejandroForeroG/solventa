#!/bin/sh
# Usage: COOKIE=... POLICY_ID=... sh infra/load/run-policies.sh [rate] [duration] [base_url]
set -eu
RATE="${1:-10}"
DURATION="${2:-60s}"
BASE_URL="${3:-http://host.docker.internal:8787}"
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${COOKIE:?Set COOKIE to a logged-in web session}"
: "${POLICY_ID:?Set POLICY_ID to an issued policy owned by that session}"
mkdir -p "$HERE/results"
rm -f "$HERE/results/last-policy-run.json"
status=0
MSYS_NO_PATHCONV=1 docker run --rm -v "$HERE:/load" \
  -e BASE_URL="$BASE_URL" -e RATE="$RATE" -e DURATION="$DURATION" -e COOKIE="$COOKIE" -e POLICY_ID="$POLICY_ID" -e COOKIE_NAME="${COOKIE_NAME:-solventa-session}" \
  grafana/k6:latest run --quiet /load/policies.k6.js || status=$?
if [ -f "$HERE/results/last-policy-run.json" ]; then
  cp "$HERE/results/last-policy-run.json" "$HERE/results/policies-${RATE}rps-${DURATION}.json"
  node "$HERE/report.mjs" "$HERE/results/policies-${RATE}rps-${DURATION}.json"
fi
exit "$status"
