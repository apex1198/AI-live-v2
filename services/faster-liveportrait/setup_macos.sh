#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SERVICE_DIR/../.." && pwd)"
UV_BIN="${UV_BIN:-$HOME/.local/bin/uv}"
PYTHON_BIN="${FASTER_LIVEPORTRAIT_PYTHON:-$HOME/.local/bin/python3.12}"
VENDOR_DIR="${FASTER_LIVEPORTRAIT_VENDOR_DIR:-$SERVICE_DIR/vendor/fasterliveportrait-mlx}"
RUNTIME_DIR="${FASTER_LIVEPORTRAIT_RUNTIME_DIR:-$WORKSPACE_ROOT/runtime-data/faster-liveportrait}"
WEIGHTS_DIR="${FASTER_LIVEPORTRAIT_WEIGHTS_DIR:-$RUNTIME_DIR/checkpoints}"
HF_HOME_DIR="${FASTER_LIVEPORTRAIT_HF_HOME:-$RUNTIME_DIR/huggingface}"
UPSTREAM_URL="https://github.com/ivanfioravanti/fasterliveportrait-mlx.git"
UPSTREAM_REVISION="d5361f4806c14fe2051eecb1dd5a89930f46db0d"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
[[ -x "$UV_BIN" ]] || { echo "uv is required at $UV_BIN" >&2; exit 1; }
[[ -x "$PYTHON_BIN" ]] || { echo "Python 3.12 is required at $PYTHON_BIN" >&2; exit 1; }

mkdir -p "$(dirname "$VENDOR_DIR")" "$RUNTIME_DIR" "$WEIGHTS_DIR" "$HF_HOME_DIR"

if [[ ! -d "$VENDOR_DIR/.git" ]]; then
  git clone "$UPSTREAM_URL" "$VENDOR_DIR"
fi

git -C "$VENDOR_DIR" fetch --depth 1 origin "$UPSTREAM_REVISION"
git -C "$VENDOR_DIR" checkout --detach "$UPSTREAM_REVISION"

(
  cd "$VENDOR_DIR"
  "$UV_BIN" sync --python "$PYTHON_BIN"
  export HF_HOME="$HF_HOME_DIR"
  export FLIP_CHECKPOINT_DIR="$WEIGHTS_DIR"
  "$VENDOR_DIR/.venv/bin/python" scripts/download_mlx_weights.py \
    --repo-id ivanfioravanti/FasterLivePortrait-MLX-weights \
    --checkpoints-dir "$WEIGHTS_DIR"
)

echo "FasterLivePortrait MLX is ready."
echo "Upstream revision: $UPSTREAM_REVISION"
echo "Runtime data: $RUNTIME_DIR"
