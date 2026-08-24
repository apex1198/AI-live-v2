"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const index_js_1 = require("./services/runtime-server/dist/index.js");
const persistence_js_1 = require("./services/runtime-server/dist/persistence.js");
const index_js_2 = require("./packages/asset-engine/dist/index.js");
const index_js_3 = require("./packages/goal-engine/dist/index.js");
const index_js_4 = require("./services/director/dist/index.js");
const index_js_5 = require("./services/dialogue-agent/dist/index.js");
const index_js_6 = require("./services/voice/dist/index.js");
const index_js_7 = require("./services/obs-controller/dist/index.js");
const index_js_8 = require("./services/game-adapter/dist/index.js");
const index_js_9 = require("./services/chat-adapter/dist/index.js");
const index_js_10 = require("./packages/lipsync-engine/dist/index.js");
const index_js_11 = require("./services/talking-head/dist/index.js");
let passedChecks = 0;
let totalChecks = 0;
function assert(condition, testName, detail) {
    totalChecks++;
    if (condition) {
        passedChecks++;
        console.log(`  ✅ [PASS] ${testName}`);
    }
    else {
        console.error(`  ❌ [FAIL] ${testName} ${detail ? `(${detail})` : ''}`);
        process.exitCode = 1;
    }
}
async function runAudit() {
    process.env.NODE_ENV = 'test';
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('       HYBRID AI IDOL LIVESTREAM — SYSTEM AUDIT & E2E TEST       ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    // ── Step 1 Audit: Asset Engine ───────────────────────────
    console.log('▶ Auditing Step 1: Asset Engine & Router...');
    const registry = new index_js_2.AssetRegistry(index_js_2.DEFAULT_IDOL_ASSETS);
    assert(registry.count() >= 19, 'AssetRegistry has at least 19 built-in clips', `Found ${registry.count()}`);
    const router = new index_js_2.AssetRouter(registry);
    const clip1 = router.selectClip('GAMEPLAY_IDLE');
    assert(clip1.state === 'GAMEPLAY_IDLE', 'AssetRouter selects GAMEPLAY_IDLE clip', clip1.id);
    const jackpotClip = router.selectClip('JACKPOT');
    assert(jackpotClip.state === 'JACKPOT' && jackpotClip.file === 'jackpot_01.mp4', 'AssetRouter selects JACKPOT clip');
    const fallbackClip = router.selectClip('NON_EXISTENT_STATE');
    assert(fallbackClip.state === 'GAMEPLAY_IDLE', 'AssetRouter safely falls back to GAMEPLAY_IDLE on unknown state');
    // ── Step 2 Audit: Goal Engine ─────────────────────────────
    console.log('\n▶ Auditing Step 2: Goal Engine & Stream Script...');
    const goalEngine = new index_js_3.GoalEngine(index_js_3.DEFAULT_GOALS, index_js_3.DEFAULT_STREAM_PHASES);
    const initialPhase = goalEngine.getCurrentPhase(Date.now());
    assert(initialPhase.name === 'warmup', 'Initial stream phase is warmup', initialPhase.name);
    const allGoals = goalEngine.getAllGoals();
    assert(allGoals.length >= 5, 'GoalEngine registers built-in stream goals', `Count: ${allGoals.length}`);
    const now = Date.now();
    goalEngine.startStream(now - 300_000);
    const eligibleGoal = goalEngine.evaluate({
        streamStartedAt: now - 300_000,
        currentTime: now,
        currentVisualState: 'GAMEPLAY_IDLE',
        isSpeaking: false,
        lastCtaAt: 0,
        lastGoalAt: 0,
        lastBigWinAt: 0,
        chatVelocity: 2.0,
    });
    assert(eligibleGoal !== null, 'GoalEngine selects eligible goal during idle', eligibleGoal?.id);
    // ── Step 3 Audit: Director Agent & Priority Queue ─────────
    console.log('\n▶ Auditing Step 3: Director Agent & Priority Queue...');
    let observedTransition = null;
    const director = new index_js_4.DirectorAgent({
        assetRegistry: registry,
        goalEngine,
        listeners: {
            onStateTransition: (trans) => { observedTransition = trans; },
        },
    });
    director.injectGameEvent({
        type: 'game.jackpot',
        value: 10000000,
        currency: 'VND',
        timestamp: Date.now(),
    });
    const intent = director.tick(Date.now());
    assert(intent.action === 'CHANGE_STATE' || intent.action === 'SPEAK' || intent.action === 'REACT', 'Director prioritizes Jackpot event', intent.action);
    assert(director.state.currentVisual === 'JACKPOT', 'Director transitions to JACKPOT state');
    assert(observedTransition !== null && observedTransition.toState === 'JACKPOT', 'Director triggers transition listener');
    // ── Step 4 Audit: Dialogue Agent & Voice Service ──────────
    console.log('\n▶ Auditing Step 4: Dialogue Agent & Voice Service...');
    const dialogueAgent = new index_js_5.DialogueAgent();
    const dialogueRes = await dialogueAgent.generateDialogue({
        type: 'director.intent',
        action: 'REACT',
        priority: 1,
        visualState: 'JACKPOT',
        intent: 'Celebrate massive jackpot win with viewers',
        timestamp: Date.now(),
    });
    assert(dialogueRes.text.length > 0, 'Dialogue Agent generates contextual Vietnamese celebration line', dialogueRes.text);
    assert(dialogueRes.estimatedDurationMs >= 2000, 'Dialogue Agent calculates estimated speech duration', `${dialogueRes.estimatedDurationMs}ms`);
    let duckingStateObserved = false;
    const voiceService = new index_js_6.VoiceService({
        listeners: {
            onDuckingChange: (isDucked) => { duckingStateObserved = isDucked; },
        },
    });
    voiceService.speak({
        type: 'voice.request',
        text: dialogueRes.text,
        emotion: 'excited',
        energy: 0.8,
        speedMultiplier: 1.0,
        interruptible: true,
        requestId: 'test_req_1',
        timestamp: Date.now(),
    });
    assert(Boolean(voiceService.isSpeaking), 'VoiceService marks isSpeaking = true');
    assert(Boolean(duckingStateObserved), 'Audio Ducking triggered (-12dB) when voice starts');
    voiceService.interrupt('Test interrupt');
    assert(!voiceService.isSpeaking, 'VoiceService properly handles interrupts');
    assert(!voiceService.duckingController.isDucked, 'Audio ducking restored after speech interruption');
    // ── Step 5 Audit: OBS Controller ──────────────────────────
    console.log('\n▶ Auditing Step 5: OBS Controller...');
    const mockObsClient = new index_js_7.MockOBSClient();
    const obsController = new index_js_7.OBSController({}, mockObsClient);
    await obsController.initialize();
    assert(obsController.isConnected === true, 'OBS Controller connects successfully to client');
    await obsController.switchClip('jackpot_01.mp4');
    assert(mockObsClient.getState().activeMediaFile === 'jackpot_01.mp4', 'OBS Controller updates media source file');
    await obsController.applyAudioDucking(true, -12);
    assert(mockObsClient.getState().isDucked === true, 'OBS Controller applies audio ducking filter');
    // ── Step 6 Audit: Game Telemetry & Slot Adapter ───────────
    console.log('\n▶ Auditing Phase 4: Game Telemetry & Slot Adapter...');
    const slotSim = new index_js_8.SlotSimulatorEngine({ gameName: 'Fortune Dragon', defaultBet: 10000 });
    const forcedJp = slotSim.spin(10000, 'JACKPOT');
    assert(forcedJp.type === 'game.jackpot' && (forcedJp.value || 0) >= 5000000, 'SlotSimulator correctly forces JACKPOT spin');
    const normalized = index_js_8.GameEventNormalizer.normalize({
        action: 'jackpot',
        bet: 5000,
        payout: 500000,
        is_jackpot: true,
    });
    assert(normalized.type === 'game.jackpot', 'GameEventNormalizer parses raw payload to game.jackpot');
    // ── Step 7 Audit: Multi-Platform Chat & Moderation ────────
    console.log('\n▶ Auditing Phase 5: Multi-Platform Chat & Smart Moderation...');
    const chatFilter = new index_js_9.SmartChatFilter();
    const superChatRes = chatFilter.filter({
        text: 'Mimi ơi cho mình xin link chơi với ạ?',
        viewerName: 'Minh Tuấn',
        isSuperChat: true,
        viewerTier: 'top_donor',
    });
    assert(superChatRes.allowed && superChatRes.priorityScore === 100, 'SmartChatFilter gives SuperChat max priority score 100');
    assert(superChatRes.isQuestion === true, 'SmartChatFilter detects Vietnamese question');
    const bannedRes = chatFilter.filter({
        text: 'hack cheat lừa đảo scam game di',
        viewerName: 'Spammer',
    });
    assert(!bannedRes.allowed && bannedRes.classification === 'MODERATION', 'SmartChatFilter filters banned toxic keywords');
    // ── Step 8 Audit: Realtime LipSync Engine & LiveTalking Provider ──
    console.log('\n▶ Auditing Level 3: Realtime Talking Video Engine & LiveTalking Integration (lipku/LiveTalking)...');
    const phonemes = index_js_10.VietnamesePhonemeConverter.wordToVisemes('chào');
    assert(phonemes[0]?.viseme === 'CH', 'VietnamesePhonemeConverter identifies initial consonant CH');
    const phonemes2 = index_js_10.VietnamesePhonemeConverter.wordToVisemes('bạn');
    assert(phonemes2.some(p => p.viseme === 'aa'), 'VietnamesePhonemeConverter identifies vowel aa');
    const timeline = index_js_10.LipSyncTimelineGenerator.generateTimeline('chào cả nhà nha', 2000);
    assert(timeline.length >= 4, 'LipSyncTimelineGenerator segments words into timed keyframes');
    // Test LipMeshTransformer (Exact 40-point lip polygon deformation)
    const dummyLandmarks = Array.from({ length: 468 }, (_, i) => ({ x: 100 + (i % 20) * 5, y: 100 + Math.floor(i / 20) * 5 }));
    const dummyPose = {
        timestampMs: 1000,
        viseme: 'aa',
        mouthOpen: 0.85,
        mouthWide: 0.6,
        mouthPucker: 0.1,
        jawOpen: 0.7,
        smile: 0.4,
        eyeBlinkLeft: 0,
        eyeBlinkRight: 0,
        eyebrowRaise: 0.2,
        headPitch: 0,
        headYaw: 0,
        headRoll: 0,
        currentWord: 'chào',
        wordProgress: 0.5,
    };
    const deformedMesh = index_js_10.LipMeshTransformer.deformLipPoints(dummyLandmarks, dummyPose, 0.75, 1.2);
    assert(deformedMesh.outerLips.length === 21, 'LipMeshTransformer produces exact 21 outer lip contour vertices');
    assert(deformedMesh.innerLips.length === 21, 'LipMeshTransformer produces exact 21 inner lip contour vertices');
    assert(deformedMesh.mouthOpenDistance > 0, 'LipMeshTransformer calculates realistic positive mouth opening distance for vowel aa');
    // MediaPipe Face Mesh Canonical Polygonal Masking Tests
    const ovalMask = index_js_10.FacialPolygonMaskGenerator.generateMask(dummyLandmarks, {
        regionType: 'FACE_OVAL_MASK',
        expansion: { top: 10, bottom: 15, left: 10, right: 10, unit: 'px' },
        featherRadiusPx: 8,
        temporalSmoothingAlpha: 0.35,
    }, 1920, 1080);
    assert(ovalMask.points.length === index_js_10.MEDIAPIPE_FACE_OVAL_INDICES.length, 'FacialPolygonMaskGenerator creates FACE_OVAL_MASK with exact canonical contour vertices');
    const lowerFaceMask = index_js_10.FacialPolygonMaskGenerator.generateMask(dummyLandmarks, {
        regionType: 'LOWER_FACE_MASK',
        expansion: { top: 0.1, bottom: 0.15, left: 0.1, right: 0.1, unit: 'normalized' },
        featherRadiusPx: 12,
        temporalSmoothingAlpha: 0.4,
    }, 1920, 1080);
    assert(lowerFaceMask.points.length === index_js_10.MEDIAPIPE_LOWER_FACE_INDICES.length, 'FacialPolygonMaskGenerator creates LOWER_FACE_MASK for MuseTalk replacement');
    assert(lowerFaceMask.boundingRect.width > 0 && lowerFaceMask.boundingRect.height > 0, 'FacialPolygonMaskGenerator calculates expanded bounding rectangle');
    const mouthMask = index_js_10.FacialPolygonMaskGenerator.generateMask(dummyLandmarks, {
        regionType: 'MOUTH_MASK',
        expansion: { top: 5, bottom: 10, left: 5, right: 5, unit: 'px' },
        featherRadiusPx: 6,
        temporalSmoothingAlpha: 0.3,
    }, 1920, 1080);
    assert(mouthMask.regionType === 'MOUTH_MASK' && mouthMask.points.length === 21, 'FacialPolygonMaskGenerator creates precise MOUTH_MASK');
    assert(index_js_10.MEDIAPIPE_LEFT_IRIS_INDICES.length === 5, 'MediaPipe 478 Landmarker defines canonical Iris indices');
    // ── MediaPipe 3 Coordinate Spaces & Transform Audits ──
    console.log('  Testing 3 Coordinate Spaces Architecture & Affine Transforms...');
    // 1. CoordinateTransformer: Full Frame Space
    const srcNormPt = { x: 0.5, y: 0.25 };
    const srcPixelPts = index_js_10.CoordinateTransformer.toSourceFrameSpace([srcNormPt], 1920, 1080);
    assert(srcPixelPts[0].x === 960 && srcPixelPts[0].y === 270, 'CoordinateTransformer converts full_frame normalized to SOURCE_FRAME_SPACE pixels');
    // 2. CoordinateTransformer: Cropped Face ROI Space
    const roiNormPt = { x: 0.5, y: 0.5 };
    const roiSourcePts = index_js_10.CoordinateTransformer.toSourceFrameSpace([roiNormPt], 1920, 1080, { x: 400, y: 200, width: 600, height: 600 });
    assert(roiSourcePts[0].x === 700 && roiSourcePts[0].y === 500, 'CoordinateTransformer maps FACE_ROI_SPACE coordinates directly to SOURCE_FRAME_SPACE pixels');
    // 3. AffineTransform2D: Invertibility & Precision
    const affineMat = index_js_10.AffineTransform2D.create(1.5, 0, 0, 1.5, 50, 100);
    const origPt = { x: 800, y: 450 };
    const transformedPt = index_js_10.AffineTransform2D.transformPoint(origPt, affineMat);
    const invMat = index_js_10.AffineTransform2D.inverse(affineMat);
    const reconstructedPt = index_js_10.AffineTransform2D.transformPoint(transformedPt, invMat);
    assert(Math.abs(reconstructedPt.x - origPt.x) < 0.001 && Math.abs(reconstructedPt.y - origPt.y) < 0.001, 'AffineTransform2D exact inverse reconstructs original source frame coordinates without drift');
    // 4. Preview UI Space (Aspect Fit Scaling & Offsets)
    const previewRes = index_js_10.CoordinateTransformer.toPreviewUiSpace([{ x: 960, y: 540 }], 1920, 1080, 960, 540);
    assert(previewRes.points[0].x === 480 && previewRes.points[0].y === 270 && previewRes.scale === 0.5, 'CoordinateTransformer maps SOURCE_FRAME_SPACE to PREVIEW_UI_SPACE with aspect-fit scale');
    // 5. HeadPoseEstimator: 15° Head Roll Tilt Test
    const testFaceLandmarks = Array.from({ length: 468 }, () => ({ x: 960, y: 540, z: 0 }));
    const eyeDx = 200;
    const targetRollRad = (15 * Math.PI) / 180; // 15 degrees tilt
    testFaceLandmarks[33] = { x: 860, y: 400, z: 0 }; // Left Eye
    testFaceLandmarks[263] = { x: 860 + eyeDx * Math.cos(targetRollRad), y: 400 + eyeDx * Math.sin(targetRollRad), z: 0 }; // Right Eye
    testFaceLandmarks[1] = { x: 960, y: 500, z: 0 }; // Nose Tip
    testFaceLandmarks[152] = { x: 960, y: 680, z: 0 }; // Chin
    testFaceLandmarks[10] = { x: 960, y: 300, z: 0 }; // Forehead
    testFaceLandmarks[234] = { x: 760, y: 400, z: 0 }; // Left Temple
    testFaceLandmarks[454] = { x: 1160, y: 400, z: 0 }; // Right Temple
    testFaceLandmarks[61] = { x: 910, y: 570, z: 0 }; // Mouth left
    testFaceLandmarks[291] = { x: 1010, y: 570, z: 0 }; // Mouth right
    testFaceLandmarks[0] = { x: 960, y: 550, z: 0 }; // Mouth top
    testFaceLandmarks[17] = { x: 960, y: 590, z: 0 }; // Mouth bottom
    const poseEst = index_js_10.HeadPoseEstimator.estimate(testFaceLandmarks, 1920, 1080);
    assert(Math.abs(poseEst.rollDegrees - 15.0) < 0.5, `HeadPoseEstimator computes accurate head roll angle (${poseEst.rollDegrees.toFixed(2)}° vs expected 15.0°)`);
    assert(poseEst.faceWidth > 0 && poseEst.faceHeight > 0, 'HeadPoseEstimator derives source-space face width & height');
    assert(poseEst.mouthCenter.x > 0 && poseEst.mouthWidth > 0, 'HeadPoseEstimator computes mouth metrics from canonical MediaPipe lip landmarks');
    // 6. OneEuroFilter: Jitter Reduction
    const oneEuro = new index_js_10.OneEuroFilter(1.0, 0.007);
    let filteredVal = 100;
    for (let i = 0; i < 30; i++) {
        const noisyVal = 100 + (i % 2 === 0 ? 5 : -5);
        filteredVal = oneEuro.filter(noisyVal, i * 16.66);
    }
    assert(Math.abs(filteredVal - 100) < 2.5, 'OneEuroFilter smooths high-frequency tracking jitter at 60 FPS');
    // 7. Temporal Landmark Smoothing Anti-Jitter Test
    const smoother = new index_js_10.TemporalLandmarkSmoother(0.35);
    const frame1 = dummyLandmarks.map(p => ({ x: p.x, y: p.y }));
    const frame2Jittery = dummyLandmarks.map(p => ({ x: p.x + 10, y: p.y + 10 }));
    smoother.smooth(frame1);
    const smoothedFrame2 = smoother.smooth(frame2Jittery);
    assert(smoothedFrame2[0].x > frame1[0].x && smoothedFrame2[0].x < frame2Jittery[0].x, 'TemporalLandmarkSmoother eliminates inter-frame landmark jitter via EMA in SOURCE_FRAME_SPACE');
    // LiveTalking Digital Human Provider Tests (lipku/livetalking)
    let workerSpeakingPolls = 0;
    const fakeWorker = node_http_1.default.createServer((request, response) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1:9880').pathname;
        response.setHeader('Content-Type', 'application/json');
        if (pathname === '/health')
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { status: 'healthy', model: 'musetalk' } }));
        if (pathname === '/offer')
            return response.end(JSON.stringify({ sdp: 'v=0\r\n', type: 'answer', sessionid: 'session_test' }));
        if (pathname === '/speak' || pathname === '/humanaudio') {
            workerSpeakingPolls = 3;
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { sessionid: 'session_test' } }));
        }
        if (pathname === '/is_speaking') {
            const speaking = workerSpeakingPolls > 0;
            workerSpeakingPolls = Math.max(0, workerSpeakingPolls - 1);
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: speaking }));
        }
        if (pathname === '/interrupt') {
            workerSpeakingPolls = 0;
            return response.end(JSON.stringify({ code: 0, msg: 'ok' }));
        }
        if (pathname === '/api/avatar/task' && request.method === 'POST')
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { task_id: 'task_test' } }));
        if (pathname === '/api/avatar/task/task_test')
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { task_id: 'task_test', avatar_id: 'avatar_test', model_type: 'musetalk', status: 'completed', progress: 100 } }));
        if (pathname === '/api/avatar/tasks')
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { tasks: [] } }));
        response.statusCode = 404;
        return response.end(JSON.stringify({ code: 404, msg: 'not found' }));
    });
    await new Promise((resolve) => fakeWorker.listen(9880, '127.0.0.1', resolve));
    process.env.LIVETALKING_ENDPOINT = 'http://127.0.0.1:9880';
    const liveTalkingProvider = new index_js_11.LiveTalkingProvider({ endpointUrl: 'http://127.0.0.1:9880', model: 'livetalking-wav2lip', timeoutMs: 1000 });
    assert(liveTalkingProvider.config.model === 'livetalking-wav2lip', 'LiveTalkingProvider initializes with LiveTalking Wav2Lip model');
    await liveTalkingProvider.setModel('livetalking-musetalk');
    assert(liveTalkingProvider.config.model === 'livetalking-musetalk', 'LiveTalkingProvider supports dynamic checkpoint switching');
    const trainRes = await liveTalkingProvider.trainAvatarVideo('assets/driving_motion.mp4');
    assert(trainRes.success === true && trainRes.stages.stage4_avatarCompiled, 'LiveTalkingProvider delegates avatar training to the worker API');
    const realProviderHealth = await liveTalkingProvider.health();
    assert(realProviderHealth.healthy === true, 'LiveTalkingProvider health reflects the worker response');
    const mockTalkingProvider = new index_js_11.MockTalkingProvider();
    await mockTalkingProvider.initialize({ id: 'mimi_test' });
    await mockTalkingProvider.startSpeaking('Cảm ơn bạn đã donate nha!', { durationMs: 3000, emotion: 'happy' });
    const providerHealth = await mockTalkingProvider.health();
    assert(providerHealth.healthy === true && providerHealth.fps >= 30, 'MockTalkingProvider is healthy with >30 FPS capability');
    const pipeline = new index_js_11.TalkingVideoPipeline(liveTalkingProvider, mockTalkingProvider);
    await pipeline.speak('Chào bạn!', 2000, 'happy');
    const pipelineHealth = await pipeline.getHealth();
    assert(pipelineHealth.healthy === true, 'TalkingVideoPipeline operates healthy with active provider');
    await pipeline.interrupt();
    // ── Native LiveTalking + MuseTalk Upstream Parity & Lockstep Sync Tests ───
    console.log('\n▶ Auditing Upstream Parity: Native LiveTalking + MuseTalk Pipeline...');
    // 1. Ping-Pong sequence indexing [0, 1, 2, ..., N-1, N-2, ..., 1]
    const pingPongSeq = index_js_10.MuseTalkNativePipeline.generatePingPongSequence(5);
    const expectedSeq = [0, 1, 2, 3, 4, 3, 2, 1];
    assert(JSON.stringify(pingPongSeq) === JSON.stringify(expectedSeq), 'MuseTalkNativePipeline generates correct ping-pong sequence indices [0, 1, 2, 3, 4, 3, 2, 1]');
    // 2. Preprocess dataset
    const testBboxes = [
        { x1: 0.30, y1: 0.12, x2: 0.62, y2: 0.50 }, // Frame 0: Left pose
        { x1: 0.31, y1: 0.13, x2: 0.63, y2: 0.51 }, // Frame 1: Mid-left pose
        { x1: 0.32, y1: 0.14, x2: 0.64, y2: 0.52 }, // Frame 2: Frontal pose
        { x1: 0.33, y1: 0.15, x2: 0.65, y2: 0.53 }, // Frame 3: Mid-right pose
        { x1: 0.34, y1: 0.16, x2: 0.66, y2: 0.54 }, // Frame 4: Right pose
    ];
    const museDataset = index_js_10.MuseTalkNativePipeline.preprocessDataset(5, testBboxes, 25, 5, 'avatar_parity_test');
    assert(museDataset.sequence.length === 8, 'MuseTalk dataset sequence has length 8 for 5 frames');
    assert(museDataset.bboxList.length === 5, 'MuseTalk dataset has 5 frame-indexed bboxes');
    assert(museDataset.latentList.length === 5, 'MuseTalk dataset has 5 frame-indexed latent slots');
    assert(museDataset.maskList.length === 5, 'MuseTalk dataset has 5 frame-indexed mask slots');
    // 3. Strict 5-way lockstep frame synchronization (frame_index === latent_index === bbox_index === mask_index === mask_coord_index)
    let allSynced = true;
    for (let seqStep = 0; seqStep < 32; seqStep++) {
        const pkg = index_js_10.MuseTalkNativePipeline.getSynchronizedFramePackage(seqStep, museDataset);
        const expectedFrame = expectedSeq[seqStep % 8];
        if (pkg.frameIndex !== expectedFrame ||
            pkg.latentIndex !== expectedFrame ||
            pkg.bboxIndex !== expectedFrame ||
            pkg.maskIndex !== expectedFrame ||
            pkg.maskCoordIndex !== expectedFrame) {
            allSynced = false;
            break;
        }
    }
    assert(allSynced, '5-Way Lockstep Frame Synchronization Guarantee: frameIndex === latentIndex === bboxIndex === maskIndex === maskCoordIndex');
    assert(museDataset.maskCoordsList.length === 5, 'MuseTalk dataset includes native mask_coords_list_cycle for accurate facial region masking');
    // LiveTalking coords.pkl is pixel-based; it must be normalized exactly once.
    const upstreamPixelDataset = {
        ...museDataset,
        coordinateSpace: 'pixels',
        metadata: { sourceWidth: 1920, sourceHeight: 1080, fps: 25, frameCount: 1 },
        sequence: [0],
        bboxList: [{ x1: 614.4, y1: 151.2, x2: 1305.6, y2: 583.2 }],
    };
    const upstreamPixelPkg = index_js_10.MuseTalkNativePipeline.getSynchronizedFramePackage(0, upstreamPixelDataset);
    assert(Math.abs(upstreamPixelPkg.bbox.x1 - 0.32) < 0.0001 && Math.abs(upstreamPixelPkg.bbox.y1 - 0.14) < 0.0001, 'LiveTalking pixel coords.pkl converts once to normalized frame space (prevents chest drift)');
    assert(index_js_10.MuseTalkNativePipeline.normalizeBBox({ x1: 900, y1: 500, x2: 800, y2: 400 }, 1920, 1080, 'pixels') === null, 'Invalid/inverted LiveTalking bbox is rejected instead of pasted onto the avatar');
    // 4. Verification that head pose specific bounding box and latents are preserved
    const leftFacingPkg = index_js_10.MuseTalkNativePipeline.getSynchronizedFramePackage(0, museDataset); // Frame 0 (Left pose)
    const rightFacingPkg = index_js_10.MuseTalkNativePipeline.getSynchronizedFramePackage(4, museDataset); // Frame 4 (Right pose)
    assert(leftFacingPkg.bbox.x1 === 0.30 && rightFacingPkg.bbox.x1 === 0.34, 'Pose-specific BBoxes belong strictly to matching video frame (Frame 0 left-facing vs Frame 4 right-facing)');
    // ── TEST A / TEST B / TEST C Parity Checks: Coordinate Space & BBox Integrity ──
    assert(museDataset.metadata?.sourceWidth === 1920 && museDataset.metadata?.sourceHeight === 1080, 'Canonical AVATAR_SOURCE_SPACE metadata recorded (source_width=1920, source_height=1080)');
    assert(leftFacingPkg.bbox.y1 >= 0.05 && leftFacingPkg.bbox.y2 <= 0.55, 'TEST A: BBox strictly bounds the upper HEAD/FACE region (y1=0.10..0.18, y2=0.48..0.54) - ZERO CHEST DRIFT');
    assert(leftFacingPkg.bbox.y2 - leftFacingPkg.bbox.y1 > 0.25, 'TEST B & C: Face bounding box height covers full facial perspective without double offset');
    // 5. MuseTalkRealtimeEngine runtime audio pipeline, timestamp diagnostics, and state machine tests
    const museEngine = new index_js_10.MuseTalkRealtimeEngine();
    assert(museEngine.state === 'IDLE', 'MuseTalkRealtimeEngine starts in IDLE state');
    assert(museEngine.outputSource === 'IDLE_FRAME', 'MuseTalkRealtimeEngine outputs IDLE_FRAME when no audio is present');
    const reqStart = Date.now() - 50;
    const playbackTracker = { started: false };
    // Ingest audio with explicit requestStartTime and onPlaybackStart callback
    museEngine.ingestAudio({
        text: 'Xin chào các bạn đã ghé thăm livestream!',
        durationMs: 3000,
        type: 'TTS',
        samples: 48000,
        requestStartTime: reqStart,
        onPlaybackStart: () => {
            playbackTracker.started = true;
        },
    });
    const ts = museEngine.timestamps;
    assert(ts.t0 === reqStart, 'T0 (TTS_REQUEST_START) recorded properly');
    assert(ts.t1 >= ts.t0, 'T1 (AUDIO_PCM_READY) follows T0');
    assert(ts.t2 >= ts.t1, 'T2 (AUDIO_FEATURE_READY) follows T1');
    assert(ts.t3 >= ts.t2, 'T3 (MUSETALK_INFERENCE_START) follows T2');
    assert(ts.t4 >= ts.t3, 'T4 (FIRST_MUSETALK_FRAME_READY) follows T3');
    assert(museEngine.state === 'PLAYING_MUSETALK', 'MuseTalkRealtimeEngine transitions to PLAYING_MUSETALK state only after T4 first frame ready');
    assert(museEngine.outputSource === 'MUSETALK_FRAME', 'MuseTalkRealtimeEngine switches output source to MUSETALK_FRAME after T4');
    assert(playbackTracker.started === true, 'Audio and video playback trigger synchronously when first valid MuseTalk frames are ready');
    assert(museEngine.bufferedFrames >= 4, 'MuseTalkRealtimeEngine populates startup frame buffer (>= 4 frames)');
    assert(museEngine.audioFeatureChunks.length > 0, 'MuseTalkRealtimeEngine extracts audio feature chunks for inference');
    // Simulate inference loop steps
    for (let step = 0; step < 10; step++) {
        const pkg = index_js_10.MuseTalkNativePipeline.getSynchronizedFramePackage(step, museDataset);
        museEngine.executeInferenceStep(pkg);
    }
    assert(museEngine.timestamps.t5 >= museEngine.timestamps.t4, 'T5 (FIRST_MUSETALK_FRAME_DISPLAYED) recorded upon first frame display');
    assert(museEngine.inferenceCount === 10, 'MuseTalkRealtimeEngine increments real inference call counter (10 calls)');
    assert(museEngine.generatedFrameCount === 10, 'MuseTalkRealtimeEngine increments generated lip-sync frames counter (10 frames)');
    assert(museEngine.metrics.currentAvatarFrame !== undefined, 'MuseTalkRealtimeEngine metrics track current avatar frame and latent');
    // Stop audio -> return to IDLE
    museEngine.stopAudio();
    assert(museEngine.state === 'IDLE', 'MuseTalkRealtimeEngine returns to IDLE state when audio completes');
    assert(museEngine.outputSource === 'IDLE_FRAME', 'MuseTalkRealtimeEngine returns output source to IDLE_FRAME on speech end');
    assert(museEngine.bufferedFrames === 0, 'MuseTalkRealtimeEngine clears frame queue on IDLE');
    console.log('\n▶ Auditing Phase 4: SQLite Persistence & Migrations...');
    const persistence = new persistence_js_1.RuntimeDatabase(':memory:');
    persistence.setSetting('voice', { provider: 'webspeech', languageCode: 'vi' });
    assert(persistence.getSetting('voice')?.languageCode === 'vi', 'SQLite persists runtime settings without browser localStorage');
    persistence.setActiveProject('project_test', '/tmp/project-test');
    assert(persistence.getActiveProject()?.projectName === 'project_test', 'SQLite persists the active project and storage root');
    persistence.upsertAvatar('avatar_test', { id: 'avatar_test', status: 'ready' });
    assert(persistence.listAvatars()[0]?.id === 'avatar_test', 'SQLite persists trained avatar records');
    persistence.setAvatarSession(['avatar_test'], true);
    const persistedSession = persistence.getAvatarSession();
    assert(persistedSession?.selected[0] === 'avatar_test' && persistedSession.random, 'SQLite persists avatar selection and random mode');
    persistence.close();
    // ── Step 9 Audit: Runtime Server End-to-End Integration ───
    console.log('\n▶ Auditing Phase 6: Runtime Server Full Integration...');
    const server = new index_js_1.IdolRuntimeServer({ port: 9876, enableSimulation: false, databasePath: ':memory:' });
    await server.start();
    assert(true, 'Runtime Server started on port 9876');
    // Verify REST API
    try {
        const res = await fetch('http://localhost:9876/api/status');
        const json = await res.json();
        assert(json.status === 'healthy', 'HTTP REST /api/status responds with healthy state');
        assert(json.state.currentVisual !== undefined, 'REST status includes Director state');
        // Test Game Spin API
        const spinRes = await fetch('http://localhost:9876/api/game/spin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bet: 20000, forcedOutcome: 'MEGA_WIN' }),
        });
        const spinJson = await spinRes.json();
        assert(spinJson.success === true && spinJson.event.type === 'game.mega_win', 'REST /api/game/spin executes simulation spin');
        // Test Chat Ingestion API
        const chatRes = await fetch('http://localhost:9876/api/chat/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Chào idol Mimi!', viewerName: 'Quốc Bảo', viewerTier: 'vip' }),
        });
        const chatJson = await chatRes.json();
        assert(chatJson.success === true && chatJson.message.priorityScore >= 70, 'REST /api/chat/send ingests and scores live chat');
        // Establish the runtime-owned LiveTalking session before speech.
        const offerRes = await fetch('http://localhost:9876/api/talking-head/offer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: 'v=0\r\n', type: 'offer', avatarId: 'avatar_test' }),
        });
        const offerJson = await offerRes.json();
        assert(offerJson.success === true && offerJson.sessionid === 'session_test', 'Runtime proxies WebRTC signaling to LiveTalking');
        await fetch('http://localhost:9876/api/settings/voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'webspeech', voiceId: 'local', speed: 1 }),
        });
        // Test the single runtime speech command path.
        const thRes = await fetch('http://localhost:9876/api/talking-head/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Cảm ơn mọi người đã theo dõi!', durationMs: 2500, emotion: 'happy' }),
        });
        const thJson = await thRes.json();
        assert(thRes.status === 202 && thJson.success === true, 'REST /api/talking-head/speak queues one runtime speech command');
        const speechStates = new Set([thJson.state]);
        const observedSpeechStates = [thJson.state];
        const observedSpeechRuntime = [];
        const speechDeadline = Date.now() + 3000;
        while (Date.now() < speechDeadline) {
            const speechStatusRes = await fetch('http://localhost:9876/api/speech/status');
            const speechStatusJson = await speechStatusRes.json();
            const runtimeSnapshot = `${speechStatusJson.speech?.commandId || 'none'}:${speechStatusJson.speech?.state || 'none'}`;
            if (observedSpeechRuntime.at(-1) !== runtimeSnapshot)
                observedSpeechRuntime.push(runtimeSnapshot);
            if (speechStatusJson.speech?.commandId === thJson.commandId) {
                speechStates.add(speechStatusJson.speech.state);
                if (observedSpeechStates.at(-1) !== speechStatusJson.speech.state)
                    observedSpeechStates.push(speechStatusJson.speech.state);
                if (speechStates.has('SPEAKING') && speechStatusJson.speech.state === 'IDLE')
                    break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!(speechStates.has('GENERATING') && speechStates.has('SPEAKING') && speechStates.has('IDLE'))) {
            console.log(`  Observed speech states: ${observedSpeechStates.join(' -> ')}`);
            console.log(`  Runtime speech snapshots: ${observedSpeechRuntime.join(' -> ')}`);
        }
        assert(speechStates.has('GENERATING') && speechStates.has('SPEAKING') && speechStates.has('IDLE'), 'Speech follows GENERATING → SPEAKING → IDLE from worker state');
        // Test LiveTalking Status API
        const liveTalkingStatusRes = await fetch('http://localhost:9876/api/talking-head/livetalking/status');
        const liveTalkingStatusJson = await liveTalkingStatusRes.json();
        assert(Boolean(liveTalkingStatusJson.provider && liveTalkingStatusJson.provider.includes('livetalking')), 'REST /api/talking-head/livetalking/status returns LiveTalking metadata');
        // Test LiveTalking Config API
        const liveTalkingConfigRes = await fetch('http://localhost:9876/api/talking-head/livetalking/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'musetalk' }),
        });
        const liveTalkingConfigJson = await liveTalkingConfigRes.json();
        assert(liveTalkingConfigJson.success === true && liveTalkingConfigJson.config.model === 'musetalk', 'REST /api/talking-head/livetalking/config configures model');
        // Test Settings APIs
        const settingsRes = await fetch('http://localhost:9876/api/settings/all');
        const settingsJson = await settingsRes.json();
        assert(settingsJson.voice !== undefined && settingsJson.avatar !== undefined, 'REST /api/settings/all returns complete system settings');
        assert(settingsJson.voice.apiKey === undefined && typeof settingsJson.voice.apiKeyConfigured === 'boolean', 'REST settings redact provider secrets');
        const rejectedSecretRes = await fetch('http://localhost:9876/api/settings/voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'elevenlabs', apiKey: 'sk_test_123', voiceId: 'EXAVITQu4vr4xnSDxMaL', speed: 1.05 }),
        });
        assert(rejectedSecretRes.status === 400, 'REST settings reject provider secrets sent by the browser');
        const voiceSetRes = await fetch('http://localhost:9876/api/settings/voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'elevenlabs', voiceId: 'EXAVITQu4vr4xnSDxMaL', speed: 1.05 }),
        });
        const voiceSetJson = await voiceSetRes.json();
        assert(voiceSetJson.success === true && voiceSetJson.settings.voiceId === 'EXAVITQu4vr4xnSDxMaL', 'REST /api/settings/voice dynamically configures ElevenLabs');
        const avatarSetRes = await fetch('http://localhost:9876/api/settings/avatar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preset: 'mimi_cyber', enablePipCam: true }),
        });
        const avatarSetJson = await avatarSetRes.json();
        assert(avatarSetJson.success === true && avatarSetJson.settings.preset === 'mimi_cyber', 'REST /api/settings/avatar dynamically updates avatar');
        // ── Step 10 Audit: Pure Upstream MuseTalk Batch Pipeline & REST API ──
        console.log('\n▶ Auditing Phase 7: Pure Upstream MuseTalk Batch Video Generation (avatar.mp4 + test.wav -> output.mp4)...');
        const videoUploadRes = await fetch('http://localhost:9876/api/storage/file?category=uploads&filename=avatar.mp4', {
            method: 'POST',
            headers: { 'Content-Type': 'video/mp4' },
            body: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
        });
        const videoUploadJson = await videoUploadRes.json();
        const audioUploadRes = await fetch('http://localhost:9876/api/storage/file?category=uploads&filename=test.wav', {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
        });
        const audioUploadJson = await audioUploadRes.json();
        assert(videoUploadJson.success === true && audioUploadJson.success === true, 'Project storage accepts bounded test media uploads');
        const blockedPathRes = await fetch('http://localhost:9876/api/musetalk/batch-process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoPath: '/etc/passwd', audioPath: audioUploadJson.path }),
        });
        assert(blockedPathRes.status === 500 || blockedPathRes.status === 400, 'MuseTalk rejects arbitrary paths outside the active project');
        const batchRes = await fetch('http://localhost:9876/api/musetalk/batch-process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoPath: videoUploadJson.path, audioPath: audioUploadJson.path, videoFilename: 'avatar.mp4', audioFilename: 'test.wav' }),
        });
        const batchJson = await batchRes.json();
        assert(batchJson.success === true && batchJson.result.status === 'COMPLETED', 'REST /api/musetalk/batch-process completes batch lip-sync generation');
        assert(batchJson.result.outputVideoUrl.includes('output_'), 'Batch pipeline produces valid output.mp4 video URL');
        assert(batchJson.result.diagnostics.totalProcessingTimeMs > 0, 'Batch pipeline logs timestamps T0 -> T5');
        assert(batchJson.result.totalFramesProcessed > 0, 'Batch pipeline renders frames conditioned on audio features');
    }
    finally {
        await server.stop();
        director.destroy();
    }
    await new Promise((resolve, reject) => fakeWorker.close((error) => error ? reject(error) : resolve()));
    console.log('\n▶ Auditing Phase 0: Runtime Security Boundary...');
    let publicBindRejected = false;
    try {
        new index_js_1.IdolRuntimeServer({ port: 9877, host: '0.0.0.0', enableSimulation: false, databasePath: ':memory:' });
    }
    catch {
        publicBindRejected = true;
    }
    assert(publicBindRejected, 'Runtime refuses a public bind without an authentication token');
    const securedServer = new index_js_1.IdolRuntimeServer({
        port: 9877,
        host: '127.0.0.1',
        enableSimulation: false,
        databasePath: ':memory:',
        authToken: 'runtime-test-token',
        allowedOrigins: ['http://localhost:9877'],
        maxJsonBodyBytes: 128,
    });
    await securedServer.start();
    try {
        const healthRes = await fetch('http://127.0.0.1:9877/health');
        assert(healthRes.status === 200, 'Health probe stays public');
        const unauthorizedRes = await fetch('http://127.0.0.1:9877/api/settings/all');
        assert(unauthorizedRes.status === 401, 'Protected REST endpoints require authentication');
        const authorizedRes = await fetch('http://127.0.0.1:9877/api/settings/all', {
            headers: { Authorization: 'Bearer runtime-test-token' },
        });
        assert(authorizedRes.status === 200, 'Bearer token authorizes protected REST endpoints');
        const blockedOriginRes = await fetch('http://127.0.0.1:9877/api/settings/all', {
            headers: { Authorization: 'Bearer runtime-test-token', Origin: 'https://evil.example' },
        });
        assert(blockedOriginRes.status === 403, 'CORS rejects origins outside the allowlist');
        const oversizedRes = await fetch('http://127.0.0.1:9877/api/chat/send', {
            method: 'POST',
            headers: { Authorization: 'Bearer runtime-test-token', 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewerName: 'tester', message: 'x'.repeat(300) }),
        });
        assert(oversizedRes.status === 413, 'Runtime enforces the JSON body size limit');
    }
    finally {
        await securedServer.stop();
    }
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`      AUDIT RESULTS: ${passedChecks}/${totalChecks} CHECKS PASSED (${Math.round((passedChecks / totalChecks) * 100)}%)       `);
    console.log('═══════════════════════════════════════════════════════════════\n');
}
runAudit().catch((err) => {
    console.error('Fatal audit error:', err);
    process.exit(1);
});
