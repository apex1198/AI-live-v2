#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SERVICE_DIR/../.." && pwd)"
RUNTIME_ROOT="${QWEN_TTS_RUNTIME_DIR:-$WORKSPACE_ROOT/runtime-data/qwen-tts}"
PYTHON_BIN="${QWEN_TTS_PYTHON:-$RUNTIME_ROOT/.venv/bin/python}"
MODEL_PATH="${QWEN_TTS_MODEL_PATH:-$RUNTIME_ROOT/gwen-tts-0.6B-8bit}"
DATA_DIR="${QWEN_TTS_DATA_DIR:-$RUNTIME_ROOT/data}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Qwen TTS Python runtime is missing: $PYTHON_BIN" >&2
  exit 1
fi
if [[ ! -f "$MODEL_PATH/config.json" ]]; then
  echo "Qwen TTS model is missing: $MODEL_PATH" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
exec "$PYTHON_BIN" "$SERVICE_DIR/server.py" \
  --model "$MODEL_PATH" \
  --data-dir "$DATA_DIR" \
  --host "${QWEN_TTS_HOST:-127.0.0.1}" \
  --port "${QWEN_TTS_PORT:-3333}"
