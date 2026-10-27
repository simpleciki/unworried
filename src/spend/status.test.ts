// S9 — scripts/spend-status.ts prints totals by day and in all, and the last 10 entries, from the ledger.
// The script runs in a child process through tsx, exactly as the author runs it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpendLedger } from "./ledger.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "spend-status.ts");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unworried-status-"));
  path = join(dir, "ledger.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Only the ledger path goes to the child; no key, no model, no network.
const run = (args: string[]) => execFileSync(process.execPath, [TSX, SCRIPT, ...args], { env: { PATH: process.env.PATH, SPEND_LEDGER_PATH: path }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("S9 — spend-status", () => {
  it("prints totals in all, by day, and the last 10 entries", () => {
    let clock = Date.parse("2026-10-31T21:30:00-05:00");
    const ledger = SpendLedger.create(path, () => clock);
    for (let i = 1; i <= 6; i++) {
      clock += 60 * 60_000; // one call an hour: 22:30, 23:30 on 10-31, then 00:30, 01:30 CDT, 01:30 CST, 02:30 on 11-01
      ledger.reserve({ call_id: `call-${i}`, session_id: "s", action_id: "a", call_kind: "k", model: "m", usd: 0.002, input_tokens_bound: 1, max_tokens: 1, attempt: 1 });
      ledger.settle(`call-${i}`, { actualUsd: 0.001, booked: "usage", outcome: "ok", usage: { input_tokens: 1, output_tokens: 1 } });
    }
    // 1 opened + 12 call lines → the last 10 are call-2 (reserve + settle) through call-6.
    const out = run([]);
    expect(out).toMatch(/Total:\s+\$0\.006000/);
    expect(out).toMatch(/2026-10-31\s+\$0\.002000/);
    expect(out).toMatch(/2026-11-01\s+\$0\.004000/);
    expect(out).toMatch(/Last 10 entries/);
    expect(out).not.toMatch(/opened/);
    expect(out).not.toMatch(/reserve\s+call-1\b/);
    expect(out).not.toMatch(/settle\s+call-1\b/);
    expect(out).toMatch(/reserve\s+call-2\b/);
    expect(out).toMatch(/settle\s+call-2\b/);
    expect(out).toMatch(/settle\s+call-6\b/);
    expect(out).toMatch(/calls: 6/);
  });

  it("fails loudly when the ledger is missing, and `init` creates it exactly once", () => {
    expect(() => run([])).toThrow(/file is missing/);
    expect(existsSync(path)).toBe(false);
    expect(run(["init"])).toMatch(/created/);
    expect(existsSync(path)).toBe(true);
    expect(() => run(["init"])).toThrow(/already exists/);
    expect(run([])).toMatch(/Total:\s+\$0\.000000/);
  });
});
