#!/bin/sh
# Runs the quote load test with k6 in Docker. Usage: run.sh [rate] [duration] [base_url]; set COOKIE or TOKEN.
set -eu
RATE="${1:-30}"
DURATION="${2:-60s}"
BASE_URL="${3:-http://host.docker.internal:8787}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HERE/results"
MSYS_NO_PATHCONV=1 docker run --rm -v "$HERE:/load" \
  -e BASE_URL="$BASE_URL" -e RATE="$RATE" -e DURATION="$DURATION" -e COOKIE="${COOKIE:-}" -e TOKEN="${TOKEN:-}" -e COOKIE_NAME="${COOKIE_NAME:-solventa-session}" \
  grafana/k6:latest run --quiet /load/quotes.k6.js || echo "k6 finished with failed thresholds (see summary above)"
cp "$HERE/results/last-run.json" "$HERE/results/run-${RATE}rps-${DURATION}.json"
node "$HERE/report.mjs" "$HERE/results/run-${RATE}rps-${DURATION}.json"
