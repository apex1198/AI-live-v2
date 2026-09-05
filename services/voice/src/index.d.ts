/**
 * @idol/voice
 *
 * Realtime TTS & Audio Ducking Service for Hybrid AI Idol.
 * Streamlined to 2 core engines:
 * 1. ElevenLabs TTS (Multilingual v2)
 * 2. Web Speech API (Local zero-latency fallback)
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
    audioBase64?: string | undefined;
    provider: 'elevenlabs' | 'webspeech';
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
export declare class WebSpeechTTSAdapter implements TTSAdapter {
    readonly name = "webspeech-tts";
    synthesize(request: VoiceRequest): Promise<TTSResult>;
}
export interface ElevenLabsConfig {
    apiKey: string;
    voiceId?: string;
    modelId?: string;
    languageCode?: string;
    stability?: number;
    similarityBoost?: number;
    timeoutMs?: number;
}
export declare const ELEVENLABS_VOICE_PRESETS: Record<string, string>;
export declare class ElevenLabsTTSAdapter implements TTSAdapter {
    readonly name = "elevenlabs-tts";
    private _config;
    private _queue;
    constructor(config: ElevenLabsConfig);
    updateConfig(config: Partial<ElevenLabsConfig>): void;
    private _resolveVoiceId;
    synthesize(request: VoiceRequest): Promise<TTSResult>;
}
export interface VoiceServiceListeners {
    onVoiceEvent?: (event: VoiceEvent) => void;
    onDuckingChange?: (isDucked: boolean, duckDb: number) => void;
    onGenerationStatus?: (status: 'idle' | 'generating' | 'playing' | 'error', details?: string) => void;
}
export declare class VoiceService {
    private _adapter;
    private readonly _duckingController;
    private readonly _listeners;
    private _isSpeaking;
    private _currentRequestId;
    private _currentTimer;
    private _speakGeneration;
    constructor(options?: {
        adapter?: TTSAdapter;
        listeners?: VoiceServiceListeners;
    });
    get adapter(): TTSAdapter;
    setAdapter(adapter: TTSAdapter): void;
    get isSpeaking(): boolean;
    get currentRequestId(): string | null;
    get duckingController(): AudioDuckingController;
    /**
     * Speak text with automated ducking, progress callback and lifecycle events.
     */
    speak(request: VoiceRequest): Promise<TTSResult>;
    interrupt(reason?: string): void;
    private _finishSpeech;
    destroy(): void;
}
//# sourceMappingURL=index.d.ts.map