#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Apps launched from Finder/Dock inherit a minimal PATH and may not see the
# Node installation that is available in an interactive Terminal session.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Checked ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, and PATH." >&2
  exit 127
fi

if [[ ! -f services/runtime-server/dist/index.js ]]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm was not found and the runtime server needs to be built." >&2
    exit 127
  fi
  pnpm build
fi

exec node --env-file-if-exists=.env services/runtime-server/dist/index.js
