# unworried

**A private assistant that remembers which of your arrangements have changed, and only acts on the ones
still in force. When it is not sure, it asks you instead of guessing.**

Nebius × NVIDIA Global AI Hackathon 2026 · **Personal AI** track · every model call goes to **NVIDIA Nemotron 3 Super
(`nvidia/nemotron-3-super-120b-a12b`) on Nebius Token Factory** · all people and data in this repository are fictional.

**Live demo:** https://unworried.onrender.com (login in the submission's testing instructions) ·
**Video (2:16):** https://youtu.be/PNm0FIWy_Tg

## The moment it is built for

I'm a mom of two figure skaters, and our week runs on pickups — and on arrangements that keep changing. The demo
plays that week through a fictional family: Morgan's flight home lands Thursday at 19:30; Theo's pickup is at 17:30.
A month ago, while Alex was travelling on Thursdays, they agreed Jordan would back Morgan up. This morning Morgan
changed that: Alex is back.

An assistant that remembers everything still gets this wrong. Both notes are in its memory, they look the same, and
the one it finds says *ask Jordan*. unworried keeps every arrangement as a decision with two dates — when it was
decided and when it takes effect — and a link to the one it replaced. So:

1. Morgan says one sentence: *"From tomorrow Alex is the backup for Thursday pickups."*
2. Nemotron turns it into a card; code works out "tomorrow" (Nov 4) and shows that it replaces October's card. She confirms.
3. The plan that said *ask Jordan* is now refused. *Plan again* → **Alex can cover it**, and October's card is struck
   through in the *Why* panel.
4. She approves. It drafts the note to Alex — **it never sends anything; she does** — and when Alex says yes,
   Thursday is marked covered and she can add it to her own calendar (`.ics`).

When it cannot tell which arrangement holds (two undated notes, two notes nobody linked), it does nothing and asks.

## Try it in 60 seconds

1. Open https://unworried.onrender.com. It sleeps after 15 minutes idle; the first load can take about a minute.
2. Log in with the judge account from the testing instructions. You get your own sandbox family and calendar.
3. In the top strip, pick **Thu Nov 5 · Flight home from Denver** → **Plan**: *Jordan can cover it.*
4. In *Tell me what changed*, send `From tomorrow Alex is the backup for Thursday pickups.` → **Confirm** the card.
5. Back on the plan: it is refused → **Plan again** → *Alex can cover it* → **Approve** → the draft is in the outbox.
6. Optional: drag the day slider in *What holds today* (today: Jordan; Thursday: Alex), open the **Saturday** row
   (two undated notes → it refuses and quotes both), or press **Show the Monday focus-block contrast (10/26 vs 11/2)** (same request on two Mondays: one refused, one moved, then undo).

*Reset my sandbox* returns everything to the start. The demo clock is fixed at Tue Nov 3, 09:00 (Chicago).
A redeploy or a sleep on the free host logs everyone out and resets every sandbox; log in again.

## What Nemotron does, and what code does

The model reads language. Code decides what is true. Nothing the model says can change which arrangement is in force.

| step | who | what happens |
|---|---|---|
| **intake** | Nemotron 3 Super | one sentence → a decision card as JSON (topic, value, quote, *unsure* fields). The card is shown; nothing is recorded until you confirm. |
| dates | code (`src/time/relative.ts`) | "from tomorrow", "next week", "from Thursday" are computed from the moment you spoke (Chicago time). If the model's date disagrees, code wins and the card says so; "next Thursday" (two readings) is marked unsure and you pick. |
| **relate** | Nemotron 3 Super, then code | does the new card replace, refine or repeat the one already on that seat? A code check (`skepticCheck`) overrules verdicts the values contradict, and **your choice on the card wins**. |
| in force | code (`src/engine/`) | the seat graph: which confirmed card holds each seat on a given day, and which one it replaced. Undated or unlinked rivals → refuse and ask. |
| plan / act | code (`src/action/`) | conflicts on the sandbox calendar → a plan built only from cards in force: draft a handoff, draft a message, or move one of your own events. Approve → executed, read back (version number), undoable. |
| **explain** | Nemotron 3 Super, then code | a short "how it decided". Every capitalised word, number and time must appear in the plan's own facts; a sentence saying it will *send* something, or mixing "today" with a date, is struck out and marked. |

**Token Factory details.** OpenAI-compatible `chat/completions` at `api.tokenfactory.nebius.com/v1`, temperature 0,
`chat_template_kwargs: { enable_thinking: false }`, `max_tokens` capped per call kind. Two things we learned
building on it (details in the feedback we submitted): with thinking on, Nemotron 3.5 Lightning spent the whole
512-token budget reasoning and returned no JSON; and in 6 of 12 replies on our intake test set, Lightning wrote the
key `"cards"` twice in one object — in 3 of them the second copy was an empty list, and `JSON.parse` keeps the last
one, so a correct card silently disappeared. We now reject any reply with a duplicate key and retry, and switched
every call to Super (0 of 12 duplicates; see *How well does the model read a sentence?* below).

**The spending wall** (`src/spend/`, `docs/spend-wall.md`). Token Factory has no spending cap of its own, so the app
is the cap. Before each call it reserves the worst case (input tokens + `max_tokens` at the console price) in an
append-only ledger, and refuses if that would cross the login's session budget ($0.15), the day (the hosted demo sets $1; the code default is $3) or the total
($47). Calls per minute are limited separately. On the free host the disk does not survive a restart, so every
reservation is first written to a private GitHub repository; if that write fails, the call is not made. The full
demo change above costs about $0.001.

## How well does the model read a sentence?

