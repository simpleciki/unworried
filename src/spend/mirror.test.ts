// M1–M9 — the ledger mirror (a private GitHub repository file) for hosts whose disk does not survive a
// restart. Offline: GitHub is a fake fetch that keeps one file and its sha.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeProvider } from "../llm/fake.ts";
import { SpendGuard } from "./guard.ts";
import { SpendLedger } from "./ledger.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import type { Limits } from "./limits.ts";
import { GitHubLedgerMirror, MirrorError } from "./mirror.ts";
import type { MirrorFetch } from "./mirror.ts";

const MODEL = "fake/model";
const PRICES = { [MODEL]: { input_per_m: 1, output_per_m: 1 } };
const CLOCK = Date.parse("2026-11-03T09:00:00-06:00");
const WIDE: Limits = { ...DEFAULT_LIMITS, maxTokensByKind: { test: 1000 }, actionCalls: 100_000, actionUsd: 1e6, sessionUsd: 1e6, dayUsd: 1e6, totalUsd: 1e6, rateGlobal: 1e6, rateSession: 1e6, hourUsd: 1e6 };
const TOKEN = "test-token-value-0123456789";
const CFG = { repo: "someone/ledger", path: "spend-ledger.jsonl", token: TOKEN, branch: "main" };
const ctx = { session_id: "s1", action_id: "a1", kind: "test" };

// One file, one sha; PUT must carry the current sha (or none when the file does not exist yet).
class FakeGitHub {
  text: string | undefined;
  sha = 0;
  requests: { method: string; url: string; headers: Record<string, string>; body?: Record<string, unknown> }[] = [];
  failNextPut?: number;
  inFlight = 0;
  maxInFlight = 0;
  readonly fetch: MirrorFetch = async (url, init) => {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 2));
    this.inFlight--;
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.requests.push({ method: init.method, url, headers: init.headers, body });
    const reply = (status: number, value: unknown) => ({ status, ok: status < 300, text: async () => JSON.stringify(value) });
    if (init.method === "GET") return this.text === undefined ? reply(404, { message: "Not Found" }) : reply(200, { sha: `sha${this.sha}`, encoding: "base64", content: Buffer.from(this.text).toString("base64") });
    if (this.failNextPut) {
      const status = this.failNextPut;
      this.failNextPut = undefined;
      return reply(status, { message: "boom" });
    }
    const expected = this.text === undefined ? undefined : `sha${this.sha}`;
    if (body?.sha !== expected) return reply(409, { message: "sha mismatch" });
    this.text = Buffer.from(String(body?.content), "base64").toString("utf8");
    this.sha++;
    return reply(201, { content: { sha: `sha${this.sha}` } });
  };
}

let dir: string;
let ledgerPath: string;
let gh: FakeGitHub;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unworried-mirror-"));
  ledgerPath = join(dir, "state", "spend-ledger.jsonl");
  gh = new FakeGitHub();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const guardWith = (mirror: GitHubLedgerMirror, provider: FakeProvider, logs: string[] = []) => new SpendGuard({ ledgerPath, prices: PRICES, model: MODEL, limits: WIDE, provider, mirror, now: () => CLOCK, log: (l) => logs.push(l) });

