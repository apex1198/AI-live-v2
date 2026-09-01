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
import type { VoiceRequest, VoiceEvent } from '@idol/event-schema';
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
}
export interface TTSAdapter {
    name: string;
    synthesize(request: VoiceRequest): Promise<TTSResult>;
}
export declare class AudioDuckingController {
    private _state;
    private _onDuckingChange?;
    constructor(onDuckingChange?: ((isDucked: boolean, duckDb: number) => void) | undefined);
    get isDucked(): boolean;
    duck(): void;
    restore(): void;
}
export declare class MockTTSAdapter implements TTSAdapter {
    readonly name = "mock-tts";
    synthesize(request: VoiceRequest): Promise<TTSResult>;
}
export interface VoiceServiceListeners {
    onVoiceEvent?: (event: VoiceEvent) => void;
    onDuckingChange?: (isDucked: boolean, duckDb: number) => void;
}
export declare class VoiceService {
    private readonly _adapter;
    private readonly _duckingController;
    private readonly _listeners;
    private _isSpeaking;
    private _currentRequestId;
    private _currentTimer;
    constructor(options?: {
        adapter?: TTSAdapter;
        listeners?: VoiceServiceListeners;
    });
    get isSpeaking(): boolean;
    get currentRequestId(): string | null;
    get duckingController(): AudioDuckingController;
    /**
     * Speak text with automated ducking and lifecycle events.
     */
    speak(request: VoiceRequest): Promise<TTSResult>;
    interrupt(reason?: string): void;
    private _finishSpeech;
    destroy(): void;
}
//# sourceMappingURL=index.d.ts.map