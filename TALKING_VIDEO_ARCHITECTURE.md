# REALTIME TALKING VIDEO — ARCHITECTURE SPECIFICATION

**Document Version:** 1.0.0  
**Target System:** Hybrid AI Idol Livestream Operator System  
**Feature Scope:** Level 3 Realtime Audio-Driven Lip & Facial Synthesis Pipeline

---

## 1. High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           AI IDOL STREAM DIRECTOR                      │
│   (Event Router · State Machine · Priority Queue · Dialogue Agent)     │
└───────────────────┬─────────────────────────────────┬───────────────────┘
                    │ 1. Visual State / Clip Request  │ 2. Speech Text / Intent
                    ▼                                 ▼
┌───────────────────────────────┐     ┌───────────────────────────────────┐
│     VIDEO ASSET ROUTER        │     │         AI VOICE SERVICE          │
│  - gameplay_idle_01.mp4       │     │  - ElevenLabs Turbo v2.5 (vi)     │
│  - jackpot_reaction_01.mp4    │     │  - WebSpeech API / Local TTS      │
│  - cta_invite_01.mp4          │     │  - Output: Streaming Audio Chunks │
└───────────────┬───────────────┘     └─────────────────┬─────────────────┘
                │ Source Video Frames                   │ Streaming PCM / MP3
                └─────────────────┬─────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      TALKING VIDEO PIPELINE MANAGER                     │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Bounded Buffer Queues (Video: 4–8 frames | Audio: 100–300 ms)     │  │
│  │ A/V Clock Synchronizer (Drift Target < 80ms)                       │  │
│  │ Interruption Controller (0ms Drop on Priority Event / Cut)        │  │
│  └─────────────────────────────────┬─────────────────────────────────┘  │
│                                    ▼                                    │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                   TalkingVideoProvider Interface                  │  │
│  │      ┌─────────────────┬──────────────────┬─────────────────┐     │  │
│  │      │ MuseTalkProvider│ DuixProvider     │ NeuralMesh (Mock│     │  │
│  │      │ (GPU Worker)    │ (Avatar Worker)  │ Provider)       │     │  │
│  │      └─────────────────┴──────────────────┴─────────────────┘     │  │
│  └─────────────────────────────────┬─────────────────────────────────┘  │
└────────────────────────────────────┼────────────────────────────────────┘
                                     ▼ Composited 60FPS Video Stream
┌─────────────────────────────────────────────────────────────────────────┐
│                    MONITOR PREVIEW & OBS STUDIO OUTPUT                  │
│  - 16:9 Live Preview Display                                            │
│  - Real-time Subtitles / Karaoke Sync                                  │
│  - OBS Studio Virtual Camera / RTMP Stream Out                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Provider Abstraction Interface

All talking video engines implement the standard `TalkingVideoProvider` interface to ensure modularity, isolation, and resilience:

```typescript
export interface AudioChunk {
  pcm?: Int16Array;
  floatData?: Float32Array;
  sampleRate: number;
  timestampMs: number;
  rawBuffer?: ArrayBuffer;
}

export interface VideoFrame {
  timestampMs: number;
  width: number;
  height: number;
  data: ImageData | ImageBitmap | HTMLCanvasElement | HTMLVideoElement;
  faceROI?: { x: number; y: number; width: number; height: number };
}

export interface TalkingOptions {
  emotion?: 'happy' | 'excited' | 'surprised' | 'neutral' | 'grateful';
  speed?: number;
  vietnameseAcousticMode?: boolean;
}

export interface ProviderHealth {
  providerName: string;
  healthy: boolean;
  fps: number;
  renderLatencyMs: number;
  avDriftMs: number;
  queueDepth: number;
  droppedFrames: number;
}

export interface TalkingVideoProvider {
  initialize(sourceConfig?: Record<string, unknown>): Promise<void>;
  pushVideoFrame(frame: VideoFrame): Promise<void>;
  startSpeaking(audioStream: AsyncIterable<AudioChunk> | AudioChunk[], options?: TalkingOptions): Promise<void>;
  outputFrames(): AsyncIterable<VideoFrame>;
  interrupt(): Promise<void>;
  stopSpeaking(): Promise<void>;
  health(): Promise<ProviderHealth>;
  dispose(): Promise<void>;
}
```

---

## 3. Fallback Hierarchy (Zero Stream Downtime)

```text
Level 3: Full Neural / Mesh Face Synthesis inside moving source video
   │ (Worker crash or GPU unavailable)
   ▼
Level 2: Real-time Audio-Driven Lower-Face Viseme Overlay with Optical ROI
   │ (Rendering bottleneck)
   ▼
Level 1: Seamlessly Cut to Dedicated Speaking Avatar / Loop
   │ (Critical system error)
   ▼
Level 0: Source Gameplay Video + Audio Playback (Emergency Continuity Only)
```

---

## 4. Latency Budget & Bounded Buffering

- **First speech reaction target**: `< 600 ms`
- **A/V drift tolerance**: `< 80 ms` (frames dropped automatically if drift exceeds 120ms)
- **Bounded Buffer Size**:
  - Video Frame Ingress: `6 frames` (approx 100ms at 60fps)
  - Audio Ingress: `200 ms` PCM chunk window
