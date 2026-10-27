// Small hand-made inputs for unit tests (not the project dataset).
import type { CheckedCard, RelationEdge, SourceRecord } from "./types.ts";
import type { Vocab } from "./vocab.ts";

export const vocab: Vocab = {
  topics: new Set(["price", "approval", "client_rule", "open_item", "scope"]),
  facets: new Set(["price.labor", "price.material", "approval.status", "client_rule.cap", "open_item.inspection", "scope.structure"]),
  scopes: new Set(["global", "client:c1", "job:j1"]),
  parent: { "job:j1": "client:c1", "client:c1": "global" },
  deciders: { price: ["p.client"], approval: ["p.client"], client_rule: ["p.client"], scope: ["p.client"] },
};

let n = 0;
export function rec(text: string, recorded: string, author = "p.client"): SourceRecord {
  n++;
  return { record_id: `r${n}`, source_type: "client_message", source_version: "v1", text, author, source_recorded_at: recorded, thread_id: "j1" };
}

export function card(id: string, r: SourceRecord, over: Partial<CheckedCard> = {}): CheckedCard {
  return {
    card_id: id,
    record_id: r.record_id,
    quote: r.text,
    mode: "decides",
    topic: "price",
    facets: ["price.labor"],
    scope: "client:c1",
    decided_at: r.source_recorded_at,
    effective: r.source_recorded_at,
    decided_by: "p.client",
    result: "PASS",
    ...over,
  };
}

export const replaces = (old_card: string, new_card: string): RelationEdge => ({ old_card, new_card, relation: "REPLACES" });
export const at = (iso: string) => Date.parse(iso);
