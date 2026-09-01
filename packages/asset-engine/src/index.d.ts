/**
 * @idol/asset-engine
 *
 * Deterministic Asset Registry & Asset Router for Hybrid AI Idol.
 *
 * Rules (from PLAN.md):
 * - LLM never selects raw filenames.
 * - All video selection goes through Asset Router.
 * - Selection enforces cooldowns, anti-repetition, and tag matching.
 * - Every state has a fallback to GAMEPLAY_IDLE.
 */
import { z } from 'zod';
import type { VisualState, Emotion } from '@idol/event-schema';
export declare const TransitionType: z.ZodEnum<["cut", "dissolve", "swipe", "overlay"]>;
export type TransitionType = z.infer<typeof TransitionType>;
export declare const AssetMetadata: z.ZodObject<{
    id: z.ZodString;
    state: z.ZodString;
    file: z.ZodString;
    durationMs: z.ZodNumber;
    loop: z.ZodDefault<z.ZodBoolean>;
    interruptible: z.ZodDefault<z.ZodBoolean>;
    audioEmbedded: z.ZodDefault<z.ZodBoolean>;
    voiceAllowed: z.ZodDefault<z.ZodBoolean>;
    transitionEnter: z.ZodDefault<z.ZodEnum<["cut", "dissolve", "swipe", "overlay"]>>;
    transitionExit: z.ZodDefault<z.ZodString>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    cooldownMs: z.ZodDefault<z.ZodNumber>;
    lastPlayedAt: z.ZodDefault<z.ZodNumber>;
    playCount: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    state: string;
    id: string;
    file: string;
    durationMs: number;
    loop: boolean;
    interruptible: boolean;
    audioEmbedded: boolean;
    voiceAllowed: boolean;
    transitionEnter: "cut" | "dissolve" | "swipe" | "overlay";
    transitionExit: string;
    tags: string[];
    cooldownMs: number;
    lastPlayedAt: number;
    playCount: number;
}, {
    state: string;
    id: string;
    file: string;
    durationMs: number;
    loop?: boolean | undefined;
    interruptible?: boolean | undefined;
    audioEmbedded?: boolean | undefined;
    voiceAllowed?: boolean | undefined;
    transitionEnter?: "cut" | "dissolve" | "swipe" | "overlay" | undefined;
    transitionExit?: string | undefined;
    tags?: string[] | undefined;
    cooldownMs?: number | undefined;
    lastPlayedAt?: number | undefined;
    playCount?: number | undefined;
}>;
export type AssetMetadata = z.infer<typeof AssetMetadata>;
export interface AssetSelectionOptions {
    avoidRecentCount?: number;
    preferredTags?: string[];
    maxDurationMs?: number;
    emotion?: Emotion;
    currentTime?: number;
}
export declare const DEFAULT_IDOL_ASSETS: AssetMetadata[];
export declare class AssetRegistry {
    private _assets;
    constructor(initialAssets?: AssetMetadata[]);
    register(asset: AssetMetadata): void;
    unregister(id: string): boolean;
    get(id: string): AssetMetadata | undefined;
    has(id: string): boolean;
    getByState(state: VisualState | string): AssetMetadata[];
    getAll(): AssetMetadata[];
    count(): number;
    updatePlayRecord(id: string, playedAt?: number): void;
}
export declare class AssetRouter {
    private readonly _registry;
    private _recentClipIds;
    private readonly _maxRecentHistory;
    constructor(registry: AssetRegistry, maxRecentHistory?: number);
    get registry(): AssetRegistry;
    /**
     * Safe selection algorithm:
     * 1. Query all assets matching the target VisualState.
     * 2. If no assets found, fallback to GAMEPLAY_IDLE.
     * 3. Filter out clips currently on cooldown.
     * 4. Exclude recently played clips (anti-repetition).
     * 5. Filter/sort by preferred tags or duration if specified.
     * 6. Pick least recently used / lowest play count among candidates.
     */
    selectClip(state: VisualState | string, options?: AssetSelectionOptions): AssetMetadata;
    private _recordSelection;
    getRecentHistory(): ReadonlyArray<string>;
    clearHistory(): void;
}
//# sourceMappingURL=index.d.ts.map