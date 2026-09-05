# AI IDOL Streamer

One source repository for local AI livestreaming on macOS Apple Silicon and
Windows with an NVIDIA GPU. The dashboard, runtime API, OBS bridge, avatar data,
voice profiles, and HTTP contracts are shared across both platforms.

## Supported platforms

| Platform | Lipsync | Vietnamese Qwen TTS |
| --- | --- | --- |
| macOS Apple Silicon | PyTorch MPS | MLX 8-bit |
| Windows 11 + NVIDIA | PyTorch CUDA | PyTorch CUDA |

Windows CPU-only inference is intentionally not supported for live sessions.
It is too slow to provide the latency and frame rate expected by this app.

## Requirements

- Node.js 22 or newer
- pnpm 9 or newer (Corepack can install it)
- FFmpeg and FFprobe on `PATH`
- macOS: Apple Silicon and Python 3.11/3.12
- Windows: NVIDIA GPU, current NVIDIA driver, Python 3.11 and 3.12

## First setup

macOS:

```bash
chmod +x setup_macos.sh start_macos.sh
./setup_macos.sh
./start_macos.sh
```

Windows PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup_windows.ps1
.\start_windows.ps1
```

The Windows setup defaults to PyTorch CUDA 12.8 wheels. A different official
PyTorch wheel channel can be selected when required by the installed driver:

```powershell
.\setup_windows.ps1 -TorchIndexUrl https://download.pytorch.org/whl/cu126
```

Open `http://127.0.0.1:6767` after the runtime starts. The web-app shortcut
starts the runtime automatically, then keeps a startup screen visible while
Qwen TTS and the lipsync worker come online.

## Platform architecture

- `services/qwen-tts/server.py`: macOS MLX backend.
- `services/qwen-tts/server_windows.py`: Windows PyTorch/CUDA backend.
- Both expose `/api/health`, `/api/voices`, `/api/voices/clone`, and
  `/api/synthesize`.
- `services/runtime-server` chooses `.sh` or `.bat` launchers from the current
  operating system, so the dashboard uses the same API on both platforms.

Models, Python environments, secrets, generated avatars, and cloned voice audio
are machine-local and excluded from Git. Copy `runtime-data` separately only
when intentionally migrating user data between machines.

## Native single-instance runtime

The packaged Native App owns one exclusive engine session per machine:

- Opening the app again focuses the existing window instead of creating another process.
- Native and localhost runtimes compete for the same loopback engine lock on port `18760`.
- If Native is active, a localhost server exits before loading Qwen or LiveTalking.
- If localhost is active, Native reports the conflict instead of starting a second engine.
- Qwen TTS is loaded on demand by the owning runtime.
- A parent-process watchdog shuts down the runtime and its model workers if the Native shell is force-quit.

Close the running Native App before using `pnpm start`, and stop localhost before
opening Native. This keeps MPS/CUDA memory and WebRTC ownership inside one session.
