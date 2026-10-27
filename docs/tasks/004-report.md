# Task 004 — report

Written 2026-10-26 23:3x CDT by the task session (Claude Fable 5.1), after tasks 001–003 in the same session.
Numbers below come from command output seen in this session. No model was called; no network was used; the
only socket opened was D11 and a local smoke run on 127.0.0.1 with the kill switch on.

## What changed

| file | one line |
|---|---|
| `src/ui/auth.ts` | `parseAccounts` (`JUDGE_ACCOUNTS`), `Auth` with random session ids, `HttpOnly; SameSite=Strict` cookie, sessions persisted to `state/sessions/auth.json`; constant-time secret compare |
| `src/ui/sessions.ts` | `JudgeSandbox` (calendar + ledger + outbox + action store + chat log + trace under `state/sessions/<id>/`, seeded from `data/`), `SandboxManager` (demo clock, chat clock, `reset`), `LayeredCache` (samples first, live second), `ReplayGuard` |
| `src/ui/api.ts` | `Api`: `state`, `chat` (intake + relate), `confirm` (incl. *I cannot date this* → `unknown`), `discard`, `plan` (+ checked explanation), `approve`, `undo`, `contrast`, `conflicts`; `seatRows`, `lookupsFor`; `ApiError` → `{ error, reason }` |
| `src/ui/server.ts` | `createRouter` → pure `route(req) → res` (no socket); `/`, `/api/login`, `/api/me`, `/api/logout`, `/api/reset`, `/api/state`, `/api/chat`, `/api/confirm`, `/api/discard`, `/api/plan`, `/api/approve`, `/api/undo`, `/api/contrast`; one `action_id` per request; `startServer` (127.0.0.1 unless HOST) |
| `src/ui/index.html` | the whole screen: top bar (clock, wall pill / red banner, reset, judge, log out), login, four panels; vanilla JS over `/api/*`; no external URL, no framework, no brand names |
| `src/cli/ui.ts` | `npm start` / `npm run ui`: everything from env; prints the bind address |
| `scripts/record-samples.ts` | author-only: refuses without `RECORD_SAMPLES=yes`, with the wall off or without a model id; runs route (a) through the API, plans (b) and (c), tees replies into `cache/samples/`. **Not run by me.** |
| `cache/samples/README.md`, `.gitignore` | `cache/*` ignored, `cache/samples/` tracked |
| `src/spend/guard.ts` | **the one allowed change outside `src/ui`**: read-only `status(sessionId?, lastN)` → `{ state, session: { calls, committed_usd, reserved_worst_usd, limit_usd, refusals }, last, day_usd }` from the ledger |
| `package.json` | `start` and `ui` scripts |
| `.env.example` | `JUDGE_ACCOUNTS`, `HOST`, `PORT`, `DEMO_CLOCK` (small addition to 001's file) |
| `docs/screen.md` | panels, judge sessions, SAMPLE mode and the replay guard, the three demo routes' exact words, the recording recipe, what the screen refuses |
| `README.md` | "Run it" and "Known limits" (decision 003-5's sentence is the first bullet) |
| tests | `src/ui/server.test.ts` (D1–D11) |

No new dependencies. Nothing in `src/engine/`, `src/chat/`, `src/ledger/`, `src/calendar/`, `src/action/`
changed; `src/spend/` only the `status()` above.

## Final test run and commits

```
> tsc --noEmit
 Test Files  20 passed (20)
      Tests  145 passed (145)
```

(132 after task 003 → 145 now; 13 new tests, all offline.)

```
cab4fba docs(screen): the four panels, judge sessions, SAMPLE mode and the three demo routes; README Run it and Known limits
68cbc96 chore(samples): author-only recording script, cache/samples/ tracked, UI variables in .env.example
91c578a test(ui): D1–D11 through route(); D11 binds port 0 and closes
14f9d96 feat(ui): the screen — chat and cards, seat table, calendar and plans, spend — one file, no framework, no CDN
8a889d5 feat(ui): JSON API bound to a judge's sandbox; route() without a socket; npm start
c0477f5 feat(ui): judge accounts with cookie sessions; one seeded sandbox per login; replay guard for SAMPLE mode
038b09e feat(spend): read-only status() for the spend panel — one session's lines and totals from the ledger
3867b59 docs(tasks): decisions on the 003 report; task card 004 (screen, judge sessions, SAMPLE mode)   (hub)
```

Plus the commit carrying this report. All commits carry the `-0500` offset. The suite was run green over the
whole working tree before the seven commits were cut.

**Smoke run** (local, kill switch on, scratch ledger path, port 18787, stopped afterwards, `state/sessions`
removed): `GET /` 200; `GET /api/me` 401 `not_logged_in`; `POST /api/login` 200; `GET /api/state` → judge
`smoke`, clock `2026-11-03T09:00:00-06:00`, wall `{ enabled: false, mode: "sample", reason: "LLM_ENABLED=false…" }`,
49 chat lines, 18 seat rows, 3 conflicts. Server log: `listening on http://127.0.0.1:18787/ (this machine only;
set HOST to expose)`.

## Acceptance

| # | test | result | note |
|---|---|---|---|
| D1 | fresh client, login, first request | ✅ | state = seeds (49 chat lines, 18 seat rows of which 13 PASS, 45 events, empty outbox, `state/sessions/sess-1/ledger/cards.jsonl` exists); after a sentence, a confirm and an approved handoff, `Reset my sandbox` → 49 lines, 16 cards, no drafts, every event `v1` |
| D2 | two judges at once | ✅ | candidates, chat lines, plans and drafts visible only to their owner; spend lines carry each login's own session id (judge1: 2 calls, judge2: 0); judge2 cannot confirm judge1's candidate (404) |
| D3 | `LLM_ENABLED=false` | ✅ | `wall.mode: "sample"`, reason present; banner text in `index.html`; intake → `rules` with the "model is off" note; explanation `template` on plan and contrast; approve, reset work; FakeProvider calls 0 |
| D4 | no accounts in env | ✅ | `/` 200; every API route 401 `no_accounts` with the message; `/api/login` 401 too. With accounts: wrong secret 401, no cookie 401, bad JSON 400, unknown route 404, missing field 400 |
| D5 | each button press | ✅ | injected action ids appear as trace `ref` (`ui.chat`, `ui.confirm`) and plan `details.action_id`; the chat press's two model calls (intake + relate) share one `action_id`; every reserve line's `session_id` = `sess-1` = the cookie session |
| D6 | key never in a body or log line | ✅ | full run through `SpendGuard.fromEnv` with a fake key value and a fake transport (3+ real-path calls): no response body, no log line and no ledger line contains the fake value or `Bearer `; the spend panel does show the ledger path and numbers |
| D7 | conflicts list | ✅ | 11/3, 11/5, 11/6 only; `GET /api/contrast` plans 10/26 (`ready`, `reschedule_own`) and 11/2 (`refused`); `POST /api/plan` on 10/31 → `in_the_past`. **How the 10/26 block is reachable:** the *Show the Monday focus-block contrast* button → `/api/contrast`, which plans both Monday focus-block conflicts regardless of the clock; Approve/Undo work from there |
| D8 | approve → read back → undo | ✅ | via the contrast plan: `v1` → approve `executed`, read-back `v2 2026-10-26T11:30` → second approve returns the stored result, still `v2` → undo `restored`, read-back `v3 09:00` → `/api/state` shows `result` and `undo` on the plan; a second undo is `refused` |
| D9 | T1 end to end through `route()` | ✅ | sentence → candidate (quote verbatim, `same_seat ["pickup.oct3"]`, REPLACES) → confirm as `pickup.nov3` → seat PASS, chain `[nov3, oct3, sept]`, panel-2 row shows the replacement → `✓ Recorded: …` in the chat → plan 11/5 → `draft_handoff` to Jordan, `seat_versions` has `=pickup.nov3`, explanation `model` with the Casey/Madison sentence removed → approve `drafted` → one `handoff` draft, `status: "draft"`; "never sent" in the HTML; the outbox has no `send`. Second case: *I cannot date this* writes `decided_at`/`effective` = `unknown` and the seat reads `UNDATED`; the same dates through plain confirm are refused `unsure` |
| D10 | `index.html` | ✅ | no `http(s)://` except `127.0.0.1` (none present); none of 17 brand names; `lang="en"`; no external `<script src>` / `<link href>`; required copy present |
| D11 | binding | ✅ | `startServer` without host → `127.0.0.1`, random port; `host: "0.0.0.0"` → `0.0.0.0`; both closed |
| D12 | README "Run it" on a clean clone | ⬜ | the steps are written; the hub runs them on a clean clone (the smoke run above was in the working checkout, not a fresh clone) |

## Questions for the author

1. **SAMPLE mode and `src/chat` (not mine to change).** `intake()` / `relate()` / `explainPlan()` check
   `guard.state().enabled` *before* the model client looks in the cache, so with the real wall off a recorded
   reply would never be read. I did not touch `src/chat`; instead `sessions.ts` has a **`ReplayGuard`** that the
   UI hands to those three functions while the wall is off: its `state()` reports enabled with reason
   `replay: recorded replies only (…)`, its provider refuses every cache miss with
   `ProviderError("refused")`, its `call()` always refuses, and nothing is reserved or spent. The banner shows
   the **real** wall state. If you would rather have `src/chat` consult the cache first and drop the replay
   guard, that is a three-line change in each of the three files; say so and I (or 005) will do it.
2. **`NEBIUS_MODEL` must be set even in SAMPLE mode** — it is part of the cache key the samples were recorded
   under. Without it the replay guard reports disabled and the rule fallback runs. `.env.example` has a default.
3. **"I cannot date this" lives in `api.ts`**, not in `confirm()` (frozen): the other fields are checked with
   placeholder dates, then the card is written with `decided_at`/`effective` = `unknown` via `store.addCard`,
   with no edges (an undated card cannot be ordered). Decision 003-3 says nothing else may produce `unknown`;
   plain `confirm` refuses it (tested).
4. **The chat clock** = the demo clock plus the time elapsed since the server started, so a judge's December
   sentence is stamped 2026-11-03 09:0x and never reads as "decided after now" (`FUTURE`) at the demo clock.
   Written in `docs/screen.md` § Judge sessions. If you want real wall-clock stamps, the seats view's `FUTURE`
   rule would need the clock moved too.
5. **Per-login session budget.** A judge who logs in again gets a new session id, a fresh sandbox and a fresh
   `SPEND_SESSION_USD`; the day and total budgets still bound everything. The card said "per login"; README
   "Known limits" says it. If you prefer per-judge-name budgets, `auth.ts` could key the spend session by name.
6. **Judge sessions are persisted** to `state/sessions/auth.json` so a server restart keeps cookies valid and
   sandboxes attached; the file holds names and session ids, no secrets.
7. **The calendar grid groups events by the Chicago date written in `start`** (the first 10 characters of the
   stored string). Every seed timestamp is Chicago-offset, so this is exact; an event written with another
   offset would land on the wrong column — the store accepts any offset. A later task could render from
   instants.
8. **`seats-view`'s `UNRESOLVED_CONFLICT`** is shown as `UNRESOLVED` in panel 2 (the card's wording); the API
   returns the full state name.
9. **D12** is the hub's clean-clone run; the README steps assume `set -a; source .env; set +a` or an equivalent
   way to export the variables, and `npx tsx scripts/spend-status.ts init` before `npm start` (without the
   ledger file the wall stays off and the screen runs in SAMPLE mode — which is also a valid first run).
10. **No screenshots** were taken (not part of acceptance); the smoke run confirms the server, the login, the
    state route and the banner state. The hub takes the screenshots.

## What a hook blocked

Nothing in this task. (The smoke run started the server with `LLM_ENABLED=false` and a scratch ledger path and
made no model call.)

## Hub addendum — D12 and the browser walkthrough (2026-10-26 23:3x CDT, hub session)

- **D12 ✅** on a fresh `git clone` of `235f616` into a scratch directory: `npm ci` → typecheck clean → 145/145
  offline → `.env` from `.env.example` with test judge accounts, `LLM_ENABLED=false`, port 18790 →
  `npx tsx scripts/spend-status.ts init` → `npm start` printed `listening on http://127.0.0.1:18790/ (this
  machine only; set HOST to expose)`. Probed from a second process: `GET /` 200 (24,444 bytes), `GET /api/me`
  401 `not_logged_in`, `POST /api/login` 200 with an `HttpOnly` cookie, `GET /api/state` 200 with judge,
  clock `2026-11-03T09:00:00-06:00`, wall `{ enabled: false, mode: "sample" }`, 49 chat lines, 18 seat rows,
  3 conflicts.
- **Browser walkthrough** (built-in browser, same clean clone): login form → four panels rendered with the red
  SAMPLE banner; panel 2 shows the overturn chain ("replaced ‹Focus blocks may be moved …› (2026-09-02)");
  *Show the Monday focus-block contrast* → 10/26 `ready` (move to 11:30–13:30) and 11/2 `refused` with the
  10/20 decision and the one it replaced → **Approve** → `executed · read back v2 2026-10-26 11:30–13:30` →
  **Undo** → `restored (v3 2026-10-26 09:00)`; panel 4 shows the wall off, 0 calls, $0.0000, limits $0.15 /
  $3 / $47.
- **One bug found and fixed** (`2aa17dd`): the *Plan* button on each conflict card was white on near-white —
  it carried the class `plan`, which the plan card's CSS rule also matched (computed color `#fff` on
  `#f7f9fc`). Renamed to `plan-btn`; after the fix the computed style is white on `rgb(43,76,126)`. D10's
  text checks could not see this; a styled-element check (button text colour ≠ background) is a candidate
  for 005.
- **Observed, not fixed:** after a server restart the browser landed on the login form again although
  `state/sessions/auth.json` had kept the sessions (3 entries). Either the cookie was not re-sent by this
  browser or the restart invalidated it; not investigated tonight. For judges this means "log in again after
  a deploy", which is acceptable; 005 may look.
- Server stopped afterwards; the scratch clone is outside the repository.
