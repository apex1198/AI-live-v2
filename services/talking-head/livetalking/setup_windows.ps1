param(
  [string]$Python = "py",
  [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128"
)
$ErrorActionPreference = "Stop"
$WorkerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvDir = Join-Path $WorkerDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw "FFmpeg is required. Install it with: winget install Gyan.FFmpeg"
}
if ($Python -eq "py") { & py -3.11 -m venv $VenvDir }
else { & $Python -m venv $VenvDir }
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install torch torchvision torchaudio --index-url $TorchIndexUrl
& $VenvPython -m pip install -r (Join-Path $WorkerDir "requirements.txt") gdown huggingface_hub
& $VenvPython -c "import torch; assert torch.cuda.is_available(), 'CUDA is unavailable. MuseTalk requires an NVIDIA GPU on Windows.'; print('CUDA ready:', torch.cuda.get_device_name(0))"

$Models = Join-Path $WorkerDir "models"
New-Item -ItemType Directory -Force -Path "$Models\musetalkV15", "$Models\sd-vae", "$Models\whisper", "$Models\face-parse-bisent" | Out-Null
function Get-ModelFile([string]$Target, [string]$Url, [long]$MinimumBytes = 1) {
  if ((Test-Path $Target) -and ((Get-Item $Target).Length -ge $MinimumBytes)) { return }
  Write-Host "Downloading $(Split-Path -Leaf $Target)..."
  Invoke-WebRequest -Uri $Url -OutFile $Target
  if ((Get-Item $Target).Length -lt $MinimumBytes) { throw "Incomplete model download: $Target" }
}
Get-ModelFile "$Models\musetalkV15\musetalk.json" "https://huggingface.co/TMElyralab/MuseTalk/resolve/main/musetalkV15/musetalk.json"
Get-ModelFile "$Models\musetalkV15\unet.pth" "https://huggingface.co/TMElyralab/MuseTalk/resolve/main/musetalkV15/unet.pth" 3000000000
Get-ModelFile "$Models\sd-vae\config.json" "https://huggingface.co/stabilityai/sd-vae-ft-mse/resolve/main/config.json"
Get-ModelFile "$Models\sd-vae\diffusion_pytorch_model.bin" "https://huggingface.co/stabilityai/sd-vae-ft-mse/resolve/main/diffusion_pytorch_model.bin" 300000000
Get-ModelFile "$Models\whisper\config.json" "https://huggingface.co/openai/whisper-tiny/resolve/main/config.json"
Get-ModelFile "$Models\whisper\preprocessor_config.json" "https://huggingface.co/openai/whisper-tiny/resolve/main/preprocessor_config.json"
Get-ModelFile "$Models\whisper\pytorch_model.bin" "https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin" 140000000
& $VenvPython -m gdown "154JgKpzCPW82qINcVieuPH3fZ2e0P812" -O "$Models\face-parse-bisent\79999_iter.pth"
Get-ModelFile "$Models\face-parse-bisent\resnet18-5c106cde.pth" "https://download.pytorch.org/models/resnet18-5c106cde.pth" 44000000
$TorchHome = if ($env:TORCH_HOME) { $env:TORCH_HOME } else { Join-Path $env:USERPROFILE ".cache\torch" }
& $VenvPython (Join-Path $WorkerDir "scripts\prefetch_s3fd.py") --target (Join-Path $TorchHome "hub\checkpoints\s3fd-619a316812.pth")
Write-Host "MuseTalk and LiveTalking are ready at $WorkerDir"
