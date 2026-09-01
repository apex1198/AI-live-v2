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
import { DirectorAgent } from '@idol/director';
import { VoiceService } from '@idol/voice';
import { OBSController } from '@idol/obs-controller';
import { AssetRegistry } from '@idol/asset-engine';
import { GoalEngine } from '@idol/goal-engine';
export interface ServerConfig {
    port: number;
    host: string;
    enableSimulation: boolean;
}
export declare class IdolRuntimeServer {
    private readonly _config;
    private readonly _httpServer;
    private readonly _wss;
    private readonly _assetRegistry;
    private readonly _assetRouter;
    private readonly _goalEngine;
    private readonly _director;
    private readonly _dialogueAgent;
    private readonly _voiceService;
    private readonly _obsController;
    private _tickTimer;
    private _simTimer;
    private _isRunning;
    private _connectedClients;
    private _recentLogs;
    constructor(config?: Partial<ServerConfig>);
    get director(): DirectorAgent;
    get voiceService(): VoiceService;
    get obsController(): OBSController;
    get goalEngine(): GoalEngine;
    get assetRegistry(): AssetRegistry;
    start(): Promise<void>;
    stop(): Promise<void>;
    private _startMainLoop;
    private _startSimulationLoop;
    private _handleDirectorIntent;
    private _handleStateTransition;
    private _handleVoiceEvent;
    private _handleDuckingChange;
    private _handleWsConnection;
    private _handleClientMessage;
    private _broadcast;
    private _broadcastTelemetry;
    private _addLog;
    private _handleHttpRequest;
    private _readJsonBody;
}
//# sourceMappingURL=index.d.ts.map