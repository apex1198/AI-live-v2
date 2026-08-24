# HYBRID AI IDOL LIVESTREAM — AGENT BUILD PLAN

## 0. Product Goal

Build a **Hybrid AI Idol Livestream System**.

This is **not** a fully generative VTuber where every frame is rendered in real time.

The final output is a hybrid of:

1. **Pre-generated / pre-recorded video assets** for visual quality and stability.
2. **Realtime AI voice** for chat interaction.
3. **Event-triggered reaction clips** for game events such as winning, losing, jackpot, surprise, celebration.
4. **Goal-driven Director Agent** that proactively runs a livestream script: invite viewers to play, react to game state, create hooks, perform CTA, fill dead air, and return naturally to gameplay.

Primary design principle:

> Keep the idol visually premium through curated video assets, while AI controls WHEN to speak, react, switch states, and pursue livestream goals.

The AI does not need to generate a new video every time it responds.

---

# 1. Target User Experience

Example stream:

```text
Idol is continuously playing game
        ↓
Viewer watches normal gameplay/idle loop
        ↓
Game reports JACKPOT
        ↓
Idol immediately switches to CELEBRATE clip
        ↓
AI says a context-aware celebration line
        ↓
Clip finishes
        ↓
Return seamlessly to GAMEPLAY_IDLE
```

Chat interaction:

```text
GAMEPLAY_IDLE continues
        ↓
Viewer: "Chơi game gì vậy?"
        ↓
Chat event enters Agent
        ↓
Agent decides to answer
        ↓
TTS generates voice
        ↓
Idol continues gameplay visual
        +
Voice response plays over it
        ↓
Optional TALKING overlay/reaction
        ↓
Return/continue gameplay
```

Goal-driven behavior:

```text
No important event
        ↓
Director checks livestream goals
        ↓
Goal: invite viewers to join
        ↓
Director waits for a natural opportunity
        ↓
AI generates contextual line
        ↓
Voice: invitation / CTA
        ↓
Optional INVITE reaction clip
        ↓
Cooldown
        ↓
GAMEPLAY_IDLE
```

---

# 2. Why Hybrid Instead of Fully Generative

A fully realtime realistic AI human creates unnecessary problems:

```text
GPU cost
visual instability
identity drift
lip-sync artifacts
latency
render failure
uncanny motion
complex deployment
```

Hybrid architecture moves the expensive visual work offline.

Generate high-quality idol footage beforehand.

Realtime runtime handles:

```text
event detection
decision making
voice
state selection
clip switching
OBS
chat
game integration
goals
memory
```

This produces a much more practical production system.

---

# 3. Core Architecture

```text
                 GAME EVENTS
                     │
CHAT ────────────────┤
                     │
TIMERS ──────────────┤
                     │
GOALS ───────────────┤
                     ▼
          ┌─────────────────────┐
          │     EVENT BUS       │
          └──────────┬──────────┘
                     ▼
          ┌─────────────────────┐
          │    DIRECTOR AGENT   │
          │                     │
          │ Priority            │
          │ Goals               │
          │ Context             │
          │ Cooldowns           │
          │ Stream pacing       │
          └──────┬────────┬─────┘
                 │        │
          dialogue        │ visual state
                 │        │
                 ▼        ▼
          ┌──────────┐  ┌───────────────┐
          │ VOICE AI │  │ STATE ENGINE  │
          │ STT/LLM/ │  │ Asset Router  │
          │ TTS      │  └───────┬───────┘
          └────┬─────┘          │
               │                ▼
               │        ┌────────────────┐
               │        │ VIDEO ASSETS   │
               │        │ gameplay       │
               │        │ celebrate      │
               │        │ lose           │
               │        │ invite         │
               │        │ reaction       │
               │        └───────┬────────┘
               │                │
               └────────┬───────┘
                        ▼
                     COMPOSITOR
                        │
                        ▼
                       OBS
                        │
                        ▼
               TikTok / YouTube
```

---

# 4. Key Change From Previous Plan

Do **not** make realtime avatar rendering the center of the system.

Previous concept:

