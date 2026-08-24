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
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

import {
  type VisualState,
  type DirectorIntent,
  type StateTransition,
  type GameEvent,
  type ChatMessage,
  type DonationEvent,
  type OperatorCommand,
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
import { OpenAIDialogueProvider, MockDialogueProvider } from '@idol/dialogue-agent';
import { MockTalkingProvider, LiveTalkingProvider, TalkingVideoPipeline, MuseTalkBatchPipeline, type VideoFrame } from '@idol/talking-head';

export interface ServerConfig {
  port: number;
  host: string;
  enableSimulation: boolean;
}

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

  private _settings = {
    voice: {
      provider: 'elevenlabs' as 'webspeech' | 'elevenlabs',
      apiKey: 'REMOVED_PROVIDER_SECRET',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      speed: 1.05,
      pitch: 1.0,
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
      systemPrompt: 'Bạn là Mimi, một AI Idol streamer người Việt Nam cực kỳ vui tính, năng động và lôi cuốn. Bạn luôn trả lời ngắn gọn (1-2 câu), dùng từ ngữ tự nhiên và thân thiện.',
      llmProvider: 'mock' as 'mock' | 'openai' | 'gemini',
      llmApiKey: '',
    },
    talkingEngine: {
      provider: 'livetalking' as 'livetalking' | 'mock' | 'off',
      endpoint: 'http://localhost:8010',
      model: 'wav2lip' as 'wav2lip' | 'wav2lip_gan',
    },
    obs: {
      host: 'localhost',
      port: 4455,
      password: '',
      autoConnect: false,
    },
  };

  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _simTimer: ReturnType<typeof setInterval> | null = null;
  private _isRunning = false;
  private _connectedClients: Set<WebSocket> = new Set();
  private _recentLogs: Array<{ level: string; message: string; timestamp: number }> = [];

  constructor(config: Partial<ServerConfig> = {}) {
    this._config = {
      port: config.port ?? parseInt(process.env['PORT'] || '8765', 10),
      host: config.host ?? '0.0.0.0',
      enableSimulation: config.enableSimulation ?? true,
    };

    // 1. Initialize Subsystems
    this._assetRegistry = new AssetRegistry(DEFAULT_IDOL_ASSETS);
    this._assetRouter = new AssetRouter(this._assetRegistry);
    this._goalEngine = new GoalEngine(DEFAULT_GOALS, DEFAULT_STREAM_PHASES);

    this._dialogueAgent = new DialogueAgent();
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
        message: `Tặng ${gift.giftCount}x ${gift.giftName}!`,
        timestamp: gift.timestamp,
      });
      this._broadcast({ type: 'CHAT_GIFT', gift });
    });

    // 5. HTTP Server
    this._httpServer = http.createServer((req, res) => this._handleHttpRequest(req, res));

    // 6. WebSocket Server
    this._wss = new WebSocketServer({ server: this._httpServer });
    this._wss.on('connection', (ws) => this._handleWsConnection(ws));
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

    this._director.destroy();
    this._voiceService.destroy();
    await this._obsController.shutdown();

    for (const ws of this._connectedClients) {
      ws.close();
    }
    this._connectedClients.clear();

    return new Promise((resolve) => {
      this._httpServer.close(() => resolve());
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
          'Chơi game này vui ghê Mimi ơi!',
          'Hôm nay stream tới mấy giờ vậy em?',
          'Pha vừa rồi xử lý mượt quá!',
          'Chào Mimi và cả nhà nha!',
          'Tí có chơi chung với viewer không Mimi?',
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

        // 2. Synthesize & Speak Voice
        this._director.setSpeaking(true);
        await this._voiceService.speak({
          type: 'voice.request',
          text: dialogue.text,
          emotion: dialogue.emotion,
          energy: 0.8,
          speedMultiplier: 1.0,
          interruptible: intent.priority > 1,
          requestId: `req_${Date.now()}`,
          timestamp: Date.now(),
        });
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
    if (event.type === 'voice.started') {
      this._talkingPipeline.speak(event.text || '', event.estimatedDurationMs || 3500, event.emotion || 'happy');
    } else if (event.type === 'voice.finished' || event.type === 'voice.interrupted' || event.type === 'voice.error') {
      this._talkingPipeline.interrupt();
      this._director.setSpeaking(false);
      this._obsController.setSubtitles('');
    }

    this._broadcast({
      type: 'VOICE_EVENT',
      event,
      timestamp: Date.now(),
    });
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
    switch (msg.type) {
      case 'OPERATOR_COMMAND':
        this._director.injectOperatorCommand(msg.command as OperatorCommand);
        break;

      case 'INJECT_GAME_EVENT':
        this._director.injectGameEvent(msg.event as GameEvent);
        break;

      case 'INJECT_CHAT_MESSAGE':
        this._director.injectChatMessage(msg.message as ChatMessage);
        break;

      case 'INJECT_DONATION':
        this._director.injectDonation(msg.donation as DonationEvent);
        break;

      case 'FORCE_STATE':
        this._director.forceState(msg.state as VisualState, 'Operator override via WS');
        break;

      case 'TEST_JACKPOT':
        this._director.injectGameEvent({
          type: 'game.jackpot',
          value: 5000,
          currency: 'JACKPOT_GOLD',
          timestamp: Date.now(),
        });
        break;
    }
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
    this._settings.voice = { ...this._settings.voice, ...newSettings };

    if (this._settings.voice.provider === 'elevenlabs' && this._settings.voice.apiKey) {
      this._voiceService.setAdapter(new ElevenLabsTTSAdapter({
        apiKey: this._settings.voice.apiKey,
        voiceId: this._settings.voice.voiceId || 'EXAVITQu4vr4xnSDxMaL',
      }));
    } else {
      this._voiceService.setAdapter(new WebSpeechTTSAdapter());
    }

    this._addLog('info', `Voice provider updated: ${this._settings.voice.provider}`);
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._settings });
  }

  private _updateAvatarSettings(newSettings: Partial<typeof this._settings.avatar>): void {
    this._settings.avatar = { ...this._settings.avatar, ...newSettings };
    this._addLog('info', `Avatar updated: preset=${this._settings.avatar.preset}, customImage=${!!this._settings.avatar.customImageUrl}`);
    this._broadcast({ type: 'AVATAR_UPDATED', avatar: this._settings.avatar });
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._settings });
  }

  private _updatePersonaSettings(newSettings: Partial<typeof this._settings.persona>): void {
    this._settings.persona = { ...this._settings.persona, ...newSettings };
    this._dialogueAgent.updatePersona({
      name: this._settings.persona.name,
      personality: this._settings.persona.personality,
      systemPrompt: this._settings.persona.systemPrompt,
    });

    if (this._settings.persona.llmProvider === 'openai' && this._settings.persona.llmApiKey) {
      this._dialogueAgent.setProviders([
        new OpenAIDialogueProvider({ apiKey: this._settings.persona.llmApiKey }),
        new MockDialogueProvider(),
      ]);
    } else {
      this._dialogueAgent.setProviders([new MockDialogueProvider()]);
    }

    this._addLog('info', `Idol persona updated: ${this._settings.persona.name}`);
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._settings });
  }

  private async _updateObsSettings(newSettings: Partial<typeof this._settings.obs>): Promise<void> {
    this._settings.obs = { ...this._settings.obs, ...newSettings };
    if (this._settings.obs.autoConnect) {
      try {
        await this._obsController.initialize();
        this._addLog('info', 'Connected to OBS Studio WebSocket');
      } catch (err) {
        this._addLog('warn', `OBS connection failed: ${err}`);
      }
    }
    this._broadcast({ type: 'SETTINGS_UPDATED', settings: this._settings });
  }

  // ─────────────────────────────────────────────────────────
  // HTTP Request Handling (REST API + Static Dashboard)
  // ─────────────────────────────────────────────────────────

  private _handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
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
        this._director.injectGameEvent(body as GameEvent);
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
        const event = this._gameAdapter.spinSimulator(body.bet, body.forcedOutcome);
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
        const msg = this._chatManager.ingest(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: !!msg, message: msg }));
      });
      return;
    }

    if (url === '/api/chat/gift' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        this._chatManager.ingestGift(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }

    if (url === '/api/talking-head/speak' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        const text = body.text || 'Chào cả nhà nha!';
        const durationMs = body.durationMs || 3500;
        const emotion = body.emotion || 'happy';
        const activeState = body.state || this._director.state.currentVisual || 'TALKING';
        this._talkingPipeline.speak(text, durationMs, emotion, activeState);
        this._voiceService.speak({
          type: 'voice.request',
          text,
          emotion: emotion as any,
          energy: 0.8,
          speedMultiplier: 1.0,
          interruptible: true,
          requestId: `th_test_${Date.now()}`,
          timestamp: Date.now(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, text, durationMs, emotion, activeState }));
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          provider: 'lipku/livetalking',
          framework: 'LiveTalking Realtime Digital Human Pipeline',
          health,
          config: this._liveTalkingProvider.config,
        }));
      });
      return;
    }

    // ── LiveTalking Avatar Creator Endpoints (lipku/livetalking) ──
    if (url === '/api/avatar/task' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const taskId = 'task_' + Math.random().toString(36).substring(2, 9);
        const result = await this._liveTalkingProvider.trainAvatarVideo(body.video_path || body.videoPath || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            task_id: taskId,
            model_type: body.model || 'wav2lip',
            avatar_id: body.avatar_id || 'avatar_main',
            status: 'completed',
            progress: 100,
            result,
          }
        }));
      });
      return;
    }

    if (url === '/api/avatar/tasks' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {
          tasks: [
            {
              task_id: 'task_current',
              model_type: 'wav2lip',
              avatar_id: 'avatar_main',
              status: 'completed',
              progress: 100,
              start_time: Math.floor(Date.now() / 1000) - 60,
              end_time: Math.floor(Date.now() / 1000),
            }
          ]
        }
      }));
      return;
    }

    if ((url === '/api/talking-head/livetalking/train' || url === '/api/talking-head/livetalking/preprocess') && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const result = await this._liveTalkingProvider.trainAvatarVideo(body.avatarPath || body.videoPath || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return;
    }

    if (url === '/api/talking-head/livetalking/speak' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        const text = body.text || 'Chào cả nhà!';
        const durationMs = body.durationMs || 3500;
        const emotion = body.emotion || 'happy';
        await this._liveTalkingProvider.startSpeaking(text, { text, durationMs, emotion });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, text, durationMs, emotion, engine: 'livetalking' }));
      });
      return;
    }

    if (url === '/api/talking-head/livetalking/interrupt' && method === 'POST') {
      this._liveTalkingProvider.interrupt().then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Interrupted LiveTalking Engine' }));
      });
      return;
    }

    if (url === '/api/talking-head/livetalking/config' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        if (body.model) this._liveTalkingProvider.setModel(body.model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: this._liveTalkingProvider.config }));
      });
      return;
    }

    if (url === '/api/settings/talking' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        this._settings.talkingEngine = { ...this._settings.talkingEngine, ...body };
        if (body.model) this._liveTalkingProvider.setModel(body.model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._settings.talkingEngine }));
      });
      return;
    }

    // ── Pure Upstream MuseTalk Batch Video Generation APIs ──
    if (url === '/api/musetalk/batch-process' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        try {
          const result = await this._museTalkBatchPipeline.process({
            videoPath: body.videoPath || 'avatar.mp4',
            audioPath: body.audioPath || 'test.wav',
            videoFilename: body.videoFilename || 'avatar.mp4',
            audioFilename: body.audioFilename || 'test.wav',
            bboxShift: body.bboxShift || 0,
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
      const filename = url.replace('/api/musetalk/output/', '');
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      // Stream or send video data
      res.end(Buffer.alloc(1024 * 64)); // placeholder binary or file stream
      return;
    }

    // ── Settings REST APIs ──
    if (url === '/api/settings/all' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._settings));
      return;
    }

    if (url === '/api/settings/voice' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        this._updateVoiceSettings(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._settings.voice }));
      });
      return;
    }

    if (url === '/api/settings/avatar' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        this._updateAvatarSettings(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._settings.avatar }));
      });
      return;
    }

    if (url === '/api/settings/persona' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        this._updatePersonaSettings(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._settings.persona }));
      });
      return;
    }

    if (url === '/api/settings/obs' && method === 'POST') {
      this._readJsonBody(req, async (body) => {
        await this._updateObsSettings(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings: this._settings.obs, isConnected: this._obsController.isConnected }));
      });
      return;
    }

    if (url === '/api/operator/command' && method === 'POST') {
      this._readJsonBody(req, (body) => {
        this._director.injectOperatorCommand(body as OperatorCommand);
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
      const candidate = path.join(dir, cleanPath);
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
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        const json = JSON.parse(data || '{}');
        callback(json);
      } catch {
        callback({});
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
