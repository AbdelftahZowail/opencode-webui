#!/usr/bin/env bash
# End-to-end pass: create session (pinned to a working model by default),
# send a prompt, capture events while it runs, wait for completion, then
# print history AND replay the capture through the store to prove streaming.
#   scripts/uitest/smoke.sh ["prompt text"] [model provider/id]
set -euo pipefail
source "$(dirname "$0")/env.sh"
PROMPT="${1:-Reply with exactly: hello from smoke test}"
MODEL="${2:-opencode/deepseek-v4-flash-free}"

EVT_F="/tmp/ocui-smoke-events.txt"
rm -f "$EVT_F" "$EVT_F.pid"

echo "== create session (model: $MODEL) =="
SID="$(scripts/uitest/create-session.sh "$MODEL")"
echo "sid: $SID"

echo "== capture events =="
scripts/uitest/capture-events.sh "$EVT_F" >/dev/null

echo "== send prompt =="
scripts/uitest/send-prompt.sh "$SID" "$PROMPT"

echo "== wait for completion =="
scripts/uitest/wait-done.sh "$SID" 180
scripts/uitest/stop-capture.sh "$EVT_F" >/dev/null || true
sleep 1

echo "== persisted history =="
scripts/uitest/messages.sh "$SID" 5

echo "== replay through store (UI streaming proof) =="
bun scripts/uitest/replay-store.mjs "$EVT_F" "$SID" "$BASE"

echo "SID=$SID"