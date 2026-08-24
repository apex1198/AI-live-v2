/**
 * @idol/game-adapter
 *
 * Phase 4: Game Telemetry & Event Ingestion Adapter
 * Normalizes raw slot/game feeds into standard GameEvents and provides a full-featured Slot Machine Simulator.
 */

import {
  GameEvent,
  type GameEventType,
} from '@idol/event-schema';

export interface RawGamePayload {
  source?: string | undefined;
  action?: string | undefined;
  event_name?: string | undefined;
  bet?: number | undefined;
  payout?: number | undefined;
  multiplier?: number | undefined;
  currency?: string | undefined;
  game_id?: string | undefined;
  symbols?: string[][] | undefined;
  bonus_triggered?: boolean | undefined;
  free_spins_count?: number | undefined;
  near_miss?: boolean | undefined;
  is_jackpot?: boolean | undefined;
  extra?: Record<string, unknown> | undefined;
  timestamp?: number | undefined;
}

export class GameEventNormalizer {
  /**
   * Normalizes any vendor-specific raw payload into our strict GameEvent schema.
   */
  static normalize(raw: RawGamePayload): GameEvent {
    const bet = raw.bet ?? 1000;
    const payout = raw.payout ?? 0;
    const multiplier = raw.multiplier ?? (bet > 0 ? payout / bet : 0);
    const currency = raw.currency || 'GOLD';
    const gameId = raw.game_id || 'slot_sweet_bonanza';
    const timestamp = raw.timestamp || Date.now();

    let type: GameEventType = 'game.round.ended';

    if (raw.is_jackpot || (multiplier >= 100 && raw.action === 'jackpot')) {
      type = 'game.jackpot';
    } else if (raw.bonus_triggered || (raw.free_spins_count && raw.free_spins_count > 0)) {
      type = 'game.bonus_round';
    } else if (raw.near_miss) {
      type = 'game.near_miss';
    } else if (multiplier >= 50) {
      type = 'game.mega_win';
    } else if (multiplier >= 10) {
      type = 'game.reward.big';
    } else if (multiplier >= 2) {
      type = 'game.win';
    } else if (payout > 0) {
      type = 'game.reward.small';
    } else if (raw.action === 'spin' || raw.event_name === 'spin') {
      type = 'game.spin';
    } else {
      type = 'game.lose';
    }

    return {
      type,
      value: payout,
      multiplier,
      betAmount: bet,
      currency,
      gameId,
      metadata: raw.extra || {},
      timestamp,
    };
  }
}

export interface SlotSimConfig {
  gameName: string;
  defaultBet: number;
  currency: string;
  rtpPercent: number; // e.g. 96.5%
}

export class SlotSimulatorEngine {
  private readonly _config: SlotSimConfig;
  private _consecutiveLosses = 0;
  private _totalSpins = 0;
  private _totalBet = 0;
  private _totalWon = 0;

  constructor(config: Partial<SlotSimConfig> = {}) {
    this._config = {
      gameName: config.gameName || 'Fortune Dragon Slots',
      defaultBet: config.defaultBet || 10000,
      currency: config.currency || 'VND',
      rtpPercent: config.rtpPercent || 96.5,
    };
  }

  get stats() {
    return {
      totalSpins: this._totalSpins,
      totalBet: this._totalBet,
      totalWon: this._totalWon,
      consecutiveLosses: this._consecutiveLosses,
      currentRtp: this._totalBet > 0 ? (this._totalWon / this._totalBet) * 100 : 0,
    };
  }

