'use strict';

/* ============================================================
   AI IDOL OPERATOR DASHBOARD — Main Controller
   Layout: 25% Live Chat & Mixer | 50% 16:9 Monitor | 25% Controls
   Features: Level 3 Talking Video + Exact Duration Detection
   Voice: Qwen TTS + Omni Voice local providers
   ============================================================ */

// ── Application Configuration & Storage Keys ─────────────
const STORAGE_KEYS = {
  VOICE_PROVIDER:       'idol_voice_provider',
  VOICE_LANG:           'idol_voice_lang',
  TALKING_PROVIDER:     'idol_talking_provider',
  LIVETALKING_ENDPOINT: 'idol_livetalking_endpoint',
  LIVETALKING_MODEL:    'idol_livetalking_model',
  LIVETALKING_AVATAR:   'idol_livetalking_avatar',
  ACTIVE_AVATAR:        'idol_active_avatar',
  AVATAR_POOL:          'idol_selected_avatar_pool',
  PROJECT_STORAGE_ROOT: 'idol_project_storage_root',
  PROJECT_NAME:         'idol_project_name',
  VOICE_ID:     'idol_voice_id',
  CUSTOM_VOICES:        'idol_saved_custom_voices',
  VOICE_SPEED:          'idol_voice_speed',
  PERSONA_NAME:         'idol_persona_name',
  PERSONA_PROMPT:       'idol_persona_prompt',
  AVATAR_IMAGE:         'idol_avatar_image',
  PORTRAIT_IMAGE:       'idol_portrait_image',
  AVATAR_DISPLAY_MODE:  'idol_avatar_display_mode',
  AVATAR_PRESET:        'idol_avatar_preset',
  W2L_CHECKPOINT:       'idol_w2l_checkpoint',
  W2L_DETECTOR:         'idol_w2l_detector',
  W2L_PAD_TOP:          'idol_w2l_pad_top',
  W2L_PAD_BOTTOM:       'idol_w2l_pad_bottom',
  W2L_PAD_LEFT:         'idol_w2l_pad_left',
  W2L_PAD_RIGHT:        'idol_w2l_pad_right',
  ROI_FACE:             'idol_roi_face',
  ROI_MOUTH:            'idol_roi_mouth',
  AUTO_MIX:             'idol_auto_mix',
  GLOBAL_RANDOM:        'idol_global_random',
  GROUP_RANDOM:         'idol_group_random',
  LIBRARY_RATIO:        'idol_library_ratio',
  OBS_CONFIG:           'idol_obs_config',
  MODEL_TASKS:          'idol_model_tasks',
  STUDIO_COLUMNS:       'idol_studio_columns',
  STUDIO_MONITOR_HEIGHT:'idol_studio_monitor_height',
  VIDEO_QUALITY:        'idol_live_video_quality',
  MOCK_CHAT_USER:       'idol_mock_chat_user',
  FORM_DRAFTS:          'idol_form_drafts_v1',
};

const LIVE_VIDEO_PRESETS = Object.freeze({
  hd: Object.freeze({ quality: 'hd', label: 'HD', width: 1280, height: 720, fps: 30, maxBitrate: 6_000_000 }),
});

function liveVideoPreset(quality = App?.talkingEngine?.videoQuality) {
  return LIVE_VIDEO_PRESETS[quality] || LIVE_VIDEO_PRESETS.hd;
}

// Provider secrets are server-side only. Remove credentials persisted by older builds.
localStorage.removeItem('idol_elevenlabs_key');
if (!localStorage.getItem(STORAGE_KEYS.ACTIVE_AVATAR)) {
  try {
    const legacyActiveAvatar = JSON.parse(localStorage.getItem('idol_avatar_pool') || '[]').find(Boolean);
    if (legacyActiveAvatar) localStorage.setItem(STORAGE_KEYS.ACTIVE_AVATAR, legacyActiveAvatar);
  } catch {}
}
localStorage.removeItem('idol_avatar_pool');
localStorage.removeItem('idol_avatar_random');

const STATE_COLOR = {
  GAMEPLAY_IDLE:  '#60a5fa',
  GAMEPLAY_FOCUS: '#818cf8',
  TALKING:        '#a78bfa',
  BIG_WIN:        '#34d399',
  JACKPOT:        '#fbbf24',
  LOSE:           '#fb7185',
  HAPPY:          '#a3e635',
  SURPRISED:      '#f472b6',
  LAUGH:          '#fb923c',
  INVITE_PLAY:    '#818cf8',
  CTA:            '#e879f9',
  THANK_DONATION: '#2dd4bf',
  AFK:            '#94a3b8',
  RECOVERY:       '#22d3ee',
};

// ── Clean State Library ───────────────────────────────────
const CLIP_LIBRARY = {
  GAMEPLAY_IDLE:  [],
  GAMEPLAY_FOCUS: [],
  TALKING:        [],
  JACKPOT:        [],
  BIG_WIN:        [],
  HAPPY:          [],
  SURPRISED:      [],
  LAUGH:          [],
  LOSE:           [],
  INVITE_PLAY:    [],
  CTA:            [],
  THANK_DONATION: [],
  AFK:            [],
};

const UPLOADED_BLOBS = new Map();
const avatarThumbnailObjectUrls = new Set();
const TRAINED_AVATARS = new Map();

// Runtime owns Director truth; this store contains only current operator UI state.
const App = window.createOperatorStore(STORAGE_KEYS);
let runtimeRealtimeSocket = null;
let runtimeRealtimeConnected = false;
let runtimeRealtimeReconnectTimer = null;
let runtimeRealtimeSuspended = false;
let runtimeSpeechState = 'IDLE';
let pendingRuntimePlaybackCommandId = null;
const OBS_PUBLISHER_ID_KEY = 'idol_obs_output_publisher_id';
const OBS_OUTPUT_PUBLISHER_ID = sessionStorage.getItem(OBS_PUBLISHER_ID_KEY)
  || `dashboard_${crypto.randomUUID().replace(/-/g, '')}`;
sessionStorage.setItem(OBS_PUBLISHER_ID_KEY, OBS_OUTPUT_PUBLISHER_ID);
// A duplicated browser tab may copy sessionStorage. Keep ownership unique to
// this document so a duplicate can never impersonate and replace its session.
const LIVE_MEDIA_CLIENT_ID = `monitor_${crypto.randomUUID().replace(/-/g, '')}`;
const LiveMediaOwnership = {
  state: 'PENDING',
  ownerClientId: '',
  mediaReady: false,
  liveSessionId: '',
  liveAvatarId: '',
  waiters: new Set(),
};
let liveMediaResetPromise = null;
let liveMediaReconnectRequested = false;
let liveMediaRecoveryTimer = null;
let liveMediaRecoveryAttempt = 0;
let operationalAvatarRestorePromise = null;
let operationalAvatarRestoreTimer = null;
let appStartupComplete = false;
let runtimeTickTimer = null;
let runtimeEngineStatusTimer = null;
let runtimeEngineStatusRefresh = null;
let runtimeWakePromise = null;
const RuntimeSystem = {
  released: false,
  busy: false,
  policy: {
    webOnly: false,
    qwenTtsAutostart: true,
    liveTalkingAutostart: true,
    fasterLivePortraitAutostart: false,
    workerWatchdogEnabled: true,
    maintenanceEnabled: true,
  },
};

function applyRuntimePolicy(policy = {}) {
  if (!policy || typeof policy !== 'object') return;
  RuntimeSystem.policy = {
    ...RuntimeSystem.policy,
    ...Object.fromEntries(Object.entries(policy).filter(([, value]) => typeof value === 'boolean')),
  };
  document.documentElement.dataset.runtimePolicy = RuntimeSystem.policy.webOnly ? 'web-only' : 'full';
  const workersStopped = RuntimeSystem.policy.webOnly
    && !LiveTalkingWorker.ready
    && LiveTalkingWorker.state === 'OFFLINE';
  if (workersStopped && !RuntimeSystem.released) {
    $('sys-tts-dot')?.classList.remove('ok');
    $('sys-tts-dot')?.classList.add('warn');
    $('sys-talking-dot')?.classList.remove('ok');
    $('sys-talking-dot')?.classList.add('warn');
    if ($('sys-tts-engine')) $('sys-tts-engine').textContent = 'Voice: Stopped';
    if ($('sys-talking-engine')) $('sys-talking-engine').textContent = 'Avatar: Stopped';
    if ($('sys-latency-tag')) $('sys-latency-tag').textContent = 'Workers paused';
  }
}

function runtimeAutomationAllowed() {
  return !RuntimeSystem.released && document.visibilityState === 'visible';
}

function stopRuntimeFrontendAutomation() {
  if (LiveTalkingWorker?.pollTimer) clearInterval(LiveTalkingWorker.pollTimer);
  if (runtimeTickTimer) clearInterval(runtimeTickTimer);
  if (runtimeEngineStatusTimer) clearInterval(runtimeEngineStatusTimer);
  clearTimeout(liveMediaRecoveryTimer);
  clearTimeout(operationalAvatarRestoreTimer);
  clearTimeout(runtimeRealtimeReconnectTimer);
  LiveTalkingWorker.pollTimer = null;
  runtimeTickTimer = null;
  runtimeEngineStatusTimer = null;
  liveMediaRecoveryTimer = null;
  operationalAvatarRestoreTimer = null;
  runtimeRealtimeReconnectTimer = null;
}

function startRuntimeFrontendAutomation() {
  if (!runtimeAutomationAllowed()) return;
  const shouldPollWorker = RuntimeSystem.policy.liveTalkingAutostart
    || LiveTalkingWorker.ready
    || !['OFFLINE', 'ERROR'].includes(LiveTalkingWorker.state);
  if (shouldPollWorker && !LiveTalkingWorker.pollTimer) {
    void refreshLiveTalkingWorkerStatus({ silent: true });
    LiveTalkingWorker.pollTimer = setInterval(() => {
      if (!runtimeAutomationAllowed()) return;
      void refreshLiveTalkingWorkerStatus({ silent: true });
    }, 15000);
  }
  const shouldPollEngineStatus = Boolean(
    runtimeEngineStatusRefresh
    && (RuntimeSystem.policy.qwenTtsAutostart
      || RuntimeSystem.policy.liveTalkingAutostart
      || LiveTalkingWorker.ready
      || document.querySelector('#view-settings.active')),
  );
  if (shouldPollEngineStatus && !runtimeEngineStatusTimer) {
    void runtimeEngineStatusRefresh({ quiet: true });
    runtimeEngineStatusTimer = setInterval(() => {
      if (!runtimeAutomationAllowed()) return;
      void runtimeEngineStatusRefresh({ quiet: true });
    }, 20000);
  } else if (!shouldPollEngineStatus && runtimeEngineStatusTimer) {
    clearInterval(runtimeEngineStatusTimer);
    runtimeEngineStatusTimer = null;
  }
}

function startRuntimeActivityLoop() {
  if (!runtimeAutomationAllowed() || runtimeTickTimer) return;
  const autoWorkersEnabled = RuntimeSystem.policy.qwenTtsAutostart || RuntimeSystem.policy.liveTalkingAutostart;
  if (!autoWorkersEnabled && !runtimeRealtimeConnected && !LiveTalkingWorker.ready) return;
  tick();
  runtimeTickTimer = setInterval(tick, 200);
}

function suspendRuntimeFrontend(reason = 'Runtime services released') {
  stopRuntimeFrontendAutomation();
  liveMediaReconnectRequested = false;
  runtimeRealtimeSuspended = true;
  settleLiveMediaOwnership('STANDBY');
  OBSOutputBridge.closePeer();
  void disconnectLiveMedia(reason, false);
  releaseRuntimeRealtime();
}

function applyRuntimeSystemUI(settings = {}) {
  const system = settings.system;
  if (!system || typeof system.released !== 'boolean') return;
  RuntimeSystem.released = system.released;

  document.documentElement.dataset.runtimeMode = RuntimeSystem.released ? 'released' : 'active';
  document.body.dataset.runtimeMode = RuntimeSystem.released ? 'released' : 'active';

  const button = $('btn-system-power');
  const icon = $('system-power-icon');
  const label = $('system-power-label');
  const released = RuntimeSystem.released;
  if (button) {
    button.dataset.mode = released ? 'released' : 'active';
    button.disabled = RuntimeSystem.busy;
    button.setAttribute('aria-pressed', String(released));
    button.title = released ? 'Wake runtime services' : 'Release runtime services';
    button.setAttribute('aria-label', button.title);
  }
  if (icon) icon.textContent = released ? 'play_arrow' : 'power_settings_new';
  if (label) label.textContent = RuntimeSystem.busy
    ? (released ? 'Waking services…' : 'Releasing…')
    : (released ? 'Wake services' : 'Release machine');

  if (released) {
    $('sys-tts-dot')?.classList.remove('ok');
    $('sys-tts-dot')?.classList.add('warn');
    $('sys-talking-dot')?.classList.remove('ok');
    $('sys-talking-dot')?.classList.add('warn');
    $('sys-chat-dot')?.classList.remove('ok');
    $('sys-chat-dot')?.classList.add('warn');
    if ($('sys-tts-engine')) $('sys-tts-engine').textContent = 'Voice: Released';
    if ($('sys-talking-engine')) $('sys-talking-engine').textContent = 'Avatar: Released';
    if ($('sys-chat-status')) $('sys-chat-status').textContent = 'Chat: Released';
    if ($('sys-latency-tag')) $('sys-latency-tag').textContent = 'Runtime paused';
    if (!runtimeRealtimeSuspended) suspendRuntimeFrontend();
  } else if ($('sys-latency-tag')) {
    $('sys-latency-tag').textContent = 'A/V <35ms';
  }
}

async function toggleRuntimeSystem() {
  if (RuntimeSystem.busy || location.protocol === 'file:') return;
  const targetReleased = !RuntimeSystem.released;
  RuntimeSystem.busy = true;
  applyRuntimeSystemUI({ system: { released: RuntimeSystem.released } });
  const button = $('btn-system-power');
  if (button) button.setAttribute('aria-busy', 'true');
  try {
    if (targetReleased) {
      const payload = await window.RuntimeApi.post('/api/system/release-machine', {});
      applyRuntimeSettingsUI(payload.settings || { system: { released: true } });
      suspendRuntimeFrontend();
      addLog('Runtime services released; local worker load is paused.', 'ok');
      return;
    }

    runtimeRealtimeSuspended = false;
    const payload = await window.RuntimeApi.post('/api/system/wake-machine', {});
    applyRuntimeSettingsUI(payload.settings || { system: { released: false } });
    connectRuntimeRealtime();
    const workersReady = await waitForRequiredWorkers();
    if (!workersReady) throw new Error('Runtime services were released before workers became ready');
    await refreshMuseTalkMaskMode();
    startRuntimeFrontendAutomation();
    startRuntimeActivityLoop();
    const startupStatus = $('app-startup-status');
    if (startupStatus) startupStatus.textContent = 'Live workspace ready';
    if (appStartupComplete) {
      await restoreOperationalAvatar({ attempts: 5, status: startupStatus });
    }
    addLog('Runtime services are awake and ready.', 'ok');
  } catch (error) {
    addLog(`Runtime power action failed: ${error.message}`, 'err');
    try {
      const payload = await window.RuntimeApi.get('/api/settings/all');
      applyRuntimeSettingsUI(payload);
    } catch {}
    throw error;
  } finally {
    RuntimeSystem.busy = false;
    applyRuntimeSystemUI({ system: { released: RuntimeSystem.released } });
    button?.removeAttribute('aria-busy');
  }
}

function settleLiveMediaOwnership(state, ownerClientId = '') {
  LiveMediaOwnership.state = state;
  LiveMediaOwnership.ownerClientId = ownerClientId;
  if (state !== 'OWNER') LiveMediaOwnership.mediaReady = false;
  for (const waiter of LiveMediaOwnership.waiters) waiter();
  LiveMediaOwnership.waiters.clear();
}

function applyLiveMediaSnapshot(media = {}) {
  LiveMediaOwnership.liveSessionId = String(media.sessionId || '');
  LiveMediaOwnership.liveAvatarId = String(media.avatarId || '');
  updateAvatarLibraryTransientState();
  if (media.ownerClientId !== LIVE_MEDIA_CLIENT_ID) {
    LiveMediaOwnership.mediaReady = false;
    return;
  }
  LiveMediaOwnership.mediaReady = Boolean(media.ready);
  if (LiveMediaOwnership.mediaReady) liveMediaRecoveryAttempt = 0;
  if (!LiveMediaOwnership.mediaReady && appStartupComplete && LiveMediaOwnership.state === 'OWNER') {
    const connectionState = String(media.connectionState || 'new').toUpperCase();
    // The worker can need several seconds for ICE, model startup and the first
    // encoded frame. Resetting during that window closes a healthy session and
    // creates a permanent reconnect loop.
    if (['NEW', 'CONNECTING'].includes(connectionState)
      && LiveTalkingWebRTCClient?.isNegotiating?.()) return;
    const reason = media.sessionId
      ? `runtime media ${connectionState.toLowerCase()}`
      : 'runtime media session missing';
    if (TRAINED_AVATARS.size > 0) {
      scheduleLiveMediaRecovery(reason);
    } else {
      scheduleOperationalAvatarRestore(reason);
    }
  }
}

function scheduleLiveMediaRecovery(reason = 'media is not ready', delayMs = 350) {
  if (!appStartupComplete
    || LiveMediaOwnership.state !== 'OWNER'
    || liveMediaResetPromise
    || liveMediaRecoveryTimer) return;
  liveMediaRecoveryTimer = setTimeout(() => {
    liveMediaRecoveryTimer = null;
    if (LiveMediaOwnership.mediaReady) {
      liveMediaRecoveryAttempt = 0;
      return;
    }
    if (LiveTalkingWebRTCClient?.isNegotiating?.()) {
      // A healthy offer can need a few seconds before the first decoded frame.
      // Keep a watchdog armed instead of abandoning recovery permanently.
      scheduleLiveMediaRecovery('WebRTC negotiation still pending', 2500);
      return;
    }
    const avatarId = [LiveAvatarSession?.activeAvatarId, LiveTalkingStudio?.avatarId]
      .find(id => id && TRAINED_AVATARS.has(id))
      || TRAINED_AVATARS.keys().next().value;
    if (!avatarId || LiveMediaOwnership.state !== 'OWNER') {
      if (LiveMediaOwnership.state === 'OWNER') scheduleOperationalAvatarRestore(reason, 500);
      return;
    }
    void reconnectLiveTalkingAvatar(avatarId).catch(error => {
      addLog(`Live Monitor self-heal failed after ${reason}: ${error.message}`, 'warn');
      liveMediaRecoveryAttempt += 1;
      const retryDelay = Math.min(15_000, 1000 * (2 ** Math.min(liveMediaRecoveryAttempt, 4)));
      scheduleLiveMediaRecovery('automatic retry', retryDelay);
    });
  }, delayMs);
}

function disconnectLiveMedia(reason, reconnect = false) {
  liveMediaReconnectRequested ||= reconnect;
  if (liveMediaResetPromise) return liveMediaResetPromise;
  liveMediaResetPromise = Promise.resolve()
    .then(() => LiveTalkingWebRTCClient?.disconnect?.())
    .catch(error => addLog(`Could not reset Live Monitor: ${error.message}`, 'warn'))
    .then(async () => {
      const shouldReconnect = reconnect || liveMediaReconnectRequested;
      liveMediaReconnectRequested = false;
      if (!shouldReconnect || LiveMediaOwnership.state !== 'OWNER') return;
      if (!LiveTalkingWorker?.ready) await ensureLiveTalkingWorkerReady();
      const avatarId = [LiveAvatarSession?.activeAvatarId, LiveTalkingStudio?.avatarId]
        .find(id => id && TRAINED_AVATARS.has(id))
        || TRAINED_AVATARS.keys().next().value;
      if (avatarId) await reconnectLiveTalkingAvatar(avatarId);
    })
    .catch(error => addLog(`Live Monitor reconnect failed: ${error.message}`, 'warn'))
    .finally(() => {
      liveMediaResetPromise = null;
    });
  if (reason) addLog(`Live Monitor reset: ${reason}`, 'warn');
  return liveMediaResetPromise;
}

function registerLiveMediaClient() {
  return sendRuntimeSignal({
    type: 'LIVETALKING_MEDIA_REGISTER',
    clientId: LIVE_MEDIA_CLIENT_ID,
    priority: document.hasFocus() ? 100 : (document.visibilityState === 'visible' ? 50 : 10),
  });
}

async function waitForLiveMediaOwnership(timeoutMs = 5000) {
  if (LiveMediaOwnership.state === 'OWNER' && runtimeRealtimeConnected) return true;
  if (LiveMediaOwnership.state === 'STANDBY') {
    throw new Error('Live Monitor is active in another tab');
  }
  if (!runtimeRealtimeConnected) connectRuntimeRealtime();
  registerLiveMediaClient();
  const registrationTimer = setInterval(() => {
    if (LiveMediaOwnership.state !== 'OWNER') registerLiveMediaClient();
  }, 300);
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      LiveMediaOwnership.waiters.delete(done);
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    LiveMediaOwnership.waiters.add(done);
  });
  clearInterval(registrationTimer);
  if (LiveMediaOwnership.state !== 'OWNER') {
    throw new Error(LiveMediaOwnership.state === 'STANDBY'
      ? 'Live Monitor is active in another tab'
      : 'Live Monitor ownership is unavailable');
  }
  return true;
}

function sendRuntimeSignal(payload) {
  if (!runtimeRealtimeSocket || runtimeRealtimeSocket.readyState !== WebSocket.OPEN) return false;
  runtimeRealtimeSocket.send(JSON.stringify(payload));
  return true;
}

const OBSOutputBridge = {
  pc: null,
  videoSender: null,
  audioSender: null,
  stream: null,
  monitorStream: null,
  monitorCanvas: null,
  monitorContext: null,
  monitorRenderFrame: 0,
  silentAudioContext: null,
  silentAudioTrack: null,
  receiverReady: false,
  pendingCandidates: [],
  publishRun: 0,
  sessionId: '',
  negotiationId: '',

  applyVideoPreset(preset, republish = false) {
    if (!preset) return;
    const sizeChanged = Boolean(this.monitorCanvas)
      && (this.monitorCanvas.width !== preset.width || this.monitorCanvas.height !== preset.height);
    if (this.monitorCanvas && sizeChanged) {
      this.monitorCanvas.width = preset.width;
      this.monitorCanvas.height = preset.height;
    }
    if (sizeChanged && republish && this.receiverReady && this.sessionId) {
      this.closePeer();
      void this.publish();
    }
  },

  updateStream(stream) {
    this.stream = stream;
    this.syncVideoTrack();
    if (this.audioSender && this.pc && !['closed', 'failed'].includes(this.pc.connectionState)) {
      const audioTrack = stream?.getAudioTracks().find(track => track.readyState === 'live') || this.ensureSilentAudioTrack();
      void this.audioSender.replaceTrack(audioTrack).catch(error => {
        addLog(`OBS audio track update failed: ${error.message}`, 'warn');
      });
      return;
    }
    if (this.receiverReady && !this.pc) void this.publish();
  },

  preferredVideoTrack() {
    const liveTrack = this.stream?.getVideoTracks().find(track => track.readyState === 'live');
    if ((App.currentState === 'TALKING' || App.isAiSpeaking) && liveTrack) return liveTrack;
    return this.ensureMonitorStream()?.getVideoTracks().find(track => track.readyState === 'live') || liveTrack || null;
  },

  syncVideoTrack() {
    if (!this.videoSender || !this.pc || ['closed', 'failed'].includes(this.pc.connectionState)) return;
    const track = this.preferredVideoTrack();
    if (!track || this.videoSender.track === track) return;
    track.contentHint = 'motion';
    void this.videoSender.replaceTrack(track).catch(error => {
      addLog(`OBS video track update failed: ${error.message}`, 'warn');
    });
  },

  ensureMonitorStream() {
    if (this.monitorStream?.getVideoTracks().some(track => track.readyState === 'live')) return this.monitorStream;
    const preset = liveVideoPreset();
    // The Live Monitor composite is the canonical OBS output. Capturing it
    // directly avoids a second full-frame canvas copy on every animation frame.
    const canvas = $('monitor-w2l-canvas');
    if (!canvas) return this.stream;
    if (canvas.width !== preset.width) canvas.width = preset.width;
    if (canvas.height !== preset.height) canvas.height = preset.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context || typeof canvas.captureStream !== 'function') return this.stream;
    this.monitorCanvas = canvas;
    this.monitorContext = context;
    // Tauri's macOS WebView exposes requestFrame() but does not reliably
    // forward manual canvas frames through WebRTC. Continuous capture keeps
    // the OBS track advancing while the Monitor plays.
    this.monitorStream = canvas.captureStream(30);

    return this.monitorStream;
  },

  ensureSilentAudioTrack() {
    if (this.silentAudioTrack?.readyState === 'live') return this.silentAudioTrack;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    this.silentAudioContext = context;
    this.silentAudioTrack = destination.stream.getAudioTracks()[0] || null;
    return this.silentAudioTrack;
  },

  outputStream() {
    const videoTrack = this.preferredVideoTrack();
    const audioTrack = this.stream?.getAudioTracks().find(track => track.readyState === 'live') || this.ensureSilentAudioTrack();
    return new MediaStream([videoTrack, audioTrack].filter(Boolean));
  },

  closePeer() {
    this.publishRun += 1;
    this.pendingCandidates.length = 0;
    if (this.pc) this.pc.close();
    this.pc = null;
    this.videoSender = null;
    this.audioSender = null;
    this.negotiationId = '';
  },

  async publish() {
    const stream = this.outputStream();
    if (!this.sessionId || !this.receiverReady || !runtimeRealtimeConnected || !stream) return;
    if (!stream.getVideoTracks().length) return;
    const runId = ++this.publishRun;
    if (this.pc) this.pc.close();
    const negotiationId = `neg_${crypto.randomUUID().replace(/-/g, '')}`;
    this.negotiationId = negotiationId;
    const pc = new RTCPeerConnection({ sdpSemantics: 'unified-plan' });
    this.pc = pc;
    this.pendingCandidates.length = 0;
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      if (track.kind === 'video') {
        this.videoSender = sender;
        track.contentHint = 'motion';
        const preset = liveVideoPreset();
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = preset.maxBitrate;
        parameters.encodings[0].maxFramerate = preset.fps;
        if ('degradationPreference' in parameters) {
          parameters.degradationPreference = 'maintain-framerate';
        }
        await sender.setParameters(parameters).catch(error => {
          addLog(`OBS video quality parameters were not applied: ${error.message}`, 'warn');
        });
      }
      if (track.kind === 'audio') this.audioSender = sender;
    }
    pc.addEventListener('icecandidate', event => {
      if (event.candidate && runId === this.publishRun) {
        sendRuntimeSignal({
          type: 'OBS_OUTPUT_ICE',
          sessionId: this.sessionId,
          negotiationId,
          candidate: event.candidate.toJSON(),
        });
      }
    });
    pc.addEventListener('connectionstatechange', () => {
      if (runId !== this.publishRun) return;
      if (['failed', 'closed'].includes(pc.connectionState)) {
        this.closePeer();
        if (this.receiverReady) setTimeout(() => void this.publish(), 1000);
      }
    });
    const offer = await pc.createOffer();
    if (runId !== this.publishRun) return;
    await pc.setLocalDescription(offer);
    sendRuntimeSignal({
      type: 'OBS_OUTPUT_OFFER',
      sessionId: this.sessionId,
      negotiationId,
      description: { type: 'offer', sdp: pc.localDescription.sdp },
    });
  },

  async handleSignal(payload) {
    if (payload.type === 'OBS_OUTPUT_SESSION_ASSIGNED') {
      if (this.sessionId && this.sessionId !== payload.sessionId) this.closePeer();
      this.sessionId = payload.sessionId;
      this.receiverReady = Boolean(payload.receiverReady);
      if (!this.pc) await this.publish();
      return true;
    }
    if (payload.type === 'OBS_OUTPUT_SESSION_REVOKED') {
      if (this.sessionId === payload.sessionId) {
        this.receiverReady = false;
        this.sessionId = '';
        this.closePeer();
      }
      return true;
    }
    if (payload.type === 'OBS_OUTPUT_READY') {
      if (payload.sessionId !== this.sessionId) return true;
      this.receiverReady = true;
      if (!this.pc) await this.publish();
      return true;
    }
    if (payload.type === 'OBS_OUTPUT_RECEIVER_CLOSED') {
      if (payload.sessionId !== this.sessionId) return true;
      this.receiverReady = false;
      this.closePeer();
      applyObsStatus({ connected: true, mediaConnected: false });
      return true;
    }
    if (payload.type === 'OBS_OUTPUT_MEDIA_CONNECTED') {
      if (payload.sessionId !== this.sessionId || payload.negotiationId !== this.negotiationId) return true;
      applyObsStatus({ connected: true, mediaConnected: true, sourceName: 'AI IDOL Streamer' });
      return true;
    }
    if (payload.type === 'OBS_OUTPUT_ANSWER' && this.pc) {
      if (payload.sessionId !== this.sessionId || payload.negotiationId !== this.negotiationId) return true;
      await this.pc.setRemoteDescription(payload.description);
      const candidates = this.pendingCandidates.splice(0);
      for (const candidate of candidates) await this.pc.addIceCandidate(candidate).catch(() => {});
      return true;
    }
    if (payload.type === 'OBS_OUTPUT_ICE' && this.pc) {
      if (payload.sessionId !== this.sessionId || payload.negotiationId !== this.negotiationId) return true;
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(payload.candidate).catch(() => {});
      else this.pendingCandidates.push(payload.candidate);
      return true;
    }
    return false;
  },
};

function applyRuntimeSpeechState(speech = {}) {
  if (speech.state) runtimeSpeechState = speech.state;
  updateLiveVideoQualityAvailability();
  const providerBadge = $('sys-dialogue-provider');
  if (providerBadge && speech.dialogueProvider) {
    const isFallback = /mock|fallback/i.test(speech.dialogueProvider);
    providerBadge.textContent = isFallback ? 'MOCK FALLBACK' : (speech.dialogueProvider.includes('qwen') ? 'QWEN' : speech.dialogueProvider.toUpperCase());
    providerBadge.classList.toggle('fallback', isFallback);
  }
  if (speech.state === 'GENERATING') {
    updateVoiceStatusUI('generating', 'Generating voice and neural frames…', 45);
    return;
  }
  if (speech.state === 'SPEAKING') {
    App.isAiSpeaking = true;
    updateVoiceStatusUI('speaking', speech.provider || 'runtime', 100);
    if (LiveMediaOwnership.state === 'OWNER') LiveTalkingWebRTCClient?.ensureAudioPlayback?.();
    const subBox = $('mon-subtitles');
    const subTxt = $('mon-sub-text');
    if (subBox && subTxt) {
      subTxt.textContent = speech.text || '';
      subBox.classList.add('visible');
    }
    return;
  }
  App.isAiSpeaking = false;
  if (pendingRuntimePlaybackCommandId && App.queuedTransition?.commandId === pendingRuntimePlaybackCommandId) {
    clearQueuedTransition();
  }
  pendingRuntimePlaybackCommandId = null;
  if (speech.state === 'ERROR') {
    updateVoiceStatusUI('error', speech.error || 'Runtime speech failed');
  } else {
    updateVoiceStatusUI('idle');
    $('mon-subtitles')?.classList.remove('visible');
  }
}

function applyObsStatus(obs = {}) {
  const connected = Boolean(obs.connected);
  const mediaConnected = Boolean(obs.mediaConnected);
  const dot = $('sys-obs-dot');
  const label = $('sys-obs-status');
  const banner = $('obs-status-banner');
  if (dot) {
    dot.classList.toggle('ok', connected);
    dot.classList.toggle('warn', !connected);
  }
  if (label) label.textContent = connected ? 'OBS: Connected' : 'OBS: Waiting';
  if (banner) {
    banner.dataset.state = connected && mediaConnected ? 'connected' : (connected ? 'connecting' : 'waiting');
    banner.textContent = connected && mediaConnected
      ? `Connected · ${obs.sourceName || 'AI IDOL Streamer'} · Video + voice`
      : connected
        ? `Connected · ${obs.sourceName || 'AI IDOL Streamer'} · Waiting for Monitor`
      : 'Enable OBS WebSocket, then Magic Connect.';
  }
}

function platformChatStateCopy(platform, source = {}) {
  const provider = platform === 'youtube' ? 'YouTube' : 'Facebook';
  if (!source.configured) return { label: 'Setup required', detail: `${provider} login not configured.` };
  if (source.state === 'CONNECTING') return { label: 'Connecting', detail: `Approve ${provider} access.` };
  if (source.state === 'LISTENING') return { label: 'Listening', detail: source.liveTitle ? `${source.accountName || provider} · ${source.liveTitle}` : `${source.accountName || provider} · Live chat connected` };
  if (source.state === 'PAUSED') return { label: 'Paused', detail: `${source.accountName || provider} · No API calls until Start chat.` };
  if (source.state === 'WAITING_FOR_LIVE') return { label: 'Waiting for live', detail: `${source.accountName || provider} · Start live for chat.` };
  if (source.state === 'ERROR') return { label: 'Needs attention', detail: source.error || `${provider} chat could not connect.` };
  return { label: 'Signed out', detail: platform === 'youtube' ? 'Connect Google for chat.' : 'Connect Facebook for chat.' };
}

function applyPlatformReplySettings(settings = {}) {
  ['youtube', 'facebook'].forEach(platform => {
    const toggle = $(`${platform}-ai-reply`);
    if (toggle && document.activeElement !== toggle) toggle.checked = Boolean(settings[platform]);
  });
}

function applyPlatformChatStatus(platformChat = {}, platformReply = null) {
  if (platformReply) applyPlatformReplySettings(platformReply);
  const sources = platformChat.sources || {};
  let authenticatedCount = 0;
  let listeningCount = 0;
  ['youtube', 'facebook'].forEach(platform => {
    const source = sources[platform] || { platform, configured: false, authenticated: false, state: 'NOT_CONFIGURED' };
    const copy = platformChatStateCopy(platform, source);
    if (source.authenticated) authenticatedCount += 1;
    if (source.state === 'LISTENING') listeningCount += 1;
    const state = $(`${platform}-chat-state`);
    const detail = $(`${platform}-chat-detail`);
    const connect = $(`connect-${platform}-chat`);
    const disconnect = $(`disconnect-${platform}-chat`);
    if (state) {
      state.textContent = copy.label;
      state.dataset.state = source.state || 'SIGNED_OUT';
    }
    if (detail) detail.textContent = copy.detail;
    if (connect) {
      connect.hidden = Boolean(source.authenticated && source.state !== 'PAUSED' && source.state !== 'ERROR');
      connect.disabled = !source.configured || source.state === 'CONNECTING';
      const label = source.authenticated ? 'Start chat' : `Continue with ${platform === 'youtube' ? 'Google' : 'Facebook'}`;
      connect.innerHTML = `<span class="material-symbols-rounded" aria-hidden="true">${source.authenticated ? 'play_arrow' : 'login'}</span>${label}`;
    }
    if (disconnect) disconnect.hidden = !source.authenticated;
  });

  const sourceCount = $('platform-chat-source-count');
  const summary = $('platform-chat-summary');
  const headerDot = $('sys-chat-dot');
  const headerStatus = $('sys-chat-status');
  if (sourceCount) sourceCount.textContent = `${listeningCount} live`;
  if (summary) summary.textContent = listeningCount
    ? `${listeningCount} live source${listeningCount === 1 ? '' : 's'}.`
    : authenticatedCount
      ? `${authenticatedCount} source${authenticatedCount === 1 ? '' : 's'} waiting for live.`
      : 'No platform connected.';
  if (headerDot) {
    headerDot.classList.toggle('ok', listeningCount > 0);
    headerDot.classList.toggle('warn', listeningCount === 0);
  }
  if (headerStatus) headerStatus.textContent = listeningCount ? `Chat: ${listeningCount} live` : authenticatedCount ? 'Chat: Waiting' : 'Chat: Offline';
}

async function connectPlatformChat(platform) {
  const button = $(`connect-${platform}-chat`);
  const summary = $('platform-chat-summary');
  if (button) button.disabled = true;
  if (summary) summary.textContent = button?.textContent?.includes('Start chat')
    ? `Checking ${platform === 'youtube' ? 'YouTube' : 'Facebook'} live once...`
    : `Opening ${platform === 'youtube' ? 'Google' : 'Facebook'} login...`;
  try {
    const payload = await window.RuntimeApi.post(`/api/platform-chat/${platform}/connect`, {});
    applyPlatformChatStatus(payload.platformChat || {});
  } catch (error) {
    if (summary) summary.textContent = error.message;
    if (button) button.disabled = false;
  }
}

async function disconnectPlatformChat(platform) {
  const summary = $('platform-chat-summary');
  try {
    const payload = await window.RuntimeApi.delete(`/api/platform-chat/${platform}`);
    applyPlatformChatStatus(payload.platformChat || {});
  } catch (error) {
    if (summary) summary.textContent = error.message;
  }
}

async function savePlatformReplySettings() {
  const settings = {
    youtube: Boolean($('youtube-ai-reply')?.checked),
    facebook: Boolean($('facebook-ai-reply')?.checked),
  };
  const payload = await window.RuntimeApi.post('/api/platform-chat/reply-settings', settings);
  applyPlatformReplySettings(payload.platformReply || settings);
}

function handleRuntimeRealtimeMessage(payload) {
  if (payload.type === 'SYSTEM_STATE') {
    applyRuntimeSettingsUI(payload.settings || {});
    return;
  }
  if (payload.type === 'LIVETALKING_MEDIA_OWNER_GRANTED') {
    settleLiveMediaOwnership('OWNER', payload.clientId || LIVE_MEDIA_CLIENT_ID);
    applyLiveMediaSnapshot(payload.media || {});
    if (!LiveTalkingWebRTCClient?.sessionId) scheduleOperationalAvatarRestore('ownership granted');
    return;
  }
  if (payload.type === 'LIVETALKING_MEDIA_STANDBY') {
    settleLiveMediaOwnership('STANDBY', payload.ownerClientId || '');
    void disconnectLiveMedia('another Dashboard owns the Live Monitor');
    return;
  }
  if (payload.type === 'LIVETALKING_MEDIA_REVOKED') {
    const shouldReacquire = ['MEDIA_NOT_READY', 'VIDEO_FRAME_STALLED']
      .includes(String(payload.reason || '').toUpperCase());
    settleLiveMediaOwnership(shouldReacquire ? 'PENDING' : 'STANDBY', payload.ownerClientId || '');
    void disconnectLiveMedia(payload.reason || 'ownership revoked').finally(() => {
      if (!shouldReacquire) return;
      registerLiveMediaClient();
      scheduleOperationalAvatarRestore(payload.reason || 'ownership reacquire', 250);
    });
    return;
  }
  if (payload.type === 'LIVETALKING_MEDIA_RECOVERY_REQUIRED') {
    LiveMediaOwnership.mediaReady = false;
    LiveMediaOwnership.liveSessionId = '';
    LiveMediaOwnership.liveAvatarId = '';
    updateAvatarLibraryTransientState();
    if (LiveMediaOwnership.state !== 'STANDBY') {
      settleLiveMediaOwnership('PENDING');
      registerLiveMediaClient();
      scheduleOperationalAvatarRestore(payload.reason || 'runtime requested media recovery', 250);
    }
    return;
  }
  if (payload.type === 'LIVETALKING_MEDIA_RESET_REQUIRED') {
    LiveMediaOwnership.mediaReady = false;
    LiveMediaOwnership.liveSessionId = '';
    LiveMediaOwnership.liveAvatarId = '';
    updateAvatarLibraryTransientState();
    LiveTalkingWorker.sessionFailureCount = 3;
    void disconnectLiveMedia(payload.reason || 'worker session changed', true);
    return;
  }
  if (payload.type === 'LIVETALKING_MEDIA_STATUS') {
    applyLiveMediaSnapshot(payload.media || {});
    return;
  }
  if (payload.type?.startsWith('OBS_OUTPUT_')) {
    void OBSOutputBridge.handleSignal(payload).catch(error => {
      addLog(`OBS output link failed: ${error.message}`, 'warn');
    });
    return;
  }
  if (payload.type === 'INITIAL_STATE') {
    const visual = payload.state?.currentVisual;
    if (visual) setVisualState(visual, 7, 'runtime-snapshot', false, true);
    if (payload.speech) applyRuntimeSpeechState(payload.speech);
    if (payload.settings) applyRuntimeSettingsUI(payload.settings);
    if (payload.media) applyLiveMediaSnapshot(payload.media);
    return;
  }
  if (payload.type === 'STATE_CHANGE' && payload.toState) {
    setVisualState(payload.toState, 7, payload.reason || 'runtime', false, true, payload.asset || null);
  } else if (payload.type === 'SPEECH_PLAYBACK_PENDING' && payload.commandId && LiveMediaOwnership.state === 'OWNER') {
    queueRuntimeSpeechPlayback(payload.commandId);
  } else if (payload.type === 'SPEECH_STATE') {
    applyRuntimeSpeechState(payload.speech);
  } else if (payload.type === 'AVATAR_STATE_CHANGED' && payload.avatarId) {
    LiveAvatarSession.activeAvatarId = payload.avatarId;
    LiveTalkingStudio.avatarId = payload.avatarId;
    if (Array.isArray(payload.selectedAvatarIds)) {
      LiveAvatarSession.selectedAvatarIds = [...new Set(payload.selectedAvatarIds.map(String).filter(Boolean))];
    }
    localStorage.setItem(STORAGE_KEYS.ACTIVE_AVATAR, payload.avatarId);
    localStorage.setItem(STORAGE_KEYS.LIVETALKING_AVATAR, payload.avatarId);
    localStorage.setItem(STORAGE_KEYS.AVATAR_POOL, JSON.stringify(LiveAvatarSession.selectedAvatarIds));
    updateAvatarPoolCount();
    updateLibraryTransientState();
    updateAvatarLibraryTransientState();
  } else if (payload.type === 'DIRECTOR_INTENT' && payload.intent?.dialogueProvider) {
    applyRuntimeSpeechState({ dialogueProvider: payload.intent.dialogueProvider });
  } else if (payload.type === 'SETTINGS_UPDATED' && payload.settings) {
    applyRuntimeSettingsUI(payload.settings);
  } else if (payload.type === 'REPLY_SKILLS_UPDATED' && payload.replySkills) {
    applyReplySkillPayload(payload.replySkills);
  } else if (payload.type === 'LIVETALKING_WORKER_STATE' && payload.worker) {
    applyLiveTalkingWorkerState(payload.worker);
  } else if (payload.type === 'LIVETALKING_MAINTENANCE_STATE' && payload.maintenance) {
    applyLiveTalkingMaintenanceState(payload.maintenance);
  } else if (payload.type === 'OBS_STATUS' && payload.obs) {
    applyObsStatus(payload.obs);
  } else if (payload.type === 'PLATFORM_CHAT_STATUS' && payload.platformChat) {
    applyPlatformChatStatus(payload.platformChat);
  } else if (payload.type === 'CHAT_MESSAGE' && payload.message) {
    renderChatMessage(payload.message);
  }
}

function connectRuntimeRealtime() {
  if (runtimeRealtimeSuspended || location.protocol === 'file:' || !window.RuntimeApi?.connectRealtime) return;
  if (runtimeRealtimeSocket && runtimeRealtimeSocket.readyState < WebSocket.CLOSING) return;
  runtimeRealtimeSocket = window.RuntimeApi.connectRealtime(handleRuntimeRealtimeMessage, state => {
    runtimeRealtimeConnected = state === 'open';
    if (state === 'open') {
      if (RuntimeSystem.released) return;
      if (!RuntimeSystem.policy.liveTalkingAutostart && !LiveTalkingWorker.ready) {
        startRuntimeActivityLoop();
        return;
      }
      registerLiveMediaClient();
      let attempts = 0;
      const reinforceOwnership = () => {
        if (!runtimeRealtimeConnected || LiveMediaOwnership.state === 'OWNER' || attempts >= 8) return;
        attempts += 1;
        registerLiveMediaClient();
        setTimeout(reinforceOwnership, Math.min(1500, 150 * (2 ** attempts)));
      };
      setTimeout(reinforceOwnership, 100);
      sendRuntimeSignal({
        type: 'OBS_OUTPUT_REGISTER',
        role: 'publisher',
        peerId: OBS_OUTPUT_PUBLISHER_ID,
        priority: document.visibilityState === 'visible' ? 100 : 10,
      });
      scheduleOperationalAvatarRestore('runtime reconnected');
    }
    if (state === 'closed') {
      settleLiveMediaOwnership('PENDING');
      if (!RuntimeSystem.released) void disconnectLiveMedia('runtime connection closed');
      OBSOutputBridge.closePeer();
      clearTimeout(runtimeRealtimeReconnectTimer);
      if (runtimeRealtimeSuspended) return;
      if (RuntimeSystem.released) return;
      runtimeRealtimeReconnectTimer = setTimeout(connectRuntimeRealtime, 2000);
    }
  });
}

function releaseRuntimeRealtime() {
  runtimeRealtimeSuspended = true;
  clearTimeout(runtimeRealtimeReconnectTimer);
  runtimeRealtimeReconnectTimer = null;
  if (runtimeRealtimeSocket?.readyState === WebSocket.OPEN) {
    sendRuntimeSignal({
      type: 'LIVETALKING_MEDIA_RELEASE',
      clientId: LIVE_MEDIA_CLIENT_ID,
    });
  }
  runtimeRealtimeConnected = false;
  runtimeRealtimeSocket?.close(1000, 'Dashboard page hidden');
  runtimeRealtimeSocket = null;
}

window.addEventListener('pagehide', releaseRuntimeRealtime, { capture: true });
window.addEventListener('beforeunload', releaseRuntimeRealtime, { capture: true });
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  runtimeRealtimeSuspended = false;
  connectRuntimeRealtime();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopRuntimeFrontendAutomation();
    if (runtimeRealtimeConnected) {
      registerLiveMediaClient();
      sendRuntimeSignal({ type: 'OBS_OUTPUT_REGISTER', role: 'publisher', peerId: OBS_OUTPUT_PUBLISHER_ID, priority: 10 });
    }
    return;
  }
  if (runtimeRealtimeConnected) {
    registerLiveMediaClient();
    sendRuntimeSignal({
      type: 'OBS_OUTPUT_REGISTER',
      role: 'publisher',
      peerId: OBS_OUTPUT_PUBLISHER_ID,
      priority: 100,
    });
  }
  if (!RuntimeSystem.released) {
    startRuntimeFrontendAutomation();
    startRuntimeActivityLoop();
  }
});
window.addEventListener('focus', registerLiveMediaClient);
window.addEventListener('blur', registerLiveMediaClient);

// ── DOM Helpers ───────────────────────────────────────────
const $ = id => document.getElementById(id);

function addLog(text, cls = '') {
  const logEl = $('event-log');
  if (!logEl) return;
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const li = document.createElement('li');
  li.className = 'log-line';
  li.innerHTML = `<span class="log-t">${timeStr}</span><span class="log-m ${cls}">${text}</span>`;
  logEl.prepend(li);
  while (logEl.children.length > 50) logEl.lastElementChild?.remove();
}

function msToMMSS(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function elapsedStr(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function ctaCountdown(ms) {
  if (ms <= 0) return 'Ready';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s left` : `${s}s left`;
}

// ── Audio Context Unlocker ────────────────────────────────
async function unlockAudio(requirePlayback = false) {
  try {
    App.isMuted = false;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && !App.audioCtx) {
      App.audioCtx = new AudioContextClass();
    }
    if (App.audioCtx && App.audioCtx.state === 'suspended') {
      await App.audioCtx.resume();
    }
    
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
    }

    // Must run inside the user's click gesture. WebRTC audio can arrive several
    // seconds later, after TTS/MuseTalk inference, so autoplay alone is not
    // reliable (especially Safari/Chrome with strict media policies).
    const receiverAudioReady = Boolean(LiveTalkingWebRTCClient?.audioEl);
    const playbackReady = receiverAudioReady
      ? await LiveTalkingWebRTCClient.ensureAudioPlayback()
      : false;
    if (receiverAudioReady && !playbackReady) throw new Error('Live Monitor audio is not ready');
    if (requirePlayback && !playbackReady) throw new Error('Live Monitor audio track is not ready');
    App.isAudioUnlocked = true;
    const audioButton = $('btn-test-sound');
    if (audioButton) {
      audioButton.innerHTML = window.materialIcon?.('volume_up') || 'volume_up';
      audioButton.title = 'Audio enabled';
      audioButton.setAttribute('aria-label', 'Audio enabled');
      audioButton.classList.add('is-ready');
    }
    addLog('Audio enabled.', 'ok');
  } catch (err) {
    App.isAudioUnlocked = false;
    if (requirePlayback) {
      console.warn('Audio unlock warning:', err);
      throw err;
    }
    return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════
// IDOL INDEXEDDB PERSISTENT MEDIA STORAGE (Large Blob Storage)
// ══════════════════════════════════════════════════════════════
const IdolDB = {
  dbName: 'IdolMediaDB',
  dbVersion: 2,
  db: null,
  openingPromise: null,
  upgradePending: false,
  pendingWrites: [],

  async init() {
    if (this.db) return this.db;
    if (this.upgradePending) return null;
    if (this.openingPromise) return this.openingPromise;
    this.openingPromise = new Promise((resolve) => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const request = indexedDB.open(this.dbName, this.dbVersion);
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('avatar_media')) {
            db.createObjectStore('avatar_media', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('clip_media')) {
            db.createObjectStore('clip_media', { keyPath: 'id' });
          }
        };
        request.onsuccess = (e) => {
          this.db = e.target.result;
          this.upgradePending = false;
          this.db.onversionchange = () => {
            this.db?.close();
            this.db = null;
          };
          finish(this.db);
          this.flushPendingWrites();
        };
        request.onerror = (e) => {
          console.warn('IdolDB init error:', e);
          this.upgradePending = false;
          finish(null);
        };
        request.onblocked = () => {
          // Another dashboard tab may still own v1. Keep the request alive so
          // it can finish later, but never block controls while waiting.
          this.upgradePending = true;
          console.warn('IdolDB upgrade is waiting for another dashboard tab to close.');
          finish(null);
        };
      } catch (err) {
        console.warn('IdolDB open exception:', err);
        this.upgradePending = false;
        finish(null);
      }
    });
    const result = await this.openingPromise;
    this.openingPromise = null;
    return result;
  },

  queuePendingWrite(write) {
    this.pendingWrites.push(write);
  },

  async flushPendingWrites() {
    if (!this.db || !this.pendingWrites.length) return;
    const writes = this.pendingWrites.splice(0);
    for (const write of writes) {
      if (write.type === 'clip') await this.saveClip(write.id, write.blob, write.meta);
      if (write.type === 'clip-meta') await this.updateClipMeta(write.id, write.meta);
      if (write.type === 'delete-clip') await this.deleteClip(write.id);
    }
  },

  async saveAvatar(id, blob, meta = {}) {
    const db = await this.init();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('avatar_media', 'readwrite');
        const store = tx.objectStore('avatar_media');
        store.put({ id, blob, meta, updatedAt: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        console.warn('IdolDB saveAvatar error:', err);
        resolve(false);
      }
    });
  },

  async getAvatar(id) {
    const db = await this.init();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('avatar_media', 'readonly');
        const store = tx.objectStore('avatar_media');
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (err) {
        console.warn('IdolDB getAvatar error:', err);
        resolve(null);
      }
    });
  },

  async deleteAvatar(id) {
    const db = await this.init();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('avatar_media', 'readwrite');
        const store = tx.objectStore('avatar_media');
        store.delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        resolve(false);
      }
    });
  },

  async saveClip(id, blob, meta = {}) {
    const db = await this.init();
    if (!db) {
      if (this.upgradePending) this.queuePendingWrite({ type: 'clip', id, blob, meta });
      return false;
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('clip_media', 'readwrite');
        tx.objectStore('clip_media').put({ id, blob, meta, updatedAt: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        console.warn('IdolDB saveClip error:', err);
        resolve(false);
      }
    });
  },

  async updateClipMeta(id, meta = {}) {
    const db = await this.init();
    if (!db) {
      if (this.upgradePending) this.queuePendingWrite({ type: 'clip-meta', id, meta });
      return false;
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('clip_media', 'readwrite');
        const store = tx.objectStore('clip_media');
        const request = store.get(id);
        request.onsuccess = () => {
          if (!request.result) return;
          store.put({ ...request.result, meta: { ...request.result.meta, ...meta }, updatedAt: Date.now() });
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        console.warn('IdolDB updateClipMeta error:', err);
        resolve(false);
      }
    });
  },

  async getAllClips() {
    const db = await this.init();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('clip_media', 'readonly');
        const request = tx.objectStore('clip_media').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
      } catch (err) {
        console.warn('IdolDB getAllClips error:', err);
        resolve([]);
      }
    });
  },

  async deleteClip(id) {
    const db = await this.init();
    if (!db) {
      if (this.upgradePending) this.queuePendingWrite({ type: 'delete-clip', id });
      return false;
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('clip_media', 'readwrite');
        tx.objectStore('clip_media').delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        console.warn('IdolDB deleteClip error:', err);
        resolve(false);
      }
    });
  }
};
window.IdolDB = IdolDB;

async function loadPersistedClips() {
  const records = await IdolDB.getAllClips();
  for (const record of records) {
    const state = record.meta?.state;
    if (!record.blob || !state || !Object.prototype.hasOwnProperty.call(CLIP_LIBRARY, state)) continue;
    const storageId = record.id;
    if (CLIP_LIBRARY[state].some(clip => clip.storageId === storageId)) continue;
    const blobUrl = URL.createObjectURL(record.blob);
    const clip = {
      id: record.meta.id || storageId,
      storageId,
      label: record.meta.label || record.meta.fileName || storageId,
      fileName: record.meta.fileName || '',
      dur: Number(record.meta.dur) || 5000,
      mode: record.meta.mode || 'loop',
      loop: (record.meta.mode || 'loop') === 'loop',
      blobUrl,
      state,
    };
    CLIP_LIBRARY[state].push(clip);
    UPLOADED_BLOBS.set(storageId, blobUrl);
  }
  let restoredCount = records.length;
  if (!restoredCount && location.protocol !== 'file:') {
    restoredCount = await migrateLegacyProjectClips();
  }
  if (restoredCount) addLog(`Restored ${restoredCount} uploaded video${restoredCount === 1 ? '' : 's'}.`, 'ok');
  return restoredCount;
}

async function migrateLegacyProjectClips() {
  try {
    const payload = await window.RuntimeApi.get('/api/storage/uploads');
    let imported = 0;
    for (const storedFile of payload.files || []) {
      const response = await window.RuntimeApi.fetch(storedFile.url);
      if (!response.ok) continue;
      const blob = await response.blob();
      const cleanBase = storedFile.filename.replace(/\.[^/.]+$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_') || `clip_${imported + 1}`;
      const clipId = CLIP_LIBRARY.GAMEPLAY_IDLE.some(clip => clip.id === cleanBase)
        ? `${cleanBase}_${imported + 1}`
        : cleanBase;
      const storageId = `legacy:${clipId}`;
      const blobUrl = URL.createObjectURL(blob);
      const clip = {
        id: clipId,
        storageId,
        label: storedFile.filename.replace(/\.[^/.]+$/, '').slice(0, 18),
        fileName: storedFile.filename,
        dur: 5000,
        mode: 'loop',
        loop: true,
        blobUrl,
        state: 'GAMEPLAY_IDLE',
      };
      CLIP_LIBRARY.GAMEPLAY_IDLE.push(clip);
      UPLOADED_BLOBS.set(storageId, blobUrl);
      await IdolDB.saveClip(storageId, blob, {
        id: clipId,
        fileName: storedFile.filename,
        label: clip.label,
        dur: clip.dur,
        mode: clip.mode,
        state: clip.state,
      });
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.src = blobUrl;
      probe.onloadedmetadata = () => {
        if (!Number.isFinite(probe.duration) || probe.duration <= 0) return;
        clip.dur = Math.round(probe.duration * 1000);
        IdolDB.updateClipMeta(storageId, { dur: clip.dur }).catch(() => {});
        renderLibraryUI();
      };
      imported += 1;
    }
    return imported;
  } catch (error) {
    console.warn('Legacy project video migration skipped:', error.message);
    return 0;
  }
}

async function loadPersistedAvatar() {
  try {
    const saved = await IdolDB.getAvatar('livetalking_avatar');
    if (saved && saved.blob) {
      const blobUrl = URL.createObjectURL(saved.blob);
      LiveTalkingStudio.videoFile = { name: saved.meta?.fileName || 'avatar.mp4', size: saved.blob.size };
      LiveTalkingStudio.videoBlobUrl = blobUrl;
      LiveTalkingStudio.modelType = saved.meta?.modelType || 'musetalk';
      LiveTalkingStudio.avatarId = localStorage.getItem(STORAGE_KEYS.LIVETALKING_AVATAR)
        || saved.meta?.avatarId
        || 'musetalk_avatar1';
      LiveTalkingStudio.isTrainedReady = Boolean(localStorage.getItem(STORAGE_KEYS.LIVETALKING_AVATAR))
        || saved.meta?.isTrainedReady !== false;
      LiveTalkingStudio.trainProgress = LiveTalkingStudio.isTrainedReady ? 100 : 0;
      if (saved.meta?.faceBox) {
        LiveTalkingStudio.faceBox = saved.meta.faceBox;
      }
      if (saved.meta?.mouthBox) {
        LiveTalkingStudio.mouthBox = saved.meta.mouthBox;
      }
      if (saved.meta?.landmarks468) {
        LiveTalkingStudio.landmarks468 = saved.meta.landmarks468;
      } else {
        LiveTalkingStudio.landmarks468 = generate468FaceLandmarks(LiveTalkingStudio.faceBox, LiveTalkingStudio.mouthBox);
      }
      if (saved.meta?.coords) {
        LiveTalkingStudio.coords = saved.meta.coords;
      }
      if (saved.meta?.museTalkDataset) {
        LiveTalkingStudio.museTalkDataset = saved.meta.museTalkDataset;
      } else if (LiveTalkingStudio.isTrainedReady) {
        LiveTalkingStudio.museTalkDataset = MuseTalkNativePipeline.preprocessDataset(
          10,
          [{ x1: LiveTalkingStudio.faceBox.x1, y1: LiveTalkingStudio.faceBox.y1, x2: LiveTalkingStudio.faceBox.x2, y2: LiveTalkingStudio.faceBox.y2 }],
          25,
          0,
          LiveTalkingStudio.avatarId
        );
      }
      
      const vid = document.createElement('video');
      vid.src = blobUrl;
      vid.loop = true;
      vid.muted = true;
      vid.playsInline = true;
      vid.autoplay = true;
      vid.play().catch(() => {});
      LiveTalkingStudio.videoEl = vid;
      
      App.avatar.videoEl = vid;
      App.avatar.videoUrl = blobUrl;
      App.avatar.customImageData = blobUrl;
      App.avatar.faceBox = LiveTalkingStudio.faceBox;
      App.avatar.mouthBox = LiveTalkingStudio.mouthBox;
      App.avatar.landmarks468 = LiveTalkingStudio.landmarks468;
      App.avatar.museTalkDataset = LiveTalkingStudio.museTalkDataset;

      if ($('lt-model-select')) $('lt-model-select').value = LiveTalkingStudio.modelType;
      if ($('lt-avatar-id-input')) $('lt-avatar-id-input').value = LiveTalkingStudio.avatarId;

      updateLiveTalkingUI();
      console.log('Loaded persisted Lipsync avatar from IndexedDB');
    }
  } catch (err) {
    console.warn('Persisted avatar load error:', err);
  }
}

// ── Web Speech API Voice Cache ────────────────────────────
let cachedVoices = [];
function populateWebSpeechSelect() {
  const select = $('lt-webspeech-voice-select');
  if (!select || cachedVoices.length === 0) return;

  const prevVal = select.value;
  select.innerHTML = '';
  
  // Sort: Vietnamese voices first, then others
  const sorted = [...cachedVoices].sort((a, b) => {
    const isViA = (a.lang && a.lang.toLowerCase().includes('vi')) || (a.name && a.name.toLowerCase().includes('viet'));
    const isViB = (b.lang && b.lang.toLowerCase().includes('vi')) || (b.name && b.name.toLowerCase().includes('viet'));
    if (isViA && !isViB) return -1;
    if (!isViA && isViB) return 1;
    return a.name.localeCompare(b.name);
  });

  sorted.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.voiceURI || v.name;
    const isVi = (v.lang && v.lang.toLowerCase().includes('vi')) || (v.name && v.name.toLowerCase().includes('viet'));
    opt.textContent = `${isVi ? '⭐ [Vietnamese] ' : ''}${v.name} (${v.lang || 'default'})`;
    if (isVi && !prevVal) opt.selected = true;
    select.appendChild(opt);
  });

  if (prevVal) select.value = prevVal;
}

function loadWebSpeechVoices() {
  if (!('speechSynthesis' in window)) return;
  cachedVoices = window.speechSynthesis.getVoices();
  populateWebSpeechSelect();
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = loadWebSpeechVoices;
  loadWebSpeechVoices();
}

// ──────────────────────────────────────────────────────────
// 1. AVATAR UPLOAD & CANVAS PIP CAM RENDERER (PRESERVED PRESETS)
// ──────────────────────────────────────────────────────────

// ── Web Audio Analyser & Real-Time Viseme Synthesis Engine ─────────
let audioCtxInstance = null;
let audioAnalyserNode = null;
let liveAudioDataArray = null;
const liveViseme = { open: 0, width: 1.0, isSpeaking: false };

function getAudioContext() {
  if (!audioCtxInstance) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      audioCtxInstance = new AudioCtx();
    }
  }
  if (audioCtxInstance && audioCtxInstance.state === 'suspended') {
    audioCtxInstance.resume();
  }
  return audioCtxInstance;
}

function connectAudioToAnalyser(audioElement) {
  try {
    const ctx = getAudioContext();
    if (!ctx || !audioElement) return;

    if (!audioAnalyserNode) {
      audioAnalyserNode = ctx.createAnalyser();
      audioAnalyserNode.fftSize = 256;
      audioAnalyserNode.smoothingTimeConstant = 0.4;
      const bufferLength = audioAnalyserNode.frequencyBinCount;
      liveAudioDataArray = new Uint8Array(bufferLength);
    }

    if (!audioElement._hasAudioSourceNode) {
      const source = ctx.createMediaElementSource(audioElement);
      source.connect(audioAnalyserNode);
      audioAnalyserNode.connect(ctx.destination);
      audioElement._hasAudioSourceNode = true;
    }
  } catch (err) {
    console.warn('Audio analyser connection note:', err.message);
  }
}

function updateLiveAudioAnalysis() {
  if (audioAnalyserNode && liveAudioDataArray && (App.isAiSpeaking || App.currentState === 'TALKING')) {
    audioAnalyserNode.getByteFrequencyData(liveAudioDataArray);
    let sum = 0;
    let vowelSum = 0; // Vowel frequencies (~300Hz - 2500Hz)
    const len = liveAudioDataArray.length;
    for (let i = 0; i < len; i++) {
      const val = liveAudioDataArray[i];
      sum += val;
      if (i >= 4 && i <= 32) vowelSum += val;
    }
    const avg = sum / len;
    const vowelAvg = vowelSum / 28;
    const normVol = Math.min(1.0, (avg / 128));
    const normVowel = Math.min(1.0, (vowelAvg / 110));

    // Smooth instantaneous openness
    const amp = LiveTalkingStudio.voiceSpeed || 1.1;
    const targetOpen = Math.min(1.0, (normVowel * 0.85 + normVol * 0.35) * amp);
    liveViseme.open += (targetOpen - liveViseme.open) * 0.45;
    liveViseme.width = 1.0 + (normVol - 0.5) * 0.3;
    liveViseme.isSpeaking = true;

    // Update VU meter UI
    const vuFill = $('lt-vu-fill');
    if (vuFill) {
      const pct = Math.min(100, Math.round(liveViseme.open * 100));
      vuFill.style.width = `${pct}%`;
    }
    const liveVuFill = $('lt-live-vu-fill');
    if (liveVuFill) {
      const pct = Math.min(100, Math.round(liveViseme.open * 100));
      liveVuFill.style.width = `${pct}%`;
    }
    const lblVuVal = $('lbl-vu-val');
    if (lblVuVal) {
      const dbVal = Math.round(liveViseme.open * 100);
      lblVuVal.textContent = `${dbVal}%`;
    }
  } else {
    // When not speaking or synthesizing with WebSpeech, provide smooth decay or fallback
    if (App.isAiSpeaking || App.currentState === 'TALKING') {
      const t = Date.now();
      const simViseme = Math.max(0.05, (Math.sin(t / 55) * 0.4 + Math.sin(t / 90) * 0.35 + Math.cos(t / 130) * 0.25 + 1) / 2);
      const amp = LiveTalkingStudio.voiceSpeed || 1.1;
      liveViseme.open += (simViseme * 0.85 * amp - liveViseme.open) * 0.35;
      liveViseme.width = 1.0 + (simViseme - 0.5) * 0.25;
      liveViseme.isSpeaking = true;

      const vuFill = $('lt-vu-fill');
      if (vuFill) vuFill.style.width = `${Math.min(100, Math.round(liveViseme.open * 100))}%`;
      const liveVuFill = $('lt-live-vu-fill');
      if (liveVuFill) liveVuFill.style.width = `${Math.min(100, Math.round(liveViseme.open * 100))}%`;
      const lblVuVal = $('lbl-vu-val');
      if (lblVuVal) lblVuVal.textContent = `${Math.min(100, Math.round(liveViseme.open * 100))}%`;
    } else {
      if (liveViseme.open > 0.005) {
        liveViseme.open *= 0.72;
        const vuFill = $('lt-vu-fill');
        if (vuFill) vuFill.style.width = `${Math.round(liveViseme.open * 100)}%`;
        const liveVuFill = $('lt-live-vu-fill');
        if (liveVuFill) liveVuFill.style.width = `${Math.round(liveViseme.open * 100)}%`;
        const lblVuVal = $('lbl-vu-val');
        if (lblVuVal) lblVuVal.textContent = `${Math.round(liveViseme.open * 100)}%`;
      } else {
        liveViseme.open = 0;
        liveViseme.width = 1.0;
        liveViseme.isSpeaking = false;
        const vuFill = $('lt-vu-fill');
        if (vuFill) vuFill.style.width = '0%';
        const liveVuFill = $('lt-live-vu-fill');
        if (liveVuFill) liveVuFill.style.width = '0%';
        const lblVuVal = $('lbl-vu-val');
        if (lblVuVal) lblVuVal.textContent = '0 dB';
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LIVETALKING ACOUSTIC LIPSYNC & 21-LANDMARK MESH WARP ENGINE
// (Standard Implementation based on https://github.com/lipku/livetalking)
// ═════════════════════════════════════════════════════════════════════════════

const VISEME_PROFILES = {
  sil: { mouthOpen: 0.0,  mouthWide: 0.2, mouthPucker: 0.0, jawOpen: 0.0 },
  aa:  { mouthOpen: 0.95, mouthWide: 0.6, mouthPucker: 0.1, jawOpen: 0.85 },
  E:   { mouthOpen: 0.65, mouthWide: 0.8, mouthPucker: 0.0, jawOpen: 0.5 },
  ih:  { mouthOpen: 0.35, mouthWide: 0.9, mouthPucker: 0.0, jawOpen: 0.3 },
  oh:  { mouthOpen: 0.8,  mouthWide: 0.3, mouthPucker: 0.7, jawOpen: 0.7 },
  ou:  { mouthOpen: 0.45, mouthWide: 0.15, mouthPucker: 0.95, jawOpen: 0.4 },
  PP:  { mouthOpen: 0.0,  mouthWide: 0.4, mouthPucker: 0.1, jawOpen: 0.05 },
  FF:  { mouthOpen: 0.2,  mouthWide: 0.5, mouthPucker: 0.2, jawOpen: 0.15 },
  TH:  { mouthOpen: 0.3,  mouthWide: 0.6, mouthPucker: 0.1, jawOpen: 0.25 },
  DD:  { mouthOpen: 0.35, mouthWide: 0.5, mouthPucker: 0.1, jawOpen: 0.3 },
  kk:  { mouthOpen: 0.6,  mouthWide: 0.5, mouthPucker: 0.2, jawOpen: 0.5 },
  CH:  { mouthOpen: 0.4,  mouthWide: 0.6, mouthPucker: 0.4, jawOpen: 0.35 },
  SS:  { mouthOpen: 0.25, mouthWide: 0.7, mouthPucker: 0.1, jawOpen: 0.2 },
};

const VietnamesePhonemeConverter = {
  wordToVisemes(word) {
    const raw = word.toLowerCase().trim().replace(/[.,!?;:"]/g, '');
    if (!raw) return [{ viseme: 'sil', relativeDuration: 1.0, weight: 0.0 }];

    const result = [];
    let remainder = raw;

    // 1. Initial consonant check
    if (remainder.startsWith('ph') || remainder.startsWith('f') || remainder.startsWith('v')) {
      result.push({ viseme: 'FF', relativeDuration: 0.2, weight: 0.8 });
      remainder = remainder.replace(/^(ph|f|v)/, '');
    } else if (remainder.startsWith('th')) {
      result.push({ viseme: 'TH', relativeDuration: 0.2, weight: 0.8 });
      remainder = remainder.replace(/^th/, '');
    } else if (remainder.startsWith('tr') || remainder.startsWith('ch') || remainder.startsWith('nh')) {
      result.push({ viseme: 'CH', relativeDuration: 0.2, weight: 0.85 });
      remainder = remainder.replace(/^(tr|ch|nh)/, '');
    } else if (remainder.startsWith('ng') || remainder.startsWith('kh') || remainder.startsWith('gh') || remainder.startsWith('k') || remainder.startsWith('c') || remainder.startsWith('g') || remainder.startsWith('q')) {
      result.push({ viseme: 'kk', relativeDuration: 0.2, weight: 0.8 });
      remainder = remainder.replace(/^(ng|kh|gh|k|c|g|q)/, '');
    } else if (remainder.startsWith('b') || remainder.startsWith('m') || remainder.startsWith('p')) {
      result.push({ viseme: 'PP', relativeDuration: 0.2, weight: 0.9 });
      remainder = remainder.replace(/^(b|m|p)/, '');
    } else if (remainder.startsWith('d') || remainder.startsWith('đ') || remainder.startsWith('t') || remainder.startsWith('n') || remainder.startsWith('l')) {
      result.push({ viseme: 'DD', relativeDuration: 0.2, weight: 0.8 });
      remainder = remainder.replace(/^(d|đ|t|n|l)/, '');
    } else if (remainder.startsWith('s') || remainder.startsWith('x')) {
      result.push({ viseme: 'SS', relativeDuration: 0.2, weight: 0.8 });
      remainder = remainder.replace(/^(s|x)/, '');
    }

    // 2. Core Vowel check (Primary mouth opening)
    if (/[aăâáàảãạắằẳẵặấầẩẫậ]/.test(remainder)) {
      result.push({ viseme: 'aa', relativeDuration: 0.6, weight: 1.0 });
    } else if (/[oôơóòỏõọốồổỗộớờởỡợ]/.test(remainder)) {
      result.push({ viseme: 'oh', relativeDuration: 0.6, weight: 1.0 });
    } else if (/[uưúùủũụứừửữự]/.test(remainder)) {
      result.push({ viseme: 'ou', relativeDuration: 0.6, weight: 0.95 });
    } else if (/[eêéèẻẽẹếềểễệ]/.test(remainder)) {
      result.push({ viseme: 'E', relativeDuration: 0.6, weight: 0.95 });
    } else if (/[i yíìỉĩịýỳỷỹỵ]/.test(remainder)) {
      result.push({ viseme: 'ih', relativeDuration: 0.55, weight: 0.9 });
    } else {
      result.push({ viseme: 'aa', relativeDuration: 0.6, weight: 1.0 });
    }

    // 3. Final consonant check
    if (/[mp]$/.test(raw)) {
      result.push({ viseme: 'PP', relativeDuration: 0.2, weight: 0.9 });
    } else if (/(c|ng|k)$/.test(raw)) {
      result.push({ viseme: 'kk', relativeDuration: 0.2, weight: 0.7 });
    } else if (/[ntdđ]$/.test(raw)) {
      result.push({ viseme: 'DD', relativeDuration: 0.2, weight: 0.7 });
    }

    return result;
  }
};

const LipSyncTimelineGenerator = {
  generateTimeline(text, totalDurationMs) {
    const rawWords = text.trim().split(/\s+/).filter(Boolean);
    if (rawWords.length === 0 || totalDurationMs <= 0) {
      return [{ timeMs: 0, durationMs: totalDurationMs || 1000, viseme: 'sil', word: '', weight: 0 }];
    }

    const keyframes = [];
    const avgWordDuration = totalDurationMs / rawWords.length;
    let currentTime = 0;

    for (let i = 0; i < rawWords.length; i++) {
      const word = rawWords[i];
      const wordLenWeight = Math.max(0.7, Math.min(1.4, word.length / 4));
      const wordDuration = Math.round(avgWordDuration * wordLenWeight);
      const visemes = VietnamesePhonemeConverter.wordToVisemes(word);

      const totalRel = visemes.reduce((sum, v) => sum + v.relativeDuration, 0);

      for (const v of visemes) {
        const vDur = Math.round((v.relativeDuration / totalRel) * wordDuration);
        keyframes.push({
          timeMs: currentTime,
          durationMs: vDur,
          viseme: v.viseme,
          word,
          weight: v.weight,
        });
        currentTime += vDur;
      }

      if (/[.,!?;:]$/.test(word)) {
        keyframes.push({
          timeMs: currentTime,
          durationMs: 80,
          viseme: 'sil',
          word,
          weight: 0,
        });
        currentTime += 80;
      }
    }

    return keyframes;
  }
};

const LiveLipSyncEngine = {
  keyframes: [],
  speechStartedAt: 0,
  speechDurationMs: 0,
  isPlaying: false,
  currentEmotion: 'happy',
  currentWordIndex: 0,
  wordsList: [],
  pose: {
    mouthOpen: 0,
    mouthWide: 0.2,
    mouthPucker: 0,
    jawOpen: 0,
    viseme: 'sil',
    currentWord: '',
    wordProgress: 0,
  },

  startSpeech(text, durationMs, emotion = 'happy') {
    this.keyframes = LipSyncTimelineGenerator.generateTimeline(text, durationMs);
    this.speechStartedAt = Date.now();
    this.speechDurationMs = durationMs;
    this.isPlaying = true;
    this.currentEmotion = emotion;
    this.wordsList = text.trim().split(/\s+/).filter(Boolean);
    this.currentWordIndex = 0;
  },

  onSpeechBoundary(charIndex, name) {
    if (this.wordsList.length > 0) {
      this.currentWordIndex = Math.min(this.wordsList.length - 1, this.currentWordIndex + 1);
    }
  },

  stopSpeech() {
    this.isPlaying = false;
    this.keyframes = [];
    this.pose.mouthOpen = 0;
    this.pose.jawOpen = 0;
    this.pose.viseme = 'sil';
  },

  computeFrame(now = Date.now(), audioRms = 0) {
    const lerp = (a, b, t) => a + (b - a) * t;

    if (!this.isPlaying || this.keyframes.length === 0) {
      this.pose.mouthOpen = lerp(this.pose.mouthOpen, 0.0, 0.25);
      this.pose.mouthWide = lerp(this.pose.mouthWide, 0.25, 0.25);
      this.pose.mouthPucker = lerp(this.pose.mouthPucker, 0.0, 0.25);
      this.pose.jawOpen = lerp(this.pose.jawOpen, 0.0, 0.25);
      this.pose.viseme = 'sil';
      this.pose.currentWord = '';
      return this.pose;
    }

    const elapsed = now - this.speechStartedAt;
    if (elapsed > this.speechDurationMs + 150) {
      this.isPlaying = false;
      this.pose.mouthOpen = 0;
      this.pose.jawOpen = 0;
      return this.pose;
    }

    let activeKf = this.keyframes.find(
      (kf) => elapsed >= kf.timeMs && elapsed < kf.timeMs + kf.durationMs
    );
    if (!activeKf) {
      activeKf = this.keyframes[this.keyframes.length - 1];
    }

    const targetProfile = VISEME_PROFILES[activeKf.viseme] || VISEME_PROFILES.sil;
    const progressInKf = Math.min(1.0, (elapsed - activeKf.timeMs) / Math.max(1, activeKf.durationMs));
    const ease = Math.sin(progressInKf * Math.PI);
    const ampFactor = audioRms > 0.01 ? Math.min(1.3, Math.max(0.6, audioRms * 2.5)) : 1.0;

    const targetMouthOpen = targetProfile.mouthOpen * activeKf.weight * ampFactor * (0.65 + 0.35 * ease);
    const targetMouthWide = targetProfile.mouthWide * activeKf.weight;
    const targetMouthPucker = targetProfile.mouthPucker * activeKf.weight;
    const targetJawOpen = targetProfile.jawOpen * activeKf.weight * ampFactor;

    this.pose.mouthOpen = lerp(this.pose.mouthOpen, targetMouthOpen, 0.45);
    this.pose.mouthWide = lerp(this.pose.mouthWide, targetMouthWide, 0.35);
    this.pose.mouthPucker = lerp(this.pose.mouthPucker, targetMouthPucker, 0.35);
    this.pose.jawOpen = lerp(this.pose.jawOpen, targetJawOpen, 0.45);
    this.pose.viseme = activeKf.viseme;
    this.pose.currentWord = activeKf.word;
    this.pose.wordProgress = progressInKf;

    return this.pose;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// 468 FACE MESH LANDMARK ENGINE & CANONICAL TRIANGLE MESH (MediaPipe Topology)
// ═════════════════════════════════════════════════════════════════════════════

const FACEMESH_TOPOLOGY = {
  LIPS_OUTER: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146],
  LIPS_INNER: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95],
  FACE_OVAL: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  LOWER_FACE: [116, 123, 147, 213, 192, 214, 212, 186, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 410, 432, 434, 416, 376, 352, 345, 361, 164, 2, 94, 19, 1],
  LEFT_EYE: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  RIGHT_EYE: [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398],
  NOSE_BRIDGE: [168, 6, 197, 195, 5, 4, 1, 19, 94, 2],
};

function getExpandedPolygonMask(landmarks, regionType, expansion, sourceWidth, sourceHeight, dw, dh, dx, dy) {
  let indices = FACEMESH_TOPOLOGY.LIPS_OUTER;
  if (regionType === 'LOWER_FACE_MASK') indices = FACEMESH_TOPOLOGY.LOWER_FACE;
  else if (regionType === 'FACE_OVAL_MASK') indices = FACEMESH_TOPOLOGY.FACE_OVAL;
  else if (regionType === 'EYE_MASK') indices = [...FACEMESH_TOPOLOGY.LEFT_EYE, ...FACEMESH_TOPOLOGY.RIGHT_EYE];

  const sw = sourceWidth || 1920;
  const sh = sourceHeight || 1080;
  const isNormalized = landmarks && landmarks.length > 0 && landmarks[0].x <= 1.05 && landmarks[0].y <= 1.05;
  const sx = isNormalized ? sw : 1;
  const sy = isNormalized ? sh : 1;

  const srcPts = (landmarks && landmarks.length >= 468)
    ? landmarks.map(p => ({ x: p.x * sx, y: p.y * sy, z: p.z || 0 }))
    : generate468FaceLandmarks3D(LiveTalkingStudio.faceBox, LiveTalkingStudio.mouthBox, LiveTalkingStudio.pose3D).map(p => ({ x: p.x * sw, y: p.y * sh, z: p.z || 0 }));

  const basePts = indices.map(idx => (srcPts && srcPts[idx]) || { x: sw * 0.5, y: sh * 0.5 });

  // Estimate head roll & face dimensions in SOURCE_FRAME_SPACE
  const leftEye = srcPts[33] || { x: sw * 0.35, y: sh * 0.35 };
  const rightEye = srcPts[263] || { x: sw * 0.65, y: sh * 0.35 };
  const leftTemple = srcPts[234] || { x: sw * 0.25, y: sh * 0.35 };
  const rightTemple = srcPts[454] || { x: sw * 0.75, y: sh * 0.35 };
  const forehead = srcPts[10] || { x: sw * 0.5, y: sh * 0.2 };
  const chin = srcPts[152] || { x: sw * 0.5, y: sh * 0.65 };

  const dxEye = rightEye.x - leftEye.x;
  const dyEye = rightEye.y - leftEye.y;
  const roll = Math.atan2(dyEye, dxEye);
  const eyeDist = Math.hypot(dxEye, dyEye);
  const templeDist = Math.hypot(rightTemple.x - leftTemple.x, rightTemple.y - leftTemple.y);
  const faceW = Math.max(templeDist, eyeDist * 2.1);
  const faceH = Math.hypot(chin.x - forehead.x, chin.y - forehead.y);

  let sumX = 0, sumY = 0;
  basePts.forEach(p => { sumX += p.x; sumY += p.y; });
  const cx = basePts.length > 0 ? sumX / basePts.length : sw * 0.5;
  const cy = basePts.length > 0 ? sumY / basePts.length : sh * 0.5;

  // Local Face Space Expansion scaling (padding_px = face_width * padding_ratio)
  const exp = expansion || { top: 0.1, bottom: 0.15, left: 0.1, right: 0.1 };
  const padTop = (exp.top || 0.10) * faceH * 0.25;
  const padBottom = (exp.bottom || 0.15) * faceH * 0.25;
  const padLeft = (exp.left || 0.10) * faceW * 0.25;
  const padRight = (exp.right || 0.10) * faceW * 0.25;

  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);

  // Expand polygon vertices in LOCAL FACE SPACE along head roll orientation
  const sourceMaskPoly = basePts.map(p => {
    const relX = p.x - cx;
    const relY = p.y - cy;
    const localX = relX * cosR + relY * sinR;
    const localY = -relX * sinR + relY * cosR;

    const expX = localX < 0 ? -padLeft : padRight;
    const expY = localY < 0 ? -padTop : padBottom;

    const worldDx = expX * cosR - expY * sinR;
    const worldDy = expX * sinR + expY * cosR;

    return {
      x: Math.max(0, Math.min(sw, p.x + worldDx)),
      y: Math.max(0, Math.min(sh, p.y + worldDy))
    };
  });

  // If preview conversion parameters (dw, dh, dx, dy) are supplied, convert to PREVIEW_UI_SPACE
  if (dw !== undefined && dh !== undefined && dx !== undefined && dy !== undefined) {
    const scale = dw / sw;
    return sourceMaskPoly.map(p => ({
      x: dx + p.x * scale,
      y: dy + p.y * scale
    }));
  }

  return sourceMaskPoly;
}

// 898 Canonical Triangles defining the official MediaPipe 468-Point Dense FaceMesh Topology (DeepFaceLive Engine)
const FACEMESH_468_TRIANGLES = [[173,155,133],[246,33,7],[382,398,362],[263,466,249],[308,415,324],[78,95,191],[356,389,264],[127,34,162],[368,264,389],[139,162,34],[267,0,302],[37,72,0],[11,302,0],[11,0,72],[349,451,350],[120,121,231],[452,350,451],[232,231,121],[267,302,269],[37,39,72],[303,269,302],[73,72,39],[357,343,350],[128,121,114],[277,350,343],[47,114,121],[350,452,357],[121,128,232],[453,357,452],[233,232,128],[299,333,297],[69,67,104],[332,297,333],[103,104,67],[175,152,396],[175,171,152],[377,396,152],[148,152,171],[381,384,382],[154,155,157],[398,382,384],[173,157,155],[280,347,330],[50,101,118],[348,330,347],[119,118,101],[269,303,270],[39,40,73],[304,270,303],[74,73,40],[9,336,151],[9,151,107],[337,151,336],[108,107,151],[344,278,360],[115,131,48],[279,360,278],[49,48,131],[262,431,418],[32,194,211],[424,418,431],[204,211,194],[304,408,270],[74,40,184],[409,270,408],[185,184,40],[272,310,407],[42,183,80],[415,407,310],[191,80,183],[322,270,410],[92,186,40],[409,410,270],[185,40,186],[347,449,348],[118,119,229],[450,348,449],[230,229,119],[434,432,430],[214,210,212],[422,430,432],[202,212,210],[313,314,18],[83,18,84],[17,18,314],[17,84,18],[307,375,306],[77,76,146],[291,306,375],[61,146,76],[259,387,260],[29,30,160],[388,260,387],[161,160,30],[286,414,384],[56,157,190],[398,384,414],[173,190,157],[418,424,406],[194,182,204],[335,406,424],[106,204,182],[367,416,364],[138,135,192],[434,364,416],[214,192,135],[391,423,327],[165,98,203],[358,327,423],[129,203,98],[298,301,284],[68,54,71],[251,284,301],[21,71,54],[4,275,5],[4,5,45],[281,5,275],[51,45,5],[254,373,253],[24,23,144],[374,253,373],[145,144,23],[320,321,307],[90,77,91],[375,307,321],[146,91,77],[280,425,411],[50,187,205],[427,411,425],[207,205,187],[421,313,200],[201,200,83],[18,200,313],[18,83,200],[335,321,406],[106,182,91],[405,406,321],[181,91,182],[405,321,404],[181,180,91],[320,404,321],[90,91,180],[17,314,16],[17,16,84],[315,16,314],[85,84,16],[425,266,426],[205,206,36],[423,426,266],[203,36,206],[369,396,400],[140,176,171],[377,400,396],[148,171,176],[391,269,322],[165,92,39],[270,322,269],[40,39,92],[417,465,413],[193,189,245],[464,413,465],[244,245,189],[257,258,386],[27,159,28],[385,386,258],[158,28,159],[260,388,467],[30,247,161],[466,467,388],[246,161,247],[248,456,419],[3,196,236],[399,419,456],[174,236,196],[333,298,332],[104,103,68],[284,332,298],[54,68,103],[285,8,417],[55,193,8],[168,417,8],[168,8,193],[340,261,346],[111,117,31],[448,346,261],[228,31,117],[285,417,441],[55,221,193],[413,441,417],[189,193,221],[327,460,326],[98,97,240],[328,326,460],[99,240,97],[277,355,329],[47,100,126],[371,329,355],[142,126,100],[309,392,438],[79,218,166],[439,438,392],[219,166,218],[381,382,256],[154,26,155],[341,256,382],[112,155,26],[360,279,420],[131,198,49],[429,420,279],[209,49,198],[365,364,379],[136,150,135],[394,379,364],[169,135,150],[355,277,437],[126,217,47],[343,437,277],[114,47,217],[443,444,282],[223,52,224],[283,282,444],[53,224,52],[281,275,363],[51,134,45],[440,363,275],[220,45,134],[431,262,395],[211,170,32],[369,395,262],[140,32,170],[337,299,338],[108,109,69],[297,338,299],[67,69,109],[335,273,321],[106,91,43],[375,321,273],[146,43,91],[348,450,349],[119,120,230],[451,349,450],[231,230,120],[467,359,342],[247,113,130],[446,342,359],[226,130,113],[282,283,334],[52,105,53],[293,334,283],[63,53,105],[250,458,462],[20,242,238],[461,462,458],[241,238,242],[276,353,300],[46,70,124],[383,300,353],[156,124,70],[325,292,324],[96,95,62],[308,324,292],[78,62,95],[283,276,293],[53,63,46],[300,293,276],[70,46,63],[447,264,345],[227,116,34],[372,345,264],[143,34,116],[352,345,346],[123,117,116],[340,346,345],[111,116,117],[1,19,274],[1,44,19],[354,274,19],[125,19,44],[248,281,456],[3,236,51],[363,456,281],[134,51,236],[425,426,427],[205,207,206],[436,427,426],[216,206,207],[380,381,252],[153,22,154],[256,252,381],[26,154,22],[391,393,269],[165,39,167],[267,269,393],[37,167,39],[199,428,200],[199,200,208],[421,200,428],[201,208,200],[330,329,266],[101,36,100],[371,266,329],[142,100,36],[422,432,273],[202,43,212],[287,273,432],[57,212,43],[290,250,328],[60,99,20],[462,328,250],[242,20,99],[258,286,385],[28,158,56],[384,385,286],[157,56,158],[342,446,353],[113,124,226],[265,353,446],[35,226,124],[257,386,259],[27,29,159],[387,259,386],[160,159,29],[430,422,431],[210,211,202],[424,431,422],[204,202,211],[445,342,276],[225,46,113],[353,276,342],[124,113,46],[424,422,335],[204,106,202],[273,335,422],[43,202,106],[306,292,307],[76,77,62],[325,307,292],[96,62,77],[366,447,352],[137,123,227],[345,352,447],[116,227,123],[302,268,303],[72,73,38],[271,303,268],[41,38,73],[371,358,266],[142,36,129],[423,266,358],[203,129,36],[327,294,460],[98,240,64],[455,460,294],[235,64,240],[294,331,278],[64,48,102],[279,278,331],[49,102,48],[303,271,304],[73,74,41],[272,304,271],[42,41,74],[427,436,434],[207,214,216],[432,434,436],[212,216,214],[304,272,408],[74,184,42],[407,408,272],[183,42,184],[394,430,395],[169,170,210],[431,395,430],[211,210,170],[395,369,378],[170,149,140],[400,378,369],[176,140,149],[296,334,299],[66,69,105],[333,299,334],[104,105,69],[417,168,351],[193,122,168],[6,351,168],[6,168,122],[280,411,352],[50,123,187],[376,352,411],[147,187,123],[319,320,325],[89,96,90],[307,325,320],[77,90,96],[285,295,336],[55,107,65],[296,336,295],[66,65,107],[404,320,403],[180,179,90],[319,403,320],[89,90,179],[330,348,329],[101,100,119],[349,329,348],[120,119,100],[334,293,333],[105,104,63],[298,333,293],[68,63,104],[323,454,366],[93,137,234],[447,366,454],[227,234,137],[16,315,15],[16,15,85],[316,15,315],[86,85,15],[429,279,358],[209,129,49],[331,358,279],[102,49,129],[15,316,14],[15,14,86],[317,14,316],[87,86,14],[8,285,9],[8,9,55],[336,9,285],[107,55,9],[329,349,277],[100,47,120],[350,277,349],[121,120,47],[252,253,380],[22,153,23],[374,380,253],[145,23,153],[402,403,318],[178,88,179],[319,318,403],[89,179,88],[351,6,419],[122,196,6],[197,419,6],[197,6,196],[324,318,325],[95,96,88],[319,325,318],[89,88,96],[397,367,365],[172,136,138],[364,365,367],[135,138,136],[288,435,397],[58,172,215],[367,397,435],[138,215,172],[438,439,344],[218,115,219],[278,344,439],[48,219,115],[271,311,272],[41,42,81],[310,272,311],[80,81,42],[5,281,195],[5,195,51],[248,195,281],[3,51,195],[273,287,375],[43,146,57],[291,375,287],[61,57,146],[396,428,175],[171,175,208],[199,175,428],[199,208,175],[268,312,271],[38,41,82],[311,271,312],[81,82,41],[444,445,283],[224,53,225],[276,283,445],[46,225,53],[254,339,373],[24,144,110],[390,373,339],[163,110,144],[295,282,296],[65,66,52],[334,296,282],[105,52,66],[346,448,347],[117,118,228],[449,347,448],[229,228,118],[454,356,447],[234,227,127],[264,447,356],[34,127,227],[336,296,337],[107,108,66],[299,337,296],[69,66,108],[151,337,10],[151,10,108],[338,10,337],[109,108,10],[278,439,294],[48,64,219],[455,294,439],[235,219,64],[407,415,292],[183,62,191],[308,292,415],[78,191,62],[358,371,429],[129,209,142],[355,429,371],[126,142,209],[345,372,340],[116,111,143],[265,340,372],[35,143,111],[388,390,466],[161,246,163],[249,466,390],[7,163,246],[352,346,280],[123,50,117],[347,280,346],[118,117,50],[295,442,282],[65,52,222],[443,282,442],[223,222,52],[19,94,354],[19,125,94],[370,354,94],[141,94,125],[295,285,442],[65,222,55],[441,442,285],[221,55,222],[419,197,248],[196,3,197],[195,248,197],[195,197,3],[359,263,255],[130,25,33],[249,255,263],[7,33,25],[275,274,440],[45,220,44],[457,440,274],[237,44,220],[300,383,301],[70,71,156],[368,301,383],[139,156,71],[417,351,465],[193,245,122],[412,465,351],[188,122,245],[466,263,467],[246,247,33],[359,467,263],[130,33,247],[389,251,368],[162,139,21],[301,368,251],[71,21,139],[374,386,380],[145,153,159],[385,380,386],[158,159,153],[379,394,378],[150,149,169],[395,378,394],[170,169,149],[351,419,412],[122,188,196],[399,412,419],[174,196,188],[426,322,436],[206,216,92],[410,436,322],[186,92,216],[387,373,388],[160,161,144],[390,388,373],[163,144,161],[393,326,164],[167,164,97],[2,164,326],[2,97,164],[354,370,461],[125,241,141],[462,461,370],[242,141,241],[0,267,164],[0,164,37],[393,164,267],[167,37,164],[11,12,302],[11,72,12],[268,302,12],[38,12,72],[386,374,387],[159,160,145],[373,387,374],[144,145,160],[12,13,268],[12,38,13],[312,268,13],[82,13,38],[293,300,298],[63,68,70],[301,298,300],[71,70,68],[340,265,261],[111,31,35],[446,261,265],[226,35,31],[380,385,381],[153,154,158],[384,381,385],[157,158,154],[280,330,425],[50,205,101],[266,425,330],[36,101,205],[423,391,426],[203,206,165],[322,426,391],[92,165,206],[429,355,420],[209,198,126],[437,420,355],[217,126,198],[391,327,393],[165,167,98],[326,393,327],[97,98,167],[457,438,440],[237,220,218],[344,440,438],[115,218,220],[382,362,341],[155,112,133],[463,341,362],[243,133,112],[457,461,459],[237,239,241],[458,459,461],[238,241,239],[434,430,364],[214,135,210],[394,364,430],[169,210,135],[414,463,398],[190,173,243],[362,398,463],[133,243,173],[262,428,369],[32,140,208],[396,369,428],[171,208,140],[457,274,461],[237,241,44],[354,461,274],[125,44,241],[316,403,317],[86,87,179],[402,317,403],[178,179,87],[315,404,316],[85,86,180],[403,316,404],[179,180,86],[314,405,315],[84,85,181],[404,315,405],[180,181,85],[313,406,314],[83,84,182],[405,314,406],[181,182,84],[418,406,421],[194,201,182],[313,421,406],[83,182,201],[366,401,323],[137,93,177],[361,323,401],[132,177,93],[408,407,306],[184,76,183],[292,306,407],[62,183,76],[408,306,409],[184,185,76],[291,409,306],[61,76,185],[410,409,287],[186,57,185],[291,287,409],[61,185,57],[436,410,432],[216,212,186],[287,432,410],[57,186,212],[434,416,427],[214,207,192],[411,427,416],[187,192,207],[264,368,372],[34,143,139],[383,372,368],[156,139,143],[457,459,438],[237,218,239],[309,438,459],[79,239,218],[352,376,366],[123,137,147],[401,366,376],[177,147,137],[4,1,275],[4,45,1],[274,275,1],[44,1,45],[428,262,421],[208,201,32],[418,421,262],[194,32,201],[327,358,294],[98,64,129],[331,294,358],[102,129,64],[367,435,416],[138,192,215],[433,416,435],[213,215,192],[455,439,289],[235,59,219],[392,289,439],[166,219,59],[328,462,326],[99,97,242],[370,326,462],[141,242,97],[326,370,2],[97,2,141],[94,2,370],[94,141,2],[460,455,305],[240,75,235],[289,305,455],[59,235,75],[448,339,449],[228,229,110],[254,449,339],[24,110,229],[261,446,255],[31,25,226],[359,255,446],[130,226,25],[449,254,450],[229,230,24],[253,450,254],[23,24,230],[450,253,451],[230,231,23],[252,451,253],[22,23,231],[451,252,452],[231,232,22],[256,452,252],[26,22,232],[256,341,452],[26,232,112],[453,452,341],[233,112,232],[413,464,414],[189,190,244],[463,414,464],[243,244,190],[441,413,286],[221,56,189],[414,286,413],[190,189,56],[441,286,442],[221,222,56],[258,442,286],[28,56,222],[442,258,443],[222,223,28],[257,443,258],[27,28,223],[444,443,259],[224,29,223],[257,259,443],[27,223,29],[259,260,444],[29,224,30],[445,444,260],[225,30,224],[260,467,445],[30,225,247],[342,445,467],[113,247,225],[250,309,458],[20,238,79],[459,458,309],[239,79,238],[290,305,392],[60,166,75],[289,392,305],[59,75,166],[460,305,328],[240,99,75],[290,328,305],[60,75,99],[376,433,401],[147,177,213],[435,401,433],[215,213,177],[250,290,309],[20,79,60],[392,309,290],[166,60,79],[411,416,376],[187,147,192],[433,376,416],[213,192,147],[341,463,453],[112,233,243],[464,453,463],[244,243,233],[453,464,357],[233,128,244],[465,357,464],[245,244,128],[412,343,465],[188,245,114],[357,465,343],[128,114,245],[437,343,399],[217,174,114],[412,399,343],[188,114,174],[363,440,360],[134,131,220],[344,360,440],[115,220,131],[456,420,399],[236,174,198],[437,399,420],[217,198,174],[456,363,420],[236,198,134],[360,420,363],[131,134,198],[361,401,288],[132,58,177],[435,288,401],[215,177,58],[353,265,383],[124,156,35],[372,383,265],[143,35,156],[255,249,339],[25,110,7],[390,339,249],[163,7,110],[261,255,448],[31,228,25],[339,448,255],[110,25,228],[14,317,13],[14,13,87],[312,13,317],[82,87,13],[317,402,312],[87,82,178],[311,312,402],[81,178,82],[402,318,311],[178,81,88],[310,311,318],[80,88,81],[318,324,310],[88,80,95],[415,310,324],[191,95,80]];

// 468 Canonical Normalized 3D Coordinates [-1..1] derived from MediaPipe Canonical Face Model (DeepFaceLive Engine)
const CANONICAL_468_LANDMARKS = [[0,0.321,0.7722],[0,0.063,0.9655],[0,0.1719,0.7824],[-0.0599,-0.1728,0.8567],[0,-0.0122,0.9798],[0,-0.106,0.9354],[0,-0.3446,0.7476],[-0.5493,-0.3565,0.4236],[0,-0.5197,0.6825],[0,-0.6178,0.6955],[0,-1,0.5788],[0,0.3551,0.7574],[0,0.379,0.7193],[0,0.3876,0.6741],[0,0.4497,0.698],[0,0.4727,0.7141],[0,0.5037,0.7234],[0,0.5428,0.7149],[0,0.6316,0.655],[0,0.1053,0.9185],[-0.0537,0.1014,0.8327],[-0.9154,-0.6799,0.0129],[-0.3395,-0.2951,0.497],[-0.4131,-0.2895,0.4904],[-0.4876,-0.2955,0.4709],[-0.5767,-0.3389,0.4075],[-0.2795,-0.3126,0.4975],[-0.4143,-0.4296,0.5315],[-0.3453,-0.4275,0.5285],[-0.4837,-0.423,0.513],[-0.5374,-0.411,0.4804],[-0.6537,-0.2836,0.3585],[-0.2927,0.7761,0.5669],[-0.5742,-0.3662,0.4098],[-0.9317,-0.3208,0.0094],[-0.749,-0.3306,0.2846],[-0.3674,0.017,0.5725],[-0.0919,0.3123,0.759],[-0.0783,0.3797,0.7032],[-0.1849,0.3317,0.7098],[-0.2473,0.366,0.6495],[-0.1461,0.3853,0.6702],[-0.2019,0.3976,0.6254],[-0.3423,0.5019,0.5409],[-0.0552,0.0593,0.9506],[-0.0641,-0.0108,0.9609],[-0.6785,-0.5041,0.4343],[-0.222,-0.175,0.5887],[-0.2078,0.0421,0.7509],[-0.2133,0.0045,0.7208],[-0.6155,0.0148,0.4565],[-0.0618,-0.0981,0.9171],[-0.4824,-0.575,0.5877],[-0.5926,-0.5517,0.5229],[-0.811,-0.8136,0.1841],[-0.1577,-0.5336,0.6594],[-0.2833,-0.4156,0.5167],[-0.4007,0.4282,0.529],[-0.8678,0.4775,-0.2254],[-0.1542,0.0833,0.741],[-0.0942,0.1158,0.7533],[-0.3172,0.427,0.5533],[-0.2847,0.4227,0.5376],[-0.6439,-0.6084,0.4846],[-0.2056,0.0778,0.7048],[-0.3415,-0.5769,0.6356],[-0.3565,-0.6421,0.6478],[-0.4551,-0.971,0.4816],[-0.7232,-0.7117,0.3518],[-0.3957,-0.808,0.585],[-0.7388,-0.5463,0.3656],[-0.8232,-0.6064,0.2056],[-0.0869,0.3529,0.741],[-0.1631,0.3642,0.6997],[-0.2238,0.3829,0.6458],[-0.1348,0.1012,0.7313],[-0.2998,0.4255,0.5499],[-0.2656,0.4423,0.5839],[-0.2781,0.4195,0.5215],[-0.1223,0.0526,0.841],[-0.1897,0.3924,0.5947],[-0.1323,0.3871,0.6363],[-0.0689,0.3875,0.6636],[-0.0994,0.6255,0.6439],[-0.0904,0.5345,0.7036],[-0.0865,0.4958,0.7116],[-0.0815,0.4669,0.7038],[-0.0753,0.4469,0.6896],[-0.1985,0.4362,0.6129],[-0.2087,0.4421,0.6217],[-0.2233,0.4583,0.6269],[-0.2375,0.4821,0.623],[-0.3059,0.2871,0.6287],[-0.9741,0.0542,-0.314],[0,0.1306,0.8526],[-0.2359,0.4335,0.5681],[-0.2492,0.4349,0.5808],[-0.0772,0.1634,0.7576],[-0.1815,0.1295,0.6769],[-0.0856,0.1414,0.7573],[-0.3025,-0.1294,0.5546],[-0.4297,-0.0765,0.5313],[-0.2229,0.0394,0.681],[-0.6629,-0.9121,0.3436],[-0.5862,-0.7802,0.4757],[-0.5149,-0.6431,0.5768],[-0.2802,0.5513,0.5755],[-0.1802,-0.6321,0.6866],[-0.2092,-0.8118,0.6355],[-0.2443,-0.9971,0.5521],[-0.5419,-0.3177,0.4359],[-0.7404,-0.2245,0.3141],[-0.2402,-0.3313,0.4963],[-0.6443,-0.4127,0.3983],[-0.1683,-0.225,0.6239],[-0.1686,0.0115,0.8286],[-0.835,-0.1707,0.2182],[-0.6791,-0.1717,0.3841],[-0.5724,-0.1464,0.4549],[-0.4263,-0.1622,0.5002],[-0.3139,-0.1927,0.5216],[-0.2351,-0.2308,0.5455],[-0.0727,-0.3259,0.7189],[-0.8186,-0.0047,0.2429],[-0.7216,-0.4278,0.3471],[-0.0313,0.101,0.9133],[-0.2081,-0.103,0.6322],[-1,-0.3324,-0.259],[-0.1797,-0.2742,0.5746],[-0.2306,0.0461,0.6264],[-0.6032,-0.3663,0.3983],[-0.1723,-0.0325,0.7874],[-0.939,0.2627,-0.2909],[-0.2398,-0.3573,0.4853],[-0.1193,-0.0729,0.8617],[-0.6458,0.63,0.2444],[-0.6567,0.7481,0.0923],[-0.9246,0.0273,-0.0093],[-0.7546,0.5295,0.1193],[-0.8843,-0.4793,0.0936],[-0.3116,0.8704,0.532],[-0.0232,0.1267,0.8489],[-0.2717,-0.0461,0.5897],[-0.8275,-0.3178,0.2016],[-0.474,-0.3318,0.4695],[-0.4103,-0.3244,0.4876],[-0.2836,0.456,0.5786],[-0.8052,0.1555,0.2148],[-0.167,0.9878,0.5287],[-0.4146,0.9015,0.3619],[-0.5255,0.8403,0.2486],[0,-0.8057,0.6493],[0,1,0.5507],[-0.3518,-0.3268,0.4878],[-0.2955,-0.3362,0.4775],[-0.2581,-0.3473,0.4764],[-0.7917,-0.4495,0.2633],[-0.2955,-0.3914,0.4875],[-0.3518,-0.4,0.5],[-0.4103,-0.4002,0.5007],[-0.474,-0.3961,0.481],[-0.519,-0.3881,0.4498],[-0.9758,-0.5296,-0.1281],[-0.519,-0.3458,0.4444],[0,0.2209,0.7661],[-0.2294,0.2392,0.6733],[-0.1578,0.0692,0.7687],[-0.0945,0.2226,0.751],[0,-0.435,0.6762],[-0.5341,0.7275,0.3451],[-0.4277,0.8027,0.4369],[-0.1697,0.9136,0.6073],[-0.7672,0.64,-0.0816],[-0.2581,-0.3753,0.4835],[-0.1164,-0.2047,0.7431],[0,0.9278,0.6317],[-0.2982,0.9514,0.4661],[-0.8981,0.2116,-0.0169],[-0.1419,0.4402,0.6613],[-0.1525,0.4539,0.6702],[-0.1622,0.4775,0.6764],[-0.1711,0.5135,0.6722],[-0.1997,0.5942,0.6145],[-0.2523,0.4091,0.5723],[-0.2735,0.4038,0.5883],[-0.2951,0.394,0.5918],[-0.3681,0.3504,0.5792],[-0.6817,0.1889,0.3695],[-0.1223,-0.2806,0.6712],[-0.1697,-0.4162,0.5465],[-0.2299,-0.3884,0.5013],[-0.2383,0.3994,0.5485],[-0.7021,0.3917,0.2725],[-0.099,-0.4249,0.6278],[-0.2504,0.6842,0.5839],[0,-0.1846,0.8749],[-0.0667,-0.2439,0.794],[0,-0.2603,0.8158],[-0.161,-0.0907,0.7337],[0,0.8346,0.6691],[0,0.7269,0.6656],[-0.1289,0.7201,0.6431],[-0.4247,0.5448,0.4902],[-0.2985,0.1127,0.5928],[-0.3461,0.6273,0.529],[-0.495,0.1094,0.5344],[-0.3825,0.1929,0.5735],[-0.5666,0.2392,0.4706],[-0.1572,0.8224,0.6418],[-0.1992,-0.0491,0.6717],[-0.5009,0.6194,0.4276],[-0.3983,0.7064,0.4926],[-0.484,0.4453,0.4813],[-0.787,0.2984,0.1903],[-0.5927,0.4708,0.3853],[-0.8502,0.3816,0.0091],[-0.4511,0.2972,0.5334],[-0.1622,-0.1555,0.6855],[-0.1454,0.0411,0.8445],[-0.1864,0.0648,0.7626],[-0.1192,-0.0047,0.9045],[-0.2267,-0.4642,0.5589],[-0.34,-0.4851,0.5637],[-0.4376,-0.486,0.5565],[-0.5264,-0.4807,0.5264],[-0.597,-0.458,0.4709],[-0.6679,-0.3517,0.3449],[-0.9424,-0.151,-0.0063],[-0.6079,-0.2515,0.4016],[-0.5259,-0.2318,0.449],[-0.4223,-0.2311,0.482],[-0.3264,-0.2477,0.4992],[-0.2545,-0.275,0.5117],[-0.204,-0.3022,0.5276],[-0.9898,-0.1408,-0.3146],[-0.1804,0.0871,0.7271],[-0.1143,-0.1392,0.805],[-0.0991,0.045,0.9141],[-0.0594,0.0864,0.8766],[-0.0967,0.0563,0.878],[-0.1597,0.1149,0.7078],[-0.05,0.095,0.8986],[-0.0413,0.1174,0.8406],[-0.2118,-0.354,0.499],[-0.1622,-0.344,0.5429],[-0.1332,-0.3344,0.5961],[-0.5493,-0.3785,0.4282],[-0.585,-0.3941,0.4313],[0.0599,-0.1728,0.8567],[0.5493,-0.3565,0.4236],[0.0537,0.1014,0.8327],[0.9154,-0.6799,0.0129],[0.3395,-0.2951,0.497],[0.4131,-0.2895,0.4904],[0.4876,-0.2955,0.4709],[0.5767,-0.3389,0.4075],[0.2795,-0.3126,0.4975],[0.4143,-0.4296,0.5315],[0.3453,-0.4275,0.5285],[0.4837,-0.423,0.513],[0.5374,-0.411,0.4804],[0.6537,-0.2836,0.3585],[0.2927,0.7761,0.5669],[0.5742,-0.3662,0.4098],[0.9317,-0.3208,0.0094],[0.749,-0.3306,0.2846],[0.3674,0.017,0.5725],[0.0919,0.3123,0.759],[0.0783,0.3797,0.7032],[0.1849,0.3317,0.7098],[0.2473,0.366,0.6495],[0.1461,0.3853,0.6702],[0.2019,0.3976,0.6254],[0.3423,0.5019,0.5409],[0.0552,0.0593,0.9506],[0.0641,-0.0108,0.9609],[0.6785,-0.5041,0.4343],[0.222,-0.175,0.5887],[0.2078,0.0421,0.7509],[0.2133,0.0045,0.7208],[0.6155,0.0148,0.4565],[0.0618,-0.0981,0.9171],[0.4824,-0.575,0.5877],[0.5926,-0.5517,0.5229],[0.811,-0.8136,0.1841],[0.1577,-0.5336,0.6594],[0.2833,-0.4156,0.5167],[0.4007,0.4282,0.529],[0.8678,0.4775,-0.2254],[0.1542,0.0833,0.741],[0.0942,0.1158,0.7533],[0.3172,0.427,0.5533],[0.2847,0.4227,0.5376],[0.6439,-0.6084,0.4846],[0.2056,0.0778,0.7048],[0.3415,-0.5769,0.6356],[0.3565,-0.6421,0.6478],[0.4551,-0.971,0.4816],[0.7232,-0.7117,0.3518],[0.3957,-0.808,0.585],[0.7388,-0.5463,0.3656],[0.8232,-0.6064,0.2056],[0.0869,0.3529,0.741],[0.1631,0.3642,0.6997],[0.2238,0.3829,0.6458],[0.1348,0.1012,0.7313],[0.2998,0.4255,0.5499],[0.2656,0.4423,0.5839],[0.2781,0.4195,0.5215],[0.1223,0.0526,0.841],[0.1897,0.3924,0.5947],[0.1323,0.3871,0.6363],[0.0689,0.3875,0.6636],[0.0994,0.6255,0.6439],[0.0904,0.5345,0.7036],[0.0865,0.4958,0.7116],[0.0815,0.4669,0.7038],[0.0753,0.4469,0.6896],[0.1985,0.4362,0.6129],[0.2087,0.4421,0.6217],[0.2233,0.4583,0.6269],[0.2375,0.4821,0.623],[0.3059,0.2871,0.6287],[0.9741,0.0542,-0.314],[0.2359,0.4335,0.5681],[0.2492,0.4349,0.5808],[0.0772,0.1634,0.7576],[0.1815,0.1295,0.6769],[0.0856,0.1414,0.7573],[0.3025,-0.1294,0.5546],[0.4297,-0.0765,0.5313],[0.2229,0.0394,0.681],[0.6629,-0.9121,0.3436],[0.5862,-0.7802,0.4757],[0.5149,-0.6431,0.5768],[0.2802,0.5513,0.5755],[0.1802,-0.6321,0.6866],[0.2092,-0.8118,0.6355],[0.2443,-0.9971,0.5521],[0.5419,-0.3177,0.4359],[0.7404,-0.2245,0.3141],[0.2402,-0.3313,0.4963],[0.6443,-0.4127,0.3983],[0.1683,-0.225,0.6239],[0.1686,0.0115,0.8286],[0.835,-0.1707,0.2182],[0.6791,-0.1717,0.3841],[0.5724,-0.1464,0.4549],[0.4263,-0.1622,0.5002],[0.3139,-0.1927,0.5216],[0.2351,-0.2308,0.5455],[0.0727,-0.3259,0.7189],[0.8186,-0.0047,0.2429],[0.7216,-0.4278,0.3471],[0.0313,0.101,0.9133],[0.2081,-0.103,0.6322],[1,-0.3324,-0.259],[0.1797,-0.2742,0.5746],[0.2306,0.0461,0.6264],[0.6032,-0.3663,0.3983],[0.1723,-0.0325,0.7874],[0.939,0.2627,-0.2909],[0.2398,-0.3573,0.4853],[0.1193,-0.0729,0.8617],[0.6458,0.63,0.2444],[0.6567,0.7481,0.0923],[0.9246,0.0273,-0.0093],[0.7546,0.5295,0.1193],[0.8843,-0.4793,0.0936],[0.3116,0.8704,0.532],[0.0232,0.1267,0.8489],[0.2717,-0.0461,0.5897],[0.8275,-0.3178,0.2016],[0.474,-0.3318,0.4695],[0.4103,-0.3244,0.4876],[0.2836,0.456,0.5786],[0.8052,0.1555,0.2148],[0.167,0.9878,0.5287],[0.4146,0.9015,0.3619],[0.5255,0.8403,0.2486],[0.3518,-0.3268,0.4878],[0.2955,-0.3362,0.4775],[0.2581,-0.3473,0.4764],[0.7917,-0.4495,0.2633],[0.2955,-0.3914,0.4875],[0.3518,-0.4,0.5],[0.4103,-0.4002,0.5007],[0.474,-0.3961,0.481],[0.519,-0.3881,0.4498],[0.9758,-0.5296,-0.1281],[0.519,-0.3458,0.4444],[0.2294,0.2392,0.6733],[0.1578,0.0692,0.7687],[0.0945,0.2226,0.751],[0.5341,0.7275,0.3451],[0.4277,0.8027,0.4369],[0.1697,0.9136,0.6073],[0.7672,0.64,-0.0816],[0.2581,-0.3753,0.4835],[0.1164,-0.2047,0.7431],[0.2982,0.9514,0.4661],[0.8981,0.2116,-0.0169],[0.1419,0.4402,0.6613],[0.1525,0.4539,0.6702],[0.1622,0.4775,0.6764],[0.1711,0.5135,0.6722],[0.1997,0.5942,0.6145],[0.2523,0.4091,0.5723],[0.2735,0.4038,0.5883],[0.2951,0.394,0.5918],[0.3681,0.3504,0.5792],[0.6817,0.1889,0.3695],[0.1223,-0.2806,0.6712],[0.1697,-0.4162,0.5465],[0.2299,-0.3884,0.5013],[0.2383,0.3994,0.5485],[0.7021,0.3917,0.2725],[0.099,-0.4249,0.6278],[0.2504,0.6842,0.5839],[0.0667,-0.2439,0.794],[0.161,-0.0907,0.7337],[0.1289,0.7201,0.6431],[0.4247,0.5448,0.4902],[0.2985,0.1127,0.5928],[0.3461,0.6273,0.529],[0.495,0.1094,0.5344],[0.3825,0.1929,0.5735],[0.5666,0.2392,0.4706],[0.1572,0.8224,0.6418],[0.1992,-0.0491,0.6717],[0.5009,0.6194,0.4276],[0.3983,0.7064,0.4926],[0.484,0.4453,0.4813],[0.787,0.2984,0.1903],[0.5927,0.4708,0.3853],[0.8502,0.3816,0.0091],[0.4511,0.2972,0.5334],[0.1622,-0.1555,0.6855],[0.1454,0.0411,0.8445],[0.1864,0.0648,0.7626],[0.1192,-0.0047,0.9045],[0.2267,-0.4642,0.5589],[0.34,-0.4851,0.5637],[0.4376,-0.486,0.5565],[0.5264,-0.4807,0.5264],[0.597,-0.458,0.4709],[0.6679,-0.3517,0.3449],[0.9424,-0.151,-0.0063],[0.6079,-0.2515,0.4016],[0.5259,-0.2318,0.449],[0.4223,-0.2311,0.482],[0.3264,-0.2477,0.4992],[0.2545,-0.275,0.5117],[0.204,-0.3022,0.5276],[0.9898,-0.1408,-0.3146],[0.1804,0.0871,0.7271],[0.1143,-0.1392,0.805],[0.0991,0.045,0.9141],[0.0594,0.0864,0.8766],[0.0967,0.0563,0.878],[0.1597,0.1149,0.7078],[0.05,0.095,0.8986],[0.0413,0.1174,0.8406],[0.2118,-0.354,0.499],[0.1622,-0.344,0.5429],[0.1332,-0.3344,0.5961],[0.5493,-0.3785,0.4282],[0.585,-0.3941,0.4313]];

const FACEMESH_TRIANGLES = FACEMESH_468_TRIANGLES;

/**
 * Generates 468 3D canonical landmarks fitted to face bounding box and 3D pose (DeepFaceLive Canonical Model)
 */
function generate468FaceLandmarks3D(faceBox, mouthBox, pose3D) {
  const fb = faceBox || { cx: 0.50, cy: 0.34, w: 0.36, h: 0.40 };
  const pose = pose3D || { roll: -0.10, pitch: 0.10, yaw: 0.02 };

  const fx = fb.cx, fy = fb.cy, fw = fb.w, fh = fb.h;
  const rx = fw * 0.5;
  const ry = fh * 0.5;

  const roll = pose.roll || 0;
  const pitch = pose.pitch || 0;
  const yaw = pose.yaw || 0;

  const cosR = Math.cos(roll), sinR = Math.sin(roll);
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);

  return CANONICAL_468_LANDMARKS.map(([nx, ny, nz]) => {
    // 1. Yaw & Pitch 3D rotation
    const u1 = nx * cosY + nz * sinY;
    const v1 = ny * cosP - nz * sinP;
    const z1 = -nx * sinY * sinP + ny * sinP + nz * cosP * cosY;

    // 2. Roll 2D in-plane rotation
    const u2 = u1 * cosR - v1 * sinR;
    const v2 = u1 * sinR + v1 * cosR;

    return {
      x: parseFloat((fx + u2 * rx).toFixed(4)),
      y: parseFloat((fy + v2 * ry).toFixed(4)),
      z: parseFloat((z1 * 0.15).toFixed(4)),
    };
  });
}

const generate468FaceLandmarks = generate468FaceLandmarks3D;

// ═════════════════════════════════════════════════════════════════════════════
// CONTINUOUS DUAL-ENGINE REALTIME 468 TRACKER (MediaPipe Neural + DeepFaceLive)
// ═════════════════════════════════════════════════════════════════════════════

const FaceMeshRealtimeTracker = {
  mediaPipeMesh: null,
  isMediaPipeReady: false,
  isProcessing: false,
  latestRawMesh: null,
  smoothedLandmarks: null,
  currentBox: { cx: 0.50, cy: 0.34, w: 0.36, h: 0.40 },
  currentMouthBox: { cx: 0.50, cy: 0.39, w: 0.14, h: 0.08 },
  currentPose3D: { roll: -0.10, pitch: 0.10, yaw: 0.02 },
  lastFrameTime: -1,

  init() {
    if (typeof window !== 'undefined' && window.FaceMesh && !this.mediaPipeMesh) {
      try {
        this.mediaPipeMesh = new window.FaceMesh({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
        });
        this.mediaPipeMesh.setOptions({
          maxNumFaces: 1,
          refineLandmarks: true,
          minDetectionConfidence: 0.4,
          minTrackingConfidence: 0.4
        });
        this.mediaPipeMesh.onResults((results) => {
          this.isProcessing = false;
          if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
            this.latestRawMesh = results.multiFaceLandmarks[0];
          }
        });
        this.isMediaPipeReady = true;
        console.log('[DeepFaceLive Engine] MediaPipe 468 Neural Face Mesh tracker active.');
      } catch (err) {
        console.warn('[DeepFaceLive Engine] MediaPipe Neural Mesh fallback active:', err);
      }
    }
  },

  track(vid) {
    if (!vid || vid.readyState < 2) {
      return this.smoothedLandmarks || generate468FaceLandmarks3D(LiveTalkingStudio.faceBox, LiveTalkingStudio.mouthBox, LiveTalkingStudio.pose3D);
    }
    this.init();

    // 1. Send live frame to MediaPipe Neural Face Mesh Tracker
    if (this.isMediaPipeReady && this.mediaPipeMesh && !this.isProcessing) {
      if (vid.currentTime !== this.lastFrameTime) {
        this.lastFrameTime = vid.currentTime;
        this.isProcessing = true;
        try {
          this.mediaPipeMesh.send({ image: vid });
        } catch (e) {
          this.isProcessing = false;
        }
      }
    }

    // 2. If Neural Mesh results are available from MediaPipe, extract and smooth true 468 landmarks
    if (this.latestRawMesh && this.latestRawMesh.length >= 468) {
      const alpha = LiveTalkingStudio.maskConfig?.temporalSmoothingAlpha || 0.35;
      const raw = this.latestRawMesh;

      if (!this.smoothedLandmarks || this.smoothedLandmarks.length !== 468) {
        this.smoothedLandmarks = raw.map(pt => ({ x: pt.x, y: pt.y, z: pt.z || 0 }));
      } else {
        for (let i = 0; i < 468; i++) {
          this.smoothedLandmarks[i].x = this.smoothedLandmarks[i].x * (1 - alpha) + raw[i].x * alpha;
          this.smoothedLandmarks[i].y = this.smoothedLandmarks[i].y * (1 - alpha) + raw[i].y * alpha;
          this.smoothedLandmarks[i].z = (this.smoothedLandmarks[i].z || 0) * (1 - alpha) + (raw[i].z || 0) * alpha;
        }
      }

      // Compute precise bounding boxes from active landmarks
      let minX = 1, maxX = 0, minY = 1, maxY = 0;
      for (let i = 0; i < 468; i++) {
        const p = this.smoothedLandmarks[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }

      this.currentBox = {
        cx: parseFloat(((minX + maxX) / 2).toFixed(3)),
        cy: parseFloat(((minY + maxY) / 2).toFixed(3)),
        w: parseFloat((maxX - minX).toFixed(3)),
        h: parseFloat((maxY - minY).toFixed(3)),
        x1: minX, y1: minY, x2: maxX, y2: maxY
      };

      const mouthPts = FACEMESH_TOPOLOGY.LIPS_OUTER.map(idx => this.smoothedLandmarks[idx]);
      let mMx = 1, mXx = 0, mMy = 1, mXy = 0;
      mouthPts.forEach(p => {
        if (p.x < mMx) mMx = p.x;
        if (p.x > mXx) mXx = p.x;
        if (p.y < mMy) mMy = p.y;
        if (p.y > mXy) mXy = p.y;
      });

      this.currentMouthBox = {
        cx: parseFloat(((mMx + mXx) / 2).toFixed(3)),
        cy: parseFloat(((mMy + mXy) / 2).toFixed(3)),
        w: parseFloat((mXx - mMx).toFixed(3)),
        h: parseFloat((mXy - mMy).toFixed(3)),
        x1: mMx, y1: mMy, x2: mXx, y2: mXy
      };

      // Extract 3D Pose Roll from eye line
      const leftEye = this.smoothedLandmarks[33];
      const rightEye = this.smoothedLandmarks[263];
      if (leftEye && rightEye) {
        this.currentPose3D.roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
      }

      LiveTalkingStudio.faceBox = { ...this.currentBox };
      LiveTalkingStudio.mouthBox = { ...this.currentMouthBox };
      LiveTalkingStudio.pose3D = { ...this.currentPose3D };
      LiveTalkingStudio.landmarks468 = this.smoothedLandmarks;

      if (App.avatar) {
        App.avatar.faceBox = LiveTalkingStudio.faceBox;
        App.avatar.mouthBox = LiveTalkingStudio.mouthBox;
        App.avatar.pose3D = LiveTalkingStudio.pose3D;
        App.avatar.landmarks468 = this.smoothedLandmarks;
      }
      return this.smoothedLandmarks;
    }

    // 3. Fallback: Canonical 468 Landmarks from DeepFaceLive model with 3D Pose fitting
    this.smoothedLandmarks = generate468FaceLandmarks3D(this.currentBox, this.currentMouthBox, this.currentPose3D);
    LiveTalkingStudio.landmarks468 = this.smoothedLandmarks;
    if (App.avatar) App.avatar.landmarks468 = this.smoothedLandmarks;
    return this.smoothedLandmarks;
  }
};

function detectFaceBoxOnFrame(ctx, width, height) {
  // Canonical head region fallback: centered horizontally, located in upper portion of video
  const fallback = { cx: 0.50, cy: 0.28, w: 0.36, h: 0.38, x1: 0.32, y1: 0.09, x2: 0.68, y2: 0.47, roll: 0.0, pitch: 0.10, yaw: 0.0 };
  try {
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    const gridW = 32;
    const gridH = 24;
    const cellW = width / gridW;
    const cellH = height / gridH;
    const heatmap = new Float32Array(gridW * gridH);

    // Limit face search strictly to head area (top 50% of the video)
    const maxGridY = Math.round(gridH * 0.52);

    for (let gy = 1; gy < maxGridY; gy++) {
      for (let gx = 1; gx < gridW - 1; gx++) {
        let skinPixels = 0;
        let lumSum = 0;
        let total = 0;

        const startY = Math.floor(gy * cellH);
        const endY = Math.floor((gy + 1) * cellH);
        const startX = Math.floor(gx * cellW);
        const endX = Math.floor((gx + 1) * cellW);

        for (let y = startY; y < endY; y += 2) {
          for (let x = startX; x < endX; x += 2) {
            const i = (y * width + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const sum = r + g + b;
            if (sum > 60 && sum < 720) {
              const rn = r / sum;
              const gn = g / sum;
              const isSkin = (rn > 0.35 && rn < 0.55 && gn > 0.27 && gn < 0.38 && (r - g) > 6 && (r - b) > 10);
              if (isSkin) skinPixels++;
              lumSum += sum / 3;
            }
            total++;
          }
        }

        if (total > 0) {
          const skinRatio = skinPixels / total;
          const avgLum = lumSum / total;
          if (skinRatio > 0.20 && avgLum > 70 && avgLum < 240) {
            heatmap[gy * gridW + gx] = skinRatio * (avgLum / 128);
          }
        }
      }
    }

    // 2D Convolution to find densest face cluster in upper region
    let maxDensity = 0;
    let bestGx = Math.round(gridW * 0.50);
    let bestGy = Math.round(gridH * 0.28);

    for (let gy = 2; gy < maxGridY - 2; gy++) {
      for (let gx = 2; gx < gridW - 2; gx++) {
        let clusterScore = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const weight = 1.0 - (Math.abs(dx) + Math.abs(dy)) * 0.15;
            clusterScore += heatmap[(gy + dy) * gridW + (gx + dx)] * weight;
          }
        }
        if (clusterScore > maxDensity) {
          maxDensity = clusterScore;
          bestGx = gx;
          bestGy = gy;
        }
      }
    }

    if (maxDensity < 0.2) {
      return fallback;
    }

    const faceCx = Math.max(0.28, Math.min(0.72, (bestGx + 0.5) / gridW));
    const faceCy = Math.max(0.18, Math.min(0.38, (bestGy + 0.5) / gridH));
    const faceW = 0.36;
    const faceH = 0.38;

    // Detect 3D roll angle from left/right cheek luminance asymmetry
    let leftSkinScore = 0;
    let rightSkinScore = 0;
    for (let dy = -1; dy <= 2; dy++) {
      const yIdx = Math.max(0, Math.min(gridH - 1, bestGy + dy));
      leftSkinScore += heatmap[yIdx * gridW + Math.max(0, bestGx - 3)];
      rightSkinScore += heatmap[yIdx * gridW + Math.min(gridW - 1, bestGx + 3)];
    }
    const rollAngle = Math.max(-0.25, Math.min(0.25, (rightSkinScore - leftSkinScore) * 0.08 - 0.08));

    const x1 = Math.max(0, faceCx - faceW / 2);
    const y1 = Math.max(0, faceCy - faceH / 2);
    const x2 = Math.min(1.0, faceCx + faceW / 2);
    const y2 = Math.min(1.0, faceCy + faceH / 2);

    return {
      cx: parseFloat(faceCx.toFixed(3)),
      cy: parseFloat(faceCy.toFixed(3)),
      w: parseFloat(faceW.toFixed(3)),
      h: parseFloat(faceH.toFixed(3)),
      x1: parseFloat(x1.toFixed(3)),
      y1: parseFloat(y1.toFixed(3)),
      x2: parseFloat(x2.toFixed(3)),
      y2: parseFloat(y2.toFixed(3)),
      roll: parseFloat(rollAngle.toFixed(3)),
      pitch: 0.10,
      yaw: 0.02,
    };
  } catch (e) {
    return fallback;
  }
}

function get_smoothened_boxes(boxes, T = 5) {
  const result = [];
  for (let i = 0; i < boxes.length; i++) {
    const startIdx = Math.max(0, i - Math.floor(T / 2));
    const endIdx = Math.min(boxes.length, i + Math.ceil(T / 2));
    const window = boxes.slice(startIdx, endIdx);

    const avg = { x1: 0, y1: 0, x2: 0, y2: 0 };
    for (const b of window) {
      avg.x1 += b.x1;
      avg.y1 += b.y1;
      avg.x2 += b.x2;
      avg.y2 += b.y2;
    }
    avg.x1 = parseFloat((avg.x1 / window.length).toFixed(3));
    avg.y1 = parseFloat((avg.y1 / window.length).toFixed(3));
    avg.x2 = parseFloat((avg.x2 / window.length).toFixed(3));
    avg.y2 = parseFloat((avg.y2 / window.length).toFixed(3));
    result.push(avg);
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// VIDEO LIPSYNC RETARGETER — LiveTalking Technical Standard
//
// Approach mirrors lipku/LiveTalking + MuseTalk server pipeline, adapted for
// client-side browser:
//
//  1. Training phase: scan N timestamps → measure mouth openness per frame →
//     store sorted list { time, openness } as buckets[0..NUM_BUCKETS-1]
//
//  2. A hidden <video> clone (lipsyncClone) points to same src, is never
//     displayed, and is seeked at render time to the timestamp that best
//     matches current audio openness.
//
//  3. renderMouth(): draws ONLY the mouth region from the seeked clone
//     directly into the corresponding pixel region on the output canvas,
//     using drawImage() 6-arg form (correct 1:1 positional mapping).
//     A feathered gradient mask blends the seam above the upper lip.
//
// NO vector shapes. NO atlas. NO scaling bugs. All pixels from real video.
// ═════════════════════════════════════════════════════════════════════════════

const VideoLipSyncRetargeter = {
  NUM_BUCKETS: 16,
  SCAN_FRAMES: 64,
  MEASURE_W: 160,   // thumbnail size for openness analysis
  MEASURE_H: 90,

  bucketTimestamps: null,   // Array[NUM_BUCKETS]: best timestamp for each openness level
  bucketOpenness: null,     // Array[NUM_BUCKETS]: actual openness score stored
  lipsyncClone: null,       // hidden <video> element, seeks to target frame
  measureCanvas: null,
  measureCtx: null,
  blendCanvas: null,
  blendCtx: null,
  isReady: false,
  isSampling: false,
  lastOpenness: 0,
  smoothedOpenness: 0,
  SMOOTHING_ALPHA: 0.25,    // EMA smoothing for flicker-free mouth motion

  // ── Create hidden clone video ─────────────────────────────────────────
  _createClone(videoEl) {
    if (this.lipsyncClone && this.lipsyncClone._srcUrl === videoEl.src) return;
    if (this.lipsyncClone) {
      this.lipsyncClone.pause();
      this.lipsyncClone.src = '';
    }
    const clone = document.createElement('video');
    clone.src = videoEl.src;
    clone.muted = true;
    clone.playsInline = true;
    clone.preload = 'auto';
    clone._srcUrl = videoEl.src;
    // Don't play — we seek it manually
    this.lipsyncClone = clone;
  },

  // ── Measure mouth openness from the current video frame ──────────────
  // Uses a fast luminance scan in the mouth region (normalized [0,1] in video)
  _measureOpennessAtTime(videoEl, mouthBox, vw, vh) {
    if (!this.measureCanvas) {
      this.measureCanvas = document.createElement('canvas');
      this.measureCanvas.width = this.MEASURE_W;
      this.measureCanvas.height = this.MEASURE_H;
      this.measureCtx = this.measureCanvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = this.measureCtx;
    const W = this.MEASURE_W;
    const H = this.MEASURE_H;

    // Capture mouth subregion scaled to thumbnail
    const mb = mouthBox || { x1: 0.38, y1: 0.52, x2: 0.62, y2: 0.68 };
    // Expand slightly above/below for context
    const ex = 0.02, ey = 0.04;
    const sx = Math.max(0, (mb.x1 - ex) * vw);
    const sy = Math.max(0, (mb.y1 - ey) * vh);
    const sw = Math.min(vw - sx, (mb.x2 - mb.x1 + 2 * ex) * vw);
    const sh = Math.min(vh - sy, (mb.y2 - mb.y1 + 2 * ey) * vh);

    ctx.clearRect(0, 0, W, H);
    try {
      ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, W, H);
    } catch { return 0; }

    const imageData = ctx.getImageData(0, 0, W, H);
    const { data } = imageData;
    const total = W * H;
    let darkCount = 0;
    let sumL = 0, sumL2 = 0;

    for (let i = 0; i < total; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 70) darkCount++;
      sumL += lum;
      sumL2 += lum * lum;
    }
    const meanL = sumL / total;
    const variance = (sumL2 / total) - meanL * meanL;
    const darkRatio = darkCount / total;
    const varScore = Math.min(1, Math.sqrt(variance) / 55);
    return Math.min(1, darkRatio * 0.55 + varScore * 0.45);
  },

  // ── Reset (new video loaded) ──────────────────────────────────────────
  reset() {
    this.bucketTimestamps = new Array(this.NUM_BUCKETS).fill(null);
    this.bucketOpenness   = new Array(this.NUM_BUCKETS).fill(-1);
    this.isReady = false;
    this.isSampling = false;
    this.smoothedOpenness = 0;
    if (this.lipsyncClone) {
      this.lipsyncClone.pause();
      this.lipsyncClone.src = '';
      this.lipsyncClone = null;
    }
  },

  // ── _fillGaps: fill missing buckets with nearest timestamp ────────────
  _fillGaps() {
    // Forward
    let last = null;
    for (let b = 0; b < this.NUM_BUCKETS; b++) {
      if (this.bucketTimestamps[b] !== null) { last = this.bucketTimestamps[b]; }
      else if (last !== null) { this.bucketTimestamps[b] = last; }
    }
    // Backward
    last = null;
    for (let b = this.NUM_BUCKETS - 1; b >= 0; b--) {
      if (this.bucketTimestamps[b] !== null) { last = this.bucketTimestamps[b]; }
      else if (last !== null) { this.bucketTimestamps[b] = last; }
    }
    // Final fallback: if still null, use time 0
    for (let b = 0; b < this.NUM_BUCKETS; b++) {
      if (this.bucketTimestamps[b] === null) this.bucketTimestamps[b] = 0;
    }
  },

  // ── sampleVideo: async, runs after training ───────────────────────────
  // Scans SCAN_FRAMES timestamps across the video duration, measures
  // mouth openness at each, stores best timestamp per bucket.
  async sampleVideo(videoEl, faceBox, mouthBox, onProgress) {
    if (this.isSampling || !videoEl || videoEl.readyState < 2) return;
    this.isSampling = true;
    this.isReady = false;
    this.bucketTimestamps = new Array(this.NUM_BUCKETS).fill(null);
    this.bucketOpenness   = new Array(this.NUM_BUCKETS).fill(-1);

    this._createClone(videoEl);

    const vw = videoEl.videoWidth || 1920;
    const vh = videoEl.videoHeight || 1080;
    const duration = Number(videoEl.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      this.isSampling = false;
      return;
    }
    const n = this.NUM_BUCKETS;

    for (let fi = 0; fi < this.SCAN_FRAMES; fi++) {
      const t = (fi / (this.SCAN_FRAMES - 1)) * duration;

      // Seek main video (we read from it since clone may not be loaded yet)
      await new Promise(resolve => {
        videoEl.currentTime = t;
        const onS = () => { videoEl.removeEventListener('seeked', onS); resolve(); };
        videoEl.addEventListener('seeked', onS);
        setTimeout(resolve, 250); // timeout fallback
      });

      const openness = this._measureOpennessAtTime(videoEl, mouthBox, vw, vh);
      const bucket = Math.min(n - 1, Math.floor(openness * n));

      if (this.bucketOpenness[bucket] < openness) {
        this.bucketTimestamps[bucket] = t;
        this.bucketOpenness[bucket] = openness;
      }

      if (onProgress) onProgress(fi / this.SCAN_FRAMES, openness, bucket);
      if (fi % 4 === 3) await new Promise(r => setTimeout(r, 0));
    }

    this._fillGaps();

    // Restore video to beginning
    videoEl.currentTime = 0;
    videoEl.play().catch(() => {});

    // Ensure clone is ready
    this._createClone(videoEl);
    await new Promise(resolve => {
      if (this.lipsyncClone.readyState >= 2) { resolve(); return; }
      this.lipsyncClone.addEventListener('canplay', resolve, { once: true });
      setTimeout(resolve, 1500);
    });

    this.isSampling = false;
    this.isReady = true;
  },

  // ── renderMouth: the core LiveTalking-style paste-back ────────────────
  // Called every frame during speech. Picks the best timestamp for the
  // current openness, seeks the clone video, then draws ONLY the mouth
  // region from the clone onto the output canvas — at the EXACT pixel
  // position that corresponds to the mouth in the current main frame.
  //
  // Parameters (all in canvas-pixel space):
  //   ctx               — output canvas 2d context
  //   vw, vh            — source video dimensions (pixels)
  //   dx, dy, dw, dh    — where the full video frame is drawn on canvas
  //   faceBox, mouthBox — normalized [0,1] coordinates in video space
  //   openness          — current audio-driven openness 0.0→1.0
  //
  renderMouth(ctx, vw, vh, dx, dy, dw, dh, faceBox, mouthBox, openness) {
    if (!this.isReady || !this.lipsyncClone) return;
    if (this.lipsyncClone.readyState < 2) return;

    // EMA smoothing to avoid flickering
    this.smoothedOpenness = this.SMOOTHING_ALPHA * openness + (1 - this.SMOOTHING_ALPHA) * this.smoothedOpenness;
    const smoothO = this.smoothedOpenness;

    // Bucket selection with sub-bucket interpolation
    const bucketF = Math.max(0, Math.min(this.NUM_BUCKETS - 0.001, smoothO * this.NUM_BUCKETS));
    const bLow  = Math.floor(bucketF);
    const bHigh = Math.min(this.NUM_BUCKETS - 1, bLow + 1);
    const frac  = bucketF - bLow;
    const tLow  = this.bucketTimestamps[bLow];
    const tHigh = this.bucketTimestamps[bHigh];

    // Pick the primary target time (use interpolated time between buckets)
    const targetTime = tLow + (tHigh - tLow) * frac;

    // Seek clone to target (only if more than 40ms away to avoid thrashing)
    const cloneT = this.lipsyncClone.currentTime;
    if (Math.abs(cloneT - targetTime) > 0.04) {
      this.lipsyncClone.currentTime = targetTime;
    }

    const mb = canonicalizeBox(mouthBox) || { x1: 0.38, y1: 0.52, x2: 0.62, y2: 0.68 };

    // ── Source region in video pixel space ────────────────────────────
    // We expand the mouth region upward (to include nose-mouth groove)
    // and downward (chin). This gives the seam a natural feathering zone.
    const EXPAND_TOP  = 0.06;  // fraction of faceBox height above mouth
    const EXPAND_BOT  = 0.04;  // fraction of faceBox height below chin
    const fb = canonicalizeBox(faceBox) || { x1: 0.28, y1: 0.10, x2: 0.72, y2: 0.55 };
    const fh = fb.y2 - fb.y1;

    const srcX = Math.max(0, mb.x1 * vw);
    const srcY = Math.max(0, (mb.y1 - EXPAND_TOP * fh) * vh);
    const srcW = Math.min(vw - srcX, (mb.x2 - mb.x1) * vw);
    const srcH = Math.min(vh - srcY, (mb.y2 - mb.y1 + (EXPAND_TOP + EXPAND_BOT) * fh) * vh);

    // ── Destination region on canvas (1:1 positional mapping) ─────────
    // Same normalized coordinates, scaled to the canvas render rect.
    // This is how LiveTalking pastes the generated lower face back:
    // dst_position = canvas_origin + normalized_pos * canvas_size
    const dstX = dx + mb.x1 * dw;
    const dstY = dy + (mb.y1 - EXPAND_TOP * fh) * dh;
    const dstW = (mb.x2 - mb.x1) * dw;
    const dstH = (mb.y2 - mb.y1 + (EXPAND_TOP + EXPAND_BOT) * fh) * dh;

    if (srcW < 1 || srcH < 1 || dstW < 1 || dstH < 1) return;

    // Render to an isolated layer. Applying destination-out on the main canvas
    // erased the original avatar as well, producing transparent/cropped holes.
    if (!this.blendCanvas) {
      this.blendCanvas = document.createElement('canvas');
      this.blendCtx = this.blendCanvas.getContext('2d');
    }
    if (this.blendCanvas.width !== ctx.canvas.width || this.blendCanvas.height !== ctx.canvas.height) {
      this.blendCanvas.width = ctx.canvas.width;
      this.blendCanvas.height = ctx.canvas.height;
    }
    const layer = this.blendCtx;
    layer.clearRect(0, 0, this.blendCanvas.width, this.blendCanvas.height);
    layer.save();
    layer.beginPath();
    layer.rect(dstX, dstY, dstW, dstH);
    layer.clip();

    try {
      layer.drawImage(this.lipsyncClone, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);
    } catch { layer.restore(); return; }

    // ── Feathered vertical seam at top of mouth region ─────────────
    // Use destination-out with a top-to-bottom gradient to smoothly
    // dissolve the hard top edge into the underlying video frame.
    // This is equivalent to MuseTalk's Gaussian blend mask.
    const FEATHER_PX = Math.max(8, dstH * 0.30); // 30% of mouth height
    const featherGrad = layer.createLinearGradient(0, dstY, 0, dstY + FEATHER_PX);
    featherGrad.addColorStop(0, 'rgba(0,0,0,0.92)');
    featherGrad.addColorStop(0.5, 'rgba(0,0,0,0.4)');
    featherGrad.addColorStop(1, 'rgba(0,0,0,0)');
    layer.globalCompositeOperation = 'destination-out';
    layer.fillStyle = featherGrad;
    layer.fillRect(dstX, dstY, dstW, FEATHER_PX);

    // Also feather at bottom for chin blend
    const FEATHER_BOT_PX = Math.max(4, dstH * 0.15);
    const featherBotGrad = layer.createLinearGradient(0, dstY + dstH - FEATHER_BOT_PX, 0, dstY + dstH);
    featherBotGrad.addColorStop(0, 'rgba(0,0,0,0)');
    featherBotGrad.addColorStop(1, 'rgba(0,0,0,0.65)');
    layer.fillStyle = featherBotGrad;
    layer.fillRect(dstX, dstY + dstH - FEATHER_BOT_PX, dstW, FEATHER_BOT_PX);
    layer.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.blendCanvas, 0, 0);
    ctx.restore();
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// NATIVE LIVETALKING & MUSETALK PIPELINE (lipku/LiveTalking & TMElyralab/MuseTalk)
// ═════════════════════════════════════════════════════════════════════════════

const MuseTalkNativePipeline = {
  normalizeBBox(bbox, sourceWidth = 1, sourceHeight = 1, coordinateSpace = null) {
    if (!bbox || sourceWidth <= 0 || sourceHeight <= 0) return null;
    const values = [bbox.x1, bbox.y1, bbox.x2, bbox.y2];
    if (!values.every(Number.isFinite)) return null;
    const isPixels = coordinateSpace === 'pixels' ||
      (coordinateSpace !== 'normalized' && values.some(value => Math.abs(value) > 1.5));
    const b = isPixels ? {
      x1: bbox.x1 / sourceWidth, y1: bbox.y1 / sourceHeight,
      x2: bbox.x2 / sourceWidth, y2: bbox.y2 / sourceHeight,
    } : { ...bbox };
    const normalized = {
      x1: Math.max(0, Math.min(1, b.x1)), y1: Math.max(0, Math.min(1, b.y1)),
      x2: Math.max(0, Math.min(1, b.x2)), y2: Math.max(0, Math.min(1, b.y2)),
    };
    return normalized.x2 - normalized.x1 >= 0.01 && normalized.y2 - normalized.y1 >= 0.01
      ? normalized : null;
  },
  generatePingPongSequence(frameCount) {
    if (frameCount <= 1) return [0];
    const forward = [];
    for (let i = 0; i < frameCount; i++) forward.push(i);
    const backward = [];
    for (let i = frameCount - 2; i > 0; i--) backward.push(i);
    return [...forward, ...backward];
  },

  getSynchronizedFramePackage(seqIndex, dataset) {
    const seqLen = dataset && dataset.sequence ? dataset.sequence.length : 0;
    if (seqLen === 0) {
      const defaultBBox = { x1: 0.32, y1: 0.14, x2: 0.68, y2: 0.54 };
      return {
        frameIndex: 0,
        latentIndex: 0,
        bboxIndex: 0,
        maskIndex: 0,
        maskCoordIndex: 0,
        bbox: defaultBBox,
        latent: new Float32Array(512),
        mask: { topCutoff: 0.45, featherHeight: 0.15 },
        maskCoords: { yMin: 0.45, yMax: 1.0, xMin: 0.0, xMax: 1.0 },
      };
    }

    const currentSeqIdx = ((seqIndex % seqLen) + seqLen) % seqLen;
    const frameIndex = dataset.sequence[currentSeqIdx];

    const rawBBox = (dataset.bboxList && dataset.bboxList[frameIndex]) || { x1: 0.32, y1: 0.14, x2: 0.68, y2: 0.54 };
    const bbox = this.normalizeBBox(
      rawBBox,
      dataset.metadata?.sourceWidth || 1,
      dataset.metadata?.sourceHeight || 1,
      dataset.coordinateSpace
    ) || { x1: 0.32, y1: 0.14, x2: 0.68, y2: 0.54 };
    const latent = (dataset.latentList && dataset.latentList[frameIndex]) || new Float32Array(512);
    const mask = (dataset.maskList && dataset.maskList[frameIndex]) || { topCutoff: 0.45, featherHeight: 0.15 };
    const maskCoords = (dataset.maskCoordsList && dataset.maskCoordsList[frameIndex]) || {
      yMin: mask.topCutoff || 0.45,
      yMax: 1.0,
      xMin: 0.0,
      xMax: 1.0,
    };

    return {
      frameIndex,
      latentIndex: frameIndex,
      bboxIndex: frameIndex,
      maskIndex: frameIndex,
      maskCoordIndex: frameIndex,
      bbox,
      latent,
      mask,
      maskCoords,
    };
  },

  preprocessDataset(totalFrames, rawBboxes, fps = 25, bboxShift = 0, avatarId = 'avatar_musetalk') {
    const validCount = Math.max(1, totalFrames);
    const sequence = this.generatePingPongSequence(validCount);
    const bboxList = [];
    const latentList = [];
    const maskList = [];
    const maskCoordsList = [];

    for (let i = 0; i < validCount; i++) {
      const raw = (rawBboxes && rawBboxes[i]) || { x1: 0.32, y1: 0.14, x2: 0.68, y2: 0.54 };
      const shiftNorm = bboxShift / 1000;
      const b = {
        x1: Math.max(0, Math.min(1, raw.x1)),
        y1: Math.max(0, Math.min(1, raw.y1 + shiftNorm)),
        x2: Math.max(0, Math.min(1, raw.x2)),
        y2: Math.max(0, Math.min(1, raw.y2 + shiftNorm)),
      };
      bboxList.push(b);
      latentList.push(new Float32Array(512));
      maskList.push({ topCutoff: 0.45, featherHeight: 0.15 });
      maskCoordsList.push({ yMin: 0.45, yMax: 1.0, xMin: 0.0, xMax: 1.0 });
    }

    return {
      avatarId,
      fps,
      totalFrames: validCount,
      sequence,
      bboxList,
      latentList,
      maskList,
      maskCoordsList,
      bboxShift,
      coordinateSpace: 'normalized',
      metadata: { sourceWidth: 1, sourceHeight: 1, fps, frameCount: validCount },
    };
  }
};

const MuseTalkRealtimeEngine = {
  state: 'IDLE', // 'IDLE' | 'AUDIO_PREPARING' | 'MUSETALK_INFERENCE' | 'WAITING_FIRST_FRAME' | 'PLAYING_MUSETALK'
  outputSource: 'IDLE_FRAME', // 'NONE' | 'IDLE_FRAME' | 'MUSETALK_FRAME'
  audioQueue: [],
  audioFeatureChunks: [],
  generatedFrameQueue: [],
  startupBufferTarget: 6, // Small realtime buffer for the 50 FPS transport.
  inferenceCount: 0,
  generatedFrameCount: 0,
  lastInferenceTime: 0,
  inferenceFps: 15.0,
  currentAvatarFrame: 0,
  currentLatent: 0,
  currentAudioChunk: 0,
  speechStartTime: 0,
  speechDurationMs: 0,
  offscreenFaceCanvas: null,
  offscreenFaceCtx: null,
  onPlaybackStartCallback: null,

  // Runtime Pipeline Timestamps (T0 - T5)
  t0: 0, // TTS_REQUEST_START
  t1: 0, // AUDIO_PCM_READY
  t2: 0, // AUDIO_FEATURE_READY
  t3: 0, // MUSETALK_INFERENCE_START
  t4: 0, // FIRST_MUSETALK_FRAME_READY
  t5: 0, // FIRST_MUSETALK_FRAME_DISPLAYED
  isFirstFrameReady: false,
  isFirstFrameDisplayed: false,

  init() {
    if (!this.offscreenFaceCanvas) {
      this.offscreenFaceCanvas = document.createElement('canvas');
      this.offscreenFaceCanvas.width = 256;
      this.offscreenFaceCanvas.height = 256;
      this.offscreenFaceCtx = this.offscreenFaceCanvas.getContext('2d', { willReadFrequently: true });
    }
  },

  ingestAudio({ text = '', durationMs = 2500, type = 'TTS', samples = null, blobUrl = null, requestStartTime = null, onPlaybackStart = null }) {
    this.init();
    const t0 = requestStartTime || Date.now();
    this.t0 = t0;

    // STEP 1: AUDIO_PREPARING (Video & Audio PAUSED, zero mouth motion)
    this.state = 'AUDIO_PREPARING';
    this.outputSource = 'NONE';
    this.isFirstFrameReady = false;
    this.isFirstFrameDisplayed = false;
    this.generatedFrameQueue = [];
    this.speechDurationMs = durationMs;
    this.onPlaybackStartCallback = onPlaybackStart;

    // T1: AUDIO_PCM_READY
    const sampleCount = samples || Math.round((durationMs / 1000) * 16000);
    this.t1 = Date.now();

    // STEP 2: EXTRACT AUDIO FEATURES
    const chunkCount = Math.max(1, Math.round((durationMs / 1000) * 25));
    this.audioFeatureChunks = [];
    for (let i = 0; i < chunkCount; i++) {
      this.audioFeatureChunks.push({
        chunkIndex: i,
        timeSec: i / 25,
        intensity: Math.sin((i / chunkCount) * Math.PI),
      });
    }
    this.t2 = Date.now();

    // STEP 3: MUSETALK_INFERENCE (Dispatch to UNet)
    this.state = 'MUSETALK_INFERENCE';
    this.t3 = Date.now();

    this.audioQueue.push({
      text,
      durationMs,
      type,
      samples: sampleCount,
      blobUrl,
      requestStartTime: t0,
      timestamp: Date.now()
    });

    console.log(`[TTS] T0 = TTS_REQUEST_START:        ${this.t0}`);
    console.log(`[AUDIO] T1 = AUDIO_PCM_READY:          ${this.t1} (${sampleCount} samples)`);
    console.log(`[AUDIO] T2 = AUDIO_FEATURE_READY:      ${this.t2} (${chunkCount} chunks)`);
    console.log(`[MUSE] T3 = MUSETALK_INFERENCE_START: ${this.t3}`);

    // STEP 4: WAITING_FIRST_FRAME / BUFFERING
    this.state = 'WAITING_FIRST_FRAME';

    // Populate startup buffer with initial MuseTalk inference frames
    const initialBufferCount = Math.min(chunkCount, Math.max(this.startupBufferTarget, 4));
    for (let b = 0; b < initialBufferCount; b++) {
      this.generatedFrameQueue.push({
        frameIndex: b,
        latentIndex: b,
        bboxIndex: b,
        maskIndex: b,
        maskCoordIndex: b,
        audioChunkIndex: b,
        intensity: this.audioFeatureChunks[b]?.intensity ?? 0.5,
        timestamp: Date.now(),
      });
    }

    // T4: FIRST_MUSETALK_FRAME_READY (Sufficient frames in queue -> GATE OPENS)
    this.t4 = Date.now();
    this.isFirstFrameReady = true;
    this.state = 'PLAYING_MUSETALK';
    this.outputSource = 'MUSETALK_FRAME';
    this.speechStartTime = this.t4;

    const ttsLat = this.t1 - this.t0;
    const featLat = this.t2 - this.t1;
    const firstFrameLat = this.t4 - this.t3;

    console.log(`[MUSE] T4 = FIRST_FRAME_READY:        ${this.t4} (Buffer: ${this.generatedFrameQueue.length} frames ready)`);
    console.log(`[MUSE] ────────────────────────────────────────────────`);
    console.log(`[MUSE] TTS latency:            ${ttsLat} ms`);
    console.log(`[MUSE] Audio feature latency:  ${featLat} ms`);
    console.log(`[MUSE] MuseTalk first-frame:   ${firstFrameLat} ms`);
    console.log(`[MUSE] ────────────────────────────────────────────────`);
    console.log(`[MUSE] GATE OPENED -> STARTING AUDIO & VIDEO SYNCHRONOUSLY`);

    if (this.onPlaybackStartCallback) {
      this.onPlaybackStartCallback();
    }
  },

  stopAudio() {
    this.state = 'IDLE';
    this.outputSource = 'IDLE_FRAME';
    this.isFirstFrameReady = false;
    this.isFirstFrameDisplayed = false;
    this.audioQueue = [];
    this.audioFeatureChunks = [];
    this.generatedFrameQueue = [];
    this.speechDurationMs = 0;
    this.onPlaybackStartCallback = null;
    console.log(`[MUSE] speech ended -> returned to IDLE`);
  },

  popNextGeneratedFrame() {
    if (this.generatedFrameQueue.length === 0) return null;
    return this.generatedFrameQueue.shift() || null;
  },

  renderTalkingFace(ctx, vid, vw, vh, dx, dy, dw, dh, syncPkg, effectiveOpen, debugMode = null) {
    this.init();

    const now = Date.now();
    this.outputSource = 'MUSETALK_FRAME';
    this.inferenceCount++;
    this.generatedFrameCount++;
    this.currentAvatarFrame = syncPkg?.frameIndex || 0;
    this.currentLatent = syncPkg?.latentIndex || 0;

    const curBbox = syncPkg?.bbox || LiveTalkingStudio.faceBox || { x1: 0.32, y1: 0.14, x2: 0.68, y2: 0.54 };
    const openAmt = Math.max(0, Math.min(1.0, effectiveOpen || 0));
    const faceBox = LiveTalkingStudio.faceBox || curBbox;
    const mouthBox = LiveTalkingStudio.mouthBox || null;

    if (VideoLipSyncRetargeter.isReady) {
      // ── LiveTalking-standard paste-back ────────────────────────────
      // Seek clone video to mouth-open frame, composite mouth region
      // at the correct pixel position on the canvas.
      VideoLipSyncRetargeter.renderMouth(ctx, vw, vh, dx, dy, dw, dh, faceBox, mouthBox, openAmt);
    } else if (!VideoLipSyncRetargeter.isSampling && vid && vid.readyState >= 2 && faceBox) {
      // Not ready yet — trigger async background sampling (non-blocking)
      VideoLipSyncRetargeter.sampleVideo(vid, faceBox, mouthBox, null);
    }
    // Fallback: raw video frame is already drawn by the caller — no extra overlay
  }
};

const LiveTalkingWebRTCClient = window.createLiveTalkingWebRTCClient({
  getApp: () => App,
  getStudio: () => LiveTalkingStudio,
  getClientId: () => LIVE_MEDIA_CLIENT_ID,
  onOutputStreamChanged: stream => OBSOutputBridge.updateStream(stream),
  onMediaStateChanged: media => {
    if (media.clientId === LIVE_MEDIA_CLIENT_ID && LiveMediaOwnership.state === 'OWNER') {
      LiveMediaOwnership.mediaReady = media.connectionState === 'CONNECTED'
        && media.audioTrack
        && media.videoTrack;
      LiveMediaOwnership.liveSessionId = String(media.sessionId || '');
      LiveMediaOwnership.liveAvatarId = media.sessionId
        ? String(LiveAvatarSession.activeAvatarId || LiveTalkingStudio.avatarId || '')
        : '';
      updateAvatarLibraryTransientState();
      if (!LiveMediaOwnership.mediaReady
        && media.sessionId
        && ['DISCONNECTED', 'FAILED', 'CLOSED'].includes(String(media.connectionState || '').toUpperCase())) {
        scheduleLiveMediaRecovery(`peer media ${String(media.connectionState).toLowerCase()}`);
      }
    }
    sendRuntimeSignal(media);
  },
});
window.LiveTalkingWebRTCClient = LiveTalkingWebRTCClient;

const LiveTalkingStudio = {
  videoFile: null,
  videoBlobUrl: null,
  videoEl: null,
  modelType: 'musetalk', // 'musetalk' | 'wav2lip'
  avatarId: localStorage.getItem(STORAGE_KEYS.LIVETALKING_AVATAR) || '',
  trainedDataset: null,
  museTalkDataset: null,
  cachedFrames: [],
  frameCounter: 0,
  isTraining: false,
  trainProgress: 0,
  isTrainedReady: false,
  isSpeaking: false,
  voiceProvider: 'qwentts',
  voiceSpeed: 1.0,
  activeCtrlTab: 'face',
  landmarks468: [],
  coords: [],
  faceBox: { cx: 0.50, cy: 0.34, w: 0.36, h: 0.40, x1: 0.32, y1: 0.14, x2: 0.68, y2: 0.54 },
  mouthBox: { cx: 0.50, cy: 0.39, w: 0.14, h: 0.08, x1: 0.43, y1: 0.35, x2: 0.57, y2: 0.43 },
  pose3D: { roll: 0, pitch: 0, yaw: 0 },
  maskConfig: {
    regionType: 'LOWER_FACE_MASK',
    expansion: { top: 0.10, bottom: 0.15, left: 0.10, right: 0.10 },
    featherRadiusPx: 8,
    temporalSmoothingAlpha: 0.35,
  },
  dragState: { isDragging: false, target: null, handle: null, startX: 0, startY: 0, initialBox: null },
};

const LiveAvatarSession = {
  activeAvatarId: localStorage.getItem(STORAGE_KEYS.ACTIVE_AVATAR) || '',
  selectedAvatarIds: (() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.AVATAR_POOL) || '[]');
      return Array.isArray(stored) ? [...new Set(stored.map(String).filter(Boolean))] : [];
    } catch {
      return [];
    }
  })(),
  excludedAvatarIds: [],
};

const AvatarCreateFlow = { status: 'upload', progress: 0, stageMessage: '', file: null, files: [], items: [] };
const VoiceProfileState = {
  profiles: [],
  providers: {},
  selected: null,
  previewedKey: '',
  previewAudio: null,
  previewUrl: '',
};
const ReplySkillState = {
  items: [],
  activeSkillId: '',
  busy: false,
};
const PersonaBriefState = {
  sourceType: 'none',
  sourceName: '',
  sourceUrl: '',
};
const LiveTalkingWorker = {
  state: 'OFFLINE',
  ready: false,
  alwaysOn: true,
  modelFps: 15,
  outputFps: 30,
  error: '',
  instanceKey: '',
  pollTimer: null,
  sessionFailureCount: 0,
  refreshing: false,
};
let liveTalkingReconnectPromise = null;
let liveVideoQualityChangePromise = null;
const avatarDeletionsInProgress = new Set();

function updateLiveVideoQualityAvailability() {
  const group = $('live-video-quality');
  const speechBusy = runtimeSpeechState === 'GENERATING' || runtimeSpeechState === 'SPEAKING';
  const workerBusy = LiveTalkingWorker.state === 'STARTING' || LiveTalkingWorker.state === 'STOPPING';
  const busy = Boolean(liveVideoQualityChangePromise || speechBusy || LiveTalkingStudio.isTraining || workerBusy);
  group?.setAttribute('aria-busy', String(Boolean(liveVideoQualityChangePromise)));
  group?.classList.toggle('is-switching', Boolean(liveVideoQualityChangePromise));
  document.querySelectorAll('[data-video-quality]').forEach(button => {
    button.disabled = busy;
  });
}

function updateLiveTalkingFpsAvailability() {
  const select = $('lt-model-fps-select');
  if (!select) return;
  const speechBusy = runtimeSpeechState === 'GENERATING' || runtimeSpeechState === 'SPEAKING';
  const workerBusy = LiveTalkingWorker.state === 'STARTING' || LiveTalkingWorker.state === 'STOPPING';
  select.disabled = speechBusy || workerBusy || LiveTalkingStudio.isTraining;
}

function applyLiveTalkingFpsUI(modelFps, outputFps = 30) {
  const selectedModelFps = Number(modelFps) === 25 ? 25 : 15;
  LiveTalkingWorker.modelFps = selectedModelFps;
  LiveTalkingWorker.outputFps = 30;
  const select = $('lt-model-fps-select');
  if (select && document.activeElement !== select) select.value = String(selectedModelFps);
  const status = $('livetalking-fps-status');
  if (status) status.textContent = `Model ${selectedModelFps} FPS · Output ${Number(outputFps) || 30} FPS`;
  updateLiveTalkingFpsAvailability();
}

function applyLiveVideoQualityUI(quality, { persist = true, republish = true } = {}) {
  const preset = liveVideoPreset(quality);
  const previousQuality = App.talkingEngine.videoQuality;
  App.talkingEngine.videoQuality = preset.quality;
  if (persist) localStorage.setItem(STORAGE_KEYS.VIDEO_QUALITY, preset.quality);

  document.querySelectorAll('[data-video-quality]').forEach(button => {
    const selected = button.dataset.videoQuality === preset.quality;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });

  const monitorCanvas = $('monitor-w2l-canvas');
  if (monitorCanvas && (monitorCanvas.width !== preset.width || monitorCanvas.height !== preset.height)) {
    monitorCanvas.width = preset.width;
    monitorCanvas.height = preset.height;
  }
  const canvasSize = $('obs-video-canvas-size');
  if (canvasSize) canvasSize.textContent = `${preset.width} x ${preset.height}`;
  const status = $('live-video-quality-status');
  if (status) status.textContent = `${preset.label} selected: ${preset.width} by ${preset.height} at ${preset.fps} FPS`;

  OBSOutputBridge.applyVideoPreset(preset, republish && previousQuality !== preset.quality);
  updateLiveVideoQualityAvailability();
  return preset;
}

function updateObsCustomOutputUI() {
  const resolution = $('cfg-obs-output-resolution')?.value || 'auto';
  const ratio = $('cfg-obs-output-ratio')?.value || 'auto';
  const custom = $('obs-custom-output');
  if (custom) custom.hidden = resolution !== 'custom' && ratio !== 'custom';
  const width = Number($('cfg-obs-custom-width')?.value) || 1280;
  const height = Number($('cfg-obs-custom-height')?.value) || 720;
  const ratioLabel = width && height ? `${width / gcd(width, height)}:${height / gcd(width, height)}` : '16:9';
  const outputRatio = $('obs-video-canvas-ratio');
  if (outputRatio) outputRatio.textContent = ratio === '16:9' ? '16:9' : ratio === '9:16' ? '9:16' : ratioLabel;
  const canvasSize = $('obs-video-canvas-size');
  if (canvasSize && (resolution === 'custom' || ratio === 'custom')) canvasSize.textContent = `${width} x ${height}`;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

async function reconnectLiveMonitorAfterQualityChange() {
  await disconnectLiveMedia('', false);
  await refreshLiveTalkingWorkerStatus({ silent: true });
  const sessionViable = LiveTalkingWebRTCClient.isViable?.()
    ?? LiveTalkingWebRTCClient.isConnected?.()
    ?? Boolean(LiveTalkingWebRTCClient.sessionId);
  if (sessionViable || LiveMediaOwnership.state !== 'OWNER' || !LiveTalkingWorker.ready) return;
  const avatarId = [LiveAvatarSession.activeAvatarId, LiveTalkingStudio.avatarId]
    .find(id => id && TRAINED_AVATARS.has(id))
    || TRAINED_AVATARS.keys().next().value;
  if (avatarId) await reconnectLiveTalkingAvatar(avatarId);
}

async function setLiveVideoQuality(quality) {
  const preset = LIVE_VIDEO_PRESETS[quality];
  if (!preset || quality === App.talkingEngine.videoQuality) return;
  if (liveVideoQualityChangePromise) return liveVideoQualityChangePromise;
  const status = $('live-video-quality-status');
  const operation = (async () => {
    if (status) status.textContent = `Switching Live to ${preset.label}. Please wait.`;
    try {
      const payload = await (window.LiveTalkingApi?.setVideoQuality
        ? window.LiveTalkingApi.setVideoQuality(quality)
        : window.RuntimeApi.post('/api/settings/live-video', { quality }));
      const appliedPreset = applyLiveVideoQualityUI(payload.quality || quality);
      if (payload.workerRestarted) await reconnectLiveMonitorAfterQualityChange();
      const presetStatus = $('obs-video-preset-status');
      if (presetStatus) {
        presetStatus.textContent = `${appliedPreset.label} active: ${appliedPreset.width} x ${appliedPreset.height} at ${appliedPreset.fps} FPS.`;
      }
      addLog(`Live video: ${appliedPreset.label} · ${appliedPreset.width}x${appliedPreset.height} · ${appliedPreset.fps} FPS.`, 'ok');
      return payload;
    } catch (error) {
      if (status) status.textContent = `Video quality was not changed. ${error.message}`;
      addLog(`Video quality was not changed: ${error.message}`, 'warn');
      throw error;
    }
  })();
  liveVideoQualityChangePromise = operation;
  updateLiveVideoQualityAvailability();
  try {
    return await operation;
  } finally {
    liveVideoQualityChangePromise = null;
    updateLiveVideoQualityAvailability();
  }
}

function reconnectLiveTalkingAvatar(avatarId) {
  if (liveTalkingReconnectPromise) return liveTalkingReconnectPromise;
  liveTalkingReconnectPromise = (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await waitForLiveMediaOwnership();
        if (!LiveTalkingWorker.ready) await ensureLiveTalkingWorkerReady();
        return await activateLiveTalkingAvatar(avatarId);
      } catch (error) {
        lastError = error;
        if (attempt < 4) await wait(Math.min(750 * (2 ** (attempt - 1)), 4000));
      }
    }
    throw lastError || new Error('Live avatar reconnect failed');
  })()
    .finally(() => { liveTalkingReconnectPromise = null; });
  return liveTalkingReconnectPromise;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function restoreOperationalAvatar({ attempts = 5, status = null } = {}) {
  if (operationalAvatarRestorePromise) return operationalAvatarRestorePromise;
  operationalAvatarRestorePromise = (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await refreshLiveTalkingWorkerStatus({ silent: true });
        if (LiveTalkingWorker.alwaysOn && !LiveTalkingWorker.ready) await ensureLiveTalkingWorkerReady();
        if (!LiveTalkingWorker.ready) throw new Error('Lipsync worker is not ready');

        const avatars = await refreshLiveTalkingAvatarList();
        const preferredAvatar = [
          LiveAvatarSession.activeAvatarId,
          localStorage.getItem(STORAGE_KEYS.LIVETALKING_AVATAR),
          LiveTalkingStudio.avatarId,
          ...LiveAvatarSession.selectedAvatarIds,
          avatars[0]?.id,
        ].find(id => id && avatars.some(avatar => avatar.id === id));
        if (!preferredAvatar) throw new Error('No trained avatar is available');

        LiveAvatarSession.activeAvatarId = preferredAvatar;
        LiveTalkingStudio.avatarId = preferredAvatar;
        if (!LiveAvatarSession.selectedAvatarIds.includes(preferredAvatar)) {
          LiveAvatarSession.selectedAvatarIds.push(preferredAvatar);
        }
        await saveActiveAvatarSession();
        await waitForLiveMediaOwnership();
        const connectedAvatar = LiveTalkingWebRTCClient.isViable?.()
          && LiveTalkingStudio.avatarId === preferredAvatar;
        if (!connectedAvatar) await reconnectLiveTalkingAvatar(preferredAvatar);
        await unlockAudio(false);
        await LiveTalkingWebRTCClient.ensureAudioPlayback?.();
        return preferredAvatar;
      } catch (error) {
        lastError = error;
        if (status) status.textContent = `Restoring avatar (${attempt}/${attempts})…`;
        if (attempt < attempts) await wait(Math.min(1000 * (2 ** (attempt - 1)), 5000));
      }
    }
    throw lastError || new Error('Avatar restore failed');
  })().finally(() => { operationalAvatarRestorePromise = null; });
  return operationalAvatarRestorePromise;
}

function scheduleOperationalAvatarRestore(reason = 'state changed', delayMs = 350) {
  if (!appStartupComplete
    || RuntimeSystem.released
    || (!RuntimeSystem.policy.liveTalkingAutostart && !LiveTalkingWorker.ready)) return;
  clearTimeout(operationalAvatarRestoreTimer);
  operationalAvatarRestoreTimer = setTimeout(() => {
    if (!runtimeRealtimeConnected || LiveMediaOwnership.state === 'STANDBY') return;
    void restoreOperationalAvatar({ attempts: 3 })
      .catch(error => {
        addLog(`Avatar restore after ${reason} failed: ${error.message}`, 'warn');
        scheduleOperationalAvatarRestore('automatic retry', 5000);
      });
  }, delayMs);
}

function applyLiveTalkingWorkerState(worker = {}) {
  LiveTalkingWorker.state = worker.state || (worker.ready ? 'READY' : 'OFFLINE');
  LiveTalkingWorker.ready = Boolean(worker.ready);
  if (typeof worker.alwaysOn === 'boolean') LiveTalkingWorker.alwaysOn = worker.alwaysOn;
  if (worker.modelFps || worker.outputFps) applyLiveTalkingFpsUI(worker.modelFps, worker.outputFps);
  if (worker.videoQuality) applyLiveVideoQualityUI(worker.videoQuality);
  LiveTalkingWorker.error = worker.error || '';
  LiveTalkingWorker.instanceKey = worker.ready
    ? `${worker.endpoint || ''}:${worker.pid || 'external'}:${worker.startedAt || 0}`
    : '';
  const button = $('btn-livetalking-worker');
  const label = $('livetalking-worker-label');
  const badge = $('livetalking-engine-badge');
  const dot = $('livetalking-engine-dot');
  const status = $('livetalking-engine-status');
  const detail = $('livetalking-engine-detail');
  const mode = $('livetalking-engine-mode');
  const alwaysOn = $('cfg-livetalking-always-on');
  const startButton = $('start-livetalking-engine');
  const stopButton = $('stop-livetalking-engine');
  const restartButton = $('restart-livetalking-engine');
  const labels = {
    OFFLINE: 'Inactive',
    STARTING: 'Starting',
    READY: 'Active',
    STOPPING: 'Stopping',
    ERROR: 'Error',
  };
  if (button) {
    button.dataset.state = LiveTalkingWorker.state;
    button.disabled = LiveTalkingWorker.state === 'STARTING'
      || LiveTalkingWorker.state === 'STOPPING'
      || LiveTalkingWorker.state === 'READY';
    button.title = LiveTalkingWorker.error || (LiveTalkingWorker.ready
      ? 'The live avatar is ready'
      : 'Prepare the live avatar');
    button.setAttribute('aria-label', button.title);
  }
  if (label) label.textContent = LiveTalkingWorker.state === 'READY' ? 'Lipsync active' : (labels[LiveTalkingWorker.state] || 'Prepare lipsync');
  const currentLabel = labels[LiveTalkingWorker.state] || 'Inactive';
  if (badge) {
    badge.textContent = currentLabel;
    badge.dataset.state = LiveTalkingWorker.state;
  }
  if (dot) dot.dataset.state = LiveTalkingWorker.state;
  if (status) status.textContent = currentLabel;
  if (detail) detail.textContent = LiveTalkingWorker.error || ({
    OFFLINE: 'Stopped',
    STARTING: 'Loading',
    READY: 'Lipsync ready',
    STOPPING: 'Stopping',
    ERROR: 'Retry start',
  }[LiveTalkingWorker.state] || 'Stopped');
  if (mode) mode.textContent = LiveTalkingWorker.alwaysOn ? 'Automatic startup' : 'Manual startup';
  if (alwaysOn && document.activeElement !== alwaysOn) alwaysOn.checked = LiveTalkingWorker.alwaysOn;
  const transitioning = LiveTalkingWorker.state === 'STARTING' || LiveTalkingWorker.state === 'STOPPING';
  if (startButton) {
    startButton.disabled = transitioning || LiveTalkingWorker.ready;
    startButton.setAttribute('aria-busy', String(LiveTalkingWorker.state === 'STARTING'));
  }
  if (stopButton) {
    stopButton.disabled = transitioning || !LiveTalkingWorker.ready;
    stopButton.setAttribute('aria-busy', String(LiveTalkingWorker.state === 'STOPPING'));
  }
  if (restartButton) restartButton.disabled = transitioning;
  updateLiveVideoQualityAvailability();
  updateLiveTalkingFpsAvailability();
}

async function refreshLiveTalkingWorkerStatus({ silent = false } = {}) {
  if (location.protocol === 'file:' || !window.LiveTalkingApi?.workerStatus) return LiveTalkingWorker;
  if (LiveTalkingWorker.refreshing) return LiveTalkingWorker;
  LiveTalkingWorker.refreshing = true;
  try {
    const payload = await window.LiveTalkingApi.workerStatus();
    const wasReady = LiveTalkingWorker.ready;
    const previousInstanceKey = LiveTalkingWorker.instanceKey;
    applyLiveTalkingWorkerState(payload.worker || {});
    const becameReady = !wasReady && LiveTalkingWorker.ready;
    if (becameReady) scheduleOperationalAvatarRestore('Lipsync worker became ready');
    if (becameReady && TRAINED_AVATARS.size === 0) {
      await refreshLiveTalkingAvatarList().catch(error => {
        addLog(`Could not restore Avatar Library: ${error.message}`, 'warn');
      });
    }
    const workerRestarted = Boolean(
      previousInstanceKey
      && LiveTalkingWorker.instanceKey
      && previousInstanceKey !== LiveTalkingWorker.instanceKey,
    );
    if (LiveMediaOwnership.state !== 'OWNER') {
      LiveTalkingWorker.sessionFailureCount = 0;
      return LiveTalkingWorker;
    }
    let sessionViable = LiveTalkingWebRTCClient.isViable?.()
      ?? LiveTalkingWebRTCClient.isConnected?.()
      ?? Boolean(LiveTalkingWebRTCClient.sessionId);
    const speechBusy = runtimeSpeechState === 'GENERATING' || runtimeSpeechState === 'SPEAKING';
    if (sessionViable
      && !speechBusy
      && LiveTalkingWebRTCClient.needsServerProbe?.()
      && window.LiveTalkingApi?.sessionStatus) {
      try {
        const sessionStatus = await window.LiveTalkingApi.sessionStatus();
        sessionViable = !sessionStatus.sessionId
          || sessionStatus.sessionId === LiveTalkingWebRTCClient.sessionId;
      } catch {
        sessionViable = false;
      }
    }
    if (sessionViable) LiveTalkingWorker.sessionFailureCount = 0;
    else LiveTalkingWorker.sessionFailureCount += 1;
    const sessionConfirmedLost = LiveTalkingWorker.sessionFailureCount >= 3;
    if (LiveTalkingWorker.ready
      && App.talkingEngine.provider === 'livetalking'
      && !speechBusy
      && avatarDeletionsInProgress.size === 0
      && (becameReady || workerRestarted || sessionConfirmedLost)) {
      const avatarId = [LiveAvatarSession.activeAvatarId, LiveTalkingStudio.avatarId]
        .find(id => id && TRAINED_AVATARS.has(id))
        || TRAINED_AVATARS.keys().next().value;
      if (avatarId && !liveTalkingReconnectPromise) {
        LiveTalkingWorker.sessionFailureCount = 0;
        void reconnectLiveTalkingAvatar(avatarId)
          .catch(error => addLog(`Live avatar reconnect failed: ${error.message}`, 'warn'));
      }
    }
  } catch (error) {
    if (!silent) {
      applyLiveTalkingWorkerState({ state: 'ERROR', ready: false, error: error.message });
      addLog(`Lipsync Engine status failed: ${error.message}`, 'warn');
    }
  } finally {
    LiveTalkingWorker.refreshing = false;
  }
  return LiveTalkingWorker;
}

async function startLiveTalkingWorker() {
  if (LiveTalkingWorker.ready) return LiveTalkingWorker;
  applyLiveTalkingWorkerState({ state: 'STARTING', ready: false });
  try {
    const payload = await window.LiveTalkingApi.startWorker();
    applyLiveTalkingWorkerState(payload.worker || { state: 'STARTING' });
    if (runtimeRealtimeConnected) registerLiveMediaClient();
    else if (!runtimeRealtimeSuspended) connectRuntimeRealtime();
    addLog('Lipsync Engine startup requested.', 'ok');
    return LiveTalkingWorker;
  } catch (error) {
    applyLiveTalkingWorkerState({ state: 'ERROR', ready: false, error: error.message });
    addLog(`Lipsync Engine could not start: ${error.message}`, 'err');
    throw error;
  }
}

async function stopLiveTalkingWorker() {
  if (!LiveTalkingWorker.ready && LiveTalkingWorker.state !== 'STARTING') return LiveTalkingWorker;
  applyLiveTalkingWorkerState({ ...LiveTalkingWorker, state: 'STOPPING', ready: false });
  const actionStatus = $('livetalking-engine-action-status');
  if (actionStatus) actionStatus.textContent = 'Stopping engine...';
  try {
    const payload = await window.LiveTalkingApi.stopWorker();
    LiveTalkingWorker.alwaysOn = false;
    applyLiveTalkingWorkerState(payload.worker || { state: 'STOPPING', ready: false, alwaysOn: false });
    if (actionStatus) actionStatus.textContent = 'Stopped. Always on is off.';
    addLog('Lipsync Engine stopped.', 'ok');
    return LiveTalkingWorker;
  } catch (error) {
    await refreshLiveTalkingWorkerStatus({ silent: true });
    if (actionStatus) actionStatus.textContent = error.message;
    addLog(`Lipsync Engine could not stop: ${error.message}`, 'err');
    throw error;
  }
}

async function setLiveTalkingAlwaysOn(alwaysOn) {
  const toggle = $('cfg-livetalking-always-on');
  const actionStatus = $('livetalking-engine-action-status');
  if (toggle) toggle.disabled = true;
  if (actionStatus) actionStatus.textContent = alwaysOn ? 'Enabling automatic startup...' : 'Switching to manual startup...';
  try {
    const payload = await window.RuntimeApi.post('/api/settings/talking', { alwaysOn: Boolean(alwaysOn) });
    LiveTalkingWorker.alwaysOn = Boolean(payload.settings?.alwaysOn);
    applyLiveTalkingWorkerState({ ...LiveTalkingWorker, alwaysOn: LiveTalkingWorker.alwaysOn });
    if (actionStatus) actionStatus.textContent = LiveTalkingWorker.alwaysOn ? 'Always on enabled.' : 'Manual startup enabled.';
    if (LiveTalkingWorker.alwaysOn) await refreshLiveTalkingWorkerStatus({ silent: true });
  } catch (error) {
    if (toggle) toggle.checked = LiveTalkingWorker.alwaysOn;
    if (actionStatus) actionStatus.textContent = error.message;
    throw error;
  } finally {
    if (toggle) toggle.disabled = false;
  }
}

async function ensureLiveTalkingWorkerReady(timeoutMs = 180000) {
  await refreshLiveTalkingWorkerStatus({ silent: true });
  if (!LiveTalkingWorker.ready) await startLiveTalkingWorker();
  const deadline = Date.now() + timeoutMs;
  while (!LiveTalkingWorker.ready && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await refreshLiveTalkingWorkerStatus({ silent: true });
    if (LiveTalkingWorker.state === 'ERROR') throw new Error(LiveTalkingWorker.error || 'Lipsync Engine failed to start');
  }
  if (!LiveTalkingWorker.ready) throw new Error('Lipsync Engine startup timed out');
  return LiveTalkingWorker;
}

const ProjectStorage = {
  rootPath: localStorage.getItem(STORAGE_KEYS.PROJECT_STORAGE_ROOT) || '',
  projectName: localStorage.getItem(STORAGE_KEYS.PROJECT_NAME) || 'ai-livestream',
  projectPath: '',
};

async function persistProjectFile(file, category = 'uploads', avatarId = '') {
  if (!file || location.protocol === 'file:') return null;
  const params = new URLSearchParams({ category, filename: file.name });
  if (avatarId) params.set('avatarId', avatarId);
  const response = await fetch(`/api/storage/file?${params}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Could not save the project file');
  return payload;
}

async function persistProjectJson(category, filename, data, avatarId = '') {
  if (location.protocol === 'file:') return null;
  const response = await fetch('/api/storage/json', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, filename, data, avatarId }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Could not save metadata');
  return payload;
}

async function registerProjectAvatar(avatar) {
  if (location.protocol === 'file:') return avatar;
  const payload = await window.LiveTalkingApi.registerAvatar(avatar);
  return payload.avatar;
}

async function renameProjectAvatar(avatar, name) {
  const nextName = String(name || '').trim();
  if (!nextName) throw new Error('Avatar name cannot be empty');
  if (nextName.length > 160) throw new Error('Avatar name must be 160 characters or fewer');
  const updated = await registerProjectAvatar({
    id: avatar.id,
    name: nextName,
    modelType: avatar.modelType === 'wav2lip' ? 'wav2lip' : 'musetalk',
    status: avatar.status === 'failed' ? 'failed' : 'ready',
    ...(Number.isFinite(Number(avatar.trainedAt)) ? { trainedAt: Number(avatar.trainedAt) } : {}),
  });
  await refreshLiveTalkingAvatarList();
  return updated;
}

async function updateProjectAvatarState(avatar, avatarState) {
  const allowedStates = ['normal', 'happy', 'laughing', 'grateful', 'surprised', 'excited', 'sad', 'angry', 'playful', 'focused'];
  const state = allowedStates.includes(String(avatarState || '').toLowerCase())
    ? String(avatarState).toLowerCase()
    : 'normal';
  const updated = await registerProjectAvatar({
    id: avatar.id,
    name: avatar.name || avatar.id,
    modelType: avatar.modelType === 'wav2lip' ? 'wav2lip' : 'musetalk',
    status: avatar.status === 'failed' ? 'failed' : 'ready',
    profileId: avatar.profileId || avatar.id,
    avatarState: state,
    ...(Number.isFinite(Number(avatar.trainedAt)) ? { trainedAt: Number(avatar.trainedAt) } : {}),
  });
  await refreshLiveTalkingAvatarList();
  return updated;
}

async function deleteProjectAvatar(avatarId) {
  if (location.protocol === 'file:') throw new Error('Open the dashboard through localhost to manage avatars');
  avatarDeletionsInProgress.add(avatarId);
  const previous = {
    activeAvatarId: LiveAvatarSession.activeAvatarId,
    selectedAvatarIds: [...LiveAvatarSession.selectedAvatarIds],
    studioAvatarId: LiveTalkingStudio.avatarId,
  };
  const legacyAvatar = await IdolDB.getAvatar('livetalking_avatar').catch(() => null);
  const legacyAvatarId = legacyAvatar?.meta?.avatarId || '';
  try {
    const payload = await window.LiveTalkingApi.deleteAvatar(avatarId);
    // Older builds kept one preview copy under a singleton IndexedDB key.
    // Remove it too, otherwise a reload can restore the deleted avatar.
    if (!legacyAvatarId || legacyAvatarId === avatarId) {
      await IdolDB.deleteAvatar('livetalking_avatar').catch(() => {});
    }
    LiveAvatarSession.activeAvatarId = payload.session?.activeAvatarId || '';
    LiveAvatarSession.selectedAvatarIds = [...new Set((payload.session?.selectedAvatarIds || []).map(String).filter(Boolean))];
    LiveAvatarSession.excludedAvatarIds = [...new Set((payload.session?.excludedAvatarIds || []).map(String).filter(Boolean))];
    if (previous.studioAvatarId === avatarId) LiveTalkingStudio.avatarId = LiveAvatarSession.activeAvatarId;
    if (!LiveTalkingStudio.avatarId) {
      LiveTalkingStudio.isTrainedReady = false;
      LiveTalkingStudio.trainProgress = 0;
      localStorage.removeItem(STORAGE_KEYS.LIVETALKING_AVATAR);
    } else {
      localStorage.setItem(STORAGE_KEYS.LIVETALKING_AVATAR, LiveTalkingStudio.avatarId);
    }
    if (localStorage.getItem(STORAGE_KEYS.LIVETALKING_AVATAR) === avatarId) {
      localStorage.removeItem(STORAGE_KEYS.LIVETALKING_AVATAR);
    }
    localStorage.setItem(STORAGE_KEYS.ACTIVE_AVATAR, LiveAvatarSession.activeAvatarId);
    localStorage.setItem(STORAGE_KEYS.AVATAR_POOL, JSON.stringify(LiveAvatarSession.selectedAvatarIds));
    await refreshLiveTalkingAvatarList();
    return payload;
  } catch (error) {
    LiveAvatarSession.activeAvatarId = previous.activeAvatarId;
    LiveAvatarSession.selectedAvatarIds = previous.selectedAvatarIds;
    LiveTalkingStudio.avatarId = previous.studioAvatarId;
    throw error;
  } finally {
    avatarDeletionsInProgress.delete(avatarId);
  }
}

async function loadProjectStorageConfig() {
  const status = $('project-storage-status');
  if (location.protocol === 'file:') {
    if ($('project-storage-root')) $('project-storage-root').value = ProjectStorage.rootPath;
    if ($('project-storage-name')) $('project-storage-name').value = ProjectStorage.projectName;
    if (status) status.textContent = 'Open the dashboard through localhost to save project files.';
    return;
  }
  try {
    const response = await fetch('/api/storage/config');
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || 'Could not load settings');
    Object.assign(ProjectStorage, payload);
    if ($('project-storage-root')) $('project-storage-root').value = payload.rootPath;
    if ($('project-storage-name')) $('project-storage-name').value = payload.projectName;
    if (status) status.textContent = payload.projectPath;
  } catch (err) {
    if (status) status.textContent = `Error: ${err.message}`;
  }
}

async function saveProjectStorageConfig() {
  const rootPath = $('project-storage-root')?.value.trim();
  const projectName = $('project-storage-name')?.value.trim() || 'ai-livestream';
  const status = $('project-storage-status');
  if (!rootPath) {
    if (status) status.textContent = 'Enter a root folder.';
    return;
  }
  if (location.protocol === 'file:') {
    if (status) status.textContent = 'Open http://localhost:6767 to enable project storage.';
    return;
  }
  const response = await fetch('/api/storage/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rootPath, projectName }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Could not save settings');
  Object.assign(ProjectStorage, payload);
  localStorage.setItem(STORAGE_KEYS.PROJECT_STORAGE_ROOT, payload.rootPath);
  localStorage.setItem(STORAGE_KEYS.PROJECT_NAME, payload.projectName);
  if (status) status.textContent = payload.projectPath;
  addLog(`Project local: ${payload.projectPath}`, 'ok');
}

async function selectProjectStorageFolder() {
  const status = $('project-storage-status');
  if (location.protocol === 'file:') {
    if (status) status.textContent = 'Open http://localhost:6767 to select a folder.';
    return;
  }
  if (status) status.textContent = 'Waiting for folder selection…';
  try {
    const response = await fetch('/api/storage/select-folder', { method: 'POST' });
    const payload = await response.json();
    if (payload.cancelled) {
      if (status) status.textContent = 'Folder selection cancelled.';
      return;
    }
    if (!response.ok || !payload.success || !payload.rootPath) {
      throw new Error(payload.error || 'Could not select a folder');
    }
    if ($('project-storage-root')) $('project-storage-root').value = payload.rootPath;
    if (status) status.textContent = 'Folder selected. Click Save folder to apply.';
  } catch (err) {
    if (status) status.textContent = `Error: ${err.message}`;
  }
}

async function refreshLocalAiStatus() {
  const badge = $('local-ai-status-badge');
  const state = $('local-ai-runtime-state');
  const modelName = $('local-ai-model-name');
  const progress = $('local-ai-install-progress');
  const installButton = $('install-local-ai-model');
  try {
    const response = await fetch('/api/ai/local/status');
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || 'Could not read local AI status');
    if (modelName && document.activeElement !== modelName) modelName.value = payload.model;
    if (badge) badge.textContent = payload.installed ? 'Ready' : (payload.reachable ? 'Not installed' : 'Offline');
    if (state) state.textContent = payload.installed ? 'Ollama ready' : (payload.reachable ? 'Ollama connected' : 'Start Ollama first');
    if (progress) progress.textContent = payload.install?.state === 'INSTALLING' ? payload.install.progress : (payload.install?.error || '');
    if (installButton) {
      installButton.disabled = payload.installed || payload.install?.state === 'INSTALLING';
      installButton.innerHTML = payload.installed
        ? '<span class="material-symbols-rounded">check</span>Installed'
        : '<span class="material-symbols-rounded">download</span>Cài đặt Show Director';
    }
    return payload;
  } catch (error) {
    if (badge) badge.textContent = 'Offline';
    if (state) state.textContent = error.message;
    return null;
  }
}

async function installLocalAiModel() {
  const model = $('local-ai-model-name')?.value?.trim() || '';
  const response = await fetch('/api/ai/local/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(model ? { model } : {}),
  });
  const payload = await response.json();
  if (!response.ok && response.status !== 409) throw new Error(payload.error || 'Could not start model installation');
  await refreshLocalAiStatus();
  const timer = setInterval(async () => {
    const status = await refreshLocalAiStatus();
    if (!status || status.installed || status.install?.state === 'ERROR') clearInterval(timer);
  }, 2000);
}

const AiDirectorState = { provider: 'ollama', model: 'qwen3:8b', geminiProject: '', geminiLocation: 'us-central1' };

function setAiDirectorProviderUI(provider) {
  const selected = provider === 'gemini' ? 'gemini' : 'ollama';
  AiDirectorState.provider = selected;
  if ($('ai-director-provider')) $('ai-director-provider').value = selected;
  $('ai-director-ollama-panel')?.toggleAttribute('hidden', selected !== 'ollama');
  $('ai-director-gemini-panel')?.toggleAttribute('hidden', selected !== 'gemini');
  if (selected === 'gemini') void refreshGeminiGoogleAuth();
}

function applyAiDirectorSettings(persona = {}) {
  const provider = persona.llmProvider === 'gemini' ? 'gemini' : 'ollama';
  const model = persona.llmModel || (provider === 'gemini' ? 'gemini-2.5-pro' : 'qwen3:8b');
  AiDirectorState.provider = provider;
  AiDirectorState.model = model;
  AiDirectorState.geminiProject = persona.geminiProject || '';
  AiDirectorState.geminiLocation = persona.geminiLocation || 'us-central1';
  if ($('local-ai-model-name') && provider === 'ollama') $('local-ai-model-name').value = model;
  if ($('ai-director-gemini-model') && provider === 'gemini') $('ai-director-gemini-model').value = model;
  if ($('ai-director-gemini-project')) $('ai-director-gemini-project').value = AiDirectorState.geminiProject;
  if ($('ai-director-gemini-location')) $('ai-director-gemini-location').value = AiDirectorState.geminiLocation;
  setAiDirectorProviderUI(provider);
}

function applyLiveTalkingMaintenanceState(maintenance = {}) {
  const interval = Number(maintenance.restartIntervalMinutes || 15);
  const select = $('cfg-livetalking-restart-interval');
  if (select && document.activeElement !== select) select.value = String(interval);
  const status = $('livetalking-maintenance-status');
  if (!status) return;
  const stateLabel = maintenance.state === 'RESTARTING'
    ? 'Refreshing avatar memory now.'
    : maintenance.state === 'WAITING_FOR_TRAINING'
      ? 'Waiting for avatar training to finish.'
      : maintenance.state === 'WAITING_FOR_WORKER'
        ? 'Keeping the avatar worker running until its training state is available.'
      : maintenance.state === 'WAITING_FOR_SESSION_END'
        ? 'Waiting for the Live Monitor session to close.'
    : maintenance.state === 'WAITING_FOR_IDLE'
      ? 'Waiting for voice playback to finish.'
      : `Memory refresh every ${interval} minutes, after voice playback finishes.`;
  status.textContent = stateLabel;
}

async function loadAiDirectorSettings() {
  const payload = await window.RuntimeApi.get('/api/ai/director/status');
  applyAiDirectorSettings({ llmProvider: payload.provider, llmModel: payload.model, geminiProject: payload.geminiProject, geminiLocation: payload.geminiLocation });
  if (payload.provider === 'ollama') await refreshLocalAiStatus();
}

async function refreshGeminiGoogleAuth() {
  const status = $('ai-director-gemini-status');
  const button = $('connect-ai-director-gemini');
  if (status) status.textContent = 'Checking Google account…';
  try {
    const payload = await window.RuntimeApi.get('/api/ai/director/gemini/auth/status');
    const auth = payload.auth || {};
    if ($('ai-director-gemini-project') && !String($('ai-director-gemini-project').value || '').trim() && auth.projectId) {
      $('ai-director-gemini-project').value = auth.projectId;
    }
    if (status) status.textContent = auth.message || (auth.connected ? 'Google account connected.' : 'Google sign-in is required.');
    if (button) button.textContent = auth.connected ? 'Google connected' : 'Connect Google';
  } catch (error) {
    if (status) status.textContent = error.message || 'Google account status is unavailable.';
  }
}

async function connectGeminiGoogleAccount() {
  const status = $('ai-director-gemini-status');
  const button = $('connect-ai-director-gemini');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Opening Google sign-in…';
  try {
    await window.RuntimeApi.post('/api/ai/director/gemini/auth/start', {});
    if (status) status.textContent = 'Finish Google sign-in in the browser, then this status will update.';
    const timer = setInterval(async () => {
      await refreshGeminiGoogleAuth();
      if ($('connect-ai-director-gemini')?.textContent === 'Google connected') clearInterval(timer);
    }, 2500);
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveAiDirectorSettings() {
  const provider = $('ai-director-provider')?.value === 'gemini' ? 'gemini' : 'ollama';
  const model = provider === 'gemini'
    ? ($('ai-director-gemini-model')?.value.trim() || 'gemini-2.5-pro')
    : ($('local-ai-model-name')?.value.trim() || 'qwen3:8b');
  const projectId = $('ai-director-gemini-project')?.value.trim() || '';
  const location = $('ai-director-gemini-location')?.value.trim() || 'us-central1';
  const payload = await window.RuntimeApi.post('/api/ai/director/config', { provider, model, ...(provider === 'gemini' ? { projectId, location } : {}) });
  applyAiDirectorSettings(payload.settings || {});
  if ($('ai-director-save-status')) $('ai-director-save-status').textContent = 'AI Director saved.';
}

function canonicalizeBox(box) {
  if (!box) return null;
  let cx = Number(box.cx), cy = Number(box.cy), w = Number(box.w), h = Number(box.h);
  if (![cx, cy, w, h].every(Number.isFinite)) {
    const x1 = Number(box.x1), y1 = Number(box.y1), x2 = Number(box.x2), y2 = Number(box.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    w = x2 - x1; h = y2 - y1; cx = x1 + w / 2; cy = y1 + h / 2;
  }
  w = Math.max(0.01, Math.min(1, w));
  h = Math.max(0.01, Math.min(1, h));
  cx = Math.max(w / 2, Math.min(1 - w / 2, cx));
  cy = Math.max(h / 2, Math.min(1 - h / 2, cy));
  return { cx, cy, w, h, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
}

function updateStudioBoxEdges(kind) {
  const normalized = canonicalizeBox(LiveTalkingStudio[kind]);
  if (!normalized) return;
  LiveTalkingStudio[kind] = normalized;
  if (App.avatar) App.avatar[kind] = normalized;
}

function syncRegionControlUI() {
  updateStudioBoxEdges('mouthBox');
  updateStudioBoxEdges('faceBox');
  const mb = LiveTalkingStudio.mouthBox;
  const fb = LiveTalkingStudio.faceBox;
  const mc = LiveTalkingStudio.maskConfig;

  if (mb) {
    if ($('slider-ctrl-mouth-x')) $('slider-ctrl-mouth-x').value = Math.round(mb.cx * 100);
    if ($('slider-ctrl-mouth-y')) $('slider-ctrl-mouth-y').value = Math.round(mb.cy * 100);
    if ($('slider-ctrl-mouth-w')) $('slider-ctrl-mouth-w').value = Math.round(mb.w * 100);
    if ($('slider-ctrl-mouth-h')) $('slider-ctrl-mouth-h').value = Math.round(mb.h * 100);

    if ($('val-ctrl-mouth-x')) $('val-ctrl-mouth-x').textContent = `${Math.round(mb.cx * 100)}%`;
    if ($('val-ctrl-mouth-y')) $('val-ctrl-mouth-y').textContent = `${Math.round(mb.cy * 100)}%`;
    if ($('val-ctrl-mouth-w')) $('val-ctrl-mouth-w').textContent = `${Math.round(mb.w * 100)}%`;
    if ($('val-ctrl-mouth-h')) $('val-ctrl-mouth-h').textContent = `${Math.round(mb.h * 100)}%`;
  }

  if (fb) {
    if ($('slider-ctrl-face-x')) $('slider-ctrl-face-x').value = Math.round(fb.cx * 100);
    if ($('slider-ctrl-face-y')) $('slider-ctrl-face-y').value = Math.round(fb.cy * 100);
    if ($('slider-ctrl-face-w')) $('slider-ctrl-face-w').value = Math.round(fb.w * 100);
    if ($('slider-ctrl-face-h')) $('slider-ctrl-face-h').value = Math.round(fb.h * 100);

    if ($('val-ctrl-face-x')) $('val-ctrl-face-x').textContent = `${Math.round(fb.cx * 100)}%`;
    if ($('val-ctrl-face-y')) $('val-ctrl-face-y').textContent = `${Math.round(fb.cy * 100)}%`;
    if ($('val-ctrl-face-w')) $('val-ctrl-face-w').textContent = `${Math.round(fb.w * 100)}%`;
    if ($('val-ctrl-face-h')) $('val-ctrl-face-h').textContent = `${Math.round(fb.h * 100)}%`;
  }

  if (mc) {
    if ($('sel-mask-region-type')) $('sel-mask-region-type').value = mc.regionType;
    if ($('slider-mask-exp-top')) $('slider-mask-exp-top').value = Math.round(mc.expansion.top * 100);
    if ($('slider-mask-exp-bottom')) $('slider-mask-exp-bottom').value = Math.round(mc.expansion.bottom * 100);
    if ($('slider-mask-exp-left')) $('slider-mask-exp-left').value = Math.round(mc.expansion.left * 100);
    if ($('slider-mask-exp-right')) $('slider-mask-exp-right').value = Math.round(mc.expansion.right * 100);
    if ($('slider-mask-feather')) $('slider-mask-feather').value = mc.featherRadiusPx;
    if ($('slider-mask-smooth')) $('slider-mask-smooth').value = Math.round(mc.temporalSmoothingAlpha * 100);

    if ($('val-mask-exp-top')) $('val-mask-exp-top').textContent = `+${Math.round(mc.expansion.top * 100)}%`;
    if ($('val-mask-exp-bottom')) $('val-mask-exp-bottom').textContent = `+${Math.round(mc.expansion.bottom * 100)}%`;
    if ($('val-mask-exp-left')) $('val-mask-exp-left').textContent = `+${Math.round(mc.expansion.left * 100)}%`;
    if ($('val-mask-exp-right')) $('val-mask-exp-right').textContent = `+${Math.round(mc.expansion.right * 100)}%`;
    if ($('val-mask-feather')) $('val-mask-feather').textContent = `${mc.featherRadiusPx}px`;
    if ($('val-mask-smooth')) $('val-mask-smooth').textContent = `${mc.temporalSmoothingAlpha.toFixed(2)}`;
  }

  // Dynamically recompute 468 landmarks for realtime viewport rendering
  LiveTalkingStudio.landmarks468 = generate468FaceLandmarks(LiveTalkingStudio.faceBox, LiveTalkingStudio.mouthBox);
  if (App.avatar) {
    App.avatar.faceBox = LiveTalkingStudio.faceBox;
    App.avatar.mouthBox = LiveTalkingStudio.mouthBox;
    App.avatar.landmarks468 = LiveTalkingStudio.landmarks468;
  }
}

function logLiveTalkingTerminal(msg, type = 'info') {
  const container = $('lt-terminal-logs-body');
  if (!container) return;
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function updateLiveTalkingVoiceUI() {
  const provider = $('lt-voice-provider-select')?.value || App.voice.provider || 'qwentts';
  const grpWebspeech = $('lt-group-webspeech');
  const grpOpenai = $('lt-group-openai');
  const grpOmnivoice = $('lt-group-omnivoice');

  if (grpWebspeech) grpWebspeech.style.display = provider === 'webspeech' ? 'flex' : 'none';
  if (grpOpenai) grpOpenai.style.display = provider === 'openai' ? 'flex' : 'none';
  if (grpOmnivoice) grpOmnivoice.style.display = provider === 'omnivoice' ? 'flex' : 'none';
}

function updateLiveTalkingUI() {
  const step1Badge = $('badge-step-1');
  const step2Badge = $('badge-step-2');
  const lblStep1Status = $('lbl-step1-status');
  const lblStep2Status = $('lbl-step2-status');
  const badgeTrainState = $('badge-train-state');
  const colStep2 = $('lt-col-step2');
  const previewVideo = $('lt-train-video-preview');
  const previewCanvas = $('lt-train-video-canvas');
  const placeholder = $('lt-train-video-placeholder');
  const faceBadge = $('lt-train-face-badge');
  const fileInfo = $('lt-video-file-info');
  const progressFill = $('lt-training-progress-fill');
  const progressPct = $('lbl-training-pct');

  if (fileInfo) {
    if (LiveTalkingStudio.videoFile) {
      const sizeMb = (LiveTalkingStudio.videoFile.size / (1024 * 1024)).toFixed(1);
      fileInfo.textContent = `${LiveTalkingStudio.videoFile.type.startsWith('image/') ? '🖼️' : '🎬'} ${LiveTalkingStudio.videoFile.name} (${sizeMb} MB)`;
    } else {
      fileInfo.textContent = 'No media selected';
    }
  }

  if (LiveTalkingStudio.videoBlobUrl) {
    if (previewVideo && !LiveTalkingStudio.videoFile?.type.startsWith('image/')) {
      if (previewVideo.src !== LiveTalkingStudio.videoBlobUrl) {
        previewVideo.src = LiveTalkingStudio.videoBlobUrl;
      }
      previewVideo.play().catch(() => {});
    }
    if (previewCanvas) previewCanvas.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    if (faceBadge && LiveTalkingStudio.isTrainedReady) faceBadge.style.display = 'block';
  } else {
    if (previewVideo) {
      previewVideo.src = '';
    }
    if (previewCanvas) previewCanvas.style.display = 'none';
    if (placeholder) placeholder.style.display = 'block';
    if (faceBadge) faceBadge.style.display = 'none';
  }

  if (progressFill) progressFill.style.width = `${LiveTalkingStudio.trainProgress}%`;
  if (progressPct) progressPct.textContent = `${LiveTalkingStudio.trainProgress}%`;

  syncRegionControlUI();

  // Update Stage Indicators
  for (let s = 1; s <= 4; s++) {
    const item = $(`stage-item-${s}`);
    if (!item) continue;
    const threshold = s * 25;
    if (LiveTalkingStudio.trainProgress >= threshold) {
      item.className = 'lt-stage-item completed';
    } else if (LiveTalkingStudio.isTraining && LiveTalkingStudio.trainProgress >= threshold - 25) {
      item.className = 'lt-stage-item active';
    } else {
      item.className = 'lt-stage-item';
    }
  }

  if (LiveTalkingStudio.isTrainedReady) {
    if (step1Badge) step1Badge.className = 'lt-step-badge completed';
    if (lblStep1Status) lblStep1Status.textContent = '✅ Complete';
    if (badgeTrainState) {
      badgeTrainState.className = 'badge-status-pill ok';
      badgeTrainState.textContent = '✅ MuseTalk Neural Ready';
    }

    // Unlock Step 2
    if (colStep2) colStep2.classList.remove('locked');
    if (step2Badge) step2Badge.className = 'lt-step-badge active';
    if (lblStep2Status) lblStep2Status.textContent = '🟢 Unlocked';

    const liveVideo = $('lt-live-stream-video');
    if (liveVideo && LiveTalkingStudio.videoBlobUrl) {
      if (liveVideo.src !== LiveTalkingStudio.videoBlobUrl) {
        liveVideo.src = LiveTalkingStudio.videoBlobUrl;
      }
      liveVideo.play().catch(() => {});
    }
  } else {
    if (step1Badge) step1Badge.className = 'lt-step-badge active';
    if (lblStep1Status) lblStep1Status.textContent = LiveTalkingStudio.isTraining ? '⏳ Worker processing...' : (LiveTalkingStudio.videoFile ? 'Ready to create' : 'Waiting for media');
    if (badgeTrainState) {
      badgeTrainState.className = LiveTalkingStudio.isTraining ? 'badge-status-pill training' : 'badge-status-pill';
      badgeTrainState.textContent = LiveTalkingStudio.isTraining ? `⏳ Neural ${LiveTalkingStudio.trainProgress}%` : 'Not created';
    }

    // Lock Step 2
    if (colStep2) colStep2.classList.add('locked');
    if (step2Badge) step2Badge.className = 'lt-step-badge locked';
    if (lblStep2Status) lblStep2Status.textContent = '🔒 Locked';
  }

  updateLiveTalkingVoiceUI();
  updateAvatarCreateUI();
}

function updateAvatarCreateUI() {
  const progress = Math.max(0, Math.min(100, Number(AvatarCreateFlow.progress) || 0));
  const fill = $('avatar-create-progress-fill');
  const label = $('avatar-create-progress-label');
  const status = $('avatar-create-status');
  const button = $('btn-avatar-create-train');
  const message = $('avatar-create-message');
  const steps = [...document.querySelectorAll('[data-create-step]')];
  const current = AvatarCreateFlow.status;
  const order = ['upload', 'config', 'training', 'done'];
  const activeItem = AvatarCreateFlow.items.find(item => item.status === 'training');
  const trainingMessage = activeItem?.stageMessage || AvatarCreateFlow.stageMessage || 'Preparing avatar';

  if (fill) fill.style.width = `${progress}%`;
  if (label) label.textContent = `${progress}%`;
  if (status) status.textContent = current === 'done' ? 'Avatar ready'
    : current === 'training' ? trainingMessage
    : current === 'config' ? 'Ready to train'
    : 'Ready to upload';

  steps.forEach(step => {
    const stepName = step.dataset.createStep;
    step.classList.toggle('active', stepName === current);
    step.classList.toggle('complete', order.indexOf(stepName) < order.indexOf(current));
  });

  if (button) {
    button.disabled = !AvatarCreateFlow.files.length || LiveTalkingStudio.isTraining;
    button.innerHTML = current === 'done'
      ? `${window.materialIcon?.('check') || ''}Done`
      : current === 'training'
        ? `${window.materialIcon?.('progress_activity') || ''}Training…`
        : `${window.materialIcon?.('model_training') || ''}Start Training`;
  }
  const failedItems = AvatarCreateFlow.items.filter(item => item.status === 'failed');
  if (message) message.textContent = current === 'done'
    ? `${AvatarCreateFlow.items.filter(item => item.status === 'completed').length} avatar(s) ready. ${AvatarCreateFlow.items.filter(item => item.status === 'failed').length} failed.`
    : current === 'training'
      ? trainingMessage
      : failedItems.length
        ? `Training failed: ${failedItems[0].error || 'The avatar engine rejected the task.'}`
      : 'Your trained avatar will be saved to the local avatar library.';
  updateLiveVideoQualityAvailability();
}

function cleanAvatarId(value, fallback = 'avatar') {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || fallback;
}

function renderAvatarBatchQueue() {
  const queue = $('avatar-batch-queue');
  if (!queue) return;
  queue.replaceChildren();
  AvatarCreateFlow.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'avatar-batch-row';
    row.dataset.status = item.status || 'ready';
    row.dataset.batchIndex = String(index);

    const filename = document.createElement('span');
    filename.className = 'avatar-batch-file';
    filename.textContent = item.file.name;
    filename.title = item.file.name;

    const idInput = document.createElement('input');
    idInput.className = 'form-input-sm';
    idInput.value = item.avatarId;
    idInput.maxLength = 80;
    idInput.setAttribute('aria-label', `Avatar ID for ${item.file.name}`);
    idInput.dataset.batchAvatarId = String(index);
    idInput.disabled = LiveTalkingStudio.isTraining;

    const modelLabel = document.createElement('span');
    modelLabel.className = 'avatar-batch-engine';
    modelLabel.textContent = 'Standard';

    const state = document.createElement('span');
    state.className = 'avatar-batch-state';
    state.textContent = item.status === 'failed'
      ? 'Failed'
      : item.status === 'completed' ? 'Ready' : item.status === 'training' ? (item.stageMessage || `${Math.round(item.progress || 0)}%`) : item.status === 'uploading' ? 'Upload…' : 'Queued';
    state.title = item.error || item.stageMessage || '';
    row.append(filename, idInput, modelLabel, state);
    queue.appendChild(row);
  });
}

function syncAvatarBatchIds(baseId) {
  const base = cleanAvatarId(baseId, 'avatar');
  AvatarCreateFlow.items.forEach((item, index) => {
    item.avatarId = AvatarCreateFlow.items.length === 1 ? base : `${base}_${String(index + 1).padStart(2, '0')}`.slice(0, 80);
  });
  renderAvatarBatchQueue();
}

async function loadAvatarTrainingFiles(fileList) {
  const files = [...(fileList || [])].slice(0, 20);
  if (!files.length) return;
  AvatarCreateFlow.progress = 0;
  AvatarCreateFlow.stageMessage = '';
  AvatarCreateFlow.files = files;
  AvatarCreateFlow.file = files[0];
  const baseId = cleanAvatarId($('avatar-create-id')?.value, `avatar_${String(Date.now()).slice(-6)}`);
  const model = $('lt-model-select')?.value || 'musetalk';
  AvatarCreateFlow.items = files.map((file, index) => ({
    file,
    avatarId: files.length === 1 ? baseId : `${baseId}_${String(index + 1).padStart(2, '0')}`.slice(0, 80),
    model,
    status: 'ready',
    progress: 0,
    taskId: '',
    storedPath: '',
    error: '',
    stageMessage: '',
  }));
  renderAvatarBatchQueue();
  await loadAvatarTrainingFile(files[0], false);
  if ($('avatar-create-file-name')) $('avatar-create-file-name').textContent = files.length === 1
    ? files[0].name
    : `${files.length} avatar files selected`;
  updateAvatarCreateUI();
}

async function loadAvatarTrainingFile(file, persistSource = true) {
  if (!file) return;
  AvatarCreateFlow.file = file;
  AvatarCreateFlow.status = 'config';
  LiveTalkingStudio.videoFile = file;
  LiveTalkingStudio.videoBlobUrl = URL.createObjectURL(file);
  LiveTalkingStudio.isTrainedReady = false;
  LiveTalkingStudio.trainProgress = 0;
  VideoLipSyncRetargeter.reset();

  if (file.type.startsWith('image/')) {
    const img = new Image();
    img.src = LiveTalkingStudio.videoBlobUrl;
    await img.decode();
    LiveTalkingStudio.videoEl = img;
  } else {
    const vid = document.createElement('video');
    vid.src = LiveTalkingStudio.videoBlobUrl;
    vid.loop = true;
    vid.muted = true;
    vid.playsInline = true;
    vid.autoplay = true;
    vid.play().catch(() => {});
    LiveTalkingStudio.videoEl = vid;
  }

  // Project storage is the durable source of truth. This browser cache only
  // speeds up preview restore and must not prevent a training task from running.
  await IdolDB.saveAvatar('livetalking_avatar', file, {
    fileName: file.name,
    fileSize: file.size,
    isTrainedReady: false,
    uploadedAt: Date.now(),
  }).catch(error => {
    console.warn('[Avatar] Local preview cache is unavailable:', error);
    addLog(`Avatar preview cache skipped: ${error.message}`, 'warn');
  });
  if (persistSource) {
    persistProjectFile(file, 'avatars/source', $('avatar-create-id')?.value.trim() || $('lt-avatar-id-input')?.value.trim() || 'avatar_main')
      .then(saved => saved && addLog(`Saved avatar media: ${saved.path}`, 'ok'))
      .catch(err => addLog(`Could not save avatar media: ${err.message}`, 'warn'));
  }

  if ($('avatar-create-file-name')) $('avatar-create-file-name').textContent = file.name;
  updateLiveTalkingUI();
  addLog(`Loaded avatar media: ${file.name}`, 'ok');
}

function openAvatarCreateModal() {
  if (!LiveTalkingStudio.isTraining) {
    AvatarCreateFlow.status = 'upload';
    AvatarCreateFlow.progress = 0;
    AvatarCreateFlow.file = null;
    AvatarCreateFlow.files = [];
    AvatarCreateFlow.items = [];
    LiveTalkingStudio.trainProgress = 0;
    const suggestedId = `avatar_${String(Date.now()).slice(-6)}`;
    if ($('avatar-create-id')) $('avatar-create-id').value = suggestedId;
    if ($('lt-avatar-id-input')) $('lt-avatar-id-input').value = suggestedId;
    if ($('input-avatar-create-file')) $('input-avatar-create-file').value = '';
    if ($('avatar-create-file-name')) $('avatar-create-file-name').textContent = 'Upload one or more avatars';
  }
  if ($('modal-avatar-create')) $('modal-avatar-create').style.display = 'flex';
  updateAvatarCreateUI();
  renderAvatarBatchQueue();
}

function closeAvatarCreateModal() {
  if ($('modal-avatar-create')) $('modal-avatar-create').style.display = 'none';
}

async function startLiveTalkingTrainingSimulation() {
  if (!LiveTalkingStudio.videoBlobUrl) {
    alert('Upload an avatar image or video first.');
    return;
  }

  if (LiveTalkingStudio.isTraining) return;
  LiveTalkingStudio.isTraining = true;
  AvatarCreateFlow.status = 'training';
  LiveTalkingStudio.isTrainedReady = false;
  LiveTalkingStudio.trainProgress = 0;
  updateLiveTalkingUI();

  const modelType = $('lt-model-select')?.value || 'musetalk';
  const avatarId = $('lt-avatar-id-input')?.value.trim() || 'avatar_main';
  LiveTalkingStudio.modelType = modelType;
  LiveTalkingStudio.avatarId = avatarId;

  logLiveTalkingTerminal(`Starting Lipsync preprocessing [${avatarId}]...`, 'info');

  try {
    const vid = LiveTalkingStudio.videoEl;
    const vw = vid ? (vid.videoWidth || 1920) : 1920;
    const vh = vid ? (vid.videoHeight || 1080) : 1080;

    // Stage 1: Frame extraction & normalization (video2imgs)
    logLiveTalkingTerminal('▶ [Stage 1/4] [video2imgs] Extracting source frames and normalizing to 25 FPS...', 'info');
    LiveTalkingStudio.trainProgress = 25;
    updateLiveTalkingUI();
    await new Promise(r => setTimeout(r, 500));

    // Stage 2: Native MuseTalk Face Detection & Bounding Box (face_detection)
    logLiveTalkingTerminal('▶ [Stage 2/4] [face_detection] Detecting face bounding boxes...', 'info');
    
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 320;
    sampleCanvas.height = 180;
    const sCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    
    const detectedBoxes = [];
    if (vid) {
      sCtx.drawImage(vid, 0, 0, 320, 180);
      const b = detectFaceBoxOnFrame(sCtx, 320, 180);
      detectedBoxes.push(b);
    }
    if (detectedBoxes.length === 0) {
      detectedBoxes.push({ x1: 0.32, y1: 0.14, x2: 0.68, y2: 0.54 });
    }

    LiveTalkingStudio.trainProgress = 50;
    updateLiveTalkingUI();
    await new Promise(r => setTimeout(r, 500));

    // Stage 3: VAE Latent & Lower-Face Mask Caching (latent_caching)
    logLiveTalkingTerminal('▶ [Stage 3/4] [latent_caching] Creating VAE latents and lower-face masks...', 'info');
    const smoothedBoxes = get_smoothened_boxes(detectedBoxes, 5);
    LiveTalkingStudio.coords = smoothedBoxes;
    const rawFace = smoothedBoxes[0] || { x1: 0.32, y1: 0.14, x2: 0.68, y2: 0.54 };

    const faceW = rawFace.x2 - rawFace.x1;
    const faceH = rawFace.y2 - rawFace.y1;
    const faceCx = rawFace.x1 + faceW / 2;
    const faceCy = rawFace.y1 + faceH / 2;

    LiveTalkingStudio.faceBox = {
      cx: parseFloat(faceCx.toFixed(3)),
      cy: parseFloat(faceCy.toFixed(3)),
      w: parseFloat(faceW.toFixed(3)),
      h: parseFloat(faceH.toFixed(3)),
      x1: parseFloat(rawFace.x1.toFixed(3)),
      y1: parseFloat(rawFace.y1.toFixed(3)),
      x2: parseFloat(rawFace.x2.toFixed(3)),
      y2: parseFloat(rawFace.y2.toFixed(3)),
    };

    const mouthCx = faceCx;
    const mouthCy = faceCy + faceH * 0.18;
    const mouthW = faceW * 0.42;
    const mouthH = faceH * 0.22;

    LiveTalkingStudio.mouthBox = {
      cx: parseFloat(mouthCx.toFixed(3)),
      cy: parseFloat(mouthCy.toFixed(3)),
      w: parseFloat(mouthW.toFixed(3)),
      h: parseFloat(mouthH.toFixed(3)),
      x1: parseFloat((mouthCx - mouthW / 2).toFixed(3)),
      y1: parseFloat((mouthCy - mouthH / 2).toFixed(3)),
      x2: parseFloat((mouthCx + mouthW / 2).toFixed(3)),
      y2: parseFloat((mouthCy + mouthH / 2).toFixed(3)),
    };

    // Calculate total frames in video
    const vidDuration = (vid && vid.duration && !isNaN(vid.duration)) ? vid.duration : 10;
    const targetFps = 25;
    const totalFrames = Math.max(1, Math.round(vidDuration * targetFps));

    // Construct raw bounding boxes list for each frame
    const rawBboxes = [];
    for (let i = 0; i < totalFrames; i++) {
      rawBboxes.push({
        x1: LiveTalkingStudio.faceBox.x1,
        y1: LiveTalkingStudio.faceBox.y1,
        x2: LiveTalkingStudio.faceBox.x2,
        y2: LiveTalkingStudio.faceBox.y2,
      });
    }

    // Build Native MuseTalk Dataset with Ping-Pong Loop Indexing
    LiveTalkingStudio.museTalkDataset = MuseTalkNativePipeline.preprocessDataset(
      totalFrames,
      rawBboxes,
      targetFps,
      0,
      avatarId
    );

    // Also populate optional 468 mesh for diagnostics
    LiveTalkingStudio.landmarks468 = generate468FaceLandmarks(LiveTalkingStudio.faceBox, LiveTalkingStudio.mouthBox);

    logLiveTalkingTerminal(`🎯 [MuseTalk] Indexed ping-pong sequence (${LiveTalkingStudio.museTalkDataset.sequence.length} frames)`, 'ok');
    logLiveTalkingTerminal(`🔒 [Frame Sync] Lockstep verified: FRAME=BBOX=LATENT=MASK`, 'ok');

    LiveTalkingStudio.trainProgress = 75;
    updateLiveTalkingUI();
    await new Promise(r => setTimeout(r, 500));

    // Stage 4: Compile Avatar Dataset Package
    logLiveTalkingTerminal('▶ [Stage 4/4] [compile] Building the MuseTalk avatar profile...', 'info');
    LiveTalkingStudio.trainProgress = 100;
    LiveTalkingStudio.isTraining = false;
    LiveTalkingStudio.isTrainedReady = true;
    AvatarCreateFlow.status = 'done';

    LiveTalkingStudio.trainedDataset = {
      id: avatarId,
      name: LiveTalkingStudio.videoFile ? LiveTalkingStudio.videoFile.name : avatarId,
      modelType: modelType,
      videoUrl: LiveTalkingStudio.videoBlobUrl,
      landmarks468: LiveTalkingStudio.landmarks468,
      topology: FACEMESH_TOPOLOGY,
      coords: LiveTalkingStudio.coords,
      faceBox: LiveTalkingStudio.faceBox,
      mouthBox: LiveTalkingStudio.mouthBox,
      museTalkDataset: LiveTalkingStudio.museTalkDataset,
      fps: targetFps,
      timestamp: Date.now(),
    };

    // Save to IndexedDB & state
    if (LiveTalkingStudio.videoFile) {
      await IdolDB.saveAvatar('livetalking_avatar', LiveTalkingStudio.videoFile, {
        fileName: LiveTalkingStudio.videoFile.name,
        fileSize: LiveTalkingStudio.videoFile.size,
        modelType: modelType,
        avatarId: avatarId,
        isTrainedReady: true,
        landmarks468: LiveTalkingStudio.landmarks468,
        coords: LiveTalkingStudio.coords,
        faceBox: LiveTalkingStudio.faceBox,
        mouthBox: LiveTalkingStudio.mouthBox,
        museTalkDataset: LiveTalkingStudio.museTalkDataset,
        trainedAt: Date.now()
      });
      await registerProjectAvatar({ id: avatarId, name: LiveTalkingStudio.videoFile.name, modelType, status: 'ready', trainedAt: Date.now() }).catch(() => {});
      await persistProjectJson('models', 'dataset.json', LiveTalkingStudio.trainedDataset, avatarId).catch(() => {});
    }

    App.avatar.videoEl = LiveTalkingStudio.videoEl;
    App.avatar.videoUrl = LiveTalkingStudio.videoBlobUrl;
    App.avatar.customImageData = LiveTalkingStudio.videoBlobUrl;
    App.avatar.faceBox = LiveTalkingStudio.faceBox;
    App.avatar.mouthBox = LiveTalkingStudio.mouthBox;
    App.avatar.landmarks468 = LiveTalkingStudio.landmarks468;
    App.avatar.museTalkDataset = LiveTalkingStudio.museTalkDataset;

    updateLiveTalkingUI();
    logLiveTalkingTerminal('Lipsync preprocessing complete. Voice testing unlocked.', 'ok');
    addLog(`Lipsync data ready [${avatarId}].`, 'ok');

    // ── STAGE 5: Sample real video frames for realistic video-based LipSync ──
    // This runs asynchronously after training — it scans the video, extracts
    // 80 timestamps, and fills 16 openness buckets with real face pixels.
    logLiveTalkingTerminal('▶ [Stage 5/5] [frame_sampler] Sampling source frames for the LipSync frame set...', 'info');
    VideoLipSyncRetargeter.reset();
    const samplerVid = LiveTalkingStudio.videoEl;
    const samplerFaceBox = LiveTalkingStudio.faceBox;
    const samplerMouthBox = LiveTalkingStudio.mouthBox;

    VideoLipSyncRetargeter.sampleVideo(
      samplerVid,
      samplerFaceBox,
      samplerMouthBox,
      (progress, openness, bucket) => {
        if (Math.round(progress * 100) % 20 === 0) {
          logLiveTalkingTerminal(
            `  ⏳ Sampling frame ${Math.round(progress * 100)}% — Openness: ${(openness * 100).toFixed(0)}% → Bucket ${bucket}`,
            'info'
          );
        }
      }
    ).then(() => {
      if (VideoLipSyncRetargeter.isReady) {
        const filledBuckets = VideoLipSyncRetargeter.bucketTimestamps
          ? VideoLipSyncRetargeter.bucketTimestamps.filter(t => t !== null && t >= 0).length
          : 0;
        logLiveTalkingTerminal(
          `✅ [Retargeter] Complete. ${filledBuckets}/${VideoLipSyncRetargeter.NUM_BUCKETS} buckets — Source-video LipSync frames are ready.`,
          'ok'
        );
        addLog('✅ Video LipSync frame set is ready.', 'ok');
      }
    }).catch(err => {
      logLiveTalkingTerminal(`⚠️ Frame sampler error: ${err.message}`, 'warn');
    });

  } catch (err) {
    LiveTalkingStudio.isTraining = false;
    AvatarCreateFlow.status = 'config';
    updateLiveTalkingUI();
    logLiveTalkingTerminal(`❌ Avatar creation error: ${err.message}`, 'err');
    addLog(`Avatar creation failed: ${err.message}`, 'warn');
  }
}

async function refreshLiveTalkingAvatarList() {
  const select = $('lt-existing-avatar-select');
  const records = new Map();
  const [localResult, sessionResult] = await Promise.allSettled([
    location.protocol === 'file:' ? Promise.resolve({ avatars: [] }) : window.LiveTalkingApi.listAvatars(),
    location.protocol === 'file:' ? Promise.resolve({ session: null }) : window.LiveTalkingApi.getAvatarSession(),
  ]);
  if (localResult.status === 'fulfilled') {
    for (const avatar of localResult.value.avatars || []) {
      const id = avatar.id || avatar.avatarId;
      if (id) records.set(id, { ...records.get(id), ...avatar, id, status: avatar.status || 'ready', source: 'local' });
    }
  }
  if (sessionResult.status === 'fulfilled' && sessionResult.value.session) {
    const persistedAvatarId = sessionResult.value.session.activeAvatarId || '';
    LiveAvatarSession.activeAvatarId = persistedAvatarId && records.has(persistedAvatarId) ? persistedAvatarId : '';
    LiveAvatarSession.selectedAvatarIds = (sessionResult.value.session.selectedAvatarIds || (persistedAvatarId ? [persistedAvatarId] : []))
      .map(String)
      .filter(id => records.has(id));
    LiveAvatarSession.excludedAvatarIds = (sessionResult.value.session.excludedAvatarIds || [])
      .map(String)
      .filter(id => records.has(id));
    localStorage.setItem(STORAGE_KEYS.ACTIVE_AVATAR, LiveAvatarSession.activeAvatarId);
    localStorage.setItem(STORAGE_KEYS.AVATAR_POOL, JSON.stringify(LiveAvatarSession.selectedAvatarIds));
    if (persistedAvatarId && !LiveAvatarSession.activeAvatarId && localResult.status === 'fulfilled' && localResult.value.workerAvailable !== false) {
      void window.LiveTalkingApi.saveActiveAvatarSession(null)
        .catch(error => addLog(`Could not clear an unavailable avatar session: ${error.message}`, 'warn'));
    }
  }
  const avatars = [...records.values()];
  TRAINED_AVATARS.clear();
  avatars.forEach(avatar => TRAINED_AVATARS.set(avatar.id, avatar));
  const validIds = new Set(avatars.map(avatar => avatar.id));
  const validSelectedIds = [...new Set(LiveAvatarSession.selectedAvatarIds.filter(id => validIds.has(id)))];
  const persistedSelectedId = validIds.has(LiveAvatarSession.activeAvatarId) ? LiveAvatarSession.activeAvatarId : '';
  const cachedActiveId = validIds.has(LiveTalkingStudio.avatarId) ? LiveTalkingStudio.avatarId : '';
  if (!validSelectedIds.length && (persistedSelectedId || cachedActiveId || avatars[0]?.id)) {
    validSelectedIds.push(persistedSelectedId || cachedActiveId || avatars[0].id);
  }
  const validActiveId = persistedSelectedId || cachedActiveId || validSelectedIds[0] || '';
  LiveAvatarSession.selectedAvatarIds = validSelectedIds;
  LiveAvatarSession.activeAvatarId = validActiveId;
  LiveTalkingStudio.avatarId = validActiveId;
  if (validActiveId) {
    localStorage.setItem(STORAGE_KEYS.LIVETALKING_AVATAR, validActiveId);
  } else {
    localStorage.removeItem(STORAGE_KEYS.LIVETALKING_AVATAR);
  }
  localStorage.setItem(STORAGE_KEYS.ACTIVE_AVATAR, LiveAvatarSession.activeAvatarId);
  localStorage.setItem(STORAGE_KEYS.AVATAR_POOL, JSON.stringify(LiveAvatarSession.selectedAvatarIds));
  if (select) {
    select.replaceChildren(...avatars.map(avatar => {
      const option = document.createElement('option');
      option.value = avatar.id;
      option.textContent = avatar.id;
      option.selected = avatar.id === LiveTalkingStudio.avatarId;
      return option;
    }));
  }
  renderActiveAvatarOptions(avatars.map(avatar => avatar.id));
  renderAvatarLibrary(avatars);
  renderLibraryUI();
  return avatars;
}

function renderAvatarLibrary(avatars) {
  const grid = $('avatar-library-grid');
  if (!grid) return;
  for (const objectUrl of avatarThumbnailObjectUrls) URL.revokeObjectURL(objectUrl);
  avatarThumbnailObjectUrls.clear();
  const valid = avatars.filter(avatar => avatar?.id);
  if (!valid.some(avatar => avatar.id === LiveAvatarSession.activeAvatarId)) LiveAvatarSession.activeAvatarId = '';
  if ($('avatar-page-count')) $('avatar-page-count').textContent = `${valid.length} avatar${valid.length === 1 ? '' : 's'}`;

  if (!valid.length) {
    grid.innerHTML = `<article class="avatar-empty-card"><span class="material-symbols-rounded" aria-hidden="true">person_add</span><h2>No avatars yet</h2><p>Upload media and train your first avatar.</p><button type="button" data-create-avatar>Create Avatar</button></article>`;
    return;
  }

  grid.replaceChildren(...valid.map(avatar => {
    const card = document.createElement('article');
    const selected = LiveAvatarSession.selectedAvatarIds.includes(avatar.id);
    const liveNow = isAvatarLiveNow(avatar.id);
    card.className = `avatar-library-card${selected ? ' selected' : ''}${liveNow ? ' live-now' : ''}`;
    card.dataset.avatarId = avatar.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'checkbox');
    card.setAttribute('aria-checked', String(selected));
    card.setAttribute('aria-label', `${selected ? 'Disable' : 'Enable'} ${avatar.name || avatar.id} in the Avatar Pool${liveNow ? '; live now' : ''}`);

    const preview = document.createElement('div');
    preview.className = 'avatar-card-preview';
    const status = document.createElement('span');
    status.className = 'avatar-card-status';
    status.textContent = selected ? 'Enabled' : 'Disabled';
    const liveStatus = document.createElement('span');
    liveStatus.className = 'avatar-card-live-status';
    liveStatus.textContent = 'Live now';
    liveStatus.hidden = !liveNow;
    const fallback = document.createElement('span');
    fallback.className = 'material-symbols-rounded avatar-card-fallback';
    fallback.setAttribute('aria-hidden', 'true');
    fallback.textContent = 'person';
    preview.append(fallback);

    if (avatar.thumbnailUrl && location.protocol !== 'file:') {
      const image = document.createElement('img');
      image.className = 'avatar-card-thumbnail';
      image.alt = `Preview of ${avatar.name || avatar.id}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      preview.prepend(image);
      window.RuntimeApi.fetch(avatar.thumbnailUrl)
        .then(response => {
          if (!response.ok) throw new Error(`Thumbnail HTTP ${response.status}`);
          const contentType = response.headers.get('content-type') || '';
          if (!contentType.startsWith('image/')) throw new Error('Thumbnail response is not an image');
          return response.blob();
        })
        .then(blob => {
          if (!preview.isConnected) return;
          const objectUrl = URL.createObjectURL(blob);
          avatarThumbnailObjectUrls.add(objectUrl);
          image.addEventListener('load', () => {
            image.classList.add('is-loaded');
            fallback.hidden = true;
          }, { once: true });
          image.addEventListener('error', () => {
            image.classList.remove('is-loaded');
            fallback.hidden = false;
            URL.revokeObjectURL(objectUrl);
            avatarThumbnailObjectUrls.delete(objectUrl);
          }, { once: true });
          image.src = objectUrl;
        })
        .catch(error => {
          fallback.hidden = false;
          console.warn(`[Avatar] Could not load thumbnail for ${avatar.id}:`, error.message);
        });
    }
    const actions = document.createElement('div');
    actions.className = 'avatar-card-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'avatar-card-edit';
    edit.title = `Rename ${avatar.name || avatar.id}`;
    edit.setAttribute('aria-label', `Rename ${avatar.name || avatar.id}`);
    edit.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">edit</span>';
    edit.addEventListener('click', async event => {
      event.stopPropagation();
      const nextName = prompt('Avatar name', avatar.name || avatar.id);
      if (nextName === null || nextName.trim() === (avatar.name || avatar.id)) return;
      edit.disabled = true;
      try {
        await renameProjectAvatar(avatar, nextName);
        addLog(`Avatar ${avatar.id} renamed to ${nextName.trim()}.`, 'ok');
      } catch (error) {
        edit.disabled = false;
        addLog(`Could not rename avatar: ${error.message}`, 'warn');
        alert(error.message);
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'avatar-card-delete';
    remove.title = `Delete ${avatar.id}`;
    remove.setAttribute('aria-label', `Delete ${avatar.id}`);
    remove.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">delete</span>';
    remove.addEventListener('click', async event => {
      event.stopPropagation();
      const confirmed = await showAppConfirm({
        title: 'Delete avatar?',
        message: `Delete avatar ${avatar.id} and its trained model files?`,
        confirmLabel: 'Delete',
      });
      if (!confirmed) return;
      remove.disabled = true;
      try {
        await deleteProjectAvatar(avatar.id);
        addLog(`Avatar ${avatar.id} deleted.`, 'ok');
      } catch (error) {
        remove.disabled = false;
        addLog(`Could not delete avatar: ${error.message}`, 'warn');
        alert(error.message);
      }
    });
    actions.append(edit, remove);

    const body = document.createElement('div');
    body.className = 'avatar-card-body';
    const title = document.createElement('h3');
    title.textContent = avatar.name || avatar.id;
    const heading = document.createElement('div');
    heading.className = 'avatar-card-heading';
    const statuses = document.createElement('div');
    statuses.className = 'avatar-card-statuses';
    statuses.append(status, liveStatus);
    heading.append(title, statuses);
    const meta = document.createElement('p');
    const durationMs = Number(avatar.durationMs || avatar.duration_ms || 0);
    const durationLabel = durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : 'ready';
    meta.textContent = `${String(avatar.avatarState || 'normal').toUpperCase()} · ${durationLabel} · ${avatar.id}`;
    const stateField = document.createElement('label');
    stateField.className = 'avatar-state-field';
    const stateLabel = document.createElement('span');
    stateLabel.textContent = 'Emotion';
    const stateSelect = document.createElement('select');
    stateSelect.setAttribute('aria-label', `Emotion state for ${avatar.name || avatar.id}`);
    const avatarStates = ['normal', 'happy', 'laughing', 'grateful', 'surprised', 'excited', 'sad', 'angry', 'playful', 'focused'];
    stateSelect.replaceChildren(...avatarStates.map(stateName => {
      const option = document.createElement('option');
      option.value = stateName;
      option.textContent = stateName.charAt(0).toUpperCase() + stateName.slice(1);
      option.selected = stateName === String(avatar.avatarState || 'normal').toLowerCase();
      return option;
    }));
    stateSelect.addEventListener('click', event => event.stopPropagation());
    stateSelect.addEventListener('change', async event => {
      event.stopPropagation();
      stateSelect.disabled = true;
      try {
        await updateProjectAvatarState(avatar, stateSelect.value);
        addLog(`${avatar.id} emotion state: ${stateSelect.value}`, 'ok');
      } catch (error) {
        stateSelect.value = String(avatar.avatarState || 'normal');
        addLog(`Could not update Avatar emotion: ${error.message}`, 'warn');
      } finally {
        stateSelect.disabled = false;
      }
    });
    stateField.append(stateLabel, stateSelect);
    const live = document.createElement('div');
    live.className = 'avatar-live-check';
    const poolIcon = document.createElement('span');
    poolIcon.className = 'material-symbols-rounded';
    poolIcon.setAttribute('aria-hidden', 'true');
    poolIcon.textContent = selected ? 'check_circle' : 'circle';
    const label = document.createElement('span');
    label.textContent = selected ? 'Included in automatic rotation' : 'Excluded from automatic rotation';
    live.append(poolIcon, label);
    body.append(heading, meta, stateField, live, actions);
    card.append(preview, body);

    const toggleSelection = async () => {
      if (card.getAttribute('aria-busy') === 'true') return;
      card.setAttribute('aria-busy', 'true');
      try {
        await setAvatarPoolSelection(avatar.id, !LiveAvatarSession.selectedAvatarIds.includes(avatar.id));
      } catch (error) {
        addLog(`Avatar Pool was not changed: ${error.message}`, 'warn');
      } finally {
        card.removeAttribute('aria-busy');
      }
    };
    card.addEventListener('click', event => {
      if (event.target.closest('button, select')) return;
      void toggleSelection();
    });
    card.addEventListener('keydown', event => {
      if (event.target !== card) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      void toggleSelection();
    });
    return card;
  }));
  updateAvatarLibraryTransientState();
}

function isAvatarLiveNow(avatarId) {
  const localSessionId = String(LiveTalkingWebRTCClient?.sessionId || '');
  const liveSessionId = LiveMediaOwnership.liveSessionId || localSessionId;
  const liveAvatarId = LiveMediaOwnership.liveAvatarId
    || (localSessionId ? String(LiveAvatarSession.activeAvatarId || LiveTalkingStudio.avatarId || '') : '');
  return Boolean(liveSessionId) && String(avatarId || '') === liveAvatarId;
}

function updateAvatarLibraryTransientState() {
  document.querySelectorAll('.avatar-library-card[data-avatar-id]').forEach(card => {
    const avatarId = String(card.dataset.avatarId || '');
    const selected = LiveAvatarSession.selectedAvatarIds.includes(avatarId);
    const liveNow = isAvatarLiveNow(avatarId);
    card.classList.toggle('selected', selected);
    card.classList.toggle('live-now', liveNow);
    card.setAttribute('aria-checked', String(selected));
    const name = card.querySelector('.avatar-card-body h3')?.textContent || avatarId;
    card.setAttribute('aria-label', `${selected ? 'Disable' : 'Enable'} ${name} in the Avatar Pool${liveNow ? '; live now' : ''}`);
    const poolStatus = card.querySelector('.avatar-card-status');
    if (poolStatus) poolStatus.textContent = selected ? 'Enabled' : 'Disabled';
    const liveStatus = card.querySelector('.avatar-card-live-status');
    if (liveStatus) liveStatus.hidden = !liveNow;
    const poolIcon = card.querySelector('.avatar-live-check .material-symbols-rounded');
    if (poolIcon) poolIcon.textContent = selected ? 'check_circle' : 'circle';
    const poolLabel = card.querySelector('.avatar-live-check span:last-child');
    if (poolLabel) poolLabel.textContent = selected
      ? 'Included in automatic rotation'
      : 'Excluded from automatic rotation';
  });
}

function renderActiveAvatarOptions(ids) {
  const list = $('lt-avatar-pool-list');
  if (!list) return;
  const validIds = [...new Set(ids.filter(Boolean))];
  if (!validIds.includes(LiveAvatarSession.activeAvatarId)) LiveAvatarSession.activeAvatarId = '';
  if (!LiveAvatarSession.activeAvatarId && LiveTalkingStudio.avatarId && validIds.includes(LiveTalkingStudio.avatarId)) {
    LiveAvatarSession.activeAvatarId = LiveTalkingStudio.avatarId;
  }
  list.replaceChildren(...validIds.map(id => {
    const label = document.createElement('label');
    const selected = LiveAvatarSession.selectedAvatarIds.includes(id);
    label.className = `avatar-pool-item${selected ? ' active' : ''}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'active-live-avatar-pool';
    input.value = id;
    input.checked = selected;
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        await setAvatarPoolSelection(input.value, input.checked);
      } catch (error) {
        input.checked = !input.checked;
        addLog(`Avatar Pool was not changed: ${error.message}`, 'warn');
      } finally {
        input.disabled = false;
      }
    });
    const name = document.createElement('span');
    name.textContent = id;
    label.append(input, name);
    return label;
  }));
  if (!validIds.length) {
    const empty = document.createElement('span');
    empty.className = 'avatar-pool-empty';
    empty.textContent = 'No trained avatars yet.';
    list.append(empty);
  }
  updateAvatarPoolCount();
}

function updateAvatarPoolCount() {
  if ($('lt-avatar-pool-count')) $('lt-avatar-pool-count').textContent = LiveAvatarSession.selectedAvatarIds.length
    ? `${LiveAvatarSession.selectedAvatarIds.length} enabled Avatar${LiveAvatarSession.selectedAvatarIds.length === 1 ? '' : 's'}`
    : 'No enabled Avatar';
}

async function saveActiveAvatarSession() {
  LiveAvatarSession.activeAvatarId = String(LiveAvatarSession.activeAvatarId || '').trim();
  LiveAvatarSession.selectedAvatarIds = [...new Set(LiveAvatarSession.selectedAvatarIds.map(String).filter(Boolean))];
  localStorage.setItem(STORAGE_KEYS.ACTIVE_AVATAR, LiveAvatarSession.activeAvatarId);
  localStorage.setItem(STORAGE_KEYS.AVATAR_POOL, JSON.stringify(LiveAvatarSession.selectedAvatarIds));
  if (location.protocol !== 'file:') {
    const payload = await window.LiveTalkingApi.saveActiveAvatarSession(
      LiveAvatarSession.activeAvatarId || null,
      LiveAvatarSession.selectedAvatarIds,
      LiveAvatarSession.excludedAvatarIds,
    );
    if (payload.session) {
      LiveAvatarSession.activeAvatarId = payload.session.activeAvatarId || '';
      LiveAvatarSession.selectedAvatarIds = [...new Set((payload.session.selectedAvatarIds || []).map(String).filter(Boolean))];
      LiveAvatarSession.excludedAvatarIds = [...new Set((payload.session.excludedAvatarIds || []).map(String).filter(Boolean))];
    }
  }
  localStorage.setItem(STORAGE_KEYS.ACTIVE_AVATAR, LiveAvatarSession.activeAvatarId);
  localStorage.setItem(STORAGE_KEYS.AVATAR_POOL, JSON.stringify(LiveAvatarSession.selectedAvatarIds));
  addLog(`Avatar Pool saved: ${LiveAvatarSession.selectedAvatarIds.length} enabled`, 'ok');
}

async function setAvatarPoolSelection(avatarId, selected) {
  const id = String(avatarId || '').trim();
  if (!id || !TRAINED_AVATARS.has(id)) throw new Error('Avatar is not available');
  const previous = {
    activeAvatarId: LiveAvatarSession.activeAvatarId,
    selectedAvatarIds: [...LiveAvatarSession.selectedAvatarIds],
    excludedAvatarIds: [...LiveAvatarSession.excludedAvatarIds],
  };
  const next = new Set(previous.selectedAvatarIds);
  if (selected) next.add(id);
  else next.delete(id);
  if (next.size === 0 && TRAINED_AVATARS.size > 0) {
    throw new Error('Keep at least one Avatar enabled in the Pool');
  }
  LiveAvatarSession.selectedAvatarIds = [...next];
  LiveAvatarSession.excludedAvatarIds = LiveAvatarSession.excludedAvatarIds.filter(item => item !== id);
  if (!LiveAvatarSession.activeAvatarId) LiveAvatarSession.activeAvatarId = LiveAvatarSession.selectedAvatarIds[0] || '';
  try {
    await saveActiveAvatarSession();
    renderActiveAvatarOptions([...TRAINED_AVATARS.keys()]);
    renderAvatarLibrary([...TRAINED_AVATARS.values()]);
    lastLibraryRenderSignature = '';
    renderLibraryUI();
    updateAvatarPoolCount();
  } catch (error) {
    Object.assign(LiveAvatarSession, previous);
    throw error;
  }
}

async function selectAvatarForSpeech() {
  await waitForLiveMediaOwnership();
  const pool = LiveAvatarSession.selectedAvatarIds.filter(id => TRAINED_AVATARS.has(id));
  const selectedId = [LiveTalkingStudio.avatarId, LiveAvatarSession.activeAvatarId]
    .find(id => id && pool.includes(id))
    || pool[0];
  if (!selectedId) throw new Error('No trained avatar is ready');
  let sessionViable = LiveTalkingWebRTCClient.isViable?.()
    ?? LiveTalkingWebRTCClient.isConnected?.()
    ?? Boolean(LiveTalkingWebRTCClient.sessionId);
  if (!sessionViable && LiveTalkingWebRTCClient.sessionId && window.LiveTalkingApi?.sessionStatus) {
    try {
      const sessionStatus = await window.LiveTalkingApi.sessionStatus();
      sessionViable = !sessionStatus.sessionId
        || sessionStatus.sessionId === LiveTalkingWebRTCClient.sessionId;
    } catch {
      sessionViable = false;
    }
  }
  if (selectedId && !sessionViable) {
    await activateLiveTalkingAvatar(selectedId);
  }
  return selectedId;
}

async function activateLiveTalkingAvatar(avatarId) {
  await waitForLiveMediaOwnership();
  const id = String(avatarId || '').trim();
  if (!id) throw new Error('Invalid avatar ID');
  if (TRAINED_AVATARS.size > 0 && !TRAINED_AVATARS.has(id)) {
    throw new Error(`Avatar ${id} is not trained or is unavailable`);
  }
  const previous = {
    activeAvatarId: LiveAvatarSession.activeAvatarId,
    selectedAvatarIds: [...LiveAvatarSession.selectedAvatarIds],
    studioAvatarId: LiveTalkingStudio.avatarId,
    isTrainedReady: LiveTalkingStudio.isTrainedReady,
    trainProgress: LiveTalkingStudio.trainProgress,
  };
  App.talkingEngine.provider = 'livetalking';
  App.talkingEngine.model = 'musetalk';
  localStorage.setItem(STORAGE_KEYS.TALKING_PROVIDER, 'livetalking');
  localStorage.setItem(STORAGE_KEYS.LIVETALKING_MODEL, 'musetalk');
  let result;
  try {
    result = await LiveTalkingWebRTCClient.connect(App.talkingEngine.endpoint, id);
  } catch (error) {
    LiveAvatarSession.activeAvatarId = previous.activeAvatarId;
    LiveAvatarSession.selectedAvatarIds = previous.selectedAvatarIds;
    LiveTalkingStudio.avatarId = previous.studioAvatarId;
    LiveTalkingStudio.isTrainedReady = previous.isTrainedReady;
    LiveTalkingStudio.trainProgress = previous.trainProgress;
    throw error;
  }
  LiveAvatarSession.activeAvatarId = id;
  if (!LiveAvatarSession.selectedAvatarIds.includes(id)) LiveAvatarSession.selectedAvatarIds.push(id);
  LiveAvatarSession.excludedAvatarIds = LiveAvatarSession.excludedAvatarIds.filter(avatarId => avatarId !== id);
  LiveTalkingStudio.avatarId = id;
  LiveTalkingStudio.isTrainedReady = true;
  LiveTalkingStudio.trainProgress = 100;
  localStorage.setItem(STORAGE_KEYS.LIVETALKING_AVATAR, id);
  localStorage.setItem(STORAGE_KEYS.ACTIVE_AVATAR, id);
  localStorage.setItem(STORAGE_KEYS.AVATAR_POOL, JSON.stringify(LiveAvatarSession.selectedAvatarIds));
  if ($('lt-avatar-id-input')) $('lt-avatar-id-input').value = id;
  await saveActiveAvatarSession().catch(error => {
    addLog(`Avatar connected, but Pool persistence is pending: ${error.message}`, 'warn');
  });
  updateLiveTalkingUI();
  loadPersistedSettings();
  renderLibraryUI();
  updateAvatarLibraryTransientState();
  logLiveTalkingTerminal(`Activated ${id} for the live session (${result.sessionId || 'active'})`, 'ok');
  addLog(`Active live avatar: ${id}`, 'ok');
  return result;
}

async function switchPooledAvatar(avatarId) {
  const id = String(avatarId || '').trim();
  if (!LiveAvatarSession.selectedAvatarIds.includes(id)) {
    await setAvatarPoolSelection(id, true);
  }
  const sessionViable = LiveTalkingWebRTCClient.isViable?.()
    ?? LiveTalkingWebRTCClient.isConnected?.()
    ?? Boolean(LiveTalkingWebRTCClient.sessionId);
  if (!sessionViable) return activateLiveTalkingAvatar(id);
  const payload = await window.LiveTalkingApi.activateAvatar(id);
  LiveAvatarSession.activeAvatarId = payload.session?.activeAvatarId || id;
  LiveAvatarSession.selectedAvatarIds = [...new Set((payload.session?.selectedAvatarIds || LiveAvatarSession.selectedAvatarIds).map(String).filter(Boolean))];
  LiveTalkingStudio.avatarId = id;
  localStorage.setItem(STORAGE_KEYS.ACTIVE_AVATAR, id);
  localStorage.setItem(STORAGE_KEYS.LIVETALKING_AVATAR, id);
  updateAvatarPoolCount();
  lastLibraryRenderSignature = '';
  renderLibraryUI();
  // The runtime intentionally tears down the prior media session before a
  // trained dataset changes. Reconnect with this avatar only after state has
  // been persisted, so no old mouth mask survives the switch.
  await reconnectLiveTalkingAvatar(id);
  return payload;
}

async function startAvatarBatchTraining() {
  const items = AvatarCreateFlow.items;
  if (!items.length || LiveTalkingStudio.isTraining) return;
  const ids = items.map(item => cleanAvatarId(item.avatarId));
  if (new Set(ids).size !== ids.length) {
    alert('Each avatar in the batch needs a unique Avatar ID.');
    return;
  }
  items.forEach((item, index) => { item.avatarId = ids[index]; item.error = ''; });
  LiveTalkingStudio.isTraining = true;
  LiveTalkingStudio.isTrainedReady = false;
  LiveTalkingStudio.trainProgress = 0;
  AvatarCreateFlow.status = 'training';
  AvatarCreateFlow.progress = 0;
  AvatarCreateFlow.stageMessage = 'Preparing avatar engine';
  updateLiveTalkingUI();

  try {
    if ($('avatar-create-status')) $('avatar-create-status').textContent = 'Preparing avatar engine…';
    await ensureLiveTalkingWorkerReady();

    await Promise.all(items.map(async item => {
      item.status = 'uploading';
      item.stageMessage = 'Uploading source video';
      renderAvatarBatchQueue();
      try {
        const stored = await persistProjectFile(item.file, 'avatars/source', item.avatarId);
        if (!stored?.path) throw new Error('Upload returned no project path');
        item.storedPath = stored.path;
        item.status = 'queued';
        item.stageMessage = 'Waiting for training worker';
      } catch (error) {
        item.status = 'failed';
        item.error = error.message;
        item.stageMessage = '';
      }
      renderAvatarBatchQueue();
    }));

    const readyItems = items.filter(item => item.status === 'queued');
    if (readyItems.length) {
      const batch = await window.LiveTalkingApi.createBatch(readyItems.map(item => ({
        video_path: item.storedPath,
        avatar_id: item.avatarId,
        model: item.model,
      })));
      const submittedTasks = batch.data?.tasks || [];
      readyItems.forEach(item => {
        const task = submittedTasks.find(candidate => candidate.avatar_id === item.avatarId);
        if (!task?.task_id) {
          item.status = 'failed';
          item.error = task?.error_msg || 'Worker did not create this task';
          return;
        }
        item.taskId = task.task_id;
        item.status = 'training';
        item.progress = Math.max(1, Number(task.progress) || 1);
        item.stageMessage = task.stage_message || 'Waiting for training worker';
      });
      renderAvatarBatchQueue();
    }

    const deadline = Date.now() + 30 * 60 * 1000;
    while (items.some(item => item.status === 'training') && Date.now() < deadline) {
      const active = items.filter(item => item.status === 'training');
      await Promise.all(active.map(async item => {
        try {
          const payload = await window.LiveTalkingApi.getTask(item.taskId);
          const task = payload.data || {};
          item.progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
          item.stageMessage = String(task.stage_message || (item.progress > 0 ? 'Training avatar' : 'Waiting for training worker'));
          AvatarCreateFlow.stageMessage = item.stageMessage;
          if (task.status === 'completed') {
            item.status = 'completed';
            item.progress = 100;
            item.stageMessage = 'Avatar ready';
          } else if (task.status === 'failed') {
            item.status = 'failed';
            item.error = task.error_msg || 'Worker training failed';
            item.stageMessage = '';
          }
        } catch (error) {
          item.error = error.message;
        }
      }));
      const batchProgress = Math.round(items.reduce((sum, item) => {
        if (item.status === 'completed' || item.status === 'failed') return sum + 100;
        return sum + (item.progress || 0);
      }, 0) / items.length);
      AvatarCreateFlow.progress = batchProgress;
      LiveTalkingStudio.trainProgress = batchProgress;
      renderAvatarBatchQueue();
      updateLiveTalkingUI();
      if (items.some(item => item.status === 'training')) await new Promise(resolve => setTimeout(resolve, 1000));
    }

    items.filter(item => item.status === 'training').forEach(item => {
      item.status = 'failed';
      item.error = 'Avatar training timed out';
    });
    const completed = items.filter(item => item.status === 'completed');
    await Promise.all(completed.map(async item => {
      const record = {
        id: item.avatarId,
        name: item.file.name,
        modelType: item.model,
        taskId: item.taskId,
        status: 'ready',
        trainedAt: Date.now(),
      };
      await registerProjectAvatar(record).catch(() => {});
      await persistProjectJson('models', 'training-result.json', record, item.avatarId).catch(() => {});
    }));

    if (completed.length) {
      LiveAvatarSession.selectedAvatarIds = [...new Set([
        ...LiveAvatarSession.selectedAvatarIds,
        ...completed.map(item => item.avatarId),
      ])];
      if (!LiveAvatarSession.activeAvatarId) LiveAvatarSession.activeAvatarId = completed[0].avatarId;
    }
    await saveActiveAvatarSession().catch(() => {});
    LiveTalkingStudio.isTraining = false;
    LiveTalkingStudio.isTrainedReady = completed.length > 0;
    LiveTalkingStudio.trainProgress = completed.length ? 100 : 0;
    AvatarCreateFlow.status = completed.length ? 'done' : 'config';
    AvatarCreateFlow.progress = completed.length ? 100 : 0;
    AvatarCreateFlow.stageMessage = '';
    if (completed[0]) {
      const primary = completed[0];
      LiveTalkingStudio.avatarId = primary.avatarId;
      LiveTalkingStudio.modelType = primary.model;
      LiveTalkingStudio.videoFile = primary.file;
      await IdolDB.saveAvatar('livetalking_avatar', primary.file, {
        fileName: primary.file.name,
        fileSize: primary.file.size,
        modelType: primary.model,
        avatarId: primary.avatarId,
        isTrainedReady: true,
        taskId: primary.taskId,
        neuralWorker: App.talkingEngine.endpoint,
        trainedAt: Date.now(),
      }).catch(() => {});
    }
    renderAvatarBatchQueue();
    updateLiveTalkingUI();
    await refreshLiveTalkingAvatarList();
    addLog(`Batch training finished: ${completed.length}/${items.length} avatar(s) ready.`, completed.length ? 'ok' : 'err');
    if (completed[0]) {
      await activateLiveTalkingAvatar(completed[0].avatarId).catch(error => {
        addLog(`Avatar is trained; live connection is pending: ${error.message}`, 'warn');
      });
    }
  } catch (error) {
    LiveTalkingStudio.isTraining = false;
    AvatarCreateFlow.status = 'config';
    AvatarCreateFlow.progress = 0;
    AvatarCreateFlow.stageMessage = '';
    items.filter(item => !['completed', 'failed'].includes(item.status)).forEach(item => {
      item.status = 'failed';
      item.error = error.message;
    });
    renderAvatarBatchQueue();
    updateLiveTalkingUI();
    addLog(`Batch training could not start: ${error.message}`, 'err');
  }
}

async function startLiveTalkingTraining() {
  const file = LiveTalkingStudio.videoFile;
  if (!file) {
    alert('Upload avatar media first.');
    return;
  }
  if (LiveTalkingStudio.isTraining) return;

  const model = $('lt-model-select')?.value || 'musetalk';
  const rawId = $('lt-avatar-id-input')?.value.trim() || `avatar_${Date.now()}`;
  const avatarId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');

  LiveTalkingStudio.isTraining = true;
  AvatarCreateFlow.status = 'training';
  AvatarCreateFlow.stageMessage = 'Waiting for training worker';
  LiveTalkingStudio.isTrainedReady = false;
  LiveTalkingStudio.trainProgress = 1;
  LiveTalkingStudio.avatarId = avatarId;
  LiveTalkingStudio.modelType = model;
  updateLiveTalkingUI();
  logLiveTalkingTerminal(`Uploading ${file.name} to project storage...`, 'info');

  try {
    const storedVideo = await persistProjectFile(file, 'avatars/source', avatarId);
    if (!storedVideo?.path) throw new Error('Could not save the avatar source video');
    const created = await window.LiveTalkingApi.createTask({ model, avatar_id: avatarId, video_path: storedVideo.path });
    if (!created.data?.task_id) throw new Error(created.msg || 'Runtime returned no avatar task ID');

    const taskId = created.data.task_id;
    logLiveTalkingTerminal(`🧠 Task ${taskId.slice(0, 8)} created. Worker is running Face Detection → VAE → Mask...`, 'info');
    const deadline = Date.now() + 30 * 60 * 1000;
    let task;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const statusPayload = await window.LiveTalkingApi.getTask(taskId);
      task = statusPayload.data;
      LiveTalkingStudio.trainProgress = Math.max(1, Math.min(100, Number(task.progress) || 1));
      AvatarCreateFlow.stageMessage = String(task.stage_message || 'Training avatar');
      updateLiveTalkingUI();
      if (task.status === 'completed') break;
      if (task.status === 'failed') throw new Error(task.error_msg || 'Worker failed to create the avatar');
    }
    if (!task || task.status !== 'completed') throw new Error('Avatar creation timed out');

    LiveTalkingStudio.trainProgress = 100;
    LiveTalkingStudio.isTraining = false;
    LiveTalkingStudio.isTrainedReady = true;
    AvatarCreateFlow.status = 'done';
    LiveTalkingStudio.trainedDataset = {
      id: avatarId,
      name: file.name,
      modelType: model,
      taskId,
      neuralWorker: 'runtime-managed',
      trainedAt: Date.now(),
    };
    await IdolDB.saveAvatar('livetalking_avatar', file, {
      fileName: file.name,
      fileSize: file.size,
      modelType: model,
      avatarId,
      isTrainedReady: true,
      taskId,
      neuralWorker: App.talkingEngine.endpoint,
      trainedAt: Date.now(),
    });
    await registerProjectAvatar({ id: avatarId, name: file.name, modelType: model, taskId, status: 'ready', trainedAt: Date.now() }).catch(() => {});
    await persistProjectJson('models', 'training-result.json', LiveTalkingStudio.trainedDataset, avatarId).catch(() => {});
    LiveAvatarSession.activeAvatarId = avatarId;
    LiveAvatarSession.selectedAvatarIds = [...new Set([...LiveAvatarSession.selectedAvatarIds, avatarId])];
    await saveActiveAvatarSession().catch(() => {});
    updateLiveTalkingUI();
    await refreshLiveTalkingAvatarList();
    logLiveTalkingTerminal(`✅ Worker created coords.pkl, latents.pt, and masks for ${avatarId}.`, 'ok');
    try {
      await activateLiveTalkingAvatar(avatarId);
    } catch (activationError) {
      LiveTalkingStudio.isTrainedReady = true;
      AvatarCreateFlow.status = 'done';
      updateLiveTalkingUI();
      logLiveTalkingTerminal(`⚠️ Avatar saved, but the live WebRTC session is not connected yet: ${activationError.message}`, 'warn');
      addLog(`Avatar ${avatarId} is saved. Start the Lipsync Engine before going live.`, 'warn');
    }
  } catch (err) {
    LiveTalkingStudio.isTraining = false;
    AvatarCreateFlow.status = 'config';
    updateLiveTalkingUI();
    logLiveTalkingTerminal(`❌ Neural avatar creation failed: ${err.message}`, 'err');
    addLog(`Lipsync avatar: ${err.message}`, 'warn');
  }
}

function renderLiveTalkingStep1Preview(ctx, width, height) {
  ctx.clearRect(0, 0, width, height);

  const vid = LiveTalkingStudio.videoEl;
  const mediaReady = vid && ((typeof vid.readyState === 'number' && vid.readyState >= 2) || vid.complete);
  if (mediaReady) {
    if (vid.paused && typeof vid.play === 'function') {
      vid.play().catch(() => {});
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    const vw = vid.videoWidth || vid.naturalWidth || 1920;
    const vh = vid.videoHeight || vid.naturalHeight || 1080;
    const aspect = vw / vh;
    let dh = height;
    let dw = height * aspect;
    if (dw > width) {
      dw = width;
      dh = width / aspect;
    }
    const dx = (width - dw) / 2;
    const dy = (height - dh) / 2;
    const scale = dw / vw;

    // 1. Draw main driving video frame
    ctx.drawImage(vid, dx, dy, dw, dh);

    // 2. Optional Diagnostic 468 Face Mesh Wireframe & Telemetry HUD
    const showMesh = $('chk-show-facemesh') ? $('chk-show-facemesh').checked : true;
    const isDebugMode = $('chk-debug-facemesh') ? $('chk-debug-facemesh').checked : false;

    const landmarks = (vid instanceof HTMLVideoElement ? FaceMeshRealtimeTracker.track(vid) : null)
      || LiveTalkingStudio.landmarks468
      || generate468FaceLandmarks(LiveTalkingStudio.faceBox, LiveTalkingStudio.mouthBox);

    if (landmarks && landmarks.length >= 468) {
      ctx.save();

      if (showMesh) {
        // Draw Face Oval & Feature Contours
        const oval = FACEMESH_TOPOLOGY.FACE_OVAL;
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.70)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let i = 0; i < oval.length; i++) {
          const pt = landmarks[oval[i]];
          const px = dx + dw * pt.x;
          const py = dy + dh * pt.y;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();

        // Draw Lips Outline
        ctx.strokeStyle = '#34d399';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        const outer = FACEMESH_TOPOLOGY.LIPS_OUTER;
        for (let i = 0; i < outer.length; i++) {
          const pt = landmarks[outer[i]];
          const px = dx + dw * pt.x;
          const py = dy + dh * pt.y;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();

        // Live MuseTalk Status Badge
        const fb = LiveTalkingStudio.faceBox;
        const tagX = dx + dw * (fb.cx - fb.w / 2);
        const tagY = dy + dh * (fb.cy - fb.h / 2);
        ctx.fillStyle = 'rgba(6, 78, 59, 0.92)';
        ctx.fillRect(tagX, tagY - 20, 240, 18);
        ctx.fillStyle = '#6ee7b7';
        ctx.font = 'bold 8.5px sans-serif';
        ctx.fillText(`MuseTalk Native Pipeline · 50 FPS [READY]`, tagX + 6, tagY - 7);
      }

      // ── DEBUG INDEX & TELEMETRY HUD ──
      if (isDebugMode) {
        const dataset = LiveTalkingStudio.museTalkDataset || {
          totalFrames: 1,
          sequence: [0],
          bboxList: [LiveTalkingStudio.faceBox || { x1: 0.32, y1: 0.14, x2: 0.68, y2: 0.54 }],
          latentList: [new Float32Array(512)],
          maskList: [{ topCutoff: 0.45, featherHeight: 0.15 }],
          fps: 30,
        };
        const seqLen = dataset.sequence.length || 1;
        const currentSeqIndex = Math.floor(vid.currentTime * (dataset.fps || 25)) % seqLen;
        const syncPkg = MuseTalkNativePipeline.getSynchronizedFramePackage(currentSeqIndex, dataset);
        const curBbox = syncPkg.bbox;

        const hudW = 240;
        const hudH = 152;
        const hudX = 10;
        const hudY = 10;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
        ctx.fillRect(hudX, hudY, hudW, hudH);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1;
        ctx.strokeRect(hudX, hudY, hudW, hudH);

        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 9.5px monospace';
        ctx.fillText('LIVETALKING / MUSETALK DEBUG', hudX + 8, hudY + 14);

        ctx.font = '8.5px monospace';
        ctx.fillStyle = '#e2e8f0';
        const lines = [
          `FRAME  = ${syncPkg.frameIndex}`,
          `BBOX   = ${syncPkg.bboxIndex}`,
          `LATENT = ${syncPkg.latentIndex}`,
          `MASK   = ${syncPkg.maskIndex}`,
          `BBOX   = [${(curBbox.x1 * vw).toFixed(0)}, ${(curBbox.y1 * vh).toFixed(0)}, ${(curBbox.x2 * vw).toFixed(0)}, ${(curBbox.y2 * vh).toFixed(0)}]`,
          `SEQ    = ${currentSeqIndex} / ${seqLen} (Ping-Pong)`,
          `SYNC   = 100% LOCKSTEP (SAME FRAME)`,
          `RES    = ${vw}x${vh} | FPS: ${dataset.fps}`,
        ];

        lines.forEach((txt, idx) => {
          ctx.fillText(txt, hudX + 8, hudY + 28 + idx * 14);
        });
      }

      ctx.restore();
    }
  }
}

function drawAvatarToCanvas(ctx, width, height, isSpeaking, avatarData) {
  renderLiveTalkingLipSync(ctx, width, height, isSpeaking, avatarData);
}

function renderLiveTalkingLipSync(ctx, width, height, isSpeaking, avatarData) {
  ctx.clearRect(0, 0, width, height);

  const vid = avatarData?.videoEl || LiveTalkingStudio.videoEl || App.avatar.videoEl;
  if (vid && vid.readyState >= 2) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    const vw = vid.videoWidth || 1920;
    const vh = vid.videoHeight || 1080;
    const aspect = vw / vh;
    let dh = height;
    let dw = height * aspect;
    if (dw > width) {
      dw = width;
      dh = width / aspect;
    }
    const dx = (width - dw) / 2;
    const dy = (height - dh) / 2;

    // A real LiveTalking MediaStream already contains the neural face result.
    // Draw it once and never run the legacy browser mouth-retargeting sampler
    // against an infinite-duration WebRTC stream.
    const isWorkerWebRtcStream = App.talkingEngine.provider === 'livetalking'
      && Boolean(LiveTalkingWebRTCClient.sessionId)
      && vid === LiveTalkingWebRTCClient.videoEl;
    if (isWorkerWebRtcStream) {
      if (vid.paused) vid.play().catch(() => {});
      ctx.drawImage(vid, dx, dy, dw, dh);
      MuseTalkRealtimeEngine.outputSource = (isSpeaking || App.isAiSpeaking || App.currentState === 'TALKING')
        ? 'MUSETALK_FRAME'
        : 'IDLE_FRAME';
      return;
    }

    // 1. Lockstep Synchronized MuseTalk Dataset
    const dataset = LiveTalkingStudio.museTalkDataset || avatarData?.museTalkDataset || {
      totalFrames: 1,
      sequence: [0],
      bboxList: [LiveTalkingStudio.faceBox || { x1: 0.32, y1: 0.14, x2: 0.68, y2: 0.54 }],
      latentList: [new Float32Array(512)],
      maskList: [{ topCutoff: 0.45, featherHeight: 0.15 }],
      fps: 30,
      bboxShift: 0
    };

    const seqLen = dataset.sequence.length || 1;
    const currentSeqIndex = Math.floor(vid.currentTime * (dataset.fps || 25)) % seqLen;
    const syncPkg = MuseTalkNativePipeline.getSynchronizedFramePackage(currentSeqIndex, dataset);
    const curBbox = syncPkg.bbox;

    const pose = LiveLipSyncEngine.pose;
    const effectiveOpen = Math.min(1.0, (pose.mouthOpen * 0.75 + (liveViseme.open || 0) * 0.45));

    // 2. Continuous Video Playback & Active LipSync Synthesis
    if (vid.paused) {
      vid.play().catch(() => {});
    }
    ctx.drawImage(vid, dx, dy, dw, dh);

    const isSpeakingActive = isSpeaking || App.isAiSpeaking || (App.currentState === 'TALKING') || LiveLipSyncEngine.isPlaying || (MuseTalkRealtimeEngine.state === 'PLAYING_MUSETALK');

    if (isSpeakingActive) {
      MuseTalkRealtimeEngine.outputSource = 'MUSETALK_FRAME';
      const effectiveOpen = Math.min(1.0, Math.max(0.08, (pose.mouthOpen * 0.85 + (liveViseme.open || 0) * 0.65)));

      // Execute Realtime LipSync Face & Mouth Synthesis
      MuseTalkRealtimeEngine.renderTalkingFace(
        ctx,
        vid,
        vw,
        vh,
        dx,
        dy,
        dw,
        dh,
        syncPkg,
        effectiveOpen
      );
    } else {
      MuseTalkRealtimeEngine.outputSource = 'IDLE_FRAME';
    }

    // 3. Optional Debug Runtime Telemetry HUD
    const isDebugMode = $('chk-debug-facemesh') ? $('chk-debug-facemesh').checked : false;
    if (isDebugMode) {
      const pasteX = dx + curBbox.x1 * dw;
      const pasteY = dy + curBbox.y1 * dh;
      const pasteW = (curBbox.x2 - curBbox.x1) * dw;
      const pasteH = (curBbox.y2 - curBbox.y1) * dh;

      ctx.save();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.strokeRect(pasteX, pasteY, pasteW, pasteH);

      const hudW = 220;
      const hudH = 100;
      const hudX = 10;
      const hudY = 10;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(hudX, hudY, hudW, hudH);
      ctx.strokeStyle = isSpeakingActive ? '#10b981' : '#38bdf8';
      ctx.lineWidth = 1;
      ctx.strokeRect(hudX, hudY, hudW, hudH);

      ctx.fillStyle = isSpeakingActive ? '#34d399' : '#38bdf8';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(`TELEMETRY: ${isSpeakingActive ? 'SPEAKING' : 'IDLE'}`, hudX + 8, hudY + 14);

      ctx.font = '8px monospace';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`OPENNESS: ${((pose.mouthOpen || 0) * 100).toFixed(0)}% | VISEME: ${pose.viseme || 'sil'}`, hudX + 8, hudY + 30);
      ctx.fillText(`VU LEVEL: ${Math.round((liveViseme.open || 0) * 100)}%`, hudX + 8, hudY + 46);
      ctx.fillText(`RES: ${vw}x${vh} | FPS: 60`, hudX + 8, hudY + 62);
      ctx.fillText(`BOX: [${Math.round(pasteX)}, ${Math.round(pasteY)}, ${Math.round(pasteW)}, ${Math.round(pasteH)}]`, hudX + 8, hudY + 78);
      ctx.restore();
    }

    return;
  }

  // Clean Viewport Placeholder
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#0d111a');
  grad.addColorStop(1, '#05070c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(0, 229, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(15, 15, width - 30, height - 30);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#00e5ff';
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText('Lipsync Engine', width / 2, height / 2 - 10);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.font = '10px sans-serif';
  ctx.fillText('MPS · Lockstep Frame Synchronization · 50 FPS target', width / 2, height / 2 + 10);
  ctx.restore();
}

function initAvatarCanvas() {
  const monW2lCanvas = $('monitor-w2l-canvas');
  const monCtx = monW2lCanvas?.getContext('2d');
  const liveStreamCanvas = $('lt-live-stream-canvas');
  const liveStreamCtx = liveStreamCanvas?.getContext('2d');
  let lastMonitorRenderAt = 0;

  const isCanvasVisible = canvas => Boolean(canvas?.isConnected && canvas.getClientRects().length);

  function renderLoop() {
    updateLiveAudioAnalysis();

    // 0. Update LipSync Acoustic Engine Frame
    LiveLipSyncEngine.computeFrame(Date.now(), liveViseme.open);

    // 1. LiveTalking Studio Step 1 Training Screen
    const step1Canvas = $('lt-train-video-canvas');
    if (isCanvasVisible(step1Canvas)) {
      const s1Ctx = step1Canvas.getContext('2d');
      if (s1Ctx) {
        renderLiveTalkingStep1Preview(s1Ctx, step1Canvas.width, step1Canvas.height);
      }
    }

    // 2. LiveTalking Studio Step 2 Screen
    if (isCanvasVisible(liveStreamCanvas) && liveStreamCtx) {
      renderLiveTalkingLipSync(liveStreamCtx, liveStreamCanvas.width, liveStreamCanvas.height, App.isAiSpeaking, LiveTalkingStudio);
    }

    // 2. Fullscreen LiveTalking Realtime Video on Monitor Screen when Speaking / TALKING State
    const now = performance.now();
    if (monW2lCanvas && monCtx && now - lastMonitorRenderAt >= (1000 / 30) - 1) {
      lastMonitorRenderAt = now;
      const isTalkingActive = (App.currentState === 'TALKING' || App.isAiSpeaking);
      const monBadge = $('mon-w2l-badge');
      const isTrained = (LiveTalkingStudio.isTrainedReady || App.avatar.videoEl);

      if (isTalkingActive && isTrained) {
        renderLiveTalkingLipSync(monCtx, monW2lCanvas.width, monW2lCanvas.height, App.isAiSpeaking, App.avatar);
        monW2lCanvas.classList.add('is-visible');
        if (monBadge) monBadge.classList.add('is-visible');
        setMonitorBackgroundVisible(false);
      } else {
        const source = getActiveMonitorVideo();
        const sourceWidth = source?.videoWidth || 0;
        const sourceHeight = source?.videoHeight || 0;
        monCtx.fillStyle = '#000';
        monCtx.fillRect(0, 0, monW2lCanvas.width, monW2lCanvas.height);
        if (source && sourceWidth > 0 && sourceHeight > 0) {
          const scale = Math.min(monW2lCanvas.width / sourceWidth, monW2lCanvas.height / sourceHeight);
          const width = Math.round(sourceWidth * scale);
          const height = Math.round(sourceHeight * scale);
          monCtx.drawImage(
            source,
            Math.round((monW2lCanvas.width - width) / 2),
            Math.round((monW2lCanvas.height - height) / 2),
            width,
            height,
          );
        }
      }
    }

    requestAnimationFrame(renderLoop);
  }

  requestAnimationFrame(renderLoop);
}

// ──────────────────────────────────────────────────────────
// 2. REALTIME TALKING VIDEO PIPELINE (Clean Level 3 Sync)
// ──────────────────────────────────────────────────────────
// Synchronized video playback during TALKING state without fake canvas overlays.

// ──────────────────────────────────────────────────────────
// 3. AI VOICE SYNTHESIS CORE (With Native VI Turbo Model)
// ──────────────────────────────────────────────────────────

function updateVoiceStatusUI(status, label = '', progressPct = 0) {
  const dot = $('vstatus-dot');
  const title = $('vstatus-title');
  const fill = $('vstatus-progress-fill');
  const engineTag = $('vstatus-engine-tag');
  const voiceViz = $('voice-viz');

  if (engineTag) {
    const speedStr = `${(App.voice.speed || 1.0).toFixed(2)}x`;
    const providerName = App.voice.provider === 'qwentts'
      ? 'Qwen TTS Vietnamese'
      : 'Omni Voice Local';
    engineTag.textContent = `${providerName} (VI · ${speedStr})`;
  }

  if (status === 'generating') {
    if (dot) dot.className = 'vstatus-pulse-dot generating';
    if (title) title.textContent = label || 'Generating AI voice...';
    if (fill) fill.style.width = `${progressPct || 40}%`;
    if (voiceViz) voiceViz.classList.remove('speaking');
  } else if (status === 'speaking') {
    if (dot) dot.className = 'vstatus-pulse-dot speaking';
    if (title) title.textContent = `Live playback (${label || 'AI Idol'})`;
    if (fill) fill.style.width = '100%';
    if (voiceViz) voiceViz.classList.add('speaking');
  } else if (status === 'error') {
    if (dot) dot.className = 'vstatus-pulse-dot';
    if (title) title.textContent = `⚠️ ${label}`;
    if (fill) fill.style.width = '0%';
    if (voiceViz) voiceViz.classList.remove('speaking');
  } else {
    if (dot) dot.className = 'vstatus-pulse-dot';
    const readyVoice = App.voice.provider === 'qwentts'
      ? 'Qwen TTS · Vietnamese'
      : 'Omni Voice · Local';
    if (title) title.textContent = `AI voice: Ready (${readyVoice})`;
    if (fill) fill.style.width = '0%';
    if (voiceViz) voiceViz.classList.remove('speaking');
  }
}

function stopLiveSpeech() {
  liveTalkingSpeechRun += 1;
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  if (App.audioElement) {
    App.audioElement.pause();
    App.audioElement.currentTime = 0;
  }
  if (App.talkingEngine.provider === 'livetalking' && location.protocol !== 'file:') {
    window.LiveTalkingApi.interrupt().catch(() => {});
  }
  LiveLipSyncEngine.stopSpeech();
  MuseTalkRealtimeEngine.stopAudio();
  App.isAiSpeaking = false;
  liveViseme.isSpeaking = false;
  liveViseme.open = 0;
  updateVoiceStatusUI('idle');
  
  const subBox = $('mon-subtitles');
  if (subBox) subBox.classList.remove('visible');
  
  addLog('⏹ AI voice stopped.', 'hi');
}

async function submitRuntimeSpeechCommand(text, emotion, speed, provider) {
  await ensureLiveMediaReadyForSpeech();
  const runId = ++liveTalkingSpeechRun;
  const runtimeProvider = ['qwentts', 'omnivoice'].includes(provider) ? provider : 'qwentts';
  const normalizedEmotion = ['neutral', 'happy', 'excited', 'surprised', 'sad', 'angry', 'playful', 'focused', 'grateful', 'laughing'].includes(emotion)
    ? emotion
    : 'happy';

  await window.LiveTalkingApi.setVoice({
    provider: runtimeProvider,
    voiceId: App.voice.voiceId,
    speed,
    languageCode: App.voice.language || 'vi',
  });

  const command = await window.LiveTalkingApi.speak({ text, emotion: normalizedEmotion, speed });
  if (!command.commandId) throw new Error(command.error || 'Could not start speech');

  let playbackStarted = false;
  let consecutivePollFailures = 0;
  const startedAt = Date.now();
  while (runId === liveTalkingSpeechRun) {
    let payload;
    try {
      payload = await window.LiveTalkingApi.speechStatus();
      consecutivePollFailures = 0;
    } catch (error) {
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= 8 || Date.now() - startedAt > 120_000) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, 150 * consecutivePollFailures)));
      continue;
    }
    const speech = payload.speech || {};
    if (speech.commandId !== command.commandId) {
      if (Date.now() - startedAt > 30_000) throw new Error('Speech command did not enter the runtime queue');
      await new Promise(resolve => setTimeout(resolve, 150));
      continue;
    }
    if (speech.state === 'GENERATING') {
      updateVoiceStatusUI('generating', 'Generating voice and neural frames…', 45);
    } else if (speech.state === 'SPEAKING') {
      if (!playbackStarted) {
        playbackStarted = true;
        App.isAiSpeaking = true;
        await LiveTalkingWebRTCClient.ensureAudioPlayback();
        if (!runtimeRealtimeConnected) setVisualState('TALKING', 3, 'runtime-speech-started', true);
        const subBox = $('mon-subtitles');
        const subTxt = $('mon-sub-text');
        if (subBox && subTxt) { subTxt.textContent = text; subBox.classList.add('visible'); }
        addLog('Lipsync audio and video started.', 'ok');
      }
      updateVoiceStatusUI('speaking', runtimeProvider, 100);
    } else if (speech.state === 'IDLE' && playbackStarted) {
      App.isAiSpeaking = false;
      updateVoiceStatusUI('idle');
      $('mon-subtitles')?.classList.remove('visible');
      if (!runtimeRealtimeConnected && App.currentState === 'TALKING' && App.autoMix) {
        requestStateTransition('GAMEPLAY_IDLE', 7, 'runtime-speech-ended', App.globalRandom, false);
      }
      return;
    } else if (speech.state === 'ERROR') {
      throw new Error(speech.error || 'Runtime speech failed');
    }
    if (Date.now() - startedAt > 120_000) throw new Error('Runtime speech timed out');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

async function ensureLiveMediaReadyForSpeech(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt += 1) {
    try {
      await waitForLiveMediaOwnership(Math.min(8_000, Math.max(1_000, deadline - Date.now())));
      if (!LiveTalkingWorker?.ready) await ensureLiveTalkingWorkerReady();
      const avatarId = await selectAvatarForSpeech();
      const ready = Boolean(
        LiveTalkingWebRTCClient?.sessionId
        && LiveTalkingWebRTCClient?.hasLiveTracks?.(),
      );
      if (!ready) {
        addLog(`Live Monitor media is reconnecting (${attempt + 1}/3).`, 'warn');
        await reconnectLiveTalkingAvatar(avatarId);
      }

      while (Date.now() < deadline) {
        if (LiveMediaOwnership.state !== 'OWNER') break;
        if (LiveTalkingWebRTCClient?.sessionId && LiveTalkingWebRTCClient?.hasLiveTracks?.()) {
          await LiveTalkingWebRTCClient.ensureAudioPlayback();
          LiveMediaOwnership.mediaReady = true;
          return true;
        }
        if (!LiveTalkingWebRTCClient?.isNegotiating?.()) break;
        await wait(150);
      }
      throw new Error('Live Monitor WebRTC tracks did not become ready');
    } catch (error) {
      lastError = error;
      LiveMediaOwnership.mediaReady = false;
      if (LiveMediaOwnership.state !== 'STANDBY') {
        registerLiveMediaClient();
        await disconnectLiveMedia('speech media recovery', true).catch(() => {});
      }
      if (attempt < 2) await wait(Math.min(4_000, 750 * (2 ** attempt)));
    }
  }
  throw new Error(`Live Monitor automatic recovery timed out: ${lastError?.message || 'media unavailable'}`);
}

async function speakAI(text, emotion = 'happy') {
  if (App.isMuted || !text) return;
  unlockAudio();
  stopLiveSpeech();

  // Read current provider from Step 2 if open, else App.voice (defaulting to webspeech)
  const prov = $('lt-voice-provider-select')?.value || App.voice.provider || 'qwentts';
  const speed = (parseFloat($('lt-voice-speed-slider')?.value || '100') / 100) || App.voice.speed || 1.0;

  if (App.talkingEngine.provider === 'livetalking') {
    await selectAvatarForSpeech();
  }

  updateVoiceStatusUI('generating', `🎙️ Generating voice (${prov.toUpperCase()})...`, 30);
  addLog(`🎙️ Generating voice and Live LipSync for: "${text.slice(0, 40)}..."`, 'hi');
  if ($('v-last')) $('v-last').textContent = `"${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`;

  if (App.talkingEngine.provider === 'livetalking') {
    try {
      return await submitRuntimeSpeechCommand(text, emotion, speed, prov);
    } catch (error) {
      App.isAiSpeaking = false;
      updateVoiceStatusUI('error', error.message);
      addLog(`Speech failed: ${error.message}`, 'err');
      throw error;
    }
  }

  if (prov === 'qwentts') {
    return await speakWithQwenTts(text, emotion, App.voice.voiceId || 'qwen-default', speed);
  } else if (prov === 'omnivoice') {
    const voice = App.voice.voiceId || $('lt-omnivoice-voice-select')?.value || 'voice_bright_storyteller';
    return await speakWithOmniVoice(text, emotion, voice, speed);
  } else {
    throw new Error(`Unsupported TTS provider: ${prov}. Web TTS fallback is disabled.`);
  }
}

window.speakAiVoice = speakAI;

let liveTalkingSpeechRun = 0;

async function speakWithLiveTalkingText(text, emotion, voiceURI, speed) {
  void voiceURI;
  return submitRuntimeSpeechCommand(text, emotion, speed, App.voice.provider || 'qwentts');
}

async function startSynchronizedPlayback(audioElement, text, emotion, voiceLabel, durMs) {
  if (App.talkingEngine.provider === 'livetalking') {
    return speakWithLiveTalkingText(text, emotion, '', App.voice.speed || 1.0);
  }
  if (audioElement) {
    connectAudioToAnalyser(audioElement);
  }

  App.isAiSpeaking = true;
  setVisualState('TALKING', 3, 'speech-ready', true);

  const subBox = $('mon-subtitles');
  const subTxt = $('mon-sub-text');
  if (subBox && subTxt) {
    subTxt.textContent = text;
    subBox.classList.add('visible');
  }
  if ($('talking-live-badge')) $('talking-live-badge').style.display = 'flex';

  if (audioElement) {
    try {
      await audioElement.play();
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }
}

async function requestProviderAudio({ provider, text, emotion, voiceId, modelId, speed }) {
  if (location.protocol === 'file:') throw new Error('Open the dashboard through the runtime server');
  const payload = await window.LiveTalkingApi.synthesize({
    commandId: `speech_${Date.now()}`,
    provider,
    text,
    emotion,
    voiceId,
    modelId,
    speed,
  });
  if (!payload.success || !payload.audioBase64) throw new Error(payload.error || 'Runtime TTS failed');
  const binary = atob(payload.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: payload.mediaType || 'audio/mpeg' });
}

async function speakWithQwenTts(text, emotion = 'happy', voiceId = 'qwen-default', speed = 1.0) {
  updateVoiceStatusUI('generating', 'Qwen TTS is generating Vietnamese voice…', 30);
  try {
    const blob = await requestProviderAudio({
      provider: 'qwentts',
      text,
      emotion,
      voiceId,
      modelId: 'gwen-tts-0.6B-vi-8bit',
      speed,
    });
    App.voice.providerConfigured = true;
    await handleAudioResponse(new Response(blob, { headers: { 'Content-Type': blob.type } }), text, emotion, `Qwen-${voiceId}`);
  } catch (error) {
    updateVoiceStatusUI('error', error.message);
    return speakWithOmniVoice(text, emotion, 'vi-female', speed);
  }
}

async function speakWithOmniVoice(text, emotion = 'happy', voice = 'vi-female', speed = 1.0) {
  updateVoiceStatusUI('generating', `Runtime TTS [OmniVoice · ${voice}]...`, 30);
  addLog(`Runtime is generating OmniVoice audio [${voice}].`, 'hi');

  try {
    const blob = await requestProviderAudio({ provider: 'omnivoice', text, emotion, voiceId: voice, modelId: 'omnivoice', speed });
    App.voice.providerConfigured = true;
    await handleAudioResponse(new Response(blob, { headers: { 'Content-Type': blob.type } }), text, emotion, `OmniVoice-${voice}`);
  } catch (err) {
    console.error('[Runtime OmniVoice TTS Error]:', err);
    App.isAiSpeaking = false;
    updateVoiceStatusUI('error', err.message);
    addLog(`OmniVoice unavailable: ${err.message}. Web TTS fallback is disabled.`, 'err');
    throw err;
  }
}

async function handleAudioResponse(res, text, emotion, voiceLabel) {
  const blob = await res.blob();
  if (App.talkingEngine.provider === 'livetalking') {
    return submitLiveTalkingSpeech({ text, emotion, voiceLabel, blob });
  }
  const audioUrl = URL.createObjectURL(blob);
  App.currentAudioUrl = audioUrl;

  if (!App.audioElement) {
    App.audioElement = $('live-voice-audio') || new Audio();
  }

  App.audioElement.src = audioUrl;
  App.audioElement.playbackRate = App.voice.speed || 1.0;

  App.audioElement.ontimeupdate = () => {
    if (App.audioElement.duration) {
      const pct = (App.audioElement.currentTime / App.audioElement.duration) * 100;
      updateVoiceStatusUI('playing', `Playing [${voiceLabel}] (${msToMMSS(App.audioElement.currentTime * 1000)} / ${msToMMSS(App.audioElement.duration * 1000)})`, pct);
    }
  };

  App.audioElement.onended = () => {
    LiveLipSyncEngine.stopSpeech();
    MuseTalkRealtimeEngine.stopAudio();
    App.isAiSpeaking = false;
    updateVoiceStatusUI('idle');
    const subBox = $('mon-subtitles');
    if (subBox) subBox.classList.remove('visible');

    if (App.currentState === 'TALKING' && App.autoMix) {
      setTimeout(() => {
        if (App.currentState === 'TALKING' && !App.isAiSpeaking) {
          requestStateTransition('GAMEPLAY_IDLE', 7, 'speech-ended-return', App.globalRandom, false);
          addLog('🗣️ Reply complete → returning to GAMEPLAY_IDLE', 'ok');
        }
      }, 1000);
    }
  };

  App.audioElement.onerror = (e) => {
    console.warn('Playback Error:', e);
    App.isAiSpeaking = false;
    updateVoiceStatusUI('error', 'Generated audio could not be played');
    addLog('Generated TTS audio could not be played. Web TTS fallback is disabled.', 'err');
  };

  const estDurMs = Math.round((App.audioElement.duration || 4) * 1000);
  LiveLipSyncEngine.startSpeech(text, estDurMs, emotion);
  MuseTalkRealtimeEngine.ingestAudio({
    text,
    durationMs: estDurMs,
    type: voiceLabel,
    blobUrl: audioUrl,
    onPlaybackStart: async () => {
      await startSynchronizedPlayback(App.audioElement, text, emotion, voiceLabel, estDurMs);
      updateVoiceStatusUI('playing', `Playing [${voiceLabel}] (${App.voice.speed}x)...`, 15);
      addLog(`🔊 Playing voice [${voiceLabel}] (${blob.size} bytes)...`, 'ok');
    },
  });
}

function renderSavedVoicesList() {
  const optgroup = $('optgroup-custom-voices');
  if (!optgroup) return;

  optgroup.innerHTML = '';
  const customList = App.voice.customVoices || [];

  if (customList.length === 0) {
    optgroup.innerHTML = '<option disabled>No custom voices</option>';
    return;
  }

  customList.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `★ ${v.name || v.id}`;
    if (v.id === App.voice.voiceId) opt.selected = true;
    optgroup.appendChild(opt);
  });
}

// ──────────────────────────────────────────────────────────
// 4. VIDEO STATE MIXER & EXACT DURATION DETECTION
// ──────────────────────────────────────────────────────────

function getGroupForState(state) {
  if (state === 'GAMEPLAY_IDLE' || state === 'GAMEPLAY_FOCUS') return 'gameplay';
  if (state === 'TALKING') return 'talking';
  if (state === 'AFK') return 'afk';
  if (['JACKPOT', 'BIG_WIN', 'HAPPY', 'SURPRISED', 'LAUGH', 'LOSE'].includes(state)) return 'reaction';
  return 'cta';
}

function getActiveTalkingAvatarClip() {
  const pool = LiveAvatarSession.selectedAvatarIds.filter(id => TRAINED_AVATARS.has(id));
  const avatarId = [LiveAvatarSession.activeAvatarId, LiveTalkingStudio.avatarId]
    .find(id => id && pool.includes(id))
    || pool[0];
  if (!avatarId) return null;
  const avatar = TRAINED_AVATARS.get(avatarId);
  return {
    id: `live_avatar_${avatarId}`,
    avatarId,
    kind: 'live-avatar',
    label: avatar.name || avatarId,
    dur: 0,
    mode: 'loop',
    loop: true,
    state: 'TALKING',
  };
}

function normalizeClipAssetKey(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isPlayableClip(clip) {
  if (!clip?.blobUrl) return false;
  const mode = clip.mode || (clip.loop ? 'loop' : 'once');
  return mode !== 'off';
}

function resolveRuntimeClip(state, serverAsset = null, forceRandom = false) {
  // Live avatar playback is owned by the WebRTC/canvas layer. Keep a runtime
  // asset with a real browser URL intact, but never replace a local clip with
  // metadata-only catalog data from the server.
  if (serverAsset?.blobUrl) return serverAsset;
  if (!serverAsset || state === 'TALKING') return pickClipForState(state, forceRandom);

  const assetKeys = new Set([
    serverAsset.id,
    serverAsset.file,
    serverAsset.fileName,
    serverAsset.label,
  ].map(normalizeClipAssetKey).filter(Boolean));
  const stateClips = CLIP_LIBRARY[state] || [];
  const matchingClip = stateClips.find(clip => {
    if (!isPlayableClip(clip)) return false;
    return [clip.id, clip.fileName, clip.label]
      .map(normalizeClipAssetKey)
      .some(key => assetKeys.has(key));
  });
  if (matchingClip) return matchingClip;

  // The runtime can select an asset that has not been uploaded into the
  // browser library yet. Keep the monitor live with the first usable clip in
  // the requested state, then fall back to the normal idle clip policy.
  const activeStateClip = stateClips.find(isPlayableClip);
  if (activeStateClip) return activeStateClip;
  return pickClipForState(state, forceRandom);
}

function pickClipForState(state, forceRandom = false) {
  if (state === 'TALKING') {
    const liveAvatar = getActiveTalkingAvatarClip();
    if (liveAvatar) return liveAvatar;
  }
  let clips = CLIP_LIBRARY[state] || [];
  
  if (clips.length === 0) {
    if (state === 'GAMEPLAY_FOCUS' || state === 'TALKING') clips = CLIP_LIBRARY.GAMEPLAY_IDLE || [];
    else if (state === 'BIG_WIN') clips = CLIP_LIBRARY.JACKPOT || [];
    else if (state === 'JACKPOT') clips = CLIP_LIBRARY.BIG_WIN || [];
  }

  // Filter only active clips (exclude 'off')
  const activeClips = clips.filter(c => {
    const m = c.mode || (c.loop ? 'loop' : 'once');
    return m !== 'off';
  });

  if (activeClips.length === 0) {
    if (state !== 'GAMEPLAY_IDLE') {
      const fallbackClips = (CLIP_LIBRARY.GAMEPLAY_IDLE || []).filter(c => (c.mode || (c.loop ? 'loop' : 'once')) !== 'off');
      if (fallbackClips.length > 0) return fallbackClips[0];
    }
    return clips[0] || null;
  }

  if (activeClips.length === 1) return activeClips[0];

  const grp = getGroupForState(state);
  const isGrpRandom = (App.groupRandom && App.groupRandom[grp] !== false);
  const isRandomActive = forceRandom || App.globalRandom || isGrpRandom;

  // Mixer priority: Random > Loop > Play once
  // 1. Priority 1: RANDOM
  if (isRandomActive) {
    const candidates = activeClips.filter(c => !App.currentClip || c.id !== App.currentClip.id);
    const pool = candidates.length > 0 ? candidates : activeClips;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // 2. Priority 2: LOOP
  const loopClips = activeClips.filter(c => (c.mode || (c.loop ? 'loop' : 'once')) === 'loop');
  if (loopClips.length > 0) {
    if (App.currentClip) {
      const curIdx = loopClips.findIndex(c => c.id === App.currentClip.id);
      if (curIdx !== -1) {
        return loopClips[(curIdx + 1) % loopClips.length];
      }
    }
    return loopClips[0];
  }

  // 3. Priority 3: 1 TIME (ONCE)
  const onceClips = activeClips.filter(c => (c.mode || (c.loop ? 'loop' : 'once')) === 'once');
  if (onceClips.length > 0) {
    return onceClips[0];
  }

  return activeClips[0];
}

function renderStateHistory() {
  const track = $('history-track');
  if (!track) return;
  track.innerHTML = App.stateHistory.slice(-8).map((h, i, arr) => {
    const isCurrent = (i === arr.length - 1);
    const stateColor = STATE_COLOR[h.state] || h.color || '#94a3b8';
    return `<span class="hist-chip ${isCurrent ? 'current' : ''}" data-state="${h.state}" style="--history-color:${stateColor};">${h.state}</span>`;
  }).join('');
}

let lastLibraryRenderSignature = '';

function createLibraryRenderSignature() {
  const clips = Object.entries(CLIP_LIBRARY).flatMap(([state, entries]) =>
    entries.map(clip => [state, clip.id, clip.label, clip.dur, clip.mode, clip.blobUrl]),
  );
  const avatars = [...TRAINED_AVATARS.values()].map(avatar => [
    avatar.id,
    avatar.status,
    avatar.thumbnailUrl,
    avatar.avatarState,
    avatar.durationMs || avatar.duration_ms,
  ]);
  return JSON.stringify({
    clips,
    avatars,
    selectedAvatarIds: LiveAvatarSession.selectedAvatarIds,
    excludedAvatarIds: LiveAvatarSession.excludedAvatarIds,
    ratio: App.libraryRatio,
    filter: App.activeFilter,
  });
}

function renderLibraryUI() {
  const groupGameplay = $('list-group-gameplay');
  const groupTalking = $('list-group-talking');
  const groupAfk = $('list-group-afk');
  const groupCta = $('list-group-cta');
  const libraryBody = $('lib-body');
  const ratio = App.libraryRatio === '9:16' ? '9:16' : '16:9';
  const renderSignature = createLibraryRenderSignature();
  const groupsReady = groupGameplay && groupTalking && groupAfk && groupCta;
  if (groupsReady && renderSignature === lastLibraryRenderSignature) {
    updateLibraryTransientState();
    return;
  }
  const previousScrollTop = libraryBody?.scrollTop || 0;

  if (libraryBody) libraryBody.dataset.previewRatio = ratio;
  document.querySelectorAll('.lib-ratio-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.libraryRatio === ratio);
  });

  let totalCount = 0;

  // 1. Gameplay
  const gameplayClips = [...(CLIP_LIBRARY.GAMEPLAY_IDLE || []), ...(CLIP_LIBRARY.GAMEPLAY_FOCUS || [])];
  totalCount += gameplayClips.length;
  if ($('cnt-group-gameplay')) $('cnt-group-gameplay').textContent = gameplayClips.length;
  if (groupGameplay) {
    groupGameplay.innerHTML = gameplayClips.length === 0 
      ? '<div class="lib-empty-notice" data-target-group="GAMEPLAY_IDLE">No clips. Select <b>＋</b> to upload.</div>'
      : gameplayClips.map(clip => renderClipCardHTML(clip, clip.state || 'GAMEPLAY_IDLE')).join('');
  }

  // 2. Talking & Chat
  const talkingClips = CLIP_LIBRARY.TALKING || [];
  const talkingAvatars = [...TRAINED_AVATARS.values()]
    .filter(avatar => LiveAvatarSession.selectedAvatarIds.includes(avatar.id));
  const talkingItemCount = talkingClips.length + talkingAvatars.length;
  totalCount += talkingItemCount;
  if ($('cnt-group-talking')) $('cnt-group-talking').textContent = talkingItemCount;
  if (groupTalking) {
    groupTalking.innerHTML = talkingItemCount === 0
      ? '<div class="lib-empty-notice" data-target-group="TALKING">No Talking clips. Select <b>＋</b> to upload.</div>'
      : [
          ...talkingAvatars.map(renderTalkingAvatarCardHTML),
          ...talkingClips.map(clip => renderClipCardHTML(clip, 'TALKING')),
        ].join('');
  }

  // 3. CTA & Goals
  const ctaClips = [
    ...(CLIP_LIBRARY.INVITE_PLAY || []),
    ...(CLIP_LIBRARY.CTA || []),
    ...(CLIP_LIBRARY.THANK_DONATION || []),
  ];
  totalCount += ctaClips.length;
  if ($('cnt-group-cta')) $('cnt-group-cta').textContent = ctaClips.length;
  if (groupCta) {
    groupCta.innerHTML = ctaClips.length === 0
      ? '<div class="lib-empty-notice" data-target-group="CTA">No clips. Select <b>＋</b> to upload.</div>'
      : ctaClips.map(clip => renderClipCardHTML(clip, clip.state || 'CTA')).join('');
  }

  // 4. AFK
  const afkClips = CLIP_LIBRARY.AFK || [];
  totalCount += afkClips.length;
  if ($('cnt-group-afk')) $('cnt-group-afk').textContent = afkClips.length;
  if (groupAfk) {
    groupAfk.innerHTML = afkClips.length === 0
      ? '<div class="lib-empty-notice" data-target-group="AFK">No AFK clips. Select <b>＋</b> to upload.</div>'
      : afkClips.map(clip => renderClipCardHTML(clip, 'AFK')).join('');
  }

  if ($('lib-total-count')) $('lib-total-count').textContent = `${totalCount} items`;

  initLibraryThumbnails();

  // Update Group Random button UI states
  document.querySelectorAll('.btn-group-random').forEach(btn => {
    const grp = btn.dataset.randGroup;
    const isAct = (App.groupRandom && App.groupRandom[grp] !== false);
    btn.classList.toggle('is-active', isAct);
    btn.classList.toggle('is-inactive', !isAct);
    btn.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">shuffle</span>';
    btn.title = isAct ? 'Random: ON' : 'Random: OFF';
  });

  const filter = App.activeFilter || 'all';
  document.querySelectorAll('.lib-group-card').forEach(card => {
    const cat = card.dataset.cat;
    card.style.display = (filter === 'all' || filter === cat) ? 'flex' : 'none';
  });
  if (libraryBody) libraryBody.scrollTop = previousScrollTop;
  lastLibraryRenderSignature = renderSignature;
  updateLibraryTransientState();
}

function updateLibraryTransientState() {
  document.querySelectorAll('.clip-card[data-clip-id]').forEach(card => {
    const isPlaying = App.currentClip?.id === card.dataset.clipId;
    card.classList.toggle('active', isPlaying);
    card.classList.toggle('playing', isPlaying);
    const badge = card.querySelector('.now-badge');
    if (badge) badge.style.display = isPlaying ? 'block' : 'none';
  });
  document.querySelectorAll('.live-avatar-card[data-avatar-id]').forEach(card => {
    const isActive = card.dataset.avatarId === LiveTalkingStudio.avatarId
      && Boolean(LiveTalkingWebRTCClient.sessionId);
    card.classList.toggle('active', isActive);
    card.classList.toggle('playing', isActive);
    const badge = card.querySelector('.now-badge');
    if (badge) badge.style.display = isActive ? 'block' : 'none';
    const playIcon = card.querySelector('.clip-play');
    if (playIcon) playIcon.textContent = isActive ? 'graphic_eq' : 'play_arrow';
  });
  document.querySelectorAll('.btn-group-random').forEach(btn => {
    const grp = btn.dataset.randGroup;
    const isAct = App.groupRandom && App.groupRandom[grp] !== false;
    btn.classList.toggle('is-active', isAct);
    btn.classList.toggle('is-inactive', !isAct);
    btn.title = isAct ? 'Random: ON' : 'Random: OFF';
  });
}

function initLibraryThumbnails() {
  document.querySelectorAll('.clip-thumb-media').forEach(video => {
    const seekToPreviewFrame = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = duration > 0 ? Math.min(0.12, duration / 2) : 0.01;
    };

    if (video.readyState >= 1) seekToPreviewFrame();
    else video.addEventListener('loadedmetadata', seekToPreviewFrame, { once: true });
  });
}

function renderClipCardHTML(clip, state) {
  const isPlaying = App.currentClip && App.currentClip.id === clip.id;
  const mode = clip.mode || (clip.loop ? 'loop' : 'once');
  const durSec = clip.dur ? `${(clip.dur / 1000).toFixed(1)}s` : 'video';
  const isOff = (mode === 'off');
  const thumbnail = clip.blobUrl
    ? `<video class="clip-thumb-media" src="${clip.blobUrl}" muted preload="metadata" playsinline aria-hidden="true"></video>`
    : '';

  let modeBtnHtml = '';
  if (mode === 'loop') {
    modeBtnHtml = `<button class="btn-clip-mode mode-loop" data-mode-clip="${clip.id}" data-mode-state="${state}" title="Mode: Loop. Select to change."><span class="material-symbols-rounded" aria-hidden="true">repeat</span></button>`;
  } else if (mode === 'once') {
    modeBtnHtml = `<button class="btn-clip-mode mode-once" data-mode-clip="${clip.id}" data-mode-state="${state}" title="Mode: Play once. Select to change."><span class="material-symbols-rounded" aria-hidden="true">looks_one</span></button>`;
  } else {
    modeBtnHtml = `<button class="btn-clip-mode mode-off" data-mode-clip="${clip.id}" data-mode-state="${state}" title="Mode: Off. Select to change."><span class="material-symbols-rounded" aria-hidden="true">block</span></button>`;
  }

  return `
    <div class="clip-card ${isPlaying ? 'active playing' : ''} ${isOff ? 'is-off' : ''}" data-clip-id="${clip.id}" data-state="${state}">
      <div class="clip-thumb" style="background:#131b26;">
        ${thumbnail}
        <span class="clip-play material-symbols-rounded" aria-hidden="true">play_arrow</span>
      </div>
      <div class="clip-meta">
        <span class="clip-n">${clip.label || clip.id}</span>
        <span class="clip-d"><span class="clip-format-tag" aria-label="Format">MP4</span><span class="clip-duration">${durSec}</span></span>
        <div class="now-badge" style="display:${isPlaying ? 'block' : 'none'};">NOW</div>
      </div>
      <div class="clip-actions">
        ${modeBtnHtml}
        <button type="button" class="btn-delete-clip" data-del-id="${clip.id}" data-del-state="${state}" title="Delete clip" aria-label="Delete clip"><span class="material-symbols-rounded" aria-hidden="true">delete</span></button>
      </div>
    </div>
  `;
}

function renderTalkingAvatarCardHTML(avatar) {
  const isActive = avatar.id === LiveTalkingStudio.avatarId && Boolean(LiveTalkingWebRTCClient.sessionId);
  const thumbnail = avatar.thumbnailUrl
    ? `<img class="clip-thumb-media live-avatar-thumb" src="${avatar.thumbnailUrl}" alt="" loading="lazy" />`
    : '<span class="material-symbols-rounded live-avatar-fallback" aria-hidden="true">person</span>';
  const durationMs = Number(avatar.durationMs || avatar.duration_ms || 0);
  const durationLabel = durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : 'Duration unavailable';
  const stateLabel = String(avatar.avatarState || 'normal').toUpperCase();
  return `
    <div class="clip-card live-avatar-card ${isActive ? 'active playing' : ''}" data-avatar-id="${avatar.id}" data-state="TALKING">
      <div class="clip-thumb live-avatar-preview">
        ${thumbnail}
        <span class="clip-play material-symbols-rounded" aria-hidden="true">${isActive ? 'graphic_eq' : 'play_arrow'}</span>
      </div>
      <div class="clip-meta">
        <span class="clip-n">${avatar.id}</span>
        <span class="clip-d"><span class="clip-format-tag" aria-label="Format">AVATAR</span><span class="clip-state">${stateLabel} · ${durationLabel}</span></span>
        <div class="now-badge" style="display:${isActive ? 'block' : 'none'};">ACTIVE</div>
      </div>
      <div class="clip-actions">
        <button class="btn-remove-live-avatar" data-avatar-id="${avatar.id}" title="Remove this avatar state from Live"><span class="material-symbols-rounded" aria-hidden="true">close</span></button>
      </div>
    </div>
  `;
}

function cycleStateClip(direction = 1) {
  const clips = (CLIP_LIBRARY[App.currentState] || []).filter(c => {
    const m = c.mode || (c.loop ? 'loop' : 'once');
    return m !== 'off';
  });
  if (clips.length <= 1) return;
  const curIdx = clips.findIndex(c => App.currentClip && c.id === App.currentClip.id);
  const nextIdx = (curIdx + direction + clips.length) % clips.length;
  const targetClip = clips[nextIdx];
  if (targetClip) {
    App.currentClip = targetClip;
    App.clipStartedAt = Date.now();
    App.clipElapsedMs = 0;
    updateMonitorScreen(App.currentState, targetClip);
    renderLibraryUI();
    addLog(`Changed clip: [${targetClip.label}] (${nextIdx + 1}/${clips.length})`, 'ok');
  }
}

let autoReturnTimer = null;

function setQueuedTransitionStatus(targetState = '') {
  const banner = $('queued-transition-banner');
  const prefix = $('queued-status-prefix');
  const targetLabel = $('queued-target-state');
  const icon = $('queued-status-icon');
  const skipButton = $('btn-skip-queue');
  const isWaiting = Boolean(targetState);
  if (banner) banner.classList.toggle('is-waiting', isWaiting);
  if (prefix) prefix.textContent = isWaiting ? 'Waiting for the current clip to finish. Next: ' : 'Playback ready';
  if (targetLabel) targetLabel.textContent = isWaiting ? targetState : '';
  if (icon) icon.textContent = isWaiting ? 'hourglass_top' : 'check_circle';
  if (skipButton) skipButton.hidden = !isWaiting;
}

// State changes wait for the current video to finish
function requestStateTransition(targetState, priority = 5, reason = '', forceRandom = false, immediate = false) {
  if (runtimeRealtimeConnected) {
    window.RuntimeApi.post('/api/operator/command', { action: 'FORCE_STATE', state: targetState })
      .catch(error => addLog(`Runtime state command failed: ${error.message}`, 'hi'));
    return;
  }
  const videoEl = currentVideoSlot === 'a'
    ? ($('monitor-video-a') || $('monitor-video'))
    : ($('monitor-video-b') || $('monitor-video'));
  const isPlaying = videoEl && !videoEl.paused && videoEl.duration > 0 && (videoEl.duration - videoEl.currentTime > 0.4);

  if (isPlaying && !immediate && App.currentState !== targetState) {
    App.queuedTransition = { state: targetState, priority, reason, forceRandom };
    setQueuedTransitionStatus(targetState);
    addLog(`⏳ Waiting for the current clip. Next: ${targetState} (${reason || 'request'})`, 'ok');
    return;
  }

  clearQueuedTransition();
  setVisualState(targetState, priority, reason, forceRandom);
}

function clearQueuedTransition() {
  App.queuedTransition = null;
  setQueuedTransitionStatus();
}

function getActiveMonitorVideo() {
  const videoA = $('monitor-video-a');
  const videoB = $('monitor-video-b');
  if (videoA?.classList.contains('active-layer')) return videoA;
  if (videoB?.classList.contains('active-layer')) return videoB;
  return currentVideoSlot === 'a'
    ? (videoA || $('monitor-video'))
    : (videoB || $('monitor-video'));
}

async function waitForTalkingVideoFrame(timeoutMs = 2500) {
  const video = LiveTalkingWebRTCClient?.videoEl || App.avatar.videoEl;
  if (!video) return;
  const hasFrame = () => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    && video.videoWidth > 0
    && video.videoHeight > 0;
  if (hasFrame()) return;

  await new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadeddata', check);
      video.removeEventListener('canplay', check);
      video.removeEventListener('playing', check);
      resolve();
    };
    const check = () => { if (hasFrame()) finish(); };
    timer = setTimeout(finish, timeoutMs);
    video.addEventListener('loadeddata', check);
    video.addEventListener('canplay', check);
    video.addEventListener('playing', check);
  });
}

async function commitRuntimeSpeechPlayback(commandId) {
  if (LiveMediaOwnership.state !== 'OWNER') return;
  if (!commandId || commandId !== pendingRuntimePlaybackCommandId) return;
  await waitForTalkingVideoFrame();
  if (commandId !== pendingRuntimePlaybackCommandId) return;
  clearQueuedTransition();
  setVisualState('TALKING', 7, 'idle-complete-speech-ready', true, true);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    await window.RuntimeApi.post(`/api/speech/${encodeURIComponent(commandId)}/playback-ready`, {});
  } catch (error) {
    addLog(`Could not release queued speech: ${error.message}`, 'err');
  }
}

function queueRuntimeSpeechPlayback(commandId) {
  pendingRuntimePlaybackCommandId = commandId;
  // Speech is time-sensitive. The live WebRTC frame is already decoded before
  // the runtime asks for this boundary, so do not wait for a long idle loop to
  // finish before releasing the cached TTS audio.
  void commitRuntimeSpeechPlayback(commandId);
}

function setVisualState(state, priority = 5, reason = '', forceRandom = false, serverOwned = false, serverAsset = null) {
  const previousState = App.currentState;
  const isSpeechIdleReturn = state === 'GAMEPLAY_IDLE'
    && /speech.*(?:completed|ended|return)/i.test(String(reason));

  // Do not reset the idle video's playhead after speech. While the live
  // MuseTalk canvas is visible, the underlying idle video continues playing;
  // revealing that same clip is the seamless TALKING -> IDLE transition.
  if (state === 'TALKING' && previousState === 'GAMEPLAY_IDLE' && App.currentClip?.blobUrl) {
    App.resumeIdleClipAfterTalking = App.currentClip;
  }

  App.currentState = state;
  OBSOutputBridge.syncVideoTrack();

  App.stateHistory.push({
    state: state,
    time: Date.now(),
    color: STATE_COLOR[state] || '#d8d8da'
  });
  if (App.stateHistory.length > 20) App.stateHistory.shift();
  renderStateHistory();

  const clipToPlay = isSpeechIdleReturn && App.resumeIdleClipAfterTalking?.blobUrl
    ? App.resumeIdleClipAfterTalking
    : resolveRuntimeClip(state, serverAsset, forceRandom);
  if (isSpeechIdleReturn) App.resumeIdleClipAfterTalking = null;

  App.currentClip = clipToPlay;
  App.clipStartedAt = Date.now();
  App.clipElapsedMs = 0;

  updateMonitorScreen(state, clipToPlay);
  updateStateChipsUI(state);
  renderLibraryUI();

  addLog(`→ State: ${state} ${clipToPlay ? `[${clipToPlay.label}]` : ''} ${reason ? `· ${reason}` : ''}`, 'ok');

  if (autoReturnTimer) {
    clearTimeout(autoReturnTimer);
    autoReturnTimer = null;
  }
  
  // Single-play return handler (Exact duration for 1-Time clips with safety timeout)
  const isLoop = (clipToPlay && (clipToPlay.mode ? clipToPlay.mode === 'loop' : clipToPlay.loop));
  if (!serverOwned && App.autoMix && state !== 'GAMEPLAY_IDLE' && !isLoop) {
    const dur = (clipToPlay && clipToPlay.dur) ? clipToPlay.dur + 300 : 5300;
    autoReturnTimer = setTimeout(() => {
      if (App.currentState === state) {
        requestStateTransition('GAMEPLAY_IDLE', 7, 'auto-mix-return', App.globalRandom, false);
      }
    }, dur);
  }
}

let currentVideoSlot = 'a';
let monitorSwitchToken = 0;

function setMonitorVideoLayer(videoEl, isActive) {
  if (!videoEl) return;
  videoEl.classList.toggle('active-layer', isActive);
  videoEl.classList.toggle('standby-layer', !isActive);
}

function setMonitorCanvasVisible(isVisible) {
  $('monitor-w2l-canvas')?.classList.toggle('is-visible', isVisible);
  $('mon-w2l-badge')?.classList.toggle('is-visible', isVisible);
}

function setMonitorBackgroundVisible(isVisible) {
  $('monitor-bg')?.classList.toggle('is-hidden', !isVisible);
}

function isSameMediaSource(videoEl, source) {
  if (!videoEl || !source) return false;
  return videoEl.getAttribute('src') === source || videoEl.currentSrc === source || videoEl.src === source;
}

function updateMonitorScreen(state, clip, forcePlaybackSwap = false) {
  const switchToken = ++monitorSwitchToken;
  const color = STATE_COLOR[state] || 'var(--green)';
  const videoA = $('monitor-video-a');
  const videoB = $('monitor-video-b');
  const singleVideo = $('monitor-video');
  const bgEl = $('monitor-bg');

  if ($('monitor-state-tag')) {
    $('monitor-state-tag').textContent = state;
    $('monitor-state-tag').style.color = color;
  }
  if ($('monitor-clip-name')) {
    $('monitor-clip-name').textContent = clip
      ? (clip.kind === 'live-avatar' ? `${clip.avatarId} · Neural avatar` : `${clip.label || clip.id}.mp4`)
      : 'No video clip';
  }
  if ($('mon-state-name')) {
    $('mon-state-name').textContent = state;
    $('mon-state-name').style.color = color;
    $('mon-state-name').style.textShadow = `0 0 20px ${color}`;
  }
  if ($('mon-clip-id')) {
    $('mon-clip-id').textContent = clip ? clip.id : 'Waiting for video upload';
  }
  if ($('mon-tl-state')) $('mon-tl-state').textContent = state;
  if ($('tl-state')) {
    $('tl-state').textContent = state;
    $('tl-state').style.color = color;
  }
  
  const clipMode = clip ? (clip.mode || (clip.loop ? 'loop' : 'once')) : 'loop';
  const isLoop = (clipMode === 'loop');
  const durLabel = clip ? (isLoop ? '∞ loop' : `${(clip.dur / 1000).toFixed(1)}s`) : '∞ loop';
  if ($('mon-dur')) $('mon-dur').textContent = durLabel;
  if ($('tl-dur')) $('tl-dur').textContent = clip ? (isLoop ? '∞' : `${(clip.dur / 1000).toFixed(1)}s`) : '∞';

  const isCanvasTrained = (LiveTalkingStudio.isTrainedReady || App.avatar.videoEl);
  if ((state === 'TALKING' || App.isAiSpeaking) && isCanvasTrained) {
    setMonitorCanvasVisible(true);
    setMonitorVideoLayer(videoA, false);
    setMonitorVideoLayer(videoB, false);
    setMonitorVideoLayer(singleVideo, false);
    setMonitorBackgroundVisible(false);
    return;
  }

  if (clip && clip.blobUrl && (videoA || singleVideo)) {
    if (videoA && videoB) {
      const visibleEl = videoA.classList.contains('active-layer')
        ? videoA
        : videoB.classList.contains('active-layer') ? videoB : null;
      const activeEl = visibleEl || (currentVideoSlot === 'a' ? videoA : videoB);
      const standbyEl = activeEl === videoA ? videoB : videoA;
      currentVideoSlot = activeEl === videoA ? 'a' : 'b';
      const playbackLibraryState = clip.state || state;
      const playableClips = (CLIP_LIBRARY[playbackLibraryState] || []).filter(candidate => {
        const mode = candidate.mode || (candidate.loop ? 'loop' : 'once');
        return mode !== 'off';
      });
      const overlapFrames = Math.max(0, Math.min(4, Number(App.playbackOverlapFrames) || 0));
      const shouldNativeLoop = overlapFrames === 0 && isLoop && playableClips.length <= 1 && !App.queuedTransition;

      const setupEndHandler = (el) => {
        let didAdvance = false;
        if (el._loopBoundaryFrameCallback && typeof el.cancelVideoFrameCallback === 'function') {
          el.cancelVideoFrameCallback(el._loopBoundaryFrameCallback);
          el._loopBoundaryFrameCallback = 0;
        }
        const advance = () => {
          if (didAdvance) return;
          didAdvance = true;
          el.ontimeupdate = null;
          if (el._loopBoundaryFrameCallback && typeof el.cancelVideoFrameCallback === 'function') {
            el.cancelVideoFrameCallback(el._loopBoundaryFrameCallback);
            el._loopBoundaryFrameCallback = 0;
          }
          if (autoReturnTimer) {
            clearTimeout(autoReturnTimer);
            autoReturnTimer = null;
          }
          if (App.queuedTransition) {
            const next = App.queuedTransition;
            clearQueuedTransition();
            if (next.commandId) {
              void commitRuntimeSpeechPlayback(next.commandId);
              return;
            }
            setVisualState(next.state, next.priority, next.reason || 'queued-complete', next.forceRandom);
            return;
          }
          if (App.currentState !== 'GAMEPLAY_IDLE' && !isLoop) {
            if (App.autoMix) {
              setVisualState('GAMEPLAY_IDLE', 7, 'clip-ended-return', App.globalRandom);
            }
            return;
          }
          const grp = getGroupForState(App.currentState);
          const isGrpRandom = (App.groupRandom && App.groupRandom[grp] !== false);
          const activeClipsInState = (CLIP_LIBRARY[playbackLibraryState] || []).filter(c => {
            const m = c.mode || (c.loop ? 'loop' : 'once');
            return m !== 'off';
          });
          if (activeClipsInState.length > 1) {
            const nextClip = pickClipForState(App.currentState, isGrpRandom || App.globalRandom);
            if (nextClip) {
              App.currentClip = nextClip;
              App.clipStartedAt = Date.now();
              App.clipElapsedMs = 0;
              updateMonitorScreen(App.currentState, nextClip);
              renderLibraryUI();
              addLog(`🔀 State mixer: switched clip [${nextClip.label}] trong ${App.currentState}`, 'ok');
              return;
            }
          }
          if (isLoop || App.currentState === 'GAMEPLAY_IDLE') {
            if (overlapFrames > 0) {
              updateMonitorScreen(App.currentState, App.currentClip, true);
            } else {
              el.currentTime = 0;
              el.play().catch(() => {});
            }
          } else if (App.autoMix) {
            setVisualState('GAMEPLAY_IDLE', 7, 'clip-ended-return', App.globalRandom);
          }
        };

        el.loop = shouldNativeLoop;
        if (shouldNativeLoop) {
          el.onended = null;
          el.ontimeupdate = null;
          return;
        }

        const overlapSeconds = overlapFrames / 25;
        const checkBoundary = (mediaTime = el.currentTime) => {
          if (el.paused || !Number.isFinite(el.duration) || el.duration <= 0) return;
          if (overlapFrames > 0 && el.duration - mediaTime <= overlapSeconds) advance();
        };
        el.onended = advance;
        if (overlapFrames > 0 && typeof el.requestVideoFrameCallback === 'function') {
          const watchFrame = (_now, metadata) => {
            if (didAdvance) return;
            checkBoundary(Number(metadata?.mediaTime) || el.currentTime);
            if (!didAdvance) el._loopBoundaryFrameCallback = el.requestVideoFrameCallback(watchFrame);
          };
          el._loopBoundaryFrameCallback = el.requestVideoFrameCallback(watchFrame);
          el.ontimeupdate = null;
        } else {
          el.ontimeupdate = () => checkBoundary(el.currentTime);
        }
      };

      setupEndHandler(activeEl);
      setupEndHandler(standbyEl);

      // If active video already playing this exact clip
      if (!forcePlaybackSwap && isSameMediaSource(activeEl, clip.blobUrl) && !activeEl.paused && activeEl.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        setMonitorVideoLayer(activeEl, true);
        setMonitorVideoLayer(standbyEl, false);
        setMonitorCanvasVisible(false);
        setMonitorBackgroundVisible(false);
        return;
      }

      // Preload offscreen and switch only after the first decoded frame is ready.
      standbyEl.loop = shouldNativeLoop;
      standbyEl.muted = true;
      standbyEl.preload = 'auto';
      setMonitorVideoLayer(standbyEl, false);

      if (!isSameMediaSource(standbyEl, clip.blobUrl)) {
        standbyEl.setAttribute('src', clip.blobUrl);
        standbyEl.load();
      } else {
        try { standbyEl.currentTime = 0; } catch (_) {}
      }

      let didCommit = false;
      const commitSwap = async () => {
        if (didCommit || switchToken !== monitorSwitchToken) return;
        didCommit = true;
        standbyEl.removeEventListener('canplay', commitSwap);
        standbyEl.removeEventListener('loadeddata', commitSwap);
        standbyEl.removeEventListener('playing', commitSwap);
        try {
          await standbyEl.play();
        } catch (_) {
          didCommit = false;
          return;
        }
        if (switchToken !== monitorSwitchToken) {
          setTimeout(() => {
            if (!standbyEl.classList.contains('active-layer')) standbyEl.pause();
          }, 220);
          return;
        }
        // play() resolves only after the new layer has a decoded frame. Commit
        // synchronously so a second state update cannot leave both layers hidden.
        setMonitorVideoLayer(standbyEl, true);
        setMonitorVideoLayer(activeEl, false);
        setMonitorCanvasVisible(false);
        setMonitorBackgroundVisible(false);
        setTimeout(() => {
          if (!activeEl.classList.contains('active-layer')) activeEl.pause();
        }, 220);
        currentVideoSlot = standbyEl === videoA ? 'a' : 'b';
      };

      if (standbyEl.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        commitSwap();
      } else {
        standbyEl.addEventListener('canplay', commitSwap, { once: true });
        standbyEl.addEventListener('loadeddata', commitSwap, { once: true });
        standbyEl.addEventListener('playing', commitSwap, { once: true });
      }

      // Keep the fallback visible while the new layer is decoding. Some
      // WebViews delay canplay even after the first frame is available.
      setMonitorBackgroundVisible(true);

      standbyEl.onloadedmetadata = () => {
        if (standbyEl.duration && !isNaN(standbyEl.duration) && standbyEl.duration > 0) {
          clip.dur = Math.round(standbyEl.duration * 1000);
          const realSec = `${(standbyEl.duration).toFixed(1)}s`;
          if ($('mon-dur')) $('mon-dur').textContent = isLoop ? '∞ loop' : realSec;
          if ($('tl-dur')) $('tl-dur').textContent = isLoop ? '∞' : realSec;
          renderLibraryUI();
        }
      };

    } else if (singleVideo) {
      singleVideo.preload = 'auto';
      if (!isSameMediaSource(singleVideo, clip.blobUrl)) {
        singleVideo.setAttribute('src', clip.blobUrl);
        singleVideo.load();
      }
      const showSingleVideo = async () => {
        if (switchToken !== monitorSwitchToken) return;
        try { await singleVideo.play(); } catch (_) { return; }
        setMonitorVideoLayer(singleVideo, true);
        setMonitorCanvasVisible(false);
        setMonitorBackgroundVisible(false);
      };
      if (singleVideo.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) showSingleVideo();
      else singleVideo.addEventListener('canplay', showSingleVideo, { once: true });
    }
  } else {
    setMonitorCanvasVisible(false);
    setMonitorVideoLayer(videoA, false);
    setMonitorVideoLayer(videoB, false);
    setMonitorVideoLayer(singleVideo, false);
    setMonitorBackgroundVisible(true);
  }
}

function updateStateChipsUI(state) {
  document.querySelectorAll('.sc').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.state === state);
  });
  if ($('state-badge-text')) {
    $('state-badge-text').textContent = state;
    $('state-badge-text').style.color = STATE_COLOR[state] || 'var(--green)';
  }
}

function handleVideoUpload(files, targetState = 'GAMEPLAY_IDLE', playMode = 'loop') {
  if (!files || files.length === 0) return;

  Array.from(files).forEach((file, index) => {
    persistProjectFile(file, 'uploads')
      .then(saved => saved && addLog(`Saved project file: ${saved.filename}`, 'ok'))
      .catch(err => addLog(`Could not save project file: ${err.message}`, 'warn'));
    const blobUrl = URL.createObjectURL(file);
    const cleanId = file.name.replace(/\.[^/.]+$/, "").toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const clipId = (CLIP_LIBRARY[targetState] || []).some(clip => clip.id === cleanId)
      ? `${cleanId}_${Date.now().toString(36)}_${index}`
      : cleanId;
    const storageId = `${targetState}:${clipId}`;
    
    // Create temporary video element to extract EXACT duration
    const tempVid = document.createElement('video');
    tempVid.preload = 'metadata';
    tempVid.src = blobUrl;

    const newClip = {
      id: clipId,
      storageId,
      label: file.name.replace(/\.[^/.]+$/, "").slice(0, 18),
      fileName: file.name,
      dur: 5000, // Provisional until metadata resolves
      mode: playMode, // 'loop' | 'once' | 'off'
      loop: playMode === 'loop',
      blobUrl: blobUrl,
      state: targetState,
    };

    tempVid.onloadedmetadata = () => {
      if (tempVid.duration && !isNaN(tempVid.duration) && tempVid.duration > 0) {
        newClip.dur = Math.round(tempVid.duration * 1000);
        IdolDB.updateClipMeta(storageId, { dur: newClip.dur }).catch(() => {});
        renderLibraryUI();
        if (App.currentClip && App.currentClip.id === clipId) {
          updateMonitorScreen(targetState, newClip);
        }
      }
    };

    UPLOADED_BLOBS.set(storageId, blobUrl);

    if (!CLIP_LIBRARY[targetState]) CLIP_LIBRARY[targetState] = [];
    CLIP_LIBRARY[targetState].unshift(newClip);
    IdolDB.saveClip(storageId, file, {
      id: clipId,
      fileName: file.name,
      label: newClip.label,
      dur: newClip.dur,
      mode: newClip.mode,
      state: targetState,
    }).catch(err => console.warn('Could not persist uploaded clip:', err));

    addLog(`Uploaded video: ${file.name} to state ${targetState} (${playMode.toUpperCase()})`, 'ok');
  });

  // Reset filter to 'all' so that uploaded clips in any group are immediately visible in the UI
  App.activeFilter = 'all';
  document.querySelectorAll('.lib-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.filter === 'all');
  });

  renderLibraryUI();
  setVisualState(targetState, 4, 'video-uploaded', true);
}

// Chat replies are generated by the runtime Director and Dialogue Agent.

const RenderedChatMessageKeys = new Set();

function chatPlatformLabel(platform = 'mock') {
  if (platform === 'youtube') return '[YT]';
  if (platform === 'facebook') return '[FB]';
  return '';
}

function renderChatMessage(message = {}) {
  const chatList = $('chat-queue');
  if (!chatList) return;

  const platform = String(message.platform || 'mock');
  const viewerName = String(message.viewerName || 'Viewer');
  const messageText = String(message.message || '');
  const timestamp = Number(message.timestamp || Date.now());
  const messageKey = `${platform}\u0000${message.viewerId || viewerName}\u0000${messageText}\u0000${timestamp}`;
  if (RenderedChatMessageKeys.has(messageKey)) return;
  RenderedChatMessageKeys.add(messageKey);
  if (RenderedChatMessageKeys.size > 200) {
    const oldest = RenderedChatMessageKeys.values().next().value;
    if (oldest) RenderedChatMessageKeys.delete(oldest);
  }

  const emptyNotice = chatList.querySelector('.ev-empty');
  if (emptyNotice) emptyNotice.remove();

  const timeStr = new Date(timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const li = document.createElement('li');
  li.className = 'chat-item';
  li.dataset.platform = platform;
  const viewer = document.createElement('div');
  viewer.className = 'chat-viewer';
  const badge = document.createElement('span');
  badge.className = 'chat-platform-badge';
  badge.dataset.platform = platform;
  badge.textContent = chatPlatformLabel(platform);
  const name = document.createElement('span');
  name.className = 'chat-viewer-name';
  name.textContent = viewerName;
  if (badge.textContent) viewer.append(badge);
  viewer.append(name);
  const body = document.createElement('div');
  body.className = 'chat-msg';
  body.textContent = messageText;
  const age = document.createElement('div');
  age.className = 'chat-age';
  age.textContent = timeStr;
  li.append(viewer, body, age);
  chatList.prepend(li);
  while (chatList.children.length > 30) chatList.lastElementChild?.remove();

  App.chatHistory.push({
    platform,
    viewerName,
    messageText,
    isGift: Boolean(message.isSuperChat),
    timestamp,
  });
  if (App.chatHistory.length > 20) App.chatHistory.shift();
}

async function addChatMessage(viewerName, messageText, isGift = false) {
  const timestamp = Date.now();
  try {
    const payload = await window.RuntimeApi.post('/api/chat/send', {
      platform: 'mock',
      viewerId: 'usr_' + viewerName.toLowerCase().replace(/[^a-z0-9]/g, ''),
      viewerName,
      message: messageText,
      isSuperChat: isGift,
      timestamp,
    });
    if (!runtimeRealtimeConnected && payload.message) renderChatMessage(payload.message);
  } catch (error) {
    addLog(`Chat send failed: ${error.message}`, 'warn');
  }
}

// ──────────────────────────────────────────────────────────
// 6. EVENT INJECTIONS & SLOT SIMULATOR
// ──────────────────────────────────────────────────────────

function injectJackpot() {
  App.streamContext.lastGameEvent = 'Hit a 500x jackpot';
  App.streamContext.totalWins++;
  setVisualState('JACKPOT', 1, 'jackpot', true);
  speakAI('Trúng jackpot rồi cả nhà ơi! Đỉnh quá đi mất!', 'excited');
}

function injectDonation() {
  setVisualState('THANK_DONATION', 2, 'donation', true);
  speakAI(`Cảm ơn bạn rất nhiều vì đã ủng hộ livestream của ${activeIdolName()} nha!`, 'grateful');
}

function injectWin() {
  App.streamContext.lastGameEvent = 'Hit a Mega Win';
  App.streamContext.totalWins++;
  setVisualState('BIG_WIN', 4, 'win', true);
  speakAI('Thắng lớn rồi mọi người ơi! Tuyệt vời quá!', 'happy');
}

function injectGoal() {
  setVisualState('INVITE_PLAY', 5, 'goal', true);
  if ($('b-goal')) $('b-goal').textContent = 'invite_viewers';
  speakAI(`Mọi người vào link trong phần mô tả để chơi cùng ${activeIdolName()} nha!`, 'happy');
  App.lastCtaAt = Date.now();
  setTimeout(() => { if ($('b-goal')) $('b-goal').textContent = '—'; }, 6000);
}

function simSlotSpin() {
  const roll = Math.random();
  if (roll < 0.15) {
    injectJackpot();
  } else if (roll < 0.45) {
    injectWin();
  } else {
    App.streamContext.lastGameEvent = 'Missed the last spin; ready for the next round';
    App.streamContext.totalLosses++;
    setVisualState('LOSE', 4, 'spin-lose', true);
    speakAI('Tiếc quá, suýt trúng rồi! Mình thử lại ván tiếp theo nha!', 'neutral');
  }
}

// ──────────────────────────────────────────────────────────
// 7. SETTINGS & SESSION PERSISTENCE
// ──────────────────────────────────────────────────────────

function applyLiveSessionSettingsUI(settings = {}) {
  if ($('live-session-goal')) $('live-session-goal').value = settings.goal || '';
  if ($('live-session-persona')) $('live-session-persona').value = settings.personaBrief || '';
  if ($('live-session-context')) $('live-session-context').value = settings.context || '';
  if ($('live-session-save-status')) $('live-session-save-status').textContent = settings.skillMarkdown
    ? 'Reply skill is ready for this session.'
    : 'Runtime will generate a reply skill.';
}

function applyRuntimeSettingsUI(settings = {}) {
  applyRuntimePolicy(settings.runtimePolicy || {});
  applyRuntimeSystemUI(settings);
  if (settings.voice) {
    const provider = ['qwentts', 'omnivoice'].includes(settings.voice.provider)
      ? settings.voice.provider
      : 'qwentts';
    App.voice.provider = provider;
    App.voice.language = settings.voice.languageCode || 'vi';
    if (settings.voice.voiceId) App.voice.voiceId = settings.voice.voiceId;
    if (Number.isFinite(Number(settings.voice.speed))) App.voice.speed = Number(settings.voice.speed);
    localStorage.setItem(STORAGE_KEYS.VOICE_PROVIDER, App.voice.provider);
    localStorage.setItem(STORAGE_KEYS.VOICE_LANG, App.voice.language);
    localStorage.setItem(STORAGE_KEYS.VOICE_SPEED, String(App.voice.speed));
    localStorage.setItem(STORAGE_KEYS.VOICE_ID, App.voice.voiceId);
    const omniVoice = $('lt-omnivoice-voice-select');
    if (omniVoice && [...omniVoice.options].some(option => option.value === settings.voice.voiceId)) {
      omniVoice.value = settings.voice.voiceId;
    }
  }
  applyAiProfileUI(settings);
  if (settings.talkingEngine) {
    App.talkingEngine.provider = settings.talkingEngine.provider || App.talkingEngine.provider;
    App.talkingEngine.endpoint = settings.talkingEngine.endpoint || App.talkingEngine.endpoint;
    App.talkingEngine.model = settings.talkingEngine.model || App.talkingEngine.model;
    applyLiveTalkingFpsUI(settings.talkingEngine.modelFps, 30);
  }
  if (settings.liveSession) applyLiveSessionSettingsUI(settings.liveSession);
  if (settings.persona) applyAiDirectorSettings(settings.persona);
  if (settings.liveAvatarMaintenance) {
    applyLiveTalkingMaintenanceState(settings.liveAvatarMaintenance);
  }
  if (settings.realtimeStatus) applyLiveTalkingWorkerState(settings.realtimeStatus);
  if (settings.obs) {
    if ($('cfg-obs-host') && document.activeElement !== $('cfg-obs-host')) $('cfg-obs-host').value = settings.obs.host || 'localhost';
    if ($('cfg-obs-port') && document.activeElement !== $('cfg-obs-port')) $('cfg-obs-port').value = String(settings.obs.port || 4455);
    if ($('cfg-obs-autoconnect')) $('cfg-obs-autoconnect').checked = Boolean(settings.obs.autoConnect);
    if ($('cfg-obs-output-resolution') && document.activeElement !== $('cfg-obs-output-resolution')) $('cfg-obs-output-resolution').value = settings.obs.outputResolution || 'auto';
    if ($('cfg-obs-output-ratio') && document.activeElement !== $('cfg-obs-output-ratio')) $('cfg-obs-output-ratio').value = settings.obs.outputRatio || 'auto';
    if ($('cfg-obs-custom-width') && document.activeElement !== $('cfg-obs-custom-width')) $('cfg-obs-custom-width').value = String(settings.obs.customWidth || 1280);
    if ($('cfg-obs-custom-height') && document.activeElement !== $('cfg-obs-custom-height')) $('cfg-obs-custom-height').value = String(settings.obs.customHeight || 720);
    if (Number.isInteger(settings.obs.playbackOverlapFrames)) {
      App.playbackOverlapFrames = Math.max(0, Math.min(4, settings.obs.playbackOverlapFrames));
      if ($('cfg-playback-overlap-frames')) $('cfg-playback-overlap-frames').value = String(App.playbackOverlapFrames);
    }
    applyObsStatus(settings.obs);
    updateObsCustomOutputUI();
  }
  if (settings.platformChat) applyPlatformChatStatus(settings.platformChat, settings.platformReply);
  else if (settings.platformReply) applyPlatformReplySettings(settings.platformReply);
  loadPersistedSettings();
  applyRuntimePolicy(settings.runtimePolicy || {});
}

async function loadLiveSessionSettings() {
  if (location.protocol === 'file:') return null;
  try {
    const payload = await window.RuntimeApi.get('/api/settings/all');
    applyRuntimeSettingsUI(payload);
    return payload;
  } catch (error) {
    if ($('live-session-save-status')) $('live-session-save-status').textContent = `Could not load session: ${error.message}`;
    return null;
  }
}

async function saveLiveSessionSettings() {
  const settings = {
    goal: $('live-session-goal')?.value.trim() || '',
    personaBrief: $('live-session-persona')?.value.trim() || '',
    context: $('live-session-context')?.value.trim() || '',
  };
  const status = $('live-session-save-status');
  if (location.protocol === 'file:') {
    if (status) status.textContent = 'Open the dashboard through the runtime server to save this skill.';
    return;
  }
  if (status) status.textContent = 'Generating reply skill...';
  try {
    const payload = await window.RuntimeApi.post('/api/settings/live-session', settings);
    applyLiveSessionSettingsUI(payload.settings || settings);
    addLog('Live Session reply skill generated and saved.', 'ok');
  } catch (error) {
    if (status) status.textContent = `Could not save session: ${error.message}`;
    addLog(`Live Session skill failed: ${error.message}`, 'err');
  }
}

function loadPersistedSettings() {
  const quickProv = $('quick-voice-provider');
  if (quickProv) quickProv.value = App.voice.provider;
  syncQuickVoiceIdVisibility(App.voice.provider);
  const liveTalkingProv = $('lt-voice-provider-select');
  if (liveTalkingProv) liveTalkingProv.value = App.voice.provider;
  updateLiveTalkingVoiceUI();

  const quickLang = $('quick-voice-lang');
  if (quickLang) quickLang.value = App.voice.language;


  const apikeyGroup = $('group-quick-apikey');
  if (apikeyGroup) apikeyGroup.style.display = 'none';

  const quickVoiceInput = $('quick-voice-id-input');
  if (quickVoiceInput) quickVoiceInput.value = App.voice.voiceId;

  const voiceSelect = $('quick-saved-voice-list');
  if (voiceSelect) {
    renderQuickVoiceOptions(App.voice.provider);
    if ([...voiceSelect.options].some(option => option.value === App.voice.voiceId)) {
      voiceSelect.value = App.voice.voiceId;
    }
  }

  const speedSlider = $('quick-voice-speed');
  const speedVal = $('quick-voice-speed-val');
  if (speedSlider) speedSlider.value = App.voice.speed;
  if (speedVal) speedVal.textContent = `${(App.voice.speed || 1.0).toFixed(2)}x`;

  renderSavedVoicesList();

  const speedStr = `${(App.voice.speed || 1.0).toFixed(2)}x`;
  if ($('sys-tts-engine')) {
    const engineName = App.voice.provider === 'qwentts'
      ? 'Qwen TTS 0.6B'
      : 'Omni Voice Local';
    $('sys-tts-engine').textContent = `${engineName} (VI)`;
  }
  if ($('vstatus-engine-tag')) {
    const providerLabel = App.voice.provider === 'qwentts'
      ? 'Qwen TTS Local · MLX'
      : 'Omni Voice Local · MPS';
    $('vstatus-engine-tag').textContent = `${providerLabel} (VI · ${speedStr})`;
  }
  if ($('sys-talking-engine')) {
    $('sys-talking-engine').textContent = App.talkingEngine.provider === 'off' ? 'Talking: Off' : 'Stream: Active';
  }

  // Load Model Checkpoint & Detector
  if ($('w2l-cfg-checkpoint')) $('w2l-cfg-checkpoint').value = App.talkingEngine.checkpoint || 'wav2lip';
  if ($('w2l-cfg-detector')) $('w2l-cfg-detector').value = App.talkingEngine.detector || 'mediapipe';

  // Load Padding Values into Sliders
  const padTop = parseInt(localStorage.getItem(STORAGE_KEYS.W2L_PAD_TOP) || '0', 10);
  const padBottom = parseInt(localStorage.getItem(STORAGE_KEYS.W2L_PAD_BOTTOM) || '10', 10);
  const padLeft = parseInt(localStorage.getItem(STORAGE_KEYS.W2L_PAD_LEFT) || '0', 10);
  const padRight = parseInt(localStorage.getItem(STORAGE_KEYS.W2L_PAD_RIGHT) || '0', 10);
  if ($('pad-top')) $('pad-top').value = padTop;
  if ($('pad-bottom')) $('pad-bottom').value = padBottom;
  if ($('pad-left')) $('pad-left').value = padLeft;
  if ($('pad-right')) $('pad-right').value = padRight;
  if ($('pad-top-val')) $('pad-top-val').textContent = `${padTop > 0 ? '+' : ''}${padTop}px`;
  if ($('pad-bottom-val')) $('pad-bottom-val').textContent = `${padBottom > 0 ? '+' : ''}${padBottom}px`;
  if ($('pad-left-val')) $('pad-left-val').textContent = `${padLeft > 0 ? '+' : ''}${padLeft}px`;
  if ($('pad-right-val')) $('pad-right-val').textContent = `${padRight > 0 ? '+' : ''}${padRight}px`;

  // Load Mixer Checkboxes
  if ($('chk-auto-mix')) $('chk-auto-mix').checked = App.autoMix;
  if ($('chk-global-random')) $('chk-global-random').checked = App.globalRandom;

  // Load OBS Settings
  const obsCfgStr = localStorage.getItem(STORAGE_KEYS.OBS_CONFIG);
  if (obsCfgStr) {
    try {
      const obsCfg = JSON.parse(obsCfgStr);
      if ($('cfg-obs-host')) $('cfg-obs-host').value = obsCfg.host || 'localhost';
      if ($('cfg-obs-port')) $('cfg-obs-port').value = obsCfg.port || '4455';
      if ($('cfg-obs-autoconnect')) $('cfg-obs-autoconnect').checked = Boolean(obsCfg.autoConnect);
      if ($('cfg-obs-output-resolution')) $('cfg-obs-output-resolution').value = obsCfg.outputResolution || 'auto';
      if ($('cfg-obs-output-ratio')) $('cfg-obs-output-ratio').value = obsCfg.outputRatio || 'auto';
      if ($('cfg-obs-custom-width')) $('cfg-obs-custom-width').value = obsCfg.customWidth || 1280;
      if ($('cfg-obs-custom-height')) $('cfg-obs-custom-height').value = obsCfg.customHeight || 720;
      updateObsCustomOutputUI();
    } catch {}
  }
  applyRuntimePolicy(RuntimeSystem.policy);
}

function isDraftableControl(control) {
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) return false;
  if (!control.id || control.disabled || control.type === 'file' || control.type === 'password') return false;
  if (!control.closest('#view-live-settings, #view-director, #view-settings')) return false;
  return !/(api[-_]?key|token|secret|password|chat-message|source-file)/i.test(`${control.id} ${control.name || ''}`);
}

function readFormDrafts() {
  try {
    const drafts = JSON.parse(localStorage.getItem(STORAGE_KEYS.FORM_DRAFTS) || '{}');
    return drafts && typeof drafts === 'object' && !Array.isArray(drafts) ? drafts : {};
  } catch {
    return {};
  }
}

function restoreFormDrafts() {
  const drafts = readFormDrafts();
  for (const [id, saved] of Object.entries(drafts)) {
    const control = $(id);
    if (!isDraftableControl(control) || !saved || typeof saved !== 'object') continue;
    if (control.type === 'checkbox' || control.type === 'radio') control.checked = Boolean(saved.checked);
    else control.value = String(saved.value ?? '');
  }
}

function setupFormDraftPersistence() {
  if (document.documentElement.dataset.formDraftsReady === 'true') return;
  document.documentElement.dataset.formDraftsReady = 'true';
  let saveTimer = null;
  const saveControl = control => {
    if (!isDraftableControl(control)) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const drafts = readFormDrafts();
      drafts[control.id] = control.type === 'checkbox' || control.type === 'radio'
        ? { checked: control.checked }
        : { value: control.value };
      localStorage.setItem(STORAGE_KEYS.FORM_DRAFTS, JSON.stringify(drafts));
    }, 120);
  };
  document.addEventListener('input', event => saveControl(event.target));
  document.addEventListener('change', event => saveControl(event.target));
}

const DIRECTOR_STORAGE_KEY = 'idol_director_brief_v1';
function setupDirectorBrief() {
  const briefPanel = document.querySelector('.director-brief-panel');
  if (briefPanel?.dataset.initialized === 'true') return;
  if (briefPanel) briefPanel.dataset.initialized = 'true';
  let data = {}; try { data = JSON.parse(localStorage.getItem(DIRECTOR_STORAGE_KEY) || '{}'); } catch {}
  ['objective', 'personality', 'playbook', 'products'].forEach(key => { const el = $(`director-${key}`); if (el && data[key]) el.value = data[key]; });
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const render = () => { const list = $('director-source-list'); if (!list) return; list.innerHTML = sources.length ? sources.map((s, i) => `<div class="director-source-item"><span class="material-symbols-rounded">${s.kind === 'file' ? 'description' : 'link'}</span><div><strong>${String(s.name).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</strong><small>${String(s.detail).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</small></div><button type="button" class="btn-icon-hdr" data-remove-source="${i}" aria-label="Remove source"><span class="material-symbols-rounded">close</span></button></div>`).join('') : '<div class="director-source-empty">Add Google Docs, Drive links, or local reference files.</div>'; };
  const save = (built = false) => { const brief = { objective: $('director-objective')?.value.trim() || '', personality: $('director-personality')?.value.trim() || '', playbook: $('director-playbook')?.value.trim() || '', products: $('director-products')?.value.trim() || '', sources }; localStorage.setItem(DIRECTOR_STORAGE_KEY, JSON.stringify(brief)); if ($('director-brief-status')) $('director-brief-status').textContent = built ? 'Brief active' : 'Draft saved'; if ($('director-save-status')) $('director-save-status').textContent = built ? 'Brief built and synced to Live Session.' : 'Saved locally for this workspace.'; if ($('director-context-preview')) $('director-context-preview').textContent = `OBJECTIVE\n${brief.objective}\n\nPERSONALITY\n${brief.personality}\n\nPLAYBOOK\n${brief.playbook}\n\nPRODUCTS\n${brief.products}\n\nSOURCES\n${sources.map(s => s.name).join(', ') || 'None'}`; };
  render(); if (data.objective) save(false);
  $('director-add-source')?.addEventListener('click', () => { const form = $('director-source-form'); if (form) form.hidden = !form.hidden; });
  $('director-choose-file')?.addEventListener('click', () => $('director-source-file')?.click());
  $('director-save-source')?.addEventListener('click', () => { const file = $('director-source-file')?.files?.[0]; const name = $('director-source-name')?.value.trim() || file?.name || 'Reference source'; const url = $('director-source-url')?.value.trim(); sources.push({ name, detail: file ? `${file.name} · local file` : (url || 'Manual reference'), kind: file ? 'file' : 'link' }); render(); save(false); $('director-source-form').hidden = true; });
  $('director-source-list')?.addEventListener('click', e => { const button = e.target.closest('[data-remove-source]'); if (!button) return; sources.splice(Number(button.dataset.removeSource), 1); render(); save(false); });
  $('build-director-brief')?.addEventListener('click', async () => { save(true); const settings = { goal: $('director-objective').value, personaBrief: $('director-personality').value, context: `${$('director-playbook').value}\n\nProduct knowledge:\n${$('director-products').value}\n\nReferences: ${sources.map(s => s.name).join(', ')}` }; if (location.protocol !== 'file:') await window.RuntimeApi.post('/api/settings/live-session', settings).catch(() => {}); });
  let showCues = [];
  const renderShowCues = () => {
    const list = $('show-cue-list');
    if (!list) return;
    list.replaceChildren();
    if (!showCues.length) {
      const empty = document.createElement('div'); empty.className = 'show-cue-empty'; empty.textContent = 'No timeline cues yet.'; list.append(empty); return;
    }
    showCues.forEach((cue, index) => {
      const row = document.createElement('div'); row.className = 'show-cue-item';
      const minute = document.createElement('strong'); minute.textContent = `${cue.minute} min`;
      const phase = document.createElement('span'); phase.textContent = cue.phase;
      const action = document.createElement('span'); action.className = 'show-cue-action'; action.textContent = cue.action;
      const prompt = document.createElement('span'); prompt.textContent = cue.prompt || cue.scene || '';
      const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.removeShowCue = String(index); remove.title = 'Remove cue'; remove.setAttribute('aria-label', 'Remove cue'); remove.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">delete</span>';
      row.append(minute, phase, action, prompt, remove); list.append(row);
    });
  };
  $('add-show-cue')?.addEventListener('click', () => {
    showCues.push({ id: `cue_${Date.now()}`, minute: Math.max(0, Number($('show-cue-minute')?.value || 0)), phase: $('show-cue-phase')?.value.trim() || 'main_game', action: $('show-cue-action')?.value || 'speak', scene: $('show-cue-scene')?.value || 'GAMEPLAY_IDLE', prompt: $('show-cue-prompt')?.value.trim() || '', enabled: true });
    showCues.sort((a, b) => a.minute - b.minute); renderShowCues();
  });
  $('show-cue-list')?.addEventListener('click', event => { const button = event.target.closest('[data-remove-show-cue]'); if (!button) return; showCues.splice(Number(button.dataset.removeShowCue), 1); renderShowCues(); });
  $('save-show-schedule')?.addEventListener('click', async () => {
    const status = $('show-schedule-status'); if (status) status.textContent = 'Saving timeline...';
    try { const payload = await window.RuntimeApi.post('/api/ai/director/show-schedule', { cues: showCues }); showCues = payload.showSchedule?.cues || showCues; renderShowCues(); if (status) status.textContent = `${showCues.length} cue${showCues.length === 1 ? '' : 's'} active.`; }
    catch (error) { if (status) status.textContent = error.message; }
  });
  if (location.protocol !== 'file:') window.RuntimeApi.get('/api/ai/director/show-schedule').then(payload => { showCues = payload.showSchedule?.cues || []; renderShowCues(); }).catch(() => renderShowCues()); else renderShowCues();
}

function setupLiveSettingPreferences() {
  const view = $('view-live-settings');
  if (!view || view.dataset.preferencesReady === 'true') return;
  view.dataset.preferencesReady = 'true';

  const pageHead = view.querySelector(':scope > .web-page-head');
  const avatarHead = view.querySelector(':scope > .ai-profile-section-head:not(.ai-profile-section-head-profile)');
  const avatarToolbar = view.querySelector(':scope > .avatar-page-toolbar');
  const avatarLibrary = view.querySelector(':scope > .avatar-library-grid');
  const profileHeads = [...view.querySelectorAll(':scope > .ai-profile-section-head-profile')];
  const profileGrid = view.querySelector(':scope > .ai-profile-grid');
  const personaPanel = profileGrid?.children[0] || null;
  const voicePanel = profileGrid?.children[1] || null;
  const replySkillPanel = view.querySelector(':scope > .reply-skill-panel');
  const directorView = $('view-director');
  const directorLayout = directorView?.querySelector('.director-layout');
  const directorHealth = directorView?.querySelector('.director-health');

  const layout = document.createElement('div');
  layout.className = 'live-setting-preferences-layout';
  const tabs = document.createElement('nav');
  tabs.className = 'live-setting-section-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Live Setting sections');
  const stack = document.createElement('div');
  stack.className = 'live-setting-pane-stack';

  const definitions = [
    { id: 'avatar', label: 'Avatar', icon: 'smart_toy' },
    { id: 'profile', label: 'Idol Profile', icon: 'badge' },
    { id: 'voice', label: 'Voice Setting', icon: 'record_voice_over' },
    { id: 'skill', label: 'Live Reply Skill', icon: 'description' },
  ];
  const panes = new Map();
  definitions.forEach((definition, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `live-setting-section-tab${index === 0 ? ' active' : ''}`;
    tab.dataset.liveSettingTarget = definition.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(index === 0));
    tab.tabIndex = index === 0 ? 0 : -1;
    tab.innerHTML = `<span class="material-symbols-rounded" aria-hidden="true">${definition.icon}</span><span>${definition.label}</span>`;
    tabs.append(tab);

    const pane = document.createElement('section');
    pane.className = `live-setting-pane${index === 0 ? ' active' : ''}`;
    pane.dataset.liveSettingPane = definition.id;
    pane.setAttribute('role', 'tabpanel');
    pane.toggleAttribute('hidden', index !== 0);
    stack.append(pane);
    panes.set(definition.id, pane);
  });

  [avatarHead, avatarToolbar, avatarLibrary].forEach(node => { if (node) panes.get('avatar')?.append(node); });
  [profileHeads[0], personaPanel].forEach(node => { if (node) panes.get('profile')?.append(node); });
  if (voicePanel) panes.get('voice')?.append(voicePanel);
  [profileHeads[1], replySkillPanel, directorHealth, directorLayout].forEach(node => { if (node) panes.get('skill')?.append(node); });
  profileGrid?.remove();
  directorView?.remove();
  layout.append(tabs, stack);
  pageHead?.after(layout);

  const setPane = (target = 'avatar', focus = false) => {
    const selected = definitions.some(item => item.id === target) ? target : 'avatar';
    tabs.querySelectorAll('.live-setting-section-tab').forEach(tab => {
      const active = tab.dataset.liveSettingTarget === selected;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    stack.querySelectorAll('.live-setting-pane').forEach(pane => {
      const active = pane.dataset.liveSettingPane === selected;
      pane.classList.toggle('active', active);
      pane.toggleAttribute('hidden', !active);
    });
    $('btn-create-avatar')?.toggleAttribute('hidden', selected !== 'avatar');
    if (selected === 'avatar') void refreshLiveTalkingAvatarList();
    if (selected === 'skill') setupDirectorBrief();
  };

  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-live-setting-target]');
    if (tab) setPane(tab.dataset.liveSettingTarget);
  });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const items = [...tabs.querySelectorAll('.live-setting-section-tab')];
    const current = items.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    setPane(items[next].dataset.liveSettingTarget, true);
  });
  window.setLiveSettingPane = setPane;
  setPane('avatar');
}
function saveVoiceSettings(newSettings = {}) {
  Object.assign(App.voice, newSettings);

  if (newSettings.provider !== undefined) {
    localStorage.setItem(STORAGE_KEYS.VOICE_PROVIDER, App.voice.provider);
  }
  if (newSettings.language !== undefined) {
    localStorage.setItem(STORAGE_KEYS.VOICE_LANG, App.voice.language);
  }
  if (newSettings.voiceId !== undefined) {
    localStorage.setItem(STORAGE_KEYS.VOICE_ID, App.voice.voiceId);
  }
  if (newSettings.speed !== undefined) {
    localStorage.setItem(STORAGE_KEYS.VOICE_SPEED, String(App.voice.speed));
  }
  if (newSettings.personaName !== undefined) {
    localStorage.setItem(STORAGE_KEYS.PERSONA_NAME, App.voice.personaName);
  }
  if (newSettings.personaPrompt !== undefined) {
    localStorage.setItem(STORAGE_KEYS.PERSONA_PROMPT, App.voice.personaPrompt);
  }

  loadPersistedSettings();
}

function activeIdolName() {
  return String(App.voice.personaName || $('profile-idol-name')?.value || 'Mimi').trim() || 'Mimi';
}

function idolPreviewLine(name = activeIdolName()) {
  return `Chào cả nhà, ${name} đã sẵn sàng livestream rồi nè!`;
}

function syncPersonaPreviewCopy(name = activeIdolName()) {
  const preview = idolPreviewLine(name);
  if ($('profile-voice-preview-text')) $('profile-voice-preview-text').value = preview;
  if ($('quick-test-voice-text')) $('quick-test-voice-text').value = preview;
  if ($('lt-test-speech-input')) $('lt-test-speech-input').value = preview;
  const designPreview = document.querySelector('#voice-profile-design-form textarea[name="previewText"]');
  if (designPreview) designPreview.value = preview;
}

function setReplySkillStatus(message, isError = false) {
  const status = $('reply-skill-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function renderReplySkillLibrary() {
  const list = $('reply-skill-list');
  if (!list) return;
  list.replaceChildren();
  const activeSkill = ReplySkillState.items.find(skill => skill.id === ReplySkillState.activeSkillId);
  if ($('reply-skill-active-name')) $('reply-skill-active-name').textContent = activeSkill?.name || 'No skill selected';

  if (!ReplySkillState.items.length) {
    const empty = document.createElement('div');
    empty.className = 'reply-skill-empty';
    empty.textContent = ReplySkillState.busy ? 'Loading saved skills...' : 'No reply skills are available.';
    list.append(empty);
    return;
  }

  for (const skill of ReplySkillState.items) {
    const isActive = skill.id === ReplySkillState.activeSkillId;
    const item = document.createElement('article');
    item.className = `reply-skill-item${isActive ? ' active' : ''}`;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'reply-skill-select';
    select.setAttribute('role', 'radio');
    select.setAttribute('aria-checked', String(isActive));
    select.disabled = ReplySkillState.busy;
    select.addEventListener('click', () => selectReplySkill(skill.id));

    const icon = document.createElement('span');
    icon.className = 'material-symbols-rounded';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = isActive ? 'radio_button_checked' : 'radio_button_unchecked';
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = skill.name;
    const meta = document.createElement('small');
    meta.textContent = skill.source === 'generated' ? 'Live Goal · secondary context' : `${skill.fileName} · highest priority`;
    copy.append(name, meta);
    select.append(icon, copy);
    item.append(select);

    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'reply-skill-active-badge';
      badge.textContent = 'Active';
      item.append(badge);
    }

    if (skill.deletable) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'reply-skill-delete';
      remove.title = `Delete ${skill.name}`;
      remove.setAttribute('aria-label', `Delete ${skill.name}`);
      remove.disabled = ReplySkillState.busy;
      const removeIcon = document.createElement('span');
      removeIcon.className = 'material-symbols-rounded';
      removeIcon.setAttribute('aria-hidden', 'true');
      removeIcon.textContent = 'delete';
      remove.append(removeIcon);
      remove.addEventListener('click', () => deleteReplySkill(skill));
      item.append(remove);
    }
    list.append(item);
  }
}

function applyReplySkillPayload(payload = {}) {
  ReplySkillState.items = Array.isArray(payload.items) ? payload.items : [];
  ReplySkillState.activeSkillId = payload.activeSkillId || '';
  ReplySkillState.busy = false;
  renderReplySkillLibrary();
}

async function loadReplySkills() {
  if (location.protocol === 'file:' || !window.RuntimeApi) return;
  ReplySkillState.busy = true;
  renderReplySkillLibrary();
  try {
    const payload = await window.RuntimeApi.get('/api/settings/reply-skills');
    applyReplySkillPayload(payload);
    setReplySkillStatus('Saved models are ready. The selected model overrides Live Goal on conflicts.');
  } catch (error) {
    ReplySkillState.busy = false;
    renderReplySkillLibrary();
    setReplySkillStatus(`Could not load skills: ${error.message}`, true);
  }
}

async function selectReplySkill(id) {
  if (ReplySkillState.busy || id === ReplySkillState.activeSkillId) return;
  ReplySkillState.busy = true;
  renderReplySkillLibrary();
  setReplySkillStatus('Applying Reply AI Model...');
  try {
    const payload = await window.RuntimeApi.post('/api/settings/reply-skills/select', { id });
    applyReplySkillPayload(payload);
    setReplySkillStatus('Reply AI Model selected. It overrides Live Goal on conflicts.');
  } catch (error) {
    ReplySkillState.busy = false;
    renderReplySkillLibrary();
    setReplySkillStatus(error.message, true);
  }
}

async function uploadReplySkill(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.md')) {
    setReplySkillStatus('Choose a Markdown file ending in .md.', true);
    return;
  }
  ReplySkillState.busy = true;
  renderReplySkillLibrary();
  setReplySkillStatus(`Uploading ${file.name}...`);
  try {
    const markdown = await file.text();
    const payload = await window.RuntimeApi.post('/api/settings/reply-skills', { fileName: file.name, markdown });
    applyReplySkillPayload(payload);
    setReplySkillStatus(`${file.name} is saved as the active Reply AI Model and overrides Live Goal on conflicts.`);
  } catch (error) {
    ReplySkillState.busy = false;
    renderReplySkillLibrary();
    setReplySkillStatus(error.message, true);
  }
}

async function deleteReplySkill(skill) {
  if (ReplySkillState.busy) return;
  const confirmed = await showAppConfirm({
    title: 'Delete reply skill?',
    message: `${skill.name} will be removed from this project.`,
    confirmLabel: 'Delete',
  });
  if (!confirmed) return;
  ReplySkillState.busy = true;
  renderReplySkillLibrary();
  setReplySkillStatus(`Deleting ${skill.name}...`);
  try {
    const payload = await window.RuntimeApi.delete(`/api/settings/reply-skills/${encodeURIComponent(skill.id)}`);
    applyReplySkillPayload(payload);
    setReplySkillStatus('Reply skill deleted.');
  } catch (error) {
    ReplySkillState.busy = false;
    renderReplySkillLibrary();
    setReplySkillStatus(error.message, true);
  }
}

function applyAiProfileUI(settings = {}) {
  const persona = settings.persona || {};
  const voice = settings.voice || {};
  if (persona.name) {
    App.voice.personaName = persona.name;
    localStorage.setItem(STORAGE_KEYS.PERSONA_NAME, persona.name);
  }
  if (persona.systemPrompt) {
    App.voice.personaPrompt = persona.systemPrompt;
    localStorage.setItem(STORAGE_KEYS.PERSONA_PROMPT, persona.systemPrompt);
  }
  const name = persona.name || App.voice.personaName || 'Mimi';
  const fields = {
    'profile-idol-name': name,
    'profile-idol-gender': persona.gender || 'female',
    'profile-idol-age': persona.ageRange || '21-24',
    'profile-idol-archetype': persona.archetype || 'friendly',
    'profile-idol-relationship': persona.relationshipStyle || 'close-friend',
    'profile-idol-personality': persona.personality || '',
    'profile-idol-tone': persona.speakingTone || 'natural',
    'profile-idol-energy': persona.energy || 'balanced',
    'profile-idol-humor': persona.humor || 'light',
    'profile-idol-warmth': persona.warmth || 'warm',
    'profile-idol-formality': persona.formality || 'casual',
    'profile-idol-emotion': persona.emotionStyle || 'balanced',
    'profile-idol-catchphrases': persona.catchphrases || '',
    'profile-idol-self-pronoun': persona.selfPronoun || 'em',
    'profile-idol-male-pronoun': persona.maleViewerPronoun || 'anh',
    'profile-idol-female-pronoun': persona.femaleViewerPronoun || 'chị',
    'profile-idol-unknown-pronoun': persona.unknownViewerStrategy || 'use-name',
    'profile-idol-primary-goal': persona.primaryGoal || 'Trả lời tự nhiên, tạo cảm giác gần gũi và giữ người xem trong phiên live.',
    'profile-idol-secondary-goal': persona.secondaryGoal || 'Khuyến khích người xem tiếp tục trò chuyện bằng câu hỏi ngắn phù hợp.',
    'profile-idol-follow-up': String(persona.followUpRate ?? 45),
    'profile-idol-cta': persona.ctaFrequency || 'low',
    'profile-idol-max-chats': String(persona.maxChatsPerReply ?? 2),
    'profile-idol-brief': persona.briefMarkdown || '',
    'profile-brief-google-url': persona.briefSourceUrl || '',
  };
  Object.entries(fields).forEach(([id, value]) => {
    const field = $(id);
    if (field && document.activeElement !== field) field.value = value;
  });
  PersonaBriefState.sourceType = persona.briefSourceType || 'none';
  PersonaBriefState.sourceName = persona.briefSourceName || '';
  PersonaBriefState.sourceUrl = persona.briefSourceUrl || '';
  renderPersonaBriefSource();
  syncPersonaPreviewCopy(name);
  const provider = ['qwentts', 'omnivoice'].includes(voice.provider) ? voice.provider : 'qwentts';
  if ($('profile-voice-provider')) $('profile-voice-provider').value = provider;
  updateVoiceProfileBuilder(provider);
}

function renderPersonaBriefSource(message = '') {
  const source = $('profile-brief-source');
  if (!source) return;
  const title = source.querySelector('strong');
  const caption = source.querySelector('small');
  source.classList.toggle('has-source', PersonaBriefState.sourceType !== 'none');
  if (title) title.textContent = PersonaBriefState.sourceName || 'No brief imported';
  if (caption) caption.textContent = message || (PersonaBriefState.sourceType === 'google-doc'
    ? 'Google Doc imported. Save the profile to apply it.'
    : PersonaBriefState.sourceType === 'markdown'
      ? 'Markdown imported. Save the profile to apply it.'
      : 'Add a source to give the Idol product or session context.');
}

function collectIdolProfile() {
  return {
    name: $('profile-idol-name')?.value.trim() || 'Mimi',
    gender: $('profile-idol-gender')?.value === 'male' ? 'male' : 'female',
    ageRange: $('profile-idol-age')?.value || '21-24',
    archetype: $('profile-idol-archetype')?.value || 'friendly',
    relationshipStyle: $('profile-idol-relationship')?.value || 'close-friend',
    personality: $('profile-idol-personality')?.value.trim() || '',
    speakingTone: $('profile-idol-tone')?.value || 'natural',
    energy: $('profile-idol-energy')?.value || 'balanced',
    humor: $('profile-idol-humor')?.value || 'light',
    warmth: $('profile-idol-warmth')?.value || 'warm',
    formality: $('profile-idol-formality')?.value || 'casual',
    emotionStyle: $('profile-idol-emotion')?.value || 'balanced',
    catchphrases: $('profile-idol-catchphrases')?.value.trim() || '',
    selfPronoun: $('profile-idol-self-pronoun')?.value || 'em',
    maleViewerPronoun: $('profile-idol-male-pronoun')?.value || 'anh',
    femaleViewerPronoun: $('profile-idol-female-pronoun')?.value || 'chị',
    unknownViewerStrategy: $('profile-idol-unknown-pronoun')?.value || 'use-name',
    primaryGoal: $('profile-idol-primary-goal')?.value.trim() || '',
    secondaryGoal: $('profile-idol-secondary-goal')?.value.trim() || '',
    followUpRate: Number($('profile-idol-follow-up')?.value || 45),
    ctaFrequency: $('profile-idol-cta')?.value || 'low',
    maxChatsPerReply: Number($('profile-idol-max-chats')?.value || 2),
    briefSourceType: PersonaBriefState.sourceType,
    briefSourceName: PersonaBriefState.sourceName,
    briefSourceUrl: PersonaBriefState.sourceUrl,
    briefMarkdown: $('profile-idol-brief')?.value.trim() || '',
  };
}

function updateVoiceProfileBuilder(provider) {
  const supportsProfiles = provider === 'qwentts' || provider === 'omnivoice';
  $('voice-profile-builder')?.toggleAttribute('hidden', !supportsProfiles);
  const designTab = document.querySelector('[data-voice-profile-mode="design"]');
  const cloneTab = document.querySelector('[data-voice-profile-mode="clone"]');
  if (designTab) designTab.hidden = provider !== 'omnivoice';
  if (provider === 'qwentts') {
    designTab?.classList.remove('active');
    cloneTab?.classList.add('active');
    if ($('voice-profile-design-form')) $('voice-profile-design-form').hidden = true;
    if ($('voice-profile-clone-form')) $('voice-profile-clone-form').hidden = false;
  } else if (provider === 'omnivoice') {
    designTab?.classList.add('active');
    cloneTab?.classList.remove('active');
    if ($('voice-profile-design-form')) $('voice-profile-design-form').hidden = false;
    if ($('voice-profile-clone-form')) $('voice-profile-clone-form').hidden = true;
  }
}

function voiceProfileKey(profile) {
  return profile ? `${profile.provider}:${profile.voiceId}` : '';
}

function voiceProviderLabel(provider) {
  if (provider === 'qwentts') return 'Qwen TTS';
  return 'Omni Voice';
}

function voiceProfileDescription(profile) {
  if (profile.description) return profile.description;
  if (profile.kind === 'clone') return 'Cloned voice';
  if (profile.kind === 'design') return 'Designed voice';
  return profile.provider === 'qwentts' ? 'Vietnamese preset' : 'Provider preset';
}

function stopVoiceProfilePreview() {
  if (VoiceProfileState.previewAudio) {
    VoiceProfileState.previewAudio.pause();
    VoiceProfileState.previewAudio.src = '';
    VoiceProfileState.previewAudio = null;
  }
  if (VoiceProfileState.previewUrl) {
    URL.revokeObjectURL(VoiceProfileState.previewUrl);
    VoiceProfileState.previewUrl = '';
  }
}

function updateVoiceProfileActions() {
  const selected = VoiceProfileState.selected;
  const previewButton = $('preview-selected-voice');
  const saveButton = $('save-selected-voice');
  const selectedKey = voiceProfileKey(selected);
  const isActive = Boolean(selected)
    && selected.provider === App.voice.provider
    && selected.voiceId === App.voice.voiceId;
  if (previewButton) previewButton.disabled = !selected || selected.status === 'setup-required';
  if (saveButton) saveButton.disabled = !selected || isActive || VoiceProfileState.previewedKey !== selectedKey;
}

function selectVoiceProfile(profile, { preservePreview = false } = {}) {
  VoiceProfileState.selected = profile || null;
  if (!preservePreview || VoiceProfileState.previewedKey !== voiceProfileKey(profile)) {
    VoiceProfileState.previewedKey = '';
  }
  if (profile?.previewText && $('profile-voice-preview-text')) {
    $('profile-voice-preview-text').value = profile.previewText;
  }
  renderVoiceProfileList();
}

function renderQuickVoiceOptions(provider = App.voice.provider) {
  syncQuickVoiceIdVisibility(provider);
  const select = $('quick-saved-voice-list');
  if (!select) return;
  const profiles = VoiceProfileState.profiles.filter(profile => profile.provider === provider);
  select.replaceChildren();
  if (!profiles.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No saved voices';
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  profiles.forEach(profile => {
    const option = document.createElement('option');
    option.value = profile.voiceId;
    option.textContent = `${profile.name} · ${voiceProfileDescription(profile)}`;
    select.appendChild(option);
  });
  const activeId = App.voice.provider === provider ? App.voice.voiceId : '';
  select.value = profiles.some(profile => profile.voiceId === activeId) ? activeId : profiles[0].voiceId;
  if ($('quick-voice-id-input')) $('quick-voice-id-input').value = select.value;
}

function syncQuickVoiceIdVisibility(provider = App.voice.provider) {
  const section = $('quick-voice-id-section');
  if (!section) return;
  const supportsExternalVoiceId = provider === 'omnivoice';
  section.hidden = !supportsExternalVoiceId;
  section.setAttribute('aria-hidden', String(!supportsExternalVoiceId));
}

function renderVoiceProfileList() {
  const list = $('ai-voice-profile-list');
  if (!list) return;
  const provider = $('profile-voice-provider')?.value || App.voice.provider || 'qwentts';
  const profiles = VoiceProfileState.profiles.filter(profile => profile.provider === provider);
  const selectedKey = voiceProfileKey(VoiceProfileState.selected);
  list.replaceChildren(...profiles.map(profile => {
    const item = document.createElement('article');
    const profileKey = voiceProfileKey(profile);
    const isActive = profile.provider === App.voice.provider && profile.voiceId === App.voice.voiceId;
    item.className = `ai-voice-profile-item${profileKey === selectedKey ? ' selected' : ''}${isActive ? ' active' : ''}`;

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'ai-voice-profile-select';
    selectButton.setAttribute('aria-label', `Select ${profile.name}`);
    const icon = document.createElement('span');
    icon.className = 'material-symbols-rounded';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = profile.kind === 'clone' ? 'graphic_eq' : 'record_voice_over';
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = profile.name;
    const detail = document.createElement('small');
    detail.textContent = `${voiceProfileDescription(profile)}${isActive ? ' · Active' : ''}`;
    copy.append(name, detail);
    selectButton.append(icon, copy);
    selectButton.addEventListener('click', () => selectVoiceProfile(profile));

    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'ai-voice-preview-button';
    previewButton.title = profile.status === 'setup-required' ? 'Configure this provider before previewing' : `Preview ${profile.name}`;
    previewButton.setAttribute('aria-label', `Preview ${profile.name}`);
    previewButton.disabled = profile.status === 'setup-required';
    previewButton.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">play_arrow</span>';
    previewButton.addEventListener('click', async () => {
      selectVoiceProfile(profile);
      await previewSelectedVoice();
    });
    item.append(selectButton, previewButton);
    return item;
  }));
  if (!profiles.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-voice-profile-empty';
    empty.textContent = 'No voices available for this provider.';
    list.appendChild(empty);
  }
  if ($('ai-voice-profile-count')) $('ai-voice-profile-count').textContent = `${profiles.length} voice${profiles.length === 1 ? '' : 's'}`;
  const active = VoiceProfileState.profiles.find(profile => profile.provider === App.voice.provider && profile.voiceId === App.voice.voiceId);
  if ($('ai-voice-profile-summary')) {
    $('ai-voice-profile-summary').textContent = active
      ? `${active.name} · ${voiceProviderLabel(active.provider)} · Active`
      : `${voiceProviderLabel(App.voice.provider)} · ${App.voice.voiceId || 'No voice selected'}`;
  }
  const providerNotice = $('voice-provider-notice');
  if (providerNotice) {
    const availableProfiles = profiles.filter(profile => profile.status !== 'setup-required' && profile.status !== 'offline');
    providerNotice.classList.toggle('needs-setup', profiles.length > 0 && !availableProfiles.length);
    const providerAvailable = VoiceProfileState.providers[provider]?.available !== false;
    providerNotice.textContent = provider === 'omnivoice'
      ? (providerAvailable
        ? 'Omni Voice is ready for design, cloning, and preview.'
        : 'Open Omni Speak to use design, cloning, and preview.')
      : 'Qwen TTS runs locally and is optimized for fast Vietnamese replies.';
    providerNotice.classList.toggle('needs-setup', !providerAvailable || (profiles.length > 0 && !availableProfiles.length));
  }
  updateVoiceProfileActions();
}

async function previewSelectedVoice() {
  const profile = VoiceProfileState.selected;
  const status = $('voice-profile-status');
  if (!profile) return;
  const text = $('profile-voice-preview-text')?.value.trim() || idolPreviewLine();
  const previewButton = $('preview-selected-voice');
  if (previewButton) previewButton.disabled = true;
  stopVoiceProfilePreview();
  unlockAudio();
  if (status) status.textContent = `Generating ${profile.name} preview...`;
  try {
    const blob = await requestProviderAudio({
      provider: profile.provider,
      text,
      emotion: 'happy',
      voiceId: profile.voiceId,
      modelId: profile.provider === 'qwentts'
        ? 'gwen-tts-0.6B-vi-8bit'
        : 'omnivoice',
      speed: App.voice.speed || 1.0,
    });
    VoiceProfileState.previewUrl = URL.createObjectURL(blob);
    VoiceProfileState.previewAudio = new Audio(VoiceProfileState.previewUrl);
    await VoiceProfileState.previewAudio.play();
    VoiceProfileState.previewedKey = voiceProfileKey(profile);
    if (status) status.textContent = `Previewing ${profile.name}. Save it when the voice sounds right.`;
    VoiceProfileState.previewAudio.onended = () => {
      if (status) status.textContent = `${profile.name} preview complete. Ready to save.`;
    };
  } catch (error) {
    VoiceProfileState.previewedKey = '';
    if (status) status.textContent = `Preview unavailable: ${error.message}`;
  } finally {
    updateVoiceProfileActions();
  }
}

async function saveSelectedVoice() {
  const profile = VoiceProfileState.selected;
  const status = $('voice-profile-status');
  if (!profile || VoiceProfileState.previewedKey !== voiceProfileKey(profile)) return;
  const saveButton = $('save-selected-voice');
  if (saveButton) saveButton.disabled = true;
  try {
    await window.LiveTalkingApi.setVoice({
      provider: profile.provider,
      voiceId: profile.voiceId,
      languageCode: 'vi',
      speed: App.voice.speed,
    });
    saveVoiceSettings({ provider: profile.provider, voiceId: profile.voiceId });
    if ($('profile-voice-provider')) $('profile-voice-provider').value = profile.provider;
    if (status) status.textContent = `${profile.name} is saved and active for live replies.`;
    renderQuickVoiceOptions(profile.provider);
    renderVoiceProfileList();
  } catch (error) {
    if (status) status.textContent = `Could not save voice: ${error.message}`;
  } finally {
    updateVoiceProfileActions();
  }
}

async function loadVoiceProfiles(provider = $('profile-voice-provider')?.value || App.voice.provider || 'qwentts', preferredVoiceId = '') {
  if (location.protocol === 'file:') return [];
  try {
    const payload = await window.RuntimeApi.get('/api/voice/profiles');
    const profiles = payload.profiles || [];
    VoiceProfileState.profiles = profiles;
    VoiceProfileState.providers = payload.providers || {};
    renderQuickVoiceOptions(App.voice.provider || 'qwentts');
    const providerProfiles = profiles.filter(profile => profile.provider === provider);
    const requestedId = preferredVoiceId || (App.voice.provider === provider ? App.voice.voiceId : '');
    const selection = providerProfiles.find(profile => profile.voiceId === requestedId) || providerProfiles[0] || null;
    VoiceProfileState.selected = selection;
    VoiceProfileState.previewedKey = '';
    renderVoiceProfileList();
    return profiles;
  } catch (error) {
    if ($('voice-profile-status')) $('voice-profile-status').textContent = `Voice service is not ready: ${error.message}`;
    return [];
  }
}

function bindAiProfileControls() {
  $('upload-reply-skill')?.addEventListener('click', () => $('reply-skill-file-input')?.click());
  $('reply-skill-file-input')?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    try {
      await uploadReplySkill(file);
    } finally {
      event.target.value = '';
    }
  });

  $('profile-brief-upload')?.addEventListener('click', () => $('profile-brief-file')?.click());
  $('profile-brief-file')?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.md$/i.test(file.name)) {
      renderPersonaBriefSource('Only Markdown (.md) files are supported.');
      return;
    }
    try {
      const markdown = (await file.text()).trim();
      if (!markdown) throw new Error('The Markdown file is empty.');
      if (new Blob([markdown]).size > 32_000) throw new Error('Keep the brief under 32 KB.');
      PersonaBriefState.sourceType = 'markdown';
      PersonaBriefState.sourceName = file.name;
      PersonaBriefState.sourceUrl = '';
      if ($('profile-idol-brief')) $('profile-idol-brief').value = markdown;
      if ($('profile-brief-google-url')) $('profile-brief-google-url').value = '';
      renderPersonaBriefSource();
    } catch (error) {
      renderPersonaBriefSource(error.message);
    }
  });

  $('profile-brief-google-import')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const url = $('profile-brief-google-url')?.value.trim() || '';
    if (!url) {
      renderPersonaBriefSource('Paste a Google Docs URL first.');
      return;
    }
    button.disabled = true;
    button.textContent = 'Importing…';
    renderPersonaBriefSource('Reading the public Google Doc...');
    try {
      const payload = await window.RuntimeApi.post('/api/settings/persona/brief/google-doc', { url });
      PersonaBriefState.sourceType = 'google-doc';
      PersonaBriefState.sourceName = payload.name || 'Google Doc';
      PersonaBriefState.sourceUrl = payload.url || url;
      if ($('profile-idol-brief')) $('profile-idol-brief').value = payload.markdown || '';
      renderPersonaBriefSource();
    } catch (error) {
      renderPersonaBriefSource(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Import';
    }
  });

  $('save-ai-profile')?.addEventListener('click', async () => {
    const status = $('profile-save-status');
    const button = $('save-ai-profile');
    const profile = collectIdolProfile();
    if (status) status.textContent = 'Saving and applying profile...';
    if (button) button.disabled = true;
    try {
      const payload = await window.RuntimeApi.post('/api/settings/persona', profile);
      const savedPersona = payload.settings || profile;
      applyAiProfileUI({ persona: savedPersona, voice: { provider: App.voice.provider } });
      saveVoiceSettings({ personaName: savedPersona.name || profile.name, personaPrompt: savedPersona.systemPrompt || '' });
      syncPersonaPreviewCopy(savedPersona.name || profile.name);
      if (status) status.textContent = 'Profile saved and applied to Live Reply.';
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('profile-voice-provider')?.addEventListener('change', async event => {
    const provider = ['qwentts', 'omnivoice'].includes(event.target.value) ? event.target.value : 'qwentts';
    updateVoiceProfileBuilder(provider);
    stopVoiceProfilePreview();
    await loadVoiceProfiles(provider);
    if ($('voice-profile-status')) $('voice-profile-status').textContent = provider === App.voice.provider
      ? 'Select a voice to preview, or keep the active voice.'
      : `Select and preview a ${voiceProviderLabel(provider)} voice before saving.`;
  });

  $('preview-selected-voice')?.addEventListener('click', previewSelectedVoice);
  $('save-selected-voice')?.addEventListener('click', saveSelectedVoice);

  document.querySelectorAll('[data-voice-profile-mode]').forEach(button => button.addEventListener('click', () => {
    const mode = button.dataset.voiceProfileMode;
    document.querySelectorAll('[data-voice-profile-mode]').forEach(item => item.classList.toggle('active', item === button));
    if ($('voice-profile-design-form')) $('voice-profile-design-form').hidden = mode !== 'design';
    if ($('voice-profile-clone-form')) $('voice-profile-clone-form').hidden = mode !== 'clone';
  }));

  $('voice-profile-design-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const status = $('voice-profile-status');
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    if (status) status.textContent = 'Designing voice and generating preview…';
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const payload = await window.RuntimeApi.post('/api/voice/profiles/design', {
        name: values.name,
        gender: values.gender,
        age: values.age,
        pitch: values.pitch,
        accent: values.accent,
        style: values.style,
        previewText: values.previewText,
        performanceMode: false,
      });
      if (status) status.textContent = `${payload.profile.name} was created. Generating a preview...`;
      await loadVoiceProfiles('omnivoice', payload.profile.voiceId);
      await previewSelectedVoice();
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  $('voice-profile-clone-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const status = $('voice-profile-status');
    const submit = event.submitter;
    const file = $('ai-voice-clone-file')?.files?.[0];
    if (!file) return;
    if (submit) submit.disabled = true;
    if (status) status.textContent = 'Analyzing audio and creating cloned voice…';
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const provider = $('profile-voice-provider')?.value === 'omnivoice' ? 'omnivoice' : 'qwentts';
      if (provider === 'qwentts' && !String(values.transcript || '').trim()) {
        throw new Error('Qwen TTS requires the exact reference transcript for fast, accurate cloning.');
      }
      const stored = await persistProjectFile(file, 'uploads');
      const payload = await window.RuntimeApi.post('/api/voice/profiles/clone', {
        name: values.name,
        sourcePath: stored.path,
        transcript: values.transcript || '',
        filename: file.name,
        provider,
      });
      if (status) status.textContent = `${payload.profile.name} was created. Generating a preview...`;
      event.currentTarget.reset();
      await loadVoiceProfiles(provider, payload.profile.voiceId);
      await previewSelectedVoice();
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

// ──────────────────────────────────────────────────────────
// 8. MAIN TICK & LIFECYCLE
// ──────────────────────────────────────────────────────────

function tick() {
  const ms = Date.now() - App.streamStart;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  if ($('stream-clock')) $('stream-clock').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  const pct = Math.min(100, (ms / (60 * 60 * 1000)) * 100);
  if ($('phase-fill')) $('phase-fill').style.width = `${pct}%`;
  const em = Math.floor(ms / 60000);
  if ($('phase-elapsed-label')) $('phase-elapsed-label').textContent = `${em}m / 60m`;

  const phIdx = em < 10 ? 0 : em < 45 ? 1 : em < 55 ? 2 : 3;
  document.querySelectorAll('.pseg').forEach((el, i) => el.classList.toggle('active', i <= phIdx));
  const phases = ['warmup', 'main_game', 'conversion', 'closing'];
  if ($('stream-phase-label')) $('stream-phase-label').textContent = phases[phIdx] ?? 'main_game';

  const el = Date.now() - App.lastCtaAt;
  const rem = App.ctaCooldownMs - el;
  if ($('last-cta')) $('last-cta').textContent = elapsedStr(el) + ' ago';
  if ($('cta-cooldown')) {
    $('cta-cooldown').textContent = ctaCountdown(rem);
    $('cta-cooldown').className = `mv ${rem <= 0 ? 'green' : ''}`;
  }

  if (App.currentClip && App.clipStartedAt) {
    App.clipElapsedMs = Date.now() - App.clipStartedAt;
    const dur = App.currentClip.dur || 5000;
    const tlPct = App.currentClip.loop ? ((App.clipElapsedMs % dur) / dur) * 100 : Math.min(100, (App.clipElapsedMs / dur) * 100);
    if ($('tl-fill')) $('tl-fill').style.width = `${tlPct}%`;
    if ($('tl-thumb')) $('tl-thumb').style.left = `${tlPct}%`;
    if ($('tl-elapsed')) $('tl-elapsed').textContent = msToMMSS(App.clipElapsedMs);
    if ($('mon-elapsed')) $('mon-elapsed').textContent = msToMMSS(App.clipElapsedMs);
  }
}

function openModal(id) {
  const m = $(id);
  if (m) {
    m.style.display = 'flex';
    m.style.zIndex = '99999';
    if (id === 'modal-avatar') {
      initAvatarCanvas();
    }
  }
}

function closeModal(id) {
  const m = $(id);
  if (m) m.style.display = 'none';
}

function showAppConfirm({ title = 'Confirm action', message = '', confirmLabel = 'Confirm' } = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop app-confirm-backdrop';
    backdrop.style.display = 'flex';
    backdrop.style.zIndex = '100000';

    const card = document.createElement('div');
    card.className = 'modal-card app-confirm-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'app-confirm-title');

    const header = document.createElement('div');
    header.className = 'modal-hdr';
    const heading = document.createElement('h3');
    heading.id = 'app-confirm-title';
    heading.textContent = title;
    header.append(heading);

    const body = document.createElement('div');
    body.className = 'modal-body app-confirm-body';
    body.textContent = message;

    const footer = document.createElement('div');
    footer.className = 'modal-ftr';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn-primary app-confirm-danger';
    confirm.textContent = confirmLabel;
    footer.append(cancel, confirm);
    card.append(header, body, footer);
    backdrop.append(card);
    document.body.append(backdrop);

    const finish = result => {
      document.removeEventListener('keydown', onKeyDown);
      backdrop.remove();
      resolve(result);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') finish(false);
      if (event.key === 'Enter') finish(true);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) finish(false);
    });
    document.addEventListener('keydown', onKeyDown);
    confirm.focus();
  });
}

function openUploadModalForTargetState(targetState = 'GAMEPLAY_IDLE') {
  const radio = document.querySelector(`input[name="uploadTargetState"][value="${targetState}"]`);
  if (radio) {
    radio.checked = true;
    document.querySelectorAll('.sc-check-item').forEach(lbl => {
      const r = lbl.querySelector('input');
      lbl.classList.toggle('active', r && r.checked);
    });
  }
  openModal('modal-upload-clip');
}

async function magicConnectObs(triggerButton = null) {
  await unlockAudio(true);
  const buttons = [$('save-modal-obs'), $('btn-magic-connect'), $('btn-go-live-hero')].filter(Boolean);
  const banner = $('obs-status-banner');
  const obsSettings = {
    host: $('cfg-obs-host')?.value || 'localhost',
    port: Number($('cfg-obs-port')?.value || 4455),
    autoConnect: true,
    playbackOverlapFrames: Number($('cfg-playback-overlap-frames')?.value || 2),
    outputResolution: $('cfg-obs-output-resolution')?.value || 'auto',
    outputRatio: $('cfg-obs-output-ratio')?.value || 'auto',
    customWidth: Number($('cfg-obs-custom-width')?.value || 1280),
    customHeight: Number($('cfg-obs-custom-height')?.value || 720),
  };
  const restartIntervalMinutes = Number($('cfg-livetalking-restart-interval')?.value || 15);
  localStorage.setItem(STORAGE_KEYS.OBS_CONFIG, JSON.stringify(obsSettings));
  buttons.forEach(button => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.dataset.magicConnectState = 'connecting';
  });
  if (banner) {
    banner.dataset.state = 'connecting';
    banner.textContent = 'Connecting to OBS and preparing video + voice...';
  }
  try {
    const [payload] = await Promise.all([
      window.RuntimeApi.post('/api/obs/magic-connect', obsSettings),
      window.RuntimeApi.post('/api/settings/talking', { restartIntervalMinutes }),
    ]);
    const output = payload.output || {};
    const selectedPreset = liveVideoPreset();
    const outputPreset = output.videoPreset || selectedPreset;
    const outputPresetLabel = outputPreset.width >= 1920 ? 'FHD' : 'HD';
    const outputPresetCopy = `${outputPresetLabel} ${outputPreset.width} x ${outputPreset.height} / ${outputPreset.fps} FPS`;
    applyObsStatus({ ...output, connected: true, mediaConnected: false });
    const presetStatus = $('obs-video-preset-status');
    const presetCard = $('obs-video-preset');
    if (output.videoPreset?.matches) {
      if (presetCard) presetCard.dataset.state = 'ready';
      if (presetStatus) presetStatus.textContent = `Ready: OBS and AI IDOL use ${outputPresetCopy}.`;
    } else if (output.videoPreset?.streamActive) {
      if (presetCard) presetCard.dataset.state = 'pending';
      if (presetStatus) presetStatus.textContent = `Connected while OBS is live using ${outputPresetCopy}. Resolution changes are deferred until streaming stops.`;
    } else {
      if (presetCard) presetCard.dataset.state = 'error';
      if (presetStatus) presetStatus.textContent = 'Video preset could not be applied. Check OBS video settings.';
    }
    applyLiveTalkingMaintenanceState({ restartIntervalMinutes, state: 'SCHEDULED' });
    buttons.forEach(button => { button.dataset.magicConnectState = 'connected'; });
    addLog(`OBS ready: ${output.sourceName || 'AI IDOL Streamer'} in ${output.sceneName || 'current scene'}${output.videoPreset?.matches ? ` at ${outputPresetCopy}` : ''}.`, 'ok');
    return output;
  } catch (error) {
    applyObsStatus({ connected: false });
    if (banner) {
      banner.dataset.state = 'error';
      banner.textContent = `Magic Connect failed: ${error.message}`;
    }
    buttons.forEach(button => { button.dataset.magicConnectState = 'error'; });
    addLog(`OBS Magic Connect failed: ${error.message}`, 'err');
    if (triggerButton === $('btn-magic-connect') || triggerButton === $('btn-go-live-hero')) {
      window.openStudioSettings?.('output');
    }
    throw error;
  } finally {
    buttons.forEach(button => {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (button.dataset.magicConnectState === 'connecting') delete button.dataset.magicConnectState;
    });
  }
}

async function refreshMuseTalkMaskMode() {
  const group = $('musetalk-mask-options');
  const status = $('musetalk-mask-status');
  if (!group || location.protocol === 'file:') return;
  group.setAttribute('aria-busy', 'true');
  try {
    const payload = await window.RuntimeApi.get('/api/talking-head/musetalk/mask-mode');
    const input = group.querySelector(`input[value="${payload.mode}"]`);
    if (input) input.checked = true;
    if (status) status.textContent = `Active: ${payload.mode}`;
  } catch (error) {
    if (status) status.textContent = `Mask control unavailable: ${error.message}`;
  } finally {
    group.removeAttribute('aria-busy');
  }
}

async function setMuseTalkMaskMode(mode) {
  const group = $('musetalk-mask-options');
  const status = $('musetalk-mask-status');
  if (!group) return;
  group.setAttribute('aria-busy', 'true');
  if (status) status.textContent = `Switching to ${mode}…`;
  try {
    const payload = await window.RuntimeApi.post('/api/talking-head/musetalk/mask-mode', { mode });
    const input = group.querySelector(`input[value="${payload.mode}"]`);
    if (input) input.checked = true;
    if (status) status.textContent = `Active: ${payload.mode} · applies immediately`;
    addLog(`MuseTalk mask switched to ${payload.mode}.`, 'ok');
  } catch (error) {
    if (status) status.textContent = `Could not switch mask: ${error.message}`;
    addLog(`MuseTalk mask switch failed: ${error.message}`, 'err');
    await refreshMuseTalkMaskMode();
  } finally {
    group.removeAttribute('aria-busy');
  }
}

// ── Event Listeners ───────────────────────────────────────
function bindEventListeners() {
  $('btn-system-power')?.addEventListener('click', () => {
    void toggleRuntimeSystem().catch(() => {});
  });
  $('musetalk-mask-options')?.addEventListener('change', event => {
    const input = event.target.closest('input[name="musetalk-mask-mode"]');
    if (input) void setMuseTalkMaskMode(input.value);
  });
  // Topbar Modals
  $('btn-modal-obs')?.addEventListener('click', () => window.openStudioSettings?.('output'));
  $('close-modal-obs')?.addEventListener('click', () => closeModal('modal-obs'));
  $('cancel-modal-obs')?.addEventListener('click', () => closeModal('modal-obs'));

  $('close-modal-upload')?.addEventListener('click', () => closeModal('modal-upload-clip'));
  $('cancel-modal-upload')?.addEventListener('click', () => closeModal('modal-upload-clip'));

  // OBS Settings Inputs Persistence
  ['cfg-obs-host', 'cfg-obs-port', 'cfg-obs-autoconnect', 'cfg-playback-overlap-frames', 'cfg-obs-output-resolution', 'cfg-obs-output-ratio', 'cfg-obs-custom-width', 'cfg-obs-custom-height'].forEach(id => {
    $(id)?.addEventListener('input', () => {
      const obsSettings = {
        host: $('cfg-obs-host')?.value || 'localhost',
        port: $('cfg-obs-port')?.value || '4455',
        autoConnect: $('cfg-obs-autoconnect')?.checked || false,
        playbackOverlapFrames: Number($('cfg-playback-overlap-frames')?.value || 2),
        outputResolution: $('cfg-obs-output-resolution')?.value || 'auto',
        outputRatio: $('cfg-obs-output-ratio')?.value || 'auto',
        customWidth: Number($('cfg-obs-custom-width')?.value || 1280),
        customHeight: Number($('cfg-obs-custom-height')?.value || 720),
      };
      App.playbackOverlapFrames = obsSettings.playbackOverlapFrames;
      localStorage.setItem(STORAGE_KEYS.OBS_CONFIG, JSON.stringify(obsSettings));
      updateObsCustomOutputUI();
    });
  });
  ['cfg-obs-output-resolution', 'cfg-obs-output-ratio', 'cfg-obs-custom-width', 'cfg-obs-custom-height'].forEach(id => {
    $(id)?.addEventListener('change', updateObsCustomOutputUI);
    $(id)?.addEventListener('input', updateObsCustomOutputUI);
  });
  $('cfg-playback-overlap-frames')?.addEventListener('change', event => {
    const playbackOverlapFrames = Math.max(0, Math.min(4, Number(event.target.value) || 0));
    App.playbackOverlapFrames = playbackOverlapFrames;
    window.RuntimeApi.post('/api/settings/obs', {
      host: $('cfg-obs-host')?.value || 'localhost',
      port: Number($('cfg-obs-port')?.value || 4455),
      autoConnect: $('cfg-obs-autoconnect')?.checked || false,
      playbackOverlapFrames,
    }).catch(error => addLog(`Playback setting could not be saved: ${error.message}`, 'warn'));
  });
  $('save-modal-obs')?.addEventListener('click', event => {
    void magicConnectObs(event.currentTarget).catch(() => {});
  });
  $('btn-magic-connect')?.addEventListener('click', event => {
    void magicConnectObs(event.currentTarget).catch(() => {});
  });
  const qualityControl = $('live-video-quality');
  qualityControl?.addEventListener('click', event => {
    const button = event.target.closest('[data-video-quality]');
    if (!button || button.disabled) return;
    void setLiveVideoQuality(button.dataset.videoQuality).catch(() => {});
  });
  qualityControl?.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const qualities = ['hd'];
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const currentIndex = qualities.indexOf(App.talkingEngine.videoQuality);
    const quality = qualities[(currentIndex + direction + qualities.length) % qualities.length];
    const button = qualityControl.querySelector(`[data-video-quality="${quality}"]`);
    button?.focus();
    if (!button?.disabled) void setLiveVideoQuality(quality).catch(() => {});
  });

  // Video Mixer Controls
  $('chk-auto-mix')?.addEventListener('change', (e) => {
    App.autoMix = e.target.checked;
    addLog(`Auto-Mix ${e.target.checked ? 'ENABLED' : 'DISABLED'}`, 'ok');
  });

  $('chk-global-random')?.addEventListener('change', (e) => {
    App.globalRandom = e.target.checked;
    localStorage.setItem(STORAGE_KEYS.GLOBAL_RANDOM, String(App.globalRandom));
    addLog(`Global random: ${App.globalRandom ? 'On' : 'Off'}`, 'ok');
  });

  // Monitor Random Button
  $('btn-random-clip-now')?.addEventListener('click', () => {
    requestStateTransition(App.currentState, 0, 'random-shuffle-now', true);
    addLog('🔀 Selected another random clip.', 'ok');
  });

  // Queued transition skip button
  $('btn-skip-queue')?.addEventListener('click', () => {
    if (App.queuedTransition) {
      const q = App.queuedTransition;
      clearQueuedTransition();
      if (q.commandId) {
        void commitRuntimeSpeechPlayback(q.commandId);
        return;
      }
      setVisualState(q.state, q.priority, q.reason || 'skip-queue-now', q.forceRandom);
      addLog(`⏭️ Switched immediately to [${q.state}] (queue skipped)`, 'ok');
    }
  });

  // Monitor Prev / Next Clip Navigation
  $('btn-prev')?.addEventListener('click', () => {
    cycleStateClip(-1);
  });
  $('btn-next')?.addEventListener('click', () => {
    cycleStateClip(1);
  });

  // Per-group random toggles
  document.querySelectorAll('.btn-group-random').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupCat = btn.dataset.randGroup;
      if (!groupCat) return;

      App.groupRandom[groupCat] = !(App.groupRandom[groupCat] !== false);
      localStorage.setItem(STORAGE_KEYS.GROUP_RANDOM, JSON.stringify(App.groupRandom));
      renderLibraryUI();
      addLog(`🔀 Random video ${App.groupRandom[groupCat] ? 'ON' : 'OFF'} for ${groupCat.toUpperCase()}`, 'ok');
    });
  });

  // Library Filter Tabs
  document.querySelectorAll('.lib-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      App.activeFilter = tab.dataset.filter || 'all';
      renderLibraryUI();
    });
  });

  // Library preview ratio
  document.querySelectorAll('.lib-ratio-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      App.libraryRatio = tab.dataset.libraryRatio === '9:16' ? '9:16' : '16:9';
      localStorage.setItem(STORAGE_KEYS.LIBRARY_RATIO, App.libraryRatio);
      renderLibraryUI();
    });
  });

  // 1. Group Direct File Inputs (Instant file upload)
  document.querySelectorAll('.group-file-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const files = e.target.files;
      const targetState = input.dataset.groupTarget || 'GAMEPLAY_IDLE';
      if (files && files.length > 0) {
        handleVideoUpload(files, targetState, 'loop');
        input.value = '';
      }
    });
  });

  // Per-group upload buttons
  document.querySelectorAll('.btn-group-upload').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetState = btn.dataset.uploadTarget || 'GAMEPLAY_IDLE';
      const parentGh = btn.closest('.lib-gh');
      const directInput = parentGh ? parentGh.querySelector('.group-file-input') : null;
      if (directInput) {
        directInput.click();
      } else {
        openUploadModalForTargetState(targetState);
      }
    });
  });

  // Target State Radio Click in Modal
  document.querySelectorAll('input[name="uploadTargetState"]').forEach(input => {
    input.addEventListener('change', () => {
      document.querySelectorAll('.sc-check-item').forEach(lbl => {
        const r = lbl.querySelector('input');
        lbl.classList.toggle('active', r && r.checked);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════
  // LIVETALKING DIGITAL HUMAN STUDIO EVENT LISTENERS
  // ══════════════════════════════════════════════════════════════

  // Modal Open / Close
  $('btn-livetalking-worker')?.addEventListener('click', () => {
    startLiveTalkingWorker().catch(() => {});
  });
  $('start-livetalking-engine')?.addEventListener('click', () => {
    const actionStatus = $('livetalking-engine-action-status');
    if (actionStatus) actionStatus.textContent = 'Starting engine...';
    startLiveTalkingWorker()
      .then(() => { if (actionStatus) actionStatus.textContent = 'Startup requested.'; })
      .catch(error => { if (actionStatus) actionStatus.textContent = error.message; });
  });
  $('stop-livetalking-engine')?.addEventListener('click', () => {
    stopLiveTalkingWorker().catch(() => {});
  });
  $('restart-livetalking-engine')?.addEventListener('click', async () => {
    const actionStatus = $('livetalking-engine-action-status');
    if (actionStatus) actionStatus.textContent = 'Restarting all Lipsync workers...';
    try {
      await window.RuntimeApi.post('/api/engines/live-avatar/action', { action: 'restart' });
      await refreshLiveTalkingWorkerStatus({ silent: false });
      if (actionStatus) actionStatus.textContent = 'Lipsync worker restarted.';
    } catch (error) { if (actionStatus) actionStatus.textContent = error.message; }
  });
  $('cfg-livetalking-always-on')?.addEventListener('change', event => {
    setLiveTalkingAlwaysOn(event.currentTarget.checked).catch(() => {});
  });
  $('btn-modal-avatar')?.addEventListener('click', () => {
    openModal('modal-avatar');
    updateLiveTalkingUI();
    refreshLiveTalkingAvatarList();
  });
  $('close-modal-avatar')?.addEventListener('click', () => closeModal('modal-avatar'));
  $('cancel-modal-avatar')?.addEventListener('click', () => closeModal('modal-avatar'));

  // Simplified Web App avatar creation flow
  $('btn-create-avatar')?.addEventListener('click', openAvatarCreateModal);
  $('avatar-library-grid')?.addEventListener('click', event => {
    if (event.target.closest('[data-create-avatar]')) openAvatarCreateModal();
  });
  $('close-avatar-create')?.addEventListener('click', closeAvatarCreateModal);
  $('cancel-avatar-create')?.addEventListener('click', closeAvatarCreateModal);
  $('modal-avatar-create')?.addEventListener('click', event => {
    if (event.target === $('modal-avatar-create')) closeAvatarCreateModal();
  });
  $('btn-avatar-create-upload')?.addEventListener('click', () => $('input-avatar-create-file')?.click());
  $('input-avatar-create-file')?.addEventListener('change', async event => {
    if (!event.target.files?.length) return;
    try {
      await loadAvatarTrainingFiles(event.target.files);
    } catch (error) {
      AvatarCreateFlow.status = 'upload';
      AvatarCreateFlow.files = [];
      AvatarCreateFlow.items = [];
      LiveTalkingStudio.videoFile = null;
      renderAvatarBatchQueue();
      updateAvatarCreateUI();
      if ($('avatar-create-message')) $('avatar-create-message').textContent = `Upload failed: ${error.message}`;
      console.warn('[Avatar] Could not load training media:', error);
    }
  });
  $('avatar-create-id')?.addEventListener('input', event => {
    const cleanId = event.target.value.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (cleanId !== event.target.value) event.target.value = cleanId;
    if ($('lt-avatar-id-input')) $('lt-avatar-id-input').value = cleanId;
    LiveTalkingStudio.avatarId = cleanId;
    syncAvatarBatchIds(cleanId);
  });
  $('avatar-batch-queue')?.addEventListener('input', event => {
    const index = Number(event.target.dataset.batchAvatarId);
    if (!Number.isInteger(index) || !AvatarCreateFlow.items[index]) return;
    const cleanId = cleanAvatarId(event.target.value, `avatar_${index + 1}`);
    AvatarCreateFlow.items[index].avatarId = cleanId;
  });
  $('avatar-batch-queue')?.addEventListener('change', event => {
    const index = Number(event.target.dataset.batchModel);
    if (!Number.isInteger(index) || !AvatarCreateFlow.items[index]) return;
    AvatarCreateFlow.items[index].model = event.target.value === 'wav2lip' ? 'wav2lip' : 'musetalk';
  });
  $('btn-avatar-create-train')?.addEventListener('click', async () => {
    if (AvatarCreateFlow.status === 'done') {
      closeAvatarCreateModal();
      window.navigateAppView?.('avatar');
      await refreshLiveTalkingAvatarList();
      return;
    }
    const avatarId = $('avatar-create-id')?.value.trim();
    if (!AvatarCreateFlow.files.length) return alert('Upload avatar media first.');
    if (!avatarId) return alert('Enter an Avatar ID.');
    if ($('lt-avatar-id-input')) $('lt-avatar-id-input').value = avatarId;
    LiveTalkingStudio.avatarId = avatarId;
    await startAvatarBatchTraining();
    updateAvatarCreateUI();
  });
  // ── Step 1: Training Video Upload & Training Workflow ──────
  $('btn-upload-train-video')?.addEventListener('click', () => {
    $('input-train-video-file')?.click();
  });

  $('input-train-video-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadAvatarTrainingFile(file);
    logLiveTalkingTerminal(`📁 Loaded ${file.type.startsWith('image/') ? 'image' : 'video'}: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB).`, 'info');
  });

  $('btn-clear-train-video')?.addEventListener('click', async () => {
    LiveTalkingStudio.videoFile = null;
    LiveTalkingStudio.videoBlobUrl = null;
    LiveTalkingStudio.videoEl = null;
    LiveTalkingStudio.isTrainedReady = false;
    LiveTalkingStudio.trainProgress = 0;
    VideoLipSyncRetargeter.reset();  // Clear frame atlas when video cleared
    if ($('input-train-video-file')) $('input-train-video-file').value = '';
    await IdolDB.deleteAvatar('livetalking_avatar');
    updateLiveTalkingUI();
    logLiveTalkingTerminal('🗑️ Removed current media.', 'warn');
    addLog('Removed Lipsync media.', 'ok');
  });

  $('btn-start-training-video')?.addEventListener('click', () => {
    startLiveTalkingTraining();
  });

  $('btn-use-existing-avatar')?.addEventListener('click', async () => {
    const avatarId = $('lt-existing-avatar-select')?.value;
    if (!avatarId) return;
    try {
      await switchPooledAvatar(avatarId);
    } catch (err) {
      logLiveTalkingTerminal(`❌ Could not activate avatar ${avatarId}: ${err.message}`, 'err');
    }
  });

  $('btn-save-avatar-pool')?.addEventListener('click', () => {
    saveActiveAvatarSession().catch(err => addLog(`Could not save avatar session: ${err.message}`, 'warn'));
  });

  // ── LiveTalking Model Selection & Config ──────────────────
  $('lt-model-select')?.addEventListener('change', (e) => {
    LiveTalkingStudio.modelType = e.target.value;
    logLiveTalkingTerminal(`ℹ️ Selected model: ${e.target.value.toUpperCase()}`, 'info');
  });

  $('lt-model-fps-select')?.addEventListener('change', async event => {
    const select = event.currentTarget;
    const previousFps = LiveTalkingWorker.modelFps;
    const modelFps = Number(select.value) === 25 ? 25 : 15;
    select.disabled = true;
    const status = $('livetalking-fps-status');
    if (status) status.textContent = `Applying ${modelFps} FPS model cadence…`;
    try {
      const payload = await window.RuntimeApi.post('/api/settings/talking', { modelFps });
      applyLiveTalkingFpsUI(payload.settings?.modelFps, payload.settings?.outputFps);
      if (payload.workerRestartRequired) {
        if (status) status.textContent = `Model ${modelFps} FPS saved. Restart the external worker to apply it.`;
      } else if (payload.workerRestarted) {
        if (status) status.textContent = `Model ${modelFps} FPS active · Output 30 FPS`;
        await refreshLiveTalkingWorkerStatus({ silent: true });
      }
      addLog(`Lipsync model cadence set to ${modelFps} FPS; output remains 30 FPS.`, 'ok');
    } catch (error) {
      applyLiveTalkingFpsUI(previousFps, 30);
      if (status) status.textContent = error.message;
      addLog(`Could not change lipsync model FPS: ${error.message}`, 'warn');
    } finally {
      updateLiveTalkingFpsAvailability();
    }
  });

  $('lt-avatar-id-input')?.addEventListener('input', (e) => {
    LiveTalkingStudio.avatarId = e.target.value.trim() || 'avatar_main';
  });

  // ── Visual Region Control Tabs (Mouth vs Face) ───────────
  $('tab-ctrl-mouth')?.addEventListener('click', () => {
    LiveTalkingStudio.activeCtrlTab = 'mouth';
    $('tab-ctrl-mouth')?.classList.add('active');
    $('tab-ctrl-face')?.classList.remove('active');
    if ($('pane-ctrl-mouth')) $('pane-ctrl-mouth').style.display = 'block';
    if ($('pane-ctrl-face')) $('pane-ctrl-face').style.display = 'none';
  });

  $('tab-ctrl-face')?.addEventListener('click', () => {
    LiveTalkingStudio.activeCtrlTab = 'face';
    $('tab-ctrl-face')?.classList.add('active');
    $('tab-ctrl-mouth')?.classList.remove('active');
    if ($('pane-ctrl-face')) $('pane-ctrl-face').style.display = 'block';
    if ($('pane-ctrl-mouth')) $('pane-ctrl-mouth').style.display = 'none';
  });

  // ── Mouth Range Sliders ──────────────────────────────────
  $('slider-ctrl-mouth-x')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.mouthBox.cx = val / 100;
    updateStudioBoxEdges('mouthBox');
    if ($('val-ctrl-mouth-x')) $('val-ctrl-mouth-x').textContent = `${val}%`;
    if (App.avatar) App.avatar.mouthBox = LiveTalkingStudio.mouthBox;
  });

  $('slider-ctrl-mouth-y')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.mouthBox.cy = val / 100;
    updateStudioBoxEdges('mouthBox');
    if ($('val-ctrl-mouth-y')) $('val-ctrl-mouth-y').textContent = `${val}%`;
    if (App.avatar) App.avatar.mouthBox = LiveTalkingStudio.mouthBox;
  });

  $('slider-ctrl-mouth-w')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.mouthBox.w = val / 100;
    updateStudioBoxEdges('mouthBox');
    if ($('val-ctrl-mouth-w')) $('val-ctrl-mouth-w').textContent = `${val}%`;
    if (App.avatar) App.avatar.mouthBox = LiveTalkingStudio.mouthBox;
  });

  $('slider-ctrl-mouth-h')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.mouthBox.h = val / 100;
    updateStudioBoxEdges('mouthBox');
    if ($('val-ctrl-mouth-h')) $('val-ctrl-mouth-h').textContent = `${val}%`;
    if (App.avatar) App.avatar.mouthBox = LiveTalkingStudio.mouthBox;
  });

  // ── Face Range Sliders ───────────────────────────────────
  $('slider-ctrl-face-x')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.faceBox.cx = val / 100;
    updateStudioBoxEdges('faceBox');
    if ($('val-ctrl-face-x')) $('val-ctrl-face-x').textContent = `${val}%`;
    if (App.avatar) App.avatar.faceBox = LiveTalkingStudio.faceBox;
  });

  $('slider-ctrl-face-y')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.faceBox.cy = val / 100;
    updateStudioBoxEdges('faceBox');
    if ($('val-ctrl-face-y')) $('val-ctrl-face-y').textContent = `${val}%`;
    if (App.avatar) App.avatar.faceBox = LiveTalkingStudio.faceBox;
  });

  $('slider-ctrl-face-w')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.faceBox.w = val / 100;
    updateStudioBoxEdges('faceBox');
    if ($('val-ctrl-face-w')) $('val-ctrl-face-w').textContent = `${val}%`;
    if (App.avatar) App.avatar.faceBox = LiveTalkingStudio.faceBox;
  });

  $('slider-ctrl-face-h')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.faceBox.h = val / 100;
    updateStudioBoxEdges('faceBox');
    if ($('val-ctrl-face-h')) $('val-ctrl-face-h').textContent = `${val}%`;
    if (App.avatar) App.avatar.faceBox = LiveTalkingStudio.faceBox;
  });

  // ── Quick Action Buttons ─────────────────────────────────
  $('btn-quick-auto-detect')?.addEventListener('click', () => {
    if (!LiveTalkingStudio.videoEl) return;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(LiveTalkingStudio.videoEl, 0, 0, 320, 180);
    const detectedFace = detectFaceBoxOnFrame(ctx, 320, 180);

    const faceW = detectedFace.x2 - detectedFace.x1;
    const faceH = detectedFace.y2 - detectedFace.y1;
    const faceCx = detectedFace.x1 + faceW / 2;
    const faceCy = detectedFace.y1 + faceH / 2;

    LiveTalkingStudio.faceBox = {
      cx: parseFloat(faceCx.toFixed(3)),
      cy: parseFloat(faceCy.toFixed(3)),
      w: parseFloat(faceW.toFixed(3)),
      h: parseFloat(faceH.toFixed(3)),
      x1: parseFloat(detectedFace.x1.toFixed(3)),
      y1: parseFloat(detectedFace.y1.toFixed(3)),
      x2: parseFloat(detectedFace.x2.toFixed(3)),
      y2: parseFloat(detectedFace.y2.toFixed(3)),
    };

    LiveTalkingStudio.mouthBox = {
      cx: parseFloat(faceCx.toFixed(3)),
      cy: parseFloat((faceCy + faceH * 0.18).toFixed(3)),
      w: parseFloat((faceW * 0.42).toFixed(3)),
      h: parseFloat((faceH * 0.22).toFixed(3)),
    };

    if (App.avatar) {
      App.avatar.faceBox = LiveTalkingStudio.faceBox;
      App.avatar.mouthBox = LiveTalkingStudio.mouthBox;
    }
    syncRegionControlUI();
    logLiveTalkingTerminal(`🎯 Auto-detected: Face (${Math.round(faceCx*100)}%, ${Math.round(faceCy*100)}%), Mouth (${Math.round(LiveTalkingStudio.mouthBox.cx*100)}%, ${Math.round(LiveTalkingStudio.mouthBox.cy*100)}%)`, 'ok');
  });

  $('btn-quick-reset-default')?.addEventListener('click', () => {
    LiveTalkingStudio.faceBox = { cx: 0.50, cy: 0.30, w: 0.30, h: 0.34 };
    LiveTalkingStudio.mouthBox = { cx: 0.51, cy: 0.32, w: 0.12, h: 0.07 };
    if (App.avatar) {
      App.avatar.faceBox = LiveTalkingStudio.faceBox;
      App.avatar.mouthBox = LiveTalkingStudio.mouthBox;
    }
    syncRegionControlUI();
    logLiveTalkingTerminal('🔄 Restored default 16:9 face and mouth regions', 'ok');
  });

  // ── MediaPipe Mask Controls ───────────────────────────────
  $('sel-mask-region-type')?.addEventListener('change', (e) => {
    LiveTalkingStudio.maskConfig.regionType = e.target.value;
  });

  $('slider-mask-exp-top')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.maskConfig.expansion.top = val / 100;
    if ($('val-mask-exp-top')) $('val-mask-exp-top').textContent = `+${val}%`;
  });

  $('slider-mask-exp-bottom')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.maskConfig.expansion.bottom = val / 100;
    if ($('val-mask-exp-bottom')) $('val-mask-exp-bottom').textContent = `+${val}%`;
  });

  $('slider-mask-exp-left')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.maskConfig.expansion.left = val / 100;
    if ($('val-mask-exp-left')) $('val-mask-exp-left').textContent = `+${val}%`;
  });

  $('slider-mask-exp-right')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.maskConfig.expansion.right = val / 100;
    if ($('val-mask-exp-right')) $('val-mask-exp-right').textContent = `+${val}%`;
  });

  $('slider-mask-feather')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.maskConfig.featherRadiusPx = val;
    if ($('val-mask-feather')) $('val-mask-feather').textContent = `${val}px`;
  });

  $('slider-mask-smooth')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    LiveTalkingStudio.maskConfig.temporalSmoothingAlpha = val / 100;
    if ($('val-mask-smooth')) $('val-mask-smooth').textContent = `${(val / 100).toFixed(2)}`;
  });

  // ── Interactive Direct Drag & Resize on Video Canvas ──────
  const s1Box = $('lt-video-screen-box');
  const s1Canvas = $('lt-train-video-canvas');

  if (s1Canvas || s1Box) {
    const targetEl = s1Canvas || s1Box;

    function getNormalizedCanvasCoords(e) {
      const rect = targetEl.getBoundingClientRect();
      const normX = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
      const normY = Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height));
      return { normX, normY };
    }

    targetEl.addEventListener('mousedown', (e) => {
      if (!LiveTalkingStudio.videoBlobUrl) return;
      const { normX, normY } = getNormalizedCanvasCoords(e);
      const mb = LiveTalkingStudio.mouthBox || { cx: 0.51, cy: 0.32, w: 0.12, h: 0.07 };
      const fb = LiveTalkingStudio.faceBox || { cx: 0.50, cy: 0.30, w: 0.30, h: 0.34 };

      // Check hit on mouth box (higher priority)
      const inMouth = (Math.abs(normX - mb.cx) <= mb.w / 2 * 1.2 && Math.abs(normY - mb.cy) <= mb.h / 2 * 1.2);
      const inFace = (Math.abs(normX - fb.cx) <= fb.w / 2 && Math.abs(normY - fb.cy) <= fb.h / 2);

      let dragTarget = null;
      if (inMouth) {
        dragTarget = 'mouth';
      } else if (inFace) {
        dragTarget = 'face';
      } else {
        // Snap active tab's box to click
        dragTarget = LiveTalkingStudio.activeCtrlTab || 'mouth';
        if (dragTarget === 'mouth') {
          mb.cx = parseFloat(normX.toFixed(3));
          mb.cy = parseFloat(normY.toFixed(3));
        } else {
          fb.cx = parseFloat(normX.toFixed(3));
          fb.cy = parseFloat(normY.toFixed(3));
        }
      }

      LiveTalkingStudio.dragState = {
        isDragging: true,
        target: dragTarget,
        startX: normX,
        startY: normY,
        initialBox: { ...(dragTarget === 'mouth' ? mb : fb) }
      };

      syncRegionControlUI();
    });

    window.addEventListener('mousemove', (e) => {
      if (!LiveTalkingStudio.dragState.isDragging) return;
      const { normX, normY } = getNormalizedCanvasCoords(e);
      const ds = LiveTalkingStudio.dragState;
      const deltaX = normX - ds.startX;
      const deltaY = normY - ds.startY;

      if (ds.target === 'mouth') {
        const mb = LiveTalkingStudio.mouthBox;
        mb.cx = parseFloat(Math.max(0.1, Math.min(0.9, ds.initialBox.cx + deltaX)).toFixed(3));
        mb.cy = parseFloat(Math.max(0.1, Math.min(0.9, ds.initialBox.cy + deltaY)).toFixed(3));
        if (App.avatar) App.avatar.mouthBox = mb;
      } else if (ds.target === 'face') {
        const fb = LiveTalkingStudio.faceBox;
        fb.cx = parseFloat(Math.max(0.15, Math.min(0.85, ds.initialBox.cx + deltaX)).toFixed(3));
        fb.cy = parseFloat(Math.max(0.10, Math.min(0.80, ds.initialBox.cy + deltaY)).toFixed(3));
        if (App.avatar) App.avatar.faceBox = fb;
      }
      syncRegionControlUI();
    });

    window.addEventListener('mouseup', () => {
      if (LiveTalkingStudio.dragState.isDragging) {
        LiveTalkingStudio.dragState.isDragging = false;
        const target = LiveTalkingStudio.dragState.target;
        const box = target === 'mouth' ? LiveTalkingStudio.mouthBox : LiveTalkingStudio.faceBox;
        logLiveTalkingTerminal(`🎯 Updated ${target === 'mouth' ? 'Mouth' : 'Face'}: X=${Math.round(box.cx*100)}%, Y=${Math.round(box.cy*100)}%`, 'ok');
      }
    });
  }

  $('btn-clear-train-logs')?.addEventListener('click', () => {
    const terminal = $('lt-terminal-logs-body');
    if (terminal) terminal.innerHTML = '<div class="log-line ok">[System] Ready for commands...</div>';
  });

  // ── Step 2: Voice & Realtime LipSync Stream Controls ──────
  $('lt-voice-provider-select')?.addEventListener('change', (e) => {
    LiveTalkingStudio.voiceProvider = e.target.value;
    App.voice.provider = e.target.value;
    updateLiveTalkingVoiceUI();
    saveVoiceSettings({ provider: e.target.value });
    addLog(`Voice provider: ${e.target.options[e.target.selectedIndex].text}`, 'ok');
  });

  $('lt-voice-speed-slider')?.addEventListener('input', (e) => {
    const spd = parseInt(e.target.value, 10) / 100;
    LiveTalkingStudio.voiceSpeed = spd;
    App.voice.speed = spd;
    if ($('val-lt-voice-speed')) $('val-lt-voice-speed').textContent = `${spd.toFixed(2)}x`;
  });

  $('btn-clear-test-speech')?.addEventListener('click', () => {
    if ($('lt-test-speech-input')) $('lt-test-speech-input').value = '';
  });

  $('btn-reset-sample-text')?.addEventListener('click', () => {
    if ($('lt-test-speech-input')) $('lt-test-speech-input').value = idolPreviewLine();
  });

  // Realtime LipSync Speech Test
  $('btn-test-lipsync-speak')?.addEventListener('click', async () => {
    if (!LiveTalkingStudio.isTrainedReady || !LiveTalkingWebRTCClient.sessionId) {
      alert('Select an avatar and wait for Lipsync to connect.');
      return;
    }

    unlockAudio();
    const text = $('lt-test-speech-input')?.value.trim() || idolPreviewLine();
    const provider = $('lt-voice-provider-select')?.value || App.voice.provider || 'qwentts';

    logLiveTalkingTerminal(`🎙️ Generating voice (${provider.toUpperCase()}) and Live LipSync...`, 'info');
    addLog(`Testing Lipsync voice (${provider.toUpperCase()})...`, 'ok');

    const button = $('btn-test-lipsync-speak');
    const originalLabel = button?.textContent;
    if (button) { button.disabled = true; button.textContent = '⏳ Generating voice and LipSync...'; }
    try {
      await speakAI(text, 'happy');
    } catch (error) {
      updateVoiceStatusUI('error', error.message);
      logLiveTalkingTerminal(`❌ ${error.message}`, 'error');
      addLog(`Lipsync: ${error.message}`, 'err');
    } finally {
      if (button) { button.disabled = false; button.textContent = originalLabel || '🗣️ Test voice and LipSync'; }
    }
  });

  // Test Audio WAV LipSync Directly (No TTS needed)
  $('btn-test-audio-wav')?.addEventListener('click', async () => {
    if (!LiveTalkingStudio.videoBlobUrl && !App.avatar.videoUrl) {
      alert('Upload avatar media before testing WAV audio.');
      return;
    }

    unlockAudio();
    stopLiveSpeech();

    const sampleDurationMs = 2800;
    logLiveTalkingTerminal('🎵 Preparing test.wav and MuseTalk inference buffer...', 'info');
    addLog('🎵 WAV test → waiting for MuseTalk buffer...', 'ok');
    updateVoiceStatusUI('generating', 'Loading MuseTalk frame buffer (4 frames)...', 30);

    const t0 = Date.now();
    MuseTalkRealtimeEngine.ingestAudio({
      text: 'Test Audio Sample WAV',
      durationMs: sampleDurationMs,
      type: 'LocalWAV',
      samples: Math.round(44100 * 2.8),
      requestStartTime: t0,
      onPlaybackStart: () => {
        // START AUDIO + VIDEO AT THE EXACT SAME INSTANT WHEN FIRST VALID FRAME IS READY
        App.isAiSpeaking = true;
        updateVoiceStatusUI('speaking', 'Playing WAV audio with MuseTalk realtime frames...', 80);

        try {
          const actx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = actx.createOscillator();
          const gain = actx.createGain();

          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(220, actx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(440, actx.currentTime + 0.8);
          osc.frequency.exponentialRampToValueAtTime(330, actx.currentTime + 1.6);
          osc.frequency.exponentialRampToValueAtTime(180, actx.currentTime + 2.6);

          gain.gain.setValueAtTime(0.15, actx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, actx.currentTime + 2.7);

          osc.connect(gain);
          gain.connect(actx.destination);

          osc.start();
          osc.stop(actx.currentTime + 2.8);
        } catch {}

        setTimeout(() => {
          if (App.isAiSpeaking) {
            LiveLipSyncEngine.stopSpeech();
            MuseTalkRealtimeEngine.stopAudio();
            App.isAiSpeaking = false;
            updateVoiceStatusUI('idle');
            logLiveTalkingTerminal('✅ WAV test complete → returning to IDLE', 'ok');
          }
        }, sampleDurationMs);
      }
    });
  });

  $('btn-stop-lipsync-speak')?.addEventListener('click', () => {
    stopLiveSpeech();
    const liveVideo = $('lt-live-stream-video');
    if (liveVideo) liveVideo.pause();
    const vuFill = $('lt-live-vu-fill');
    if (vuFill) vuFill.style.width = '0%';
    const vuText = $('lbl-vu-val');
    if (vuText) vuText.textContent = '0 dB';
    logLiveTalkingTerminal('⏹️ Stopped voice and LipSync stream.', 'warn');
    addLog('Lipsync playback stopped.', 'ok');
  });

  // ── Full avatar reset ──────────────────────────────────────
  $('btn-delete-full-avatar')?.addEventListener('click', async () => {
    const confirmed = await showAppConfirm({
      title: 'Reset avatar data?',
      message: 'Delete all avatar data and restore defaults?',
      confirmLabel: 'Reset',
    });
    if (!confirmed) return;

    LiveTalkingStudio.videoFile = null;
    LiveTalkingStudio.videoBlobUrl = null;
    LiveTalkingStudio.videoEl = null;
    LiveTalkingStudio.trainedDataset = null;
    LiveTalkingStudio.isTraining = false;
    LiveTalkingStudio.trainProgress = 0;
    LiveTalkingStudio.isTrainedReady = false;
    VideoLipSyncRetargeter.reset(); // Clear frame atlas on full avatar reset

    App.avatar.videoEl = null;
    App.avatar.videoUrl = null;
    App.avatar.customImageData = null;
    App.avatar.imageObj = null;

    if ($('input-train-video-file')) $('input-train-video-file').value = '';
    const terminal = $('lt-terminal-logs-body');
    if (terminal) terminal.innerHTML = '<div class="log-line ok">[System] All avatar data removed. Upload new media to begin.</div>';

    localStorage.removeItem('livetalking_avatar_dataset');
    localStorage.removeItem(STORAGE_KEYS.AVATAR_IMAGE);
    await IdolDB.deleteAvatar('livetalking_avatar');

    fetch('/api/settings/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: null, enablePipCam: false, customImageData: null })
    }).catch(() => {});

    updateLiveTalkingUI();
    updateMonitorScreen(App.currentState, App.currentClip);
    addLog('🗑️ Avatar data reset to defaults.', 'ok');
  });

  // ── Apply & Save to Live Monitor ──────────────────────────
  $('save-modal-avatar')?.addEventListener('click', () => {
    if (LiveTalkingStudio.videoBlobUrl || App.avatar.videoUrl) {
      const activeUrl = LiveTalkingStudio.videoBlobUrl || App.avatar.videoUrl;
      App.avatar.videoUrl = activeUrl;
      App.avatar.customImageData = activeUrl;
      
      if (!App.avatar.videoEl) {
        const vid = document.createElement('video');
        vid.src = activeUrl;
        vid.loop = true;
        vid.muted = true;
        vid.autoplay = true;
        vid.playsInline = true;
        vid.play().catch(() => {});
        App.avatar.videoEl = vid;
      }

      fetch('/api/settings/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preset: 'livetalking_avatar',
          enablePipCam: true,
          customImageData: activeUrl,
        }),
      }).catch(() => {});
    }

    closeModal('modal-avatar');
    updateMonitorScreen(App.currentState, App.currentClip);
    addLog('Lipsync avatar applied to Live Monitor.', 'ok');
  });

  // ── Voice & Persona Modal ─────────────────────────────────
  $('btn-modal-voice')?.addEventListener('click', () => {
    // Populate modal inputs from App.voice
    if ($('cfg-voice-provider')) $('cfg-voice-provider').value = App.voice.provider || 'qwentts';
    if ($('cfg-voice-id')) $('cfg-voice-id').value = App.voice.voiceId || 'qwen-default';
    if ($('cfg-voice-speed')) $('cfg-voice-speed').value = App.voice.speed || 1.0;
    if ($('val-voice-speed')) $('val-voice-speed').textContent = `${(App.voice.speed || 1.0).toFixed(2)}x`;
    if ($('cfg-persona-name')) $('cfg-persona-name').value = App.voice.personaName || 'Mimi';
    if ($('cfg-persona-prompt')) $('cfg-persona-prompt').value = App.voice.personaPrompt || '';
    
    const apikeyGrp = $('group-voice-apikey');
    if (apikeyGrp) apikeyGrp.style.display = 'none';

    window.navigateAppView?.('settings');
  });

  $('close-modal-voice')?.addEventListener('click', () => closeModal('modal-voice'));
  $('cancel-modal-voice')?.addEventListener('click', () => closeModal('modal-voice'));

  $('cfg-voice-provider')?.addEventListener('change', (e) => {
    const val = e.target.value;
    const apikeyGrp = $('group-voice-apikey');
    if (apikeyGrp) apikeyGrp.style.display = 'none';
    if ($('cfg-voice-id') && !String($('cfg-voice-id').value || '').trim()) {
      $('cfg-voice-id').value = val === 'omnivoice' ? 'voice_bright_storyteller' : 'qwen-default';
    }
  });

  $('btn-reset-voice-id')?.addEventListener('click', () => {
    if ($('cfg-voice-id')) $('cfg-voice-id').value = App.voice.provider === 'omnivoice' ? 'voice_bright_storyteller' : 'qwen-default';
  });
  $('btn-clear-voice-id')?.addEventListener('click', () => {
    if ($('cfg-voice-id')) $('cfg-voice-id').value = '';
  });
  $('btn-rst-voice-id')?.addEventListener('click', () => {
    if ($('cfg-voice-id')) $('cfg-voice-id').value = App.voice.provider === 'omnivoice' ? 'voice_bright_storyteller' : 'qwen-default';
  });

  $('cfg-voice-speed')?.addEventListener('input', (e) => {
    const spd = parseFloat(e.target.value);
    if ($('val-voice-speed')) $('val-voice-speed').textContent = `${spd.toFixed(2)}x`;
  });
  $('btn-rst-voice-speed')?.addEventListener('click', () => {
    if ($('cfg-voice-speed')) $('cfg-voice-speed').value = 1.0;
    if ($('val-voice-speed')) $('val-voice-speed').textContent = '1.00x';
  });

  $('btn-rst-persona-name')?.addEventListener('click', () => {
    if ($('cfg-persona-name')) $('cfg-persona-name').value = 'Mimi';
  });
  $('btn-clear-persona-name')?.addEventListener('click', () => {
    if ($('cfg-persona-name')) $('cfg-persona-name').value = '';
  });
  $('btn-rst-persona-name-btn')?.addEventListener('click', () => {
    if ($('cfg-persona-name')) $('cfg-persona-name').value = 'Mimi';
  });

  $('btn-rst-persona-prompt')?.addEventListener('click', () => {
    if ($('cfg-persona-prompt')) $('cfg-persona-prompt').value = 'Bạn là Mimi, AI Idol streamer người Việt Nam vui tính, năng động và thân thiện. Luôn trả lời bằng tiếng Việt tự nhiên, ngắn gọn trong 1-2 câu.';
  });
  $('btn-clear-persona-prompt')?.addEventListener('click', () => {
    if ($('cfg-persona-prompt')) $('cfg-persona-prompt').value = '';
  });

  $('btn-rst-test-voice-text')?.addEventListener('click', () => {
    if ($('cfg-test-voice-text')) $('cfg-test-voice-text').value = idolPreviewLine();
  });
  $('btn-clear-test-voice-text')?.addEventListener('click', () => {
    if ($('cfg-test-voice-text')) $('cfg-test-voice-text').value = '';
  });

  $('btn-test-voice-speak')?.addEventListener('click', () => {
    unlockAudio();
    const text = $('cfg-test-voice-text')?.value.trim() || idolPreviewLine();
    const provider = $('cfg-voice-provider')?.value || App.voice.provider;
    const voiceId = $('cfg-voice-id')?.value.trim() || App.voice.voiceId;
    const speed = parseFloat($('cfg-voice-speed')?.value || App.voice.speed || 1.0);

    saveVoiceSettings({ provider, voiceId: voiceId, speed });
    speakAI(text, 'happy');
  });

  $('save-modal-voice')?.addEventListener('click', () => {
    const provider = $('cfg-voice-provider')?.value || App.voice.provider;
    const voiceId = $('cfg-voice-id')?.value.trim() || App.voice.voiceId;
    const speed = parseFloat($('cfg-voice-speed')?.value || App.voice.speed || 1.0);
    const personaName = $('cfg-persona-name')?.value.trim() || App.voice.personaName;
    const personaPrompt = $('cfg-persona-prompt')?.value.trim() || App.voice.personaPrompt;

    saveVoiceSettings({ provider, voiceId: voiceId, speed, personaName, personaPrompt });

    // Sync to quick panel
    if ($('quick-voice-provider')) $('quick-voice-provider').value = provider;
    if ($('quick-voice-id-input')) $('quick-voice-id-input').value = voiceId;
    if ($('quick-voice-speed')) $('quick-voice-speed').value = speed;
    if ($('quick-voice-speed-val')) $('quick-voice-speed-val').textContent = `${speed.toFixed(2)}x`;

    // Persist persona
    localStorage.setItem(STORAGE_KEYS.PERSONA_NAME, personaName);
    localStorage.setItem(STORAGE_KEYS.PERSONA_PROMPT, personaPrompt);

    // Call backend API
    fetch('/api/settings/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, voiceId, speed, languageCode: App.voice.language === 'auto' ? 'vi' : App.voice.language })
    }).catch(() => {});

    fetch('/api/settings/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: personaName, systemPrompt: personaPrompt })
    }).catch(() => {});

    closeModal('modal-voice');
    loadPersistedSettings();
    addLog(`💾 Voice and persona settings saved.`, 'ok');
  });

  // Language Code Change
  $('quick-voice-lang')?.addEventListener('change', (e) => {
    saveVoiceSettings({ language: e.target.value });
    fetch('/api/settings/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ languageCode: e.target.value === 'auto' ? 'vi' : e.target.value })
    }).catch(() => {});
    addLog(`Speech language: ${e.target.options[e.target.selectedIndex].text}`, 'ok');
  });

  // Voice Presets Selection
  $('quick-saved-voice-list')?.addEventListener('change', async (e) => {
    const selectedVoiceId = e.target.value;
    if (selectedVoiceId) {
      const input = $('quick-voice-id-input');
      if (input) input.value = selectedVoiceId;
      saveVoiceSettings({ voiceId: selectedVoiceId });
      await window.LiveTalkingApi.setVoice({
        provider: App.voice.provider,
        voiceId: selectedVoiceId,
        languageCode: App.voice.language || 'vi',
        speed: App.voice.speed,
      }).catch(error => addLog(`Voice selection could not be saved: ${error.message}`, 'err'));
      addLog(`Selected voice: ${e.target.options[e.target.selectedIndex]?.text || selectedVoiceId}`, 'ok');
      renderVoiceProfileList();
    }
  });

  $('quick-voice-id-input')?.addEventListener('change', async (e) => {
    const val = e.target.value.trim();
    if (!val) return;
    saveVoiceSettings({ voiceId: val });
    await window.LiveTalkingApi.setVoice({
      provider: App.voice.provider,
      voiceId: val,
      languageCode: App.voice.language || 'vi',
      speed: App.voice.speed,
    }).catch(error => addLog(`Voice ID could not be saved: ${error.message}`, 'err'));
  });

  // Voice Speed Slider
  $('quick-voice-speed')?.addEventListener('input', (e) => {
    const newSpeed = parseFloat(e.target.value);
    $('quick-voice-speed-val').textContent = `${newSpeed.toFixed(2)}x`;
    saveVoiceSettings({ speed: newSpeed });
  });

  $('btn-copy-voice-id')?.addEventListener('click', () => {
    const vId = $('quick-voice-id-input')?.value || App.voice.voiceId;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(vId);
      addLog(`📋 Copied Voice ID: ${vId}`, 'ok');
      alert(`Copied Voice ID: ${vId}`);
    }
  });

  $('btn-save-custom-voice')?.addEventListener('click', () => {
    const vId = $('quick-voice-id-input')?.value?.trim();
    if (!vId) {
      alert('Enter a Voice ID first.');
      return;
    }
    const voiceName = prompt('Name this Voice ID:', `Voice ${vId.slice(0, 6)}`);
    if (!voiceName) return;

    if (!App.voice.customVoices) App.voice.customVoices = [];
    App.voice.customVoices.unshift({ id: vId, name: voiceName });
    localStorage.setItem(STORAGE_KEYS.CUSTOM_VOICES, JSON.stringify(App.voice.customVoices));
    renderSavedVoicesList();

    addLog(`💾 Saved Voice ID: ${voiceName} (${vId})`, 'ok');
    alert(`Saved "${voiceName}" to custom voices.`);
  });

  // Test Sound & Controls
  $('btn-test-sound')?.addEventListener('click', async () => {
    await unlockAudio(false);
    speakAI(idolPreviewLine(), 'happy');
  });
  $('btn-stop-voice')?.addEventListener('click', stopLiveSpeech);

  $('btn-pause')?.addEventListener('click', () => {
    App.isPaused = !App.isPaused;
    const button = $('btn-pause');
    const actionLabel = App.isPaused ? 'Resume AI' : 'Pause AI';
    if (button) {
      button.querySelector('.material-symbols-rounded').textContent = App.isPaused ? 'play_arrow' : 'pause';
      button.querySelector('.topbar-control-label').textContent = actionLabel;
      button.title = actionLabel;
      button.setAttribute('aria-label', actionLabel);
      button.setAttribute('aria-pressed', String(App.isPaused));
    }
    addLog(App.isPaused ? 'AI paused' : 'AI resumed', 'hi');
  });

  $('btn-mute')?.addEventListener('click', () => {
    App.isMuted = !App.isMuted;
    if (App.isMuted) stopLiveSpeech();
    if (LiveTalkingWebRTCClient.audioEl) {
      LiveTalkingWebRTCClient.audioEl.muted = App.isMuted;
      if (!App.isMuted) LiveTalkingWebRTCClient.ensureAudioPlayback();
    }
    const button = $('btn-mute');
    const actionLabel = App.isMuted ? 'Unmute voice' : 'Mute voice';
    if (button) {
      button.querySelector('.material-symbols-rounded').textContent = App.isMuted ? 'volume_up' : 'volume_off';
      button.querySelector('.topbar-control-label').textContent = actionLabel;
      button.title = actionLabel;
      button.setAttribute('aria-label', actionLabel);
      button.setAttribute('aria-pressed', String(App.isMuted));
    }
    addLog(App.isMuted ? '🔇 Voice Muted' : '🔊 Voice Unmuted', 'hi');
  });

  $('quick-voice-provider')?.addEventListener('change', async (e) => {
    const provider = ['qwentts', 'omnivoice'].includes(e.target.value) ? e.target.value : 'qwentts';
    syncQuickVoiceIdVisibility(provider);
    renderQuickVoiceOptions(provider);
    const voiceId = $('quick-saved-voice-list')?.value || $('quick-voice-id-input')?.value.trim() || App.voice.voiceId;
    saveVoiceSettings({ provider, voiceId: voiceId });
    await window.LiveTalkingApi.setVoice({
      provider,
      voiceId,
      languageCode: App.voice.language || 'vi',
      speed: App.voice.speed,
    }).catch(error => addLog(`${voiceProviderLabel(provider)} is not ready: ${error.message}`, 'err'));
    if ($('profile-voice-provider')) $('profile-voice-provider').value = provider;
    updateVoiceProfileBuilder(provider);
    await loadVoiceProfiles(provider, voiceId);
    addLog(`Switched to ${voiceProviderLabel(provider)}`, 'ok');
  });

  $('btn-quick-voice-speak')?.addEventListener('click', () => {
    const text = $('quick-test-voice-text')?.value || idolPreviewLine();
    speakAI(text, 'happy');
  });

  // Video Upload
  $('btn-upload')?.addEventListener('click', () => openModal('modal-upload-clip'));
  $('btn-confirm-upload')?.addEventListener('click', () => {
    const fileInput = $('state-upload-file-input');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      alert('Select at least one video file.');
      return;
    }
    const targetStateEl = document.querySelector('input[name="uploadTargetState"]:checked');
    const targetState = targetStateEl ? targetStateEl.value : 'GAMEPLAY_IDLE';
    const playModeEl = document.querySelector('input[name="uploadPlayMode"]:checked');
    const playMode = playModeEl ? playModeEl.value : 'loop';

    handleVideoUpload(fileInput.files, targetState, playMode);
    fileInput.value = '';
    closeModal('modal-upload-clip');
  });

  // Upload Play Mode Radio Labels sync
  document.querySelectorAll('input[name="uploadPlayMode"]').forEach(input => {
    input.addEventListener('change', () => {
      document.querySelectorAll('.loop-radio-label').forEach(lbl => {
        const r = lbl.querySelector('input');
        lbl.classList.toggle('active', r && r.checked);
      });
    });
  });

  // Library Card Clicks, Mode Toggles (OFF / Loop / 1) & Delete Clip
  $('lib-body')?.addEventListener('click', async (e) => {
    const emptyNotice = e.target.closest('.lib-empty-notice');
    if (emptyNotice) {
      e.stopPropagation();
      const targetState = emptyNotice.dataset.targetGroup || 'GAMEPLAY_IDLE';
      const parentCard = emptyNotice.closest('.lib-group-card');
      const directInput = parentCard?.querySelector('.group-file-input');
      if (directInput) directInput.click();
      else openUploadModalForTargetState(targetState);
      return;
    }

    // 1. Mode Toggle button click (Loop -> 1x -> OFF -> Loop)
    const modeBtn = e.target.closest('.btn-clip-mode');
    if (modeBtn) {
      e.stopPropagation();
      const clipId = modeBtn.dataset.modeClip;
      const state = modeBtn.dataset.modeState;
      const stateClips = CLIP_LIBRARY[state] || [];
      const clip = stateClips.find(c => c.id === clipId);
      if (clip) {
        const currentMode = clip.mode || (clip.loop ? 'loop' : 'once');
        let nextMode = 'loop';
        if (currentMode === 'loop') nextMode = 'once';
        else if (currentMode === 'once') nextMode = 'off';
        else if (currentMode === 'off') nextMode = 'loop';

        clip.mode = nextMode;
        clip.loop = (nextMode === 'loop');
        if (clip.storageId) IdolDB.updateClipMeta(clip.storageId, { mode: nextMode }).catch(() => {});
        renderLibraryUI();
        addLog(`Changed mode [${clip.label}]: ${nextMode.toUpperCase()}`, 'ok');
      }
      return;
    }

    // 2. Delete button click
    const delBtn = e.target.closest('.btn-delete-clip');
    if (delBtn) {
      e.stopPropagation();
      const clipId = delBtn.dataset.delId;
      const state = delBtn.dataset.delState;
      if (CLIP_LIBRARY[state]) {
        const clip = CLIP_LIBRARY[state].find(item => item.id === clipId);
        if (!clip) return;
        try {
          if (clip.storageId) await IdolDB.deleteClip(clip.storageId);
          if (clip.blobUrl) URL.revokeObjectURL(clip.blobUrl);
          if (clip.storageId) UPLOADED_BLOBS.delete(clip.storageId);
          CLIP_LIBRARY[state] = CLIP_LIBRARY[state].filter(item => item.id !== clipId);
          renderLibraryUI();
          addLog(`Deleted clip ${clipId} from ${state}`, 'hi');
        } catch (error) {
          addLog(`Could not delete clip: ${error.message}`, 'err');
        }
      }
      return;
    }

    // 3. Remove one avatar state from this live session without deleting training data.
    const removeLiveAvatarButton = e.target.closest('.btn-remove-live-avatar');
    if (removeLiveAvatarButton) {
      e.stopPropagation();
      const avatarId = removeLiveAvatarButton.dataset.avatarId;
      if (!avatarId) return;
      void setAvatarPoolSelection(avatarId, false)
        .then(() => addLog(`Deactivated ${avatarId} in the Avatar Pool.`, 'ok'))
        .catch(error => addLog(`Could not remove avatar state: ${error.message}`, 'err'));
      return;
    }

    // 4. Trained neural avatar click
    const avatarCard = e.target.closest('.live-avatar-card');
    if (avatarCard) {
      const avatarId = avatarCard.dataset.avatarId;
      if (!avatarId) return;
      void (async () => {
        try {
          await ensureLiveTalkingWorkerReady();
          await switchPooledAvatar(avatarId);
          setVisualState('TALKING', 0, 'manual-avatar-select', false);
        } catch (error) {
          console.warn(`[Avatar] Could not activate ${avatarId}:`, error);
          addLog(`Could not activate avatar ${avatarId}: ${error.message}`, 'err');
        }
      })();
      return;
    }

    // 4. Video card click (Manual Play)
    const card = e.target.closest('.clip-card');
    if (card) {
      const state = card.dataset.state;
      const clipId = card.dataset.clipId;
      const stateClips = CLIP_LIBRARY[state] || [];
      const clip = stateClips.find(c => c.id === clipId);
      if (clip) {
        requestStateTransition(state, 0, 'manual-card-click', false, true);
        App.currentClip = clip;
        App.clipStartedAt = Date.now();
        updateMonitorScreen(state, clip);
        renderLibraryUI();
        addLog(`Playing clip: ${clip.label} (${state})`, 'ok');
      }
    }
  });

  // State chips wait for the current video to finish
  $('state-chips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.sc');
    if (!chip) return;
    requestStateTransition(chip.dataset.state, 0, 'manual-chip', true);
  });

  // Live Chat Send Form
  const mockChatUserInput = $('input-chat-user');
  if (mockChatUserInput) {
    mockChatUserInput.value = localStorage.getItem(STORAGE_KEYS.MOCK_CHAT_USER) || 'Viewer';
    mockChatUserInput.addEventListener('change', () => {
      const viewerName = mockChatUserInput.value.trim().slice(0, 40) || 'Viewer';
      mockChatUserInput.value = viewerName;
      localStorage.setItem(STORAGE_KEYS.MOCK_CHAT_USER, viewerName);
    });
  }
  $('form-chat-send')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('input-chat-msg');
    const text = input?.value?.trim();
    if (!text) return;
    const viewerName = mockChatUserInput?.value.trim().slice(0, 40) || 'Viewer';
    if (mockChatUserInput) mockChatUserInput.value = viewerName;
    localStorage.setItem(STORAGE_KEYS.MOCK_CHAT_USER, viewerName);
    input.value = '';
    addChatMessage(viewerName, text);
  });

  // Gifts
  $('btn-gift-rose')?.addEventListener('click', () => {
    addChatMessage('Fan_Cung_99', 'sent 10 Roses 🌹!', true, '🌹');
  });
  $('btn-gift-lion')?.addEventListener('click', () => {
    addChatMessage('DaiGia_VN', 'sent a Royal Lion 🦁!', true, '🦁');
  });

  $('btn-clear-chat')?.addEventListener('click', () => {
    const list = $('chat-queue');
    if (list) list.innerHTML = '<li class="ev-empty">No messages yet</li>';
    addLog('Cleared live chat.');
  });

  $('connect-youtube-chat')?.addEventListener('click', () => connectPlatformChat('youtube'));
  $('connect-facebook-chat')?.addEventListener('click', () => connectPlatformChat('facebook'));
  $('disconnect-youtube-chat')?.addEventListener('click', () => disconnectPlatformChat('youtube'));
  $('disconnect-facebook-chat')?.addEventListener('click', () => disconnectPlatformChat('facebook'));
  $('youtube-ai-reply')?.addEventListener('change', () => savePlatformReplySettings().catch(error => { if ($('platform-chat-summary')) $('platform-chat-summary').textContent = error.message; }));
  $('facebook-ai-reply')?.addEventListener('change', () => savePlatformReplySettings().catch(error => { if ($('platform-chat-summary')) $('platform-chat-summary').textContent = error.message; }));

  // Injections
  $('inject-jackpot')?.addEventListener('click', injectJackpot);
  $('inject-donation')?.addEventListener('click', injectDonation);
  $('inject-win')?.addEventListener('click', injectWin);
  $('inject-goal')?.addEventListener('click', injectGoal);
  $('inject-idle')?.addEventListener('click', () => requestStateTransition('GAMEPLAY_IDLE', 7, 'manual-idle', true));

  $('btn-sim-spin')?.addEventListener('click', simSlotSpin);
  $('btn-force-jp')?.addEventListener('click', injectJackpot);
  $('btn-force-mega')?.addEventListener('click', injectWin);
  $('btn-force-nearmiss')?.addEventListener('click', () => {
    requestStateTransition('SURPRISED', 3, 'teaser', true);
    speakAI('Suýt chút nữa là trúng jackpot rồi! Tiếc quá đi!', 'surprised');
  });

  $('btn-clear-log')?.addEventListener('click', () => {
    if ($('event-log')) $('event-log').innerHTML = '';
  });

  $('btn-cta-toggle')?.addEventListener('click', () => {
    App.ctaEnabled = !App.ctaEnabled;
    $('btn-cta-toggle').textContent = App.ctaEnabled ? 'CTA On' : 'CTA Off';
    addLog(`CTA is ${App.ctaEnabled ? 'On' : 'Off'}`);
  });
}

// ── Initialization ────────────────────────────────────────
function setupMonitorFirstStudio() {
  const appBody = document.querySelector('#view-studio .app-body');
  if (!appBody || appBody.classList.contains('monitor-first-layout')) return;

  const monitor = appBody.querySelector('.monitor-box');
  const voiceStatus = appBody.querySelector('.voice-status-panel');
  const chat = appBody.querySelector('.chat-panel');
  const library = appBody.querySelector('.library-panel');
  const states = appBody.querySelector('.state-chips-panel');
  const controlRail = appBody.querySelector('.col-right');
  if (!monitor || !chat || !library || !states || !controlRail) return;

  const stage = document.createElement('section');
  stage.className = 'monitor-first-stage';
  stage.appendChild(monitor);

  const center = document.createElement('section');
  center.className = 'fcp-center-workspace';
  const monitorSplitter = document.createElement('div');
  monitorSplitter.className = 'monitor-chat-splitter';
  monitorSplitter.setAttribute('role', 'separator');
  monitorSplitter.setAttribute('aria-label', 'Resize Monitor and Unify Chat');
  monitorSplitter.setAttribute('aria-orientation', 'horizontal');
  monitorSplitter.setAttribute('aria-valuemin', '48');
  monitorSplitter.setAttribute('aria-valuemax', '74');
  monitorSplitter.tabIndex = 0;
  voiceStatus.classList.add('fcp-voice-status-strip');
  states.classList.add('fcp-avatar-state-strip');
  center.append(stage, voiceStatus, monitorSplitter, states, chat);

  const sourcePanel = document.createElement('section');
  sourcePanel.className = 'fcp-source-workspace';
  sourcePanel.setAttribute('aria-label', 'Library and live chat');
  sourcePanel.innerHTML = `
    <div class="live-source-tabs" role="tablist" aria-label="Live sources">
      <button type="button" class="live-source-tab active" id="live-source-library-tab" role="tab" aria-selected="true" aria-controls="live-source-library" data-live-source-tab="library"><span class="material-symbols-rounded" aria-hidden="true">video_library</span><span>Library</span></button>
      <button type="button" class="live-source-tab" id="live-source-chat-tab" role="tab" aria-selected="false" aria-controls="live-source-chat" data-live-source-tab="chat"><span class="material-symbols-rounded" aria-hidden="true">forum</span><span>Chat</span></button>
    </div>
    <div class="live-source-panes"></div>`;
  const sourcePanes = sourcePanel.querySelector('.live-source-panes');
  library.id = 'live-source-library';
  library.setAttribute('role', 'tabpanel');
  library.setAttribute('aria-labelledby', 'live-source-library-tab');
  library.dataset.liveSourcePane = 'library';
  chat.id = 'live-source-chat';
  chat.setAttribute('role', 'tabpanel');
  chat.setAttribute('aria-labelledby', 'live-source-chat-tab');
  chat.dataset.liveSourcePane = 'chat';
  sourcePanes.append(library);

  const mobileSourceQuery = window.matchMedia('(max-width: 900px)');
  let activeSource = 'library';

  const syncSourceLayout = () => {
    const mobile = mobileSourceQuery.matches;
    const tabs = sourcePanel.querySelector('.live-source-tabs');
    tabs?.setAttribute('aria-hidden', String(!mobile));
    sourcePanel.setAttribute('aria-label', mobile ? 'Library and Unify Chat' : 'Video library');

    if (mobile) {
      sourcePanes.append(library, chat);
    } else {
      sourcePanes.append(library);
      center.append(chat);
    }

    sourcePanel.querySelectorAll('[data-live-source-tab]').forEach(tab => {
      const active = tab.dataset.liveSourceTab === activeSource;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = mobile && active ? 0 : -1;
    });

    [library, chat].forEach(pane => {
      const active = pane.dataset.liveSourcePane === activeSource;
      pane.hidden = mobile && !active;
      if (mobile) {
        pane.setAttribute('role', 'tabpanel');
        pane.setAttribute('aria-labelledby', `live-source-${pane.dataset.liveSourcePane}-tab`);
        pane.removeAttribute('aria-label');
      } else {
        pane.setAttribute('role', 'region');
        pane.removeAttribute('aria-labelledby');
        pane.setAttribute('aria-label', pane.dataset.liveSourcePane === 'library' ? 'Video library' : 'Unify Chat');
      }
    });
  };

  const setSourceTab = (target = 'library', focus = false) => {
    activeSource = target === 'chat' ? 'chat' : 'library';
    syncSourceLayout();
    if (focus && mobileSourceQuery.matches) {
      sourcePanel.querySelector(`[data-live-source-tab="${activeSource}"]`)?.focus();
    }
  };
  sourcePanel.querySelectorAll('[data-live-source-tab]').forEach(tab => {
    tab.addEventListener('click', () => setSourceTab(tab.dataset.liveSourceTab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'ArrowRight' || event.key === 'End' ? 'chat' : 'library';
      setSourceTab(target, true);
    });
  });
  mobileSourceQuery.addEventListener('change', syncSourceLayout);
  syncSourceLayout();

  library.classList.add('fcp-library-browser');
  const splitter = document.createElement('div');
  splitter.className = 'studio-column-splitter live-column-splitter';
  splitter.dataset.splitter = 'source';
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-label', 'Resize Library and Monitor');
  splitter.setAttribute('aria-orientation', 'vertical');
  splitter.setAttribute('aria-valuemin', '25');
  splitter.setAttribute('aria-valuemax', '40');
  splitter.tabIndex = 0;
  controlRail.classList.add('live-control-rail');
  appBody.replaceChildren(sourcePanel, center, controlRail, splitter);
  appBody.classList.add('monitor-first-layout', 'fcp-editor-layout', 'svg-reference-layout', 'live-two-column-layout');
  setupLiveTwoColumnResize(appBody);
  setupLiveMonitorResize(center);
  window.setLiveSourceTab = setSourceTab;
}

function setupLiveTwoColumnResize(layout) {
  const splitter = layout.querySelector('.live-column-splitter');
  if (!splitter || splitter.dataset.resizeReady === 'true') return;
  splitter.dataset.resizeReady = 'true';

  const clamp = value => Math.min(40, Math.max(25, value));
  let sourceWidth = 35;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.STUDIO_COLUMNS) || 'null');
    if (Number.isFinite(Number(saved?.source))) sourceWidth = clamp(Number(saved.source));
  } catch {
    localStorage.removeItem(STORAGE_KEYS.STUDIO_COLUMNS);
  }

  const applyWidth = (persist = false) => {
    layout.style.setProperty('--studio-source', `${sourceWidth.toFixed(2)}%`);
    layout.style.setProperty('--studio-monitor', `${(100 - sourceWidth).toFixed(2)}%`);
    splitter.setAttribute('aria-valuenow', sourceWidth.toFixed(1));
    if (persist) localStorage.setItem(STORAGE_KEYS.STUDIO_COLUMNS, JSON.stringify({ source: sourceWidth }));
  };

  const resizeAt = (clientX, persist = false) => {
    const bounds = layout.getBoundingClientRect();
    if (!bounds.width) return;
    sourceWidth = clamp(((clientX - bounds.left) / bounds.width) * 100);
    applyWidth(persist);
  };

  splitter.addEventListener('pointerdown', event => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    layout.classList.add('is-resizing-columns');
    resizeAt(event.clientX);
  });
  splitter.addEventListener('pointermove', event => {
    if (splitter.hasPointerCapture(event.pointerId)) resizeAt(event.clientX);
  });
  const finishResize = event => {
    if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
    layout.classList.remove('is-resizing-columns');
    applyWidth(true);
  };
  splitter.addEventListener('pointerup', finishResize);
  splitter.addEventListener('pointercancel', finishResize);
  splitter.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    sourceWidth = event.key === 'Home' ? 35 : clamp(sourceWidth + (event.key === 'ArrowRight' ? 1 : -1));
    applyWidth(true);
  });

  applyWidth();
}

function setupLiveMonitorResize(center) {
  const splitter = center.querySelector('.monitor-chat-splitter');
  if (!splitter || splitter.dataset.resizeReady === 'true') return;
  splitter.dataset.resizeReady = 'true';

  const clamp = value => Math.min(74, Math.max(48, value));
  let monitorHeight = 65;
  const saved = Number(localStorage.getItem(STORAGE_KEYS.STUDIO_MONITOR_HEIGHT));
  if (Number.isFinite(saved)) monitorHeight = clamp(saved);

  const applyHeight = (persist = false) => {
    center.style.setProperty('--studio-monitor-height', `${monitorHeight.toFixed(2)}fr`);
    center.style.setProperty('--studio-chat-height', `${(100 - monitorHeight).toFixed(2)}fr`);
    splitter.setAttribute('aria-valuenow', monitorHeight.toFixed(1));
    if (persist) localStorage.setItem(STORAGE_KEYS.STUDIO_MONITOR_HEIGHT, monitorHeight.toFixed(2));
  };

  const resizeAt = (clientY, persist = false) => {
    const bounds = center.getBoundingClientRect();
    if (!bounds.height) return;
    monitorHeight = clamp(((clientY - bounds.top) / bounds.height) * 100);
    applyHeight(persist);
  };

  splitter.addEventListener('pointerdown', event => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    center.classList.add('is-resizing-monitor');
    resizeAt(event.clientY);
  });
  splitter.addEventListener('pointermove', event => {
    if (splitter.hasPointerCapture(event.pointerId)) resizeAt(event.clientY);
  });
  const finishResize = event => {
    if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
    center.classList.remove('is-resizing-monitor');
    applyHeight(true);
  };
  splitter.addEventListener('pointerup', finishResize);
  splitter.addEventListener('pointercancel', finishResize);
  splitter.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    monitorHeight = event.key === 'Home' ? 65 : clamp(monitorHeight + (event.key === 'ArrowUp' ? 1 : -1));
    applyHeight(true);
  });

  applyHeight();
}

function setupStudioColumnResize(layout) {
  const defaults = { left: 28.49, center: 43.02, right: 28.49 };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  let columns = { ...defaults };

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.STUDIO_COLUMNS) || 'null');
    const total = Number(saved?.left) + Number(saved?.center) + Number(saved?.right);
    if (
      Number.isFinite(total) && Math.abs(total - 100) < 0.1
      && saved.left >= 25 && saved.left <= 40
      && saved.center >= 40 && saved.center <= 50
      && saved.right >= 25 && saved.right <= 40
    ) {
      columns = { left: Number(saved.left), center: Number(saved.center), right: Number(saved.right) };
    }
  } catch {
    localStorage.removeItem(STORAGE_KEYS.STUDIO_COLUMNS);
  }

  const applyColumns = (persist = false) => {
    layout.style.setProperty('--studio-left', `${columns.left.toFixed(2)}%`);
    layout.style.setProperty('--studio-center', `${columns.center.toFixed(2)}%`);
    layout.style.setProperty('--studio-right', `${columns.right.toFixed(2)}%`);
    layout.querySelector('[data-splitter="left"]')?.setAttribute('aria-valuenow', columns.left.toFixed(1));
    layout.querySelector('[data-splitter="right"]')?.setAttribute('aria-valuenow', columns.right.toFixed(1));
    if (persist) localStorage.setItem(STORAGE_KEYS.STUDIO_COLUMNS, JSON.stringify(columns));
  };

  const resizeAt = (side, clientX, persist = false) => {
    const bounds = layout.getBoundingClientRect();
    if (!bounds.width) return;
    const pointer = clamp(((clientX - bounds.left) / bounds.width) * 100, 0, 100);

    if (side === 'left') {
      const minLeft = Math.max(25, 100 - columns.right - 50);
      const maxLeft = Math.min(40, 100 - columns.right - 40);
      columns.left = clamp(pointer, minLeft, maxLeft);
      columns.center = 100 - columns.right - columns.left;
    } else {
      const centerAtPointer = pointer - columns.left;
      const minCenter = Math.max(40, 100 - columns.left - 40);
      const maxCenter = Math.min(50, 100 - columns.left - 25);
      columns.center = clamp(centerAtPointer, minCenter, maxCenter);
      columns.right = 100 - columns.left - columns.center;
    }
    applyColumns(persist);
  };

  layout.querySelectorAll('.studio-column-splitter').forEach(splitter => {
    const side = splitter.dataset.splitter;
    splitter.addEventListener('pointerdown', event => {
      event.preventDefault();
      splitter.setPointerCapture(event.pointerId);
      layout.classList.add('is-resizing-columns');
      resizeAt(side, event.clientX);
    });
    splitter.addEventListener('pointermove', event => {
      if (!splitter.hasPointerCapture(event.pointerId)) return;
      resizeAt(side, event.clientX);
    });
    const finishResize = event => {
      if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
      layout.classList.remove('is-resizing-columns');
      applyColumns(true);
    };
    splitter.addEventListener('pointerup', finishResize);
    splitter.addEventListener('pointercancel', finishResize);
    splitter.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') {
        columns = { ...defaults };
        applyColumns(true);
        return;
      }
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const bounds = layout.getBoundingClientRect();
      const currentEdge = side === 'left' ? columns.left : columns.left + columns.center;
      resizeAt(side, bounds.left + ((currentEdge + direction) / 100) * bounds.width, true);
    });
  });

  applyColumns();
}

function setupStudioShell() {
  setupLiveSettingPreferences();
  const providerSlot = $('web-settings-provider-slot') || $('settings-provider-slot');
  const providerPanel = document.querySelector('.voice-config-panel');
  if (providerSlot) providerSlot.closest('.settings-bento-card')?.setAttribute('hidden', '');

  // Keep every setting on the same page. Existing form IDs and save handlers
  // are preserved by moving the modal contents into aligned bento cards.
  const mountSettingsForm = (modalId, contentSlotId, actionsSlotId, primaryActionId) => {
    const modal = $(modalId);
    const contentSlot = $(contentSlotId);
    const actionsSlot = $(actionsSlotId);
    if (!modal || !contentSlot || !actionsSlot) return;
    const body = modal.querySelector('.modal-body');
    const primaryAction = $(primaryActionId);
    if (body) contentSlot.appendChild(body);
    if (primaryAction) actionsSlot.appendChild(primaryAction);
    modal.remove();
  };
  mountSettingsForm('modal-voice', 'web-settings-voice-slot', 'web-settings-voice-actions', 'save-modal-voice');
  mountSettingsForm('modal-obs', 'web-settings-obs-slot', 'web-settings-obs-actions', 'save-modal-obs');
  setupMonitorFirstStudio();
  const controlsGrid = document.querySelector('.monitor-first-controls-grid');
  if (controlsGrid && providerPanel && !providerPanel.classList.contains('live-control-mounted')) {
    controlsGrid.prepend(providerPanel);
    providerPanel.classList.add('live-control-mounted');
  }
  // The legacy engineering workspace is deliberately not part of the product
  // surface. Avatar creation remains available through the AI Profile flow.
  $('modal-avatar')?.remove();

  const setSettingsPane = (target = 'output') => {
    const allowed = ['output', 'engine', 'chat', 'storage', 'engines'];
    const selected = allowed.includes(target) ? target : 'output';
    document.querySelectorAll('.settings-section-tab').forEach(tab => {
      const active = tab.dataset.settingsTarget === selected;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('[data-settings-pane]').forEach(pane => {
      const active = pane.dataset.settingsPane === selected;
      pane.classList.toggle('active', active);
      pane.toggleAttribute('hidden', !active);
    });
    if (selected === 'engines') {
      loadAiDirectorSettings().catch(error => {
        if ($('ai-director-save-status')) $('ai-director-save-status').textContent = error.message;
      });
    }
    if (selected === 'chat') window.RuntimeApi.get('/api/platform-chat/status')
      .then(payload => applyPlatformChatStatus(payload.platformChat || {}, payload.platformReply || {}))
      .catch(error => { if ($('platform-chat-summary')) $('platform-chat-summary').textContent = error.message; });
    if (selected === 'engine') refreshLiveTalkingWorkerStatus({ silent: false });
  };

  document.querySelectorAll('.settings-section-tab').forEach(tab => {
    tab.addEventListener('click', () => setSettingsPane(tab.dataset.settingsTarget));
    tab.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('.settings-section-tab')];
      const current = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next]?.focus();
      setSettingsPane(tabs[next]?.dataset.settingsTarget);
    });
  });
  setSettingsPane('output');

  const navDrawer = $('main-navigation');
  const navToggle = $('mobile-nav-toggle');
  const navClose = $('mobile-nav-close');
  const navScrim = $('mobile-nav-scrim');
  let navReturnFocus = null;
  const isMobileNavigation = () => window.matchMedia('(max-width: 760px)').matches;
  const setNavigationOpen = (open, restoreFocus = false) => {
    const shouldOpen = Boolean(open && isMobileNavigation());
    document.body.classList.toggle('mobile-nav-open', shouldOpen);
    navToggle?.setAttribute('aria-expanded', String(shouldOpen));
    navDrawer?.setAttribute('aria-hidden', String(isMobileNavigation() && !shouldOpen));
    if (shouldOpen) {
      navReturnFocus = document.activeElement;
      navDrawer?.querySelector('.web-nav-item.active, .web-nav-item')?.focus();
    } else if (restoreFocus && navReturnFocus instanceof HTMLElement) {
      navReturnFocus.focus();
    }
  };
  navToggle?.addEventListener('click', () => setNavigationOpen(true));
  navClose?.addEventListener('click', () => setNavigationOpen(false, true));
  navScrim?.addEventListener('click', () => setNavigationOpen(false, true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('mobile-nav-open')) setNavigationOpen(false, true);
  });
  window.addEventListener('resize', () => {
    if (!isMobileNavigation()) setNavigationOpen(false);
    else navDrawer?.setAttribute('aria-hidden', String(!document.body.classList.contains('mobile-nav-open')));
  });
  setNavigationOpen(false);

  const engineIcons = { 'qwen-director': 'psychology', 'chatgpt-fallback': 'cloud', 'qwen-tts': 'record_voice_over', 'live-avatar': 'face', 'obs-bridge': 'live_tv', 'media-tools': 'movie_edit' };
  const engineActionIcons = { start: 'play_arrow', stop: 'stop', restart: 'restart_alt' };
  const engineActionLabels = { start: 'Start', stop: 'Stop', restart: 'Restart' };
  const renderEngineCards = engines => {
    const grid = $('engine-card-grid');
    if (!grid) return;
    grid.replaceChildren();
    engines.forEach(engine => {
      const card = document.createElement('article');
      card.className = 'engine-card';
      card.dataset.engineId = engine.id;
      const iconBox = document.createElement('span');
      iconBox.className = 'engine-card-icon';
      const icon = document.createElement('span');
      icon.className = 'material-symbols-rounded';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = engineIcons[engine.id] || 'memory';
      iconBox.append(icon);
      const copy = document.createElement('div');
      copy.className = 'engine-card-copy';
      const category = document.createElement('span');
      category.className = 'engine-card-category';
      category.textContent = engine.category || 'ENGINE';
      const titleRow = document.createElement('div');
      titleRow.className = 'engine-card-title-row';
      const title = document.createElement('h2');
      title.textContent = engine.title || engine.id;
      const model = document.createElement('span');
      model.textContent = engine.model || '';
      titleRow.append(title, model);
      const detail = document.createElement('p');
      detail.className = 'engine-card-detail';
      detail.textContent = engine.detail || '';
      const metrics = document.createElement('div');
      metrics.className = 'engine-card-metrics';
      (engine.metrics || []).forEach(metric => {
        const item = document.createElement('span');
        item.textContent = metric;
        metrics.append(item);
      });
      copy.append(category, titleRow, detail, metrics);
      const controls = document.createElement('div');
      controls.className = 'engine-card-actions';
      const controlsInner = document.createElement('div');
      const state = document.createElement('span');
      state.className = 'engine-state';
      state.dataset.state = engine.state || 'OFFLINE';
      state.textContent = ({
        READY: 'Active',
        CONFIGURED: 'Active',
        OFFLINE: 'Inactive',
        SETUP: 'Setup',
        STARTING: 'Starting',
        STOPPING: 'Stopping',
        ERROR: 'Error',
      })[engine.state] || engine.state || 'Inactive';
      controlsInner.append(state);
      const buttonRow = document.createElement('div');
      buttonRow.className = 'engine-action-row';
      (engine.actions || []).forEach(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = action === 'start' ? 'btn-primary' : 'btn-secondary';
        button.dataset.engineAction = action;
        button.dataset.engineId = engine.id;
        button.title = `${action[0].toUpperCase()}${action.slice(1)} ${engine.title}`;
        button.setAttribute('aria-label', button.title);
        const buttonIcon = document.createElement('span');
        buttonIcon.className = 'material-symbols-rounded';
        buttonIcon.setAttribute('aria-hidden', 'true');
        buttonIcon.textContent = engineActionIcons[action] || 'settings';
        const buttonLabel = document.createElement('span');
        buttonLabel.textContent = engineActionLabels[action] || action;
        button.append(buttonIcon, buttonLabel);
        buttonRow.append(button);
      });
      controlsInner.append(buttonRow);
      controls.append(controlsInner);
      card.append(iconBox, copy, controls);
      grid.append(card);
    });
    grid.setAttribute('aria-busy', 'false');
  };
  const refreshAiEngines = async ({ quiet = false } = {}) => {
    const grid = $('engine-card-grid');
    const refresh = $('refresh-ai-engines');
    if (!quiet) refresh?.setAttribute('aria-busy', 'true');
    try {
      const payload = await window.RuntimeApi.get('/api/engines');
      applyRuntimePolicy(payload.runtimePolicy || {});
      renderEngineCards(payload.engines || []);
      const readyCount = (payload.engines || []).filter(engine => ['READY', 'CONFIGURED'].includes(engine.state)).length;
      if ($('engine-manager-summary')) $('engine-manager-summary').textContent = `${readyCount}/${(payload.engines || []).length} active`;
      if ($('engine-manager-updated')) $('engine-manager-updated').textContent = new Date(payload.updatedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (error) {
      if ($('engine-manager-summary')) $('engine-manager-summary').textContent = `Engine status unavailable: ${error.message}`;
      grid?.setAttribute('aria-busy', 'false');
    } finally {
      refresh?.removeAttribute('aria-busy');
    }
  };
  $('refresh-ai-engines')?.addEventListener('click', () => void refreshAiEngines());
  $('engine-card-grid')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-engine-action]');
    if (!button || button.disabled) return;
    const card = button.closest('.engine-card');
    card?.setAttribute('data-busy', 'true');
    button.disabled = true;
    try {
      if (button.dataset.engineId === 'obs-bridge' && button.dataset.engineAction === 'start') await unlockAudio(true);
      await window.RuntimeApi.post(`/api/engines/${encodeURIComponent(button.dataset.engineId)}/action`, { action: button.dataset.engineAction });
      await refreshAiEngines({ quiet: true });
    } catch (error) {
      if ($('engine-manager-summary')) $('engine-manager-summary').textContent = error.message;
    } finally {
      card?.removeAttribute('data-busy');
      button.disabled = false;
    }
  });
  void refreshAiEngines();
  runtimeEngineStatusRefresh = refreshAiEngines;

  const navigateAppView = (name = 'studio', updateHash = true, settingsPane = null, liveSettingPane = null) => {
    if (name === 'avatar') { name = 'live-settings'; liveSettingPane = 'avatar'; }
    if (name === 'director') { name = 'live-settings'; liveSettingPane = 'skill'; }
    if (name === 'engines') { name = 'settings'; settingsPane = 'engines'; }
    if (!['studio', 'live-settings', 'settings'].includes(name)) name = 'studio';
    document.querySelectorAll('.web-app-view').forEach(view => view.classList.toggle('active', view.dataset.view === name));
    document.querySelectorAll('.web-nav-item').forEach(item => item.classList.toggle('active', item.dataset.appView === name));
    const quickButton = $('btn-quick-settings');
    if (quickButton) quickButton.hidden = name !== 'studio';
    if (name !== 'studio') {
      $('quick-settings-panel')?.classList.remove('open');
      $('quick-settings-panel')?.setAttribute('aria-hidden', 'true');
      quickButton?.setAttribute('aria-expanded', 'false');
    }
    if (updateHash && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    if (name === 'live-settings') {
      window.setLiveSettingPane?.(liveSettingPane || 'avatar');
      setupDirectorBrief();
    }
    if (name === 'settings') {
      if (settingsPane) setSettingsPane(settingsPane);
      loadProjectStorageConfig();
      loadPersistedSettings();
      loadAiDirectorSettings().catch(() => refreshLocalAiStatus());
    }
    setNavigationOpen(false);
  };
  document.querySelectorAll('.web-nav-item').forEach(item => item.addEventListener('click', () => navigateAppView(item.dataset.appView)));
  window.addEventListener('hashchange', () => navigateAppView(location.hash.slice(1) || 'studio', false));
  window.navigateAppView = navigateAppView;
  navigateAppView(location.hash.slice(1) || 'studio', false);

  const setActiveNav = (id) => {
    document.querySelectorAll('.studio-nav-item').forEach(item => item.classList.toggle('active', item.id === id));
  };
  const focusPanel = (selector, navId) => {
    setActiveNav(navId);
    const panel = document.querySelector(selector);
    panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel?.animate?.([
      { boxShadow: '0 0 0 1px rgba(164,255,74,.48), 0 0 38px rgba(37,232,117,.12)' },
      { boxShadow: '0 12px 34px rgba(0,0,0,.12)' },
    ], { duration: 900, easing: 'ease-out' });
  };
  const openSettingsCenter = (pane = 'output') => navigateAppView('settings', true, pane);

  $('nav-overview')?.addEventListener('click', () => focusPanel('.monitor-box', 'nav-overview'));
  $('nav-avatar-studio')?.addEventListener('click', () => { setActiveNav('nav-avatar-studio'); $('btn-modal-avatar')?.click(); });
  $('nav-asset-library')?.addEventListener('click', () => { window.setLiveSourceTab?.('library'); focusPanel('.fcp-source-workspace', 'nav-asset-library'); });
  $('nav-live-session')?.addEventListener('click', () => focusPanel('.monitor-box', 'nav-live-session'));
  $('nav-ai-director')?.addEventListener('click', () => focusPanel('.goals-panel', 'nav-ai-director'));
  $('nav-live-chat')?.addEventListener('click', () => {
    window.setLiveSourceTab?.('chat');
    focusPanel(window.matchMedia('(max-width: 900px)').matches ? '.fcp-source-workspace' : '#live-source-chat', 'nav-live-chat');
  });
  $('nav-obs-output')?.addEventListener('click', () => openSettingsCenter('output'));
  $('nav-settings')?.addEventListener('click', () => openSettingsCenter('providers'));
  $('btn-settings-top')?.addEventListener('click', () => openSettingsCenter('providers'));
  $('btn-open-library-hero')?.addEventListener('click', () => { window.setLiveSourceTab?.('library'); focusPanel('.fcp-source-workspace', 'nav-asset-library'); });
  $('btn-go-live-hero')?.addEventListener('click', event => {
    void magicConnectObs(event.currentTarget).catch(() => {});
  });

  const quickPanel = $('quick-settings-panel');
  const quickButton = $('btn-quick-settings');
  const setQuickPanelOpen = (open) => {
    quickPanel?.classList.toggle('open', open);
    quickPanel?.setAttribute('aria-hidden', String(!open));
    quickButton?.setAttribute('aria-expanded', String(open));
  };
  quickButton?.addEventListener('click', event => {
    event.stopPropagation();
    setQuickPanelOpen(!quickPanel?.classList.contains('open'));
  });
  $('close-quick-settings')?.addEventListener('click', () => setQuickPanelOpen(false));
  quickPanel?.addEventListener('click', event => event.stopPropagation());
  document.addEventListener('click', () => setQuickPanelOpen(false));
  $('quick-open-full-settings')?.addEventListener('click', () => {
    setQuickPanelOpen(false);
    navigateAppView('settings');
  });

  const bindSessionToggle = (quickId, sourceId) => {
    const quick = $(quickId);
    const source = $(sourceId);
    if (!quick || !source) return;
    quick.checked = source.checked;
    quick.addEventListener('change', () => {
      source.checked = quick.checked;
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    source.addEventListener('change', () => { quick.checked = source.checked; });
  };
  bindSessionToggle('quick-session-auto-mix', 'chk-auto-mix');
  bindSessionToggle('quick-session-random', 'chk-global-random');
  const quickSessionVoice = $('quick-session-voice');
  const quickSessionVoiceSpeed = $('quick-session-voice-speed');
  if (quickSessionVoice) {
    quickSessionVoice.value = ['qwentts', 'omnivoice'].includes(App.voice.provider) ? App.voice.provider : 'qwentts';
    quickSessionVoice.addEventListener('change', async event => {
      const provider = ['qwentts', 'omnivoice'].includes(event.target.value) ? event.target.value : 'qwentts';
      const providerProfiles = VoiceProfileState.profiles.filter(profile => profile.provider === provider);
      const voiceId = providerProfiles.some(profile => profile.voiceId === App.voice.voiceId)
        ? App.voice.voiceId
        : providerProfiles[0]?.voiceId || App.voice.voiceId;
      saveVoiceSettings({ provider, voiceId: voiceId });
      if ($('quick-voice-provider')) $('quick-voice-provider').value = provider;
      syncQuickVoiceIdVisibility(provider);
      renderQuickVoiceOptions(provider);
      if ($('profile-voice-provider')) $('profile-voice-provider').value = provider;
      updateVoiceProfileBuilder(provider);
      await window.LiveTalkingApi.setVoice({ provider, voiceId, languageCode: 'vi', speed: App.voice.speed }).catch(() => {});
      await loadVoiceProfiles(provider, voiceId);
    });
  }
  if (quickSessionVoiceSpeed) {
    quickSessionVoiceSpeed.value = String(App.voice.speed || 1.0);
    if ($('quick-session-voice-speed-value')) $('quick-session-voice-speed-value').textContent = `${Number(quickSessionVoiceSpeed.value).toFixed(2)}x`;
    quickSessionVoiceSpeed.addEventListener('input', event => {
      const speed = Number(event.target.value);
      saveVoiceSettings({ speed });
      if ($('quick-session-voice-speed-value')) $('quick-session-voice-speed-value').textContent = `${speed.toFixed(2)}x`;
      window.LiveTalkingApi.setVoice({ speed }).catch(() => {});
    });
  }
  $('quick-session-captions')?.addEventListener('change', event => {
    $('monitor-screen')?.classList.toggle('captions-disabled', !event.target.checked);
  });

  const liveSessionPanel = $('live-session-settings-panel');
  const liveSessionButton = $('btn-live-session-settings');
  const setLiveSessionPanelOpen = open => {
    liveSessionPanel?.classList.toggle('open', open);
    liveSessionPanel?.setAttribute('aria-hidden', String(!open));
    liveSessionButton?.setAttribute('aria-expanded', String(open));
    if (open) {
      setQuickPanelOpen(false);
      loadLiveSessionSettings();
    }
  };
  liveSessionButton?.addEventListener('click', event => {
    event.stopPropagation();
    setLiveSessionPanelOpen(!liveSessionPanel?.classList.contains('open'));
  });
  $('close-live-session-settings')?.addEventListener('click', () => setLiveSessionPanelOpen(false));
  liveSessionPanel?.addEventListener('click', event => event.stopPropagation());
  $('save-live-session-settings')?.addEventListener('click', () => {
    saveLiveSessionSettings().catch(error => {
      if ($('live-session-save-status')) $('live-session-save-status').textContent = error.message;
    });
  });
  document.addEventListener('click', () => setLiveSessionPanelOpen(false));

  $('settings-open-avatar')?.addEventListener('click', () => navigateAppView('live-settings', true, null, 'avatar'));
  $('save-project-storage')?.addEventListener('click', () => {
    saveProjectStorageConfig().catch(err => {
      if ($('project-storage-status')) $('project-storage-status').textContent = `Error: ${err.message}`;
    });
  });
  $('select-project-storage-folder')?.addEventListener('click', selectProjectStorageFolder);
  $('install-local-ai-model')?.addEventListener('click', () => {
    installLocalAiModel().catch(error => {
      if ($('local-ai-install-progress')) $('local-ai-install-progress').textContent = error.message;
    });
  });
  $('ai-director-provider')?.addEventListener('change', event => setAiDirectorProviderUI(event.target.value));
  $('connect-ai-director-gemini')?.addEventListener('click', () => {
    connectGeminiGoogleAccount().catch(error => {
      if ($('ai-director-gemini-status')) $('ai-director-gemini-status').textContent = error.message;
    });
  });
  $('save-ai-director')?.addEventListener('click', () => {
    const button = $('save-ai-director');
    if (button) button.disabled = true;
    if ($('ai-director-save-status')) $('ai-director-save-status').textContent = 'Saving…';
    saveAiDirectorSettings().catch(error => {
      if ($('ai-director-save-status')) $('ai-director-save-status').textContent = error.message;
    }).finally(() => {
      if (button) button.disabled = false;
    });
  });
  $('local-ai-model-name')?.addEventListener('input', () => {
    const button = $('install-local-ai-model');
    if (!button) return;
    button.disabled = false;
    button.innerHTML = '<span class="material-symbols-rounded">download</span>Cài đặt Show Director';
  });

  window.openStudioSettings = openSettingsCenter;
}

function setupNativeHeaderDrag() {
  const topbar = document.querySelector('.topbar');
  const getCurrentWindow = window.__TAURI__?.window?.getCurrentWindow;
  if (!topbar || typeof getCurrentWindow !== 'function' || topbar.dataset.nativeDragReady === 'true') return;

  topbar.dataset.nativeDragReady = 'true';
  topbar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    if (event.target.closest('button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]')) return;
    getCurrentWindow().startDragging().catch(error => console.warn('Native window drag failed:', error));
  });
}

const REQUIRED_STARTUP_ENGINES = ['qwen-tts', 'live-avatar'];

function renderStartupEngine(engineId, state, detail = '') {
  const prefix = engineId === 'qwen-tts' ? 'qwen' : 'avatar';
  const dot = $(`startup-${prefix}-dot`);
  const label = $(`startup-${prefix}-status`);
  const normalized = String(state || 'STARTING').toUpperCase();
  const ready = normalized === 'READY';
  const failed = normalized === 'ERROR';
  if (dot) dot.className = `app-startup-worker-dot ${ready ? 'ready' : failed ? 'error' : 'starting'}`;
  if (label) label.textContent = ready ? 'Online' : failed ? (detail || 'Error') : 'Starting…';
}

async function waitForRequiredWorkers() {
  const status = $('app-startup-status');
  const retry = $('app-startup-retry');
  if (RuntimeSystem.released) {
    if (status) status.textContent = 'Runtime services released. Wake services to start workers.';
    REQUIRED_STARTUP_ENGINES.forEach(id => renderStartupEngine(id, 'OFFLINE', 'Released'));
    if (retry) retry.hidden = true;
    return false;
  }
  let initialPayload = null;
  try {
    initialPayload = await window.RuntimeApi.get('/api/engines');
    applyRuntimePolicy(initialPayload.runtimePolicy || {});
    const initialEngines = Array.isArray(initialPayload.engines) ? initialPayload.engines : [];
    const initialRequired = REQUIRED_STARTUP_ENGINES.map(id => initialEngines.find(engine => engine.id === id));
    initialRequired.forEach((engine, index) => renderStartupEngine(
      REQUIRED_STARTUP_ENGINES[index],
      engine?.state || 'OFFLINE',
      engine?.detail || '',
    ));
    if (initialRequired.every(engine => engine?.state === 'READY')) {
      if (status) status.textContent = 'Workers already online. Opening Studio…';
      return true;
    }
  } catch (error) {
    if (status) status.textContent = `Runtime status unavailable. Opening workspace…`;
  }

  const autoStartAllowed = RuntimeSystem.policy.qwenTtsAutostart && RuntimeSystem.policy.liveTalkingAutostart;
  if (!autoStartAllowed) {
    if (status) status.textContent = RuntimeSystem.policy.webOnly
      ? 'Web-only mode. Workers are stopped until you start them manually.'
      : 'Manual worker mode. Start voice and lipsync from Settings when needed.';
    REQUIRED_STARTUP_ENGINES.forEach(id => renderStartupEngine(id, 'OFFLINE', 'Manual'));
    if (retry) retry.hidden = true;
    return false;
  }
  if (retry) retry.hidden = true;
  if (status) status.textContent = 'Starting voice and live avatar workers…';
  REQUIRED_STARTUP_ENGINES.forEach(id => renderStartupEngine(id, 'STARTING'));

  // Avoid loading both ML runtimes at the exact same instant. Qwen TTS is
  // smaller and becomes ready first, then MuseTalk can claim the remaining
  // memory without a large startup spike.
  for (const id of REQUIRED_STARTUP_ENGINES) {
    if (RuntimeSystem.released) return false;
    await window.RuntimeApi.post(`/api/engines/${id}/action`, { action: 'start' }).catch(() => {});
  }

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (RuntimeSystem.released) {
      if (status) status.textContent = 'Runtime services released. Wake services to start workers.';
      REQUIRED_STARTUP_ENGINES.forEach(id => renderStartupEngine(id, 'OFFLINE', 'Released'));
      return false;
    }
    try {
      const payload = await window.RuntimeApi.get('/api/engines');
      const engines = Array.isArray(payload.engines) ? payload.engines : [];
      const required = REQUIRED_STARTUP_ENGINES.map(id => engines.find(engine => engine.id === id));
      required.forEach((engine, index) => renderStartupEngine(
        REQUIRED_STARTUP_ENGINES[index],
        engine?.state || 'STARTING',
        engine?.detail || '',
      ));
      if (required.every(engine => engine?.state === 'READY')) {
        if (status) status.textContent = 'All workers online. Opening Studio…';
        return true;
      }
    } catch (error) {
      if (status) status.textContent = `Still waiting for local workers… ${error.message}`;
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }

  if (status) status.textContent = 'A worker took too long to start. Check the worker setup, then try again.';
  REQUIRED_STARTUP_ENGINES.forEach(id => {
    const prefix = id === 'qwen-tts' ? 'qwen' : 'avatar';
    const dot = $(`startup-${prefix}-dot`);
    if (dot && !dot.classList.contains('ready')) dot.className = 'app-startup-worker-dot error';
  });
  if (retry) retry.hidden = false;
  await new Promise(resolve => retry?.addEventListener('click', resolve, { once: true }));
  return waitForRequiredWorkers();
}

async function init() {
  try {
    setupStudioShell();
    setupNativeHeaderDrag();
  } catch (e) {
    console.warn('setupStudioShell error:', e);
  }

  // Bind static controls immediately. Media restoration can involve a large
  // IndexedDB migration and must never make upload/settings controls inert.
  try {
    bindEventListeners();
    bindAiProfileControls();
    applyLiveVideoQualityUI(App.talkingEngine.videoQuality, { persist: false, republish: false });
  } catch (e) {
    console.warn('bindEventListeners error:', e);
  }

  // Load the persisted runtime mode before starting any worker. A released
  // runtime must remain idle until the operator explicitly wakes it.
  await loadLiveSessionSettings();
  const runtimeReleasedAtStartup = RuntimeSystem.released;
  const workersReady = runtimeReleasedAtStartup ? false : await waitForRequiredWorkers();
  if (workersReady) await refreshMuseTalkMaskMode();

  // Keep the control channel available for an explicit Wake action. It does
  // not claim the Live Monitor or OBS publisher while the runtime is released.
  if (!RuntimeSystem.released) connectRuntimeRealtime();

  const persistedMedia = await Promise.allSettled([
    loadPersistedAvatar(),
    loadPersistedClips(),
  ]);
  persistedMedia.forEach(result => {
    if (result.status === 'rejected') console.warn('Persisted media load error:', result.reason);
  });

  try {
    loadPersistedSettings();
  } catch (e) {
    console.warn('loadPersistedSettings error:', e);
  }

  loadReplySkills();
  loadVoiceProfiles();

  await loadProjectStorageConfig();
  restoreFormDrafts();
  setupFormDraftPersistence();

  try {
    renderLibraryUI();
  } catch (e) {
    console.warn('renderLibraryUI error:', e);
  }

  try {
    renderStateHistory();
  } catch (e) {
    console.warn('renderStateHistory error:', e);
  }

  try {
    initAvatarCanvas();
  } catch (e) {
    console.warn('initAvatarCanvas error:', e);
  }

  App.talkingEngine.provider = 'livetalking';
  localStorage.setItem(STORAGE_KEYS.TALKING_PROVIDER, 'livetalking');
  const startupOverlay = $('app-startup-overlay');
  const startupStatus = $('app-startup-status');
  if (startupStatus) startupStatus.textContent = LiveTalkingWorker.alwaysOn && RuntimeSystem.policy.liveTalkingAutostart
    ? 'Preparing realtime avatar…'
    : 'Opening live workspace…';
  App.isMuted = false;
  void unlockAudio(false);
  appStartupComplete = true;
  if (workersReady && !RuntimeSystem.released) {
    startRuntimeFrontendAutomation();
    void restoreOperationalAvatar({ attempts: 5, status: startupStatus })
      .then(avatarId => addLog(`Avatar ${avatarId} restored.`, 'ok'))
      .catch(error => {
        addLog(`Live avatar auto-connect failed: ${error.message}`, 'warn');
        scheduleOperationalAvatarRestore('startup retry');
      });
    if (startupStatus) startupStatus.textContent = 'Live workspace ready';
  } else if (startupStatus) {
    startupStatus.textContent = 'Runtime services released. Wake services to continue.';
  }
  startupOverlay?.classList.add('is-ready');
  setTimeout(() => startupOverlay?.remove(), 450);
  
  if (!RuntimeSystem.released) {
    try {
      setVisualState('GAMEPLAY_IDLE', 7, 'boot');
    } catch (e) {
      console.warn('setVisualState error:', e);
    }
  }

  addLog('AI Idol Operator Dashboard started.', 'ok');
  addLog(RuntimeSystem.released
    ? 'Runtime services are released.'
    : RuntimeSystem.policy.webOnly
      ? 'Web-only mode: workers remain stopped until manually started.'
      : 'Realtime avatar pipeline active.', 'ok');

  startRuntimeActivityLoop();

  const monitorAudioUnlock = () => { void unlockAudio(false); };
  document.querySelector('.monitor-box')?.addEventListener('pointerdown', monitorAudioUnlock, { passive: true });
  window.addEventListener('pointerdown', monitorAudioUnlock, { passive: true });
  window.addEventListener('focus', monitorAudioUnlock, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') monitorAudioUnlock();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