```text
AI Voice
   ↓
Realtime Avatar
   ↓
OBS
```

New concept:

```text
                  ┌─ Pre-generated Gameplay Video
                  │
AI Director ──────┼─ Pre-generated Reaction Video
                  │
                  ├─ Realtime Voice
                  │
                  └─ Overlay / Effects / UI
                             ↓
                            OBS
```

The main product is therefore an:

> **AI-controlled realtime video state machine.**

---

# 5. Visual State Machine

Minimum states:

```text
BOOT
GAMEPLAY_IDLE
GAMEPLAY_FOCUS
LISTENING
TALKING
HAPPY
BIG_WIN
JACKPOT
LOSE
SURPRISED
LAUGH
INVITE_PLAY
CTA
THANK_DONATION
AFK
RECOVERY
```

Not every state requires a unique avatar technology.

Most states can simply point to prepared video assets.

---

# 6. State Priority

Events must have deterministic priority.

Recommended:

```text
P0 EMERGENCY / OPERATOR
P1 BIG_WIN / JACKPOT
P2 DONATION
P3 DIRECT CHAT RESPONSE
P4 GAME REACTION
P5 SCRIPTED GOAL
P6 PROACTIVE CONVERSATION
P7 IDLE
```

Example:

```text
AI is performing CTA
        ↓
JACKPOT occurs
        ↓
Cancel/pause CTA
        ↓
BIG_WIN state
        ↓
Celebrate
        ↓
Return to normal stream
        ↓
CTA may be rescheduled later
```

Do not let the LLM decide event priority freely.

Priority belongs to deterministic application logic.

---

# 7. Video Asset System

Organize assets by semantic state.

```text
assets/
  idol_01/
    gameplay/
      idle_01.mp4
      idle_02.mp4
      idle_03.mp4

    reactions/
      happy_01.mp4
      happy_02.mp4
      surprise_01.mp4
      laugh_01.mp4

    game/
      big_win_01.mp4
      jackpot_01.mp4
      lose_01.mp4

    goals/
      invite_play_01.mp4
      cta_soft_01.mp4
      cta_hard_01.mp4

    transitions/
      gameplay_to_reaction.mp4
      reaction_to_gameplay.mp4
```

---

# 8. Asset Metadata

Every clip must have metadata.

Example:

```yaml
id: jackpot_01

state: BIG_WIN

file: jackpot_01.mp4

duration_ms: 5200

loop: false

interruptible: false

audio:
  embedded: false

voice:
  allowed: true

transition:
  enter: cut
  exit: gameplay_idle

tags:
  - jackpot
  - celebration
  - high_energy

cooldown_ms: 20000
```

This lets the Agent reason about semantics without touching video files directly.

---

# 9. Critical Asset Rule — Voice-Free Master

Reaction/gameplay master clips should normally contain:

```text
NO spoken dialogue
NO fixed voice
NO baked CTA
```

Keep:

```text
body movement
facial reaction
game interaction
ambient movement
optional game SFX
```

Realtime AI voice is mixed separately.

This allows the same clip to support unlimited dialogue.

---

# 10. Gameplay Idle

The main visual state is:

```text
GAMEPLAY_IDLE
```

This is not one obvious 10-second loop.

Prepare multiple long clips.

Recommended prototype:

```text
6–12 gameplay clips
30–120 seconds each
```

Randomize safely:

```text
idle_01
idle_04
idle_02
idle_06
...
```

Avoid immediate repetition.

---

# 11. Seamless Loop Strategy

For gameplay footage, prioritize:

```text
stable camera
consistent character position
consistent lighting
consistent costume
consistent game UI/layout
neutral beginning/end pose
```

Possible transition strategies:

```text
hard cut during game motion
short dissolve
match-action cut
camera-cover transition
UI overlay transition
```

Do not require every video to loop frame-perfectly.

Use a playlist of compatible clips.

---

# 12. Game Event Integration

Preferred architecture:

```text
GAME
 ↓
Game Adapter
 ↓
Normalized Game Event
 ↓
Event Bus
```

Example:

