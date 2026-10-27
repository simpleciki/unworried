// Seat-graph shapes and who may hold a seat.
import type { CheckedCard, Relation, Result, Seat } from "./types.ts";
import type { Vocab } from "./vocab.ts";

// Who can hold a seat. "mentions" only reports what someone else said, so it never does. On a topic
// the client owns (it has deciders), only the client's own cards count: a contractor's note about a
// rule or a price is not the rule or the price. Contractor promises sit on open_item seats.
export function holdsSeat(c: CheckedCard, vocab: Vocab): boolean {
  if (c.mode === "mentions") return false;
  if (c.mode === "decides") return true; // already decider-checked
  if (c.mode === "proposes") return c.topic === "open_item";
  const deciders = vocab.deciders[c.topic];
  return !deciders || deciders.includes(c.decided_by);
}

export type Link = { from: string; to: string; relation: Relation; status: "ok" | "conflict"; why: string };

export type SeatResolution = {
  seat: Seat;
  scope_used: string;
  scope_fallback: boolean;
  state: Result;
  current_card: string | null;
  in_effect_card: string | null;
  coexisting: string[];
  chain: string[];
  conflicts: Link[];
  scheduled: string | null; // decided but not yet effective on the as-of date
};
