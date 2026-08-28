/**
 * @idol/event-schema
 *
 * Single source of truth for ALL events flowing through the
 * Hybrid AI Idol Livestream event bus.
 *
 * Rule: Nothing in Agent Core or services may invent its own
 * event shapes. Import from here.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────
// 1. Shared primitives
// ─────────────────────────────────────────────────────────

export const TimestampMs = z.number().int().positive();

/** Priority levels — lower number = higher priority */
export const Priority = z.union([
  z.literal(0), // P0 Emergency / Operator override
  z.literal(1), // P1 BIG_WIN / JACKPOT
  z.literal(2), // P2 Donation
  z.literal(3), // P3 Direct chat response
  z.literal(4), // P4 Game reaction
  z.literal(5), // P5 Scripted goal
  z.literal(6), // P6 Proactive conversation
  z.literal(7), // P7 Idle
]);
export type Priority = z.infer<typeof Priority>;

// ─────────────────────────────────────────────────────────
// 2. Visual States
// ─────────────────────────────────────────────────────────

export const VisualState = z.enum([
  'BOOT',
  'GAMEPLAY_IDLE',
  'GAMEPLAY_FOCUS',
  'LISTENING',
  'TALKING',
  'HAPPY',
  'BIG_WIN',
  'JACKPOT',
  'LOSE',
  'SURPRISED',
  'LAUGH',
  'INVITE_PLAY',
  'CTA',
  'THANK_DONATION',
  'AFK',
  'RECOVERY',
]);
export type VisualState = z.infer<typeof VisualState>;

// ─────────────────────────────────────────────────────────
// 3. Emotion
// ─────────────────────────────────────────────────────────

export const Emotion = z.enum([
  'neutral',
  'happy',
  'excited',
  'surprised',
  'sad',
  'angry',
  'playful',
  'focused',
  'grateful',
  'laughing',
]);
export type Emotion = z.infer<typeof Emotion>;

// ─────────────────────────────────────────────────────────
// 4. Game Events
// ─────────────────────────────────────────────────────────

export const GameEventType = z.enum([
  'game.started',
  'game.round.started',
  'game.round.ended',
  'game.spin',
  'game.reward.small',
  'game.reward.big',
  'game.win',
  'game.mega_win',
  'game.jackpot',
  'game.near_miss',
  'game.free_spins',
  'game.bonus_round',
  'game.lose',
  'game.loss_streak',
  'game.level_up',
  'game.waiting',
  'game.error',
  'game.disconnected',
]);
export type GameEventType = z.infer<typeof GameEventType>;

export const GameEvent = z.object({
  type: GameEventType,
  value: z.number().optional(),
  multiplier: z.number().optional(),
  betAmount: z.number().optional(),
  currency: z.string().optional(),
  gameId: z.string().optional(),
  streakCount: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: TimestampMs,
});
export type GameEvent = z.infer<typeof GameEvent>;

// ─────────────────────────────────────────────────────────
// 5. Chat Events
// ─────────────────────────────────────────────────────────

export const ChatPlatform = z.enum(['youtube', 'twitch', 'tiktok', 'facebook', 'discord', 'mock']);
export type ChatPlatform = z.infer<typeof ChatPlatform>;

export const ViewerTier = z.enum(['regular', 'subscriber', 'vip', 'moderator', 'top_donor']);
export type ViewerTier = z.infer<typeof ViewerTier>;

export const ChatSentiment = z.enum(['positive', 'negative', 'neutral', 'question']);
export type ChatSentiment = z.infer<typeof ChatSentiment>;

export const ChatClassification = z.enum([
  'IGNORE',
  'ACKNOWLEDGE',
  'ANSWER',
  'PRIORITY_ANSWER',
  'MODERATION',
]);
export type ChatClassification = z.infer<typeof ChatClassification>;

export const ChatMessage = z.object({
  type: z.literal('chat.message'),
  platform: ChatPlatform,
  liveSessionId: z.string().trim().min(1).max(160).optional(),
  viewerId: z.string(),
  viewerName: z.string(),
  avatarUrl: z.string().optional(),
  message: z.string().max(500),
  viewerTier: ViewerTier.default('regular'),
  isSuperChat: z.boolean().default(false),
  isSubscriber: z.boolean().default(false),
  sentiment: ChatSentiment.optional(),
  priorityScore: z.number().min(0).max(100).default(50),
  isQuestion: z.boolean().default(false),
  timestamp: TimestampMs,
});
export type ChatMessage = z.infer<typeof ChatMessage>;

