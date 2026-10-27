// A7–A10, A13: approve → re-check seats → write → read back → roll back / undo / idempotency / trace.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Outbox } from "../outbox/drafts.ts";
import { detectConflicts } from "./detect.ts";
import type { Conflict } from "./detect.ts";
import { ActionStore, executePlan } from "./execute.ts";
import type { ExecuteDeps } from "./execute.ts";
import { DEMO_CLOCK, card, morganSeats, rec, store as makeStore } from "./fixtures.test-helpers.ts";
import { planConflict } from "./plan.ts";
import type { ActionPlan } from "./plan.ts";
import { JsonlTrace, MemoryTrace } from "./trace.ts";
import { undo } from "./undo.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unworried-exec-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seats = morganSeats();

async function setup(session = "s1") {
  const calendar = makeStore(dir, session);
  const events = await calendar.all();
  const conflicts = detectConflicts(events);
  const trace = new MemoryTrace(() => DEMO_CLOCK);
  const outbox = new Outbox({ now: () => DEMO_CLOCK });
  const store = new ActionStore();
  const deps: ExecuteDeps = { approved: true, session_id: session, calendar, seats, outbox, trace, store };
  const conflictOn = (day: string, title: string): Conflict => {
    const c = conflicts.find((x) => x.overlap.start.startsWith(day) && (x.a.title.startsWith(title) || x.b.title.startsWith(title)));
    if (!c) throw new Error(`no conflict on ${day} with ${title}`);
    return c;
  };
  return { calendar, events, trace, outbox, store, deps, conflictOn };
}

describe("A7 — arrangements changed after planning", () => {
  it("refuses with 'your arrangements changed'", async () => {
    const s = await setup();
    const plan = planConflict(s.conflictOn("2026-11-05", "Flight home from Denver"), { events: s.events, seats });
    expect(plan.status).toBe("ready");
    // A newer Thursday decision lands before approval.
    const later = morganSeats(DEMO_CLOCK, (c) => {
      const r = rec("Thursdays: Alex covers pickup again from this week.", "2026-11-02T20:00:00-06:00");
      c.records.push(r);
      c.cards.push(card("pickup.nov2", r, { quote: "Thursdays: Alex covers pickup", topic: "pickup_backup", facets: ["thursday"], scope: "kids" }));
      c.edges.push({ old_card: "pickup.oct3", new_card: "pickup.nov2", relation: "REPLACES" });
    });
    const r = await executePlan(plan, { ...s.deps, seats: later });
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/your arrangements changed after this plan was made: pickup_backup\|thursday\|kids: was pickup\.oct3, now pickup\.nov2/);
    expect(s.outbox.list()).toEqual([]);
  });
});

