/**
 * @idol/voice
 *
 * Realtime TTS & Audio Ducking Service for Hybrid AI Idol.
 * Streamlined to 2 core engines:
 * 1. ElevenLabs TTS (Multilingual v2)
 * 2. Web Speech API (Local zero-latency fallback)
 */

import type { VoiceRequest, VoiceEvent } from '@idol/event-schema';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (typeof (globalThis as any).Buffer !== 'undefined') {
    return (globalThis as any).Buffer.from(buffer).toString('base64');
  }
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return '';
}

export interface DuckingState {
  isDucked: boolean;
  duckDb: number;
  attackMs: number;
  releaseMs: number;
}

export interface TTSResult {
  requestId: string;
  durationMs: number;
  audioBuffer?: ArrayBuffer | Uint8Array | undefined;
  audioBase64?: string | undefined;
  provider: 'elevenlabs' | 'webspeech';
}

export interface TTSAdapter {
  name: string;
  synthesize(request: VoiceRequest): Promise<TTSResult>;
}

// ─────────────────────────────────────────────────────────
// 1. Audio Ducking Controller
// ─────────────────────────────────────────────────────────

export class AudioDuckingController {
  private _state: DuckingState = {
    isDucked: false,
    duckDb: -12,
    attackMs: 150,
    releaseMs: 300,
  };

  private _onDuckingChange?: ((isDucked: boolean, duckDb: number) => void) | undefined;

  constructor(onDuckingChange?: ((isDucked: boolean, duckDb: number) => void) | undefined) {
    this._onDuckingChange = onDuckingChange;
  }

  get isDucked(): boolean {
    return this._state.isDucked;
  }

  duck(): void {
    if (!this._state.isDucked) {
      this._state.isDucked = true;
      this._onDuckingChange?.(true, this._state.duckDb);
    }
  }

  restore(): void {
    if (this._state.isDucked) {
      this._state.isDucked = false;
      this._onDuckingChange?.(false, 0);
    }
  }
}

// ─────────────────────────────────────────────────────────
// 2. Web Speech API Adapter (Local / Zero Cost)
// ─────────────────────────────────────────────────────────

export class WebSpeechTTSAdapter implements TTSAdapter {
  readonly name = 'webspeech-tts';

  async synthesize(request: VoiceRequest): Promise<TTSResult> {
    const wordCount = request.text.split(/\s+/).filter(Boolean).length;
    const speed = request.speedMultiplier || 1.0;
    const baseDurationSec = Math.max(1.8, (wordCount / 3.5) / speed);
    const durationMs = Math.round(baseDurationSec * 1000);

    return {
      requestId: request.requestId,
      durationMs,
      provider: 'webspeech',
    };
  }
}

// ─────────────────────────────────────────────────────────
// 3. ElevenLabs TTS Adapter (Multilingual v2)
// ─────────────────────────────────────────────────────────

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
}

export const ELEVENLABS_VOICE_PRESETS: Record<string, string> = {
  rachel: '21m00Tcm4TlvDq8ikWAM',
  bella: 'EXAVITQu4vr4xnSDxMaL',
  domi: 'AZnzlk1XvdvUeBnXmlld',
  dorothy: 'ThT5KcBeYPX3keUQqHPh',
  elli: 'MF3mGyEYCl7XYWbV9V6O',
  adam: 'pNInz6obpgDQGcFmaJgB',
  default: '21m00Tcm4TlvDq8ikWAM', // Rachel
};

export class ElevenLabsTTSAdapter implements TTSAdapter {
  readonly name = 'elevenlabs-tts';
  private _config: ElevenLabsConfig;
  private _queue: Promise<void> = Promise.resolve();

  constructor(config: ElevenLabsConfig) {
    this._config = {
      modelId: 'eleven_multilingual_v2',
      stability: 0.5,
      similarityBoost: 0.75,
      voiceId: '21m00Tcm4TlvDq8ikWAM',
      ...config,
    };
  }

  updateConfig(config: Partial<ElevenLabsConfig>): void {
    this._config = { ...this._config, ...config };
  }

  private _resolveVoiceId(rawId?: string): string {
    if (!rawId || rawId === 'nova' || rawId === 'shimmer' || rawId === 'alloy' || rawId === 'default') {
      return '21m00Tcm4TlvDq8ikWAM'; // Rachel (Multilingual)
    }
    const lower = rawId.toLowerCase().trim();
    if (ELEVENLABS_VOICE_PRESETS[lower]) {
      return ELEVENLABS_VOICE_PRESETS[lower];
    }
    return rawId.trim();
  }

