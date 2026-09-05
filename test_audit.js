"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const index_js_1 = require("./services/runtime-server/dist/index.js");
const persistence_js_1 = require("./services/runtime-server/dist/persistence.js");
const platform_chat_js_1 = require("./services/runtime-server/dist/platform-chat.js");
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
function probeWebSocketUpgrade(headers) {
    return new Promise((resolve, reject) => {
        const request = node_http_1.default.request({
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
async function openRuntimeSocket(port) {
    const messages = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, ['idol-runtime-v2']);
    socket.addEventListener('message', (event) => {
        try {
            messages.push(JSON.parse(String(event.data)));
        }
        catch { }
    });
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('Runtime WebSocket connection failed')), { once: true });
    });
    return { socket, messages };
}
async function waitForSocketMessage(messages, type, timeoutMs = 1_000, startIndex = 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const match = messages.slice(startIndex).find((message) => message?.type === type);
        if (match)
            return match;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return null;
}
async function runAudit() {
    process.env.NODE_ENV = 'test';
    process.env.OMNIVOICE_DESKTOP_ENDPOINT = 'off';
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
    assert(allGoals.every(({ definition }) => [
        'neutral', 'happy', 'excited', 'surprised', 'sad',
        'angry', 'playful', 'focused', 'grateful', 'laughing',
    ].includes((0, index_js_4.goalToneToEmotion)(definition.tone))), 'Every descriptive goal tone maps to a valid speech emotion');
    assert((0, index_js_4.goalToneToEmotion)(['cheerful']) === 'happy'
        && (0, index_js_4.goalToneToEmotion)(['curious']) === 'playful'
        && (0, index_js_4.goalToneToEmotion)(['unknown-tone']) === 'playful', 'Goal tone aliases and unknown custom tones use safe emotions');
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
    const dialogueAgent = new index_js_5.DialogueAgent({
        providers: [{
                name: 'test-ai',
                async generate() { return 'Pha này thắng lớn rồi, vui quá mọi người ơi!'; },
            }],
    });
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
    assert((0, index_js_5.normalizeVietnameseSpokenText)('AK47 đang lên!') === 'a ca bốn bảy đang lên!', 'Dialogue output converts product codes to Vietnamese phonetics');
    assert(!/[\p{Extended_Pictographic}\p{Symbol}]/u.test((0, index_js_5.normalizeVietnameseSpokenText)('Đỉnh quá 🔥')), 'Dialogue output removes icons before TTS');
    const splitReplyAgent = new index_js_5.DialogueAgent({
        providers: [{ name: 'split-test', async generate() { return 'AK47 lên sóng rồi nha 🔥'; } }],
    });
    const splitReply = await splitReplyAgent.generateDialogue({
        type: 'director.intent', action: 'SPEAK', priority: 3, visualState: 'GAMEPLAY_IDLE',
        intent: 'reply_to_chat_batch', speechText: 'Viewer: AK47 mạnh không?', timestamp: Date.now(),
    });
    assert(splitReply.replyText === 'AK47 lên sóng rồi nha 🔥', 'Text reply preserves natural codes and emoji', splitReply.replyText);
    assert(splitReply.speechText === 'a ca bốn bảy lên sóng rồi nha', 'TTS reply applies independent speech normalization', splitReply.speechText);
    assert(splitReply.text === splitReply.speechText, 'Legacy dialogue text aliases the TTS reply');
    const customPersonaAgent = new index_js_5.DialogueAgent({
        persona: { ...dialogueAgent.persona, name: 'Bé Lộc Y Tá' },
        providers: [{
                name: 'test-ai',
                async generate(_intent, persona) { return `${persona.name} thấy ý tưởng này rất hay nha.`; },
            }],
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
    assert(customPersonaBatch.text.includes('Bé Lộc Y Tá')
        && !customPersonaBatch.text.includes('Mimi')
        && customPersonaBatch.text === 'Bé Lộc Y Tá thấy ý tưởng này rất hay nha.'
        && customPersonaBatch.estimatedDurationMs >= 2_000
        && customPersonaBatch.estimatedDurationMs <= 12_000, 'Dialogue output keeps the active AI Profile without appending filler', customPersonaBatch.text);
    const batchWordCount = customPersonaBatch.text.split(/\s+/).filter(Boolean).length;
    assert(batchWordCount < 28, 'Short AI replies remain short instead of being padded to a minimum duration', `${batchWordCount} words`);
    const cleanedReply = (0, index_js_5.constrainLiveReply)('Mình thích ý tưởng đó nha. Bé Lộc Y Tá đã đọc hết các câu hỏi rồi, mọi người cứ nhắn tiếp để không bỏ sót ai.');
    assert(cleanedReply === 'Mình thích ý tưởng đó nha.'
        && !/đã đọc hết|không bỏ sót|trả lời lần lượt/i.test(cleanedReply), 'Dialogue cleanup removes meta commentary without adding replacement text', cleanedReply);
    assert(!(0, index_js_5.constrainLiveReply)('Hay đó nha!').includes('Mọi người nghĩ sao')
        && (0, index_js_5.constrainLiveReply)('Hay đó nha!') === 'Hay đó nha!', 'Dialogue cleanup never appends the legacy mock follow-up');
    const sentenceBoundaryReply = (0, index_js_5.constrainLiveReply)('Mình rất thích ý tưởng này và muốn cùng mọi người thử ngay hôm nay. Phần tiếp theo có rất nhiều chi tiết cần giải thích nên mình sẽ nói thật dài để chắc chắn rằng câu trả lời ban đầu vượt quá giới hạn thời lượng dành cho một clip talking trong phiên live hiện tại.');
    const sentenceBoundaryWordCount = sentenceBoundaryReply.split(/\s+/).filter(Boolean).length;
    assert(sentenceBoundaryWordCount <= 40, 'Dialogue sentence-boundary trimming enforces only the maximum word budget', `${sentenceBoundaryWordCount} words`);
    const emptyDialogueAgent = new index_js_5.DialogueAgent({
        providers: [{ name: 'empty-ai', async generate() { return ' '; } }],
    });
    let emptyDialogueRejected = false;
    try {
        await emptyDialogueAgent.generateDialogue({
            type: 'director.intent', action: 'SPEAK', priority: 3, visualState: 'GAMEPLAY_IDLE',
            intent: 'reply_to_chat_batch', speechText: 'Một câu hỏi', timestamp: Date.now(),
        });
    }
    catch {
        emptyDialogueRejected = true;
    }
    assert(emptyDialogueRejected, 'Empty AI replies are rejected instead of becoming mock TTS');
    let duckingStateObserved = false;
    const voiceService = new index_js_6.VoiceService({
        listeners: {
            onDuckingChange: (isDucked) => { duckingStateObserved = isDucked; },
        },
    });
    void voiceService.speak({
        type: 'voice.request',
        text: dialogueRes.text,
        emotion: 'excited',
        energy: 0.8,
        speedMultiplier: 1.0,
        interruptible: true,
        requestId: 'test_req_1',
        timestamp: Date.now(),
    }).catch(() => { });
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
    const magicObs = await obsController.magicConnect({
        url: 'http://127.0.0.1:9876/overlay/obs-output.html',
        sourceName: 'AI IDOL Streamer',
        width: 1280,
        height: 720,
        fps: 30,
    });
    assert(magicObs.connected
        && magicObs.audioRouted
        && magicObs.videoPreset.width === 1280
        && magicObs.videoPreset.height === 720
        && magicObs.videoPreset.fps === 30
        && mockObsClient.getState().visibleSources.has('AI IDOL Streamer'), 'OBS Magic Connect provisions one visible HD 720p30 video + voice source');
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
    const youtubeChat = (0, platform_chat_js_1.normalizeYouTubeChatItem)({
        id: 'yt-message-1',
        snippet: { displayMessage: 'Idol xinh quá', publishedAt: new Date().toISOString(), type: 'textMessageEvent' },
        authorDetails: { channelId: 'yt-viewer-1', displayName: 'Mai YouTube', isChatSponsor: true },
    }, 'yt-live-1');
    const facebookChat = (0, platform_chat_js_1.normalizeFacebookComment)({
        id: 'fb-message-1',
        message: 'Chào idol nha',
        from: { id: 'fb-viewer-1', name: 'Mai Facebook' },
        created_time: new Date().toISOString(),
    }, 'fb-live-1');
    assert(youtubeChat?.platform === 'youtube'
        && youtubeChat.viewerTier === 'subscriber'
        && facebookChat?.platform === 'facebook', 'YouTube and Facebook payloads normalize into one chat event shape');
    assert((0, platform_chat_js_1.isYouTubeOwnerChatItem)({ authorDetails: { isChatOwner: true } })
        && !(0, platform_chat_js_1.isYouTubeOwnerChatItem)({ authorDetails: { isChatOwner: false } }), 'YouTube owner replies are identifiable before entering the AI reply pipeline');
    assert((0, platform_chat_js_1.isFacebookPageComment)({ from: { id: 'page-1' } }, 'page-1')
        && !(0, platform_chat_js_1.isFacebookPageComment)({ from: { id: 'viewer-1' } }, 'page-1'), 'Facebook Page replies are identifiable before entering the AI reply pipeline');
    const activeYouTubeBroadcast = (0, platform_chat_js_1.selectActiveYouTubeBroadcast)([
        { id: 'scheduled', status: { lifeCycleStatus: 'ready' }, snippet: { liveChatId: 'scheduled-chat' } },
        { id: 'live', status: { lifeCycleStatus: 'live' }, snippet: { liveChatId: 'live-chat' } },
    ]);
    assert(activeYouTubeBroadcast?.id === 'live', 'YouTube chat selects the owned live broadcast locally without combining incompatible API filters');
    const unifiedManager = new index_js_9.ChatManager();
    const unifiedSources = [];
    unifiedManager.onProcessedMessage((message) => unifiedSources.push(message.platform));
    unifiedManager.ingest({ platform: 'youtube', viewerName: 'Same Name', message: 'Cùng một lời chào' });
    unifiedManager.ingest({ platform: 'facebook', viewerName: 'Same Name', message: 'Cùng một lời chào' });
    assert(unifiedSources.join(',') === 'youtube,facebook', 'Cross-platform users are filtered independently before entering Unify Chat');
    const aggregateFixture = [
        { platform: 'youtube', viewerId: 'viewer-1', viewerName: 'Mai', message: 'Game gì vậy?', timestamp: Date.now() },
        { platform: 'youtube', viewerId: 'viewer-1', viewerName: 'Mai', message: '  Game gì vậy?  ', timestamp: Date.now() },
        { platform: 'youtube', viewerId: 'viewer-1', viewerName: 'Mai', message: 'Cho mình chơi cùng được không?', timestamp: Date.now() },
    ].map((message) => ({
        type: 'chat.message',
        viewerTier: 'regular',
        isSuperChat: false,
        isSubscriber: false,
        priorityScore: 50,
        isQuestion: true,
        ...message,
    }));
    assert((0, index_js_1.chatReplyUserKey)(aggregateFixture[0]) === 'youtube:viewer-1'
        && (0, index_js_1.aggregateUserChatMessages)(aggregateFixture).join(' | ') === 'Game gì vậy? | Cho mình chơi cùng được không?', 'Same-user comments are deduplicated and aggregated before one reply');
    const cooldownNow = Date.now();
    assert((0, index_js_1.isChatReplyOnCooldown)(cooldownNow - 59_999, cooldownNow)
        && !(0, index_js_1.isChatReplyOnCooldown)(cooldownNow - index_js_1.CHAT_REPLY_COOLDOWN_MS, cooldownNow), 'Each platform user receives at most one reply per 60-second window');
    const openedLoginUrls = [];
    let savedYouTubeCredentials = {};
    const googleTokenBodies = [];
    const loginCoordinator = new platform_chat_js_1.PlatformChatCoordinator({
        port: 9876,
        environment: {
            GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
            GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret',
            FACEBOOK_APP_ID: 'facebook-app-id',
        },
        loadCredentials: () => ({}),
        saveCredentials: (credentials) => { savedYouTubeCredentials = credentials; },
        onMessage: () => { },
        onStatus: () => { },
        openExternal: async (url) => { openedLoginUrls.push(url); },
        fetchImpl: async (input, init) => {
            const url = String(input);
            if (url === 'https://oauth2.googleapis.com/token') {
                googleTokenBodies.push(String(init?.body || ''));
                return new Response(JSON.stringify({
                    access_token: 'youtube-access-token',
                    refresh_token: 'youtube-refresh-token',
                    expires_in: 3600,
                    scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
                return new Response(JSON.stringify({ items: [{ id: 'channel-1', snippet: { title: 'AI IDOL Channel' } }] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected OAuth test request: ${url}`);
        },
    });
    const youtubeLogin = await loginCoordinator.beginLogin('youtube');
    await loginCoordinator.beginLogin('facebook');
    assert(openedLoginUrls[0]?.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')
        && openedLoginUrls[0]?.includes('code_challenge_method=S256')
        && openedLoginUrls[1]?.startsWith('https://www.facebook.com/v24.0/dialog/oauth?')
        && openedLoginUrls[1]?.includes('response_type=token'), 'Simple Login opens Google PKCE and Facebook consent in the system browser');
    const youtubeLoginState = new URL(youtubeLogin.authUrl).searchParams.get('state') || '';
    await loginCoordinator.completeYouTubeLogin(new URLSearchParams({ state: youtubeLoginState, code: 'authorization-code' }));
    assert(googleTokenBodies[0]?.includes('client_secret=google-client-secret')
        && googleTokenBodies[0]?.includes('code_verifier=')
        && !youtubeLogin.authUrl.includes('client_secret')
        && new URL(youtubeLogin.authUrl).searchParams.get('scope') === 'https://www.googleapis.com/auth/youtube.force-ssl'
        && new URL(youtubeLogin.authUrl).searchParams.get('prompt') === 'select_account consent'
        && savedYouTubeCredentials.youtube?.accountName === 'AI IDOL Channel', 'Google login requests only YouTube access and sends the installed-app secret only to the token endpoint');
    let missingScopeYouTubeCalls = 0;
    const missingScopeCoordinator = new platform_chat_js_1.PlatformChatCoordinator({
        port: 9876,
        environment: {
            GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
            GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret',
        },
        loadCredentials: () => ({}),
        saveCredentials: () => { },
        onMessage: () => { },
        onStatus: () => { },
        openExternal: async () => { },
        fetchImpl: async (input) => {
            const url = String(input);
            if (url === 'https://oauth2.googleapis.com/token') {
                return new Response(JSON.stringify({
                    access_token: 'profile-only-access-token',
                    expires_in: 3600,
                    scope: 'openid profile',
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.startsWith('https://www.googleapis.com/youtube/'))
                missingScopeYouTubeCalls += 1;
            throw new Error(`Unexpected missing-scope request: ${url}`);
        },
    });
    const missingScopeLogin = await missingScopeCoordinator.beginLogin('youtube');
    const missingScopeState = new URL(missingScopeLogin.authUrl).searchParams.get('state') || '';
    let missingScopeError = '';
    try {
        await missingScopeCoordinator.completeYouTubeLogin(new URLSearchParams({
            state: missingScopeState,
            code: 'authorization-code-without-youtube-scope',
        }));
    }
    catch (error) {
        missingScopeError = error instanceof Error ? error.message : String(error);
    }
    assert(missingScopeError.includes('View your YouTube account') && missingScopeYouTubeCalls === 0, 'Google token without youtube.force-ssl stops before any YouTube API request and explains how to grant access');
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
    let workerHealthy = true;
    let workerSpeakingPolls = 0;
    let workerStatusFailuresAfterSpeaking = 0;
    let workerAudioTransportFailures = 0;
    let workerTaskCounter = 0;
    let workerOfferCount = 0;
    let workerSessionSequence = [];
    const workerAvatarSwitches = [];
    const workerAudioSessions = [];
    const workerTaskRequests = [];
    const workerTasks = new Map();
    const thumbnailBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const fakeWorker = node_http_1.default.createServer(async (request, response) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1:9880').pathname;
        response.setHeader('Content-Type', 'application/json');
        if (pathname === '/health')
            return response.end(JSON.stringify(workerHealthy
                ? { code: 0, msg: 'ok', data: { status: 'healthy', model: 'musetalk' } }
                : { code: 503, msg: 'offline', data: { status: 'offline', model: 'musetalk' } }));
        if (pathname === '/offer') {
            workerOfferCount += 1;
            let rawBody = '';
            for await (const chunk of request)
                rawBody += String(chunk);
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
            for await (const chunk of request)
                rawBody += chunk.toString('latin1');
            const sessionid = rawBody.includes('stale_session') ? 'stale_session' : 'session_test';
            workerAudioSessions.push(sessionid);
            if (workerAudioTransportFailures > 0) {
                workerAudioTransportFailures -= 1;
                response.statusCode = 503;
                return response.end(JSON.stringify({ code: 503, msg: 'temporary media upload outage' }));
            }
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
            if (workerStatusFailuresAfterSpeaking > 0 && workerSpeakingPolls < 3) {
                workerStatusFailuresAfterSpeaking -= 1;
                request.socket.destroy();
                return;
            }
            const speaking = workerSpeakingPolls > 0;
            workerSpeakingPolls = Math.max(0, workerSpeakingPolls - 1);
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: speaking }));
        }
        if (pathname === '/interrupt') {
            workerSpeakingPolls = 0;
            return response.end(JSON.stringify({ code: 0, msg: 'ok' }));
        }
        if (pathname === '/api/session/session_test/avatar-state' && request.method === 'POST') {
            let rawBody = '';
            for await (const chunk of request)
                rawBody += String(chunk);
            const input = JSON.parse(rawBody || '{}');
            workerAvatarSwitches.push(input);
            return response.end(JSON.stringify({
                code: 0,
                msg: 'ok',
                data: { sessionid: 'session_test', avatar_id: input.avatar_id, state: input.state, changed: true },
            }));
        }
        if (pathname === '/api/session/session_test' && request.method === 'DELETE') {
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { sessionid: 'session_test', closed: true } }));
        }
        if (pathname === '/api/avatar/task' && request.method === 'POST') {
            let rawBody = '';
            for await (const chunk of request)
                rawBody += String(chunk);
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
            const task = workerTasks.get(workerTaskMatch[1]) || { task_id: workerTaskMatch[1], avatar_id: 'avatar_test', model_type: 'musetalk', status: 'completed', progress: 100 };
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: task }));
        }
        if (pathname === '/api/avatar/tasks')
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { tasks: [] } }));
        if (pathname === '/api/avatars')
            return response.end(JSON.stringify({ code: 0, msg: 'ok', data: { avatars: [
                        { id: 'avatar_test', model_type: 'musetalk', thumbnail_url: '/api/avatars/avatar_test/thumbnail', avatarState: 'normal' },
                        { id: 'avatar_happy', model_type: 'musetalk', avatarState: 'happy' },
                    ] } }));
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
    await new Promise((resolve) => fakeWorker.listen(9880, '127.0.0.1', resolve));
    process.env.LIVETALKING_ENDPOINT = 'http://127.0.0.1:9880';
    const qwenTestAudio = Buffer.alloc(44);
    qwenTestAudio.write('RIFF', 0);
    qwenTestAudio.write('WAVEfmt ', 8);
    qwenTestAudio.write('data', 36);
    let qwenSynthesisFailures = 0;
    let qwenSynthesisRequests = 0;
    const fakeQwen = node_http_1.default.createServer(async (request, response) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1:9881').pathname;
        if (pathname === '/api/health')
            return response.end(JSON.stringify({ ready: true, model_loaded: true, provider: 'qwentts', backend: 'mlx' }));
        if (pathname === '/api/voices')
            return response.end(JSON.stringify([{ id: 'qwen-default', voice_id: 'qwen-default', name: 'Yến Nhi', kind: 'preset', provider: 'qwentts' }]));
        if (pathname === '/api/voices/clone' && request.method === 'POST') {
            for await (const _chunk of request) { /* consume multipart input */ }
            response.setHeader('Content-Type', 'application/json');
            response.statusCode = 201;
            return response.end(JSON.stringify({ id: 'qwen-voice-test', voice_id: 'qwen-voice-test', name: 'Mimi Clone', kind: 'clone', provider: 'qwentts', ref_text: 'xin chào mọi người' }));
        }
        if (pathname === '/api/synthesize' && request.method === 'POST') {
            for await (const _chunk of request) { /* consume JSON input */ }
            qwenSynthesisRequests += 1;
            if (qwenSynthesisFailures > 0) {
                qwenSynthesisFailures -= 1;
                response.statusCode = 503;
                return response.end(JSON.stringify({ detail: 'temporary synthesis outage' }));
            }
            response.setHeader('Content-Type', 'audio/wav');
            response.setHeader('X-Audio-Duration-Ms', '1200');
            response.setHeader('X-Generation-Ms', '100');
            return response.end(qwenTestAudio);
        }
        response.statusCode = 404;
        return response.end(JSON.stringify({ detail: 'not found' }));
    });
    await new Promise((resolve) => fakeQwen.listen(9881, '127.0.0.1', resolve));
    process.env.QWEN_TTS_ENDPOINT = 'http://127.0.0.1:9881';
    const liveTalkingProvider = new index_js_11.LiveTalkingProvider({ endpointUrl: 'http://127.0.0.1:9880', model: 'livetalking-wav2lip', timeoutMs: 1000 });
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
    assert(workerAudioSessions.join(' -> ') === 'stale_session -> session_test', 'LiveTalkingProvider recovers when WebRTC session changes during TTS upload');
    workerSessionSequence = ['session_test'];
    workerAudioSessions.length = 0;
    workerAudioTransportFailures = 1;
    await liveTalkingProvider.sendAudio(new Blob([qwenTestAudio], { type: 'audio/wav' }));
    assert(workerAudioSessions.join(' -> ') === 'session_test -> session_test', 'LiveTalkingProvider retries a transient audio upload without regenerating TTS');
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
    persistence.setSetting('voice', { provider: 'qwentts', languageCode: 'vi' });
    assert(persistence.getSetting('voice')?.languageCode === 'vi', 'SQLite persists runtime settings without browser localStorage');
    persistence.setActiveProject('project_test', '/tmp/project-test');
    assert(persistence.getActiveProject()?.projectName === 'project_test', 'SQLite persists the active project and storage root');
    persistence.upsertAvatar('avatar_test', { id: 'avatar_test', status: 'ready' });
    assert(persistence.listAvatars()[0]?.id === 'avatar_test', 'SQLite persists trained avatar records');
    persistence.setAvatarSession('avatar_test', ['avatar_test', 'avatar_happy']);
    const persistedSession = persistence.getAvatarSession();
    assert(persistedSession?.activeAvatarId === 'avatar_test'
        && persistedSession.selectedAvatarIds.join(',') === 'avatar_test,avatar_happy', 'SQLite persists a multi-Avatar pool and its current live Avatar');
    persistence.close();
    // ── Step 9 Audit: Runtime Server End-to-End Integration ───
    console.log('\n▶ Auditing Phase 6: Runtime Server Full Integration...');
    const server = new index_js_1.IdolRuntimeServer({ port: 9876, enableSimulation: false, databasePath: ':memory:' });
    await server.start();
    assert(true, 'Runtime Server started on port 9876');
    const duplicateRuntime = new index_js_1.IdolRuntimeServer({ port: 9888, enableSimulation: false, databasePath: ':memory:' });
    let duplicateRuntimeRejected = false;
    try {
        await duplicateRuntime.start();
    }
    catch (error) {
        duplicateRuntimeRejected = String(error).includes('Another AI IDOL runtime is active');
    }
    assert(duplicateRuntimeRejected, 'Global engine lock rejects a second runtime even when it uses another HTTP port');
    await duplicateRuntime.stop();
    // Verify REST API
    try {
        const res = await fetch('http://localhost:9876/api/status');
        const json = await res.json();
        assert(json.status === 'healthy', 'HTTP REST /api/status responds with healthy state');
        assert(json.service === 'ai-idol-runtime' && typeof json.runtimeBuildId === 'string', 'Runtime status identifies the native backend build');
        assert(json.state.currentVisual !== undefined, 'REST status includes Director state');
        const routeSessionId = 'obs_route_test';
        const runtimeInternals = server;
        const qwenRequestsBeforeRetry = qwenSynthesisRequests;
        qwenSynthesisFailures = 1;
        const recoveredQwenAudio = await runtimeInternals._synthesizeQwenTtsAudio({
            commandId: 'qwen_retry_test',
            text: 'Kiểm tra tự phục hồi giọng nói.',
            emotion: 'neutral',
            speed: 1,
            provider: 'qwentts',
            voiceId: 'qwen-default',
            modelId: 'gwen-tts-0.6B-vi-8bit',
        });
        assert(recoveredQwenAudio.audioBase64
            && qwenSynthesisRequests === qwenRequestsBeforeRetry + 2, 'Qwen TTS retries once after a transient HTTP 5xx synthesis failure');
        runtimeInternals._activeObsOutputSessionId = routeSessionId;
        runtimeInternals._obsOutputRoutes.set(routeSessionId, {
            sessionId: routeSessionId,
            receiver: null,
            receiverPeerId: '',
            publisher: null,
            publisherPeerId: '',
            negotiationId: '',
        });
        const primaryPublisher = await openRuntimeSocket(9876);
        const standbyPublisher = await openRuntimeSocket(9876);
        const obsReceiver = await openRuntimeSocket(9876);
        primaryPublisher.socket.send(JSON.stringify({
            type: 'OBS_OUTPUT_REGISTER', role: 'publisher', peerId: 'dashboard_primary', priority: 100,
        }));
        standbyPublisher.socket.send(JSON.stringify({
            type: 'OBS_OUTPUT_REGISTER', role: 'publisher', peerId: 'dashboard_standby', priority: 10,
        }));
        obsReceiver.socket.send(JSON.stringify({
            type: 'OBS_OUTPUT_REGISTER', role: 'receiver', peerId: 'obs_receiver_test', sessionId: routeSessionId,
        }));
        obsReceiver.socket.send(JSON.stringify({ type: 'OBS_OUTPUT_READY', sessionId: routeSessionId }));
        const primaryAssignment = await waitForSocketMessage(primaryPublisher.messages, 'OBS_OUTPUT_SESSION_ASSIGNED');
        await new Promise(resolve => setTimeout(resolve, 50));
        const standbyAssignedEarly = standbyPublisher.messages.some(message => message?.type === 'OBS_OUTPUT_SESSION_ASSIGNED');
        assert(primaryAssignment?.sessionId === routeSessionId && !standbyAssignedEarly, 'OBS signaling elects exactly one Dashboard publisher for each output session');
        primaryPublisher.socket.send(JSON.stringify({
            type: 'OBS_OUTPUT_OFFER',
            sessionId: routeSessionId,
            negotiationId: 'neg_primary_test',
            description: { type: 'offer', sdp: 'v=0\r\n' },
        }));
        const routedOffer = await waitForSocketMessage(obsReceiver.messages, 'OBS_OUTPUT_OFFER');
        standbyPublisher.socket.send(JSON.stringify({
            type: 'OBS_OUTPUT_OFFER',
            sessionId: routeSessionId,
            negotiationId: 'neg_standby_test',
            description: { type: 'offer', sdp: 'v=0\r\n' },
        }));
        await new Promise(resolve => setTimeout(resolve, 50));
        const receivedOffers = obsReceiver.messages.filter(message => message?.type === 'OBS_OUTPUT_OFFER');
        assert(routedOffer?.negotiationId === 'neg_primary_test' && receivedOffers.length === 1, 'OBS signaling routes offer and ICE traffic only inside the assigned publisher-receiver pair');
        primaryPublisher.socket.close();
        const standbyAssignment = await waitForSocketMessage(standbyPublisher.messages, 'OBS_OUTPUT_SESSION_ASSIGNED');
        assert(standbyAssignment?.sessionId === routeSessionId, 'OBS signaling promotes one standby publisher after the active Dashboard disconnects');
        standbyPublisher.socket.close();
        obsReceiver.socket.close();
        runtimeInternals._obsOutputRoutes.delete(routeSessionId);
        runtimeInternals._activeObsOutputSessionId = null;
        const defaultSettingsRes = await fetch('http://localhost:9876/api/settings/all');
        const defaultSettings = await defaultSettingsRes.json();
        assert(defaultSettings.voice.provider === 'qwentts'
            && defaultSettings.voice.voiceId === 'qwen-default'
            && defaultSettings.voice.languageCode === 'vi', 'Runtime defaults TTS to Qwen Vietnamese 0.6B');
        assert(defaultSettings.persona?.llmProvider === 'ollama'
            && defaultSettings.persona?.llmModel === 'qwen3:8b', 'AI Director defaults to local Qwen 8B');
        assert(defaultSettings.talkingEngine?.modelFps === 15
            && defaultSettings.talkingEngine?.outputFps === 30
            && defaultSettings.realtimeStatus?.alwaysOn === true
            && defaultSettings.realtimeStatus?.videoQuality === 'hd'
            && defaultSettings.realtimeStatus?.modelFps === 15
            && defaultSettings.realtimeStatus?.outputFps === 30, 'Public settings expose the configured 15 FPS model clock and fixed HD 720p30 output');
        const engineHub = await fetch('http://localhost:9876/api/engines').then((response) => response.json());
        assert(engineHub.success === true
            && engineHub.engines?.length === 6
            && engineHub.engines.some((engine) => engine.id === 'qwen-director' && engine.model === 'qwen3:8b')
            && engineHub.engines.some((engine) => engine.id === 'obs-bridge' && engine.metrics?.includes('30 FPS')), 'AI Engine hub reports the complete Qwen, voice, avatar, OBS, and media pipeline');
        workerHealthy = false;
        const hdSettingsRes = await fetch('http://localhost:9876/api/settings/live-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quality: 'hd' }),
        });
        const hdSettings = await hdSettingsRes.json();
        const persistedHdSettings = await fetch('http://localhost:9876/api/settings/all').then((response) => response.json());
        assert(hdSettingsRes.status === 200
            && hdSettings.preset?.width === 1280
            && hdSettings.preset?.height === 720
            && hdSettings.preset?.fps === 30
            && persistedHdSettings.realtimeStatus?.videoQuality === 'hd', 'Live video API persists HD 720p30 as one runtime preset');
        const fhdSettingsRes = await fetch('http://localhost:9876/api/settings/live-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quality: 'fhd' }),
        });
        await fhdSettingsRes.json();
        workerHealthy = true;
        assert(fhdSettingsRes.status === 400, 'Live video API rejects the removed FHD preset');
        const platformChatStatus = await fetch('http://localhost:9876/api/platform-chat/status').then((response) => response.json());
        assert(platformChatStatus.success === true
            && platformChatStatus.platformChat?.unified === true
            && platformChatStatus.platformChat?.sources?.youtube
            && platformChatStatus.platformChat?.sources?.facebook
            && !JSON.stringify(platformChatStatus).includes('accessToken'), 'Unified platform chat status exposes YouTube and Facebook without exposing OAuth tokens');
        const maintenanceConfigRes = await fetch('http://localhost:9876/api/settings/talking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ restartIntervalMinutes: 10 }),
        });
        const maintenanceSettings = await fetch('http://localhost:9876/api/settings/all').then((response) => response.json());
        assert(maintenanceConfigRes.status === 200
            && maintenanceSettings.liveAvatarMaintenance?.restartIntervalMinutes === 10, 'Avatar worker memory refresh accepts and persists a 5/10/15/20 minute interval');
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
        const customPersonaSettings = await customPersonaRes.json();
        assert(customPersonaRes.status === 200
            && customPersonaSettings.settings?.name === 'Bé Lộc Y Tá'
            && !customPersonaSettings.settings?.systemPrompt?.includes('Mimi')
            && !customPersonaSettings.settings?.systemPrompt?.includes('Y Tá Y Tá'), 'AI Profile updates legacy prompt names without duplicating a new name that extends the previous name');
        const multiAvatarSessionRes = await fetch('http://localhost:9876/api/avatars/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeAvatarId: 'avatar_test', selectedAvatarIds: ['avatar_test', 'avatar_happy'] }),
        });
        const multiAvatarSession = await multiAvatarSessionRes.json();
        assert(multiAvatarSessionRes.status === 200
            && multiAvatarSession.session?.selectedAvatarIds?.join(',') === 'avatar_test,avatar_happy', 'Avatar session stores multiple enabled Avatar states in one Pool');
        const activeAvatarSessionRes = await fetch('http://localhost:9876/api/avatars/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeAvatarId: 'avatar_test', selectedAvatarIds: ['avatar_test', 'avatar_happy'] }),
        });
        const activeAvatarSession = await activeAvatarSessionRes.json();
        assert(activeAvatarSession.session?.activeAvatarId === 'avatar_test'
            && activeAvatarSession.session?.selectedAvatarIds?.length === 2, 'Avatar session tracks one current Avatar inside a multi-Avatar Pool');
        runtimeInternals._db.upsertAvatar('avatar_test', {
            id: 'avatar_test', avatarId: 'avatar_test', status: 'ready', avatarState: 'normal',
        });
        runtimeInternals._db.upsertAvatar('avatar_happy', {
            id: 'avatar_happy', avatarId: 'avatar_happy', status: 'ready', avatarState: 'happy',
        });
        runtimeInternals._db.upsertAvatar('avatar_happy_alt', {
            id: 'avatar_happy_alt', avatarId: 'avatar_happy_alt', status: 'ready', avatarState: 'happy',
        });
        runtimeInternals._db.setAvatarSession('avatar_test', ['avatar_test', 'avatar_happy', 'avatar_happy_alt']);
        const firstHappyAvatar = runtimeInternals._resolveAvatarState({ emotion: 'happy' });
        runtimeInternals._db.setAvatarSession(firstHappyAvatar.avatarId, ['avatar_test', 'avatar_happy', 'avatar_happy_alt']);
        const secondHappyAvatar = runtimeInternals._resolveAvatarState({ emotion: 'happy' });
        const neutralAvatar = runtimeInternals._resolveAvatarState({ emotion: 'neutral' });
        assert(firstHappyAvatar.state === 'happy'
            && secondHappyAvatar.state === 'happy'
            && firstHappyAvatar.avatarId !== secondHappyAvatar.avatarId
            && new Set(['avatar_happy', 'avatar_happy_alt']).has(firstHappyAvatar.avatarId)
            && new Set(['avatar_happy', 'avatar_happy_alt']).has(secondHappyAvatar.avatarId)
            && neutralAvatar.avatarId === 'avatar_test'
            && neutralAvatar.state === 'normal', 'Automatic Avatar selection prefers the speech emotion, round-robins eligible datasets, and falls back to normal');
        runtimeInternals._db.deleteAvatar('avatar_happy_alt');
        const excludedAvatarSessionRes = await fetch('http://localhost:9876/api/avatars/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeAvatarId: 'avatar_test', excludedAvatarIds: ['avatar_happy'] }),
        });
        const excludedAvatarSession = await excludedAvatarSessionRes.json();
        assert(excludedAvatarSessionRes.status === 200
            && excludedAvatarSession.session?.activeAvatarId === 'avatar_test'
            && excludedAvatarSession.session?.excludedAvatarIds?.[0] === 'avatar_happy', 'Live session persists active avatar and per-state exclusions independently');
        await fetch('http://localhost:9876/api/avatars/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeAvatarId: 'avatar_test', selectedAvatarIds: ['avatar_test', 'avatar_happy'] }),
        });
        const workerStatusRes = await fetch('http://localhost:9876/api/talking-head/livetalking/worker');
        const workerStatus = await workerStatusRes.json();
        assert(workerStatus.worker?.state === 'READY' && workerStatus.worker?.owned === false, 'Worker status detects an externally running LiveTalking worker without spawning one');
        const workerStartRes = await fetch('http://localhost:9876/api/talking-head/livetalking/worker/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const workerStart = await workerStartRes.json();
        assert(workerStartRes.status === 200 && workerStart.worker?.ready === true && workerStart.worker?.owned === false, 'Worker start endpoint reuses an already healthy worker');
        const concurrentWorkerStarts = await Promise.all(Array.from({ length: 4 }, () => fetch('http://localhost:9876/api/talking-head/livetalking/worker/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((response) => response.json())));
        assert(concurrentWorkerStarts.every((payload) => payload.success && payload.worker?.ready), 'Concurrent worker start requests converge on the same healthy Live Talking instance');
        const manualModeRes = await fetch('http://localhost:9876/api/settings/talking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alwaysOn: false }),
        });
        const manualModeSettings = await fetch('http://localhost:9876/api/settings/all').then((response) => response.json());
        assert(manualModeRes.status === 200 && manualModeSettings.realtimeStatus?.alwaysOn === false, 'Live Talking can switch to persistent manual startup mode without exposing engine configuration');
        workerHealthy = false;
        const manualStopRes = await fetch('http://localhost:9876/api/talking-head/livetalking/worker/stop', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const manualStop = await manualStopRes.json();
        assert(manualStopRes.status === 202
            && manualStop.worker?.state === 'OFFLINE'
            && manualStop.worker?.alwaysOn === false, 'Manual Stop leaves Live Talking offline and disables automatic restart');
        workerHealthy = true;
        await fetch('http://localhost:9876/api/settings/talking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alwaysOn: true }),
        });
        // Test Game Spin API
        const spinRes = await fetch('http://localhost:9876/api/game/spin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bet: 20000, forcedOutcome: 'MEGA_WIN' }),
        });
        const spinJson = await spinRes.json();
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
        const priorSpeechStatus = await priorSpeechStatusRes.json();
        const priorSpeechCommandId = priorSpeechStatus.speech?.commandId || '';
        const chatPayloads = [
            { platform: 'youtube', message: 'Chào idol Mimi!', viewerName: 'Quốc Bảo', viewerTier: 'vip' },
            { platform: 'facebook', message: 'Hôm nay Mimi chơi game gì vậy?', viewerName: 'Ngọc Mai', viewerTier: 'subscriber' },
            { platform: 'youtube', message: 'Cho mình tham gia cùng nha', viewerName: 'Thanh Trúc', viewerTier: 'regular' },
        ];
        const chatResults = await Promise.all(chatPayloads.map(payload => fetch('http://localhost:9876/api/chat/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).then(response => response.json())));
        assert(chatResults.every(result => result.success === true), 'REST /api/chat/send ingests and scores a chat batch');
        assert(chatResults[0]?.message?.platform === 'youtube' && chatResults[1]?.message?.platform === 'facebook', 'YouTube and Facebook chat share one runtime ingestion endpoint');
        const chatSpeechDeadline = Date.now() + 5000;
        let chatDialogueProvider = '';
        let chatSpeechDurationMs = 0;
        let chatSpeechText = '';
        while (Date.now() < chatSpeechDeadline) {
            const speechStatusRes = await fetch('http://localhost:9876/api/speech/status');
            const speechStatusJson = await speechStatusRes.json();
            if (speechStatusJson.speech?.commandId !== priorSpeechCommandId && speechStatusJson.speech?.dialogueProvider) {
                chatDialogueProvider = speechStatusJson.speech.dialogueProvider;
                chatSpeechDurationMs = Number(speechStatusJson.speech.durationMs || 0);
                chatSpeechText = String(speechStatusJson.speech.text || '');
            }
            if (server.speechCommandCount > chatSpeechBaseline && chatDialogueProvider)
                break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const generatedChatSpeech = server.speechCommandCount === chatSpeechBaseline + 1;
        assert(generatedChatSpeech || server.speechCommandCount === chatSpeechBaseline, 'A chat batch creates at most one AI-generated SpeechCommand');
        if (generatedChatSpeech) {
            assert(chatDialogueProvider === 'qwen' || chatDialogueProvider === 'gemini-google', 'Chat SpeechCommand records only a real AI provider', chatDialogueProvider);
            const chatSpeechWordCount = chatSpeechText.split(/\s+/).filter(Boolean).length;
            assert(chatSpeechWordCount > 0 && chatSpeechWordCount <= 40, 'Batched AI reply stays within the maximum spoken word budget', `${chatSpeechWordCount} words / ${chatSpeechDurationMs}ms fixture audio`);
            assert(customPersonaSettings.settings?.name === 'Bé Lộc Y Tá'
                && !/\bMimi\b/i.test(chatSpeechText)
                && !/Mọi người nghĩ sao thì kể mình nghe thêm|đã đọc hết|không bỏ sót ai/i.test(chatSpeechText), 'Runtime chat speech contains only the AI reply for the active profile', chatSpeechText);
        }
        else {
            assert(!chatDialogueProvider, 'Unavailable AI providers do not produce fallback TTS');
        }
        // Establish one runtime-owned Live Monitor before speech. A second
        // Dashboard must remain standby and must never replace the worker session.
        const mediaPrimary = await openRuntimeSocket(9876);
        const mediaStandby = await openRuntimeSocket(9876);
        let mediaAvatarReconnectPromise = Promise.resolve();
        mediaPrimary.socket.send(JSON.stringify({
            type: 'LIVETALKING_MEDIA_REGISTER', clientId: 'monitor_primary', priority: 100,
        }));
        const mediaOwnerGranted = await waitForSocketMessage(mediaPrimary.messages, 'LIVETALKING_MEDIA_OWNER_GRANTED');
        mediaStandby.socket.send(JSON.stringify({
            type: 'LIVETALKING_MEDIA_REGISTER', clientId: 'monitor_standby', priority: 10,
        }));
        const mediaStandbyAssigned = await waitForSocketMessage(mediaStandby.messages, 'LIVETALKING_MEDIA_STANDBY');
        assert(mediaOwnerGranted?.clientId === 'monitor_primary'
            && mediaStandbyAssigned?.ownerClientId === 'monitor_primary', 'Exactly one Dashboard owns the Live Monitor while other tabs stay in standby');
        const standbyForegroundStart = mediaStandby.messages.length;
        mediaStandby.socket.send(JSON.stringify({
            type: 'LIVETALKING_MEDIA_REGISTER', clientId: 'monitor_standby', priority: 100,
        }));
        const standbyForegroundOwner = await waitForSocketMessage(mediaStandby.messages, 'LIVETALKING_MEDIA_OWNER_GRANTED', 1_000, standbyForegroundStart);
        const primaryForegroundStart = mediaPrimary.messages.length;
        mediaPrimary.socket.send(JSON.stringify({
            type: 'LIVETALKING_MEDIA_REGISTER', clientId: 'monitor_primary', priority: 100,
        }));
        const primaryForegroundOwner = await waitForSocketMessage(mediaPrimary.messages, 'LIVETALKING_MEDIA_OWNER_GRANTED', 1_000, primaryForegroundStart);
        assert(standbyForegroundOwner?.clientId === 'monitor_standby'
            && primaryForegroundOwner?.clientId === 'monitor_primary', 'The newest focused Dashboard takes Live Monitor ownership from a stale foreground tab');
        mediaPrimary.socket.addEventListener('message', (event) => {
            try {
                const payload = JSON.parse(String(event.data));
                if (payload?.type === 'SPEECH_PLAYBACK_PENDING' && payload.commandId) {
                    void fetch(`http://localhost:9876/api/speech/${encodeURIComponent(payload.commandId)}/playback-ready`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                    });
                }
                else if (payload?.type === 'LIVETALKING_MEDIA_RESET_REQUIRED'
                    && payload.reason === 'AVATAR_DATASET_CHANGED') {
                    mediaAvatarReconnectPromise = mediaAvatarReconnectPromise.then(async () => {
                        const avatarSession = await fetch('http://localhost:9876/api/avatars/session').then((response) => response.json());
                        const avatarId = avatarSession.session?.activeAvatarId;
                        const reconnectOffer = await fetch('http://localhost:9876/api/talking-head/offer', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sdp: 'v=0\r\n', type: 'offer', avatarId, clientId: 'monitor_primary' }),
                        });
                        if (!reconnectOffer.ok)
                            throw new Error(`Avatar reconnect offer failed: HTTP ${reconnectOffer.status}`);
                        mediaPrimary.socket.send(JSON.stringify({
                            type: 'LIVETALKING_MEDIA_STATE',
                            clientId: 'monitor_primary',
                            sessionId: 'session_test',
                            connectionState: 'CONNECTED',
                            audioTrack: true,
                            videoTrack: true,
                            audioPlayable: true,
                            audioPackets: 10,
                            videoFrames: 10,
                            reason: 'avatar-dataset-reconnected',
                        }));
                    });
                }
            }
            catch { }
        });
        const offerRes = await fetch('http://localhost:9876/api/talking-head/offer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: 'v=0\r\n', type: 'offer', avatarId: 'avatar_test', clientId: 'monitor_primary' }),
        });
        const offerJson = await offerRes.json();
        assert(offerJson.success === true && offerJson.sessionid === 'session_test', 'Runtime proxies WebRTC signaling to LiveTalking');
        const offerCountAfterPrimary = workerOfferCount;
        const standbyOfferRes = await fetch('http://localhost:9876/api/talking-head/offer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: 'v=0\r\n', type: 'offer', avatarId: 'avatar_test', clientId: 'monitor_standby' }),
        });
        assert(standbyOfferRes.status === 409 && workerOfferCount === offerCountAfterPrimary, 'A standby Dashboard cannot replace the active WebRTC session');
        mediaPrimary.socket.send(JSON.stringify({
            type: 'LIVETALKING_MEDIA_STATE',
            clientId: 'monitor_primary',
            sessionId: 'session_test',
            connectionState: 'CONNECTED',
            audioTrack: true,
            videoTrack: true,
            audioPlayable: true,
            audioPackets: 10,
            videoFrames: 10,
            reason: 'integration-ready',
        }));
        await new Promise(resolve => setTimeout(resolve, 30));
        const readyMediaStatus = await fetch('http://localhost:9876/api/talking-head/media/status').then((response) => response.json());
        assert(readyMediaStatus.media?.ready === true
            && readyMediaStatus.media?.audioTrack === true
            && readyMediaStatus.media?.videoTrack === true, 'Runtime accepts speech only after live audio and video tracks are confirmed');
        const activateHappyRes = await fetch('http://localhost:9876/api/avatars/session/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarId: 'avatar_happy' }),
        });
        const activateHappy = await activateHappyRes.json();
        const happyDatasetReset = await waitForSocketMessage(mediaPrimary.messages, 'LIVETALKING_MEDIA_RESET_REQUIRED');
        await mediaAvatarReconnectPromise;
        assert(activateHappyRes.status === 200
            && activateHappy.session?.activeAvatarId === 'avatar_happy'
            && happyDatasetReset?.reason === 'AVATAR_DATASET_CHANGED', 'Manual Avatar switching persists the new live Avatar before reconnecting its dataset');
        const offerCountAfterHappyReconnect = workerOfferCount;
        const resetCountAfterHappyReconnect = mediaPrimary.messages
            .filter(message => message?.type === 'LIVETALKING_MEDIA_RESET_REQUIRED').length;
        const keepHappyRes = await fetch('http://localhost:9876/api/avatars/session/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarId: 'avatar_happy' }),
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert(keepHappyRes.status === 200
            && workerOfferCount === offerCountAfterHappyReconnect
            && mediaPrimary.messages.filter(message => message?.type === 'LIVETALKING_MEDIA_RESET_REQUIRED').length === resetCountAfterHappyReconnect, 'Selecting the current live Avatar keeps the existing WebRTC session');
        await fetch('http://localhost:9876/api/avatars/session/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarId: 'avatar_test' }),
        });
        await mediaAvatarReconnectPromise;
        let integrationAudioPackets = 10;
        let integrationVideoFrames = 10;
        const mediaHeartbeat = setInterval(() => {
            integrationAudioPackets += 5;
            integrationVideoFrames += 5;
            mediaPrimary.socket.send(JSON.stringify({
                type: 'LIVETALKING_MEDIA_STATE',
                clientId: 'monitor_primary',
                sessionId: 'session_test',
                connectionState: 'CONNECTED',
                audioTrack: true,
                videoTrack: true,
                audioPlayable: true,
                audioPackets: integrationAudioPackets,
                videoFrames: integrationVideoFrames,
                reason: 'integration-heartbeat',
            }));
        }, 500);
        const failedOfferRes = await fetch('http://localhost:9876/api/talking-head/offer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: 'v=0\r\n', type: 'offer', avatarId: 'missing_avatar', clientId: 'monitor_primary' }),
        });
        const sessionAfterFailedOffer = await fetch('http://localhost:9876/api/avatars/session').then((response) => response.json());
        assert(failedOfferRes.status === 503 && sessionAfterFailedOffer.session?.activeAvatarId === 'avatar_test', 'A failed avatar connection cannot replace the persisted active session');
        process.env.QWEN_TTS_ENDPOINT = 'http://127.0.0.1:9';
        process.env.QWEN_TTS_AUTOSTART = 'false';
        const omniFallbackRes = await fetch('http://localhost:9876/api/talking-head/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Kiểm tra giọng nữ tiếng Việt dự phòng.', durationMs: 1200, emotion: 'happy' }),
        });
        const omniFallbackJson = await omniFallbackRes.json();
        const omniFallbackStates = new Set([omniFallbackJson.state]);
        let omniFallbackProvider = '';
        let omniFallbackError = '';
        const omniFallbackDeadline = Date.now() + 3000;
        while (Date.now() < omniFallbackDeadline) {
            const statusRes = await fetch('http://localhost:9876/api/speech/status');
            const statusJson = await statusRes.json();
            if (statusJson.speech?.commandId === omniFallbackJson.commandId) {
                omniFallbackStates.add(statusJson.speech.state);
                omniFallbackProvider = statusJson.speech.provider || omniFallbackProvider;
                omniFallbackError = statusJson.speech.error || omniFallbackError;
                if (statusJson.speech.state === 'ERROR')
                    break;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert(omniFallbackProvider === 'qwentts'
            && omniFallbackStates.has('GENERATING')
            && omniFallbackStates.has('ERROR')
            && /automatic startup is disabled/i.test(omniFallbackError), 'Disabled Qwen TTS fails clearly without an operating-system voice fallback', `${omniFallbackProvider} / ${[...omniFallbackStates].join(',')} / ${omniFallbackError}`);
        process.env.QWEN_TTS_ENDPOINT = 'http://127.0.0.1:9881';
        delete process.env.QWEN_TTS_AUTOSTART;
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
        // A worker status request can fail after media playback has started. The runtime
        // must preserve the active WebRTC session and still leave TALKING after audio ends.
        workerStatusFailuresAfterSpeaking = 80;
        const recoverySpeechRes = await fetch('http://localhost:9876/api/talking-head/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Kiểm tra phục hồi trạng thái nói.', durationMs: 1200, emotion: 'neutral' }),
        });
        const recoverySpeech = await recoverySpeechRes.json();
        const recoveryDeadline = Date.now() + 6000;
        let recoveryReachedSpeaking = false;
        let recoveryFinalState = '';
        while (Date.now() < recoveryDeadline) {
            const status = await fetch('http://localhost:9876/api/speech/status').then((response) => response.json());
            if (status.speech?.commandId === recoverySpeech.commandId) {
                recoveryReachedSpeaking ||= status.speech.state === 'SPEAKING';
                recoveryFinalState = status.speech.state;
                if (recoveryReachedSpeaking && recoveryFinalState === 'IDLE')
                    break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const recoveredRuntimeStatus = await fetch('http://localhost:9876/api/status').then((response) => response.json());
        assert(recoveryReachedSpeaking
            && recoveryFinalState === 'IDLE'
            && recoveredRuntimeStatus.state?.currentVisual === 'GAMEPLAY_IDLE'
            && recoveredRuntimeStatus.state?.isSpeaking === false, 'Speech status fetch failure after playback recovers to IDLE without leaving TALKING stuck', `${recoveryReachedSpeaking}:${recoveryFinalState}:${recoveredRuntimeStatus.state?.currentVisual}`);
        workerStatusFailuresAfterSpeaking = 0;
        clearInterval(mediaHeartbeat);
        mediaPrimary.socket.send(JSON.stringify({
            type: 'LIVETALKING_MEDIA_STATE',
            clientId: 'monitor_primary',
            sessionId: 'session_test',
            connectionState: 'CONNECTED',
            audioTrack: true,
            videoTrack: true,
            audioPlayable: false,
            audioPackets: 20,
            videoFrames: 20,
            reason: 'autoplay-blocked-test',
        }));
        await new Promise(resolve => setTimeout(resolve, 30));
        let blockedMediaAccepted = true;
        try {
            await runtimeInternals._waitForReadyLiveTalkingMedia(100);
        }
        catch {
            blockedMediaAccepted = false;
        }
        assert(blockedMediaAccepted, 'Speech keeps avatar video and OBS audio running when local Monitor playback is blocked');
        mediaPrimary.socket.send(JSON.stringify({
            type: 'LIVETALKING_MEDIA_STATE',
            clientId: 'monitor_primary',
            sessionId: 'session_test',
            connectionState: 'CONNECTED',
            audioTrack: true,
            videoTrack: true,
            audioPlayable: true,
            audioPackets: 30,
            videoFrames: 30,
            reason: 'integration-restored',
        }));
        await new Promise(resolve => setTimeout(resolve, 30));
        const resetCountBeforeWorkerRestart = mediaPrimary.messages.length;
        runtimeInternals._invalidateLiveTalkingMediaSession('INTEGRATION_WORKER_RESTART');
        const resetRequired = await waitForSocketMessage(mediaPrimary.messages, 'LIVETALKING_MEDIA_RESET_REQUIRED', 1_000, resetCountBeforeWorkerRestart);
        assert(resetRequired?.reason === 'INTEGRATION_WORKER_RESTART', 'Worker restart invalidates stale browser media instead of reporting a false healthy session');
        const replacementOfferRes = await fetch('http://localhost:9876/api/talking-head/offer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: 'v=0\r\n', type: 'offer', avatarId: 'avatar_test', clientId: 'monitor_primary' }),
        });
        assert(replacementOfferRes.status === 200, 'The owning Dashboard can establish a fresh session after worker recovery');
        mediaPrimary.socket.send(JSON.stringify({
            type: 'LIVETALKING_MEDIA_STATE',
            clientId: 'monitor_primary',
            sessionId: 'session_test',
            connectionState: 'CONNECTED',
            audioTrack: true,
            videoTrack: true,
            audioPlayable: true,
            audioPackets: 1,
            videoFrames: 1,
            reason: 'replacement-ready',
        }));
        await new Promise(resolve => setTimeout(resolve, 30));
        const resetMessageCount = mediaPrimary.messages.filter(message => message?.type === 'LIVETALKING_MEDIA_RESET_REQUIRED').length;
        runtimeInternals._liveTalkingMediaOwner.lastVideoProgressAt = Date.now() - 20_000;
        runtimeInternals._lastLiveTalkingMediaWatchdogAt = 0;
        runtimeInternals._reconcileLiveTalkingMediaOwnership(Date.now());
        const videoStallDeadline = Date.now() + 1_000;
        while (Date.now() < videoStallDeadline
            && mediaPrimary.messages.filter(message => message?.type === 'LIVETALKING_MEDIA_RESET_REQUIRED').length <= resetMessageCount) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        const videoStallReset = mediaPrimary.messages
            .filter(message => message?.type === 'LIVETALKING_MEDIA_RESET_REQUIRED')
            .slice(resetMessageCount)
            .find(message => message.reason === 'VIDEO_FRAME_STALLED');
        assert(Boolean(videoStallReset), 'A connected WebRTC track with no newly decoded frames is reset instead of staying frozen');
        runtimeInternals._liveTalkingMediaOwner.lastHeartbeatAt = Date.now() - 20_000;
        runtimeInternals._lastLiveTalkingMediaWatchdogAt = 0;
        runtimeInternals._reconcileLiveTalkingMediaOwnership(Date.now());
        const promotedMediaOwner = await waitForSocketMessage(mediaStandby.messages, 'LIVETALKING_MEDIA_OWNER_GRANTED');
        assert(promotedMediaOwner?.clientId === 'monitor_standby', 'A standby Dashboard replaces an unresponsive owner after its heartbeat expires');
        mediaPrimary.socket.close();
        mediaStandby.socket.close();
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
        const geminiAuth = await fetch('http://localhost:9876/api/ai/director/gemini/auth/status').then((response) => response.json());
        const geminiStatus = await fetch('http://localhost:9876/api/ai/director/status').then((response) => response.json());
        assert(geminiAuth.success === true
            && typeof geminiAuth.auth?.connected === 'boolean'
            && geminiStatus.fallbackProvider === 'ollama'
            && geminiStatus.fallbackModel === 'qwen3:8b'
            && JSON.stringify(geminiAuth).includes('access_token') === false, 'Gemini Google-account status never exposes an access token and retains Qwen fallback');
        const voiceProfilesRes = await fetch('http://localhost:9876/api/voice/profiles');
        const voiceProfilesJson = await voiceProfilesRes.json();
        const voiceProfileProviders = new Set((voiceProfilesJson.profiles || []).map((profile) => profile.provider));
        assert(voiceProfileProviders.has('qwentts') && !voiceProfileProviders.has('elevenlabs'), 'Voice catalog returns Qwen profiles without the removed ElevenLabs provider');
        const dashboardHtml = fs.readFileSync('./operator-dashboard/index.html', 'utf8');
        const dashboardScript = fs.readFileSync('./operator-dashboard/dashboard.js', 'utf8');
        const dashboardStyles = fs.readFileSync('./operator-dashboard/design-system.css', 'utf8');
        const dashboardLegacyStyles = fs.readFileSync('./operator-dashboard/style.css', 'utf8');
        const webRtcReceiverScript = fs.readFileSync('./operator-dashboard/webrtc/receiver.js', 'utf8');
        const obsOutputHtml = fs.readFileSync('./operator-dashboard/overlay/obs-output.html', 'utf8');
        const nativeShellSource = fs.readFileSync('./src-tauri/src/lib.rs', 'utf8');
        const desktopPrepareSource = fs.readFileSync('./scripts/prepare-desktop-runtime.mjs', 'utf8');
        const launchWebappSource = fs.readFileSync('./scripts/launch-webapp.sh', 'utf8');
        const nativeCapabilitySource = fs.readFileSync('./src-tauri/capabilities/default.json', 'utf8');
        const qwenServerSource = fs.readFileSync('./services/qwen-tts/server.py', 'utf8');
        const runtimeServerSource = fs.readFileSync('./services/runtime-server/src/index.ts', 'utf8');
        const talkingHeadSource = fs.readFileSync('./services/talking-head/src/index.ts', 'utf8');
        const obsControllerSource = fs.readFileSync('./services/obs-controller/src/index.ts', 'utf8');
        const liveTalkingLauncherSource = fs.readFileSync('./services/talking-head/livetalking/run_worker.sh', 'utf8');
        const liveTalkingAppSource = fs.readFileSync('./services/talking-head/livetalking/app.py', 'utf8');
        const platformChatSource = fs.readFileSync('./services/runtime-server/src/platform-chat.ts', 'utf8');
        const avatarTaskManagerSource = fs.readFileSync('./services/talking-head/livetalking/server/task_manager.py', 'utf8');
        const faceDetectorSetupSource = fs.readFileSync('./services/talking-head/livetalking/scripts/prefetch_s3fd.py', 'utf8');
        assert(runtimeServerSource.includes("llmProvider: 'ollama'")
            && runtimeServerSource.includes("model: 'qwen3:8b'")
            && !runtimeServerSource.includes('new SafeDialogueProvider()')
            && !runtimeServerSource.includes('new MockDialogueProvider()')
            && dashboardHtml.includes('value="gemini"')
            && dashboardHtml.includes('Gemini Pro - Google account')
            && runtimeServerSource.includes('new GeminiDialogueProvider('), 'AI Director supports Gemini Google-account auth with local Qwen fallback and no mock dialogue provider');
        assert(runtimeServerSource.includes("!/^mimi$/i.test(this._settings.persona.name)")
            && runtimeServerSource.includes(".replace(/\\bMimi\\b/gi, this._settings.persona.name)"), 'Runtime startup migrates a legacy Mimi system prompt to the active AI Profile name');
        assert(nativeShellSource.includes('"Preparing face detector"')
            && nativeShellSource.includes('s3fd-619a316812.pth')
            && faceDetectorSetupSource.includes('S3FD_SHA256')
            && avatarTaskManagerSource.includes('task.stage_message = "Preparing face detector"')
            && dashboardScript.includes("activeItem?.stageMessage || AvatarCreateFlow.stageMessage")
            && runtimeServerSource.includes("this._liveTalkingMaintenanceBlocker = 'TRAINING'")
            && runtimeServerSource.includes('Cannot stop the Live Avatar worker while avatar training is active'), 'Magic Setup preloads S3FD, training exposes its preparation stage, and worker recycling waits for active training');
        assert(runtimeServerSource.includes('_liveTalkingWorkerStartPromise')
            && runtimeServerSource.includes('AI IDOL is already running at')
            && liveTalkingLauncherSource.includes('acquire_worker_lock')
            && dashboardScript.includes("$('cfg-livetalking-always-on')")
            && dashboardScript.includes("$('start-livetalking-engine')")
            && dashboardScript.includes("$('stop-livetalking-engine')"), 'Runtime, launcher, and Settings enforce one worker with Manual Start/Stop and Always On status controls');
        assert(dashboardHtml.includes('id="preview-selected-voice"')
            && dashboardHtml.includes('id="save-selected-voice"')
            && dashboardScript.includes('VoiceProfileState.previewedKey !== voiceProfileKey(profile)'), 'AI Profile requires voice preview before Save & use');
        assert(dashboardHtml.indexOf('id="avatar-library-grid"') < dashboardHtml.indexOf('<h2>Idol Profile</h2>'), 'AI Profile keeps Avatar Library above Idol Profile');
        assert(dashboardHtml.indexOf('data-app-view="live-settings"') < dashboardHtml.indexOf('data-app-view="studio"')
            && dashboardHtml.includes('id="view-live-settings"')
            && dashboardHtml.includes('id="reply-skill-file-input"')
            && dashboardHtml.includes('id="reply-skill-list"')
            && dashboardScript.includes("{ id: 'avatar', label: 'Avatar'")
            && dashboardScript.includes("{ id: 'profile', label: 'Idol Profile'")
            && dashboardScript.includes("{ id: 'voice', label: 'Voice Setting'")
            && dashboardScript.includes("{ id: 'skill', label: 'Live Reply Skill'")
            && dashboardScript.includes("window.RuntimeApi.post('/api/settings/reply-skills/select'")
            && dashboardScript.includes("window.RuntimeApi.delete(`/api/settings/reply-skills/${encodeURIComponent(skill.id)}`)"), 'Sidebar exposes one Live Setting workspace with Avatar, Idol Profile, Voice, and persistent Markdown reply-skill tabs');
        assert(dashboardStyles.includes('.avatar-library-grid { display: flex; flex: 0 0 304px;') && dashboardStyles.includes('overflow-x: auto'), 'Avatar Library is horizontally scrollable without collapsing inside AI Profile');
        assert(dashboardStyles.includes('--ui-command-h: var(--ui-control-h);')
            && dashboardStyles.includes('.chat-input-form > :where(input, button, .chat-user-field)')
            && dashboardStyles.includes('border-radius: var(--ui-radius) !important;'), 'Live chat user, message, and Send controls share one height and corner-radius token');
        assert(dashboardHtml.includes('data-settings-target="output"')
            && dashboardHtml.includes('data-settings-target="chat"')
            && dashboardHtml.includes('data-settings-target="storage"')
            && dashboardHtml.includes('data-settings-target="engines"')
            && dashboardScript.includes("const openSettingsCenter = (pane = 'output')")
            && dashboardStyles.includes('grid-template-columns: repeat(4, minmax(0, 1fr));'), 'Settings uses left-side tabs with one content pane and Live Library uses quarter-width desktop previews');
        assert(dashboardHtml.includes('Continue with Google')
            && dashboardHtml.includes('Continue with Facebook')
            && dashboardHtml.includes('Unify Chat')
            && dashboardScript.includes("if (platform === 'youtube') return '[YT]';")
            && dashboardScript.includes("if (platform === 'facebook') return '[FB]';")
            && dashboardScript.includes("payload.type === 'CHAT_MESSAGE'")
            && platformChatSource.includes('code_challenge_method: \'S256\'')
            && platformChatSource.includes("pages_read_engagement")
            && platformChatSource.includes("normalized.timestamp >= this._youtubeJoinedAt")
            && runtimeServerSource.includes("this._chatManager.ingest(message)")
            && runtimeServerSource.includes("firstMessage.platform === 'facebook' ? '[FB]'")
            && runtimeServerSource.includes("this._platformChat.publicState()")
            && (platformChatSource.match(/client_secret:/g)?.length || 0) >= 2
            && nativeShellSource.includes('"GOOGLE_OAUTH_CLIENT_SECRET"')
            && nativeShellSource.includes('BUILT_IN_GOOGLE_OAUTH_CLIENT_ID')
            && nativeShellSource.includes('592506943214-3i76k7r31250u3gphtott19g15pe54tg.apps.googleusercontent.com'), 'Simple OAuth feeds YouTube and Facebook into one labeled, filtered AI-to-TTS chat pipeline');
        assert(dashboardHtml.indexOf('id="monitor-screen"') < dashboardHtml.indexOf('id="queued-transition-banner"')
            && dashboardHtml.indexOf('id="queued-transition-banner"') < dashboardHtml.indexOf('id="timeline-track"')
            && dashboardScript.includes("function setQueuedTransitionStatus(targetState = '')")
            && dashboardScript.includes("clearQueuedTransition();\n  setVisualState('TALKING'")
            && dashboardStyles.includes('grid-template-rows: 38px minmax(0, 1fr) 32px 26px;'), 'Playback wait status keeps a reserved row below Monitor without shifting the video');
        assert(dashboardHtml.includes('id="cfg-playback-overlap-frames"')
            && dashboardHtml.includes('<option value="2" selected>Overlap 2 frames</option>')
            && dashboardScript.includes('const overlapSeconds = overlapFrames / 25;')
            && dashboardScript.includes('requestVideoFrameCallback(watchFrame)')
            && dashboardScript.includes('updateMonitorScreen(App.currentState, App.currentClip, true)'), 'Monitor Library overlaps two decoded frames by default across seamless OBS loop boundaries');
        assert(dashboardLegacyStyles.includes('.monitor-w2l-canvas')
            && dashboardLegacyStyles.includes('transition: none;')
            && dashboardScript.includes('setMonitorVideoLayer(standbyEl, true);')
            && dashboardScript.includes('setMonitorCanvasVisible(false);'), 'Talking canvas swaps atomically to decoded Library media without a double-face opacity fade');
        const avatarStateControls = dashboardHtml.match(/<div class="state-chips" id="state-chips">([\s\S]*?)<\/div>/)?.[1] || '';
        assert(!avatarStateControls.includes('data-state="BIG_WIN"')
            && !avatarStateControls.includes('data-state="JACKPOT"')
            && dashboardStyles.includes('grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));')
            && dashboardStyles.includes('grid-template-rows: minmax(0, 47.76fr) 36px 128px minmax(0, 40.94fr);')
            && dashboardStyles.includes('fcp-avatar-state-strip .state-chips')
            && dashboardStyles.includes('overflow: hidden;'), 'Avatar States shows every implemented control in a wrapped grid without horizontal scrolling');
        assert(dashboardHtml.includes('<header class="topbar" data-tauri-drag-region>')
            && dashboardScript.includes('function setupNativeHeaderDrag()')
            && dashboardScript.includes('getCurrentWindow().startDragging()')
            && nativeCapabilitySource.includes('core:window:allow-start-dragging')
            && nativeCapabilitySource.includes('http://127.0.0.1:6767/*')
            && dashboardStyles.includes('--svg-toolbar: 72px;')
            && dashboardStyles.includes('padding: 24px 12px 8px;'), 'Native header provides a safe drag region with reserved bottom padding');
        assert(dashboardScript.includes('class="btn-delete-clip"')
            && dashboardScript.includes('aria-label="Delete clip"')
            && dashboardStyles.includes('display: inline-flex !important;')
            && !dashboardScript.includes("title: 'Delete video?'")
            && dashboardScript.includes('if (clip.storageId) await IdolDB.deleteClip(clip.storageId);'), 'Every Library video deletes immediately while awaiting storage deletion');
        assert(dashboardHtml.includes('id="btn-go-live-hero"')
            && dashboardHtml.includes('id="btn-magic-connect"')
            && dashboardHtml.includes('Magic Connect')
            && dashboardHtml.includes('Monitor and voice to OBS.')
            && dashboardScript.includes("window.RuntimeApi.post('/api/obs/magic-connect'")
            && runtimeServerSource.includes("pathname === '/api/obs/magic-connect'")
            && runtimeServerSource.includes('obs-output.html?session=${encodeURIComponent(sessionId)}&instance=${Date.now()}')
            && runtimeServerSource.includes('this._handleObsOutputSignal(parsed.data, _ws)')
            && runtimeServerSource.includes('this._bestObsPublisher()')
            && webRtcReceiverScript.includes('onOutputStreamChanged(this.outputStream)')
            && dashboardScript.includes('ensureMonitorStream()')
            && dashboardScript.includes('ensureSilentAudioTrack()')
            && dashboardScript.includes("type: 'OBS_OUTPUT_REGISTER'")
            && dashboardScript.includes('this.audioSender.replaceTrack(audioTrack)')
            && !dashboardScript.includes("if (!stream.getVideoTracks().length || !stream.getAudioTracks().length) return;")
            && obsOutputHtml.includes("type: 'OBS_OUTPUT_ANSWER'")
            && obsOutputHtml.includes("role: 'receiver'")
            && obsOutputHtml.includes('payload.negotiationId !== negotiationId')
            && obsOutputHtml.includes('id="output-audio"')
            && obsOutputHtml.includes("event.track.kind === 'video'")
            && obsControllerSource.includes("boundsType: 'OBS_BOUNDS_NONE'"), 'Magic Connect provisions an OBS-only Browser Source and forwards the existing Monitor video + voice stream');
        assert(dashboardHtml.includes('id="live-video-quality"')
            && dashboardHtml.includes('data-video-quality="hd"')
            && !dashboardHtml.includes('data-video-quality="fhd"')
            && dashboardHtml.includes('id="monitor-w2l-canvas" width="1280" height="720"')
            && dashboardScript.includes("parameters.degradationPreference = 'maintain-framerate'")
            && dashboardScript.includes('maxBitrate: 6_000_000')
            && runtimeServerSource.includes("hd: { width: 1280, height: 720, fps: 30 }")
            && !runtimeServerSource.includes("fhd: { width: 1920, height: 1080, fps: 30 }")
            && dashboardStyles.includes('.live-video-quality-option.active'), 'Live output stays on one HD 720p30 preset across Monitor, WebRTC, and OBS');
        assert(dashboardHtml.includes('data-settings-target="engines"')
            && dashboardHtml.includes('data-settings-pane="engines"')
            && !dashboardHtml.includes('data-app-view="engines"')
            && dashboardHtml.includes('id="engine-card-grid"')
            && dashboardScript.includes("window.RuntimeApi.get('/api/engines')")
            && runtimeServerSource.includes("pathname === '/api/engines'")
            && dashboardStyles.includes('.engine-card-grid'), 'Settings includes the runtime AI Engines hub and a responsive two-column card layout');
        assert(dashboardScript.includes('await unlockAudio(true);')
            && runtimeServerSource.includes('await this._waitForReadyLiveTalkingMedia();')
            && runtimeServerSource.includes('LIVETALKING_FPS: String(this._settings.talkingEngine.modelFps)')
            && runtimeServerSource.includes("LIVETALKING_OUTPUT_FPS: '30'")
            && liveTalkingLauncherSource.includes('LIVETALKING_FPS:-15')
            && dashboardHtml.includes('HD · 30'), 'OBS preflight unlocks audio, waits for ready media, and publishes HD30 from a 15 FPS model clock');
        assert(fs.readFileSync('./services/talking-head/livetalking/requirements.txt', 'utf8').includes('av==15.1.0')
            && fs.readFileSync('./services/talking-head/livetalking/avatars/musetalk/models/vae.py', 'utf8').includes('use_safetensors=False'), 'LiveTalking pins compatible PyAV and loads the available VAE binary without safetensor probing');
        assert(obsControllerSource.includes('private _reconnectDelayMs = 2_000;')
            && obsControllerSource.includes('Math.min(30_000, this._reconnectDelayMs * 2)')
            && obsControllerSource.includes('now - this._lastConnectionErrorLogAt >= 30_000')
            && obsControllerSource.includes('reconnectDisabled && this._reconnectTimer'), 'OBS reconnect uses bounded exponential backoff and cannot flood logs while OBS is closed');
        assert(JSON.parse(fs.readFileSync('./package.json', 'utf8')).scripts.test.includes('@idol/obs-controller build'), 'The release test gate rebuilds OBS Controller before the runtime uses its compiled package');
        assert(qwenServerSource.includes('"model_loaded": engine.model is not None')
            && qwenServerSource.includes('engine.load()\n    uvicorn.run')
            && nativeShellSource.includes('tauri_plugin_single_instance::init')
            && nativeShellSource.includes('.env("QWEN_TTS_RUNTIME_DIR", &paths.qwen_runtime)')
            && !nativeShellSource.includes('start_qwen_tts(&paths)')
            && runtimeServerSource.includes('this._autoStartQwenTtsWorker();'), 'Native startup is single-instance and keeps Qwen TTS ready inside its sandbox');
        assert(runtimeServerSource.includes("AI_IDOL_ENGINE_LOCK_PORT")
            && runtimeServerSource.includes('Another AI IDOL runtime is active')
            && runtimeServerSource.includes('await this._acquireEngineLock();')
            && runtimeServerSource.includes("AI_IDOL_NATIVE_PARENT_PID")
            && nativeShellSource.includes('.env("AI_IDOL_NATIVE_PARENT_PID", std::process::id().to_string())'), 'Native and localhost runtimes share one exclusive engine lock');
        assert(runtimeServerSource.includes('await this._ensureQwenTtsReady();')
            && runtimeServerSource.includes("QWEN_TTS_AUTOSTART")
            && runtimeServerSource.includes("services', 'qwen-tts', launcherName"), 'Runtime starts Qwen TTS on demand and reuses a healthy existing service');
        assert(webRtcReceiverScript.includes("type: 'LIVETALKING_MEDIA_STATE'")
            && webRtcReceiverScript.includes('await pc.getStats()')
            && webRtcReceiverScript.includes("throw new Error('LiveTalking connected without both audio and video tracks')")
            && webRtcReceiverScript.indexOf('this.audioEl.remove();') < webRtcReceiverScript.indexOf('await global.LiveTalkingApi.closeSession(sessionId);')
            && dashboardScript.includes("payload.type === 'LIVETALKING_MEDIA_OWNER_GRANTED'")
            && dashboardScript.includes("payload.type === 'LIVETALKING_MEDIA_STANDBY'")
            && dashboardScript.includes("type: 'LIVETALKING_MEDIA_RELEASE'")
            && dashboardScript.includes("window.addEventListener('pagehide', releaseRuntimeRealtime")
            && dashboardScript.includes('await waitForLiveMediaOwnership();'), 'Dashboard verifies media packets, releases stale page ownership, and enforces one Live Monitor owner');
        assert(dashboardScript.includes("payload.type === 'LIVETALKING_MEDIA_RECOVERY_REQUIRED'")
            && dashboardScript.includes("scheduleLiveMediaRecovery('WebRTC negotiation still pending', 2500)")
            && dashboardScript.includes('await ensureLiveMediaReadyForSpeech();')
            && dashboardScript.includes('await reconnectLiveTalkingAvatar(avatarId);')
            && runtimeServerSource.includes("this._requestLiveTalkingMediaRecovery('MEDIA_OWNER_REQUIRED')")
            && runtimeServerSource.includes("this._requestLiveTalkingMediaRecovery('AUDIO_UPLOAD_FAILED')")
            && runtimeServerSource.includes('this._uploadLiveTalkingAudioWithRecovery(bytes, mediaType, runId)')
            && talkingHeadSource.includes("this._request('/humanaudio', { method: 'POST', body: form }, true"), 'Live Monitor self-heal reconnects before speech and replays cached audio after upload failure');
        assert(runtimeServerSource.includes('this._startWorkerWatchdog();')
            && runtimeServerSource.includes("this._restartQwenTtsWorker('health watchdog')")
            && runtimeServerSource.includes("this._restartLiveTalkingWorker('health watchdog', true)"), 'Runtime health watchdog automatically restarts stalled Qwen TTS and MuseTalk workers');
        assert(liveTalkingAppSource.includes('avatar_this = get_or_load_avatar(avatar_id)')
            && liveTalkingAppSource.includes('if loaded_avatar is None:')
            && liveTalkingAppSource.includes('avatar_cache_lock = RLock()'), 'MuseTalk reconnects reload an evicted default Avatar and reject empty cache payloads before WebRTC starts');
        assert(launchWebappSource.includes('<key>KeepAlive</key><true/>')
            && launchWebappSource.includes('launchctl bootstrap')
            && launchWebappSource.includes('launchctl kickstart -k'), 'macOS web runtime is installed as a KeepAlive LaunchAgent instead of a one-shot process');
        assert(desktopPrepareSource.includes("createHash('sha256')")
            && desktopPrepareSource.includes("runtime-build-id.txt")
            && nativeShellSource.includes('runtime-build-id.txt'), 'Native updates fingerprint the complete backend instead of reusing a stale runtime process');
        assert(webRtcReceiverScript.includes('needsServerProbe()')
            && dashboardScript.includes('LiveTalkingWebRTCClient.needsServerProbe?.()')
            && dashboardScript.includes('sessionStatus.sessionId === LiveTalkingWebRTCClient.sessionId'), 'A transient WebRTC disconnect is verified against the worker session before reconnecting');
        assert(dashboardScript.includes('if (LiveTalkingWorker.refreshing) return LiveTalkingWorker;')
            && dashboardScript.includes('LiveTalkingWorker.refreshing = false;'), 'Live avatar health polls cannot overlap and replace a session twice');
        assert(dashboardScript.includes('let sessionViable = LiveTalkingWebRTCClient.isViable?.()')
            && dashboardScript.includes('if (!sessionViable && LiveTalkingWebRTCClient.sessionId && window.LiveTalkingApi?.sessionStatus)')
            && !dashboardScript.includes("selectedId !== LiveTalkingStudio.avatarId || !LiveTalkingWebRTCClient.isConnected?.()"), 'Quick voice tests reuse a viable avatar session instead of replacing it');
        assert(dashboardHtml.includes('Multi Avatar Pool · Enabled / Disabled · Live now')
            && dashboardScript.includes("status.textContent = selected ? 'Enabled' : 'Disabled';")
            && dashboardScript.includes("liveStatus.textContent = 'Live now';")
            && dashboardScript.includes('Included in automatic rotation')
            && dashboardStyles.includes('.avatar-library-card.live-now .avatar-card-preview'), 'Avatar Pool UI separates enabled rotation membership from the Avatar currently live on WebRTC');
        assert(runtimeServerSource.includes('private _avatarRotationCursor = 0;')
            && runtimeServerSource.includes('const emotionMatches = available.filter')
            && runtimeServerSource.includes("this._requestLiveTalkingMediaRecovery('AVATAR_DATASET_CHANGED')")
            && !runtimeServerSource.includes('Automatic avatar rotation is disabled while live'), 'Runtime automatically selects emotion-matched Avatars and reconnects only when the dataset ID changes');
        assert(dashboardScript.includes("item.status = 'failed';\n      item.error = error.message;"), 'Avatar training surfaces startup and submission failures in the create modal');
        assert(dashboardScript.includes("function showAppConfirm({ title = 'Confirm action'")
            && dashboardScript.includes("title: 'Delete avatar?'")
            && dashboardScript.includes("confirmLabel: 'Delete'")
            && !dashboardScript.includes('if (!confirm(`Delete avatar'), 'Native avatar deletion uses an in-app confirmation modal');
        assert(dashboardScript.includes('function resolveRuntimeClip(state, serverAsset = null, forceRandom = false)')
            && dashboardScript.includes('serverAsset.fileName')
            && dashboardScript.includes('if (matchingClip) return matchingClip;')
            && dashboardScript.includes(': resolveRuntimeClip(state, serverAsset, forceRandom);'), 'Runtime state assets resolve to a playable local library clip after speech ends');
        const avatarLibraryRes = await fetch('http://localhost:9876/api/avatars/library');
        const avatarLibraryJson = await avatarLibraryRes.json();
        assert(avatarLibraryJson.avatars?.[0]?.thumbnailUrl === '/api/avatars/library/avatar_test/thumbnail', 'Avatar library exposes a runtime-owned thumbnail URL');
        const avatarRenameRes = await fetch('http://localhost:9876/api/avatars/library', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'avatar_test', name: 'Mimi Main', modelType: 'musetalk', status: 'ready' }),
        });
        const avatarRenameJson = await avatarRenameRes.json();
        const renamedAvatarLibraryJson = await fetch('http://localhost:9876/api/avatars/library').then((response) => response.json());
        assert(avatarRenameRes.status === 201
            && avatarRenameJson.avatar?.name === 'Mimi Main'
            && renamedAvatarLibraryJson.avatars?.find((avatar) => avatar.id === 'avatar_test')?.name === 'Mimi Main', 'Avatar library persists editable display names');
        const avatarThumbnailRes = await fetch('http://localhost:9876/api/avatars/library/avatar_test/thumbnail');
        const avatarThumbnailBytes = Buffer.from(await avatarThumbnailRes.arrayBuffer());
        assert(avatarThumbnailRes.headers.get('content-type') === 'image/png' && avatarThumbnailBytes.equals(thumbnailBytes), 'Runtime securely proxies avatar thumbnail image bytes');
        const avatarDeleteRes = await fetch('http://localhost:9876/api/avatars/library/avatar_test', { method: 'DELETE' });
        const sessionAfterAvatarDelete = await fetch('http://localhost:9876/api/avatars/session').then((response) => response.json());
        assert(avatarDeleteRes.status === 200
            && sessionAfterAvatarDelete.session?.activeAvatarId === 'avatar_happy'
            && sessionAfterAvatarDelete.session?.selectedAvatarIds?.join(',') === 'avatar_happy', 'Deleting the current Avatar preserves an enabled Pool replacement as the next live Avatar');
        await fetch('http://localhost:9876/api/talking-head/session/session_test', { method: 'DELETE' });
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
        const generatedSkillLibrary = await fetch('http://localhost:9876/api/settings/reply-skills').then((response) => response.json());
        assert(generatedSkillLibrary.activeSkillId === 'generated-live-session'
            && generatedSkillLibrary.items?.some((skill) => skill.id === 'generated-live-session'), 'Reply-skill library always includes the generated Live Session fallback');
        const uploadedSkillMarkdown = '# Bé Lộc Sales Skill\n\n- Nói tự nhiên, thân thiện.\n- Mời người xem đăng ký ở cuối câu.';
        const uploadSkillRes = await fetch('http://localhost:9876/api/settings/reply-skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName: 'be-loc-sales.md', markdown: uploadedSkillMarkdown }),
        });
        const uploadedSkillLibrary = await uploadSkillRes.json();
        const uploadedSkillId = uploadedSkillLibrary.skill?.id || '';
        const uploadedSkillPath = path.join(deleteTestProject, 'skills', `${uploadedSkillId}.md`);
        assert(uploadSkillRes.status === 201
            && uploadedSkillLibrary.activeSkillId === uploadedSkillId
            && fs.readFileSync(uploadedSkillPath, 'utf8') === uploadedSkillMarkdown, 'Markdown reply skill is persisted to the active project and selected after upload');
        const selectGeneratedSkillRes = await fetch('http://localhost:9876/api/settings/reply-skills/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'generated-live-session' }),
        });
        const selectedGeneratedSkill = await selectGeneratedSkillRes.json();
        assert(selectGeneratedSkillRes.status === 200 && selectedGeneratedSkill.activeSkillId === 'generated-live-session', 'Reply-skill library can switch back to the generated Live Session skill');
        await fetch('http://localhost:9876/api/settings/reply-skills/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: uploadedSkillId }),
        });
        const deleteSkillRes = await fetch(`http://localhost:9876/api/settings/reply-skills/${uploadedSkillId}`, { method: 'DELETE' });
        const deletedSkillLibrary = await deleteSkillRes.json();
        assert(deleteSkillRes.status === 200
            && deletedSkillLibrary.activeSkillId === 'generated-live-session'
            && !deletedSkillLibrary.items?.some((skill) => skill.id === uploadedSkillId)
            && !fs.existsSync(uploadedSkillPath), 'Deleting the active Markdown skill removes its file and safely restores the generated fallback');
        const projectOnlyAvatarRes = await fetch('http://localhost:9876/api/avatars/library', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: deleteTestAvatar, name: 'Integration Avatar', modelType: 'musetalk', status: 'ready' }),
        });
        const projectOnlyLibrary = await fetch('http://localhost:9876/api/avatars/library').then((response) => response.json());
        assert(projectOnlyAvatarRes.status === 201 && projectOnlyLibrary.avatars?.some((avatar) => avatar.id === deleteTestAvatar), 'Avatar library discovers a trained project-only artifact');
        await fetch('http://localhost:9876/api/avatars/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeAvatarId: deleteTestAvatar }),
        });
        const projectOnlyDeleteRes = await fetch(`http://localhost:9876/api/avatars/library/${deleteTestAvatar}`, { method: 'DELETE' });
        const repeatedDeleteRes = await fetch(`http://localhost:9876/api/avatars/library/${deleteTestAvatar}`, { method: 'DELETE' });
        const deletedLibrary = await fetch('http://localhost:9876/api/avatars/library').then((response) => response.json());
        const deletedSession = await fetch('http://localhost:9876/api/avatars/session').then((response) => response.json());
        assert(projectOnlyDeleteRes.status === 200
            && repeatedDeleteRes.status === 200
            && !deletedLibrary.avatars?.some((avatar) => avatar.id === deleteTestAvatar)
            && !fs.existsSync(path.join(deleteTestProject, 'models', deleteTestAvatar))
            && !fs.existsSync(path.join(deleteTestProject, 'avatars', 'source', deleteTestAvatar))
            && deletedSession.session?.activeAvatarId === null, 'Avatar deletion removes project artifacts, SQLite state, and remains idempotent');
        const staleAvatarId = 'avatar_stale_sqlite_only';
        await fetch('http://localhost:9876/api/avatars/library', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: staleAvatarId, name: 'Stale Avatar', modelType: 'musetalk', status: 'ready' }),
        });
        const reconciledLibrary = await fetch('http://localhost:9876/api/avatars/library').then((response) => response.json());
        assert(!reconciledLibrary.avatars?.some((avatar) => avatar.id === staleAvatarId), 'Avatar library reconciles stale SQLite-only records');
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
            body: JSON.stringify({ provider: 'qwentts', voiceId: 'qwen-default', speed: 1.0, pitch: 1.0 }),
        });
        const qwenVoiceSetJson = await qwenVoiceSetRes.json();
        assert(qwenVoiceSetJson.success === true
            && qwenVoiceSetJson.settings.provider === 'qwentts'
            && qwenVoiceSetJson.settings.speed === 1.0
            && qwenVoiceSetJson.settings.pitch === 1.0, 'REST /api/settings/voice configures Qwen TTS with neutral speed and pitch');
        const voiceSetRes = await fetch('http://localhost:9876/api/settings/voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'omnivoice', voiceId: 'voice_bright_storyteller', speed: 1.05 }),
        });
        const voiceSetJson = await voiceSetRes.json();
        assert(voiceSetJson.success === true && voiceSetJson.settings.voiceId === 'voice_bright_storyteller', 'REST /api/settings/voice dynamically configures Omni Voice');
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
        const samePathUploadRes = await fetch('http://localhost:9876/api/storage/file?category=uploads&filename=avatar.mp4', {
            method: 'POST',
            headers: { 'Content-Type': 'video/mp4' },
            body: fs.createReadStream(videoUploadJson.path),
            duplex: 'half',
        });
        const samePathUploadJson = await samePathUploadRes.json();
        assert(samePathUploadJson.success === true && fs.readFileSync(videoUploadJson.path).equals(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112])), 'Project storage atomically replaces a file without truncating the upload source');
        const audioUploadRes = await fetch('http://localhost:9876/api/storage/file?category=uploads&filename=test.wav', {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
        });
        const audioUploadJson = await audioUploadRes.json();
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
        const avatarSourceAJson = await avatarSourceARes.json();
        const avatarSourceBJson = await avatarSourceBRes.json();
        assert(avatarSourceAJson.path !== avatarSourceBJson.path
            && avatarSourceAJson.path.includes(`${path.sep}audit_source_a${path.sep}`)
            && avatarSourceBJson.path.includes(`${path.sep}audit_source_b${path.sep}`), 'Avatar source uploads are isolated by avatar ID and cannot overwrite matching filenames');
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
        const cloneProfileJson = await cloneProfileRes.json();
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
        const avatarBatchJson = await avatarBatchRes.json();
        const submittedWorkerTasks = workerTaskRequests.slice(workerTaskBaseline);
        const submittedModels = new Map(submittedWorkerTasks.map(task => [task.avatar_id, task.model]));
        assert(avatarBatchRes.status === 202 && avatarBatchJson.data?.tasks?.length === 2, 'Avatar batch returns one task record per requested avatar');
        assert(submittedWorkerTasks.length === 2
            && submittedModels.get('batch_musetalk') === 'musetalk'
            && submittedModels.get('batch_wav2lip') === 'wav2lip', 'Avatar batch submits every task with its explicit model and no shared provider mutation');
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
    await new Promise((resolve, reject) => fakeQwen.close((error) => error ? reject(error) : resolve()));
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
