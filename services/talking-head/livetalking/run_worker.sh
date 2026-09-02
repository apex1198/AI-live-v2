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
port="${LIVETALKING_PORT:-2222}"
max_session="${LIVETALKING_MAX_SESSION:-1}"
stun_url="${LIVETALKING_STUN_URL:-stun:stun.l.google.com:19302}"
if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || (( port < 1 || port > 65535 )); then
  echo "Invalid LiveTalking port: $port" >&2
  exit 64
fi

lock_parent="${TMPDIR:-/tmp}"
lock_dir="${lock_parent%/}/ai-idol-livetalking-${port}.lock"
worker_pid=""

acquire_worker_lock() {
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock_dir/pid"
    return
  fi

  local existing_pid=""
  if [[ -f "$lock_dir/pid" ]]; then
    existing_pid="$(<"$lock_dir/pid")"
  fi
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "LiveTalking worker is already running on 127.0.0.1:$port (PID $existing_pid)" >&2
    exit 73
  fi

  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "LiveTalking worker lock is busy for 127.0.0.1:$port" >&2
    exit 73
  fi
  printf '%s\n' "$$" > "$lock_dir/pid"
}

release_worker_lock() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill -TERM "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
  exit "$exit_code"
}

acquire_worker_lock
trap release_worker_lock EXIT INT TERM
if [[ "$(uname -s)" == "Darwin" ]]; then
  batch_size="${LIVETALKING_BATCH_SIZE:-4}"
  fps="${LIVETALKING_FPS:-15}"
  output_fps="${LIVETALKING_OUTPUT_FPS:-30}"
else
  batch_size="${LIVETALKING_BATCH_SIZE:-4}"
  fps="${LIVETALKING_FPS:-15}"
  output_fps="${LIVETALKING_OUTPUT_FPS:-30}"
fi
prebuffer_ms="${LIVETALKING_PREBUFFER_MS:-480}"

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

if [[ "$(uname -s)" == "Darwin" ]]; then
  .venv/bin/python scripts/dedupe_macos_ffmpeg.py
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
.venv/bin/python app.py \
  --transport webrtc \
  --model "$model" \
  --avatar_id "$avatar_id" \
  --batch_size "$batch_size" \
  --fps "$fps" \
  --output_fps "$output_fps" \
  --prebuffer_ms "$prebuffer_ms" \
  --max_session "$max_session" \
  --stun "$stun_url" \
  --listenport "$port" &
worker_pid=$!
wait "$worker_pid"
