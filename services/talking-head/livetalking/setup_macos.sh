#!/usr/bin/env bash
set -euo pipefail

worker_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$worker_dir"
python_bin="${LIVETALKING_PYTHON:-$HOME/.local/bin/python3.11}"

command -v uv >/dev/null || { echo "uv is required"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required"; exit 1; }
[[ -x "$python_bin" ]] || { echo "Python 3.11 not found at $python_bin"; exit 1; }

uv venv --python "$python_bin" .venv
uv pip install --python .venv/bin/python torch torchvision torchaudio
uv pip install --python .venv/bin/python -r requirements.txt gdown huggingface_hub

mkdir -p models/musetalkV15 models/sd-vae models/whisper models/face-parse-bisent

download() {
  local target="$1"
  local url="$2"
  local minimum_bytes="${3:-1}"
  local current_bytes=0
  [[ -f "$target" ]] && current_bytes="$(stat -f %z "$target")"
  (( current_bytes >= minimum_bytes )) && return 0
  curl -fL --retry 5 --retry-delay 2 -C - -o "$target" "$url"
}

download models/musetalkV15/musetalk.json \
  https://huggingface.co/TMElyralab/MuseTalk/resolve/main/musetalkV15/musetalk.json
download models/musetalkV15/unet.pth \
  https://huggingface.co/TMElyralab/MuseTalk/resolve/main/musetalkV15/unet.pth 3000000000
download models/sd-vae/config.json \
  https://huggingface.co/stabilityai/sd-vae-ft-mse/resolve/main/config.json
download models/sd-vae/diffusion_pytorch_model.bin \
  https://huggingface.co/stabilityai/sd-vae-ft-mse/resolve/main/diffusion_pytorch_model.bin 300000000
download models/whisper/config.json \
  https://huggingface.co/openai/whisper-tiny/resolve/main/config.json
download models/whisper/preprocessor_config.json \
  https://huggingface.co/openai/whisper-tiny/resolve/main/preprocessor_config.json
download models/whisper/pytorch_model.bin \
  https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin 140000000
download models/face-parse-bisent/79999_iter.pth \
  'https://drive.google.com/uc?export=download&id=154JgKpzCPW82qINcVieuPH3fZ2e0P812' 50000000
download models/face-parse-bisent/resnet18-5c106cde.pth \
  https://download.pytorch.org/models/resnet18-5c106cde.pth 44000000

echo "LiveTalking dependencies and MuseTalk weights are ready."
