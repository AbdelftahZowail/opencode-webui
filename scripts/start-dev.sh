#!/usr/bin/env bash
# Start the webui dev stack (proxy + vite) with debug logging, detached.
# Frontend logs  -> /tmp/webui-debug.log   (via the /api/debug proxy sink)
# Server logs    -> /tmp/webui-server.log  (stdout of the dev processes)
set -euo pipefail
cd "$(dirname "$0")/.."
LOG_DIR="${WEBUI_LOG_DIR:-/tmp}"
rm -f "$LOG_DIR/webui-debug.log"
nohup env WEBUI_DEBUG=1 bun run dev > "$LOG_DIR/webui-server.log" 2>&1 &
echo "dev pid: $!"
sleep 5
if ss -tln | grep -qE ":5173|:4097"; then
  echo "UP: vite 5173 + proxy 4097"
else
  echo "NOT UP — server log tail:"
  tail -20 "$LOG_DIR/webui-server.log"
fi