# Task 002 — report

Written 2026-10-26 22:4x CDT by the task session (Claude Fable 5.1), after task 001 in the same session.
Everything below comes from command output seen in this session. No model was called; no network was used.

## What changed

| file | one line |
|---|---|
| `src/calendar/port.ts` | `CalendarPort`, `CalEvent`, `VersionMismatch`; `instant()` (refuses timestamps without an offset); Chicago helpers `chicagoParts` / `chicagoIso` / `chicagoLocal` |
| `src/calendar/json-store.ts` | one JSON file per session copied from the seed; `list` / `get` / `update(expected_version)` / `reset`; `v1 → v2` versions; temp-file + rename writes; loud validation |
| `src/calendar/ics.ts` | iCalendar export (UTC instants, DATE for all-day, `X-UNWORRIED-*` for the rest), folding and TEXT escaping |
| `src/action/seats-view.ts` | the four lookups (priority / movable / pickup_backup / working_hours) over the engine's `SeatGraph`; states PASS / NOT_FOUND / UNRESOLVED_CONFLICT / AMBIGUOUS / UNDATED / UNREADABLE / FUTURE; value parsers for the documented quote shapes |
| `src/action/detect.ts` | buffered half-open intervals on instants; all-day only with all-day; `conflict_id` = hash of sorted `id@version` |
| `src/action/plan.ts` | `planConflict` (priority → loser → handoff / draft / reschedule / refused) and `findSlots`; explanation template citing the decision, its date, its author and what it replaced |
| `src/action/execute.ts` | `executePlan`: approval flag → seat re-check → steps → read back → reverse rollback; `ActionStore` (results, undo records); `withTimeout` 2 s; `matches()` |
| `src/action/undo.ts` | all-or-nothing restore when every current version equals the one written; single-use tokens |
| `src/action/trace.ts` | `MemoryTrace` / `JsonlTrace`; every line carries `model: null, usd: null` for later tasks |
| `src/outbox/drafts.ts` | `Outbox.add` / `list`; no send method exists |
| `data/vocab.yaml` | topics / facets / scopes / scope_parent / deciders for this domain, plus `categories` and `people`; the quote shapes each seat value is read from |
| `data/calendar-seed.json` | 45 fictional events, 2026-10-26 → 2026-11-08, recurring ones expanded; 3 events on 10/31 (−05:00), 3 on 11/01 (−06:00) |
| `data/README.md` | ALL DATA IS FICTIONAL; the cast; the seven deliberate conflicts |
| `docs/action-layer.md` | how it works, the seat table, what it refuses, v1 limitations |
| `src/action/fixtures.test-helpers.ts` | Morgan's decision cards built by hand (priority ranks, movable, working hours, T1/T3/T6/T10) and helpers over the seed |
| tests | `src/action/detect.test.ts` (A1, A2), `src/action/plan.test.ts` (A3–A6, A11, A12 + refusals), `src/action/execute.test.ts` (A7–A11, A13), `src/calendar/store.test.ts` (A14 + versions + validation), `src/calendar/ics.test.ts` (A15) |

No new dependencies. `src/engine/`, `src/spend/`, `src/llm/` untouched in this task.

## Final test run and commits

```
> tsc --noEmit
 Test Files  15 passed (15)
      Tests  104 passed (104)
```

(68 after task 001 → 104 now; 36 new tests, all offline.)

```
b70f799 docs(action): how the action layer works and what it refuses
a2929c7 test(action): A1–A15 with Morgan's decision cards
010ffce feat(action): approve, re-check seats, write, read back, roll back; undo; outbox drafts
e080e7c feat(action): seats view, conflict detection on buffered instants, plans ordered from the decisions in force
89dd0f5 feat(calendar): JSON sandbox store with optimistic versions and .ics export
d8930c6 feat(data): fictional vocabulary, two-week calendar seed across the DST change, data README
e47f8bb docs(tasks): 001 report — spend wall and Nebius provider
```

Plus the commit carrying this report. All commits carry the `-0500` offset. As in 001, `npm run typecheck &&
npm test` was run green once over the whole working tree and the six commits split that one green tree.

## Acceptance