// ─────────────────────────────────────────────────────────
// 6. Gift & Donation Events
// ─────────────────────────────────────────────────────────

export const GiftEvent = z.object({
  type: z.literal('chat.gift'),
  platform: ChatPlatform,
  viewerId: z.string(),
  viewerName: z.string(),
  giftName: z.string(),
  giftCount: z.number().int().positive().default(1),
  diamondValue: z.number().positive().optional(),
  timestamp: TimestampMs,
});
export type GiftEvent = z.infer<typeof GiftEvent>;

export const DonationEvent = z.object({
  type: z.literal('donation.received'),
  platform: ChatPlatform,
  viewerId: z.string(),
  viewerName: z.string(),
  amount: z.number().positive(),
  currency: z.string().default('VND'),
  message: z.string().max(300).optional(),
  timestamp: TimestampMs,
});
export type DonationEvent = z.infer<typeof DonationEvent>;

// ─────────────────────────────────────────────────────────
// 7. Director / Agent Events
// ─────────────────────────────────────────────────────────

export const DirectorIntent = z.object({
  type: z.literal('director.intent'),
  action: z.enum(['SPEAK', 'REACT', 'CHANGE_STATE', 'TRIGGER_GOAL', 'WAIT', 'SKIP']),
  intent: z.string().optional(),            // e.g. "celebrate_big_win"
  emotion: Emotion.optional(),
  visualState: VisualState.optional(),
  speechText: z.string().optional(),        // pre-generated or hint
  dialogueProvider: z.string().trim().min(1).max(120).optional(),
  maxSpeechSeconds: z.number().optional(),
  priority: Priority,
  goalId: z.string().optional(),
  timestamp: TimestampMs,
});
export type DirectorIntent = z.infer<typeof DirectorIntent>;

// ─────────────────────────────────────────────────────────
// 8. Voice / TTS Events
// ─────────────────────────────────────────────────────────

export const VoiceRequest = z.object({
  type: z.literal('voice.request'),
  text: z.string().max(1000),
  emotion: Emotion.default('neutral'),
  energy: z.number().min(0).max(1).default(0.7),
  speedMultiplier: z.number().min(0.5).max(2.0).default(1.0),
  interruptible: z.boolean().default(true),
  requestId: z.string(),
  timestamp: TimestampMs,
});
export type VoiceRequest = z.infer<typeof VoiceRequest>;

export const VoiceEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('voice.started'),
    requestId: z.string(),
    text: z.string().optional(),
    emotion: Emotion.optional(),
    estimatedDurationMs: z.number().optional(),
    audioBase64: z.string().optional(),
    timestamp: TimestampMs,
  }),
  z.object({ type: z.literal('voice.finished'), requestId: z.string(), timestamp: TimestampMs }),
  z.object({ type: z.literal('voice.interrupted'), requestId: z.string(), timestamp: TimestampMs }),
  z.object({ type: z.literal('voice.error'), requestId: z.string(), error: z.string(), timestamp: TimestampMs }),
]);
export type VoiceEvent = z.infer<typeof VoiceEvent>;

// ─────────────────────────────────────────────────────────
// 9. Asset / State Events
// ─────────────────────────────────────────────────────────

export const AssetRequest = z.object({
  type: z.literal('asset.request'),
  state: VisualState,
  emotion: Emotion.optional(),
  avoidRecentCount: z.number().int().default(2),
  maxDurationMs: z.number().optional(),
  timestamp: TimestampMs,
});
export type AssetRequest = z.infer<typeof AssetRequest>;

export const StateTransition = z.object({
  type: z.literal('state.transition'),
  fromState: VisualState,
  toState: VisualState,
  assetId: z.string().optional(),
  reason: z.string().optional(),
  timestamp: TimestampMs,
});
export type StateTransition = z.infer<typeof StateTransition>;

// ─────────────────────────────────────────────────────────
// 10. OBS Events
// ─────────────────────────────────────────────────────────

