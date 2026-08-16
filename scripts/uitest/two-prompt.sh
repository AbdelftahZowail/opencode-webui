#!/usr/bin/env bash
# Regression: the "second message doesn't appear" bug. Two sequential prompts
# in one session with one event capture, then replay the whole log through the
# store. Both runs must stream into live assistants and settle into history.
#   scripts/uitest/two-prompt.sh [model provider/id]
set -euo pipefail
source "$(dirname "$0")/env.sh"
MODEL="${1:-opencode/deepseek-v4-flash-free}"
EVT_F="/tmp/ocui-two-events.txt"
rm -f "$EVT_F" "$EVT_F.pid"

SID="$(scripts/uitest/create-session.sh "$MODEL")"
echo "sid: $SID"
scripts/uitest/capture-events.sh "$EVT_F" >/dev/null

scripts/uitest/send-prompt.sh "$SID" "Reply with exactly the single word: first"
scripts/uitest/wait-done.sh "$SID" 180
echo "-- run 1 finished --"

scripts/uitest/send-prompt.sh "$SID" "Reply with exactly the single word: second"
scripts/uitest/wait-done.sh "$SID" 180
echo "-- run 2 finished --"

scripts/uitest/stop-capture.sh "$EVT_F" >/dev/null || true
sleep 1
echo
echo "== persisted history =="
scripts/uitest/messages.sh "$SID" 8
echo
echo "== replay through store (proves BOTH runs stream + settle) =="
bun scripts/uitest/replay-store.mjs "$EVT_F" "$SID" "$BASE"