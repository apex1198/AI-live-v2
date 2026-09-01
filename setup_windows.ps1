param([string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128")
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 22+ is required." }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { corepack enable; corepack prepare pnpm@latest --activate }
pnpm install --frozen-lockfile
pnpm build
& "$Root\services\qwen-tts\setup_windows.ps1" -TorchIndexUrl $TorchIndexUrl
& "$Root\services\talking-head\livetalking\setup_windows.ps1" -TorchIndexUrl $TorchIndexUrl
Write-Host "Setup complete. Start AI IDOL with .\start_windows.ps1"
