// D13 — the chat clock survives a restart: what is said after a restart is never stamped before what was
// said before it. (A hosting platform that sleeps and wakes restarts the server; the decision ledger orders
// decisions by these stamps.)
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "../action/fixtures.test-helpers.ts";
import { FakeProvider } from "../llm/fake.ts";
import { SpendGuard } from "../spend/guard.ts";
import { DEFAULT_LIMITS } from "../spend/limits.ts";
import { chicagoIso } from "../time/chicago.ts";
import { DEMO_CLOCK_ISO, SandboxManager, latestChatInstant } from "./sessions.ts";

const CLOCK = Date.parse(DEMO_CLOCK_ISO);

let root: string;
beforeEach(() => {
  root = join(tmpdir(), `unworried-sessions-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(root, { recursive: true });
  symlinkSync(join(ROOT, "data"), join(root, "data"), "dir");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// A guard that is never asked to call: no ledger file, so the wall is closed.
const guard = () => new SpendGuard({ ledgerPath: join(root, "absent-ledger.jsonl"), prices: {}, limits: DEFAULT_LIMITS, provider: new FakeProvider(() => "{}", ["fake/model"], "fake/model"), now: () => CLOCK });

describe("D13 — the chat clock does not run backwards across a restart", () => {
  it("a sentence after a restart is stamped after the last sentence before it; the demo clock is unchanged", () => {
    let wall = 1_000_000;
    const before = new SandboxManager({ root, guard: guard(), now: () => wall });
    const sb = before.get("sess-1", "judge1");
    wall += 10 * 60_000; // ten minutes of use
    const said = before.chatNow();
    sb.say({ message_id: "u-before", sent_at: chicagoIso(said), from: "me", text: "Jordan does the Tuesday pickup from now on." });

    // Restart: a new process, its own start time, the same state directory.
    wall += 5_000;
    const after = new SandboxManager({ root, guard: guard(), now: () => wall });
    expect(after.chatNow()).toBeGreaterThan(said);
    expect(after.clock).toBe(CLOCK);
  });

  it("with no state on disk the chat clock starts at the demo clock", () => {
    const m = new SandboxManager({ root, guard: guard(), now: () => 42 });
    expect(m.chatNow()).toBe(CLOCK);
    expect(latestChatInstant(join(root, "state", "sessions"))).toBe(-Infinity);
  });

  it("an unreadable sent_at fails loudly instead of guessing a clock", () => {
    const m = new SandboxManager({ root, guard: guard(), now: () => 0 });
    m.get("sess-1", "judge1").say({ message_id: "u-bad", sent_at: "unknown", from: "me", text: "x" });
    expect(() => new SandboxManager({ root, guard: guard(), now: () => 0 })).toThrow(/no readable sent_at/);
  });
});
