// AUTHOR ONLY. Why does the model sometimes find no arrangement in a sentence that plainly states one?
// Sends the same twelve sentences, with the real intake prompt, to each model under test and prints the
// RAW reply next to what the code makes of it. REAL calls through the spend wall: run it only in your own
// terminal, against a separate eval ledger so the hosted ledger is not touched:
//
//   SPEND_LEDGER_PATH=state/eval-ledger.jsonl npx tsx scripts/spend-status.ts init
//   EVAL_INTAKE=yes LLM_ENABLED=true SPEND_LEDGER_PATH=state/eval-ledger.jsonl SPEND_TOTAL_USD=0.05 \
//     SPEND_RATE_GLOBAL=30 NEBIUS_MODEL=nvidia/Nemotron-3_5-Lightning npx tsx scripts/eval-intake.ts
//
// 12 sentences × 2 models = 24 calls, about $0.008 at the console prices. Results are also written to
// state/eval-intake-<time>.jsonl (state/ is not committed).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadVocab } from "../src/engine/vocab.ts";
import { extractJson } from "../src/llm/json.ts";
import { checkCandidate, parseIntakeReply } from "../src/chat/intake.ts";
import { intakePrompt, loadVocabExtras } from "../src/chat/prompts.ts";
import { SpendGuard } from "../src/spend/guard.ts";

const MODELS = ["nvidia/Nemotron-3_5-Lightning", "nvidia/nemotron-3-super-120b-a12b"];
const SENT_AT = "2026-11-03T09:08:00-06:00"; // the demo clock, a Tuesday
// expect: "card" = one decision should come back; "none" = no decision (a question, small talk) — a
// question may come back as a `mentions` card, which also counts as right.
const SENTENCES: { text: string; expect: "card" | "none" }[] = [
  { text: "From next week Jordan picks up Theo on Wednesdays.", expect: "card" }, // missed on the hosted site, 2026-10-27 21:48
  { text: "From next week Jordan also picks up Theo on Wednesdays.", expect: "card" }, // found on the hosted site, 20:50
  { text: "From tomorrow Alex is the backup for Friday pickups.", expect: "card" },
  { text: "Thursdays I pick up, backup Jordan.", expect: "card" },
  { text: "Change of plan: Thursdays I pick up, backup Jordan — Alex is travelling Thursdays now.", expect: "card" },
  { text: "Jordan will cover Theo's Monday pickup from now on.", expect: "card" },
  { text: "Starting November 9th, Alex picks up Theo on Tuesdays.", expect: "card" },
  { text: "Meetings come before my own focus blocks from now on.", expect: "card" },
  { text: "From next week focus blocks may be moved again.", expect: "card" },
  { text: "Which Saturday note counts?", expect: "none" },
  { text: "Should we ask Jordan to cover Fridays?", expect: "none" },
  { text: "The Pebblemail launch went fine, thanks.", expect: "none" },
];

async function main() {
  if (process.env.EVAL_INTAKE !== "yes") throw new Error("refusing: set EVAL_INTAKE=yes (this spends money)");
  if (!/eval/.test(process.env.SPEND_LEDGER_PATH ?? "")) throw new Error("refusing: point SPEND_LEDGER_PATH at a separate eval ledger (e.g. state/eval-ledger.jsonl)");
  const root = join(import.meta.dirname, "..");
  const vocab = loadVocab(root);
  const extras = loadVocabExtras(root);
  const guard = SpendGuard.fromEnv(process.env, { log: (l) => console.error(l) });
  const wall = guard.state();
  if (!wall.enabled) throw new Error(`refusing: the wall is off (${wall.reason})`);

  const rows: Record<string, unknown>[] = [];
  const score: Record<string, number> = Object.fromEntries(MODELS.map((m) => [m, 0]));
  for (const [i, s] of SENTENCES.entries()) {
    console.log(`\n#${i + 1} ${s.text}   (expect ${s.expect})`);
    const { system, user } = intakePrompt({ text: s.text, sent_at: SENT_AT, vocab, extras });
    for (const model of MODELS) {
      const r = await guard.call({ session_id: `eval-${i}-${model.slice(7, 12)}`, action_id: `eval-${i}`, kind: "intake", system, user, model });
      const short = model.includes("super") ? "super    " : "lightning";
      if (!r.ok) {
        console.log(`  ${short}  REFUSED ${"reason" in r ? r.reason : ""}`);
        rows.push({ i: i + 1, model, refused: true });
        continue;
      }
      let cards: ReturnType<typeof parseIntakeReply>["cards"] = [];
      let parseError = "";
      try {
        cards = parseIntakeReply(extractJson(r.text)).cards;
      } catch (e) {
        parseError = (e as Error).message;
      }
      const decides = cards.filter((c) => c.mode === "decides");
      const right = s.expect === "card" ? decides.length > 0 : decides.length === 0;
      if (right) score[model]++;
      const first = cards[0];
      const checked = first ? checkCandidate({ ...first, source_recorded_at: SENT_AT }, first.value, s.text, vocab, extras) : null;
      console.log(`  ${short}  ${right ? "ok  " : "MISS"}  cards=${cards.length}${parseError ? ` parse-error: ${parseError}` : ""}${first ? `  ${first.mode} ${first.topic}|${first.facet}|${first.scope} value=${first.value} effective=${first.effective} unsure=[${checked?.unsure.join(",")}]` : ""}  (${r.usage?.output_tokens ?? "?"} out)`);
      console.log(`             raw: ${r.text.replace(/\s+/g, " ").slice(0, 400)}`);
      rows.push({ i: i + 1, text: s.text, expect: s.expect, model, right, cards, parseError, raw: r.text, usage: r.usage, unsure: checked?.unsure, notes: checked?.notes });
    }
  }
  console.log(`\nscore (right / ${SENTENCES.length}): ${MODELS.map((m) => `${m.slice(7)} ${score[m]}`).join(" · ")}`);
  console.log("spend:", JSON.stringify(MODELS.map((m) => guard.status(`eval-0-${m.slice(7, 12)}`)?.session?.committed_usd)));
  const out = join(root, "state", `eval-intake-${Date.now()}.jsonl`);
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`written: ${out}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
