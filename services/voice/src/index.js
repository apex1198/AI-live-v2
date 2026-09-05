/**
 * @idol/voice
 *
 * Realtime TTS & Audio Ducking Service for Hybrid AI Idol.
 * Streamlined to 2 core engines:
 * 1. ElevenLabs TTS (Multilingual v2)
 * 2. Web Speech API (Local zero-latency fallback)
 */
function arrayBufferToBase64(buffer) {
    if (typeof globalThis.Buffer !== 'undefined') {
        return globalThis.Buffer.from(buffer).toString('base64');
    }
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    if (typeof btoa === 'function') {
        return btoa(binary);
    }
    return '';
}
// ─────────────────────────────────────────────────────────
// 1. Audio Ducking Controller
// ─────────────────────────────────────────────────────────
export class AudioDuckingController {
    _state = {
        isDucked: false,
        duckDb: -12,
        attackMs: 150,
        releaseMs: 300,
    };
    _onDuckingChange;
    constructor(onDuckingChange) {
        this._onDuckingChange = onDuckingChange;
    }
    get isDucked() {
        return this._state.isDucked;
    }
    duck() {
        if (!this._state.isDucked) {
            this._state.isDucked = true;
            this._onDuckingChange?.(true, this._state.duckDb);
        }
    }
    restore() {
        if (this._state.isDucked) {
            this._state.isDucked = false;
            this._onDuckingChange?.(false, 0);
        }
    }
}
// ─────────────────────────────────────────────────────────
// 2. Web Speech API Adapter (Local / Zero Cost)
// ─────────────────────────────────────────────────────────
export class WebSpeechTTSAdapter {
    name = 'webspeech-tts';
    async synthesize(request) {
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
export const ELEVENLABS_VOICE_PRESETS = {
    rachel: '21m00Tcm4TlvDq8ikWAM',
    bella: 'EXAVITQu4vr4xnSDxMaL',
    domi: 'AZnzlk1XvdvUeBnXmlld',
    dorothy: 'ThT5KcBeYPX3keUQqHPh',
    elli: 'MF3mGyEYCl7XYWbV9V6O',
    adam: 'pNInz6obpgDQGcFmaJgB',
    default: '21m00Tcm4TlvDq8ikWAM', // Rachel
};
export class ElevenLabsTTSAdapter {
    name = 'elevenlabs-tts';
    _config;
    _queue = Promise.resolve();
    constructor(config) {
        this._config = {
            modelId: 'eleven_multilingual_v2',
            languageCode: 'vi',
            stability: 0.5,
            similarityBoost: 0.75,
            timeoutMs: 30_000,
            voiceId: '21m00Tcm4TlvDq8ikWAM',
            ...config,
        };
    }
    updateConfig(config) {
        this._config = { ...this._config, ...config };
    }
    _resolveVoiceId(rawId) {
        if (!rawId || rawId === 'nova' || rawId === 'shimmer' || rawId === 'alloy' || rawId === 'default') {
            return '21m00Tcm4TlvDq8ikWAM'; // Rachel (Multilingual)
        }
        const lower = rawId.toLowerCase().trim();
        if (ELEVENLABS_VOICE_PRESETS[lower]) {
            return ELEVENLABS_VOICE_PRESETS[lower];
        }
        return rawId.trim();
    }
    async synthesize(request) {
        if (!this._config.apiKey) {
            console.warn('[ElevenLabsTTSAdapter] No API Key provided, using mock fallback.');
            return new WebSpeechTTSAdapter().synthesize(request);
        }
        const voiceId = this._resolveVoiceId(this._config.voiceId);
        const modelId = this._config.modelId || 'eleven_multilingual_v2';
        return new Promise((resolve, reject) => {
            this._queue = this._queue.catch(() => { }).then(async () => {
                let lastError = null;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), this._config.timeoutMs);
                        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                            method: 'POST',
                            signal: controller.signal,
                            headers: {
                                'xi-api-key': this._config.apiKey,
                                'Content-Type': 'application/json',
                                'Accept': 'audio/mpeg',
                            },
                            body: JSON.stringify({
                                text: request.text,
                                model_id: modelId,
                                language_code: this._config.languageCode || 'vi',
                                voice_settings: {
                                    stability: this._config.stability ?? 0.5,
                                    similarity_boost: this._config.similarityBoost ?? 0.75,
                                    use_speaker_boost: true,
                                    speed: Math.max(0.7, Math.min(1.2, request.speedMultiplier || 1)),
                                },
                            }),
                        }).finally(() => clearTimeout(timeout));
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
                    }
                    catch (err) {
                        lastError = err;
                        if (attempt < 3) {
                            await new Promise((r) => setTimeout(r, 500));
                        }
                    }
                }
                console.error('[ElevenLabsTTSAdapter] Synthesis failed after retries:', lastError);
                throw lastError instanceof Error ? lastError : new Error('ElevenLabs synthesis failed');
            }).catch((queueErr) => {
                console.error('[ElevenLabsTTSAdapter] Queue execution error:', queueErr);
                reject(queueErr);
            });
        });
    }
}
export class VoiceService {
    _adapter;
    _duckingController;
    _listeners;
    _isSpeaking = false;
    _currentRequestId = null;
    _currentTimer = null;
    _speakGeneration = 0;
    constructor(options = {}) {
        this._adapter = options.adapter ?? new WebSpeechTTSAdapter();
        this._listeners = options.listeners ?? {};
        this._duckingController = new AudioDuckingController((isDucked, duckDb) => {
            this._listeners.onDuckingChange?.(isDucked, duckDb);
        });
    }
    get adapter() {
        return this._adapter;
    }
    setAdapter(adapter) {
        this._adapter = adapter;
    }
    get isSpeaking() {
        return this._isSpeaking;
    }
    get currentRequestId() {
        return this._currentRequestId;
    }
    get duckingController() {
        return this._duckingController;
    }
    /**
     * Speak text with automated ducking, progress callback and lifecycle events.
     */
    async speak(request) {
        if (this._isSpeaking) {
            this.interrupt('New speech requested');
        }
        const generation = ++this._speakGeneration;
        this._isSpeaking = true;
        this._currentRequestId = request.requestId;
        // 1. Duck game audio / BGM immediately
        this._duckingController.duck();
        this._listeners.onGenerationStatus?.('generating', `Synthesizing with ${this._adapter.name}...`);
        try {
            // 2. Synthesize
            const result = await this._adapter.synthesize(request);
            // A newer request may have interrupted this synthesis while the adapter
            // was still working. Do not emit stale lifecycle events or arm a timer.
            if (generation !== this._speakGeneration || this._currentRequestId !== request.requestId) {
                throw new Error('Speech request was superseded');
            }
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
        }
        catch (err) {
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
    interrupt(reason = 'Interrupted') {
        if (!this._isSpeaking || !this._currentRequestId)
            return;
        this._speakGeneration++;
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
    _finishSpeech(requestId) {
        if (this._currentRequestId !== requestId)
            return;
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
    destroy() {
        this._speakGeneration++;
        if (this._currentTimer)
            clearTimeout(this._currentTimer);
        this._duckingController.restore();
    }
}
//# sourceMappingURL=index.js.map