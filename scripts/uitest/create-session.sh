#!/usr/bin/env bash
# Create a session. Optional model as "providerID/id" (quoted):
#   scripts/uitest/create-session.sh "opencode/deepseek-v4-flash-free"
set -euo pipefail
source "$(dirname "$0")/env.sh"
MODEL="${1:-null}"
if [ "$MODEL" != "null" ]; then
  PROV="${MODEL%/*}"; ID="${MODEL#*/}"
  BODY="{\"title\":null,\"agent\":null,\"model\":{\"id\":\"$ID\",\"providerID\":\"$PROV\"},\"location\":null}"
else
  BODY='{"title":null,"agent":null,"model":null,"location":null}'
fi
curl -s -X POST "$BASE/api/session" -H 'content-type: application/json' -d "$BODY" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])'