```json
{
  "type": "game.reward",
  "level": "jackpot",
  "value": 5000,
  "currency": "coin",
  "timestamp": 123456
}
```

Then:

```text
Director
   ↓
BIG_WIN
   ↓
Asset Router
   ↓
jackpot_02.mp4
```

---

# 13. Never Let the LLM Detect Critical Game Events If an API Exists

Correct:

```text
Game API
→ jackpot event
→ Director
```

Avoid:

```text
Screen
→ Vision LLM
→ "I think this might be a jackpot"
```

Use computer vision only when structured game telemetry/API is unavailable.

---

# 14. Game Adapter Interface

```ts
interface GameAdapter {
  connect(): Promise<void>;
  events(): AsyncIterable<GameEvent>;
  getState(): Promise<GameState>;
  disconnect(): Promise<void>;
}
```

Normalized events:

```text
game.started
game.round.started
game.reward.small
game.reward.big
game.jackpot
game.win
game.lose
game.level_up
game.waiting
game.error
```

---

# 15. Chat Interaction

Chat is another event source.

```text
TikTok / YouTube / Twitch
            ↓
      Chat Adapter
            ↓
       Event Bus
            ↓
        Director
```

Do not answer every message.

Classify:

```text
IGNORE
ACKNOWLEDGE
ANSWER
PRIORITY_ANSWER
MODERATION
```

---

# 16. Chat Response Flow

```text
Viewer message
     ↓
Chat filter
     ↓
Context enrichment
     ↓
Director
     ↓
Should respond?
     ↓ YES
LLM response
     ↓
Streaming TTS
     ↓
Audio Mixer
     ↓
OBS
```

The gameplay video can continue while the AI speaks.

This is the cheapest and most reliable interaction mode.

---

# 17. Optional Talking Visual

For higher visual quality, add a transparent/foreground TALKING layer.

```text
GAMEPLAY VIDEO
      +
TALKING IDOL OVERLAY
      +
AI VOICE
```

Or temporarily switch:

```text
Gameplay
   ↓
Talking close-up
   ↓
Gameplay
```

Do not require dynamic lipsync for MVP.

---

# 18. Lip-Sync Levels

Support progressive quality levels.

## Level 0 — Voice Only

```text
gameplay video + AI voice
```

Fastest MVP.

## Level 1 — Generic Talking Clip

```text
looped talking animation + AI voice
```

No phoneme accuracy.

## Level 2 — Realtime Mouth Overlay

Drive mouth/face layer from audio amplitude/viseme.

## Level 3 — Realtime Talking Head

MuseTalk / Duix / equivalent.

Only implement Level 3 after product behavior works.

---

# 19. Director Agent

This becomes the heart of the product.

The Director receives:

```text
game state
chat
donations
current video state
current speech state
recent dialogue
stream goals
time
cooldowns
operator commands
```

It outputs structured intent.

Example:

```json
{
  "action": "SPEAK",
  "intent": "invite_to_play",
  "emotion": "playful",
  "visual_state": "INVITE_PLAY",
  "priority": 50
}
```

---

# 20. Separate Director From Dialogue LLM

Do not ask one LLM:

> "Run the entire livestream."

Use:

```text
DIRECTOR
   ↓
Intent
   ↓
DIALOGUE GENERATOR
   ↓
Natural language
```

Example:

Director:

```json
{
  "intent": "celebrate_big_win",
  "energy": 0.95,
  "max_seconds": 6
}
```

Dialogue model:

```text
"Trời ơi, trúng thật rồi! Cái này mới đã nè!"
```

This gives much better control.

---

# 21. Goal Engine

Goals are explicit runtime objects.

Example:

```yaml
goal:
  id: invite_viewers

  objective:
    invite viewers to join the game

  priority: 40

  schedule:
    min_interval_seconds: 180
    max_interval_seconds: 420

  constraints:
    do_not_interrupt:
      - BIG_WIN
      - DONATION
      - DIRECT_CHAT

  success:
    - viewer_asks_how_to_join
    - join_link_clicked
    - game_join_event

  visual_states:
    - INVITE_PLAY

  tone:
    - playful
    - friendly
```

