#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
[[ -f services/runtime-server/dist/index.js ]] || pnpm build
exec node --env-file-if-exists=.env services/runtime-server/dist/index.js
