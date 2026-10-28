// One sandbox per judge login: calendar store + decision ledger + outbox + action store + chat log + trace,
// all under state/sessions/<session_id>/, seeded on first use from data/ exactly as scripts/seed-ledger.ts
// does. reset() wipes and re-seeds that judge only. The spend wall is shared (one ledger file) and keyed by
// the same session id, so a judge spends only their own budget.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ActionStore } from "../action/execute.ts";
import type { ActionPlan } from "../action/plan.ts";
import { JsonlTrace } from "../action/trace.ts";
import { JsonCalendarStore } from "../calendar/json-store.ts";
import { loadVocab } from "../engine/vocab.ts";
import type { Vocab } from "../engine/vocab.ts";
import { LedgerStore, loadConversationSeed } from "../ledger/store.ts";
import type { SeedLedger, SeedMessage } from "../ledger/store.ts";
import { FileCache } from "../llm/cache.ts";
import type { CachedResponse, ResponseCache } from "../llm/cache.ts";
import type { ChatProvider, ChatRequest, ChatResult } from "../llm/provider.ts";
import { ProviderError } from "../llm/provider.ts";
import { Outbox } from "../outbox/drafts.ts";
import { SpendGuard } from "../spend/guard.ts";
import type { GuardContext, GuardResult, GuardState } from "../spend/guard.ts";
import type { Explanation } from "../chat/explain.ts";
import { loadVocabExtras } from "../chat/prompts.ts";
import type { VocabExtras } from "../chat/prompts.ts";
import type { ExecutionResult } from "../action/execute.ts";

export const DEMO_CLOCK_ISO = "2026-11-03T09:00:00-06:00";

export type ChatLine = { message_id: string; sent_at: string; from: "me" | "assistant"; text: string; card_ids?: string[] };

export type StoredPlan = { plan: ActionPlan; explanation: Explanation; result?: ExecutionResult; undo?: unknown; created_at: string };

// Reads cache/samples/ first (the author's recorded replies), then the live cache; writes only to live.
export class LayeredCache implements ResponseCache {
  constructor(
    private readonly samples: ResponseCache,
    private readonly live: ResponseCache,
  ) {}
  get(key: string): CachedResponse | undefined {
    return this.samples.get(key) ?? this.live.get(key);
  }
  set(key: string, value: CachedResponse): void {
    this.live.set(key, value);
  }
}

// When the real wall is off, intake / relate / explain get this guard instead: it reports "enabled" so
// ModelClient looks in the cache, and its provider refuses every miss. No call leaves the machine, nothing
// is reserved or spent. The screen's banner still shows the REAL wall state.
export class ReplayGuard extends SpendGuard {
  private readonly real: SpendGuard;
  constructor(real: SpendGuard) {
    super({ prices: {}, ledgerPath: join("state", "replay-guard-has-no-ledger"), model: real.state().model, provider: replayProvider(), log: () => {}, limits: real.limits });
    this.real = real;
  }
  override state(): GuardState {
    const s = this.real.state();
    return { ...s, enabled: Boolean(s.model), reason: `replay: recorded replies only (${s.reason ?? "wall off"})`, limit: undefined };
  }
  override async call(): Promise<GuardResult> {
    return { ok: false, limit: "kill_switch", reason: "replay guard: no live calls" };
  }
  override asProvider(_ctx: GuardContext): ChatProvider {
    return replayProvider();
  }
}

function replayProvider(): ChatProvider {
  return {
    id: "replay",
    async status() {
      return "offline" as const;
    },
    async listModels() {
      return [];
    },
    async chat(_req: ChatRequest): Promise<ChatResult> {
      throw new ProviderError("refused", "model is off and no recorded reply exists for this exact prompt");
    },
  };
}

export class JudgeSandbox {
  readonly session_id: string;
  readonly judge: string;
  readonly dir: string;
  readonly calendar: JsonCalendarStore;
  readonly ledger: LedgerStore;
  readonly outbox: Outbox;
  readonly actions = new ActionStore();
  readonly trace: JsonlTrace;
  readonly plans = new Map<string, StoredPlan>();
  readonly cache: ResponseCache;
  private readonly chatFile: string;

  constructor(opts: { root: string; session_id: string; judge: string; vocab: Vocab; seed: SeedLedger; seedMessages: SeedMessage[]; seedCalendar: string; cache: ResponseCache; now: () => number }) {
    this.session_id = opts.session_id;
    this.judge = opts.judge;
    this.dir = join(opts.root, "state", "sessions", opts.session_id);
    mkdirSync(this.dir, { recursive: true });
    this.calendar = new JsonCalendarStore({ dir: join(this.dir, "calendar"), session: "calendar", seedPath: opts.seedCalendar, now: opts.now });
    this.ledger = new LedgerStore({ dir: this.dir, session: "ledger", vocab: opts.vocab, seed: opts.seed, now: opts.now });
    this.outbox = new Outbox({ path: join(this.dir, "outbox.jsonl"), now: opts.now });
    this.trace = new JsonlTrace(join(this.dir, "trace.jsonl"), opts.now);
    this.cache = opts.cache;
    this.chatFile = join(this.dir, "chat.jsonl");
    if (!existsSync(this.chatFile)) {
      for (const m of opts.seedMessages) appendFileSync(this.chatFile, JSON.stringify({ message_id: m.message_id, sent_at: m.sent_at, from: m.from, text: m.text, ...(m.cards ? { card_ids: m.cards.map((c) => c.card.card_id) } : {}) } satisfies ChatLine) + "\n");
    }
  }

