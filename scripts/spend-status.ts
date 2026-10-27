// Prints the spend ledger for reconciliation against the Nebius Token Factory Usage page.
//
//   npx tsx scripts/spend-status.ts          totals in all and by America/Chicago day, last 10 entries
//   npx tsx scripts/spend-status.ts init     create the ledger (only when nothing has been spent yet)
//
// Reads only SPEND_LEDGER_PATH (default state/spend-ledger.jsonl). No key, no model, no network.
import { DEFAULT_LEDGER_PATH, SpendLedger, chicagoIso } from "../src/spend/ledger.ts";
import type { LedgerEntry } from "../src/spend/ledger.ts";

const path = process.env.SPEND_LEDGER_PATH || DEFAULT_LEDGER_PATH;
const command = process.argv[2];

const usd = (n: number) => `$${n.toFixed(6)}`;

function describe(e: LedgerEntry): string {
  switch (e.kind) {
    case "opened":
      return `opened   ${e.note}`;
    case "reserve":
      return `reserve  ${e.call_id}  ${usd(e.usd)}  worst case · ${e.model} · ${e.call_kind} · session ${e.session_id} · action ${e.action_id} · attempt ${e.attempt}`;
    case "settle":
      return `settle   ${e.call_id}  ${usd(e.usd)}  → actual ${usd(e.actual_usd)} (${e.booked}, ${e.outcome})${e.usage ? ` · ${e.usage.input_tokens} in / ${e.usage.output_tokens} out` : ""}`;
    case "refuse":
      return `refuse   ${e.limit}  ${e.reason}`;
    case "breaker":
      return `breaker  ${usd(e.spent_usd)}  ${e.reason}`;
  }
}

if (command === "init") {
  try {
    SpendLedger.create(path, Date.now, "created by scripts/spend-status.ts init");
    console.log(`created ${path}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (command === undefined) {
  let ledger: SpendLedger;
  try {
    ledger = SpendLedger.open(path);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const t = ledger.totals();
  console.log(`Ledger:  ${path}`);
  console.log(`Opened:  ${ledger.openedAt ?? "(no opened line)"}`);
  console.log(`Now:     ${chicagoIso(Date.now())}`);
  console.log(`Total:   ${usd(t.all)}  (calls: ${t.calls}, refusals: ${t.refusals}, lines: ${ledger.size})`);
  console.log("");
  console.log("By day (America/Chicago; the Nebius Usage page may bucket by UTC — compare sums over the same instants):");
  for (const day of Object.keys(t.byDay).sort()) console.log(`  ${day}  ${usd(t.byDay[day])}`);
  if (Object.keys(t.byDay).length === 0) console.log("  (no calls yet)");
  console.log("");
  console.log("Last 10 entries:");
  for (const e of ledger.last(10)) console.log(`  ${e.at}  ${describe(e)}`);
} else {
  console.error(`unknown command ${command}; use no argument (status) or init`);
  process.exit(2);
}
