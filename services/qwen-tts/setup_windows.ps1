param(
  [string]$Python = "py",
  [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128"
)
$ErrorActionPreference = "Stop"
$ServiceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Resolve-Path (Join-Path $ServiceDir "..\..")).Path
$RuntimeRoot = if ($env:QWEN_TTS_RUNTIME_DIR) { $env:QWEN_TTS_RUNTIME_DIR } else { Join-Path $WorkspaceRoot "runtime-data\qwen-tts" }
$VenvPython = Join-Path $RuntimeRoot ".venv\Scripts\python.exe"
$ModelPath = Join-Path $RuntimeRoot "gwen-tts-0.6B"

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
if ($Python -eq "py") { & py -3.12 -m venv (Join-Path $RuntimeRoot ".venv") }
else { & $Python -m venv (Join-Path $RuntimeRoot ".venv") }
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install torch torchvision torchaudio --index-url $TorchIndexUrl
& $VenvPython -m pip install --upgrade qwen-tts fastapi uvicorn python-multipart soundfile huggingface-hub
& $VenvPython -c "import torch; assert torch.cuda.is_available(), 'CUDA is unavailable. Install an NVIDIA driver compatible with the selected PyTorch build.'; print('CUDA ready:', torch.cuda.get_device_name(0))"
& $VenvPython -c "from huggingface_hub import snapshot_download; snapshot_download('g-group-ai-lab/gwen-tts-0.6B', local_dir=r'$ModelPath')"
Write-Host "Qwen Vietnamese TTS is ready at $RuntimeRoot"
