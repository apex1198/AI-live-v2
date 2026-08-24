#!/usr/bin/env bash
set -euo pipefail

worker_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$worker_dir"

model="${LIVETALKING_MODEL:-musetalk}"
avatar_id="${LIVETALKING_AVATAR_ID:-musetalk_avatar1}"
port="${LIVETALKING_PORT:-8011}"
batch_size="${LIVETALKING_BATCH_SIZE:-4}"

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
exec .venv/bin/python app.py \
  --transport webrtc \
  --model "$model" \
  --avatar_id "$avatar_id" \
  --batch_size "$batch_size" \
  --listenport "$port"
