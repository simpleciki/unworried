# From a sentence to a card

The user types one sentence. The model (through the spending wall) proposes one candidate card per decision
in it. Code verifies every field it can; anything it cannot verify is marked **unsure**. The user confirms,
and only then does the card enter the decision ledger. Nothing enters silently.

```
message {text, sent_at} ──▶ intake ──▶ Candidate[] (fields + unsure[]) ──▶ relate ──▶ confirm(edits) ──▶ ledger (card, edges, value)
                             model proposes      code checks            model proposes       user decides
                             rules if wall off   never trusts           Skeptic checks       unsure blocks
```

## The four questions

| | answer |
|---|---|
| **Input** | one user message `{ message_id, session_id, text, sent_at }`; `sent_at` is the chat entry's clock, ISO 8601 with offset |
| **Who guarantees it** | the chat entry code guarantees `message_id` and `sent_at`; nobody guarantees the text, so a candidate never counts until confirmed |
| **Physical layer** | `decided_at` = `sent_at` unless the sentence names an earlier moment ("on 10/3 we agreed …"), then `decided_at` = that date and `source_recorded_at` = `sent_at`, shown side by side. `effective` = the time the sentence says ("from next Thursday"); unreadable → empty and **unsure**, never defaulted to `decided_at` |
| **Failure shape** | a misread → a wrong field visible on the card before confirmation; an unreadable field → "unsure", the user fills it; a confirmed mistake is undone by a new sentence, and the ledger keeps the overturn chain |

## Intake (`src/chat/intake.ts`)

1. `guard.state()`. If the wall is off (kill switch, budget, breaker, no key, no model) → **rule fallback**: a
   sentence with a decision marker ("from now on", "from <date>", "instead", "change to", "switch to",
   "no longer", "picks up", "may not be moved", "backup", "comes first", "working hours", "change of plan") →
   one candidate with every field unsure and the note *"the model is off; fill the card yourself"*; any other
   sentence → no candidate. No provider call is made.
2. Otherwise one `intake` call (`max_tokens` 512, temperature 0, ≤ 1 retry on a bad reply) through
   `SpendGuard.asProvider({ session_id, action_id, kind: "intake" })` wrapped in `ModelClient.json`. The
   prompt states the rules, the vocabulary with its value shapes, the people, the message and its `sent_at`,
   and asks for JSON only. A reply that is not usable JSON twice → rule fallback with the reason.
3. **Code checks every proposed card** (`checkCandidate`):

| field | check | on failure |
|---|---|---|
| `quote` | verbatim substring of the message (`normaliseText` on both) | unsure |
| `mode` | a message ending in `?` is `mentions`; one starting "should/shall/maybe/could we…" is `proposes` | corrected, with a note |
| `topic` / `facet` / `scope` | keys in `data/vocab.yaml` | unsure |
| `decided_by` | `me` or a person in the vocabulary; `applyDeciderCheck` — anyone else deciding becomes `mentions` | unsure / corrected with a note |
| `decided_at` | `null` → `sent_at`; a string must parse (`parseTime`) | unsure |
| `effective` | required for `decides`; must parse | unsure |
| `value` | required for `decides`; must fit the topic's shape (below) | unsure |

A mention or proposal needs neither `effective` nor `value`: it holds no seat.
4. `same_seat` = the cards currently on `topic | facet | scope` in this session's ledger.

## Relation (`src/chat/relate.ts`)

For a `decides` candidate with cards on its seat: one `relate` call (`max_tokens` 256) asks, per existing card,
REPLACES / REFINES / SAME / UNRELATED. Then the **Skeptic** in code keeps a verdict only if the two quotes
support it:

- REPLACES / REFINES: the candidate's `decided_at` is not before the existing card's (comparable, not
  "after"), and the quotes share a content word (or the values are equal).
- SAME: equal values or equal normalised quotes.
- Anything unsupported → UNRELATED, which leaves both cards on the seat, so the action layer refuses and asks.

Each verdict carries a note saying why it was kept or downgraded. Wall off → all UNRELATED, for the user to set.

## Confirm (`src/chat/confirm.ts`)

`confirm(candidate_id, edits)` applies the user's edits (`card` fields, `value`, `relations`, `card_id`),
re-runs the checks, and refuses while anything is still unsure. Then it writes the card (`source: "human"`),
the edges (UNRELATED writes none; a relation the user set is recorded `source: "human"` and wins over the
model's), and the value (side table), and returns the seat's new `SeatResolution` so the UI can show what
changed. `discard(candidate_id)` drops a candidate. Mentions and proposals are written but hold no seat.

## Explanation (`src/chat/explain.ts`)

One `explain` call (`max_tokens` 512) writes ≤ 4 sentences about an `ActionPlan`. Each sentence is checked
against the plan's own facts: every capitalised word and every number or time in it must appear in the plan
(template explanation, refusal, steps, the seats' quotes and dates); common words are allowed. A sentence
that fails is **removed** and listed in `explanation_removed` with what was not in the plan. The plan's
`explanation` (the code template) is never replaced; the prose is the separate `explanation_prose`. Wall off,
model failure, or every sentence removed → the template.

## The value shapes (the ledger's side table)

Quotes stay the user's exact words. The seat's **value** is a short restatement in a fixed shape, proposed by
the model, checked by code, confirmed by the user, and stored in `values.jsonl`; `seats-view.ts` reads it
first and falls back to the quote.

| topic | shape | example |
|---|---|---|
| `priority` | `rank N` (1 yields to nothing) | `rank 2` |
| `movable` | `may be moved` / `may not be moved` | `may not be moved` |
| `pickup_backup` | `backup <Name>` | `backup Jordan` |
| `working_hours` | `HH:MM-HH:MM[ Monday to Friday]` | `09:00-17:00 Monday to Friday` |

## The ledger (`src/ledger/store.ts`)

`state/ledger/<session>/`: `records.jsonl` (the messages cards quote), `cards.jsonl` (confirmed cards and
`{"withdrawn": …}` lines), `edges.jsonl`, `values.jsonl`, `candidates.jsonl` (pending; never read by the
graph). Append-only. A line that does not parse → the store refuses to open. `graph()` builds the engine's
`SeatGraph` from confirmed, non-withdrawn cards; `seatsView(clock)` adds the value lookup. `reset()` returns
to the seed. `scripts/seed-ledger.ts` writes a session from `data/conversation-seed.jsonl` without a model.

## What is refused

- Confirming a candidate with any field unsure.
- A quote that is not in the message; a topic, facet or scope not in the vocabulary; a value not in shape.
- A decision by someone who may not decide (becomes a mention).
- A relation the two quotes do not support (becomes UNRELATED → the seat is ambiguous → the action layer asks).
- Any model sentence that names something the plan does not.
- Opening a ledger with a corrupt line; a session id outside `[A-Za-z0-9._-]{1,64}`.

## Limitations

- The engine drops cards whose `decided_at` does not parse whenever a date is given; the seats view scans
  for undated cards itself (`UNDATED`), as `docs/action-layer.md` says.
- The engine does not call two unlinked cards on a seat a conflict (it reports `PASS` with `coexisting`);
  the seats view does (`AMBIGUOUS`). Both lead to a refusal naming both cards.
- The rule fallback recognises a fixed list of markers; a decision phrased without them produces no
  candidate while the wall is off (the UI shows the "model is off" banner).
- Value shapes are English and fixed; a new topic needs a parser in `seats-view.ts` and a row above.
