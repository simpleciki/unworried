// The core-claim eval: does the assistant act on the arrangement IN FORCE, and refuse when it cannot tell?
// No model: the product's own planner (planConflict over the seat graph) on 13 constructed scenarios, each a
// pickup that collides with a flight. The expected answer of every scenario is written from the product
// rules BEFORE running anything. Two baselines read the same notes the way a plain memory would:
//   latest — the most recently said note that names a backup for that weekday (what a "remember
//            everything, answer from the newest" assistant does);
//   first  — the first such note (a memory that was never updated);
//   latestInForce — the newest note that has already taken effect on the pickup day (a memory that reads
//            start dates, but not which note replaced which, nor whether a note was a question or a proposal).
//            Added 2026-10-28 after an independent review: the first two baselines ignore start dates.
// The scenarios are constructed (fictional family, controlled), not observed from real use.
import type { CalEvent } from "../calendar/port.ts";
import { detectConflicts } from "../action/detect.ts";
import { planConflict } from "../action/plan.ts";
import { SeatsView } from "../action/seats-view.ts";
import { card, morganCards, rec, replaces, vocab } from "../action/fixtures.test-helpers.ts";
import { SeatGraph } from "../engine/seats.ts";
import type { CheckedCard, RelationEdge, SourceRecord } from "../engine/types.ts";

export type Answer = { ask: string } | { refuse: true };
// who: the person the note names. The product gets it the way a judge gives it: the value confirmed on the
// card ("backup Alex"); a mention or proposal holds no seat and has no value. The baselines get the same name
// for every note, so they are compared on which note they trust, not on reading the sentence.
export type Note = { id: string; text: string; said: string; days: string[]; who: string; mode?: "decides" | "mentions" | "proposes"; effective?: string; quote?: string };
export type Scenario = { id: string; trap: string; notes: Note[]; replaces?: [string, string][]; pickup: string; expected: Answer };

// Everything below is said by 2026-11-03 09:00 CST; the seats are read at the moment of each conflict.
const KNOWN_AT = Date.parse("2026-11-03T12:00:00-06:00");
const SEPT: Note = { id: "sept", text: "Tuesdays and Thursdays Alex picks up Theo if I can't.", quote: "Tuesdays and Thursdays Alex picks up", said: "2026-09-08T19:40:00-05:00", days: ["tuesday", "thursday"], who: "Alex" };
const OCT3: Note = { id: "oct3", text: "Thursdays I pick up, backup Jordan — Alex has the late shift now.", quote: "Thursdays I pick up, backup Jordan", said: "2026-10-03T21:10:00-05:00", days: ["thursday"], who: "Jordan" };
const NOV3: Note = { id: "nov3", text: "From tomorrow Alex is the backup for Thursday pickups.", said: "2026-11-03T09:00:40-06:00", effective: "2026-11-04T00:00:00-06:00", days: ["thursday"], who: "Alex" };

