#!/usr/bin/env bash
# Pretty-print the messages of a session (history = what the transcript shows).
#   scripts/uitest/messages.sh <session-id> [limit]
set -euo pipefail
source "$(dirname "$0")/env.sh"
SID="${1:?usage: messages.sh <session-id> [limit]}"
LIMIT="${2:-20}"
TMP="$(mktemp)"
curl -s "$BASE/api/session/$SID/message?limit=$LIMIT&order=desc" > "$TMP"
python3 - "$TMP" <<'EOF'
import json, sys
msgs = list(reversed(json.load(open(sys.argv[1]))["data"]))
for m in msgs:
    t = m["type"]
    if t == "user":
        print("[user]        %r" % (m.get("text", "")[:90]))
    elif t == "assistant":
        parts = [p.get("text", "")[:60] for p in m.get("content", []) if p["type"] in ("text", "reasoning")]
        print("[assistant]   %s finish=%s" % (parts if parts else "(no text parts)", m.get("finish")))
    else:
        print("[%s]        %r" % (t, (m.get("text") or m.get("name") or "")[:70]))
EOF
rm -f "$TMP"