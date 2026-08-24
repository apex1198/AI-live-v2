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

// ─────────────────────────────────────────────────────────
// 1. Mock OBS Client (For zero-dependency runtime & tests)
// ─────────────────────────────────────────────────────────

export class MockOBSClient implements OBSClient {
  private _state: OBSState = {
    connected: false,
    currentScene: 'Main Scene',
    activeMediaFile: 'gameplay_idle_01.mp4',
    isDucked: false,
    visibleSources: new Set(['IdolVideo', 'GameCapture', 'Subtitles']),
  };

  async connect(): Promise<boolean> {
    this._state.connected = true;
    return true;
  }

  async disconnect(): Promise<void> {
    this._state.connected = false;
  }

  async execute(command: OBSCommand): Promise<boolean> {
    switch (command.action) {
      case 'switch_scene':
        this._state.currentScene = command.sceneName;
        break;
      case 'show_source':
        this._state.visibleSources.add(command.sourceName);
        break;
      case 'hide_source':
        this._state.visibleSources.delete(command.sourceName);
        break;
      case 'duck_audio':
        this._state.isDucked = true;
        break;
      case 'restore_audio':
        this._state.isDucked = false;
        break;
    }
    return true;
  }

  async switchMedia(filePath: string): Promise<boolean> {
    this._state.activeMediaFile = filePath;
    return true;
  }

  async setSubtitles(_text: string): Promise<boolean> {
    return true;
  }

  async setDucking(isDucked: boolean, _duckDb: number = -12): Promise<boolean> {
    this._state.isDucked = isDucked;
    return true;
  }

  getState(): OBSState {
    return {
      connected: this._state.connected,
      currentScene: this._state.currentScene,
      activeMediaFile: this._state.activeMediaFile,
      isDucked: this._state.isDucked,
      visibleSources: new Set(this._state.visibleSources),
    };
  }
}

// ─────────────────────────────────────────────────────────
// 2. OBS Controller Service
// ─────────────────────────────────────────────────────────

export interface OBSControllerListeners {
  onStatusChange?: (connected: boolean) => void;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class OBSController {
  private readonly _client: OBSClient;
  private readonly _config: Required<OBSConnectionConfig>;
  private readonly _listeners: OBSControllerListeners;

  constructor(
    config: OBSConnectionConfig = {},
    client?: OBSClient,
    listeners: OBSControllerListeners = {}
  ) {
    this._config = {
      url: config.url ?? 'ws://localhost:4455',
      password: config.password ?? '',
      mediaSourceName: config.mediaSourceName ?? 'IdolVideoSource',
      subtitlesSourceName: config.subtitlesSourceName ?? 'Subtitles',
      gameAudioSourceName: config.gameAudioSourceName ?? 'GameAudio',
      autoReconnect: config.autoReconnect ?? true,
    };
    this._client = client ?? new MockOBSClient();
    this._listeners = listeners;
  }

  get client(): OBSClient {
    return this._client;
  }

  get isConnected(): boolean {
    return this._client.getState().connected;
  }

  async initialize(): Promise<boolean> {
    try {
      const ok = await this._client.connect();
      this._listeners.onStatusChange?.(ok);
      this._log('info', `OBS Controller initialized. Connected: ${ok}`);
      return ok;
    } catch (err) {
      this._log('warn', `Could not connect to OBS: ${err}`);
      return false;
    }
  }

  async switchClip(fileName: string): Promise<boolean> {
    this._log('info', `Switching OBS Media Source to: ${fileName}`);
    return this._client.switchMedia(fileName);
  }

  async setSubtitles(text: string): Promise<boolean> {
    return this._client.setSubtitles(text);
  }

  async applyAudioDucking(isDucked: boolean, duckDb: number = -12): Promise<boolean> {
    return this._client.setDucking(isDucked, duckDb);
  }

  async executeCommand(command: OBSCommand): Promise<boolean> {
    return this._client.execute(command);
  }

  async shutdown(): Promise<void> {
    await this._client.disconnect();
    this._listeners.onStatusChange?.(false);
  }

  private _log(level: 'info' | 'warn' | 'error', message: string): void {
    this._listeners.onLog?.(level, `[OBSController] ${message}`);
  }
}
