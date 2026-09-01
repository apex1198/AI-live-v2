$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
if (-not (Test-Path "services\runtime-server\dist\index.js")) { pnpm build }
node --env-file-if-exists=.env services/runtime-server/dist/index.js
