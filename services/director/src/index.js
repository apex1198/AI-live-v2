/**
 * @idol/director
 *
 * Stream Director Agent Core.
 *
 * Rules (from PLAN.md):
 * - Director owns high-level decision making and state orchestration.
 * - LLM never controls event priority, raw filenames, or CTA frequency.
 * - Critical game events (P1) immediately interrupt lower-priority goals.
 * - Visual reaction clip begins immediately before waiting for TTS/LLM.
 * - Emits structured DirectorIntent for the Dialogue and Voice layers.
 */
import { gameEventPriority, gameEventToVisualState, } from '@idol/event-schema';
import { VisualStateMachine } from '@idol/state-machine';
import { PriorityQueue } from '@idol/priority-queue';
import { AssetRegistry, AssetRouter } from '@idol/asset-engine';
import { GoalEngine } from '@idol/goal-engine';
export class DirectorAgent {
    _stateMachine;
    _queue;
    _assetRouter;
    _goalEngine;
    _listeners;
    _state;
    _recentChatMessages = [];
    constructor(options = {}) {
        this._listeners = options.listeners ?? {};
        this._stateMachine = new VisualStateMachine();
        if (options.initialState) {
            this._stateMachine.forceTransition(options.initialState, 'initial');
        }
        else {
            this._stateMachine.forceTransition('GAMEPLAY_IDLE', 'initial');
        }
        this._queue = new PriorityQueue({ maxSize: 100, defaultTtlMs: 20_000 });
        const registry = options.assetRegistry ?? new AssetRegistry();
        this._assetRouter = new AssetRouter(registry);
        this._goalEngine = options.goalEngine ?? new GoalEngine();
        const initialClip = this._assetRouter.selectClip(this._stateMachine.current);
        this._state = {
            currentPhase: 'main_game',
            currentVisual: this._stateMachine.current,
            currentClip: initialClip,
            isSpeaking: false,
            isPaused: false,
            isMuted: false,
            lastCtaAt: 0,
            lastGoalAt: 0,
            lastChatReplyAt: 0,
            lastBigWinAt: 0,
            chatVelocity: 0,
            activeGoal: null,
            totalEventsProcessed: 0,
            streamStartedAt: Date.now(),
        };
        this._goalEngine.startStream(this._state.streamStartedAt);
        // Listen to state machine auto-return transitions
        this._stateMachine.onStateChange((from, to, reason) => {
            const clip = this._assetRouter.selectClip(to);
            this._state.currentVisual = to;
            this._state.currentClip = clip;
            const transition = {
                type: 'state.transition',
                fromState: from,
                toState: to,
                assetId: clip.id,
                reason,
                timestamp: Date.now(),
            };
            this._listeners.onStateTransition?.(transition, clip);
        });
    }
    get state() {
        return { ...this._state };
    }
    get stateMachine() {
        return this._stateMachine;
    }
    get assetRouter() {
        return this._assetRouter;
    }
    get goalEngine() {
        return this._goalEngine;
    }
    get queue() {
        return this._queue;
    }
    // ─────────────────────────────────────────────────────────
    // Event Ingestion
    // ─────────────────────────────────────────────────────────
    enqueueEvent(event) {
        if (this._state.isPaused && event.priority > 0) {
            this._log('debug', `Event ${event.id} dropped (AI Paused)`);
            return;
        }
        const queueItem = {
            id: event.id,
            priority: event.priority,
            payload: event,
        };
        if (event.expiresAt !== undefined) {
            queueItem.expiresAt = event.expiresAt;
        }
        this._queue.enqueue(queueItem);
        this._log('debug', `Enqueued event ${event.id} with priority P${event.priority} (${event.source})`);
    }
    injectGameEvent(event) {
        const priority = gameEventPriority(event.type);
        this.enqueueEvent({
            id: `game_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            priority,
            source: 'game',
            payload: event,
            enqueuedAt: Date.now(),
            expiresAt: Date.now() + 15_000,
        });
    }
    injectChatMessage(msg) {
        this._recentChatMessages.push(msg);
        if (this._recentChatMessages.length > 20)
            this._recentChatMessages.shift();
        const priority = msg.isSuperChat ? 2 : 3;
        this.enqueueEvent({
            id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            priority,
            source: 'chat',
            payload: msg,
            enqueuedAt: Date.now(),
            expiresAt: Date.now() + 25_000,
        });
    }
    injectDonation(event) {
        this.enqueueEvent({
            id: `donate_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            priority: 2, // P2 Donation
            source: 'donation',
            payload: event,
            enqueuedAt: Date.now(),
            expiresAt: Date.now() + 30_000,
        });
    }
    injectOperatorCommand(cmd) {
        this.handleOperatorCommand(cmd);
    }
    // ─────────────────────────────────────────────────────────
    // Operator Overrides (P0)
    // ─────────────────────────────────────────────────────────
    handleOperatorCommand(cmd) {
        this._log('info', `Operator command received: ${cmd.action}`, cmd);
        switch (cmd.action) {
            case 'PAUSE_AI':
                this._state.isPaused = true;
                this._queue.clear();
                break;
            case 'RESUME_AI':
                this._state.isPaused = false;
                break;
            case 'MUTE_AI':
                this._state.isMuted = true;
                break;
            case 'UNMUTE_AI':
                this._state.isMuted = false;
                break;
            case 'KILL_SWITCH':
                this._state.isPaused = true;
                this._state.isMuted = true;
                this._queue.clear();
                this.forceState('GAMEPLAY_IDLE', 'Operator kill switch');
                break;
            case 'FORCE_STATE':
                this.forceState(cmd.state, 'Operator forced state');
                break;
            case 'FORCE_CTA':
                this.triggerGoalAction('goal_conversion_cta');
                break;
            case 'SKIP_CLIP':
                this.forceState('GAMEPLAY_IDLE', 'Operator skipped clip');
                break;
            case 'CLEAR_QUEUE':
                this._queue.clear();
                break;
            case 'CHANGE_PHASE':
                this._state.currentPhase = cmd.phase;
                break;
        }
    }
    forceState(targetState, reason = 'Forced') {
        const prevState = this._stateMachine.current;
        this._stateMachine.forceTransition(targetState, reason);
        const clip = this._assetRouter.selectClip(targetState);
        this._state.currentVisual = targetState;
        this._state.currentClip = clip;
        const transition = {
            type: 'state.transition',
            fromState: prevState,
            toState: targetState,
            assetId: clip.id,
            reason,
            timestamp: Date.now(),
        };
        this._listeners.onStateTransition?.(transition, clip);
    }
    // ─────────────────────────────────────────────────────────
    // Main Director Evaluation Tick
    // ─────────────────────────────────────────────────────────
    tick(now = Date.now()) {
        // 1. Update stream phase
        const phase = this._goalEngine.getCurrentPhase(now);
        this._state.currentPhase = phase.name;
        if (this._state.isPaused)
            return null;
        // 2. Process Priority Queue
        const topItem = this._queue.dequeue();
        if (topItem) {
            this._state.totalEventsProcessed += 1;
            return this._processBusEvent(topItem.payload, now);
        }
        // 3. If Idle and no high-priority event, evaluate Goal Engine
        if (this._stateMachine.current === 'GAMEPLAY_IDLE' && !this._state.isSpeaking) {
            const streamCtx = {
                streamStartedAt: this._state.streamStartedAt,
                currentTime: now,
                currentVisualState: this._state.currentVisual,
                isSpeaking: this._state.isSpeaking,
                lastCtaAt: this._state.lastCtaAt,
                lastGoalAt: this._state.lastGoalAt,
                lastBigWinAt: this._state.lastBigWinAt,
                chatVelocity: this._state.chatVelocity,
            };
            if (this._state.activeGoal) {
                streamCtx.activeGoalId = this._state.activeGoal.id;
            }
            const dueGoal = this._goalEngine.evaluate(streamCtx);
            if (dueGoal) {
                return this._executeGoal(dueGoal, now);
            }
        }
        return null;
    }
    // ─────────────────────────────────────────────────────────
    // Process Single Event
    // ─────────────────────────────────────────────────────────
    _processBusEvent(event, now) {
        const payload = event.payload;
        // Handle Game Events
        if ('type' in payload && typeof payload.type === 'string' && payload.type.startsWith('game.')) {
            return this._handleGameEvent(payload, now);
        }
        // Handle Chat Messages
        if ('type' in payload && payload.type === 'chat.message') {
            return this._handleChatMessage(payload, now);
        }
        // Handle Donations
        if ('type' in payload && payload.type === 'donation.received') {
            return this._handleDonation(payload, now);
        }
        return null;
    }
    _handleGameEvent(gameEvent, now) {
        const targetState = gameEventToVisualState(gameEvent.type);
        const priority = gameEventPriority(gameEvent.type);
        this._log('info', `Handling Game Event: ${gameEvent.type} (P${priority}) -> ${targetState}`);
        // If Jackpot or Big Win (P1): Cancel any low-priority items in queue
        if (priority <= 1) {
            this._queue.cancelBelowPriority(1);
            this._state.lastBigWinAt = now;
        }
        // Trigger visual state transition immediately (DO NOT WAIT FOR TTS/LLM)
        const success = this._stateMachine.transition(targetState, `Game event ${gameEvent.type}`, priority);
        let clip = this._state.currentClip;
        if (success) {
            clip = this._assetRouter.selectClip(targetState, { currentTime: now });
            this._state.currentVisual = targetState;
            this._state.currentClip = clip;
            this._listeners.onStateTransition?.({
                type: 'state.transition',
                fromState: this._stateMachine.current,
                toState: targetState,
                assetId: clip.id,
                reason: `Game event ${gameEvent.type}`,
                timestamp: now,
            }, clip);
        }
        // Generate Intent for Dialogue Agent & Voice
        let emotion = 'excited';
        let intentDesc = 'celebrate_big_win';
        if (gameEvent.type === 'game.lose') {
            emotion = 'sad';
            intentDesc = 'react_loss';
        }
        else if (gameEvent.type === 'game.reward.small' || gameEvent.type === 'game.win') {
            emotion = 'happy';
            intentDesc = 'react_small_win';
        }
        const intent = {
            type: 'director.intent',
            action: 'REACT',
            intent: intentDesc,
            emotion,
            visualState: targetState,
            priority,
            timestamp: now,
            maxSpeechSeconds: Math.floor(clip.durationMs / 1000) || 5,
        };
        this._listeners.onIntent?.(intent);
        return intent;
    }
    _handleChatMessage(chatMsg, now) {
        this._log('debug', `Handling Chat from ${chatMsg.viewerName}: "${chatMsg.message}"`);
        // Only answer if idol is not currently speaking and current state allows voice
        if (this._state.isSpeaking || !this._stateMachine.config.voiceAllowed) {
            return null;
        }
        this._state.lastChatReplyAt = now;
        const intent = {
            type: 'director.intent',
            action: 'SPEAK',
            intent: 'reply_to_chat',
            emotion: chatMsg.isSuperChat ? 'excited' : 'playful',
            visualState: this._state.currentVisual, // Keeps playing gameplay visual
            speechText: `[Chat reply to ${chatMsg.viewerName}]: ${chatMsg.message}`,
            priority: chatMsg.isSuperChat ? 2 : 3,
            timestamp: now,
            maxSpeechSeconds: 6,
        };
        this._listeners.onIntent?.(intent);
        return intent;
    }
    _handleDonation(donation, now) {
        this._log('info', `Donation received from ${donation.viewerName}: $${donation.amount}`);
        const targetState = 'THANK_DONATION';
        const success = this._stateMachine.transition(targetState, `Donation from ${donation.viewerName}`, 2);
        let clip = this._state.currentClip;
        if (success) {
            clip = this._assetRouter.selectClip(targetState, { currentTime: now });
            this._state.currentVisual = targetState;
            this._state.currentClip = clip;
            this._listeners.onStateTransition?.({
                type: 'state.transition',
                fromState: this._stateMachine.current,
                toState: targetState,
                assetId: clip.id,
                reason: `Donation from ${donation.viewerName}`,
                timestamp: now,
            }, clip);
        }
        const intent = {
            type: 'director.intent',
            action: 'REACT',
            intent: 'thank_donation',
            emotion: 'grateful',
            visualState: targetState,
            speechText: `Cảm ơn ${donation.viewerName} đã ủng hộ ${donation.amount} đô nha!`,
            priority: 2,
            timestamp: now,
            maxSpeechSeconds: 5,
        };
        this._listeners.onIntent?.(intent);
        return intent;
    }
    _executeGoal(goal, now) {
        this._log('info', `Executing Stream Goal: [${goal.type}] - ${goal.objective}`);
        const visualState = goal.visualStates[0] ?? 'INVITE_PLAY';
        this._stateMachine.transition(visualState, `Goal ${goal.id}`, goal.priority);
        const clip = this._assetRouter.selectClip(visualState, { currentTime: now });
        this._state.currentVisual = visualState;
        this._state.currentClip = clip;
        this._state.lastGoalAt = now;
        if (goal.type === 'CTA' || goal.type === 'INVITE_PLAY') {
            this._state.lastCtaAt = now;
        }
        this._state.activeGoal = goal;
        this._goalEngine.recordExecution(goal.id, now);
        this._listeners.onStateTransition?.({
            type: 'state.transition',
            fromState: this._stateMachine.current,
            toState: visualState,
            assetId: clip.id,
            reason: `Goal ${goal.type}`,
            timestamp: now,
        }, clip);
        const intent = {
            type: 'director.intent',
            action: 'TRIGGER_GOAL',
            intent: `goal_${goal.type.toLowerCase()}`,
            emotion: goal.tone[0] ?? 'playful',
            visualState,
            goalId: goal.id,
            priority: goal.priority,
            timestamp: now,
            maxSpeechSeconds: Math.floor(clip.durationMs / 1000) || 6,
        };
        this._listeners.onIntent?.(intent);
        return intent;
    }
    triggerGoalAction(goalId) {
        const goalState = this._goalEngine.getGoal(goalId);
        if (goalState) {
            this._executeGoal(goalState.definition, Date.now());
        }
    }
    setSpeaking(speaking) {
        this._state.isSpeaking = speaking;
    }
    destroy() {
        this._stateMachine.destroy();
    }
    _log(level, message, data) {
        this._listeners.onLog?.(level, `[Director] ${message}`, data);
    }
}
//# sourceMappingURL=index.js.map
