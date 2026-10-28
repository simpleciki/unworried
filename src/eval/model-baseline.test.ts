import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./core-claim.ts";
import { modelPrompt, readModelAnswer } from "./model-baseline.ts";

describe("model baseline — prompt and reply reading (no model is called)", () => {
  it("hands the model every note as text with when it was said, in order, and the pickup day", () => {
    const s = SCENARIOS.find((x) => x.id === "S12")!;
    const { user } = modelPrompt(s);
    expect(user).toContain("Today is Tuesday, November 3, 2026");
    expect(user).toContain('- [said 2026-09-08 19:40] "Tuesdays and Thursdays Alex picks up Theo if I can\'t."');
    expect(user.indexOf("2026-09-08")).toBeLessThan(user.indexOf("2026-10-03"));
    expect(user.indexOf("2026-10-03")).toBeLessThan(user.indexOf("2026-11-03 09:00"));
    expect(user).toContain("On Thursday, November 5, 2026");
    expect(user).toContain("ask me instead of guessing");
  });

  it("gives no ledger, no links and no labels — only what a person reading the notes would see", () => {
    const { user } = modelPrompt(SCENARIOS.find((x) => x.id === "S06")!);
    expect(user).not.toMatch(/replaces|mentions|proposes|decides|effective/i);
    expect(modelPrompt(SCENARIOS.find((x) => x.id === "S08")!).user).toContain("[said unknown — no date on this note]");
  });

  it("reads {ask} and {ask_me}; anything else is unreadable, never a refusal", () => {
    expect(readModelAnswer('{"ask": "Jordan"}').answer).toEqual({ ask: "Jordan" });
    expect(readModelAnswer('```json\n{"ask_me": "Which Saturday note counts?"}\n```')).toEqual({ answer: { refuse: true }, note: "Which Saturday note counts?" });
    expect(readModelAnswer("Jordan should cover it.").answer).toBeNull();
    expect(readModelAnswer('{"ask": "Jordan", "ask_me": "x"}').answer).toBeNull();
    expect(readModelAnswer('{"ask": "Jordan", "ask": "Alex"}').answer).toBeNull();
  });
});
