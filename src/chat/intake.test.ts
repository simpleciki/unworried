// C1, C2, C3, C7, C8 — one sentence → candidate cards, with the model scripted and the code checking.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { intake } from "./intake.ts";
import { confirm } from "./confirm.ts";
import { DEMO_CLOCK, extras, fakeGuard, intakeReply, seededStore, thursdayJordanCard, tmp } from "./fixtures.test-helpers.ts";
import type { LedgerStore } from "../ledger/store.ts";

let dir: string;
let store: LedgerStore;
beforeEach(() => {
  dir = tmp("intake");
  store = seededStore(dir, "s1");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const msg = (text: string, sent_at = "2026-10-27T20:10:00-05:00") => ({ message_id: `m-${Math.random().toString(36).slice(2, 8)}`, session_id: "s1", text, sent_at });

describe("C1 — effective vs decided_at", () => {
  it("effective = the Thursday the model proposed; decided_at = sent_at", async () => {
    const { guard, fake } = fakeGuard(dir, () => intakeReply([thursdayJordanCard({ quote: "From next Thursday Jordan picks up Theo", effective: "2026-10-29" })]));
    const r = await intake(msg("From next Thursday Jordan picks up Theo."), { guard, store, extras, action_id: "a1" });
    expect(r.mode).toBe("model");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].maxTokens).toBe(512); // the intake kind's cap
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.card.effective).toBe("2026-10-29");
    expect(c.card.decided_at).toBe("2026-10-27T20:10:00-05:00");
    expect(c.card.source_recorded_at).toBe("2026-10-27T20:10:00-05:00");
    expect(c.unsure).toEqual([]);
    expect(c.value).toBe("backup Jordan");
    expect(c.same_seat).toEqual(["pickup.oct3"]); // what currently sits on pickup_backup|thursday|kids
    expect(c.status).toBe("pending");
    expect(store.candidate(c.candidate_id)).toEqual(c);
  });

  it("T2: a sentence naming an earlier moment → decided_at then, recorded now, both kept", async () => {
    const { guard } = fakeGuard(dir, () => intakeReply([thursdayJordanCard({ quote: "on 10/3 we agreed Thursdays I pick up, backup Jordan", decided_at: "2026-10-03", effective: "2026-10-03" })]));
    const r = await intake(msg("By the way, on 10/3 we agreed Thursdays I pick up, backup Jordan.", "2026-10-09T08:00:00-05:00"), { guard, store, extras, action_id: "a1" });
    const c = r.candidates[0];
    expect(c.card.decided_at).toBe("2026-10-03");
    expect(c.card.source_recorded_at).toBe("2026-10-09T08:00:00-05:00");
    expect(c.card.decided_at).not.toBe(c.card.source_recorded_at);
    expect(c.unsure).toEqual([]);
  });
});

describe("C2 — questions and suggestions hold no seat", () => {
  it("a question is a mention, a 'should we' is a proposal; confirmed, neither reaches the graph", async () => {
    const script = [
      intakeReply([thursdayJordanCard({ quote: "Does Alex pick up Thursdays", mode: "decides", value: "backup Alex" })]), // the model got the mode wrong; the code corrects it
      intakeReply([thursdayJordanCard({ quote: "Should we ask Jordan to cover Thursdays", mode: "proposes", value: null, effective: null })]),
    ];
    const { guard } = fakeGuard(dir, (_r, n) => script[n - 1]);
    const q = await intake(msg("Does Alex pick up Thursdays?"), { guard, store, extras, action_id: "a1" });
    expect(q.candidates[0].card.mode).toBe("mentions");
    expect(q.candidates[0].note).toMatch(/a question is a mention/);
    expect(q.candidates[0].unsure).toEqual([]); // a mention needs no effective date or value
    const p = await intake(msg("Should we ask Jordan to cover Thursdays?"), { guard, store, extras, action_id: "a1" });
    expect(p.candidates[0].card.mode).toBe("proposes");
    const before = store.graph().cardsOn({ topic: "pickup_backup", facet: "thursday", scope: "kids" }).map((c) => c.card_id);
    const r1 = confirm(q.candidates[0].candidate_id, {}, { store, extras, clock: DEMO_CLOCK });
    const r2 = confirm(p.candidates[0].candidate_id, {}, { store, extras, clock: DEMO_CLOCK });
    expect(r1).toMatchObject({ ok: true, holds_seat: false });
    expect(r2).toMatchObject({ ok: true, holds_seat: false });
    expect(store.cards()).toHaveLength(18); // written to the ledger …
    expect(store.graph().cardsOn({ topic: "pickup_backup", facet: "thursday", scope: "kids" }).map((c) => c.card_id)).toEqual(before); // … but on no seat
    if (r1.ok) expect(r1.resolution.in_effect_card).toBe("pickup.oct3");
  });
});

