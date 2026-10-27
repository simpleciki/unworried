# unworried

**A private assistant that remembers which of your arrangements have changed, and only acts on the ones
still in force. When it is not sure, it asks you instead of guessing.**

Nebius × NVIDIA Global AI Hackathon 2026 · Personal AI track · model calls go through Nebius Token Factory
to an NVIDIA Nemotron model · all data in this repository is fictional.

Status: under construction (started 2026-10-26).

## Provenance — read this first

This repository was started on 2026-10-26 for the Nebius × NVIDIA Global AI Hackathon (submission period
2026-08-26 to 2026-10-30). Its first commit imports the decision-ledger engine from
[unexplained](https://github.com/simpleciki/unexplained) (commit `3007251`), which the same author built for
the Open Agent Hackathon 2026 between 2026-10-21 and 2026-10-26.

Imported as-is in the first commit:

- `src/engine/` — decision cards, the seat graph (which decision currently holds each seat, and which one
  it replaced), bitemporal time (when a decision was made vs. when it takes effect), verification.
- `src/llm/` — the model client: call budget, response cache, rate limiter, JSON reply parsing, and a fake
  provider for tests. Its routing modes still name the Open Agent runtime; they are replaced in later commits.

Everything after the first commit is new for this hackathon: taking decisions from a conversation with the
user, the sandbox calendar and the action layer (reschedule, draft, undo), the spending wall around Token
Factory, the Nebius provider, the UI, and the fictional data.

The two projects have different users and do different things. `unexplained` checks a contractor's outgoing
quotes against the client's recorded decisions and explains why. `unworried` keeps one person's decisions
and acts on their calendar with them. What they share is the idea underneath both: an old arrangement and
a new one look the same on paper, so the system has to know which one replaced which.

## Run it

Node ≥ 26. No build step; no runtime dependencies.

```bash
git clone <this repository> unworried && cd unworried
npm ci
npm run typecheck && npm test            # all offline
cp .env.example .env                     # then edit: at least JUDGE_ACCOUNTS; NEBIUS_* only for live calls
npx tsx scripts/spend-status.ts init     # creates state/spend-ledger.jsonl (model calls stay off without it)
set -a; source .env; set +a              # or export the variables your own way
npm start                                # http://127.0.0.1:8787/  (HOST / PORT to change)
```

Open the address, log in with a `name:secret` pair from `JUDGE_ACCOUNTS`, and follow `docs/screen.md`
("The three demo routes"). Each login gets its own sandbox under `state/sessions/`; *Reset my sandbox* returns
it to the seed. With `LLM_ENABLED=false` (or no key) the screen runs in SAMPLE mode: a red banner, recorded
replies for the demo sentences from `cache/samples/`, rule fallback for everything else, and every other panel
fully working. Live calls go through the spending wall described in `docs/spend-wall.md`; the per-login budget
is `SPEND_SESSION_USD` (default $0.15).

For hosting: `HOST=0.0.0.0 PORT=3000 npm start` binds as told; without `HOST` the server listens on
127.0.0.1 only. Secrets (the Token Factory key, `JUDGE_ACCOUNTS`) come only from the environment; never
commit `.env`.

## Known limits

- The model-written explanation is checked lexically: every capitalised word and every number or time in a
  sentence must appear in the plan's own facts, so a sentence made only of common lowercase words would pass
  the check; a second model is deliberately not used to judge the first.
- The decision engine drops a card whose `decided_at` does not parse whenever it is asked with a date; the
  seats view scans for undated cards itself and reports them. Two unlinked cards on one seat are "coexisting"
  to the engine and "ambiguous" to the assistant; both refuse.
- Seat values are read from a side table in fixed English shapes (`rank N`, `may be moved`, `backup <Name>`,
  `HH:MM-HH:MM`); a new topic needs a parser.
- Conflicts: all-day events conflict only with all-day events; the free-slot search looks at most five days
  ahead; v1 moves only the owner's own events (no create, delete or recurrence rules).
- Prices in `config/prices.json` are provisional until read from the provider's console; the wall refuses any
  model id without a price, so a wrong price can under-book but a wrong id cannot leak spend.
- Judge sessions live in `state/`; a judge who logs in again gets a fresh sandbox and a fresh session budget
  (the day and total budgets still bound the whole hackathon).
- A server restart keeps each judge's calendar, decisions, drafts and chat, but not the plans on screen or
  their undo tokens (held in memory): after a restart, press *Plan* again; an approved change is already in
  the calendar and its version history.

## License

MIT — see `LICENSE`.
