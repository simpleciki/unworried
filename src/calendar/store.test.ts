// A14 (two sessions, reset) and the store's version checks and validation.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_CLOCK, SEED_PATH, seedEvents, store } from "../action/fixtures.test-helpers.ts";
import { JsonCalendarStore, bump, readSeed } from "./json-store.ts";
import { VersionMismatch } from "./port.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unworried-cal-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("A14 — sessions are isolated; reset returns to the seed", () => {
  it("writes in one session are invisible in the other", async () => {
    const s1 = store(dir, "judge-1");
    const s2 = store(dir, "judge-2");
    const id = seedEvents()[0].event_id;
    const before = (await s1.get(id))!;
    const moved = await s1.update(id, { start: "2026-10-26T08:00:00-05:00", end: "2026-10-26T08:30:00-05:00" }, before.version);
    expect(moved.version).toBe("v2");
    expect((await s1.get(id))?.start).toBe("2026-10-26T08:00:00-05:00");
    expect(await s2.get(id)).toEqual(before);
    // reset: back to the seed, exactly
    s1.reset();
    expect(await s1.all()).toEqual(seedEvents());
    expect(await s1.all()).toEqual(await s2.all());
  });

  it("a session survives reopening (the file is the state)", async () => {
    const id = seedEvents()[0].event_id;
    const a = store(dir, "s");
    await a.update(id, { title: "renamed" }, "v1");
    const b = store(dir, "s");
    expect((await b.get(id))?.title).toBe("renamed");
    expect((await b.get(id))?.version).toBe("v2");
  });
});

describe("optimistic versions", () => {
  it("update with a stale version throws VersionMismatch and writes nothing", async () => {
    const s = store(dir, "s");
    const id = seedEvents()[0].event_id;
    await s.update(id, { title: "one" }, "v1");
    await expect(s.update(id, { title: "two" }, "v1")).rejects.toBeInstanceOf(VersionMismatch);
    expect((await s.get(id))?.title).toBe("one");
    await expect(s.update("nope", { title: "x" }, "v1")).rejects.toThrow(/not found/);
    await expect(s.update(id, { start: "2026-10-26T09:00" }, "v2")).rejects.toThrow(/not an ISO 8601 datetime with an offset/);
    await expect(s.update(id, { start: "2026-10-26T09:00:00-05:00", end: "2026-10-26T08:00:00-05:00" }, "v2")).rejects.toThrow(/ends before it starts/);
    expect(bump("v9")).toBe("v10");
    expect(bump("abc")).toBe("abc.1");
  });

  it("list filters by instant overlap and sorts by start", async () => {
    const s = store(dir, "s");
    const day = await s.list({ start: "2026-11-03T00:00:00-06:00", end: "2026-11-04T00:00:00-06:00" });
    expect(day.map((e) => e.title)).toEqual(["Theo — school drop-off", "Pebblemail — launch metrics check", "Flight to Denver — Pebblemail customer visit", "Theo — robotics club pickup"]);
    await expect(s.list({ start: "2026-11-04T00:00:00-06:00", end: "2026-11-03T00:00:00-06:00" })).rejects.toThrow(/range.end must be after/);
  });
});

describe("validation is loud", () => {
  it("the seed is valid, has 45 fictional events and no duplicate ids", () => {
    const events = readSeed(SEED_PATH);
    expect(events).toHaveLength(45);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(45);
    expect(events.every((e) => /([+-]\d{2}:\d{2})$/.test(e.start) && /([+-]\d{2}:\d{2})$/.test(e.end))).toBe(true);
    expect(events.every((e) => e.owner === "me")).toBe(true);
  });

  it("a seed with a timestamp without offset is refused; so is a bad session id", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ events: [{ event_id: "x", version: "v1", title: "t", start: "2026-11-03T09:00:00", end: "2026-11-03T10:00:00-06:00", owner: "me", attendees: [], category: "personal" }] }));
    expect(() => new JsonCalendarStore({ dir, session: "s", seedPath: bad, now: () => DEMO_CLOCK })).toThrow(/not an ISO 8601 datetime with an offset/);
    expect(() => new JsonCalendarStore({ dir, session: "../escape", seedPath: SEED_PATH })).toThrow(/session id/);
    expect(() => new JsonCalendarStore({ dir, session: "s", seedPath: join(dir, "missing.json") })).toThrow(/cannot read/);
  });
});
