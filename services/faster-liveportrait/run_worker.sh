#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SERVICE_DIR/../.." && pwd)"
if [[ -f "$WORKSPACE_ROOT/.env" ]]; then
  set -a
  source "$WORKSPACE_ROOT/.env"
  set +a
fi

VENDOR_DIR="${FASTER_LIVEPORTRAIT_VENDOR_DIR:-$SERVICE_DIR/vendor/fasterliveportrait-mlx}"
PYTHON_BIN="${FASTER_LIVEPORTRAIT_PYTHON_BIN:-$VENDOR_DIR/.venv/bin/python}"
HOST="${FASTER_LIVEPORTRAIT_HOST:-127.0.0.1}"
PORT="${FASTER_LIVEPORTRAIT_PORT:-8011}"
LOCK_DIR="${TMPDIR:-/tmp}/ai-idol-fasterliveportrait-${PORT}.lock"
WORKER_PID=""
STOPPED=0

[[ -x "$PYTHON_BIN" ]] || {
  echo "FasterLivePortrait MLX runtime is missing. Run: pnpm faster-liveportrait:setup" >&2
  exit 1
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "FasterLivePortrait worker lock is busy for ${HOST}:${PORT}" >&2
  exit 73
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"

cleanup() {
  STOPPED=1
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill -TERM "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

delay_seconds=2
while true; do
  echo "Starting FasterLivePortrait MLX worker on ${HOST}:${PORT}"
  "$PYTHON_BIN" "$SERVICE_DIR/server.py" --host "$HOST" --port "$PORT" &
  WORKER_PID=$!
  set +e
  wait "$WORKER_PID"
  exit_code=$?
  set -e
  WORKER_PID=""

  [[ "$STOPPED" -eq 1 ]] && exit 0
  echo "FasterLivePortrait worker exited with ${exit_code}; restarting in ${delay_seconds}s" >&2
  sleep "$delay_seconds"
  if (( delay_seconds < 30 )); then
    delay_seconds=$((delay_seconds * 2))
  fi
done