export const SCENARIOS: Scenario[] = [
  { id: "S01", trap: "one standing arrangement", notes: [SEPT], pickup: "2026-11-05", expected: { ask: "Alex" } },
  { id: "S02", trap: "overturned", notes: [SEPT, OCT3], replaces: [["sept", "oct3"]], pickup: "2026-11-05", expected: { ask: "Jordan" } },
  { id: "S03", trap: "overturned for Thursday only; Tuesday unchanged", notes: [SEPT, OCT3], replaces: [["sept", "oct3"]], pickup: "2026-11-10", expected: { ask: "Alex" } },
  { id: "S04", trap: "decided, not yet in force", notes: [SEPT, { id: "oct30", text: "From November 10 Jordan is the backup for Thursday pickups.", said: "2026-10-30T18:00:00-05:00", effective: "2026-11-10T00:00:00-06:00", days: ["thursday"], who: "Jordan" }], replaces: [["sept", "oct30"]], pickup: "2026-11-05", expected: { ask: "Alex" } },
  { id: "S05", trap: "decided, now in force", notes: [SEPT, { id: "oct30", text: "From November 10 Jordan is the backup for Thursday pickups.", said: "2026-10-30T18:00:00-05:00", effective: "2026-11-10T00:00:00-06:00", days: ["thursday"], who: "Jordan" }], replaces: [["sept", "oct30"]], pickup: "2026-11-12", expected: { ask: "Jordan" } },
  { id: "S06", trap: "a later question names the old backup", notes: [SEPT, OCT3, { id: "q", text: "So Alex covers Thursdays, right?", said: "2026-10-10T08:00:00-05:00", days: ["thursday"], who: "Alex", mode: "mentions" }], replaces: [["sept", "oct3"]], pickup: "2026-11-05", expected: { ask: "Jordan" } },
  { id: "S07", trap: "a later suggestion names someone else", notes: [SEPT, OCT3, { id: "p", text: "Maybe Casey covers Thursdays instead?", said: "2026-10-12T08:00:00-05:00", days: ["thursday"], who: "Casey", mode: "proposes" }], replaces: [["sept", "oct3"]], pickup: "2026-11-05", expected: { ask: "Jordan" } },
  { id: "S08", trap: "two undated notes disagree", notes: [{ id: "a", text: "Saturdays Jordan picks up Theo from the showcase.", said: "unknown", days: ["saturday"] , who: "Jordan" }, { id: "b", text: "Saturday showcase: Alex covers pickup.", said: "unknown", days: ["saturday"] , who: "Alex" }], pickup: "2026-11-07", expected: { refuse: true } },
  { id: "S09", trap: "a dated note and an undated one", notes: [{ id: "a", text: "Fridays Jordan picks up Theo.", said: "2026-09-10T19:00:00-05:00", days: ["friday"] , who: "Jordan" }, { id: "b", text: "Friday: Alex covers pickup.", said: "unknown", days: ["friday"] , who: "Alex" }], pickup: "2026-11-06", expected: { refuse: true } },
  { id: "S10", trap: "two dated notes, nobody said one replaces the other", notes: [{ id: "a", text: "Mondays Jordan picks up Theo.", said: "2026-10-01T19:00:00-05:00", days: ["monday"] , who: "Jordan" }, { id: "b", text: "Mondays Casey picks up Theo.", said: "2026-10-15T19:00:00-05:00", days: ["monday"] , who: "Casey" }], pickup: "2026-11-09", expected: { refuse: true } },
  { id: "S11", trap: "nothing decided for that day", notes: [SEPT], pickup: "2026-11-11", expected: { refuse: true } },
  { id: "S12", trap: "overturned twice (the demo sentence)", notes: [SEPT, OCT3, NOV3], replaces: [["sept", "oct3"], ["oct3", "nov3"]], pickup: "2026-11-05", expected: { ask: "Alex" } },
  { id: "S13", trap: "the demo sentence, before it is in force", notes: [SEPT, OCT3, NOV3], replaces: [["sept", "oct3"], ["oct3", "nov3"]], pickup: "2026-10-29", expected: { ask: "Jordan" } },
];

const offset = (date: string) => (date >= "2026-11-01" ? "-06:00" : "-05:00");
function events(date: string): CalEvent[] {
  const o = offset(date);
  return [
    { event_id: `flight-${date}`, version: "v1", title: "Flight home", start: `${date}T15:45:00${o}`, end: `${date}T19:30:00${o}`, owner: "me", attendees: [], category: "travel", buffer_before_min: 90 },
    { event_id: `pickup-${date}`, version: "v1", title: "Theo — pickup", start: `${date}T17:30:00${o}`, end: `${date}T18:00:00${o}`, owner: "me", attendees: [], category: "kids_pickup", buffer_before_min: 15 },
  ];
}

