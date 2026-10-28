// D1–D11 through route() (no socket, except D11 which binds port 0 on this machine and closes).
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "../action/fixtures.test-helpers.ts";
import { FakeProvider } from "../llm/fake.ts";
import type { ChatRequest } from "../llm/provider.ts";
import { SpendGuard } from "../spend/guard.ts";
import type { GuardOptions } from "../spend/guard.ts";
import { SpendLedger } from "../spend/ledger.ts";
import { DEFAULT_LIMITS } from "../spend/limits.ts";
import { Auth, parseAccounts } from "./auth.ts";
import { createRouter, startServer } from "./server.ts";
import type { Req, Res } from "./server.ts";
import { DEMO_CLOCK_ISO, SandboxManager } from "./sessions.ts";

const MODEL = "fake/model";
const CLOCK = Date.parse(DEMO_CLOCK_ISO);
const HTML = readFileSync(join(ROOT, "src", "ui", "index.html"), "utf8");

// Scripted replies by prompt kind (intake / relate / explain), recognised from the system prompt.
type Script = Partial<Record<"intake" | "relate" | "explain", (req: ChatRequest, n: number) => unknown>>;
const kindOf = (req: ChatRequest): "intake" | "relate" | "explain" => (/candidate decision cards/.test(req.system ?? "") ? "intake" : /how the new one relates/.test(req.system ?? "") ? "relate" : "explain");
const thursday = { cards: [{ quote: "Thursdays I pick up, backup Jordan", mode: "decides", topic: "pickup_backup", facet: "thursday", scope: "kids", decided_by: "me", effective: "2026-11-03", decided_at: null, value: "backup Jordan", unsure: [] }] };
const DEFAULT_SCRIPT: Script = {
  intake: () => thursday,
  relate: (req) => ({ relations: [...(req.user.match(/card_id (\S+):/g) ?? [])].map((m) => ({ card_id: m.slice(8, -1), relation: "REPLACES", because: "new Thursday arrangement" })) }),
  explain: () => ({ sentences: ["Jordan is the Thursday backup.", "Casey flies to Madison tomorrow."] }),
};

let root: string;
let logs: string[];
let bodies: string[];

