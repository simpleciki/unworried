// C4, C5, C6 — relation, confirmation, and what the action layer then sees.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectConflicts } from "../action/detect.ts";
import { seedEvents } from "../action/fixtures.test-helpers.ts";
import { planConflict } from "../action/plan.ts";
import type { LedgerStore } from "../ledger/store.ts";
import { confirm, discard } from "./confirm.ts";
import { DEMO_CLOCK, extras, fakeGuard, intakeReply, reply, seededStore, thursdayJordanCard, tmp } from "./fixtures.test-helpers.ts";
import { intake } from "./intake.ts";
import { relate, skepticCheck } from "./relate.ts";
import type { CheckedCard } from "../engine/types.ts";
import type { CandidateCard } from "../ledger/store.ts";

let dir: string;
beforeEach(() => {
  dir = tmp("confirm");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const events = seedEvents();
const conflictOn = (day: string, title: string) => detectConflicts(events).find((x) => x.overlap.start.startsWith(day) && (x.a.title.startsWith(title) || x.b.title.startsWith(title)))!;

describe("C4 — a Thursday card that REPLACES the September card", () => {
  it("seat PASS → new card, chain holds the old one, A3 drafts to Jordan", async () => {
    // The ledger as it stood before 10/3: Tuesdays and Thursdays are Alex.
    const store: LedgerStore = seededStore(dir, "s1", { until: "2026-10-03T00:00:00-05:00" });
    expect(store.cards().map((c) => c.card_id)).not.toContain("pickup.oct3");
    const script = [intakeReply([thursdayJordanCard({ effective: "2026-10-03" })]), reply({ relations: [{ card_id: "pickup.sept", relation: "REPLACES", because: "Thursdays now Morgan, backup Jordan" }] })];
    const { guard, fake } = fakeGuard(dir, (_r, n) => script[n - 1]);
    const msg = { message_id: "m-oct3", session_id: "s1", text: "Change of plan: Thursdays I pick up, backup Jordan — Alex is travelling Thursdays now.", sent_at: "2026-10-03T21:10:00-05:00" };
    const { candidates } = await intake(msg, { guard, store, extras, action_id: "a1" });
    expect(candidates[0].same_seat).toEqual(["pickup.sept"]);
    const related = await relate(candidates[0], { guard, store, action_id: "a1" });
    expect(related.mode).toBe("model");
    expect(fake.calls[1].maxTokens).toBe(256); // the relate kind's cap
    expect(related.candidate.relations).toEqual({ "pickup.sept": "REPLACES" });
    expect(related.candidate.relation_notes?.["pickup.sept"]).toMatch(/REPLACES supported: shared words thursdays/);
    const r = confirm(related.candidate.candidate_id, { card_id: "pickup.oct3" }, { store, extras, clock: DEMO_CLOCK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seat).toBe("pickup_backup|thursday|kids");
    expect(r.resolution.state).toBe("PASS");
    expect(r.resolution.in_effect_card).toBe("pickup.oct3");
    expect(r.resolution.chain).toEqual(["pickup.oct3", "pickup.sept"]);
    expect(store.edges().at(-1)).toEqual({ old_card: "pickup.sept", new_card: "pickup.oct3", relation: "REPLACES", source: "model" });
    expect(store.valueOf("pickup.oct3")).toBe("backup Jordan");
    // Tuesday is untouched (T6).
    expect(store.graph().resolve({ topic: "pickup_backup", facet: "tuesday", scope: "kids" }, DEMO_CLOCK).in_effect_card).toBe("pickup.sept");
    // A3 against this ledger.
    const plan = planConflict(conflictOn("2026-11-05", "Flight home from Denver"), { events, seats: store.seatsView(DEMO_CLOCK) });
    expect(plan.status).toBe("ready");
    expect(plan.steps[0].draft?.to).toEqual(["Jordan"]);
    expect(plan.explanation).toContain('"Thursdays I pick up, backup Jordan" (decided 2026-10-03T21:10:00-05:00 by me, replacing "Tuesdays and Thursdays Alex picks up Theo" of 2026-09-08T19:40:00-05:00)');
  });

  it("the user's relation wins over the model's and is recorded as human", async () => {
    const store = seededStore(dir, "s1", { until: "2026-10-03T00:00:00-05:00" });
    const script = [intakeReply([thursdayJordanCard({ effective: "2026-10-03" })]), reply({ relations: [{ card_id: "pickup.sept", relation: "UNRELATED", because: "" }] })];
    const { guard } = fakeGuard(dir, (_r, n) => script[n - 1]);
    const { candidates } = await intake({ message_id: "m", session_id: "s1", text: "Thursdays I pick up, backup Jordan.", sent_at: "2026-10-03T21:10:00-05:00" }, { guard, store, extras, action_id: "a1" });
    const related = await relate(candidates[0], { guard, store, action_id: "a1" });
    expect(related.candidate.relations["pickup.sept"]).toBe("UNRELATED");
    const r = confirm(related.candidate.candidate_id, { relations: { "pickup.sept": "REPLACES" } }, { store, extras, clock: DEMO_CLOCK });
    expect(r.ok).toBe(true);
    expect(store.edges().at(-1)).toMatchObject({ old_card: "pickup.sept", relation: "REPLACES", source: "human" });
  });
});

describe("the Skeptic", () => {
  const sept: CheckedCard = { card_id: "pickup.sept", record_id: "r", quote: "Tuesdays and Thursdays Alex picks up Theo", mode: "decides", topic: "pickup_backup", facets: ["tuesday", "thursday"], scope: "kids", decided_at: "2026-09-08T19:40:00-05:00", effective: "2026-09-08T19:40:00-05:00", decided_by: "me", result: "PASS" };
  const cand: CandidateCard = { quote: "Thursdays I pick up, backup Jordan", mode: "decides", topic: "pickup_backup", facet: "thursday", scope: "kids", decided_by: "me", decided_at: "2026-10-03T21:10:00-05:00", effective: "2026-10-03T21:10:00-05:00", source_recorded_at: "2026-10-03T21:10:00-05:00" };
  it("keeps REPLACES when the quotes share a word and the order is right", () => {
    expect(skepticCheck(cand, "backup Jordan", sept, "backup Alex", "REPLACES").relation).toBe("REPLACES");
  });
  it("downgrades a replacement that predates what it replaces, or shares nothing, or SAME with different values", () => {
    expect(skepticCheck({ ...cand, decided_at: "2026-09-01T10:00:00-05:00" }, "backup Jordan", sept, "backup Alex", "REPLACES").relation).toBe("UNRELATED");
    expect(skepticCheck({ ...cand, decided_at: "unknown" }, "backup Jordan", sept, "backup Alex", "REPLACES").relation).toBe("UNRELATED");
    expect(skepticCheck({ ...cand, quote: "Jordan has the spare key" }, "backup Jordan", sept, "backup Alex", "REFINES").relation).toBe("UNRELATED");
    expect(skepticCheck(cand, "backup Jordan", sept, "backup Alex", "SAME").relation).toBe("UNRELATED");
    expect(skepticCheck(cand, "backup Alex", sept, "backup Alex", "SAME").relation).toBe("SAME");
  });
});

describe("C5 — two Saturday cards, UNRELATED", () => {
  it("the seat is not PASS (ambiguous); the action layer refuses and names both", async () => {
    // The seeded ledger without the fridge-notes message: no Saturday card at all.
    const store = seededStore(dir, "s1", { drop: (m) => m.message_id === "m032" || (m.cards ?? []).some((c) => c.card.card_id.startsWith("pickup.sat")) });
    expect(store.cards().some((c) => c.card_id.startsWith("pickup.sat"))).toBe(false);
    const script = [
      intakeReply([thursdayJordanCard({ quote: "Saturdays Jordan picks up Theo from the showcase", facet: "saturday", effective: "2026-10-14", value: "backup Jordan" })]),
      intakeReply([thursdayJordanCard({ quote: "Saturday showcase: Alex covers pickup", facet: "saturday", effective: "2026-10-15", value: "backup Alex" })]),
      reply({ relations: [{ card_id: "sat.a", relation: "UNRELATED", because: "cannot tell" }] }),
    ];
    const { guard } = fakeGuard(dir, (_r, n) => script[n - 1]);
    const a = await intake({ message_id: "ma", session_id: "s1", text: "Saturdays Jordan picks up Theo from the showcase.", sent_at: "2026-10-14T20:00:00-05:00" }, { guard, store, extras, action_id: "a1" });
    expect(confirm(a.candidates[0].candidate_id, { card_id: "sat.a" }, { store, extras, clock: DEMO_CLOCK }).ok).toBe(true);
    const b = await intake({ message_id: "mb", session_id: "s1", text: "Saturday showcase: Alex covers pickup.", sent_at: "2026-10-15T20:00:00-05:00" }, { guard, store, extras, action_id: "a1" });
    expect(b.candidates[0].same_seat).toEqual(["sat.a"]);
    const related = await relate(b.candidates[0], { guard, store, action_id: "a1" });
    expect(related.candidate.relations).toEqual({ "sat.a": "UNRELATED" });
    const r = confirm(related.candidate.candidate_id, { card_id: "sat.b" }, { store, extras, clock: DEMO_CLOCK });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolution.coexisting).toEqual(["sat.a"]); // the engine: two heads, no link between them
      expect(r.resolution.state).toBe("PASS"); // (the engine does not call coexistence a conflict; the view does)
    }
    const lookup = store.seatsView(DEMO_CLOCK).pickupBackup("saturday", Date.parse("2026-10-31T15:00:00-05:00"));
    expect(lookup.state).toBe("AMBIGUOUS");
    expect(lookup.cards.sort()).toEqual(["sat.a", "sat.b"]);
    const plan = planConflict(conflictOn("2026-10-31", "Flight home from Madison"), { events, seats: store.seatsView(DEMO_CLOCK) });
    expect(plan.status).toBe("refused");
    expect(plan.refusal?.cards.sort()).toEqual(["sat.a", "sat.b"]);
    expect(plan.refusal?.reason).toContain("Saturdays Jordan picks up Theo from the showcase");
    expect(plan.refusal?.reason).toContain("Saturday showcase: Alex covers pickup");
  });
});

describe("C6 — an unconfirmed candidate", () => {
  it("is not in graph(); the action layer cannot see it; discard keeps it out for good", async () => {
    const store = seededStore(dir, "s1");
    const { guard } = fakeGuard(dir, () => intakeReply([thursdayJordanCard({ quote: "Fridays Jordan picks up Theo", facet: "friday", effective: "2026-10-30" })]));
    const { candidates } = await intake({ message_id: "m", session_id: "s1", text: "Fridays Jordan picks up Theo.", sent_at: "2026-10-27T20:10:00-05:00" }, { guard, store, extras, action_id: "a1" });
    expect(candidates[0].unsure).toEqual([]);
    expect(store.graph().cardsOn({ topic: "pickup_backup", facet: "friday", scope: "kids" })).toEqual([]);
    expect(store.seatsView(DEMO_CLOCK).pickupBackup("friday", DEMO_CLOCK).state).toBe("NOT_FOUND");
    expect(store.cards()).toHaveLength(16);
    const d = discard(candidates[0].candidate_id, { store });
    expect(d.status).toBe("discarded");
    expect(store.candidates("pending")).toEqual([]);
    expect(() => confirm(candidates[0].candidate_id, {}, { store, extras, clock: DEMO_CLOCK })).toThrow(/already discarded/);
    expect(store.cards()).toHaveLength(16);
  });
});
