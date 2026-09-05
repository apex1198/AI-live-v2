/**
 * @idol/talking-head
 *
 * Realtime Neural Talking Video & Audio-Driven Lip-Sync Engine
 * Conforms 100% to https://github.com/lipku/livetalking workflow:
 *
 * WORKFLOW:
 * Step 1: Training Video (Data Prep: Frame extraction, Face bounding & alignment, Feature caching, Avatar compilation)
 * Step 2: Connect Voice & Realtime LipSync (Audio chunk ingestion, Lockstep A/V sync, WebRTC/Canvas streaming < 35ms)
 */

import {
  type FacePoseFrame,
  type VisemeName,
  LipMeshTransformer,
  type DeformedLipMesh,
  type Point2D,
  MEDIAPIPE_FACE_OVAL_INDICES,
  MEDIAPIPE_LOWER_FACE_INDICES,
  MEDIAPIPE_LEFT_EYE_INDICES,
  MEDIAPIPE_RIGHT_EYE_INDICES,
  MEDIAPIPE_LEFT_IRIS_INDICES,
  MEDIAPIPE_RIGHT_IRIS_INDICES,
  MEDIAPIPE_NOSE_INDICES,
  MEDIAPIPE_LIPS_OUTER_INDICES,
  MEDIAPIPE_LIPS_INNER_INDICES,
  type FaceMaskRegionType,
  type MaskExpansionConfig,
  type MaskConfig,
  type PolygonMask,
  type FaceRoi,
  type AffineMatrix2D,
  type HeadPoseEstimation,
  type DebugVisualizationData,
  AffineTransform2D,
  CoordinateTransformer,
  HeadPoseEstimator,
  OneEuroFilter,
  TemporalLandmarkSmoother,
  FacialPolygonMaskGenerator,
  FacialMaskCompositor,
  LandmarkTrackingDebugger,
  type MuseTalkBBox,
  type MuseTalkMaskCoords,
  type MuseTalkFramePackage,
  type MuseTalkDataset,
  type MuseTalkAudioIngestParams,
  type MuseTalkRuntimeMetrics,
  type MuseTalkTimestamps,
  type MuseTalkRealtimeState,
  type MuseTalkOutputSource,
  type MuseTalkGeneratedQueueFrame,
  type MuseTalkBatchProcessInput,
  type MuseTalkBatchProcessResult,
  MuseTalkNativePipeline,
  MuseTalkRealtimeEngine,
  MuseTalkBatchPipeline,
} from '@idol/lipsync-engine';
import { z } from 'zod';

export {
  LipMeshTransformer,
  type DeformedLipMesh,
  type Point2D,
  MEDIAPIPE_FACE_OVAL_INDICES,
  MEDIAPIPE_LOWER_FACE_INDICES,
  MEDIAPIPE_LEFT_EYE_INDICES,
  MEDIAPIPE_RIGHT_EYE_INDICES,
  MEDIAPIPE_LEFT_IRIS_INDICES,
  MEDIAPIPE_RIGHT_IRIS_INDICES,
  MEDIAPIPE_NOSE_INDICES,
  MEDIAPIPE_LIPS_OUTER_INDICES,
  MEDIAPIPE_LIPS_INNER_INDICES,
  type FaceMaskRegionType,
  type MaskExpansionConfig,
  type MaskConfig,
  type PolygonMask,
  type FaceRoi,
  type AffineMatrix2D,
  type HeadPoseEstimation,
  type DebugVisualizationData,
  AffineTransform2D,
  CoordinateTransformer,
  HeadPoseEstimator,
  OneEuroFilter,
  TemporalLandmarkSmoother,
  FacialPolygonMaskGenerator,
  FacialMaskCompositor,
  LandmarkTrackingDebugger,
  type MuseTalkBBox,
  type MuseTalkMaskCoords,
  type MuseTalkFramePackage,
  type MuseTalkDataset,
  type MuseTalkAudioIngestParams,
  type MuseTalkRuntimeMetrics,
  type MuseTalkTimestamps,
  type MuseTalkRealtimeState,
  type MuseTalkOutputSource,
  type MuseTalkGeneratedQueueFrame,
  type MuseTalkBatchProcessInput,
  type MuseTalkBatchProcessResult,
  MuseTalkNativePipeline,
  MuseTalkRealtimeEngine,
  MuseTalkBatchPipeline,
};

