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
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
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
import { OBSController } from '@idol/obs-controller';
import { AssetRegistry, AssetRouter, DEFAULT_IDOL_ASSETS } from '@idol/asset-engine';
import { GoalEngine, DEFAULT_GOALS, DEFAULT_STREAM_PHASES } from '@idol/goal-engine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { GameAdapter, SlotSimulatorEngine } from '@idol/game-adapter';
import { ChatManager, MockChatGenerator, SmartChatFilter } from '@idol/chat-adapter';
import { ElevenLabsTTSAdapter, WebSpeechTTSAdapter } from '@idol/voice';
import { OpenAIDialogueProvider, OllamaDialogueProvider, MockDialogueProvider } from '@idol/dialogue-agent';
import { MockTalkingProvider, LiveTalkingProvider, TalkingVideoPipeline, MuseTalkBatchPipeline, type VideoFrame } from '@idol/talking-head';
import { RuntimeDatabase } from './persistence.js';

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

const SafeIdSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
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
  selected: z.array(SafeIdSchema).max(20).default([]),
  random: z.boolean().default(false),
}).strict();
const AvatarRecordSchema = z.object({
  id: SafeIdSchema.optional(),
  avatarId: SafeIdSchema.optional(),
  name: z.string().trim().min(1).max(160).optional(),
  modelType: z.enum(['musetalk', 'wav2lip']).optional(),
  taskId: z.string().trim().max(120).optional(),
  status: z.enum(['empty', 'uploading', 'training', 'ready', 'failed']).optional(),
  trainedAt: z.number().int().positive().optional(),
  thumbnailUrl: z.string().max(2048).optional(),
}).strict().refine((value) => Boolean(value.id || value.avatarId), { message: 'Avatar ID is required' });
const RawChatSchema = z.object({
  type: z.literal('chat.message').optional(),
  platform: z.enum(['youtube', 'twitch', 'tiktok', 'facebook', 'discord', 'mock']).default('youtube'),
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
const GameSpinSchema = z.object({
  bet: z.number().positive().max(1_000_000_000).optional(),
  forcedOutcome: z.enum(['JACKPOT', 'MEGA_WIN', 'BIG_WIN', 'NEAR_MISS', 'BONUS', 'LOSS']).optional(),
}).strict();
const TalkingSettingsSchema = z.object({
  provider: z.enum(['livetalking', 'mock', 'off']).optional(),
  endpoint: z.string().url().max(500).optional(),
  model: z.enum(['musetalk', 'wav2lip', 'wav2lip_gan']).optional(),
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
  provider: z.enum(['elevenlabs', 'openai']),
  voiceId: z.string().trim().min(1).max(120).optional(),
  modelId: z.string().trim().min(1).max(120).optional(),
}).strict();
const WebRtcOfferSchema = z.object({
  sdp: z.string().min(1).max(2_000_000),
  type: z.literal('offer').default('offer'),
  avatarId: SafeIdSchema.optional(),
  avatar: SafeIdSchema.optional(),
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
const VoiceSettingsSchema = z.object({
  provider: z.enum(['webspeech', 'elevenlabs', 'openai']).optional(),
  voiceId: z.string().trim().min(1).max(120).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  pitch: z.number().min(0.5).max(2).optional(),
  languageCode: z.string().trim().min(2).max(16).optional(),
  customEndpoint: z.string().url().max(500).or(z.literal('')).optional(),
}).strict();
const PersonaSettingsSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  personality: z.string().trim().max(1000).optional(),
  systemPrompt: z.string().trim().min(1).max(4000).optional(),
  llmProvider: z.enum(['mock', 'openai', 'gemini', 'ollama']).optional(),
}).strict();
const ObsSettingsSchema = z.object({
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  autoConnect: z.boolean().optional(),
}).strict();

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

type DefinedPartial<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

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
  private readonly _liveTalkingProvider: LiveTalkingProvider;
  private readonly _talkingPipeline: TalkingVideoPipeline;
  private readonly _museTalkBatchPipeline: MuseTalkBatchPipeline;
  private readonly _db: RuntimeDatabase;

  private _settings = {
    voice: {
      provider: (process.env['ELEVENLABS_API_KEY'] ? 'elevenlabs' : 'webspeech') as 'webspeech' | 'elevenlabs' | 'openai',
      apiKey: process.env['ELEVENLABS_API_KEY'] || '',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      speed: 1.05,
      pitch: 1.0,
      languageCode: 'vi',
      customEndpoint: '',
    },
    avatar: {
      preset: 'mimi_anime',
      customImageUrl: null as string | null,
      enablePipCam: true,
      enableAuraGlow: true,
    },
    persona: {
      name: 'Mimi',
      personality: 'Dễ thương, năng động, hài hước, thích tương tác và hay trêu người xem',
      systemPrompt: 'Bạn là Mimi, AI Idol streamer người Việt Nam vui tính, năng động và thân thiện. Luôn trả lời bằng tiếng Việt tự nhiên, ngắn gọn trong 1-2 câu. Không tự chuyển sang tiếng Anh.',
      llmProvider: (process.env['NODE_ENV'] === 'test' ? 'mock' : 'ollama') as 'mock' | 'openai' | 'gemini' | 'ollama',
      llmApiKey: process.env['OPENAI_API_KEY'] || '',
    },
    talkingEngine: {
      provider: 'livetalking' as 'livetalking' | 'mock' | 'off',
      endpoint: process.env['LIVETALKING_ENDPOINT'] || 'http://127.0.0.1:8011',
      model: 'musetalk' as 'musetalk' | 'wav2lip' | 'wav2lip_gan',
    },
    obs: {
      host: 'localhost',
      port: 4455,
      password: process.env['OBS_WEBSOCKET_PASSWORD'] || '',
      autoConnect: false,
    },
  };

  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _simTimer: ReturnType<typeof setInterval> | null = null;
  private _isRunning = false;
  private _connectedClients: Set<WebSocket> = new Set();
  private _recentLogs: Array<{ level: string; message: string; timestamp: number }> = [];
  private _speechRun = 0;
  private _speechIdleSince = Date.now();
  private _localModelInstall = { state: 'IDLE' as 'IDLE' | 'INSTALLING' | 'READY' | 'ERROR', progress: '', error: '' };
  private _speechRuntime: {
    commandId: string | null;
    state: 'IDLE' | 'GENERATING' | 'SPEAKING' | 'ERROR';
    text: string;
    provider: string;
    error: string | null;
    updatedAt: number;
  } = { commandId: null, state: 'IDLE', text: '', provider: '', error: null, updatedAt: Date.now() };
  private _projectStorageRoot = path.resolve(process.cwd(), 'local-projects');
  private _activeProject = 'ai-livestream';
  private readonly _storageConfigPath = path.resolve(process.cwd(), 'runtime-data', 'project-storage.json');

  constructor(config: Partial<ServerConfig> = {}) {
    this._config = {
      port: config.port ?? parseInt(process.env['PORT'] || '8765', 10),
      host: config.host ?? process.env['HOST'] ?? '127.0.0.1',
      enableSimulation: config.enableSimulation ?? process.env['ENABLE_SIMULATION'] === 'true',
      authToken: config.authToken ?? process.env['RUNTIME_AUTH_TOKEN'] ?? '',
      allowedOrigins: config.allowedOrigins ?? (process.env['CORS_ALLOWED_ORIGINS'] || 'http://127.0.0.1:8765,http://localhost:8765')
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

    // 1. Initialize Subsystems
    this._assetRegistry = new AssetRegistry(DEFAULT_IDOL_ASSETS);
    this._assetRouter = new AssetRouter(this._assetRegistry);
    this._goalEngine = new GoalEngine(DEFAULT_GOALS, DEFAULT_STREAM_PHASES);

    this._dialogueAgent = new DialogueAgent();
    this._configureDialogueProvider();
    this._voiceService = new VoiceService({
      listeners: {
        onVoiceEvent: (event) => this._handleVoiceEvent(event),
        onDuckingChange: (isDucked, duckDb) => this._handleDuckingChange(isDucked, duckDb),
      },
    });

    this._obsController = new OBSController();

    // 2. Level 3 Realtime Talking Video Pipeline (LiveTalking Primary + Neural Mesh Fallback)
    this._liveTalkingProvider = new LiveTalkingProvider({
      endpointUrl: this._settings.talkingEngine.endpoint,
      model: this._settings.talkingEngine.model,
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
      this._director.injectChatMessage(msg);
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
    const { apiKey: _voiceKey, ...voice } = this._settings.voice;
    const { llmApiKey: _llmKey, ...persona } = this._settings.persona;
    const { password: _obsPassword, ...obs } = this._settings.obs;
    return {
      voice: {
        ...voice,
        apiKeyConfigured: this._settings.voice.provider === 'openai'
          ? Boolean(this._settings.persona.llmApiKey)
          : Boolean(this._settings.voice.apiKey),
      },
      avatar: { ...this._settings.avatar },
      persona: { ...persona, apiKeyConfigured: Boolean(this._settings.persona.llmApiKey) },
      talkingEngine: { ...this._settings.talkingEngine },
      obs: { ...obs, passwordConfigured: Boolean(this._settings.obs.password) },
    };
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

  private _projectDir(): string {
    return path.join(this._projectStorageRoot, this._safeName(this._activeProject, 'ai-livestream'));
  }

  private _ensureProjectStorage(): void {
    const projectDir = this._projectDir();
    for (const dir of ['uploads', 'avatars/source', 'avatars/training', 'models', 'outputs', 'metadata']) {
      fs.mkdirSync(path.join(projectDir, dir), { recursive: true });
    }
    const projectFile = path.join(projectDir, 'project.json');
    if (!fs.existsSync(projectFile)) {
      fs.writeFileSync(projectFile, JSON.stringify({ name: this._activeProject, createdAt: new Date().toISOString(), version: 1 }, null, 2));
    }
  }

  private _loadProjectStorageConfig(): void {
    try {
      const databaseProject = this._db.getActiveProject();
      if (databaseProject) {
        this._projectStorageRoot = path.resolve(databaseProject.rootPath);
        this._activeProject = this._safeName(databaseProject.projectName, 'ai-livestream');
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
    const obs = this._db.getSetting<Record<string, unknown>>('obs');
    if (voice) this._settings.voice = { ...this._settings.voice, ...voice, apiKey: this._settings.voice.apiKey } as typeof this._settings.voice;
    if (avatar) this._settings.avatar = { ...this._settings.avatar, ...avatar } as typeof this._settings.avatar;
    if (persona) this._settings.persona = { ...this._settings.persona, ...persona, llmApiKey: this._settings.persona.llmApiKey } as typeof this._settings.persona;
    if (talkingEngine) this._settings.talkingEngine = { ...this._settings.talkingEngine, ...talkingEngine } as typeof this._settings.talkingEngine;
    if (obs) this._settings.obs = { ...this._settings.obs, ...obs, password: this._settings.obs.password } as typeof this._settings.obs;
  }

  private _avatarManifestPath(): string {
    return path.join(this._projectDir(), 'metadata', 'avatars.json');
  }

  private _readAvatarManifest(): any[] {
    const stored = this._db.listAvatars();
    if (stored.length) return stored;
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

  // ─────────────────────────────────────────────────────────
  // Server Lifecycle
  // ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;

    await this._obsController.initialize();

    return new Promise((resolve) => {
      this._httpServer.listen(this._config.port, this._config.host, () => {
        this._addLog('info', `Idol Runtime Server listening at http://${this._config.host}:${this._config.port}`);
        this._startMainLoop();
        if (this._config.enableSimulation) {
          this._startSimulationLoop();
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this._isRunning = false;
    if (this._tickTimer) clearInterval(this._tickTimer);
    if (this._simTimer) clearInterval(this._simTimer);

    await this._interruptSpeech();
    this._director.destroy();
    this._voiceService.destroy();
    await this._obsController.shutdown();

    for (const ws of this._connectedClients) {
      ws.close();
    }
    this._connectedClients.clear();

    return new Promise((resolve) => {
      this._httpServer.close(() => {
        this._db.close();
        resolve();
      });
    });
  }

  // ─────────────────────────────────────────────────────────
  // Main Director Runtime Tick Loop (100ms interval)
  // ─────────────────────────────────────────────────────────

  private _startMainLoop(): void {
    this._tickTimer = setInterval(() => {
      try {
        const intent = this._director.tick(Date.now());
        // Broadcast heartbeat & system telemetry periodically
        this._broadcastTelemetry();
      } catch (err) {
        this._addLog('error', `Error in Director tick: ${err}`);
      }
    }, 100);
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

  private async _handleDirectorIntent(intent: DirectorIntent): Promise<void> {
    this._addLog('info', `Intent generated: [${intent.action}] ${intent.intent || ''}`);

    this._broadcast({
      type: 'DIRECTOR_INTENT',
      intent,
      timestamp: Date.now(),
    });

    if (intent.action === 'SPEAK' || intent.action === 'REACT' || intent.action === 'TRIGGER_GOAL') {
      try {
        // 1. Generate Natural Dialogue text via Dialogue Agent
        const dialogue = await this._dialogueAgent.generateDialogue(intent);

        this._addLog('info', `[Dialogue] Mimi says: "${dialogue.text}" (duration ~${dialogue.estimatedDurationMs}ms)`);
        await this._obsController.setSubtitles(dialogue.text);

        // 2. One production path: server TTS -> LiveTalking -> WebRTC A/V.
        await this._executeSpeechCommand(SpeechCommandSchema.parse({
          commandId: `director_${Date.now()}`,
          text: dialogue.text,
          emotion: dialogue.emotion,
          speed: 1,
        }), 'director');
      } catch (err) {
        this._addLog('warn', `Failed to generate or play voice: ${err}`);
        this._director.setSpeaking(false);
      }
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
    if (this._speechRuntime.commandId) {
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

  private async _executeSpeechCommand(
    command: z.infer<typeof SpeechCommandSchema>,
    source: 'operator' | 'director' = 'operator',
  ): Promise<void> {
    if (source === 'director' && (this._speechRuntime.state !== 'IDLE' || Date.now() - this._speechIdleSince < 750)) {
      this._addLog('info', `Director speech skipped while the voice pipeline is active or settling`);
      return;
    }
    const runId = ++this._speechRun;
    const commandId = command.commandId || `speech_${crypto.randomBytes(8).toString('hex')}`;
    this._director.setSpeaking(false);
    this._setSpeechRuntime({ commandId, state: 'GENERATING', text: command.text, provider: this._settings.voice.provider, error: null });
    this._addLog('info', `Speech ${commandId}: generating with ${this._settings.voice.provider}`);
    await this._liveTalkingProvider.interrupt().catch(() => {});
    if (runId !== this._speechRun) return;

    try {
      if (this._settings.voice.provider !== 'webspeech') {
        const provider = this._settings.voice.provider as 'elevenlabs' | 'openai';
        const audio = await this._synthesizeProviderAudio({
          commandId,
          provider,
          text: command.text,
          emotion: command.emotion,
          speed: command.speed,
          voiceId: provider === 'elevenlabs' ? this._settings.voice.voiceId : 'nova',
          modelId: provider === 'elevenlabs' ? 'eleven_turbo_v2_5' : 'tts-1',
        });
        if (runId !== this._speechRun) return;
        await this._liveTalkingProvider.sendAudio(Buffer.from(audio.audioBase64, 'base64'));
      } else {
        await this._liveTalkingProvider.startSpeaking(command.text, {
          text: command.text,
          emotion: ['happy', 'excited', 'surprised', 'neutral', 'grateful'].includes(command.emotion)
            ? command.emotion as 'happy' | 'excited' | 'surprised' | 'neutral' | 'grateful'
            : 'neutral',
          speed: command.speed,
          voice: process.env['LIVETALKING_TTS_VOICE'] || 'vi-VN-HoaiMyNeural',
          ...(command.durationMs ? { durationMs: command.durationMs } : {}),
        });
      }

      const waitStartedAt = Date.now();
      let started = false;
      while (runId === this._speechRun) {
        const speaking = await this._liveTalkingProvider.isSessionSpeaking();
        if (!started && speaking) {
          started = true;
          this._director.setSpeaking(true);
          this._director.forceState('TALKING', 'LiveTalking WebRTC audio/video started');
          await this._obsController.setSubtitles(command.text);
          this._setSpeechRuntime({ state: 'SPEAKING' });
        } else if (started && !speaking) {
          this._director.setSpeaking(false);
          await this._obsController.setSubtitles('');
          this._director.forceState('GAMEPLAY_IDLE', 'LiveTalking speech completed');
          this._setSpeechRuntime({ state: 'IDLE' });
          return;
        }
        if (!started && Date.now() - waitStartedAt > 30_000) {
          throw new Error('LiveTalking did not start speaking within 30 seconds');
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } catch (error) {
      if (runId !== this._speechRun) return;
      const message = error instanceof Error ? error.message : String(error);
      this._director.setSpeaking(false);
      await this._obsController.setSubtitles('');
      this._setSpeechRuntime({ state: 'ERROR', error: message });
      this._addLog('error', `Speech ${commandId} failed: ${message}`);
    }
  }

  private async _interruptSpeech(): Promise<void> {
    this._speechRun += 1;
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

    if (this._settings.voice.provider === 'elevenlabs' && this._settings.voice.apiKey) {
      this._voiceService.setAdapter(new ElevenLabsTTSAdapter({
        apiKey: this._settings.voice.apiKey,
        voiceId: this._settings.voice.voiceId || 'EXAVITQu4vr4xnSDxMaL',
        languageCode: this._settings.voice.languageCode || 'vi',
      }));
    } else {
      this._voiceService.setAdapter(new WebSpeechTTSAdapter());
    }

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
    this._settings.persona = { ...this._settings.persona, ...safeSettings };
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

  private _configureDialogueProvider(): void {
    if (this._settings.persona.llmProvider === 'openai' && this._settings.persona.llmApiKey) {
      this._dialogueAgent.setProviders([
        new OpenAIDialogueProvider({ apiKey: this._settings.persona.llmApiKey }),
        new MockDialogueProvider(),
      ]);
      return;
    }
    if (this._settings.persona.llmProvider === 'ollama') {
      this._dialogueAgent.setProviders([
        new OllamaDialogueProvider({
          endpoint: process.env['OLLAMA_ENDPOINT'] || 'http://127.0.0.1:11434',
          model: process.env['OLLAMA_MODEL'] || 'qwen3.5:35b-64k',
        }),
        new MockDialogueProvider(),
      ]);
      return;
    }
    this._dialogueAgent.setProviders([new MockDialogueProvider()]);
  }

  private async _updateObsSettings(newSettings: Partial<typeof this._settings.obs>): Promise<void> {
    const { password: _ignoredPassword, ...safeSettings } = newSettings;
    this._settings.obs = { ...this._settings.obs, ...safeSettings };
    const { password: _secret, ...persistedObs } = this._settings.obs;
    this._db.setSetting('obs', persistedObs);
    if (this._settings.obs.autoConnect) {
      try {
        await this._obsController.initialize();
        this._addLog('info', 'Connected to OBS Studio WebSocket');
      } catch (err) {
        this._addLog('warn', `OBS connection failed: ${err}`);
      }
    }
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._publicSettings() });
  }

  private async _synthesizeProviderAudio(input: z.infer<typeof SpeechSynthesisSchema>): Promise<{ audioBase64: string; mediaType: string; durationMs: number }> {
    const request = {
      type: 'voice.request' as const,
      text: input.text,
      emotion: input.emotion,
      energy: 0.8,
      speedMultiplier: input.speed,
      interruptible: true,
      requestId: input.commandId || `speech_${Date.now()}`,
      timestamp: Date.now(),
    };

    if (input.provider === 'elevenlabs') {
      if (!this._settings.voice.apiKey) throw new Error('ElevenLabs is not configured on the runtime server');
      const result = await new ElevenLabsTTSAdapter({
        apiKey: this._settings.voice.apiKey,
        voiceId: input.voiceId || this._settings.voice.voiceId,
        modelId: input.modelId || 'eleven_turbo_v2_5',
        languageCode: this._settings.voice.languageCode,
      }).synthesize(request);
      if (!result.audioBase64) throw new Error('ElevenLabs did not return audio');
      return { audioBase64: result.audioBase64, mediaType: 'audio/mpeg', durationMs: result.durationMs };
    }

    if (!this._settings.persona.llmApiKey) throw new Error('OpenAI is not configured on the runtime server');
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._settings.persona.llmApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.modelId || 'tts-1',
        voice: input.voiceId || 'nova',
        input: input.text,
        speed: input.speed,
      }),
    });
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error(`OpenAI TTS failed with HTTP ${response.status}${details ? `: ${details.slice(0, 300)}` : ''}`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    const wordCount = input.text.split(/\s+/).filter(Boolean).length;
    return {
      audioBase64: audio.toString('base64'),
      mediaType: response.headers.get('content-type') || 'audio/mpeg',
      durationMs: Math.max(1800, Math.round((wordCount / 3.2 / input.speed) * 1000)),
    };
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

    const publicPath = pathname === '/health' || pathname === '/api/status';
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
        folders: ['uploads', 'avatars/source', 'avatars/training', 'models', 'outputs', 'metadata'],
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
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, rootPath: this._projectStorageRoot, projectName: this._activeProject, projectPath: this._projectDir() }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
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
      const targetDir = avatarId && (category === 'models' || category === 'avatars/training')
        ? path.join(this._projectDir(), category, avatarId)
        : path.join(this._projectDir(), category);
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.resolve(targetDir, filename);
      if (!targetPath.startsWith(path.resolve(targetDir) + path.sep)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid upload filename' }));
        return;
      }
      const stream = fs.createWriteStream(targetPath);
      let receivedSize = 0;
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        receivedSize += chunk.length;
        if (!rejected && receivedSize > this._config.maxUploadBytes) {
          rejected = true;
          req.unpipe(stream);
          stream.destroy();
          fs.unlink(targetPath, () => {});
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Upload exceeds the configured size limit' }));
          req.resume();
        }
      });
      req.pipe(stream);
      stream.on('finish', () => {
        if (rejected) return;
        const stat = fs.statSync(targetPath);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, filename, category, size: stat.size, path: targetPath }));
      });
      stream.on('error', (err) => {
        if (rejected || res.writableEnded) return;
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
      this._liveTalkingProvider.listTrainedAvatars().then((workerAvatars) => {
        const merged = new Map<string, any>();
        for (const avatar of workerAvatars) {
          const id = String(avatar.id || avatar.avatar_id || '');
          if (id) merged.set(id, {
            id,
            avatarId: id,
            status: 'ready',
            modelType: avatar.model_type || 'musetalk',
            name: avatar.source_name || id,
            source: 'worker',
          });
        }
        for (const avatar of localAvatars) {
          const id = String(avatar.id || avatar.avatarId || '');
          if (id) merged.set(id, { ...merged.get(id), ...avatar, id, avatarId: id });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, avatars: [...merged.values()] }));
      }).catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, avatars: localAvatars, workerAvailable: false }));
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

    if (pathname === '/api/avatars/session' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const input = this._parseBody(AvatarSessionSchema, body, res);
        if (!input) return;
        const session = { selected: input.selected, random: input.random, updatedAt: new Date().toISOString() };
        this._db.setAvatarSession(input.selected, input.random);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, session }));
      });
      return;
    }

    if (pathname === '/api/avatars/session' && method === 'GET') {
      const session = this._db.getAvatarSession();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, session }));
      return;
    }

    // ── REST API Endpoints ──
    if (url === '/api/status' || url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        state: this._director.state,
        queueSize: this._director.queue.size,
        connectedClients: this._connectedClients.size,
        uptime: process.uptime(),
        timestamp: Date.now(),
      }));
      return;
    }

    if (pathname === '/api/ai/local/status' && method === 'GET') {
      const model = process.env['OLLAMA_MODEL'] || 'qwen3.5:35b-64k';
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
      if (this._localModelInstall.state === 'INSTALLING') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Model installation is already running' }));
        return;
      }
      const model = process.env['OLLAMA_MODEL'] || 'qwen3.5:35b-64k';
      this._localModelInstall = { state: 'INSTALLING', progress: `Pulling ${model}`, error: '' };
      execFile(process.env['OLLAMA_BIN'] || 'ollama', ['pull', model], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          this._localModelInstall = { state: 'ERROR', progress: '', error: String(stderr || error.message).slice(-1000) };
          return;
        }
        this._localModelInstall = { state: 'READY', progress: String(stdout || 'Installed').slice(-1000), error: '' };
        this._settings.persona.llmProvider = 'ollama';
        this._configureDialogueProvider();
        const { llmApiKey: _secret, ...persistedPersona } = this._settings.persona;
        this._db.setSetting('persona', persistedPersona);
      });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, model, install: this._localModelInstall }));
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
        const msg = this._chatManager.ingest(this._withoutUndefined(input) as Parameters<ChatManager['ingest']>[0]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: !!msg, message: msg }));
      });
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

    if (pathname === '/api/talking-head/offer' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const offer = this._parseBody(WebRtcOfferSchema, body, res);
        if (!offer) return;
        try {
          const answer = await this._liveTalkingProvider.createOffer(offer.sdp, offer.type, offer.avatarId || offer.avatar);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ...answer }));
        } catch (err: any) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
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
        if (!this._liveTalkingProvider.sessionId) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Connect a LiveTalking avatar before speaking' }));
          return;
        }
        const command = { ...input, commandId: input.commandId || `speech_${crypto.randomBytes(8).toString('hex')}` };
        void this._executeSpeechCommand(command);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, commandId: command.commandId, state: 'GENERATING' }));
      });
      return;
    }

    if (pathname === '/api/speech/status' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, speech: this._speechRuntime }));
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
        if (!this._liveTalkingProvider.sessionId) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Connect a LiveTalking avatar before speaking' }));
          return;
        }
        const normalized = { ...command, commandId: command.commandId || `speech_${crypto.randomBytes(8).toString('hex')}` };
        void this._executeSpeechCommand(normalized);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, commandId: normalized.commandId, state: 'GENERATING' }));
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

    // ── LiveTalking Avatar Creator Endpoints (lipku/livetalking) ──
    if (url === '/api/avatar/task' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        try {
          const input = this._parseBody(AvatarTrainSchema, body, res);
          if (!input) return;
          const videoPath = this._resolveProjectPath(input.video_path || input.videoPath || input.avatarPath);
          const avatarId = input.avatar_id || `avatar_${Date.now().toString(36)}`;
          await this._liveTalkingProvider.setModel(input.model);
          const taskId = await this._liveTalkingProvider.createAvatarTask(videoPath, avatarId, path.join(this._projectDir(), 'models'));
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
          await this._liveTalkingProvider.setModel(input.model);
          const result = await this._liveTalkingProvider.trainAvatarVideo(videoPath, undefined, {
            savePath: path.join(this._projectDir(), 'models'),
            ...(input.avatar_id ? { avatarId: input.avatar_id } : {}),
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
        void this._executeSpeechCommand(normalized);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, commandId: normalized.commandId, state: 'GENERATING', engine: 'livetalking' }));
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._settings.talkingEngine }));
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

    if (url === '/api/settings/obs' && method === 'POST') {
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
  server.start().then(() => {
    console.log(`✨ Idol Runtime Server daemon active on port 8765`);
    setInterval(() => {}, 1000 * 3600);
  }).catch((err) => {
    console.error('Fatal runtime server error:', err);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });
}
