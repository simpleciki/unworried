import { describe, expect, it } from "vitest";
import { MemoryCache } from "./cache.ts";
import { BudgetExhausted, CallBudget, ModelClient } from "./client.ts";
import type { CallEvent } from "./client.ts";
import { FakeProvider } from "./fake.ts";
import { obj, str } from "./json.ts";

const spec = { stage: "test", agent: "A", model: "meterless/auto", system: "sys", user: "say hi" };
const parseHi = (v: unknown) => str(obj(v, "reply").hi, "hi");

describe("ModelClient", () => {
  it("retries once on invalid JSON and counts it as a retry", async () => {
    const fake = new FakeProvider((_r, n) => (n === 1 ? "not json at all" : '```json\n{"hi": "there"}\n```'));
    const events: CallEvent[] = [];
    const client = new ModelClient(fake, new MemoryCache(), new CallBudget(5), (e) => events.push(e));
    const r = await client.json(spec, parseHi, 1);
    expect(r.value).toBe("there");
    expect(r.retries).toBe(1);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].user).toMatch(/could not be used/);
    expect(events.some((e) => e.outcome === "invalid")).toBe(true);
    expect(events.at(-1)!.model_answered).toBe("fake/model");
  });

  it("gives up after the retry budget and returns null with the error", async () => {
    const fake = new FakeProvider(() => '{"nope": 1}');
    const client = new ModelClient(fake, new MemoryCache(), new CallBudget(5));
    const r = await client.json(spec, parseHi, 2);
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/hi must be a string/);
    expect(fake.calls).toHaveLength(3);
  });

  it("stops at the call budget", async () => {
    const fake = new FakeProvider(() => '{"hi": "x"}');
    const client = new ModelClient(fake, new MemoryCache(), new CallBudget(2));
    await client.json({ ...spec, user: "a" }, parseHi, 0);
    await client.json({ ...spec, user: "b" }, parseHi, 0);
    await expect(client.json({ ...spec, user: "c" }, parseHi, 0)).rejects.toBeInstanceOf(BudgetExhausted);
    expect(fake.calls).toHaveLength(2);
  });

  it("serves a repeated call from the cache without spending budget", async () => {
    const fake = new FakeProvider(() => '{"hi": "cached"}');
    const cache = new MemoryCache();
    const events: CallEvent[] = [];
    const client = new ModelClient(fake, cache, new CallBudget(1), (e) => events.push(e));
    await client.json(spec, parseHi, 0);
    const again = await client.json(spec, parseHi, 0); // budget is already used up
    expect(again.value).toBe("cached");
    expect(fake.calls).toHaveLength(1);
    expect(events.map((e) => e.cache)).toEqual(["miss", "hit"]);
  });

  it("without a provider, a cache miss fails with 'needs model credentials'", async () => {
    const client = new ModelClient(null, new MemoryCache(), new CallBudget(1));
    await expect(client.text(spec)).rejects.toThrow(/needs model credentials/);
  });

  it("never puts prompt text into events", async () => {
    const events: CallEvent[] = [];
    const client = new ModelClient(new FakeProvider(() => '{"hi":"x"}'), new MemoryCache(), new CallBudget(1), (e) => events.push(e));
    await client.json({ ...spec, user: "SECRET-PROMPT-TEXT" }, parseHi, 0);
    expect(JSON.stringify(events)).not.toContain("SECRET-PROMPT-TEXT");
  });
});
