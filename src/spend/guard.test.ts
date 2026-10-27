// Spend wall acceptance S1–S6 (S7 is the author's own real call; S8–S10 live in their own files).
// No test here reaches the network: the provider is FakeProvider, or NebiusProvider over a fake fetch.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeProvider } from "../llm/fake.ts";
import { ProviderError } from "../llm/provider.ts";
import type { ChatProvider, ChatRequest, ChatResult } from "../llm/provider.ts";
import { MemoryCache } from "../llm/cache.ts";
import { CallBudget, ModelClient } from "../llm/client.ts";
import { obj, str } from "../llm/json.ts";
import { ALWAYS_ALLOW_BUDGET, SpendGuard } from "./guard.ts";
import type { GuardOptions } from "./guard.ts";
import { SpendLedger } from "./ledger.ts";
import { ALWAYS_ALLOW_LIMITER } from "./limiter.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import type { Limits } from "./limits.ts";

const MODEL = "fake/model";
// $1 per 1M tokens in and out: with max_tokens 1,000 and a 2-byte prompt the worst case of one call is
// exactly $0.001001 (1 input token bound + 1,000 output tokens).
const PRICES = { [MODEL]: { input_per_m: 1, output_per_m: 1 } };
const DEMO_CLOCK = Date.parse("2026-11-03T09:00:00-06:00");

// Wide limits so each test isolates the one limit it is about.
const WIDE: Limits = { ...DEFAULT_LIMITS, maxTokensByKind: { test: 1000 }, actionCalls: 100_000, actionUsd: 1e6, sessionUsd: 1e6, dayUsd: 1e6, totalUsd: 1e6, rateGlobal: 1e6, rateSession: 1e6, hourUsd: 1e6 };

let dir: string;
let ledgerPath: string;
let clock: number;
const now = () => clock;
const ctx = { session_id: "s1", action_id: "a1", kind: "test" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unworried-spend-"));
  ledgerPath = join(dir, "ledger.jsonl");
  clock = DEMO_CLOCK;
  SpendLedger.create(ledgerPath, now);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A provider that reports usage, like Token Factory does.
class UsageProvider implements ChatProvider {
  readonly id = "fake-usage";
  readonly calls: ChatRequest[] = [];
  constructor(private readonly outputTokens: number) {}
  async status() {
    return "online" as const;
  }
  async listModels() {
    return [MODEL];
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls.push(req);
    return { text: "ok", model: MODEL, latencyMs: 1, usage: { input_tokens: 1, output_tokens: this.outputTokens } };
  }
}

const guard = (over: Partial<GuardOptions>) => new SpendGuard({ ledgerPath, prices: PRICES, model: MODEL, limits: WIDE, now, log: () => {}, ...over });

// Fake transport for S1: a complete Token Factory reply with usage; never touches the network.
function fakeTransport(outputTokens: number) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const body = { model: "nvidia/fake-answered", choices: [{ message: { content: "reply" } }], usage: { prompt_tokens: 1, completion_tokens: outputTokens } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchFn };
}

