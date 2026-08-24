#!/usr/bin/env bash
set -euo pipefail

model="${LIVETALKING_MODEL:-musetalk}"
avatar_id="${LIVETALKING_AVATAR_ID:-musetalk_avatar1}"

if [[ "$model" == "musetalk" ]]; then
  required=(
    /app/models/musetalkV15/unet.pth
    /app/models/musetalkV15/musetalk.json
    /app/models/sd-vae/config.json
    /app/models/sd-vae/diffusion_pytorch_model.bin
    /app/models/whisper/config.json
    /app/models/whisper/pytorch_model.bin
    /app/models/face-parse-bisent/79999_iter.pth
    /app/models/face-parse-bisent/resnet18-5c106cde.pth
    "/app/data/avatars/$avatar_id/latents.pt"
  )
else
  required=(/app/models/wav2lip.pth "/app/data/avatars/$avatar_id/coords.pkl")
fi

for asset in "${required[@]}"; do
  if [[ ! -f "$asset" ]]; then
    echo "Missing required LiveTalking volume asset: $asset" >&2
    exit 1
  fi
done

exec python3 /app/app.py \
  --transport webrtc \
  --model "$model" \
  --avatar_id "$avatar_id" \
  --batch_size "${LIVETALKING_BATCH_SIZE:-4}" \
  --max_session "${LIVETALKING_MAX_SESSION:-1}" \
  --stun "${LIVETALKING_STUN_URL:-stun:stun.l.google.com:19302}" \
  --listenport "${LIVETALKING_PORT:-8011}"