describe("M — ledger mirror", () => {
  it("M1 remote absent → 'absent', no local file is created (model calls stay off)", async () => {
    const m = new GitHubLedgerMirror(CFG, gh.fetch);
    expect(await m.restore(ledgerPath)).toBe("absent");
    expect(existsSync(ledgerPath)).toBe(false);
    expect(guardWith(m, new FakeProvider(() => "x", [MODEL], MODEL)).state().enabled).toBe(false);
  });

  it("M2 local missing → the mirror is written locally and the guard opens it with the same totals", async () => {
    const src = join(dir, "src.jsonl");
    SpendLedger.create(src, () => CLOCK).reserve({ call_id: "c0", session_id: "old", action_id: "a0", call_kind: "test", model: MODEL, usd: 0.5, input_tokens_bound: 1, max_tokens: 1, attempt: 1 });
    gh.text = readFileSync(src, "utf8");
    const m = new GitHubLedgerMirror(CFG, gh.fetch);
    expect(await m.restore(ledgerPath)).toBe("restored");
    expect(readFileSync(ledgerPath, "utf8")).toBe(gh.text);
    expect(SpendLedger.open(ledgerPath).totals().all).toBe(0.5);
  });

  it("M3 local present and different → refuses; equal → 'same'", async () => {
    SpendLedger.create(ledgerPath, () => CLOCK);
    const m = new GitHubLedgerMirror(CFG, gh.fetch);
    gh.text = readFileSync(ledgerPath, "utf8");
    expect(await m.restore(ledgerPath)).toBe("same");
    gh.text += '{"kind":"opened","at":"x","day":"y","note":"other"}\n';
    await expect(new GitHubLedgerMirror(CFG, gh.fetch).restore(ledgerPath)).rejects.toThrow(/differs from the mirror/);
  });

  it("M4 a call pushes the reserve before the model is asked, then the settle; the mirror equals the local file", async () => {
    SpendLedger.create(ledgerPath, () => CLOCK);
    const m = new GitHubLedgerMirror(CFG, gh.fetch);
    let mirroredAtCall = "";
    const provider = new FakeProvider(() => {
      mirroredAtCall = gh.text ?? "";
      return "hello";
    }, [MODEL], MODEL);
    const r = await guardWith(m, provider).call({ ...ctx, user: "hi" });
    expect(r.ok).toBe(true);
    expect(mirroredAtCall).toMatch(/"kind":"reserve"/);
    expect(mirroredAtCall).not.toMatch(/"kind":"settle"/);
    await m.push(() => readFileSync(ledgerPath, "utf8")); // waits for the queued settle push
    expect(gh.text).toBe(readFileSync(ledgerPath, "utf8"));
    expect(gh.text).toMatch(/"kind":"settle"/);
  });

  it("M5 the reserve cannot be pushed → nothing is sent, refusal 'ledger', the reserve stays booked in full", async () => {
    SpendLedger.create(ledgerPath, () => CLOCK);
    const m = new GitHubLedgerMirror(CFG, gh.fetch);
    gh.failNextPut = 500;
    const provider = new FakeProvider(() => "never", [MODEL], MODEL);
    const r = await guardWith(m, provider).call({ ...ctx, user: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.limit).toBe("ledger");
      expect(r.reason).toMatch(/not sent/);
    }
    expect(provider.calls.length).toBe(0);
    const t = SpendLedger.open(ledgerPath).totals();
    expect(t.calls).toBe(1);
    expect(t.all).toBeGreaterThan(0);
  });

  it("M6 a second writer (stale sha) is a loud conflict, never an overwrite", async () => {
    SpendLedger.create(ledgerPath, () => CLOCK);
    gh.text = readFileSync(ledgerPath, "utf8");
    const m = new GitHubLedgerMirror(CFG, gh.fetch);
    await m.restore(ledgerPath);
    gh.sha += 5; // someone else wrote meanwhile
    const before = gh.text;
    await expect(m.push(() => readFileSync(ledgerPath, "utf8") + "extra\n")).rejects.toThrow(/conflict/);
    expect(gh.text).toBe(before);
  });

  it("M7 pushes are serial: never two PUTs in flight, each carries the sha the previous one returned", async () => {
    SpendLedger.create(ledgerPath, () => CLOCK);
    const m = new GitHubLedgerMirror(CFG, gh.fetch);
    await Promise.all([1, 2, 3].map((n) => m.push(() => `line ${n}\n`)));
    const puts = gh.requests.filter((q) => q.method === "PUT");
    expect(puts.map((p) => p.body?.sha)).toEqual([undefined, "sha1", "sha2"]);
    expect(gh.maxInFlight).toBe(1);
  });

  it("M8 the token is sent as a bearer header and never appears in an error message or a log line", async () => {
    SpendLedger.create(ledgerPath, () => CLOCK);
    const m = new GitHubLedgerMirror(CFG, gh.fetch);
    await m.push(() => "x\n");
    expect(gh.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    gh.failNextPut = 401;
    const logs: string[] = [];
    const r = await guardWith(m, new FakeProvider(() => "x", [MODEL], MODEL), logs).call({ ...ctx, user: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(readFileSync(ledgerPath, "utf8")).not.toContain(TOKEN);
  });

  it("M9 fromEnv: neither set → no mirror; only one set → loud error; a bad repo name → loud error", () => {
    expect(GitHubLedgerMirror.fromEnv({})).toBeNull();
    expect(() => GitHubLedgerMirror.fromEnv({ LEDGER_MIRROR_REPO: "a/b" })).toThrow(MirrorError);
    expect(() => GitHubLedgerMirror.fromEnv({ LEDGER_MIRROR_TOKEN: "t" })).toThrow(/set together/);
    expect(() => GitHubLedgerMirror.fromEnv({ LEDGER_MIRROR_REPO: "not a repo", LEDGER_MIRROR_TOKEN: "t" })).toThrow(/owner\/name/);
  });
});