describe("C3 — effective: null", () => {
  it("is unsure, cannot be confirmed until filled, and is never defaulted", async () => {
    const { guard } = fakeGuard(dir, () => intakeReply([thursdayJordanCard({ effective: null })]));
    const r = await intake(msg("Thursdays I pick up, backup Jordan."), { guard, store, extras, action_id: "a1" });
    const c = r.candidates[0];
    expect(c.unsure).toEqual(["effective"]);
    expect(c.card.effective).toBeNull();
    const refused = confirm(c.candidate_id, {}, { store, extras, clock: DEMO_CLOCK });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/still unsure about effective/);
    expect(store.cards()).toHaveLength(16);
    const filled = confirm(c.candidate_id, { card: { effective: "2026-10-29" } }, { store, extras, clock: DEMO_CLOCK });
    expect(filled.ok).toBe(true);
    if (filled.ok) expect(filled.card.effective).toBe("2026-10-29");
    expect(store.cards()).toHaveLength(17);
  });
});

describe("C7 — the wall is off", () => {
  it("rule fallback: marker sentence → one all-unsure candidate; other sentences → none; no provider call", async () => {
    const { guard, fake } = fakeGuard(dir, () => intakeReply([thursdayJordanCard()]), { killSwitch: { enabled: false, reason: "LLM_ENABLED=false: model calls switched off by the kill switch" } });
    const on = await intake(msg("From now on Jordan picks up Theo on Thursdays."), { guard, store, extras, action_id: "a1" });
    expect(on.mode).toBe("rules");
    expect(on.candidates).toHaveLength(1);
    const c = on.candidates[0];
    expect(c.note).toMatch(/the model is off; fill the card yourself/);
    expect(c.unsure.sort()).toEqual(["effective", "facet", "quote", "scope", "topic", "value"].sort());
    expect(c.card.decided_at).toBe("2026-10-27T20:10:00-05:00");
    const off = await intake(msg("The Pebblemail launch went fine, thanks."), { guard, store, extras, action_id: "a1" });
    expect(off.candidates).toEqual([]);
    expect(off.mode).toBe("rules");
    expect(fake.calls).toHaveLength(0);
    expect(confirm(c.candidate_id, {}, { store, extras, clock: DEMO_CLOCK }).ok).toBe(false);
  });

  it("a refused call (budget) also falls back, with the reason", async () => {
    const { guard, fake } = fakeGuard(dir, () => intakeReply([thursdayJordanCard()]));
    const tight = new (await import("../spend/guard.ts")).SpendGuard({ ...(guard as unknown as { limits: object }).limits, ledgerPath: `${dir}/spend-ledger.jsonl`, prices: { "fake/model": { input_per_m: 1, output_per_m: 1 } }, model: "fake/model", limits: { ...guard.limits, totalUsd: 0 }, provider: fake, now: () => DEMO_CLOCK, log: () => {} });
    const r = await intake(msg("From now on Jordan picks up Theo on Thursdays."), { guard: tight, store, extras, action_id: "a1" });
    expect(r.mode).toBe("rules");
    expect(r.note).toMatch(/refused: total_usd/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("C8 — the model's reply is checked, not trusted", () => {
  it("a quote not in the message, or an unknown facet → that field unsure; the card stays; nothing enters the ledger", async () => {
    const { guard } = fakeGuard(dir, () => intakeReply([thursdayJordanCard({ quote: "Jordan picks up Theo on Fridays", facet: "fridays" })]));
    const r = await intake(msg("Thursdays I pick up, backup Jordan."), { guard, store, extras, action_id: "a1" });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].unsure.sort()).toEqual(["facet", "quote"]);
    expect(r.candidates[0].same_seat).toEqual([]); // no valid seat yet
    expect(store.cards()).toHaveLength(16);
    expect(store.candidates("pending")).toHaveLength(1);
    const fixed = confirm(r.candidates[0].candidate_id, { card: { quote: "Thursdays I pick up, backup Jordan", facet: "thursday" } }, { store, extras, clock: DEMO_CLOCK });
    expect(fixed.ok).toBe(true);
  });

  it("a non-JSON reply twice → rule fallback, nothing silently accepted", async () => {
    const { guard, fake } = fakeGuard(dir, () => "Sure! Here is the card you asked for.");
    const r = await intake(msg("From now on Jordan picks up Theo on Thursdays."), { guard, store, extras, action_id: "a1" });
    expect(fake.calls).toHaveLength(2); // one retry
    expect(r.mode).toBe("rules");
    expect(r.note).toMatch(/could not be used/);
  });

  it("a decision by someone who may not decide becomes a mention, loudly", async () => {
    const { guard } = fakeGuard(dir, () => intakeReply([thursdayJordanCard({ quote: "Alex says Thursdays Jordan picks up", decided_by: "Alex" })]));
    const r = await intake(msg("Alex says Thursdays Jordan picks up."), { guard, store, extras, action_id: "a1" });
    expect(r.candidates[0].card.mode).toBe("mentions");
    expect(r.candidates[0].note).toMatch(/Alex may not decide pickup_backup/);
  });
});
