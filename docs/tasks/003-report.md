# Task 003 — report

Written 2026-10-26 23:0x CDT by the task session (Claude Fable 5.1), after tasks 001 and 002 in the same
session and after reading `decisions-2026-10-26.md`. Everything below comes from command output seen in this
session. No model was called; no network was used.

## What changed

| file | one line |
|---|---|
| `src/engine/time.ts` | **the one allowed engine fix**: `localMidnight` takes the offset in force at that midnight (`chicagoOffsetAt`, from Intl), so 2026-11-01 is 25 h and 2026-03-08 is 23 h; `chicagoOffsetMinutes` (date-level) unchanged, with a comment |
| `src/engine/time.test.ts` | three tests: the two transition days and `chicagoOffsetAt` either side of each switch (C12) |
| `src/time/chicago.ts` | shared helpers moved from `spend/ledger.ts` and `calendar/port.ts`: `chicagoParts`, `chicagoIso(ms, millis?)`, `chicagoDay`, `chicagoDayBounds`, `chicagoMidnight`, `chicagoLocal`, `chicagoOffsetAt`, `WEEKDAYS` |
| `src/spend/ledger.ts`, `src/calendar/port.ts` | import / re-export from `src/time/chicago.ts` (pure move; their tests unchanged) |
| `src/spend/limits.ts` | `DEFAULT_MAX_TOKENS_BY_KIND`: intake 512, relate 256, explain 512 (env still overrides, hard cap 1,024) |
| `src/action/seats-view.ts` | `values` lookup (card_id → value) read before the quote; `UNREADABLE` says whether the recorded value or the quote failed |
| `src/ledger/store.ts` | `LedgerStore`: `records` / `cards` / `edges` / `values` / `candidates` JSONL per session; withdraw lines; loud validation; `graph()`, `seatsView(clock)`, `reset()`; `loadConversationSeed`, `ledgerFromMessages` |
| `src/chat/prompts.ts` | `RULES`, `VALUE_SHAPES`, `vocabText`, `peopleText`, `loadVocabExtras`, the three prompts (intake / relate / explain) |
| `src/chat/intake.ts` | `intake()`: wall state → model via `asProvider` + `ModelClient.json` (≤ 1 retry) or rule fallback; `checkCandidate()` verifies every field into `unsure`; `seatHeads()`; `DECISION_MARKERS` |
| `src/chat/relate.ts` | `relate()`: one `relate` call per candidate, then `skepticCheck()` keeps a verdict only when the two quotes (and dates) support it; wall off → UNRELATED with notes |
| `src/chat/confirm.ts` | `confirm(candidate_id, edits)`: edits → re-check → refuse while unsure → card + edges (human relation wins, `source: "human"`) + value → new `SeatResolution`; `discard()` |
| `src/chat/explain.ts` | `explainPlan()`: one `explain` call → sentence-by-sentence `checkSentence()` against `factsOf(plan, lookups)`; unsupported sentences removed and listed; template fallback |
| `data/conversation-seed.jsonl` | 49 messages, Morgan ↔ assistant, 2026-09-01 → 2026-11-03, confirmed cards inline with the fixtures' ids (T1, T2, T3, T6, T9, T10, a question → mentions, a "should we" → proposes) |
| `scripts/seed-ledger.ts` | writes `state/ledger/<session>/` from the seed, no model; prints the seat table |
| `docs/intake.md` | the four questions, intake / relate / confirm / explain, value shapes, what is refused, limitations |
| `docs/action-layer.md` | limitations: undated cards invisible to the engine's `asOf`; coexisting ≠ conflict for the engine |
| tests | `src/chat/intake.test.ts` (C1, C2, C3, C7, C8), `src/chat/confirm.test.ts` (C4, C5, C6 + Skeptic), `src/chat/explain.test.ts` (C10), `src/ledger/store.test.ts` (seed shape, C9, C11), `src/spend/single-exit.test.ts` (C13 added), `src/chat/fixtures.test-helpers.ts` |

No new dependencies. Nothing else in `src/engine/`, `src/spend/`, `src/calendar/`, `src/action/` changed.

