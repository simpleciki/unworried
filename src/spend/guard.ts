// The single exit for model calls. Nothing else in this repository may construct NebiusProvider or
// read NEBIUS_API_KEY (test S8 greps for both).
//
// One call: kill switch → ledger readable → hourly breaker → provider + model known → price known →
// worst-case cost → budgets (action calls, action $, session $, day $, total $) → rate limits →
// RESERVE the worst case in the ledger → send → SETTLE on the usage the server reports. A response
// with no usage, and a failed attempt, are booked at the worst case, never at 0. Every refusal says
// which limit refused and happens before the network call.
import { randomUUID } from "node:crypto";
import type { ChatProvider, ChatRequest, ChatResult, ProviderStatus } from "../llm/provider.ts";
import { ProviderError } from "../llm/provider.ts";
import { NebiusProvider } from "../llm/nebius.ts";
import type { FetchLike } from "../llm/nebius.ts";
import { HourlyBreaker } from "./breaker.ts";
import type { BreakerState } from "./breaker.ts";
import { killSwitch as readKillSwitch } from "./kill-switch.ts";
import type { SwitchState } from "./kill-switch.ts";
import { DEFAULT_LEDGER_PATH, LedgerUnreadable, SpendLedger, chicagoDay, chicagoIso } from "./ledger.ts";
import type { LedgerEntry, Totals, Usage } from "./ledger.ts";
import { SlidingWindowRateLimiter } from "./limiter.ts";
import type { RateLimiter } from "./limiter.ts";
import { DEFAULT_LIMITS, loadLimits, maxTokensFor } from "./limits.ts";
import type { Limits } from "./limits.ts";
import { actualUsd, loadPrices, priceFor, round8, worstCaseUsd } from "./prices.ts";
import type { PriceTable } from "./prices.ts";

export type GuardContext = { session_id: string; action_id: string; kind: string };
export type GuardCall = GuardContext & { system?: string; user: string; temperature?: number; model?: string };

export type RefusalLimit =
  | "kill_switch"
  | "ledger"
  | "breaker"
  | "config"
  | "credentials"
  | "model"
  | "price"
  | "action_calls"
  | "action_usd"
  | "session_usd"
  | "day_usd"
  | "total_usd"
  | "rate_global"
  | "rate_session"
  | "provider";

export type GuardRefusal = { ok: false; limit: RefusalLimit; reason: string };
export type GuardSuccess = {
  ok: true;
  call_id: string;
  text: string;
  model: string;
  latencyMs: number;
  usage?: Usage;
  attempts: number;
  cost: { reserved_usd: number; actual_usd: number; booked: "usage" | "worst_case" };
};
export type GuardResult = GuardSuccess | GuardRefusal;

export type GuardState = {
  enabled: boolean;
  reason?: string;
  limit?: RefusalLimit;
  model?: string;
  ledger: { path: string; readable: boolean; totals?: Totals; opened_at?: string };
  breaker: BreakerState;
  limits: Limits;
  now: string;
};

export type GuardStatus = {
  state: GuardState;
  session: { session_id: string; calls: number; committed_usd: number; reserved_worst_usd: number; limit_usd: number; refusals: number } | null;
  last: LedgerEntry[];
  day_usd: number;
};

// The budget decision, isolated so a test can break it on purpose (S3) and show the rate limiter
// still holds. Returns the first limit the worst case would exceed.
export type BudgetCheck = (args: { ledger: SpendLedger; limits: Limits; ctx: GuardContext; day: string; worstUsd: number }) => GuardRefusal | null;

