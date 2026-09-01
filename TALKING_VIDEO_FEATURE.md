# REALTIME TALKING VIDEO — FEATURE SPEC

## 1. Goal

Build a mandatory **Level 3 Realtime Talking Video** module for the Hybrid AI Idol Livestream.

> When the AI Idol speaks, the character already visible inside the currently playing gameplay/reaction video must visibly speak in that same shot, synchronized with realtime TTS audio.

Voice-only playback over a silent character is NOT a successful implementation. Cutting to a separate talking-head shot is NOT the default solution.

## 2. Required Output

```text
SOURCE GAMEPLAY / REACTION VIDEO
              +
       REALTIME TTS AUDIO
              ↓
      TALKING VIDEO ENGINE
              ↓
 FACE / MOUTH SYNTHESIS
              ↓
 COMPOSITE INTO SOURCE FRAMES
              ↓
 SAME IDOL + SAME SHOT + SAME BODY MOTION
              ↓
             OBS
```

Normal:
```text
Idol playing game → no dialogue → original video
```

Viewer chat:
```text
Chat → Dialogue Agent → TTS
                         +
                  Current video
                         ↓
                 Talking Engine
                         ↓
          Idol visibly speaks while playing
```

Game reaction:
```text
JACKPOT → celebration body clip
                    +
             excited TTS
                    ↓
             Talking Engine
                    ↓
       Idol celebrates AND speaks
```

## 3. Hard Acceptance Rule

FAIL:
```text
gameplay.mp4 + tts.wav
```

FAIL:
```text
gameplay → cut to portrait talking head → gameplay
```

PASS:
```text
moving gameplay frames
+
TTS audio
+
audio-driven facial synthesis
=
same character visibly speaking in the moving source video
```

## 4. Runtime Modes

### IDLE
Source video passes through normally.

### SPEAKING
Current source video + streaming TTS → synthesized speaking frames.

### REACTION_SPEAKING
Prepared body/reaction clip + streaming TTS → reaction where the character also speaks.

## 5. Rendering Principle

Do not regenerate the entire frame if avoidable.

```text
Original Frame
 ├─ Body       → preserve
 ├─ Background → preserve
 ├─ Game/UI    → preserve
 └─ Face ROI
       ↓
 Audio-driven model
       ↓
 Composite face back into original frame
```

This minimizes identity drift, flicker, body deformation, GPU load and latency.

## 6. Provider Architecture

All engines must sit behind an adapter.

```ts
interface TalkingVideoProvider {
  initialize(source: AvatarSource): Promise<void>;
  pushVideoFrame(frame: VideoFrame): Promise<void>;
  startSpeaking(audio: AsyncIterable<AudioChunk>, options: TalkingOptions): Promise<void>;
  outputFrames(): AsyncIterable<VideoFrame>;
  interrupt(): Promise<void>;
  stopSpeaking(): Promise<void>;
  health(): Promise<ProviderHealth>;
  dispose(): Promise<void>;
}
```

Implementations may include:

```text
MuseTalkProvider
LiveTalkingProvider
DuixProvider
Wav2LipProvider
MockTalkingProvider
```

Agent Core must never contain MuseTalk/Duix-specific logic.

## 7. Candidate Repositories

### MuseTalk
https://github.com/TMElyralab/MuseTalk

Primary candidate for audio-driven lip synchronization on moving video.

### LiveTalking
https://github.com/lipku/LiveTalking

Evaluate as a realtime orchestration layer around digital-human/lip-sync engines, especially for continuous streaming, WebRTC and interruption.

### Duix Avatar
https://github.com/duixcom/Duix-Avatar

Alternative provider to benchmark. Do not make the application dependent on it.

## 8. Source Video Requirements

Preferred:

```text
1080p+
25–30 fps
stable camera
stable lighting
face clearly visible
face large enough for synthesis
consistent identity
mostly frontal / moderate head motion
```

Avoid:

```text
tiny face
full profile for long periods
hand covering mouth
hair covering mouth
heavy motion blur
rapid cuts
extreme head rotation
large exposure changes
```

The Idol should occupy a meaningful portion of the livestream frame.

## 9. Preprocessing

Do expensive work before livestream whenever possible.

Per source clip:

