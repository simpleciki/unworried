import { describe, expect, it } from "vitest";
import { duplicateKey, extractJson } from "./json.ts";

// The reply the intake model gave on 2026-10-27 (eval #1): a correct card, then the same key again, empty.
const TWICE = `{
  "cards": [ { "quote": "From next week Jordan picks up Theo on Wednesdays.", "mode": "decides", "topic": "pickup_backup", "facet": "wednesday", "scope": "kids", "decided_by": "me", "effective": null, "decided_at": null, "value": "backup Jordan", "unsure": [] } ],
  "cards": []
}`;

describe("extractJson — a repeated key is an invalid reply, not a silent overwrite", () => {
  it("throws on the 2026-10-27 reply instead of returning { cards: [] }", () => {
    expect(() => extractJson(TWICE)).toThrow(/the key "cards" appears twice/);
  });
  it("finds a repeated key at any depth, and ignores keys inside strings", () => {
    expect(duplicateKey('{"a":1,"b":{"x":1,"x":2}}')).toBe("x");
    expect(duplicateKey('{"a":"{\\"a\\":1}","b":[{"a":1},{"a":2}]}')).toBeNull(); // same key in two different objects is fine
    expect(duplicateKey('{"q":"say \\"cards\\", \\"cards\\"","cards":[]}')).toBeNull();
  });
  it("a clean reply still parses", () => {
    expect(extractJson('{ "cards": [] }')).toEqual({ cards: [] });
  });
});
