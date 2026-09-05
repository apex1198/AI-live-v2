/**
 * OBS WebSocket v5 controller used by the native AI Idol runtime.
 * The mock client remains injectable so the event pipeline stays deterministic in tests.
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
export interface OBSBrowserSourceConfig {
    url: string;
    sourceName?: string;
    sceneName?: string;
    width?: number;
    height?: number;
    fps?: number;
    /** Explicitly update OBS Video Settings before placing the Browser Source. */
    applyVideoSettings?: boolean;
}
export interface OBSMagicConnectResult {
    connected: boolean;
    sceneName: string;
    sourceName: string;
    sourceUrl: string;
    sourceCreated: boolean;
    sceneItemCreated: boolean;
    audioRouted: boolean;
    obsVersion: string;
    videoPreset: {
        width: number;
        height: number;
        fps: number;
        applied: boolean;
        matches: boolean;
        streamActive: boolean;
    };
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
    provisionBrowserSource?(config: OBSBrowserSourceConfig): Promise<OBSMagicConnectResult>;
    configure?(config: OBSConnectionConfig): Promise<void>;
    getState(): OBSState;
}
export interface OBSControllerListeners {
    onStatusChange?: (connected: boolean) => void;
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}
type ClientListeners = {
    onStatusChange: (connected: boolean) => void;
    onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
};
export declare class MockOBSClient implements OBSClient {
    private _state;
    connect(): Promise<boolean>;
    disconnect(): Promise<void>;
    execute(command: OBSCommand): Promise<boolean>;
    switchMedia(filePath: string): Promise<boolean>;
    setSubtitles(_text: string): Promise<boolean>;
    setDucking(isDucked: boolean, _duckDb?: number): Promise<boolean>;
    provisionBrowserSource(config: OBSBrowserSourceConfig): Promise<OBSMagicConnectResult>;
    getState(): OBSState;
}
export declare class OBSWebSocketClient implements OBSClient {
    private _config;
    private _obs;
    private readonly _listeners;
    private _connectPromise;
    private _reconnectTimer;
    private _reconnectDelayMs;
    private _lastConnectionErrorLogAt;
    private _manualDisconnect;
    private _lastBrowserSource;
    private _state;
    constructor(config?: OBSConnectionConfig, listeners?: Partial<ClientListeners>);
    private _bindConnectionEvents;
    private _scheduleReconnect;
    configure(config: OBSConnectionConfig): Promise<void>;
    connect(): Promise<boolean>;
    disconnect(): Promise<void>;
    private _currentScene;
    private _setSceneItemVisible;
    execute(command: OBSCommand): Promise<boolean>;
    switchMedia(filePath: string): Promise<boolean>;
    setSubtitles(text: string): Promise<boolean>;
    setDucking(isDucked: boolean, duckDb?: number): Promise<boolean>;
    provisionBrowserSource(config: OBSBrowserSourceConfig): Promise<OBSMagicConnectResult>;
    getState(): OBSState;
}
export declare class OBSController {
    private readonly _client;
    private _config;
    private readonly _listeners;
    constructor(config?: OBSConnectionConfig, client?: OBSClient, listeners?: OBSControllerListeners);
    get client(): OBSClient;
    get isConnected(): boolean;
    configure(config: OBSConnectionConfig): Promise<void>;
    initialize(): Promise<boolean>;
    magicConnect(config: OBSBrowserSourceConfig): Promise<OBSMagicConnectResult>;
    switchClip(fileName: string): Promise<boolean>;
    setSubtitles(text: string): Promise<boolean>;
    applyAudioDucking(isDucked: boolean, duckDb?: number): Promise<boolean>;
    executeCommand(command: OBSCommand): Promise<boolean>;
    shutdown(): Promise<void>;
    private _log;
}
export {};
//# sourceMappingURL=index.d.ts.map