# Task 003 — Decisions from conversation, the decision-ledger store, model-written explanations

Read `docs/tasks/000-shared-rules.md`, then `docs/tasks/decisions-2026-10-26.md` (it changes a few things
from 001/002 and lists small fixes this task owns), then this card. Then read the code you build on:
`src/spend/guard.ts` (`asProvider`), `src/llm/client.ts` (`ModelClient.json`), `src/engine/types.ts`,
`seats.ts`, `verify.ts`, `vocab.ts`, `src/action/seats-view.ts`, `data/vocab.yaml`, `data/README.md`.

## Why this task exists

The product's promise, in the author's words: *"I don't want to worry whether the answer is already stale;
if it does not know, it does not lie — it shows me the point it is unsure about and lets me confirm, without
costing me much thought."* In the sibling project the model read 100 noisy records and missed a third of the
decisions. Here the model reads **one sentence the user just typed** and turns it into **one candidate card**
that the user confirms before it counts. Precision problems become visible fields, not hidden errors.

## Files you own

```
src/time/chicago.ts             shared Chicago helpers (moved from spend/ledger.ts and calendar/port.ts; pure move)
src/ledger/store.ts             the decision ledger on disk: cards, relation edges, values; builds a SeatGraph
src/ledger/*.test.ts
src/chat/intake.ts              one user message → 0..n candidate cards (model via the spend wall; rule fallback)
src/chat/relate.ts              candidate vs cards on the same seat → REPLACES / REFINES / SAME / UNRELATED (model + Skeptic check)
src/chat/confirm.ts             candidate → confirmed card (+ edges, + value) → store; or discarded
src/chat/explain.ts             model-written explanation of an ActionPlan, Skeptic-checked sentence by sentence; template fallback
src/chat/prompts.ts             the prompts (English); the rules every prompt states
src/chat/*.test.ts
data/conversation-seed.jsonl    Morgan ↔ assistant, ~60–100 messages over 2026-09-01 → 2026-11-03, with the confirmed cards inline
scripts/seed-ledger.ts          builds state/ledger/<session>/ from the seed without a model
docs/intake.md                  how a sentence becomes a card, what is refused, the value shapes
```

Also yours, by `decisions-2026-10-26.md`: the one engine fix (`src/engine/time.ts` offset from the instant,
with tests); `src/action/seats-view.ts` reading values from the ledger's side table first; the
`SPEND_MAX_TOKENS_<KIND>` defaults for `intake` 512, `relate` 256, `explain` 512 in `src/spend/limits.ts`.
Nothing else in `src/engine/`, `src/spend/`, `src/calendar/`, `src/action/` changes.

## Design

### Input contract (the four questions the author asks of every new module)

1. **Input:** one user message `{ message_id, session_id, text, sent_at }`. `sent_at` is the chat entry's
   clock, ISO 8601 with offset. Not a file, not a chat export.
2. **Who guarantees it:** the chat entry code guarantees `message_id` and `sent_at`. Nobody guarantees the
   text → a candidate card never counts until the user confirms it.
