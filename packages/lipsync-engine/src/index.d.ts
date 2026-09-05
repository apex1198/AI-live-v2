/**
 * @idol/lipsync-engine
 *
 * Vietnamese Phoneme-to-Viseme Acoustic Engine & Real-time Lip-Sync Generator.
 * Computes exact 60FPS facial blendshapes for accurate AI Idol lipsync.
 */
export type VisemeName = 'sil' | 'aa' | 'E' | 'ih' | 'oh' | 'ou' | 'PP' | 'FF' | 'TH' | 'DD' | 'kk' | 'CH' | 'SS';
export interface VisemeKeyframe {
    timeMs: number;
    durationMs: number;
    viseme: VisemeName;
    word: string;
    weight: number;
}
export interface FacePoseFrame {
    timestampMs: number;
    viseme: VisemeName;
    mouthOpen: number;
    mouthWide: number;
    mouthPucker: number;
    jawOpen: number;
    smile: number;
    eyeBlinkLeft: number;
    eyeBlinkRight: number;
    eyebrowRaise: number;
    headPitch: number;
    headYaw: number;
    headRoll: number;
    currentWord: string;
    wordProgress: number;
}
export interface VisemeProfile {
    mouthOpen: number;
    mouthWide: number;
    mouthPucker: number;
    jawOpen: number;
}
export declare const VISEME_PROFILES: Record<VisemeName, VisemeProfile>;
export declare class VietnamesePhonemeConverter {
    /**
     * Converts a single Vietnamese word / syllable into a sequence of Visemes with relative weights.
     */
    static wordToVisemes(word: string): Array<{
        viseme: VisemeName;
        relativeDuration: number;
        weight: number;
    }>;
}
export declare class LipSyncTimelineGenerator {
    /**
     * Generates a fully timed sequence of Viseme Keyframes from spoken Vietnamese text and speech duration.
     */
    static generateTimeline(text: string, totalDurationMs: number): VisemeKeyframe[];
}
export declare class LipSyncEngine {
    private _keyframes;
    private _speechStartedAt;
    private _speechDurationMs;
    private _isPlaying;
    private _currentEmotion;
    private _currentPose;
    /**
     * Starts a new lipsync animation sequence for the given spoken text and duration.
     */
    startSpeech(text: string, durationMs: number, emotion?: string): void;
    stopSpeech(): void;
    get isPlaying(): boolean;
    /**
     * Computes the exact FacePoseFrame for the current playback timestamp.
     * @param now Current timestamp in ms (defaults to Date.now())
     * @param audioRms Optional audio amplitude (0.0 to 1.0) from Web Audio Analyser
     */
    computeFrame(now?: number, audioRms?: number): FacePoseFrame;
    private _computeIdleFrame;
}
export declare const MEDIAPIPE_LIPS_OUTER_INDICES: number[];
export declare const MEDIAPIPE_LIPS_INNER_INDICES: number[];
export interface Point2D {
    x: number;
    y: number;
    z?: number | undefined;
}
export interface DeformedLipMesh {
    outerLips: Point2D[];
    innerLips: Point2D[];
    mouthOpenDistance: number;
    upperLipMid: Point2D;
    lowerLipMid: Point2D;
    leftCorner: Point2D;
    rightCorner: Point2D;
}
export declare class LipMeshTransformer {
    /**
     * Deforms 40 MediaPipe Lip Landmark points dynamically according to FacePoseFrame and Audio Amplitude.
     * Directly uses exact landmark indices (Outer 21 points, Inner 21 points) for anatomical polygon warping.
     */
    static deformLipPoints(landmarks: Point2D[], pose: FacePoseFrame, audioAmplitude?: number, mouthHeightScale?: number): DeformedLipMesh;
}
export declare const MEDIAPIPE_FACE_OVAL_INDICES: number[];
export declare const MEDIAPIPE_LOWER_FACE_INDICES: number[];
export declare const MEDIAPIPE_LEFT_EYE_INDICES: number[];
export declare const MEDIAPIPE_RIGHT_EYE_INDICES: number[];
export declare const MEDIAPIPE_LEFT_IRIS_INDICES: number[];
export declare const MEDIAPIPE_RIGHT_IRIS_INDICES: number[];
export declare const MEDIAPIPE_NOSE_INDICES: number[];
export declare const FACEMESH_468_TRIANGLES: [number, number, number][];
export declare const CANONICAL_468_LANDMARKS: [number, number, number][];
export declare const FACEMESH_TOPOLOGY: {
    LIPS_OUTER: number[];
    LIPS_INNER: number[];
    FACE_OVAL: number[];
    LOWER_FACE: number[];
    LEFT_EYE: number[];
    RIGHT_EYE: number[];
    NOSE_BRIDGE: number[];
};
export declare function generateCanonicalLandmarks468_3D(faceBox?: {
    cx: number;
    cy: number;
    w: number;
    h: number;
}, pose3D?: {
    roll?: number;
    pitch?: number;
    yaw?: number;
}): Point2D[];
export type FaceMaskRegionType = 'FACE_OVAL_MASK' | 'LOWER_FACE_MASK' | 'MOUTH_MASK' | 'EYE_MASK' | 'CUSTOM_MASK';
export interface MaskExpansionConfig {
    top: number;
    bottom: number;
    left: number;
    right: number;
    unit?: 'px' | 'normalized';
}
export interface MaskConfig {
    regionType: FaceMaskRegionType;
    expansion: MaskExpansionConfig;
    featherRadiusPx: number;
    temporalSmoothingAlpha: number;
    customIndices?: number[];
}
export interface PolygonMask {
    points: Point2D[];
    boundingRect: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    featherRadiusPx: number;
    regionType: FaceMaskRegionType;
}
export interface BoundingBox {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface FaceRoi {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
}
export interface AffineMatrix2D {
    a: number;
    b: number;
    c: number;
    d: number;
    tx: number;
    ty: number;
}
export declare class AffineTransform2D {
    static create(a: number, b: number, c: number, d: number, tx: number, ty: number): AffineMatrix2D;
    static identity(): AffineMatrix2D;
    static inverse(m: AffineMatrix2D): AffineMatrix2D;
    static transformPoint(p: Point2D, m: AffineMatrix2D): Point2D;
    static transformLandmarks(landmarks: Point2D[], m: AffineMatrix2D): Point2D[];
}
export declare class CoordinateTransformer {
    /**
     * Transforms MediaPipe landmarks from inference space to SOURCE_FRAME_SPACE.
     * If MediaPipe ran on full source frame:
     *   source_x = landmark.x * source_width
     *   source_y = landmark.y * source_height
     * If MediaPipe ran on cropped ROI:
     *   source_x = roi.x + landmark.x * roi.width
     *   source_y = roi.y + landmark.y * roi.height
     * If affine transformation was applied:
     *   source = inverse_transform(aligned_landmark)
     */
    static toSourceFrameSpace(landmarks: Point2D[], sourceWidth: number, sourceHeight: number, roi?: FaceRoi, affineMatrix?: AffineMatrix2D): Point2D[];
    /**
     * Transforms landmarks from SOURCE_FRAME_SPACE into PREVIEW_UI_SPACE with aspect-fit letterboxing.
     */
    static toPreviewUiSpace(landmarks: Point2D[], sourceWidth: number, sourceHeight: number, previewWidth: number, previewHeight: number): {
        points: Point2D[];
        scale: number;
        offsetX: number;
        offsetY: number;
        displayWidth: number;
        displayHeight: number;
    };
    /**
     * Transforms coordinates from PREVIEW_UI_SPACE back to SOURCE_FRAME_SPACE.
     */
    static previewToSourceSpace(previewX: number, previewY: number, sourceWidth: number, sourceHeight: number, previewWidth: number, previewHeight: number): Point2D;
}
export interface HeadPoseEstimation {
    faceCenter: Point2D;
    faceWidth: number;
    faceHeight: number;
    roll: number;
    rollDegrees: number;
    yaw: number;
    yawDegrees: number;
    pitch: number;
    pitchDegrees: number;
    leftEye: Point2D;
    rightEye: Point2D;
    noseTip: Point2D;
    mouthCenter: Point2D;
    mouthWidth: number;
    mouthHeight: number;
    chin: Point2D;
    forehead: Point2D;
    boundingBox: BoundingBox;
}
export declare class HeadPoseEstimator {
    /**
     * Estimates 3D head pose and facial geometry directly from SOURCE_FRAME_SPACE landmarks.
     */
    static estimate(landmarks: Point2D[], sourceWidth?: number, sourceHeight?: number): HeadPoseEstimation;
    private static _fallback;
}
export declare class OneEuroFilter {
    private _minCutoff;
    private _beta;
    private _dCutoff;
    private _xPrev;
    private _dxPrev;
    private _tPrev;
    constructor(minCutoff?: number, beta?: number, dCutoff?: number);
    private _smoothingFactor;
    private _exponentialSmoothing;
    filter(x: number, timestampMs?: number): number;
    reset(): void;
}
export declare class TemporalLandmarkSmoother {
    private _smoothedLandmarks;
    private _alpha;
    private _filters;
    private _useOneEuro;
    constructor(alpha?: number, useOneEuro?: boolean);
    setAlpha(alpha: number): void;
    setUseOneEuro(useOneEuro: boolean): void;
    smooth(rawLandmarks: Point2D[], timestampMs?: number): Point2D[];
    reset(): void;
}
export declare class FacialPolygonMaskGenerator {
    /**
     * Generates a polygon-based facial mask according to the configured region type and directional expansion in LOCAL FACE SPACE.
     * Expansion is relative to face dimensions: padding_px = face_width * padding_ratio.
     */
    static generateMask(landmarks: Point2D[], config: MaskConfig, frameWidth?: number, frameHeight?: number): PolygonMask;
}
export interface DebugVisualizationData {
    rawLandmarks?: Point2D[];
    sourceLandmarks?: Point2D[];
    smoothedLandmarks?: Point2D[];
    polygonMask?: PolygonMask;
    pose: HeadPoseEstimation;
    sourceResolution: {
        width: number;
        height: number;
    };
    previewResolution: {
        width: number;
        height: number;
    };
    previewScale: number;
    previewOffset: {
        x: number;
        y: number;
    };
}
export declare class LandmarkTrackingDebugger {
    /**
     * Renders color-coded debug landmarks and telemetry HUD onto preview canvas.
     * RED: Raw MediaPipe landmarks
     * BLUE: Source-frame transformed landmarks
     * GREEN: Temporally smoothed landmarks
     * YELLOW: Final polygon mask
     */
    static renderDebug(ctx: CanvasRenderingContext2D, data: DebugVisualizationData): void;
}
export declare class FacialMaskCompositor {
    /**
     * Applies the polygon mask to a 2D Canvas context with soft Gaussian edge feathering.
     */
    static applyPolygonMask(ctx: CanvasRenderingContext2D, mask: PolygonMask, featherRadiusPx?: number): void;
    /**
     * Composites a generated talking face region back onto the original frame using soft alpha blending.
     */
    static compositeTalkingFace(destinationCtx: CanvasRenderingContext2D, baseImage: CanvasImageSource, talkingFaceImage: CanvasImageSource, mask: PolygonMask, alpha?: number): void;
}
export interface MuseTalkBBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}
export type MuseTalkCoordinateSpace = 'normalized' | 'pixels';
export interface MuseTalkMaskCoords {
    yMin: number;
    yMax: number;
    xMin: number;
    xMax: number;
}
export interface MuseTalkFramePackage {
    frameIndex: number;
    latentIndex: number;
    bboxIndex: number;
    maskIndex: number;
    maskCoordIndex: number;
    bbox: MuseTalkBBox;
    latent: Float32Array | number[];
    mask: {
        topCutoff: number;
        featherHeight: number;
    };
    maskCoords: MuseTalkMaskCoords;
}
export interface MuseTalkMetadata {
    sourceWidth: number;
    sourceHeight: number;
    fps: number;
    frameCount: number;
}
export interface MuseTalkDataset {
    avatarId: string;
    fps: number;
    totalFrames: number;
    sequence: number[];
    bboxList: MuseTalkBBox[];
    latentList: (Float32Array | number[])[];
    maskList: {
        topCutoff: number;
        featherHeight: number;
    }[];
    maskCoordsList: MuseTalkMaskCoords[];
    bboxShift: number;
    /** LiveTalking coords.pkl uses source-frame pixels; browser-created datasets use normalized coordinates. */
    coordinateSpace?: MuseTalkCoordinateSpace;
    metadata?: MuseTalkMetadata;
}
export declare class MuseTalkNativePipeline {
    static normalizeBBox(bbox: MuseTalkBBox, sourceWidth: number, sourceHeight: number, coordinateSpace?: MuseTalkCoordinateSpace): MuseTalkBBox | null;
    /**
     * Generates the standard upstream LiveTalking / MuseTalk ping-pong sequence indices:
     * e.g. for N=5: [0, 1, 2, 3, 4, 3, 2, 1]
     */
    static generatePingPongSequence(frameCount: number): number[];
    /**
     * Returns lockstep synchronized frame, latent, bbox, mask, and mask_coord indices for frame i.
     * Guarantees: frameIndex === latentIndex === bboxIndex === maskIndex === maskCoordIndex ALWAYS.
     */
    static getSynchronizedFramePackage(seqIndex: number, dataset: MuseTalkDataset): MuseTalkFramePackage;
    /**
     * Preprocesses avatar video metadata according to upstream MuseTalk pipeline:
     * - Extracts per-frame bboxes (coord_list_cycle) in AVATAR_SOURCE_SPACE
     * - Caches VAE latents (input_latent_list_cycle)
     * - Caches native lower-face masks (mask_list_cycle)
     * - Caches native mask coordinates (mask_coords_list_cycle)
     * - Records metadata.json with source resolution
     * - Builds ping-pong sequence
     */
    static preprocessDataset(totalFrames: number, rawBboxes: MuseTalkBBox[], fps?: number, bboxShift?: number, avatarId?: string, sourceWidth?: number, sourceHeight?: number): MuseTalkDataset;
    /**
     * Native MuseTalk Face Blending:
     * Reconstructs the generated face region and blends it back into the SAME original video frame
     * at the EXACT corresponding bbox[frame_index].
     *
     * NEVER pastes an isolated 2D mouth.
     * Preserves head perspective, roll, yaw, pitch, skin tone, lighting, and background.
     */
    static blendGeneratedFace(ctx: CanvasRenderingContext2D, frameImage: CanvasImageSource, generatedFaceCrop: CanvasImageSource, bbox: MuseTalkBBox, frameWidth: number, frameHeight: number, maskConfig?: {
        topCutoff: number;
        featherHeight: number;
    }): void;
}
export interface MuseTalkAudioIngestParams {
    text?: string | undefined;
    durationMs?: number | undefined;
    type?: string | undefined;
    samples?: number | undefined;
    blobUrl?: string | null | undefined;
    requestStartTime?: number | undefined;
    audioBuffer?: AudioBuffer | null | undefined;
    audioElement?: HTMLAudioElement | null | undefined;
    onPlaybackStart?: (() => void) | undefined;
}
export type MuseTalkRealtimeState = 'IDLE' | 'AUDIO_PREPARING' | 'MUSETALK_INFERENCE' | 'WAITING_FIRST_FRAME' | 'PLAYING_MUSETALK';
export type MuseTalkOutputSource = 'NONE' | 'IDLE_FRAME' | 'MUSETALK_FRAME';
export interface MuseTalkGeneratedQueueFrame {
    frameIndex: number;
    latentIndex: number;
    bboxIndex: number;
    maskIndex: number;
    maskCoordIndex: number;
    audioChunkIndex: number;
    intensity: number;
    timestamp: number;
}
export interface MuseTalkTimestamps {
    t0: number;
    t1: number;
    t2: number;
    t3: number;
    t4: number;
    t5: number;
    ttsLatencyMs: number;
    audioFeatureLatencyMs: number;
    museTalkFirstFrameLatencyMs: number;
    totalLipSyncLatencyMs: number;
}
export interface MuseTalkRuntimeMetrics {
    state: MuseTalkRealtimeState;
    outputSource: MuseTalkOutputSource;
    bufferedFrames: number;
    startupBufferTarget: number;
    inferenceCount: number;
    generatedFrameCount: number;
    inferenceFps: number;
    audioQueueLength: number;
    audioFeatureChunksLength: number;
    currentAvatarFrame: number;
    currentLatent: number;
    currentAudioChunk: number;
    timestamps: MuseTalkTimestamps;
}
export declare class MuseTalkRealtimeEngine {
    private _state;
    private _outputSource;
    private _audioQueue;
    private _audioFeatureChunks;
    private _generatedFrameQueue;
    private _startupBufferTarget;
    private _inferenceCount;
    private _generatedFrameCount;
    private _lastInferenceTime;
    private _inferenceFps;
    private _currentAvatarFrame;
    private _currentLatent;
    private _currentAudioChunk;
    private _speechStartTime;
    private _speechDurationMs;
    private _onPlaybackStartCallback;
    private _t0;
    private _t1;
    private _t2;
    private _t3;
    private _t4;
    private _t5;
    private _isFirstFrameReady;
    private _isFirstFrameDisplayed;
    get state(): MuseTalkRealtimeState;
    get outputSource(): MuseTalkOutputSource;
    get isFirstFrameReady(): boolean;
    get bufferedFrames(): number;
    get startupBufferTarget(): number;
    set startupBufferTarget(val: number);
    get inferenceCount(): number;
    get generatedFrameCount(): number;
    get inferenceFps(): number;
    get audioQueue(): MuseTalkAudioIngestParams[];
    get audioFeatureChunks(): Array<{
        chunkIndex: number;
        timeSec: number;
        intensity: number;
    }>;
    get timestamps(): MuseTalkTimestamps;
    get metrics(): MuseTalkRuntimeMetrics;
    ingestAudio(params: MuseTalkAudioIngestParams): void;
    stopAudio(): void;
    popNextGeneratedFrame(): MuseTalkGeneratedQueueFrame | null;
    executeInferenceStep(syncPkg: MuseTalkFramePackage): void;
}
export interface MuseTalkBatchProcessInput {
    videoPath?: string;
    audioPath?: string;
    videoBuffer?: Uint8Array | ArrayBuffer;
    audioBuffer?: Uint8Array | ArrayBuffer;
    videoFilename?: string;
    audioFilename?: string;
    outputFps?: number;
    bboxShift?: number;
}
export interface MuseTalkBatchProcessResult {
    status: 'COMPLETED' | 'ERROR';
    totalFramesProcessed: number;
    videoDurationSec: number;
    audioDurationSec: number;
    outputVideoUrl: string;
    outputFilename: string;
    diagnostics: {
        t0_start: number;
        t1_audio_ready: number;
        t2_features_ready: number;
        t3_inference_start: number;
        t4_inference_done: number;
        t5_encoding_done: number;
        totalProcessingTimeMs: number;
        avgFps: number;
    };
    metrics: {
        faceBbox: {
            x1: number;
            y1: number;
            x2: number;
            y2: number;
        };
        totalLatents: number;
        totalAudioChunks: number;
        maskFeathering: number;
    };
    logLines: string[];
}
/**
 * Pure Upstream MuseTalk Batch Video Generation Pipeline
 *
 * Pipeline:
 * avatar.mp4 + test.wav
 *  -> Native Preprocess (coords.pkl, latents.pt, mask_coords.pkl)
 *  -> Audio Feature Extraction (16kHz Whisper / STFT chunks)
 *  -> MuseTalk UNet Face Inference (256x256 upper face conditioned on audio)
 *  -> Native Face Blending (Original resolution canvas composite)
 *  -> Output output.mp4
 *
 * ZERO MediaPipe, ZERO UI masks, ZERO mouth controls, ZERO OBS.
 */
export declare class MuseTalkBatchPipeline {
    private _logs;
    private _log;
    process(input: MuseTalkBatchProcessInput): Promise<MuseTalkBatchProcessResult>;
}
//# sourceMappingURL=index.d.ts.map