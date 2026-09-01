# LIVETALKING REALTIME DIGITAL HUMAN INTEGRATION
**Repository Reference**: [lipku/LiveTalking](https://github.com/lipku/LiveTalking)

---

## 1. Overview & Architecture

The **LiveTalking** engine (`lipku/LiveTalking`) has been injected into the **Hybrid AI Idol Livestream** system as the primary Level 3 Audio-Driven Talking Video Provider.

```text
       ┌────────────────────────────────────────────────────────┐
       │                AI IDOL STREAM DIRECTOR                 │
       │    (Gameplay Events, Chat Ingestion, Goal Engine)       │
       └──────────────────────────┬─────────────────────────────┘
                                  │ (Speech Text / Audio Stream)
                                  ▼
       ┌────────────────────────────────────────────────────────┐
       │               ELEVENLABS TURBO V2.5 / TTS               │
       │          (Native Vietnamese Audio Generation)          │
       └──────────────────────────┬─────────────────────────────┘
                                  │ (PCM Audio / Synthesized Stream)
                                  ▼
       ┌────────────────────────────────────────────────────────┐
       │             LIVETALKING REAL-TIME PIPELINE             │
       │         (services/talking-head/livetalking)            │
       │                                                        │
       │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ │
       │  │    Wav2Lip    │ │   MuseTalk    │ │    ER-NeRF    │ │
       │  │ (Ultra Fast)  │ │ (High Fidelity│ │ (3D Radiance) │ │
       │  └───────────────┘ └───────────────┘ └───────────────┘ │
       └──────────────────────────┬─────────────────────────────┘
                                  │ (Real-time Synthesized Video Stream)
                                  ▼
       ┌────────────────────────────────────────────────────────┐
       │               16:9 OPERATOR DASHBOARD / OBS            │
       │       - Video State: TALKING (Primary Speech Set)      │
       │       - Level 3 Clean Lipsync without Fake Overlays    │
       │       - Sub-50ms Low-Latency Interruption Handling     │
       └────────────────────────────────────────────────────────┘
```

---

## 2. Model Capabilities & Comparison

| Model Engine | Technology | Latency | GPU Requirements | Best For |
| :--- | :--- | :--- | :--- | :--- |
| **Wav2Lip** | 2D Neural Lip Inpainting | **30–45ms** | Modest (GTX 1660 / RTX 2060+) | Ultra-low latency, instant response |
| **MuseTalk** | Latent Diffusion / Whisper | **55–75ms** | Moderate (RTX 3070 / 4070+) | High-resolution realistic mouth sync |
| **ER-NeRF** | Efficient Radiance Fields | **40–60ms** | High (RTX 3080 / 4080+) | Photorealistic 3D head motion |
| **UltraLight** | Optimized MobileNet V3 | **20–30ms** | CPU or Light GPU | Low-resource / edge deployment |

---

## 3. Directory Layout & Module Components

```text
services/talking-head/
├── src/
│   └── index.ts                # LiveTalkingProvider, MuseTalkProvider, TalkingVideoPipeline
├── livetalking/
│   ├── livetalking_server.py   # FastAPI/aiohttp Server implementing LiveTalking protocol
│   ├── requirements.txt        # Python dependencies (PyTorch, TorchAudio, Librosa, OpenCV)
│   ├── run_livetalking.sh      # Direct bash launch script
│   └── Dockerfile              # Docker container with CUDA 11.8 support
```

---

## 4. API Endpoints

The LiveTalking server exposes the following REST & WebRTC endpoints on `http://localhost:8010`:

### `GET /health` / `GET /status`
Returns server operational status, active model, FPS, rendering latency, and drift metrics.

### `POST /speak`
Triggers real-time digital human speech.
```json
{
  "text": "Chào bạn nha! Mimi là AI Idol người Việt Nam nè!",
  "duration_ms": 3500,
  "emotion": "happy",
  "model": "wav2lip"
}
```

### `POST /interrupt`
Immediately stops the current speech utterance (<50ms latency), returning the avatar to idle.

### `POST /set_avatar`
Configures avatar background video or template loop.
```json
{
  "avatar_path": "assets/idol_idle.mp4",
  "model": "wav2lip"
}
```

### `POST /human`
Creates a WebRTC / streaming session for low-latency browser rendering.

---

## 5. How to Run LiveTalking Worker

### Option A: Local Python Environment
```bash
cd "services/talking-head/livetalking"
pip install -r requirements.txt
python3 livetalking_server.py
```

### Option B: Docker Container (with NVIDIA GPU)
```bash
cd "services/talking-head/livetalking"
docker build -t livetalking-idol .
docker run --gpus all -p 8010:8010 livetalking-idol
```

---

## 6. Integration in Operator Dashboard

1. Open **Operator Dashboard** at `http://localhost:9876`.
2. Under **AI Voice & Brain Settings**:
   * **Talking Video Engine**: Select `⚡ LiveTalking: Wav2Lip / MuseTalk (lipku/LiveTalking)`.
   * **Server URL**: `http://localhost:8010`.
   * **Model**: Choose `Wav2Lip`, `MuseTalk`, `ER-NeRF`, or `UltraLight`.
3. When sending chat messages or triggering game wins/jackpots, speech is routed directly to the LiveTalking engine and the `TALKING` video set.
