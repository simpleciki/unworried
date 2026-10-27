# The action layer

The half of `unworried` that acts: finds conflicts on the sandbox calendar, orders a plan from the
decisions in force, executes it after the user approves, and can undo it. **It uses no model.** Conflicts
are found by code, plans are ordered by code from the seat graph, the explanation is a code template
naming the decisions. (A model-written explanation comes later, through the spending wall.)

## One conflict, start to finish

```
calendar.list(range) ──▶ detectConflicts ──▶ planConflict(conflict, seats) ──▶ user approves ──▶ executePlan ──▶ undo(token)
                           pure code            reads the seat graph            caller flag        write → read back
                                                 refuses when unsure                               roll back on failure
```

### Detect (`src/action/detect.ts`)

- Occupied interval = `[start − buffer_before, end + buffer_after)`. Two intervals that intersect
  conflict; touching ends do not.
- All instants. `2026-11-01T01:30-05:00` and `2026-11-01T01:15-06:00` do **not** overlap although the
  wall-clock strings do (A2).
- All-day events conflict only with all-day events (v1 limitation).
- `conflict_id` = hash of the sorted `event_id@version` pair: the same conflict found twice has the same id,
  and a moved event makes a new one.

### Where importance and movability come from — the seat graph, never a guess (`src/action/seats-view.ts`)

| needed | seat (topic \| facet \| scope) | value read from the card's quote | if the seat is not PASS |
|---|---|---|---|
| which category yields | `priority \| <category> \| global` | `rank N` (1 yields to nothing) | plan **refused**: "which of these two comes first?" |
| whether an event may be moved | attendees besides me → draft only; else `movable \| <category> \| global` | `may be moved` / `may not be moved` | treated as not movable → refused |
| who covers a pickup | `pickup_backup \| <weekday> \| kids` | `backup <Name>` / `<Name> picks up` | conflict reported, nothing drafted |
| which hours a move may land in | `working_hours \| work \| global` | `HH:MM-HH:MM[, Monday to Friday]` | ±2 h of the original slot, same day |

A seat is resolved **at the instant the conflict happens** (the decision that governs that moment), with
decisions limited to those made by the demo clock. So "the Monday focus block may not be moved, from 11/2"
(decided 10/20) does not bind the block on 10/26 and does bind the one on 11/2 (A6).

A lookup is `PASS` only when exactly one dated decision is in force and its quote states the value. Every
other state refuses and names the cards:

| state | meaning |
|---|---|
| `NOT_FOUND` | no decision on the seat (or the only one takes effect later) |
| `UNRESOLVED_CONFLICT` | the engine found contradictory replacement links |
| `AMBIGUOUS` | two or more decisions coexist and none replaces the others |
| `UNDATED` | a card on the seat cannot be dated, so nothing can be ordered against it (A5: both Saturday cards) |
| `UNREADABLE` | the card in force does not state the value in the documented shape |
| `FUTURE` | the card is dated after the clock (data error) |

Each plan records `depends_on_seats` and `seat_versions` (`<seat>=<card id in force>`; `-` when empty).

### Plan (`src/action/plan.ts`)

1. Resolve `priority` for both categories. Anything not PASS, or a tie → `refused`.
2. The loser is the lower-ranked event.
3. Loser handling, in this order:

| loser | step |
|---|---|
| a pickup (`kids_pickup`) I cannot make | `draft_handoff` to the backup in force for that weekday; the pickup is **never** moved or marked covered |
| has other attendees | `draft_message` to them with two candidate slots |
| only me, `movable` says yes | `reschedule_own` to the earliest free slot inside working hours, same duration, no new conflict |
| only me, `movable` says no or is missing | `refused` |
| no free slot | `refused`, "no free slot inside working hours" |

4. The explanation names the decision that decided it, when it was decided, by whom, and which earlier
   decision it replaced (read from the seat's chain) — e.g. *"Thursdays I pick up, backup Jordan" (decided
   2026-10-03 by me, replacing "Tuesdays and Thursdays Alex picks up" of 2026-09-08)*.