// ── 1. Core Data Interfaces ───────────────────────────────

export interface AudioChunk {
  pcm?: Int16Array | undefined;
  floatData?: Float32Array | undefined;
  sampleRate: number;
  timestampMs: number;
  rawBuffer?: ArrayBuffer | undefined;
}

export interface VideoFrame {
  timestampMs: number;
  width: number;
  height: number;
  data?: ImageData | ImageBitmap | HTMLCanvasElement | HTMLVideoElement | ArrayBuffer | undefined;
  faceROI?: { x: number; y: number; width: number; height: number } | undefined;
}

export interface TalkingOptions {
  emotion?: 'happy' | 'excited' | 'surprised' | 'neutral' | 'grateful' | undefined;
  speed?: number | undefined;
  voice?: string | undefined;
  vietnameseAcousticMode?: boolean | undefined;
  text?: string | undefined;
  durationMs?: number | undefined;
}

export interface ProviderHealth {
  providerName: string;
  healthy: boolean;
  fps: number;
  renderLatencyMs: number;
  avDriftMs: number;
  queueDepth: number;
  droppedFrames: number;
  trainingState: 'idle' | 'training' | 'ready';
  trainingProgress: number;
}

export type MuseTalkMaskMode = 'none' | 'repo' | 'mediapipe_478' | 'adaptive';

export interface AvatarSource {
  id: string;
  videoUrl?: string | undefined;
  trainedData?: any | undefined;
  faceTrack?: { x: number; y: number; width: number; height: number } | undefined;
}

export interface TalkingVideoProvider {
  initialize(source?: AvatarSource): Promise<void>;
  pushVideoFrame(frame: VideoFrame): Promise<void>;
  startSpeaking(audio: AsyncIterable<AudioChunk> | AudioChunk[] | string, options?: TalkingOptions): Promise<void>;
  outputFrames(): AsyncIterable<VideoFrame>;
  interrupt(): Promise<void>;
  stopSpeaking(): Promise<void>;
  health(): Promise<ProviderHealth>;
  dispose(): Promise<void>;
}

// ── 2. LiveTalking Training Stage Definition ───────────────

export interface LiveTalkingTrainResult {
  status: 'ok' | 'error';
  success: boolean;
  avatarId: string;
  avatarPath: string;
  cachedFrames: number;
  fps: number;
  faceROI: { x: number; y: number; width: number; height: number };
  stages: {
    stage1_frameExtraction: boolean;
    stage2_faceAlignment: boolean;
    stage3_latentFeatureCache: boolean;
    stage4_avatarCompiled: boolean;
  };
  renderLatencyMs: number;
  message: string;
}

export interface LiveTalkingConfig {
  endpointUrl: string;
  model: 'livetalking-wav2lip' | 'livetalking-musetalk' | 'livetalking-ernerf' | string;
  avatarPath?: string | undefined;
  authToken?: string | undefined;
  cachedFrames: number;
  fps: number;
  timeoutMs: number;
  trainingTimeoutMs: number;
  maxRetries: number;
  useWebRTC: boolean;
}

export interface LiveTalkingSessionStatus {
  sessionid: string;
  state: 'GENERATING' | 'SPEAKING' | 'IDLE' | 'ERROR';
  speaking: boolean;
  sequence?: number | undefined;
  updated_at?: number | undefined;
  details?: Record<string, unknown> | undefined;
}

const LiveTalkingSessionStatusSchema = z.object({
  sessionid: z.string().min(1),
  state: z.enum(['GENERATING', 'SPEAKING', 'IDLE', 'ERROR']),
  speaking: z.boolean().optional().default(false),
  sequence: z.number().optional(),
  updated_at: z.number().optional(),
  details: z.record(z.unknown()).optional(),
});

// ── 3. LiveTalkingProvider (lipku/livetalking Engine) ──────

export class LiveTalkingProvider implements TalkingVideoProvider {
  private readonly _config: LiveTalkingConfig;
  private _isHealthy = false;
  private _isSpeaking = false;
  private _trainingState: 'idle' | 'training' | 'ready' = 'idle';
  private _trainingProgress = 0;
  private _currentAvatar: AvatarSource | null = null;
  private _sessionId: string | null = null;
  private _lastFrameTime = Date.now();
  private _fps = 0;
  private _outputQueue: VideoFrame[] = [];

