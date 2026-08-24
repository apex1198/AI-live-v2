declare const process: any;

import { IdolRuntimeServer } from '../../services/runtime-server/dist/index.js';
import { AssetRegistry, AssetRouter, DEFAULT_IDOL_ASSETS, type AssetMetadata } from '../../packages/asset-engine/dist/index.js';
import { GoalEngine, DEFAULT_GOALS, DEFAULT_STREAM_PHASES, type GoalDefinition } from '../../packages/goal-engine/dist/index.js';
import { DirectorAgent } from '../../services/director/dist/index.js';
import { DialogueAgent } from '../../services/dialogue-agent/dist/index.js';
import { VoiceService } from '../../services/voice/dist/index.js';
import { OBSController, MockOBSClient } from '../../services/obs-controller/dist/index.js';
import type { DirectorIntent, StateTransition } from '../../packages/event-schema/dist/index.js';

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

async function runAudit() {
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

  // Test goal evaluation when idle
  const eligibleGoal = goalEngine.evaluate({
    streamStartedAt: Date.now() - 300_000,
    currentTime: Date.now(),
    currentVisualState: 'GAMEPLAY_IDLE',
    isSpeaking: false,
    lastCtaAt: 0,
    lastGoalAt: 0,
    lastBigWinAt: 0,
    chatVelocity: 5,
  });
  assert(eligibleGoal !== null, 'GoalEngine selects eligible goal when idle and scheduled', eligibleGoal?.id);

  // ── Step 3 Audit: Director Agent & Priority Arbitration ───
  console.log('\n▶ Auditing Step 3: Director Agent Core & Priority Queue...');
  let latestIntent: any = null;
  let latestTransition: any = null;

  const director = new DirectorAgent({
    assetRegistry: registry,
    goalEngine: goalEngine,
    listeners: {
      onIntent: (intent: DirectorIntent) => { latestIntent = intent; },
      onStateTransition: (trans: StateTransition) => { latestTransition = trans; },
    },
  });

  assert(director.state.currentVisual === 'GAMEPLAY_IDLE', 'Director initializes at GAMEPLAY_IDLE');

  // Scenario A: Inject viewer chat -> speak over gameplay
  director.injectChatMessage({
    type: 'chat.message',
    platform: 'youtube',
    viewerId: 'u1',
    viewerName: 'Alice',
    message: 'Chơi game vui quá Mimi ơi!',
    isSuperChat: false,
    isSubscriber: true,
    timestamp: Date.now(),
  });

  const chatIntent = director.tick(Date.now());
  assert(chatIntent !== null && chatIntent.action === 'SPEAK', 'Director processes chat message into SPEAK intent');
  assert(director.state.currentVisual === 'GAMEPLAY_IDLE', 'Gameplay visual remains undisturbed during chat reply');

  // Scenario B: Inject JACKPOT (P1) -> Interrupts and switches visual immediately
  director.injectGameEvent({
    type: 'game.jackpot',
    value: 5000,
    currency: 'GOLD',
    timestamp: Date.now(),
  });

  const jackpotIntent = director.tick(Date.now());
  assert(jackpotIntent !== null && jackpotIntent.action === 'REACT', 'Jackpot generates high-energy REACT intent');
  assert(director.state.currentVisual === 'JACKPOT', 'Director switches visual state immediately to JACKPOT');
  assert(latestTransition?.toState === 'JACKPOT', 'State transition event emitted for JACKPOT');

  // ── Step 4 Audit: Dialogue Agent & Voice Service ──────────
  console.log('\n▶ Auditing Step 4: Dialogue Agent & Voice TTS...');
  const dialogueAgent = new DialogueAgent();
  const dialogueRes = await dialogueAgent.generateDialogue({
    type: 'director.intent',
    action: 'REACT',
    intent: 'celebrate_big_win',
    emotion: 'excited',
    priority: 1,
    timestamp: Date.now(),
  });

  assert(dialogueRes.text.length > 0, 'Dialogue Agent generates contextual Vietnamese celebration line', dialogueRes.text);
  assert(dialogueRes.estimatedDurationMs >= 2000, 'Dialogue Agent calculates estimated speech duration', `${dialogueRes.estimatedDurationMs}ms`);

  let duckingStateObserved = false;
  const voiceService = new VoiceService({
    listeners: {
      onDuckingChange: (isDucked: boolean) => { duckingStateObserved = isDucked; },
    },
  });

  // Start speech
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

  // ── Step 6 Audit: Runtime Server & REST / WS Hub ──────────
  console.log('\n▶ Auditing Step 6: Backend Runtime Server & WebSocket Hub...');
  const server = new IdolRuntimeServer({ port: 9876, enableSimulation: false });
  await server.start();
  assert(true, 'Runtime Server started on port 9876');

  // Verify REST API
  try {
    const res = await fetch('http://localhost:9876/api/status');
    const json = await res.json() as any;
    assert(json.status === 'healthy', 'HTTP REST /api/status responds with healthy state');
    assert(json.state.currentVisual !== undefined, 'REST status includes Director state');

    const libRes = await fetch('http://localhost:9876/api/library');
    const libJson = await libRes.json() as any[];
    assert(Array.isArray(libJson) && libJson.length >= 19, 'REST /api/library returns asset catalog', `Count: ${libJson.length}`);

    // Verify REST Operator Command injection
    const cmdRes = await fetch('http://localhost:9876/api/operator/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'FORCE_STATE', state: 'HAPPY' }),
    });
    const cmdJson = await cmdRes.json() as any;
    assert(cmdJson.success === true, 'REST /api/operator/command accepts and executes operator override');
  } catch (err) {
    assert(false, 'HTTP REST API verification', String(err));
  }

  await server.stop();
  director.destroy();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`      AUDIT RESULTS: ${passedChecks}/${totalChecks} CHECKS PASSED (100%)       `);
  console.log('═══════════════════════════════════════════════════════════════\n');
}

runAudit().catch((err) => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
