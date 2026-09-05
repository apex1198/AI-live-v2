/**
 * OBS WebSocket v5 controller used by the native AI Idol runtime.
 * The mock client remains injectable so the event pipeline stays deterministic in tests.
 */
import { OBSWebSocket } from 'obs-websocket-js/json';
const DEFAULT_VIDEO_PRESET = Object.freeze({ width: 1280, height: 720, fps: 30 });
function normalizedConfig(config = {}) {
    return {
        url: config.url ?? 'ws://127.0.0.1:4455',
        password: config.password ?? '',
        mediaSourceName: config.mediaSourceName ?? 'IdolVideoSource',
        subtitlesSourceName: config.subtitlesSourceName ?? 'Subtitles',
        gameAudioSourceName: config.gameAudioSourceName ?? 'GameAudio',
        autoReconnect: config.autoReconnect ?? true,
    };
}
export class MockOBSClient {
    _state = {
        connected: false,
        currentScene: 'Main Scene',
        activeMediaFile: 'gameplay_idle_01.mp4',
        isDucked: false,
        visibleSources: new Set(['IdolVideo', 'GameCapture', 'Subtitles']),
    };
    async connect() {
        this._state.connected = true;
        return true;
    }
    async disconnect() {
        this._state.connected = false;
    }
    async execute(command) {
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
    async switchMedia(filePath) {
        this._state.activeMediaFile = filePath;
        return true;
    }
    async setSubtitles(_text) {
        return true;
    }
    async setDucking(isDucked, _duckDb = -12) {
        this._state.isDucked = isDucked;
        return true;
    }
    async provisionBrowserSource(config) {
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
    getState() {
        return {
            connected: this._state.connected,
            currentScene: this._state.currentScene,
            activeMediaFile: this._state.activeMediaFile,
            isDucked: this._state.isDucked,
            visibleSources: new Set(this._state.visibleSources),
        };
    }
}
export class OBSWebSocketClient {
    _config;
    _obs = new OBSWebSocket();
    _listeners;
    _connectPromise = null;
    _reconnectTimer = null;
    _reconnectDelayMs = 2_000;
    _lastConnectionErrorLogAt = 0;
    _manualDisconnect = false;
    _lastBrowserSource = null;
    _state = {
        connected: false,
        currentScene: '',
        activeMediaFile: '',
        isDucked: false,
        visibleSources: new Set(),
    };
    constructor(config = {}, listeners = {}) {
        this._config = normalizedConfig(config);
        this._listeners = {
            onStatusChange: listeners.onStatusChange ?? (() => { }),
            onLog: listeners.onLog ?? (() => { }),
        };
        this._bindConnectionEvents();
    }
    _bindConnectionEvents() {
        this._obs.on('ConnectionClosed', () => {
            const wasConnected = this._state.connected;
            this._state.connected = false;
            if (wasConnected)
                this._listeners.onStatusChange(false);
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
    _scheduleReconnect() {
        if (this._manualDisconnect || !this._config.autoReconnect || this._reconnectTimer)
            return;
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
    async configure(config) {
        const next = normalizedConfig({ ...this._config, ...config });
        const connectionChanged = next.url !== this._config.url || next.password !== this._config.password;
        const reconnectDisabled = this._config.autoReconnect && !next.autoReconnect;
        this._config = next;
        if (reconnectDisabled && this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
            this._reconnectDelayMs = 2_000;
        }
        if (!connectionChanged)
            return;
        this._manualDisconnect = true;
        if (this._reconnectTimer)
            clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        if (this._state.connected)
            await this._obs.disconnect().catch(() => { });
        this._state.connected = false;
        this._manualDisconnect = false;
    }
    async connect() {
        if (this._state.connected)
            return true;
        if (this._connectPromise)
            return this._connectPromise;
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
            }
            catch (error) {
                this._state.connected = false;
                this._listeners.onStatusChange(false);
                this._scheduleReconnect();
                const message = error instanceof Error && error.message.trim()
                    ? error.message
                    : `Could not reach OBS WebSocket at ${this._config.url}`;
                throw new Error(message, { cause: error });
            }
            finally {
                this._connectPromise = null;
            }
        })();
        return this._connectPromise;
    }
    async disconnect() {
        this._manualDisconnect = true;
        if (this._reconnectTimer)
            clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        this._reconnectDelayMs = 2_000;
        await this._obs.disconnect().catch(() => { });
        this._state.connected = false;
        this._listeners.onStatusChange(false);
    }
    async _currentScene() {
        const result = await this._obs.call('GetCurrentProgramScene');
        this._state.currentScene = result.sceneName;
        return result.sceneName;
    }
    async _setSceneItemVisible(sourceName, visible) {
        const sceneName = await this._currentScene();
        const item = await this._obs.call('GetSceneItemId', { sceneName, sourceName });
        await this._obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: visible });
        if (visible)
            this._state.visibleSources.add(sourceName);
        else
            this._state.visibleSources.delete(sourceName);
    }
    async execute(command) {
        if (!this._state.connected)
            return false;
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
        }
        catch (error) {
            this._listeners.onLog('warn', `OBS command ${command.action} failed: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    async switchMedia(filePath) {
        if (!this._state.connected)
            return false;
        try {
            await this._obs.call('SetInputSettings', {
                inputName: this._config.mediaSourceName,
                inputSettings: { local_file: filePath },
                overlay: true,
            });
            this._state.activeMediaFile = filePath;
            return true;
        }
        catch {
            return false;
        }
    }
    async setSubtitles(text) {
        if (!this._state.connected)
            return false;
        try {
            await this._obs.call('SetInputSettings', {
                inputName: this._config.subtitlesSourceName,
                inputSettings: { text },
                overlay: true,
            });
            return true;
        }
        catch {
            return false;
        }
    }
    async setDucking(isDucked, duckDb = -12) {
        this._state.isDucked = isDucked;
        if (!this._state.connected)
            return false;
        try {
            await this._obs.call('SetInputVolume', {
                inputName: this._config.gameAudioSourceName,
                inputVolumeDb: isDucked ? duckDb : 0,
            });
            return true;
        }
        catch {
            return false;
        }
    }
    async provisionBrowserSource(config) {
        this._lastBrowserSource = { ...config };
        await this.connect();
        const sceneName = config.sceneName || await this._currentScene();
        const sourceName = config.sourceName || 'AI IDOL Streamer';
        // OBS owns the output ratio unless the operator explicitly selected a
        // resolution and ratio in AI IDOL's OBS settings. Use the base canvas (the scene coordinate
        // space that is later sent to output) so the browser source fills it at
        // native resolution. Do not overwrite OBS Video Settings during connect.
        let videoSettings = await this._obs.call('GetVideoSettings');
        const streamStatus = await this._obs.call('GetStreamStatus').catch(() => ({ outputActive: false }));
        const requestedWidth = Math.max(1, Number(config.width || DEFAULT_VIDEO_PRESET.width));
        const requestedHeight = Math.max(1, Number(config.height || DEFAULT_VIDEO_PRESET.height));
        const requestedFps = Math.max(1, Number(config.fps || DEFAULT_VIDEO_PRESET.fps));
        const canApplyVideoSettings = Boolean(config.applyVideoSettings && !streamStatus.outputActive);
        if (canApplyVideoSettings) {
            await this._obs.call('SetVideoSettings', {
                baseWidth: requestedWidth,
                baseHeight: requestedHeight,
                outputWidth: requestedWidth,
                outputHeight: requestedHeight,
                fpsNumerator: Math.round(requestedFps),
                fpsDenominator: 1,
            });
            videoSettings = await this._obs.call('GetVideoSettings');
        }
        const targetWidth = Math.max(1, Number(videoSettings.baseWidth || videoSettings.outputWidth || config.width || DEFAULT_VIDEO_PRESET.width));
        const targetHeight = Math.max(1, Number(videoSettings.baseHeight || videoSettings.outputHeight || config.height || DEFAULT_VIDEO_PRESET.height));
        const targetFps = Math.max(1, Number(videoSettings.fpsNumerator) / Math.max(1, Number(videoSettings.fpsDenominator)) || config.fps || DEFAULT_VIDEO_PRESET.fps);
        const videoSettingsMatch = !config.applyVideoSettings
            || (targetWidth === requestedWidth && targetHeight === requestedHeight && Math.round(targetFps) === Math.round(requestedFps));
        const sourceSettings = {
            url: config.url,
            width: targetWidth,
            height: targetHeight,
            fps: targetFps,
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
        let sceneItemId;
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
        }
        else {
            await this._obs.call('SetInputSettings', { inputName: sourceName, inputSettings: sourceSettings, overlay: true });
            try {
                const item = await this._obs.call('GetSceneItemId', { sceneName, sourceName });
                sceneItemId = item.sceneItemId;
                await this._obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: true });
            }
            catch {
                await this._obs.call('CreateSceneItem', { sceneName, sourceName, sceneItemEnabled: true });
                sceneItemCreated = true;
                const item = await this._obs.call('GetSceneItemId', { sceneName, sourceName });
                sceneItemId = item.sceneItemId;
            }
        }
        await this._obs.call('SetSceneItemTransform', {
            sceneName,
            sceneItemId,
            sceneItemTransform: {
                positionX: 0,
                positionY: 0,
                alignment: 5,
                scaleX: 1,
                scaleY: 1,
                // Pass the Monitor frame through unchanged. Do not apply OBS bounds:
                // bounds transforms can re-fit/crop the Browser Source a second time.
                cropLeft: 0,
                cropRight: 0,
                cropTop: 0,
                cropBottom: 0,
                boundsType: 'OBS_BOUNDS_NONE',
                boundsAlignment: 5,
            },
        });
        await this._obs.call('SetInputMute', { inputName: sourceName, inputMuted: false }).catch(() => { });
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
                applied: canApplyVideoSettings,
                matches: videoSettingsMatch,
                streamActive: Boolean(streamStatus.outputActive),
            },
        };
    }
    getState() {
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
    _client;
    _config;
    _listeners;
    constructor(config = {}, client, listeners = {}) {
        this._config = normalizedConfig(config);
        this._listeners = listeners;
        this._client = client ?? new OBSWebSocketClient(this._config, {
            onStatusChange: (connected) => this._listeners.onStatusChange?.(connected),
            onLog: (level, message) => this._log(level, message),
        });
    }
    get client() {
        return this._client;
    }
    get isConnected() {
        return this._client.getState().connected;
    }
    async configure(config) {
        this._config = normalizedConfig({ ...this._config, ...config });
        await this._client.configure?.(this._config);
    }
    async initialize() {
        try {
            const ok = await this._client.connect();
            this._listeners.onStatusChange?.(ok);
            this._log('info', `OBS Controller initialized. Connected: ${ok}`);
            return ok;
        }
        catch (error) {
            this._listeners.onStatusChange?.(false);
            this._log('warn', `Could not connect to OBS: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    async magicConnect(config) {
        if (!this._client.provisionBrowserSource) {
            throw new Error('The configured OBS client cannot create a Browser Source');
        }
        const result = await this._client.provisionBrowserSource(config);
        this._listeners.onStatusChange?.(true);
        this._log('info', `Magic Connect ready: ${result.sourceName} in ${result.sceneName}`);
        return result;
    }
    async switchClip(fileName) {
        return this._client.switchMedia(fileName);
    }
    async setSubtitles(text) {
        return this._client.setSubtitles(text);
    }
    async applyAudioDucking(isDucked, duckDb = -12) {
        return this._client.setDucking(isDucked, duckDb);
    }
    async executeCommand(command) {
        return this._client.execute(command);
    }
    async shutdown() {
        await this._client.disconnect();
        this._listeners.onStatusChange?.(false);
    }
    _log(level, message) {
        this._listeners.onLog?.(level, `[OBSController] ${message}`);
    }
}
//# sourceMappingURL=index.js.map