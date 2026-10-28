// C10 — a model-written explanation, checked sentence by sentence; template when the wall is off.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectConflicts } from "../action/detect.ts";
import { seedEvents } from "../action/fixtures.test-helpers.ts";
import { planConflict } from "../action/plan.ts";
import type { Lookup } from "../action/seats-view.ts";
import { checkSentence, claimsSending, explainPlan } from "./explain.ts";
import { DEMO_CLOCK, fakeGuard, reply, seededStore, tmp } from "./fixtures.test-helpers.ts";

let dir: string;
beforeEach(() => {
  dir = tmp("explain");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function thursdayPlan() {
  const store = seededStore(dir, "s1");
  const seats = store.seatsView(DEMO_CLOCK);
  const events = seedEvents();
  const conflict = detectConflicts(events).find((x) => x.overlap.start.startsWith("2026-11-05"))!;
  const plan = planConflict(conflict, { events, seats });
  const at = Date.parse(conflict.overlap.start);
  const lookups: Lookup<unknown>[] = [seats.priority("travel", at), seats.priority("kids_pickup", at), seats.pickupBackup("thursday", at)];
  return { plan, lookups };
}

describe("C10 — explain", () => {
  it("removes the one unsupported sentence and lists it; keeps the rest", async () => {
    const { plan, lookups } = thursdayPlan();
    expect(plan.status).toBe("ready");
    const sentences = [
      'Your pickup "Theo — robotics club pickup" on Thu 2026-11-05 17:30 yields to "Flight home from Denver".',
      "Jordan is the Thursday backup, decided 2026-10-03, replacing the September arrangement with Alex.",
      "Casey will cover the pickup on Friday instead.", // nothing in the plan says this
      "A handoff message to Jordan is drafted and the pickup stays not covered until Jordan confirms.",
    ];
    const { guard, fake } = fakeGuard(dir, () => reply({ sentences }));
    const r = await explainPlan(plan, lookups, { guard, session_id: "s1", action_id: "a1" });
    expect(r.mode).toBe("model");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].maxTokens).toBe(512); // the explain kind's cap
    expect(r.explanation_removed).toEqual(["Casey will cover the pickup on Friday instead. (not in the plan: Casey)"]);
    expect(r.explanation_prose).toBe([sentences[0], sentences[1], sentences[3]].join(" "));
    expect(plan.explanation).toMatch(/^"Theo — robotics club pickup"/); // the template stays as it was
  });

  it("wall off → template; a wholly unsupported reply → template with everything listed", async () => {
    const { plan, lookups } = thursdayPlan();
    const off = fakeGuard(dir, () => reply({ sentences: ["x"] }), { killSwitch: { enabled: false, reason: "LLM_ENABLED=false: model calls switched off by the kill switch" } });
    const r = await explainPlan(plan, lookups, { guard: off.guard, session_id: "s1", action_id: "a1" });
    expect(r).toMatchObject({ mode: "template", explanation_prose: plan.explanation, explanation_removed: [] });
    expect(off.fake.calls).toHaveLength(0);
    const { guard } = fakeGuard(`${dir}/b`, () => reply({ sentences: ["Devin agreed to move the review to 4:15.", "The flight to Madison leaves at noon."] }));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(`${dir}/b`, { recursive: true });
    const r2 = await explainPlan(plan, lookups, { guard, session_id: "s1", action_id: "a1" });
    expect(r2.mode).toBe("template");
    expect(r2.explanation_removed).toHaveLength(2);
    expect(r2.explanation_removed[0]).toMatch(/not in the plan: Devin, 4:15/);
  });

  it("checkSentence: names, numbers and times must appear in the plan; common words need not", () => {
    const facts = 'Jordan 2026-10-03 "Flight home from Denver" 17:30';
    expect(checkSentence("Jordan covers the flight at 17:30.", facts).ok).toBe(true);
    expect(checkSentence("Alex covers it at 17:30.", facts)).toEqual({ ok: false, unsupported: ["Alex"] });
    expect(checkSentence("The Thursday pickup moves to 18:00.", facts)).toEqual({ ok: false, unsupported: ["18:00"] });
  });

  it("removes a sentence that says it sends — the assistant only drafts — and keeps a negated one", async () => {
    expect(claimsSending("The assistant will send a handoff message to Jordan.")).toBe(true);
    expect(claimsSending("Jordan was emailed.")).toBe(true);
    expect(claimsSending("A handoff to Jordan is drafted and never sent.")).toBe(false);
    expect(claimsSending("Nothing is sent until you approve.")).toBe(false);
    expect(claimsSending("The handoff to Jordan is drafted.")).toBe(false);
    const { plan, lookups } = thursdayPlan();
    const { guard } = fakeGuard(dir, () => reply({ sentences: ["The assistant will send a handoff message to Jordan.", "Jordan is the Thursday backup."] }));
    const r = await explainPlan(plan, lookups, { guard, session_id: "s1", action_id: "a1" });
    expect(r.explanation_prose).toBe("Jordan is the Thursday backup.");
    expect(r.explanation_removed).toEqual(["The assistant will send a handoff message to Jordan. (says it sends; the assistant only drafts, never sends)"]);
  });

  it("keeps at most four sentences", async () => {
    const { plan, lookups } = thursdayPlan();
    const { guard } = fakeGuard(dir, () => reply({ sentences: ["Jordan.", "Jordan.", "Jordan.", "Jordan.", "Jordan."] }));
    const r = await explainPlan(plan, lookups, { guard, session_id: "s1", action_id: "a1" });
    expect(r.explanation_prose.split(" ")).toHaveLength(4);
    expect(r.explanation_removed).toEqual(["Jordan. (beyond 4 sentences)"]);
  });
});
