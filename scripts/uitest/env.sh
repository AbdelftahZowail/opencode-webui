#!/usr/bin/env bash
# Shared environment for the UI test scripts. Source this before using them:
#   source scripts/uitest/env.sh
export BASE="${BASE:-http://127.0.0.1:4097}"
export EVT_OUT="${EVT_OUT:-/tmp/ocui-events.txt}"