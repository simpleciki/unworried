// Hourly circuit breaker: when actual spend in the trailing 60 minutes exceeds the threshold, model
// calls switch off for the rest of the process (same effect as the kill switch). It never resets by
// itself; a restart with a ledger that still shows the spend trips it again at once.

export type BreakerState = { tripped: false } | { tripped: true; at: string; reason: string; spentUsd: number };

export class HourlyBreaker {
  readonly limitUsd: number;
  readonly windowMs: number;
  private state: BreakerState = { tripped: false };

  constructor(limitUsd: number, windowMs = 60 * 60 * 1000) {
    this.limitUsd = limitUsd;
    this.windowMs = windowMs;
  }

  // spentUsd = actual spend (settled usage, or the worst case where no usage was reported) whose call
  // started in [nowMs − windowMs, nowMs]. atIso is the human-readable instant for the log.
  check(spentUsd: number, atIso: string): BreakerState {
    if (this.state.tripped) return this.state;
    if (spentUsd > this.limitUsd) {
      this.state = {
        tripped: true,
        at: atIso,
        spentUsd,
        reason: `hourly breaker: $${spentUsd.toFixed(4)} spent in the trailing ${this.windowMs / 60_000} minutes exceeds $${this.limitUsd.toFixed(2)}; model calls are off for this process`,
      };
    }
    return this.state;
  }

  get current(): BreakerState {
    return this.state;
  }
}
