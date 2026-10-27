# Task 004 — The screen: chat, cards, calendar, plans, spend; judge sessions; SAMPLE mode

Read `docs/tasks/000-shared-rules.md`, `docs/tasks/decisions-2026-10-26.md` (all three sections), then this
card. You build on 001–003; read `src/chat/*.ts`, `src/ledger/store.ts`, `src/action/{detect,plan,execute,
undo,seats-view}.ts`, `src/calendar/*.ts`, `src/spend/guard.ts`, `src/outbox/drafts.ts` and their tests first.

## Why this task exists

Judges (and the author, on 10/29 with a fresh browser) must be able to **log in, type one sentence, confirm one
card, see a conflict's plan change, approve it, read the calendar back, undo it, and see what it cost** —
without a key in their hands and without being able to spend more than their session budget. The screen is
also the author's acceptance interface: she designs and verifies, she does not read code. Judges review
12/1–12/15 with the demo clock fixed at 2026-11-03 09:00 (−06:00).

## Files you own

```
src/ui/server.ts           Node http, 127.0.0.1 by default (HOST / PORT env for hosting); one route() function that is unit-testable without a socket
src/ui/api.ts              the JSON handlers, each bound to one judge session
src/ui/auth.ts             judge accounts from JUDGE_ACCOUNTS env ("name:secret,name:secret"); cookie session; no accounts → the site shows only the login page
src/ui/sessions.ts         one sandbox per judge: calendar store + ledger store + outbox + action store + spend session id; reset
src/ui/index.html          the whole screen, one file, no framework, no CDN (judges may be offline from CDNs; no third-party trademarks on screen)
src/ui/*.test.ts
src/cli/ui.ts              `npm run ui` / `npm start`
scripts/record-samples.ts  (author only, inside her approval window) replays the three demo routes with the real model and tees the replies into cache/samples/
docs/screen.md             what each panel shows and what it refuses to do
```

You may add `"start"` and `"ui"` scripts to `package.json`. Nothing in `src/engine/`, `src/spend/`,
`src/chat/`, `src/ledger/`, `src/calendar/`, `src/action/` changes except: `src/spend/guard.ts` may gain a
read-only `status()` if the spend panel needs a field that is not exposed yet (say so in the report).

## The screen (English copy; one page, four panels; works at 1280 px wide and on a phone)

**Top bar.** Product name; the demo clock ("Demo clock: Tue 2026-11-03 09:00 CST"); the wall state —
`Model: on · session budget $0.11 of $0.15 left` or a red banner `Model is off (reason) — showing recorded
replies; nothing here is live` when `SpendGuard.state(session)` is not enabled; a `Reset my sandbox` button;
the judge's name and `Log out`.

