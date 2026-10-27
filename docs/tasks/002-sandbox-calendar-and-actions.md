# Task 002 — Sandbox calendar, conflict detection, plans, execution, undo

Read `docs/tasks/000-shared-rules.md` first. This task is the "takes real action on your behalf" half of the
product. **It uses no model at all**: conflicts are found by code, plans are ordered by code from the
decisions in the seat graph, execution writes to the sandbox calendar and reads back. The explanation text
is a code template in this task (a model-written explanation comes later, through the spending wall of
task 001 — not your concern).

## Files you own

```
src/calendar/port.ts          CalendarPort interface + CalEvent type
src/calendar/json-store.ts    one JSON file per session; optimistic versions
src/calendar/ics.ts           export a calendar to .ics text
src/calendar/*.test.ts
src/action/seats-view.ts      reads the engine's SeatGraph → priority / movable / pickup_backup / working_hours
src/action/detect.ts          conflicts (pure code)
src/action/plan.ts            ActionPlan from a conflict + the seats currently in force
src/action/execute.ts         approve → re-check seat versions → write → read back → roll back on failure
src/action/undo.ts
src/action/trace.ts           JSONL trace of every step (no model, no money in this task; keep the shape open for both)
src/action/*.test.ts
src/outbox/drafts.ts          drafts only; nothing is ever sent
data/vocab.yaml               the decision vocabulary for this domain (topics / facets / scopes / deciders)
data/calendar-seed.json       two weeks of fictional events, 2026-10-26 → 2026-11-08, ~40 events
data/README.md                "ALL DATA IS FICTIONAL" + the people
docs/action-layer.md          how it works and what it refuses (feeds the README later)
```

Do not touch `src/spend/`, `src/llm/` (task 001) or `src/engine/` (frozen). Read `src/engine/seats.ts`,
`seat-types.ts`, `types.ts`, `vocab.ts`, `time.ts` and their tests to learn the seat graph; your fixtures build
`CheckedCard`s by hand the way `src/engine/fixtures.test-helpers.ts` does.

## The people (fictional; see shared rule 5)

Morgan — an independent product manager running two small products (invent two product names that match no
real product). Alex — Morgan's partner. Jordan — a neighbour, the backup for school pickup. Theo — Morgan
and Alex's child, robotics club after school on Tuesdays and Thursdays. The calendar is Morgan's only
(`owner: "me"`).

## Design (decided by the author on 2026-10-14)

### Calendar

```ts
interface CalendarPort {
  list(range: { start: string; end: string }): Promise<CalEvent[]>;
  get(event_id: string): Promise<CalEvent | null>;
  update(event_id: string, patch: Partial<CalEvent>, expected_version: string): Promise<CalEvent>; // throws if the version does not match
}
interface CalEvent {
  event_id: string; version: string; title: string;
  start: string; end: string;          // ISO 8601 with offset, America/Chicago
  all_day?: boolean; owner: "me";
  attendees: string[];                 // anyone besides "me" → the event can only be drafted about, never moved
  category: CategoryKey;               // from data/vocab.yaml: kids_pickup / work_focus / work_meeting / travel / personal …
  location?: string; buffer_before_min?: number; buffer_after_min?: number;
}
```

- v1 has no create / delete: the assistant only moves its owner's own events.
- One sandbox per session id, copied from `data/calendar-seed.json` on first use; `reset(session)` returns
  to the seed. Two sessions never see each other's writes.
- Recurring events are **expanded into instances in the seed** (no RRULE); say so in `docs/action-layer.md`.
- The seed crosses the end of daylight saving time (2026-11-01). At least two events sit on either side.

### Where importance and movability come from — the seat graph, never a guess

| needed | seat key (topic \| facet \| scope) | if the seat is empty or unresolved |
|---|---|---|
| which category yields to which (e.g. kids_pickup > work_meeting) | `priority \| <category> \| global` | **do not act**: plan = `refused`, "which of these two comes first?" |
| whether an event may be moved | code: attendees besides me → draft only; else `movable \| <category> \| global` | treat as not movable (conservative) |
| who can cover a pickup | `pickup_backup \| <weekday> \| kids` | report the conflict only, no draft |
| which hours a move may land in | `working_hours \| work \| global` | only within ±2 h of the original slot, same day |