```text
face detection
face tracking
landmarks
face bounding boxes
provider-specific avatar features
frame indexes
transition metadata
```

Cache example:

```text
cache/
  gameplay_idle_01/
    metadata.json
    face_track.bin
    landmarks.bin
    provider_cache/
```

Do not repeatedly preprocess the same clip every time the Idol starts talking.

## 10. Asset Metadata

Talking-compatible assets must declare support.

```yaml
id: gameplay_idle_01
file: gameplay_idle_01.mp4

talking:
  supported: true
  face_track: idol_main
  quality: high
  cache_prepared: true

loop: true
```

Asset Router must prefer `talking.supported: true` when dialogue can occur.

## 11. TTS Contract

Preferred internal audio:

```text
PCM
mono
fixed sample rate
timestamped chunks
```

Example:

```ts
type AudioChunk = {
  pcm: Int16Array;
  sampleRate: number;
  timestampMs: number;
};
```

Avoid MP3 encode/decode loops inside the realtime path.

## 12. Streaming Pipeline

Wrong:

```text
LLM finishes full answer
→ generate full WAV
→ start lip sync
```

Preferred:

```text
LLM stream
→ sentence/chunk
→ streaming TTS
→ PCM chunks
→ TalkingVideoProvider
→ speaking frames
```

Target first visible speech: `< 2 seconds` after response decision.

## 13. Hide AI Latency

Use a natural pre-speech reaction.

```text
T+0ms     chat accepted
T+100ms   LISTENING / small visual reaction
T+200ms   dialogue generation
T+500ms   first TTS chunk
T+600ms   mouth begins speaking
```

Do not freeze the character while waiting.

## 14. Audio/Video Synchronization

Maintain one timeline:

```text
session_start
audio_pts
video_pts
```

Targets:

```text
preferred A/V drift < 80 ms
maximum target < 120 ms
```

If inference falls behind, drop stale synthesized frames instead of accumulating seconds of livestream latency.

## 15. Bounded Buffers

Suggested starting point:

```text
video input: 3–8 frames
video output: 3–8 frames
audio: ~100–300 ms
```

Never use an unbounded realtime queue.

## 16. Face Tracking

```text
detect
→ lock identity
→ track
→ smooth ROI/landmarks
→ synthesize
→ composite
```

Apply temporal smoothing. Do not allow the crop to jump independently every frame.

## 17. Identity Lock

Preserve as much as possible:

```text
eyes
nose
face shape
jaw identity
hairline
skin tone
makeup
```

Only the necessary speaking region should change.

Reject configurations with obvious identity drift.

## 18. Temporal Stability

Benchmark continuous video, not screenshots.

Inspect:

```text
mouth flicker
teeth instability
jaw flicker
face-box jitter
skin texture flicker
blend boundaries
identity changes
```

## 19. Speech End

When TTS ends:

```text
finish phoneme
→ close mouth naturally
→ short neutral settle
→ stop synthesis
→ continue original video
```

Avoid an abrupt one-frame mouth reset.

## 20. Interruption

Mandatory.

```text
AI speaking
→ Director/operator interrupt
→ cancel TTS
→ TalkingVideoProvider.interrupt()
→ mouth settles
→ next state
```

Cancelled dialogue must never keep animating.

## 21. Reaction Assets

Reaction clips should contain body acting but preferably no baked dialogue.

Example:

```text
jackpot_01.mp4:
eyes widen
smile
hands rise
body celebrates
NO fixed spoken sentence
```

Then:

```text
jackpot_01.mp4
+
"Trúng rồi!" generated at runtime
↓
TalkingVideoProvider
```

One body reaction can therefore support many contextual lines.

## 22. Director Integration

Director emits structured intent:

```json
{
  "visualState": "BIG_WIN",
  "speechIntent": "celebrate_jackpot",
  "emotion": "excited",
  "talkingRequired": true
}
```

Flow:

```text
Director
 ├─ Asset Router → source video
 └─ Dialogue Agent → TTS audio
                       │
source video ──────────┤
                       ↓
               Talking Runtime
                       ↓
                 Speaking Video
                       ↓
                      OBS
```

## 23. Fallback Levels

### Level 3 — Required production behavior
Realtime facial/lip synthesis inside moving source video.