3. **Physical layer:** `decided_at` = `sent_at`, unless the sentence names an earlier moment ("by the way, on
   10/3 we agreed …") → `decided_at` = that date (model proposes, user confirms) and `source_recorded_at` =
   `sent_at`; the two are shown side by side when they differ. `effective` = the time the sentence says
   ("from next Thursday") → model proposes, user confirms; **if it cannot be read, the field is empty and marked
   "I could not tell from when this applies" — never defaulted to `decided_at`.**
4. **Failure shape:** a misread → a wrong field visible on the card before confirmation (loud); an unreadable
   field → explicitly "unsure", the user fills it; **nothing enters the ledger silently**. A confirmed mistake
   is undone by saying a new sentence: the ledger keeps the overturn chain.

### The ledger store (`src/ledger/store.ts`)

- Per session id (one judge's sandbox), under `state/ledger/<session>/`: `cards.jsonl` (confirmed
  `CheckedCard`s, `source: "human"`), `edges.jsonl` (`RelationEdge`s), `values.jsonl` (`{ card_id, value }`
  in the shapes documented in `data/vocab.yaml`), `candidates.jsonl` (pending, never read by the graph).
  Append-only; a card is "withdrawn" by a new line, never deleted.
- `graph()` builds a `SeatGraph` from confirmed cards + edges with the project vocab, exactly as
  `src/action/fixtures.test-helpers.ts` does by hand today. `src/action/seats-view.ts` gets a `values` lookup
  and uses it before parsing the quote.
- `reset(session)` returns to the seeded ledger (the seed's confirmed cards), as the calendar does.
- Loud validation on load: a line that does not parse → the store refuses to open (same stance as the spend
  ledger).

### Intake (`src/chat/intake.ts`)

- Through `SpendGuard.asProvider({ session_id, action_id, kind: "intake" })` wrapped in `ModelClient`
  (`json()` with a strict parser; retries ≤ 1). Temperature 0.
- Prompt gives: the rules (quote verbatim; `"the records do not say"` discipline; never infer a date), the
  vocabulary (`vocabText` style: topics, facets, scopes, deciders, the value shapes), the people, the
  message with its `sent_at`, and asks for JSON only:
  `{ "cards": [ { "quote", "mode", "topic", "facet", "scope", "decided_by", "effective" | null,
  "decided_at" | null, "value" | null, "unsure": ["effective", …] } ] }`.
- **Code verifies the model** (do not trust it): `quote` must be a verbatim substring of the message (use
  `normaliseText` from `src/engine/verify.ts`), topic/facet/scope must be vocab keys (`keyProblems`),
  `decided_by` must be allowed by `applyDeciderCheck`, `value` must match the facet's shape; any failure
  moves that field into `unsure` rather than dropping the card. A question or a "should we…" sentence →
  `mode: mentions` / `proposes` and **holds no seat**.
- **Rule fallback when the wall says `enabled: false`** (kill switch, budget, breaker, no key): no model.
  Sentences with none of the decision markers ("from now on", "from <date>", "instead", "change to",
  "switch to", "no longer", "picks up", "may not be moved") → no candidate; otherwise one candidate with every
  field `unsure` and a note "the model is off; fill the card yourself". The UI (task 004) shows the banner.
- Output: `Candidate[]`, each with `candidate_id`, the proposed `CheckedCard` fields, `value`, `unsure`, and
  `same_seat: card_id[]` (cards currently on the same seat, for the relation step).

### Relation (`src/chat/relate.ts`)

- For a candidate with `same_seat` non-empty: one `relate` call asking REPLACES / REFINES / SAME / UNRELATED
  per existing card, then a Skeptic-style check (`src/agents/skeptic.ts` in `unexplained` is the pattern;
  write your own here: "is this verdict supported by the two quotes?"). Unsupported → `UNRELATED`, which
  leaves both cards on the seat → the engine reports `UNRESOLVED_CONFLICT` → the action layer refuses and asks.
- The user may override on confirmation ("this replaces X"); **human relation wins** and is recorded with
  `source: "human"` on the edge line.

### Confirm (`src/chat/confirm.ts`)

- `confirm(candidate_id, edits)` → applies the user's field edits, re-runs the code checks, writes card +
  edges + value, returns the new `SeatResolution` for the seat (so the UI can show "the seat changed").
- `discard(candidate_id)`.
- A candidate with any field still `unsure` **cannot be confirmed** until the user fills it.

### Explanation (`src/chat/explain.ts`)

- Input: an `ActionPlan` (ready or refused) and the seat resolutions it depended on. One `explain` call writes
  ≤ 4 sentences for a person. Then a sentence-by-sentence check against the structured plan (same pattern as
  the Skeptic's answer stage): a sentence not supported by the plan's fields is **removed** and listed under
  `unresolved`. If the wall is off or the model fails → the template explanation from `src/action/plan.ts`.
- The plan's own `explanation` field stays the template; the model's text is a separate field
  `explanation_prose` with `explanation_removed: string[]`.

### Seed conversation (`data/conversation-seed.jsonl`)

One line per message: `{ "message_id", "sent_at", "from": "me" | "assistant", "text", "cards": [ … confirmed
cards and edges and values, for "me" messages only … ] }`. `scripts/seed-ledger.ts` writes the ledger from
these lines deterministically (no model). Embed the traps the calendar tests already rely on, with the same
card ids as `src/action/fixtures.test-helpers.ts` so A3–A6 keep passing against the seeded ledger:

| trap | how it appears in the conversation |
|---|---|
| T1 | September: "Tuesdays and Thursdays Alex picks up Theo." · 10/3: "Change of plan: Thursdays I pick up, backup Jordan — Alex is travelling Thursdays now." · later a reply to the assistant: "yeah Alex gets him Thursdays right?" (a question → `mentions`) |
| T2 | 10/9: "By the way, on 10/3 we agreed …" → `decided_at` 10/3, `source_recorded_at` 10/9, both shown |
| T3 | two Saturday sentences, neither dated nor replacing the other |
| T6 | only Thursday changed; Tuesday still Alex |
| T9 | "Monday focus blocks may not be moved." with no reason → the "why" is "the conversation does not say" |
| T10 | 10/20: "From November 2nd, focus blocks may not be moved." |

Keep every name fictional; Morgan's two products need names (invent; match no real product).

## Acceptance (C = conversation layer; run with `FakeProvider` scripted replies)

| # | test | passes when |
|---|---|---|
| C1 | "From next Thursday Jordan picks up Theo." sent 2026-10-27T20:10:00-05:00 | candidate `effective` = the Thursday the model proposed, `decided_at` = `sent_at`; both shown when they differ |
| C2 | "Does Alex pick up Thursdays?" / "Should we ask Jordan to cover Thursdays?" | `mentions` / `proposes`; after confirmation neither holds a seat |
| C3 | model returns `effective: null` | field `unsure`, candidate cannot be confirmed until filled; nothing defaults |
| C4 | confirm a Thursday card with relation REPLACES the September card | seat PASS → new card; `chain` holds the old one; A3 against the seeded ledger drafts to Jordan |
| C5 | two Saturday cards, relation UNRELATED | seat `UNRESOLVED_CONFLICT`; the action layer refuses and names both |
| C6 | unconfirmed candidate | not in `graph()`; the action layer cannot see it |
| C7 | wall off (`LLM_ENABLED=false`) | rule fallback: marker sentence → one all-unsure candidate with the "model is off" note; non-marker sentence → none; no provider call |
| C8 | model returns a quote that is not in the message, or an unknown facet | that field is `unsure`; the card is not dropped; nothing enters the ledger |
| C9 | two session ids | ledgers isolated; `reset` returns to the seed |
| C10 | `explain` with a scripted reply containing one unsupported sentence | that sentence removed and listed; the rest kept; wall off → template |
| C11 | `scripts/seed-ledger.ts` then the full action suite | A1–A15 still pass against the seeded ledger (not only the hand-built fixtures) |
| C12 | `src/engine/time.ts` fix | 2026-11-01 00:30 CDT is on 11/01 (−05:00); 02:30 CST is on 11/01 (−06:00); 2026-03-08 likewise; all existing engine tests still pass |
| C13 | every model call | goes through `SpendGuard` (extend `src/spend/single-exit.test.ts`: `new ModelClient(` only wraps `asProvider`) |

## Done looks like

`npm run typecheck && npm test` green including C1–C13; seed conversation and `scripts/seed-ledger.ts`
committed; `docs/intake.md` written; `docs/tasks/003-report.md` per the shared rules. Small commits. No real
model call. If a hook blocks a command, stop and report.