`seats-view.ts` resolves these from a `SeatGraph` at the demo clock and returns, per lookup, the card id and
the seat's `state`; a plan records `depends_on_seats` and `seat_versions` (use the card ids in effect as the
version). The vocabulary for these topics/facets/scopes goes in `data/vocab.yaml` (a different domain from the
imported engine's test vocab; the engine reads any vocab).

### Conflict detection (pure code)

- occupied interval = `[start − buffer_before, end + buffer_after)`; two intervals that intersect conflict;
  touching ends do not.
- all-day events conflict only with all-day events (v1 limitation, documented).
- `Conflict { conflict_id, a, b, overlap: { start, end } }`, `conflict_id = hash(sorted event ids + versions)`,
  so the same conflict detected twice gets the same id.

### Planning (code orders candidates)

1. Resolve the seats the conflict depends on. Any seat not `PASS` → whole plan `refused`, naming the seat.
2. The loser (the event that yields) comes from `priority`.
3. Loser handling:

| loser | step |
|---|---|
| only me, `movable` allows | `reschedule_own`: earliest slot inside `working_hours`, same duration, no new conflict |
| has other attendees | `draft_message` to the attendees with two candidate slots |
| a pickup I cannot make | `draft_handoff` to the backup currently in force; **never mark the pickup as covered** |
| no free slot | `refused`, "no free slot inside working hours" |

4. `explanation`: a code template naming which decision decided it, when it was decided, and which earlier
   decision it replaced (read from the seat's `chain`).

```ts
interface ActionPlan {
  plan_id: string;                      // hash(conflict_id + seat_versions + event versions)
  conflict_id: string; depends_on_seats: string[]; seat_versions: string[];
  steps: { kind: "reschedule_own" | "draft_message" | "draft_handoff"; target_event_id: string;
           before: Partial<CalEvent>; after?: Partial<CalEvent>;
           draft?: { to: string[]; subject: string; body: string } }[];
  explanation: string;
}
```

### Execution (after the user approves; approval is a caller flag, there is no UI in this task)

1. Re-resolve the seats; any version differs from `seat_versions` → `refused` ("your arrangements changed
   after this plan was made").
2. Run steps in order. `reschedule_own` → `update(id, after, expected_version)`.
3. **Read back after every write**; start/end must equal `after`, else the step failed.
4. Any failure → revert completed steps in reverse order, read back each revert; final `rolled_back`. If a
   revert fails → `needs_attention` with the current state of each touched event.
5. Draft steps write to the outbox only. **Nothing is ever sent**; there is no mail or SMS integration.
6. Idempotent: the same `plan_id` executed twice returns the stored first result and writes nothing.
7. Timeouts: calendar ops 2 s. No automatic retry of writes.

```ts
interface ExecutionResult {
  plan_id: string;
  status: "executed" | "drafted" | "refused" | "rolled_back" | "needs_attention";
  steps: { index: number; outcome: "done" | "drafted" | "failed" | "reverted"; readback?: Partial<CalEvent>; error?: string }[];
  undo_token?: string;                  // only when executed
}
```

### Undo

`undo(token)` restores `before` only if each target event's current version equals the version written by
the execution (nobody changed it since); else refuse with "this event was changed after the plan ran".

## Traps in the seed (the fixtures' decision cards; the full conversational version comes later)

| trap | in the data | correct behaviour |
|---|---|---|
| T1 overturned pickup | September card: "Thursdays Alex picks up"; 10/3 card replaces it: "Thursdays I pick up, backup Jordan" | Thursday backup = Jordan, never Alex |
| T3 undated conflict | two cards about Saturday pickup, both undated, neither replaces the other | Saturday conflict → `refused`, names both cards |
| T6 partial overturn | only Thursday changed; Tuesday is still Alex | Tuesday conflict → draft to Alex |
| T10 decided, not yet in force | 10/20 card: "Monday focus block may not be moved, from 11/2" | Monday 10/26 block may move; Monday 11/2 may not |

## Acceptance (A = action layer)

| # | test | passes when |
|---|---|---|
| A1 | two overlapping events / two touching events | conflict / no conflict |
| A2 | two events across 2026-11-01 02:00 | judged by instants (write one case where wall-clock order and instant order differ) |
| A3 | Thursday conflict (T1) | plan drafts a handoff to Jordan, not Alex; explanation cites the 10/3 decision and names the one it replaced |
| A4 | Tuesday conflict (T6) | draft to Alex |
| A5 | Saturday conflict (T3) | `refused`, both cards named |
| A6 | Monday focus block on 10/26 vs 11/2 (T10) | the first may be moved, the second is refused |
| A7 | change a seat card after planning, then approve | `refused` (seat versions differ) |
| A8 | step 2 fails on purpose | step 1 reverted, final `rolled_back`, read-back equals `before` |
| A9 | same plan executed twice | calendar written once; second call returns the stored result |
| A10 | undo after execute / undo after a later unrelated edit | restored / refused with reason |
| A11 | loser has other attendees | draft only, calendar untouched |
| A12 | no free slot inside working hours | `refused`, nothing forced |
| A13 | full run | every step is in the JSONL trace |
| A14 | two session ids | writes in one are invisible in the other; `reset` returns to the seed |
| A15 | `ics.ts` | exported text parses back to the same events (write a minimal parser in the test) |

## Done looks like

`npm run typecheck && npm test` green including A1–A15; `data/calendar-seed.json` and `data/vocab.yaml`
committed with `data/README.md`; `docs/action-layer.md` written; `docs/tasks/002-report.md` per the shared
rules. Small commits, e.g. `feat(calendar): JSON sandbox store with optimistic versions`,
`feat(action): conflict detection on buffered instants`, `test(action): A1–A15`.
