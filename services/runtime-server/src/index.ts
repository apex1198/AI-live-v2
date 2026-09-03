/**
 * @idol/runtime-server
 *
 * Central Backend Runtime Server & WebSocket Hub for Hybrid AI Idol Livestream.
 *
 * Combines:
 * - Event Bus & Priority Queue
 * - Stream Director Agent
 * - Dialogue Agent & Voice TTS
 * - OBS WebSocket Controller
 * - Asset Engine & Goal Engine
 * - HTTP REST API & Realtime WebSocket Server for Operator Dashboard
 */

import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';

import {
  type VisualState,
  type DirectorIntent,
  type StateTransition,
  type GameEvent,
  type ChatMessage,
  type DonationEvent,
  type OperatorCommand,
  GameEvent as GameEventSchema,
  ChatMessage as ChatMessageSchema,
  DonationEvent as DonationEventSchema,
  OperatorCommand as OperatorCommandSchema,
  VisualState as VisualStateSchema,
} from '@idol/event-schema';

import { DirectorAgent } from '@idol/director';
import { DialogueAgent } from '@idol/dialogue-agent';
import { VoiceService, type DuckingState } from '@idol/voice';
import { OBSController, type OBSMagicConnectResult } from '@idol/obs-controller';
import { AssetRegistry, AssetRouter, DEFAULT_IDOL_ASSETS } from '@idol/asset-engine';
import { GoalEngine, DEFAULT_GOALS, DEFAULT_STREAM_PHASES } from '@idol/goal-engine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { GameAdapter, SlotSimulatorEngine } from '@idol/game-adapter';
import { ChatManager, MockChatGenerator, SmartChatFilter } from '@idol/chat-adapter';
import { WebSpeechTTSAdapter } from '@idol/voice';
import { OpenAIDialogueProvider, OllamaDialogueProvider } from '@idol/dialogue-agent';
import { MockTalkingProvider, LiveTalkingProvider, TalkingVideoPipeline, MuseTalkBatchPipeline, type VideoFrame } from '@idol/talking-head';
import { RuntimeDatabase } from './persistence.js';
import {
  PlatformChatCoordinator,
  type PlatformChatId,
  type StoredPlatformChatCredentials,
} from './platform-chat.js';

export interface ServerConfig {
  port: number;
  host: string;
  enableSimulation: boolean;
  authToken: string;
  allowedOrigins: string[];
  maxJsonBodyBytes: number;
  maxUploadBytes: number;
  databasePath: string;
}

type LiveVideoQuality = 'hd';
const LIVE_VIDEO_PRESETS: Record<LiveVideoQuality, { width: number; height: number; fps: number }> = {
  hd: { width: 1280, height: 720, fps: 30 },
};

const SafeIdSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const OllamaModelSchema = z.string().trim().min(1).max(120).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/,
  'Model must be a valid Ollama model tag',
);
const LocalAiInstallSchema = z.object({
  model: OllamaModelSchema.optional(),
}).strict();
const EngineActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart']),
}).strict();
const PlatformReplySettingsSchema = z.object({ youtube: z.boolean(), facebook: z.boolean() }).strict();
const ShowCueSchema = z.object({
  id: SafeIdSchema,
  minute: z.number().int().min(0).max(1440),
  phase: z.string().trim().min(1).max(80),
  action: z.enum(['scene', 'speak', 'cta']),
  scene: z.enum(['GAMEPLAY_IDLE', 'GAMEPLAY_FOCUS', 'TALKING', 'CTA', 'INVITE_PLAY', 'HAPPY', 'SURPRISED', 'LAUGH', 'LOSE', 'THANK_DONATION']).optional(),
  prompt: z.string().trim().max(500).default(''),
  enabled: z.boolean().default(true),
}).strict();
const ShowScheduleSchema = z.object({ cues: z.array(ShowCueSchema).max(100) }).strict();
const StorageConfigSchema = z.object({
  rootPath: z.string().trim().min(1).max(1024),
  projectName: SafeIdSchema.default('ai-livestream'),
}).strict();
const StorageJsonSchema = z.object({
  category: z.enum(['avatars/training', 'models', 'metadata', 'outputs']).default('metadata'),
  filename: z.string().trim().min(1).max(120),
  avatarId: SafeIdSchema.optional(),
  data: z.unknown().default({}),
}).strict();
const AvatarSessionSchema = z.object({
  activeAvatarId: SafeIdSchema.nullable(),
  selectedAvatarIds: z.array(SafeIdSchema).max(20).optional(),
  excludedAvatarIds: z.array(SafeIdSchema).max(20).default([]),
}).strict();
const AvatarActivateSchema = z.object({
  avatarId: SafeIdSchema,
}).strict();
const AvatarStateSchema = z.enum([
  'normal', 'happy', 'laughing', 'grateful', 'surprised',
  'excited', 'sad', 'angry', 'playful', 'focused',
]);
const AvatarRecordSchema = z.object({
  id: SafeIdSchema.optional(),
  avatarId: SafeIdSchema.optional(),
  name: z.string().trim().min(1).max(160).optional(),
  modelType: z.enum(['musetalk', 'wav2lip']).optional(),
  taskId: z.string().trim().max(120).optional(),
  status: z.enum(['empty', 'uploading', 'training', 'ready', 'failed']).optional(),
  trainedAt: z.number().int().positive().optional(),
  thumbnailUrl: z.string().max(2048).optional(),
  profileId: SafeIdSchema.optional(),
  avatarState: AvatarStateSchema.optional(),
  frameCount: z.number().int().nonnegative().optional(),
  sourceFps: z.number().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict().refine((value) => Boolean(value.id || value.avatarId), { message: 'Avatar ID is required' });
const RawChatSchema = z.object({
  type: z.literal('chat.message').optional(),
  platform: z.enum(['youtube', 'twitch', 'tiktok', 'facebook', 'discord', 'mock']).default('youtube'),
  liveSessionId: z.string().trim().min(1).max(160).optional(),
  viewerId: z.string().trim().min(1).max(120).optional(),
  viewerName: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(500),
  viewerTier: z.enum(['regular', 'subscriber', 'vip', 'moderator', 'top_donor']).default('regular'),
  isSuperChat: z.boolean().default(false),
  isSubscriber: z.boolean().default(false),
  timestamp: z.number().int().positive().optional(),
}).strict();
const RawGiftSchema = z.object({
  type: z.literal('chat.gift').default('chat.gift'),
  platform: z.enum(['youtube', 'twitch', 'tiktok', 'facebook', 'discord', 'mock']).default('tiktok'),
  viewerId: z.string().trim().min(1).max(120),
  viewerName: z.string().trim().min(1).max(120),
  giftName: z.string().trim().min(1).max(120),
  giftCount: z.number().int().min(1).max(100_000).default(1),
  diamondValue: z.number().positive().max(1_000_000_000).optional(),
  timestamp: z.number().int().positive().default(() => Date.now()),
}).strict();
const FacebookOAuthTokenSchema = z.object({
  state: z.string().trim().min(1).max(256),
  accessToken: z.string().trim().max(4096).default(''),
  expiresIn: z.number().int().nonnegative().max(365 * 24 * 60 * 60).default(0),
  error: z.string().trim().max(1000).default(''),
}).strict();
const GameSpinSchema = z.object({
  bet: z.number().positive().max(1_000_000_000).optional(),
  forcedOutcome: z.enum(['JACKPOT', 'MEGA_WIN', 'BIG_WIN', 'NEAR_MISS', 'BONUS', 'LOSS']).optional(),
}).strict();
const TalkingSettingsSchema = z.object({
  provider: z.enum(['livetalking', 'mock', 'off']).optional(),
  endpoint: z.string().url().max(500).optional(),
  model: z.enum(['musetalk', 'wav2lip', 'wav2lip_gan']).optional(),
  restartIntervalMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).optional(),
  alwaysOn: z.boolean().optional(),
}).strict();
const LiveVideoSettingsSchema = z.object({
  quality: z.literal('hd'),
}).strict();
const AvatarSettingsSchema = z.object({
  preset: SafeIdSchema.optional(),
  customImageUrl: z.string().max(5_000_000).nullable().optional(),
  customImageData: z.string().max(5_000_000).nullable().optional(),
  enablePipCam: z.boolean().optional(),
  enableAuraGlow: z.boolean().optional(),
}).strict();
const MuseTalkBatchSchema = z.object({
  videoPath: z.string().trim().min(1).max(1024),
  audioPath: z.string().trim().min(1).max(1024),
  videoFilename: z.string().trim().min(1).max(120).optional(),
  audioFilename: z.string().trim().min(1).max(120).optional(),
  bboxShift: z.number().int().min(-50).max(50).default(0),
}).strict();
const SpeechCommandSchema = z.object({
  commandId: SafeIdSchema.optional(),
  text: z.string().trim().min(1).max(1000),
  emotion: z.enum(['neutral', 'happy', 'excited', 'surprised', 'sad', 'angry', 'playful', 'focused', 'grateful', 'laughing']).default('happy'),
  speed: z.number().min(0.5).max(2).default(1),
  durationMs: z.number().int().min(250).max(120_000).optional(),
  avatarId: SafeIdSchema.optional(),
  state: VisualStateSchema.optional(),
}).strict();
const SpeechSynthesisSchema = z.object({
  commandId: SafeIdSchema.optional(),
  text: z.string().trim().min(1).max(1000),
  emotion: z.enum(['neutral', 'happy', 'excited', 'surprised', 'sad', 'angry', 'playful', 'focused', 'grateful', 'laughing']).default('happy'),
  speed: z.number().min(0.5).max(2).default(1),
  provider: z.enum(['qwentts', 'omnivoice']),
  voiceId: z.string().trim().min(1).max(120).optional(),
  modelId: z.string().trim().min(1).max(120).optional(),
}).strict();
const WebRtcOfferSchema = z.object({
  sdp: z.string().min(1).max(2_000_000),
  type: z.literal('offer').default('offer'),
  avatarId: SafeIdSchema.optional(),
  avatar: SafeIdSchema.optional(),
  clientId: SafeIdSchema.optional(),
}).strict();
const AvatarTrainSchema = z.object({
  video_path: z.string().trim().min(1).max(1024).optional(),
  videoPath: z.string().trim().min(1).max(1024).optional(),
  avatarPath: z.string().trim().min(1).max(1024).optional(),
  avatar_id: SafeIdSchema.optional(),
  model: z.enum(['musetalk', 'wav2lip']).default('musetalk'),
}).strict().refine((value) => Boolean(value.video_path || value.videoPath || value.avatarPath), {
  message: 'A project video path is required',
});
const AvatarBatchItemSchema = z.object({
  video_path: z.string().trim().min(1).max(1024).optional(),
  videoPath: z.string().trim().min(1).max(1024).optional(),
  avatar_id: SafeIdSchema,
  model: z.enum(['musetalk', 'wav2lip']).default('musetalk'),
}).strict().refine((value) => Boolean(value.video_path || value.videoPath), {
  message: 'A project video path is required',
});
const AvatarBatchSchema = z.object({
  items: z.array(AvatarBatchItemSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    if (seen.has(item.avatar_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'avatar_id'],
        message: 'Avatar IDs must be unique within a batch',
      });
    }
    seen.add(item.avatar_id);
  });
});
const VoiceSettingsSchema = z.object({
  provider: z.enum(['qwentts', 'omnivoice']).optional(),
  voiceId: z.string().trim().min(1).max(120).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  pitch: z.number().min(0.5).max(2).optional(),
  languageCode: z.string().trim().min(2).max(16).optional(),
}).strict();
const LiveSessionSettingsSchema = z.object({
  goal: z.string().trim().max(1500).default(''),
  personaBrief: z.string().trim().max(3000).default(''),
  context: z.string().trim().max(3000).default(''),
}).strict();
const ReplySkillUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(160)
    .refine((name) => /^[^/\\]+\.md$/i.test(name), 'Only Markdown files are supported'),
  markdown: z.string().trim().min(1).max(64_000),
}).strict();
const ReplySkillSelectSchema = z.object({
  id: SafeIdSchema,
}).strict();
const PersonaSettingsSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  gender: z.enum(['female', 'male']).optional(),
  ageRange: z.enum(['18-20', '21-24', '25-27', '28-30']).optional(),
  archetype: z.enum(['friendly', 'sweet', 'energetic', 'playful', 'elegant', 'calm', 'professional']).optional(),
  relationshipStyle: z.enum(['close-friend', 'younger-sister', 'younger-brother', 'host', 'adviser', 'entertainer']).optional(),
  personality: z.string().trim().max(1000).optional(),
  speakingTone: z.enum(['natural', 'sweet', 'bright', 'warm', 'calm', 'confident']).optional(),
  energy: z.enum(['low', 'balanced', 'high']).optional(),
  humor: z.enum(['none', 'light', 'playful']).optional(),
  warmth: z.enum(['reserved', 'warm', 'very-warm']).optional(),
  formality: z.enum(['casual', 'balanced', 'polite']).optional(),
  emotionStyle: z.enum(['balanced', 'expressive', 'calm']).optional(),
  catchphrases: z.string().trim().max(500).optional(),
  selfPronoun: z.enum(['em', 'anh', 'mình', 'tôi']).optional(),
  maleViewerPronoun: z.enum(['anh', 'em', 'bạn']).optional(),
  femaleViewerPronoun: z.enum(['chị', 'em', 'bạn']).optional(),
  unknownViewerStrategy: z.enum(['use-name', 'avoid-pronoun', 'ban']).optional(),
  primaryGoal: z.string().trim().max(500).optional(),
  secondaryGoal: z.string().trim().max(500).optional(),
  followUpRate: z.number().int().min(0).max(100).optional(),
  ctaFrequency: z.enum(['off', 'low', 'balanced']).optional(),
  maxChatsPerReply: z.number().int().min(1).max(3).optional(),
  briefSourceType: z.enum(['none', 'markdown', 'google-doc']).optional(),
  briefSourceName: z.string().trim().max(160).optional(),
  briefSourceUrl: z.string().trim().max(1000).optional(),
  briefMarkdown: z.string().trim().max(32_000).optional(),
  systemPrompt: z.string().trim().min(1).max(32_000).optional(),
  llmProvider: z.enum(['mock', 'openai', 'gemini', 'ollama', 'ttm-chatgpt']).optional(),
  llmModel: OllamaModelSchema.optional(),
}).strict();
const PersonaBriefImportSchema = z.object({
  url: z.string().url().max(1000),
}).strict();
const AiDirectorConfigSchema = z.object({
  provider: z.enum(['ollama', 'ttm-chatgpt']),
  model: OllamaModelSchema,
  apiKey: z.string().trim().max(500).optional(),
  clearApiKey: z.boolean().default(false),
}).strict();
const TtmModelsSchema = z.object({
  apiKey: z.string().trim().max(500).optional(),
}).strict();
const VoiceDesignProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  gender: z.enum(['male', 'female']).default('female'),
  age: z.enum(['child', 'teenager', 'young adult', 'middle-aged', 'elderly']).default('young adult'),
  pitch: z.enum(['very low pitch', 'low pitch', 'moderate pitch', 'high pitch', 'very high pitch']).default('moderate pitch'),
  accent: z.enum(['', 'american accent', 'british accent', 'australian accent', 'canadian accent', 'indian accent', 'japanese accent', 'korean accent', 'portuguese accent', 'russian accent', 'chinese accent']).default(''),
  style: z.enum(['', 'whisper']).default(''),
  previewText: z.string().trim().min(1).max(1000),
  performanceMode: z.boolean().default(false),
}).strict();
const VoiceCloneProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sourcePath: z.string().trim().min(1).max(1024),
  transcript: z.string().trim().max(4000).default(''),
  filename: z.string().trim().max(160).optional(),
  provider: z.enum(['qwentts', 'omnivoice']).default('qwentts'),
}).strict();
const ObsSettingsSchema = z.object({
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  autoConnect: z.boolean().optional(),
  playbackOverlapFrames: z.number().int().min(0).max(4).optional(),
  outputResolution: z.enum(['auto', '720', '1080', 'custom']).optional(),
  outputRatio: z.enum(['auto', '16:9', '9:16', 'custom']).optional(),
  customWidth: z.number().int().min(320).max(7680).optional(),
  customHeight: z.number().int().min(180).max(4320).optional(),
}).strict();
const ObsOutputSignalSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('OBS_OUTPUT_REGISTER'),
    role: z.enum(['publisher', 'receiver']),
    peerId: SafeIdSchema,
    sessionId: SafeIdSchema.optional(),
    priority: z.number().int().min(0).max(100).default(10),
  }).strict(),
  z.object({ type: z.literal('OBS_OUTPUT_READY'), sessionId: SafeIdSchema }).strict(),
  z.object({ type: z.literal('OBS_OUTPUT_MEDIA_CONNECTED'), sessionId: SafeIdSchema, negotiationId: SafeIdSchema }).strict(),
  z.object({ type: z.literal('OBS_OUTPUT_RECEIVER_CLOSED'), sessionId: SafeIdSchema }).strict(),
  z.object({
    type: z.literal('OBS_OUTPUT_OFFER'),
    sessionId: SafeIdSchema,
    negotiationId: SafeIdSchema,
    description: z.object({
      type: z.literal('offer'),
      sdp: z.string().min(1).max(2_000_000),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('OBS_OUTPUT_ANSWER'),
    sessionId: SafeIdSchema,
    negotiationId: SafeIdSchema,
    description: z.object({
      type: z.literal('answer'),
      sdp: z.string().min(1).max(2_000_000),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('OBS_OUTPUT_ICE'),
    sessionId: SafeIdSchema,
    negotiationId: SafeIdSchema,
    candidate: z.object({
      candidate: z.string().max(16_000),
      sdpMid: z.string().max(160).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(128).nullable().optional(),
      usernameFragment: z.string().max(512).nullable().optional(),
    }).strict(),
  }).strict(),
]);
const LiveTalkingMediaSignalSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('LIVETALKING_MEDIA_REGISTER'),
    clientId: SafeIdSchema,
    priority: z.number().int().min(0).max(100).default(10),
  }).strict(),
  z.object({
    type: z.literal('LIVETALKING_MEDIA_STATE'),
    clientId: SafeIdSchema,
    sessionId: SafeIdSchema.nullable(),
    connectionState: z.enum(['NEW', 'CONNECTING', 'CONNECTED', 'DISCONNECTED', 'FAILED', 'CLOSED']),
    audioTrack: z.boolean(),
    videoTrack: z.boolean(),
    audioPlayable: z.boolean(),
    audioPackets: z.number().int().nonnegative().default(0),
    videoFrames: z.number().int().nonnegative().default(0),
    reason: z.string().trim().max(240).default('heartbeat'),
  }).strict(),
  z.object({
    type: z.literal('LIVETALKING_MEDIA_RELEASE'),
    clientId: SafeIdSchema,
  }).strict(),
]);

type LiveTalkingMediaRegistration = {
  clientId: string;
  priority: number;
  registeredAt: number;
};

type LiveTalkingMediaOwner = LiveTalkingMediaRegistration & {
  ws: WebSocket;
  sessionId: string | null;
  avatarId: string;
  connectionState: 'NEW' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'FAILED' | 'CLOSED';
  audioTrack: boolean;
  videoTrack: boolean;
  audioPlayable: boolean;
  audioPackets: number;
  videoFrames: number;
  lastAudioProgressAt: number;
  lastVideoProgressAt: number;
  lastHeartbeatAt: number;
};

const GENERATED_REPLY_SKILL_ID = 'generated-live-session';

interface ReplySkillRecord {
  id: string;
  name: string;
  fileName: string;
  markdown: string;
  source: 'uploaded';
  createdAt: string;
  updatedAt: string;
}

interface ReplySkillLibraryState {
  activeSkillId: string;
  items: ReplySkillRecord[];
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function oauthResultPage(provider: string, success: boolean, detail: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] || character);
  const title = success ? `${provider} connected` : `${provider} login failed`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{margin:0;background:#171818;color:#f4f4f4;font:14px -apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;min-height:100vh}.box{max-width:440px;padding:24px;border:1px solid #343636;border-radius:8px;background:#202121}p{color:#b8baba;line-height:1.5}</style></head><body><main class="box"><strong>${escape(title)}</strong><p>${escape(detail)}</p></main>${success ? '<script>setTimeout(()=>window.close(),1200)</script>' : ''}</body></html>`;
}

type DefinedPartial<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

type ObsPublisherRegistration = {
  peerId: string;
  priority: number;
  registeredAt: number;
};

type ObsOutputRoute = {
  sessionId: string;
  receiver: WebSocket | null;
  receiverPeerId: string;
  publisher: WebSocket | null;
  publisherPeerId: string;
  negotiationId: string;
};

export class IdolRuntimeServer {
  private readonly _config: ServerConfig;
  private readonly _httpServer: http.Server;
  private readonly _wss: WebSocketServer;

  private readonly _assetRegistry: AssetRegistry;
  private readonly _assetRouter: AssetRouter;
  private readonly _goalEngine: GoalEngine;
  private readonly _director: DirectorAgent;
  private readonly _dialogueAgent: DialogueAgent;
  private readonly _voiceService: VoiceService;
  private readonly _obsController: OBSController;
  private readonly _gameAdapter: GameAdapter;
  private readonly _chatManager: ChatManager;
  private readonly _mockChat: MockChatGenerator;
  private readonly _platformChat: PlatformChatCoordinator;
  private readonly _liveTalkingProvider: LiveTalkingProvider;
  private readonly _talkingPipeline: TalkingVideoPipeline;
  private readonly _museTalkBatchPipeline: MuseTalkBatchPipeline;
  private readonly _db: RuntimeDatabase;

  private _settings = {
    voice: {
      provider: 'qwentts' as 'qwentts' | 'omnivoice',
      apiKey: '',
      voiceId: 'qwen-default',
      speed: 1.0,
      pitch: 1.0,
      languageCode: 'vi',
      customEndpoint: '',
    },
    liveSession: {
      goal: '',
      personaBrief: '',
      context: '',
      skillMarkdown: '',
    },
    platformReply: { youtube: false, facebook: false },
    showSchedule: { cues: [] as Array<z.infer<typeof ShowCueSchema>> },
    avatar: {
      preset: 'mimi_anime',
      customImageUrl: null as string | null,
      enablePipCam: true,
      enableAuraGlow: true,
    },
    persona: {
      name: 'Mimi',
      gender: 'female' as 'female' | 'male',
      ageRange: '21-24' as '18-20' | '21-24' | '25-27' | '28-30',
      archetype: 'friendly' as 'friendly' | 'sweet' | 'energetic' | 'playful' | 'elegant' | 'calm' | 'professional',
      relationshipStyle: 'close-friend' as 'close-friend' | 'younger-sister' | 'younger-brother' | 'host' | 'adviser' | 'entertainer',
      personality: 'Dễ thương, năng động, hài hước, thích tương tác và hay trêu người xem',
      speakingTone: 'natural' as 'natural' | 'sweet' | 'bright' | 'warm' | 'calm' | 'confident',
      energy: 'balanced' as 'low' | 'balanced' | 'high',
      humor: 'light' as 'none' | 'light' | 'playful',
      warmth: 'warm' as 'reserved' | 'warm' | 'very-warm',
      formality: 'casual' as 'casual' | 'balanced' | 'polite',
      emotionStyle: 'balanced' as 'balanced' | 'expressive' | 'calm',
      catchphrases: '',
      selfPronoun: 'em' as 'em' | 'anh' | 'mình' | 'tôi',
      maleViewerPronoun: 'anh' as 'anh' | 'em' | 'bạn',
      femaleViewerPronoun: 'chị' as 'chị' | 'em' | 'bạn',
      unknownViewerStrategy: 'use-name' as 'use-name' | 'avoid-pronoun' | 'ban',
      primaryGoal: 'Trả lời tự nhiên, tạo cảm giác gần gũi và giữ người xem trong phiên live.',
      secondaryGoal: 'Khuyến khích người xem tiếp tục trò chuyện bằng câu hỏi ngắn phù hợp.',
      followUpRate: 45,
      ctaFrequency: 'low' as 'off' | 'low' | 'balanced',
      maxChatsPerReply: 2,
      briefSourceType: 'none' as 'none' | 'markdown' | 'google-doc',
      briefSourceName: '',
      briefSourceUrl: '',
      briefMarkdown: '',
      systemPrompt: 'Bạn là Mimi, AI Idol streamer người Việt Nam vui tính, năng động và thân thiện. Luôn trả lời bằng tiếng Việt tự nhiên, ngắn gọn trong 1-2 câu. Không tự chuyển sang tiếng Anh.',
      llmProvider: 'ollama' as 'mock' | 'openai' | 'gemini' | 'ollama' | 'ttm-chatgpt',
      llmModel: 'qwen3:8b',
      llmApiKey: process.env['TTM_API_KEY'] || process.env['OPENAI_API_KEY'] || '',
    },
    talkingEngine: {
      provider: 'livetalking' as 'livetalking' | 'mock' | 'off',
      endpoint: process.env['LIVETALKING_ENDPOINT'] || 'http://127.0.0.1:2222',
      model: 'musetalk' as 'musetalk' | 'wav2lip' | 'wav2lip_gan',
      restartIntervalMinutes: 15 as 5 | 10 | 15 | 20,
      alwaysOn: true,
      videoQuality: 'hd' as LiveVideoQuality,
    },
    obs: {
      host: 'localhost',
      port: 4455,
      password: process.env['OBS_WEBSOCKET_PASSWORD'] || '',
      autoConnect: false,
      playbackOverlapFrames: 2,
      outputResolution: 'auto' as 'auto' | '720' | '1080' | 'custom',
      outputRatio: 'auto' as 'auto' | '16:9' | '9:16' | 'custom',
      customWidth: 1280,
      customHeight: 720,
    },
  };

  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _simTimer: ReturnType<typeof setInterval> | null = null;
  private _isRunning = false;
  private _connectedClients: Set<WebSocket> = new Set();
  private _liveTalkingMediaClients = new Map<WebSocket, LiveTalkingMediaRegistration>();
  private _liveTalkingMediaOwner: LiveTalkingMediaOwner | null = null;
  private _lastLiveTalkingMediaWatchdogAt = 0;
  private _obsPublishers = new Map<WebSocket, ObsPublisherRegistration>();
  private _obsOutputRoutes = new Map<string, ObsOutputRoute>();
  private _activeObsOutputSessionId: string | null = null;
  private _obsMagicConnectPromise: Promise<OBSMagicConnectResult> | null = null;
  private _recentLogs: Array<{ level: string; message: string; timestamp: number }> = [];
  private _speechRun = 0;
  private _speechIdleSince = 0;
  private _directorSpeechQueue: Array<{
    command: z.infer<typeof SpeechCommandSchema>;
    dialogueProvider: string;
    source: 'operator' | 'director';
  }> = [];
  private _directorSpeechDrainRunning = false;
  private _avatarStateSwitch: Promise<unknown> = Promise.resolve();
  private _directorGenerationRun = 0;
  private _pendingPlatformReplyTargets: Array<'youtube' | 'facebook'> = [];
  private _executedShowCueIds = new Set<string>();
  private _speechPlaybackGates = new Map<string, { release: () => void; timer: ReturnType<typeof setTimeout> }>();
  private _chatBatchBuffer: ChatMessage[] = [];
  private _chatBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _chatBatchWindowMs = 2_500;
  private readonly _chatBatchMaxMessages = 2;
  private _localModelInstall = { state: 'IDLE' as 'IDLE' | 'INSTALLING' | 'READY' | 'ERROR', progress: '', error: '' };
  private _localModelProcess: ReturnType<typeof spawn> | null = null;
  private _qwenTtsProcess: ReturnType<typeof spawn> | null = null;
  private _qwenTtsStartPromise: Promise<void> | null = null;
  private _qwenTtsState = {
    state: 'OFFLINE' as 'OFFLINE' | 'STARTING' | 'READY' | 'ERROR',
    owned: false,
    pid: null as number | null,
    error: '',
    output: [] as string[],
    updatedAt: Date.now(),
  };
  private _liveTalkingWorkerProcess: ReturnType<typeof spawn> | null = null;
  private _liveTalkingWorkerStartPromise: Promise<Record<string, unknown>> | null = null;
  private _liveTalkingWorkerRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private _liveTalkingMaintenanceTimer: ReturnType<typeof setTimeout> | null = null;
  private _liveTalkingMaintenanceRunning = false;
  private _liveTalkingMaintenancePending = false;
  private _liveTalkingMaintenanceBlocker: 'NONE' | 'SPEECH' | 'TRAINING' | 'MEDIA_SESSION' | 'WORKER_STATUS' = 'NONE';
  private _liveTalkingLastRecycleAt: number | null = null;
  private _liveTalkingWorker = {
    state: 'OFFLINE' as 'OFFLINE' | 'STARTING' | 'READY' | 'STOPPING' | 'ERROR',
    pid: null as number | null,
    owned: false,
    startedAt: null as number | null,
    updatedAt: Date.now(),
    error: '',
    output: [] as string[],
  };
  private _speechRuntime: {
    commandId: string | null;
    state: 'IDLE' | 'GENERATING' | 'SPEAKING' | 'ERROR';
    text: string;
    provider: string;
    dialogueProvider: string;
    durationMs: number | null;
    error: string | null;
    updatedAt: number;
  } = { commandId: null, state: 'IDLE', text: '', provider: '', dialogueProvider: '', durationMs: null, error: null, updatedAt: Date.now() };
  private _projectStorageRoot = path.resolve(process.env['AI_IDOL_PROJECTS_ROOT'] || path.join(process.cwd(), 'local-projects'));
  private _activeProject = 'ai-livestream';
  private readonly _storageConfigPath = path.resolve(process.cwd(), 'runtime-data', 'project-storage.json');
  private _engineLockServer: net.Server | null = null;
  private readonly _engineLockPort = Math.max(1, Math.min(65535, parseInt(process.env['AI_IDOL_ENGINE_LOCK_PORT'] || '18760', 10) || 18760));

