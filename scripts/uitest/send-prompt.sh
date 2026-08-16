#!/usr/bin/env bash
# Send a prompt to a session (fire and forget, like the UI).
#   scripts/uitest/send-prompt.sh <session-id> "prompt text"
#   scripts/uitest/send-prompt.sh <session-id> --stdin
set -euo pipefail
source "$(dirname "$0")/env.sh"
SID="${1:?usage: send-prompt.sh <session-id> <text|--stdin>}"
shift
TEXT="${1:-}"; if [ "$#" -gt 1 ]; then shift; fi
if [ "${TEXT}" = "--stdin" ]; then
  TEXT="$(cat)"
fi
printf '{"text":%s}' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$TEXT")" \
  | curl -s -X POST "$BASE/api/session/$SID/prompt" -H 'content-type: application/json' -d @- \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("data",{}).get("id") or "accepted")'