Twelve sentences (nine state an arrangement, three are a question, a suggestion or small talk) sent once to each model
with the real intake prompt, on 2026-10-27, before the duplicate-key check existed (`scripts/eval-intake.ts`, 24 calls,
about $0.01; raw replies in `evidence/eval-intake-2026-10-27.jsonl`).

| model | right | replies with a duplicate `"cards"` key | of those, the second copy empty (card lost) |
|---|---|---|---|
| Nemotron 3 Super | **11 / 12** | 0 | 0 |
| Nemotron 3.5 Lightning | 8 / 12 | 6 | 3 |

Super's one miss: "From next week focus blocks may be moved again." Twelve sentences are a small, hand-written set;
the table explains a choice of model, it does not measure accuracy in general. Nothing the model reads is recorded
until the user confirms the card.

## Does it act on the arrangement in force?

13 constructed scenarios, each a pickup colliding with a flight; the expected answer was written from the product
rules before anything ran. unworried gets what a parent confirms on each card in the product — the value, and
which earlier card it replaces; three baselines get the same notes (text, when said, when in force, the name each
one mentions) and read them the way a plain memory would. No model is called
(`npx tsx scripts/eval-core-claim.ts`, held by `src/eval/core-claim.test.ts`; table in `docs/eval-core-claim.md`).

| | right | asked the wrong person | acted where it should have asked |
|---|---|---|---|
| **unworried** | **13 / 13** | 0 | 0 |
| a memory that reads start dates (newest note already in force) | 8 / 13 | 2 | 3 |
| a memory that trusts the newest note | 6 / 13 | 4 | 3 |
| a memory that was never updated | 5 / 13 | 5 | 3 |

**The same question to NVIDIA Nemotron 3 Super, without the ledger.** The same 13 scenarios, the notes handed to
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

Read it honestly: the scenarios are built to contain the traps the product is for; they show it follows its own rules
and how often a plain memory falls into those traps, not how often the traps happen in real life. Reading start
dates fixes the timing traps; what it does not fix is a question read as a decision, and acting when two notes disagree. The first version
of this eval scored unworried 11/13 because the harness did not pass the values a parent confirms; after that fix
the same 13 cases were re-run, so 13/13 is not a second, unseen test. 187 unit and end-to-end tests run offline
(`npm test`).

## Run it locally

Node ≥ 26. No build step and no runtime dependencies beyond the dev tools `npm ci` installs (`npm start` runs through `tsx`).

```bash
git clone https://github.com/simpleciki/unworried && cd unworried
npm ci
npm run typecheck && npm test            # all offline, no key
cp .env.example .env                     # then edit: at least JUDGE_ACCOUNTS; NEBIUS_* only for live calls
npx tsx scripts/spend-status.ts init     # creates state/spend-ledger.jsonl (model calls stay off without it)
set -a; source .env; set +a              # or export the variables your own way
npm start                                # http://127.0.0.1:8787/  (HOST / PORT to change)
```

Log in with a `name:secret` pair from `JUDGE_ACCOUNTS` and follow the steps above. With `LLM_ENABLED=false` (or no
key) the screen says *Model is off* and uses the recorded Nemotron replies in `cache/samples/` for the demo
sentences and a rule fallback for anything else; every other panel works. Secrets come only from the environment;
never commit `.env`. Hosting notes: `docs/deploy.md`.

## Provenance

This repository was started on 2026-10-26 for this hackathon (submission period 2026-08-26 to 2026-10-30). Its first
commit imports the decision-ledger engine from [unexplained](https://github.com/simpleciki/unexplained) (commit
`3007251`), which the same author built for the Open Agent Hackathon 2026 between 2026-10-21 and 2026-10-26:
`src/engine/` (decision cards, the seat graph, decided-vs-effective time, verification) and `src/llm/` (call budget,
response cache, rate limiter, JSON parsing, a fake provider for tests).

Everything after the first commit is new here: taking decisions from a conversation, code-computed dates, the
sandbox calendar and the action layer (plan, draft, move, undo, read back, `.ics`), the spending wall and its
mirrored ledger, the Nebius provider, the screen, the eval and the fictional data. The two projects have different
users: `unexplained` checks a contractor's quotes against a client's recorded decisions; `unworried` keeps one
person's decisions and acts on their calendar with them.

Built by one person with AI coding agents: the author set the requirements and made the product decisions
(`docs/tasks/decisions-*.md`), agents wrote code against task cards (`docs/tasks/00N-*.md`), and every paid model
call during development was made by the author in her own terminal (judges' calls on the hosted demo go through
the spending wall).

## Known limits

- **It does not touch your real calendar or send anything.** It acts on a sandbox calendar, drafts messages for you
  to send, and exports a covered pickup as `.ics`. Real calendar and messaging connectors are the next step.
- One household's vocabulary: pickup backups by weekday, priorities, which events may be moved, working hours. Seat
  values are read in fixed English shapes (`backup <Name>`, `HH:MM-HH:MM`); a new topic needs a parser.
- The explanation check is lexical: a sentence made only of common lowercase words would pass. A second model is
  deliberately not used to judge the first.
- Conflicts: all-day events conflict only with all-day events; the free-slot search looks five days ahead; v1 moves
  only your own events (no create, delete or recurrence rules).
- Hosting is the free tier: it sleeps after 15 minutes, and a restart clears every sandbox and logs everyone out
  (the spend ledger survives in the mirror). Each new login gets a fresh sandbox and a fresh session budget; the
  day and total budgets bound everything spent on the hosted demo.
- On the same host, the plans on screen and their undo tokens live in memory: after a restart press *Plan* again.

## License

MIT — see `LICENSE`.
