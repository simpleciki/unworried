// Morgan's decision cards for the action-layer tests, built by hand the way src/engine/fixtures.test-helpers.ts
// does. The conversational version (cards taken from a chat with the user) comes in a later task.
import { join } from "node:path";
import { SeatGraph } from "../engine/seats.ts";
import type { CheckedCard, RelationEdge, SourceRecord } from "../engine/types.ts";
import { loadVocab } from "../engine/vocab.ts";
import type { Vocab } from "../engine/vocab.ts";
import { JsonCalendarStore, readSeed } from "../calendar/json-store.ts";
import type { CalEvent } from "../calendar/port.ts";
import { SeatsView } from "./seats-view.ts";

export const ROOT = join(import.meta.dirname, "..", "..");
export const SEED_PATH = join(ROOT, "data", "calendar-seed.json");
export const DEMO_CLOCK = Date.parse("2026-11-03T09:00:00-06:00");

export const vocab: Vocab = loadVocab(ROOT);

let n = 0;
export function rec(text: string, recorded: string, author = "me"): SourceRecord {
  n++;
  return { record_id: `rec-${n}`, source_type: "client_message", source_version: "v1", text, author, source_recorded_at: recorded, thread_id: "morgan" };
}

export function card(id: string, r: SourceRecord, over: Partial<CheckedCard> & Pick<CheckedCard, "topic" | "facets" | "scope">): CheckedCard {
  return {
    card_id: id,
    record_id: r.record_id,
    quote: r.text,
    mode: "decides",
    decided_at: r.source_recorded_at,
    effective: r.source_recorded_at,
    decided_by: "me",
    result: "PASS",
    ...over,
  };
}

export const replaces = (old_card: string, new_card: string): RelationEdge => ({ old_card, new_card, relation: "REPLACES" });

// The decisions behind the seed's traps (T1, T3, T6, T10) plus the ordinary rules.
export function morganCards(): { cards: CheckedCard[]; edges: RelationEdge[]; records: SourceRecord[] } {
  const records: SourceRecord[] = [];
  const R = (text: string, at: string) => {
    const r = rec(text, at);
    records.push(r);
    return r;
  };
  // Priority ranks (September): travel first, then Theo, then meetings, personal, focus.
  const rPrio = R("Booked travel comes first, rank 1. Theo's pickups rank 2. Meetings with other people rank 3. Personal appointments rank 4. My own focus blocks rank 5.", "2026-09-02T20:15:00-05:00");
  const prio = (cat: string, quote: string) => card(`prio.${cat}`, rPrio, { quote, topic: "priority", facets: [cat], scope: "global" });
  // Movable (September): focus blocks and personal items may be moved; the rest may not.
  const rMov = R("Focus blocks may be moved for a meeting. Personal appointments may be moved. Meetings, travel and pickups may not be moved by the assistant.", "2026-09-02T20:20:00-05:00");
  // T10: 10/20 decision, in force from 11/2.
  const rMovNew = R("From Monday 2 November the Monday focus block may not be moved — launch week.", "2026-10-20T08:05:00-05:00");
  // Working hours.
  const rHours = R("Working hours 09:00-17:00, Monday to Friday.", "2026-09-02T20:25:00-05:00");
  // T1 / T6: September card for Tuesday AND Thursday; the 10/3 card replaces only the Thursday half.
  const rSept = R("Tuesdays and Thursdays Alex picks up Theo if I can't.", "2026-09-08T19:40:00-05:00");
  const rOct = R("Thursdays I pick up, backup Jordan — Alex has the late shift now.", "2026-10-03T21:10:00-05:00");
  // T3: two undated notes about Saturday pickup; nobody said which replaced which.
  const rSatA = R("Saturdays Jordan picks up Theo from the showcase.", "unknown");
  const rSatB = R("Saturday showcase: Alex covers pickup.", "unknown");

  const cards: CheckedCard[] = [
    prio("travel", "Booked travel comes first, rank 1"),
    prio("kids_pickup", "Theo's pickups rank 2"),
    prio("work_meeting", "Meetings with other people rank 3"),
    prio("personal", "Personal appointments rank 4"),
    prio("work_focus", "My own focus blocks rank 5"),
    card("mov.focus.sept", rMov, { quote: "Focus blocks may be moved for a meeting", topic: "movable", facets: ["work_focus"], scope: "global" }),
    card("mov.personal.sept", rMov, { quote: "Personal appointments may be moved", topic: "movable", facets: ["personal"], scope: "global" }),
    card("mov.fixed.sept", rMov, { quote: "Meetings, travel and pickups may not be moved by the assistant", topic: "movable", facets: ["work_meeting", "travel", "kids_pickup"], scope: "global" }),
    card("mov.focus.oct20", rMovNew, { quote: "the Monday focus block may not be moved", topic: "movable", facets: ["work_focus"], scope: "global", effective: "2026-11-02T00:00:00-06:00" }),
    card("hours.sept", rHours, { topic: "working_hours", facets: ["work"], scope: "global" }),
    card("pickup.sept", rSept, { quote: "Tuesdays and Thursdays Alex picks up", topic: "pickup_backup", facets: ["tuesday", "thursday"], scope: "kids" }),
    card("pickup.oct3", rOct, { quote: "Thursdays I pick up, backup Jordan", topic: "pickup_backup", facets: ["thursday"], scope: "kids" }),
    card("pickup.sat.a", rSatA, { topic: "pickup_backup", facets: ["saturday"], scope: "kids", decided_at: "unknown", effective: "unknown" }),
    card("pickup.sat.b", rSatB, { topic: "pickup_backup", facets: ["saturday"], scope: "kids", decided_at: "unknown", effective: "unknown" }),
  ];
  const edges: RelationEdge[] = [replaces("mov.focus.sept", "mov.focus.oct20"), replaces("pickup.sept", "pickup.oct3")];
  return { cards, edges, records };
}

export function morganGraph(mutate?: (c: ReturnType<typeof morganCards>) => void): SeatGraph {
  const c = morganCards();
  mutate?.(c);
  return new SeatGraph(c.cards, c.edges, c.records, vocab);
}

export const morganSeats = (clock = DEMO_CLOCK, mutate?: (c: ReturnType<typeof morganCards>) => void) => new SeatsView(morganGraph(mutate), vocab, clock);

export const seedEvents = (): CalEvent[] => readSeed(SEED_PATH);
export const byId = (events: CalEvent[], id: string): CalEvent => {
  const e = events.find((x) => x.event_id === id);
  if (!e) throw new Error(`no seed event ${id}; have ${events.map((x) => x.event_id).join(", ")}`);
  return e;
};

export const store = (dir: string, session: string, now = () => DEMO_CLOCK) => new JsonCalendarStore({ dir, session, seedPath: SEED_PATH, now });
