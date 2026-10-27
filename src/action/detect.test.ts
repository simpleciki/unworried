// A1 (overlap / touch) and A2 (judged by instants across the end of DST).
import { describe, expect, it } from "vitest";
import type { CalEvent } from "../calendar/port.ts";
import { conflictId, detectConflicts } from "./detect.ts";

const ev = (id: string, start: string, end: string, over: Partial<CalEvent> = {}): CalEvent => ({ event_id: id, version: "v1", title: id, start, end, owner: "me", attendees: [], category: "personal", ...over });

describe("A1 — overlap and touch", () => {
  it("two overlapping events conflict; two touching events do not", () => {
    const a = ev("a", "2026-11-03T09:00:00-06:00", "2026-11-03T10:00:00-06:00");
    const b = ev("b", "2026-11-03T09:30:00-06:00", "2026-11-03T10:30:00-06:00");
    const c = ev("c", "2026-11-03T10:00:00-06:00", "2026-11-03T11:00:00-06:00"); // starts when a ends
    const found = detectConflicts([a, b, c]);
    expect(found.map((x) => [x.a.event_id, x.b.event_id])).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(found[0].overlap).toEqual({ start: "2026-11-03T09:30:00-06:00", end: "2026-11-03T10:00:00-06:00" });
    expect(detectConflicts([a, c])).toEqual([]);
  });

  it("buffers widen the occupied interval, so touching events with a buffer do conflict", () => {
    const a = ev("a", "2026-11-03T09:00:00-06:00", "2026-11-03T10:00:00-06:00", { buffer_after_min: 10 });
    const c = ev("c", "2026-11-03T10:00:00-06:00", "2026-11-03T11:00:00-06:00");
    expect(detectConflicts([a, c])).toHaveLength(1);
    expect(detectConflicts([a, c])[0].overlap).toEqual({ start: "2026-11-03T10:00:00-06:00", end: "2026-11-03T10:10:00-06:00" });
  });

  it("all-day events conflict only with all-day events (v1)", () => {
    const day = ev("day", "2026-11-03T00:00:00-06:00", "2026-11-04T00:00:00-06:00", { all_day: true });
    const day2 = ev("day2", "2026-11-03T00:00:00-06:00", "2026-11-04T00:00:00-06:00", { all_day: true });
    const timed = ev("t", "2026-11-03T09:00:00-06:00", "2026-11-03T10:00:00-06:00");
    expect(detectConflicts([day, timed])).toEqual([]);
    expect(detectConflicts([day, day2])).toHaveLength(1);
  });

  it("the same conflict found twice has the same id, whatever the order; a new version changes it", () => {
    const a = ev("a", "2026-11-03T09:00:00-06:00", "2026-11-03T10:00:00-06:00");
    const b = ev("b", "2026-11-03T09:30:00-06:00", "2026-11-03T10:30:00-06:00");
    expect(conflictId(a, b)).toBe(conflictId(b, a));
    expect(detectConflicts([b, a])[0].conflict_id).toBe(conflictId(a, b));
    expect(conflictId({ ...a, version: "v2" }, b)).not.toBe(conflictId(a, b));
  });
});

describe("A2 — across 2026-11-01 02:00 CDT, judged by instants", () => {
  it("wall-clock overlap but no instant overlap → no conflict", () => {
    // A: 01:30–01:50 CDT = 06:30–06:50Z. B: 01:15–01:40 CST = 07:15–07:40Z. The strings overlap; the instants do not.
    const a = ev("a", "2026-11-01T01:30:00-05:00", "2026-11-01T01:50:00-05:00");
    const b = ev("b", "2026-11-01T01:15:00-06:00", "2026-11-01T01:40:00-06:00");
    expect(Date.parse(b.start) - Date.parse(a.end)).toBe(25 * 60_000); // B starts 25 minutes after A ends
    expect(detectConflicts([a, b])).toEqual([]);
  });

  it("wall-clock disjoint but instant overlap → conflict", () => {
    // X: 01:30–01:59 CDT = 06:30–06:59Z. Y written as 00:55–01:05 with the CST offset = 06:55–07:05Z.
    // Read as strings Y ends before X starts; as instants they share four minutes.
    const x = ev("x", "2026-11-01T01:30:00-05:00", "2026-11-01T01:59:00-05:00");
    const y = ev("y", "2026-11-01T00:55:00-06:00", "2026-11-01T01:05:00-06:00");
    expect(y.end < x.start).toBe(true); // string comparison says "disjoint"
    const found = detectConflicts([x, y]);
    expect(found).toHaveLength(1);
    expect(Date.parse(found[0].overlap.start)).toBe(Date.parse("2026-11-01T06:55:00Z"));
    expect(Date.parse(found[0].overlap.end)).toBe(Date.parse("2026-11-01T06:59:00Z"));
    expect(found[0].overlap.start).toBe("2026-11-01T01:55:00-05:00"); // rendered with the offset in force at that instant
  });

  it("the seed itself has events on both sides of the change", async () => {
    const { seedEvents } = await import("./fixtures.test-helpers.ts");
    const events = seedEvents();
    expect(events.filter((e) => e.start.startsWith("2026-10-31") && e.start.endsWith("-05:00")).length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e.start.startsWith("2026-11-01") && e.start.endsWith("-06:00")).length).toBeGreaterThanOrEqual(2);
  });
});