describe("A8 — step 2 fails on purpose", () => {
  it("reverts step 1, ends rolled_back, read-back equals before", async () => {
    const s = await setup();
    const focus = s.events.find((e) => e.event_id.startsWith("ev-20261026-loomstack-monday-focus"))!;
    const review = s.events.find((e) => e.event_id.startsWith("ev-20261106-week-review"))!;
    const plan: ActionPlan = {
      plan_id: "test-a8",
      conflict_id: "c",
      at: "2026-10-26T10:00:00-05:00",
      status: "ready",
      depends_on_seats: [],
      seat_versions: [],
      steps: [
        { kind: "reschedule_own", target_event_id: focus.event_id, before: { version: focus.version, start: focus.start, end: focus.end }, after: { start: "2026-10-26T13:00:00-05:00", end: "2026-10-26T15:00:00-05:00" } },
        { kind: "reschedule_own", target_event_id: review.event_id, before: { version: "v99", start: review.start, end: review.end }, after: { start: "2026-11-06T13:00:00-06:00", end: "2026-11-06T14:00:00-06:00" } },
      ],
      explanation: "test",
    };
    const r = await executePlan(plan, s.deps);
    expect(r.status).toBe("rolled_back");
    expect(r.reason).toMatch(/step 1 failed: event .* expected version v99 but the calendar has v1/);
    expect(r.steps.map((x) => x.outcome)).toEqual(["reverted", "failed"]);
    expect(r.undo_token).toBeUndefined();
    const back = await s.calendar.get(focus.event_id);
    expect(back?.start).toBe(focus.start);
    expect(back?.end).toBe(focus.end);
    expect(back?.version).toBe("v3"); // written, then written back
    expect(r.steps[0].readback).toEqual({ version: "v3", start: focus.start, end: focus.end });
    expect((await s.calendar.get(review.event_id))?.version).toBe("v1");
  });

  it("a revert that fails → needs_attention with the current state", async () => {
    const s = await setup();
    const focus = s.events.find((e) => e.event_id.startsWith("ev-20261026-loomstack-monday-focus"))!;
    // Write 1 = step 0, write 2 = step 1 (fails on its own: no such event), write 3 = the revert of step 0 → fails.
    let writes = 0;
    const flaky = {
      ...s.calendar,
      list: s.calendar.list.bind(s.calendar),
      get: s.calendar.get.bind(s.calendar),
      update: async (id: string, patch: Parameters<typeof s.calendar.update>[1], v: string) => {
        writes++;
        if (writes === 3) throw new Error("disk full");
        return s.calendar.update(id, patch, v);
      },
    };
    const plan: ActionPlan = {
      plan_id: "test-a8b",
      conflict_id: "c",
      at: "2026-10-26T10:00:00-05:00",
      status: "ready",
      depends_on_seats: [],
      seat_versions: [],
      steps: [
        { kind: "reschedule_own", target_event_id: focus.event_id, before: { version: "v1", start: focus.start, end: focus.end }, after: { start: "2026-10-26T13:00:00-05:00", end: "2026-10-26T15:00:00-05:00" } },
        { kind: "reschedule_own", target_event_id: "ev-does-not-exist", before: { version: "v1", start: focus.start, end: focus.end }, after: { start: focus.start, end: focus.end } },
      ],
      explanation: "test",
    };
    const r = await executePlan(plan, { ...s.deps, calendar: flaky });
    expect(r.status).toBe("needs_attention");
    expect(r.steps[0].error).toMatch(/revert failed: disk full/);
    expect(r.steps[0].readback).toEqual({ version: "v2", start: "2026-10-26T13:00:00-05:00", end: "2026-10-26T15:00:00-05:00" });
  });
});

describe("A9 — the same plan twice", () => {
  it("writes the calendar once and returns the stored result", async () => {
    const s = await setup();
    const plan = planConflict(s.conflictOn("2026-10-26", "Loomstack — Monday focus block"), { events: s.events, seats });
    const first = await executePlan(plan, s.deps);
    expect(first.status).toBe("executed");
    expect(first.undo_token).toBeDefined();
    const again = await executePlan(plan, s.deps);
    expect(again).toBe(first);
    const ev = await s.calendar.get(plan.loser!);
    expect(ev?.version).toBe("v2"); // one write
    expect(ev?.start).toBe(plan.steps[0].after!.start);
    expect(s.trace.events.filter((e) => e.action === "execute.start").map((e) => e.outcome)).toEqual(["ready", "replay"]);
    expect(s.trace.events.filter((e) => e.action === "execute.step")).toHaveLength(1);
  });

  it("not approved → refused, nothing written, and not remembered as done", async () => {
    const s = await setup();
    const plan = planConflict(s.conflictOn("2026-10-26", "Loomstack — Monday focus block"), { events: s.events, seats });
    const r = await executePlan(plan, { ...s.deps, approved: false });
    expect(r).toMatchObject({ status: "refused", reason: "not approved by the user" });
    expect((await s.calendar.get(plan.loser!))?.version).toBe("v1");
    expect((await executePlan(plan, s.deps)).status).toBe("executed"); // approval later runs it
  });
});

