// Holds the numbers the README and the video quote. If a change moves any of them, this goes red.
import { describe, expect, it } from "vitest";
import { SCENARIOS, first, latest, score, unworried } from "./core-claim.ts";

describe("core-claim eval — acts on the arrangement in force, refuses when it cannot tell", () => {
  it("unworried 13/13; a newest-note memory 6/13 (4 wrong person, 3 acted instead of asking); a never-updated memory 5/13", () => {
    expect(SCENARIOS).toHaveLength(13);
    expect(score("unworried", unworried)).toMatchObject({ right: 13, wrongPerson: 0, refusedWhenShouldAct: 0, actedWhenShouldRefuse: 0 });
    expect(score("latest", latest)).toMatchObject({ right: 6, wrongPerson: 4, refusedWhenShouldAct: 0, actedWhenShouldRefuse: 3 });
    expect(score("first", first)).toMatchObject({ right: 5, wrongPerson: 5, refusedWhenShouldAct: 0, actedWhenShouldRefuse: 3 });
  });

  it("4 of the 13 must be refused, and unworried refuses exactly those", () => {
    const mustRefuse = SCENARIOS.filter((s) => "refuse" in s.expected).map((s) => s.id);
    expect(mustRefuse).toEqual(["S08", "S09", "S10", "S11"]);
    expect(SCENARIOS.filter((s) => "refuse" in unworried(s)).map((s) => s.id)).toEqual(mustRefuse);
  });
});
