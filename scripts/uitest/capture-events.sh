#!/usr/bin/env bash
# Capture the /api/event SSE stream to a file in the background.
#   scripts/uitest/capture-events.sh [outfile=/tmp/ocui-events.txt]
#   -> writes the capture PID to <outfile>.pid ; kill it with that pid,
#      or use scripts/uitest/stop-capture.sh <outfile>
set -euo pipefail
source "$(dirname "$0")/env.sh"
OUT="${1:-$EVT_OUT}"
nohup curl -sN "$BASE/api/event" > "$OUT" 2>/dev/null &
echo $! > "$OUT.pid"
echo "capturing events to $OUT (pid $(cat "$OUT.pid"))"