  /**
   * Generates a single spin outcome based on realistic slot weightings.
   */
  spin(customBet?: number, forcedOutcome?: 'JACKPOT' | 'MEGA_WIN' | 'BIG_WIN' | 'NEAR_MISS' | 'BONUS' | 'LOSS'): GameEvent {
    const bet = customBet ?? this._config.defaultBet;
    this._totalSpins++;
    this._totalBet += bet;

    // Handle forced outcomes for testing
    if (forcedOutcome) {
      return this._generateForcedOutcome(forcedOutcome, bet);
    }

    const rand = Math.random() * 100;
    let type: GameEventType = 'game.lose';
    let multiplier = 0;
    let payout = 0;

    if (rand < 0.1) {
      // 0.1% chance: JACKPOT (200x - 1000x)
      multiplier = 200 + Math.floor(Math.random() * 800);
      type = 'game.jackpot';
      this._consecutiveLosses = 0;
    } else if (rand < 0.8) {
      // 0.7% chance: MEGA WIN (50x - 150x)
      multiplier = 50 + Math.floor(Math.random() * 100);
      type = 'game.mega_win';
      this._consecutiveLosses = 0;
    } else if (rand < 3.0) {
      // 2.2% chance: BONUS ROUND / FREE SPINS
      multiplier = 20 + Math.floor(Math.random() * 40);
      type = 'game.bonus_round';
      this._consecutiveLosses = 0;
    } else if (rand < 8.0) {
      // 5% chance: BIG WIN (10x - 30x)
      multiplier = 10 + Math.floor(Math.random() * 20);
      type = 'game.reward.big';
      this._consecutiveLosses = 0;
    } else if (rand < 15.0) {
      // 7% chance: NEAR MISS (Teaser: 2 scatters, missing 3rd scatter)
      type = 'game.near_miss';
      multiplier = 0;
      this._consecutiveLosses++;
    } else if (rand < 35.0) {
      // 20% chance: SMALL WIN (1.5x - 5x)
      multiplier = Number((1.5 + Math.random() * 3.5).toFixed(1));
      type = 'game.win';
      this._consecutiveLosses = 0;
    } else {
      // 65% chance: LOSS
      multiplier = 0;
      this._consecutiveLosses++;
      if (this._consecutiveLosses >= 5) {
        type = 'game.loss_streak';
      } else {
        type = 'game.lose';
      }
    }

    payout = Math.round(bet * multiplier);
    this._totalWon += payout;

    return {
      type,
      value: payout,
      multiplier,
      betAmount: bet,
      currency: this._config.currency,
      gameId: this._config.gameName,
      streakCount: this._consecutiveLosses,
      metadata: {
        spinIndex: this._totalSpins,
        consecutiveLosses: this._consecutiveLosses,
      },
      timestamp: Date.now(),
    };
  }

  private _generateForcedOutcome(outcome: string, bet: number): GameEvent {
    let type: GameEventType = 'game.lose';
    let multiplier = 0;

    switch (outcome) {
      case 'JACKPOT':
        type = 'game.jackpot';
        multiplier = 500;
        this._consecutiveLosses = 0;
        break;
      case 'MEGA_WIN':
        type = 'game.mega_win';
        multiplier = 80;
        this._consecutiveLosses = 0;
        break;
      case 'BIG_WIN':
        type = 'game.reward.big';
        multiplier = 25;
        this._consecutiveLosses = 0;
        break;
      case 'BONUS':
        type = 'game.bonus_round';
        multiplier = 35;
        this._consecutiveLosses = 0;
        break;
      case 'NEAR_MISS':
        type = 'game.near_miss';
        multiplier = 0;
        this._consecutiveLosses++;
        break;
      default:
        type = 'game.lose';
        multiplier = 0;
        this._consecutiveLosses++;
        break;
    }

    const payout = Math.round(bet * multiplier);
    this._totalWon += payout;

    return {
      type,
      value: payout,
      multiplier,
      betAmount: bet,
      currency: this._config.currency,
      gameId: this._config.gameName,
      streakCount: this._consecutiveLosses,
      metadata: { forced: true, outcome },
      timestamp: Date.now(),
    };
  }
}

export class GameAdapter {
  private readonly _simulator: SlotSimulatorEngine;
  private readonly _eventListeners: Array<(event: GameEvent) => void> = [];

  constructor(config: Partial<SlotSimConfig> = {}) {
    this._simulator = new SlotSimulatorEngine(config);
  }

  onEvent(listener: (event: GameEvent) => void): () => void {
    this._eventListeners.push(listener);
    return () => {
      const idx = this._eventListeners.indexOf(listener);
      if (idx >= 0) this._eventListeners.splice(idx, 1);
    };
  }

  /**
   * Ingests a raw external payload (e.g. from HTTP Webhook or WebSocket).
   */
  ingestRaw(payload: RawGamePayload): GameEvent {
    const normalized = GameEventNormalizer.normalize(payload);
    this._dispatch(normalized);
    return normalized;
  }

  /**
   * Spins the built-in simulator engine and emits the event.
   */
  spinSimulator(customBet?: number, forcedOutcome?: 'JACKPOT' | 'MEGA_WIN' | 'BIG_WIN' | 'NEAR_MISS' | 'BONUS' | 'LOSS'): GameEvent {
    const event = this._simulator.spin(customBet, forcedOutcome);
    this._dispatch(event);
    return event;
  }

  get stats() {
    return this._simulator.stats;
  }

  private _dispatch(event: GameEvent): void {
    for (const listener of this._eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[GameAdapter] Error in listener:', err);
      }
    }
  }
}