export const defaultBudgetCheck: BudgetCheck = ({ ledger, limits, ctx, day, worstUsd }) => {
  const over = (limit: RefusalLimit, spent: number, cap: number, scope: string): GuardRefusal => ({
    ok: false,
    limit,
    reason: `${limit}: $${spent.toFixed(6)} already committed ${scope} + worst case $${worstUsd.toFixed(6)} would exceed $${cap.toFixed(2)}`,
  });
  const calls = ledger.callsInAction(ctx.action_id);
  if (calls + 1 > limits.actionCalls) return { ok: false, limit: "action_calls", reason: `action_calls: action ${ctx.action_id} already made ${calls} of ${limits.actionCalls} allowed calls` };
  const action = ledger.committed({ action_id: ctx.action_id });
  if (action + worstUsd > limits.actionUsd) return over("action_usd", action, limits.actionUsd, `for action ${ctx.action_id}`);
  const session = ledger.committed({ session_id: ctx.session_id });
  if (session + worstUsd > limits.sessionUsd) return over("session_usd", session, limits.sessionUsd, `for session ${ctx.session_id}`);
  const today = ledger.committed({ day });
  if (today + worstUsd > limits.dayUsd) return over("day_usd", today, limits.dayUsd, `on ${day} (America/Chicago)`);
  const all = ledger.committed();
  if (all + worstUsd > limits.totalUsd) return over("total_usd", all, limits.totalUsd, "in total");
  return null;
};

export const ALWAYS_ALLOW_BUDGET: BudgetCheck = () => null;

export type GuardOptions = {
  ledgerPath?: string;
  limits?: Limits;
  prices: PriceTable;
  model?: string; // NEBIUS_MODEL; absent → every call is refused with "NEBIUS_MODEL not set"
  killSwitch?: SwitchState;
  // Exactly one of: a provider (tests inject FakeProvider) or Token Factory credentials (production).
  provider?: ChatProvider;
  credentials?: { apiKey: string | undefined; baseUrl: string | undefined };
  fetchFn?: FetchLike;
  configError?: string; // a load-time error (prices, limits) keeps the guard disabled with this reason
  limiter?: RateLimiter;
  breaker?: HourlyBreaker;
  budgetCheck?: BudgetCheck;
  now?: () => number;
  log?: (line: string) => void;
  newId?: () => string;
};

export class SpendGuard {
  readonly limits: Limits;
  private readonly prices: PriceTable;
  private readonly model?: string;
  private readonly killSwitch: SwitchState;
  private readonly ledgerPath: string;
  private readonly ledger: SpendLedger | LedgerUnreadable;
  private readonly provider: ChatProvider | { unavailable: string };
  private readonly limiter: RateLimiter;
  private readonly breaker: HourlyBreaker;
  private readonly budgetCheck: BudgetCheck;
  private readonly configError?: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly newId: () => string;
  private breakerLogged = false;

  constructor(opts: GuardOptions) {
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.prices = opts.prices;
    this.model = opts.model;
    this.killSwitch = opts.killSwitch ?? { enabled: true };
    this.ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER_PATH;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    this.newId = opts.newId ?? (() => randomUUID());
    this.configError = opts.configError;
    this.limiter = opts.limiter ?? new SlidingWindowRateLimiter({ maxGlobal: this.limits.rateGlobal, maxSession: this.limits.rateSession, now: this.now });
    this.breaker = opts.breaker ?? new HourlyBreaker(this.limits.hourUsd);
    this.budgetCheck = opts.budgetCheck ?? defaultBudgetCheck;
    // The ledger is read once at startup; unreadable → disabled, never "zero".
    try {
      this.ledger = SpendLedger.open(this.ledgerPath, this.now);
    } catch (e) {
      this.ledger = e instanceof LedgerUnreadable ? e : new LedgerUnreadable(this.ledgerPath, (e as Error).message);
    }
    this.provider = SpendGuard.buildProvider(opts);
  }

  // The only place a NebiusProvider is constructed.
  private static buildProvider(opts: GuardOptions): ChatProvider | { unavailable: string } {
    if (opts.provider) return opts.provider;
    if (!opts.credentials) return { unavailable: "no model provider configured" };
    if (!opts.credentials.apiKey) return { unavailable: "NEBIUS_API_KEY not set" };
    try {
      return new NebiusProvider({ apiKey: opts.credentials.apiKey, baseUrl: opts.credentials.baseUrl ?? "", fetchFn: opts.fetchFn, now: opts.now });
    } catch (e) {
      return { unavailable: (e as Error).message };
    }
  }

