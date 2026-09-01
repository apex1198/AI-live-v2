/**
 * @idol/voice
 *
 * Realtime TTS & Audio Ducking Service for Hybrid AI Idol.
 *
 * Rules (from PLAN.md):
 * - AI Voice is mixed separately from video assets.
 * - Duck game audio / BGM by -12dB when voice starts, restore when finished.
 * - Visual reaction clip does not wait for TTS.
 * - Support interrupts for high priority events (Jackpot, Operator Mute).
 */
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
// 2. Mock TTS Adapter (Calculates accurate Vietnamese duration)
// ─────────────────────────────────────────────────────────
export class MockTTSAdapter {
    name = 'mock-tts';
    async synthesize(request) {
        const wordCount = request.text.split(/\s+/).filter(Boolean).length;
        // Vietnamese speaking speed: ~3.5 words/sec adjusted by speedMultiplier
        const speed = request.speedMultiplier || 1.0;
        const baseDurationSec = Math.max(1.8, (wordCount / 3.5) / speed);
        const durationMs = Math.round(baseDurationSec * 1000);
        return {
            requestId: request.requestId,
            durationMs,
        };
    }
}
export class VoiceService {
    _adapter;
    _duckingController;
    _listeners;
    _isSpeaking = false;
    _currentRequestId = null;
    _currentTimer = null;
    constructor(options = {}) {
        this._adapter = options.adapter ?? new MockTTSAdapter();
        this._listeners = options.listeners ?? {};
        this._duckingController = new AudioDuckingController((isDucked, duckDb) => {
            this._listeners.onDuckingChange?.(isDucked, duckDb);
        });
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
     * Speak text with automated ducking and lifecycle events.
     */
    async speak(request) {
        // If already speaking and interruptible, cancel previous
        if (this._isSpeaking) {
            this.interrupt('New speech requested');
        }
        this._isSpeaking = true;
        this._currentRequestId = request.requestId;
        // 1. Duck game audio / BGM immediately
        this._duckingController.duck();
        // 2. Emit voice started
        this._listeners.onVoiceEvent?.({
            type: 'voice.started',
            requestId: request.requestId,
            timestamp: Date.now(),
        });
        try {
            // 3. Synthesize
            const result = await this._adapter.synthesize(request);
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
        if (this._currentTimer) {
            clearTimeout(this._currentTimer);
            this._currentTimer = null;
        }
        const reqId = this._currentRequestId;
        this._isSpeaking = false;
        this._currentRequestId = null;
        this._duckingController.restore();
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
        this._listeners.onVoiceEvent?.({
            type: 'voice.finished',
            requestId,
            timestamp: Date.now(),
        });
    }
    destroy() {
        if (this._currentTimer)
            clearTimeout(this._currentTimer);
        this._duckingController.restore();
    }
}
//# sourceMappingURL=index.js.map