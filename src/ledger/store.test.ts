// C9 (sessions isolated, reset to the seed), C11 (the seeded ledger drives the whole action suite), and
// the store's loud validation.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectConflicts } from "../action/detect.ts";
import { ActionStore, executePlan } from "../action/execute.ts";
import { DEMO_CLOCK, ROOT, morganSeats, seedEvents, store as calendarStore, vocab } from "../action/fixtures.test-helpers.ts";
import { planConflict } from "../action/plan.ts";
import { MemoryTrace } from "../action/trace.ts";
import { undo } from "../action/undo.ts";
import { Outbox } from "../outbox/drafts.ts";
import { LedgerStore, loadConversationSeed } from "./store.ts";

const SEED_PATH = join(ROOT, "data", "conversation-seed.jsonl");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = join(ROOT, "scripts", "seed-ledger.ts");

let dir: string;
beforeEach(() => {
  dir = join(tmpdir(), `unworried-ledger-${Math.random().toString(36).slice(2, 8)}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seed = () => loadConversationSeed(SEED_PATH);

describe("the conversation seed", () => {
  it("is well formed: 49 messages 2026-09-01 → 2026-11-03, 16 cards with the fixtures' ids, values for every decision", () => {
    const { messages, ledger } = seed();
    expect(messages).toHaveLength(49);
    expect(messages[0].sent_at.startsWith("2026-09-01")).toBe(true);
    expect(messages.at(-1)!.sent_at.startsWith("2026-11-03")).toBe(true);
    expect(messages.every((m) => /[+-]\d{2}:\d{2}$/.test(m.sent_at))).toBe(true);
    expect(ledger.cards).toHaveLength(16);
    const ids = ledger.cards.map((c) => c.card_id).sort();
    for (const id of ["prio.travel", "prio.kids_pickup", "prio.work_meeting", "prio.personal", "prio.work_focus", "mov.focus.sept", "mov.personal.sept", "mov.fixed.sept", "mov.focus.oct20", "hours.sept", "pickup.sept", "pickup.oct3", "pickup.sat.a", "pickup.sat.b"]) expect(ids).toContain(id);
    const decides = ledger.cards.filter((c) => c.mode === "decides");
    expect(decides.every((c) => ledger.values.some((v) => v.card_id === c.card_id))).toBe(true);
    expect(ledger.edges).toEqual([
      { old_card: "pickup.sept", new_card: "pickup.oct3", relation: "REPLACES", source: "seed" },
      { old_card: "mov.focus.sept", new_card: "mov.focus.oct20", relation: "REPLACES", source: "seed" },
    ]);
    // T2: decided before it was recorded.
    const hours = ledger.cards.find((c) => c.card_id === "hours.sept")!;
    const rec = ledger.records.find((r) => r.record_id === hours.record_id)!;
    expect(hours.decided_at).toBe("2026-09-02T20:25:00-05:00");
    expect(rec.source_recorded_at).toBe("2026-09-15T21:05:00-05:00");
    // Every quote is in its message.
    for (const c of ledger.cards) expect(ledger.records.find((r) => r.record_id === c.record_id)!.text).toContain(c.quote);
  });
});

describe("C9 — sessions are isolated; reset returns to the seed", () => {
  it("a card written in one session is invisible in the other; reset drops it", () => {
    const { ledger } = seed();
    const s1 = new LedgerStore({ dir, session: "judge-1", vocab, seed: ledger, now: () => DEMO_CLOCK });
    const s2 = new LedgerStore({ dir, session: "judge-2", vocab, seed: ledger, now: () => DEMO_CLOCK });
    const card = { ...ledger.cards.find((c) => c.card_id === "pickup.oct3")!, card_id: "pickup.extra", facets: ["friday"], quote: "Thursdays I pick up" };
    s1.addCard(card, ledger.records[0], [], "backup Jordan");
    expect(s1.cards()).toHaveLength(17);
    expect(s2.cards()).toHaveLength(16);
    expect(new LedgerStore({ dir, session: "judge-1", vocab, seed: ledger }).cards()).toHaveLength(17); // the file is the state
    s1.reset();
    expect(s1.cards()).toHaveLength(16);
    expect(s1.cards().map((c) => c.card_id)).toEqual(ledger.cards.map((c) => c.card_id));
    expect(s1.values().size).toBe(14);
  });

  it("withdraw hides a card and its edges from the graph without deleting lines", () => {
    const { ledger } = seed();
    const s = new LedgerStore({ dir, session: "s", vocab, seed: ledger, now: () => DEMO_CLOCK });
    s.withdraw("pickup.oct3", "test");
    expect(s.card("pickup.oct3")).toBeUndefined();
    expect(s.edges().some((e) => e.new_card === "pickup.oct3")).toBe(false);
    expect(s.graph().resolve({ topic: "pickup_backup", facet: "thursday", scope: "kids" }, DEMO_CLOCK).in_effect_card).toBe("pickup.sept");
    expect(readFileSync(join(dir, "s", "cards.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(17); // 16 cards + 1 withdraw line
    expect(() => s.withdraw("pickup.oct3")).toThrow(/unknown or already withdrawn/);
  });

  it("refuses to open a ledger with a corrupt line, and a bad session id", () => {
    const { ledger } = seed();
    new LedgerStore({ dir, session: "s", vocab, seed: ledger });
    appendFileSync(join(dir, "s", "cards.jsonl"), "{not json\n");
    expect(() => new LedgerStore({ dir, session: "s", vocab, seed: ledger })).toThrow(/cards\.jsonl: line 17 is not a JSON object/);
    expect(() => new LedgerStore({ dir, session: "../x", vocab, seed: ledger })).toThrow(/session id/);
  });
});

describe("C11 — scripts/seed-ledger.ts, then the action suite against the seeded ledger", () => {
  it("the seeded ledger plans every seed conflict exactly as the hand-built fixtures do, and executes", async () => {
    const out = execFileSync(process.execPath, [TSX, SCRIPT, "judge-x"], { env: { PATH: process.env.PATH, LEDGER_DIR: dir }, encoding: "utf8" });
    expect(out).toMatch(/cards: 16\s+edges: 2\s+values: 14/);
    expect(out).toMatch(/pickup_backup\|thursday\|kids\s+PASS\s+current=pickup\.oct3/);
    expect(existsSync(join(dir, "judge-x", "cards.jsonl"))).toBe(true);
    // Open what the script wrote (the seed argument is only used when the files do not exist yet).
    const store = new LedgerStore({ dir, session: "judge-x", vocab, seed: { cards: [], edges: [], values: [], records: [] }, now: () => DEMO_CLOCK });
    expect(store.cards()).toHaveLength(16);
    const seeded = store.seatsView(DEMO_CLOCK);
    const hand = morganSeats();
    const events = seedEvents();
    const conflicts = detectConflicts(events);
    expect(conflicts).toHaveLength(7);
    const shape = (p: ReturnType<typeof planConflict>) => ({ status: p.status, loser: p.loser, steps: p.steps.map((s) => ({ kind: s.kind, to: s.draft?.to, after: s.after })), refused_cards: p.refusal?.cards.sort() });
    for (const c of conflicts) expect(shape(planConflict(c, { events, seats: seeded }))).toEqual(shape(planConflict(c, { events, seats: hand })));
    // The seeded values are what the view reads: the quotes alone would not parse ("Then Theo's pickups" has no rank).
    expect(seeded.priority("kids_pickup", DEMO_CLOCK)).toMatchObject({ state: "PASS", value: 2, card_id: "prio.kids_pickup", quote: "Then Theo's pickups" });
    expect(seeded.pickupBackup("saturday", DEMO_CLOCK).state).toBe("UNDATED");
    // Execute and undo one plan through the seeded view.
    const calendar = calendarStore(dir, "judge-x");
    const plan = planConflict(conflicts.find((c) => c.overlap.start.startsWith("2026-10-26"))!, { events, seats: seeded });
    const deps = { approved: true, session_id: "judge-x", calendar, seats: seeded, outbox: new Outbox(), trace: new MemoryTrace(), store: new ActionStore() };
    const r = await executePlan(plan, deps);
    expect(r.status).toBe("executed");
    expect((await undo(r.undo_token!, { calendar, store: deps.store, trace: deps.trace, session_id: "judge-x" })).status).toBe("restored");
  });
});
