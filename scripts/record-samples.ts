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
  // Route (a) is the wow: plan 11/5 (Jordan covers), then this sentence, confirm it as REPLACING the 10/03
  // card, Plan again → Alex covers, the Jordan card struck through. The seed's own 10/03 sentence was the
  // old route (a); the model rightly called it SAME as the card already there.
  a_thursday: "From tomorrow Alex is the backup for Thursday pickups.",
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
  // How long a judge waits for each step (model calls, or cache hits when re-run).
  let t0 = Date.now();
  const took = () => { const s = ((Date.now() - t0) / 1000).toFixed(1); t0 = Date.now(); return `${s}s`; };
  console.log(`model: ${wall.model}`);

  // (a) the wow, in the order the screen is used: Plan 11/5 → the sentence → Confirm (REPLACES) → Plan again.
  const thuConflict = async () => (await api.conflicts(sb)).find((c) => c.at.startsWith("2026-11-05"));
  const before = await thuConflict();
  if (before) { t0 = Date.now(); const e = (await api.plan(sb, before.conflict_id, action())).explanation; console.log(`(a) plan before [${took()}]`, e); }
  t0 = Date.now();
  const a = await api.chat(sb, DEMO_ROUTES.a_thursday, action());
  console.log(`(a) intake ${a.mode} [${took()}]: ${a.candidates.length} candidate(s)`, a.candidates.map((c) => ({ card: c.card, value: c.value, unsure: c.unsure, same_seat: c.same_seat, relations: c.relations })));
  const cand = a.candidates[0];
  if (cand && !cand.unsure.length) {
    // The judge's word on each card already on the seat: REPLACES (the screen's radio), as in the recording.
    const relations = Object.fromEntries(cand.same_seat.map((id) => [id, "REPLACES" as const]));
    console.log("(a) confirm", api.confirm(sb, cand.candidate_id, { relations }, action()));
  } else console.log("(a) NOT confirmed — the card is unsure; fix the sentence or the prompt before recording again");
  const after = await thuConflict();
  if (after) { t0 = Date.now(); const e = (await api.plan(sb, after.conflict_id, action())).explanation; console.log(`(a) plan again [${took()}]`, e); }
  // (b) T3: the Saturday conflict → refused → "which one counts?"
  const sat = (await api.conflicts(sb, { all: true })).find((c) => c.at.startsWith("2026-10-31"));
  if (sat) { t0 = Date.now(); const e = (await api.plan(sb, sat.conflict_id, action(), { all: true })).explanation; console.log(`(b) plan [${took()}]`, e); }
  // The question a judge types in route (b): a mention, so no card and nothing changes.
  t0 = Date.now();
  const q = await api.chat(sb, "Which Saturday note counts?", action());
  console.log(`(b) question ${q.mode} [${took()}]: ${q.candidates.length} candidate(s)`);
  // (c) T10: the two focus blocks.
  t0 = Date.now();
  const c = await api.contrast(sb, action());
  console.log(`(c) contrast [${took()}]`, c.pairs.map((p) => `${p.plan.status}: ${p.explanation.mode}`));
  console.log("spend:", JSON.stringify(guard.status("record-samples")?.session));
  console.log("Recorded replies are in cache/samples/. Commit them.");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
