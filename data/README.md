# Data — ALL DATA IS FICTIONAL

Nothing in this directory describes a real person, family, employer, address, phone number, email,
product or company. Names were invented for the demo; any resemblance is accidental.

## The people

| name | role in the data |
|---|---|
| **Morgan** (`owner: "me"`) | independent product manager running two small products, **Loomstack** and **Pebblemail** (both invented). The calendar is Morgan's only. |
| **Alex** | Morgan's partner |
| **Jordan** | a neighbour; the backup for school pickup |
| **Theo** | Morgan and Alex's child; robotics club after school on Tuesdays and Thursdays |

Work contacts that appear as attendees — Casey (Loomstack contractor), Devin (Pebblemail designer),
Harper (Pebblemail beta customer) — are invented too. Places (Oakridge Robotics Club, Birchfield
Elementary, Maple Row Dental, Lakeshore Coworking, Copper Kettle Café, Fernwood Court, Northgate Market)
are invented.

## Files

- `vocab.yaml` — the decision vocabulary (topics / facets / scopes / deciders) the engine and the action
  layer read, plus the event categories and the cast. The sentence shapes the seat values are read from
  are documented there.
- `calendar-seed.json` — Morgan's calendar, 45 events, 2026-10-26 → 2026-11-08, America/Chicago.
  Recurring events (drop-offs, pickups, focus blocks, dev syncs) are **expanded into instances**; there
  is no RRULE. The range crosses the end of daylight saving time (2026-11-01 02:00 CDT → 01:00 CST):
  three events sit on 10/31 (−05:00) and three on 11/01 (−06:00). Every sandbox session starts as a copy
  of this file.
- The decision cards that the seed's conflicts are judged against are built in
  `src/action/fixtures.test-helpers.ts` for this task; the conversational version is `data/conversation-seed.jsonl`, read by `src/chat/`.

## Deliberate conflicts in the seed

| when | events | what the correct plan does |
|---|---|---|
| Mon 10/26 10:00 | Monday focus block × pricing call with Harper | focus loses to the meeting; the old rule still allows moving it → reschedule |
| Fri 10/30 16:00 | Loomstack offsite day × Week review | review (own focus) loses to the meeting and may be moved → reschedule |
| Sat 10/31 15:00 | Flight home from Madison × robotics showcase pickup | pickup loses to travel; two undated Saturday-backup cards → **refused, both named** |
| Mon 11/2 10:00 | Monday focus block × investor intro call | focus loses; "may not be moved from 11/2" is in force → **refused** |
| Tue 11/3 17:30 | Flight to Denver × Tuesday pickup | pickup loses; Tuesday backup is still Alex → handoff draft to Alex |
| Thu 11/5 17:30 | Flight home from Denver × Thursday pickup | pickup loses; Thursday backup is Jordan (10/3 decision) → handoff draft to Jordan, never Alex |
| Fri 11/6 15:30 | Design review with Devin × robotics demo day pickup | review loses; it has an attendee → message draft with two slots, calendar untouched |

Mon 10/26 11:00: the focus block ends exactly when the dev sync starts — touching, not a conflict.