describe("S1 — total budget $0.01 over a fake transport", () => {
  it("refuses the Nth call before the transport is invoked; transport count == calls allowed; ledger ≤ $0.01", async () => {
    const t = fakeTransport(500); // actual ≈ $0.000501 per call, worst case ≈ $0.001001
    const g = guard({ limits: { ...WIDE, totalUsd: 0.01 }, credentials: { apiKey: "test-only-not-a-real-key", baseUrl: "http://127.0.0.1:1/v1" }, fetchFn: t.fetchFn });
    expect(g.state().enabled).toBe(true);
    let allowed = 0;
    let refusal: { limit: string; reason: string } | undefined;
    for (let i = 0; i < 100 && !refusal; i++) {
      const r = await g.call({ ...ctx, user: "hi" });
      if (r.ok) allowed++;
      else refusal = r;
    }
    expect(refusal?.limit).toBe("total_usd");
    expect(refusal?.reason).toMatch(/would exceed \$0\.01/);
    expect(allowed).toBeGreaterThan(0);
    expect(t.seen).toHaveLength(allowed); // the refused call never reached the transport
    const total = SpendLedger.open(ledgerPath, now).totals().all;
    expect(total).toBeLessThanOrEqual(0.01);
    expect(total).toBeGreaterThan(0);
    // The transport saw the real request shape, with a token cap on every call.
    const body = JSON.parse(String(t.seen[0].init.body)) as { max_tokens: number; model: string; messages: unknown[] };
    expect(body.max_tokens).toBe(1000);
    expect(body.model).toBe(MODEL);
    expect(t.seen[0].url).toBe("http://127.0.0.1:1/v1/chat/completions");
    expect((t.seen[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-only-not-a-real-key");
  });
});

describe("S2 — a response without usage", () => {
  it("is booked at the worst case, not 0", async () => {
    const fake = new FakeProvider(() => "reply", [MODEL], MODEL); // FakeProvider reports no usage
    const g = guard({ provider: fake });
    const r = await g.call({ ...ctx, user: "hi" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cost.booked).toBe("worst_case");
    expect(r.cost.actual_usd).toBe(r.cost.reserved_usd);
    expect(r.cost.actual_usd).toBe(0.001001); // 1,000 output tokens + 1 input token at $1/M
    const ledger = SpendLedger.open(ledgerPath, now);
    expect(ledger.totals().all).toBe(r.cost.reserved_usd);
    const settle = ledger.last(1)[0];
    expect(settle.kind).toBe("settle");
    if (settle.kind === "settle") expect(settle.usd).toBe(0); // nothing refunded
  });
});

describe("S3 — budget broken (always allows), rate limiter intact", () => {
  it("allows at most the rate limit within one minute", async () => {
    const fake = new UsageProvider(10);
    const g = guard({ provider: fake, budgetCheck: ALWAYS_ALLOW_BUDGET, limits: { ...WIDE, totalUsd: 0, rateGlobal: 12, rateSession: 4 } });
    const refusals: string[] = [];
    for (const s of ["s1", "s2", "s3", "s4", "s5"]) {
      for (let i = 0; i < 10; i++) {
        const r = await g.call({ session_id: s, action_id: "a", kind: "test", user: "hi" });
        if (!r.ok) refusals.push(r.limit);
        clock += 100; // 10 calls per second, well inside one minute
      }
    }
    expect(fake.calls.length).toBeLessThanOrEqual(12);
    expect(fake.calls.length).toBe(12); // 4 per session × first 3 sessions reach the global 12
    expect(refusals).toContain("rate_session");
    expect(refusals).toContain("rate_global");
    // After the window passes, calls flow again.
    clock += 61_000;
    expect((await g.call({ ...ctx, user: "hi" })).ok).toBe(true);
  });
});

describe("S4 — rate limiter broken, budget intact", () => {
  it("still stops at the total budget", async () => {
    const fake = new FakeProvider(() => "reply", [MODEL], MODEL); // no usage → each call booked ≈ $0.001001
    const g = guard({ provider: fake, limiter: ALWAYS_ALLOW_LIMITER, limits: { ...WIDE, totalUsd: 0.01 } });
    const outcomes: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await g.call({ ...ctx, user: "hi" });
      outcomes.push(r.ok ? "ok" : r.limit);
    }
    expect(fake.calls).toHaveLength(9); // 9 × $0.001001 = $0.009009; the 10th would exceed $0.01
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(9);
    expect(new Set(outcomes.filter((o) => o !== "ok"))).toEqual(new Set(["total_usd"]));
    expect(SpendLedger.open(ledgerPath, now).totals().all).toBeLessThanOrEqual(0.01);
  });
});

describe("S5 — trailing-hour spend over the breaker threshold", () => {
  it("disables model calls and says why", async () => {
    // Simulate $0.60 of actual spend 30 minutes ago, straight into the ledger.
    const ledger = SpendLedger.open(ledgerPath, now);
    clock -= 30 * 60_000;
    for (let i = 0; i < 6; i++) {
      ledger.reserve({ call_id: `old-${i}`, session_id: "x", action_id: "y", call_kind: "test", model: MODEL, usd: 0.2, input_tokens_bound: 10, max_tokens: 1000, attempt: 1 });
      ledger.settle(`old-${i}`, { actualUsd: 0.1, booked: "usage", outcome: "ok" });
    }
    clock += 30 * 60_000;
    const fake = new UsageProvider(10);
    const logged: string[] = [];
    const g = guard({ provider: fake, limits: { ...WIDE, hourUsd: 0.5 }, log: (l) => logged.push(l) });
    const s = g.state();
    expect(s.enabled).toBe(false);
    expect(s.limit).toBe("breaker");
    expect(s.reason).toMatch(/hourly breaker: \$0\.6000 spent in the trailing 60 minutes exceeds \$0\.50/);
    const r = await g.call({ ...ctx, user: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.limit).toBe("breaker");
    expect(fake.calls).toHaveLength(0);
    expect(logged.some((l) => /hourly breaker/.test(l))).toBe(true);
    expect(SpendLedger.open(ledgerPath, now).last(1)[0].kind).toBe("breaker");
    // Stays off even after the hour passes: the breaker never resets by itself.
    clock += 2 * 60 * 60_000;
    expect(g.state().enabled).toBe(false);
  });

  it("trips at the moment a call pushes the trailing hour over the line", async () => {
    const fake = new FakeProvider(() => "reply", [MODEL], MODEL); // ≈ $0.001001 per call
    const g = guard({ provider: fake, limits: { ...WIDE, hourUsd: 0.0025 } });
    expect((await g.call({ ...ctx, user: "hi" })).ok).toBe(true);
    expect((await g.call({ ...ctx, user: "hi" })).ok).toBe(true);
    expect((await g.call({ ...ctx, user: "hi" })).ok).toBe(true); // third call: $0.003003 > $0.0025 → trips after settling
    const r = await g.call({ ...ctx, user: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.limit).toBe("breaker");
    expect(fake.calls).toHaveLength(3);
  });
});

describe("S6 — ledger file deleted, process restarted", () => {
  it("keeps model calls disabled instead of starting from zero", async () => {
    const fake = new UsageProvider(10);
    const a = guard({ provider: fake });
    expect((await a.call({ ...ctx, user: "hi" })).ok).toBe(true);
    expect((await a.call({ ...ctx, user: "hi" })).ok).toBe(true);
    rmSync(ledgerPath);
    const b = guard({ provider: fake }); // "restart": a new guard over the same path
    const s = b.state();
    expect(s.enabled).toBe(false);
    expect(s.limit).toBe("ledger");
    expect(s.reason).toMatch(/file is missing; model calls stay disabled/);
    expect(s.ledger.readable).toBe(false);
    expect(s.ledger.totals).toBeUndefined(); // no "total $0" that looks like a fresh start
    const r = await b.call({ ...ctx, user: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.limit).toBe("ledger");
    expect(fake.calls).toHaveLength(2);
  });

  it("a corrupt line disables calls too", async () => {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(ledgerPath, "this is not json\n");
    const g = guard({ provider: new UsageProvider(1) });
    const s = g.state();
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/line 2 is not JSON/);
  });
});

describe("other refusals happen before any network call", () => {
  it("unknown model id → refused with 'no price'", async () => {
    const fake = new UsageProvider(1);
    const g = guard({ provider: fake, model: "fake/unpriced" });
    const r = await g.call({ ...ctx, user: "hi" });
    expect(r).toMatchObject({ ok: false, limit: "price" });
    if (!r.ok) expect(r.reason).toMatch(/no price for model fake\/unpriced/);
    expect(fake.calls).toHaveLength(0);
    expect(SpendLedger.open(ledgerPath, now).last(1)[0].kind).toBe("refuse");
  });

  it("no model id → 'NEBIUS_MODEL not set'", async () => {
    const fake = new UsageProvider(1);
    const g = guard({ provider: fake, model: undefined });
    expect(g.state()).toMatchObject({ enabled: false, limit: "model", reason: "NEBIUS_MODEL not set" });
    expect(await g.call({ ...ctx, user: "hi" })).toMatchObject({ ok: false, limit: "model" });
    expect(fake.calls).toHaveLength(0);
  });

  it("kill switch off → enabled: false with the reason", async () => {
    const fake = new UsageProvider(1);
    const g = guard({ provider: fake, killSwitch: { enabled: false, reason: "LLM_ENABLED=false: model calls switched off by the kill switch" } });
    expect(g.state()).toMatchObject({ enabled: false, limit: "kill_switch" });
    expect(await g.call({ ...ctx, user: "hi" })).toMatchObject({ ok: false, limit: "kill_switch" });
    expect(fake.calls).toHaveLength(0);
  });

  it("fromEnv without credentials → refused, key named, nothing constructed", async () => {
    const g = SpendGuard.fromEnv({ SPEND_LEDGER_PATH: ledgerPath, NEBIUS_MODEL: MODEL, NEBIUS_PRICES_JSON: JSON.stringify(PRICES) }, { now, log: () => {} });
    const s = g.state();
    expect(s.enabled).toBe(false);
    expect(s.limit).toBe("credentials");
    expect(s.reason).toMatch(/API_KEY not set/);
  });

  it("fromEnv with a broken limits value → config refusal, not a silent default", () => {
    const g = SpendGuard.fromEnv({ SPEND_LEDGER_PATH: ledgerPath, SPEND_TOTAL_USD: "lots", NEBIUS_PRICES_JSON: JSON.stringify(PRICES) }, { now, log: () => {} });
    expect(g.state()).toMatchObject({ enabled: false, limit: "config" });
    expect(g.state().reason).toMatch(/SPEND_TOTAL_USD/);
  });

  it("action limits: calls per action and $ per action", async () => {
    const fake = new UsageProvider(1);
    const g = guard({ provider: fake, limits: { ...WIDE, actionCalls: 2 } });
    expect((await g.call({ ...ctx, user: "a" })).ok).toBe(true);
    expect((await g.call({ ...ctx, user: "b" })).ok).toBe(true);
    expect(await g.call({ ...ctx, user: "c" })).toMatchObject({ ok: false, limit: "action_calls" });
    expect((await g.call({ ...ctx, action_id: "a2", user: "c" })).ok).toBe(true); // another action is fine
    const g2 = guard({ provider: fake, limits: { ...WIDE, actionUsd: 0.0015 } });
    expect((await g2.call({ ...ctx, action_id: "a3", user: "a" })).ok).toBe(true); // ≈ $0.000002 actual
    expect(await g2.call({ ...ctx, action_id: "a3", user: "b" })).toMatchObject({ ok: true }); // committed tiny + worst 0.001 < 0.0015
  });
});

describe("retries", () => {
  const failing = (statuses: number[]) => {
    const calls: ChatRequest[] = [];
    let n = 0;
    const p: ChatProvider = {
      id: "flaky",
      status: async () => "online",
      listModels: async () => [MODEL],
      async chat(req) {
        calls.push(req);
        const s = statuses[n++];
        if (s === 0) return { text: "ok", model: MODEL, latencyMs: 1, usage: { input_tokens: 1, output_tokens: 1 } };
        if (s === -1) throw new ProviderError("timeout", "slow");
        throw new ProviderError("http", `HTTP ${s}`, s);
      },
    };
    return { p, calls };
  };

  it("a 5xx is retried once, and the retry reserves budget again", async () => {
    const f = failing([503, 0]);
    const g = guard({ provider: f.p });
    const r = await g.call({ ...ctx, user: "hi" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attempts).toBe(2);
    expect(f.calls).toHaveLength(2);
    const ledger = SpendLedger.open(ledgerPath, now);
    expect(ledger.totals().calls).toBe(2); // two reservations
    const entries = ledger.last(4);
    expect(entries.map((e) => e.kind)).toEqual(["reserve", "settle", "reserve", "settle"]);
    // The failed attempt stays booked at the worst case.
    const failed = entries[1];
    if (failed.kind === "settle") expect(failed).toMatchObject({ booked: "worst_case", outcome: "error", usd: 0 });
  });

  it("a timeout is retried once; two failures → refused with the provider error", async () => {
    const f = failing([-1, -1]);
    const g = guard({ provider: f.p });
    const r = await g.call({ ...ctx, user: "hi" });
    expect(r).toMatchObject({ ok: false, limit: "provider" });
    if (!r.ok) expect(r.reason).toMatch(/timeout: slow/);
    expect(f.calls).toHaveLength(2);
  });

  it("a 4xx is never retried", async () => {
    const f = failing([429]);
    const g = guard({ provider: f.p });
    const r = await g.call({ ...ctx, user: "hi" });
    expect(r).toMatchObject({ ok: false, limit: "provider" });
    expect(f.calls).toHaveLength(1);
  });

  it("the retry is refused when the second reservation would break the budget", async () => {
    const f = failing([503, 0]);
    const g = guard({ provider: f.p, limits: { ...WIDE, totalUsd: 0.0015 } }); // room for one worst case (≈ $0.001001), not two
    const r = await g.call({ ...ctx, user: "hi" });
    expect(r).toMatchObject({ ok: false, limit: "total_usd" });
    expect(f.calls).toHaveLength(1);
  });
});

describe("asProvider — ModelClient on top of the wall", () => {
  it("serves a JSON call through the guard and surfaces a refusal as ProviderError('refused')", async () => {
    const fake = new UsageProvider(5);
    const g = guard({ provider: fake, limits: { ...WIDE, actionCalls: 1 } });
    const client = new ModelClient(g.asProvider(ctx), new MemoryCache(), new CallBudget(5));
    fake.calls.length = 0;
    const spec = { stage: "t", agent: "A", model: MODEL, system: "sys", user: "say hi" };
    const r = await client.json({ ...spec }, (v) => str(obj(v, "reply").hi, "hi"), 0).catch((e) => e);
    // UsageProvider answers "ok", which is prose: the client reports the parse error, the call still went through the wall once.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].maxTokens).toBe(1000);
    expect(r).toMatchObject({ value: null });
    await expect(client.text({ ...spec, user: "another" })).rejects.toMatchObject({ name: "ProviderError", kind: "refused" });
    expect(fake.calls).toHaveLength(1);
  });
});
