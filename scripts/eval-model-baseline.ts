// AUTHOR ONLY. The core-claim eval with a real model as the baseline: the same 13 scenarios, the notes handed to
// NVIDIA Nemotron 3 Super on Nebius Token Factory as plain text, and the question "who should I ask?". REAL calls
// through the spend wall: run it only in your own terminal, against a separate eval ledger so the hosted ledger
// is not touched:
//
//   SPEND_LEDGER_PATH=state/eval-ledger.jsonl npx tsx scripts/spend-status.ts init     (once; it exists already)
//   EVAL_MODEL_BASELINE=yes LLM_ENABLED=true SPEND_LEDGER_PATH=state/eval-ledger.jsonl SPEND_TOTAL_USD=0.05 \
//     SPEND_RATE_GLOBAL=30 NEBIUS_MODEL=nvidia/nemotron-3-super-120b-a12b npx tsx scripts/eval-model-baseline.ts
//
// 13 calls, about $0.002 at the console prices. Results are written to state/eval-model-baseline-<variant>-<time>.jsonl.
// MODEL_BASELINE_NUDGE=no drops the sentence "ask me instead of guessing" (the reply format still offers ask_me).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS, same, score, show, unworried } from "../src/eval/core-claim.ts";
import { modelPrompt, readModelAnswer } from "../src/eval/model-baseline.ts";
import { SpendGuard } from "../src/spend/guard.ts";

async function main() {
  if (process.env.EVAL_MODEL_BASELINE !== "yes") throw new Error("refusing: set EVAL_MODEL_BASELINE=yes (this spends money)");
  if (!/eval/.test(process.env.SPEND_LEDGER_PATH ?? "")) throw new Error("refusing: point SPEND_LEDGER_PATH at a separate eval ledger (e.g. state/eval-ledger.jsonl)");
  const model = process.env.NEBIUS_MODEL ?? "";
  const nudge = process.env.MODEL_BASELINE_NUDGE !== "no";
  const variant = nudge ? "nudge" : "no-nudge";
  console.log(`variant: ${variant}`);
  const guard = SpendGuard.fromEnv(process.env, { log: (l) => console.error(l) });
  const wall = guard.state();
  if (!wall.enabled) throw new Error(`refusing: the wall is off (${wall.reason})`);

  const rows: Record<string, unknown>[] = [];
  let right = 0, wrongPerson = 0, actedWhenShouldRefuse = 0, refusedWhenShouldAct = 0, unreadable = 0;
  console.log(`| # | trap | expected | unworried | ${model} |`);
  console.log("|---|---|---|---|---|");
  for (const s of SCENARIOS) {
    const { system, user } = modelPrompt(s, { nudge });
    const r = await guard.call({ session_id: `baseline-${variant}-${s.id}`, action_id: `baseline-${variant}-${s.id}`, kind: "baseline", system, user, model });
    if (!r.ok) {
      console.log(`| ${s.id} | ${s.trap} | REFUSED BY THE WALL: ${"reason" in r ? r.reason : ""} |`);
      rows.push({ id: s.id, refused: true });
      continue;
    }
    const { answer, note } = readModelAnswer(r.text);
    const ok = answer !== null && same(answer, s.expected);
    if (ok) right++;
    else if (answer === null) unreadable++;
    else if ("refuse" in s.expected) actedWhenShouldRefuse++;
    else if ("refuse" in answer) refusedWhenShouldAct++;
    else wrongPerson++;
    const u = unworried(s);
    console.log(`| ${s.id} | ${s.trap} | ${show(s.expected)} | ${same(u, s.expected) ? "✓" : "✗"} ${show(u)} | ${ok ? "✓" : "✗"} ${answer ? show(answer) : "unreadable"}${note ? ` — “${note.replace(/\s+/g, " ").slice(0, 140)}”` : ""} |`);
    rows.push({ id: s.id, trap: s.trap, expected: s.expected, model, variant, answer, note, right: ok, user, raw: r.text, usage: r.usage });
  }
  const u = score("unworried", unworried);
  console.log("");
  console.log(`unworried: ${u.right}/${u.total} right`);
  console.log(`${model} with the notes as text: ${right}/${SCENARIOS.length} right · asked the wrong person ${wrongPerson} · acted where it should have asked ${actedWhenShouldRefuse} · asked where it could have acted ${refusedWhenShouldAct} · unreadable ${unreadable}`);
  const out = join(import.meta.dirname, "..", "state", `eval-model-baseline-${variant}-${Date.now()}.jsonl`);
  writeFileSync(out, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  console.log(`written: ${out}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
