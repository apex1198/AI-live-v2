/**
 * OBS WebSocket v5 controller used by the native AI Idol runtime.
 * The mock client remains injectable so the event pipeline stays deterministic in tests.
 */

import type { OBSCommand } from '@idol/event-schema';
import { OBSWebSocket } from 'obs-websocket-js/json';

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

const DEFAULT_VIDEO_PRESET = Object.freeze({ width: 1920, height: 1080, fps: 30 });

type ClientListeners = {
  onStatusChange: (connected: boolean) => void;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
};

function normalizedConfig(config: OBSConnectionConfig = {}): Required<OBSConnectionConfig> {
  return {
    url: config.url ?? 'ws://127.0.0.1:4455',
    password: config.password ?? '',
    mediaSourceName: config.mediaSourceName ?? 'IdolVideoSource',
    subtitlesSourceName: config.subtitlesSourceName ?? 'Subtitles',
    gameAudioSourceName: config.gameAudioSourceName ?? 'GameAudio',
    autoReconnect: config.autoReconnect ?? true,
  };
}

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
      default:
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

  async provisionBrowserSource(config: OBSBrowserSourceConfig): Promise<OBSMagicConnectResult> {
    const sourceName = config.sourceName || 'AI IDOL Streamer';
    const width = config.width || DEFAULT_VIDEO_PRESET.width;
    const height = config.height || DEFAULT_VIDEO_PRESET.height;
    const fps = config.fps || DEFAULT_VIDEO_PRESET.fps;
    this._state.visibleSources.add(sourceName);
    return {
      connected: true,
      sceneName: config.sceneName || this._state.currentScene,
      sourceName,
      sourceUrl: config.url,
      sourceCreated: true,
      sceneItemCreated: true,
      audioRouted: true,
      obsVersion: 'mock',
      videoPreset: { width, height, fps, applied: true, matches: true, streamActive: false },
    };
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

export class OBSWebSocketClient implements OBSClient {
  private _config: Required<OBSConnectionConfig>;
  private _obs = new OBSWebSocket();
  private readonly _listeners: ClientListeners;
  private _connectPromise: Promise<boolean> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelayMs = 2_000;
  private _lastConnectionErrorLogAt = 0;
  private _manualDisconnect = false;
  private _lastBrowserSource: OBSBrowserSourceConfig | null = null;
  private _state: OBSState = {
    connected: false,
    currentScene: '',
    activeMediaFile: '',
    isDucked: false,
    visibleSources: new Set(),
  };

  constructor(config: OBSConnectionConfig = {}, listeners: Partial<ClientListeners> = {}) {
    this._config = normalizedConfig(config);
    this._listeners = {
      onStatusChange: listeners.onStatusChange ?? (() => {}),
      onLog: listeners.onLog ?? (() => {}),
    };
    this._bindConnectionEvents();
  }

  private _bindConnectionEvents(): void {
    this._obs.on('ConnectionClosed', () => {
      const wasConnected = this._state.connected;
      this._state.connected = false;
      if (wasConnected) this._listeners.onStatusChange(false);
      this._scheduleReconnect();
    });
    this._obs.on('ConnectionError', (error) => {
      const now = Date.now();
      if (now - this._lastConnectionErrorLogAt >= 30_000) {
        this._lastConnectionErrorLogAt = now;
        const detail = error instanceof Error && error.message.trim()
          ? error.message
          : `Could not reach ${this._config.url}`;
        this._listeners.onLog('warn', `OBS WebSocket connection error: ${detail}`);
      }
    });
  }

  private _scheduleReconnect(): void {
    if (this._manualDisconnect || !this._config.autoReconnect || this._reconnectTimer) return;
    const delayMs = this._reconnectDelayMs;
    this._reconnectDelayMs = Math.min(30_000, this._reconnectDelayMs * 2);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this.connect().then(async (connected) => {
        if (connected && this._lastBrowserSource) {
          await this.provisionBrowserSource(this._lastBrowserSource);
        }
      }).catch(() => this._scheduleReconnect());
    }, delayMs);
  }

  async configure(config: OBSConnectionConfig): Promise<void> {
    const next = normalizedConfig({ ...this._config, ...config });
    const connectionChanged = next.url !== this._config.url || next.password !== this._config.password;
    const reconnectDisabled = this._config.autoReconnect && !next.autoReconnect;
    this._config = next;
    if (reconnectDisabled && this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._reconnectDelayMs = 2_000;
    }
    if (!connectionChanged) return;
    this._manualDisconnect = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this._state.connected) await this._obs.disconnect().catch(() => {});
    this._state.connected = false;
    this._manualDisconnect = false;
  }

  async connect(): Promise<boolean> {
    if (this._state.connected) return true;
    if (this._connectPromise) return this._connectPromise;
    this._manualDisconnect = false;
    this._connectPromise = (async () => {
      try {
        await this._obs.connect(this._config.url, this._config.password || undefined, { rpcVersion: 1 });
        this._state.connected = true;
        this._reconnectDelayMs = 2_000;
        this._lastConnectionErrorLogAt = 0;
        const scene = await this._obs.call('GetCurrentProgramScene');
        this._state.currentScene = scene.sceneName;
        this._listeners.onStatusChange(true);
        return true;
      } catch (error) {
        this._state.connected = false;
        this._listeners.onStatusChange(false);
        this._scheduleReconnect();
        const message = error instanceof Error && error.message.trim()
          ? error.message
          : `Could not reach OBS WebSocket at ${this._config.url}`;
        throw new Error(message, { cause: error });
      } finally {
        this._connectPromise = null;
      }
    })();
    return this._connectPromise;
  }

  async disconnect(): Promise<void> {
    this._manualDisconnect = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._reconnectDelayMs = 2_000;
    await this._obs.disconnect().catch(() => {});
    this._state.connected = false;
    this._listeners.onStatusChange(false);
  }

  private async _currentScene(): Promise<string> {
    const result = await this._obs.call('GetCurrentProgramScene');
    this._state.currentScene = result.sceneName;
    return result.sceneName;
  }

  private async _setSceneItemVisible(sourceName: string, visible: boolean): Promise<void> {
    const sceneName = await this._currentScene();
    const item = await this._obs.call('GetSceneItemId', { sceneName, sourceName });
    await this._obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: visible });
    if (visible) this._state.visibleSources.add(sourceName);
    else this._state.visibleSources.delete(sourceName);
  }

  async execute(command: OBSCommand): Promise<boolean> {
    if (!this._state.connected) return false;
    try {
      switch (command.action) {
        case 'switch_scene':
          await this._obs.call('SetCurrentProgramScene', { sceneName: command.sceneName });
          this._state.currentScene = command.sceneName;
          break;
        case 'show_source':
          await this._setSceneItemVisible(command.sourceName, true);
          break;
        case 'hide_source':
          await this._setSceneItemVisible(command.sourceName, false);
          break;
        case 'play_media':
          await this._obs.call('TriggerMediaInputAction', { inputName: command.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' });
          break;
        case 'stop_media':
          await this._obs.call('TriggerMediaInputAction', { inputName: command.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' });
          break;
        case 'set_text':
          await this._obs.call('SetInputSettings', { inputName: command.sourceName, inputSettings: { text: command.text }, overlay: true });
          break;
        case 'mute_source':
          await this._obs.call('SetInputMute', { inputName: command.sourceName, inputMuted: true });
          break;
        case 'unmute_source':
          await this._obs.call('SetInputMute', { inputName: command.sourceName, inputMuted: false });
          break;
        case 'duck_audio':
          await this.setDucking(true, command.duckDb);
          break;
        case 'restore_audio':
          await this.setDucking(false);
          break;
      }
      return true;
    } catch (error) {
      this._listeners.onLog('warn', `OBS command ${command.action} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async switchMedia(filePath: string): Promise<boolean> {
    if (!this._state.connected) return false;
    try {
      await this._obs.call('SetInputSettings', {
        inputName: this._config.mediaSourceName,
        inputSettings: { local_file: filePath },
        overlay: true,
      });
      this._state.activeMediaFile = filePath;
      return true;
    } catch {
      return false;
    }
  }

  async setSubtitles(text: string): Promise<boolean> {
    if (!this._state.connected) return false;
    try {
      await this._obs.call('SetInputSettings', {
        inputName: this._config.subtitlesSourceName,
        inputSettings: { text },
        overlay: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  async setDucking(isDucked: boolean, duckDb: number = -12): Promise<boolean> {
    this._state.isDucked = isDucked;
    if (!this._state.connected) return false;
    try {
      await this._obs.call('SetInputVolume', {
        inputName: this._config.gameAudioSourceName,
        inputVolumeDb: isDucked ? duckDb : 0,
      });
      return true;
    } catch {
      return false;
    }
  }

  async provisionBrowserSource(config: OBSBrowserSourceConfig): Promise<OBSMagicConnectResult> {
    this._lastBrowserSource = { ...config };
    await this.connect();
    const sceneName = config.sceneName || await this._currentScene();
    const sourceName = config.sourceName || 'AI IDOL Streamer';
    const sourceSettings = {
      url: config.url,
      width: config.width || DEFAULT_VIDEO_PRESET.width,
      height: config.height || DEFAULT_VIDEO_PRESET.height,
      fps: config.fps || DEFAULT_VIDEO_PRESET.fps,
      reroute_audio: true,
      restart_when_active: true,
      shutdown: false,
    };
    const inputList = await this._obs.call('GetInputList');
    const existingInput = inputList.inputs.find((input) => input['inputName'] === sourceName);
    let sourceCreated = false;
    let sceneItemCreated = false;

    if (existingInput && existingInput['inputKind'] !== 'browser_source') {
      throw new Error(`OBS source "${sourceName}" already exists but is not a Browser Source`);
    }
    let sceneItemId: number;
    if (!existingInput) {
      await this._obs.call('CreateInput', {
        sceneName,
        inputName: sourceName,
        inputKind: 'browser_source',
        inputSettings: sourceSettings,
        sceneItemEnabled: true,
      });
      sourceCreated = true;
      sceneItemCreated = true;
      const item = await this._obs.call('GetSceneItemId', { sceneName, sourceName });
      sceneItemId = item.sceneItemId;
    } else {
      await this._obs.call('SetInputSettings', { inputName: sourceName, inputSettings: sourceSettings, overlay: true });
      try {
        const item = await this._obs.call('GetSceneItemId', { sceneName, sourceName });
        sceneItemId = item.sceneItemId;
        await this._obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: true });
      } catch {
        await this._obs.call('CreateSceneItem', { sceneName, sourceName, sceneItemEnabled: true });
        sceneItemCreated = true;
        const item = await this._obs.call('GetSceneItemId', { sceneName, sourceName });
        sceneItemId = item.sceneItemId;
      }
    }
    const targetWidth = config.width || DEFAULT_VIDEO_PRESET.width;
    const targetHeight = config.height || DEFAULT_VIDEO_PRESET.height;
    const targetFps = config.fps || DEFAULT_VIDEO_PRESET.fps;
    let videoSettings = await this._obs.call('GetVideoSettings');
    const streamStatus = await this._obs.call('GetStreamStatus').catch(() => ({ outputActive: false }));
    const matchesPreset = () => Number(videoSettings.baseWidth) === targetWidth
      && Number(videoSettings.baseHeight) === targetHeight
      && Number(videoSettings.outputWidth) === targetWidth
      && Number(videoSettings.outputHeight) === targetHeight
      && Number(videoSettings.fpsNumerator) / Math.max(1, Number(videoSettings.fpsDenominator)) === targetFps;
    let presetApplied = false;
    if (!matchesPreset() && !streamStatus.outputActive) {
      await this._obs.call('SetVideoSettings', {
        baseWidth: targetWidth,
        baseHeight: targetHeight,
        outputWidth: targetWidth,
        outputHeight: targetHeight,
        fpsNumerator: targetFps,
        fpsDenominator: 1,
      });
      videoSettings = await this._obs.call('GetVideoSettings');
      presetApplied = true;
    }
    await this._obs.call('SetSceneItemTransform', {
      sceneName,
      sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        alignment: 5,
        boundsType: 'OBS_BOUNDS_STRETCH',
        boundsAlignment: 5,
        boundsWidth: Number(videoSettings.baseWidth || DEFAULT_VIDEO_PRESET.width),
        boundsHeight: Number(videoSettings.baseHeight || DEFAULT_VIDEO_PRESET.height),
      },
    });
    await this._obs.call('SetInputMute', { inputName: sourceName, inputMuted: false }).catch(() => {});
    this._state.currentScene = sceneName;
    this._state.visibleSources.add(sourceName);
    const version = await this._obs.call('GetVersion');
    return {
      connected: true,
      sceneName,
      sourceName,
      sourceUrl: config.url,
      sourceCreated,
      sceneItemCreated,
      audioRouted: true,
      obsVersion: String(version.obsVersion || ''),
      videoPreset: {
        width: targetWidth,
        height: targetHeight,
        fps: targetFps,
        applied: presetApplied,
        matches: matchesPreset(),
        streamActive: Boolean(streamStatus.outputActive),
      },
    };
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

export class OBSController {
  private readonly _client: OBSClient;
  private _config: Required<OBSConnectionConfig>;
  private readonly _listeners: OBSControllerListeners;

  constructor(
    config: OBSConnectionConfig = {},
    client?: OBSClient,
    listeners: OBSControllerListeners = {},
  ) {
    this._config = normalizedConfig(config);
    this._listeners = listeners;
    this._client = client ?? new OBSWebSocketClient(this._config, {
      onStatusChange: (connected) => this._listeners.onStatusChange?.(connected),
      onLog: (level, message) => this._log(level, message),
    });
  }

  get client(): OBSClient {
    return this._client;
  }

  get isConnected(): boolean {
    return this._client.getState().connected;
  }

  async configure(config: OBSConnectionConfig): Promise<void> {
    this._config = normalizedConfig({ ...this._config, ...config });
    await this._client.configure?.(this._config);
  }

  async initialize(): Promise<boolean> {
    try {
      const ok = await this._client.connect();
      this._listeners.onStatusChange?.(ok);
      this._log('info', `OBS Controller initialized. Connected: ${ok}`);
      return ok;
    } catch (error) {
      this._listeners.onStatusChange?.(false);
      this._log('warn', `Could not connect to OBS: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async magicConnect(config: OBSBrowserSourceConfig): Promise<OBSMagicConnectResult> {
    if (!this._client.provisionBrowserSource) {
      throw new Error('The configured OBS client cannot create a Browser Source');
    }
    const result = await this._client.provisionBrowserSource(config);
    this._listeners.onStatusChange?.(true);
    this._log('info', `Magic Connect ready: ${result.sourceName} in ${result.sceneName}`);
    return result;
  }

  async switchClip(fileName: string): Promise<boolean> {
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
