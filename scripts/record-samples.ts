// AUTHOR ONLY. Records the model's replies for the three demo routes into cache/samples/, so the screen can
// show them when the wall is closed (SAMPLE mode). This script makes REAL model calls through the spend
// wall and therefore costs money: run it only inside your approval window, in your own terminal:
//
//   RECORD_SAMPLES=yes npx tsx scripts/record-samples.ts
//
// It refuses to run without RECORD_SAMPLES=yes, with the wall off, or without NEBIUS_MODEL. The exact
// sentences are the ones in docs/screen.md "The three demo routes"; the video must use the same words.
import { join } from "node:path";
import { FileCache } from "../src/llm/cache.ts";
import { SpendGuard } from "../src/spend/guard.ts";
import { Api } from "../src/ui/api.ts";
import { LayeredCache, SandboxManager } from "../src/ui/sessions.ts";

export const DEMO_ROUTES = {
  a_thursday: "Change of plan: Thursdays I pick up, backup Jordan — Alex is travelling Thursdays now.",
  // Route (b) plans the Saturday conflict (no sentence: it must be refused and show both notes).
  // Route (c) plans the two Monday focus blocks (no sentence: the contrast view).
} as const;

const root = join(import.meta.dirname, "..");

async function main() {
  if (process.env.RECORD_SAMPLES !== "yes") throw new Error("refusing: set RECORD_SAMPLES=yes to record (this spends money)");
  const guard = SpendGuard.fromEnv(process.env, { log: (l) => console.error(l) });
  const wall = guard.state();
  if (!wall.enabled) throw new Error(`refusing: the wall is off (${wall.reason})`);
  // Every reply used or produced is teed into cache/samples/.
  const cache = new LayeredCache(new FileCache(join(root, "cache", "samples"), { readOnly: true }), new FileCache(join(root, "cache", "live"), { tee: join(root, "cache", "samples") }));
  const sandboxes = new SandboxManager({ root, guard, cache });
  const api = new Api(sandboxes);
  const sb = sandboxes.reset("record-samples", "ciki");
  const action = () => `record-${Date.now()}`;

  // (a) T1: the Thursday sentence → card → confirm REPLACES → re-plan 11/5 (explanation recorded).
  const a = await api.chat(sb, DEMO_ROUTES.a_thursday, action());
  console.log(`(a) intake ${a.mode}: ${a.candidates.length} candidate(s)`, a.candidates.map((c) => ({ unsure: c.unsure, relations: c.relations })));
  const cand = a.candidates[0];
  if (cand && !cand.unsure.length) {
    const edits = cand.card.effective ? {} : { card: { effective: "2026-10-03" } };
    api.confirm(sb, cand.candidate_id, { ...edits, card_id: `rec.${cand.candidate_id.slice(0, 8)}` }, action());
  }
  const conflicts = await api.conflicts(sb);
  const thu = conflicts.find((c) => c.at.startsWith("2026-11-05"));
  if (thu) console.log("(a) plan", (await api.plan(sb, thu.conflict_id, action())).explanation);
  // (b) T3: the Saturday conflict → refused → "which one counts?"
  const sat = (await api.conflicts(sb, { all: true })).find((c) => c.at.startsWith("2026-10-31"));
  if (sat) console.log("(b) plan", (await api.plan(sb, sat.conflict_id, action(), { all: true })).explanation);
  // (c) T10: the two focus blocks.
  const c = await api.contrast(sb, action());
  console.log("(c) contrast", c.pairs.map((p) => `${p.plan.status}: ${p.explanation.mode}`));
  console.log("spend:", JSON.stringify(guard.status("record-samples")?.session));
  console.log("Recorded replies are in cache/samples/. Commit them.");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
