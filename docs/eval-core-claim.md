# Core-claim eval: does it act on the arrangement in force?

**The claim.** unworried acts on the arrangement that is in force at the moment of the conflict — not the newest
thing said, not the first — and when it cannot tell which one holds, it asks instead of guessing.

**How it is measured.** 13 scenarios, each a pickup that collides with a flight. For every scenario the expected
answer (ask this person / refuse and ask you) was written from the product rules before anything was run. unworried
is the product's own planner (`planConflict` over the seat graph, with the values a parent confirms on each card).
Two baselines read the same notes the way a plain memory would, each given the name every note mentions:

- **newest note** — trust the most recently said note naming a backup for that weekday;
- **first note** — trust the first one (a memory that was never updated).
- **newest note in force** — trust the newest note that has already taken effect on the pickup day: a memory that
  reads start dates, but not which note replaced which, nor whether a note was a question, a suggestion or a
  decision. Added 2026-10-28 after an independent review pointed out that the first two ignore start dates.

What each side is given is not the same: unworried gets what a parent confirms on each card in the product — the
value, whether it is a decision, and which earlier card it replaces; the baselines get every note's text, when it
was said, when it takes effect, and the name it mentions. That difference is the product's claim (the parent confirms
it once, on the card), not a hidden advantage.

No model is called: $0, no key, no network. Run it: `npx tsx scripts/eval-core-claim.ts`. The numbers below are
held by `src/eval/core-claim.test.ts` (as of 2026-10-28).

| # | trap | expected | unworried | newest note in force | newest note | first note |
|---|---|---|---|---|---|---|
| S01 | one standing arrangement | asks Alex | ✓ asks Alex | ✓ asks Alex | ✓ asks Alex | ✓ asks Alex |
| S02 | overturned | asks Jordan | ✓ asks Jordan | ✓ asks Jordan | ✓ asks Jordan | ✗ asks Alex |
| S03 | overturned for Thursday only; Tuesday unchanged | asks Alex | ✓ asks Alex | ✓ asks Alex | ✓ asks Alex | ✓ asks Alex |
| S04 | decided, not yet in force | asks Alex | ✓ asks Alex | ✓ asks Alex | ✗ asks Jordan | ✓ asks Alex |
| S05 | decided, now in force | asks Jordan | ✓ asks Jordan | ✓ asks Jordan | ✓ asks Jordan | ✗ asks Alex |
| S06 | a later question names the old backup | asks Jordan | ✓ asks Jordan | ✗ asks Alex | ✗ asks Alex | ✗ asks Alex |
| S07 | a later suggestion names someone else | asks Jordan | ✓ asks Jordan | ✗ asks Casey | ✗ asks Casey | ✗ asks Alex |
| S08 | two undated notes disagree | refuses (asks you) | ✓ refuses (asks you) | ✗ asks Alex | ✗ asks Alex | ✗ asks Jordan |
| S09 | a dated note and an undated one | refuses (asks you) | ✓ refuses (asks you) | ✗ asks Alex | ✗ asks Alex | ✗ asks Jordan |
| S10 | two dated notes, nobody said one replaces the other | refuses (asks you) | ✓ refuses (asks you) | ✗ asks Casey | ✗ asks Casey | ✗ asks Jordan |
| S11 | nothing decided for that day | refuses (asks you) | ✓ refuses (asks you) | ✓ refuses (asks you) | ✓ refuses (asks you) | ✓ refuses (asks you) |
| S12 | overturned twice (the demo sentence) | asks Alex | ✓ asks Alex | ✓ asks Alex | ✓ asks Alex | ✓ asks Alex |
| S13 | the demo sentence, before it is in force | asks Jordan | ✓ asks Jordan | ✓ asks Jordan | ✗ asks Alex | ✗ asks Alex |

unworried: 13/13 right · asked the wrong person 0 · acted where it should have asked 0 · asked where it could have acted 0
newest note in force: 8/13 right · asked the wrong person 2 · acted where it should have asked 3 · asked where it could have acted 0
newest note: 6/13 right · asked the wrong person 4 · acted where it should have asked 3 · asked where it could have acted 0
first note: 5/13 right · asked the wrong person 5 · acted where it should have asked 3 · asked where it could have acted 0

**Read it honestly.**

- The scenarios are **constructed** (a fictional family), not observed from real use. They cover the traps the
  product is built for; they are not a sample of how often each trap happens.
- The date-aware memory gets every timing trap right (8/13); what it still gets wrong is a question or a suggestion read
  as a decision (S06, S07) and two notes that disagree with nothing to say which counts (S08–S10).
- unworried's 13/13 shows the product does what its rules say. The informative numbers are the baselines': on the
  same notes, a memory that answers from the newest note asks the wrong person 4 times and acts 3 times where it
  should have asked.
- S10 (two dated notes, nobody said one replaces the other) is a judgment call: unworried asks, the newest-note
  memory picks the later one — which may be what the parent meant. We count asking as right because the product
  never guesses which arrangement holds; the parent answers once and the card records it.
- The first version of this eval did not pass the confirmed values the product stores, and unworried scored 11/13
  (it could not read "Alex is the backup for …" from the sentence alone). The eval can go red; it did once.

## The same scenarios, with a real model as the baseline (2026-10-28)

The same 13 scenarios, the notes handed to
the model as text with when each was said — what a person reading them would see, no links, no labels
(`scripts/eval-model-baseline.ts`, held offline by `src/eval/model-baseline.test.ts`; 26 calls on 2026-10-28, about
$0.003; raw replies in `evidence/eval-model-baseline-*.jsonl`). Run twice, differing in one sentence of the prompt:

| Nemotron 3 Super, notes as text | right | asked the wrong person | acted where it should have asked | asked where it could have acted |
|---|---|---|---|---|
| told "if my notes don't let you tell, ask me instead of guessing" | 5 / 13 | 0 | 0 | 8 |
| not told | 5 / 13 | 4 | 4 | 0 |

Told to ask, it asked in 12 of 13 — mostly about things the notes already settle ("does 'Alex' refer to your
partner/spouse?"); one question named the real conflict (S10). Not told, it never asked. One sentence of prompt moves
it from asking about everything to guessing; what decides when to ask is which arrangement holds, and that is what
the ledger keeps. One run per variant, temperature 0, constructed scenarios.

Per scenario (✓ = matches the expected answer):

| # | expected | told to ask | not told |
|---|---|---|---|
| S01 | asks Alex | ✓ asks Alex | ✓ asks Alex |
| S02 | asks Jordan | ✗ asks you | ✓ asks Jordan |
| S03 | asks Alex | ✗ asks you | ✓ asks Alex |
| S04 | asks Alex | ✗ asks you | ✗ asks Jordan |
| S05 | asks Jordan | ✗ asks you | ✓ asks Jordan |
| S06 | asks Jordan | ✗ asks you | ✗ asks Alex |
| S07 | asks Jordan | ✗ asks you | ✗ asks Casey |
| S08 | refuses (asks you) | ✓ asks you | ✗ asks Alex |
| S09 | refuses (asks you) | ✓ asks you | ✗ asks Alex |
| S10 | refuses (asks you) | ✓ asks you | ✗ asks Casey |
| S11 | refuses (asks you) | ✓ asks you | ✗ asks Alex |
| S12 | asks Alex | ✗ asks you | ✓ asks Alex |
| S13 | asks Jordan | ✗ asks you | ✗ asks Alex |

When told to ask, the questions it asked in S08, S09 and S11 were not about the real gap (for S11: "whether 'Alex'
refers to your partner/spouse"); counted as right because the answer, asking, is right.
