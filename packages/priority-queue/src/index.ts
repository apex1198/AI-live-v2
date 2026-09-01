/**
 * @idol/priority-queue
 *
 * Deterministic priority queue for the Event Bus.
 *
 * Rules:
 * - Lower priority number = processed first (P0 > P1 > P2 ...)
 * - Events with equal priority are FIFO
 * - Events can expire (expiresAt) and are dropped silently
 * - Max queue size enforced to prevent memory growth
 */

import type { Priority } from '@idol/event-schema';

export interface QueueItem<T> {
  id: string;
  priority: Priority;
  payload: T;
  enqueuedAt: number;
  expiresAt?: number;
}

export interface PriorityQueueOptions {
  /** Maximum items in the queue. Oldest low-priority items are dropped. Default: 50 */
  maxSize?: number;
  /** Default TTL in ms if expiresAt is not specified. Default: 30_000 (30s) */
  defaultTtlMs?: number;
}

export class PriorityQueue<T> {
  private _items: QueueItem<T>[] = [];
  private readonly _maxSize: number;
  private readonly _defaultTtlMs: number;
  private _droppedCount = 0;

  constructor(options: PriorityQueueOptions = {}) {
    this._maxSize = options.maxSize ?? 50;
    this._defaultTtlMs = options.defaultTtlMs ?? 30_000;
  }

  get size(): number {
    this._purgeExpired();
    return this._items.length;
  }

  get droppedCount(): number {
    return this._droppedCount;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  /** Add an item to the queue, maintaining sorted order */
  enqueue(item: Omit<QueueItem<T>, 'enqueuedAt'>): void {
    this._purgeExpired();

    const full: QueueItem<T> = {
      ...item,
      enqueuedAt: Date.now(),
      expiresAt: item.expiresAt ?? Date.now() + this._defaultTtlMs,
    };

    // Insert in sorted position (lower priority number = earlier)
    let insertIndex = this._items.length;
    for (let i = 0; i < this._items.length; i++) {
      const existing = this._items[i]!;
      if (full.priority < existing.priority) {
        insertIndex = i;
        break;
      }
    }
    this._items.splice(insertIndex, 0, full);

    // Enforce max size — drop lowest priority items from the tail
    while (this._items.length > this._maxSize) {
      this._items.pop();
      this._droppedCount++;
    }
  }

  /** Remove and return the highest-priority item */
  dequeue(): QueueItem<T> | undefined {
    this._purgeExpired();
    return this._items.shift();
  }

  /** Peek at the highest-priority item without removing it */
  peek(): QueueItem<T> | undefined {
    this._purgeExpired();
    return this._items[0];
  }

  /** Remove all items with priority LOWER than the given level */
  cancelBelowPriority(minPriority: Priority): number {
    const before = this._items.length;
    this._items = this._items.filter(item => item.priority <= minPriority);
    return before - this._items.length;
  }

  /** Remove a specific item by id */
  cancel(id: string): boolean {
    const before = this._items.length;
    this._items = this._items.filter(item => item.id !== id);
    return this._items.length < before;
  }

  /** Clear all items */
  clear(): void {
    const count = this._items.length;
    this._items = [];
    this._droppedCount += count;
  }

  /** Snapshot of current queue (read-only copy) */
  snapshot(): ReadonlyArray<QueueItem<T>> {
    this._purgeExpired();
    return [...this._items];
  }

  private _purgeExpired(): void {
    const now = Date.now();
    const before = this._items.length;
    this._items = this._items.filter(
      item => item.expiresAt === undefined || item.expiresAt > now,
    );
    this._droppedCount += before - this._items.length;
  }
}
