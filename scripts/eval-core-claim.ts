// The core-claim eval as a table: `npx tsx scripts/eval-core-claim.ts`. No model, no key, no network, $0.
// Scenarios, expected answers and the two baselines are in src/eval/core-claim.ts.
import { SCENARIOS, first, latest, latestInForce, same, score, show, unworried } from "../src/eval/core-claim.ts";

const mark = (ok: boolean) => (ok ? "✓" : "✗");
console.log("| # | trap | expected | unworried | newest note in force | newest note | first note |");
console.log("|---|---|---|---|---|---|---|");
for (const s of SCENARIOS) {
  const u = unworried(s), d = latestInForce(s), l = latest(s), f = first(s);
  console.log(`| ${s.id} | ${s.trap} | ${show(s.expected)} | ${mark(same(u, s.expected))} ${show(u)} | ${mark(same(d, s.expected))} ${show(d)} | ${mark(same(l, s.expected))} ${show(l)} | ${mark(same(f, s.expected))} ${show(f)} |`);
}
console.log("");
for (const [name, f] of [["unworried", unworried], ["newest note in force", latestInForce], ["newest note", latest], ["first note", first]] as const) {
  const r = score(name, f);
  console.log(`${name}: ${r.right}/${r.total} right · asked the wrong person ${r.wrongPerson} · acted where it should have asked ${r.actedWhenShouldRefuse} · asked where it could have acted ${r.refusedWhenShouldAct}`);
}
