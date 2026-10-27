# Decisions on the task reports — 2026-10-26 (hub session, after tasks 001 and 002)

Answers to the "Questions for the author" in `001-report.md` and `002-report.md`. "Hub" = the author's
coordinating session; "Ciki" = the author herself. Later tasks follow these.

## From 001

| # | question | decision |
|---|---|---|
| 1 | `src/engine/time.ts` treats the DST transition days as a single offset | Real bug, low impact. **Unfreeze for this one fix only** in task 003: `fix(engine): resolve the Chicago offset from the instant`, with a test for 2026-11-01 00:30 CDT and 2026-03-08. Nothing else in `src/engine/` changes. |
| 2 | model ids and prices provisional | Official sources checked by the hub on 2026-10-26: Nebius's Nemotron page uses `nvidia/nemotron-3-super-120b-a12b`; the Token Factory cookbook lists `nvidia/Nemotron-3_5-Lightning` (1M context) and `nvidia/Nemotron-3-Ultra-550b-a55b` as current, and the Nano 30B / Nano Omni ids under "not currently featured". `config/prices.json` now carries Lightning and Super only. **Prices stay unverified** until Ciki reads the console prices page (login required) — the guard refuses unknown ids, so a wrong price can under-book but a wrong id cannot leak spend. Default candidate for all call kinds: Lightning; Super only if Lightning's JSON discipline is poor. Never Ultra. |
| 3 | base URL | Official quickstart: `https://api.tokenfactory.nebius.com/v1/`. `.env.example` and `docs/spend-wall.md` corrected. Still read from env only. |
| 4 | failed attempts booked at worst case | Keep (conservative). |
| 5 | `LLM_ENABLED` unset = enabled | Keep; the other walls refuse without key / model / ledger. |
| 6 | call kinds | Task 003 defines `intake` (512), `relate` (256), `explain` (512) in `SPEND_MAX_TOKENS_<KIND>` defaults. |
| 7 | `asProvider()` | Keep; task 003 puts `ModelClient` on top of it. |

## From 002

| # | question | decision |
|---|---|---|
| 1 | resolve seats at the conflict instant, refuse `FUTURE` cards | Accepted. That is what "the decision that governs that moment" means; the demo clock only bounds which conflicts the UI offers. |
| 2 | seat values read from the quote's sentence shape | Quotes must stay the user's exact words (engine rule), so **add a value side table** in the decision ledger store (task 003): `card_id → value` in the shapes `data/vocab.yaml` documents. `seats-view.ts` reads the side table first and falls back to quote parsing; task 003 may edit `seats-view.ts` for that one purpose. The engine's types do not change. |
| 3 | undated cards invisible to the engine's `asOf` filter | Accepted as handled (`UNDATED` scan first). Note it in `docs/action-layer.md` "limitations" if not already there. |
| 4 | T10 forbids moving every focus block from 11/2 | Keep as encoded. The demo contrasts 10/26 vs 11/2, which this supports. |
| 5 | `status` / `refusal` / `at` on `ActionPlan` | Keep. |
| 6 | pickup that wins needs no backup lookup | Correct. |
| 7 | pickups with other attendees refused | Keep. |
| 8 | free-slot search ignores the clock | Keep in the planner; the UI (task 004) offers only conflicts at or after the demo clock. |
| 9 | duplicated Chicago time helpers | Task 003 moves them to `src/time/chicago.ts` and makes `spend/ledger.ts` and `calendar/port.ts` import it (pure move, tests unchanged). |
| 10 | extra invented names (Casey, Devin, Harper, places) | Fine. Keep them out of any list of "the people" that implies a real household. |

## Hook blocks

Two in the hub (a Python script that *wrote documentation* containing the Token Factory hostname) and one in
the task session (a `sed` + `grep` mentioning the key's env name). All three were false positives of the
money guard on text that made no call. Recorded; the guard is not being changed during the hackathon.
