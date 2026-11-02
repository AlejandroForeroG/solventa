#!/bin/sh
# Usage: COOKIE=... QUOTE_ID=... sh infra/load/run-offers.sh [rate] [duration] [base_url]
set -eu
RATE="${1:-10}"
DURATION="${2:-60s}"
BASE_URL="${3:-http://host.docker.internal:8787}"
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${COOKIE:?Set COOKIE to a logged-in web session}"
: "${QUOTE_ID:?Set QUOTE_ID to a quote owned by that session}"
mkdir -p "$HERE/results"
rm -f "$HERE/results/last-offer-run.json"
status=0
MSYS_NO_PATHCONV=1 docker run --rm -v "$HERE:/load" \
  -e BASE_URL="$BASE_URL" -e RATE="$RATE" -e DURATION="$DURATION" -e COOKIE="$COOKIE" -e QUOTE_ID="$QUOTE_ID" -e COOKIE_NAME="${COOKIE_NAME:-solventa-session}" \
  grafana/k6:latest run --quiet /load/offers.k6.js || status=$?
if [ -f "$HERE/results/last-offer-run.json" ]; then
  cp "$HERE/results/last-offer-run.json" "$HERE/results/offers-${RATE}rps-${DURATION}.json"
  node "$HERE/report.mjs" "$HERE/results/offers-${RATE}rps-${DURATION}.json"
fi
exit "$status"
