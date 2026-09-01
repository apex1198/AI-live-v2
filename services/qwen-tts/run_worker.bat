@echo off
setlocal
set "SERVICE_DIR=%~dp0"
for %%I in ("%SERVICE_DIR%\..\..") do set "WORKSPACE_ROOT=%%~fI"
if not defined QWEN_TTS_RUNTIME_DIR set "QWEN_TTS_RUNTIME_DIR=%WORKSPACE_ROOT%\runtime-data\qwen-tts"
if not defined QWEN_TTS_PYTHON set "QWEN_TTS_PYTHON=%QWEN_TTS_RUNTIME_DIR%\.venv\Scripts\python.exe"
if not defined QWEN_TTS_MODEL_PATH set "QWEN_TTS_MODEL_PATH=%QWEN_TTS_RUNTIME_DIR%\gwen-tts-0.6B"
if not defined QWEN_TTS_DATA_DIR set "QWEN_TTS_DATA_DIR=%QWEN_TTS_RUNTIME_DIR%\data"
if not defined QWEN_TTS_HOST set "QWEN_TTS_HOST=127.0.0.1"
if not defined QWEN_TTS_PORT set "QWEN_TTS_PORT=8002"

if not exist "%QWEN_TTS_PYTHON%" (
  echo Qwen TTS Python runtime is missing: %QWEN_TTS_PYTHON%
  exit /b 1
)
if not exist "%QWEN_TTS_MODEL_PATH%\config.json" (
  echo Qwen TTS model is missing: %QWEN_TTS_MODEL_PATH%
  exit /b 1
)
if not exist "%QWEN_TTS_DATA_DIR%" mkdir "%QWEN_TTS_DATA_DIR%"

"%QWEN_TTS_PYTHON%" "%SERVICE_DIR%server_windows.py" --model "%QWEN_TTS_MODEL_PATH%" --data-dir "%QWEN_TTS_DATA_DIR%" --host "%QWEN_TTS_HOST%" --port "%QWEN_TTS_PORT%"
exit /b %ERRORLEVEL%
