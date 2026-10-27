import { describe, expect, it } from "vitest";
import { parsePhrase } from "./timephrase.ts";

const rec = "2026-03-20T11:30:00-05:00";

describe("parsePhrase", () => {
  it("reads written dates with and without a year, with the Chicago offset for that day", () => {
    expect(parsePhrase("17 March 2026 at 09:20", rec)).toEqual({ iso: "2026-03-17T09:20:00-05:00", source: "phrase" });
    expect(parsePhrase("1 June", rec).iso).toBe("2026-06-01T00:00:00-05:00");
    expect(parsePhrase("March 5", rec).iso).toBe("2026-03-05T00:00:00-06:00"); // before daylight time
    expect(parsePhrase("the 22nd of April at 14:10", rec).iso).toBe("2026-04-22T14:10:00-05:00");
  });
  it("accepts ISO forms and adds a missing offset", () => {
    expect(parsePhrase("2026-06-01", rec).iso).toBe("2026-06-01T00:00:00-05:00");
    expect(parsePhrase("2026-04-22T14:10", rec).iso).toBe("2026-04-22T14:10:00-05:00");
    expect(parsePhrase("2026-04-22T14:10:00-05:00", rec).iso).toBe("2026-04-22T14:10:00-05:00");
  });
  it("falls back to the record time when there is no phrase or it cannot be placed", () => {
    expect(parsePhrase(null, rec)).toEqual({ iso: rec, source: "record_time" });
    expect(parsePhrase("record_time", rec).source).toBe("record_time");
    expect(parsePhrase("after the rain", rec).source).toBe("record_time");
    expect(parsePhrase("31 June", rec).source).toBe("record_time");
  });
});
