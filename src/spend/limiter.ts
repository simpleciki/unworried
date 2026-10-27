// Sliding-window rate limits, global and per session. Deliberately separate code from the budget
// (ledger.ts): if one has a bug, the other still bounds the loss per hour. This limiter never waits;
// over the limit it refuses, and the caller decides what to do.

export type RateDecision = { ok: true } | { ok: false; reason: string; limit: "rate_global" | "rate_session" };

export interface RateLimiter {
  tryAcquire(sessionId: string): RateDecision;
}

export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly global: number[] = [];
  private readonly perSession = new Map<string, number[]>();
  private readonly maxGlobal: number;
  private readonly maxSession: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { maxGlobal: number; maxSession: number; windowMs?: number; now?: () => number }) {
    this.maxGlobal = opts.maxGlobal;
    this.maxSession = opts.maxSession;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  tryAcquire(sessionId: string): RateDecision {
    const t = this.now();
    prune(this.global, t, this.windowMs);
    const mine = this.perSession.get(sessionId) ?? [];
    prune(mine, t, this.windowMs);
    if (this.global.length >= this.maxGlobal) {
      return { ok: false, limit: "rate_global", reason: `rate limit: ${this.maxGlobal} calls per ${this.windowMs / 1000}s across all sessions already used` };
    }
    if (mine.length >= this.maxSession) {
      return { ok: false, limit: "rate_session", reason: `rate limit: ${this.maxSession} calls per ${this.windowMs / 1000}s for session ${sessionId} already used` };
    }
    this.global.push(t);
    mine.push(t);
    this.perSession.set(sessionId, mine);
    return { ok: true };
  }
}

function prune(stamps: number[], now: number, windowMs: number) {
  while (stamps.length && now - stamps[0] >= windowMs) stamps.shift();
}

// For tests that deliberately break the limiter (S4): the budget must still hold on its own.
export const ALWAYS_ALLOW_LIMITER: RateLimiter = { tryAcquire: () => ({ ok: true }) };
