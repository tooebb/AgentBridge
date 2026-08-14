import type { Context, EventType, RawEvent } from '../types.js';

/**
 * ContextEngine maintains a sliding window of recent raw events and provides
 * contextual hints to disambiguate event classification.
 */
export class ContextEngine {
  private window: RawEvent[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 5) {
    this.maxSize = maxSize;
  }

  /** Record a new raw event and advance the sliding window. */
  push(event: RawEvent): void {
    this.window.push(event);
    if (this.window.length > this.maxSize) {
      this.window.shift();
    }
  }

  /** Build a Context snapshot from the current window. */
  getContext(): Context {
    return {
      recentOutputs: this.window.map((e) => e.rawOutput.slice(0, 200)),
      recentEventTypes: this.window
        .map((e) => e.classifiedType)
        .filter((t): t is EventType => t !== undefined),
      timeSinceLastOutput:
        this.window.length > 0
          ? Date.now() - this.window[this.window.length - 1].timestamp
          : Infinity,
      consecutiveErrors: this.window.filter(
        (e) => e.classifiedType === 'task_failed'
      ).length,
      currentTaskPhase: this.inferPhase(),
    };
  }

  /** Heuristic phase inference based on recent events. */
  private inferPhase(): Context['currentTaskPhase'] {
    const types = this.window.map((e) => e.classifiedType);

    // Session just created, fewer than 3 events.
    if (this.window.length < 3) return 'init';

    // Recent approval was pending.
    if (types.includes('needs_approval')) return 'awaiting_approval';

    // Recent completion signals in the tail.
    const tailTypes = types.slice(-3);
    if (tailTypes.includes('task_completed')) return 'cleanup';

    // Default: agent is executing.
    return 'executing';
  }
}