| # | test | result | note |
|---|---|---|---|
| A1 | overlapping / touching | ✅ | overlap → one conflict with the overlap interval; touching ends → none; a 10-min buffer turns touching into a conflict; all-day vs timed → none |
| A2 | two events across 2026-11-01 02:00 | ✅ | 01:30–01:50 −05:00 vs 01:15–01:40 −06:00: strings overlap, instants are 25 min apart → no conflict. 01:30–01:59 −05:00 vs 00:55–01:05 −06:00: strings disjoint, instants share 4 min → conflict, rendered `01:55:00-05:00` |
| A3 | Thursday conflict (T1) | ✅ | 11/5 flight home × pickup → `draft_handoff` to `["Jordan"]`, body never mentions Alex; explanation: *"Thursdays I pick up, backup Jordan" (decided 2026-10-03T21:10:00-05:00 by me, replacing "Tuesdays and Thursdays Alex picks up" of 2026-09-08T19:40:00-05:00)*; `seat_versions` has `pickup_backup\|thursday\|kids=pickup.oct3` |
| A4 | Tuesday conflict (T6) | ✅ | 11/3 flight out × pickup → `draft_handoff` to `["Alex"]`; version `pickup.sept` (the September card still holds the Tuesday half) |
| A5 | Saturday conflict (T3) | ✅ | 10/31 flight home × showcase pickup → `refused`; `refusal.cards` = `pickup.sat.a`, `pickup.sat.b`; reason quotes both |
| A6 | Monday focus block 10/26 vs 11/2 (T10) | ✅ | 10/26 → `reschedule_own` to 11:30–13:30 (first free 2 h inside working hours), citing the September "may be moved"; 11/2 → `refused`, citing the 10/20 decision and the one it replaced |
| A7 | seat card changed after planning, then approve | ✅ | a 11/2 card replacing `pickup.oct3` → `refused`: "your arrangements changed after this plan was made: pickup_backup\|thursday\|kids: was pickup.oct3, now pickup.nov2"; outbox empty |
| A8 | step 2 fails on purpose | ✅ | hand-built two-step plan, step 2 with a wrong expected version → `rolled_back`, outcomes `["reverted", "failed"]`, read-back equals `before` (version `v3`). Second case: the revert itself fails → `needs_attention` with the current state (`v2`, moved) |
| A9 | same plan executed twice | ✅ | second call returns the stored object (`toBe`); event version `v2` = one write; trace shows `execute.start` outcomes `["ready", "replay"]` |
| A10 | undo after execute / after a later unrelated edit | ✅ | restored (`v3`, original start/end), token single-use; after a rename → `refused`, "this event was changed after the plan ran", event untouched |
| A11 | loser has other attendees | ✅ | 11/6 design review × demo-day pickup → `draft_message` to Devin with exactly two numbered slots; `executePlan` → `drafted`, calendar deep-equal before/after, one draft in the outbox, no `send` member |
| A12 | no free slot inside working hours | ✅ | working hours shrunk to 09:00–10:00, horizon 0 → `refused`, "no free slot inside working hours", no steps |
| A13 | full run | ✅ | detect (7) → plan (7) → execute all → undo one; every plan has `execute.start` and `execute.result` lines and every step has an `execute.step` / `draft` line after its start; all lines `model: null, usd: null`, Chicago offsets; the JSONL file has the same lines as memory |
| A14 | two session ids | ✅ | write in `judge-1` invisible in `judge-2`; `reset()` deep-equals the seed; a session survives reopening |
| A15 | `ics.ts` | ✅ | all 45 seed events parse back deep-equal (2 all-day); UTC DTSTART/DTEND equal the instants; lines ≤ 75 octets; `;` and `,` escaped |

Also covered: the seed's conflicts are exactly the seven deliberate ones (dates asserted); a category with no
priority decision → "which of these two comes first?"; a rank tie → refused; `plan_id` stable across runs and
changed when a seat's card changes; stale version → `VersionMismatch`; timestamps without offset refused on
load; bad session ids refused.

## Questions for the author

1. **When is a seat resolved?** The card says "at the demo clock". With that literally, A6 cannot pass: at
   11/3 the 10/20 rule (effective 11/2) is in force and would also forbid moving the 10/26 block. I resolve
   each seat **at the instant the conflict happens** (`overlap.start`) — the decision that governs that
   moment — and additionally refuse a card dated after the clock (`FUTURE`, a data error). This is written in
   `docs/action-layer.md`. Say if you meant something else by "at the demo clock".
2. **How a seat's value is read.** The engine stores topic/facet/scope/time but no value, so the value comes
   from the card's quote in a fixed sentence shape (`rank N`, `may (not) be moved`, `backup <Name>` /
   `<Name> picks up`, `HH:MM-HH:MM`). The shapes are documented in `data/vocab.yaml`; a quote that does not
   fit is `UNREADABLE` and refuses. Task 003 (conversational intake) will need to produce quotes in these
   shapes or we add a `value` field to the card — your call; the latter touches the frozen engine's types.
3. **T3 and the engine's `asOf` filter.** With an `asOf`, `SeatGraph.resolveExact` drops cards whose
   `decided_at` does not parse (`!(NaN <= asOf)`), so two undated Saturday cards would simply vanish and the
   seat would read `NOT_FOUND` ("no backup") instead of naming them. `seats-view.ts` therefore scans the seat
   (and its scope chain) for undated cards first and reports `UNDATED` with all cards on the seat. No engine
   change needed, but worth knowing: undated cards are invisible to the engine whenever a date is given.
4. **T10 as encoded.** The 10/20 card sits on `movable | work_focus | global` (REPLACES the September "focus
   blocks may be moved"), so from 11/2 it forbids moving **every** focus block, not only Monday's. The
   vocabulary has no weekday facet for `movable`. If you want "Monday only", add `movable | <weekday> | …` or
   a scope; I kept the card's seat table as given.
5. **`ActionPlan` has two fields beyond the card's interface**: `status: "ready" | "refused"` with `refusal`
   (the card's text says a plan can be `refused` but the interface had nowhere to say so), and `at` (the
   instant used for seat resolution, needed to re-resolve at execution). `winner` / `loser` are convenience
   fields.
6. **Who decides the pickup when the pickup wins?** In the seed the pickup loses only to travel (rank 1). A
   pickup that **wins** (e.g. against the 11/6 design review) needs no backup lookup, so none is made.
7. **Pickups with attendees.** A `kids_pickup` event that lists other attendees is refused ("only hands off
   its owner's own pickups") rather than drafted to the attendees, to keep "never mark the pickup as covered"
   unambiguous. None exist in the seed.
8. **The free-slot search ignores the clock** (it starts at the conflict day's working window, up to 5 days
   ahead). That is what lets the 10/26 case be planned at a 11/3 clock; the UI should decide which conflicts
   to offer. Say if you want "no slot before now" enforced in the planner.
9. **Chicago time helpers are duplicated** in `src/calendar/port.ts` (and `src/spend/ledger.ts` has its own)
   rather than one shared module, to keep the two tasks' file ownership clean. A later task could move them to
   `src/time/`.
10. **Work contacts** (Casey, Devin, Harper) and place names are additional invented names beyond the card's
    four people; the seed needed attendees for the draft-only path.

## What a hook blocked

Nothing in this task. (The one block of the session happened in task 001 and is described in
`docs/tasks/001-report.md`.)
