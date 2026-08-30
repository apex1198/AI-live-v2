#!/usr/bin/env bash
set -euo pipefail

worker_dir="$(cd "$(dirname "$0")" && pwd)"
repo_dir="$(cd "$worker_dir/../../.." && pwd)"
cd "$worker_dir"

if [[ -f "$repo_dir/.env" ]]; then
  set -a
  source "$repo_dir/.env"
  set +a
fi

model="${LIVETALKING_MODEL:-musetalk}"
avatar_id="${LIVETALKING_AVATAR_ID:-}"
port="${LIVETALKING_PORT:-8011}"
max_session="${LIVETALKING_MAX_SESSION:-1}"
stun_url="${LIVETALKING_STUN_URL:-stun:stun.l.google.com:19302}"
if [[ "$(uname -s)" == "Darwin" ]]; then
  batch_size="${LIVETALKING_BATCH_SIZE:-8}"
  fps="12.5"
  output_fps="${LIVETALKING_OUTPUT_FPS:-25}"
else
  batch_size="${LIVETALKING_BATCH_SIZE:-8}"
  fps="12.5"
  output_fps="${LIVETALKING_OUTPUT_FPS:-25}"
fi

output_fps="25"

avatar_asset="latents.pt"
if [[ "$model" != "musetalk" ]]; then
  avatar_asset="coords.pkl"
fi
if [[ -z "$avatar_id" || ! -f "data/avatars/$avatar_id/$avatar_asset" ]]; then
  for candidate in data/avatars/*/"$avatar_asset"; do
    [[ -f "$candidate" ]] || continue
    avatar_id="$(basename "$(dirname "$candidate")")"
    break
  done
fi
if [[ -z "$avatar_id" ]]; then
  echo "No trained avatar is available for model: $model"
  exit 1
fi

if [[ ! -x .venv/bin/python ]]; then
  echo "LiveTalking Python environment is missing. Run: pnpm livetalking:setup"
  exit 1
fi

if [[ "$model" == "musetalk" ]]; then
  required=(
    models/musetalkV15/unet.pth
    models/musetalkV15/musetalk.json
    models/sd-vae/config.json
    models/sd-vae/diffusion_pytorch_model.bin
    models/whisper/config.json
    models/whisper/pytorch_model.bin
    models/face-parse-bisent/79999_iter.pth
    models/face-parse-bisent/resnet18-5c106cde.pth
    "data/avatars/$avatar_id/latents.pt"
  )
else
  required=(models/wav2lip.pth "data/avatars/$avatar_id/coords.pkl")
fi

for file in "${required[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing required LiveTalking asset: $file"
    exit 1
  fi
done

export PYTORCH_ENABLE_MPS_FALLBACK=1
export PYTORCH_MPS_FAST_MATH="${PYTORCH_MPS_FAST_MATH:-1}"
export PYTORCH_MPS_PREFER_METAL="${PYTORCH_MPS_PREFER_METAL:-1}"
export LIVETALKING_HOST="${LIVETALKING_HOST:-127.0.0.1}"
export LIVETALKING_ALLOWED_MEDIA_ROOTS="${LIVETALKING_ALLOWED_MEDIA_ROOTS:-$worker_dir/data/tmp,$worker_dir/data/avatars,$repo_dir/local-projects}"
export LIVETALKING_ALLOWED_AVATAR_ROOTS="${LIVETALKING_ALLOWED_AVATAR_ROOTS:-$worker_dir/data/avatars,$repo_dir/local-projects}"
exec .venv/bin/python app.py \
  --transport webrtc \
  --model "$model" \
  --avatar_id "$avatar_id" \
  --batch_size "$batch_size" \
  --fps "$fps" \
  --output_fps "$output_fps" \
  --max_session "$max_session" \
  --stun "$stun_url" \
  --listenport "$port"
