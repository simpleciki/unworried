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

## From 003 (hub verified 132/132 offline at 23:1x CDT)

| # | question | decision |
|---|---|---|
| 1 | seed is 49 messages, not 60–100 | Fine. Every trap and every fixture card is in it. Add texture only if the demo recording needs it (task 004 decides from the screen, not from a count). |
| 2 | `same_seat` = seat heads + undated cards | Accepted. |
| 3 | "undated" comes from the user reporting old notes; `decided_at: "unknown"` | Accepted. Task 004's confirmation card offers an explicit "I cannot date this" choice that writes `unknown`; nothing else may produce it. |
| 4 | rule-fallback `quote` is unsure | Accepted. |
| 5 | the explanation check is lexical | Accepted for the hackathon; **README "Known limits" must say so in one sentence** (a sentence made only of common lowercase words would pass). No second model call to judge a model. |
| 6 | `chicagoOffsetMinutes(y, m, d)` kept as a date-level approximation | Keep, with its comment. |
| 7 | human relation wins and is recorded `source: "human"` on the edge line | Accepted. |
| 8 | `seats-view.ts` change travelled in the time refactor commit | Noted; no rewrite of history. |

## From 004 (hub verified 145/145 offline at 23:3x CDT; D12 clean-clone run by the hub, see 004-report addendum)

| # | question | decision |
|---|---|---|
| 1 | SAMPLE mode via a `ReplayGuard` because `src/chat` checks the wall before the cache | Accepted for the hackathon. The cleaner change (chat consults the cache before asking the wall) goes on the 005 list if there is time after the author has seen the screen; not before. |
| 2 | `NEBIUS_MODEL` must be set even in SAMPLE mode (cache key) | Accepted; `.env.example` has it. README "Run it" must say it in one line. |
| 3 | "I cannot date this" implemented in `api.ts` | Accepted. |
| 4 | chat clock = demo clock + elapsed since server start | Accepted; it keeps a December judge's sentence from reading as `FUTURE`. Written in `docs/screen.md`. |
| 5 | budget per login, not per judge name | Accepted (the day and total walls still bound everything). |
| 6 | sessions persisted to `state/sessions/auth.json`, no secrets | Accepted. |
| 7 | calendar grid groups by the Chicago date prefix of `start` | Accepted for the seed; listed under Known limits. |
| 8 | `UNRESOLVED` wording in panel 2 | Accepted. |
| 9–10 | D12 and screenshots | Hub. |

## Hook blocks

Two in the hub (a Python script that *wrote documentation* containing the Token Factory hostname), one in
the task session (a `sed` + `grep` mentioning the key's env name), then two more in the hub (a `sed` with the
old hostname; a Python script whose observation text named the key's env variable). All five were false
positives of the money guard on text that made no call. Recorded in the hub's observation queue (#025); the
guard is not being changed during the hackathon.
