// Append-only JSONL spend ledger on disk. Every model call is booked twice: a `reserve` line for the
// worst case before the request leaves, and a `settle` line afterwards that refunds the difference to
// the usage the server reported (or refunds nothing when no usage came back). Totals are sums of the
// `usd` field over reserve + settle lines, so the committed spend is always the sum of the file.
//
// The ledger must exist before model calls are allowed. A missing or unreadable file never means
// "zero spent" — the guard stays disabled until a human creates the file (scripts/spend-status.ts init).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chicagoDay, chicagoIso as chicagoIsoShared } from "../time/chicago.ts";
import { round8 } from "./prices.ts";

export const DEFAULT_LEDGER_PATH = "state/spend-ledger.jsonl";

export type Usage = { input_tokens: number; output_tokens: number };

type Base = { at: string; day: string }; // at = ISO 8601 with America/Chicago offset; day = Chicago calendar day

export type OpenedEntry = Base & { kind: "opened"; note: string };
export type ReserveEntry = Base & {
  kind: "reserve";
  call_id: string;
  session_id: string;
  action_id: string;
  call_kind: string;
  model: string;
  usd: number; // worst case, positive
  input_tokens_bound: number;
  max_tokens: number;
  attempt: number; // 1 = first try, 2 = the single retry
};
export type SettleEntry = Base & {
  kind: "settle";
  call_id: string;
  session_id: string;
  action_id: string;
  usd: number; // actual − reserved: a refund (≤ 0) or, if usage exceeded the bound, a top-up (> 0)
  actual_usd: number;
  booked: "usage" | "worst_case"; // worst_case = the response carried no usage, or the call failed
  outcome: "ok" | "error";
  usage?: Usage;
  model_answered?: string;
  latency_ms?: number;
};
export type RefuseEntry = Base & {
  kind: "refuse";
  session_id: string;
  action_id: string;
  call_kind: string;
  model: string;
  limit: string;
  reason: string;
  worst_usd?: number;
};
export type BreakerEntry = Base & { kind: "breaker"; reason: string; spent_usd: number };

export type LedgerEntry = OpenedEntry | ReserveEntry | SettleEntry | RefuseEntry | BreakerEntry;

export class LedgerUnreadable extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`spend ledger ${path}: ${detail}`);
    this.name = "LedgerUnreadable";
    this.path = path;
  }
}

export type Totals = {
  all: number;
  byDay: Record<string, number>;
  bySession: Record<string, number>;
  byAction: Record<string, number>;
  byCall: Record<string, number>;
  calls: number; // reserve lines
  refusals: number;
};

export class SpendLedger {
  readonly path: string;
  private readonly entries: LedgerEntry[] = [];
  private readonly reserves = new Map<string, ReserveEntry>();
  private readonly actualByCall = new Map<string, number>(); // call_id → settled actual (absent = unsettled)
  private readonly now: () => number;

  private constructor(path: string, now: () => number) {
    this.path = path;
    this.now = now;
  }

  // Creates a new ledger with its `opened` line. Refuses to overwrite an existing file.
  static create(path: string, now: () => number = Date.now, note = "created"): SpendLedger {
    if (existsSync(path)) throw new LedgerUnreadable(path, "already exists; refusing to overwrite a ledger");
    mkdirSync(dirname(path), { recursive: true });
    const ms = now();
    const line: OpenedEntry = { kind: "opened", at: chicagoIso(ms), day: chicagoDay(ms), note };
    writeFileSync(path, JSON.stringify(line) + "\n");
    return SpendLedger.open(path, now);
  }

