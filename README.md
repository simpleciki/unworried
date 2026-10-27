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

## License

MIT — see `LICENSE`.