---

# 22. Goal Types

Support:

```text
INVITE_PLAY
EXPLAIN_GAME
BUILD_EXCITEMENT
ASK_CHAT_QUESTION
THANK_VIEWERS
FOLLOW
SHARE
JOIN
DONATE
PROMO
RETENTION
RETURN_TO_GAME
```

Goals should be configurable without changing code.

---

# 23. Goal Scheduler

The Director periodically evaluates:

```text
What is happening?
What happened recently?
Is chat active?
Is the idol already talking?
Was a CTA recently performed?
Did a high-priority game event happen?
Which goal is due?
Would executing it feel natural now?
```

Then:

```text
execute
delay
cancel
replace
```

---

# 24. Natural CTA Rule

Never run CTA only by fixed timer.

Bad:

```text
every 3 minutes
→ "Join now!"
```

Better:

```text
BIG WIN
→ excitement
→ reaction
→ conversational bridge
→ invitation
```

Example logic:

```text
game.jackpot
   ↓
celebrate
   ↓
"Thấy chưa, nãy giờ chờ đúng pha này đó."
   ↓
if CTA eligible
   ↓
"Ai muốn vào chơi cùng thì vào nha..."
```

The timing is deterministic; wording is generated.

---

# 25. Stream Script

Support a high-level show script.

Example:

```yaml
stream:
  duration_minutes: 60

  phases:

    - name: warmup
      duration: 10
      goals:
        - greet
        - explain_game

    - name: main_game
      duration: 35
      goals:
        - gameplay
        - react
        - answer_chat
        - invite_play

    - name: conversion
      duration: 10
      goals:
        - invite_play
        - CTA

    - name: closing
      duration: 5
      goals:
        - thank_viewers
        - next_stream
```

This is guidance, not a rigid timeline.

Game/chat events can interrupt it.

---

# 26. Stream Director State

Maintain:

```json
{
  "current_phase": "main_game",
  "current_visual": "GAMEPLAY_IDLE",
  "currently_speaking": false,
  "last_cta_at": 0,
  "last_chat_reply_at": 0,
  "last_big_win_at": 0,
  "chat_velocity": 12,
  "pending_goals": [],
  "active_goal": null
}
```

---

# 27. Event Arbitration

All events enter one priority queue.

Example:

```text
09:10:01 scheduled CTA
09:10:02 viewer question
09:10:03 JACKPOT
```

Execution:

```text
JACKPOT
↓
viewer question
↓
CTA delayed
```

Never execute all three simultaneously.

---

# 28. Reaction Composition

A reaction can be composed from:

```text
Visual
+
Voice
+
SFX
+
Overlay
+
OBS effect
```

Example BIG_WIN:

```text
Video: jackpot_03.mp4
Voice: generated celebration
SFX: win sting
Overlay: particles
OBS: optional zoom / frame effect
```

This gives high perceived production value without realtime video generation.

---

# 29. Voice Architecture

Use realtime TTS independent from video.

Recommended abstraction:

```ts
interface VoiceProvider {
  synthesize(text: string, options: VoiceOptions): AsyncIterable<AudioChunk>;
  cancel(): Promise<void>;
}
```

Possible providers:

```text
Qwen3-TTS
ElevenLabs
OpenAI-compatible voice
local TTS
```

Speech-to-speech is useful if microphone conversation is required.

For livestream chat-only MVP:

```text
Chat
→ LLM
→ TTS
```

is simpler.

---

# 30. Voice Emotion

Director supplies emotion.

Example:

```json
{
  "text": "Trúng rồi!",
  "emotion": "excited",
  "energy": 0.95,
  "speed": 1.08
}
```

Voice adapter maps these parameters to provider-specific controls.

---

# 31. Audio Mixer

Separate buses:

```text
GAME
VOICE
SFX
BGM
```

When AI speaks:

```text
duck GAME/BGM
play VOICE
restore GAME/BGM
```

Do not bake all audio into video.

---

# 32. OBS Integration

OBS becomes primarily the output/composition layer.

