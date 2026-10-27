// Reads the engine's SeatGraph for the four things the action layer needs — priority, movable,
// pickup_backup, working_hours — and never guesses: an empty, conflicting, ambiguous, undated or
// unreadable seat is reported as such and the plan refuses.
//
// A seat is resolved AT THE INSTANT THE CONFLICT HAPPENS (the decision that governs that moment), with
// decisions limited to those made by the clock: a rule "from 11/2" does not bind an event on 10/26.
import type { SeatGraph } from "../engine/seats.ts";
import { parseTime } from "../engine/time.ts";
import type { CheckedCard, Seat } from "../engine/types.ts";
import { seatKey } from "../engine/types.ts";
import type { Vocab } from "../engine/vocab.ts";
import { scopeChain } from "../engine/vocab.ts";
import type { Weekday } from "../calendar/port.ts";

export type LookupState = "PASS" | "NOT_FOUND" | "UNRESOLVED_CONFLICT" | "AMBIGUOUS" | "UNDATED" | "UNREADABLE" | "FUTURE";

export type Lookup<T> = {
  key: string; // topic|facet|scope as asked
  state: LookupState;
  card_id: string | null; // the card in force (the seat's version)
  value?: T;
  cards: string[]; // every card a refusal should name
  reason?: string; // one sentence when not PASS
  quote?: string;
  decided_at?: string;
  decided_by?: string;
  effective?: string;
  replaced: { card_id: string; quote: string; decided_at: string } | null; // what the card in force replaced
};

export type WorkingHours = { start: { hour: number; minute: number }; end: { hour: number; minute: number }; days: Weekday[] };

const WEEKDAY_NAMES: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// ---- value parsers (one per topic; the sentence shapes are documented in data/vocab.yaml) ----------

export function parsePriority(quote: string): number | null {
  const m = quote.match(/\brank\s*(?:is\s*)?(\d+)\b/i);
  return m ? +m[1] : null;
}

export function parseMovable(quote: string): boolean | null {
  if (/\b(may|must|can|should)\s+not\s+be\s+moved\b|\bcannot\s+be\s+moved\b|\bnot\s+movable\b|\bstays?\s+(put|where it is)\b/i.test(quote)) return false;
  if (/\b(may|can)\s+be\s+moved\b|\bmovable\b/i.test(quote)) return true;
  return null;
}

// Who covers when I cannot: "backup Jordan" / "backup is Jordan" / "Alex picks up" / "Alex covers".
export function parsePickupBackup(quote: string): string | null {
  const backup = quote.match(/\bbackup(?:\s+is)?[:\s]+([A-Z][a-z]+)/);
  if (backup) return backup[1];
  const does = quote.match(/\b([A-Z][a-z]+)\s+(?:picks?\s+up|covers|does\s+(?:the\s+)?pickups?)\b/);
  if (does && does[1] !== "I") return does[1];
  return null;
}

