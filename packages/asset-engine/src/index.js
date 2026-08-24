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
// ─────────────────────────────────────────────────────────
// 1. Asset Metadata Schema
// ─────────────────────────────────────────────────────────
export const TransitionType = z.enum(['cut', 'dissolve', 'swipe', 'overlay']);
export const AssetMetadata = z.object({
    id: z.string(),
    state: z.string(), // VisualState compatible
    file: z.string(),
    durationMs: z.number().int().nonnegative(),
    loop: z.boolean().default(false),
    interruptible: z.boolean().default(true),
    audioEmbedded: z.boolean().default(false),
    voiceAllowed: z.boolean().default(true),
    transitionEnter: TransitionType.default('cut'),
    transitionExit: z.string().default('GAMEPLAY_IDLE'),
    tags: z.array(z.string()).default([]),
    cooldownMs: z.number().int().nonnegative().default(0),
    lastPlayedAt: z.number().int().default(0),
    playCount: z.number().int().default(0),
});
// ─────────────────────────────────────────────────────────
// 2. Default Built-in Catalog for idol_01
// ─────────────────────────────────────────────────────────
export const DEFAULT_IDOL_ASSETS = [
    // ── 1. Gameplay & Focus (Loop / Background) ──
    {
        id: 'gameplay_idle_01',
        state: 'GAMEPLAY_IDLE',
        file: 'gameplay_idle_01.mp4',
        durationMs: 45_000,
        loop: true,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['idle', 'calm', 'gameplay', 'loop'],
        cooldownMs: 0,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'gameplay_idle_02',
        state: 'GAMEPLAY_IDLE',
        file: 'gameplay_idle_02.mp4',
        durationMs: 60_000,
        loop: true,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['idle', 'ambient', 'gameplay', 'loop'],
        cooldownMs: 0,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'gameplay_idle_03',
        state: 'GAMEPLAY_IDLE',
        file: 'gameplay_idle_03.mp4',
        durationMs: 40_000,
        loop: true,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['idle', 'chill', 'gameplay', 'loop'],
        cooldownMs: 0,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'gameplay_focus_01',
        state: 'GAMEPLAY_FOCUS',
        file: 'gameplay_focus_01.mp4',
        durationMs: 30_000,
        loop: true,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['focus', 'intense', 'gameplay'],
        cooldownMs: 15_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'gameplay_focus_02',
        state: 'GAMEPLAY_FOCUS',
        file: 'gameplay_focus_02.mp4',
        durationMs: 35_000,
        loop: true,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['focus', 'clutch', 'gameplay'],
        cooldownMs: 15_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    // ── 2. Reactions & Game Milestones ──
    {
        id: 'jackpot_01',
        state: 'JACKPOT',
        file: 'jackpot_01.mp4',
        durationMs: 6_000,
        loop: false,
        interruptible: false,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'BIG_WIN',
        tags: ['jackpot', 'high_energy', 'celebrate'],
        cooldownMs: 30_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'big_win_01',
        state: 'BIG_WIN',
        file: 'big_win_01.mp4',
        durationMs: 5_000,
        loop: false,
        interruptible: false,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['big_win', 'celebrate', 'cheer'],
        cooldownMs: 20_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'big_win_02',
        state: 'BIG_WIN',
        file: 'big_win_02.mp4',
        durationMs: 4_800,
        loop: false,
        interruptible: false,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['big_win', 'cheer', 'dance'],
        cooldownMs: 20_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'happy_01',
        state: 'HAPPY',
        file: 'happy_01.mp4',
        durationMs: 3_500,
        loop: false,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['happy', 'smile', 'small_win'],
        cooldownMs: 10_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'happy_02',
        state: 'HAPPY',
        file: 'happy_02.mp4',
        durationMs: 4_000,
        loop: false,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['happy', 'clap', 'positive'],
        cooldownMs: 10_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'lose_01',
        state: 'LOSE',
        file: 'lose_01.mp4',
        durationMs: 4_000,
        loop: false,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['lose', 'pout', 'funny'],
        cooldownMs: 15_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'lose_02',
        state: 'LOSE',
        file: 'lose_02.mp4',
        durationMs: 3_500,
        loop: false,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['lose', 'sigh', 'dramatic'],
        cooldownMs: 15_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'surprised_01',
        state: 'SURPRISED',
        file: 'surprised_01.mp4',
        durationMs: 3_000,
        loop: false,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['shock', 'gasp', 'surprise'],
        cooldownMs: 10_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'laugh_01',
        state: 'LAUGH',
        file: 'laugh_01.mp4',
        durationMs: 3_500,
        loop: false,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['laugh', 'giggle', 'fun'],
        cooldownMs: 10_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    // ── 3. Goals, CTA & Interaction ──
    {
        id: 'invite_play_01',
        state: 'INVITE_PLAY',
        file: 'invite_play_01.mp4',
        durationMs: 6_000,
        loop: false,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['invite', 'point', 'welcome'],
        cooldownMs: 60_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'invite_play_02',
        state: 'INVITE_PLAY',
        file: 'invite_play_02.mp4',
        durationMs: 5_500,
        loop: false,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['invite', 'wave', 'co-op'],
        cooldownMs: 60_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'cta_soft_01',
        state: 'CTA',
        file: 'cta_soft_01.mp4',
        durationMs: 8_000,
        loop: false,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['cta', 'like', 'follow', 'soft'],
        cooldownMs: 90_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'cta_hard_01',
        state: 'CTA',
        file: 'cta_hard_01.mp4',
        durationMs: 8_000,
        loop: false,
        interruptible: true,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['cta', 'join_link', 'direct'],
        cooldownMs: 120_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
    {
        id: 'thank_donation_01',
        state: 'THANK_DONATION',
        file: 'thank_donation_01.mp4',
        durationMs: 5_000,
        loop: false,
        interruptible: false,
        audioEmbedded: false,
        voiceAllowed: true,
        transitionEnter: 'cut',
        transitionExit: 'GAMEPLAY_IDLE',
        tags: ['heart', 'thank', 'bow', 'gift'],
        cooldownMs: 5_000,
        lastPlayedAt: 0,
        playCount: 0,
    },
];
// ─────────────────────────────────────────────────────────
// 3. Asset Registry
// ─────────────────────────────────────────────────────────
export class AssetRegistry {
    _assets = new Map();
    constructor(initialAssets = DEFAULT_IDOL_ASSETS) {
        for (const asset of initialAssets) {
            this.register(asset);
        }
    }
    register(asset) {
        const validated = AssetMetadata.parse(asset);
        this._assets.set(validated.id, validated);
    }
    unregister(id) {
        return this._assets.delete(id);
    }
    get(id) {
        return this._assets.get(id);
    }
    has(id) {
        return this._assets.has(id);
    }
    getByState(state) {
        const list = [];
        for (const asset of this._assets.values()) {
            if (asset.state === state) {
                list.push(asset);
            }
        }
        return list;
    }
    getAll() {
        return Array.from(this._assets.values());
    }
    count() {
        return this._assets.size;
    }
    updatePlayRecord(id, playedAt = Date.now()) {
        const asset = this._assets.get(id);
        if (asset) {
            asset.lastPlayedAt = playedAt;
            asset.playCount += 1;
        }
    }
}
// ─────────────────────────────────────────────────────────
// 4. Deterministic Asset Router
// ─────────────────────────────────────────────────────────
export class AssetRouter {
    _registry;
    _recentClipIds = [];
    _maxRecentHistory;
    constructor(registry, maxRecentHistory = 5) {
        this._registry = registry;
        this._maxRecentHistory = maxRecentHistory;
    }
    get registry() {
        return this._registry;
    }
    /**
     * Safe selection algorithm:
     * 1. Query all assets matching the target VisualState.
     * 2. If no assets found, fallback to GAMEPLAY_IDLE.
     * 3. Filter out clips currently on cooldown.
     * 4. Exclude recently played clips (anti-repetition).
     * 5. Filter/sort by preferred tags or duration if specified.
     * 6. Pick least recently used / lowest play count among candidates.
     */
    selectClip(state, options = {}) {
        const now = options.currentTime ?? Date.now();
        const avoidRecent = options.avoidRecentCount ?? 2;
        let candidates = this._registry.getByState(state);
        // Safe fallback if target state has no clips
        if (candidates.length === 0) {
            candidates = this._registry.getByState('GAMEPLAY_IDLE');
        }
        if (candidates.length === 0) {
            // Ultimate fallback guaranteed
            return DEFAULT_IDOL_ASSETS[0];
        }
        // Filter by cooldown
        const notOnCooldown = candidates.filter(c => {
            if (c.cooldownMs <= 0)
                return true;
            return (now - c.lastPlayedAt) >= c.cooldownMs;
        });
        const pool = notOnCooldown.length > 0 ? notOnCooldown : candidates;
        // Filter out recently played if we have enough candidates
        const recentToAvoid = new Set(this._recentClipIds.slice(-avoidRecent));
        const nonRecent = pool.filter(c => !recentToAvoid.has(c.id));
        const finalPool = nonRecent.length > 0 ? nonRecent : pool;
        // Optional tag scoring
        let selected;
        if (options.preferredTags && options.preferredTags.length > 0) {
            const preferred = new Set(options.preferredTags);
            const scored = [...finalPool].sort((a, b) => {
                const scoreA = a.tags.filter(t => preferred.has(t)).length;
                const scoreB = b.tags.filter(t => preferred.has(t)).length;
                if (scoreB !== scoreA)
                    return scoreB - scoreA;
                return a.lastPlayedAt - b.lastPlayedAt; // LRU
            });
            selected = scored[0];
        }
        else {
            // Pick LRU (least recently used / lowest play count)
            const sorted = [...finalPool].sort((a, b) => {
                if (a.playCount !== b.playCount)
                    return a.playCount - b.playCount;
                return a.lastPlayedAt - b.lastPlayedAt;
            });
            selected = sorted[0];
        }
        // Record usage
        this._recordSelection(selected.id, now);
        return selected;
    }
    _recordSelection(clipId, now) {
        this._registry.updatePlayRecord(clipId, now);
        this._recentClipIds.push(clipId);
        if (this._recentClipIds.length > this._maxRecentHistory) {
            this._recentClipIds.shift();
        }
    }
    getRecentHistory() {
        return this._recentClipIds;
    }
    clearHistory() {
        this._recentClipIds = [];
    }
}
//# sourceMappingURL=index.js.map