beforeEach(() => {
  root = join(tmpdir(), `unworried-ui-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(root, { recursive: true });
  symlinkSync(join(ROOT, "data"), join(root, "data"), "dir");
  logs = [];
  bodies = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function guardWith(script: Script, over: Partial<GuardOptions> = {}) {
  const ledgerPath = join(root, "spend-ledger.jsonl");
  if (!existsSync(ledgerPath)) SpendLedger.create(ledgerPath, () => CLOCK);
  const fake = new FakeProvider((req, n) => JSON.stringify((script[kindOf(req)] ?? DEFAULT_SCRIPT[kindOf(req)])!(req, n)), [MODEL], MODEL);
  const guard = new SpendGuard({ ledgerPath, prices: { [MODEL]: { input_per_m: 1, output_per_m: 1 } }, model: MODEL, limits: { ...DEFAULT_LIMITS, actionCalls: 100, rateGlobal: 1e6, rateSession: 1e6 }, now: () => CLOCK, log: (l) => logs.push(l), provider: fake, ...over });
  return { guard, fake };
}

function app(opts: { guard: SpendGuard; accounts?: string; actionIds?: string[]; now?: () => number }) {
  const auth = new Auth({ accounts: parseAccounts(opts.accounts ?? "judge1:secret-one,judge2:secret-two"), file: join(root, "auth.json"), newId: (() => { let n = 0; return () => `sess-${++n}`; })() });
  const sandboxes = new SandboxManager({ root, guard: opts.guard, now: opts.now ?? (() => CLOCK) });
  const ids = opts.actionIds;
  const route = createRouter({ auth, sandboxes, html: HTML, log: (l) => logs.push(l), newActionId: ids ? () => ids.shift() ?? `act-${Math.random().toString(36).slice(2, 8)}` : undefined });
  return { auth, sandboxes, route };
}

// A browser-like client with a cookie jar.
function client(route: (r: Req) => Promise<Res>) {
  let cookie: string | undefined;
  return async (method: string, path: string, body?: unknown) => {
    const res = await route({ method, url: path, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    bodies.push(res.body);
    const set = res.headers["set-cookie"];
    if (set) cookie = set.split(";")[0];
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, json, body: res.body, headers: res.headers };
  };
}
type Client = ReturnType<typeof client>;
const login = async (c: Client, name = "judge1", secret = "secret-one") => expect((await c("POST", "/api/login", { name, secret })).status).toBe(200);

describe("D4 — no accounts", () => {
  it("every route but / and /login is 401 with a message; /login itself says there are no accounts", async () => {
    const { guard } = guardWith({});
    const { route } = app({ guard, accounts: "" });
    const c = client(route);
    expect((await c("GET", "/")).status).toBe(200);
    for (const [m, p] of [["GET", "/api/state"], ["GET", "/api/me"], ["POST", "/api/chat"], ["POST", "/api/reset"], ["GET", "/api/contrast"], ["GET", "/api/nothing"]] as const) {
      const r = await c(m, p, { text: "x" });
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(r.json).toMatchObject({ error: "no_accounts", reason: expect.stringMatching(/no judge accounts are configured/) });
    }
    expect((await c("POST", "/api/login", { name: "a", secret: "b" })).status).toBe(401);
  });

  it("with accounts: wrong secret 401, no cookie 401, bad JSON 400, unknown route 404", async () => {
    const { guard } = guardWith({});
    const { route } = app({ guard });
    const c = client(route);
    expect((await c("POST", "/api/login", { name: "judge1", secret: "nope" })).json).toMatchObject({ error: "bad_login" });
    expect((await c("GET", "/api/state")).json).toMatchObject({ error: "not_logged_in", reason: "log in first" });
    await login(c);
    expect((await route({ method: "POST", url: "/api/chat", headers: {}, body: "{not json" })).status).toBe(400);
    expect((await c("GET", "/api/nothing")).status).toBe(404);
    expect((await c("POST", "/api/chat", {})).json).toMatchObject({ error: "missing_field", reason: "text is required" });
  });
});

describe("D1 — a fresh client gets its own seeded sandbox; reset returns to the seed", async () => {
  it("state after login = the seeds; after changes, reset restores calendar, ledger, outbox and chat", async () => {
    const { guard } = guardWith({});
    const { route, sandboxes } = app({ guard });
    const c = client(route);
    await login(c);
    const s0 = (await c("GET", "/api/state")).json as { chat: unknown[]; seats: { state: string }[]; calendar: { events: unknown[] }; outbox: unknown[]; candidates: unknown[]; clock: string; judge: string };
    expect(s0.judge).toBe("judge1");
    expect(s0.clock).toBe("2026-11-03T09:00:00-06:00");
    expect(s0.chat).toHaveLength(49);
    expect(s0.seats).toHaveLength(18);
    expect(s0.seats.filter((r) => r.state === "PASS")).toHaveLength(13); // 18 rows: the Saturday seat is UNDATED, Mon/Wed/Fri/Sun pickups NOT_FOUND
    expect(s0.calendar.events).toHaveLength(45);
    expect(s0.outbox).toEqual([]);
    expect(existsSync(join(root, "state", "sessions", "sess-1", "ledger", "cards.jsonl"))).toBe(true);
    // Change things: a sentence, a confirmed card, a plan approved (drafts a handoff).
    const chat = (await c("POST", "/api/chat", { text: "Change of plan: Thursdays I pick up, backup Jordan." })).json as { candidates: { candidate_id: string }[] };
    expect(chat.candidates).toHaveLength(1);
    expect((await c("POST", "/api/confirm", { candidate_id: chat.candidates[0].candidate_id, edits: {} })).status).toBe(200);
    const s1 = (await c("GET", "/api/state")).json as { chat: unknown[]; conflicts: { conflict_id: string }[] };
    expect(s1.chat.length).toBeGreaterThan(49);
    const plan = (await c("POST", "/api/plan", { conflict_id: s1.conflicts[1].conflict_id })).json as { plan: { plan_id: string } };
    expect((await c("POST", "/api/approve", { plan_id: plan.plan.plan_id })).json).toMatchObject({ status: "drafted" });
    expect(((await c("GET", "/api/state")).json as { outbox: unknown[] }).outbox).toHaveLength(1);
    expect(sandboxes.get("sess-1", "judge1").ledger.cards()).toHaveLength(17);
    // Reset.
    expect((await c("POST", "/api/reset")).json).toEqual({ ok: true, judge: "judge1" });
    const s2 = (await c("GET", "/api/state")).json as typeof s0;
    expect(s2.chat).toHaveLength(49);
    expect(s2.outbox).toEqual([]);
    expect(s2.candidates).toEqual([]);
    expect(sandboxes.get("sess-1", "judge1").ledger.cards()).toHaveLength(16);
    expect((s2.calendar.events as { version: string }[]).every((e) => e.version === "v1")).toBe(true);
  });
});

describe("D2 — two judges at once", () => {
  it("each sees only their own writes, candidates, drafts and spend lines", async () => {
    const { guard } = guardWith({});
    const { route } = app({ guard });
    const a = client(route);
    const b = client(route);
    await login(a, "judge1", "secret-one");
    await login(b, "judge2", "secret-two");
    const chatA = (await a("POST", "/api/chat", { text: "Change of plan: Thursdays I pick up, backup Jordan." })).json as { candidates: { candidate_id: string }[] };
    const sa = (await a("GET", "/api/state")).json as { candidates: unknown[]; chat: unknown[]; session_id: string; spend: { session: { calls: number }; last: { session_id?: string }[] } };
    const sb = (await b("GET", "/api/state")).json as typeof sa;
    expect(sa.candidates).toHaveLength(1);
    expect(sb.candidates).toHaveLength(0);
    expect(sa.chat).toHaveLength(51);
    expect(sb.chat).toHaveLength(49);
    expect(sa.session_id).not.toBe(sb.session_id);
    expect(sa.spend.session.calls).toBe(2); // intake + relate
    expect(sb.spend.session.calls).toBe(0);
    expect(sa.spend.last.every((l) => l.session_id === sa.session_id)).toBe(true);
    expect(sb.spend.last).toEqual([]);
    await a("POST", "/api/confirm", { candidate_id: chatA.candidates[0].candidate_id, edits: {} });
    const conflictsB = ((await b("GET", "/api/state")).json as { conflicts: { conflict_id: string }[] }).conflicts;
    await b("POST", "/api/plan", { conflict_id: conflictsB[0].conflict_id });
    const planB = Object.keys(((await b("GET", "/api/state")).json as { plans: object }).plans);
    expect(planB).toHaveLength(1);
    expect(Object.keys(((await a("GET", "/api/state")).json as { plans: object }).plans)).toHaveLength(0);
    // judge2 cannot approve judge1's plan or confirm judge1's candidate.
    expect((await b("POST", "/api/confirm", { candidate_id: chatA.candidates[0].candidate_id, edits: {} })).status).toBe(404);
  });
});

describe("D3 — LLM_ENABLED=false (SAMPLE mode)", () => {
  it("every route answers; banner reason present; intake falls back; explanation is the template; zero provider calls", async () => {
    const { guard, fake } = guardWith({}, { killSwitch: { enabled: false, reason: "LLM_ENABLED=false: model calls switched off by the kill switch" } });
    const { route } = app({ guard });
    const c = client(route);
    await login(c);
    const s = (await c("GET", "/api/state")).json as { wall: { enabled: boolean; reason: string; mode: string } };
    expect(s.wall).toMatchObject({ enabled: false, mode: "sample", reason: expect.stringMatching(/LLM_ENABLED=false/) });
    expect(HTML).toContain("Model is off (");
    expect(HTML).toContain("showing recorded replies; nothing here is live");
    const chat = (await c("POST", "/api/chat", { text: "From now on Jordan picks up Theo on Thursdays." })).json as { mode: string; candidates: { unsure: string[]; note: string }[]; note: string };
    expect(chat.mode).toBe("rules");
    expect(chat.candidates[0].unsure).toContain("facet");
    expect(chat.candidates[0].note).toMatch(/the model is off; fill the card yourself/);
    const none = (await c("POST", "/api/chat", { text: "Thanks, that is all." })).json as { candidates: unknown[] };
    expect(none.candidates).toEqual([]);
    const st = (await c("GET", "/api/state")).json as { conflicts: { conflict_id: string }[] };
    const plan = (await c("POST", "/api/plan", { conflict_id: st.conflicts[0].conflict_id })).json as { plan: { status: string; plan_id: string }; explanation: { mode: string } };
    expect(plan.explanation.mode).toBe("template");
    expect((await c("POST", "/api/approve", { plan_id: plan.plan.plan_id })).json).toMatchObject({ status: "drafted" });
    const contrast = (await c("GET", "/api/contrast")).json as { pairs: { plan: { status: string }; explanation: { mode: string } }[] };
    expect(contrast.pairs.map((p) => p.plan.status)).toEqual(["ready", "refused"]);
    expect(contrast.pairs.every((p) => p.explanation.mode === "template")).toBe(true);
    expect((await c("POST", "/api/reset")).status).toBe(200);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("D5 — one action_id per button press; spend lines carry the login's session id", () => {
  it("trace refs equal the injected action ids; ledger session_id equals the cookie session", async () => {
    const { guard } = guardWith({});
    const { route, sandboxes } = app({ guard, actionIds: ["a-login", "a-state", "a-chat", "a-confirm", "a-plan", "a-approve", "a-undo-missing"] });
    const c = client(route);
    await login(c);
    await c("GET", "/api/state");
    const chat = (await c("POST", "/api/chat", { text: "Change of plan: Thursdays I pick up, backup Jordan." })).json as { candidates: { candidate_id: string }[] };
    await c("POST", "/api/confirm", { candidate_id: chat.candidates[0].candidate_id, edits: {} });
    const st = (await c("GET", "/api/state")).json as { conflicts: { conflict_id: string }[]; session_id: string };
    const plan = (await c("POST", "/api/plan", { conflict_id: st.conflicts[1].conflict_id })).json as { plan: { plan_id: string } };
    await c("POST", "/api/approve", { plan_id: plan.plan.plan_id });
    const trace = readFileSync(join(root, "state", "sessions", "sess-1", "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { action: string; ref?: string; details?: { action_id?: string } });
    expect(trace.find((t) => t.action === "ui.chat")?.ref).toBe("a-chat");
    expect(trace.find((t) => t.action === "ui.confirm")?.ref).toBe("a-confirm");
    expect(trace.find((t) => t.action === "plan")?.details?.action_id).toBe("a-approve"); // the 5th injected id went to the GET /api/state before it
    expect(trace.filter((t) => t.action === "ui.chat")).toHaveLength(1);
    // The spend ledger: the chat press made two model calls (intake + relate) under ONE action id and the login's session id.
    const status = guard.status(st.session_id);
    const reserves = status.last.filter((e) => e.kind === "reserve") as { action_id: string; session_id: string; call_kind: string }[];
    expect(reserves.map((r) => r.call_kind).sort()).toEqual(["explain", "intake", "relate"]);
    expect(new Set(reserves.slice(0, 2).map((r) => r.action_id))).toEqual(new Set(["a-chat"]));
    expect(reserves.every((r) => r.session_id === "sess-1")).toBe(true);
    expect(sandboxes.get("sess-1", "judge1").session_id).toBe(st.session_id);
  });
});

describe("D6 — the key never appears in any response body or log line", () => {
  it("over a full run through the real provider path with a fake transport", async () => {
    const FAKE_KEY = "sk-FAKE-KEY-do-not-leak-7f3a9c";
    const KEY_NAME = ["NEBIUS", "_API_KEY"].join("");
    const ledgerPath = join(root, "spend-ledger.jsonl");
    SpendLedger.create(ledgerPath, () => CLOCK);
    let n = 0;
    const fetchFn = async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      const system = req.messages.find((m) => m.role === "system")?.content ?? "";
      const user = req.messages.find((m) => m.role === "user")?.content ?? "";
      const kind = kindOf({ model: MODEL, system, user });
      const text = JSON.stringify(DEFAULT_SCRIPT[kind]!({ model: MODEL, system, user }, ++n));
      return new Response(JSON.stringify({ model: MODEL, choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), { status: 200 });
    };
    const env: Record<string, string> = { [KEY_NAME]: FAKE_KEY, NEBIUS_BASE_URL: "http://127.0.0.1:1/v1", NEBIUS_MODEL: MODEL, NEBIUS_PRICES_JSON: JSON.stringify({ [MODEL]: { input_per_m: 1, output_per_m: 1 } }), SPEND_LEDGER_PATH: ledgerPath };
    const guard = SpendGuard.fromEnv(env, { fetchFn, now: () => CLOCK, log: (l) => logs.push(l) });
    expect(guard.state().enabled).toBe(true);
    const { route } = app({ guard });
    const c = client(route);
    await login(c);
    const chat = (await c("POST", "/api/chat", { text: "Change of plan: Thursdays I pick up, backup Jordan." })).json as { mode: string; candidates: { candidate_id: string }[] };
    expect(chat.mode).toBe("model");
    await c("POST", "/api/confirm", { candidate_id: chat.candidates[0].candidate_id, edits: {} });
    const st = (await c("GET", "/api/state")).json as { conflicts: { conflict_id: string }[] };
    const plan = (await c("POST", "/api/plan", { conflict_id: st.conflicts[1].conflict_id })).json as { plan: { plan_id: string }; explanation: { mode: string } };
    expect(plan.explanation.mode).toBe("model");
    await c("POST", "/api/approve", { plan_id: plan.plan.plan_id });
    await c("GET", "/api/contrast");
    await c("GET", "/api/state");
    await c("POST", "/api/undo", { token: "nope" });
    await c("POST", "/api/logout");
    expect(n).toBeGreaterThanOrEqual(3);
    const everything = [...bodies, ...logs].join("\n");
    expect(everything).not.toContain(FAKE_KEY);
    expect(everything).not.toContain("Bearer ");
    expect(bodies.some((b) => b.includes("spend-ledger.jsonl"))).toBe(true); // the panel does show the ledger path and numbers
    const ledgerText = readFileSync(ledgerPath, "utf8");
    expect(ledgerText).not.toContain(FAKE_KEY);
    expect(ledgerText).toContain('"session_id":"sess-1"');
  });
});

describe("D7 — conflicts at or after the demo clock; the T10 contrast is reachable", () => {
  it("lists 11/3, 11/5, 11/6 only; /api/contrast plans 10/26 (ready) and 11/2 (refused); /api/plan on a past conflict says so", async () => {
    const { guard } = guardWith({});
    const { route, sandboxes } = app({ guard });
    const c = client(route);
    await login(c);
    const st = (await c("GET", "/api/state")).json as { conflicts: { at: string; conflict_id: string }[] };
    expect(st.conflicts.map((x) => x.at.slice(0, 10))).toEqual(["2026-11-03", "2026-11-05", "2026-11-06"]);
    const contrast = (await c("GET", "/api/contrast")).json as { pairs: { plan: { status: string; at: string; steps: { kind: string }[] } }[] };
    expect(contrast.pairs.map((p) => [p.plan.at.slice(0, 10), p.plan.status, p.plan.steps[0]?.kind])).toEqual([
      ["2026-10-26", "ready", "reschedule_own"],
      ["2026-11-02", "refused", undefined],
    ]);
    const all = await (await import("./api.ts")).Api.prototype.conflicts.call(new (await import("./api.ts")).Api(sandboxes), sandboxes.get("sess-1", "judge1"), { all: true });
    const past = all.find((x) => x.at.startsWith("2026-10-31"))!;
    expect((await c("POST", "/api/plan", { conflict_id: past.conflict_id })).json).toMatchObject({ error: "in_the_past" });
  });
});

describe("D8 — approve → read back → undo", () => {
  it("versions move v1 → v2 → v3 and each read-back is in the API output", async () => {
    const { guard } = guardWith({});
    const { route, sandboxes } = app({ guard });
    const c = client(route);
    await login(c);
    const contrast = (await c("GET", "/api/contrast")).json as { pairs: { plan: { plan_id: string; loser: string; steps: { after: { start: string } }[] } }[] };
    const ready = contrast.pairs[0].plan;
    const cal = sandboxes.get("sess-1", "judge1").calendar;
    expect((await cal.get(ready.loser))?.version).toBe("v1");
    const r = (await c("POST", "/api/approve", { plan_id: ready.plan_id })).json as { status: string; undo_token: string; steps: { readback: { version: string; start: string } }[] };
    expect(r.status).toBe("executed");
    expect(r.steps[0].readback).toMatchObject({ version: "v2", start: ready.steps[0].after.start });
    expect((await cal.get(ready.loser))?.version).toBe("v2");
    const again = (await c("POST", "/api/approve", { plan_id: ready.plan_id })).json as { status: string };
    expect(again.status).toBe("executed"); // the stored first result; nothing written again
    expect((await cal.get(ready.loser))?.version).toBe("v2");
    const u = (await c("POST", "/api/undo", { token: r.undo_token })).json as { status: string; events: { readback: { version: string; start: string } }[] };
    expect(u.status).toBe("restored");
    expect(u.events[0].readback).toMatchObject({ version: "v3", start: "2026-10-26T09:00:00-05:00" });
    expect((await cal.get(ready.loser))?.version).toBe("v3");
    const st = (await c("GET", "/api/state")).json as { plans: Record<string, { result: { status: string }; undo: { status: string } }> };
    expect(st.plans[ready.plan_id]).toMatchObject({ result: { status: "executed" }, undo: { status: "restored" } });
    expect((await c("POST", "/api/undo", { token: r.undo_token })).json).toMatchObject({ status: "refused" });
  });
});

describe("D9 — the T1 route end to end through route()", () => {
  it("with the clock running (as on a real server), a card confirmed a minute after the demo clock is in force for the plan — not \"dated after now\"", async () => {
    let t = CLOCK;
    const { guard } = guardWith({});
    const { route } = app({ guard, now: () => (t += 60_000) }); // every read of the clock is a minute later
    const c = client(route);
    await login(c);
    const chat = (await c("POST", "/api/chat", { text: "Change of plan: Thursdays I pick up, backup Jordan — Alex is travelling Thursdays now." })).json as { candidates: { candidate_id: string; card: { decided_at: string } }[] };
    const cand = chat.candidates[0];
    expect(Date.parse(cand.card.decided_at)).toBeGreaterThan(CLOCK); // stamped after the demo clock
    const conf = (await c("POST", "/api/confirm", { candidate_id: cand.candidate_id, edits: { card_id: "pickup.nov3" } })).json as { ok: boolean; resolution: { state: string; in_effect_card: string } };
    expect(conf).toMatchObject({ ok: true, resolution: { state: "PASS", in_effect_card: "pickup.nov3" } });
    const st = (await c("GET", "/api/state")).json as { conflicts: { at: string; conflict_id: string }[] };
    const thu = st.conflicts.find((x) => x.at.startsWith("2026-11-05"))!;
    const plan = (await c("POST", "/api/plan", { conflict_id: thu.conflict_id })).json as { plan: { status: string; seat_versions: string[] } };
    expect(plan.plan.status).toBe("ready");
    expect(plan.plan.seat_versions).toContain("pickup_backup|thursday|kids=pickup.nov3");
    // The screen can quote the card the plan used and strike through what it replaced.
    const after = (await c("GET", "/api/state")).json as { cards: Record<string, { quote: string; replaces: string[] }> };
    expect(after.cards["pickup.nov3"]).toMatchObject({ quote: "Thursdays I pick up, backup Jordan", replaces: ["pickup.oct3"] });
    expect(after.cards["pickup.oct3"].quote).toMatch(/^Thursdays I pick up, backup Jordan/);
  });

  it("sentence → candidate → confirm (REPLACES) → seat PASS new card → re-plan 11/5 → handoff to Jordan → one draft, never sent", async () => {
    const { guard } = guardWith({});
    const { route, sandboxes } = app({ guard });
    const c = client(route);
    await login(c);
    const chat = (await c("POST", "/api/chat", { text: "Change of plan: Thursdays I pick up, backup Jordan — Alex is travelling Thursdays now." })).json as { mode: string; candidates: { candidate_id: string; same_seat: string[]; relations: Record<string, string>; unsure: string[]; card: { quote: string } }[] };
    expect(chat.mode).toBe("model");
    const cand = chat.candidates[0];
    expect(cand.card.quote).toBe("Thursdays I pick up, backup Jordan");
    expect(cand.unsure).toEqual([]);
    expect(cand.same_seat).toEqual(["pickup.oct3"]);
    expect(cand.relations).toEqual({ "pickup.oct3": "REPLACES" });
    const conf = (await c("POST", "/api/confirm", { candidate_id: cand.candidate_id, edits: { card_id: "pickup.nov3" } })).json as { ok: boolean; seat: string; resolution: { state: string; in_effect_card: string; chain: string[] } };
    expect(conf).toMatchObject({ ok: true, seat: "pickup_backup|thursday|kids", resolution: { state: "PASS", in_effect_card: "pickup.nov3", chain: ["pickup.nov3", "pickup.oct3", "pickup.sept"] } });
    const st = (await c("GET", "/api/state")).json as { seats: { key: string; in_effect: { card_id: string }; replaced: { card_id: string } }[]; conflicts: { at: string; conflict_id: string }[]; chat: { text: string }[] };
    const row = st.seats.find((r) => r.key === "pickup_backup|thursday|kids")!;
    expect(row.in_effect.card_id).toBe("pickup.nov3");
    expect(row.replaced.card_id).toBe("pickup.oct3");
    expect(st.chat.at(-1)!.text).toMatch(/^✓ Recorded: "Thursdays I pick up, backup Jordan"/);
    const thu = st.conflicts.find((x) => x.at.startsWith("2026-11-05"))!;
    const plan = (await c("POST", "/api/plan", { conflict_id: thu.conflict_id })).json as { plan: { status: string; plan_id: string; steps: { kind: string; draft: { to: string[] } }[]; explanation: string; seat_versions: string[] }; explanation: { mode: string; explanation_prose: string; explanation_removed: string[] } };
    expect(plan.plan.status).toBe("ready");
    expect(plan.plan.steps[0]).toMatchObject({ kind: "draft_handoff", draft: { to: ["Jordan"] } });
    expect(plan.plan.seat_versions).toContain("pickup_backup|thursday|kids=pickup.nov3");
    expect(plan.explanation.mode).toBe("model");
    expect(plan.explanation.explanation_prose).toBe("Jordan is the Thursday backup.");
    expect(plan.explanation.explanation_removed).toEqual(["Casey flies to Madison tomorrow. (not in the plan: Casey, Madison)"]);
    const r = (await c("POST", "/api/approve", { plan_id: plan.plan.plan_id })).json as { status: string };
    expect(r.status).toBe("drafted");
    const outbox = ((await c("GET", "/api/state")).json as { outbox: { kind: string; to: string[]; status: string }[] }).outbox;
    expect(outbox).toEqual([expect.objectContaining({ kind: "handoff", to: ["Jordan"], status: "draft" })]);
    expect(HTML).toContain("Draft · you send it"); // the assistant has no send step; the parent sends
    expect(Object.keys(sandboxes.get("sess-1", "judge1").outbox)).not.toContain("send");
  });

  it("the 'I cannot date this' choice writes an undated card, and only it does", async () => {
    const { guard } = guardWith({ intake: () => ({ cards: [{ quote: "Saturdays Jordan picks up Theo from the showcase", mode: "decides", topic: "pickup_backup", facet: "friday", scope: "kids", decided_by: "me", effective: null, decided_at: null, value: "backup Jordan", unsure: ["effective"] }] }) });
    const { route, sandboxes } = app({ guard });
    const c = client(route);
    await login(c);
    const chat = (await c("POST", "/api/chat", { text: "An old note says Saturdays Jordan picks up Theo from the showcase." })).json as { candidates: { candidate_id: string }[] };
    const id = chat.candidates[0].candidate_id;
    // Through confirm(), "unknown" is not accepted (decided_at must parse).
    expect((await c("POST", "/api/confirm", { candidate_id: id, edits: { card: { decided_at: "unknown", effective: "unknown" } } })).json).toMatchObject({ error: "unsure" });
    const r = (await c("POST", "/api/confirm", { candidate_id: id, edits: { cannot_date: true, card_id: "pickup.fri.undated" } })).json as { ok: boolean; undated: boolean };
    expect(r).toMatchObject({ ok: true, undated: true });
    const card = sandboxes.get("sess-1", "judge1").ledger.card("pickup.fri.undated")!;
    expect(card).toMatchObject({ decided_at: "unknown", effective: "unknown" });
    const st = (await c("GET", "/api/state")).json as { seats: { key: string; state: string; cards: string[] }[] };
    expect(st.seats.find((s) => s.key === "pickup_backup|friday|kids")).toMatchObject({ state: "UNDATED", cards: ["pickup.fri.undated"] });
  });
});

describe("D10 — index.html", () => {
  it("has no external URL, no third-party brand names, and is English", () => {
    const urls = [...HTML.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
    expect(urls.filter((u) => !u.startsWith("http://127.0.0.1"))).toEqual([]);
    for (const brand of ["Nebius", "NVIDIA", "Nvidia", "Nemotron", "OpenAI", "Anthropic", "Claude", "Google", "Microsoft", "Apple", "Amazon", "Meta", "Slack", "Notion", "Zoom", "Devpost", "GitHub"]) {
      expect(HTML.includes(brand), `index.html mentions ${brand}`).toBe(false);
    }
    expect(HTML).toMatch(/<html lang="en">/);
    expect(HTML).not.toMatch(/<script[^>]+src=/);
    expect(HTML).not.toMatch(/<link[^>]+href=/);
    expect(HTML).toContain("Reset my sandbox");
    expect(HTML).toContain("Log out");
    expect(HTML).toContain("Demo clock:");
    expect(HTML).toContain("I cannot date this");
    expect(HTML).toContain("not supported by the plan");
  });
});

describe("D11 — binding", () => {
  it("without HOST binds 127.0.0.1 only; HOST=0.0.0.0 binds as told", async () => {
    const { guard } = guardWith({});
    const { route } = app({ guard });
    const a = await startServer(route, { port: 0 });
    const addrA = a.address() as { address: string; port: number };
    expect(addrA.address).toBe("127.0.0.1");
    expect(addrA.port).toBeGreaterThan(0);
    const b = await startServer(route, { host: "0.0.0.0", port: 0 });
    expect((b.address() as { address: string }).address).toBe("0.0.0.0");
    await new Promise<void>((r) => a.close(() => r()));
    await new Promise<void>((r) => b.close(() => r()));
  });
});
