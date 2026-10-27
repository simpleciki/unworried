// Shared set-up for the conversation-layer tests: a spend guard over FakeProvider (no network), a ledger
// store seeded from data/conversation-seed.jsonl in a temp dir, and the vocab extras.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest } from "../llm/provider.ts";
import { FakeProvider } from "../llm/fake.ts";
import { SpendGuard } from "../spend/guard.ts";
import type { GuardOptions } from "../spend/guard.ts";
import { SpendLedger } from "../spend/ledger.ts";
import { DEFAULT_LIMITS } from "../spend/limits.ts";
import { LedgerStore, loadConversationSeed } from "../ledger/store.ts";
import type { SeedMessage } from "../ledger/store.ts";
import { DEMO_CLOCK, ROOT, vocab } from "../action/fixtures.test-helpers.ts";
import { loadVocabExtras } from "./prompts.ts";

export { DEMO_CLOCK, ROOT, vocab };
export const SEED_PATH = join(ROOT, "data", "conversation-seed.jsonl");
export const extras = loadVocabExtras(ROOT);
export const MODEL = "fake/model";

export const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `unworried-${prefix}-`));

// A guard whose provider answers from a script. `responder` sees the request (system/user) and the call
// number; return the JSON text the model would send.
export function fakeGuard(dir: string, responder: (req: ChatRequest, n: number) => string, over: Partial<GuardOptions> = {}): { guard: SpendGuard; fake: FakeProvider } {
  const ledgerPath = join(dir, "spend-ledger.jsonl");
  SpendLedger.create(ledgerPath, () => DEMO_CLOCK);
  const fake = new FakeProvider(responder, [MODEL], MODEL);
  const guard = new SpendGuard({
    ledgerPath,
    prices: { [MODEL]: { input_per_m: 1, output_per_m: 1 } },
    model: MODEL,
    limits: { ...DEFAULT_LIMITS, actionCalls: 1000, actionUsd: 1e6, sessionUsd: 1e6, dayUsd: 1e6, totalUsd: 1e6, rateGlobal: 1e6, rateSession: 1e6, hourUsd: 1e6 },
    now: () => DEMO_CLOCK,
    log: () => {},
    provider: fake,
    ...over,
  });
  return { guard, fake };
}

// The seeded ledger, optionally cut to the messages sent before `until` or with some messages removed.
export function seededStore(dir: string, session: string, opts: { until?: string; drop?: (m: SeedMessage) => boolean } = {}): LedgerStore {
  const { messages } = loadConversationSeed(SEED_PATH);
  let kept = messages;
  if (opts.until) kept = kept.filter((m) => Date.parse(m.sent_at) < Date.parse(opts.until!));
  if (opts.drop) kept = kept.filter((m) => !opts.drop!(m));
  const ledger = loadConversationSeed.fromMessages(kept);
  return new LedgerStore({ dir, session, vocab, seed: ledger, now: () => DEMO_CLOCK });
}

// Scripted model replies.
export const reply = (o: unknown) => JSON.stringify(o);
export const intakeReply = (cards: unknown[]) => reply({ cards });
export const thursdayJordanCard = (over: Record<string, unknown> = {}) => ({
  quote: "Thursdays I pick up, backup Jordan",
  mode: "decides",
  topic: "pickup_backup",
  facet: "thursday",
  scope: "kids",
  decided_by: "me",
  effective: "2026-10-03",
  decided_at: null,
  value: "backup Jordan",
  unsure: [],
  ...over,
});
