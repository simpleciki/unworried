import { describe, expect, it } from "vitest";
import type { EngineEvent } from "./types.ts";
import { verifyCards } from "./verify.ts";
import { card, rec, vocab } from "./fixtures.test-helpers.ts";

describe("verifyCards", () => {
  it("accepts a quote that differs only by curly quotes and spacing", () => {
    const r = rec("Helen said: “only  me”, not the board.", "2026-03-06T16:40:00-06:00");
    const [c] = verifyCards([card("c", r, { quote: 'said: "only me"', topic: "client_rule", facets: ["client_rule.cap"] })], [r], vocab);
    expect(c.result).toBe("PASS");
  });

  it("rejects a quote that is not in the record, and unknown keys", () => {
    const r = rec("Approved as sent.", "2026-03-06T16:40:00-06:00");
    const [bad] = verifyCards([card("c", r, { quote: "Approved with changes." })], [r], vocab);
    expect(bad.result).toBe("REJECTED");
    const [badFacet] = verifyCards([card("d", r, { quote: "Approved as sent.", facets: ["price.nonsense"] })], [r], vocab);
    expect(badFacet.result).toBe("REJECTED");
    const [badScope] = verifyCards([card("e", r, { quote: "Approved as sent.", scope: "job:unknown" })], [r], vocab);
    expect(badScope.result).toBe("OUT_OF_SCOPE");
  });

  it("downgrades a decision by someone who is not a decider, with an event", () => {
    const r = rec("Labor is $120 now.", "2026-03-06T16:40:00-06:00", "p.office");
    const events: EngineEvent[] = [];
    const [c] = verifyCards([card("c", r, { decided_by: "p.office" })], [r], vocab, (e) => events.push(e));
    expect(c.result).toBe("PASS");
    expect(c.mode).toBe("mentions");
    expect(events[0].action).toBe("decider_downgrade");
  });
});
