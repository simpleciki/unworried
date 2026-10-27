import { describe, expect, it } from "vitest";
import { chicagoOffsetAt, chicagoOffsetMinutes, compare, parseTime } from "./time.ts";

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

describe("the DST transition days (fixed 2026-10-26, task 003)", () => {
  it("2026-11-01 runs from 00:00 CDT to 00:00 CST next day: 25 hours", () => {
    const d = parseTime("2026-11-01")!;
    expect(new Date(d.start).toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(new Date(d.end + 1).toISOString()).toBe("2026-11-02T06:00:00.000Z");
    expect(d.end + 1 - d.start).toBe(25 * 3_600_000);
    for (const inside of ["2026-11-01T00:30:00-05:00", "2026-11-01T01:30:00-05:00", "2026-11-01T01:30:00-06:00", "2026-11-01T02:30:00-06:00", "2026-11-01T23:59:59-06:00"]) {
      expect(compare(inside, "2026-11-01")).toBe("overlap");
    }
    expect(compare("2026-10-31T23:59:59-05:00", "2026-11-01")).toBe("before");
    expect(compare("2026-11-02T00:00:00-06:00", "2026-11-01")).toBe("after");
  });
  it("2026-03-08 runs from 00:00 CST to 00:00 CDT next day: 23 hours", () => {
    const d = parseTime("2026-03-08")!;
    expect(new Date(d.start).toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(new Date(d.end + 1).toISOString()).toBe("2026-03-09T05:00:00.000Z");
    expect(d.end + 1 - d.start).toBe(23 * 3_600_000);
    expect(compare("2026-03-08T00:30:00-06:00", "2026-03-08")).toBe("overlap");
    expect(compare("2026-03-08T03:30:00-05:00", "2026-03-08")).toBe("overlap");
    expect(compare("2026-03-07T23:30:00-06:00", "2026-03-08")).toBe("before");
  });
  it("the offset comes from the instant", () => {
    expect(chicagoOffsetAt(Date.parse("2026-11-01T06:59:59Z"))).toBe(-300);
    expect(chicagoOffsetAt(Date.parse("2026-11-01T07:00:00Z"))).toBe(-360);
    expect(chicagoOffsetAt(Date.parse("2026-03-08T07:59:59Z"))).toBe(-360);
    expect(chicagoOffsetAt(Date.parse("2026-03-08T08:00:00Z"))).toBe(-300);
  });
});
