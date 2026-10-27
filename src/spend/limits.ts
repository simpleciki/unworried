// The limits of the spending wall and their env overrides. Defaults were decided by the author on
// 2026-10-14 and may be changed only through the environment, never here.

export type Limits = {
  // Per call: max_tokens by call kind. Hard cap 1,024 — an override above it is refused at load time.
  maxTokensByKind: Record<string, number>;
  maxTokensDefault: number;
  actionCalls: number; // ≤ N calls per action id
  actionUsd: number; // ≤ $ worst case per action id
  sessionUsd: number; // per session id
  dayUsd: number; // per America/Chicago calendar day
  totalUsd: number; // whole hackathon: balance $50 − $3 margin
  rateGlobal: number; // calls per minute, all sessions
  rateSession: number; // calls per minute, one session
  hourUsd: number; // hourly circuit breaker: actual spend in the trailing 60 minutes
};

export const MAX_TOKENS_HARD_CAP = 1024;

export const DEFAULT_LIMITS: Limits = {
  maxTokensByKind: {},
  maxTokensDefault: 512,
  actionCalls: 8,
  actionUsd: 0.03,
  sessionUsd: 0.15,
  dayUsd: 3.0,
  totalUsd: 47.0,
  rateGlobal: 12,
  rateSession: 4,
  hourUsd: 0.5,
};

export class LimitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitsError";
  }
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, opts: { integer?: boolean } = {}): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new LimitsError(`${name}=${JSON.stringify(raw)} is not a non-negative number`);
  if (opts.integer && !Number.isInteger(n)) throw new LimitsError(`${name}=${JSON.stringify(raw)} must be an integer`);
  return n;
}

// SPEND_MAX_TOKENS_<KIND>: KIND is the call kind upper-cased with non-alphanumerics as "_".
export const maxTokensEnvName = (kind: string) => `SPEND_MAX_TOKENS_${kind.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

export function loadLimits(env: NodeJS.ProcessEnv = process.env): Limits {
  const byKind: Record<string, number> = {};
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith("SPEND_MAX_TOKENS_") || raw === undefined) continue;
    const kind = name.slice("SPEND_MAX_TOKENS_".length).toLowerCase();
    const n = num(env, name, DEFAULT_LIMITS.maxTokensDefault, { integer: true });
    if (n > MAX_TOKENS_HARD_CAP) throw new LimitsError(`${name}=${n} is above the hard cap of ${MAX_TOKENS_HARD_CAP} tokens per call`);
    byKind[kind] = n;
  }
  return {
    maxTokensByKind: byKind,
    maxTokensDefault: DEFAULT_LIMITS.maxTokensDefault,
    actionCalls: num(env, "SPEND_ACTION_CALLS", DEFAULT_LIMITS.actionCalls, { integer: true }),
    actionUsd: num(env, "SPEND_ACTION_USD", DEFAULT_LIMITS.actionUsd),
    sessionUsd: num(env, "SPEND_SESSION_USD", DEFAULT_LIMITS.sessionUsd),
    dayUsd: num(env, "SPEND_DAY_USD", DEFAULT_LIMITS.dayUsd),
    totalUsd: num(env, "SPEND_TOTAL_USD", DEFAULT_LIMITS.totalUsd),
    rateGlobal: num(env, "SPEND_RATE_GLOBAL", DEFAULT_LIMITS.rateGlobal, { integer: true }),
    rateSession: num(env, "SPEND_RATE_SESSION", DEFAULT_LIMITS.rateSession, { integer: true }),
    hourUsd: num(env, "SPEND_HOUR_USD", DEFAULT_LIMITS.hourUsd),
  };
}

// max_tokens for one call kind, never above the hard cap.
export function maxTokensFor(limits: Limits, kind: string): number {
  const n = limits.maxTokensByKind[kind.toLowerCase()] ?? limits.maxTokensDefault;
  return Math.min(n, MAX_TOKENS_HARD_CAP);
}