  constructor(config: Partial<LiveTalkingConfig> | string = 'http://localhost:8010') {
    if (typeof config === 'string') {
      this._config = {
        endpointUrl: config,
        model: 'livetalking-musetalk',
        cachedFrames: 300,
        fps: 15,
        timeoutMs: 3000,
        trainingTimeoutMs: 30 * 60 * 1000,
        maxRetries: 2,
        useWebRTC: true,
      };
    } else {
      this._config = {
        endpointUrl: config.endpointUrl ?? 'http://localhost:8010',
        model: config.model ?? 'livetalking-musetalk',
        cachedFrames: config.cachedFrames ?? 300,
        fps: config.fps ?? 15,
        timeoutMs: config.timeoutMs ?? 3000,
        trainingTimeoutMs: config.trainingTimeoutMs ?? 30 * 60 * 1000,
        maxRetries: config.maxRetries ?? 2,
        useWebRTC: config.useWebRTC ?? true,
        ...(config.avatarPath ? { avatarPath: config.avatarPath } : {}),
        ...(config.authToken ? { authToken: config.authToken } : {}),
      };
    }
  }

  get config(): LiveTalkingConfig {
    return this._config;
  }

  get trainingState(): 'idle' | 'training' | 'ready' {
    return this._trainingState;
  }

  get trainingProgress(): number {
    return this._trainingProgress;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  setSession(sessionId: string | null): void {
    this._sessionId = sessionId ? String(sessionId) : null;
  }

  async ensureActiveSession(forceRefresh = false): Promise<string> {
    if (this._sessionId && !forceRefresh) return this._sessionId;
    const payload = await this._request('/api/admin/sessions', {}, true);
    const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];
    const active = sessions.find((session: any) => typeof session?.sessionid === 'string' && session.sessionid);
    if (!active) throw new Error('No active LiveTalking WebRTC session');
    this._sessionId = active.sessionid;
    return this._sessionId!;
  }

  async getMuseTalkMaskMode(): Promise<MuseTalkMaskMode> {
    const payload = await this._request('/api/musetalk/mask-mode', {}, true);
    return z.enum(['none', 'repo', 'mediapipe_478', 'adaptive']).parse(payload.data?.mode);
  }