## Final test run and commits

```
> tsc --noEmit
 Test Files  19 passed (19)
      Tests  132 passed (132)
```

(104 after task 002 → 107 after the engine fix → 132 now; all offline.)

```
07e9c4f docs(intake): how a sentence becomes a card, what is refused, the value shapes; action-layer limitations on undated and coexisting cards
4743a56 test(chat): C1–C11 and C13 with scripted FakeProvider replies; C12 lives with the engine fix
2cfde58 feat(chat): one sentence → candidate cards, relation with a Skeptic check, confirmation, checked explanations
1c69558 feat(data): Morgan's seed conversation (49 messages, 2026-09-01 → 2026-11-03) and the seed-ledger script
13312a5 feat(ledger): append-only decision ledger per session with a value side table; builds the seat graph
8445ada feat(spend): default max_tokens for the intake (512), relate (256) and explain (512) call kinds
58c3427 refactor(time): one shared src/time/chicago.ts for the spend ledger, the calendar and the action layer
e9804e4 fix(engine): resolve the Chicago offset from the instant on the DST transition days
11abf15 docs(tasks): decisions on the 001/002 reports, task card 003 (conversation → ledger), model ids and base URL from official sources   (hub)
```

Plus the commit carrying this report. All commits carry the `-0500` offset. The suite was run green over the
whole working tree before each batch of commits (107 before the first three, 132 before the last five). One
impurity: the `seats-view.ts` value-lookup change travelled in the `refactor(time)` commit (`58c3427`) rather
than its own, because the same file also changed its import.

## Acceptance

| # | test | result | note |
|---|---|---|---|
| C1 | "From next Thursday Jordan picks up Theo." sent 2026-10-27T20:10 | ✅ | `effective` = `2026-10-29` (the model's proposal), `decided_at` = `source_recorded_at` = `sent_at`; T2 variant: `decided_at` 2026-10-03 with `source_recorded_at` 2026-10-09, both present and different; `same_seat` = `["pickup.oct3"]`; intake `max_tokens` 512 observed on the fake |
| C2 | question / "should we" | ✅ | the model mislabelled the question `decides`; code made it `mentions` with a note; "Should we…" → `proposes`; both confirmed (`holds_seat: false`), written to the ledger (18 cards) but the Thursday seat's cards are unchanged and `in_effect_card` stays `pickup.oct3` |
| C3 | `effective: null` | ✅ | `unsure: ["effective"]`, `card.effective` null; confirm refused ("still unsure about effective"), 16 cards; confirm with `effective: "2026-10-29"` → 17 cards |
| C4 | Thursday card REPLACES the September card | ✅ | ledger cut before 10/3 → intake + relate (REPLACES kept: "shared words thursdays") + confirm as `pickup.oct3` → seat `PASS`, `in_effect` new, `chain` `["pickup.oct3","pickup.sept"]`, edge `source: "model"`, Tuesday still `pickup.sept`; A3 against this ledger drafts to Jordan with the full citation. Second case: model says UNRELATED, user says REPLACES → edge `source: "human"` |
| C5 | two Saturday cards, UNRELATED | ✅ | seats view `AMBIGUOUS` naming `sat.a`, `sat.b`; plan `refused`, both quoted. **Note:** the engine itself reports `PASS` with `coexisting` for two unlinked cards (it does not call coexistence a conflict); the refusal comes from the seats view's `AMBIGUOUS`, as it did in 002 |
| C6 | unconfirmed candidate | ✅ | not in `graph()`, seat `NOT_FOUND`, 16 cards; `discard` → `confirm` throws "already discarded" |
| C7 | wall off (`LLM_ENABLED=false`) | ✅ | marker sentence → one candidate, `unsure` = effective, facet, quote, scope, topic, value, note "the model is off; fill the card yourself"; non-marker sentence → none; FakeProvider calls 0; a budget refusal (`total_usd` 0) also falls back with the reason |
| C8 | quote not in message / unknown facet | ✅ | `unsure` = facet, quote; card kept as a pending candidate; 16 cards; fixed by edits → confirmed. Also: prose reply twice → rule fallback after 2 calls; "Alex says…" with `decided_by: Alex` → `mentions` with a note |
| C9 | two session ids | ✅ | card in `judge-1` invisible in `judge-2`; reopening sees it (file is the state); `reset()` → 16 cards, 14 values, same ids as the seed |
| C10 | `explain` with one unsupported sentence | ✅ | "Casey will cover the pickup on Friday instead." removed and listed `(not in the plan: Casey)`; three sentences kept in order; template field untouched; wall off → `template`, 0 calls; every sentence unsupported → template with both listed; > 4 sentences → the fifth listed "beyond 4 sentences" |
| C11 | `scripts/seed-ledger.ts` then the action suite | ✅ | the script (child process via tsx, env = PATH + `LEDGER_DIR`) prints `cards: 16 edges: 2 values: 14` and the seat table; the seeded `SeatsView` plans all 7 seed conflicts with the same status / loser / step kinds / recipients / `after` / refused cards as the hand-built fixtures; values drive the read (`"Then Theo's pickups"` → rank 2 only via the side table); execute + undo through the seeded view |
| C12 | `src/engine/time.ts` fix | ✅ | `parseTime("2026-11-01")` = 05:00Z → 06:00Z next day (25 h), 00:30 CDT and 02:30 CST both `overlap`; 2026-03-08 = 06:00Z → 05:00Z (23 h); `chicagoOffsetAt` flips at 07:00Z (Nov) and 08:00Z (Mar); the 8 pre-existing engine time tests still pass |
| C13 | every model call through the guard | ✅ | `single-exit.test.ts`: outside tests `new ModelClient(` appears only in `chat/explain.ts`, `chat/intake.ts`, `chat/relate.ts`, each as `new ModelClient(provider` with `const provider = deps.guard.asProvider(`; `.asProvider(` is used nowhere else |

## Questions for the author

1. **Seed length: 49 messages**, below the card's "~60–100". Every trap and every fixture card is in it and
   the assistant's replies model the product's voice; I stopped where more messages would have been filler.
   Easy to extend in `data/conversation-seed.jsonl` (one JSON object per line) if the demo wants more texture.
2. **`same_seat` = the seat's heads plus any undated card**, not every card ever on the seat (a replaced
   card is history and would only invite a REPLACES-of-a-replaced verdict). C1's expectation (`["pickup.oct3"]`)
   follows from this.
