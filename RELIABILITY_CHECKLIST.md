# AI IDOL Streamer Reliability Checklist

Last audited: 2026-08-31

This checklist defines the expected behavior for the local AI IDOL pipeline. An item is complete only when the failure is handled explicitly and covered by an automated test or a repeatable manual check.

## Release Gate

- [x] TypeScript runtime builds without errors.
- [x] Dashboard, WebRTC receiver, and API clients pass JavaScript syntax checks.
- [x] Runtime/API/system audit passes 215 checks.
- [x] LiveTalking Python audit passes 36 checks.
- [x] A chat batch creates exactly one `SpeechCommand`.
- [x] Speech follows `GENERATING -> SPEAKING -> IDLE`.
- [x] Runtime does not report successful speech without a playable audio track and decoded video frames.
- [ ] Perform one real 10-minute OBS soak test after changing model, codec, or media settings.

## Startup And Service Ownership

- [x] Runtime refuses a duplicate server on the same port with a clear error.
- [x] Concurrent LiveTalking start requests converge on one worker.
- [x] Qwen TTS reuses a healthy process and starts locally only when first needed.
- [x] Runtime shuts down only Qwen/LiveTalking processes that it owns.
- [x] Manual Stop disables automatic worker restart.
- [x] Always On restores the worker without spawning duplicate instances.
- [x] Worker restart is deferred during training, speech, or an active Live Monitor session.
- [x] Worker restart invalidates the old WebRTC session.

## Live Monitor And WebRTC

- [x] Exactly one Dashboard tab owns the Live Monitor.
- [x] A second tab is standby and receives HTTP 409 if it attempts an offer.
- [x] Duplicated tabs use different client IDs.
- [x] Reloading a tab cannot reuse stale audio/video track state.
- [x] Owner disconnect promotes one standby tab.
- [x] Owner heartbeat timeout promotes standby even when the stale socket still appears open.
- [x] Receiver waits for both audio and video tracks before reporting connected.
- [x] Receiver reports connection state, audio packets, and decoded video frames every two seconds.
- [x] A connected track with no new decoded frames is reset automatically.
- [x] Local audio/video elements are cleared before the backend session-delete request.
- [x] Browser autoplay rejection produces an actionable error instead of silent speech.
- [x] Transient disconnect is probed before replacing a viable session.

## Speech And Lip Sync

- [x] Speech waits for a media-ready Live Monitor before TTS upload.
- [x] Qwen failure falls back without leaving runtime stuck in `GENERATING`.
- [x] Interrupt clears queued audio, video, playback gates, and subtitles.
- [x] Audio and video open from one shared prebuffer boundary.
- [x] 12.5 FPS inference is paced to 25/30 FPS without cumulative drift.
- [x] Saturated queues drop matching audio/video work rather than desynchronizing them.
- [x] Starvation rebases timestamps instead of producing a catch-up burst.
- [x] Talking finishes before returning to Idle.
- [x] Idle finishes before queued Talking begins unless the operator explicitly skips.
- [x] Failed worker status polling after playback still returns the app to Idle.
- [x] Lip color correction moves generated chroma toward the source mouth color.
- [x] Blend masks preserve upper-face detail and smooth color correction over time.

## Chat And Director

- [x] YouTube and Facebook messages enter one normalized chat queue.
- [x] Source labels remain `[YT]` and `[FB]`.
- [x] Filtering happens before Director/TTS.
- [x] A short batch is converted into one response and one speech command.
- [x] Replies use the active AI Profile name and persona.
- [x] Startup migrates a legacy Mimi system prompt to the active profile name.
- [x] Replies remove icons and normalize codes such as `AK47` for Vietnamese speech.
- [x] Fixed meta phrases such as "da doc het cau hoi" are removed.
- [x] Replies target an 8-12 second speaking budget.
- [x] Provider identity is present in Director intent and speech state.

## Avatar Training And Library

- [x] Training reports a human-readable preparation stage before face detection.
- [x] Training uses a bounded preprocessing resolution.
- [x] Training reuses the inference VAE instead of retaining a second copy.
- [x] Training defaults to a 20 percent duty cycle while live inference is active.
- [x] Active avatar state stores exactly one profile with multiple emotion-state variants.
- [x] Deleting an avatar clears SQLite, project files, source uploads, and active session state.
- [x] Repeated deletion remains safe.
- [x] Renaming an avatar persists after reload.
- [x] Worker sessions are released even if peer close hangs.
- [x] Pending replaced sessions cannot resurrect after preprocessing completes.

## OBS Output

- [x] Magic Connect creates one assigned Dashboard publisher per OBS receiver.
- [x] Signaling is isolated to its publisher/receiver pair.
- [x] OBS receives one continuous Monitor stream containing video and voice.
- [x] A silent audio track keeps the OBS source shape stable while Idle.
- [x] OBS reconnect uses bounded exponential backoff and throttled error logging.
- [x] Turning Auto Connect off cancels a pending reconnect timer.
- [x] The release gate rebuilds OBS Controller before starting the runtime.
- [x] Library loops overlap two decoded frames by default.
- [x] Idle and Talking assets use one selected output contract: HD 1280 x 720 or FHD 1920 x 1080, both at 30 FPS.
- [ ] Confirm Browser Source hardware acceleration and 30 FPS in a real OBS session.
- [ ] Confirm no `Waiting for media` event during a 10-minute Idle/Talking soak test.

## Storage, API, And Security

- [x] Uploads are isolated by avatar ID and cannot overwrite matching filenames.
- [x] Project writes replace files atomically.
- [x] Paths outside the active project are rejected.
- [x] Provider secrets are redacted from settings responses.
- [x] Browser attempts to submit provider secrets are rejected.
- [x] OAuth tokens are not included in public platform-chat state.
- [x] Runtime binds locally unless authentication explicitly protects a public bind.
- [x] WebSocket, CORS, body-size, and model-tag validation are enforced.

## Known Environment Risk

- [ ] On the current macOS environment, OpenCV and PyAV load different bundled FFmpeg `libavdevice` versions. Functional tests pass, but the dependency images should be rebuilt against one FFmpeg family before public distribution to remove the native duplicate-class warning.
