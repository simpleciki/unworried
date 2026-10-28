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
