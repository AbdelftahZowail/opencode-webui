#!/usr/bin/env bash
# Stop a background capture started by capture-events.sh.
#   scripts/uitest/stop-capture.sh [outfile=/tmp/ocui-events.txt]
set -euo pipefail
source "$(dirname "$0")/env.sh"
OUT="${1:-$EVT_OUT}"
if [ -f "$OUT.pid" ]; then
  kill "$(cat "$OUT.pid")" 2>/dev/null || true
  rm -f "$OUT.pid"
  echo "stopped capture $OUT ($(grep -c '^data: ' "$OUT" 2>/dev/null || echo 0) events)"
else
  echo "no capture running for $OUT"
fi