  constructor(config: Partial<ServerConfig> = {}) {
    this._config = {
      port: config.port ?? parseInt(process.env['PORT'] || '11111', 10),
      host: config.host ?? process.env['HOST'] ?? '127.0.0.1',
      enableSimulation: config.enableSimulation ?? process.env['ENABLE_SIMULATION'] === 'true',
      authToken: config.authToken ?? process.env['RUNTIME_AUTH_TOKEN'] ?? '',
      allowedOrigins: config.allowedOrigins ?? (process.env['CORS_ALLOWED_ORIGINS'] || 'http://127.0.0.1:11111,http://localhost:11111')
        .split(',').map((origin) => origin.trim()).filter(Boolean),
      maxJsonBodyBytes: config.maxJsonBodyBytes ?? parseInt(process.env['MAX_JSON_BODY_BYTES'] || '1048576', 10),
      maxUploadBytes: config.maxUploadBytes ?? parseInt(process.env['MAX_UPLOAD_BYTES'] || '524288000', 10),
      databasePath: config.databasePath ?? process.env['RUNTIME_DB_PATH'] ?? 'runtime-data/runtime.sqlite',
    };

    if (!isLoopbackHost(this._config.host) && !this._config.authToken) {
      throw new Error('RUNTIME_AUTH_TOKEN is required when the runtime server is exposed beyond localhost');
    }

    this._db = new RuntimeDatabase(this._config.databasePath);
    this._loadProjectStorageConfig();
    this._ensureProjectStorage();
    this._loadRuntimeSettings();
    if (process.env['AI_IDOL_DESKTOP'] === '1') {
      this._settings.talkingEngine.provider = 'livetalking';
      this._settings.talkingEngine.endpoint = process.env['LIVETALKING_ENDPOINT'] || this._settings.talkingEngine.endpoint;
      this._settings.talkingEngine.model = 'musetalk';
    }
    if (!this._settings.liveSession.skillMarkdown) {
      this._settings.liveSession.skillMarkdown = this._buildLiveSessionSkill(this._settings.liveSession);
    }

    // 1. Initialize Subsystems
    this._assetRegistry = new AssetRegistry(DEFAULT_IDOL_ASSETS);
    this._assetRouter = new AssetRouter(this._assetRegistry);
    this._goalEngine = new GoalEngine(DEFAULT_GOALS, DEFAULT_STREAM_PHASES);

    this._dialogueAgent = new DialogueAgent();
    this._dialogueAgent.updatePersona({
      name: this._settings.persona.name,
      personality: this._settings.persona.personality,
      systemPrompt: this._settings.persona.systemPrompt,
      sessionSkillMarkdown: this._activeReplySkillMarkdown(),
    });
    this._configureDialogueProvider();
    this._voiceService = new VoiceService({
      listeners: {
        onVoiceEvent: (event) => this._handleVoiceEvent(event),
        onDuckingChange: (isDucked, duckDb) => this._handleDuckingChange(isDucked, duckDb),
      },
    });

    this._obsController = new OBSController({
      url: `ws://${this._settings.obs.host}:${this._settings.obs.port}`,
      password: this._settings.obs.password,
      autoReconnect: this._settings.obs.autoConnect,
    }, undefined, {
      onStatusChange: (connected) => this._broadcast({
        type: 'OBS_STATUS',
        obs: { connected, sourceName: 'AI IDOL Streamer' },
        timestamp: Date.now(),
      }),
      onLog: (level, message) => this._addLog(level, message),
    });

    // 2. Level 3 Realtime Talking Video Pipeline (LiveTalking Primary + Neural Mesh Fallback)
    this._liveTalkingProvider = new LiveTalkingProvider({
      endpointUrl: this._settings.talkingEngine.endpoint,
      model: this._settings.talkingEngine.model,
      fps: Math.max(1, parseInt(process.env['LIVETALKING_FPS'] || '15', 10) || 15),
      authToken: process.env['LIVETALKING_AUTH_TOKEN'] || '',
    });
    this._talkingPipeline = new TalkingVideoPipeline(this._liveTalkingProvider, new MockTalkingProvider());
    this._museTalkBatchPipeline = new MuseTalkBatchPipeline();

    this._director = new DirectorAgent({
      assetRegistry: this._assetRegistry,
      goalEngine: this._goalEngine,
      listeners: {
        onIntent: (intent) => this._handleDirectorIntent(intent),
        onStateTransition: (trans, asset) => this._handleStateTransition(trans, asset),
        onLog: (level, msg, data) => this._addLog(level, msg, data),
      },
    });

    // 3. Game Telemetry Adapter (Phase 4)
    this._gameAdapter = new GameAdapter();
    this._gameAdapter.onEvent((event) => {
      this._director.injectGameEvent(event);
      this._broadcast({ type: 'GAME_EVENT', event });
    });

    // 4. Multi-Platform Chat Adapter & Filter (Phase 5)
    this._chatManager = new ChatManager();
    this._mockChat = new MockChatGenerator();
    this._chatManager.registerAdapter(this._mockChat);

    this._chatManager.onProcessedMessage((msg) => {
      this._queueChatForReply(msg);
      this._broadcast({ type: 'CHAT_MESSAGE', message: msg });
    });

    this._chatManager.onGift((gift) => {
      this._director.injectDonation({
        type: 'donation.received',
        platform: gift.platform,
        viewerId: gift.viewerId,
        viewerName: gift.viewerName,
        amount: gift.diamondValue || (gift.giftCount * 10),
        currency: 'DIAMOND',
        message: `Đã gửi ${gift.giftCount} ${gift.giftName}!`,
        timestamp: gift.timestamp,
      });
      this._broadcast({ type: 'CHAT_GIFT', gift });
    });

    this._platformChat = new PlatformChatCoordinator({
      port: this._config.port,
      loadCredentials: () => this._db.getSetting<StoredPlatformChatCredentials>('platformChatCredentials') || {},
      saveCredentials: (credentials) => this._db.setSetting('platformChatCredentials', credentials),
      onMessage: (message) => {
        this._chatManager.ingest(message);
      },
      onStatus: (platformChat) => {
        this._broadcast({ type: 'PLATFORM_CHAT_STATUS', platformChat, timestamp: Date.now() });
      },
      onLog: (level, message) => this._addLog(level, message),
    });

    // 5. HTTP Server
    this._httpServer = http.createServer((req, res) => this._handleHttpRequest(req, res));

    // 6. Authenticated WebSocket Server
    this._wss = new WebSocketServer({ noServer: true, maxPayload: this._config.maxJsonBodyBytes });
    this._wss.on('connection', (ws) => this._handleWsConnection(ws));
    this._httpServer.on('upgrade', (req, socket, head) => {
      if (!this._isOriginAllowed(String(req.headers.origin || ''))) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!this._isAuthorized(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this._wss.handleUpgrade(req, socket, head, (ws) => {
        this._wss.emit('connection', ws, req);
      });
    });
  }

  private _safeName(value: unknown, fallback: string): string {
    const safe = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
    return safe || String(fallback || '').slice(0, 120);
  }

  private _safeAvatarPath(root: string, avatarId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(avatarId)) throw new Error('Invalid avatar ID');
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, avatarId);
    if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error('Avatar path is outside the allowed root');
    }
    return target;
  }

  private _pathExists(target: string): boolean {
    try {
      fs.lstatSync(target);
      return true;
    } catch {
      return false;
    }
  }

  private _avatarArtifactRoots(): Array<{ kind: 'project' | 'worker'; root: string }> {
    const repositoryRoot = process.env['AI_IDOL_ENGINE_ROOT']
      ? path.resolve(process.env['AI_IDOL_ENGINE_ROOT'])
      : path.resolve(__dirname, '../../..');
    const workerRoot = path.join(repositoryRoot, 'services', 'talking-head', 'livetalking', 'data', 'avatars');
    return [
      { kind: 'project', root: path.join(this._projectDir(), 'models') },
      { kind: 'project', root: path.join(this._projectDir(), 'avatars', 'source') },
      { kind: 'project', root: path.join(this._projectDir(), 'avatars', 'training') },
      { kind: 'worker', root: workerRoot },
    ];
  }

  private _cleanupAvatarArtifacts(avatarId: string): { projectArtifactFound: boolean; workerArtifactFound: boolean } {
    const result = { projectArtifactFound: false, workerArtifactFound: false };
    for (const { kind, root } of this._avatarArtifactRoots()) {
      const target = this._safeAvatarPath(root, avatarId);
      if (!this._pathExists(target)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      if (kind === 'worker') result.workerArtifactFound = true;
      else result.projectArtifactFound = true;
    }
    return result;
  }

  private _projectAvatarArtifactExists(avatarId: string): boolean {
    return this._avatarArtifactRoots()
      .filter(({ kind }) => kind === 'project')
      .some(({ root }) => this._isMuseTalkAvatarReady(this._safeAvatarPath(root, avatarId)));
  }

  private _isMuseTalkAvatarReady(avatarDir: string): boolean {
    const requiredFiles = ['avator_info.json', 'latents.pt', 'coords.pkl', 'mask_coords.pkl'];
    const requiredDirs = ['full_imgs', 'mask'];
    return requiredFiles.every((name) => fs.existsSync(path.join(avatarDir, name)))
      && requiredDirs.every((name) => {
        const target = path.join(avatarDir, name);
        try {
          return fs.statSync(target).isDirectory() && fs.readdirSync(target).length > 0;
        } catch {
          return false;
        }
      });
  }

  private _removeAvatarManifestRecord(avatarId: string): void {
    const manifestPath = this._avatarManifestPath();
    if (!fs.existsSync(manifestPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(parsed)) return;
      const filtered = parsed.filter((avatar: any) => String(avatar?.id || avatar?.avatarId || '') !== avatarId);
      if (filtered.length !== parsed.length) fs.writeFileSync(manifestPath, JSON.stringify(filtered, null, 2));
    } catch {
      // A malformed legacy manifest must not prevent the database/artifact cleanup.
    }
  }

  private _readProjectAvatarArtifacts(): any[] {
    const modelsRoot = path.resolve(this._projectDir(), 'models');
    if (!fs.existsSync(modelsRoot)) return [];
    const avatars: any[] = [];
    for (const entry of fs.readdirSync(modelsRoot, { withFileTypes: true })) {
      const id = entry.name;
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) continue;
      const entryPath = path.join(modelsRoot, id);
      let avatarDir: string;
      try {
        avatarDir = fs.realpathSync(entryPath);
        const realRoot = fs.realpathSync(modelsRoot);
        if (avatarDir === realRoot || !avatarDir.startsWith(`${realRoot}${path.sep}`)) continue;
        if (!fs.statSync(avatarDir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!this._isMuseTalkAvatarReady(avatarDir)) continue;
      let info: any = {};
      try {
        const infoPath = path.join(avatarDir, 'avator_info.json');
        if (fs.existsSync(infoPath)) info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) || {};
      } catch { /* Keep the artifact visible even when legacy metadata is invalid. */ }
      avatars.push({
        id,
        avatarId: id,
        status: 'ready',
        modelType: 'musetalk',
        name: path.basename(String(info.video_path || '')) || id,
        source: 'project',
      });
    }
    return avatars;
  }

  private _isAuthorized(req: http.IncomingMessage): boolean {
    if (!this._config.authToken) return true;
    const authorization = String(req.headers.authorization || '');
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const requestUrl = new URL(req.url || '/', `http://${this._config.host}:${this._config.port}`);
    const queryToken = requestUrl.searchParams.get('token') || '';
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((value) => value.trim());
    const encodedProtocol = protocols.find((value) => value.startsWith('auth.'))?.slice(5) || '';
    let protocolToken = '';
    try {
      if (encodedProtocol) protocolToken = Buffer.from(encodedProtocol, 'base64url').toString('utf8');
    } catch {}
    const candidate = bearer || protocolToken || queryToken;
    if (!candidate) return false;
    const expected = Buffer.from(this._config.authToken);
    const received = Buffer.from(candidate);
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  }

  private _applyCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const origin = String(req.headers.origin || '');
    if (!this._isOriginAllowed(origin)) return false;
    if (!origin) return true;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    return true;
  }

  private _isOriginAllowed(origin: string): boolean {
    if (!origin) return true;
    const sameOrigin = new Set([
      `http://${this._config.host}:${this._config.port}`,
      `http://127.0.0.1:${this._config.port}`,
      `http://localhost:${this._config.port}`,
    ]);
    return sameOrigin.has(origin) || this._config.allowedOrigins.includes(origin);
  }

  private _publicSettings() {
    const { apiKey: _voiceKey, customEndpoint: _voiceEndpoint, ...voice } = this._settings.voice;
    const { llmApiKey: _llmKey, ...persona } = this._settings.persona;
    const { password: _obsPassword, ...obs } = this._settings.obs;
    return {
      voice: {
        ...voice,
        apiKeyConfigured: Boolean(this._settings.voice.apiKey),
      },
      avatar: { ...this._settings.avatar },
      persona: { ...persona, apiKeyConfigured: Boolean(this._settings.persona.llmApiKey) },
      liveSession: { ...this._settings.liveSession },
      platformReply: { ...this._settings.platformReply },
      showSchedule: { cues: this._settings.showSchedule.cues.map((cue) => ({ ...cue })) },
      liveAvatarMaintenance: {
        restartIntervalMinutes: this._settings.talkingEngine.restartIntervalMinutes,
        state: this._liveTalkingMaintenanceRunning
          ? 'RESTARTING'
          : (this._liveTalkingMaintenancePending
            ? (this._liveTalkingMaintenanceBlocker === 'TRAINING'
              ? 'WAITING_FOR_TRAINING'
              : (this._liveTalkingMaintenanceBlocker === 'MEDIA_SESSION'
                ? 'WAITING_FOR_SESSION_END'
                : (this._liveTalkingMaintenanceBlocker === 'WORKER_STATUS' ? 'WAITING_FOR_WORKER' : 'WAITING_FOR_IDLE')))
            : 'SCHEDULED'),
        lastRestartAt: this._liveTalkingLastRecycleAt,
      },
      realtimeStatus: {
        ready: this._liveTalkingWorker.state === 'READY',
        state: this._liveTalkingWorker.state,
        alwaysOn: this._settings.talkingEngine.alwaysOn,
        videoQuality: this._settings.talkingEngine.videoQuality,
      },
      obs: {
        ...obs,
        passwordConfigured: Boolean(this._settings.obs.password),
        connected: this._obsController?.isConnected ?? false,
        sourceName: 'AI IDOL Streamer',
      },
      platformChat: this._platformChat.publicState(),
    };
  }

  private _replySkillSettingKey(): string {
    const projectScope = crypto.createHash('sha256').update(path.resolve(this._projectDir())).digest('hex').slice(0, 16);
    return `replySkills:${projectScope}`;
  }

  private _replySkillFilePath(id: string): string {
    return path.join(this._projectDir(), 'skills', `${id}.md`);
  }

  private _replySkillLibrary(): ReplySkillLibraryState {
    const stored = this._db.getSetting<Partial<ReplySkillLibraryState>>(this._replySkillSettingKey());
    const rawItems = Array.isArray(stored?.items) ? stored.items : [];
    const items = rawItems.filter((item): item is ReplySkillRecord => Boolean(
      item
      && typeof item.id === 'string'
      && /^[a-zA-Z0-9_-]{1,80}$/.test(item.id)
      && typeof item.fileName === 'string'
      && typeof item.markdown === 'string'
      && item.markdown.trim(),
    ));
    const requestedActiveId = typeof stored?.activeSkillId === 'string'
      ? stored.activeSkillId
      : GENERATED_REPLY_SKILL_ID;
    const activeSkillId = requestedActiveId === GENERATED_REPLY_SKILL_ID
      || items.some((item) => item.id === requestedActiveId)
      ? requestedActiveId
      : GENERATED_REPLY_SKILL_ID;
    return { activeSkillId, items };
  }

  private _saveReplySkillLibrary(library: ReplySkillLibraryState): void {
    this._db.setSetting(this._replySkillSettingKey(), library);
  }

  private _replySkillLibraryResponse() {
    const library = this._replySkillLibrary();
    return {
      activeSkillId: library.activeSkillId,
      items: [
        {
          id: GENERATED_REPLY_SKILL_ID,
          name: 'Generated Live Session Skill',
          fileName: 'generated-live-session.md',
          markdown: this._settings.liveSession.skillMarkdown,
          source: 'generated',
          deletable: false,
          createdAt: '',
          updatedAt: '',
        },
        ...library.items.map((item) => ({ ...item, deletable: true })),
      ],
    };
  }

  private _activeReplySkillMarkdown(): string {
    const library = this._replySkillLibrary();
    if (library.activeSkillId === GENERATED_REPLY_SKILL_ID) return this._settings.liveSession.skillMarkdown;
    return library.items.find((item) => item.id === library.activeSkillId)?.markdown
      || this._settings.liveSession.skillMarkdown;
  }

  private _applyActiveReplySkill(): void {
    this._dialogueAgent.updatePersona({ sessionSkillMarkdown: this._activeReplySkillMarkdown() });
  }

  private _uploadReplySkill(input: z.infer<typeof ReplySkillUploadSchema>): ReplySkillRecord {
    this._ensureProjectStorage();
    const id = `skill_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const name = path.basename(input.fileName, path.extname(input.fileName)).trim() || 'Reply Skill';
    const record: ReplySkillRecord = {
      id,
      name,
      fileName: input.fileName,
      markdown: input.markdown,
      source: 'uploaded',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    fs.writeFileSync(this._replySkillFilePath(id), input.markdown, 'utf8');
    const library = this._replySkillLibrary();
    library.items.unshift(record);
    library.items = library.items.slice(0, 50);
    library.activeSkillId = id;
    this._saveReplySkillLibrary(library);
    this._applyActiveReplySkill();
    this._addLog('info', `Live reply skill uploaded and selected: ${input.fileName}`);
    this._broadcast({ type: 'REPLY_SKILLS_UPDATED', replySkills: this._replySkillLibraryResponse() });
    return record;
  }

  private _selectReplySkill(id: string): void {
    const library = this._replySkillLibrary();
    if (id !== GENERATED_REPLY_SKILL_ID && !library.items.some((item) => item.id === id)) {
      throw new Error('Reply skill was not found');
    }
    library.activeSkillId = id;
    this._saveReplySkillLibrary(library);
    this._applyActiveReplySkill();
    this._addLog('info', `Live reply skill selected: ${id}`);
    this._broadcast({ type: 'REPLY_SKILLS_UPDATED', replySkills: this._replySkillLibraryResponse() });
  }

  private _deleteReplySkill(id: string): void {
    if (id === GENERATED_REPLY_SKILL_ID) throw new Error('The generated Live Session skill cannot be deleted');
    const library = this._replySkillLibrary();
    if (!library.items.some((item) => item.id === id)) throw new Error('Reply skill was not found');
    library.items = library.items.filter((item) => item.id !== id);
    if (library.activeSkillId === id) library.activeSkillId = GENERATED_REPLY_SKILL_ID;
    this._saveReplySkillLibrary(library);
    fs.rmSync(this._replySkillFilePath(id), { force: true });
    this._applyActiveReplySkill();
    this._addLog('info', `Live reply skill deleted: ${id}`);
    this._broadcast({ type: 'REPLY_SKILLS_UPDATED', replySkills: this._replySkillLibraryResponse() });
  }

  private _voiceProfiles(): Array<Record<string, unknown>> {
    const profiles = this._db.getSetting<unknown[]>('voiceProfiles');
    return Array.isArray(profiles)
      ? profiles.filter((profile): profile is Record<string, unknown> => Boolean(profile && typeof profile === 'object'))
      : [];
  }

  private _saveVoiceProfile(profile: Record<string, unknown>): Record<string, unknown> {
    const profiles = this._voiceProfiles().filter((item) => item['id'] !== profile['id']);
    profiles.unshift(profile);
    this._db.setSetting('voiceProfiles', profiles.slice(0, 50));
    return profile;
  }

  private _omniSpeakEndpoint(): string {
    return (process.env['OMNIVOICE_DESKTOP_ENDPOINT'] || 'http://127.0.0.1:8003').replace(/\/$/, '');
  }

  private _qwenTtsEndpoint(): string {
    return (process.env['QWEN_TTS_ENDPOINT'] || 'http://127.0.0.1:3333').replace(/\/$/, '');
  }

  private async _qwenTtsHealth(timeoutMs = 2_000): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this._qwenTtsEndpoint()}/api/health`, { signal: controller.signal });
      if (!response.ok) return false;
      const payload = await response.json().catch(() => ({})) as any;
      return payload.ready === true && payload.provider === 'qwentts';
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async _commandVersion(command: string, args: string[]): Promise<string> {
    const configuredPath = process.env[`${command.toUpperCase()}_PATH`];
    const candidates = [
      configuredPath,
      command,
      ...(process.platform === 'darwin'
        ? [`/opt/homebrew/bin/${command}`, `/usr/local/bin/${command}`]
        : process.platform === 'win32'
          ? [path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'ffmpeg', 'bin', `${command}.exe`)]
          : [`/usr/bin/${command}`, `/usr/local/bin/${command}`]),
    ].filter((candidate, index, values): candidate is string => Boolean(candidate) && values.indexOf(candidate) === index);

    for (const candidate of candidates) {
      const version = await new Promise<string | null>((resolve) => {
        execFile(candidate, args, { timeout: 3_000 }, (error, stdout, stderr) => {
          if (error) return resolve(null);
          resolve(String(stdout || stderr || '').trim().split(/\r?\n/)[0] || 'Installed');
        });
      });
      if (version) return version;
    }
    return 'Not installed';
  }

  private async _engineStatus(): Promise<{ updatedAt: number; engines: Array<Record<string, unknown>> }> {
    const repositoryRoot = process.env['AI_IDOL_ENGINE_ROOT']
      ? path.resolve(process.env['AI_IDOL_ENGINE_ROOT'])
      : path.resolve(__dirname, '../../..');
    const ollamaEndpoint = (process.env['OLLAMA_ENDPOINT'] || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const ollamaController = new AbortController();
    const ollamaTimeout = setTimeout(() => ollamaController.abort(), 2_500);
    const ollama = await fetch(`${ollamaEndpoint}/api/tags`, { signal: ollamaController.signal })
      .then(async (response) => {
        const payload = response.ok ? await response.json() as any : { models: [] };
        const model = Array.isArray(payload.models)
          ? payload.models.find((item: any) => item.name === 'qwen3:8b' || item.model === 'qwen3:8b')
          : null;
        return { reachable: response.ok, installed: Boolean(model), size: Number(model?.size || 0) };
      })
      .catch(() => ({ reachable: false, installed: false, size: 0 }))
      .finally(() => clearTimeout(ollamaTimeout));
    const [qwenTtsReady, liveWorker, ffmpegVersion, ffprobeVersion] = await Promise.all([
      this._qwenTtsHealth(),
      this._liveTalkingWorkerStatus(),
      this._commandVersion('ffmpeg', ['-version']),
      this._commandVersion('ffprobe', ['-version']),
    ]);
    const obsRoute = this._activeObsOutputSessionId
      ? this._obsOutputRoutes.get(this._activeObsOutputSessionId)
      : null;
    const torchHome = process.env['TORCH_HOME'] || path.join(os.homedir(), '.cache', 'torch');
    const s3fdPath = process.env['S3FD_MODEL_PATH'] || path.join(torchHome, 'hub', 'checkpoints', 's3fd-619a316812.pth');
    const ffmpegReady = ffmpegVersion !== 'Not installed';
    const ffprobeReady = ffprobeVersion !== 'Not installed';
    const s3fdReady = fs.existsSync(s3fdPath);
    const missingMediaDependencies = [
      !ffmpegReady && 'FFmpeg',
      !ffprobeReady && 'FFprobe',
      !s3fdReady && 'S3FD',
    ].filter(Boolean);
    const runtimeMemoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const stateFromWorker = String(liveWorker['state'] || 'OFFLINE');
    return {
      updatedAt: Date.now(),
      engines: [
        {
          id: 'qwen-director', category: 'AI DIRECTOR', title: 'Qwen Director', model: 'qwen3:8b',
          state: ollama.reachable && ollama.installed ? 'READY' : (ollama.reachable ? 'SETUP' : 'OFFLINE'),
          detail: ollama.installed ? 'Primary reply engine · local Ollama' : 'Install qwen3:8b to enable local replies',
          metrics: [ollama.size ? `${(ollama.size / 1024 / 1024 / 1024).toFixed(1)} GB` : 'Local', 'Primary'],
          actions: ollama.reachable && ollama.installed ? ['stop'] : ['start'],
        },
        {
          id: 'chatgpt-fallback', category: 'AI DIRECTOR', title: 'ChatGPT Fallback', model: process.env['TTM_MODEL'] || 'chat-latest',
          state: this._settings.persona.llmApiKey ? 'CONFIGURED' : 'SETUP',
          detail: this._settings.persona.llmApiKey ? 'TTM API credential configured · used only if Qwen fails' : 'Add a TTM API key in AI Director settings',
          metrics: ['Cloud', 'Fallback'], actions: [],
        },
        {
          id: 'qwen-tts', category: 'VOICE', title: 'Qwen TTS Vietnamese', model: 'Qwen TTS 0.6B',
          state: qwenTtsReady ? 'READY' : this._qwenTtsState.state,
          detail: qwenTtsReady ? 'Vietnamese voice synthesis ready' : (this._qwenTtsState.error || 'Loaded on demand'),
          metrics: [this._qwenTtsState.owned ? `PID ${this._qwenTtsState.pid || '-'}` : 'On demand', '24 kHz'],
          actions: qwenTtsReady ? ['stop'] : ['start'],
        },
        {
          id: 'live-avatar', category: 'LIPSYNC', title: 'Lipsync Engine', model: 'MuseTalk',
          state: stateFromWorker,
          detail: liveWorker['ready'] ? 'Lipsync ready' : (liveWorker['error'] || 'Lipsync inactive'),
          metrics: ['15 model FPS', '30 output FPS', 'HD 720p', `${runtimeMemoryMb} MB runtime`],
          actions: liveWorker['ready'] ? ['restart', 'stop'] : ['start'],
        },
        {
          id: 'obs-bridge', category: 'STREAM OUTPUT', title: 'OBS Bridge', model: 'WebRTC Browser Source',
          state: obsRoute?.receiver && obsRoute?.publisher ? 'READY' : (this._obsController.isConnected ? 'STARTING' : 'OFFLINE'),
          detail: obsRoute?.receiver && obsRoute?.publisher ? 'Video and voice route established' : 'Magic Connect prepares the OBS browser source',
          metrics: ['1280 × 720', '30 FPS', 'Video + audio'], actions: obsRoute?.receiver && obsRoute?.publisher ? ['stop'] : ['start'],
        },
        {
          id: 'media-tools', category: 'MEDIA FOUNDATION', title: 'FFmpeg & Face Detector', model: 'FFmpeg · FFprobe · S3FD',
          state: missingMediaDependencies.length === 0 ? 'READY' : 'SETUP',
          detail: missingMediaDependencies.length === 0
            ? 'Media tools and S3FD face detector ready'
            : `Missing ${missingMediaDependencies.join(', ')}`,
          metrics: [
            ffmpegReady ? ffmpegVersion.replace(/^ffmpeg version\s*/i, 'FFmpeg ') : 'FFmpeg missing',
            ffprobeReady ? 'FFprobe ready' : 'FFprobe missing',
            s3fdReady ? 'S3FD ready' : 'S3FD missing',
          ], actions: missingMediaDependencies.length === 0 ? [] : ['start'],
        },
      ],
    };
  }

  private async _runEngineAction(engineId: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
    if (engineId === 'media-tools') {
      if (action !== 'start') return;
      const [ffmpeg, ffprobe] = await Promise.all([
        this._commandVersion('ffmpeg', ['-version']),
        this._commandVersion('ffprobe', ['-version']),
      ]);
      if (ffmpeg === 'Not installed' || ffprobe === 'Not installed') {
        throw new Error('Bundled FFmpeg tools are missing. Reinstall the Native App package.');
      }
      const torchHome = process.env['TORCH_HOME'] || path.join(os.homedir(), '.cache', 'torch');
      const s3fdPath = process.env['S3FD_MODEL_PATH'] || path.join(torchHome, 'hub', 'checkpoints', 's3fd-619a316812.pth');
      if (!fs.existsSync(s3fdPath)) throw new Error('S3FD is missing. Run Magic Setup again to download the face detector.');
      return;
    }
    if (engineId === 'qwen-director') {
      const endpoint = (process.env['OLLAMA_ENDPOINT'] || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const response = await fetch(`${endpoint}/${action === 'stop' ? 'api/generate' : 'api/chat'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'stop'
          ? { model: 'qwen3:8b', keep_alive: 0 }
          : { model: 'qwen3:8b', messages: [{ role: 'user', content: 'Trả lời một từ: sẵn sàng' }], stream: false, think: false, keep_alive: '10m' }),
      });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      return;
    }
    if (engineId === 'qwen-tts') {
      if (action === 'stop') {
        if (!this._qwenTtsProcess) throw new Error('Qwen TTS is external or already stopped');
        this._qwenTtsProcess.kill('SIGTERM');
        return;
      }
      await this._ensureQwenTtsReady();
      return;
    }
    if (engineId === 'live-avatar') {
      if (action === 'stop') await this._stopLiveTalkingWorker(true);
      else if (action === 'restart') {
        if (this._liveTalkingWorkerProcess) await this._stopLiveTalkingWorker(false);
        await new Promise<void>((resolve) => {
          if (process.platform === 'win32') return resolve();
          execFile('/usr/bin/pkill', ['-KILL', '-f', 'app.py --transport webrtc'], () => resolve());
        });
        for (let attempt = 0; attempt < 30 && this._liveTalkingWorkerProcess; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await this._startLiveTalkingWorker();
      } else await this._startLiveTalkingWorker();
      return;
    }
    if (engineId === 'obs-bridge') {
      if (action === 'stop') {
        await this._obsController.shutdown();
        this._activeObsOutputSessionId = null;
      } else {
        await this._waitForReadyLiveTalkingMedia();
        await this._magicConnectObs();
      }
      return;
    }
    throw new Error('This engine has no runtime action');
  }

  private _appendQwenTtsOutput(chunk: Buffer | string): void {
    const lines = String(chunk).split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
    this._qwenTtsState.output.push(...lines);
    if (this._qwenTtsState.output.length > 40) this._qwenTtsState.output.splice(0, this._qwenTtsState.output.length - 40);
    this._qwenTtsState.updatedAt = Date.now();
  }

  private async _startQwenTtsOnce(): Promise<void> {
    if (await this._qwenTtsHealth()) {
      this._qwenTtsState.state = 'READY';
      this._qwenTtsState.error = '';
      this._qwenTtsState.updatedAt = Date.now();
      return;
    }
    const endpoint = new URL(this._qwenTtsEndpoint());
    if (!isLoopbackHost(endpoint.hostname)) {
      throw new Error('Remote Qwen TTS endpoint is unavailable and cannot be started locally');
    }
    if (process.env['QWEN_TTS_AUTOSTART'] === 'false') {
      throw new Error('Qwen TTS is offline and automatic startup is disabled');
    }

    const repositoryRoot = process.env['AI_IDOL_ENGINE_ROOT']
      ? path.resolve(process.env['AI_IDOL_ENGINE_ROOT'])
      : path.resolve(__dirname, '../../..');
    const launcherName = process.platform === 'win32' ? 'run_worker.bat' : 'run_worker.sh';
    const scriptPath = path.join(repositoryRoot, 'services', 'qwen-tts', launcherName);
    if (!fs.existsSync(scriptPath)) throw new Error('Qwen TTS launcher is missing');

    this._qwenTtsState = {
      state: 'STARTING',
      owned: true,
      pid: null,
      error: '',
      output: [],
      updatedAt: Date.now(),
    };
    const command = process.platform === 'win32' ? (process.env['COMSPEC'] || 'cmd.exe') : 'bash';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', scriptPath] : [scriptPath];
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        QWEN_TTS_HOST: endpoint.hostname === 'localhost' ? '127.0.0.1' : endpoint.hostname,
        QWEN_TTS_PORT: endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._qwenTtsProcess = child;
    this._qwenTtsState.pid = child.pid || null;
    child.stdout?.on('data', (chunk) => this._appendQwenTtsOutput(chunk));
    child.stderr?.on('data', (chunk) => this._appendQwenTtsOutput(chunk));
    child.once('error', (error) => {
      if (this._qwenTtsProcess !== child) return;
      this._qwenTtsState.state = 'ERROR';
      this._qwenTtsState.error = error.message;
      this._qwenTtsState.updatedAt = Date.now();
    });
    child.once('exit', (code, signal) => {
      if (this._qwenTtsProcess !== child) return;
      this._qwenTtsProcess = null;
      this._qwenTtsState.pid = null;
      this._qwenTtsState.owned = false;
      if (this._qwenTtsState.state !== 'READY') {
        this._qwenTtsState.state = 'ERROR';
        this._qwenTtsState.error = this._qwenTtsState.error
          || `Qwen TTS exited (${signal || `code ${code ?? 'unknown'}`})`;
      } else {
        this._qwenTtsState.state = 'OFFLINE';
        this._qwenTtsState.error = '';
      }
      this._qwenTtsState.updatedAt = Date.now();
    });

    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await this._qwenTtsHealth(1_000)) {
        this._qwenTtsState.state = 'READY';
        this._qwenTtsState.error = '';
        this._qwenTtsState.updatedAt = Date.now();
        this._addLog('info', `Qwen TTS ready at ${this._qwenTtsEndpoint()}`);
        return;
      }
      if (child.exitCode !== null || this._qwenTtsState.state === 'ERROR') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const recentOutput = this._qwenTtsState.output.slice(-3).join(' | ');
    throw new Error(this._qwenTtsState.error || recentOutput || 'Qwen TTS did not become ready');
  }

  private async _ensureQwenTtsReady(): Promise<void> {
    if (await this._qwenTtsHealth()) {
      this._qwenTtsState.state = 'READY';
      this._qwenTtsState.error = '';
      this._qwenTtsState.updatedAt = Date.now();
      return;
    }
    if (this._qwenTtsStartPromise) return this._qwenTtsStartPromise;
    const operation = this._startQwenTtsOnce();
    this._qwenTtsStartPromise = operation;
    try {
      await operation;
    } finally {
      if (this._qwenTtsStartPromise === operation) this._qwenTtsStartPromise = null;
    }
  }

  private async _qwenTtsJson(pathname: string, init: RequestInit = {}): Promise<any> {
    await this._ensureQwenTtsReady();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this._qwenTtsEndpoint()}${pathname}`, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Qwen TTS HTTP ${response.status}${payload.detail ? `: ${payload.detail}` : ''}`);
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async _omniSpeakJson(pathname: string, init: RequestInit = {}): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(`${this._omniSpeakEndpoint()}${pathname}`, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`OmniVoice desktop API HTTP ${response.status}${payload.detail ? `: ${payload.detail}` : ''}`);
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  private _parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown, res: http.ServerResponse): z.output<TSchema> | null {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Invalid request payload',
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    }));
    return null;
  }

  private _withoutUndefined<T extends Record<string, unknown>>(value: T): DefinedPartial<T> {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as DefinedPartial<T>;
  }

  private _resolveProjectPath(value: unknown): string {
    const requested = String(value || '').trim();
    if (!requested || requested.includes('\0')) throw new Error('A valid project file path is required');
    const projectRoot = path.resolve(this._projectDir());
    const resolved = path.resolve(path.isAbsolute(requested) ? requested : path.join(projectRoot, requested));
    if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) {
      throw new Error('File path must be inside the active project folder');
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error('Project file does not exist');
    }
    return resolved;
  }

  private _validateWorkerEndpoint(value: string): string {
    const endpoint = new URL(value);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('LiveTalking endpoint must use HTTP or HTTPS');
    const allowedHosts = (process.env['LIVETALKING_ALLOWED_HOSTS'] || '127.0.0.1,localhost,::1')
      .split(',').map((host) => host.trim()).filter(Boolean);
    if (!allowedHosts.includes(endpoint.hostname)) throw new Error('LiveTalking endpoint host is not allowlisted');
    return endpoint.toString().replace(/\/$/, '');
  }

  private _appendLiveTalkingWorkerOutput(chunk: unknown): void {
    const lines = String(chunk || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) this._liveTalkingWorker.output.push(line.slice(0, 500));
    if (this._liveTalkingWorker.output.length > 40) {
      this._liveTalkingWorker.output.splice(0, this._liveTalkingWorker.output.length - 40);
    }
    this._liveTalkingWorker.updatedAt = Date.now();
  }

  private async _liveTalkingWorkerStatus(): Promise<Record<string, unknown>> {
    const health = await this._liveTalkingProvider.health();
    if (health.healthy && this._liveTalkingWorker.state !== 'STOPPING') {
      this._liveTalkingWorker.state = 'READY';
      this._liveTalkingWorker.error = '';
    } else if (this._liveTalkingWorkerProcess) {
      if (this._liveTalkingWorker.state !== 'ERROR' && this._liveTalkingWorker.state !== 'STOPPING') {
        this._liveTalkingWorker.state = 'STARTING';
      }
    } else if (this._liveTalkingWorker.state !== 'ERROR') {
      this._liveTalkingWorker.state = 'OFFLINE';
      this._liveTalkingWorker.pid = null;
      this._liveTalkingWorker.owned = false;
    }
    this._liveTalkingWorker.updatedAt = Date.now();
    return {
      state: this._liveTalkingWorker.state,
      ready: health.healthy,
      pid: this._liveTalkingWorker.pid,
      owned: this._liveTalkingWorker.owned,
      startedAt: this._liveTalkingWorker.startedAt,
      updatedAt: this._liveTalkingWorker.updatedAt,
      error: this._liveTalkingWorker.error || null,
      endpoint: this._settings.talkingEngine.endpoint,
      model: this._settings.talkingEngine.model,
      videoQuality: this._settings.talkingEngine.videoQuality,
      alwaysOn: this._settings.talkingEngine.alwaysOn,
      trainingWorkers: Math.max(1, Math.min(4, parseInt(process.env['LIVETALKING_TRAIN_WORKERS'] || '1', 10) || 1)),
      recentOutput: this._liveTalkingWorker.output.slice(-12),
      health,
    };
  }

  private async _monitorLiveTalkingWorker(processRef: ReturnType<typeof spawn>): Promise<void> {
    for (let attempt = 0; attempt < 360 && this._liveTalkingWorkerProcess === processRef; attempt += 1) {
      const health = await this._liveTalkingProvider.health();
      if (health.healthy) {
        if (this._liveTalkingWorker.state === 'STOPPING') return;
        this._liveTalkingWorker.state = 'READY';
        this._liveTalkingWorker.error = '';
        this._liveTalkingWorker.updatedAt = Date.now();
        this._addLog('info', `LiveTalking worker ready at ${this._settings.talkingEngine.endpoint}`);
        this._broadcast({ type: 'LIVETALKING_WORKER_STATE', worker: await this._liveTalkingWorkerStatus() });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private async _startLiveTalkingWorkerOnce(): Promise<Record<string, unknown>> {
    const current = await this._liveTalkingWorkerStatus();
    if (current['ready'] || this._liveTalkingWorkerProcess) return current;

    const endpointUrl = new URL(this._validateWorkerEndpoint(this._settings.talkingEngine.endpoint));
    if (!isLoopbackHost(endpointUrl.hostname)) {
      throw new Error('The dashboard can only start a LiveTalking worker on this machine');
    }
    const repositoryRoot = process.env['AI_IDOL_ENGINE_ROOT']
      ? path.resolve(process.env['AI_IDOL_ENGINE_ROOT'])
      : path.resolve(__dirname, '../../..');
    const launcherName = process.platform === 'win32' ? 'run_worker.bat' : 'run_worker.sh';
    const scriptPath = path.join(repositoryRoot, 'services', 'talking-head', 'livetalking', launcherName);
    if (!fs.existsSync(scriptPath)) throw new Error('Live avatar worker launcher is missing');

    this._invalidateLiveTalkingMediaSession('WORKER_STARTING');
    this._liveTalkingWorker = {
      state: 'STARTING',
      pid: null,
      owned: true,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      error: '',
      output: [],
    };
    const workerCommand = process.platform === 'win32' ? (process.env['COMSPEC'] || 'cmd.exe') : 'bash';
    const workerArgs = process.platform === 'win32' ? ['/d', '/s', '/c', scriptPath] : [scriptPath];
    const workerRoot = path.join(repositoryRoot, 'services', 'talking-head', 'livetalking');
    const projectStorageRoot = path.resolve(this._projectStorageRoot);
    const workerModel = this._settings.talkingEngine.model === 'musetalk' ? 'musetalk' : 'wav2lip';
    const avatarAssetName = workerModel === 'musetalk' ? 'latents.pt' : 'coords.pkl';
    const selectedAvatarId = this._db.getAvatarSession()?.activeAvatarId;
    const projectModelsRoot = path.join(this._projectDir(), 'models');
    const projectArtifactIds = fs.existsSync(projectModelsRoot)
      ? fs.readdirSync(projectModelsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,80}$/.test(entry.name))
        .filter((entry) => fs.existsSync(path.join(projectModelsRoot, entry.name, avatarAssetName)))
        .map((entry) => entry.name)
      : [];
    const projectAvatarIds = this._readProjectAvatarArtifacts()
      .filter((avatar) => avatar.modelType === workerModel)
      .map((avatar) => String(avatar.id || avatar.avatarId || ''))
      .concat(projectArtifactIds);
    const workerAvatarsRoot = path.join(workerRoot, 'data', 'avatars');
    const workerAvatarIds = fs.existsSync(workerAvatarsRoot)
      ? fs.readdirSync(workerAvatarsRoot)
        .filter((avatarId) => /^[a-zA-Z0-9_-]{1,80}$/.test(avatarId))
        .filter((avatarId) => fs.existsSync(path.join(workerAvatarsRoot, avatarId, avatarAssetName)))
      : [];
    const availableAvatarIds = [...new Set([...projectAvatarIds, ...workerAvatarIds])];
    const workerAvatarId = selectedAvatarId && availableAvatarIds.includes(selectedAvatarId)
      ? selectedAvatarId
      : availableAvatarIds[0];
    if (workerAvatarId && workerAvatarId !== selectedAvatarId) {
      this._db.setAvatarSession(workerAvatarId, [workerAvatarId]);
    }
    if (workerAvatarId && !fs.existsSync(path.join(workerAvatarsRoot, workerAvatarId, avatarAssetName))) {
      const projectAvatarDir = path.join(this._projectDir(), 'models', workerAvatarId);
      const workerAvatarDir = path.join(workerAvatarsRoot, workerAvatarId);
      if (fs.existsSync(projectAvatarDir)) {
        fs.mkdirSync(workerAvatarsRoot, { recursive: true });
        try {
          fs.rmSync(workerAvatarDir, { recursive: true, force: true });
          fs.symlinkSync(projectAvatarDir, workerAvatarDir, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
          fs.cpSync(projectAvatarDir, workerAvatarDir, { recursive: true, force: true });
        }
      }
    }
    const allowedRoots = (configured: string | undefined, defaults: string[]) => [...new Set([
      ...String(configured || '').split(',').map((entry) => entry.trim()).filter(Boolean),
      ...defaults,
      projectStorageRoot,
    ].map((entry) => path.resolve(entry)))].join(',');
    const workerProcess = spawn(workerCommand, workerArgs, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        LIVETALKING_HOST: endpointUrl.hostname === 'localhost' ? '127.0.0.1' : endpointUrl.hostname,
        LIVETALKING_PORT: endpointUrl.port || (endpointUrl.protocol === 'https:' ? '443' : '80'),
        LIVETALKING_MODEL: workerModel,
        LIVETALKING_FPS: '15',
        LIVETALKING_OUTPUT_FPS: '30',
        LIVETALKING_VIDEO_QUALITY: this._settings.talkingEngine.videoQuality,
        LIVETALKING_PREPROCESS_QUALITY: 'hd',
        LIVETALKING_MAX_WIDTH: String(LIVE_VIDEO_PRESETS[this._settings.talkingEngine.videoQuality].width),
        LIVETALKING_MAX_HEIGHT: String(LIVE_VIDEO_PRESETS[this._settings.talkingEngine.videoQuality].height),
        LIVETALKING_TRAIN_WORKERS: process.env['LIVETALKING_TRAIN_WORKERS'] || '1',
        AVATAR_TRAIN_RESOURCE_FRACTION: process.env['AVATAR_TRAIN_RESOURCE_FRACTION'] || '0.20',
        ...(workerAvatarId ? { LIVETALKING_AVATAR_ID: workerAvatarId } : {}),
        LIVETALKING_ALLOWED_MEDIA_ROOTS: allowedRoots(process.env['LIVETALKING_ALLOWED_MEDIA_ROOTS'], [
          path.join(workerRoot, 'data', 'tmp'),
          path.join(workerRoot, 'data', 'avatars'),
          path.join(repositoryRoot, 'local-projects'),
        ]),
        LIVETALKING_ALLOWED_AVATAR_ROOTS: allowedRoots(process.env['LIVETALKING_ALLOWED_AVATAR_ROOTS'], [
          path.join(workerRoot, 'data', 'avatars'),
          path.join(repositoryRoot, 'local-projects'),
        ]),
      },
    });
    this._liveTalkingWorkerProcess = workerProcess;
    this._liveTalkingWorker.pid = workerProcess.pid || null;
    workerProcess.stdout?.on('data', (chunk) => this._appendLiveTalkingWorkerOutput(chunk));
    workerProcess.stderr?.on('data', (chunk) => this._appendLiveTalkingWorkerOutput(chunk));
    workerProcess.once('error', (error) => {
      if (this._liveTalkingWorkerProcess !== workerProcess) return;
      this._liveTalkingWorker.state = 'ERROR';
      this._liveTalkingWorker.error = error.message;
      this._liveTalkingWorker.updatedAt = Date.now();
      this._addLog('error', `LiveTalking worker could not start: ${error.message}`);
    });
    workerProcess.once('exit', (code, signal) => {
      if (this._liveTalkingWorkerProcess !== workerProcess) return;
      this._invalidateLiveTalkingMediaSession('WORKER_EXITED');
      const stoppedByRuntime = this._liveTalkingWorker.state === 'STOPPING';
      this._liveTalkingWorkerProcess = null;
      this._liveTalkingWorker.pid = null;
      this._liveTalkingWorker.owned = false;
      this._liveTalkingWorker.state = stoppedByRuntime ? 'OFFLINE' : 'ERROR';
      this._liveTalkingWorker.error = stoppedByRuntime
        ? ''
        : `Worker exited (${signal || `code ${code ?? 'unknown'}`})`;
      this._liveTalkingWorker.updatedAt = Date.now();
      if (!stoppedByRuntime) this._addLog('error', `LiveTalking ${this._liveTalkingWorker.error}`);
      if (!stoppedByRuntime && this._isRunning && this._settings.talkingEngine.alwaysOn) {
        this._scheduleLiveTalkingWorkerRestart();
      }
      void this._liveTalkingWorkerStatus().then((worker) => {
        this._broadcast({ type: 'LIVETALKING_WORKER_STATE', worker, timestamp: Date.now() });
      });
    });
    this._addLog('info', `Starting LiveTalking worker (PID ${this._liveTalkingWorker.pid || 'pending'})`);
    void this._monitorLiveTalkingWorker(workerProcess);
    return this._liveTalkingWorkerStatus();
  }

  private async _startLiveTalkingWorker(): Promise<Record<string, unknown>> {
    if (this._liveTalkingWorkerStartPromise) return this._liveTalkingWorkerStartPromise;
    const operation = this._startLiveTalkingWorkerOnce();
    this._liveTalkingWorkerStartPromise = operation;
    try {
      return await operation;
    } finally {
      if (this._liveTalkingWorkerStartPromise === operation) {
        this._liveTalkingWorkerStartPromise = null;
      }
    }
  }

  private _cancelLiveTalkingAutomation(): void {
    if (this._liveTalkingWorkerRestartTimer) clearTimeout(this._liveTalkingWorkerRestartTimer);
    this._liveTalkingWorkerRestartTimer = null;
    if (this._liveTalkingMaintenanceTimer) clearTimeout(this._liveTalkingMaintenanceTimer);
    this._liveTalkingMaintenanceTimer = null;
    this._liveTalkingMaintenancePending = false;
    this._liveTalkingMaintenanceBlocker = 'NONE';
  }

  private _scheduleLiveTalkingWorkerRestart(): void {
    if (!this._isRunning
      || !this._settings.talkingEngine.alwaysOn
      || this._settings.talkingEngine.provider !== 'livetalking'
      || this._liveTalkingWorkerProcess
      || this._liveTalkingWorkerRestartTimer) return;
    this._liveTalkingWorkerRestartTimer = setTimeout(() => {
      this._liveTalkingWorkerRestartTimer = null;
      if (!this._isRunning || !this._settings.talkingEngine.alwaysOn || this._liveTalkingWorkerProcess) return;
      void this._startLiveTalkingWorker().catch((error) => {
        this._addLog('error', `LiveTalking worker restart failed: ${error instanceof Error ? error.message : String(error)}`);
        this._scheduleLiveTalkingWorkerRestart();
      });
    }, 1000);
  }

  private _autoStartLiveTalkingWorker(): void {
    if (!this._settings.talkingEngine.alwaysOn
      || process.env['NODE_ENV'] === 'test'
      || process.env['LIVETALKING_AUTOSTART'] === 'false') return;
    try {
      const endpoint = new URL(this._settings.talkingEngine.endpoint);
      if (!isLoopbackHost(endpoint.hostname)) return;
    } catch {
      return;
    }
    void this._startLiveTalkingWorker().catch((error) => {
      this._addLog('error', `LiveTalking autostart failed: ${error instanceof Error ? error.message : String(error)}`);
      this._scheduleLiveTalkingWorkerRestart();
    });
  }

  private _scheduleLiveTalkingMaintenance(): void {
    if (this._liveTalkingMaintenanceTimer) clearTimeout(this._liveTalkingMaintenanceTimer);
    this._liveTalkingMaintenanceTimer = null;
    if (!this._isRunning
      || !this._settings.talkingEngine.alwaysOn
      || this._settings.talkingEngine.provider !== 'livetalking') return;
    this._liveTalkingMaintenanceTimer = setTimeout(() => {
      this._liveTalkingMaintenanceTimer = null;
      this._liveTalkingMaintenancePending = true;
      this._liveTalkingMaintenanceBlocker = 'NONE';
      this._broadcast({ type: 'LIVETALKING_MAINTENANCE_STATE', maintenance: this._publicSettings().liveAvatarMaintenance, timestamp: Date.now() });
      void this._tryRunLiveTalkingMaintenance();
    }, this._settings.talkingEngine.restartIntervalMinutes * 60_000);
  }

  private async _activeLiveTalkingTrainingTasks(): Promise<any[]> {
    const tasks = await this._liveTalkingProvider.listAvatarTasks();
    return tasks.filter((task) => task?.status === 'pending' || task?.status === 'running');
  }

  private async _tryRunLiveTalkingMaintenance(): Promise<void> {
    if (!this._liveTalkingMaintenancePending || this._liveTalkingMaintenanceRunning) return;
    if (!this._settings.talkingEngine.alwaysOn) {
      this._liveTalkingMaintenancePending = false;
      this._liveTalkingMaintenanceBlocker = 'NONE';
      return;
    }
    if (this._speechRuntime.state !== 'IDLE' || this._directorSpeechDrainRunning || this._director.state.isSpeaking) {
      this._liveTalkingMaintenanceBlocker = 'SPEECH';
      setTimeout(() => void this._tryRunLiveTalkingMaintenance(), 1_000);
      return;
    }
    if (this._liveTalkingMediaOwner?.sessionId && this._liveTalkingMediaOwner.ws.readyState === WebSocket.OPEN) {
      // Never tear down a healthy viewer-facing WebRTC session for routine cache
      // maintenance. Recycling is deferred until the Live Monitor owner leaves.
      this._liveTalkingMaintenanceBlocker = 'MEDIA_SESSION';
      setTimeout(() => void this._tryRunLiveTalkingMaintenance(), 5_000);
      return;
    }
    try {
      const activeTasks = await this._activeLiveTalkingTrainingTasks();
      if (activeTasks.length > 0) {
        this._liveTalkingMaintenanceBlocker = 'TRAINING';
        setTimeout(() => void this._tryRunLiveTalkingMaintenance(), 1_000);
        return;
      }
    } catch {
      // Keep the worker alive when its task state cannot be verified.
      this._liveTalkingMaintenanceBlocker = 'WORKER_STATUS';
      setTimeout(() => void this._tryRunLiveTalkingMaintenance(), 2_000);
      return;
    }
    this._liveTalkingMaintenanceBlocker = 'NONE';
    const workerProcess = this._liveTalkingWorkerProcess;
    if (!workerProcess) {
      this._liveTalkingMaintenancePending = false;
      this._scheduleLiveTalkingMaintenance();
      return;
    }
    this._liveTalkingMaintenancePending = false;
    this._liveTalkingMaintenanceRunning = true;
    this._liveTalkingWorker.state = 'STOPPING';
    this._invalidateLiveTalkingMediaSession('WORKER_MAINTENANCE');
    this._broadcast({ type: 'LIVETALKING_MAINTENANCE_STATE', maintenance: this._publicSettings().liveAvatarMaintenance, timestamp: Date.now() });
    try {
      await this._liveTalkingProvider.closeSession().catch(() => {});
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        workerProcess.once('exit', () => { clearTimeout(timer); resolve(); });
        workerProcess.kill('SIGTERM');
      });
      await this._startLiveTalkingWorker();
      this._liveTalkingLastRecycleAt = Date.now();
    } catch (error) {
      this._addLog('error', `Scheduled Live Avatar restart failed: ${error instanceof Error ? error.message : String(error)}`);
      this._scheduleLiveTalkingWorkerRestart();
    } finally {
      this._liveTalkingMaintenanceRunning = false;
      this._liveTalkingMaintenanceBlocker = 'NONE';
      this._scheduleLiveTalkingMaintenance();
      this._broadcast({ type: 'LIVETALKING_MAINTENANCE_STATE', maintenance: this._publicSettings().liveAvatarMaintenance, timestamp: Date.now() });
    }
  }

  private _liveVideoPreset() {
    return LIVE_VIDEO_PRESETS[this._settings.talkingEngine.videoQuality];
  }

  private _obsOutputPreset(): { width: number; height: number; fps: number } | null {
    const { outputResolution } = this._settings.obs;
    // The Monitor pipeline is a native landscape 16:9 stream. Keep OBS on
    // the same contract so it never crops or letterboxes into a portrait
    // canvas before the Browser Source receives the video.
    if (outputResolution === 'auto') return null;
    const height = outputResolution === '1080' ? 1080 : 720;
    const width = Math.round(height * 16 / 9);
    return { width, height, fps: this._liveVideoPreset().fps };
  }

  private async _restartOwnedLiveTalkingWorkerForQuality(): Promise<boolean> {
    const workerProcess = this._liveTalkingWorkerProcess;
    if (!workerProcess) return false;
    if (this._liveTalkingWorker.state !== 'READY') {
      throw new Error('Wait for the Live Avatar worker to finish starting before changing video quality');
    }
    if (this._speechRuntime.state !== 'IDLE' || this._directorSpeechDrainRunning) {
      throw new Error('Wait for the current reply to finish before changing video quality');
    }
    const activeTasks = await this._activeLiveTalkingTrainingTasks();
    if (activeTasks.length > 0) {
      throw new Error('Video quality cannot change while avatar training is active');
    }

    this._liveTalkingWorker.state = 'STOPPING';
    this._liveTalkingWorker.updatedAt = Date.now();
    this._invalidateLiveTalkingMediaSession('VIDEO_QUALITY_CHANGED');
    await this._liveTalkingProvider.closeSession().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        workerProcess.off('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => finish();
      const timer = setTimeout(() => finish(new Error('Live Avatar worker did not stop for the quality change')), 15_000);
      workerProcess.once('exit', onExit);
      if (!workerProcess.kill('SIGTERM')) finish(new Error('Live Avatar worker could not be stopped'));
    });

    await this._startLiveTalkingWorker();
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const status = await this._liveTalkingWorkerStatus();
      if (status['ready']) {
        this._broadcast({ type: 'LIVETALKING_WORKER_STATE', worker: status, timestamp: Date.now() });
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Live Avatar worker did not become ready after changing video quality');
  }

  private async _setLiveVideoQuality(quality: LiveVideoQuality) {
    const previousQuality = this._settings.talkingEngine.videoQuality;
    const preset = LIVE_VIDEO_PRESETS[quality];
    const currentWorker = await this._liveTalkingWorkerStatus();
    const ownedWorkerReady = Boolean(currentWorker['ready'] && this._liveTalkingWorkerProcess);
    if (quality !== previousQuality && currentWorker['ready'] && !this._liveTalkingWorkerProcess) {
      throw new Error('Stop the externally started Live Avatar worker before changing video quality');
    }
    if (quality !== previousQuality && this._liveTalkingWorkerProcess) {
      if (this._speechRuntime.state !== 'IDLE' || this._directorSpeechDrainRunning) {
        throw new Error('Wait for the current reply to finish before changing video quality');
      }
      const activeTasks = await this._activeLiveTalkingTrainingTasks();
      if (activeTasks.length > 0) throw new Error('Video quality cannot change while avatar training is active');
    }

    this._settings.talkingEngine.videoQuality = quality;
    this._db.setSetting('talkingEngine', this._settings.talkingEngine);
    let workerRestarted = false;
    let workerRestartRequired = false;
    if (quality !== previousQuality && ownedWorkerReady) {
      workerRestarted = await this._restartOwnedLiveTalkingWorkerForQuality();
    } else if (quality !== previousQuality && currentWorker['ready']) {
      workerRestartRequired = true;
    }

    let obsOutput: OBSMagicConnectResult | null = null;
    if (this._activeObsOutputSessionId && this._obsController.isConnected) {
      obsOutput = await this._obsController.magicConnect({
        url: this._obsBrowserSourceUrl(this._activeObsOutputSessionId),
        sourceName: 'AI IDOL Streamer',
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
      });
      this._broadcast({ type: 'OBS_STATUS', obs: { ...obsOutput, autoConnect: true }, timestamp: Date.now() });
    }
    this._addLog('info', `Live video quality changed to ${quality.toUpperCase()} (${preset.width}x${preset.height} @ ${preset.fps} FPS)`);
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
    return { quality, preset, workerRestarted, workerRestartRequired, obsOutput };
  }

  private async _stopLiveTalkingWorker(disableAlwaysOn = false): Promise<Record<string, unknown>> {
    if (this._liveTalkingWorkerStartPromise && !this._liveTalkingWorkerProcess) {
      await this._liveTalkingWorkerStartPromise.catch(() => {});
    }
    const workerProcess = this._liveTalkingWorkerProcess;
    if (!workerProcess) {
      const status = await this._liveTalkingWorkerStatus();
      if (status['ready']) throw new Error('This LiveTalking worker was started outside the dashboard');
      if (disableAlwaysOn) {
        this._settings.talkingEngine.alwaysOn = false;
        this._db.setSetting('talkingEngine', this._settings.talkingEngine);
        this._cancelLiveTalkingAutomation();
        return this._liveTalkingWorkerStatus();
      }
      return status;
    }
    let activeTasks: any[];
    try {
      activeTasks = await this._activeLiveTalkingTrainingTasks();
    } catch {
      throw new Error('Cannot stop the Live Avatar worker while training state is unavailable');
    }
    if (activeTasks.length > 0) {
      throw new Error('Cannot stop the Live Avatar worker while avatar training is active');
    }
    if (disableAlwaysOn) {
      this._settings.talkingEngine.alwaysOn = false;
      this._db.setSetting('talkingEngine', this._settings.talkingEngine);
      this._cancelLiveTalkingAutomation();
    }
    this._liveTalkingWorker.state = 'STOPPING';
    this._liveTalkingWorker.updatedAt = Date.now();
    workerProcess.kill('SIGTERM');
    return this._liveTalkingWorkerStatus();
  }

  private _projectDir(): string {
    return path.join(this._projectStorageRoot, this._safeName(this._activeProject, 'ai-livestream'));
  }

  private _ensureProjectStorage(): void {
    const projectDir = this._projectDir();
    for (const dir of ['uploads', 'avatars/source', 'avatars/training', 'models', 'outputs', 'metadata', 'skills']) {
      fs.mkdirSync(path.join(projectDir, dir), { recursive: true });
    }
    const projectFile = path.join(projectDir, 'project.json');
    if (!fs.existsSync(projectFile)) {
      fs.writeFileSync(projectFile, JSON.stringify({ name: this._activeProject, createdAt: new Date().toISOString(), version: 1 }, null, 2));
    }
  }

  private _loadProjectStorageConfig(): void {
    try {
      const sandboxProjectsRoot = process.env['AI_IDOL_PROJECTS_ROOT'];
      const databaseProject = this._db.getActiveProject();
      if (databaseProject) {
        this._projectStorageRoot = path.resolve(sandboxProjectsRoot || databaseProject.rootPath);
        this._activeProject = this._safeName(databaseProject.projectName, 'ai-livestream');
        if (sandboxProjectsRoot) this._db.setActiveProject(this._activeProject, this._projectStorageRoot);
        return;
      }
      if (sandboxProjectsRoot) {
        this._projectStorageRoot = path.resolve(sandboxProjectsRoot);
        this._db.setActiveProject(this._activeProject, this._projectStorageRoot);
        return;
      }
      if (!fs.existsSync(this._storageConfigPath)) return;
      const saved = JSON.parse(fs.readFileSync(this._storageConfigPath, 'utf8'));
      if (saved.rootPath) this._projectStorageRoot = path.resolve(String(saved.rootPath));
      if (saved.projectName) this._activeProject = this._safeName(saved.projectName, 'ai-livestream');
      this._db.setActiveProject(this._activeProject, this._projectStorageRoot);
    } catch (err) {
      console.warn('[Storage] Could not load project storage config:', err);
    }
  }

  private _saveProjectStorageConfig(): void {
    this._db.setActiveProject(this._activeProject, this._projectStorageRoot);
  }

  private _loadRuntimeSettings(): void {
    const voice = this._db.getSetting<Record<string, unknown>>('voice');
    const avatar = this._db.getSetting<Record<string, unknown>>('avatar');
    const persona = this._db.getSetting<Record<string, unknown>>('persona');
    const talkingEngine = this._db.getSetting<Record<string, unknown>>('talkingEngine');
    const liveSession = this._db.getSetting<Record<string, unknown>>('liveSession');
    const obs = this._db.getSetting<Record<string, unknown>>('obs');
    const platformReply = this._db.getSetting<Record<string, unknown>>('platformReply');
    const showSchedule = this._db.getSetting<Record<string, unknown>>('showSchedule');
    if (voice) this._settings.voice = { ...this._settings.voice, ...voice, apiKey: this._settings.voice.apiKey } as typeof this._settings.voice;
    if (avatar) this._settings.avatar = { ...this._settings.avatar, ...avatar } as typeof this._settings.avatar;
    if (persona) this._settings.persona = { ...this._settings.persona, ...persona } as typeof this._settings.persona;
    if (this._settings.persona.name
      && !/^mimi$/i.test(this._settings.persona.name)
      && /\bMimi\b/i.test(this._settings.persona.systemPrompt)) {
      this._settings.persona.systemPrompt = this._settings.persona.systemPrompt
        .replace(/\bMimi\b/gi, this._settings.persona.name);
      const { llmApiKey: _secret, ...persistedPersona } = this._settings.persona;
      this._db.setSetting('persona', persistedPersona);
    }
    if (liveSession) this._settings.liveSession = { ...this._settings.liveSession, ...liveSession } as typeof this._settings.liveSession;
    if (talkingEngine) this._settings.talkingEngine = { ...this._settings.talkingEngine, ...talkingEngine } as typeof this._settings.talkingEngine;
    if (![5, 10, 15, 20].includes(this._settings.talkingEngine.restartIntervalMinutes)) {
      this._settings.talkingEngine.restartIntervalMinutes = 15;
    }
    if (typeof this._settings.talkingEngine.alwaysOn !== 'boolean') {
      this._settings.talkingEngine.alwaysOn = true;
    }
    this._settings.talkingEngine.videoQuality = 'hd';
    if (obs) this._settings.obs = { ...this._settings.obs, ...obs, password: this._settings.obs.password } as typeof this._settings.obs;
    if (platformReply) this._settings.platformReply = PlatformReplySettingsSchema.parse({ ...this._settings.platformReply, ...platformReply });
    if (showSchedule) this._settings.showSchedule = ShowScheduleSchema.parse(showSchedule);

    const directorDefaultsVersion = Number(this._db.getSetting<number>('directorDefaultsVersion') || 0);
    if (directorDefaultsVersion < 3) {
      this._settings.persona.llmProvider = 'ollama';
      this._settings.persona.llmModel = 'qwen3:8b';
      const { llmApiKey: _secret, ...persistedPersona } = this._settings.persona;
      this._db.setSetting('persona', persistedPersona);
      this._db.setSetting('directorDefaultsVersion', 3);
    }

    const voiceDefaultsVersion = Number(this._db.getSetting<number>('voiceDefaultsVersion') || 0);
    const supportedVoiceProvider = this._settings.voice.provider === 'qwentts'
      || this._settings.voice.provider === 'omnivoice';
    if (voiceDefaultsVersion < 4 || !supportedVoiceProvider) {
      this._settings.voice = {
        ...this._settings.voice,
        provider: 'qwentts',
        voiceId: 'qwen-default',
        languageCode: 'vi',
        customEndpoint: '',
      };
      const { apiKey: _secret, ...persistedVoice } = this._settings.voice;
      this._db.setSetting('voice', persistedVoice);
      this._db.setSetting('voiceDefaultsVersion', 4);
    }
  }

  private _avatarManifestPath(): string {
    return path.join(this._projectDir(), 'metadata', 'avatars.json');
  }

  private _readAvatarManifest(): any[] {
    const stored = this._db.listAvatars();
    if (stored.length) return this._normalizeAvatarRecords(stored, true);
    try {
      const file = this._avatarManifestPath();
      const legacy = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      if (Array.isArray(legacy)) this._writeAvatarManifest(legacy);
      return Array.isArray(legacy) ? legacy : [];
    } catch { return []; }
  }

  private _writeAvatarManifest(avatars: any[]): void {
    for (const avatar of avatars) {
      const id = String(avatar?.id || avatar?.avatarId || '');
      if (id) this._db.upsertAvatar(id, { ...avatar, id, avatarId: id });
    }
  }

  private _normalizeAvatarRecords(records: any[], persist = false): any[] {
    const states = ['normal', 'happy', 'laughing', 'grateful', 'surprised', 'excited', 'sad', 'angry', 'playful', 'focused'];
    const idOf = (avatar: any) => String(avatar?.id || avatar?.avatarId || '');
    const batchParts = (id: string) => {
      const match = id.match(/^(.*)_([0-9]{2})$/);
      return match ? { base: match[1]!, position: Number(match[2]) } : null;
    };
    const groups = new Map<string, any[]>();
    for (const avatar of records) {
      const parts = batchParts(idOf(avatar));
      if (!parts) continue;
      groups.set(parts.base, [...(groups.get(parts.base) || []), avatar]);
    }
    return records.map((avatar) => {
      const id = idOf(avatar);
      if (!id) return avatar;
      const parts = batchParts(id);
      const siblings = parts ? (groups.get(parts.base) || []) : [];
      const profileId = String(avatar.profileId || (parts && siblings.length > 1 ? parts.base : id));
      const requestedState = String(avatar.avatarState || '').toLowerCase();
      const avatarState = AvatarStateSchema.safeParse(requestedState).success
        ? requestedState
        : (parts && siblings.length > 1 ? states[Math.max(0, parts.position - 1)] || 'normal' : 'normal');
      const normalized = { ...avatar, id, avatarId: id, profileId, avatarState };
      if (persist && (avatar.profileId !== profileId || avatar.avatarState !== avatarState)) this._db.upsertAvatar(id, normalized);
      return normalized;
    });
  }

  get talkingPipeline(): TalkingVideoPipeline {
    return this._talkingPipeline;
  }

  get museTalkBatchPipeline(): MuseTalkBatchPipeline {
    return this._museTalkBatchPipeline;
  }

  get gameAdapter(): GameAdapter {
    return this._gameAdapter;
  }

  get chatManager(): ChatManager {
    return this._chatManager;
  }

  get director(): DirectorAgent {
    return this._director;
  }

  get voiceService(): VoiceService {
    return this._voiceService;
  }

  get obsController(): OBSController {
    return this._obsController;
  }

  get goalEngine(): GoalEngine {
    return this._goalEngine;
  }

  get assetRegistry(): AssetRegistry {
    return this._assetRegistry;
  }

  get speechCommandCount(): number {
    return this._db.countSpeechCommands();
  }

  // ─────────────────────────────────────────────────────────
  // Server Lifecycle
  // ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;

    try {
      await this._acquireEngineLock();
    } catch (error) {
      this._isRunning = false;
      throw error;
    }

    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this._isRunning = false;
        void this._releaseEngineLock();
        const message = error.code === 'EADDRINUSE'
          ? `AI IDOL is already running at http://${this._config.host}:${this._config.port}`
          : error.message;
        reject(new Error(message));
      };
      this._httpServer.once('error', onError);
      this._httpServer.listen(this._config.port, this._config.host, () => {
        this._httpServer.off('error', onError);
        this._addLog('info', `Idol Runtime Server listening at http://${this._config.host}:${this._config.port}`);
        this._startMainLoop();
        this._autoStartLiveTalkingWorker();
        this._scheduleLiveTalkingMaintenance();
        this._platformChat.start();
        if (this._config.enableSimulation) {
          this._startSimulationLoop();
        }
        if (this._settings.obs.autoConnect) {
          void this._magicConnectObs().catch((error) => {
            this._addLog('warn', `OBS auto-connect is waiting: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this._isRunning = false;
    this._directorGenerationRun += 1;
    this._directorSpeechQueue.length = 0;
    if (this._chatBatchTimer) clearTimeout(this._chatBatchTimer);
    this._chatBatchTimer = null;
    this._chatBatchBuffer.length = 0;
    if (this._liveTalkingWorkerRestartTimer) {
      clearTimeout(this._liveTalkingWorkerRestartTimer);
      this._liveTalkingWorkerRestartTimer = null;
    }
    if (this._liveTalkingMaintenanceTimer) {
      clearTimeout(this._liveTalkingMaintenanceTimer);
      this._liveTalkingMaintenanceTimer = null;
    }
    if (this._tickTimer) clearInterval(this._tickTimer);
    if (this._simTimer) clearInterval(this._simTimer);
    this._platformChat.stop();

    await this._interruptSpeech();
    if (this._localModelProcess && !this._localModelProcess.killed) {
      this._localModelProcess.kill('SIGTERM');
    }
    this._localModelProcess = null;
    const qwenTtsProcess = this._qwenTtsProcess;
    if (qwenTtsProcess && !qwenTtsProcess.killed) qwenTtsProcess.kill('SIGTERM');
    this._qwenTtsProcess = null;
    this._qwenTtsStartPromise = null;
    const liveTalkingWorker = this._liveTalkingWorkerProcess;
    if (liveTalkingWorker && !liveTalkingWorker.killed) {
      this._liveTalkingWorker.state = 'STOPPING';
      await this._liveTalkingProvider.closeSession().catch(() => {});
      await new Promise<void>((resolve) => {
        let completed = false;
        const finish = () => {
          if (completed) return;
          completed = true;
          clearTimeout(forceTimer);
          resolve();
        };
        const forceTimer = setTimeout(() => {
          if (liveTalkingWorker.exitCode === null) liveTalkingWorker.kill('SIGKILL');
          finish();
        }, 8_000);
        liveTalkingWorker.once('exit', finish);
        liveTalkingWorker.kill('SIGTERM');
      });
    }
    if (this._liveTalkingWorkerProcess === liveTalkingWorker) this._liveTalkingWorkerProcess = null;
    this._director.destroy();
    this._voiceService.destroy();
    await this._obsController.shutdown();

    for (const ws of this._connectedClients) {
      ws.close();
    }
    this._connectedClients.clear();
    this._liveTalkingMediaClients.clear();
    this._liveTalkingMediaOwner = null;
    this._obsPublishers.clear();
    this._obsOutputRoutes.clear();
    this._activeObsOutputSessionId = null;

    return new Promise((resolve) => {
      this._httpServer.close(async () => {
        this._db.close();
        await this._releaseEngineLock();
        resolve();
      });
    });
  }

  private _acquireEngineLock(): Promise<void> {
    if (this._engineLockServer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const lockServer = net.createServer((socket) => {
        socket.end(`AI IDOL engine owner ${process.pid}\n`);
      });
      const onError = (error: NodeJS.ErrnoException) => {
        lockServer.close();
        reject(new Error(error.code === 'EADDRINUSE'
          ? 'Another AI IDOL runtime is active. Close the Native App or localhost server before starting a new engine instance.'
          : `Could not acquire the AI IDOL engine lock: ${error.message}`));
      };
      lockServer.once('error', onError);
      lockServer.listen(this._engineLockPort, '127.0.0.1', () => {
        lockServer.off('error', onError);
        this._engineLockServer = lockServer;
        this._addLog('info', `Exclusive engine lock acquired on 127.0.0.1:${this._engineLockPort}`);
        resolve();
      });
    });
  }

  private _releaseEngineLock(): Promise<void> {
    const lockServer = this._engineLockServer;
    this._engineLockServer = null;
    if (!lockServer) return Promise.resolve();
    return new Promise((resolve) => lockServer.close(() => resolve()));
  }

  // ─────────────────────────────────────────────────────────
  // Main Director Runtime Tick Loop (100ms interval)
  // ─────────────────────────────────────────────────────────

  private _startMainLoop(): void {
    this._tickTimer = setInterval(() => {
      try {
        const now = Date.now();
        this._runDueShowCues(now);
        const intent = this._director.tick(now);
        this._reconcileLiveTalkingMediaOwnership(now);
        // Broadcast heartbeat & system telemetry periodically
        this._broadcastTelemetry();
      } catch (err) {
        this._addLog('error', `Error in Director tick: ${err}`);
      }
    }, 100);
  }

  private _runDueShowCues(now: number): void {
    const elapsedMinutes = Math.floor((now - this._director.state.streamStartedAt) / 60_000);
    for (const cue of this._settings.showSchedule.cues) {
      if (!cue.enabled || cue.minute > elapsedMinutes || this._executedShowCueIds.has(cue.id)) continue;
      this._executedShowCueIds.add(cue.id);
      this._director.handleOperatorCommand({ action: 'CHANGE_PHASE', phase: cue.phase } as OperatorCommand);
      if (cue.action === 'scene' && cue.scene) {
        this._director.forceState(cue.scene, `Show cue ${cue.id}`);
      } else {
        const intent: DirectorIntent = {
          type: 'director.intent', action: cue.action === 'cta' ? 'TRIGGER_GOAL' : 'SPEAK',
          intent: cue.action === 'cta' ? 'scheduled_cta' : 'scheduled_show_prompt',
          emotion: 'happy', visualState: cue.scene || this._director.state.currentVisual,
          speechText: cue.prompt || `Bắt đầu phần ${cue.phase} của livestream.`, priority: 4,
          timestamp: now, maxSpeechSeconds: 15,
        };
        void this._handleDirectorIntent(intent);
      }
      this._addLog('info', `Show cue started at ${cue.minute}m: ${cue.phase}`);
    }
  }

  // ─────────────────────────────────────────────────────────
  // Simulation Loop for Fake Events (Autonomous Testing)
  // ─────────────────────────────────────────────────────────

  private _startSimulationLoop(): void {
    let tickCount = 0;
    this._simTimer = setInterval(() => {
      tickCount++;

      // Every 15s: inject random chat
      if (tickCount % 15 === 0) {
        const mockViewers = ['ThanhTam_99', 'GamerPro_VN', 'Ha_Linh_Cute', 'DragonSlayer', 'Minh_Tri'];
        const mockMessages = [
          'Game này vui quá Mimi ơi!',
          'Hôm nay Mimi live đến mấy giờ vậy?',
          'Pha vừa rồi mượt quá!',
          'Chào Mimi và cả nhà nha!',
          'Lát nữa mình vào chơi cùng được không Mimi?',
        ];
        const randomViewer = mockViewers[Math.floor(Math.random() * mockViewers.length)]!;
        const randomMsg = mockMessages[Math.floor(Math.random() * mockMessages.length)]!;

        this._chatManager.ingest({
          platform: 'youtube',
          viewerId: `usr_${Math.random().toString(36).slice(2, 7)}`,
          viewerName: randomViewer,
          message: randomMsg,
          isSuperChat: Math.random() < 0.1,
          isSubscriber: true,
          viewerTier: 'regular',
          timestamp: Date.now(),
        });
      }

      // Every 30s: spin the game simulator
      if (tickCount % 30 === 0) {
        this._gameAdapter.spinSimulator();
      }
    }, 1000);
  }

  // ─────────────────────────────────────────────────────────
  // Subsystem Event Handlers
  // ─────────────────────────────────────────────────────────

  private _queueChatForReply(message: ChatMessage): void {
    this._chatBatchBuffer.push(message);
    if (this._chatBatchBuffer.length >= this._chatBatchMaxMessages) {
      this._flushChatBatch();
      return;
    }
    this._scheduleChatBatchFlush(message.isSuperChat ? 350 : this._chatBatchWindowMs);
  }

  private _scheduleChatBatchFlush(delayMs = this._chatBatchWindowMs): void {
    if (this._chatBatchTimer) clearTimeout(this._chatBatchTimer);
    this._chatBatchTimer = setTimeout(() => {
      this._chatBatchTimer = null;
      this._flushChatBatch();
    }, Math.max(0, delayMs));
  }

  private _flushChatBatch(): void {
    if (!this._chatBatchBuffer.length) return;
    // Never interrupt the current short reply. New messages remain buffered until
    // the current audio/video command returns to IDLE.
    if (this._speechRuntime.state !== 'IDLE' || this._directorSpeechDrainRunning || this._director.state.isSpeaking) {
      this._scheduleChatBatchFlush(750);
      return;
    }

    const messages = this._chatBatchBuffer.splice(0, this._chatBatchMaxMessages);
    this._pendingPlatformReplyTargets = [...new Set(messages
      .map((message) => message.platform)
      .filter((platform): platform is 'youtube' | 'facebook' => platform === 'youtube' || platform === 'facebook'))];
    const highestPriority = Math.max(...messages.map((message) => message.priorityScore || (message.isSuperChat ? 100 : 40)));
    const emotion = messages.some((message) => message.isSuperChat) ? 'excited' : 'playful';
    const speechText = messages
      .map((message) => `${message.platform === 'facebook' ? '[FB]' : message.platform === 'youtube' ? '[YT]' : '[TEST]'} ${message.viewerName}: ${message.message}`)
      .join('\n');
    const intent: DirectorIntent = {
      type: 'director.intent',
      action: 'SPEAK',
      intent: 'reply_to_chat_batch',
      emotion,
      visualState: this._director.state.currentVisual,
      speechText,
      priority: highestPriority >= 90 ? 2 : 3,
      timestamp: Date.now(),
      maxSpeechSeconds: 12,
    };
    void this._handleDirectorIntent(intent);
    if (this._chatBatchBuffer.length) this._scheduleChatBatchFlush(250);
  }

  private async _handleDirectorIntent(intent: DirectorIntent): Promise<void> {
    this._addLog('info', `Intent generated: [${intent.action}] ${intent.intent || ''}`);

    if (intent.action === 'SPEAK' || intent.action === 'REACT' || intent.action === 'TRIGGER_GOAL') {
      const generationRun = ++this._directorGenerationRun;
      try {
        // 1. Generate Natural Dialogue text via Dialogue Agent
        const dialogue = await this._dialogueAgent.generateDialogue(intent);
        if (!this._isRunning || generationRun !== this._directorGenerationRun) return;
        if (!dialogue.text.trim()) {
          throw new Error('AI Director returned an empty reply; no TTS command was created');
        }

        const enrichedIntent = {
          ...intent,
          dialogueProvider: dialogue.provider,
          voiceProvider: this._settings.voice.provider,
        };
        this._broadcast({ type: 'DIRECTOR_INTENT', intent: enrichedIntent, timestamp: Date.now() });
        this._addLog('info', `[Dialogue:${dialogue.provider}][Voice:${this._settings.voice.provider}] ${this._settings.persona.name} says: "${dialogue.text}" (duration ~${dialogue.estimatedDurationMs}ms)`);
        await this._obsController.setSubtitles(dialogue.text);
        if (intent.intent === 'reply_to_chat_batch') {
          const targets = this._pendingPlatformReplyTargets.splice(0);
          const enabledTargets = targets.filter((platform) => this._settings.platformReply[platform]);
          const results = await Promise.allSettled(enabledTargets.map((platform) => this._platformChat.sendReply(platform, dialogue.text)));
          results.forEach((result, index) => {
            if (result.status === 'rejected') this._addLog('warn', `Platform AI reply failed: ${String(result.reason)}`);
            else this._addLog('info', `AI reply sent to ${enabledTargets[index] || 'platform chat'}`);
          });
        }

        // 2. One production path: server TTS -> LiveTalking -> WebRTC A/V.
        this._enqueueDirectorSpeechCommand(SpeechCommandSchema.parse({
          commandId: `director_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
          text: dialogue.text,
          emotion: dialogue.emotion,
          speed: 1,
          ...(intent.intent === 'reply_to_chat_batch'
            ? { durationMs: Math.min(12_000, dialogue.estimatedDurationMs) }
            : {}),
        }), dialogue.provider);
      } catch (err) {
        this._addLog('warn', `Failed to generate or play voice: ${err}`);
      this._director.setSpeaking(false);
      }
      return;
    }

    this._broadcast({ type: 'DIRECTOR_INTENT', intent, timestamp: Date.now() });
  }

  private _enqueueDirectorSpeechCommand(
    command: z.infer<typeof SpeechCommandSchema>,
    dialogueProvider: string,
  ): void {
    this._enqueueSpeechCommand(command, 'director', dialogueProvider);
  }

  private _enqueueSpeechCommand(
    command: z.infer<typeof SpeechCommandSchema>,
    source: 'operator' | 'director' = 'operator',
    dialogueProvider = source === 'operator' ? 'operator' : 'unknown',
  ): void {
    if (!this._isRunning) return;
    this._directorSpeechQueue.push({ command, dialogueProvider, source });
    void this._drainDirectorSpeechQueue();
  }

  private async _drainDirectorSpeechQueue(): Promise<void> {
    if (this._directorSpeechDrainRunning) return;
    this._directorSpeechDrainRunning = true;
    try {
      while (this._directorSpeechQueue.length > 0) {
        const next = this._directorSpeechQueue.shift();
        if (!next) continue;
        await this._executeSpeechCommand(next.command, next.source, next.dialogueProvider);
      }
    } finally {
      this._directorSpeechDrainRunning = false;
      if (this._isRunning && this._chatBatchBuffer.length) this._scheduleChatBatchFlush(250);
    }
  }

  private async _handleStateTransition(transition: StateTransition, asset: any): Promise<void> {
    this._addLog('info', `State: ${transition.fromState} -> ${transition.toState} (${asset.file})`);

    // Switch media file in OBS Media Source
    await this._obsController.switchClip(asset.file);

    this._broadcast({
      type: 'STATE_CHANGE',
      fromState: transition.fromState,
      toState: transition.toState,
      asset,
      reason: transition.reason,
      timestamp: transition.timestamp,
    });
  }

  private _handleVoiceEvent(event: any): void {
    if (event.type === 'voice.finished' || event.type === 'voice.interrupted' || event.type === 'voice.error') {
      this._director.setSpeaking(false);
      this._obsController.setSubtitles('');
    }

    const { audioBase64: _audioBase64, ...publicEvent } = event;
    this._broadcast({
      type: 'VOICE_EVENT',
      event: publicEvent,
      timestamp: Date.now(),
    });
  }

  private _setSpeechRuntime(update: Partial<typeof this._speechRuntime>): void {
    this._speechRuntime = { ...this._speechRuntime, ...update, updatedAt: Date.now() };
    if (this._speechRuntime.state === 'IDLE') this._speechIdleSince = this._speechRuntime.updatedAt;
    if (this._isRunning && this._speechRuntime.commandId) {
      this._db.upsertSpeechCommand({
        id: this._speechRuntime.commandId,
        text: this._speechRuntime.text,
        provider: this._speechRuntime.provider,
        state: this._speechRuntime.state,
        error: this._speechRuntime.error,
      });
    }
    this._broadcast({ type: 'SPEECH_STATE', speech: this._speechRuntime, timestamp: Date.now() });
  }

  private _switchLiveAvatarState(
    avatarId: string,
    state: z.infer<typeof AvatarStateSchema>,
    reason: 'emotion' | 'manual' | 'delete-replacement' = 'emotion',
  ): Promise<{ sessionid: string; avatar_id: string; state: string; changed: boolean }> {
    const operation = this._avatarStateSwitch.then(async () => {
      const sessionId = this._liveTalkingProvider.sessionId;
      if (!sessionId) throw new Error('No active Live Avatar session is available for switching');
      const result = await this._liveTalkingProvider.switchAvatarState(avatarId, state, sessionId);
      const session = this._db.getAvatarSession();
      const selectedAvatarIds = session?.selectedAvatarIds?.length
        ? session.selectedAvatarIds
        : [avatarId];
      this._db.setAvatarSession(avatarId, selectedAvatarIds, session?.excludedAvatarIds || []);
      if (this._liveTalkingMediaOwner?.sessionId === sessionId) {
        this._liveTalkingMediaOwner.avatarId = avatarId;
        this._broadcastLiveTalkingMediaState();
      }
      this._broadcast({
        type: 'AVATAR_STATE_CHANGED',
        avatarId,
        state,
        reason,
        selectedAvatarIds,
        timestamp: Date.now(),
      });
      return result;
    });
    this._avatarStateSwitch = operation.catch(() => {});
    return operation;
  }

  private async _waitForAvatarMutationBoundary(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._speechRuntime.state === 'IDLE' && !this._directorSpeechDrainRunning) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Avatar change timed out while waiting for the current reply to finish');
  }

  private async _executeSpeechCommand(
    command: z.infer<typeof SpeechCommandSchema>,
    source: 'operator' | 'director' = 'operator',
    dialogueProvider = source === 'operator' ? 'operator' : 'unknown',
  ): Promise<void> {
    const runId = ++this._speechRun;
    const commandId = command.commandId || `speech_${crypto.randomBytes(8).toString('hex')}`;
    this._director.setSpeaking(false);
    this._setSpeechRuntime({ commandId, state: 'GENERATING', text: command.text, provider: this._settings.voice.provider, dialogueProvider, durationMs: command.durationMs || null, error: null });
    this._addLog('info', `Speech ${commandId}: dialogue=${dialogueProvider}, voice=${this._settings.voice.provider}`);
    await this._liveTalkingProvider.interrupt().catch(() => {});
    if (runId !== this._speechRun) return;
    const selectedAvatarState = this._resolveAvatarState(command);
    const avatarStateSwitch = selectedAvatarState && this._liveTalkingProvider.sessionId
      ? this._switchLiveAvatarState(
        selectedAvatarState.avatarId,
        selectedAvatarState.state,
        'emotion',
      ).catch((error) => {
        this._addLog('warn', `Avatar state unavailable; keeping current state (${error instanceof Error ? error.message : String(error)})`);
        return null;
      })
      : Promise.resolve(null);

    try {
      let uploadedAudio: { bytes: Uint8Array; mediaType: string; sessionId: string } | null = null;
      await this._waitForReadyLiveTalkingMedia();
      if (runId !== this._speechRun) return;
      let playbackBoundaryReleased = false;
      const waitForPlaybackBoundary = async (): Promise<void> => {
        if (playbackBoundaryReleased) return;
        playbackBoundaryReleased = true;
        await this._waitForSpeechPlaybackBoundary(commandId, runId);
      };
      const uploadAudio = async (bytes: Uint8Array, mediaType: string): Promise<void> => {
        await avatarStateSwitch;
        await waitForPlaybackBoundary();
        if (runId !== this._speechRun) return;
        const sessionId = await this._liveTalkingProvider.sendAudio(bytes, null, mediaType);
        uploadedAudio = { bytes, mediaType, sessionId };
      };
      {
        const provider = this._settings.voice.provider;
        try {
          let audio = await this._synthesizeProviderAudio({
            commandId,
            provider,
            text: command.text,
            emotion: command.emotion,
            speed: command.speed,
            voiceId: this._settings.voice.voiceId || 'nova',
            modelId: provider === 'qwentts'
              ? 'gwen-tts-0.6B-vi-8bit'
              : 'omnivoice',
          });
          audio = await this._fitSpeechAudioDuration(audio, command.durationMs);
          this._setSpeechRuntime({ durationMs: audio.durationMs });
          if (runId !== this._speechRun) return;
          const audioBytes = Uint8Array.from(Buffer.from(audio.audioBase64, 'base64'));
          await uploadAudio(audioBytes, audio.mediaType);
        } catch (error) {
          const primaryReason = error instanceof Error ? error.message : String(error);
          if (provider === 'qwentts') {
            try {
              this._addLog('warn', `Qwen TTS unavailable; using OmniVoice fallback (${primaryReason})`);
              let fallbackAudio = await this._synthesizeProviderAudio({
                commandId,
                provider: 'omnivoice',
                text: command.text,
                emotion: command.emotion,
                speed: command.speed,
                voiceId: 'vi-female',
                modelId: 'omnivoice',
              });
              fallbackAudio = await this._fitSpeechAudioDuration(fallbackAudio, command.durationMs);
              this._setSpeechRuntime({
                provider: 'omnivoice-fallback',
                durationMs: fallbackAudio.durationMs,
              });
              const fallbackBytes = Uint8Array.from(Buffer.from(fallbackAudio.audioBase64, 'base64'));
              await uploadAudio(fallbackBytes, fallbackAudio.mediaType);
              await this._waitForLiveTalkingSpeech(runId, command, uploadedAudio);
              return;
            } catch (fallbackError) {
              this._addLog('warn', `OmniVoice fallback unavailable (${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)})`);
            }
          }
          this._addLog('warn', `${provider} unavailable; using operating-system TTS (${primaryReason})`);
          this._setSpeechRuntime({ provider: 'system-tts-fallback' });
          const systemAudio = await this._synthesizeSystemAudio(command.text, command.speed);
          await uploadAudio(systemAudio.bytes, systemAudio.mediaType);
        }
      }

      await this._waitForLiveTalkingSpeech(runId, command, uploadedAudio);
    } catch (error) {
      if (runId !== this._speechRun) return;
      const message = error instanceof Error ? error.message : String(error);
      this._director.setSpeaking(false);
      await this._obsController.setSubtitles('');
      this._director.forceState('GAMEPLAY_IDLE', 'LiveTalking speech failed');
      this._setSpeechRuntime({ state: 'ERROR', error: message });
      this._addLog('error', `Speech ${commandId} failed: ${message}`);
    }
  }

  private _resolveAvatarState(command: z.infer<typeof SpeechCommandSchema>): { avatarId: string; state: z.infer<typeof AvatarStateSchema> } | null {
    const emotionState: Record<string, z.infer<typeof AvatarStateSchema>> = {
      neutral: 'normal',
      happy: 'happy',
      excited: 'excited',
      surprised: 'surprised',
      sad: 'sad',
      angry: 'angry',
      playful: 'playful',
      focused: 'focused',
      grateful: 'grateful',
      laughing: 'laughing',
    };
    const session = this._db.getAvatarSession();
    const selectedAvatarIds = [...new Set(
      (session?.selectedAvatarIds?.length
        ? session.selectedAvatarIds
        : (session?.activeAvatarId ? [session.activeAvatarId] : []))
        .filter((id) => id && !session?.excludedAvatarIds?.includes(id)),
    )];
    const sessionAvatarId = command.avatarId || session?.activeAvatarId || selectedAvatarIds[0] || '';
    if (!sessionAvatarId && selectedAvatarIds.length === 0) return null;
    const requestedState = emotionState[command.emotion] || 'normal';
    const recordsById = new Map<string, any>();
    for (const record of [...this._readProjectAvatarArtifacts(), ...this._db.listAvatars()]) {
      const id = String(record?.id || record?.avatarId || '');
      if (id) recordsById.set(id, record);
    }
    const records = this._normalizeAvatarRecords([...recordsById.values()]);
    const selectedIdSet = new Set(command.avatarId ? [command.avatarId] : selectedAvatarIds);
    const available = records.filter((record) => selectedIdSet.has(String(record.id || record.avatarId || '')));
    const selected = available.find((record) => record.avatarState === requestedState)
      || available.find((record) => record.avatarState === 'normal')
      || available.find((record) => String(record.id || record.avatarId) === sessionAvatarId)
      || available[0];
    if (!selected) {
      const fallbackId = command.avatarId || selectedAvatarIds[0] || sessionAvatarId;
      return fallbackId ? { avatarId: fallbackId, state: requestedState } : null;
    }
    return {
      avatarId: String(selected.id || selected.avatarId),
      state: AvatarStateSchema.parse(selected.avatarState || 'normal'),
    };
  }

  private async _waitForSpeechPlaybackBoundary(commandId: string, runId: number): Promise<void> {
    if (this._connectedClients.size === 0 || runId !== this._speechRun) return;

    await new Promise<void>((resolve) => {
      const finish = () => {
        const gate = this._speechPlaybackGates.get(commandId);
        if (gate) clearTimeout(gate.timer);
        this._speechPlaybackGates.delete(commandId);
        resolve();
      };
      const timer = setTimeout(() => {
        this._addLog('warn', `Speech ${commandId}: visual boundary timed out; continuing playback`);
        finish();
      }, 8_000);
      this._speechPlaybackGates.set(commandId, { release: finish, timer });
      this._broadcast({
        type: 'SPEECH_PLAYBACK_PENDING',
        commandId,
        targetState: 'TALKING',
        timestamp: Date.now(),
      });
    });
  }

  private _releaseSpeechPlaybackBoundary(commandId: string): boolean {
    const gate = this._speechPlaybackGates.get(commandId);
    if (!gate) return false;
    gate.release();
    return true;
  }

  private async _synthesizeSystemAudio(
    text: string,
    speed = 1,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    if (process.env['NODE_ENV'] === 'test') {
      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.writeUInt32LE(36, 4);
      header.write('WAVEfmt ', 8);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(16_000, 24);
      header.writeUInt32LE(32_000, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36);
      header.writeUInt32LE(0, 40);
      return { bytes: Uint8Array.from(header), mediaType: 'audio/wav' };
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-system-tts-'));
    const outputPath = path.join(tempDir, process.platform === 'darwin' ? 'speech.aiff' : 'speech.wav');
    const run = (command: string, args: string[]): Promise<void> => new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    try {
      if (process.platform === 'darwin') {
        const rate = String(Math.max(120, Math.min(300, Math.round(185 * speed))));
        await run('say', ['-v', process.env['MACOS_TTS_VOICE'] || 'Linh', '-r', rate, '-o', outputPath, text]);
      } else if (process.platform === 'win32') {
        const rate = Math.max(-5, Math.min(5, Math.round((speed - 1) * 5)));
        const script = [
          'Add-Type -AssemblyName System.Speech;',
          '$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
          `$voice.Rate = ${rate};`,
          '$voice.SetOutputToWaveFile($args[1]);',
          '$voice.Speak($args[0]);',
          '$voice.Dispose();',
        ].join(' ');
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, text, outputPath]);
      } else {
        const wordsPerMinute = String(Math.max(100, Math.min(320, Math.round(175 * speed))));
        await run('espeak-ng', ['-v', 'vi', '-s', wordsPerMinute, '-w', outputPath, text]);
      }

      const bytes = fs.readFileSync(outputPath);
      if (!bytes.length) throw new Error('System TTS returned empty audio');
      return {
        bytes: Uint8Array.from(bytes),
        mediaType: process.platform === 'darwin' ? 'audio/aiff' : 'audio/wav',
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async _fitSpeechAudioDuration(
    audio: { audioBase64: string; mediaType: string; durationMs: number },
    requestedDurationMs?: number,
  ): Promise<{ audioBase64: string; mediaType: string; durationMs: number }> {
    if (!requestedDurationMs || audio.durationMs <= requestedDurationMs * 1.03) return audio;
    const targetDurationMs = Math.min(12_000, requestedDurationMs);
    const tempo = Math.max(1, Math.min(1.08, audio.durationMs / targetDurationMs));
    if (tempo <= 1.03) return audio;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-speech-fit-'));
    const inputExtension = audio.mediaType.includes('mpeg') ? 'mp3'
      : audio.mediaType.includes('aiff') ? 'aiff'
        : audio.mediaType.includes('ogg') ? 'ogg' : 'wav';
    const inputPath = path.join(tempDir, `input.${inputExtension}`);
    const outputPath = path.join(tempDir, 'output.wav');
    try {
      fs.writeFileSync(inputPath, Buffer.from(audio.audioBase64, 'base64'));
      await new Promise<void>((resolve, reject) => {
        execFile('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', inputPath,
          '-filter:a', `atempo=${tempo.toFixed(5)}`,
          '-ar', '16000', '-ac', '1',
          outputPath,
        ], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      const fitted = fs.readFileSync(outputPath);
      if (!fitted.length) return audio;
      const fittedDurationMs = Math.round(audio.durationMs / tempo);
      this._addLog('debug', `Fitted ${audio.durationMs}ms speech audio to ${fittedDurationMs}ms at ${tempo.toFixed(2)}x`);
      return { audioBase64: fitted.toString('base64'), mediaType: 'audio/wav', durationMs: fittedDurationMs };
    } catch (error) {
      this._addLog('warn', `Could not fit speech audio duration; using original audio (${error instanceof Error ? error.message : String(error)})`);
      return audio;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async _waitForLiveTalkingSpeech(
    runId: number,
    command: z.infer<typeof SpeechCommandSchema>,
    uploadedAudio: { bytes: Uint8Array; mediaType: string; sessionId: string } | null = null,
  ): Promise<void> {
    let started = false;
    let speechStartedAt = 0;
    let idleClipBeforeTalking: typeof this._director.state.currentClip | undefined;
    const markStarted = async (): Promise<void> => {
      if (started) return;
      started = true;
      speechStartedAt = Date.now();
      if (this._director.state.currentVisual === 'GAMEPLAY_IDLE') {
        idleClipBeforeTalking = this._director.state.currentClip;
      }
      this._director.setSpeaking(true);
      this._director.forceState('TALKING', 'LiveTalking WebRTC audio/video started');
      await this._obsController.setSubtitles(command.text);
      this._setSpeechRuntime({ state: 'SPEAKING' });
    };
    const markFinished = async (): Promise<void> => {
      this._director.setSpeaking(false);
      await this._obsController.setSubtitles('');
      this._director.forceState(
        'GAMEPLAY_IDLE',
        'LiveTalking speech completed',
        idleClipBeforeTalking,
      );
      this._setSpeechRuntime({ state: 'IDLE' });
    };

    const waitStartedAt = Date.now();
    const speechStartTimeoutMs = Math.max(
      120_000,
      Math.min(180_000, (command.durationMs || 15_000) * 8),
    );
    const replayedSessions = new Set<string>(uploadedAudio ? [uploadedAudio.sessionId] : []);
    let observedSessionId = uploadedAudio?.sessionId || this._liveTalkingProvider.sessionId;
    let supportsDetailedStatus = true;
    let speechDrainedAt = 0;
    let consecutiveStatusFailures = 0;
    let lastSuccessfulStatusAt = waitStartedAt;
    while (runId === this._speechRun) {
      try {
        let activeSessionId = this._liveTalkingProvider.sessionId;
        if (!activeSessionId) activeSessionId = await this._liveTalkingProvider.ensureActiveSession(true);
        if (!started && uploadedAudio && activeSessionId !== observedSessionId && !replayedSessions.has(activeSessionId)) {
          this._addLog('warn', `Live avatar session changed before speech; replaying audio on ${activeSessionId}`);
          activeSessionId = await this._liveTalkingProvider.sendAudio(
            uploadedAudio.bytes,
            activeSessionId,
            uploadedAudio.mediaType,
          );
          replayedSessions.add(activeSessionId);
          observedSessionId = activeSessionId;
        }

        const status = supportsDetailedStatus
          ? await this._liveTalkingProvider.getSessionStatus(activeSessionId).catch(async (statusError) => {
              const message = statusError instanceof Error ? statusError.message : String(statusError);
              if (/session\s+not\s+found|no active/i.test(message)) throw statusError;
              supportsDetailedStatus = false;
              const speaking = await this._liveTalkingProvider.isSessionSpeaking(activeSessionId);
              return { sessionid: activeSessionId, state: speaking ? 'SPEAKING' as const : 'IDLE' as const, speaking };
            })
          : await this._liveTalkingProvider.isSessionSpeaking(activeSessionId).then((speaking) => ({
              sessionid: activeSessionId,
              state: speaking ? 'SPEAKING' as const : 'IDLE' as const,
              speaking,
            }));
        consecutiveStatusFailures = 0;
        lastSuccessfulStatusAt = Date.now();
        if (status.state === 'ERROR') {
          throw new Error(String(status.details?.['error'] || 'Live avatar worker reported a speech error'));
        }
        if (status.speaking) {
          speechDrainedAt = 0;
          await markStarted();
        } else if (started) {
          const statusDetails = 'details' in status ? status.details : undefined;
          const playback = statusDetails?.['playback'] as Record<string, unknown> | undefined;
          const frameIndex = Number(playback?.['display_frame_index'] ?? playback?.['frame_index']);
          const frameCount = Number(playback?.['frame_count']);
          const sourceFps = Number(playback?.['source_fps']);
          const hasPlaybackPosition = Number.isFinite(frameIndex)
            && Number.isFinite(frameCount)
            && Number.isFinite(sourceFps)
            && frameCount > 1
            && sourceFps > 0;
          if (hasPlaybackPosition) {
            if (!speechDrainedAt) speechDrainedAt = Date.now();
            const boundaryWindow = Math.max(2, Math.ceil(sourceFps * 0.2));
            const fullCycleTimeoutMs = Math.ceil((frameCount / sourceFps) * 1000) + 1_000;
            const reachedLoopBoundary = frameIndex <= boundaryWindow;
            if (!reachedLoopBoundary && Date.now() - speechDrainedAt < fullCycleTimeoutMs) {
              await new Promise((resolve) => setTimeout(resolve, 40));
              continue;
            }
          }
          await markFinished();
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/session\s+not\s+found|no active|fetch failed|abort/i.test(message)) throw error;
        consecutiveStatusFailures += 1;

        if (started) {
          const now = Date.now();
          const expectedDurationMs = Math.max(
            500,
            this._speechRuntime.durationMs || command.durationMs || 15_000,
          );
          const playbackElapsedMs = now - speechStartedAt;
          const statusUnavailableMs = now - lastSuccessfulStatusAt;
          const playbackShouldBeComplete = playbackElapsedMs >= expectedDurationMs + 750
            && statusUnavailableMs >= 1_000
            && consecutiveStatusFailures >= 2;
          const absoluteDeadlineReached = playbackElapsedMs >= Math.max(30_000, expectedDurationMs * 3);

          // Once playback has started, replacing the WebRTC session disconnects the
          // active media source. A short status outage after the expected audio end
          // is therefore treated as a completed speech, while the worker stays alive.
          if (playbackShouldBeComplete || absoluteDeadlineReached) {
            this._addLog(
              'warn',
              `Speech status unavailable after playback; returning to idle (${message})`,
            );
            await markFinished();
            return;
          }
          this._addLog('debug', `Speech status temporarily unavailable; keeping the active session (${message})`);
        } else {
          this._addLog('debug', `Live avatar session is changing; waiting for recovery (${message})`);
          if (/session\s+not\s+found|no active/i.test(message) || consecutiveStatusFailures >= 3) {
            this._liveTalkingProvider.setSession(null);
            await this._liveTalkingProvider.ensureActiveSession(true).catch(() => null);
            consecutiveStatusFailures = 0;
          }
        }
      }
      if (!started && Date.now() - waitStartedAt > speechStartTimeoutMs) {
        throw new Error(`Live avatar did not start speaking within ${Math.round(speechStartTimeoutMs / 1000)} seconds`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  private async _interruptSpeech(): Promise<void> {
    this._speechRun += 1;
    for (const gate of this._speechPlaybackGates.values()) gate.release();
    this._speechPlaybackGates.clear();
    this._directorSpeechQueue.length = 0;
    this._voiceService.interrupt('Operator interrupt');
    await this._liveTalkingProvider.interrupt().catch(() => {});
    this._director.setSpeaking(false);
    await this._obsController.setSubtitles('');
    this._setSpeechRuntime({ state: 'IDLE', error: null });
  }

  private _handleDuckingChange(isDucked: boolean, duckDb: number): void {
    this._obsController.applyAudioDucking(isDucked, duckDb);
    this._broadcast({
      type: 'DUCKING_CHANGE',
      isDucked,
      duckDb,
      timestamp: Date.now(),
    });
  }

  private _sendLiveTalkingMediaSignal(ws: WebSocket | null, payload: Record<string, unknown>): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  private _publicLiveTalkingMediaState(): Record<string, unknown> {
    const owner = this._liveTalkingMediaOwner;
    const now = Date.now();
    const heartbeatFresh = Boolean(owner && now - owner.lastHeartbeatAt <= 7_500);
    const videoProgressFresh = Boolean(owner && owner.videoFrames > 0 && now - owner.lastVideoProgressAt <= 7_500);
    const ready = Boolean(
      owner
      && heartbeatFresh
      && videoProgressFresh
      && owner.sessionId
      && owner.sessionId === this._liveTalkingProvider.sessionId
      && owner.connectionState === 'CONNECTED'
      && owner.audioTrack
      && owner.videoTrack,
    );
    return {
      ownerClientId: owner?.clientId || null,
      sessionId: owner?.sessionId || null,
      avatarId: owner?.avatarId || null,
      connectionState: owner?.connectionState || 'CLOSED',
      audioTrack: Boolean(owner?.audioTrack),
      videoTrack: Boolean(owner?.videoTrack),
      audioPlayable: Boolean(owner?.audioPlayable),
      audioPackets: owner?.audioPackets || 0,
      videoFrames: owner?.videoFrames || 0,
      heartbeatFresh,
      videoProgressFresh,
      ready,
      standbyClients: Math.max(0, this._liveTalkingMediaClients.size - (owner ? 1 : 0)),
      updatedAt: owner?.lastHeartbeatAt || null,
    };
  }

  private _broadcastLiveTalkingMediaState(): void {
    this._broadcast({
      type: 'LIVETALKING_MEDIA_STATUS',
      media: this._publicLiveTalkingMediaState(),
      timestamp: Date.now(),
    });
  }

  private _promoteLiveTalkingMediaOwner(): void {
    if (this._liveTalkingMediaOwner?.ws.readyState === WebSocket.OPEN) return;
    this._liveTalkingMediaOwner = null;
    const candidate = [...this._liveTalkingMediaClients.entries()]
      .filter(([ws]) => ws.readyState === WebSocket.OPEN)
      .sort((a, b) => b[1].priority - a[1].priority || a[1].registeredAt - b[1].registeredAt)[0];
    if (!candidate) {
      this._liveTalkingProvider.setSession(null);
      this._broadcastLiveTalkingMediaState();
      return;
    }
    const [ws, registration] = candidate;
    this._liveTalkingMediaOwner = {
      ...registration,
      ws,
      sessionId: null,
      avatarId: '',
      connectionState: 'NEW',
      audioTrack: false,
      videoTrack: false,
      audioPlayable: false,
      audioPackets: 0,
      videoFrames: 0,
      lastAudioProgressAt: Date.now(),
      lastVideoProgressAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    };
    this._sendLiveTalkingMediaSignal(ws, {
      type: 'LIVETALKING_MEDIA_OWNER_GRANTED',
      clientId: registration.clientId,
      media: this._publicLiveTalkingMediaState(),
    });
    for (const [standbyWs, standby] of this._liveTalkingMediaClients) {
      if (standbyWs === ws) continue;
      this._sendLiveTalkingMediaSignal(standbyWs, {
        type: 'LIVETALKING_MEDIA_STANDBY',
        clientId: standby.clientId,
        ownerClientId: registration.clientId,
      });
    }
    this._addLog('info', `Live Monitor ownership granted to ${registration.clientId}`);
    this._broadcastLiveTalkingMediaState();
  }

  private _registerLiveTalkingMediaClient(
    payload: Extract<z.infer<typeof LiveTalkingMediaSignalSchema>, { type: 'LIVETALKING_MEDIA_REGISTER' }>,
    ws: WebSocket,
  ): void {
    const previous = this._liveTalkingMediaClients.get(ws);
    this._liveTalkingMediaClients.set(ws, {
      clientId: payload.clientId,
      priority: payload.priority,
      registeredAt: previous?.registeredAt || Date.now(),
    });

    const owner = this._liveTalkingMediaOwner;
    if (owner?.clientId === payload.clientId) {
      if (owner.ws !== ws) {
        const staleSessionId = owner.sessionId;
        this._sendLiveTalkingMediaSignal(owner.ws, {
          type: 'LIVETALKING_MEDIA_REVOKED',
          clientId: owner.clientId,
          reason: 'SOCKET_REPLACED',
        });
        owner.sessionId = null;
        owner.avatarId = '';
        owner.connectionState = 'NEW';
        owner.audioTrack = false;
        owner.videoTrack = false;
        owner.audioPlayable = false;
        owner.audioPackets = 0;
        owner.videoFrames = 0;
        owner.lastAudioProgressAt = Date.now();
        owner.lastVideoProgressAt = Date.now();
        this._liveTalkingProvider.setSession(null);
        if (staleSessionId) void this._liveTalkingProvider.closeSession(staleSessionId).catch(() => {});
      }
      owner.ws = ws;
      owner.priority = payload.priority;
      owner.lastHeartbeatAt = Date.now();
      this._sendLiveTalkingMediaSignal(ws, {
        type: 'LIVETALKING_MEDIA_OWNER_GRANTED',
        clientId: payload.clientId,
        media: this._publicLiveTalkingMediaState(),
      });
      return;
    }

    if (!owner || owner.ws.readyState !== WebSocket.OPEN) {
      this._promoteLiveTalkingMediaOwner();
      return;
    }
    this._sendLiveTalkingMediaSignal(ws, {
      type: 'LIVETALKING_MEDIA_STANDBY',
      clientId: payload.clientId,
      ownerClientId: owner.clientId,
    });
  }

  private _updateLiveTalkingMediaState(
    payload: Extract<z.infer<typeof LiveTalkingMediaSignalSchema>, { type: 'LIVETALKING_MEDIA_STATE' }>,
    ws: WebSocket,
  ): void {
    const owner = this._liveTalkingMediaOwner;
    if (!owner || owner.ws !== ws || owner.clientId !== payload.clientId) return;
    if (owner.sessionId && payload.sessionId && owner.sessionId !== payload.sessionId) {
      this._sendLiveTalkingMediaSignal(ws, {
        type: 'LIVETALKING_MEDIA_RESET_REQUIRED',
        clientId: owner.clientId,
        reason: 'STALE_SESSION',
      });
      return;
    }
    const now = Date.now();
    if (payload.audioPackets > owner.audioPackets) owner.lastAudioProgressAt = now;
    if (payload.videoFrames > owner.videoFrames) owner.lastVideoProgressAt = now;
    owner.sessionId = payload.sessionId || owner.sessionId;
    owner.connectionState = payload.connectionState;
    owner.audioTrack = payload.audioTrack;
    owner.videoTrack = payload.videoTrack;
    owner.audioPlayable = payload.audioPlayable;
    owner.audioPackets = payload.audioPackets;
    owner.videoFrames = payload.videoFrames;
    owner.lastHeartbeatAt = now;
    this._broadcastLiveTalkingMediaState();
  }

  private _reconcileLiveTalkingMediaOwnership(now = Date.now()): void {
    if (now - this._lastLiveTalkingMediaWatchdogAt < 1_000) return;
    this._lastLiveTalkingMediaWatchdogAt = now;
    const owner = this._liveTalkingMediaOwner;
    if (!owner) return;

    const standbyAvailable = [...this._liveTalkingMediaClients.entries()]
      .some(([ws]) => ws !== owner.ws && ws.readyState === WebSocket.OPEN);
    if (now - owner.lastHeartbeatAt > 10_000 && standbyAvailable) {
      const staleSessionId = owner.sessionId;
      this._sendLiveTalkingMediaSignal(owner.ws, {
        type: 'LIVETALKING_MEDIA_REVOKED',
        clientId: owner.clientId,
        reason: 'HEARTBEAT_TIMEOUT',
      });
      this._liveTalkingMediaClients.delete(owner.ws);
      this._liveTalkingMediaOwner = null;
      this._liveTalkingProvider.setSession(null);
      if (staleSessionId) void this._liveTalkingProvider.closeSession(staleSessionId).catch(() => {});
      this._addLog('warn', `Live Monitor ${owner.clientId} timed out; promoting standby`);
      this._promoteLiveTalkingMediaOwner();
      return;
    }

    if (owner.sessionId
      && owner.connectionState === 'CONNECTED'
      && owner.videoFrames > 0
      && now - owner.lastVideoProgressAt > 10_000) {
      const staleSessionId = owner.sessionId;
      this._invalidateLiveTalkingMediaSession('VIDEO_FRAME_STALLED');
      void this._liveTalkingProvider.closeSession(staleSessionId).catch(() => {});
      this._addLog('warn', `Live Monitor ${owner.clientId} stopped decoding video; session reset`);
    }
  }

  private _releaseLiveTalkingMediaClient(ws: WebSocket, explicitClientId?: string): void {
    const registration = this._liveTalkingMediaClients.get(ws);
    if (explicitClientId && registration?.clientId !== explicitClientId) return;
    this._liveTalkingMediaClients.delete(ws);
    const owner = this._liveTalkingMediaOwner;
    if (!owner || owner.ws !== ws) return;
    const sessionId = owner.sessionId;
    this._liveTalkingMediaOwner = null;
    if (sessionId) void this._liveTalkingProvider.closeSession(sessionId).catch(() => {});
    else this._liveTalkingProvider.setSession(null);
    this._addLog('info', `Live Monitor ownership released by ${owner.clientId}`);
    this._promoteLiveTalkingMediaOwner();
  }

  private _invalidateLiveTalkingMediaSession(reason: string): void {
    this._liveTalkingProvider.setSession(null);
    const owner = this._liveTalkingMediaOwner;
    if (!owner) return;
    owner.sessionId = null;
    owner.connectionState = 'DISCONNECTED';
    owner.audioTrack = false;
    owner.videoTrack = false;
    owner.audioPlayable = false;
    owner.audioPackets = 0;
    owner.videoFrames = 0;
    owner.lastAudioProgressAt = Date.now();
    owner.lastVideoProgressAt = Date.now();
    owner.lastHeartbeatAt = Date.now();
    this._sendLiveTalkingMediaSignal(owner.ws, {
      type: 'LIVETALKING_MEDIA_RESET_REQUIRED',
      clientId: owner.clientId,
      reason,
    });
    this._broadcastLiveTalkingMediaState();
  }

  private _hasReadyLiveTalkingMedia(): boolean {
    return Boolean(this._publicLiveTalkingMediaState()['ready']);
  }

  private async _waitForReadyLiveTalkingMedia(timeoutMs = 12_000): Promise<void> {
    if (process.env['NODE_ENV'] === 'test' && !this._liveTalkingMediaOwner) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._hasReadyLiveTalkingMedia()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const media = this._publicLiveTalkingMediaState();
    if (!media['ownerClientId']) throw new Error('No active Live Monitor owns the avatar session');
    throw new Error('Live Monitor WebRTC media is not ready; reconnecting the avatar is required');
  }

  // ─────────────────────────────────────────────────────────
  // WebSocket Handling
  // ─────────────────────────────────────────────────────────

  private _handleWsConnection(ws: WebSocket): void {
    this._connectedClients.add(ws);
    this._addLog('info', `Operator Dashboard connected. Total clients: ${this._connectedClients.size}`);

    // Send initial complete state snapshot
    ws.send(JSON.stringify({
      type: 'INITIAL_STATE',
      state: this._director.state,
      library: this._assetRegistry.getAll(),
      goals: this._goalEngine.getAllGoals(),
      speech: this._speechRuntime,
      settings: this._publicSettings(),
      media: this._publicLiveTalkingMediaState(),
      recentLogs: this._recentLogs.slice(-25),
      timestamp: Date.now(),
    }));

    ws.on('message', (data: string) => {
      try {
        const message = JSON.parse(data.toString());
        this._handleClientMessage(message, ws);
      } catch (err) {
        this._addLog('error', `Invalid WS payload: ${err}`);
      }
    });

    ws.on('close', () => {
      this._connectedClients.delete(ws);
      this._releaseLiveTalkingMediaClient(ws);
      this._releaseObsOutputSocket(ws);
      this._addLog('info', `Operator Dashboard disconnected. Remaining: ${this._connectedClients.size}`);
    });
  }

  private _handleClientMessage(msg: any, _ws: WebSocket): void {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      _ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid WebSocket message' }));
      return;
    }
    switch (msg.type) {
      case 'OPERATOR_COMMAND': {
        const parsed = OperatorCommandSchema.safeParse(msg.command);
        if (!parsed.success) return this._sendWsValidationError(_ws, parsed.error.issues);
        this._director.injectOperatorCommand(parsed.data);
        break;
      }

      case 'INJECT_GAME_EVENT': {
        const parsed = GameEventSchema.safeParse(msg.event);
        if (!parsed.success) return this._sendWsValidationError(_ws, parsed.error.issues);
        this._director.injectGameEvent(parsed.data);
        break;
      }

      case 'INJECT_CHAT_MESSAGE': {
        const parsed = ChatMessageSchema.safeParse(msg.message);
        if (!parsed.success) return this._sendWsValidationError(_ws, parsed.error.issues);
        this._director.injectChatMessage(parsed.data);
        break;
      }

      case 'INJECT_DONATION': {
        const parsed = DonationEventSchema.safeParse(msg.donation);
        if (!parsed.success) return this._sendWsValidationError(_ws, parsed.error.issues);
        this._director.injectDonation(parsed.data);
        break;
      }

      case 'FORCE_STATE': {
        const parsed = VisualStateSchema.safeParse(msg.state);
        if (!parsed.success) return this._sendWsValidationError(_ws, parsed.error.issues);
        this._director.forceState(parsed.data, 'Operator override via WS');
        break;
      }

      case 'TEST_JACKPOT':
        this._director.injectGameEvent({
          type: 'game.jackpot',
          value: 5000,
          currency: 'JACKPOT_GOLD',
          timestamp: Date.now(),
        });
        break;

      case 'LIVETALKING_MEDIA_REGISTER':
      case 'LIVETALKING_MEDIA_STATE':
      case 'LIVETALKING_MEDIA_RELEASE': {
        const parsed = LiveTalkingMediaSignalSchema.safeParse(msg);
        if (!parsed.success) return this._sendWsValidationError(_ws, parsed.error.issues);
        if (parsed.data.type === 'LIVETALKING_MEDIA_REGISTER') {
          this._registerLiveTalkingMediaClient(parsed.data, _ws);
        } else if (parsed.data.type === 'LIVETALKING_MEDIA_STATE') {
          this._updateLiveTalkingMediaState(parsed.data, _ws);
        } else {
          this._releaseLiveTalkingMediaClient(_ws, parsed.data.clientId);
        }
        break;
      }

      case 'OBS_OUTPUT_REGISTER':
      case 'OBS_OUTPUT_READY':
      case 'OBS_OUTPUT_MEDIA_CONNECTED':
      case 'OBS_OUTPUT_RECEIVER_CLOSED':
      case 'OBS_OUTPUT_OFFER':
      case 'OBS_OUTPUT_ANSWER':
      case 'OBS_OUTPUT_ICE': {
        const parsed = ObsOutputSignalSchema.safeParse(msg);
        if (!parsed.success) return this._sendWsValidationError(_ws, parsed.error.issues);
        this._handleObsOutputSignal(parsed.data, _ws);
        break;
      }

      default:
        _ws.send(JSON.stringify({ type: 'ERROR', error: 'Unsupported WebSocket message type' }));
    }
  }

  private _sendWsValidationError(ws: WebSocket, issues: z.ZodIssue[]): void {
    ws.send(JSON.stringify({
      type: 'ERROR',
      error: 'Invalid WebSocket payload',
      issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    }));
  }

  private _broadcast(payload: Record<string, unknown>): void {
    const serialized = JSON.stringify(payload);
    for (const ws of this._connectedClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serialized);
      }
    }
  }

  private _sendObsOutputSignal(ws: WebSocket | null, payload: Record<string, unknown>): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  private _bestObsPublisher(): [WebSocket, ObsPublisherRegistration] | null {
    const available = [...this._obsPublishers.entries()]
      .filter(([ws]) => ws.readyState === WebSocket.OPEN)
      .sort((a, b) => b[1].priority - a[1].priority || b[1].registeredAt - a[1].registeredAt);
    return available[0] || null;
  }

  private _assignObsPublisher(route: ObsOutputRoute): void {
    if (!route.receiver || route.receiver.readyState !== WebSocket.OPEN) return;
    const selected = this._bestObsPublisher();
    const nextPublisher = selected?.[0] || null;
    const nextRegistration = selected?.[1] || null;
    if (route.publisher === nextPublisher && route.publisherPeerId === (nextRegistration?.peerId || '')) {
      return;
    }

    if (route.publisher) {
      this._sendObsOutputSignal(route.publisher, {
        type: 'OBS_OUTPUT_SESSION_REVOKED',
        sessionId: route.sessionId,
      });
    }
    route.publisher = nextPublisher;
    route.publisherPeerId = nextRegistration?.peerId || '';
    route.negotiationId = '';
    this._sendObsOutputSignal(route.receiver, { type: 'OBS_OUTPUT_RESET', sessionId: route.sessionId });
    if (route.publisher) {
      this._sendObsOutputSignal(route.publisher, {
        type: 'OBS_OUTPUT_SESSION_ASSIGNED',
        sessionId: route.sessionId,
        receiverReady: true,
      });
      this._addLog('info', `OBS output ${route.sessionId} assigned to publisher ${route.publisherPeerId}`);
    } else {
      this._addLog('warn', `OBS output ${route.sessionId} is waiting for a Monitor publisher`);
    }
  }

  private _registerObsOutputPeer(payload: z.infer<typeof ObsOutputSignalSchema>, ws: WebSocket): void {
    if (payload.type !== 'OBS_OUTPUT_REGISTER') return;
    if (payload.role === 'publisher') {
      this._obsPublishers.set(ws, {
        peerId: payload.peerId,
        priority: payload.priority,
        registeredAt: Date.now(),
      });
      for (const route of this._obsOutputRoutes.values()) this._assignObsPublisher(route);
      return;
    }

    const sessionId = payload.sessionId || '';
    if (!sessionId || sessionId !== this._activeObsOutputSessionId) {
      this._sendObsOutputSignal(ws, { type: 'OBS_OUTPUT_SESSION_REJECTED', sessionId, reason: 'STALE_SESSION' });
      return;
    }
    let route = this._obsOutputRoutes.get(sessionId);
    if (!route) {
      route = {
        sessionId,
        receiver: null,
        receiverPeerId: '',
        publisher: null,
        publisherPeerId: '',
        negotiationId: '',
      };
      this._obsOutputRoutes.set(sessionId, route);
    }
    if (route.receiver && route.receiver !== ws) {
      this._sendObsOutputSignal(route.receiver, { type: 'OBS_OUTPUT_SESSION_REVOKED', sessionId });
    }
    route.receiver = ws;
    route.receiverPeerId = payload.peerId;
    route.negotiationId = '';
    this._assignObsPublisher(route);
  }

  private _handleObsOutputSignal(payload: z.infer<typeof ObsOutputSignalSchema>, sender: WebSocket): void {
    if (payload.type === 'OBS_OUTPUT_REGISTER') {
      this._registerObsOutputPeer(payload, sender);
      return;
    }
    const route = this._obsOutputRoutes.get(payload.sessionId);
    if (!route) return;
    const fromPublisher = route.publisher === sender;
    const fromReceiver = route.receiver === sender;
    if (!fromPublisher && !fromReceiver) return;

    if (payload.type === 'OBS_OUTPUT_RECEIVER_CLOSED') {
      if (!fromReceiver) return;
      route.receiver = null;
      route.receiverPeerId = '';
      route.negotiationId = '';
      this._sendObsOutputSignal(route.publisher, { type: 'OBS_OUTPUT_SESSION_REVOKED', sessionId: route.sessionId });
      route.publisher = null;
      route.publisherPeerId = '';
      return;
    }
    if (payload.type === 'OBS_OUTPUT_READY') {
      if (fromReceiver) {
        this._sendObsOutputSignal(route.publisher, { type: 'OBS_OUTPUT_READY', sessionId: route.sessionId });
      }
      return;
    }
    if (payload.type === 'OBS_OUTPUT_OFFER') {
      if (!fromPublisher) return;
      route.negotiationId = payload.negotiationId;
      this._sendObsOutputSignal(route.receiver, payload);
      return;
    }
    if (payload.type === 'OBS_OUTPUT_ANSWER') {
      if (!fromReceiver || payload.negotiationId !== route.negotiationId) return;
      this._sendObsOutputSignal(route.publisher, payload);
      return;
    }
    if (payload.type === 'OBS_OUTPUT_ICE') {
      if (payload.negotiationId !== route.negotiationId) return;
      this._sendObsOutputSignal(fromPublisher ? route.receiver : route.publisher, payload);
      return;
    }
    if (payload.type === 'OBS_OUTPUT_MEDIA_CONNECTED') {
      if (!fromReceiver || payload.negotiationId !== route.negotiationId) return;
      this._sendObsOutputSignal(route.publisher, payload);
    }
  }

  private _releaseObsOutputSocket(ws: WebSocket): void {
    this._obsPublishers.delete(ws);
    for (const route of this._obsOutputRoutes.values()) {
      if (route.receiver === ws) {
        route.receiver = null;
        route.receiverPeerId = '';
        route.negotiationId = '';
        this._sendObsOutputSignal(route.publisher, { type: 'OBS_OUTPUT_SESSION_REVOKED', sessionId: route.sessionId });
        route.publisher = null;
        route.publisherPeerId = '';
      } else if (route.publisher === ws) {
        route.publisher = null;
        route.publisherPeerId = '';
        route.negotiationId = '';
        this._sendObsOutputSignal(route.receiver, { type: 'OBS_OUTPUT_RESET', sessionId: route.sessionId });
        this._assignObsPublisher(route);
      }
    }
  }

  private _broadcastTelemetry(): void {
    const memory = process.memoryUsage();
    this._broadcast({
      type: 'TELEMETRY',
      state: this._director.state,
      memoryMb: Math.round(memory.heapUsed / 1024 / 1024),
      queueSize: this._director.queue.size,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: Date.now(),
    });
  }

  private _addLog(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown): void {
    const entry = { level, message: `${message} ${data ? JSON.stringify(data) : ''}`.trim(), timestamp: Date.now() };
    this._recentLogs.push(entry);
    if (this._recentLogs.length > 100) this._recentLogs.shift();

    this._broadcast({
      type: 'LOG_ENTRY',
      log: entry,
    });
  }

  private _updateVoiceSettings(newSettings: Partial<typeof this._settings.voice>): void {
    const { apiKey: _ignoredApiKey, ...safeSettings } = newSettings;
    this._settings.voice = { ...this._settings.voice, ...safeSettings };
    const { apiKey: _secret, ...persistedVoice } = this._settings.voice;
    this._db.setSetting('voice', persistedVoice);

    this._voiceService.setAdapter(new WebSpeechTTSAdapter());

    this._addLog('info', `Voice provider updated: ${this._settings.voice.provider}`);
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
  }

  private _updateAvatarSettings(newSettings: Partial<typeof this._settings.avatar>): void {
    this._settings.avatar = { ...this._settings.avatar, ...newSettings };
    this._db.setSetting('avatar', this._settings.avatar);
    this._addLog('info', `Avatar updated: preset=${this._settings.avatar.preset}, customImage=${!!this._settings.avatar.customImageUrl}`);
    this._broadcast({ type: 'AVATAR_UPDATED', avatar: this._settings.avatar });
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
  }

  private _updatePersonaSettings(newSettings: Partial<typeof this._settings.persona>): void {
    const { llmApiKey: _ignoredLlmKey, ...safeSettings } = newSettings;
    const previousName = this._settings.persona.name;
    const nextPersona = { ...this._settings.persona, ...safeSettings };
    const hasStructuredProfile = Object.keys(safeSettings).some((key) => !['name', 'personality', 'systemPrompt', 'llmProvider', 'llmModel'].includes(key));
    if (hasStructuredProfile) {
      nextPersona.systemPrompt = this._buildPersonaSkill(nextPersona);
    } else if (safeSettings.name && safeSettings.name !== previousName) {
      const sourcePrompt = safeSettings.systemPrompt ?? this._settings.persona.systemPrompt;
      nextPersona.systemPrompt = (sourcePrompt.includes(safeSettings.name)
        ? sourcePrompt
        : sourcePrompt.replaceAll(previousName, safeSettings.name))
        .replace(/\bMimi\b/gi, safeSettings.name);
    }
    this._settings.persona = nextPersona;
    const { llmApiKey: _secret, ...persistedPersona } = this._settings.persona;
    this._db.setSetting('persona', persistedPersona);
    this._dialogueAgent.updatePersona({
      name: this._settings.persona.name,
      personality: this._settings.persona.personality,
      systemPrompt: this._settings.persona.systemPrompt,
    });

    this._configureDialogueProvider();

    this._addLog('info', `Idol persona updated: ${this._settings.persona.name}`);
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
  }

  private _buildPersonaSkill(persona: typeof this._settings.persona): string {
    const labels: Record<string, string> = {
      friendly: 'thân thiện', sweet: 'ngọt ngào', energetic: 'năng động', playful: 'tinh nghịch', elegant: 'thanh lịch', calm: 'điềm tĩnh', professional: 'chuyên nghiệp',
      'close-friend': 'người bạn thân', 'younger-sister': 'em gái gần gũi', 'younger-brother': 'em trai gần gũi', host: 'host dẫn dắt', adviser: 'người tư vấn', entertainer: 'người tạo không khí',
      natural: 'tự nhiên', bright: 'tươi sáng', warm: 'ấm áp', confident: 'tự tin', balanced: 'cân bằng', high: 'cao', low: 'thấp',
      none: 'không', light: 'nhẹ', reserved: 'tiết chế', 'very-warm': 'rất ấm áp', casual: 'thân mật', polite: 'lịch sự', expressive: 'biểu cảm',
      off: 'không dùng', 'use-name': 'gọi tên người xem', 'avoid-pronoun': 'tránh đại từ', ban: 'gọi bạn',
    };
    const label = (value: string) => labels[value] || value;
    const brief = persona.briefMarkdown.trim();
    return [
      '# Idol Profile',
      `Bạn là ${persona.name}, AI Idol ${persona.gender === 'male' ? 'nam' : 'nữ'} ${persona.ageRange} tuổi.`,
      `Vai trò: ${label(persona.archetype)}, tương tác như ${label(persona.relationshipStyle)}.`,
      `Tính cách: ${persona.personality || label(persona.archetype)}.`,
      `Giọng nói: ${label(persona.speakingTone)}; năng lượng ${label(persona.energy)}; hài hước ${label(persona.humor)}; độ ấm ${label(persona.warmth)}; mức trang trọng ${label(persona.formality)}.`,
      persona.catchphrases ? `Câu cửa miệng (chỉ dùng khi tự nhiên): ${persona.catchphrases}.` : '',
      '',
      '## Mục tiêu',
      `- Chính: ${persona.primaryGoal}`,
      `- Phụ: ${persona.secondaryGoal}`,
      `- Tối đa ${persona.maxChatsPerReply} bình luận trong một lượt; hỏi tiếp khoảng ${persona.followUpRate}% số lượt; CTA ${label(persona.ctaFrequency)}.`,
      '',
      '## Xưng hô',
      `- Tự xưng "${persona.selfPronoun}"; gọi người xem nam là "${persona.maleViewerPronoun}", nữ là "${persona.femaleViewerPronoun}".`,
      `- Không rõ giới tính: ${label(persona.unknownViewerStrategy)}. Không trộn hệ xưng hô trong cùng một câu trả lời.`,
      '',
      '## Live Reply',
      '- Trả lời trực tiếp bằng tiếng Việt tự nhiên, 1-2 câu nói và không quá 40 từ.',
      '- Giữ nguyên câu trả lời ngắn; không thêm câu xã giao chỉ để kéo dài thời lượng.',
      '- Không mở đầu bằng câu thông báo đã đọc bình luận. Không nói như trợ lý, không lặp nguyên văn câu hỏi.',
      '- Bỏ tag nền tảng, emoji, Markdown và ký hiệu khỏi phần được đọc thành tiếng.',
      `- Cảm xúc ${label(persona.emotionStyle)}: khen -> happy; đùa -> playful; quà/cảm ơn -> grateful; bất ngờ -> surprised; câu thường -> neutral; câu khó -> focused; spam/không an toàn -> bỏ qua.`,
      brief ? `\n## Brief tham chiếu (${persona.briefSourceName || 'Imported brief'})\n${brief}` : '',
    ].filter(Boolean).join('\n');
  }

  private _buildLiveSessionSkill(settings: Pick<typeof this._settings.liveSession, 'goal' | 'personaBrief' | 'context'>): string {
    return [
      '# Live Session Reply Skill',
      '## Goal', settings.goal || 'Tương tác tự nhiên và giữ người xem trong phiên live.',
      '## Character voice', settings.personaBrief || this._settings.persona.personality,
      '## Session context', settings.context || 'Livestream tương tác với người xem.',
      '## Speaking rules',
      '- Trả lời nhất quán với mục tiêu, cá tính và bối cảnh trên.',
      '- Dùng văn nói tiếng Việt tự nhiên, ngắn gọn, phù hợp để TTS đọc trực tiếp.',
      '- Không dùng emoji, icon, Markdown hoặc ký hiệu trang trí trong câu trả lời.',
      '- Phiên âm chữ viết tắt, model, mã sản phẩm và chuỗi chữ-số sang cách đọc tiếng Việt.',
      '- Không nhắc đến skill, brief, prompt hoặc các chỉ dẫn nội bộ.',
    ].join('\n');
  }

  private _updateLiveSessionSettings(input: z.infer<typeof LiveSessionSettingsSchema>): void {
    const skillMarkdown = this._buildLiveSessionSkill(input);
    this._settings.liveSession = { ...input, skillMarkdown };
    this._db.setSetting('liveSession', this._settings.liveSession);
    if (this._replySkillLibrary().activeSkillId === GENERATED_REPLY_SKILL_ID) {
      this._dialogueAgent.updatePersona({ sessionSkillMarkdown: skillMarkdown });
    }
    this._addLog('info', 'Live Session reply skill regenerated');
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
  }

  private _configureDialogueProvider(): void {
    const providers: Array<OllamaDialogueProvider | OpenAIDialogueProvider> = [
      new OllamaDialogueProvider({
        endpoint: process.env['OLLAMA_ENDPOINT'] || 'http://127.0.0.1:11434',
        model: 'qwen3:8b',
      }),
    ];
    if (this._settings.persona.llmApiKey) {
      providers.push(new OpenAIDialogueProvider({
        apiKey: this._settings.persona.llmApiKey,
        baseUrl: this._ttmApiBaseUrl(),
        model: process.env['TTM_MODEL'] || 'chat-latest',
        providerName: 'ttm-chatgpt',
      }));
    }
    this._dialogueAgent.setProviders(providers);
  }

  private async _unloadOllamaModels(): Promise<void> {
    const endpoint = (process.env['OLLAMA_ENDPOINT'] || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const runningResponse = await fetch(`${endpoint}/api/ps`, { signal: controller.signal });
      if (!runningResponse.ok) return;
      const running = await runningResponse.json() as any;
      const models = Array.isArray(running.models)
        ? [...new Set(running.models
          .map((item: any) => String(item?.name || item?.model || '').trim())
          .filter(Boolean))]
        : [];
      await Promise.all(models.map((model) => fetch(`${endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: controller.signal,
      })));
      if (models.length) this._addLog('info', `Released ${models.length} local AI Director model${models.length === 1 ? '' : 's'} from memory`);
    } catch {
      // Ollama is optional when TTM is active.
    } finally {
      clearTimeout(timeout);
    }
  }

  private _ttmApiBaseUrl(): string {
    return (process.env['TTM_API_BASE_URL'] || 'https://ttmapi.site/v1').replace(/\/+$/, '');
  }

  private async _fetchTtmModels(apiKey: string): Promise<string[]> {
    if (!apiKey) throw new Error('TTM API key is required');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${this._ttmApiBaseUrl()}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as any;
      if (!response.ok) throw new Error(payload.error?.message || payload.message || `TTM API HTTP ${response.status}`);
      const models = Array.isArray(payload.data) ? payload.data : (Array.isArray(payload.models) ? payload.models : []);
      return [...new Set(models
        .map((item: any) => String(typeof item === 'string' ? item : item?.id || '').trim())
        .filter((id: string) => OllamaModelSchema.safeParse(id).success))].slice(0, 200) as string[];
    } finally {
      clearTimeout(timeout);
    }
  }

  private async _updateObsSettings(newSettings: Partial<typeof this._settings.obs>): Promise<void> {
    const { password: _ignoredPassword, ...safeSettings } = newSettings;
    this._settings.obs = { ...this._settings.obs, ...safeSettings };
    const { password: _secret, ...persistedObs } = this._settings.obs;
    this._db.setSetting('obs', persistedObs);
    await this._obsController.configure({
      url: `ws://${this._settings.obs.host}:${this._settings.obs.port}`,
      password: this._settings.obs.password,
      autoReconnect: this._settings.obs.autoConnect,
    });
    if (this._settings.obs.autoConnect) {
      await this._obsController.initialize();
    }
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
  }

  private _obsBrowserSourceUrl(sessionId: string): string {
    const host = isLoopbackHost(this._config.host) || this._config.host === '0.0.0.0'
      ? '127.0.0.1'
      : this._config.host;
    const tokenFragment = this._config.authToken
      ? `#token=${encodeURIComponent(this._config.authToken)}`
      : '';
    return `http://${host}:${this._config.port}/overlay/obs-output.html?session=${encodeURIComponent(sessionId)}&instance=${Date.now()}${tokenFragment}`;
  }

  private async _magicConnectObs(): Promise<OBSMagicConnectResult> {
    if (this._obsMagicConnectPromise) return this._obsMagicConnectPromise;
    this._obsMagicConnectPromise = (async () => {
      this._settings.obs.autoConnect = true;
      const { password: _secret, ...persistedObs } = this._settings.obs;
      this._db.setSetting('obs', persistedObs);
      await this._obsController.configure({
        url: `ws://${this._settings.obs.host}:${this._settings.obs.port}`,
        password: this._settings.obs.password,
        autoReconnect: true,
      });
      const sessionId = `obs_${crypto.randomUUID().replace(/-/g, '')}`;
      const previousSessionId = this._activeObsOutputSessionId;
      this._activeObsOutputSessionId = sessionId;
      if (previousSessionId && previousSessionId !== sessionId) {
        const previousRoute = this._obsOutputRoutes.get(previousSessionId);
        this._sendObsOutputSignal(previousRoute?.publisher || null, {
          type: 'OBS_OUTPUT_SESSION_REVOKED',
          sessionId: previousSessionId,
        });
        this._sendObsOutputSignal(previousRoute?.receiver || null, {
          type: 'OBS_OUTPUT_SESSION_REVOKED',
          sessionId: previousSessionId,
        });
        this._obsOutputRoutes.delete(previousSessionId);
      }
      this._obsOutputRoutes.set(sessionId, {
        sessionId,
        receiver: null,
        receiverPeerId: '',
        publisher: null,
        publisherPeerId: '',
        negotiationId: '',
      });
      const videoPreset = this._obsOutputPreset() || this._liveVideoPreset();
      const result = await this._obsController.magicConnect({
        url: this._obsBrowserSourceUrl(sessionId),
        sourceName: 'AI IDOL Streamer',
        width: videoPreset.width,
        height: videoPreset.height,
        fps: videoPreset.fps,
        applyVideoSettings: Boolean(this._obsOutputPreset()),
      });
      this._addLog('info', `OBS Magic Connect ready in scene ${result.sceneName}`);
      this._broadcast({
        type: 'OBS_STATUS',
        obs: { ...result, autoConnect: true },
        timestamp: Date.now(),
      });
      this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
      return result;
    })();
    try {
      return await this._obsMagicConnectPromise;
    } finally {
      this._obsMagicConnectPromise = null;
    }
  }

  private async _synthesizeOmniSpeakAudio(input: z.infer<typeof SpeechSynthesisSchema>): Promise<{ audioBase64: string; mediaType: string; durationMs: number }> {
    const requestedVoice = input.voiceId || this._settings.voice.voiceId || 'voice_bright_storyteller';
    const voiceId = requestedVoice === 'vi-female' ? 'voice_bright_storyteller' : requestedVoice;
    const job = await this._omniSpeakJson('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 'project_inbox',
        text: input.text,
        speaker_map: { 'Speaker 1': voiceId },
        config: { speed: input.speed, language: 'vi', remove_silence: true },
      }),
    });
    const jobId = String(job.id || '');
    if (!jobId) throw new Error('OmniVoice desktop API returned no speech job id');

    let completed: any = null;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const status = await this._omniSpeakJson(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (status.status === 'completed') {
        completed = status;
        break;
      }
      if (['failed', 'cancelled'].includes(status.status)) {
        throw new Error(status.error || `OmniVoice desktop job ${status.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!completed || completed.status !== 'completed') throw new Error('OmniVoice desktop speech job timed out');
    const audioUrl = completed.audio_url || `/api/jobs/${encodeURIComponent(jobId)}/audio?format=wav`;
    const audioResponse = await fetch(new URL(audioUrl, `${this._omniSpeakEndpoint()}/`));
    if (!audioResponse.ok) throw new Error(`OmniVoice desktop audio HTTP ${audioResponse.status}`);
    const audio = Buffer.from(await audioResponse.arrayBuffer());
    return {
      audioBase64: audio.toString('base64'),
      mediaType: audioResponse.headers.get('content-type') || 'audio/wav',
      durationMs: Number(completed.duration_ms) || Math.max(1800, Math.round((input.text.split(/\s+/).filter(Boolean).length / 3.2 / input.speed) * 1000)),
    };
  }

  private async _synthesizeQwenTtsAudio(input: z.infer<typeof SpeechSynthesisSchema>): Promise<{ audioBase64: string; mediaType: string; durationMs: number }> {
    await this._ensureQwenTtsReady();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`${this._qwenTtsEndpoint()}/api/synthesize`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: input.text,
          voice_id: input.voiceId || this._settings.voice.voiceId || 'qwen-default',
          speed: input.speed,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(`Qwen TTS HTTP ${response.status}${payload.detail ? `: ${payload.detail}` : ''}`);
      }
      const audio = Buffer.from(await response.arrayBuffer());
      const durationMs = Number(response.headers.get('x-audio-duration-ms'))
        || Math.max(1800, Math.round((input.text.split(/\s+/).filter(Boolean).length / 3.2 / input.speed) * 1000));
      const generationMs = Number(response.headers.get('x-generation-ms'));
      if (generationMs > 0) this._addLog('debug', `Qwen TTS generated ${durationMs}ms audio in ${generationMs}ms`);
      return {
        audioBase64: audio.toString('base64'),
        mediaType: response.headers.get('content-type') || 'audio/wav',
        durationMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async _synthesizeProviderAudio(input: z.infer<typeof SpeechSynthesisSchema>): Promise<{ audioBase64: string; mediaType: string; durationMs: number }> {
    if (input.provider === 'qwentts') {
      return this._synthesizeQwenTtsAudio(input);
    }

    if (input.provider === 'omnivoice') {
      if (process.env['OMNIVOICE_DESKTOP_ENDPOINT'] !== 'off') {
        try {
          return await this._synthesizeOmniSpeakAudio(input);
        } catch (error) {
          this._addLog('warn', `OmniVoice desktop service unavailable; trying compatible TTS endpoint (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      const endpoint = new URL(this._settings.voice.customEndpoint || process.env['OMNIVOICE_ENDPOINT'] || 'http://127.0.0.1:7861');
      const allowedHosts = (process.env['OMNIVOICE_ALLOWED_HOSTS'] || '127.0.0.1,localhost,::1')
        .split(',').map(host => host.trim()).filter(Boolean);
      if (!['http:', 'https:'].includes(endpoint.protocol) || !allowedHosts.includes(endpoint.hostname)) {
        throw new Error('OmniVoice endpoint is not allowlisted');
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      const requestedVoice = input.voiceId || this._settings.voice.voiceId || 'vi-female';
      const providerVoice = requestedVoice === 'vi-female'
        ? (process.env['OMNIVOICE_VI_FEMALE_VOICE'] || 'nova')
        : requestedVoice;
      const response = await fetch(new URL('/v1/audio/speech', endpoint), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.modelId || process.env['OMNIVOICE_MODEL'] || 'omnivoice',
          voice: providerVoice,
          input: input.text,
          language: 'Vietnamese',
          speed: input.speed,
          response_format: 'mp3',
        }),
      }).finally(() => clearTimeout(timeout));
      if (!response.ok) {
        const details = await response.text().catch(() => '');
        throw new Error(`OmniVoice TTS failed with HTTP ${response.status}${details ? `: ${details.slice(0, 300)}` : ''}`);
      }
      const audio = Buffer.from(await response.arrayBuffer());
      const wordCount = input.text.split(/\s+/).filter(Boolean).length;
      return {
        audioBase64: audio.toString('base64'),
        mediaType: response.headers.get('content-type') || 'audio/mpeg',
        durationMs: Math.max(1800, Math.round((wordCount / 3.2 / input.speed) * 1000)),
      };
    }

    throw new Error(`Unsupported TTS provider: ${input.provider}`);
  }

  // ─────────────────────────────────────────────────────────
  // HTTP Request Handling (REST API + Static Dashboard)
  // ─────────────────────────────────────────────────────────

  private _handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/';
    const method = req.method || 'GET';
    const requestUrl = new URL(url, `http://${this._config.host}:${this._config.port}`);
    const pathname = requestUrl.pathname;

    (req as http.IncomingMessage & { __runtimeResponse?: http.ServerResponse }).__runtimeResponse = res;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (!this._applyCors(req, res)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Origin is not allowed' }));
      return;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const oauthCallbackPath = /^\/api\/platform-chat\/(youtube|facebook)\/oauth\/callback$/.test(pathname)
      || pathname === '/api/platform-chat/facebook/oauth/token';
    const publicPath = pathname === '/health' || pathname === '/api/status' || oauthCallbackPath;
    if (pathname.startsWith('/api/') && !publicPath && !this._isAuthorized(req)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="idol-runtime"',
      });
      res.end(JSON.stringify({ success: false, error: 'Authentication required' }));
      return;
    }
    if (pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }

    if (pathname === '/api/platform-chat/youtube/oauth/callback' && method === 'GET') {
      this._platformChat.completeYouTubeLogin(requestUrl.searchParams).then(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(oauthResultPage('YouTube', true, 'You can close this window and return to AI IDOL.'));
      }).catch((error) => {
        this._platformChat.reportLoginError('youtube', error);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(oauthResultPage('YouTube', false, error instanceof Error ? error.message : String(error)));
      });
      return;
    }

    if (pathname === '/api/platform-chat/facebook/oauth/callback' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this._platformChat.facebookCallbackPage());
      return;
    }

    if (pathname === '/api/platform-chat/facebook/oauth/token' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(FacebookOAuthTokenSchema, body, res);
        if (!input) return;
        try {
          await this._platformChat.completeFacebookLogin(input);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          this._platformChat.reportLoginError('facebook', error);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }

    if (pathname === '/api/platform-chat/status' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, platformChat: this._platformChat.publicState(), platformReply: this._settings.platformReply }));
      return;
    }

    if (pathname === '/api/platform-chat/reply-settings' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(PlatformReplySettingsSchema, body, res);
        if (!input) return;
        this._settings.platformReply = input;
        this._db.setSetting('platformReply', input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, platformReply: input }));
      });
      return;
    }

    if (pathname === '/api/ai/director/show-schedule' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, showSchedule: this._settings.showSchedule }));
      return;
    }

    if (pathname === '/api/ai/director/show-schedule' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(ShowScheduleSchema, body, res);
        if (!input) return;
        this._settings.showSchedule = { cues: [...input.cues].sort((a, b) => a.minute - b.minute) };
        this._executedShowCueIds.clear();
        this._db.setSetting('showSchedule', this._settings.showSchedule);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, showSchedule: this._settings.showSchedule }));
      });
      return;
    }

    const platformChatConnectMatch = pathname.match(/^\/api\/platform-chat\/(youtube|facebook)\/connect$/);
    if (platformChatConnectMatch && method === 'POST') {
      const platform = platformChatConnectMatch[1] as PlatformChatId;
      const source = this._platformChat.publicState().sources[platform];
      if (source.authenticated) {
        try {
          this._platformChat.resume(platform);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, platformChat: this._platformChat.publicState() }));
        } catch (error) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }
      this._platformChat.beginLogin(platform).then((login) => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, authUrl: login.authUrl, platformChat: this._platformChat.publicState() }));
      }).catch((error) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
      });
      return;
    }

    const platformChatDisconnectMatch = pathname.match(/^\/api\/platform-chat\/(youtube|facebook)$/);
    if (platformChatDisconnectMatch && method === 'DELETE') {
      const platform = platformChatDisconnectMatch[1] as PlatformChatId;
      this._platformChat.disconnect(platform);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, platformChat: this._platformChat.publicState() }));
      return;
    }

    // ── Local Project Storage ──
    if (pathname === '/api/storage/select-folder' && method === 'POST') {
      if (process.platform !== 'darwin') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Native folder selection is currently available on macOS. Enter the path manually on this system.' }));
        return;
      }
      execFile('/usr/bin/osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "Select project storage folder")',
      ], { timeout: 120_000 }, (error, stdout) => {
        if (error) {
          const cancelled = String((error as any).stderr || error.message || '').includes('-128');
          res.writeHead(cancelled ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cancelled
            ? { success: false, cancelled: true }
            : { success: false, error: 'Could not open the folder picker' }));
          return;
        }
        const rootPath = String(stdout || '').trim().replace(/\/$/, '');
        if (!rootPath || rootPath === path.parse(rootPath).root) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Choose a dedicated folder, not the filesystem root' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, rootPath }));
      });
      return;
    }

    if (pathname === '/api/storage/config' && method === 'GET') {
      this._ensureProjectStorage();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        rootPath: this._projectStorageRoot,
        projectName: this._activeProject,
        projectPath: this._projectDir(),
        folders: ['uploads', 'avatars/source', 'avatars/training', 'models', 'outputs', 'metadata', 'skills'],
      }));
      return;
    }

    if (pathname === '/api/storage/config' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        try {
          const input = this._parseBody(StorageConfigSchema, body, res);
          if (!input) return;
          const requestedRoot = input.rootPath;
          const resolvedRoot = path.resolve(requestedRoot);
          if (resolvedRoot === path.parse(resolvedRoot).root) throw new Error('Choose a dedicated folder, not the filesystem root');
          this._projectStorageRoot = resolvedRoot;
          this._activeProject = input.projectName;
          this._ensureProjectStorage();
          this._saveProjectStorageConfig();
          this._applyActiveReplySkill();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, rootPath: this._projectStorageRoot, projectName: this._activeProject, projectPath: this._projectDir() }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (pathname === '/api/storage/uploads' && method === 'GET') {
      this._ensureProjectStorage();
      const uploadsDir = path.join(this._projectDir(), 'uploads');
      const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm']);
      const files = fs.readdirSync(uploadsDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && videoExtensions.has(path.extname(entry.name).toLowerCase()))
        .map(entry => {
          const stat = fs.statSync(path.join(uploadsDir, entry.name));
          return {
            filename: entry.name,
            size: stat.size,
            updatedAt: stat.mtimeMs,
            url: `/api/storage/uploads/${encodeURIComponent(entry.name)}`,
          };
        })
        .filter(file => file.size >= 1024)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, files }));
      return;
    }

    const storedUploadMatch = pathname.match(/^\/api\/storage\/uploads\/([^/]+)$/);
    if (storedUploadMatch && method === 'GET') {
      this._ensureProjectStorage();
      const requestedName = decodeURIComponent(storedUploadMatch[1]!);
      const filename = this._safeName(requestedName, '');
      const uploadsDir = path.resolve(this._projectDir(), 'uploads');
      const targetPath = path.resolve(uploadsDir, filename);
      if (!filename || requestedName !== filename || !targetPath.startsWith(uploadsDir + path.sep) || !fs.existsSync(targetPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Stored video was not found' }));
        return;
      }
      const stat = fs.statSync(targetPath);
      const extension = path.extname(filename).toLowerCase();
      const contentTypes: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.m4v': 'video/x-m4v',
        '.webm': 'video/webm',
      };
      const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': contentTypes[extension] || 'application/octet-stream',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(targetPath, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentTypes[extension] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Length': stat.size,
      });
      fs.createReadStream(targetPath).pipe(res);
      return;
    }

    if (pathname === '/api/storage/file' && method === 'POST') {
      this._ensureProjectStorage();
      const declaredSize = Number(req.headers['content-length'] || 0);
      if (declaredSize > this._config.maxUploadBytes) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Upload exceeds the configured size limit' }));
        return;
      }
      const allowed = new Set(['uploads', 'avatars/source', 'avatars/training', 'models', 'outputs', 'metadata']);
      const category = String(requestUrl.searchParams.get('category') || 'uploads').replace(/\\/g, '/');
      if (!allowed.has(category)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid storage category' }));
        return;
      }
      const filename = this._safeName(requestUrl.searchParams.get('filename'), `file_${Date.now()}.bin`);
      const avatarId = this._safeName(requestUrl.searchParams.get('avatarId'), '');
      const targetDir = avatarId && (category === 'models' || category === 'avatars/source' || category === 'avatars/training')
        ? path.join(this._projectDir(), category, avatarId)
        : path.join(this._projectDir(), category);
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.resolve(targetDir, filename);
      if (!targetPath.startsWith(path.resolve(targetDir) + path.sep)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid upload filename' }));
        return;
      }
      const tempPath = path.join(
        targetDir,
        `.${filename}.upload-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
      );
      const stream = fs.createWriteStream(tempPath, { flags: 'wx' });
      let receivedSize = 0;
      let rejected = false;
      const removeTemp = () => fs.unlink(tempPath, () => {});
      req.on('data', (chunk: Buffer) => {
        receivedSize += chunk.length;
        if (!rejected && receivedSize > this._config.maxUploadBytes) {
          rejected = true;
          req.unpipe(stream);
          stream.destroy();
          removeTemp();
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Upload exceeds the configured size limit' }));
          req.resume();
        }
      });
      req.on('aborted', () => {
        rejected = true;
        stream.destroy();
        removeTemp();
      });
      req.pipe(stream);
      stream.on('finish', () => {
        if (rejected) return;
        try {
          fs.renameSync(tempPath, targetPath);
          const stat = fs.statSync(targetPath);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, filename, category, size: stat.size, path: targetPath }));
        } catch (err: any) {
          removeTemp();
          if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }
      });
      stream.on('error', (err) => {
        if (rejected || res.writableEnded) return;
        removeTemp();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
      return;
    }

    if (pathname === '/api/storage/json' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        try {
          const input = this._parseBody(StorageJsonSchema, body, res);
          if (!input) return;
          const category = input.category;
          const avatarId = input.avatarId || '';
          const targetDir = avatarId ? path.join(this._projectDir(), category, avatarId) : path.join(this._projectDir(), category);
          fs.mkdirSync(targetDir, { recursive: true });
          const filename = this._safeName(input.filename, `data_${Date.now()}.json`).replace(/\.json$/i, '') + '.json';
          const targetPath = path.join(targetDir, filename);
          fs.writeFileSync(targetPath, JSON.stringify(input.data, null, 2));
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, path: targetPath }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (pathname === '/api/avatars/library' && method === 'GET') {
      const localAvatars = this._readAvatarManifest();
      const projectAvatars = this._readProjectAvatarArtifacts();
      const respondWithLibrary = (workerAvatars: any[], workerAvailable: boolean) => {
        const merged = new Map<string, any>();
        const workerIds = new Set<string>();
        for (const avatar of workerAvatars) {
          const id = String(avatar.id || avatar.avatar_id || '');
          if (!id) continue;
          workerIds.add(id);
          merged.set(id, {
              id,
              avatarId: id,
              status: 'ready',
              modelType: avatar.model_type || 'musetalk',
              name: avatar.source_name || id,
              thumbnailUrl: avatar.thumbnail_url
                ? `/api/avatars/library/${encodeURIComponent(id)}/thumbnail`
                : undefined,
              frameCount: Number(avatar.frame_count || 0),
              sourceFps: Number(avatar.source_fps || 25),
              durationMs: Number(avatar.duration_ms || 0),
              source: 'worker',
            });
        }
        for (const avatar of localAvatars) {
          const id = String(avatar.id || avatar.avatarId || '');
          if (!id) continue;
          if (!workerIds.has(id) && !this._projectAvatarArtifactExists(id)) {
            this._db.deleteAvatar(id);
            this._removeAvatarManifestRecord(id);
            continue;
          }
          merged.set(id, { ...merged.get(id), ...avatar, id, avatarId: id });
        }
        for (const avatar of projectAvatars) {
          const id = String(avatar.id || avatar.avatarId || '');
          if (id && !merged.has(id)) merged.set(id, avatar);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, avatars: this._normalizeAvatarRecords([...merged.values()]), workerAvailable }));
      };
      this._liveTalkingProvider.listTrainedAvatars()
        .then((workerAvatars) => respondWithLibrary(workerAvatars, true))
        .catch(() => respondWithLibrary([], false));
      return;
    }

    const avatarThumbnailMatch = pathname.match(/^\/api\/avatars\/library\/([a-zA-Z0-9_-]{1,80})\/thumbnail$/);
    if (avatarThumbnailMatch && method === 'GET') {
      const avatarId = avatarThumbnailMatch[1]!;
      this._liveTalkingProvider.getAvatarThumbnail(avatarId).then((thumbnail) => {
        res.writeHead(200, {
          'Content-Type': thumbnail.contentType,
          'Content-Length': thumbnail.bytes.byteLength,
          'Cache-Control': 'private, max-age=60',
        });
        res.end(thumbnail.bytes);
      }).catch((error: any) => {
        const message = String(error?.message || error);
        const status = /404/.test(message) ? 404 : 503;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: message }));
      });
      return;
    }

    if (pathname === '/api/avatars/library' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const avatar = this._parseBody(AvatarRecordSchema, body.avatar || body, res);
        if (!avatar) return;
        const id = avatar.id || avatar.avatarId!;
        const avatars = this._readAvatarManifest();
        const record = { ...avatar, id, avatarId: id, updatedAt: new Date().toISOString() };
        const index = avatars.findIndex(item => item.id === id || item.avatarId === id);
        if (index >= 0) avatars[index] = { ...avatars[index], ...record };
        else avatars.push(record);
        this._writeAvatarManifest(avatars);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, avatar: record, avatars }));
      });
      return;
    }

    const avatarLibraryMatch = pathname.match(/^\/api\/avatars\/library\/([a-zA-Z0-9_-]{1,80})$/);
    if (avatarLibraryMatch && method === 'DELETE') {
      const avatarId = avatarLibraryMatch[1]!;
      const completeDeletion = (workerArtifactFound: boolean, workerError = '') => {
        const cleaned = this._cleanupAvatarArtifacts(avatarId);
        this._removeAvatarManifestRecord(avatarId);
        this._db.deleteAvatar(avatarId);
        const session = this._db.getAvatarSession();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          avatarId,
          deleted: true,
          session,
          workerArtifactFound: workerArtifactFound || cleaned.workerArtifactFound,
          projectArtifactFound: cleaned.projectArtifactFound,
          ...(workerError ? { workerCleanupError: workerError } : {}),
        }));
      };
      void (async () => {
        const session = this._db.getAvatarSession();
        const selectedAvatarIds = (session?.selectedAvatarIds || []).filter((id) => id !== avatarId);
        const isCurrentLiveAvatar = Boolean(
          this._liveTalkingProvider.sessionId
          && (session?.activeAvatarId === avatarId || this._liveTalkingMediaOwner?.avatarId === avatarId),
        );
        if (isCurrentLiveAvatar) {
          await this._waitForAvatarMutationBoundary();
          const replacementId = selectedAvatarIds[0];
          if (!replacementId) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Select another Avatar before deleting the active Avatar' }));
            return;
          }
          const replacement = this._normalizeAvatarRecords([
            ...this._readProjectAvatarArtifacts(),
            ...this._db.listAvatars(),
          ]).find((record) => String(record.id || record.avatarId) === replacementId);
          const replacementState = AvatarStateSchema.parse(replacement?.avatarState || 'normal');
          await this._switchLiveAvatarState(replacementId, replacementState, 'delete-replacement');
        }
        try {
          await this._liveTalkingProvider.deleteTrainedAvatar(avatarId);
          completeDeletion(true);
        } catch (err: any) {
          const message = String(err?.message || err);
          if (/in use|still active|training is still active/i.test(message)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: message }));
            return;
          }
          // Deletion is idempotent. If the worker is offline or the artifact is
          // already missing there, clean every runtime-owned local copy now.
          completeDeletion(false, message);
        }
      })().catch((error: any) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: String(error?.message || error) }));
      });
      return;
    }

    if (pathname === '/api/avatars/session/activate' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(AvatarActivateSchema, body, res);
        if (!input) return;
        const session = this._db.getAvatarSession();
        if (!session?.selectedAvatarIds.includes(input.avatarId)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Activate this Avatar in the Pool before switching to it' }));
          return;
        }
        try {
          await this._waitForAvatarMutationBoundary();
          const record = this._normalizeAvatarRecords([
            ...this._readProjectAvatarArtifacts(),
            ...this._db.listAvatars(),
          ]).find((avatar) => String(avatar.id || avatar.avatarId) === input.avatarId);
          const state = AvatarStateSchema.parse(record?.avatarState || 'normal');
          if (this._liveTalkingProvider.sessionId) {
            await this._switchLiveAvatarState(input.avatarId, state, 'manual');
          } else {
            this._db.setAvatarSession(input.avatarId, session.selectedAvatarIds, session.excludedAvatarIds);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, avatarId: input.avatarId, state, session: this._db.getAvatarSession() }));
        } catch (error: any) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: String(error?.message || error) }));
        }
      });
      return;
    }

    if (pathname === '/api/avatars/session' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(AvatarSessionSchema, body, res);
        if (!input) return;
        const selectedAvatarIds = [...new Set(
          (input.selectedAvatarIds || (input.activeAvatarId ? [input.activeAvatarId] : []))
            .filter((id) => !input.excludedAvatarIds.includes(id)),
        )];
        const activeAvatarId = input.activeAvatarId || selectedAvatarIds[0] || null;
        const session = {
          activeAvatarId,
          selectedAvatarIds,
          excludedAvatarIds: input.excludedAvatarIds.filter((id) => !selectedAvatarIds.includes(id)),
          updatedAt: new Date().toISOString(),
        };
        this._db.setAvatarSession(session.activeAvatarId, session.selectedAvatarIds, session.excludedAvatarIds);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, session }));
      });
      return;
    }

    if (pathname === '/api/avatars/session' && method === 'GET') {
      const session = this._db.getAvatarSession();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        session,
      }));
      return;
    }

    // ── REST API Endpoints ──
    if (url === '/api/status' || url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'ai-idol-runtime',
        runtimeBuildId: process.env['AI_IDOL_RUNTIME_BUILD_ID'] || 'development',
        status: 'healthy',
        state: this._director.state,
        queueSize: this._director.queue.size,
        connectedClients: this._connectedClients.size,
        uptime: process.uptime(),
        timestamp: Date.now(),
      }));
      return;
    }

    if (pathname === '/api/ai/director/status' && method === 'GET') {
      const persona = this._settings.persona;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        provider: persona.llmProvider,
        model: persona.llmModel,
        apiKeyConfigured: Boolean(persona.llmApiKey),
        fallbackProvider: 'ttm-chatgpt',
        fallbackModel: process.env['TTM_MODEL'] || 'chat-latest',
        fallbackBaseUrl: this._ttmApiBaseUrl(),
      }));
      return;
    }

    if (pathname === '/api/ai/director/models' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(TtmModelsSchema, body, res);
        if (!input) return;
        const apiKey = input.apiKey || this._settings.persona.llmApiKey;
        try {
          const models = await this._fetchTtmModels(apiKey);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, models, apiKeyConfigured: Boolean(apiKey) }));
        } catch (error) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }

    if (pathname === '/api/engines' && method === 'GET') {
      this._engineStatus().then((payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...payload }));
      }).catch((error) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
      });
      return;
    }

    const engineActionMatch = pathname.match(/^\/api\/engines\/([a-z0-9-]+)\/action$/);
    if (engineActionMatch && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(EngineActionSchema, body, res);
        if (!input) return;
        try {
          await this._runEngineAction(engineActionMatch[1]!, input.action);
          const payload = await this._engineStatus();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ...payload }));
        } catch (error) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }

    if (pathname === '/api/ai/director/config' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(AiDirectorConfigSchema, body, res);
        if (!input) return;
        const nextApiKey = input.clearApiKey ? '' : (input.apiKey || this._settings.persona.llmApiKey);
        if (input.provider === 'ttm-chatgpt' && !nextApiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'TTM API key is required for ChatGPT' }));
          return;
        }
        this._settings.persona = {
          ...this._settings.persona,
          llmProvider: 'ollama',
          llmModel: 'qwen3:8b',
          llmApiKey: nextApiKey,
        };
        this._db.setSetting('persona', this._settings.persona);
        this._configureDialogueProvider();
        this._addLog('info', `AI Director updated: qwen3:8b primary${nextApiKey ? ', ChatGPT fallback ready' : ''}`);
        this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._publicSettings().persona }));
      });
      return;
    }

    if (pathname === '/api/ai/local/status' && method === 'GET') {
      const model = this._settings.persona.llmModel;
      const endpoint = (process.env['OLLAMA_ENDPOINT'] || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      fetch(`${endpoint}/api/tags`, { signal: controller.signal }).then(async response => {
        const payload = response.ok ? await response.json() as any : { models: [] };
        const installed = Array.isArray(payload.models) && payload.models.some((item: any) => item.name === model || item.model === model);
        if (installed && this._localModelInstall.state !== 'INSTALLING') this._localModelInstall = { state: 'READY', progress: 'Installed', error: '' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, provider: 'ollama', model, installed, reachable: response.ok, install: this._localModelInstall }));
      }).catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, provider: 'ollama', model, installed: false, reachable: false, install: this._localModelInstall }));
      }).finally(() => clearTimeout(timeout));
      return;
    }

    if (pathname === '/api/ai/local/install' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(LocalAiInstallSchema, body, res);
        if (!input) return;
        if (this._localModelInstall.state === 'INSTALLING') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Model installation is already running' }));
          return;
        }
        const model = input.model || this._settings.persona.llmModel;
        this._settings.persona.llmModel = model;
        this._localModelInstall = { state: 'INSTALLING', progress: `Pulling ${model}`, error: '' };
        const child = spawn(process.env['OLLAMA_BIN'] || 'ollama', ['pull', model], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        this._localModelProcess = child;
        let output = '';
        let installSettled = false;
        const captureProgress = (chunk: Buffer): void => {
          output = `${output}${chunk.toString('utf8')}`.slice(-4000);
          const latest = output.split(/[\r\n]+/).filter(Boolean).at(-1);
          if (latest) this._localModelInstall.progress = latest.slice(0, 500);
        };
        child.stdout?.on('data', captureProgress);
        child.stderr?.on('data', captureProgress);
        child.once('error', (error) => {
          installSettled = true;
          this._localModelProcess = null;
          this._localModelInstall = {
            state: 'ERROR',
            progress: '',
            error: error.message.includes('ENOENT')
              ? 'Ollama is not installed or OLLAMA_BIN is invalid'
              : error.message.slice(0, 1000),
          };
        });
        child.once('close', (code) => {
          if (installSettled) return;
          installSettled = true;
          this._localModelProcess = null;
          if (code !== 0) {
            this._localModelInstall = { state: 'ERROR', progress: '', error: (output || `ollama pull exited with code ${code}`).slice(-1000) };
            return;
          }
          this._localModelInstall = { state: 'READY', progress: 'Model installed', error: '' };
          this._settings.persona.llmProvider = 'ollama';
          this._configureDialogueProvider();
          this._db.setSetting('persona', this._settings.persona);
          this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
        });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, model, install: this._localModelInstall }));
      });
      return;
    }

    if (url === '/api/library' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._assetRegistry.getAll()));
      return;
    }

    if (url === '/api/goals' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._goalEngine.getAllGoals()));
      return;
    }

    if (url === '/api/game/event' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const event = this._parseBody(GameEventSchema, body, res);
        if (!event) return;
        this._director.injectGameEvent(event);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Game event accepted' }));
      });
      return;
    }

    if (url === '/api/game/webhook' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const event = this._gameAdapter.ingestRaw(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, event }));
      });
      return;
    }

    if (url === '/api/game/spin' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(GameSpinSchema, body, res);
        if (!input) return;
        const event = this._gameAdapter.spinSimulator(input.bet, input.forcedOutcome);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, event, stats: this._gameAdapter.stats }));
      });
      return;
    }

    if (url === '/api/game/stats' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._gameAdapter.stats));
      return;
    }

    if (url === '/api/chat/send' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(RawChatSchema, body, res);
        if (!input) return;
        const msg = this._chatManager.ingest(this._withoutUndefined({
          ...input,
          liveSessionId: input.liveSessionId || this._mockChat.liveSessionId,
        }) as Parameters<ChatManager['ingest']>[0]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: !!msg, message: msg }));
      });
      return;
    }

    if (url === '/api/chat/session' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        mode: 'mock',
        platform: 'mock',
        liveSessionId: this._mockChat.liveSessionId,
      }));
      return;
    }

    if (url === '/api/chat/gift' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const gift = this._parseBody(RawGiftSchema, body, res);
        if (!gift) return;
        this._chatManager.ingestGift(gift);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }

    if (pathname === '/api/talking-head/media/status' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, media: this._publicLiveTalkingMediaState() }));
      return;
    }

    if (pathname === '/api/talking-head/offer' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const offer = this._parseBody(WebRtcOfferSchema, body, res);
        if (!offer) return;
        try {
          const mediaOwner = this._liveTalkingMediaOwner;
          if (process.env['NODE_ENV'] !== 'test' && !offer.clientId) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Live Monitor client ownership is required' }));
            return;
          }
          if (offer.clientId && (!mediaOwner || mediaOwner.clientId !== offer.clientId)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: mediaOwner
                ? 'Live Monitor is already active in another tab'
                : 'This tab does not own the Live Monitor session',
              ownerClientId: mediaOwner?.clientId || null,
            }));
            return;
          }
          const requestedAvatarId = offer.avatarId || offer.avatar;
          const currentAvatarId = this._db.getAvatarSession()?.activeAvatarId || null;
          const avatarId = requestedAvatarId || currentAvatarId || undefined;
          const answer = await this._liveTalkingProvider.createOffer(offer.sdp, offer.type, avatarId);
          if (mediaOwner && offer.clientId === mediaOwner.clientId) {
            mediaOwner.sessionId = answer.sessionid;
            mediaOwner.avatarId = avatarId || '';
            mediaOwner.connectionState = 'CONNECTING';
            mediaOwner.audioTrack = false;
            mediaOwner.videoTrack = false;
            mediaOwner.audioPlayable = false;
            mediaOwner.audioPackets = 0;
            mediaOwner.videoFrames = 0;
            mediaOwner.lastAudioProgressAt = Date.now();
            mediaOwner.lastVideoProgressAt = Date.now();
            mediaOwner.lastHeartbeatAt = Date.now();
            this._broadcastLiveTalkingMediaState();
          }
          if (requestedAvatarId && requestedAvatarId !== currentAvatarId) {
            const session = this._db.getAvatarSession();
            const selectedAvatarIds = session?.selectedAvatarIds?.length
              ? session.selectedAvatarIds
              : [requestedAvatarId];
            this._db.setAvatarSession(requestedAvatarId, selectedAvatarIds, session?.excludedAvatarIds || []);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, avatarId, ...answer }));
        } catch (err: any) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    const talkingSessionMatch = pathname.match(/^\/api\/talking-head\/session\/([a-zA-Z0-9_-]{1,120})$/);
    if (talkingSessionMatch && method === 'DELETE') {
      const sessionId = talkingSessionMatch[1]!;
      this._liveTalkingProvider.closeSession(sessionId).then((closed) => {
        const owner = this._liveTalkingMediaOwner;
        if (owner?.sessionId === sessionId) {
          owner.sessionId = null;
          owner.connectionState = 'DISCONNECTED';
          owner.audioTrack = false;
          owner.videoTrack = false;
          owner.audioPlayable = false;
          owner.audioPackets = 0;
          owner.videoFrames = 0;
          owner.lastAudioProgressAt = Date.now();
          owner.lastVideoProgressAt = Date.now();
          owner.lastHeartbeatAt = Date.now();
          this._broadcastLiveTalkingMediaState();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, sessionId, closed }));
      }).catch((err: any) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
      return;
    }

    if (pathname === '/api/talking-head/is-speaking' && method === 'GET') {
      this._liveTalkingProvider.isSessionSpeaking().then((speaking) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, speaking, sessionId: this._liveTalkingProvider.sessionId }));
      }).catch((err: any) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
      return;
    }

    if (pathname === '/api/speech/commands' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(SpeechCommandSchema, body, res);
        if (!input) return;
        const command = { ...input, commandId: input.commandId || `speech_${crypto.randomBytes(8).toString('hex')}` };
        this._enqueueSpeechCommand(command, 'operator', 'operator');
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, commandId: command.commandId, state: 'QUEUED' }));
      });
      return;
    }

    if (pathname === '/api/speech/status' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, speech: this._speechRuntime }));
      return;
    }

    const speechPlaybackReadyMatch = pathname.match(/^\/api\/speech\/([a-zA-Z0-9_-]{1,120})\/playback-ready$/);
    if (speechPlaybackReadyMatch && method === 'POST') {
      const commandId = speechPlaybackReadyMatch[1]!;
      const released = this._releaseSpeechPlaybackBoundary(commandId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, commandId, released }));
      return;
    }

    if (pathname === '/api/speech/interrupt' && method === 'POST') {
      this._interruptSpeech().then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, speech: this._speechRuntime }));
      });
      return;
    }

    if (url === '/api/speech/synthesize' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(SpeechSynthesisSchema, body, res);
        if (!input) return;
        try {
          const audio = await this._synthesizeProviderAudio(input);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            commandId: input.commandId,
            provider: input.provider,
            ...audio,
          }));
        } catch (err: any) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (url === '/api/talking-head/speak' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const command = this._parseBody(SpeechCommandSchema, body, res);
        if (!command) return;
        const normalized = { ...command, commandId: command.commandId || `speech_${crypto.randomBytes(8).toString('hex')}` };
        this._directorGenerationRun += 1;
        this._enqueueSpeechCommand(normalized, 'operator', 'operator');
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, commandId: normalized.commandId, state: 'QUEUED' }));
      });
      return;
    }

    if (url === '/api/talking-head/status' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      this._talkingPipeline.getHealth().then((health) => {
        res.end(JSON.stringify({
          status: 'ready',
          health,
          engine: 'lipku/livetalking (Realtime Digital Human)',
        }));
      });
      return;
    }

    if (url === '/api/talking-head/livetalking/status' && method === 'GET') {
      this._liveTalkingProvider.health().then((health: any) => {
        const { authToken: _workerToken, ...config } = this._liveTalkingProvider.config;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          provider: 'lipku/livetalking',
          framework: 'LiveTalking Realtime Digital Human Pipeline',
          health,
          config,
        }));
      });
      return;
    }

    if (pathname === '/api/talking-head/livetalking/worker' && method === 'GET') {
      this._liveTalkingWorkerStatus().then((worker) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, worker }));
      });
      return;
    }

    if (pathname === '/api/talking-head/livetalking/worker/start' && method === 'POST') {
      this._startLiveTalkingWorker().then((worker) => {
        this._broadcast({ type: 'LIVETALKING_WORKER_STATE', worker, timestamp: Date.now() });
        res.writeHead(worker['ready'] ? 200 : 202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, worker }));
      }).catch((error: any) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      });
      return;
    }

    if (pathname === '/api/talking-head/livetalking/worker/stop' && method === 'POST') {
      this._stopLiveTalkingWorker(true).then((worker) => {
        this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
        this._broadcast({ type: 'LIVETALKING_WORKER_STATE', worker, timestamp: Date.now() });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, worker }));
      }).catch((error: any) => {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      });
      return;
    }

    // ── LiveTalking Avatar Creator Endpoints (lipku/livetalking) ──
    if (url === '/api/avatar/task' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        try {
          const input = this._parseBody(AvatarTrainSchema, body, res);
          if (!input) return;
          const videoPath = this._resolveProjectPath(input.video_path || input.videoPath || input.avatarPath);
          const avatarId = input.avatar_id || `avatar_${Date.now().toString(36)}`;
          const taskId = await this._liveTalkingProvider.createAvatarTask(
            videoPath,
            avatarId,
            path.join(this._projectDir(), 'models'),
            input.model,
          );
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              task_id: taskId,
              model_type: input.model,
              avatar_id: avatarId,
              status: 'pending',
              progress: 0,
            }
          }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 1, msg: err.message }));
        }
      });
      return;
    }

    if (url === '/api/avatar/batch' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        try {
          const input = this._parseBody(AvatarBatchSchema, body, res);
          if (!input) return;
          const worker = await this._liveTalkingWorkerStatus();
          if (!worker['ready']) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Start the LiveTalking worker before batch training' }));
            return;
          }
          const items = input.items.map((item) => ({
            ...item,
            videoPath: this._resolveProjectPath(item.video_path || item.videoPath),
          }));
          const batchId = `batch_${crypto.randomBytes(8).toString('hex')}`;
          const settled = await Promise.allSettled(items.map(async (item) => {
            const taskId = await this._liveTalkingProvider.createAvatarTask(
              item.videoPath,
              item.avatar_id,
              path.join(this._projectDir(), 'models'),
              item.model,
            );
            return {
              task_id: taskId,
              model_type: item.model,
              avatar_id: item.avatar_id,
              status: 'pending',
              progress: 0,
            };
          }));
          const tasks = settled.map((result, index) => result.status === 'fulfilled'
            ? result.value
            : {
                task_id: null,
                model_type: items[index]!.model,
                avatar_id: items[index]!.avatar_id,
                status: 'failed',
                progress: 0,
                error_msg: result.reason instanceof Error ? result.reason.message : String(result.reason),
              });
          const submitted = tasks.filter((task) => task.task_id).length;
          res.writeHead(submitted ? 202 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: submitted ? 0 : 1,
            msg: submitted ? 'ok' : 'No training task could be submitted',
            data: { batch_id: batchId, submitted, total: tasks.length, tasks },
          }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 1, msg: err.message }));
        }
      });
      return;
    }

    if (url === '/api/avatar/tasks' && method === 'GET') {
      this._liveTalkingProvider.listAvatarTasks().then((tasks) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, msg: 'ok', data: { tasks } }));
      }).catch((err: any) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 1, msg: err.message }));
      });
      return;
    }

    const avatarTaskMatch = pathname.match(/^\/api\/avatar\/task\/([a-zA-Z0-9_-]{1,120})$/);
    if (avatarTaskMatch && method === 'GET') {
      this._liveTalkingProvider.getAvatarTask(avatarTaskMatch[1]!).then((task) => {
        if (task?.status === 'completed' && task.avatar_id) {
          const avatars = this._readAvatarManifest();
          const record = {
            id: task.avatar_id,
            avatarId: task.avatar_id,
            modelType: task.model_type,
            taskId: task.task_id,
            status: 'ready',
            trainedAt: Date.now(),
            updatedAt: new Date().toISOString(),
          };
          const index = avatars.findIndex((item) => item.id === task.avatar_id || item.avatarId === task.avatar_id);
          if (index >= 0) avatars[index] = { ...avatars[index], ...record };
          else avatars.push(record);
          this._writeAvatarManifest(avatars);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, msg: 'ok', data: task }));
      }).catch((err: any) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 1, msg: err.message }));
      });
      return;
    }

    if (avatarTaskMatch && method === 'DELETE') {
      this._liveTalkingProvider.deleteAvatarTask(avatarTaskMatch[1]!).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, msg: 'ok' }));
      }).catch((err: any) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 1, msg: err.message }));
      });
      return;
    }

    if ((url === '/api/talking-head/livetalking/train' || url === '/api/talking-head/livetalking/preprocess') && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        try {
          const input = this._parseBody(AvatarTrainSchema, body, res);
          if (!input) return;
          const videoPath = this._resolveProjectPath(input.avatarPath || input.videoPath || input.video_path);
          const result = await this._liveTalkingProvider.trainAvatarVideo(videoPath, undefined, {
            savePath: path.join(this._projectDir(), 'models'),
            ...(input.avatar_id ? { avatarId: input.avatar_id } : {}),
            model: input.model,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (url === '/api/talking-head/livetalking/speak' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const command = this._parseBody(SpeechCommandSchema, body, res);
        if (!command) return;
        if (!this._liveTalkingProvider.sessionId) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Connect a LiveTalking avatar before speaking' }));
          return;
        }
        const normalized = { ...command, commandId: command.commandId || `speech_${crypto.randomBytes(8).toString('hex')}` };
        this._enqueueSpeechCommand(normalized, 'operator', 'operator');
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, commandId: normalized.commandId, state: 'QUEUED', engine: 'livetalking' }));
      });
      return;
    }

    if (url === '/api/talking-head/livetalking/interrupt' && method === 'POST') {
      this._interruptSpeech().then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Interrupted LiveTalking Engine' }));
      });
      return;
    }

    if (url === '/api/talking-head/livetalking/config' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(TalkingSettingsSchema.pick({ model: true }), body, res);
        if (!input) return;
        if (input.model) this._liveTalkingProvider.setModel(input.model);
        const { authToken: _workerToken, ...config } = this._liveTalkingProvider.config;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config }));
      });
      return;
    }

    if (url === '/api/settings/talking' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(TalkingSettingsSchema, body, res);
        if (!input) return;
        if (input.endpoint) {
          try {
            input.endpoint = this._validateWorkerEndpoint(input.endpoint);
            this._liveTalkingProvider.setEndpoint(input.endpoint);
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
          }
        }
        this._settings.talkingEngine = { ...this._settings.talkingEngine, ...this._withoutUndefined(input) };
        this._db.setSetting('talkingEngine', this._settings.talkingEngine);
        if (input.model) this._liveTalkingProvider.setModel(input.model);
        if (input.alwaysOn === false) this._cancelLiveTalkingAutomation();
        if (input.alwaysOn === true) this._autoStartLiveTalkingWorker();
        if (input.restartIntervalMinutes || input.alwaysOn === true) this._scheduleLiveTalkingMaintenance();
        this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          settings: {
            alwaysOn: this._settings.talkingEngine.alwaysOn,
            restartIntervalMinutes: this._settings.talkingEngine.restartIntervalMinutes,
          },
        }));
      });
      return;
    }

    if (url === '/api/settings/live-video' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(LiveVideoSettingsSchema, body, res);
        if (!input) return;
        try {
          const result = await this._setLiveVideoQuality(input.quality);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            ...result,
            settings: this._publicSettings(),
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this._addLog('warn', `Live video quality change rejected: ${message}`);
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: message,
            quality: this._settings.talkingEngine.videoQuality,
            preset: this._liveVideoPreset(),
          }));
        }
      });
      return;
    }

    // ── Pure Upstream MuseTalk Batch Video Generation APIs ──
    if (url === '/api/musetalk/batch-process' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        try {
          const input = this._parseBody(MuseTalkBatchSchema, body, res);
          if (!input) return;
          const videoPath = this._resolveProjectPath(input.videoPath);
          const audioPath = this._resolveProjectPath(input.audioPath);
          const result = await this._museTalkBatchPipeline.process({
            videoPath,
            audioPath,
            videoFilename: this._safeName(input.videoFilename || path.basename(videoPath), 'avatar.mp4'),
            audioFilename: this._safeName(input.audioFilename || path.basename(audioPath), 'test.wav'),
            bboxShift: input.bboxShift,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (url === '/api/musetalk/sample-process' && method === 'POST') {
      this._readJsonBody(req, async (_body) => {
        try {
          const result = await this._museTalkBatchPipeline.process({
            videoFilename: 'avatar_sample.mp4',
            audioFilename: 'test_sample.wav',
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (url?.startsWith('/api/musetalk/output/') && method === 'GET') {
      const filename = this._safeName(pathname.replace('/api/musetalk/output/', ''), '');
      const outputRoot = path.resolve(this._projectDir(), 'outputs');
      const outputPath = path.resolve(outputRoot, filename);
      if (!filename || !outputPath.startsWith(outputRoot + path.sep) || !fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Generated output was not found' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      fs.createReadStream(outputPath).pipe(res);
      return;
    }

    // ── Voice Profile APIs ──
    if (url === '/api/voice/profiles' && method === 'GET') {
      void Promise.allSettled([
        this._qwenTtsJson('/api/voices'),
        this._omniSpeakJson('/api/voices'),
      ]).then(([qwenResult, omniResult]) => {
        const storedProfiles = this._voiceProfiles()
          .filter((profile) => profile['provider'] === 'qwentts' || profile['provider'] === 'omnivoice');
        const qwenProfiles = qwenResult.status === 'fulfilled' && Array.isArray(qwenResult.value)
          ? qwenResult.value.map((profile: any) => ({
          id: String(profile.id || profile.voice_id),
          voiceId: String(profile.voice_id || profile.id),
          name: String(profile.name || 'Qwen voice'),
          kind: String(profile.kind || 'preset'),
          provider: 'qwentts',
          status: 'ready',
          remote: 'qwen-tts',
          }))
          : [];
        const omniProfiles = omniResult.status === 'fulfilled' && Array.isArray(omniResult.value)
          ? omniResult.value.map((profile: any) => ({
            id: String(profile.id),
            voiceId: String(profile.id),
            name: String(profile.name || 'Omni Voice'),
            kind: String(profile.kind || 'preset'),
            provider: 'omnivoice',
            status: 'ready',
            transcript: profile.transcript || '',
            description: profile.instruct || profile.metadata?.description || '',
            remote: 'omni-speak',
          }))
          : [];
        const merged = [
          ...qwenProfiles,
          ...omniProfiles,
          ...storedProfiles.filter((profile) => ![...qwenProfiles, ...omniProfiles].some((remote: any) => remote.id === profile['id'])),
        ];
        if (!merged.some((profile) => profile.provider === 'qwentts')) {
          merged.unshift({ id: 'qwen-default', voiceId: 'qwen-default', name: 'Yến Nhi', kind: 'preset', provider: 'qwentts', status: 'offline', remote: 'qwen-tts' });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          profiles: merged,
          providers: {
            qwentts: { available: qwenResult.status === 'fulfilled' },
            omnivoice: { available: omniResult.status === 'fulfilled', endpoint: this._omniSpeakEndpoint() },
          },
        }));
      });
      return;
    }

    if (url === '/api/voice/profiles/design' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(VoiceDesignProfileSchema, body, res);
        if (!input) return;
        try {
          const description = [input.gender, input.age, input.pitch, input.accent, input.style].filter(Boolean).join(', ');
          const remote = await this._omniSpeakJson('/api/voices/design', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: input.name,
              description,
              preview_text: input.previewText,
              performance_mode: input.performanceMode,
            }),
          });
          const profile = this._saveVoiceProfile({
            id: String(remote.id || `voice_${Date.now()}`),
            voiceId: String(remote.id || ''),
            name: input.name,
            kind: 'design',
            provider: 'omnivoice',
            status: 'ready',
            attributes: { gender: input.gender, age: input.age, pitch: input.pitch, accent: input.accent, style: input.style },
            previewText: input.previewText,
            remote: 'omni-speak',
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, profile }));
        } catch (err: any) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message || 'OmniVoice Design is unavailable' }));
        }
      });
      return;
    }

    if (url === '/api/voice/profiles/clone' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(VoiceCloneProfileSchema, body, res);
        if (!input) return;
        try {
          const sourcePath = this._resolveProjectPath(input.sourcePath);
          const extension = path.extname(sourcePath).toLowerCase();
          const mediaType = extension === '.wav' ? 'audio/wav' : extension === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
          const form = new FormData();
          form.append('name', input.name);
          form.append('transcript', input.transcript);
          form.append('file', new Blob([fs.readFileSync(sourcePath)], { type: mediaType }), input.filename || path.basename(sourcePath));
          const endpoint = input.provider === 'qwentts' ? this._qwenTtsEndpoint() : this._omniSpeakEndpoint();
          const response = await fetch(`${endpoint}/api/voices/clone`, { method: 'POST', body: form });
          const remote = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(remote.detail || `${input.provider} Clone HTTP ${response.status}`);
          const profile = this._saveVoiceProfile({
            id: String(remote.id || remote.voice_id || `voice_${Date.now()}`),
            voiceId: String(remote.voice_id || remote.id || ''),
            name: input.name,
            kind: 'clone',
            provider: input.provider,
            status: 'ready',
            transcript: remote.ref_text || remote.transcript || input.transcript,
            sourcePath: input.sourcePath,
            remote: input.provider === 'qwentts' ? 'qwen-tts' : 'omni-speak',
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, profile }));
        } catch (err: any) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message || 'Voice Clone is unavailable' }));
        }
      });
      return;
    }

    // ── Settings REST APIs ──
    if (url === '/api/settings/all' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._publicSettings()));
      return;
    }

    if (url === '/api/settings/voice' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(VoiceSettingsSchema, body, res);
        if (!input) return;
        this._updateVoiceSettings(this._withoutUndefined(input));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._publicSettings().voice }));
      });
      return;
    }

    if (url === '/api/settings/avatar' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(AvatarSettingsSchema, body, res);
        if (!input) return;
        const { customImageData, ...settings } = input;
        this._updateAvatarSettings(this._withoutUndefined({ ...settings, customImageUrl: customImageData ?? settings.customImageUrl }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._settings.avatar }));
      });
      return;
    }

    if (url === '/api/settings/persona' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(PersonaSettingsSchema, body, res);
        if (!input) return;
        this._updatePersonaSettings(this._withoutUndefined(input));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._publicSettings().persona }));
      });
      return;
    }

    if (pathname === '/api/settings/persona/brief/google-doc' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(PersonaBriefImportSchema, body, res);
        if (!input) return;
        try {
          const documentUrl = new URL(input.url);
          if (documentUrl.hostname !== 'docs.google.com') throw new Error('Use a Google Docs document URL.');
          const id = documentUrl.pathname.match(/^\/document\/d\/([a-zA-Z0-9_-]+)/)?.[1];
          if (!id) throw new Error('Google Docs URL is invalid.');
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          let response: Response;
          try {
            response = await fetch(`https://docs.google.com/document/d/${id}/export?format=txt`, {
              signal: controller.signal,
              redirect: 'follow',
              headers: { 'User-Agent': 'AI-IDOL-Streamer/1.0' },
            });
          } finally {
            clearTimeout(timeout);
          }
          if (!response.ok) throw new Error(`Google Docs returned HTTP ${response.status}.`);
          const contentType = response.headers.get('content-type') || '';
          const contentLength = Number(response.headers.get('content-length') || 0);
          if (contentLength > 64_000) throw new Error('Document is too large. Keep the brief under 64 KB.');
          const text = (await response.text()).trim();
          if (!text || contentType.includes('text/html') || /<html[\s>]/i.test(text.slice(0, 500))) {
            throw new Error('This Google Doc is private. Share it as “Anyone with the link” and try again.');
          }
          if (Buffer.byteLength(text, 'utf8') > 64_000) throw new Error('Document is too large. Keep the brief under 64 KB.');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, name: `Google Doc ${id.slice(0, 8)}`, markdown: text.slice(0, 32_000), url: input.url }));
        } catch (error) {
          const message = error instanceof Error && error.name === 'AbortError'
            ? 'Google Docs import timed out.'
            : (error instanceof Error ? error.message : String(error));
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: message }));
        }
      });
      return;
    }

    if (url === '/api/settings/live-session' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(LiveSessionSettingsSchema, body, res);
        if (!input) return;
        this._updateLiveSessionSettings(input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._publicSettings().liveSession }));
      });
      return;
    }

    if (pathname === '/api/settings/reply-skills' && method === 'GET') {
      this._ensureProjectStorage();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...this._replySkillLibraryResponse() }));
      return;
    }

    if (pathname === '/api/settings/reply-skills' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(ReplySkillUploadSchema, body, res);
        if (!input) return;
        try {
          const skill = this._uploadReplySkill(input);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, skill, ...this._replySkillLibraryResponse() }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }

    if (pathname === '/api/settings/reply-skills/select' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(ReplySkillSelectSchema, body, res);
        if (!input) return;
        try {
          this._selectReplySkill(input.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ...this._replySkillLibraryResponse() }));
        } catch (error) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }

    const replySkillDeleteMatch = pathname.match(/^\/api\/settings\/reply-skills\/([a-zA-Z0-9_-]+)$/);
    if (replySkillDeleteMatch && method === 'DELETE') {
      try {
        this._deleteReplySkill(replySkillDeleteMatch[1]!);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...this._replySkillLibraryResponse() }));
      } catch (error) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (pathname === '/api/obs/magic-connect' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(ObsSettingsSchema, body, res);
        if (!input) return;
        try {
          await this._updateObsSettings({ ...this._withoutUndefined(input), autoConnect: true });
          await this._waitForReadyLiveTalkingMedia();
          const output = await this._magicConnectObs();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, output, settings: this._publicSettings().obs }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this._addLog('warn', `OBS Magic Connect failed: ${message}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: message,
            hint: 'Open OBS, enable WebSocket Server under Tools, then try Magic Connect again.',
          }));
        }
      });
      return;
    }

    if (pathname === '/api/obs/status' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        connected: this._obsController.isConnected,
        settings: this._publicSettings().obs,
      }));
      return;
    }

    if (pathname === '/api/settings/obs' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const input = this._parseBody(ObsSettingsSchema, body, res);
        if (!input) return;
        await this._updateObsSettings(this._withoutUndefined(input));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._publicSettings().obs, isConnected: this._obsController.isConnected }));
      });
      return;
    }

    if (url === '/api/operator/command' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const command = this._parseBody(OperatorCommandSchema, body, res);
        if (!command) return;
        this._director.injectOperatorCommand(command);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Command executed' }));
      });
      return;
    }

    // ── Static Files (Serve operator-dashboard) ──
    const parsedPath = new URL(url, `http://${this._config.host}:${this._config.port}`).pathname;
    const cleanPath = parsedPath === '/' ? 'index.html' : parsedPath.replace(/^\//, '');

    const candidateDirs = [
      ...(process.env['AI_IDOL_DASHBOARD_DIR'] ? [path.resolve(process.env['AI_IDOL_DASHBOARD_DIR'])] : []),
      path.resolve(process.cwd(), 'operator-dashboard'),
      path.resolve(__dirname, '../../../operator-dashboard'),
      path.resolve(__dirname, '../../operator-dashboard'),
      path.resolve(__dirname, '../../../../operator-dashboard'),
    ];

    let filePath = '';
    for (const dir of candidateDirs) {
      const candidate = path.resolve(dir, cleanPath);
      if (candidate !== dir && !candidate.startsWith(dir + path.sep)) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        filePath = candidate;
        break;
      }
    }

    if (filePath) {
      const ext = path.extname(filePath);
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', requestedUrl: url }));
  }

  private _readJsonBody(req: http.IncomingMessage, callback: (body: any) => void): void {
    let data = '';
    let receivedBytes = 0;
    let rejected = false;
    const res = (req as http.IncomingMessage & { __runtimeResponse?: http.ServerResponse }).__runtimeResponse;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      receivedBytes += chunk.length;
      if (receivedBytes > this._config.maxJsonBodyBytes) {
        rejected = true;
        res?.writeHead(413, { 'Content-Type': 'application/json' });
        res?.end(JSON.stringify({ success: false, error: 'JSON request body is too large' }));
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const json = JSON.parse(data || '{}');
        callback(json);
      } catch {
        res?.writeHead(400, { 'Content-Type': 'application/json' });
        res?.end(JSON.stringify({ success: false, error: 'Malformed JSON request body' }));
      }
    });
  }
}

