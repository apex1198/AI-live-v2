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
import { type VisualState, type DirectorIntent, type StateTransition, type BusEvent, type GameEvent, type ChatMessage, type DonationEvent, type OperatorCommand } from '@idol/event-schema';
import { VisualStateMachine } from '@idol/state-machine';
import { PriorityQueue } from '@idol/priority-queue';
import { AssetRegistry, AssetRouter, type AssetMetadata } from '@idol/asset-engine';
import { GoalEngine, type GoalDefinition } from '@idol/goal-engine';
export interface DirectorState {
    currentPhase: string;
    currentVisual: VisualState;
    currentClip: AssetMetadata;
    isSpeaking: boolean;
    isPaused: boolean;
    isMuted: boolean;
    lastCtaAt: number;
    lastGoalAt: number;
    lastChatReplyAt: number;
    lastBigWinAt: number;
    chatVelocity: number;
    activeGoal: GoalDefinition | null;
    totalEventsProcessed: number;
    streamStartedAt: number;
}
export interface DirectorListeners {
    onIntent?: (intent: DirectorIntent) => void;
    onStateTransition?: (transition: StateTransition, asset: AssetMetadata) => void;
    onLog?: (level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown) => void;
}
export declare class DirectorAgent {
    private readonly _stateMachine;
    private readonly _queue;
    private readonly _assetRouter;
    private readonly _goalEngine;
    private readonly _listeners;
    private _state;
    private _recentChatMessages;
    constructor(options?: {
        listeners?: DirectorListeners;
        assetRegistry?: AssetRegistry;
        goalEngine?: GoalEngine;
        initialState?: VisualState;
    });
    get state(): Readonly<DirectorState>;
    get stateMachine(): VisualStateMachine;
    get assetRouter(): AssetRouter;
    get goalEngine(): GoalEngine;
    get queue(): PriorityQueue<BusEvent>;
    enqueueEvent(event: BusEvent): void;
    injectGameEvent(event: GameEvent): void;
    injectChatMessage(msg: ChatMessage): void;
    injectDonation(event: DonationEvent): void;
    injectOperatorCommand(cmd: OperatorCommand): void;
    handleOperatorCommand(cmd: OperatorCommand): void;
    forceState(targetState: VisualState, reason?: string, clipOverride?: AssetMetadata): void;
    tick(now?: number): DirectorIntent | null;
    private _processBusEvent;
    private _handleGameEvent;
    private _handleChatMessage;
    private _handleDonation;
    private _executeGoal;
    private triggerGoalAction;
    setSpeaking(speaking: boolean): void;
    destroy(): void;
    private _log;
}
//# sourceMappingURL=index.d.ts.map