**Panel 1 — Tell me what changed (chat).** A text box ("From next Thursday Jordan picks up Theo.") and the
conversation (seed messages first, newest at the bottom). Sending a sentence calls `intake()` → each candidate
renders as a **card**: quote (verbatim, highlighted inside the message), mode, topic / facet / scope, decided
by, decided at, effective, value, and each `unsure` field as an input with the note from intake. If
`same_seat` is non-empty the card shows the current head(s) and the relation the model proposed
(REPLACES / REFINES / SAME / UNRELATED, with the Skeptic's one line) as a radio the user may change ("human
relation wins"). A `decided_at` field offers "I cannot date this" → `unknown` (decision 003-3). Buttons:
**Confirm** (disabled while any field is unsure, with the reason) and **Discard**. After confirm, the card
collapses into the conversation as "✓ Recorded: …" and panel 2 refreshes.

**Panel 2 — What holds today (seats).** The seat table at the demo clock from `LedgerStore.seatsView`: one
row per seat the vocabulary knows — state (PASS / NOT_FOUND / UNRESOLVED / AMBIGUOUS / UNDATED / FUTURE),
the card in effect (quote, decided at, by), and the overturn chain as "replaced ‹older quote› (date)". Rows
that are not PASS say in one sentence what the assistant will refuse to do because of it.

**Panel 3 — Calendar and conflicts.** Two weeks (10/26–11/08) as a simple week grid; events with other
attendees marked; conflicts **at or after the demo clock** listed (decision 002-8), each with a **Plan** button
→ the `ActionPlan`: status, the step(s) in plain words ("move *Focus block* to Mon 11:30–13:30" / "draft a
handoff to Jordan" / "refused: …"), the template explanation and, when the model is on, `explanation_prose`
with removed sentences shown struck-through under "not supported by the plan". Buttons: **Approve** (runs
`executePlan` with the approval flag) → the `ExecutionResult` with each step's read-back; **Undo** when an
`undo_token` exists → result. Drafts appear in a small **Outbox** list with "never sent" in the header.
Re-planning after a seat changed shows the `refused` ("your arrangements changed…") message rather than
silently re-planning.

**Panel 4 — What it cost.** From the spend ledger for this session: calls, USD spent, worst-case reserved,
session limit, the last 10 ledger lines (kind, model, tokens, USD), the global day total, breaker state.
Every number comes from `state/spend-ledger.jsonl`; nothing is computed in the browser.

Loud failures: a request the server refuses returns JSON `{ error, reason }` and the panel shows it in red
where the user clicked. No toast that disappears.

## Judge sessions and sandboxes

- `JUDGE_ACCOUNTS="judge1:…,judge2:…,ciki:…"` (secrets only in env; the Devpost form will carry them). Login
  sets an `HttpOnly` cookie with a random session id; the id is the `session_id` for calendar, ledger, outbox
  and the **spend wall** (so one judge cannot spend another's budget; `SPEND_SESSION_USD` applies per login).
- First request after login copies the seeds: calendar from `data/calendar-seed.json`, ledger from
  `data/conversation-seed.jsonl` via the same code `scripts/seed-ledger.ts` uses. `Reset my sandbox` wipes and
  re-seeds that judge only.
- No accounts configured → every route except `/login` returns 401 and the page says so. There is no
  anonymous mode.
- `action_id` for the wall = one request id per button press (intake / relate / explain are separate kinds
  but one `action_id`), so `SPEND_ACTION_*` bounds one click.

## SAMPLE mode (the kill switch and the budget walls, seen from the screen)

- When `guard.state(session).enabled` is false: the banner; intake runs its rule fallback (003 C7); explanations
  show the template; **everything else works** (seats, calendar, plans, approve, undo, spend panel).
- `cache/samples/`: the `FileCache` tee from `src/llm/cache.ts`. `scripts/record-samples.ts` (author only,
  inside her approval window) runs the three demo routes against the real model and tees every reply into
  `cache/samples/`; the UI's `ModelClient` reads `cache/samples/` first, so the demo's scripted sentences get
  their recorded replies even when the wall is closed. The three routes are: (a) the T1 Thursday sentence →
  card → confirm → re-plan the 11/5 conflict; (b) the T3 Saturday conflict → refused → "which one counts?";
  (c) the 10/26 vs 11/2 focus-block pair. Write the exact sentences into `docs/screen.md` so the recording and
  the video use the same words.
- `cache/` is gitignored except `cache/samples/` (add the exception; `unexplained` does the same).

## Acceptance (D = demo / hosting)

| # | test | passes when |
|---|---|---|
| D1 | fresh client, login, first request | its own seeded sandbox; `Reset my sandbox` returns to the seed (calendar + ledger + outbox) |
| D2 | two judges act at once | each sees only their own writes, candidates, drafts and spend lines |
| D3 | `LLM_ENABLED=false` | every route answers; banner text present; intake falls back; explanation is the template; zero provider calls |
| D4 | no accounts in env | every route but `/login` is 401 with a message |
| D5 | each button press | exactly one `action_id` per press in the trace; the spend ledger's `session_id` equals the login's |
| D6 | grep every HTTP response body and every log line in a full test run | the key's env value never appears (seed the test env with a recognisable fake value) |
| D7 | conflicts list | only conflicts whose overlap starts at or after the demo clock; the 10/26 focus block is still reachable through the T10 contrast view (say how) |
| D8 | approve → read back → undo from the API | the calendar store's versions move `v1 → v2 → v3`; the UI shows each read-back |
| D9 | the T1 route end to end through `route()` (no socket) | sentence → candidate → confirm (REPLACES) → seat PASS new card → re-plan 11/5 → `draft_handoff` to Jordan → outbox has one draft, "never sent" |
| D10 | `index.html` | no external URL (`http://`, `https://`) except `127.0.0.1`; no third-party brand names; English |
| D11 | `npm start` with `HOST=0.0.0.0 PORT=3000` | binds as told; without `HOST` binds 127.0.0.1 only |
| D12 | README "Run it" | a fresh clone + `npm ci` + the documented env + `npm start` reaches the login page (write the steps; the hub will run them on a clean clone) |

Screenshots are **not** part of this task's acceptance (the hub takes them); text assertions through
`route()` are.

## Done looks like

`npm run typecheck && npm test` green including D1–D11; `docs/screen.md` written (panels, refusals, the three
demo routes' exact sentences, the recording recipe for the author); README gains "Run it" and "Known limits"
(including decision 003-5's sentence); `docs/tasks/004-report.md` per the shared rules. Small commits. No real
model call. If a hook blocks a command, stop and report. If context runs short, commit what is green and
report with ⬜ rows.