3. **T3 in the conversation.** A chat message always has a `sent_at`, so "undated" is produced by the user
   reporting old notes: *"Found two old notes on the fridge, no idea when either is from…"* → two cards with
   `decided_at: "unknown"`. The intake path marks an unparseable `decided_at` as unsure, so a user who really
   wants an undated card today must say so on confirmation (the UI could offer "unknown"); the seed writes it
   directly. Say if you prefer a different convention for "I cannot date this".
4. **Rule-fallback `quote` is unsure** on purpose (the whole message stands in; the user trims it). The card
   said "every field unsure"; this is the one field the checks would otherwise accept.
5. **Explanation check is lexical**: capitalised words and digit tokens must appear in the plan's facts; a
   fixed allow-list covers common words, weekday and month names, "Morgan", "Theo". A sentence that lies with
   only lowercase common words (e.g. "nothing changes") would pass. The Skeptic-style check the card asked for
   is this; a second model call to judge support was deliberately not added (money, and a model checking a
   model).
6. **The engine's `chicagoOffsetMinutes(y, m, d)` still exists and still says "whole day −300/−360"**; it is
   now only a date-level approximation with a comment, kept because an existing engine test asserts it. The
   actual midnight computation no longer uses it.
7. **Human relation on confirmation** is applied even when the model proposed something else, and recorded
   `source: "human"` on the edge line; a model verdict the user did not touch is recorded `source: "model"`.
   The `RelationEdge` type is untouched (the extra field lives on the JSONL line and is stripped for the graph).
8. **Commit impurity** noted above (`seats-view.ts` in the time refactor commit).

## What a hook blocked

Nothing in this task.
