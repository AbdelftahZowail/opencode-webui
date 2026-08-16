#!/usr/bin/env bash
# Wait until a session is no longer running. Prints "done" (or "still-running").
#   scripts/uitest/wait-done.sh <session-id> [timeout-secs=120]
set -euo pipefail
source "$(dirname "$0")/env.sh"
SID="${1:?usage: wait-done.sh <session-id> [timeout]}"
TIMEOUT="${2:-120}"
for i in $(seq 1 "$((TIMEOUT / 2))"); do
  OUT="$(curl -s "$BASE/api/session/active" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print('running' if '$SID' in d else 'done')")"
  if [ "$OUT" = "done" ]; then echo "done"; exit 0; fi
  sleep 2
done
echo "still-running"