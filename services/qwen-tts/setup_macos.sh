#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SERVICE_DIR/../.." && pwd)"
RUNTIME_ROOT="${QWEN_TTS_RUNTIME_DIR:-$WORKSPACE_ROOT/runtime-data/qwen-tts}"
UV_BIN="${UV_BIN:-$HOME/.local/bin/uv}"
SOURCE_MODEL="g-group-ai-lab/gwen-tts-0.6B"
MODEL_PATH="$RUNTIME_ROOT/gwen-tts-0.6B-8bit"

mkdir -p "$RUNTIME_ROOT"
"$UV_BIN" venv --python 3.12 "$RUNTIME_ROOT/.venv"
"$UV_BIN" pip install --python "$RUNTIME_ROOT/.venv/bin/python" \
  "mlx-audio==0.5.0" fastapi uvicorn python-multipart soundfile huggingface-hub
HF_HUB_DISABLE_XET=1 "$RUNTIME_ROOT/.venv/bin/python" -m mlx_audio.convert \
  --hf-path "$SOURCE_MODEL" \
  --mlx-path "$MODEL_PATH" \
  --quantize \
  --q-bits 8 \
  --q-group-size 64 \
  --model-domain tts

echo "Qwen Vietnamese TTS is installed at $RUNTIME_ROOT"