### Level 2
Simplified audio-driven mouth/face overlay.

### Level 1
Prepared generic talking clip + realtime TTS.

### Level 0
Original gameplay + TTS only.

Level 0 is emergency continuity only. It does NOT count as completion of this feature.

## 24. Health Monitoring

Expose:

```text
provider
model loaded
GPU status
FPS
render latency
queue depth
A/V drift
dropped frames
face tracking confidence
```

Example:

```json
{
  "provider": "musetalk",
  "healthy": true,
  "fps": 28.4,
  "renderLatencyMs": 72,
  "avDriftMs": 41,
  "queueDepth": 4
}
```

## 25. Performance Targets

Prototype:

```text
25 fps minimum target
speech startup < 2 s
visual reaction < 500 ms
A/V drift < 120 ms
30 s speech without progressive desync
```

Production target where hardware permits:

```text
stable 30 fps
first speech < 1.5 s
A/V drift < 80 ms preferred
```

## 26. GPU Isolation

Talking inference must be a separate service.

```text
Desktop / Mac Runtime
 ├─ Director
 ├─ Dialogue
 ├─ Chat/Game
 ├─ TTS
 └─ OBS
       │
       │ WebRTC/WebSocket
       ▼
 Talking GPU Worker
       │
       ▼
 Speaking Video Stream
```

This permits local NVIDIA, remote NVIDIA or future Apple Silicon providers without rewriting the main app.

## 27. Worker API

Control:

```text
POST /avatar/load
POST /session/start
POST /session/interrupt
POST /session/stop
GET  /health
```

Realtime media transport:

```text
WebRTC
or
WebSocket/binary streaming
```

Do not transport raw frames as JSON HTTP requests.

## 28. OBS Responsibility

OBS receives final output and handles:

```text
scene composition
game capture
overlays
BGM
alerts
stream output
```

OBS Controller must NOT contain:

```text
face detection
lip-sync inference
MuseTalk model logic
face compositing
```

## 29. Canonical Test Asset

Create:

```text
test_gameplay.mp4
```

Requirements:

```text
15–30 seconds
Idol continuously visible
body visibly playing game
mostly frontal face
no spoken dialogue
stable camera
1080p
25/30 fps
```

## 30. Standard Test Audio

Use identical samples across providers:

```text
01_short.wav
"Hello mọi người."

02_normal.wav
"Game này vui ghê, ai muốn chơi cùng không?"

03_fast.wav

04_excited.wav

05_long_30s.wav
```

## 31. Benchmark Document

Create:

```text
TALKING_HEAD_BENCHMARK.md
```

Compare:

```text
Provider
Hardware
FPS
Startup latency
A/V sync
Identity preservation
Mouth quality
Temporal stability
VRAM
Interrupt support
Integration difficulty
License
```

Do not select a production engine only from README claims.

## 32. Mandatory Tests

### A — Basic
5-second speech while gameplay continues.

PASS: same character visibly speaks.

### B — Long
30-second speech.

PASS: no progressive A/V drift.

### C — Multi-turn
Speak → pause → speak → pause → speak.

PASS: no renderer reset artifact.

### D — Interrupt
Cancel at 2 seconds.

PASS: voice and mouth stop promptly.

### E — Reaction
BIG_WIN clip + excited TTS.

PASS: body celebrates while mouth speaks.

### F — Loop Boundary
Gameplay clip ends during speech.

PASS: no black frame, face reset or audio cut.

### G — Renderer Failure
Kill GPU worker.

PASS: livestream remains alive using fallback.

## 33. Mandatory Acceptance Checklist

- [ ] Idol visibly speaks inside the gameplay video.
- [ ] No camera cut is required for normal chat replies.
- [ ] Original body motion continues during speech.
- [ ] Background/game content remains stable.
- [ ] Mouth movement follows realtime TTS audio.
- [ ] A/V drift stays below configured threshold.
- [ ] Speech can be interrupted.
- [ ] Reaction clips can also speak.
- [ ] Runtime returns naturally to non-speaking gameplay.
- [ ] Talking-engine failure does not terminate the livestream.
- [ ] Talking provider can be replaced through an adapter.
- [ ] Voice-only playback is never reported as Level 3 success.

## 34. Out of Scope