`plan_id` = hash(conflict_id + seat_versions + event versions). The free-slot search starts at the conflict
day's working window and looks up to 5 days ahead (15-minute steps); it does not consult the clock, so the
caller decides which conflicts are worth planning (a past one can still be planned, as in the tests).

### Execute (`src/action/execute.ts`)

Approval is a caller flag (no UI in this task). Then:

1. Re-resolve every seat in `seat_versions` at the plan's instant; any difference → `refused`
   ("your arrangements changed after this plan was made", naming the seat) (A7).
2. Steps in order. `reschedule_own` → `calendar.update(id, after, expected_version)`.
3. **Read back after every write**; start/end must equal `after`, else the step failed.
4. Any failure → completed writes are reverted in reverse order, each revert read back; final status
   `rolled_back`. A failed revert → `needs_attention` with the current state of each touched event (A8).
5. Draft steps write to the outbox only (`src/outbox/drafts.ts`). **Nothing is ever sent**; there is no
   send method, no mail or SMS integration. A draft's status is always `draft`.
6. Idempotent: the same `plan_id` executed twice returns the stored first result and writes nothing (A9).
   A "not approved" refusal is not stored, so approving later runs the plan.
7. Calendar operations time out after 2 s. Writes are never retried automatically.

`status`: `executed` (something moved; carries `undo_token`) · `drafted` (only drafts) · `refused` ·
`rolled_back` · `needs_attention`.

### Undo (`src/action/undo.ts`)

`undo(token)` restores each event's `before` only if its current version is the one the execution wrote.
Any mismatch → `refused`, "this event was changed after the plan ran", and nothing is touched (all versions
are checked before the first write). Tokens are single-use.

### Trace (`src/action/trace.ts`)

Every step is one JSONL line: `at` (Chicago offset), `session_id`, `action` (`detect`, `plan`,
`execute.start`, `execute.seats`, `execute.step`, `draft`, `execute.revert`, `execute.result`, `undo`),
`ref`, `step`, `outcome`, `details`, and two fields that stay `null` in this task — `model` and `usd` — so a
later task can log a guarded model call on the same line.

## The sandbox calendar (`src/calendar/`)

- `CalendarPort`: `list(range)`, `get(id)`, `update(id, patch, expected_version)`. **v1 has no create and no
  delete**: the assistant only moves its owner's own events.
- `JsonCalendarStore`: one JSON file per session id, copied from `data/calendar-seed.json` on first use.
  Two sessions never see each other's writes; `reset()` returns a session to the seed (A14). Versions are
  `v1`, `v2`, … and a stale `expected_version` throws `VersionMismatch`. Writes are temp-file + rename.
- Every timestamp must be ISO 8601 with an offset; a bare date or a datetime without offset is refused on
  load, not guessed.
- **Recurring events are expanded into instances in the seed**; there is no RRULE.
- `ics.ts` exports a calendar to iCalendar text (UTC instants, DATE values for all-day events, extra fields
  in `X-UNWORRIED-*` properties) and the test parses it back to the same events (A15).

## What it refuses, in one place

- A conflict whose categories have no priority decision, or the same rank.
- A pickup with no backup decided for that weekday, or two backup arrangements nobody ordered (Saturday).
- Moving an event whose category has no `movable` decision, or whose decision says no.
- Moving an event with other attendees (drafts instead).
- A plan whose seats changed between planning and approval.
- Executing without approval; executing the same plan twice (returns the first result).
- Undoing an event somebody changed since.
- Any timestamp without an offset; any seed or sandbox file that does not validate.

## v1 limitations

- The engine drops a card whose `decided_at` does not parse whenever it is asked with a date (`asOf`), so an
  undated arrangement would silently look like "no decision". The seats view scans the seat for undated
  cards first and reports `UNDATED`, naming them, before asking the engine.
- The engine does not call two unlinked cards on one seat a conflict (it reports `PASS` with `coexisting`);
  the seats view does (`AMBIGUOUS`). Either way the plan refuses and names both.
- All-day events only conflict with all-day events.
- No create / delete; no recurrence rules; one calendar (`owner: "me"`).
- The free-slot search is greedy (earliest first) and looks at most 5 days ahead.
- Results and undo tokens live in the process (`ActionStore`); the calendar file is the only durable state.
