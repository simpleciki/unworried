# Task 005 — Visual pass: "A's layout + B's strike-through"

Decided 2026-10-27 19:48 CDT by the author: *"要 A+B 轻版，按这个写设计卡并实现。"* The mock-up is
`docs/design/directions.html` → button **A+B light**. This task restyles and rearranges `src/ui/index.html`; it
changes no behaviour. Every row of `docs/screen.md` (top bar, the four panels, SAMPLE mode, the three demo
routes, "What the screen refuses to do") must still hold word for word where it names on-screen text.

## Why

The 004 screen is an engineer's acceptance view: `topic | facet | scope` codes, plan ids and `PASS` in a
table. A judge cannot see in five seconds that the product takes worry off a parent. "Looking good" is now
judged too (author, 10/27). The product's one idea — **which arrangement is in force, and which one it
replaced** — becomes the visual centre, in the shape of a ledger entry with the replaced sentence struck
through in red.

## Files you own

`src/ui/index.html` (one file, no framework, no CDN, no external URL, no third-party brand names — test D10)
and the layout paragraph of `docs/screen.md`. Nothing else changes.

## Look

| token | value | used for |
|---|---|---|
| paper | `#f6f2ea` | page |
| card | `#fffdf8` | panels (radius 18–22 px) |
| ink / mute / line | `#2a2723` / `#8a8277` / `#e6dfd2` | text, secondary text, rules |
| sage / sage-bg | `#4f7a5d` / `#e5efe6` | in force, OK, primary buttons, "my" chat bubbles |
| clay | `#b4532a` | needs you, "never sent" stamp, asks |
| red | `#b3261e` | the strike-through on a replaced sentence, and real errors only (an API error, a rollback) |

Colour follows meaning (author, 2026-10-27 20:01: too much red reads as "the product is all errors"): a seat
with nothing decided is grey *not set*; a seat the product will ask about (`UNDATED` …), a `refused` plan and
the SAMPLE banner are clay — the product asking instead of guessing is the feature, not a fault.
| UI face | `ui-rounded, system-ui` | everything a person reads as interface |
| quote face | `ui-serif, Georgia` | a person's own words (card quotes, the chain) |
| mono | `ui-monospace` | dates in ledger entries, ids, the ledger tail |

Dark mode is not in scope (judges' browsers vary; one tested look is safer than two half-tested ones).

## Layout (1280 px; on a phone everything becomes one column)

1. **Top bar** — `un`**`worried`** · `Demo clock: …` · wall pill · judge · Reset my sandbox · Log out; the red
   SAMPLE banner below it, unchanged in words.
2. **Conflict strip** — one chip per conflict at or after the clock (weekday + date, the two titles); the
   selected chip is the hero. Empty → "No conflicts at or after the demo clock."
3. **Left column**
   - **Hero = Calendar and conflicts, the selected conflict**: kicker (`Thursday needs you · 2 of 3`), the two
     events in plain words with times, then **Why** — for every seat the plan depends on, a ledger entry: the
     card in force (sage *In force* stamp, date, quote in serif) and the card it replaced (date, quote struck
     through in red). Then the plan: steps in plain words, the draft (to, subject, body) under a clay
     *never sent* stamp, the template explanation, the checked model prose with removed sentences under
     "not supported by the plan", `depends on: …`, Approve / Undo, the result with every read-back.
   - **Your two weeks** — the 7-column calendar grid (2 columns on a phone), other-attendee edge, versions.
   - **The Monday focus-block contrast** button and its two plans (same plan view as the hero).
   - **Outbox — drafts only, never sent.**
4. **Right column**
   - **Tell me what changed** — chat bubbles (me right on sage, assistant left), the text box, the candidate
     cards: quote in serif with the highlight, the fields, unsure inputs, *I cannot date this*, the
     REPLACES / REFINES / SAME / UNRELATED radios, Confirm / Discard as pills, refusals in red under the card.
   - **What holds today** — one row per seat, grouped (Who picks up Theo · What comes first · What may move ·
     Working hours): plain label, value in force, state badge when not PASS (red, the state's name), the
     replaced quote struck through in red with its date, and the refusal sentence.
   - **What it cost** — open by default; the same numbers as 004 (wall, model id from the server, breaker,
     session, today, all time, ledger path, last 10 lines) plus three bars drawn from those numbers.

## Acceptance

- `npx vitest run` passes (D10 included); `npx tsc --noEmit` clean.
- Local run with `LLM_ENABLED=false`: log in; the three demo routes of `docs/screen.md` work by clicking, at
  1280 px and at a phone width; screenshots of the hero after Plan → Approve → Undo on 11/5.
- No new endpoint, no change to any `/api/*` response.

## Addendum 2026-10-27 20:10 — calm by default

Author: *“当前就是细节太多了要读的太多了反而不像‘无忧助手’……尽量让你少操心，能帮你处理好的就帮你处理了还让你觉得安心可靠。”*
Rule: lead with what is handled; every detail stays one click away, nothing is removed. What changed is in
`docs/screen.md` ("Calm by default").
