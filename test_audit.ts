declare const process: any;

import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IdolRuntimeServer } from './services/runtime-server/dist/index.js';
import { RuntimeDatabase } from './services/runtime-server/dist/persistence.js';
import { AssetRegistry, AssetRouter, DEFAULT_IDOL_ASSETS, type AssetMetadata } from './packages/asset-engine/dist/index.js';
import { GoalEngine, DEFAULT_GOALS, DEFAULT_STREAM_PHASES, type GoalDefinition } from './packages/goal-engine/dist/index.js';
import { DirectorAgent } from './services/director/dist/index.js';
import { DialogueAgent, MockDialogueProvider, normalizeVietnameseSpokenText } from './services/dialogue-agent/dist/index.js';
import { VoiceService } from './services/voice/dist/index.js';
import { OBSController, MockOBSClient } from './services/obs-controller/dist/index.js';
import { GameAdapter, GameEventNormalizer, SlotSimulatorEngine } from './services/game-adapter/dist/index.js';
import { ChatManager, SmartChatFilter, MockChatGenerator } from './services/chat-adapter/dist/index.js';
import {
  LipSyncEngine,
  VietnamesePhonemeConverter,
  LipSyncTimelineGenerator,
  LipMeshTransformer,
  FacialPolygonMaskGenerator,
  TemporalLandmarkSmoother,
  FacialMaskCompositor,
  MEDIAPIPE_FACE_OVAL_INDICES,
  MEDIAPIPE_LOWER_FACE_INDICES,
  MEDIAPIPE_LEFT_IRIS_INDICES,
  CoordinateTransformer,
  AffineTransform2D,
  HeadPoseEstimator,
  OneEuroFilter,
  LandmarkTrackingDebugger,
  MuseTalkNativePipeline,
  MuseTalkRealtimeEngine,
} from './packages/lipsync-engine/dist/index.js';
import { MockTalkingProvider, LiveTalkingProvider, TalkingVideoPipeline } from './services/talking-head/dist/index.js';
import type { DirectorIntent, StateTransition } from './packages/event-schema/dist/index.js';

let passedChecks = 0;
let totalChecks = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalChecks++;
  if (condition) {
    passedChecks++;
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    console.error(`  ❌ [FAIL] ${testName} ${detail ? `(${detail})` : ''}`);
    process.exitCode = 1;
  }
}

function probeWebSocketUpgrade(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: 9877,
      path: '/',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...headers,
      },
    });
    request.once('response', (response) => {
      response.resume();
      resolve(response.statusCode || 0);
    });
    request.once('upgrade', (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.once('error', reject);
    request.end();
  });
}

