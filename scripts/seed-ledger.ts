// Builds state/ledger/<session>/ from data/conversation-seed.jsonl, deterministically and without a model.
//
//   npx tsx scripts/seed-ledger.ts [session]      default session: "demo"
//   LEDGER_DIR=…  SEED_PATH=…                     override the locations
//
// An existing session directory is reset to the seed (the sandbox calendar works the same way).
import { join } from "node:path";
import { loadVocab } from "../src/engine/vocab.ts";
import { LedgerStore, loadConversationSeed } from "../src/ledger/store.ts";

const root = join(import.meta.dirname, "..");
const session = process.argv[2] ?? "demo";
const dir = process.env.LEDGER_DIR ?? join(root, "state", "ledger");
const seedPath = process.env.SEED_PATH ?? join(root, "data", "conversation-seed.jsonl");

try {
  const { messages, ledger } = loadConversationSeed(seedPath);
  const store = new LedgerStore({ dir, session, vocab: loadVocab(root), seed: ledger });
  store.reset();
  const seats = store.graph().seatTable();
  console.log(`seeded ${store.dir}`);
  console.log(`  messages: ${messages.length}  cards: ${store.cards().length}  edges: ${store.edges().length}  values: ${store.values().size}`);
  console.log(`  seats: ${Object.keys(seats.seats).length}`);
  for (const [key, r] of Object.entries(seats.seats)) console.log(`    ${key}  ${r.state}  current=${r.current_card ?? "-"}${r.coexisting.length ? `  coexisting=${r.coexisting.join(",")}` : ""}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