Suggested sources:

```text
GAMEPLAY_MEDIA
REACTION_MEDIA
IDOL_OVERLAY
GAME_CAPTURE
VOICE_AUDIO
GAME_AUDIO
BGM
SFX
CHAT_OVERLAY
CTA_OVERLAY
```

Use OBS WebSocket for:

```text
source visibility
media restart
scene switching
text update
audio mute/unmute
```

---

# 33. Compositor Alternative

Long term, do not require OBS for all internal switching.

Possible architecture:

```text
Internal Video Compositor
        ↓
Virtual Camera / NDI / SRT
        ↓
OBS
```

But OBS-first is faster for MVP.

---

# 34. Asset Router

Agent never chooses filenames.

Bad:

```text
LLM → play jackpot_04.mp4
```

Correct:

```text
LLM/Director → BIG_WIN
                   ↓
              Asset Router
                   ↓
           jackpot_04.mp4
```

Asset Router considers:

```text
state
tags
recent history
duration
cooldown
transition compatibility
```

---

# 35. Asset Selection

Example:

```ts
selectAsset({
  state: "BIG_WIN",
  emotion: "excited",
  avoidRecent: 3,
  maxDurationMs: 7000
})
```

Return:

```json
{
  "assetId": "jackpot_03",
  "file": "...",
  "durationMs": 5800
}
```

---

# 36. Reaction Timing

Important problem:

```text
event occurs
→ voice generation takes time
→ reaction clip starts
```

Do not wait for full voice generation.

Recommended:

```text
T+0ms     game event
T+50ms    reaction state selected
T+100ms   reaction clip starts
T+100ms   dialogue request starts
T+500ms   first TTS audio arrives
T+500ms   voice starts over reaction
```

The reaction video hides AI latency.

This is one of the biggest advantages of Hybrid architecture.

---

# 37. Response Latency Target

Game reaction:

```text
event → visual reaction < 300 ms
```

Chat:

```text
chat → decision < 300 ms
chat → first voice < 2 s
```

Goal action:

```text
not latency critical
```

---

# 38. Reaction Pre-Roll

Design reaction clips with:

```text
0–0.5s visual-only reaction
0.5s+ speaking-compatible movement
```

This creates a natural window for TTS startup.

Example:

```text
0.0 Idol notices win
0.2 eyes widen
0.5 raises hands
0.7 AI voice starts
1.0 celebration continues
```

Very useful for hiding generation latency.

---

# 39. Chat Queue

Never allow unlimited replies.

Queue:

```text
priority
timestamp
viewer importance
message quality
conversation relevance
```

Drop stale messages.

Example:

```text
max pending chat replies = 3
expire after = 20 seconds
```

---

# 40. Context Memory

Memory should include:

```text
recent game events
recent chat messages
recent answers
viewer names
recent goals
recent CTA
stream phase
recent reactions
```

This prevents:

```text
repeating the same line
repeating CTA
celebrating the same event twice
answering stale chat
```

---

# 41. Operator Control

Provide an operator dashboard.

Controls:

```text
PAUSE AI
MUTE AI
FORCE GAMEPLAY
FORCE REACTION
SKIP CLIP
TRIGGER CTA
DISABLE CTA
CHANGE GOAL
CHANGE STREAM PHASE
CLEAR CHAT QUEUE
KILL SWITCH
```

AI livestream must always be overridable.

---

# 42. Dashboard

Display:

```text
CURRENT STATE
GAMEPLAY_IDLE

ACTIVE GOAL
invite_play

CURRENT EVENT
none

CHAT QUEUE
2

VOICE
idle

NEXT GOAL CHECK
14s

LAST CTA
4m 21s

GAME
connected
```

---

# 43. Recommended Repositories

## AIRI

https://github.com/moeru-ai/airi

Use as reference for:

```text
agent architecture
event-driven integrations
memory
game integrations
realtime audio
character systems
```

Do not require AIRI's realtime avatar renderer for our output.

---

## Neuro SDK / Neuro API Reference

https://github.com/o9nn/neuro-sama

Useful architectural reference for:

```text
game → context
game → registered actions
AI → intent/action
game → result
WebSocket event protocol
```

The important lesson is to send structured game state/events to the AI instead of asking a general LLM to infer everything visually.

---

## Hugging Face Speech-to-Speech

https://github.com/huggingface/speech-to-speech

Use when realtime microphone speech interaction is needed.

For text chat → voice, a direct LLM + TTS pipeline can be simpler.

---

## OBS WebSocket

https://github.com/obsproject/obs-websocket

Use for realtime source/media/scene control.

---

## Open-LLM-VTuber

https://github.com/Open-LLM-VTuber/Open-LLM-VTuber

Use as a reference for:

```text
conversation
interruptions
character behavior
speech
streamer-style interaction
```

---

## Optional Realistic Talking Layer

Duix:

https://github.com/duixcom/Duix-Mobile

MuseTalk:

https://github.com/TMElyralab/MuseTalk

These are **optional Phase 2 components**, not MVP dependencies.

---

# 44. Revised Repository Structure

```text
hybrid-ai-streamer/

  apps/
    operator-dashboard/
    desktop-runtime/

  services/
    director/
    dialogue-agent/
    voice/
    game-gateway/
    chat-gateway/
    obs-controller/
    asset-engine/
    memory/

  packages/
    event-schema/
    state-machine/
    goal-engine/
    priority-queue/
    provider-sdk/
    asset-sdk/
    shared-types/

  characters/
    idol_01/
      character.yaml
      persona.md
      voice.yaml
      behavior.yaml
      goals.yaml

  assets/
    idol_01/
      gameplay/
      reactions/
      goals/
      transitions/

  scripts/
    stream_60min.yaml
```

---

# 45. Main Runtime Loop

Pseudo logic:

```text
while STREAMING:

    receive events

    normalize events

    push into priority queue

    if high priority event:
        interrupt lower priority activity

    Director.evaluate(
        current_state,
        events,
        goals,
        chat,
        game_state,
        cooldowns
    )

    intent = Director.next_action()

    if intent.visual_state:
        AssetEngine.transition(intent.visual_state)

    if intent.speech:
        DialogueAgent.generate(intent)
        Voice.speak()

    update memory

    update goals

    update dashboard
```

---

# 46. Example — Jackpot

```text
game.jackpot
      ↓
priority = P1
      ↓
cancel low-priority goal
      ↓
state = BIG_WIN
      ↓
play jackpot reaction clip immediately
      ↓
generate celebration dialogue
      ↓
TTS voice starts
      ↓
optional win SFX
      ↓
reaction finishes
      ↓
evaluate follow-up
      ↓
possible invite-to-play CTA
      ↓
GAMEPLAY_IDLE
```

---

# 47. Example — Viewer Chat

```text
viewer:
"Chị chơi game này lâu chưa?"

      ↓

chat classifier:
ANSWER

      ↓

Director:
priority P3
visual remains GAMEPLAY_IDLE

      ↓

Dialogue Agent:
short contextual answer

      ↓

TTS

      ↓

gameplay continues
+
voice response

      ↓

memory records viewer/topic
```

No reaction video is required.

---

# 48. Example — Goal: Invite to Play

```text
Goal Engine:
INVITE_PLAY is due

      ↓

Director checks:

no jackpot
no donation
not currently replying
CTA cooldown passed
chat state suitable

      ↓

visual state:
INVITE_PLAY

      ↓

Dialogue Agent receives:

goal = invite viewers
tone = playful
context = recent game event
max speech = 8 sec

      ↓

TTS

      ↓

CTA overlay optionally appears

      ↓

goal enters cooldown

      ↓

GAMEPLAY_IDLE
```

---

# 49. Recommended Asset Set for First Prototype

Do not create hundreds of videos.

Start with:

```text
GAMEPLAY_IDLE      x 6
HAPPY              x 2
BIG_WIN            x 3
LOSE               x 2
SURPRISED          x 2
LAUGH              x 2
INVITE_PLAY        x 2
CTA                 x 2
THANK               x 2
```

Total:

```text
23 clips
```

Enough to validate the system.

---

# 50. MVP

MVP is successful when:

```text
1. Gameplay video can run continuously.

2. Runtime can switch between multiple gameplay clips without stopping stream.

3. Simulated JACKPOT event causes a reaction clip immediately.

4. AI generates a context-aware celebration voice line.

5. Viewer chat enters the system.

6. AI selectively answers chat using realtime voice.

7. Gameplay continues while normal chat voice is playing.

8. Goal Engine can trigger INVITE_PLAY.

9. High-priority events interrupt low-priority goals.

10. System returns to gameplay automatically.

11. OBS is controlled through WebSocket.

12. Operator can override all automation.
```

No realtime realistic avatar is required.

No autonomous game playing is required.

---

# 51. Phase 1 — Hybrid Playback Engine

Build:

```text
Asset Library
State Machine
Asset Router
OBS Controller
Event Bus
```

Test with fake events.

No AI required yet.

Acceptance:

```text
IDLE
→ JACKPOT
→ BIG_WIN
→ IDLE

IDLE
→ INVITE
→ IDLE
```

must work for one hour without playback failure.

---

# 52. Phase 2 — Voice

Add:

```text
LLM
TTS
audio ducking
dialogue context
```

Test:

```text
fake jackpot
→ reaction video
→ generated voice
```

and:

```text
fake chat
→ generated answer
→ voice
```

---

# 53. Phase 3 — Director + Goal Engine

Add:

```text
priority arbitration
goals
cooldowns
stream phases
proactive behavior
```

Test with a simulated 60-minute stream.

---

# 54. Phase 4 — Real Game Integration

Connect game telemetry/API.

Do not begin with computer vision unless necessary.

Map game-specific events into generic events.

Example:

```text
provider-specific "reward_type=mega"
               ↓
         game.jackpot
```

---

# 55. Phase 5 — Real Chat

Connect:

```text
YouTube
Twitch
TikTok
```

through separate adapters.

Implement:

```text
spam filtering
message scoring
queue expiry
moderation hooks
```

---

# 56. Phase 6 — Visual Upgrade

Only after livestream logic is proven.

Possible improvements:

```text
talking overlay
audio-driven mouth
Duix
MuseTalk
dynamic camera
generative reaction clips
```

Do not block product development on these.

---

# 57. Coding Rules

## Rule 1

The LLM never chooses raw video filenames.

## Rule 2

The LLM never owns event priority.

## Rule 3

The LLM never owns CTA frequency.

## Rule 4

The LLM generates language and high-level intent.

## Rule 5

Deterministic application code controls timing, playback, permissions, cooldowns, and transitions.

## Rule 6

Game events should be structured whenever possible.

## Rule 7

Visual reaction must start before waiting for TTS.

## Rule 8

Every state must define a fallback.

## Rule 9

GAMEPLAY_IDLE is the universal safe fallback.

## Rule 10

The stream must continue even if the LLM/TTS service temporarily fails.

---

# 58. Failure Strategy

If LLM fails:

```text
continue gameplay
```

If TTS fails:

```text
continue gameplay
skip voice
```

If reaction clip fails:

```text
fallback to gameplay
```

If game connection fails:

```text
gameplay visual continues
Director disables game-dependent goals
```

If chat fails:

```text
gameplay + scripted goals continue
```

The stream should almost never go black.

---

# 59. Coding Agent Goal

> Build a fault-tolerant Hybrid AI Idol Livestream runtime that combines continuous pre-generated gameplay footage, event-triggered reaction videos, realtime AI voice interaction, and a deterministic goal-driven Stream Director.

The system must prioritize:

```text
visual stability
low reaction latency
natural conversation
goal control
operator control
modularity
```

over fully generative visuals.

---

# 60. Master Prompt for Coding Agent

