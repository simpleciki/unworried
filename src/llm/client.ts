// Every model call goes through here: cache first, then the call budget, then the provider.
// JSON replies are validated; an invalid reply costs one retry with the error quoted back.
// Each call emits one event (stage, agent, prompt hash, cache hit/miss, retries, latency, the model
// that actually answered). Prompt text, headers and the token are never recorded.
import { createHash } from "node:crypto";
import type { ChatProvider } from "./provider.ts";
import { ProviderError } from "./provider.ts";
import type { ResponseCache } from "./cache.ts";
import { cacheKey } from "./cache.ts";
import { extractJson } from "./json.ts";
import { candidateModes } from "./modes.ts";
import type { DeadModes } from "./modes.ts";

// A run stops cleanly (keeping what it has) on either of these.
export class RunStopped extends Error {}

export class BudgetExhausted extends RunStopped {
  constructor(max: number) {
    super(`call budget of ${max} reached`);
    this.name = "BudgetExhausted";
  }
}

export type DeadRoute = { mode: string; model: string; reason: "dead" | "unavailable"; detail?: string };

export class AllRoutesDead extends RunStopped {
  constructor(readonly dead: DeadRoute[]) {
    super(`every routing mode is dead or unavailable: ${dead.map((d) => `${d.mode} -> ${d.model} (${d.reason}${d.detail ? `: ${d.detail.slice(0, 160)}` : ""})`).join("; ")}`);
    this.name = "AllRoutesDead";
  }
}

export { FALLBACK_MODES } from "./modes.ts";

export class CallBudget {
  used = 0;
  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 0) throw new Error("--max-calls must be a non-negative integer");
  }
  take() {
    if (this.used >= this.max) throw new BudgetExhausted(this.max);
    this.used++;
  }
  get remaining() {
    return this.max - this.used;
  }
}

export type CallEvent = {
  action?: "model_call" | "route_fallback";
  requested_mode?: string;
  dead_model?: string;
  mode_used?: string;
  stage: string;
  agent: string;
  prompt_hash: string;
  cache: "hit" | "miss";
  retry_count: number;
  latency_ms: number;
  model_answered: string;
  outcome: "ok" | "invalid" | "error";
  route?: string; // nightshift | nvidia-direct | cache (the reply came from the cache)
  requested?: string; // the routing mode or model id this attempt asked for
};

export type CallSpec = { stage: string; agent: string; model: string; system: string; user: string };
export type RawReply = { text: string; model: string; mode: string; fromCache: boolean };
export type JsonResult<T> = { value: T | null; model: string; error?: string; retries: number };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export type ClientOptions = {
  availableModels?: string[];
  modeOrder?: string[]; // METERLESS_MODE_ORDER, already validated
  deadModes?: DeadModes; // state/dead-modes.json in real runs
  warn?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>; // injectable for tests
  route?: string; // which provider route this run uses, recorded on every event
  cacheNamespace?: string; // e.g. "thinking-off": part of every cache key, so other settings' replies never hit
};

