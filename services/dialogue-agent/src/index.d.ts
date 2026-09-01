/**
 * @idol/dialogue-agent
 *
 * Natural Language Dialogue Generator for Hybrid AI Idol.
 *
 * Rules (from PLAN.md):
 * - Generates natural language based on structured DirectorIntent.
 * - Keeps spoken responses concise (3-6 seconds speech length).
 * - Multi-provider (Mock / Gemini / OpenAI) with automatic offline fallback.
 * - Stream continues even if LLM service fails.
 */
import type { DirectorIntent, Emotion } from '@idol/event-schema';
export interface CharacterPersona {
    name: string;
    streamName: string;
    personality: string;
    language: string;
    catchphrases: string[];
}
export declare const DEFAULT_IDOL_PERSONA: CharacterPersona;
export interface DialogueGenerationResult {
    text: string;
    emotion: Emotion;
    estimatedDurationMs: number;
    provider: string;
}
export interface DialogueProvider {
    name: string;
    generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string>;
}
export declare class MockDialogueProvider implements DialogueProvider {
    readonly name = "mock-template-provider";
    generate(intent: DirectorIntent, _persona: CharacterPersona): Promise<string>;
}
export declare class DialogueAgent {
    private readonly _persona;
    private readonly _providers;
    private _activeProviderIndex;
    constructor(options?: {
        persona?: CharacterPersona;
        providers?: DialogueProvider[];
    });
    get persona(): CharacterPersona;
    generateDialogue(intent: DirectorIntent): Promise<DialogueGenerationResult>;
}
//# sourceMappingURL=index.d.ts.map