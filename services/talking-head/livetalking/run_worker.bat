@echo off
setlocal
cd /d "%~dp0"

if not defined LIVETALKING_MODEL set "LIVETALKING_MODEL=musetalk"
if not defined LIVETALKING_AVATAR_ID set "LIVETALKING_AVATAR_ID=musetalk_avatar1"
if not defined LIVETALKING_PORT set "LIVETALKING_PORT=8011"
if not defined LIVETALKING_BATCH_SIZE set "LIVETALKING_BATCH_SIZE=8"
if not defined LIVETALKING_MAX_SESSION set "LIVETALKING_MAX_SESSION=1"
set "LIVETALKING_FPS=12.5"
set "LIVETALKING_OUTPUT_FPS=25"
if not defined LIVETALKING_STUN_URL set "LIVETALKING_STUN_URL=stun:stun.l.google.com:19302"
if not defined LIVETALKING_HOST set "LIVETALKING_HOST=127.0.0.1"

if not exist ".venv\Scripts\python.exe" (
  echo Live avatar Python environment is missing.
  exit /b 1
)

if /I "%LIVETALKING_MODEL%"=="musetalk" (
  call :require "models\musetalkV15\unet.pth" || exit /b 1
  call :require "models\musetalkV15\musetalk.json" || exit /b 1
  call :require "models\sd-vae\config.json" || exit /b 1
  call :require "models\sd-vae\diffusion_pytorch_model.bin" || exit /b 1
  call :require "models\whisper\config.json" || exit /b 1
  call :require "models\whisper\pytorch_model.bin" || exit /b 1
  call :require "models\face-parse-bisent\79999_iter.pth" || exit /b 1
  call :require "models\face-parse-bisent\resnet18-5c106cde.pth" || exit /b 1
  call :require "data\avatars\%LIVETALKING_AVATAR_ID%\latents.pt" || exit /b 1
) else (
  call :require "models\wav2lip.pth" || exit /b 1
  call :require "data\avatars\%LIVETALKING_AVATAR_ID%\coords.pkl" || exit /b 1
)

if not defined LIVETALKING_ALLOWED_MEDIA_ROOTS set "LIVETALKING_ALLOWED_MEDIA_ROOTS=%CD%\data\tmp,%CD%\data\avatars"
if not defined LIVETALKING_ALLOWED_AVATAR_ROOTS set "LIVETALKING_ALLOWED_AVATAR_ROOTS=%CD%\data\avatars"

".venv\Scripts\python.exe" app.py ^
  --transport webrtc ^
  --model "%LIVETALKING_MODEL%" ^
  --avatar_id "%LIVETALKING_AVATAR_ID%" ^
  --batch_size "%LIVETALKING_BATCH_SIZE%" ^
  --fps "%LIVETALKING_FPS%" ^
  --output_fps "%LIVETALKING_OUTPUT_FPS%" ^
  --max_session "%LIVETALKING_MAX_SESSION%" ^
  --stun "%LIVETALKING_STUN_URL%" ^
  --listenport "%LIVETALKING_PORT%"
exit /b %ERRORLEVEL%

:require
if exist "%~1" exit /b 0
echo Missing required live avatar asset: %~1
exit /b 1
