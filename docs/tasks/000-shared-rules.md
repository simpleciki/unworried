# Shared rules for every task in this repository

These apply to tasks 001, 002 and everything after. A task card may add rules; it may not remove these.

## What this project is

`unworried` — a private assistant for the Nebius × NVIDIA Global AI Hackathon 2026 (Personal AI track,
deadline 2026-10-30 12:00 CDT; the human submits on the evening of 10/29). It keeps one person's decisions
(a "decision ledger": which arrangement currently holds, which one it replaced, from when), and acts on
their sandbox calendar with only the decisions still in force. When it is not sure, it refuses and asks.
The user's own words for the goal: *"I don't want to worry whether the answer is already stale; if it does
not know, it does not lie — it shows me the point it is unsure about and lets me confirm, without costing
me much thought."*

Read `README.md` (Provenance) first. The engine in `src/engine/` and the client in `src/llm/` were imported
from a sibling project; see `docs/tasks/00N-*.md` for which parts you may change.

## Hard rules

1. **No real model calls, ever, from a task session.** Use `FakeProvider` (`src/llm/fake.ts`) in every test.
   Real calls to Nebius Token Factory cost the author money and are made only by the author, in her own
   terminal, inside an approval window. If a pre-tool hook on this machine blocks a command for
   "production model API", **stop and write it in your report** — do not reshape or split the command to
   get past it.
2. **No network in tests.** `npm test` must pass offline.
3. **Secrets only from the environment** (`NEBIUS_API_KEY`). Never log a key, never write one to a file,
   never commit `.env`. Commit `.env.example` with placeholder values only.
4. **`src/engine/` is frozen.** If you believe a change there is needed, write it under "Questions" in
   your report with the reason; do not edit it. `src/llm/` may be adapted (it is the model client).
5. **All data fictional.** No real person, employer, address, phone, email, product or company. Invent
   names; do not reuse names from `unexplained`. The child in the seed data is called Theo and attends a
   robotics club; do not give the family any sport.
6. **Time:** every timestamp is ISO 8601 with an explicit offset, America/Chicago. Daylight saving time
   ends 2026-11-01 02:00 CDT (UTC−5 → UTC−6). Any comparison of two times must use the instants, not the
   wall-clock strings. The demo clock ("now" in the sandbox) is fixed at `2026-11-03T09:00:00-06:00`.
7. **Failures are loud.** A missing input, an unknown model id, a missing ledger file, a seat with no
   decision — each produces an explicit refusal with a reason, never a default that looks like success.
8. **Commits:** Conventional Commits (`feat(scope): …`, `fix(scope): …`, `test(scope): …`,
   `docs(scope): …`), one logical change per commit, message says what the change does, not how. End
   every commit message with the trailer `Co-Authored-By: Claude <the model you are> <noreply@anthropic.com>`
   (look at `git log -1 --format=%B` for the exact form). The repository's git author is already configured;
   do not change it. Do not push: there is no remote yet, and the author decides when the repo goes public.
9. **TypeScript:** strict, ESM, `.ts` imports (see `tsconfig.json`), Node ≥ 26, `tsx` + `vitest`. Run
   `npm run typecheck && npm test` before every commit. Code comments and docs in English.
10. **Do not touch files owned by another task** (each card lists its files). Do not install new
    dependencies without writing why in the report; prefer zero new runtime dependencies.

## Report

When done (or when you stop for any reason), write `docs/tasks/00N-report.md` with:

- what changed (files, one line each),
- the final `npm test` summary line and the commit list (`git log --oneline`),
- the acceptance table from your card with ✅ / ❌ / ⬜ per row, and for each ❌ or ⬜ one line why,
- questions for the author (anything you had to assume),
- anything a hook blocked.

Numbers in the report come from command output you actually saw, not from memory.
