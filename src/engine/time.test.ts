import { describe, expect, it } from "vitest";
import { chicagoOffsetMinutes, compare, parseTime } from "./time.ts";

describe("compare", () => {
  it("3/4 is before 3/15", () => {
    expect(compare("2026-03-04", "2026-03-15")).toBe("before");
    expect(compare("2026-03-15", "2026-03-04")).toBe("after");
  });
  it("March overlaps 3/15", () => {
    expect(compare("2026-03", "2026-03-15")).toBe("overlap");
  });
  it("a week is before a later day", () => {
    expect(compare("2026-W10", "2026-03-15")).toBe("before"); // W10 = Mon 2 Mar .. Sun 8 Mar
  });
  it("unknown is incomparable", () => {
    expect(compare(null, "2026-03-15")).toBe("incomparable");
    expect(compare("sometime in spring", "2026-03-15")).toBe("incomparable");
  });
  it("orders instants by their offsets, not by the wall-clock text", () => {
    expect(compare("2026-04-14T09:20:00-05:00", "2026-04-14T09:30:00-04:00")).toBe("after");
  });
});

describe("parseTime", () => {
  it("refuses a datetime without an offset", () => {
    expect(parseTime("2026-04-14T09:20:00")).toBeNull();
  });
  it("reads date-only values as the Chicago local day", () => {
    const d = parseTime("2026-04-14")!;
    expect(new Date(d.start).toISOString()).toBe("2026-04-14T05:00:00.000Z");
    expect(new Date(d.end + 1).toISOString()).toBe("2026-04-15T05:00:00.000Z");
  });
  it("handles quarters and the daylight-time switch", () => {
    const q = parseTime("2026-Q2")!;
    expect(new Date(q.start).toISOString()).toBe("2026-04-01T05:00:00.000Z");
    expect(new Date(q.end + 1).toISOString()).toBe("2026-07-01T05:00:00.000Z");
    expect(chicagoOffsetMinutes(2026, 2, 7)).toBe(-360);
    expect(chicagoOffsetMinutes(2026, 2, 8)).toBe(-300);
  });
});
