# FasterLivePortrait MLX (V2 lipsync test)

This service adds FasterLivePortrait MLX to `AI IDOL STREAMER V2` as a queued
batch lipsync tester. It supports a portrait image or video driven by uploaded
audio or Vietnamese text, then publishes browser-safe MP4 output at
`1280x720 @ 30 FPS`.

It is intentionally separate from LiveTalking/MuseTalk WebRTC. FasterLivePortrait
MLX generates a finished video; it does not provide the persistent WebRTC avatar
session required for a live broadcast. Text mode uses the local Qwen TTS worker
to create a WAV before FasterLivePortrait runs its audio-driving path. This avoids
the current upstream MLX-audio/eSpeak packaging failure on macOS.

## Setup and run

```bash
pnpm faster-liveportrait:setup
pnpm faster-liveportrait:start
pnpm start:v2
```

Open `http://127.0.0.1:6768/faster-liveportrait-test.html`.

`start:v2` uses runtime port `6768` and engine-lock port `18761`, so it can run
beside the V1 runtime on port `6767` without requiring V1 to stop.

The setup script pins the Apple Silicon MLX upstream to:

```text
d5361f4806c14fe2051eecb1dd5a89930f46db0d
```

It downloads upstream code, the isolated Python 3.12 environment, and the
FasterLivePortrait MLX/JoyVASA weights into ignored local runtime directories.

## Reliability behavior

- One render is processed at a time to prevent concurrent MLX memory pressure.
- A failed job clears MLX memory and retries once automatically.
- Jobs in progress are recovered after the worker process restarts when an
  attempt remains; exhausted jobs are marked failed instead of remaining stuck.
- `run_worker.sh` restarts the worker with exponential backoff after a crash.
- Generated MP4s are normalized with `ffmpeg` to H.264/AAC, `1280x720`, `30 FPS`.

Useful variables:

```text
FASTER_LIVEPORTRAIT_PORT=8011
FASTER_LIVEPORTRAIT_RUNTIME_DIR=/path/to/runtime-data/faster-liveportrait
FASTER_LIVEPORTRAIT_VENDOR_DIR=/path/to/fasterliveportrait-mlx
FASTER_LIVEPORTRAIT_WEIGHTS_DIR=/path/to/checkpoints
FASTER_LIVEPORTRAIT_QWEN_TTS_ENDPOINT=http://127.0.0.1:3333
```
