#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://127.0.0.1:11111/#studio"
LOG_DIR="$ROOT/runtime-data"
CHROME_PROFILE="$LOG_DIR/chrome-webapp-profile"

mkdir -p "$LOG_DIR" "$CHROME_PROFILE"

if ! curl -fsS --max-time 2 "http://127.0.0.1:11111/health" >/dev/null 2>&1; then
  nohup "$ROOT/start_macos.sh" >"$LOG_DIR/webapp-runtime.log" 2>&1 &
  for _ in {1..30}; do
    curl -fsS --max-time 2 "http://127.0.0.1:11111/health" >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! curl -fsS --max-time 2 "http://127.0.0.1:11111/health" >/dev/null 2>&1; then
  osascript -e 'display alert "AI Livestream" message "Khong the khoi dong local web server. Kiem tra runtime-data/webapp-runtime.log." as critical'
  exit 1
fi

open -na "Google Chrome" --args \
  --user-data-dir="$CHROME_PROFILE" \
  --autoplay-policy=no-user-gesture-required \
  --disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies \
  --app="$URL"