describe("A10 — undo", () => {
  it("after execute: restored", async () => {
    const s = await setup();
    const plan = planConflict(s.conflictOn("2026-10-26", "Loomstack — Monday focus block"), { events: s.events, seats });
    const r = await executePlan(plan, s.deps);
    const u = await undo(r.undo_token!, { calendar: s.calendar, store: s.store, trace: s.trace, session_id: "s1" });
    expect(u.status).toBe("restored");
    const ev = await s.calendar.get(plan.loser!);
    expect(ev?.start).toBe(plan.steps[0].before.start);
    expect(ev?.end).toBe(plan.steps[0].before.end);
    expect(ev?.version).toBe("v3");
    expect(u.events[0].readback).toEqual({ version: "v3", start: plan.steps[0].before.start, end: plan.steps[0].before.end });
    // Single use.
    const twice = await undo(r.undo_token!, { calendar: s.calendar, store: s.store, trace: s.trace, session_id: "s1" });
    expect(twice).toMatchObject({ status: "refused", reason: "unknown or already used undo token" });
  });

  it("after a later unrelated edit: refused with the reason", async () => {
    const s = await setup();
    const plan = planConflict(s.conflictOn("2026-10-26", "Loomstack — Monday focus block"), { events: s.events, seats });
    const r = await executePlan(plan, s.deps);
    const current = (await s.calendar.get(plan.loser!))!;
    await s.calendar.update(plan.loser!, { title: "Loomstack — Monday focus block (renamed)" }, current.version);
    const u = await undo(r.undo_token!, { calendar: s.calendar, store: s.store, trace: s.trace, session_id: "s1" });
    expect(u.status).toBe("refused");
    expect(u.reason).toMatch(/this event was changed after the plan ran/);
    expect((await s.calendar.get(plan.loser!))?.start).toBe(plan.steps[0].after!.start); // untouched by the refused undo
  });
});

describe("A11 — drafts only", () => {
  it("writes to the outbox and leaves the calendar untouched", async () => {
    const s = await setup();
    const plan = planConflict(s.conflictOn("2026-11-06", "Pebblemail — design review with Devin"), { events: s.events, seats });
    const before = await s.calendar.all();
    const r = await executePlan(plan, s.deps);
    expect(r.status).toBe("drafted");
    expect(r.undo_token).toBeUndefined();
    expect(r.steps).toEqual([{ index: 0, outcome: "drafted", draft_id: expect.any(String) }]);
    expect(await s.calendar.all()).toEqual(before);
    const drafts = s.outbox.list();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: "message", to: ["Devin (Pebblemail designer)"], status: "draft", plan_id: plan.plan_id });
    expect(Object.keys(s.outbox)).not.toContain("send");
  });
});

describe("A13 — the trace", () => {
  it("holds every step of a full run, in memory and as JSONL", async () => {
    const s = await setup();
    const jsonl = new JsonlTrace(join(dir, "trace", "actions.jsonl"), () => DEMO_CLOCK);
    const tee = { write: (e: Parameters<typeof jsonl.write>[0]) => (jsonl.write(e), s.trace.write(e)) };
    const deps = { ...s.deps, trace: tee };
    const plans = detectConflicts(s.events).map((c) => {
      tee.write({ session_id: "s1", action: "detect", ref: c.conflict_id, outcome: "conflict", details: { a: c.a.event_id, b: c.b.event_id } });
      const p = planConflict(c, { events: s.events, seats });
      tee.write({ session_id: "s1", action: "plan", ref: p.plan_id, outcome: p.status, details: { steps: p.steps.map((x) => x.kind), refusal: p.refusal?.reason } });
      return p;
    });
    const results = [];
    for (const p of plans) results.push(await executePlan(p, deps));
    const executed = results.find((r) => r.status === "executed")!;
    await undo(executed.undo_token!, { calendar: s.calendar, store: s.store, trace: tee, session_id: "s1" });

    const ev = s.trace.events;
    expect(ev.filter((e) => e.action === "detect")).toHaveLength(7);
    expect(ev.filter((e) => e.action === "plan")).toHaveLength(7);
    for (const p of plans) {
      expect(ev.some((e) => e.action === "execute.start" && e.ref === p.plan_id)).toBe(true);
      expect(ev.some((e) => e.action === "execute.result" && e.ref === p.plan_id)).toBe(true);
      for (let i = 0; i < p.steps.length; i++) expect(ev.some((e) => (e.action === "execute.step" || e.action === "draft") && e.ref !== undefined && e.step === i && ev.indexOf(e) > ev.findIndex((x) => x.action === "execute.start" && x.ref === p.plan_id))).toBe(true);
    }
    expect(ev.filter((e) => e.action === "undo").map((e) => e.outcome)).toEqual(["restored"]);
    expect(ev.every((e) => e.model === null && e.usd === null)).toBe(true); // no model, no money in this task
    expect(ev.every((e) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[56]:00$/.test(e.at))).toBe(true);
    const lines = readFileSync(join(dir, "trace", "actions.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(ev.length);
    expect(JSON.parse(lines.at(-1)!)).toEqual(ev.at(-1));
  });
});