// unworried: the product's planner over the seat graph built from the scenario's notes.
export function unworried(s: Scenario): Answer {
  const base = morganCards();
  const cards: CheckedCard[] = base.cards.filter((c) => c.topic !== "pickup_backup");
  const records: SourceRecord[] = [...base.records];
  for (const n of s.notes) {
    const r = rec(n.text, n.said);
    records.push(r);
    cards.push(card(n.id, r, { quote: n.quote ?? n.text, topic: "pickup_backup", facets: n.days, scope: "kids", mode: n.mode ?? "decides", decided_at: n.said, effective: n.effective ?? n.said }));
  }
  const edges: RelationEdge[] = [...base.edges.filter((e) => !e.old_card.startsWith("pickup")), ...(s.replaces ?? []).map(([o, n]) => replaces(o, n))];
  const values = new Map(s.notes.filter((n) => (n.mode ?? "decides") === "decides").map((n) => [n.id, `backup ${n.who}`]));
  const seats = new SeatsView(new SeatGraph(cards, edges, records, vocab), vocab, KNOWN_AT, (id) => values.get(id));
  const evs = events(s.pickup);
  const [conflict] = detectConflicts(evs);
  if (!conflict) throw new Error(`${s.id}: the scenario's events do not collide`);
  const plan = planConflict(conflict, { events: evs, seats });
  if (plan.status === "refused") return { refuse: true };
  const handoff = plan.steps.find((st) => st.kind === "draft_handoff");
  if (!handoff?.draft) throw new Error(`${s.id}: ready plan without a handoff (${plan.steps.map((x) => x.kind).join(", ")})`);
  return { ask: handoff.draft.to[0] };
}

const WEEKDAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const dayOf = (date: string) => WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()];

// A plain memory: every note that names someone for that weekday, in the order it was said (a note with no
// date has no place in time; it is read where it was written down, after the dated ones).
function named(s: Scenario): string[] {
  const day = dayOf(s.pickup);
  const said = (n: Note) => (n.said === "unknown" ? Number.POSITIVE_INFINITY : Date.parse(n.said));
  return s.notes
    .filter((n) => n.days.includes(day))
    .map((n, i) => ({ n, i }))
    .sort((x, y) => said(x.n) - said(y.n) || x.i - y.i)
    .map(({ n }) => n.who);
}
export const latest = (s: Scenario): Answer => {
  const names = named(s);
  return names.length ? { ask: names[names.length - 1] } : { refuse: true };
};
export const latestInForce = (s: Scenario): Answer => {
  const day = dayOf(s.pickup);
  const pickupAt = Date.parse(`${s.pickup}T12:00:00-06:00`);
  const said = (n: Note) => (n.said === "unknown" ? Number.POSITIVE_INFINITY : Date.parse(n.said));
  const names = s.notes
    .filter((n) => n.days.includes(day))
    .filter((n) => n.said === "unknown" || Date.parse(n.effective ?? n.said) <= pickupAt)
    .map((n, i) => ({ n, i }))
    .sort((x, y) => said(x.n) - said(y.n) || x.i - y.i)
    .map(({ n }) => n.who);
  return names.length ? { ask: names[names.length - 1] } : { refuse: true };
};
export const first = (s: Scenario): Answer => {
  const names = named(s);
  return names.length ? { ask: names[0] } : { refuse: true };
};

export const same = (a: Answer, b: Answer) => ("refuse" in a ? "refuse" in b : "ask" in b && a.ask === b.ask);
export const show = (a: Answer) => ("refuse" in a ? "refuses (asks you)" : `asks ${a.ask}`);

export type Score = { name: string; right: number; total: number; wrongPerson: number; refusedWhenShouldAct: number; actedWhenShouldRefuse: number };
export function score(name: string, f: (s: Scenario) => Answer): Score {
  const out: Score = { name, right: 0, total: SCENARIOS.length, wrongPerson: 0, refusedWhenShouldAct: 0, actedWhenShouldRefuse: 0 };
  for (const s of SCENARIOS) {
    const got = f(s);
    if (same(got, s.expected)) out.right++;
    else if ("refuse" in s.expected) out.actedWhenShouldRefuse++;
    else if ("refuse" in got) out.refusedWhenShouldAct++;
    else out.wrongPerson++;
  }
  return out;
}