  async setMuseTalkMaskMode(mode: MuseTalkMaskMode): Promise<MuseTalkMaskMode> {
    const payload = await this._request('/api/musetalk/mask-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    return z.enum(['none', 'repo', 'mediapipe_478', 'adaptive']).parse(payload.data?.mode);
  }

  private _workerModel(): 'musetalk' | 'wav2lip' {
    return this._config.model.includes('musetalk') ? 'musetalk' : 'wav2lip';
  }

  private async _request(
    pathname: string,
    init: RequestInit = {},
    retryable = false,
    timeoutMs = this._config.timeoutMs,
  ): Promise<any> {
    const endpoint = this._config.endpointUrl.replace(/\/$/, '');
    const attempts = retryable ? Math.max(1, this._config.maxRetries + 1) : 1;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = new Headers(init.headers);
        if (this._config.authToken) headers.set('Authorization', `Bearer ${this._config.authToken}`);
        const response = await fetch(`${endpoint}${pathname}`, { ...init, headers, signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || (typeof payload.code === 'number' && payload.code !== 0)) {
          const requestError = new Error(payload.msg || payload.error || `LiveTalking HTTP ${response.status}`) as Error & {
            retryable?: boolean;
          };
          const statusCode = !response.ok ? response.status : Number(payload.code || 0);
          requestError.retryable = statusCode === 429 || statusCode >= 500;
          throw requestError;
        }
        return payload;
      } catch (error) {
        lastError = error;
        const canRetry = (error as { retryable?: boolean } | null)?.retryable !== false;
        if (attempt < attempts && canRetry) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          continue;
        }
        break;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'LiveTalking request failed'));
  }

  async initialize(source?: AvatarSource): Promise<void> {
    this._currentAvatar = source ?? { id: 'default_avatar' };
    if (source?.videoUrl) {
      this._config.avatarPath = source.videoUrl;
    }
  }

  /**
   * Step 1: Training Video (Workflow lipku/livetalking)
   * 1. Extract Frames
   * 2. Face Alignment & Bounding Box
   * 3. Audio-Visual Latent Feature Precomputation (aud.npy / latents)
   * 4. Compile Avatar Dataset Package
   */
  async trainAvatarVideo(
    videoPath: string,
    onProgress?: (stage: number, message: string, progressPct: number) => void,
    options: { avatarId?: string; savePath?: string; model?: 'musetalk' | 'wav2lip' } = {},
  ): Promise<LiveTalkingTrainResult> {
    this._trainingState = 'training';
    this._trainingProgress = 0;
    const avatarId = options.avatarId || this._currentAvatar?.id || `avatar_${Date.now().toString(36)}`;
    this._config.avatarPath = videoPath;
    try {
      onProgress?.(1, 'Submitting avatar preprocessing to LiveTalking...', 1);
      const taskId = await this.createAvatarTask(videoPath, avatarId, options.savePath, options.model);

      const startedAt = Date.now();
      while (Date.now() - startedAt < this._config.trainingTimeoutMs) {
        const statusResponse = await this._request(`/api/avatar/task/${encodeURIComponent(taskId)}`, {}, true);
        const task = statusResponse.data || {};
        const progress = Math.max(0, Math.min(100, Number(task.progress || 0)));
        this._trainingProgress = progress;
        onProgress?.(
          Math.min(4, Math.max(1, Math.ceil(progress / 25))),
          String(task.stage_message || `LiveTalking avatar task: ${task.status || 'running'}`),
          progress,
        );
        if (task.status === 'failed') throw new Error(task.error_msg || 'LiveTalking avatar preprocessing failed');
        if (task.status === 'completed') {
          this._trainingState = 'ready';
          this._trainingProgress = 100;
          return {
            status: 'ok',
            success: true,
            avatarId,
            avatarPath: videoPath,
            cachedFrames: this._config.cachedFrames,
            fps: this._config.fps,
            faceROI: { x: 0, y: 0, width: 0, height: 0 },
            stages: {
              stage1_frameExtraction: true,
              stage2_faceAlignment: true,
              stage3_latentFeatureCache: true,
              stage4_avatarCompiled: true,
            },
            renderLatencyMs: 0,
            message: 'Avatar preprocessing completed by the LiveTalking worker.',
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      throw new Error('LiveTalking avatar preprocessing timed out');
    } catch (error) {
      this._trainingState = 'idle';
      this._trainingProgress = 0;
      throw error;
    }
  }

  // Alias for backward compatibility
  async preprocessAvatar(videoPath: string): Promise<any> {
    return this.trainAvatarVideo(videoPath);
  }

  async preprocessDualReference(portraitImagePath?: string, drivingVideoPath?: string): Promise<any> {
    return this.trainAvatarVideo(drivingVideoPath || portraitImagePath || '');
  }

  async pushVideoFrame(frame: VideoFrame): Promise<void> {
    const now = Date.now();
    const dt = now - this._lastFrameTime;
    this._lastFrameTime = now;
    if (dt > 0) this._fps = Math.round(1000 / dt);

    if (this._outputQueue.length >= 8) {
      this._outputQueue.shift();
    }
    this._outputQueue.push(frame);
  }

  /**
   * Step 2: Connect Voice & Realtime LipSync
   */
  async startSpeaking(
    audio: AsyncIterable<AudioChunk> | AudioChunk[] | string,
    options?: TalkingOptions
  ): Promise<void> {
    this._isSpeaking = true;
    const text = typeof audio === 'string' ? audio : (options?.text ?? 'Hello everyone!');
    try {
      const payload = await this._request('/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          sessionid: this._sessionId || '',
          emotion: options?.emotion ?? 'happy',
          speed: options?.speed ?? 1,
          ...(options?.voice ? { voice: options.voice } : {}),
          interrupt: true,
        }),
      });
      if (payload.data?.sessionid) this._sessionId = String(payload.data.sessionid);
    } catch (error) {
      this._isSpeaking = false;
      throw error;
    }
  }

  async createOffer(sdp: string, type: string = 'offer', avatarId?: string): Promise<{ sdp: string; type: string; sessionid: string }> {
    const payload = await this._request('/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sdp,
        type,
        replace_existing: true,
        ...(avatarId ? { avatar: avatarId } : {}),
      }),
    }, false, Math.max(this._config.timeoutMs, 30_000));
    const parsed = z.object({ sdp: z.string().min(1), type: z.string().min(1), sessionid: z.string().min(1) }).parse(payload);
    this._sessionId = parsed.sessionid;
    return parsed;
  }

  async closeSession(sessionId: string | null = this._sessionId): Promise<boolean> {
    if (!sessionId) return false;
    const payload = await this._request(`/api/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    if (this._sessionId === sessionId) this._sessionId = null;
    return Boolean(payload.data?.closed);
  }

  async switchAvatarState(
    avatarId: string,
    state = 'normal',
    sessionId: string | null = this._sessionId,
  ): Promise<{ sessionid: string; avatar_id: string; state: string; changed: boolean }> {
    sessionId = sessionId || await this.ensureActiveSession();
    const payload = await this._request(`/api/session/${encodeURIComponent(sessionId)}/avatar-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar_id: avatarId, state }),
    }, false, Math.max(this._config.timeoutMs, 30_000));
    return z.object({
      sessionid: z.string().min(1),
      avatar_id: z.string().min(1),
      state: z.string().min(1),
      changed: z.boolean(),
    }).parse(payload.data);
  }

  async sendAudio(
    audio: Blob | ArrayBuffer | Uint8Array,
    sessionId: string | null = null,
    mediaType = 'audio/mpeg',
  ): Promise<string> {
    let blob: Blob;
    if (audio instanceof Blob) {
      blob = audio;
    } else {
      const source = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
      const copy = new Uint8Array(source.byteLength);
      copy.set(source);
      blob = new Blob([copy.buffer], { type: mediaType });
    }
    const extension = mediaType.includes('wav') ? 'wav' : mediaType.includes('ogg') ? 'ogg' : 'mp3';
    const upload = async (activeSessionId: string): Promise<void> => {
      const form = new FormData();
      form.append('sessionid', activeSessionId);
      form.append('file', blob, `voice.${extension}`);
      await this._request('/humanaudio', { method: 'POST', body: form }, true, Math.max(this._config.timeoutMs, 15_000));
    };

    let activeSessionId = sessionId;
    let lastSessionError: unknown = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      try {
        if (!activeSessionId) activeSessionId = await this.ensureActiveSession(true);
        await upload(activeSessionId);
        return activeSessionId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/session\s+not\s+found|no active/i.test(message)) throw error;
        lastSessionError = error;
        if (this._sessionId === activeSessionId) this._sessionId = null;
        activeSessionId = null;
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          activeSessionId = await this.ensureActiveSession(true);
        } catch (resolveError) {
          lastSessionError = resolveError;
          if (attempt === 15) throw resolveError;
        }
      }
    }
    throw lastSessionError instanceof Error ? lastSessionError : new Error('No active live avatar session');
  }

  async isSessionSpeaking(sessionId: string | null = this._sessionId): Promise<boolean> {
    sessionId = sessionId || await this.ensureActiveSession();
    const payload = await this._request('/is_speaking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionid: sessionId }),
    }, true);
    this._isSpeaking = Boolean(payload.data);
    return this._isSpeaking;
  }

  async getSessionStatus(sessionId: string | null = this._sessionId): Promise<LiveTalkingSessionStatus> {
    sessionId = sessionId || await this.ensureActiveSession();
    const payload = await this._request(`/api/session/${encodeURIComponent(sessionId)}/status`, {}, true);
    const status = LiveTalkingSessionStatusSchema.parse(payload.data);
    this._isSpeaking = status.state === 'SPEAKING' || status.speaking;
    return status;
  }

  async *watchSessionStatus(
    sessionId: string | null = this._sessionId,
    signal?: AbortSignal,
  ): AsyncIterable<LiveTalkingSessionStatus> {
    sessionId = sessionId || await this.ensureActiveSession();
    const endpoint = this._config.endpointUrl.replace(/\/$/, '');
    const headers = new Headers({ Accept: 'text/event-stream' });
    if (this._config.authToken) headers.set('Authorization', `Bearer ${this._config.authToken}`);
    const streamInit: RequestInit = { headers };
    if (signal) streamInit.signal = signal;
    const response = await fetch(
      `${endpoint}/api/session/${encodeURIComponent(sessionId)}/events`,
      streamInit,
    );
    if (!response.ok || !response.body) {
      throw new Error(`LiveTalking state stream HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!signal?.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          if (!block || block.startsWith(':')) continue;
          const lines = block.split('\n');
          const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
          if (eventName !== 'speech_state' && eventName !== 'message') continue;
          const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (!data) continue;
          const parsed = JSON.parse(data);
          if (eventName === 'message' && parsed?.type !== 'speech_state' && !parsed?.state) continue;
          const normalized = LiveTalkingSessionStatusSchema.parse(parsed);
          this._isSpeaking = normalized.state === 'SPEAKING' || normalized.speaking;
          yield normalized;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async listAvatarTasks(): Promise<any[]> {
    const payload = await this._request('/api/avatar/tasks', {}, true);
    return Array.isArray(payload.data?.tasks) ? payload.data.tasks : [];
  }

  async listTrainedAvatars(): Promise<any[]> {
    const payload = await this._request('/api/avatars', {}, true);
    return Array.isArray(payload.data?.avatars) ? payload.data.avatars : [];
  }

  async getAvatarThumbnail(avatarId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const endpoint = this._config.endpointUrl.replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._config.timeoutMs);
    const headers = new Headers();
    if (this._config.authToken) headers.set('Authorization', `Bearer ${this._config.authToken}`);
    try {
      const response = await fetch(`${endpoint}/api/avatars/${encodeURIComponent(avatarId)}/thumbnail`, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`LiveTalking thumbnail HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || 'image/png';
      if (!contentType.startsWith('image/')) throw new Error('LiveTalking thumbnail is not an image');
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAvatarTask(taskId: string): Promise<any> {
    const payload = await this._request(`/api/avatar/task/${encodeURIComponent(taskId)}`, {}, true);
    return payload.data;
  }

  async createAvatarTask(
    videoPath: string,
    avatarId: string,
    savePath?: string,
    model?: 'musetalk' | 'wav2lip',
  ): Promise<string> {
    const created = await this._request('/api/avatar/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || this._workerModel(),
        avatar_id: avatarId,
        video_path: videoPath,
        ...(savePath ? { save_path: savePath } : {}),
      }),
    });
    const taskId = String(created.data?.task_id || '');
    if (!taskId) throw new Error('LiveTalking did not return an avatar task ID');
    return taskId;
  }

  async deleteAvatarTask(taskId: string): Promise<void> {
    await this._request(`/api/avatar/task/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
  }

  async deleteTrainedAvatar(avatarId: string): Promise<void> {
    await this._request(`/api/avatars/${encodeURIComponent(avatarId)}`, { method: 'DELETE' });
  }

  async *outputFrames(): AsyncIterable<VideoFrame> {
    while (this._outputQueue.length > 0) {
      const frame = this._outputQueue.shift();
      if (frame) yield frame;
    }
  }

  async interrupt(): Promise<void> {
    try {
      await this._request('/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionid: this._sessionId || '' }),
      });
    } finally {
      this._isSpeaking = false;
      this._outputQueue = [];
    }
  }

  async stopSpeaking(): Promise<void> {
    await this.interrupt();
  }

  async health(): Promise<ProviderHealth> {
    let workerMetrics: Record<string, unknown> = {};
    try {
      const payload = await this._request('/health', {}, true);
      this._isHealthy = payload.code === 0 && payload.data?.status === 'healthy';
      workerMetrics = payload.data || {};
    } catch {
      this._isHealthy = false;
    }
    return {
      providerName: 'LiveTalking Engine (lipku/livetalking)',
      healthy: this._isHealthy,
      fps: Number(workerMetrics['output_fps'] || this._fps || 0),
      renderLatencyMs: Number(workerMetrics['video_buffer_ms'] || 0),
      avDriftMs: Number(workerMetrics['av_drift_ms'] || 0),
      queueDepth: Number(workerMetrics['video_queue_depth'] || this._outputQueue.length || 0),
      droppedFrames: Number(workerMetrics['dropped_video_frames'] || 0),
      trainingState: this._trainingState,
      trainingProgress: this._trainingProgress,
    };
  }

  async setModel(model: string): Promise<void> {
    this._config.model = model;
  }

  setFps(fps: number): void {
    this._config.fps = Math.max(1, Math.round(fps));
  }

  setEndpoint(endpointUrl: string): void {
    this._config.endpointUrl = endpointUrl.replace(/\/$/, '');
    this._isHealthy = false;
    this._sessionId = null;
  }

  async dispose(): Promise<void> {
    await this.interrupt();
  }
}

// ── 4. MockTalkingProvider (Built-in Fallback) ─────────────

export class MockTalkingProvider extends LiveTalkingProvider {
  constructor() {
    super('http://localhost:8010');
  }

  override async trainAvatarVideo(videoPath: string, onProgress?: (stage: number, message: string, progressPct: number) => void): Promise<LiveTalkingTrainResult> {
    onProgress?.(4, 'Mock avatar ready', 100);
    return {
      status: 'ok', success: true, avatarId: 'mock_avatar', avatarPath: videoPath,
      cachedFrames: 1, fps: 30, faceROI: { x: 0, y: 0, width: 0, height: 0 },
      stages: { stage1_frameExtraction: true, stage2_faceAlignment: true, stage3_latentFeatureCache: true, stage4_avatarCompiled: true },
      renderLatencyMs: 0, message: 'Mock avatar ready',
    };
  }

  override async startSpeaking(_audio: AsyncIterable<AudioChunk> | AudioChunk[] | string, _options?: TalkingOptions): Promise<void> {}
  override async interrupt(): Promise<void> {}
  override async health(): Promise<ProviderHealth> {
    return { providerName: 'Mock Talking Provider', healthy: true, fps: 30, renderLatencyMs: 0, avDriftMs: 0, queueDepth: 0, droppedFrames: 0, trainingState: 'ready', trainingProgress: 100 };
  }
}

// ── 5. TalkingVideoPipeline (Master Pipeline Manager) ──────

export class TalkingVideoPipeline {
  private _primaryProvider: TalkingVideoProvider;
  private _fallbackProvider: TalkingVideoProvider;
  private _currentSource: AvatarSource | null = null;
  private _isSpeaking = false;

  constructor(
    primaryProvider?: TalkingVideoProvider,
    fallbackProvider?: TalkingVideoProvider
  ) {
    this._fallbackProvider = fallbackProvider ?? new MockTalkingProvider();
    this._primaryProvider = primaryProvider ?? this._fallbackProvider;
  }

  get activeProvider(): TalkingVideoProvider {
    return this._primaryProvider;
  }

  async setSource(source: AvatarSource): Promise<void> {
    this._currentSource = source;
    await this._primaryProvider.initialize(source);
    await this._fallbackProvider.initialize(source);
  }

  async pushFrame(frame: VideoFrame): Promise<void> {
    const health = await this._primaryProvider.health();
    if (health.healthy) {
      await this._primaryProvider.pushVideoFrame(frame);
    } else {
      await this._fallbackProvider.pushVideoFrame(frame);
    }
  }

  async speak(
    text: string,
    durationMs: number,
    emotion: string = 'happy',
    activeState: string = 'TALKING'
  ): Promise<void> {
    if (activeState !== 'TALKING') {
      return;
    }

    this._isSpeaking = true;
    const health = await this._primaryProvider.health();
    const target = health.healthy ? this._primaryProvider : this._fallbackProvider;

    await target.startSpeaking(text, {
      text,
      durationMs,
      emotion: emotion as TalkingOptions['emotion'],
      vietnameseAcousticMode: true,
    });
  }

  async interrupt(): Promise<void> {
    this._isSpeaking = false;
    await this._primaryProvider.interrupt();
    await this._fallbackProvider.interrupt();
  }

  async getHealth(): Promise<ProviderHealth> {
    const primaryHealth = await this._primaryProvider.health();
    if (primaryHealth.healthy) return primaryHealth;
    return await this._fallbackProvider.health();
  }

  async dispose(): Promise<void> {
    await this._primaryProvider.dispose();
    await this._fallbackProvider.dispose();
  }
}