  // Production entry point: everything from the environment. The only place NEBIUS_API_KEY is read.
  static fromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<GuardOptions> = {}): SpendGuard {
    let configError: string | undefined;
    let limits: Limits = DEFAULT_LIMITS;
    let prices: PriceTable = {};
    try {
      limits = loadLimits(env);
      prices = loadPrices(env);
    } catch (e) {
      configError = (e as Error).message;
    }
    return new SpendGuard({
      ledgerPath: env.SPEND_LEDGER_PATH || DEFAULT_LEDGER_PATH,
      limits,
      prices,
      model: env.NEBIUS_MODEL || undefined,
      killSwitch: readKillSwitch(env),
      credentials: { apiKey: env.NEBIUS_API_KEY, baseUrl: env.NEBIUS_BASE_URL },
      configError,
      ...overrides,
    });
  }

  // Reasons that disable every call, in the order they are checked. Also trips the breaker from the
  // ledger's trailing-hour spend, so a restart with hot spend is off at once.
  private gate(): GuardRefusal | null {
    if (!this.killSwitch.enabled) return { ok: false, limit: "kill_switch", reason: this.killSwitch.reason };
    if (this.configError) return { ok: false, limit: "config", reason: this.configError };
    if (this.ledger instanceof LedgerUnreadable) return { ok: false, limit: "ledger", reason: this.ledger.message };
    const nowMs = this.now();
    const spent = this.ledger.actualInWindow(nowMs - this.breaker.windowMs, nowMs);
    const b = this.breaker.check(spent, chicagoIso(nowMs));
    if (b.tripped) {
      if (!this.breakerLogged) {
        this.breakerLogged = true;
        this.ledger.breakerTripped(b.reason, b.spentUsd);
        this.log(`[spend] ${b.reason}`);
      }
      return { ok: false, limit: "breaker", reason: b.reason };
    }
    if ("unavailable" in this.provider) return { ok: false, limit: "credentials", reason: this.provider.unavailable };
    return null;
  }

  state(): GuardState {
    const nowMs = this.now();
    const gate = this.gate();
    const base = {
      model: this.model,
      ledger: this.ledger instanceof LedgerUnreadable ? { path: this.ledgerPath, readable: false } : { path: this.ledgerPath, readable: true, totals: this.ledger.totals(), opened_at: this.ledger.openedAt },
      breaker: this.breaker.current,
      limits: this.limits,
      now: chicagoIso(nowMs),
    };
    if (gate) return { enabled: false, reason: gate.reason, limit: gate.limit, ...base };
    if (!this.model) return { enabled: false, reason: "NEBIUS_MODEL not set", limit: "model", ...base };
    return { enabled: true, ...base };
  }

  // Read-only view for the spend panel (task 004): one session's lines and totals, straight from the
  // ledger file. Nothing here changes state.
  status(sessionId?: string, lastN = 10): GuardStatus {
    const s = this.state();
    if (this.ledger instanceof LedgerUnreadable) return { state: s, session: null, last: [], day_usd: 0 };
    const all = this.ledger.last(10_000);
    const mine = sessionId ? all.filter((e) => "session_id" in e && e.session_id === sessionId) : all;
    const reserves = mine.filter((e) => e.kind === "reserve");
    const session = sessionId
      ? {
          session_id: sessionId,
          calls: reserves.length,
          committed_usd: this.ledger.committed({ session_id: sessionId }),
          reserved_worst_usd: round8(reserves.reduce((n, e) => n + (e.kind === "reserve" ? e.usd : 0), 0)),
          limit_usd: this.limits.sessionUsd,
          refusals: mine.filter((e) => e.kind === "refuse").length,
        }
      : null;
    return { state: s, session, last: mine.slice(-lastN), day_usd: this.ledger.committed({ day: chicagoDay(this.now()) }) };
  }

  async call(req: GuardCall): Promise<GuardResult> {
    const gate = this.gate();
    if (gate) return gate;
    const ledger = this.ledger as SpendLedger;
    const provider = this.provider as ChatProvider;
    const ctx: GuardContext = { session_id: req.session_id, action_id: req.action_id, kind: req.kind };
    const model = req.model ?? this.model;
    const refuse = (limit: RefusalLimit, reason: string, worstUsd?: number): GuardRefusal => {
      ledger.refuse({ session_id: ctx.session_id, action_id: ctx.action_id, call_kind: ctx.kind, model: model ?? "", limit, reason, ...(worstUsd !== undefined ? { worst_usd: worstUsd } : {}) });
      return { ok: false, limit, reason };
    };
    if (!model) return refuse("model", "NEBIUS_MODEL not set");
    const price = priceFor(this.prices, model);
    if (!price) return refuse("price", `no price for model ${model}: add it to config/prices.json or NEBIUS_PRICES_JSON`);
    const maxTokens = maxTokensFor(this.limits, ctx.kind);
    const worst = worstCaseUsd(price, (req.system ?? "") + req.user, maxTokens);

    let lastError: ProviderError | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const budget = this.budgetCheck({ ledger, limits: this.limits, ctx, day: chicagoDay(this.now()), worstUsd: worst.usd });
      if (budget) return refuse(budget.limit, budget.reason, worst.usd);
      const rate = this.limiter.tryAcquire(ctx.session_id);
      if (!rate.ok) return refuse(rate.limit, rate.reason, worst.usd);

      const callId = this.newId();
      ledger.reserve({ call_id: callId, session_id: ctx.session_id, action_id: ctx.action_id, call_kind: ctx.kind, model, usd: worst.usd, input_tokens_bound: worst.inputTokensBound, max_tokens: maxTokens, attempt });
      let r: ChatResult;
      try {
        r = await provider.chat({ model, system: req.system, user: req.user, temperature: req.temperature ?? 0, maxTokens });
      } catch (e) {
        // Unknown whether the server billed a failed attempt: book the worst case, never 0.
        ledger.settle(callId, { actualUsd: worst.usd, booked: "worst_case", outcome: "error" });
        lastError = e instanceof ProviderError ? e : new ProviderError("http", (e as Error).message);
        const retryable = lastError.kind === "timeout" || (lastError.kind === "http" && (lastError.status ?? 0) >= 500);
        if (retryable && attempt === 1) continue; // the retry reserves budget again, above
        return refuse("provider", `${lastError.kind}: ${lastError.message}`, worst.usd);
      }
      const booked: "usage" | "worst_case" = r.usage ? "usage" : "worst_case";
      const actual = r.usage ? actualUsd(price, r.usage) : worst.usd;
      ledger.settle(callId, { actualUsd: actual, booked, outcome: "ok", usage: r.usage, modelAnswered: r.model, latencyMs: r.latencyMs });
      this.gate(); // trips the breaker now if this call pushed the trailing hour over the line
      return { ok: true, call_id: callId, text: r.text, model: r.model, latencyMs: r.latencyMs, usage: r.usage, attempts: attempt, cost: { reserved_usd: worst.usd, actual_usd: actual, booked } };
    }
    return refuse("provider", `${lastError?.kind}: ${lastError?.message}`, worst.usd);
  }

  // A ChatProvider view bound to one session/action/kind, so ModelClient (cache, JSON retries) can sit
  // on top of the wall. A refusal surfaces as ProviderError("refused", reason).
  asProvider(ctx: GuardContext): ChatProvider {
    const guard = this;
    return {
      id: "nebius-guarded",
      async status(): Promise<ProviderStatus> {
        const s = guard.state();
        if (!s.enabled) return s.limit === "credentials" ? "unauthorized" : "offline";
        return "unavailable" in guard.provider ? "offline" : guard.provider.status();
      },
      async listModels() {
        return guard.model ? [guard.model] : [];
      },
      async chat(req: ChatRequest): Promise<ChatResult> {
        const r = await guard.call({ ...ctx, system: req.system, user: req.user, temperature: req.temperature, model: req.model });
        if (!r.ok) throw new ProviderError("refused", `${r.limit}: ${r.reason}`);
        return { text: r.text, model: r.model, latencyMs: r.latencyMs, ...(r.usage ? { usage: r.usage } : {}) };
      },
    };
  }
}