export function parseWorkingHours(quote: string): WorkingHours | null {
  const m = quote.match(/(\d{1,2}):(\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const start = { hour: +m[1], minute: +m[2] };
  const end = { hour: +m[3], minute: +m[4] };
  if (start.hour > 23 || end.hour > 24 || start.minute > 59 || end.minute > 59) return null;
  if (start.hour * 60 + start.minute >= end.hour * 60 + end.minute) return null;
  let days: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday"];
  const range = quote.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:to|through|-|–)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (range) {
    const a = WEEKDAY_NAMES.indexOf(range[1].toLowerCase() as Weekday);
    const b = WEEKDAY_NAMES.indexOf(range[2].toLowerCase() as Weekday);
    days = [];
    for (let i = a; ; i = (i + 1) % 7) {
      days.push(WEEKDAY_NAMES[i]);
      if (i === b) break;
    }
  }
  return { start, end, days };
}

// ---- the view ---------------------------------------------------------------------------------------

export class SeatsView {
  readonly graph: SeatGraph;
  readonly vocab: Vocab;
  readonly clock: number; // decisions made after this instant do not exist yet

  constructor(graph: SeatGraph, vocab: Vocab, clock: number) {
    this.graph = graph;
    this.vocab = vocab;
    this.clock = clock;
  }

  priority(category: string, at: number): Lookup<number> {
    return this.lookup({ topic: "priority", facet: category, scope: "global" }, at, parsePriority, "a rank (`rank N`)");
  }

  movable(category: string, at: number): Lookup<boolean> {
    return this.lookup({ topic: "movable", facet: category, scope: "global" }, at, parseMovable, "`may be moved` or `may not be moved`");
  }

  pickupBackup(weekday: Weekday, at: number): Lookup<string> {
    return this.lookup({ topic: "pickup_backup", facet: weekday, scope: "kids" }, at, parsePickupBackup, "a name (`backup <Name>` or `<Name> picks up`)");
  }

  workingHours(at: number): Lookup<WorkingHours> {
    return this.lookup({ topic: "working_hours", facet: "work", scope: "global" }, at, parseWorkingHours, "a window (`HH:MM-HH:MM`)");
  }

  // Generic re-resolution by key, used by execute() to check a plan's seat_versions.
  resolveKey(key: string, at: number): { state: LookupState; card_id: string | null } {
    const [topic, facet, scope] = key.split("|");
    const r = this.lookup({ topic, facet, scope }, at, (q) => q, "");
    return { state: r.state, card_id: r.card_id };
  }

  private cardsOnChain(seat: Seat): CheckedCard[] {
    const out: CheckedCard[] = [];
    for (const scope of scopeChain(this.vocab, seat.scope)) out.push(...this.graph.cardsOn({ ...seat, scope }));
    return out;
  }

  private lookup<T>(seat: Seat, at: number, parse: (quote: string) => T | null, expected: string): Lookup<T> {
    const key = seatKey(seat);
    const base = { key, card_id: null, cards: [] as string[], replaced: null };
    const name = (c: CheckedCard) => `${c.card_id} ("${c.quote}", ${c.decided_at})`;

    // A decision we cannot date cannot be ordered against the others, so the seat cannot be read.
    const undated = this.cardsOnChain(seat).filter((c) => parseTime(c.decided_at) === null);
    if (undated.length) {
      const all = this.cardsOnChain(seat);
      return { ...base, state: "UNDATED", cards: all.map((c) => c.card_id), reason: `${all.length} arrangement(s) on ${key} and ${undated.length === all.length ? "none" : "not all"} can be dated, so nobody can say which one holds: ${all.map(name).join(" / ")}` };
    }
    const r = this.graph.resolve(seat, at);
    if (r.state === "UNRESOLVED_CONFLICT") {
      const cards = [...new Set(r.conflicts.flatMap((l) => [l.from, l.to]))];
      return { ...base, state: "UNRESOLVED_CONFLICT", cards, reason: `the decisions on ${key} contradict each other (${r.conflicts.map((l) => l.why).join("; ")}): ${cards.map((id) => name(this.graph.cards.get(id)!)).join(" / ")}` };
    }
    if (r.state === "NOT_FOUND") return { ...base, state: "NOT_FOUND", reason: `no decision on ${key}` };
    if (!r.in_effect_card) {
      const sched = r.scheduled ? this.graph.cards.get(r.scheduled) : undefined;
      return { ...base, state: "NOT_FOUND", cards: sched ? [sched.card_id] : [], reason: sched ? `the only decision on ${key} (${name(sched)}) takes effect ${sched.effective}, after this moment` : `no decision on ${key} is in force at this moment` };
    }
    const card = this.graph.cards.get(r.in_effect_card)!;
    if (r.coexisting.length) {
      const cards = [card.card_id, ...r.coexisting];
      return { ...base, state: "AMBIGUOUS", card_id: card.card_id, cards, reason: `${cards.length} arrangements on ${key} coexist and none replaces the others: ${cards.map((id) => name(this.graph.cards.get(id)!)).join(" / ")}` };
    }
    const decided = parseTime(card.decided_at)!.start;
    if (decided > this.clock) return { ...base, state: "FUTURE", card_id: card.card_id, cards: [card.card_id], reason: `${name(card)} is dated after now (${new Date(this.clock).toISOString()})` };
    const value = parse(card.quote);
    const replacedLink = this.graph.links.find((l) => l.to === card.card_id && l.status === "ok" && l.relation === "REPLACES");
    const replacedCard = replacedLink ? this.graph.cards.get(replacedLink.from) : undefined;
    const common = {
      ...base,
      card_id: card.card_id,
      cards: [card.card_id],
      quote: card.quote,
      decided_at: card.decided_at,
      decided_by: card.decided_by,
      effective: card.effective,
      replaced: replacedCard ? { card_id: replacedCard.card_id, quote: replacedCard.quote, decided_at: replacedCard.decided_at } : null,
    };
    if (value === null) return { ...common, state: "UNREADABLE", reason: `${name(card)} is in force on ${key} but does not state ${expected}` };
    return { ...common, state: "PASS", value };
  }
}
