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
// ─────────────────────────────────────────────────────────
// 1. Mock OBS Client (For zero-dependency runtime & tests)
// ─────────────────────────────────────────────────────────
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
    get client() {
        return this._client;
    }
    get isConnected() {
        return this._client.getState().connected;
    }
    async initialize() {
        try {
            const ok = await this._client.connect();
            this._listeners.onStatusChange?.(ok);
            this._log('info', `OBS Controller initialized. Connected: ${ok}`);
            return ok;
        }
        catch (err) {
            this._log('warn', `Could not connect to OBS: ${err}`);
            return false;
        }
    }
    async switchClip(fileName) {
        this._log('info', `Switching OBS Media Source to: ${fileName}`);
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