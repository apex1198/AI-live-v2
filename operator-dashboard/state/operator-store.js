'use strict';

(function installOperatorStore(global) {
  global.createOperatorStore = function createOperatorStore(storageKeys) {
    const storage = global.localStorage;
    return {
      streamStart: Date.now() - 22 * 60 * 1000,
      isPaused: false,
      isMuted: false,
      currentState: 'GAMEPLAY_IDLE',
      currentClip: null,
      // The idle clip keeps playing behind the live talking canvas. Preserve
      // it so a completed voice line reveals the same in-progress frame rather
      // than cutting back to the beginning of a new idle clip.
      resumeIdleClipAfterTalking: null,
      clipStartedAt: null,
      clipElapsedMs: 0,
      isAiSpeaking: false,
      chatQueue: [],
      chatHistory: [],
      eventQueue: [],
      eventLog: [],
      lastCtaAt: Date.now() - (4 * 60 + 21) * 1000,
      ctaCooldownMs: 4 * 60 * 1000,
      ctaEnabled: true,
      nextGoalSec: 14,
      autoMix: storage.getItem(storageKeys.AUTO_MIX) !== null ? storage.getItem(storageKeys.AUTO_MIX) === 'true' : true,
      globalRandom: storage.getItem(storageKeys.GLOBAL_RANDOM) !== null ? storage.getItem(storageKeys.GLOBAL_RANDOM) === 'true' : true,
      groupRandom: JSON.parse(storage.getItem(storageKeys.GROUP_RANDOM) || '{"gameplay":true,"talking":true,"reaction":true,"cta":true}'),
      queuedTransition: null,
      activeFilter: 'all',
      libraryRatio: storage.getItem(storageKeys.LIBRARY_RATIO) === '9:16' ? '9:16' : '16:9',
      playbackOverlapFrames: 2,
      stateHistory: [{ state: 'GAMEPLAY_IDLE', time: Date.now() - 60000, color: '#d8d8da' }],
      streamContext: {
        lastGameEvent: 'New round in progress',
        lastGameOutcome: null,
        totalWins: 0,
        totalLosses: 0,
        recentTopics: [],
      },
      talkingEngine: {
        provider: 'livetalking',
        endpoint: storage.getItem(storageKeys.LIVETALKING_ENDPOINT) || 'http://localhost:2222',
        model: storage.getItem(storageKeys.LIVETALKING_MODEL) || 'musetalk',
        checkpoint: storage.getItem(storageKeys.W2L_CHECKPOINT) || 'wav2lip',
        detector: storage.getItem(storageKeys.W2L_DETECTOR) || 'mediapipe',
        isConnected: true,
        device: 'metal',
        lastHealthMs: 0,
        mouthOpen: 0,
        mouthWide: 0.3,
        mouthPucker: 0,
        jawOpen: 0,
        viseme: 'sil',
        currentSpeechDurationMs: 0,
        speechStartedAt: 0,
        videoQuality: 'fhd',
      },
      voice: {
        provider: ['qwentts', 'omnivoice'].includes(storage.getItem(storageKeys.VOICE_PROVIDER))
          ? storage.getItem(storageKeys.VOICE_PROVIDER)
          : 'qwentts',
        language: (() => {
          const storedLanguage = storage.getItem(storageKeys.VOICE_LANG);
          return !storedLanguage || storedLanguage === 'auto' ? 'vi' : storedLanguage;
        })(),
        providerConfigured: false,
        voiceId: storage.getItem(storageKeys.VOICE_ID) || 'qwen-default',
        customVoices: JSON.parse(storage.getItem(storageKeys.CUSTOM_VOICES) || '[]'),
        speed: parseFloat(storage.getItem(storageKeys.VOICE_SPEED) || '1.0'),
        personaName: storage.getItem(storageKeys.PERSONA_NAME) || 'Mimi',
        personaPrompt: storage.getItem(storageKeys.PERSONA_PROMPT) || 'Bạn là Mimi, AI Idol streamer người Việt Nam vui tính, năng động và thân thiện. Luôn trả lời bằng tiếng Việt tự nhiên, ngắn gọn trong 1-2 câu.',
      },
      avatar: {
        displayMode: storage.getItem(storageKeys.AVATAR_DISPLAY_MODE) || 'video',
        customImageData: storage.getItem(storageKeys.AVATAR_IMAGE) || null,
        portraitImageData: storage.getItem(storageKeys.PORTRAIT_IMAGE) || null,
        preset: storage.getItem(storageKeys.AVATAR_PRESET) || 'mimi_anime',
        imageObj: null,
        portraitImage: null,
        portraitImageUrl: null,
        videoEl: null,
        videoUrl: null,
        tempPreviewImage: null,
        tempPortraitImage: null,
        tempPreviewVideo: null,
        tempPreviewData: null,
        tempPreset: 'mimi_anime',
      },
      audioCtx: null,
      audioElement: null,
      currentAudioUrl: null,
      isAudioUnlocked: false,
    };
  };
})(window);