export const OBSCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('switch_scene'),    sceneName: z.string() }),
  z.object({ action: z.literal('show_source'),     sourceName: z.string() }),
  z.object({ action: z.literal('hide_source'),     sourceName: z.string() }),
  z.object({ action: z.literal('play_media'),      sourceName: z.string() }),
  z.object({ action: z.literal('stop_media'),      sourceName: z.string() }),
  z.object({ action: z.literal('set_text'),        sourceName: z.string(), text: z.string() }),
  z.object({ action: z.literal('mute_source'),     sourceName: z.string() }),
  z.object({ action: z.literal('unmute_source'),   sourceName: z.string() }),
  z.object({ action: z.literal('duck_audio'),      duckDb: z.number().default(-12) }),
  z.object({ action: z.literal('restore_audio') }),
]);
export type OBSCommand = z.infer<typeof OBSCommand>;

// ─────────────────────────────────────────────────────────
// 11. Goal Events
// ─────────────────────────────────────────────────────────

export const GoalType = z.enum([
  'INVITE_PLAY',
  'EXPLAIN_GAME',
  'BUILD_EXCITEMENT',
  'ASK_CHAT_QUESTION',
  'THANK_VIEWERS',
  'FOLLOW',
  'SHARE',
  'JOIN',
  'DONATE',
  'PROMO',
  'RETENTION',
  'RETURN_TO_GAME',
]);
export type GoalType = z.infer<typeof GoalType>;

export const GoalEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('goal.triggered'),
    goalType: GoalType,
    goalId: z.string(),
    priority: Priority,
    timestamp: TimestampMs,
  }),
  z.object({
    type: z.literal('goal.completed'),
    goalId: z.string(),
    timestamp: TimestampMs,
  }),
  z.object({
    type: z.literal('goal.cancelled'),
    goalId: z.string(),
    reason: z.string(),
    timestamp: TimestampMs,
  }),
]);
export type GoalEvent = z.infer<typeof GoalEvent>;

// ─────────────────────────────────────────────────────────
// 12. Operator / Override Events
// ─────────────────────────────────────────────────────────

export const OperatorCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('PAUSE_AI') }),
  z.object({ action: z.literal('RESUME_AI') }),
  z.object({ action: z.literal('MUTE_AI') }),
  z.object({ action: z.literal('UNMUTE_AI') }),
  z.object({ action: z.literal('KILL_SWITCH') }),
  z.object({ action: z.literal('FORCE_STATE'),  state: VisualState }),
  z.object({ action: z.literal('FORCE_CTA') }),
  z.object({ action: z.literal('SKIP_CLIP') }),
  z.object({ action: z.literal('CLEAR_QUEUE') }),
  z.object({ action: z.literal('CHANGE_PHASE'), phase: z.string() }),
]);
export type OperatorCommand = z.infer<typeof OperatorCommand>;

// ─────────────────────────────────────────────────────────
// 13. Bus Event — union of ALL events
// ─────────────────────────────────────────────────────────

/**
 * BusEvent wraps any event with routing metadata.
 * This is the type flowing through the Event Bus.
 */
export const BusEvent = z.object({
  id: z.string(),               // unique event id (nanoid)
  priority: Priority,
  source: z.enum(['game', 'chat', 'donation', 'director', 'voice', 'asset', 'obs', 'goal', 'operator', 'timer', 'mock']),
  payload: z.union([
    GameEvent,
    ChatMessage,
    DonationEvent,
    DirectorIntent,
    VoiceRequest,
    VoiceEvent,
    AssetRequest,
    StateTransition,
    GoalEvent,
  ]),
  enqueuedAt: TimestampMs,
  expiresAt: TimestampMs.optional(),
});
export type BusEvent = z.infer<typeof BusEvent>;

// ─────────────────────────────────────────────────────────
// 14. Convenience helpers
// ─────────────────────────────────────────────────────────

/** Map a game event type to its default priority */
export function gameEventPriority(type: GameEventType): Priority {
  switch (type) {
    case 'game.jackpot':      return 1;
    case 'game.reward.big':   return 1;
    case 'game.win':          return 4;
    case 'game.lose':         return 4;
    case 'game.level_up':     return 4;
    case 'game.reward.small': return 4;
    default:                  return 7;
  }
}

/** Map a game event type to the recommended VisualState */
export function gameEventToVisualState(type: GameEventType): VisualState {
  switch (type) {
    case 'game.jackpot':      return 'JACKPOT';
    case 'game.reward.big':   return 'BIG_WIN';
    case 'game.win':          return 'HAPPY';
    case 'game.lose':         return 'LOSE';
    case 'game.level_up':     return 'HAPPY';
    case 'game.reward.small': return 'HAPPY';
    default:                  return 'GAMEPLAY_IDLE';
  }
}
