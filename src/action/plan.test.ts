// A3–A6, A11, A12: plans from the seed's traps, ordered by the decisions in force.
import { describe, expect, it } from "vitest";
import type { CalEvent } from "../calendar/port.ts";
import { detectConflicts } from "./detect.ts";
import type { Conflict } from "./detect.ts";
import { DEMO_CLOCK, morganSeats, seedEvents } from "./fixtures.test-helpers.ts";
import { planConflict } from "./plan.ts";

const events = seedEvents();
const seats = morganSeats();
const conflicts = detectConflicts(events);

// The conflict on `day` involving an event whose title starts with `title`.
function conflictOn(day: string, title: string): Conflict {
  const c = conflicts.find((x) => x.overlap.start.startsWith(day) && (x.a.title.startsWith(title) || x.b.title.startsWith(title)));
  if (!c) throw new Error(`no conflict on ${day} with "${title}"; have ${conflicts.map((x) => `${x.overlap.start} ${x.a.title} × ${x.b.title}`).join(" | ")}`);
  return c;
}

describe("the seed's conflicts", () => {
  it("are exactly the seven deliberate ones", () => {
    expect(conflicts.map((c) => c.overlap.start.slice(0, 10))).toEqual(["2026-10-26", "2026-10-30", "2026-10-31", "2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"]);
  });
});

describe("A3 — Thursday pickup (T1: overturned pickup)", () => {
  const plan = planConflict(conflictOn("2026-11-05", "Flight home from Denver"), { events, seats });
  it("drafts a handoff to Jordan, never Alex", () => {
    expect(plan.status).toBe("ready");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe("draft_handoff");
    expect(plan.steps[0].draft?.to).toEqual(["Jordan"]);
    expect(plan.steps[0].draft?.body).not.toMatch(/Alex/);
    expect(plan.steps[0].after).toBeUndefined(); // the pickup is never moved or marked covered
  });
  it("cites the 10/3 decision and names the one it replaced", () => {
    expect(plan.explanation).toContain('"Thursdays I pick up, backup Jordan" (decided 2026-10-03T21:10:00-05:00 by me');
    expect(plan.explanation).toContain('replacing "Tuesdays and Thursdays Alex picks up" of 2026-09-08T19:40:00-05:00');
    expect(plan.explanation).toMatch(/not covered until Jordan confirms/);
    expect(plan.depends_on_seats).toContain("pickup_backup|thursday|kids");
    expect(plan.seat_versions).toContain("pickup_backup|thursday|kids=pickup.oct3");
  });
});

describe("A4 — Tuesday pickup (T6: partial overturn)", () => {
  it("drafts to Alex: only Thursday changed", () => {
    const plan = planConflict(conflictOn("2026-11-03", "Flight to Denver"), { events, seats });
    expect(plan.status).toBe("ready");
    expect(plan.steps[0].kind).toBe("draft_handoff");
    expect(plan.steps[0].draft?.to).toEqual(["Alex"]);
    expect(plan.seat_versions).toContain("pickup_backup|tuesday|kids=pickup.sept");
    expect(plan.explanation).toContain('"Tuesdays and Thursdays Alex picks up" (decided 2026-09-08T19:40:00-05:00 by me)');
  });
});

describe("A5 — Saturday pickup (T3: undated conflict)", () => {
  it("refuses and names both cards", () => {
    const plan = planConflict(conflictOn("2026-10-31", "Flight home from Madison"), { events, seats });
    expect(plan.status).toBe("refused");
    expect(plan.steps).toEqual([]);
    expect(plan.refusal?.cards.sort()).toEqual(["pickup.sat.a", "pickup.sat.b"]);
    expect(plan.refusal?.seats).toEqual(["pickup_backup|saturday|kids"]);
    expect(plan.refusal?.reason).toMatch(/who covers the saturday pickup\?/);
    expect(plan.refusal?.reason).toContain("Saturdays Jordan picks up Theo from the showcase.");
    expect(plan.refusal?.reason).toContain("Saturday showcase: Alex covers pickup.");
    expect(plan.seat_versions).toContain("pickup_backup|saturday|kids=-");
  });
});

describe("A6 — Monday focus block (T10: decided, not yet in force)", () => {
  it("10/26: may be moved → reschedule_own to the earliest free slot inside working hours", () => {
    const plan = planConflict(conflictOn("2026-10-26", "Loomstack — Monday focus block"), { events, seats });
    expect(plan.status).toBe("ready");
    expect(plan.steps[0].kind).toBe("reschedule_own");
    expect(plan.steps[0].before).toEqual({ version: "v1", start: "2026-10-26T09:00:00-05:00", end: "2026-10-26T11:00:00-05:00" });
    // 09:00–11:00 is taken by the call (10:00–10:45) and the dev sync (11:00–11:30): the first free 2 h is 11:30.
    expect(plan.steps[0].after).toEqual({ start: "2026-10-26T11:30:00-05:00", end: "2026-10-26T13:30:00-05:00" });
    expect(plan.seat_versions).toContain("movable|work_focus|global=mov.focus.sept");
    expect(plan.explanation).toContain('"Focus blocks may be moved for a meeting" (decided 2026-09-02T20:20:00-05:00 by me)');
  });
  it("11/2: may not be moved → refused, citing the 10/20 decision and what it replaced", () => {
    const plan = planConflict(conflictOn("2026-11-02", "Loomstack — Monday focus block"), { events, seats });
    expect(plan.status).toBe("refused");
    expect(plan.refusal?.reason).toContain('"the Monday focus block may not be moved" (decided 2026-10-20T08:05:00-05:00 by me, replacing "Focus blocks may be moved for a meeting" of 2026-09-02T20:20:00-05:00)');
    expect(plan.seat_versions).toContain("movable|work_focus|global=mov.focus.oct20");
  });
});

