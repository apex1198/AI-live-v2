#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
command -v node >/dev/null || { echo "Node.js 22+ is required" >&2; exit 1; }
command -v pnpm >/dev/null || corepack prepare pnpm@latest --activate
pnpm install --frozen-lockfile
pnpm build
bash services/qwen-tts/setup_macos.sh
bash services/talking-head/livetalking/setup_macos.sh
echo "Setup complete. Start AI IDOL with ./start_macos.sh"
