/**
 * @idol/obs-controller
 *
 * OBS WebSocket Controller for Hybrid AI Idol.
 *
 * Rules (from PLAN.md):
 * - Controls OBS Studio scenes, media clips, overlays, audio filters via WebSocket.
 * - Fault tolerant: if OBS disconnects or is offline, stream logic continues without crashing.
 * - Includes MockOBSClient for reliable local testing and CI.
 */
import type { OBSCommand } from '@idol/event-schema';
export interface OBSConnectionConfig {
    url?: string;
    password?: string;
    mediaSourceName?: string;
    subtitlesSourceName?: string;
    gameAudioSourceName?: string;
    autoReconnect?: boolean;
}
export interface OBSState {
    connected: boolean;
    currentScene: string;
    activeMediaFile: string;
    isDucked: boolean;
    visibleSources: Set<string>;
}
export interface OBSClient {
    connect(): Promise<boolean>;
    disconnect(): Promise<void>;
    execute(command: OBSCommand): Promise<boolean>;
    switchMedia(filePath: string): Promise<boolean>;
    setSubtitles(text: string): Promise<boolean>;
    setDucking(isDucked: boolean, duckDb?: number): Promise<boolean>;
    getState(): OBSState;
}
export declare class MockOBSClient implements OBSClient {
    private _state;
    connect(): Promise<boolean>;
    disconnect(): Promise<void>;
    execute(command: OBSCommand): Promise<boolean>;
    switchMedia(filePath: string): Promise<boolean>;
    setSubtitles(_text: string): Promise<boolean>;
    setDucking(isDucked: boolean, _duckDb?: number): Promise<boolean>;
    getState(): OBSState;
}
export interface OBSControllerListeners {
    onStatusChange?: (connected: boolean) => void;
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}
export declare class OBSController {
    private readonly _client;
    private readonly _config;
    private readonly _listeners;
    constructor(config?: OBSConnectionConfig, client?: OBSClient, listeners?: OBSControllerListeners);
    get client(): OBSClient;
    get isConnected(): boolean;
    initialize(): Promise<boolean>;
    switchClip(fileName: string): Promise<boolean>;
    setSubtitles(text: string): Promise<boolean>;
    applyAudioDucking(isDucked: boolean, duckDb?: number): Promise<boolean>;
    executeCommand(command: OBSCommand): Promise<boolean>;
    shutdown(): Promise<void>;
    private _log;
}
//# sourceMappingURL=index.d.ts.map