// Waits before re-asking a route that worked earlier in the run and then failed upstream.
export const TRANSIENT_RETRY_MS = [3_000, 10_000];
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ModelClient {
  readonly temperature = 0;
  // Per agent: the routing mode that last worked after a fallback; used for the rest of the run.
  readonly sticky = new Map<string, string>();
  // Routes that answered at least once in this run.
  readonly succeeded = new Set<string>();
  private warned = false;
  constructor(
    private provider: ChatProvider | null,
    private cache: ResponseCache,
    readonly budget: CallBudget,
    private onEvent: (e: CallEvent) => void = () => {},
    private opts: ClientOptions = {},
  ) {}

  // One raw call: cache hit, or budget + provider. No provider (sample mode) means a miss is fatal.
  // The cache key uses the mode the agent asked for, so replays find the reply whichever mode answered.
  keyOf(spec: CallSpec) {
    return cacheKey({ model: spec.model, system: spec.system, user: spec.user, temperature: this.temperature, namespace: this.opts.cacheNamespace });
  }

  // read: may the reply come from the cache; write: may this reply be cached as it is. JSON calls write
  // only after the reply passed parsing and the schema (see json()), never here.
  async raw(spec: CallSpec, retry = 0, cacheUse: { read: boolean; write: boolean } = { read: true, write: true }): Promise<RawReply> {
    const key = this.keyOf(spec);
    const prompt_hash = sha(`${spec.model}\n${spec.system}\n${spec.user}`);
    const base = { stage: spec.stage, agent: spec.agent, prompt_hash, retry_count: retry };
    const hit = cacheUse.read ? this.cache.get(key) : undefined;
    if (hit) {
      this.onEvent({ ...base, cache: "hit", latency_ms: 0, model_answered: hit.model, outcome: "ok", route: "cache", requested: spec.model });
      return { text: hit.text, model: hit.model, mode: hit.mode ?? spec.model, fromCache: true };
    }
    if (!this.provider) throw new ProviderError("unauthorized", "needs model credentials");
    // The human's pinned order wins; otherwise the agent's mode (or the one that stuck), then the
    // fallback order. Modes found dead in this or an earlier run are tried last.
    const stuck = this.sticky.get(spec.agent);
    const order = this.opts.modeOrder?.length ? [...(stuck ? [stuck] : []), ...this.opts.modeOrder] : undefined;
    const intended = order?.[0] ?? stuck ?? spec.model;
    const candidates = candidateModes(stuck ?? spec.model, { order, available: this.opts.availableModels, dead: this.opts.deadModes });
    const dead: DeadRoute[] = [];
    for (const mode of candidates) {
      for (let transient = 0; ; transient++) {
        this.budget.take(); // every attempt, retries and fallbacks included, counts against --max-calls
        try {
          const r = await this.provider.chat({ model: mode, system: spec.system, user: spec.user, temperature: this.temperature });
          if (cacheUse.write) this.cache.set(key, { text: r.text, model: r.model, mode });
          this.succeeded.add(mode);
          this.opts.deadModes?.markAlive(mode);
          if (mode !== intended) this.recordFallback(spec, base, intended, dead, mode, r.model);
          this.onEvent({ ...base, cache: "miss", latency_ms: r.latencyMs, model_answered: r.model, outcome: "ok", route: this.opts.route ?? this.provider.id, requested: mode });
          return { text: r.text, model: r.model, mode, fromCache: false };
        } catch (e) {
          this.onEvent({ ...base, cache: "miss", latency_ms: 0, model_answered: "", outcome: "error", route: this.opts.route ?? this.provider.id, requested: mode });
          if (!(e instanceof ProviderError) || (e.kind !== "route_dead" && e.kind !== "route_unavailable")) throw e;
          // A route that already answered in this run and now says "not found for account" is having a
          // transient upstream fault: same route again after 3 s, then 10 s, before moving on.
          const wasWorking = e.kind === "route_unavailable" && this.succeeded.has(mode);
          if (wasWorking && transient < TRANSIENT_RETRY_MS.length) {
            await (this.opts.sleep ?? defaultSleep)(TRANSIENT_RETRY_MS[transient]);
            continue;
          }
          // Otherwise switch route. Only a route that never worked is remembered as dead across runs.
          const reason = e.kind === "route_dead" ? "dead" : "unavailable";
          dead.push({ mode, model: e.deadModel ?? mode, reason, detail: e.message });
          if (!wasWorking) this.opts.deadModes?.markDead(mode, e.deadModel ?? mode, reason, e.message);
          break;
        }
      }
    }
    throw new AllRoutesDead(dead.length ? dead : [{ mode: "(none)", model: "no allowed routing mode is listed by the runtime", reason: "unavailable" }]);
  }

  // The mode that worked sticks for this agent. Dead models named: those hit now, plus the intended
  // mode's entry from the dead-mode memory when it was skipped without a call.
  private recordFallback(spec: CallSpec, base: Omit<CallEvent, "cache" | "latency_ms" | "model_answered" | "outcome">, intended: string, dead: DeadRoute[], mode: string, answered: string) {
    this.sticky.set(spec.agent, mode);
    const known = dead.some((d) => d.mode === intended) ? undefined : this.opts.deadModes?.isDead(intended);
    const deadModel = [...(known ? [`${known.dead_model} (known dead since ${known.first_seen})`] : []), ...dead.map((d) => `${d.model} (${d.reason})`)].join(", ") || intended;
    this.onEvent({ ...base, action: "route_fallback", requested_mode: intended, dead_model: deadModel, mode_used: mode, cache: "miss", latency_ms: 0, model_answered: answered, outcome: "ok" });
    if (!this.warned) {
      this.warned = true;
      (this.opts.warn ?? console.log)(`warning: ${intended} routes to a retired or unavailable model (${deadModel}); ${spec.agent} now uses ${mode} (answered by ${answered}) for the rest of this run.`);
    }
  }

  async text(spec: CallSpec) {
    return this.raw(spec);
  }

  // JSON call with schema check. retries = extra attempts after an invalid reply.
  // Only a reply that parses and passes the schema is cached, under the original prompt's key, so the
  // next run gets it in one hit. Retries never read the cache.
  async json<T>(spec: CallSpec, parse: (v: unknown) => T, retries: number): Promise<JsonResult<T>> {
    let user = spec.user;
    let lastError = "";
    let model = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await this.raw({ ...spec, user }, attempt, { read: attempt === 0, write: false });
      model = r.model;
      let value: T;
      try {
        value = parse(extractJson(r.text));
      } catch (e) {
        lastError = (e as Error).message;
        this.onEvent({ stage: spec.stage, agent: spec.agent, prompt_hash: sha(user), cache: r.fromCache ? "hit" : "miss", retry_count: attempt, latency_ms: 0, model_answered: model, outcome: "invalid", route: r.fromCache ? "cache" : (this.opts.route ?? this.provider?.id), requested: r.mode });
        user = `${spec.user}\n\nAttempt ${attempt + 2}. Your previous reply could not be used: ${lastError}. Reply with the JSON object only.`;
        continue;
      }
      if (!r.fromCache) this.cache.set(this.keyOf(spec), { text: r.text, model: r.model, mode: r.mode });
      return { value, model, retries: attempt };
    }
    return { value: null, model, error: lastError, retries };
  }
}