  chat(): ChatLine[] {
    return readFileSync(this.chatFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ChatLine);
  }

  say(line: ChatLine): void {
    appendFileSync(this.chatFile, JSON.stringify(line) + "\n");
  }
}

// The latest sent_at (as an instant) over every judge's chat log under dir; -Infinity when there is none.
// An unreadable line fails loudly: a guessed clock is worse than no server.
export function latestChatInstant(dir: string): number {
  let latest = -Infinity;
  if (!existsSync(dir)) return latest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "chat.jsonl");
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const at = Date.parse((JSON.parse(line) as ChatLine).sent_at);
      if (Number.isNaN(at)) throw new Error(`${file}: a chat line has no readable sent_at`);
      if (at > latest) latest = at;
    }
  }
  return latest;
}

export class SandboxManager {
  readonly root: string;
  readonly vocab: Vocab;
  readonly extras: VocabExtras;
  readonly clock: number; // the demo clock
  readonly guard: SpendGuard;
  readonly replay: ReplayGuard;
  readonly cache: ResponseCache;
  private readonly seed: SeedLedger;
  private readonly seedMessages: SeedMessage[];
  private readonly seedCalendar: string;
  private readonly live = new Map<string, JudgeSandbox>();
  private readonly startedAt: number;
  private readonly chatBase: number;
  private readonly now: () => number;

  constructor(opts: { root: string; guard: SpendGuard; clock?: string; now?: () => number; cache?: ResponseCache }) {
    this.root = opts.root;
    this.vocab = loadVocab(opts.root);
    this.extras = loadVocabExtras(opts.root);
    this.clock = Date.parse(opts.clock ?? DEMO_CLOCK_ISO);
    if (Number.isNaN(this.clock)) throw new Error(`DEMO_CLOCK ${JSON.stringify(opts.clock)} does not parse`);
    this.guard = opts.guard;
    this.replay = new ReplayGuard(opts.guard);
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    // A restart must not move the chat clock backwards: a sentence said after a restart would otherwise be
    // stamped before one said earlier, and the newer decision would be ordered as the older one.
    this.chatBase = Math.max(this.clock, latestChatInstant(join(opts.root, "state", "sessions")) + 1000);
    const seeded = loadConversationSeed(join(opts.root, "data", "conversation-seed.jsonl"));
    this.seed = seeded.ledger;
    this.seedMessages = seeded.messages;
    this.seedCalendar = join(opts.root, "data", "calendar-seed.json");
    this.cache = opts.cache ?? new LayeredCache(new FileCache(join(opts.root, "cache", "samples"), { readOnly: true }), new FileCache(join(opts.root, "cache", "live")));
  }

  // The chat clock: the demo clock (or, after a restart, one second past the latest chat line already on
  // disk) plus the time elapsed since the server started, so new messages are ordered after the seed and
  // after everything said before the restart, and are never "from the future" relative to the demo clock's day.
  chatNow(): number {
    return this.chatBase + (this.now() - this.startedAt);
  }

  // What the assistant knows when it answers: every card said up to the latest chat moment. Seats are
  // resolved at this instant, not at the fixed demo clock — a sentence a judge types is stamped after the
  // demo clock, and resolving at the demo clock made every new card "dated after now" and every plan that
  // needed it a refusal (hosted, 2026-10-27 22:2x). Which conflicts are shown still uses the demo clock.
  knownAt(): number {
    return Math.max(this.clock, this.chatNow());
  }

  // The guard a model-using step should use right now: the real wall when it is open, the replay guard
  // (recorded replies only) when it is closed.
  guardFor(): { guard: SpendGuard; mode: "live" | "sample" } {
    const s = this.guard.state();
    return s.enabled ? { guard: this.guard, mode: "live" } : { guard: this.replay, mode: "sample" };
  }

  get(session_id: string, judge: string): JudgeSandbox {
    let s = this.live.get(session_id);
    if (!s) {
      s = new JudgeSandbox({ root: this.root, session_id, judge, vocab: this.vocab, seed: this.seed, seedMessages: this.seedMessages, seedCalendar: this.seedCalendar, cache: this.cache, now: () => this.chatNow() });
      this.live.set(session_id, s);
    }
    return s;
  }

  reset(session_id: string, judge: string): JudgeSandbox {
    const dir = join(this.root, "state", "sessions", session_id);
    rmSync(dir, { recursive: true, force: true });
    this.live.delete(session_id);
    return this.get(session_id, judge);
  }
}
