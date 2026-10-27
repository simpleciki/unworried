// Shared shapes for the deterministic engine. Inputs mirror the files under data/;
// cards and edges are model outputs in a real run and gold files in oracle mode.

export type SourceType =
  | "client_message"
  | "internal_note"
  | "field_note"
  | "quote_version"
  | "work_order"
  | "submission_event"
  | "invoice";

export type SourceRecord = {
  record_id: string;
  source_type: SourceType;
  source_version: string;
  text: string;
  author: string;
  source_recorded_at: string;
  thread_id?: string;
  row_key?: string;
};

export type CardMode = "decides" | "mentions" | "gives_reason" | "proposes";

export type DecisionCard = {
  card_id: string;
  record_id: string;
  quote: string;
  mode: CardMode;
  topic: string;
  facets: string[];
  scope: string;
  decided_at: string;
  effective: string;
  decided_by: string;
  source?: "model" | "human"; // absent = model; "human" = from a review judgment (src/review/judgments.ts)
  judgment_id?: string;
  mode_used?: CardMode; // human cards: what the engine applies when it differs from the mode the person chose
};

export type Relation = "REPLACES" | "SAME" | "REFINES" | "UNRELATED";
export type RelationEdge = { old_card: string; new_card: string; relation: Relation };

export type Seat = { topic: string; facet: string; scope: string };
export const seatKey = (s: Seat) => `${s.topic}|${s.facet}|${s.scope}`;

export const RESULTS = [
  "PASS",
  "REPLACED_BY_SUCCESSOR",
  "UNRESOLVED_CONFLICT",
  "NOT_FOUND",
  "OUT_OF_SCOPE",
  "REJECTED",
] as const;
export type Result = (typeof RESULTS)[number];

// A card after verification: accepted cards keep their (possibly downgraded) mode.
export type CheckedCard = DecisionCard & { result: "PASS" | "OUT_OF_SCOPE" | "REJECTED"; reason?: string };

export type Row = Record<string, string>;

export type Tables = {
  clients: Row[];
  workOrders: Row[];
  quotes: Row[];
  quoteLines: Row[];
  events: Row[];
  invoices: Row[];
  invoiceLines: Row[];
};

// views: cross-source rows read through Zetaris (or their in-memory equivalent). Optional: the engine's
// conclusions never depend on them; they add cross-system context to the evidence.
export type Dataset = { records: SourceRecord[]; tables: Tables; views?: { invoice_vs_approved?: Row[]; job_evidence_timeline?: Row[] } };

// evidence backs a fired flag; support cites what a check found clean (e.g. a promise closed by its result).
export type Flag = { pattern: string; fired: boolean; evidence: string[]; details: Record<string, unknown>; support?: string[] };

// Trace hook: the engine reports notable events (downgrades, drift, overrides); callers decide where they go.
export type EngineEvent = { action: string; ref: string; outcome: string; details?: Record<string, unknown> };
export type EventSink = (e: EngineEvent) => void;
export const noEvents: EventSink = () => {};