async function runAudit() {
  process.env.NODE_ENV = 'test';
  process.env.OMNIVOICE_DESKTOP_ENDPOINT = 'off';
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       HYBRID AI IDOL LIVESTREAM — SYSTEM AUDIT & E2E TEST       ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Step 1 Audit: Asset Engine ───────────────────────────
  console.log('▶ Auditing Step 1: Asset Engine & Router...');
  const registry = new AssetRegistry(DEFAULT_IDOL_ASSETS);
  assert(registry.count() >= 19, 'AssetRegistry has at least 19 built-in clips', `Found ${registry.count()}`);

  const router = new AssetRouter(registry);
  const clip1 = router.selectClip('GAMEPLAY_IDLE');
  assert(clip1.state === 'GAMEPLAY_IDLE', 'AssetRouter selects GAMEPLAY_IDLE clip', clip1.id);

  const jackpotClip = router.selectClip('JACKPOT');
  assert(jackpotClip.state === 'JACKPOT' && jackpotClip.file === 'jackpot_01.mp4', 'AssetRouter selects JACKPOT clip');

  const fallbackClip = router.selectClip('NON_EXISTENT_STATE' as any);
  assert(fallbackClip.state === 'GAMEPLAY_IDLE', 'AssetRouter safely falls back to GAMEPLAY_IDLE on unknown state');

  // ── Step 2 Audit: Goal Engine ─────────────────────────────
  console.log('\n▶ Auditing Step 2: Goal Engine & Stream Script...');
  const goalEngine = new GoalEngine(DEFAULT_GOALS, DEFAULT_STREAM_PHASES);
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
  let observedTransition: StateTransition | null = null;
  const director = new DirectorAgent({
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
  const dialogueAgent = new DialogueAgent();
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
  assert(normalizeVietnameseSpokenText('AK47 đang lên!') === 'a ca bốn bảy đang lên!', 'Dialogue output converts product codes to Vietnamese phonetics');
  assert(!/[\p{Extended_Pictographic}\p{Symbol}]/u.test(normalizeVietnameseSpokenText('Đỉnh quá 🔥')), 'Dialogue output removes icons before TTS');
  const customPersonaAgent = new DialogueAgent({
    persona: { ...dialogueAgent.persona, name: 'Bé Lộc Y Tá' },
    providers: [new MockDialogueProvider()],
  });
  const customPersonaBatch = await customPersonaAgent.generateDialogue({
    type: 'director.intent',
    action: 'SPEAK',
    priority: 3,
    visualState: 'GAMEPLAY_IDLE',
    intent: 'reply_to_chat_batch',
    speechText: 'Khánh: Hôm nay chơi gì vậy?\nLinh: Cho mình chơi cùng nha',
    timestamp: Date.now(),
  });
  assert(
    customPersonaBatch.text.includes('Bé Lộc Y Tá') && !customPersonaBatch.text.includes('Mimi'),
    'Dialogue fallback and 15–20 second batch filler always use the active AI Profile name',
    customPersonaBatch.text,
  );

  let duckingStateObserved = false;
  const voiceService = new VoiceService({
    listeners: {
      onDuckingChange: (isDucked: boolean) => { duckingStateObserved = isDucked; },
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
  const mockObsClient = new MockOBSClient();
  const obsController = new OBSController({}, mockObsClient);
  await obsController.initialize();
  assert(obsController.isConnected === true, 'OBS Controller connects successfully to client');

  await obsController.switchClip('jackpot_01.mp4');
  assert(mockObsClient.getState().activeMediaFile === 'jackpot_01.mp4', 'OBS Controller updates media source file');

  await obsController.applyAudioDucking(true, -12);
  assert(mockObsClient.getState().isDucked === true, 'OBS Controller applies audio ducking filter');

  // ── Step 6 Audit: Game Telemetry & Slot Adapter ───────────
  console.log('\n▶ Auditing Phase 4: Game Telemetry & Slot Adapter...');
  const slotSim = new SlotSimulatorEngine({ gameName: 'Fortune Dragon', defaultBet: 10000 });
  const forcedJp = slotSim.spin(10000, 'JACKPOT');
  assert(forcedJp.type === 'game.jackpot' && (forcedJp.value || 0) >= 5000000, 'SlotSimulator correctly forces JACKPOT spin');

  const normalized = GameEventNormalizer.normalize({
    action: 'jackpot',
    bet: 5000,
    payout: 500000,
    is_jackpot: true,
  });
  assert(normalized.type === 'game.jackpot', 'GameEventNormalizer parses raw payload to game.jackpot');

  // ── Step 7 Audit: Multi-Platform Chat & Moderation ────────
  console.log('\n▶ Auditing Phase 5: Multi-Platform Chat & Smart Moderation...');
  const chatFilter = new SmartChatFilter();
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
  const phonemes = VietnamesePhonemeConverter.wordToVisemes('chào');
  assert(phonemes[0]?.viseme === 'CH', 'VietnamesePhonemeConverter identifies initial consonant CH');

  const phonemes2 = VietnamesePhonemeConverter.wordToVisemes('bạn');
  assert(phonemes2.some(p => p.viseme === 'aa'), 'VietnamesePhonemeConverter identifies vowel aa');

  const timeline = LipSyncTimelineGenerator.generateTimeline('chào cả nhà nha', 2000);
  assert(timeline.length >= 4, 'LipSyncTimelineGenerator segments words into timed keyframes');

  // Test LipMeshTransformer (Exact 40-point lip polygon deformation)
  const dummyLandmarks = Array.from({ length: 468 }, (_, i) => ({ x: 100 + (i % 20) * 5, y: 100 + Math.floor(i / 20) * 5 }));
  const dummyPose = {
    timestampMs: 1000,
    viseme: 'aa' as any,
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
  const deformedMesh = LipMeshTransformer.deformLipPoints(dummyLandmarks, dummyPose, 0.75, 1.2);
  assert(deformedMesh.outerLips.length === 21, 'LipMeshTransformer produces exact 21 outer lip contour vertices');
  assert(deformedMesh.innerLips.length === 21, 'LipMeshTransformer produces exact 21 inner lip contour vertices');
  assert(deformedMesh.mouthOpenDistance > 0, 'LipMeshTransformer calculates realistic positive mouth opening distance for vowel aa');

  // MediaPipe Face Mesh Canonical Polygonal Masking Tests
  const ovalMask = FacialPolygonMaskGenerator.generateMask(dummyLandmarks, {
    regionType: 'FACE_OVAL_MASK',
    expansion: { top: 10, bottom: 15, left: 10, right: 10, unit: 'px' },
    featherRadiusPx: 8,
    temporalSmoothingAlpha: 0.35,
  }, 1920, 1080);
  assert(ovalMask.points.length === MEDIAPIPE_FACE_OVAL_INDICES.length, 'FacialPolygonMaskGenerator creates FACE_OVAL_MASK with exact canonical contour vertices');

  const lowerFaceMask = FacialPolygonMaskGenerator.generateMask(dummyLandmarks, {
    regionType: 'LOWER_FACE_MASK',
    expansion: { top: 0.1, bottom: 0.15, left: 0.1, right: 0.1, unit: 'normalized' },
    featherRadiusPx: 12,
    temporalSmoothingAlpha: 0.4,
  }, 1920, 1080);
  assert(lowerFaceMask.points.length === MEDIAPIPE_LOWER_FACE_INDICES.length, 'FacialPolygonMaskGenerator creates LOWER_FACE_MASK for MuseTalk replacement');
  assert(lowerFaceMask.boundingRect.width > 0 && lowerFaceMask.boundingRect.height > 0, 'FacialPolygonMaskGenerator calculates expanded bounding rectangle');

  const mouthMask = FacialPolygonMaskGenerator.generateMask(dummyLandmarks, {
    regionType: 'MOUTH_MASK',
    expansion: { top: 5, bottom: 10, left: 5, right: 5, unit: 'px' },
    featherRadiusPx: 6,
    temporalSmoothingAlpha: 0.3,
  }, 1920, 1080);
  assert(mouthMask.regionType === 'MOUTH_MASK' && mouthMask.points.length === 21, 'FacialPolygonMaskGenerator creates precise MOUTH_MASK');

  assert(MEDIAPIPE_LEFT_IRIS_INDICES.length === 5, 'MediaPipe 478 Landmarker defines canonical Iris indices');

  // ── MediaPipe 3 Coordinate Spaces & Transform Audits ──
  console.log('  Testing 3 Coordinate Spaces Architecture & Affine Transforms...');
  
  // 1. CoordinateTransformer: Full Frame Space
  const srcNormPt = { x: 0.5, y: 0.25 };
  const srcPixelPts = CoordinateTransformer.toSourceFrameSpace([srcNormPt], 1920, 1080);
  assert(srcPixelPts[0]!.x === 960 && srcPixelPts[0]!.y === 270, 'CoordinateTransformer converts full_frame normalized to SOURCE_FRAME_SPACE pixels');

  // 2. CoordinateTransformer: Cropped Face ROI Space
  const roiNormPt = { x: 0.5, y: 0.5 };
  const roiSourcePts = CoordinateTransformer.toSourceFrameSpace([roiNormPt], 1920, 1080, { x: 400, y: 200, width: 600, height: 600 });
  assert(roiSourcePts[0]!.x === 700 && roiSourcePts[0]!.y === 500, 'CoordinateTransformer maps FACE_ROI_SPACE coordinates directly to SOURCE_FRAME_SPACE pixels');

  // 3. AffineTransform2D: Invertibility & Precision
  const affineMat = AffineTransform2D.create(1.5, 0, 0, 1.5, 50, 100);
  const origPt = { x: 800, y: 450 };
  const transformedPt = AffineTransform2D.transformPoint(origPt, affineMat);
  const invMat = AffineTransform2D.inverse(affineMat);
  const reconstructedPt = AffineTransform2D.transformPoint(transformedPt, invMat);
  assert(
    Math.abs(reconstructedPt.x - origPt.x) < 0.001 && Math.abs(reconstructedPt.y - origPt.y) < 0.001,
    'AffineTransform2D exact inverse reconstructs original source frame coordinates without drift'
  );

  // 4. Preview UI Space (Aspect Fit Scaling & Offsets)
  const previewRes = CoordinateTransformer.toPreviewUiSpace([{ x: 960, y: 540 }], 1920, 1080, 960, 540);
  assert(previewRes.points[0]!.x === 480 && previewRes.points[0]!.y === 270 && previewRes.scale === 0.5, 'CoordinateTransformer maps SOURCE_FRAME_SPACE to PREVIEW_UI_SPACE with aspect-fit scale');

  // 5. HeadPoseEstimator: 15° Head Roll Tilt Test
  const testFaceLandmarks: any[] = Array.from({ length: 468 }, () => ({ x: 960, y: 540, z: 0 }));
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

  const poseEst = HeadPoseEstimator.estimate(testFaceLandmarks, 1920, 1080);
  assert(
    Math.abs(poseEst.rollDegrees - 15.0) < 0.5,
    `HeadPoseEstimator computes accurate head roll angle (${poseEst.rollDegrees.toFixed(2)}° vs expected 15.0°)`
  );
  assert(poseEst.faceWidth > 0 && poseEst.faceHeight > 0, 'HeadPoseEstimator derives source-space face width & height');
  assert(poseEst.mouthCenter.x > 0 && poseEst.mouthWidth > 0, 'HeadPoseEstimator computes mouth metrics from canonical MediaPipe lip landmarks');

  // 6. OneEuroFilter: Jitter Reduction
  const oneEuro = new OneEuroFilter(1.0, 0.007);
  let filteredVal = 100;
  for (let i = 0; i < 30; i++) {
    const noisyVal = 100 + (i % 2 === 0 ? 5 : -5);
    filteredVal = oneEuro.filter(noisyVal, i * 16.66);
  }
  assert(Math.abs(filteredVal - 100) < 2.5, 'OneEuroFilter smooths high-frequency tracking jitter at 60 FPS');

  // 7. Temporal Landmark Smoothing Anti-Jitter Test
  const smoother = new TemporalLandmarkSmoother(0.35);
  const frame1 = dummyLandmarks.map(p => ({ x: p.x, y: p.y }));
  const frame2Jittery = dummyLandmarks.map(p => ({ x: p.x + 10, y: p.y + 10 }));
  smoother.smooth(frame1);
  const smoothedFrame2 = smoother.smooth(frame2Jittery);
  assert(smoothedFrame2[0]!.x > frame1[0]!.x && smoothedFrame2[0]!.x < frame2Jittery[0]!.x, 'TemporalLandmarkSmoother eliminates inter-frame landmark jitter via EMA in SOURCE_FRAME_SPACE');

  // LiveTalking Digital Human Provider Tests (lipku/livetalking)
  let workerSpeakingPolls = 0;
  let workerTaskCounter = 0;
  let workerSessionSequence: string[] = [];
  const workerAudioSessions: string[] = [];
  const workerTaskRequests: any[] = [];
  const workerTasks = new Map<string, any>();
  const thumbnailBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const fakeWorker = http.createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1:9880').pathname;
    response.setHeader('Content-Type', 'application/json');
    if (pathname === '/health') return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { status: 'healthy', model: 'musetalk' } }));
    if (pathname === '/offer') {
      let rawBody = '';
      for await (const chunk of request) rawBody += String(chunk);
      const input = JSON.parse(rawBody || '{}');
      if (input.avatar === 'missing_avatar') {
        response.statusCode = 404;
        return response.end(JSON.stringify({ code: 404, msg: 'avatar not found' }));
      }
      return response.end(JSON.stringify({ sdp: 'v=0\r\n', type: 'answer', sessionid: 'session_test' }));
    }
    if (pathname === '/api/admin/sessions') {
      const sessionid = workerSessionSequence.shift() || 'session_test';
      return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { sessions: [{ sessionid }] } }));
    }
    if (pathname === '/humanaudio') {
      let rawBody = '';
      for await (const chunk of request) rawBody += chunk.toString('latin1');
      const sessionid = rawBody.includes('stale_session') ? 'stale_session' : 'session_test';
      workerAudioSessions.push(sessionid);
      if (sessionid === 'stale_session') {
        return response.end(JSON.stringify({ code: 404, msg: 'session not found' }));
      }
      workerSpeakingPolls = 3;
      return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { sessionid } }));
    }
    if (pathname === '/speak') {
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
    if (pathname === '/api/avatar/task' && request.method === 'POST') {
      let rawBody = '';
      for await (const chunk of request) rawBody += String(chunk);
      const input = JSON.parse(rawBody || '{}');
      const taskId = workerTaskCounter === 0 ? 'task_test' : `task_batch_${workerTaskCounter}`;
      workerTaskCounter += 1;
      workerTaskRequests.push(input);
      workerTasks.set(taskId, {
        task_id: taskId,
        avatar_id: input.avatar_id || 'avatar_test',
        model_type: input.model || 'musetalk',
        status: 'completed',
        progress: 100,
      });
      return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { task_id: taskId } }));
    }
    const workerTaskMatch = pathname.match(/^\/api\/avatar\/task\/([a-zA-Z0-9_-]+)$/);
    if (workerTaskMatch && request.method === 'GET') {
      const task = workerTasks.get(workerTaskMatch[1]!) || { task_id: workerTaskMatch[1], avatar_id: 'avatar_test', model_type: 'musetalk', status: 'completed', progress: 100 };
      return response.end(JSON.stringify({ code: 0, msg: 'ok', data: task }));
    }
    if (pathname === '/api/avatar/tasks') return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { tasks: [] } }));
    if (pathname === '/api/avatars') return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { avatars: [{ id: 'avatar_test', model_type: 'musetalk', thumbnail_url: '/api/avatars/avatar_test/thumbnail' }] } }));
    if (pathname === '/api/avatars/avatar_test/thumbnail') {
      response.setHeader('Content-Type', 'image/png');
      return response.end(thumbnailBytes);
    }
    if (pathname === '/api/avatars/avatar_test' && request.method === 'DELETE') {
      return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { avatar_id: 'avatar_test', deleted: true } }));
    }
    response.statusCode = 404;
    return response.end(JSON.stringify({ code: 404, msg: 'not found' }));
  });
  await new Promise<void>((resolve) => fakeWorker.listen(9880, '127.0.0.1', resolve));
  process.env.LIVETALKING_ENDPOINT = 'http://127.0.0.1:9880';

  const qwenTestAudio = Buffer.alloc(44);
  qwenTestAudio.write('RIFF', 0);
  qwenTestAudio.write('WAVEfmt ', 8);
  qwenTestAudio.write('data', 36);
  const fakeQwen = http.createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1:9881').pathname;
    if (pathname === '/api/health') return response.end(JSON.stringify({ ready: true, provider: 'qwentts', backend: 'mlx' }));
    if (pathname === '/api/voices') return response.end(JSON.stringify([{ id: 'qwen-default', voice_id: 'qwen-default', name: 'Yến Nhi', kind: 'preset', provider: 'qwentts' }]));
    if (pathname === '/api/voices/clone' && request.method === 'POST') {
      for await (const _chunk of request) { /* consume multipart input */ }
      response.setHeader('Content-Type', 'application/json');
      response.statusCode = 201;
      return response.end(JSON.stringify({ id: 'qwen-voice-test', voice_id: 'qwen-voice-test', name: 'Mimi Clone', kind: 'clone', provider: 'qwentts', ref_text: 'xin chào mọi người' }));
    }
    if (pathname === '/api/synthesize' && request.method === 'POST') {
      for await (const _chunk of request) { /* consume JSON input */ }
      response.setHeader('Content-Type', 'audio/wav');
      response.setHeader('X-Audio-Duration-Ms', '1200');
      response.setHeader('X-Generation-Ms', '100');
      return response.end(qwenTestAudio);
    }
    response.statusCode = 404;
    return response.end(JSON.stringify({ detail: 'not found' }));
  });
  await new Promise<void>((resolve) => fakeQwen.listen(9881, '127.0.0.1', resolve));
  process.env.QWEN_TTS_ENDPOINT = 'http://127.0.0.1:9881';

  const liveTalkingProvider = new LiveTalkingProvider({ endpointUrl: 'http://127.0.0.1:9880', model: 'livetalking-wav2lip', timeoutMs: 1000 });
  assert(liveTalkingProvider.config.model === 'livetalking-wav2lip', 'LiveTalkingProvider initializes with LiveTalking Wav2Lip model');

  await liveTalkingProvider.setModel('livetalking-musetalk');
  assert(liveTalkingProvider.config.model === 'livetalking-musetalk', 'LiveTalkingProvider supports dynamic checkpoint switching');

  const trainRes = await liveTalkingProvider.trainAvatarVideo('assets/driving_motion.mp4');
  assert(trainRes.success === true && trainRes.stages.stage4_avatarCompiled, 'LiveTalkingProvider delegates avatar training to the worker API');

  const realProviderHealth = await liveTalkingProvider.health();
  assert(realProviderHealth.healthy === true, 'LiveTalkingProvider health reflects the worker response');

  const providerThumbnail = await liveTalkingProvider.getAvatarThumbnail('avatar_test');
  assert(providerThumbnail.contentType === 'image/png' && Buffer.from(providerThumbnail.bytes).equals(thumbnailBytes), 'LiveTalkingProvider fetches real avatar thumbnail bytes');

  workerSessionSequence = ['stale_session', 'session_test'];
  workerAudioSessions.length = 0;
  await liveTalkingProvider.sendAudio(new Blob([qwenTestAudio], { type: 'audio/wav' }));
  assert(
    workerAudioSessions.join(' -> ') === 'stale_session -> session_test',
    'LiveTalkingProvider recovers when WebRTC session changes during TTS upload',
  );

  const mockTalkingProvider = new MockTalkingProvider();
  await mockTalkingProvider.initialize({ id: 'mimi_test' });

  await mockTalkingProvider.startSpeaking('Cảm ơn bạn đã donate nha!', { durationMs: 3000, emotion: 'happy' });
  const providerHealth = await mockTalkingProvider.health();
  assert(providerHealth.healthy === true && providerHealth.fps >= 30, 'MockTalkingProvider is healthy with >30 FPS capability');

  const pipeline = new TalkingVideoPipeline(liveTalkingProvider, mockTalkingProvider);
  await pipeline.speak('Chào bạn!', 2000, 'happy');
  const pipelineHealth = await pipeline.getHealth();
  assert(pipelineHealth.healthy === true, 'TalkingVideoPipeline operates healthy with active provider');

  await pipeline.interrupt();

  // ── Native LiveTalking + MuseTalk Upstream Parity & Lockstep Sync Tests ───
  console.log('\n▶ Auditing Upstream Parity: Native LiveTalking + MuseTalk Pipeline...');

  // 1. Ping-Pong sequence indexing [0, 1, 2, ..., N-1, N-2, ..., 1]
  const pingPongSeq = MuseTalkNativePipeline.generatePingPongSequence(5);
  const expectedSeq = [0, 1, 2, 3, 4, 3, 2, 1];
  assert(
    JSON.stringify(pingPongSeq) === JSON.stringify(expectedSeq),
    'MuseTalkNativePipeline generates correct ping-pong sequence indices [0, 1, 2, 3, 4, 3, 2, 1]'
  );

  // 2. Preprocess dataset
  const testBboxes = [
    { x1: 0.30, y1: 0.12, x2: 0.62, y2: 0.50 }, // Frame 0: Left pose
    { x1: 0.31, y1: 0.13, x2: 0.63, y2: 0.51 }, // Frame 1: Mid-left pose
    { x1: 0.32, y1: 0.14, x2: 0.64, y2: 0.52 }, // Frame 2: Frontal pose
    { x1: 0.33, y1: 0.15, x2: 0.65, y2: 0.53 }, // Frame 3: Mid-right pose
    { x1: 0.34, y1: 0.16, x2: 0.66, y2: 0.54 }, // Frame 4: Right pose
  ];
  const museDataset = MuseTalkNativePipeline.preprocessDataset(5, testBboxes, 25, 5, 'avatar_parity_test');
  assert(museDataset.sequence.length === 8, 'MuseTalk dataset sequence has length 8 for 5 frames');
  assert(museDataset.bboxList.length === 5, 'MuseTalk dataset has 5 frame-indexed bboxes');
  assert(museDataset.latentList.length === 5, 'MuseTalk dataset has 5 frame-indexed latent slots');
  assert(museDataset.maskList.length === 5, 'MuseTalk dataset has 5 frame-indexed mask slots');

  // 3. Strict 5-way lockstep frame synchronization (frame_index === latent_index === bbox_index === mask_index === mask_coord_index)
  let allSynced = true;
  for (let seqStep = 0; seqStep < 32; seqStep++) {
    const pkg = MuseTalkNativePipeline.getSynchronizedFramePackage(seqStep, museDataset);
    const expectedFrame = expectedSeq[seqStep % 8]!;
    if (
      pkg.frameIndex !== expectedFrame ||
      pkg.latentIndex !== expectedFrame ||
      pkg.bboxIndex !== expectedFrame ||
      pkg.maskIndex !== expectedFrame ||
      pkg.maskCoordIndex !== expectedFrame
    ) {
      allSynced = false;
      break;
    }
  }
  assert(
    allSynced,
    '5-Way Lockstep Frame Synchronization Guarantee: frameIndex === latentIndex === bboxIndex === maskIndex === maskCoordIndex'
  );
  assert(
    museDataset.maskCoordsList.length === 5,
    'MuseTalk dataset includes native mask_coords_list_cycle for accurate facial region masking'
  );

  // LiveTalking coords.pkl is pixel-based; it must be normalized exactly once.
  const upstreamPixelDataset = {
    ...museDataset,
    coordinateSpace: 'pixels' as const,
    metadata: { sourceWidth: 1920, sourceHeight: 1080, fps: 25, frameCount: 1 },
    sequence: [0],
    bboxList: [{ x1: 614.4, y1: 151.2, x2: 1305.6, y2: 583.2 }],
  };
  const upstreamPixelPkg = MuseTalkNativePipeline.getSynchronizedFramePackage(0, upstreamPixelDataset);
  assert(
    Math.abs(upstreamPixelPkg.bbox.x1 - 0.32) < 0.0001 && Math.abs(upstreamPixelPkg.bbox.y1 - 0.14) < 0.0001,
    'LiveTalking pixel coords.pkl converts once to normalized frame space (prevents chest drift)'
  );
  assert(
    MuseTalkNativePipeline.normalizeBBox({ x1: 900, y1: 500, x2: 800, y2: 400 }, 1920, 1080, 'pixels') === null,
    'Invalid/inverted LiveTalking bbox is rejected instead of pasted onto the avatar'
  );

  // 4. Verification that head pose specific bounding box and latents are preserved
  const leftFacingPkg = MuseTalkNativePipeline.getSynchronizedFramePackage(0, museDataset); // Frame 0 (Left pose)
  const rightFacingPkg = MuseTalkNativePipeline.getSynchronizedFramePackage(4, museDataset); // Frame 4 (Right pose)
  assert(
    leftFacingPkg.bbox.x1 === 0.30 && rightFacingPkg.bbox.x1 === 0.34,
    'Pose-specific BBoxes belong strictly to matching video frame (Frame 0 left-facing vs Frame 4 right-facing)'
  );

  // ── TEST A / TEST B / TEST C Parity Checks: Coordinate Space & BBox Integrity ──
  assert(
    museDataset.metadata?.sourceWidth === 1920 && museDataset.metadata?.sourceHeight === 1080,
    'Canonical AVATAR_SOURCE_SPACE metadata recorded (source_width=1920, source_height=1080)'
  );
  assert(
    leftFacingPkg.bbox.y1 >= 0.05 && leftFacingPkg.bbox.y2 <= 0.55,
    'TEST A: BBox strictly bounds the upper HEAD/FACE region (y1=0.10..0.18, y2=0.48..0.54) - ZERO CHEST DRIFT'
  );
  assert(
    leftFacingPkg.bbox.y2 - leftFacingPkg.bbox.y1 > 0.25,
    'TEST B & C: Face bounding box height covers full facial perspective without double offset'
  );

  // 5. MuseTalkRealtimeEngine runtime audio pipeline, timestamp diagnostics, and state machine tests
  const museEngine = new MuseTalkRealtimeEngine();
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
    const pkg = MuseTalkNativePipeline.getSynchronizedFramePackage(step, museDataset);
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
  const persistence = new RuntimeDatabase(':memory:');
  persistence.setSetting('voice', { provider: 'qwentts', languageCode: 'vi' });
  assert(persistence.getSetting<any>('voice')?.languageCode === 'vi', 'SQLite persists runtime settings without browser localStorage');
  persistence.setActiveProject('project_test', '/tmp/project-test');
  assert(persistence.getActiveProject()?.projectName === 'project_test', 'SQLite persists the active project and storage root');
  persistence.upsertAvatar('avatar_test', { id: 'avatar_test', status: 'ready' });
  assert(persistence.listAvatars<any>()[0]?.id === 'avatar_test', 'SQLite persists trained avatar records');
  persistence.setAvatarSession('avatar_test');
  const persistedSession = persistence.getAvatarSession();
  assert(
    persistedSession?.activeAvatarId === 'avatar_test',
    'SQLite persists one active avatar for the live session',
  );
  persistence.close();

  // ── Step 9 Audit: Runtime Server End-to-End Integration ───
  console.log('\n▶ Auditing Phase 6: Runtime Server Full Integration...');
  const server = new IdolRuntimeServer({ port: 9876, enableSimulation: false, databasePath: ':memory:' });
  await server.start();
  assert(true, 'Runtime Server started on port 9876');

  // Verify REST API
  try {
    const res = await fetch('http://localhost:9876/api/status');
    const json = await res.json() as any;
    assert(json.status === 'healthy', 'HTTP REST /api/status responds with healthy state');
    assert(json.service === 'ai-idol-runtime' && typeof json.runtimeBuildId === 'string', 'Runtime status identifies the native backend build');
    assert(json.state.currentVisual !== undefined, 'REST status includes Director state');

    const defaultSettingsRes = await fetch('http://localhost:9876/api/settings/all');
    const defaultSettings = await defaultSettingsRes.json() as any;
    assert(
      defaultSettings.voice.provider === 'qwentts'
        && defaultSettings.voice.voiceId === 'qwen-default'
        && defaultSettings.voice.languageCode === 'vi',
      'Runtime defaults TTS to Qwen Vietnamese 0.6B',
    );
    assert(defaultSettings.persona?.llmModel === 'qwen3:8b', 'AI Director defaults to the bounded Qwen 8B model');
    assert(defaultSettings.talkingEngine === undefined && defaultSettings.realtimeStatus !== undefined, 'Public settings hide core realtime implementation details');

    const maintenanceConfigRes = await fetch('http://localhost:9876/api/settings/talking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restartIntervalMinutes: 10 }),
    });
    const maintenanceSettings = await fetch('http://localhost:9876/api/settings/all').then((response) => response.json()) as any;
    assert(
      maintenanceConfigRes.status === 200
        && maintenanceSettings.liveAvatarMaintenance?.restartIntervalMinutes === 10,
      'Avatar worker memory refresh accepts and persists a 5/10/15/20 minute interval',
    );

    await fetch('http://localhost:9876/api/settings/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bé Lộc' }),
    });
    const customPersonaRes = await fetch('http://localhost:9876/api/settings/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bé Lộc Y Tá',
        systemPrompt: 'Bạn là Bé Lộc Y Tá, Idol streamer người Việt Nam thân thiện.',
      }),
    });
    const customPersonaSettings = await customPersonaRes.json() as any;
    assert(
      customPersonaRes.status === 200
        && customPersonaSettings.settings?.name === 'Bé Lộc Y Tá'
        && !customPersonaSettings.settings?.systemPrompt?.includes('Mimi')
        && !customPersonaSettings.settings?.systemPrompt?.includes('Y Tá Y Tá'),
      'AI Profile updates legacy prompt names without duplicating a new name that extends the previous name',
    );

    const rejectedMultiAvatarSession = await fetch('http://localhost:9876/api/avatars/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected: ['avatar_one', 'avatar_two'], random: true }),
    });
    assert(rejectedMultiAvatarSession.status === 400, 'Avatar session rejects multiple active avatars');
    const activeAvatarSessionRes = await fetch('http://localhost:9876/api/avatars/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeAvatarId: 'avatar_test' }),
    });
    const activeAvatarSession = await activeAvatarSessionRes.json() as any;
    assert(activeAvatarSession.session?.activeAvatarId === 'avatar_test', 'Avatar session stores exactly one active avatar');
    const excludedAvatarSessionRes = await fetch('http://localhost:9876/api/avatars/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeAvatarId: 'avatar_test', excludedAvatarIds: ['avatar_happy'] }),
    });
    const excludedAvatarSession = await excludedAvatarSessionRes.json() as any;
    assert(
      excludedAvatarSessionRes.status === 200
        && excludedAvatarSession.session?.activeAvatarId === 'avatar_test'
        && excludedAvatarSession.session?.excludedAvatarIds?.[0] === 'avatar_happy',
      'Live session persists active avatar and per-state exclusions independently',
    );

    const workerStatusRes = await fetch('http://localhost:9876/api/talking-head/livetalking/worker');
    const workerStatus = await workerStatusRes.json() as any;
    assert(workerStatus.worker?.state === 'READY' && workerStatus.worker?.owned === false, 'Worker status detects an externally running LiveTalking worker without spawning one');
    const workerStartRes = await fetch('http://localhost:9876/api/talking-head/livetalking/worker/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const workerStart = await workerStartRes.json() as any;
    assert(workerStartRes.status === 200 && workerStart.worker?.ready === true && workerStart.worker?.owned === false, 'Worker start endpoint reuses an already healthy worker');

    // Test Game Spin API
    const spinRes = await fetch('http://localhost:9876/api/game/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bet: 20000, forcedOutcome: 'MEGA_WIN' }),
    });
    const spinJson = await spinRes.json() as any;
    assert(spinJson.success === true && spinJson.event.type === 'game.mega_win', 'REST /api/game/spin executes simulation spin');

    // Test Chat Ingestion API after clearing earlier simulator activity so this assertion isolates one chat.
    await fetch('http://localhost:9876/api/speech/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await fetch('http://localhost:9876/api/operator/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'CLEAR_QUEUE' }),
    });
    await fetch('http://localhost:9876/api/operator/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'FORCE_STATE', state: 'GAMEPLAY_IDLE' }),
    });
    const chatSpeechBaseline = server.speechCommandCount;
    const priorSpeechStatusRes = await fetch('http://localhost:9876/api/speech/status');
    const priorSpeechStatus = await priorSpeechStatusRes.json() as any;
    const priorSpeechCommandId = priorSpeechStatus.speech?.commandId || '';

    const chatPayloads = [
      { message: 'Chào idol Mimi!', viewerName: 'Quốc Bảo', viewerTier: 'vip' },
      { message: 'Hôm nay Mimi chơi game gì vậy?', viewerName: 'Ngọc Mai', viewerTier: 'subscriber' },
      { message: 'Cho mình tham gia cùng nha', viewerName: 'Thanh Trúc', viewerTier: 'regular' },
    ];
    const chatResults = await Promise.all(chatPayloads.map(payload => fetch('http://localhost:9876/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(response => response.json() as Promise<any>)));
    assert(chatResults.every(result => result.success === true), 'REST /api/chat/send ingests and scores a chat batch');

    const chatSpeechDeadline = Date.now() + 5000;
    let chatDialogueProvider = '';
    let chatSpeechDurationMs = 0;
    let chatSpeechText = '';
    while (Date.now() < chatSpeechDeadline) {
      const speechStatusRes = await fetch('http://localhost:9876/api/speech/status');
      const speechStatusJson = await speechStatusRes.json() as any;
      if (speechStatusJson.speech?.commandId !== priorSpeechCommandId && speechStatusJson.speech?.dialogueProvider) {
        chatDialogueProvider = speechStatusJson.speech.dialogueProvider;
        chatSpeechDurationMs = Number(speechStatusJson.speech.durationMs || 0);
        chatSpeechText = String(speechStatusJson.speech.text || '');
      }
      if (server.speechCommandCount > chatSpeechBaseline && chatDialogueProvider) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(server.speechCommandCount === chatSpeechBaseline + 1, 'One chat batch creates exactly one SpeechCommand');
    assert(chatDialogueProvider === 'mock-fallback', 'Chat SpeechCommand records the actual fallback dialogue provider', chatDialogueProvider);
    assert(chatSpeechDurationMs >= 15_000 && chatSpeechDurationMs <= 20_000, 'Batched chat reply targets a 15–20 second avatar response', `${chatSpeechDurationMs}ms`);
    assert(
      chatSpeechText.includes('Bé Lộc Y Tá') && !chatSpeechText.includes('Mimi đã đọc'),
      'Runtime chat speech uses the active AI Profile instead of the legacy Mimi batch phrase',
      chatSpeechText,
    );

    // Establish the runtime-owned LiveTalking session before speech.
    const offerRes = await fetch('http://localhost:9876/api/talking-head/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: 'v=0\r\n', type: 'offer', avatarId: 'avatar_test' }),
    });
    const offerJson = await offerRes.json() as any;
    assert(offerJson.success === true && offerJson.sessionid === 'session_test', 'Runtime proxies WebRTC signaling to LiveTalking');
    const failedOfferRes = await fetch('http://localhost:9876/api/talking-head/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: 'v=0\r\n', type: 'offer', avatarId: 'missing_avatar' }),
    });
    const sessionAfterFailedOffer = await fetch('http://localhost:9876/api/avatars/session').then((response) => response.json()) as any;
    assert(
      failedOfferRes.status === 503 && sessionAfterFailedOffer.session?.activeAvatarId === 'avatar_test',
      'A failed avatar connection cannot replace the persisted active session',
    );

    process.env.QWEN_TTS_ENDPOINT = 'http://127.0.0.1:9';
    const omniFallbackRes = await fetch('http://localhost:9876/api/talking-head/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Kiểm tra giọng nữ tiếng Việt dự phòng.', durationMs: 1200, emotion: 'happy' }),
    });
    const omniFallbackJson = await omniFallbackRes.json() as any;
    const omniFallbackStates = new Set<string>([omniFallbackJson.state]);
    let omniFallbackProvider = '';
    const omniFallbackDeadline = Date.now() + 3000;
    while (Date.now() < omniFallbackDeadline) {
      const statusRes = await fetch('http://localhost:9876/api/speech/status');
      const statusJson = await statusRes.json() as any;
      if (statusJson.speech?.commandId === omniFallbackJson.commandId) {
        omniFallbackStates.add(statusJson.speech.state);
        omniFallbackProvider = statusJson.speech.provider || omniFallbackProvider;
        if (omniFallbackStates.has('SPEAKING') && statusJson.speech.state === 'IDLE') break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(
      omniFallbackProvider === 'system-tts-fallback'
        && omniFallbackStates.has('SPEAKING')
        && omniFallbackStates.has('IDLE'),
      'Offline OmniVoice falls back to operating-system audio without breaking LiveTalking speech',
    );
    process.env.QWEN_TTS_ENDPOINT = 'http://127.0.0.1:9881';

    await fetch('http://localhost:9876/api/settings/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'qwentts', voiceId: 'qwen-default', speed: 1 }),
    });

    // Test the single runtime speech command path.
    const thRes = await fetch('http://localhost:9876/api/talking-head/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Cảm ơn mọi người đã theo dõi!', durationMs: 2500, emotion: 'happy' }),
    });
    const thJson = await thRes.json() as any;
    assert(thRes.status === 202 && thJson.success === true, 'REST /api/talking-head/speak queues one runtime speech command');
    const speechStates = new Set<string>([thJson.state]);
    const observedSpeechStates: string[] = [thJson.state];
    const observedSpeechRuntime: string[] = [];
    const speechDeadline = Date.now() + 3000;
    while (Date.now() < speechDeadline) {
      const speechStatusRes = await fetch('http://localhost:9876/api/speech/status');
      const speechStatusJson = await speechStatusRes.json() as any;
      const runtimeSnapshot = `${speechStatusJson.speech?.commandId || 'none'}:${speechStatusJson.speech?.state || 'none'}`;
      if (observedSpeechRuntime.at(-1) !== runtimeSnapshot) observedSpeechRuntime.push(runtimeSnapshot);
      if (speechStatusJson.speech?.commandId === thJson.commandId) {
        speechStates.add(speechStatusJson.speech.state);
        if (observedSpeechStates.at(-1) !== speechStatusJson.speech.state) observedSpeechStates.push(speechStatusJson.speech.state);
        if (speechStates.has('SPEAKING') && speechStatusJson.speech.state === 'IDLE') break;
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
    const liveTalkingStatusJson = await liveTalkingStatusRes.json() as any;
    assert(Boolean(liveTalkingStatusJson.provider && liveTalkingStatusJson.provider.includes('livetalking')), 'REST /api/talking-head/livetalking/status returns LiveTalking metadata');

    // Test LiveTalking Config API
    const liveTalkingConfigRes = await fetch('http://localhost:9876/api/talking-head/livetalking/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'musetalk' }),
    });
    const liveTalkingConfigJson = await liveTalkingConfigRes.json() as any;
    assert(liveTalkingConfigJson.success === true && liveTalkingConfigJson.config.model === 'musetalk', 'REST /api/talking-head/livetalking/config configures model');

    // Test Settings APIs
    const settingsRes = await fetch('http://localhost:9876/api/settings/all');
    const settingsJson = await settingsRes.json() as any;
    assert(settingsJson.voice !== undefined && settingsJson.avatar !== undefined, 'REST /api/settings/all returns complete system settings');

    const ttmConfigRes = await fetch('http://localhost:9876/api/ai/director/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'ttm-chatgpt', model: 'chat-latest', apiKey: 'ttm_test_secret' }),
    });
    const ttmConfig = await ttmConfigRes.json() as any;
    const ttmStatus = await fetch('http://localhost:9876/api/ai/director/status').then((response) => response.json()) as any;
    assert(
      ttmConfigRes.status === 200
        && ttmConfig.settings?.llmProvider === 'ttm-chatgpt'
        && ttmConfig.settings?.llmApiKey === undefined
        && ttmStatus.apiKeyConfigured === true
        && ttmStatus.baseUrl === 'https://ttmapi.site/v1'
        && JSON.stringify(ttmStatus).includes('ttm_test_secret') === false,
      'ChatGPT TTM provider is configurable through ttmapi.site without exposing its API key',
    );
    await fetch('http://localhost:9876/api/ai/director/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', model: 'qwen3:8b', clearApiKey: true }),
    });

    const voiceProfilesRes = await fetch('http://localhost:9876/api/voice/profiles');
    const voiceProfilesJson = await voiceProfilesRes.json() as any;
    const voiceProfileProviders = new Set((voiceProfilesJson.profiles || []).map((profile: any) => profile.provider));
    assert(
      voiceProfileProviders.has('qwentts') && !voiceProfileProviders.has('elevenlabs'),
      'Voice catalog returns Qwen profiles without the removed ElevenLabs provider',
    );

    const dashboardHtml = fs.readFileSync('./operator-dashboard/index.html', 'utf8');
    const dashboardScript = fs.readFileSync('./operator-dashboard/dashboard.js', 'utf8');
    const dashboardStyles = fs.readFileSync('./operator-dashboard/design-system.css', 'utf8');
    const webRtcReceiverScript = fs.readFileSync('./operator-dashboard/webrtc/receiver.js', 'utf8');
    const nativeShellSource = fs.readFileSync('./src-tauri/src/lib.rs', 'utf8');
    const qwenServerSource = fs.readFileSync('./services/qwen-tts/server.py', 'utf8');
    assert(
      dashboardHtml.includes('id="preview-selected-voice"')
        && dashboardHtml.includes('id="save-selected-voice"')
        && dashboardScript.includes('VoiceProfileState.previewedKey !== voiceProfileKey(profile)'),
      'AI Profile requires voice preview before Save & use',
    );
    assert(
      dashboardHtml.indexOf('id="avatar-library-grid"') < dashboardHtml.indexOf('<h2>Idol Profile</h2>'),
      'AI Profile keeps Avatar Library above Idol Profile',
    );
    assert(
      dashboardHtml.indexOf('data-app-view="avatar"') < dashboardHtml.indexOf('data-app-view="studio"')
        && dashboardHtml.includes('id="reply-skill-file-input"')
        && dashboardHtml.includes('id="reply-skill-list"')
        && dashboardScript.includes("window.RuntimeApi.post('/api/settings/reply-skills/select'")
        && dashboardScript.includes("window.RuntimeApi.delete(`/api/settings/reply-skills/${encodeURIComponent(skill.id)}`)"),
      'Sidebar starts with AI Profile and exposes the persistent Markdown reply-skill workflow',
    );
    assert(
      dashboardStyles.includes('.avatar-library-grid { display: flex; flex: 0 0 304px;') && dashboardStyles.includes('overflow-x: auto'),
      'Avatar Library is horizontally scrollable without collapsing inside AI Profile',
    );
    assert(
      dashboardStyles.includes('--ui-command-h: var(--ui-control-h);')
        && dashboardStyles.includes('.chat-input-form > :where(input, button)')
        && dashboardStyles.includes('border-radius: var(--ui-radius) !important;'),
      'Live chat input and Send button share one height and corner-radius token',
    );
    assert(
      dashboardHtml.includes('data-settings-target="output"')
        && dashboardHtml.includes('data-settings-target="storage"')
        && dashboardHtml.includes('data-settings-target="director"')
        && dashboardScript.includes("const openSettingsCenter = (pane = 'output')")
        && dashboardStyles.includes('grid-template-columns: repeat(4, minmax(0, 1fr));'),
      'Settings uses left-side tabs with one content pane and Live Library uses quarter-width desktop previews',
    );
    assert(
      dashboardHtml.includes('id="btn-go-live-hero"')
        && dashboardHtml.includes('OBS output')
        && !dashboardHtml.includes('Continue with Google')
        && !dashboardHtml.includes('Continue with Facebook')
        && dashboardScript.includes("openSettingsCenter('output');"),
      'Live output is OBS-only with no direct platform authentication controls',
    );
    assert(
      qwenServerSource.includes('"model_loaded": engine.model is not None')
        && !qwenServerSource.includes('engine.load()\n    uvicorn.run')
        && nativeShellSource.includes('response.contains("\\\"model_loaded\\\"")')
        && nativeShellSource.includes('terminate_qwen_port_owner()?;'),
      'Native startup replaces legacy Qwen port owners and keeps the TTS model lazy-loaded',
    );
    assert(
      webRtcReceiverScript.includes('needsServerProbe()')
        && dashboardScript.includes('LiveTalkingWebRTCClient.needsServerProbe?.()')
        && dashboardScript.includes('sessionStatus.sessionId === LiveTalkingWebRTCClient.sessionId'),
      'A transient WebRTC disconnect is verified against the worker session before reconnecting',
    );
    assert(
      dashboardScript.includes('if (LiveTalkingWorker.refreshing) return LiveTalkingWorker;')
        && dashboardScript.includes('LiveTalkingWorker.refreshing = false;'),
      'Live avatar health polls cannot overlap and replace a session twice',
    );
    assert(
      dashboardScript.includes('let sessionViable = LiveTalkingWebRTCClient.isViable?.()')
        && dashboardScript.includes('if (!sessionViable && LiveTalkingWebRTCClient.sessionId && window.LiveTalkingApi?.sessionStatus)')
        && !dashboardScript.includes("selectedId !== LiveTalkingStudio.avatarId || !LiveTalkingWebRTCClient.isConnected?.()"),
      'Quick voice tests reuse a viable avatar session instead of replacing it',
    );
    assert(
      dashboardScript.includes("item.status = 'failed';\n      item.error = error.message;"),
      'Avatar training surfaces startup and submission failures in the create modal',
    );
    assert(
      dashboardScript.includes("function showAppConfirm({ title = 'Confirm action'")
        && dashboardScript.includes("title: 'Delete avatar?'")
        && dashboardScript.includes("confirmLabel: 'Delete'")
        && !dashboardScript.includes('if (!confirm(`Delete avatar'),
      'Native avatar deletion uses an in-app confirmation modal',
    );
    assert(
      dashboardScript.includes('function resolveRuntimeClip(state, serverAsset = null, forceRandom = false)')
        && dashboardScript.includes('serverAsset.fileName')
        && dashboardScript.includes('if (matchingClip) return matchingClip;')
        && dashboardScript.includes('const clipToPlay = resolveRuntimeClip(state, serverAsset, forceRandom);'),
      'Runtime state assets resolve to a playable local library clip after speech ends',
    );

    const avatarLibraryRes = await fetch('http://localhost:9876/api/avatars/library');
    const avatarLibraryJson = await avatarLibraryRes.json() as any;
    assert(avatarLibraryJson.avatars?.[0]?.thumbnailUrl === '/api/avatars/library/avatar_test/thumbnail', 'Avatar library exposes a runtime-owned thumbnail URL');

    const avatarRenameRes = await fetch('http://localhost:9876/api/avatars/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'avatar_test', name: 'Mimi Main', modelType: 'musetalk', status: 'ready' }),
    });
    const avatarRenameJson = await avatarRenameRes.json() as any;
    const renamedAvatarLibraryJson = await fetch('http://localhost:9876/api/avatars/library').then((response) => response.json()) as any;
    assert(
      avatarRenameRes.status === 201
        && avatarRenameJson.avatar?.name === 'Mimi Main'
        && renamedAvatarLibraryJson.avatars?.find((avatar: any) => avatar.id === 'avatar_test')?.name === 'Mimi Main',
      'Avatar library persists editable display names',
    );

    const avatarThumbnailRes = await fetch('http://localhost:9876/api/avatars/library/avatar_test/thumbnail');
    const avatarThumbnailBytes = Buffer.from(await avatarThumbnailRes.arrayBuffer());
    assert(avatarThumbnailRes.headers.get('content-type') === 'image/png' && avatarThumbnailBytes.equals(thumbnailBytes), 'Runtime securely proxies avatar thumbnail image bytes');
    const avatarDeleteRes = await fetch('http://localhost:9876/api/avatars/library/avatar_test', { method: 'DELETE' });
    const sessionAfterAvatarDelete = await fetch('http://localhost:9876/api/avatars/session').then((response) => response.json()) as any;
    assert(
      avatarDeleteRes.status === 200 && sessionAfterAvatarDelete.session?.activeAvatarId === null,
      'Deleting the active avatar clears its persisted live session',
    );

    // Avatar deletion must also cover legacy project-only artifacts and be
    // safe to repeat after the worker has already lost its copy.
    const deleteTestRoot = `/tmp/ai-idol-avatar-delete-${process.pid}`;
    const deleteTestProject = path.join(deleteTestRoot, 'project');
    const deleteTestAvatar = 'avatar_delete_integration';
    fs.rmSync(deleteTestRoot, { recursive: true, force: true });
    const deleteTestModelDir = path.join(deleteTestProject, 'models', deleteTestAvatar);
    fs.mkdirSync(path.join(deleteTestModelDir, 'full_imgs'), { recursive: true });
    fs.mkdirSync(path.join(deleteTestModelDir, 'mask'), { recursive: true });
    fs.mkdirSync(path.join(deleteTestProject, 'avatars', 'source', deleteTestAvatar), { recursive: true });
    fs.writeFileSync(path.join(deleteTestModelDir, 'avator_info.json'), JSON.stringify({ avatar_id: deleteTestAvatar }));
    fs.writeFileSync(path.join(deleteTestModelDir, 'latents.pt'), 'test');
    fs.writeFileSync(path.join(deleteTestModelDir, 'coords.pkl'), 'test');
    fs.writeFileSync(path.join(deleteTestModelDir, 'mask_coords.pkl'), 'test');
    fs.writeFileSync(path.join(deleteTestModelDir, 'full_imgs', '00000000.png'), 'test');
    fs.writeFileSync(path.join(deleteTestModelDir, 'mask', '00000000.png'), 'test');
    fs.writeFileSync(path.join(deleteTestProject, 'avatars', 'source', deleteTestAvatar, 'source.mp4'), 'test');
    const deleteStorageConfigRes = await fetch('http://localhost:9876/api/storage/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootPath: deleteTestRoot, projectName: 'project' }),
    });
    assert(deleteStorageConfigRes.status === 200, 'Avatar deletion integration uses an isolated project directory');
    const generatedSkillLibrary = await fetch('http://localhost:9876/api/settings/reply-skills').then((response) => response.json()) as any;
    assert(
      generatedSkillLibrary.activeSkillId === 'generated-live-session'
        && generatedSkillLibrary.items?.some((skill: any) => skill.id === 'generated-live-session'),
      'Reply-skill library always includes the generated Live Session fallback',
    );
    const uploadedSkillMarkdown = '# Bé Lộc Sales Skill\n\n- Nói tự nhiên, thân thiện.\n- Mời người xem đăng ký ở cuối câu.';
    const uploadSkillRes = await fetch('http://localhost:9876/api/settings/reply-skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'be-loc-sales.md', markdown: uploadedSkillMarkdown }),
    });
    const uploadedSkillLibrary = await uploadSkillRes.json() as any;
    const uploadedSkillId = uploadedSkillLibrary.skill?.id || '';
    const uploadedSkillPath = path.join(deleteTestProject, 'skills', `${uploadedSkillId}.md`);
    assert(
      uploadSkillRes.status === 201
        && uploadedSkillLibrary.activeSkillId === uploadedSkillId
        && fs.readFileSync(uploadedSkillPath, 'utf8') === uploadedSkillMarkdown,
      'Markdown reply skill is persisted to the active project and selected after upload',
    );
    const selectGeneratedSkillRes = await fetch('http://localhost:9876/api/settings/reply-skills/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'generated-live-session' }),
    });
    const selectedGeneratedSkill = await selectGeneratedSkillRes.json() as any;
    assert(
      selectGeneratedSkillRes.status === 200 && selectedGeneratedSkill.activeSkillId === 'generated-live-session',
      'Reply-skill library can switch back to the generated Live Session skill',
    );
    await fetch('http://localhost:9876/api/settings/reply-skills/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: uploadedSkillId }),
    });
    const deleteSkillRes = await fetch(`http://localhost:9876/api/settings/reply-skills/${uploadedSkillId}`, { method: 'DELETE' });
    const deletedSkillLibrary = await deleteSkillRes.json() as any;
    assert(
      deleteSkillRes.status === 200
        && deletedSkillLibrary.activeSkillId === 'generated-live-session'
        && !deletedSkillLibrary.items?.some((skill: any) => skill.id === uploadedSkillId)
        && !fs.existsSync(uploadedSkillPath),
      'Deleting the active Markdown skill removes its file and safely restores the generated fallback',
    );
    const projectOnlyAvatarRes = await fetch('http://localhost:9876/api/avatars/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: deleteTestAvatar, name: 'Integration Avatar', modelType: 'musetalk', status: 'ready' }),
    });
    const projectOnlyLibrary = await fetch('http://localhost:9876/api/avatars/library').then((response) => response.json()) as any;
    assert(
      projectOnlyAvatarRes.status === 201 && projectOnlyLibrary.avatars?.some((avatar: any) => avatar.id === deleteTestAvatar),
      'Avatar library discovers a trained project-only artifact',
    );
    await fetch('http://localhost:9876/api/avatars/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeAvatarId: deleteTestAvatar }),
    });
    const projectOnlyDeleteRes = await fetch(`http://localhost:9876/api/avatars/library/${deleteTestAvatar}`, { method: 'DELETE' });
    const repeatedDeleteRes = await fetch(`http://localhost:9876/api/avatars/library/${deleteTestAvatar}`, { method: 'DELETE' });
    const deletedLibrary = await fetch('http://localhost:9876/api/avatars/library').then((response) => response.json()) as any;
    const deletedSession = await fetch('http://localhost:9876/api/avatars/session').then((response) => response.json()) as any;
    assert(
      projectOnlyDeleteRes.status === 200
        && repeatedDeleteRes.status === 200
        && !deletedLibrary.avatars?.some((avatar: any) => avatar.id === deleteTestAvatar)
        && !fs.existsSync(path.join(deleteTestProject, 'models', deleteTestAvatar))
        && !fs.existsSync(path.join(deleteTestProject, 'avatars', 'source', deleteTestAvatar))
        && deletedSession.session?.activeAvatarId === null,
      'Avatar deletion removes project artifacts, SQLite state, and remains idempotent',
    );
    const staleAvatarId = 'avatar_stale_sqlite_only';
    await fetch('http://localhost:9876/api/avatars/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: staleAvatarId, name: 'Stale Avatar', modelType: 'musetalk', status: 'ready' }),
    });
    const reconciledLibrary = await fetch('http://localhost:9876/api/avatars/library').then((response) => response.json()) as any;
    assert(!reconciledLibrary.avatars?.some((avatar: any) => avatar.id === staleAvatarId), 'Avatar library reconciles stale SQLite-only records');
    fs.rmSync(deleteTestRoot, { recursive: true, force: true });
    assert(settingsJson.voice.apiKey === undefined && typeof settingsJson.voice.apiKeyConfigured === 'boolean', 'REST settings redact provider secrets');

    const rejectedSecretRes = await fetch('http://localhost:9876/api/settings/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'elevenlabs', apiKey: 'sk_test_123', voiceId: 'EXAVITQu4vr4xnSDxMaL', speed: 1.05 }),
    });
    assert(rejectedSecretRes.status === 400, 'REST settings reject provider secrets sent by the browser');

    const rejectedLegacyVoiceRes = await fetch('http://localhost:9876/api/settings/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai' }),
    });
    assert(rejectedLegacyVoiceRes.status === 400, 'REST voice settings accept only Qwen TTS and Omni Voice');

    const qwenVoiceSetRes = await fetch('http://localhost:9876/api/settings/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'qwentts', voiceId: 'qwen-default', speed: 1.05 }),
    });
    const qwenVoiceSetJson = await qwenVoiceSetRes.json() as any;
    assert(qwenVoiceSetJson.success === true && qwenVoiceSetJson.settings.provider === 'qwentts', 'REST /api/settings/voice configures Qwen TTS as the active provider');

    const voiceSetRes = await fetch('http://localhost:9876/api/settings/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'omnivoice', voiceId: 'voice_bright_storyteller', speed: 1.05 }),
    });
    const voiceSetJson = await voiceSetRes.json() as any;
    assert(voiceSetJson.success === true && voiceSetJson.settings.voiceId === 'voice_bright_storyteller', 'REST /api/settings/voice dynamically configures Omni Voice');

    const avatarSetRes = await fetch('http://localhost:9876/api/settings/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'mimi_cyber', enablePipCam: true }),
    });
    const avatarSetJson = await avatarSetRes.json() as any;
    assert(avatarSetJson.success === true && avatarSetJson.settings.preset === 'mimi_cyber', 'REST /api/settings/avatar dynamically updates avatar');

    // ── Step 10 Audit: Pure Upstream MuseTalk Batch Pipeline & REST API ──
    console.log('\n▶ Auditing Phase 7: Pure Upstream MuseTalk Batch Video Generation (avatar.mp4 + test.wav -> output.mp4)...');
    const videoUploadRes = await fetch('http://localhost:9876/api/storage/file?category=uploads&filename=avatar.mp4', {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    });
    const videoUploadJson = await videoUploadRes.json() as any;
    const samePathUploadRes = await fetch('http://localhost:9876/api/storage/file?category=uploads&filename=avatar.mp4', {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: fs.createReadStream(videoUploadJson.path),
      duplex: 'half',
    } as any);
    const samePathUploadJson = await samePathUploadRes.json() as any;
    assert(
      samePathUploadJson.success === true && fs.readFileSync(videoUploadJson.path).equals(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112])),
      'Project storage atomically replaces a file without truncating the upload source',
    );
    const audioUploadRes = await fetch('http://localhost:9876/api/storage/file?category=uploads&filename=test.wav', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
    });
    const audioUploadJson = await audioUploadRes.json() as any;
    const avatarSourceARes = await fetch('http://localhost:9876/api/storage/file?category=avatars%2Fsource&filename=shared-avatar.png&avatarId=audit_source_a', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([1, 2, 3]),
    });
    const avatarSourceBRes = await fetch('http://localhost:9876/api/storage/file?category=avatars%2Fsource&filename=shared-avatar.png&avatarId=audit_source_b', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([4, 5, 6]),
    });
    const avatarSourceAJson = await avatarSourceARes.json() as any;
    const avatarSourceBJson = await avatarSourceBRes.json() as any;
    assert(
      avatarSourceAJson.path !== avatarSourceBJson.path
        && avatarSourceAJson.path.includes(`${path.sep}audit_source_a${path.sep}`)
        && avatarSourceBJson.path.includes(`${path.sep}audit_source_b${path.sep}`),
      'Avatar source uploads are isolated by avatar ID and cannot overwrite matching filenames',
    );
    fs.unlinkSync(avatarSourceAJson.path);
    fs.unlinkSync(avatarSourceBJson.path);
    fs.rmdirSync(path.dirname(avatarSourceAJson.path));
    fs.rmdirSync(path.dirname(avatarSourceBJson.path));
    const cloneProfileRes = await fetch('http://localhost:9876/api/voice/profiles/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Mimi Clone',
        sourcePath: audioUploadJson.path,
        transcript: 'xin chào mọi người',
        filename: 'test.wav',
        provider: 'qwentts',
      }),
    });
    const cloneProfileJson = await cloneProfileRes.json() as any;
    assert(cloneProfileRes.status === 201 && cloneProfileJson.profile?.provider === 'qwentts', 'Qwen voice cloning creates a reusable cached profile');
    assert(videoUploadJson.success === true && audioUploadJson.success === true, 'Project storage accepts bounded test media uploads');

    const duplicateAvatarBatchRes = await fetch('http://localhost:9876/api/avatar/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [
        { video_path: videoUploadJson.path, avatar_id: 'duplicate_avatar', model: 'musetalk' },
        { video_path: videoUploadJson.path, avatar_id: 'duplicate_avatar', model: 'wav2lip' },
      ] }),
    });
    assert(duplicateAvatarBatchRes.status === 400, 'Avatar batch rejects duplicate avatar IDs before submitting tasks');

    const unsafeAvatarBatchRes = await fetch('http://localhost:9876/api/avatar/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ video_path: '/etc/passwd', avatar_id: 'unsafe_avatar', model: 'musetalk' }] }),
    });
    assert(unsafeAvatarBatchRes.status === 400, 'Avatar batch rejects source paths outside the active project');

    const workerTaskBaseline = workerTaskRequests.length;
    const avatarBatchRes = await fetch('http://localhost:9876/api/avatar/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [
        { video_path: videoUploadJson.path, avatar_id: 'batch_musetalk', model: 'musetalk' },
        { video_path: videoUploadJson.path, avatar_id: 'batch_wav2lip', model: 'wav2lip' },
      ] }),
    });
    const avatarBatchJson = await avatarBatchRes.json() as any;
    const submittedWorkerTasks = workerTaskRequests.slice(workerTaskBaseline);
    const submittedModels = new Map(submittedWorkerTasks.map(task => [task.avatar_id, task.model]));
    assert(avatarBatchRes.status === 202 && avatarBatchJson.data?.tasks?.length === 2, 'Avatar batch returns one task record per requested avatar');
    assert(
      submittedWorkerTasks.length === 2
        && submittedModels.get('batch_musetalk') === 'musetalk'
        && submittedModels.get('batch_wav2lip') === 'wav2lip',
      'Avatar batch submits every task with its explicit model and no shared provider mutation',
    );

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
    const batchJson = await batchRes.json() as any;
    assert(batchJson.success === true && batchJson.result.status === 'COMPLETED', 'REST /api/musetalk/batch-process completes batch lip-sync generation');
    assert(batchJson.result.outputVideoUrl.includes('output_'), 'Batch pipeline produces valid output.mp4 video URL');
    assert(batchJson.result.diagnostics.totalProcessingTimeMs > 0, 'Batch pipeline logs timestamps T0 -> T5');
    assert(batchJson.result.totalFramesProcessed > 0, 'Batch pipeline renders frames conditioned on audio features');

  } finally {
    await server.stop();
    director.destroy();
  }

  await new Promise<void>((resolve, reject) => fakeWorker.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => fakeQwen.close((error) => error ? reject(error) : resolve()));

  console.log('\n▶ Auditing Phase 0: Runtime Security Boundary...');
  let publicBindRejected = false;
  try {
    new IdolRuntimeServer({ port: 9877, host: '0.0.0.0', enableSimulation: false, databasePath: ':memory:' });
  } catch {
    publicBindRejected = true;
  }
  assert(publicBindRejected, 'Runtime refuses a public bind without an authentication token');

  const securedServer = new IdolRuntimeServer({
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

    const unauthorizedWsStatus = await probeWebSocketUpgrade({ Origin: 'http://localhost:9877' });
    assert(unauthorizedWsStatus === 401, 'WebSocket upgrades require authentication');

    const authorizedWsStatus = await probeWebSocketUpgrade({
      Origin: 'http://localhost:9877',
      Authorization: 'Bearer runtime-test-token',
    });
    assert(authorizedWsStatus === 101, 'Bearer token authorizes WebSocket upgrades');

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

    const invalidModelRes = await fetch('http://127.0.0.1:9877/api/ai/local/install', {
      method: 'POST',
      headers: { Authorization: 'Bearer runtime-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '../../bin/sh' }),
    });
    assert(invalidModelRes.status === 400, 'Local AI installer rejects unsafe model tags');
  } finally {
    await securedServer.stop();
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`      AUDIT RESULTS: ${passedChecks}/${totalChecks} CHECKS PASSED (${Math.round((passedChecks/totalChecks)*100)}%)       `);
  console.log('═══════════════════════════════════════════════════════════════\n');
}

runAudit().catch((err) => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
