#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_PORT="${AI_IDOL_WEBAPP_PORT:-6767}"
RUNTIME_ORIGIN="http://127.0.0.1:${RUNTIME_PORT}"
URL="${RUNTIME_ORIGIN}/#studio"
LOG_DIR="$ROOT/runtime-data"
CHROME_PROFILE="$LOG_DIR/chrome-webapp-profile"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PLIST="$LAUNCH_AGENT_DIR/com.aiidol.web-runtime.plist"
LAUNCH_AGENT_LABEL="com.aiidol.web-runtime"

mkdir -p "$LOG_DIR" "$CHROME_PROFILE" "$LAUNCH_AGENT_DIR"

install_runtime_launch_agent() {
  local plist_tmp="$LAUNCH_AGENT_PLIST.tmp.$$"
  local escaped_root escaped_log escaped_start
  escaped_root="$(printf '%s' "$ROOT" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')"
  escaped_log="$(printf '%s' "$LOG_DIR/webapp-runtime.log" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')"
  escaped_start="$(printf '%s' "$ROOT/start_macos.sh" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0"><dict>'
    printf '%s\n' '  <key>Label</key><string>com.aiidol.web-runtime</string>'
    printf '%s\n' '  <key>ProgramArguments</key><array>'
    printf '%s\n' '    <string>/usr/bin/env</string>'
    printf '    <string>PORT=%s</string>\n' "$RUNTIME_PORT"
    printf '    <string>CORS_ALLOWED_ORIGINS=%s,http://localhost:%s</string>\n' "$RUNTIME_ORIGIN" "$RUNTIME_PORT"
    printf '    <string>%s</string>\n' "$escaped_start"
    printf '%s\n' '  </array>'
    printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$escaped_root"
    printf '  <key>StandardOutPath</key><string>%s</string>\n' "$escaped_log"
    printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$escaped_log"
    printf '%s\n' '  <key>RunAtLoad</key><true/>'
    printf '%s\n' '  <key>KeepAlive</key><true/>'
    printf '%s\n' '  <key>ThrottleInterval</key><integer>5</integer>'
    printf '%s\n' '  <key>ProcessType</key><string>Interactive</string>'
    printf '%s\n' '</dict></plist>'
  } > "$plist_tmp"
  plutil -lint "$plist_tmp" >/dev/null
  mv "$plist_tmp" "$LAUNCH_AGENT_PLIST"

  launchctl bootout "gui/$UID" "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$LAUNCH_AGENT_PLIST"
  launchctl enable "gui/$UID/$LAUNCH_AGENT_LABEL"
  launchctl kickstart -k "gui/$UID/$LAUNCH_AGENT_LABEL"
}

# Migrate a runtime left running by an older shortcut. Chromium blocks port
# 6666, and that legacy process also owns the exclusive engine lock. Only stop
# it after confirming that it identifies itself as our AI IDOL runtime.
LEGACY_ORIGIN="http://127.0.0.1:6666"
if curl -fsS --max-time 2 "${LEGACY_ORIGIN}/api/status" 2>/dev/null | grep -q '"service":"ai-idol-runtime"'; then
  LEGACY_PIDS="$(lsof -nP -tiTCP:6666 -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$LEGACY_PIDS" ]]; then
    while IFS= read -r legacy_pid; do
      [[ "$legacy_pid" =~ ^[0-9]+$ ]] && kill -TERM "$legacy_pid" 2>/dev/null || true
    done <<< "$LEGACY_PIDS"
    for _ in {1..50}; do
      ! curl -fsS --max-time 1 "${LEGACY_ORIGIN}/health" >/dev/null 2>&1 && break
      sleep 0.1
    done
  fi
fi

if ! curl -fsS --max-time 2 "${RUNTIME_ORIGIN}/health" >/dev/null 2>&1; then
  # Finder-launched apps can lose ordinary child processes. Install a real
  # per-user LaunchAgent with KeepAlive so the runtime restarts after a crash,
  # memory-pressure termination, or unexpected worker failure.
  install_runtime_launch_agent
  for _ in {1..30}; do
    curl -fsS --max-time 2 "${RUNTIME_ORIGIN}/health" >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! curl -fsS --max-time 2 "${RUNTIME_ORIGIN}/health" >/dev/null 2>&1; then
  osascript -e 'display alert "AI Livestream" message "Khong the khoi dong local web server. Kiem tra runtime-data/webapp-runtime.log." as critical'
  exit 1
fi

open -na "Google Chrome" --args \
  --user-data-dir="$CHROME_PROFILE" \
  --autoplay-policy=no-user-gesture-required \
  --disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies \
  --app="$URL"
