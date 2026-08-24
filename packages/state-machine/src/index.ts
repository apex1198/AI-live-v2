/**
 * @idol/state-machine
 *
 * Deterministic visual state machine for the AI Idol stream.
 *
 * Rules (from PLAN.md):
 * - LLM never owns state transitions
 * - GAMEPLAY_IDLE is the universal safe fallback
 * - Every state must define a fallback
 * - Visual reactions begin immediately (do not wait for TTS)
 */

import type { VisualState, Priority } from '@idol/event-schema';

// ─────────────────────────────────────────────────────────
// State Configuration
// ─────────────────────────────────────────────────────────

export interface StateConfig {
  /** Default duration before auto-returning to fallback (ms). 0 = no auto-return */
  durationMs: number;
  /** State to transition to after duration expires */
  fallback: VisualState;
  /** Can this state be interrupted by a higher-priority event? */
  interruptible: boolean;
  /** Minimum priority level needed to interrupt this state */
  interruptMinPriority: Priority;
  /** Whether AI voice is allowed over this state's visual */
  voiceAllowed: boolean;
}

export const STATE_CONFIGS: Record<VisualState, StateConfig> = {
  BOOT: {
    durationMs: 0,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: false,
    interruptMinPriority: 0,
    voiceAllowed: false,
  },
  GAMEPLAY_IDLE: {
    durationMs: 0,        // loops forever
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 1,
    voiceAllowed: true,   // chat answers play over gameplay
  },
  GAMEPLAY_FOCUS: {
    durationMs: 0,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 1,
    voiceAllowed: true,
  },
  LISTENING: {
    durationMs: 8_000,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 1,
    voiceAllowed: false,
  },
  TALKING: {
    durationMs: 0,        // ends when TTS finishes
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 1,
    voiceAllowed: true,
  },
  HAPPY: {
    durationMs: 3_500,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 1,
    voiceAllowed: true,
  },
  BIG_WIN: {
    durationMs: 5_000,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: false,  // don't cut celebration short
    interruptMinPriority: 0,
    voiceAllowed: true,
  },
  JACKPOT: {
    durationMs: 6_000,
    fallback: 'BIG_WIN',   // flows into big_win
    interruptible: false,
    interruptMinPriority: 0,
    voiceAllowed: true,
  },
  LOSE: {
    durationMs: 4_000,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 2,
    voiceAllowed: true,
  },
  SURPRISED: {
    durationMs: 3_000,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 2,
    voiceAllowed: true,
  },
  LAUGH: {
    durationMs: 3_500,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 2,
    voiceAllowed: true,
  },
  INVITE_PLAY: {
    durationMs: 6_000,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 2,
    voiceAllowed: true,
  },
  CTA: {
    durationMs: 8_000,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 2,
    voiceAllowed: true,
  },
  THANK_DONATION: {
    durationMs: 5_000,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: false,
    interruptMinPriority: 0,
    voiceAllowed: true,
  },
  AFK: {
    durationMs: 0,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: true,
    interruptMinPriority: 3,
    voiceAllowed: false,
  },
  RECOVERY: {
    durationMs: 2_000,
    fallback: 'GAMEPLAY_IDLE',
    interruptible: false,
    interruptMinPriority: 0,
    voiceAllowed: false,
  },
};

// ─────────────────────────────────────────────────────────
// State Machine
// ─────────────────────────────────────────────────────────

export type StateChangeListener = (
  from: VisualState,
  to: VisualState,
  reason: string,
) => void;

export class VisualStateMachine {
  private _current: VisualState = 'BOOT';
  private _returnTimer: ReturnType<typeof setTimeout> | null = null;
  private _listeners: StateChangeListener[] = [];
  private _history: Array<{ state: VisualState; at: number; reason: string }> = [];

  get current(): VisualState {
    return this._current;
  }

  get config(): StateConfig {
    return STATE_CONFIGS[this._current]!;
  }

  get history() {
    return [...this._history];
  }

  // ── Event Listeners ──────────────────────────────────
  onStateChange(listener: StateChangeListener): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter(l => l !== listener);
    };
  }

  private _emit(from: VisualState, to: VisualState, reason: string) {
    this._history.push({ state: to, at: Date.now(), reason });
    if (this._history.length > 100) this._history.shift();
    this._listeners.forEach(l => l(from, to, reason));
  }

  // ── Transition ───────────────────────────────────────
  /**
   * Request a state transition.
   * Returns true if the transition was accepted, false if blocked.
   */
  transition(
    to: VisualState,
    reason: string = 'manual',
    incomingPriority: Priority = 5,
  ): boolean {
    const currentConfig = STATE_CONFIGS[this._current]!;

    // Check if current state allows interruption at this priority
    if (
      this._current !== 'BOOT' &&
      this._current !== to &&
      !currentConfig.interruptible &&
      incomingPriority > currentConfig.interruptMinPriority
    ) {
      return false; // blocked
    }

    const prev = this._current;
    this._current = to;

    // Clear existing auto-return timer
    if (this._returnTimer !== null) {
      clearTimeout(this._returnTimer);
      this._returnTimer = null;
    }

    this._emit(prev, to, reason);

    // Schedule auto-return if configured
    const newConfig = STATE_CONFIGS[to]!;
    if (newConfig.durationMs > 0) {
      this._returnTimer = setTimeout(() => {
        this.transition(newConfig.fallback, `auto-return from ${to}`, 4);
      }, newConfig.durationMs);
    }

    return true;
  }

  /** Force transition bypassing interruption rules (operator/kill switch) */
  forceTransition(to: VisualState, reason: string = 'operator-override'): void {
    const prev = this._current;
    this._current = to;
    if (this._returnTimer !== null) {
      clearTimeout(this._returnTimer);
      this._returnTimer = null;
    }
    this._emit(prev, to, reason);
    const newConfig = STATE_CONFIGS[to]!;
    if (newConfig.durationMs > 0) {
      this._returnTimer = setTimeout(() => {
        this.transition(newConfig.fallback, `auto-return from ${to}`, 4);
      }, newConfig.durationMs);
    }
  }

  /** Return to safe state immediately */
  recover(): void {
    this.forceTransition('GAMEPLAY_IDLE', 'recovery');
  }

  destroy(): void {
    if (this._returnTimer !== null) clearTimeout(this._returnTimer);
    this._listeners = [];
  }
}