  async synthesize(request: VoiceRequest): Promise<TTSResult> {
    if (!this._config.apiKey) {
      console.warn('[ElevenLabsTTSAdapter] No API Key provided, using mock fallback.');
      return new WebSpeechTTSAdapter().synthesize(request);
    }

    const voiceId = this._resolveVoiceId(this._config.voiceId);
    const modelId = this._config.modelId || 'eleven_multilingual_v2';

    return new Promise<TTSResult>((resolve) => {
      this._queue = this._queue.then(async () => {
        let lastError: any = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
              method: 'POST',
              headers: {
                'xi-api-key': this._config.apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg',
              },
              body: JSON.stringify({
                text: request.text,
                model_id: modelId,
                voice_settings: {
                  stability: this._config.stability ?? 0.5,
                  similarity_boost: this._config.similarityBoost ?? 0.75,
                  use_speaker_boost: true,
                },
              }),
            });

            if (res.status === 409 || res.status === 429) {
              const errText = await res.text().catch(() => '');
              console.warn(`[ElevenLabs TTS] Attempt ${attempt}/3 got HTTP ${res.status} (${errText}). Auto-retrying in ${attempt * 600}ms...`);
              await new Promise((r) => setTimeout(r, attempt * 600));
              continue;
            }

            if (!res.ok) {
              const errText = await res.text().catch(() => '');
              console.error(`[ElevenLabs TTS] HTTP Error ${res.status} for voice ${voiceId}:`, errText);
              throw new Error(`ElevenLabs API HTTP ${res.status}: ${errText}`);
            }

            const buffer = await res.arrayBuffer();
            const base64 = arrayBufferToBase64(buffer);
            const wordCount = request.text.split(/\s+/).filter(Boolean).length;
            const durationMs = Math.max(1800, Math.round((wordCount / 3.2) * 1000));

            resolve({
              requestId: request.requestId,
              durationMs,
              audioBuffer: buffer,
              audioBase64: base64,
              provider: 'elevenlabs',
            });
            return;
          } catch (err) {
            lastError = err;
            if (attempt < 3) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        }

        console.error('[ElevenLabsTTSAdapter] Synthesis failed after retries:', lastError);
        resolve(new WebSpeechTTSAdapter().synthesize(request));
      }).catch((queueErr) => {
        console.error('[ElevenLabsTTSAdapter] Queue execution error:', queueErr);
        resolve(new WebSpeechTTSAdapter().synthesize(request));
      });
    });
  }
}

// ─────────────────────────────────────────────────────────
// 4. Voice Service Core
// ─────────────────────────────────────────────────────────

export interface VoiceServiceListeners {
  onVoiceEvent?: (event: VoiceEvent) => void;
  onDuckingChange?: (isDucked: boolean, duckDb: number) => void;
  onGenerationStatus?: (status: 'idle' | 'generating' | 'playing' | 'error', details?: string) => void;
}

export class VoiceService {
  private _adapter: TTSAdapter;
  private readonly _duckingController: AudioDuckingController;
  private readonly _listeners: VoiceServiceListeners;

  private _isSpeaking = false;
  private _currentRequestId: string | null = null;
  private _currentTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    adapter?: TTSAdapter;
    listeners?: VoiceServiceListeners;
  } = {}) {
    this._adapter = options.adapter ?? new WebSpeechTTSAdapter();
    this._listeners = options.listeners ?? {};

    this._duckingController = new AudioDuckingController((isDucked, duckDb) => {
      this._listeners.onDuckingChange?.(isDucked, duckDb);
    });
  }

  get adapter(): TTSAdapter {
    return this._adapter;
  }

  setAdapter(adapter: TTSAdapter): void {
    this._adapter = adapter;
  }

  get isSpeaking(): boolean {
    return this._isSpeaking;
  }

  get currentRequestId(): string | null {
    return this._currentRequestId;
  }

  get duckingController(): AudioDuckingController {
    return this._duckingController;
  }

  /**
   * Speak text with automated ducking, progress callback and lifecycle events.
   */
  async speak(request: VoiceRequest): Promise<TTSResult> {
    if (this._isSpeaking) {
      this.interrupt('New speech requested');
    }

    this._isSpeaking = true;
    this._currentRequestId = request.requestId;

    // 1. Duck game audio / BGM immediately
    this._duckingController.duck();
    this._listeners.onGenerationStatus?.('generating', `Synthesizing with ${this._adapter.name}...`);

    try {
      // 2. Synthesize
      const result = await this._adapter.synthesize(request);

      this._listeners.onGenerationStatus?.('playing', `Playing audio (${Math.round(result.durationMs / 1000)}s)...`);

      // 3. Emit voice started with complete audio data
      this._listeners.onVoiceEvent?.({
        type: 'voice.started',
        requestId: request.requestId,
        text: request.text,
        emotion: request.emotion,
        estimatedDurationMs: result.durationMs,
        audioBase64: result.audioBase64,
        timestamp: Date.now(),
      });

      // 4. Set timer for completion
      this._currentTimer = setTimeout(() => {
        this._finishSpeech(request.requestId);
      }, result.durationMs);

      return result;
    } catch (err) {
      this._duckingController.restore();
      this._isSpeaking = false;
      this._currentRequestId = null;
      this._listeners.onGenerationStatus?.('error', err instanceof Error ? err.message : String(err));

      this._listeners.onVoiceEvent?.({
        type: 'voice.error',
        requestId: request.requestId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });

      throw err;
    }
  }

  interrupt(reason: string = 'Interrupted'): void {
    if (!this._isSpeaking || !this._currentRequestId) return;

    if (this._currentTimer) {
      clearTimeout(this._currentTimer);
      this._currentTimer = null;
    }

    const reqId = this._currentRequestId;
    this._isSpeaking = false;
    this._currentRequestId = null;
    this._duckingController.restore();
    this._listeners.onGenerationStatus?.('idle', 'Interrupted');

    this._listeners.onVoiceEvent?.({
      type: 'voice.interrupted',
      requestId: reqId,
      timestamp: Date.now(),
    });
  }

  private _finishSpeech(requestId: string): void {
    if (this._currentRequestId !== requestId) return;

    this._isSpeaking = false;
    this._currentRequestId = null;
    this._currentTimer = null;
    this._duckingController.restore();
    this._listeners.onGenerationStatus?.('idle', 'Finished');

    this._listeners.onVoiceEvent?.({
      type: 'voice.finished',
      requestId,
      timestamp: Date.now(),
    });
  }

  destroy(): void {
    if (this._currentTimer) clearTimeout(this._currentTimer);
    this._duckingController.restore();
  }
}
