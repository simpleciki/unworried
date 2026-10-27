// S8 — the single exit. Only src/spend/guard.ts may construct NebiusProvider or read the Token Factory
// API key from the environment. The provider's own test may construct it (that is what it tests); no
// other file, test or not. (The key's env name is not spelled out in this file: see KEY_NAME.)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const KEY_NAME = ["NEBIUS", "_API_KEY"].join(""); // spelled in two parts so this file is not its own hit
const CONSTRUCT = /new\s+NebiusProvider\s*\(/;

describe("S8 — single exit", () => {
  const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));

  it("only spend/guard.ts reads the API key", () => {
    const hits = files.filter((f) => f.text.includes(KEY_NAME)).map((f) => f.rel);
    expect(hits, `files mentioning the key: ${hits.join(", ")}`).toEqual(["spend/guard.ts"]);
  });

  it("only spend/guard.ts (and the provider's own test) constructs NebiusProvider", () => {
    const hits = files.filter((f) => CONSTRUCT.test(f.text)).map((f) => f.rel).sort();
    expect(hits, `files constructing the provider: ${hits.join(", ")}`).toEqual(["llm/nebius.test.ts", "spend/guard.ts"]);
  });

  // C13 — every model call goes through the guard: outside tests, ModelClient is constructed only in
  // src/chat/*, and every such file hands it guard.asProvider(...).
  it("only src/chat/*.ts constructs ModelClient, always over asProvider", () => {
    const nonTest = files.filter((f) => !f.rel.endsWith(".test.ts") && !f.rel.endsWith(".test-helpers.ts"));
    const constructing = nonTest.filter((f) => /new\s+ModelClient\s*\(/.test(f.text)).map((f) => f.rel).sort();
    expect(constructing, `files constructing ModelClient: ${constructing.join(", ")}`).toEqual(["chat/explain.ts", "chat/intake.ts", "chat/relate.ts"]);
    for (const rel of constructing) {
      const text = nonTest.find((f) => f.rel === rel)!.text;
      expect(text, `${rel} must wrap guard.asProvider(...)`).toMatch(/new\s+ModelClient\s*\(\s*provider/);
      expect(text, `${rel} must obtain its provider from asProvider`).toMatch(/const provider = deps\.guard\.asProvider\(/);
    }
    // And asProvider is defined in the guard and used nowhere else outside src/chat.
    const users = nonTest.filter((f) => /\.asProvider\(/.test(f.text)).map((f) => f.rel).sort();
    expect(users).toEqual(["chat/explain.ts", "chat/intake.ts", "chat/relate.ts"]);
  });

  it("the scan actually covers the files it should", () => {
    const rels = files.map((f) => f.rel);
    expect(rels).toContain("spend/guard.ts");
    expect(rels).toContain("llm/nebius.ts");
    expect(rels).toContain("llm/client.ts");
    expect(rels.length).toBeGreaterThan(20);
  });
});
