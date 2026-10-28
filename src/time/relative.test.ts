import { describe, expect, it } from "vitest";
import { resolveRelativeStart } from "./relative.ts";

const TUE = "2026-11-03T09:04:35-06:00"; // the demo clock, a Tuesday (CST)

describe("resolveRelativeStart — the code, not the model, says which day", () => {
  it('"from next week" said on Tue 11/3 is Mon 11/9 (the 2026-10-27 bug: the model said 11/10)', () => {
    expect(resolveRelativeStart("From next week Jordan also picks up Theo on Wednesdays.", TUE)).toMatchObject({ kind: "date", effective: "2026-11-09T00:00:00-06:00" });
  });
  it("next week from a Monday or a Sunday is the following Monday", () => {
    expect(resolveRelativeStart("next week", "2026-11-02T10:00:00-06:00")).toMatchObject({ effective: "2026-11-09T00:00:00-06:00" });
    expect(resolveRelativeStart("next week", "2026-11-08T10:00:00-06:00")).toMatchObject({ effective: "2026-11-09T00:00:00-06:00" });
  });
  it("tomorrow and today are Chicago days, across the DST change", () => {
    expect(resolveRelativeStart("From tomorrow Alex picks up.", "2026-10-31T22:00:00-05:00")).toMatchObject({ effective: "2026-11-01T00:00:00-05:00" });
    expect(resolveRelativeStart("starting today", TUE)).toMatchObject({ effective: "2026-11-03T00:00:00-06:00" });
    expect(resolveRelativeStart("From now on Jordan does Tuesdays.", TUE)).toMatchObject({ effective: TUE });
  });
  it('"next Thursday" is ambiguous: both readings are offered, nothing is picked', () => {
    expect(resolveRelativeStart("From next Thursday Jordan picks up Theo.", TUE)).toEqual({ kind: "ambiguous", phrase: "from next thursday", readings: ["Thu 2026-11-05", "Thu 2026-11-12"] });
  });
  it('"from Thursday" is the coming Thursday; "on Wednesdays" (plural) is a repeat, not a start', () => {
    expect(resolveRelativeStart("Starting Thursday Jordan covers.", TUE)).toMatchObject({ effective: "2026-11-05T00:00:00-06:00" });
    expect(resolveRelativeStart("Jordan picks up on Wednesdays.", TUE)).toBeNull();
    expect(resolveRelativeStart("Thursdays I pick up, backup Jordan.", TUE)).toBeNull();
  });
  it("a named date: this year, or next year when it is long past", () => {
    expect(resolveRelativeStart("From November 2nd, focus blocks may not be moved.", "2026-10-20T08:05:00-05:00")).toMatchObject({ effective: "2026-11-02T00:00:00-06:00" });
    expect(resolveRelativeStart("from January 4th", TUE)).toMatchObject({ effective: "2027-01-04T00:00:00-06:00" });
    expect(resolveRelativeStart("from February 30th", TUE)).toBeNull();
  });
  it("next month", () => {
    expect(resolveRelativeStart("From next month Riley drives.", TUE)).toMatchObject({ effective: "2026-12-01T00:00:00-06:00" });
  });
});