// ─────────────────────────────────────────────────────────
// CLI Standalone Entrypoint
// ─────────────────────────────────────────────────────────

const isDirectRun = process.argv[1] && (
  process.argv[1].includes('runtime-server') ||
  process.argv[1].endsWith('dist/index.js') ||
  process.argv[1].endsWith('src/index.ts')
);

if (isDirectRun) {
  process.on('uncaughtException', (err) => {
    console.error('[RuntimeServer] Uncaught exception:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[RuntimeServer] Unhandled rejection:', reason);
  });

  const server = new IdolRuntimeServer();
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.stop().catch((error) => console.error('Runtime shutdown error:', error));
    process.exit(exitCode);
  };
  server.start().then(() => {
    console.log(`Idol Runtime Server active on port ${process.env['PORT'] || '11111'}`);
    setInterval(() => {}, 1000 * 3600);
  }).catch((err) => {
    console.error('Fatal runtime server error:', err);
    process.exit(1);
  });

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  const nativeParentPid = parseInt(process.env['AI_IDOL_NATIVE_PARENT_PID'] || '', 10);
  if (Number.isInteger(nativeParentPid) && nativeParentPid > 1) {
    setInterval(() => {
      try {
        process.kill(nativeParentPid, 0);
      } catch {
        console.warn(`Native parent ${nativeParentPid} exited; shutting down the isolated runtime.`);
        void shutdown(0);
      }
    }, 1_000);
  }
}
