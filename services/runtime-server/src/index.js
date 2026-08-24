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
import { DirectorAgent } from '@idol/director';
import { DialogueAgent } from '@idol/dialogue-agent';
import { VoiceService } from '@idol/voice';
import { OBSController } from '@idol/obs-controller';
import { AssetRegistry, AssetRouter, DEFAULT_IDOL_ASSETS } from '@idol/asset-engine';
import { GoalEngine, DEFAULT_GOALS, DEFAULT_STREAM_PHASES } from '@idol/goal-engine';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export class IdolRuntimeServer {
    _config;
    _httpServer;
    _wss;
    _assetRegistry;
    _assetRouter;
    _goalEngine;
    _director;
    _dialogueAgent;
    _voiceService;
    _obsController;
    _tickTimer = null;
    _simTimer = null;
    _isRunning = false;
    _connectedClients = new Set();
    _recentLogs = [];
    constructor(config = {}) {
        this._config = {
            port: config.port ?? parseInt(process.env['PORT'] || '8080', 10),
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
        this._director = new DirectorAgent({
            assetRegistry: this._assetRegistry,
            goalEngine: this._goalEngine,
            listeners: {
                onIntent: (intent) => this._handleDirectorIntent(intent),
                onStateTransition: (trans, asset) => this._handleStateTransition(trans, asset),
                onLog: (level, msg, data) => this._addLog(level, msg, data),
            },
        });
        // 2. HTTP Server
        this._httpServer = http.createServer((req, res) => this._handleHttpRequest(req, res));
        // 3. WebSocket Server
        this._wss = new WebSocketServer({ server: this._httpServer });
        this._wss.on('connection', (ws) => this._handleWsConnection(ws));
    }
    get director() {
        return this._director;
    }
    get voiceService() {
        return this._voiceService;
    }
    get obsController() {
        return this._obsController;
    }
    get goalEngine() {
        return this._goalEngine;
    }
    get assetRegistry() {
        return this._assetRegistry;
    }
    // ─────────────────────────────────────────────────────────
    // Server Lifecycle
    // ─────────────────────────────────────────────────────────
    async start() {
        if (this._isRunning)
            return;
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
    async stop() {
        this._isRunning = false;
        if (this._tickTimer)
            clearInterval(this._tickTimer);
        if (this._simTimer)
            clearInterval(this._simTimer);
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
    _startMainLoop() {
        this._tickTimer = setInterval(() => {
            try {
                const intent = this._director.tick(Date.now());
                // Broadcast heartbeat & system telemetry periodically
                this._broadcastTelemetry();
            }
            catch (err) {
                this._addLog('error', `Error in Director tick: ${err}`);
            }
        }, 100);
    }
    // ─────────────────────────────────────────────────────────
    // Simulation Loop for Fake Events (Autonomous Testing)
    // ─────────────────────────────────────────────────────────
    _startSimulationLoop() {
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
                const randomViewer = mockViewers[Math.floor(Math.random() * mockViewers.length)];
                const randomMsg = mockMessages[Math.floor(Math.random() * mockMessages.length)];
                this._director.injectChatMessage({
                    type: 'chat.message',
                    platform: 'youtube',
                    viewerId: `usr_${Math.random().toString(36).slice(2, 7)}`,
                    viewerName: randomViewer,
                    message: randomMsg,
                    isSuperChat: Math.random() < 0.1,
                    isSubscriber: true,
                    timestamp: Date.now(),
                });
            }
            // Every 45s: inject a game event (win / reward / lose)
            if (tickCount % 45 === 0) {
                const events = [
                    { type: 'game.win', value: 200 },
                    { type: 'game.reward.small', value: 50 },
                    { type: 'game.lose', value: 0 },
                ];
                const evt = events[Math.floor(Math.random() * events.length)];
                this._director.injectGameEvent({
                    type: evt.type,
                    value: evt.value,
                    currency: 'coins',
                    timestamp: Date.now(),
                });
            }
        }, 1000);
    }
    // ─────────────────────────────────────────────────────────
    // Subsystem Event Handlers
    // ─────────────────────────────────────────────────────────
    async _handleDirectorIntent(intent) {
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
            }
            catch (err) {
                this._addLog('warn', `Failed to generate or play voice: ${err}`);
                this._director.setSpeaking(false);
            }
        }
    }
    async _handleStateTransition(transition, asset) {
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
    _handleVoiceEvent(event) {
        if (event.type === 'voice.finished' || event.type === 'voice.interrupted' || event.type === 'voice.error') {
            this._director.setSpeaking(false);
            this._obsController.setSubtitles('');
        }
        this._broadcast({
            type: 'VOICE_EVENT',
            event,
            timestamp: Date.now(),
        });
    }
    _handleDuckingChange(isDucked, duckDb) {
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
    _handleWsConnection(ws) {
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
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                this._handleClientMessage(message, ws);
            }
            catch (err) {
                this._addLog('error', `Invalid WS payload: ${err}`);
            }
        });
        ws.on('close', () => {
            this._connectedClients.delete(ws);
            this._addLog('info', `Operator Dashboard disconnected. Remaining: ${this._connectedClients.size}`);
        });
    }
    _handleClientMessage(msg, _ws) {
        switch (msg.type) {
            case 'OPERATOR_COMMAND':
                this._director.injectOperatorCommand(msg.command);
                break;
            case 'INJECT_GAME_EVENT':
                this._director.injectGameEvent(msg.event);
                break;
            case 'INJECT_CHAT_MESSAGE':
                this._director.injectChatMessage(msg.message);
                break;
            case 'INJECT_DONATION':
                this._director.injectDonation(msg.donation);
                break;
            case 'FORCE_STATE':
                this._director.forceState(msg.state, 'Operator override via WS');
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
    _broadcast(payload) {
        const serialized = JSON.stringify(payload);
        for (const ws of this._connectedClients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(serialized);
            }
        }
    }
    _broadcastTelemetry() {
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
    _addLog(level, message, data) {
        const entry = { level, message: `${message} ${data ? JSON.stringify(data) : ''}`.trim(), timestamp: Date.now() };
        this._recentLogs.push(entry);
        if (this._recentLogs.length > 100)
            this._recentLogs.shift();
        this._broadcast({
            type: 'LOG_ENTRY',
            log: entry,
        });
    }
    // ─────────────────────────────────────────────────────────
    // HTTP Request Handling (REST API + Static Dashboard)
    // ─────────────────────────────────────────────────────────
    _handleHttpRequest(req, res) {
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
                this._director.injectGameEvent(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Game event accepted' }));
            });
            return;
        }
        if (url === '/api/operator/command' && method === 'POST') {
            this._readJsonBody(req, (body) => {
                this._director.injectOperatorCommand(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Command executed' }));
            });
            return;
        }
        // ── Static Files (Serve operator-dashboard) ──
        const dashboardDir = path.resolve(__dirname, '../../../../operator-dashboard');
        let filePath = path.join(dashboardDir, url === '/' ? 'index.html' : url);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath);
            const mimeTypes = {
                '.html': 'text/html',
                '.css': 'text/css',
                '.js': 'text/javascript',
                '.json': 'application/json',
                '.png': 'image/png',
                '.svg': 'image/svg+xml',
            };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
            fs.createReadStream(filePath).pipe(res);
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
    _readJsonBody(req, callback) {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => {
            try {
                const json = JSON.parse(data || '{}');
                callback(json);
            }
            catch {
                callback({});
            }
        });
    }
}
// ─────────────────────────────────────────────────────────
// CLI Standalone Entrypoint
// ─────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('dist/index.js')) {
    const server = new IdolRuntimeServer();
    server.start().catch((err) => {
        console.error('Fatal runtime server error:', err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map