describe("A11 — loser has other attendees", () => {
  it("drafts a message with two candidate slots and moves nothing", () => {
    const plan = planConflict(conflictOn("2026-11-06", "Pebblemail — design review with Devin"), { events, seats });
    expect(plan.status).toBe("ready");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe("draft_message");
    expect(plan.steps[0].after).toBeUndefined();
    expect(plan.steps[0].draft?.to).toEqual(["Devin (Pebblemail designer)"]);
    const options = plan.steps[0].draft!.body.match(/^\s+\d\. .+$/gm) ?? [];
    expect(options).toHaveLength(2);
    expect(plan.explanation).toMatch(/not moved: a message with two candidate slots is drafted/);
  });
});

describe("A12 — no free slot inside working hours", () => {
  it("refuses and forces nothing", () => {
    // Working hours shrunk to the hour the appointment already occupies; nothing else is free.
    const tight = morganSeats(DEMO_CLOCK, (c) => {
      const hours = c.cards.find((x) => x.card_id === "hours.sept")!;
      hours.quote = "Working hours 09:00-10:00, Monday to Friday.";
    });
    // A personal appointment (movable per the September decision) loses to a meeting.
    const errand: CalEvent = { event_id: "p", version: "v1", title: "Pharmacy", start: "2026-11-10T09:00:00-06:00", end: "2026-11-10T10:00:00-06:00", owner: "me", attendees: [], category: "personal" };
    const meeting: CalEvent = { event_id: "m", version: "v1", title: "Call", start: "2026-11-10T09:30:00-06:00", end: "2026-11-10T10:00:00-06:00", owner: "me", attendees: ["Casey (Loomstack contractor)"], category: "work_meeting" };
    const [conflict] = detectConflicts([errand, meeting]);
    expect(planConflict(conflict, { events: [errand, meeting], seats }).status).toBe("ready"); // with normal hours a slot exists
    const plan = planConflict(conflict, { events: [errand, meeting], seats: tight, horizonDays: 0 });
    expect(plan.status).toBe("refused");
    expect(plan.refusal?.reason).toMatch(/no free slot inside working hours/);
    expect(plan.steps).toEqual([]);
  });
});

describe("other refusals", () => {
  it("a category with no priority decision → 'which of these two comes first?'", () => {
    const noPersonal = morganSeats(DEMO_CLOCK, (c) => {
      c.cards = c.cards.filter((x) => x.card_id !== "prio.personal");
    });
    const dentist: CalEvent = { event_id: "d", version: "v1", title: "Dentist", start: "2026-11-10T15:00:00-06:00", end: "2026-11-10T16:00:00-06:00", owner: "me", attendees: [], category: "personal" };
    const focus: CalEvent = { event_id: "f", version: "v1", title: "Focus", start: "2026-11-10T15:30:00-06:00", end: "2026-11-10T16:30:00-06:00", owner: "me", attendees: [], category: "work_focus" };
    const plan = planConflict(detectConflicts([dentist, focus])[0], { events: [dentist, focus], seats: noPersonal });
    expect(plan.status).toBe("refused");
    expect(plan.refusal?.reason).toMatch(/which of these two comes first\? no decision on priority\|personal\|global/);
    expect(plan.refusal?.seats).toContain("priority|personal|global");
  });

  it("two categories with the same rank → refused", () => {
    const tie = morganSeats(DEMO_CLOCK, (c) => {
      c.cards.find((x) => x.card_id === "prio.personal")!.quote = "Personal appointments rank 5";
    });
    const dentist: CalEvent = { event_id: "d", version: "v1", title: "Dentist", start: "2026-11-10T15:00:00-06:00", end: "2026-11-10T16:00:00-06:00", owner: "me", attendees: [], category: "personal" };
    const focus: CalEvent = { event_id: "f", version: "v1", title: "Focus", start: "2026-11-10T15:30:00-06:00", end: "2026-11-10T16:30:00-06:00", owner: "me", attendees: [], category: "work_focus" };
    const plan = planConflict(detectConflicts([dentist, focus])[0], { events: [dentist, focus], seats: tie });
    expect(plan.status).toBe("refused");
    expect(plan.refusal?.reason).toMatch(/both have rank 5/);
  });

  it("the plan id changes when a seat's card changes, and is stable otherwise", () => {
    const c = conflictOn("2026-11-05", "Flight home from Denver");
    const p1 = planConflict(c, { events, seats });
    const p2 = planConflict(c, { events, seats });
    expect(p1.plan_id).toBe(p2.plan_id);
    const changed = morganSeats(DEMO_CLOCK, (x) => {
      x.cards.find((k) => k.card_id === "pickup.oct3")!.card_id = "pickup.oct3b";
      x.edges[1].new_card = "pickup.oct3b";
    });
    expect(planConflict(c, { events, seats: changed }).plan_id).not.toBe(p1.plan_id);
  });
});