  // Reads the whole file. Throws LedgerUnreadable when the file is missing, unreadable, or any line is
  // not a ledger entry — the caller must then keep model calls disabled.
  static open(path: string, now: () => number = Date.now): SpendLedger {
    if (!existsSync(path)) throw new LedgerUnreadable(path, "file is missing; model calls stay disabled (never start from zero). Create it with `npx tsx scripts/spend-status.ts init` only if you know nothing has been spent yet");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new LedgerUnreadable(path, `cannot read (${(e as Error).message})`);
    }
    const ledger = new SpendLedger(path, now);
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length === 0) throw new LedgerUnreadable(path, "file is empty; a ledger starts with an `opened` line");
    lines.forEach((line, i) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new LedgerUnreadable(path, `line ${i + 1} is not JSON`);
      }
      if (!isEntry(parsed)) throw new LedgerUnreadable(path, `line ${i + 1} is not a ledger entry`);
      ledger.index(parsed);
    });
    return ledger;
  }

  private index(e: LedgerEntry) {
    this.entries.push(e);
    if (e.kind === "reserve") this.reserves.set(e.call_id, e);
    if (e.kind === "settle") this.actualByCall.set(e.call_id, e.actual_usd);
  }

  private append(e: LedgerEntry) {
    appendFileSync(this.path, JSON.stringify(e) + "\n");
    this.index(e);
  }

  private stamp(): Base {
    const ms = this.now();
    return { at: chicagoIso(ms), day: chicagoDay(ms) };
  }

  reserve(input: Omit<ReserveEntry, "kind" | "at" | "day">): ReserveEntry {
    if (this.reserves.has(input.call_id)) throw new Error(`ledger: call ${input.call_id} is already reserved`);
    const e: ReserveEntry = { kind: "reserve", ...this.stamp(), ...input, usd: round8(input.usd) };
    this.append(e);
    return e;
  }

  // Books the call at its actual cost. The settle line is attributed to the reserve's day, so a call
  // that straddles midnight stays in the day it started.
  settle(callId: string, result: { actualUsd: number; booked: SettleEntry["booked"]; outcome: SettleEntry["outcome"]; usage?: Usage; modelAnswered?: string; latencyMs?: number }): SettleEntry {
    const r = this.reserves.get(callId);
    if (!r) throw new Error(`ledger: cannot settle unknown call ${callId}`);
    if (this.actualByCall.has(callId)) throw new Error(`ledger: call ${callId} is already settled`);
    const actual = round8(result.actualUsd);
    const e: SettleEntry = {
      kind: "settle",
      at: this.stamp().at,
      day: r.day,
      call_id: callId,
      session_id: r.session_id,
      action_id: r.action_id,
      usd: round8(actual - r.usd),
      actual_usd: actual,
      booked: result.booked,
      outcome: result.outcome,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.modelAnswered ? { model_answered: result.modelAnswered } : {}),
      ...(result.latencyMs !== undefined ? { latency_ms: result.latencyMs } : {}),
    };
    this.append(e);
    return e;
  }

  refuse(input: Omit<RefuseEntry, "kind" | "at" | "day">): RefuseEntry {
    const e: RefuseEntry = { kind: "refuse", ...this.stamp(), ...input };
    this.append(e);
    return e;
  }

  breakerTripped(reason: string, spentUsd: number): BreakerEntry {
    const e: BreakerEntry = { kind: "breaker", ...this.stamp(), reason, spent_usd: spentUsd };
    this.append(e);
    return e;
  }

  // Committed spend (reserved, net of refunds) within a scope. Unsettled reserves count in full.
  committed(scope: { session_id?: string; action_id?: string; day?: string } = {}): number {
    let sum = 0;
    for (const e of this.entries) {
      if (e.kind !== "reserve" && e.kind !== "settle") continue;
      if (scope.session_id !== undefined && e.session_id !== scope.session_id) continue;
      if (scope.action_id !== undefined && e.action_id !== scope.action_id) continue;
      if (scope.day !== undefined && e.day !== scope.day) continue;
      sum += e.usd;
    }
    return round8(sum);
  }

  callsInAction(actionId: string): number {
    let n = 0;
    for (const r of this.reserves.values()) if (r.action_id === actionId) n++;
    return n;
  }

  // Actual spend of calls that started in [fromMs, toMs]: settled actual, or the full reservation while
  // unsettled. Feeds the hourly breaker.
  actualInWindow(fromMs: number, toMs: number): number {
    let sum = 0;
    for (const r of this.reserves.values()) {
      const t = Date.parse(r.at);
      if (t < fromMs || t > toMs) continue;
      sum += this.actualByCall.get(r.call_id) ?? r.usd;
    }
    return round8(sum);
  }

  totals(): Totals {
    const t: Totals = { all: 0, byDay: {}, bySession: {}, byAction: {}, byCall: {}, calls: 0, refusals: 0 };
    for (const e of this.entries) {
      if (e.kind === "refuse") t.refusals++;
      if (e.kind === "reserve") t.calls++;
      if (e.kind !== "reserve" && e.kind !== "settle") continue;
      t.all += e.usd;
      t.byDay[e.day] = (t.byDay[e.day] ?? 0) + e.usd;
      t.bySession[e.session_id] = (t.bySession[e.session_id] ?? 0) + e.usd;
      t.byAction[e.action_id] = (t.byAction[e.action_id] ?? 0) + e.usd;
      t.byCall[e.call_id] = (t.byCall[e.call_id] ?? 0) + e.usd;
    }
    t.all = round8(t.all);
    for (const m of [t.byDay, t.bySession, t.byAction, t.byCall]) for (const k of Object.keys(m)) m[k] = round8(m[k]);
    return t;
  }

  last(n: number): LedgerEntry[] {
    return this.entries.slice(-n);
  }

  get size(): number {
    return this.entries.length;
  }

  get openedAt(): string | undefined {
    const first = this.entries[0];
    return first?.kind === "opened" ? first.at : undefined;
  }
}

const KINDS = new Set(["opened", "reserve", "settle", "refuse", "breaker"]);
function isEntry(v: unknown): v is LedgerEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.kind === "string" && KINDS.has(o.kind) && typeof o.at === "string" && typeof o.day === "string";
}

// ---- America/Chicago clock helpers (shared: src/time/chicago.ts) ------------------------------------
// The ledger writes its timestamps with milliseconds; day buckets are Chicago calendar days.
export const chicagoIso = (ms: number) => chicagoIsoShared(ms, true);
export { chicagoDay };
export { chicagoDayBounds } from "../time/chicago.ts";