```text
You are the lead engineer for a Hybrid AI Idol Livestream platform.

Read this PLAN completely before coding.

PRODUCT MODEL

The visual output is HYBRID.

The idol does NOT need to be rendered as a fully realtime AI avatar.

Normal livestream state:
- curated/pre-generated video footage of the idol continuously playing a game.

Realtime interaction:
- viewer chat enters the Agent;
- Agent decides whether to respond;
- dialogue is generated;
- TTS speaks over the gameplay footage;
- an optional talking/reaction visual can be triggered.

Game reactions:
- game telemetry/API produces structured events;
- high-priority events such as JACKPOT immediately trigger a prepared reaction clip;
- voice dialogue is generated concurrently;
- the visual reaction must not wait for the LLM/TTS.

Goal behavior:
- a deterministic Goal Engine tells the Director what business/content goal should be pursued;
- examples: invite viewers to play, ask chat a question, explain the game, perform CTA, thank viewers;
- the LLM generates natural wording but does NOT decide CTA frequency or event priority.

CORE ARCHITECTURE

Event Sources
→ Event Bus
→ Priority Queue
→ Stream Director
→ State Machine
→ Asset Router
→ OBS

and

Stream Director
→ Dialogue Agent
→ TTS
→ Audio Mixer
→ OBS

ARCHITECTURE RULES

1. GAMEPLAY_IDLE is the default safe state.
2. LLM must never choose raw media filenames.
3. LLM must never control event priority.
4. LLM must never control CTA frequency.
5. All video selection goes through Asset Router.
6. All game integrations emit normalized structured events.
7. Critical game events use deterministic priority.
8. Visual reactions begin immediately and do not wait for generated voice.
9. All goals have cooldowns and interruption rules.
10. The stream must continue if AI services fail.
11. Operator controls override AI at all times.
12. All integrations use adapters.

FIRST MILESTONE

Do NOT implement a realistic realtime avatar.

Build only:

- Event schemas
- State Machine
- Asset Library
- Asset metadata
- Asset Router
- Priority Queue
- Goal Engine skeleton
- OBS WebSocket controller
- Mock Game Adapter
- Mock Chat Adapter
- Operator debug panel

Create a simulated demo:

A. Start GAMEPLAY_IDLE.

B. Inject viewer chat.
Gameplay must continue.

C. Inject JACKPOT.
Immediately switch to BIG_WIN clip.

D. When reaction ends, return to GAMEPLAY_IDLE.

E. Trigger INVITE_PLAY goal.
Switch to appropriate visual and return to gameplay.

F. Inject JACKPOT during INVITE_PLAY.
JACKPOT must interrupt the goal.

Before implementation:

1. inspect repository;
2. create ARCHITECTURE.md;
3. create EVENT_SCHEMA.md;
4. create ASSET_SPEC.md;
5. create TODO.md;
6. create the minimal vertical slice.

Do not add game-playing AI, computer vision, MuseTalk, Duix, or other heavy avatar inference until this vertical slice is reliable for a continuous one-hour simulated stream.
```

---

# 61. Recommended Development Order

```text
01 Event Schema
02 Video State Machine
03 Asset Metadata
04 Asset Router
05 OBS Controller
06 Mock Event Simulator
07 Priority Queue
08 Goal Engine
09 Director
10 LLM Dialogue
11 TTS
12 Chat
13 Game API
14 Memory
15 Operator Dashboard
16 Production Livestream Test
17 Talking Visual Upgrade
18 Optional Realtime Avatar
```

---

# 62. Final Product Model

Think of the product as:

```text
             AI DIRECTOR
                  │
      ┌───────────┼───────────┐
      │           │           │
     GAME        CHAT        GOALS
      │           │           │
      └───────────┼───────────┘
                  ↓
             DECISION
                  │
       ┌──────────┴──────────┐
       ↓                     ↓
   VISUAL STATE            DIALOGUE
       ↓                     ↓
 Prepared Video              TTS
       │                     │
       └──────────┬──────────┘
                  ↓
                 OBS
                  ↓
             LIVESTREAM
```

This is the core architecture.

The AI is primarily the **director, personality, dialogue generator, and decision layer**.

The prepared footage is the **body**.

Realtime TTS is the **voice**.

Game/chat integrations are the **senses**.

The Goal Engine is the **showrunner/business logic**.
