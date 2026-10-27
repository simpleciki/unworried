# The screen

One page, four panels, no framework, no CDN: `src/ui/index.html`, served by `src/ui/server.ts`. A judge logs
in, types one sentence, confirms one card, sees a conflict's plan change, approves it, reads the calendar
back, undoes it, and sees what it cost — without a key in their hands and without being able to spend more
than their session budget. The demo clock is fixed at **Tue 2026-11-03 09:00 CST**.

## Top bar

| element | shows | refuses |
|---|---|---|
| Demo clock | `Demo clock: 2026-11-03 09:00 (CST)` from `DEMO_CLOCK` | — |
| Wall pill | `Model: on · session budget $X of $0.15 left`, both numbers from the spend ledger for this login | — |
| Red banner | `Model is off (reason) — showing recorded replies; nothing here is live` whenever `SpendGuard.state()` is not enabled | — |
| Reset my sandbox | wipes and re-seeds **this judge's** calendar, ledger, outbox, chat and plans | never touches another judge |
| Judge name · Log out | the login's name; logout clears the cookie | — |

## Panel 1 — Tell me what changed

The conversation (seed first, newest at the bottom) and a text box. Sending calls `intake()` then, for each
decision with cards already on its seat, `relate()`. Each candidate renders as a **card**:

- the message with the quote highlighted (the quote is verbatim, or the field is unsure),
- mode · topic / facet / scope · decided by · decided at · effective · value,
- every `unsure` field as an input, with intake's note (`the model is off; fill the card yourself`, `a
  question is a mention, not a decision`, …),
- `recorded at` beside `decided at` when they differ (a sentence that named an earlier moment),
- if `same_seat` is non-empty: the current head(s) with the Skeptic's one-line note and a radio
  REPLACES / REFINES / SAME / UNRELATED — **your choice wins** and is recorded as the human's,
- **I cannot date this** — writes the card with `decided_at` and `effective` = `unknown`; it is then never
  ordered against the other cards on its seat (any conflict there is refused and both shown). This checkbox is
  the only thing in the product that produces `unknown` (decision 003-3).

Buttons: **Confirm** (disabled while any field is unsure, saying which) and **Discard**. After confirm the
card disappears and the conversation gains `✓ Recorded: "…" — decided …, in force from …; replaces …`; panels
2–4 refresh. A refusal from the server (`{ error, reason }`) is shown in red under the card; it does not
vanish.

## Panel 2 — What holds today

One row per seat the vocabulary knows (5 priority, 5 movable, 7 weekday pickup backups, working hours),
resolved at the demo clock from the judge's ledger: state (`PASS` green; `NOT_FOUND`, `UNDATED`, `AMBIGUOUS`,
`UNRESOLVED`, `FUTURE`, `UNREADABLE` red), the card in effect (quote, value, decided at, by), the overturn
chain as `replaced ‹older quote› (date)`, and for every non-PASS row one sentence saying what the assistant
will refuse because of it ("Will refuse to draft a handoff for a saturday pickup (conflict reported only) —
2 arrangement(s) … none can be dated …").

## Panel 3 — Calendar and conflicts

Two weeks (10/26–11/08) as a 7-column grid, seven columns on a phone become two; events with other attendees
are marked (orange edge, "with …"); every event shows its version. Below: **conflicts whose overlap starts at
or after the demo clock** (11/3 Tuesday pickup × flight, 11/5 Thursday pickup × flight, 11/6 design review ×
demo-day pickup). Each has **Plan** → the `ActionPlan`: status, steps in plain words ("move *…* from … to …",
"draft a handoff to Jordan (never sent)"), the template explanation, and when the model is on the checked
`explanation_prose` with removed sentences struck through under "not supported by the plan", plus
`depends on: seat=card`. **Approve** runs `executePlan` with the approval flag and shows the result with every
step's read-back (`v2 2026-10-26 11:30–13:30`); **Undo** appears when an `undo_token` exists and shows its
result. Approving the same plan twice returns the stored first result. If a seat changed after planning,
Approve shows `refused — your arrangements changed after this plan was made: …` in red; nothing is re-planned
silently.

**The T10 contrast** (decision 002-8: the main list hides conflicts before the clock): the button *Show the
Monday focus-block contrast (10/26 vs 11/2)* calls `GET /api/contrast`, which plans the two Monday
focus-block conflicts side by side — 10/26 `ready` (move to 11:30–13:30, the September rule allows it) and
11/2 `refused` (the 10/20 rule, in force from 11/2, forbids it). The 10/26 plan can be approved and undone from
there; it is how D8 reads `v1 → v2 → v3`.

**Outbox** lists drafts (`handoff` / `message`, to whom, subject, body) under a header that says *drafts only,
never sent*. There is no send button and no send code.

## Panel 4 — What it cost

From `state/spend-ledger.jsonl` only (`SpendGuard.status(session_id)`): wall on/off and why, model, breaker;
this session's calls, USD spent (committed), worst case reserved, refusals, session limit; today's total
across sessions and the all-time total against their limits; the ledger path and whether it is readable; the
last 10 ledger lines for this session (at, kind, model or limit, tokens, USD with actual/booked). Nothing is
computed in the browser.

## Judge sessions

`JUDGE_ACCOUNTS="judge1:…,judge2:…,ciki:…"` (secrets only in env). Login sets an `HttpOnly; SameSite=Strict`
cookie with a random session id; that id names the judge's sandbox directory `state/sessions/<id>/` (calendar
JSON, ledger JSONL, outbox, chat log, trace) and is the `session_id` on every spend-ledger line, so
`SPEND_SESSION_USD` applies per login. Sessions are kept in `state/sessions/auth.json` across restarts. With
no accounts configured every route but `/`, `/api/login` and `/api/me` answers 401 `no_accounts`; the page
shows the reason on the login form. There is no anonymous mode. Every button press is one request and one
`action_id` (trace `ref`, spend ledger `action_id`), so `SPEND_ACTION_*` bounds one click.

**The chat clock** stamps every new chat line: the demo clock plus the time elapsed since the server started,
so a judge's sentence typed in December reads as said on 11/3 and never as "decided after now" (`FUTURE`).
After a restart it starts one second past the latest chat line already under `state/sessions/`, never back at
the demo clock — otherwise a sentence said after a restart would be stamped before one said earlier, and the
newer decision would be ordered as the older one (test D13). The demo clock itself never moves.

## SAMPLE mode

When the wall is off (`LLM_ENABLED=false`, budget, breaker, no key): the banner; `intake` runs its rule
fallback; `explain` shows the template; everything else works (seats, calendar, plans, approve, undo, spend).
**Recorded replies:** the screen's model client reads `cache/samples/` first (then `cache/live/`). While the
wall is off the UI hands intake / relate / explain a *replay guard* that reports "enabled" so the client looks
in the cache, and whose provider refuses every cache miss — no call leaves the machine, nothing is reserved
or spent, and the banner still shows the real wall state. So the demo's scripted sentences get their recorded
replies; any other sentence gets the rule fallback. `NEBIUS_MODEL` must be set to the id the samples were
recorded with (it is part of the cache key).

### The three demo routes (use these exact words)

| route | what to do | what the screen shows |
|---|---|---|
| (a) T1 | type **`Change of plan: Thursdays I pick up, backup Jordan — Alex is travelling Thursdays now.`** → the card (quote highlighted, value `backup Jordan`, head `pickup.oct3`, proposed REPLACES with the Skeptic's note) → Confirm → panel 2's Thursday row shows the new card and `replaced ‹Thursdays I pick up, backup Jordan› (2026-10-03)` → Plan the 11/5 conflict → `draft a handoff to Jordan (never sent)` → Approve → the outbox draft | Jordan, never Alex; the chain |
| (b) T3 | Plan is not offered for 10/31 (before the clock); open the Saturday row in panel 2: `UNDATED`, both fridge notes quoted, "Will refuse to draft a handoff for a saturday pickup" → type **`Which Saturday note counts?`** → the assistant answers it is a question (mention), nothing changes | the product asks instead of guessing |
| (c) T10 | *Show the Monday focus-block contrast* → 10/26 `ready` (move to 11:30–13:30, "Focus blocks may be moved for a meeting", 2026-09-02) · 11/2 `refused` ("the Monday focus block may not be moved", decided 2026-10-20, replacing the September rule) → Approve 10/26 → read-back `v2` → Undo → `v3` | decided ≠ in force; the overturn chain in the refusal |

### Recording recipe (author only, inside an approval window, in her own terminal)

```bash
RECORD_SAMPLES=yes LLM_ENABLED=true NEBIUS_MODEL=<id> npx tsx scripts/record-samples.ts
npx tsx scripts/spend-status.ts            # reconcile what it cost
git add cache/samples && git commit -m "chore(samples): recorded replies for the three demo routes"
```

The script refuses without `RECORD_SAMPLES=yes`, with the wall off, or without a model id. It runs route (a)
through the same API handlers the screen uses, plans (b) and (c), and tees every reply into `cache/samples/`.

## What the screen refuses to do

- Show anything without a login; let one judge see or spend another's sandbox or budget.
- Confirm a card with an unsure field; confirm "unknown" dates by any path other than *I cannot date this*.
- Plan a conflict before the demo clock from the main list (`in_the_past`; the contrast view is explicit).
- Approve a plan whose seats changed; approve twice (returns the first result); undo an event changed since.
- Send anything: drafts stay in the outbox.
- Call a model when the wall is off (the replay guard only reads the cache).
- Compute spend in the browser; hide a refusal in a toast.