Do not implement here:

```text
autonomous game playing
CTA scheduler
chat moderation
donation business logic
long-term memory
stream analytics
full-body text-to-video generation
```

This module has one job:

> Make the existing Idol inside an existing moving video speak realtime.

## 35. Implementation Phases

### Phase 0 — Benchmark
Test MuseTalk, LiveTalking and Duix.

Deliver `TALKING_HEAD_BENCHMARK.md`.

### Phase 1 — Offline Proof

Input:
```text
test_gameplay.mp4
+
test_speech.wav
```

Output:
```text
test_gameplay_talking.mp4
```

Do not proceed until the same character visibly speaks.

### Phase 2 — Cached Avatar
Precompute reusable face/model data for source clips.

### Phase 3 — Streaming TTS
Replace full WAV with PCM chunks from Voice Service.

### Phase 4 — Continuous Playback
Support speaking before/during/after gameplay clip transitions.

### Phase 5 — Interrupt
Connect Director cancellation → TTS cancellation → renderer cancellation.

### Phase 6 — Reaction Assets
Make BIG_WIN, HAPPY, LOSE, INVITE etc. talking-compatible.

### Phase 7 — OBS
Route final realtime video to livestream composition.

## 36. Coding Agent Master Prompt

```text
You are implementing the Level 3 Realtime Talking Video feature for a Hybrid AI Idol Livestream application.

Read TALKING_VIDEO_FEATURE.md completely before coding.

CRITICAL REQUIREMENT:

When the AI speaks, the Idol already visible inside the currently playing gameplay/reaction video must visibly move her mouth/face in synchronization with realtime TTS audio.

Playing TTS audio over a silent gameplay video is NOT ACCEPTABLE.

Always cutting to a separate talking-head portrait is NOT ACCEPTABLE.

Required transformation:

SOURCE MOVING VIDEO
+
REALTIME TTS AUDIO
+
AUDIO-DRIVEN FACE/LIP SYNTHESIS
=
THE SAME IDOL SPEAKING INSIDE THE SAME MOVING VIDEO.

Architecture:

Source Video Frames
        +
Streaming TTS Audio
        ↓
TalkingVideoProvider
        ↓
Face/Lip Synthesis
        ↓
Composite Into Original Frames
        ↓
Output Video
        ↓
OBS

Rules:

1. Preserve original body motion.
2. Preserve original background/game content.
3. Modify only the necessary facial region.
4. All engines must use TalkingVideoProvider adapters.
5. Do not put MuseTalk-specific code in Agent Core.
6. Do not put lip-sync inference in OBS Controller.
7. Preprocess/cache reusable video assets.
8. Use bounded realtime buffers.
9. Drop stale frames instead of accumulating livestream latency.
10. Support interruption.
11. Maintain A/V timestamps.
12. Log FPS, latency, A/V drift and dropped frames.
13. Implement graceful fallback.
14. Voice-only fallback is emergency continuity and never counts as feature completion.

Research candidates:

MuseTalk:
https://github.com/TMElyralab/MuseTalk

LiveTalking:
https://github.com/lipku/LiveTalking

Duix Avatar:
https://github.com/duixcom/Duix-Avatar

FIRST MILESTONE:

Do not integrate chat, games, Stream Director or OBS automation yet.

Take:

test_gameplay.mp4
+
test_speech.wav

and produce:

test_gameplay_talking.mp4

where the SAME character from the moving input video visibly speaks the supplied audio while original body/background motion continues.

Before substantial implementation:

1. inspect repository;
2. create TALKING_HEAD_BENCHMARK.md;
3. create TALKING_VIDEO_ARCHITECTURE.md;
4. implement TalkingVideoProvider;
5. implement MockTalkingProvider;
6. benchmark candidate real providers;
7. select and implement the first real provider;
8. prove offline video+audio synthesis;
9. only then move to realtime streaming.

Do not claim completion until every mandatory acceptance criterion passes.
```

## 37. Definition of Done

```text
INPUT A
Moving video of Idol playing game

INPUT B
Realtime AI-generated voice

OUTPUT
The SAME Idol in INPUT A visibly speaks INPUT B
while the original gameplay/body motion continues.
```

If that does not happen, this feature is not done.
