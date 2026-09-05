/**
 * @idol/dialogue-agent
 *
 * Natural Language Dialogue Generator for Hybrid AI Idol.
 * Supports local Qwen and OpenAI-compatible dialogue providers.
 */
import type { DirectorIntent, Emotion } from '@idol/event-schema';
export interface CharacterPersona {
    name: string;
    streamName: string;
    personality: string;
    language: string;
    catchphrases: string[];
    systemPrompt?: string;
    sessionSkillMarkdown?: string;
}
export declare const DEFAULT_IDOL_PERSONA: CharacterPersona;
export interface DialogueGenerationResult {
    /** Backwards-compatible alias for speechText. */
    text: string;
    /** Natural text intended for YouTube/Facebook chat and visual subtitles. */
    replyText: string;
    /** Speech-safe text intended exclusively for TTS. */
    speechText: string;
    emotion: Emotion;
    estimatedDurationMs: number;
    provider: string;
}
export interface DialogueProvider {
    name: string;
    generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string>;
}
/** Converts display-oriented LLM output into clean Vietnamese speech text for TTS. */
export declare function normalizeVietnameseSpokenText(input: string): string;
/** Removes non-spoken metadata and caps length without inventing extra dialogue. */
export declare function constrainLiveReply(input: string): string;
export interface OpenAILLMConfig {
    apiKey: string;
    model?: string;
    temperature?: number;
    baseUrl?: string;
    providerName?: string;
}
export declare class OpenAIDialogueProvider implements DialogueProvider {
    readonly name: string;
    private readonly _config;
    constructor(config: OpenAILLMConfig);
    generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string>;
}
export interface OllamaLLMConfig {
    endpoint?: string;
    model?: string;
    timeoutMs?: number;
}
export declare class OllamaDialogueProvider implements DialogueProvider {
    readonly name = "qwen";
    private readonly _config;
    constructor(config?: OllamaLLMConfig);
    generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string>;
}
export declare class DialogueAgent {
    private _persona;
    private _providers;
    private _activeProviderIndex;
    constructor(options?: {
        persona?: CharacterPersona;
        providers?: DialogueProvider[];
    });
    get persona(): CharacterPersona;
    updatePersona(persona: Partial<CharacterPersona>): void;
    setProviders(providers: DialogueProvider[]): void;
    generateDialogue(intent: DirectorIntent): Promise<DialogueGenerationResult>;
}
//# sourceMappingURL=index.d.ts.map