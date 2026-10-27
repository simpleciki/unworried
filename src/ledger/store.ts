// The decision ledger on disk, one directory per session: confirmed cards, relation edges, the value
// side table (card_id → value in the shapes data/vocab.yaml documents), the source records the cards
// quote, and pending candidates (never read by the graph). Append-only: a card is withdrawn by a new line,
// never deleted. A line that does not parse → the store refuses to open (same stance as the spend ledger).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SeatGraph } from "../engine/seats.ts";
import type { CardMode, CheckedCard, Relation, RelationEdge, SourceRecord } from "../engine/types.ts";
import type { Vocab } from "../engine/vocab.ts";
import { SeatsView } from "../action/seats-view.ts";
import { chicagoIso } from "../time/chicago.ts";

export type EdgeSource = "seed" | "model" | "human";
export type EdgeLine = RelationEdge & { source: EdgeSource };
export type ValueLine = { card_id: string; value: string; source: "seed" | "human" };
export type WithdrawLine = { withdrawn: string; at: string; reason?: string };

// The fields of a card as proposed from one sentence, before confirmation. `decided_at` / `effective`
// are null until known; nothing is ever defaulted silently.
export type CandidateCard = {
  quote: string;
  mode: CardMode;
  topic: string;
  facet: string;
  scope: string;
  decided_by: string;
  decided_at: string | null;
  effective: string | null;
  source_recorded_at: string; // = sent_at; shown beside decided_at when they differ
};

export type Candidate = {
  candidate_id: string;
  session_id: string;
  message_id: string;
  sent_at: string;
  text: string; // the user's message, verbatim
  card: CandidateCard;
  value: string | null; // in the facet's documented shape
  unsure: string[]; // field names the user must fill or correct before confirmation
  note?: string; // e.g. "the model is off; fill the card yourself"
  same_seat: string[]; // cards currently on the same seat (for the relation step)
  relations: Record<string, Relation>; // existing card_id → proposed relation
  relation_notes?: Record<string, string>; // why a proposed relation was kept or downgraded
  status: "pending" | "confirmed" | "discarded";
  card_id?: string; // once confirmed
  created_at: string;
  mode_of_origin: "model" | "rules" | "seed";
};

export type SeedLedger = { cards: CheckedCard[]; edges: EdgeLine[]; values: ValueLine[]; records: SourceRecord[] };

export type SeedMessage = {
  message_id: string;
  sent_at: string;
  from: "me" | "assistant";
  text: string;
  cards?: Array<{
    card: { card_id: string; quote: string; mode?: CardMode; topic: string; facets: string[]; scope: string; decided_at?: string; effective?: string; decided_by?: string };
    value?: string;
    edges?: Array<{ old_card: string; relation: Relation }>;
  }>;
};

export class LedgerUnreadable extends Error {
  constructor(path: string, detail: string) {
    super(`decision ledger ${path}: ${detail}`);
    this.name = "LedgerUnreadable";
  }
}

const SESSION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const FILES = ["records", "cards", "edges", "values", "candidates"] as const;
type FileName = (typeof FILES)[number];

function readLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new LedgerUnreadable(path, `cannot read (${(e as Error).message})`);
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, i) => {
    try {
      const v = JSON.parse(line);
      if (!v || typeof v !== "object") throw new Error("not an object");
      return v;
    } catch {
      throw new LedgerUnreadable(path, `line ${i + 1} is not a JSON object`);
    }
  });
}

// data/conversation-seed.jsonl → the ledger a fresh session starts from. Deterministic, no model.
export function loadConversationSeed(path: string): { messages: SeedMessage[]; ledger: SeedLedger } {
  const messages = readLines(path) as SeedMessage[];
  return { messages, ledger: ledgerFromMessages(messages, path) };
}
loadConversationSeed.fromMessages = (messages: SeedMessage[]): SeedLedger => ledgerFromMessages(messages, "(messages)");

export function ledgerFromMessages(messages: SeedMessage[], path: string): SeedLedger {
  const ledger: SeedLedger = { cards: [], edges: [], values: [], records: [] };
  const ids = new Set<string>();
  messages.forEach((m, i) => {
    const where = `${path} line ${i + 1}`;
    if (typeof m.message_id !== "string" || typeof m.sent_at !== "string" || typeof m.text !== "string" || (m.from !== "me" && m.from !== "assistant")) throw new LedgerUnreadable(path, `line ${i + 1}: message needs message_id, sent_at, from, text`);
    if (Number.isNaN(Date.parse(m.sent_at)) || !/[+-]\d{2}:\d{2}$/.test(m.sent_at)) throw new LedgerUnreadable(path, `line ${i + 1}: sent_at must be ISO 8601 with an offset`);
    if (!m.cards?.length) return;
    if (m.from !== "me") throw new LedgerUnreadable(path, `line ${i + 1}: only "me" messages carry cards`);
    ledger.records.push({ record_id: m.message_id, source_type: "client_message", source_version: "v1", text: m.text, author: "me", source_recorded_at: m.sent_at, thread_id: "morgan" });
    for (const entry of m.cards) {
      const c = entry.card;
      if (ids.has(c.card_id)) throw new LedgerUnreadable(path, `${where}: duplicate card ${c.card_id}`);
      ids.add(c.card_id);
      const decided_at = c.decided_at ?? m.sent_at;
      ledger.cards.push({
        card_id: c.card_id,
        record_id: m.message_id,
        quote: c.quote,
        mode: c.mode ?? "decides",
        topic: c.topic,
        facets: [...c.facets],
        scope: c.scope,
        decided_at,
        effective: c.effective ?? decided_at,
        decided_by: c.decided_by ?? "me",
        source: "human",
        result: "PASS",
      });
      if (entry.value !== undefined) ledger.values.push({ card_id: c.card_id, value: entry.value, source: "seed" });
      for (const e of entry.edges ?? []) ledger.edges.push({ old_card: e.old_card, new_card: c.card_id, relation: e.relation, source: "seed" });
    }
  });
  for (const e of ledger.edges) {
    if (!ids.has(e.old_card)) throw new LedgerUnreadable(path, `edge ${e.old_card} → ${e.new_card}: unknown old card`);
  }
  return ledger;
}

export class LedgerStore {
  readonly session: string;
  readonly dir: string;
  readonly vocab: Vocab;
  private readonly seed: SeedLedger;
  private readonly now: () => number;
  private state!: { records: SourceRecord[]; cards: CheckedCard[]; withdrawn: Set<string>; edges: EdgeLine[]; values: Map<string, string>; candidates: Map<string, Candidate> };

  constructor(opts: { dir: string; session: string; vocab: Vocab; seed: SeedLedger; now?: () => number }) {
    if (!SESSION_ID.test(opts.session)) throw new LedgerUnreadable(opts.dir, `session id ${JSON.stringify(opts.session)} must match ${SESSION_ID}`);
    this.session = opts.session;
    this.dir = join(opts.dir, opts.session);
    this.vocab = opts.vocab;
    this.seed = opts.seed;
    this.now = opts.now ?? Date.now;
    if (!existsSync(join(this.dir, "cards.jsonl"))) this.writeSeed();
    this.load();
  }

  private file(name: FileName) {
    return join(this.dir, `${name}.jsonl`);
  }

  private writeSeed() {
    mkdirSync(this.dir, { recursive: true });
    const dump = (name: FileName, lines: unknown[]) => writeFileSync(this.file(name), lines.map((l) => JSON.stringify(l) + "\n").join(""));
    dump("records", this.seed.records);
    dump("cards", this.seed.cards);
    dump("edges", this.seed.edges);
    dump("values", this.seed.values);
    dump("candidates", []);
  }

  private load() {
    const records = readLines(this.file("records")).map((l, i) => validateRecord(l, `${this.file("records")} line ${i + 1}`));
    const cards: CheckedCard[] = [];
    const withdrawn = new Set<string>();
    readLines(this.file("cards")).forEach((l, i) => {
      const o = l as Record<string, unknown>;
      if (typeof o.withdrawn === "string") withdrawn.add(o.withdrawn);
      else cards.push(validateCard(o, `${this.file("cards")} line ${i + 1}`));
    });
    const edges = readLines(this.file("edges")).map((l, i) => validateEdge(l, `${this.file("edges")} line ${i + 1}`));
    const values = new Map<string, string>();
    readLines(this.file("values")).forEach((l, i) => {
      const o = l as Record<string, unknown>;
      if (typeof o.card_id !== "string" || typeof o.value !== "string") throw new LedgerUnreadable(this.file("values"), `line ${i + 1}: needs card_id and value`);
      values.set(o.card_id, o.value); // the latest line for a card wins
    });
    const candidates = new Map<string, Candidate>();
    readLines(this.file("candidates")).forEach((l, i) => {
      const o = l as Candidate;
      if (typeof o.candidate_id !== "string" || !o.card || typeof o.status !== "string") throw new LedgerUnreadable(this.file("candidates"), `line ${i + 1}: not a candidate`);
      candidates.set(o.candidate_id, o); // latest line wins
    });
    this.state = { records, cards, withdrawn, edges, values, candidates };
  }

  private append(name: FileName, line: unknown) {
    appendFileSync(this.file(name), JSON.stringify(line) + "\n");
  }

  // ---- reads ----------------------------------------------------------------------------------------

  cards(): CheckedCard[] {
    return this.state.cards.filter((c) => !this.state.withdrawn.has(c.card_id));
  }
  card(id: string): CheckedCard | undefined {
    return this.cards().find((c) => c.card_id === id);
  }
  edges(): EdgeLine[] {
    return this.state.edges.filter((e) => !this.state.withdrawn.has(e.old_card) && !this.state.withdrawn.has(e.new_card));
  }
  records(): SourceRecord[] {
    return [...this.state.records];
  }
  values(): Map<string, string> {
    return new Map(this.state.values);
  }
  valueOf(card_id: string): string | undefined {
    return this.state.values.get(card_id);
  }
  candidates(status?: Candidate["status"]): Candidate[] {
    return [...this.state.candidates.values()].filter((c) => !status || c.status === status);
  }
  candidate(id: string): Candidate | undefined {
    return this.state.candidates.get(id);
  }

  // The seat graph from confirmed cards only. Candidates are invisible here.
  graph(): SeatGraph {
    return new SeatGraph(this.cards(), this.edges(), this.records(), this.vocab);
  }

  seatsView(clock: number): SeatsView {
    return new SeatsView(this.graph(), this.vocab, clock, (id) => this.state.values.get(id));
  }

  // ---- writes (append-only) ---------------------------------------------------------------------------

  addCard(card: CheckedCard, record: SourceRecord, edges: EdgeLine[], value: string | null): void {
    if (this.state.cards.some((c) => c.card_id === card.card_id)) throw new Error(`ledger: card ${card.card_id} already exists`);
    for (const e of edges) {
      if (e.new_card !== card.card_id) throw new Error(`ledger: edge ${e.old_card} → ${e.new_card} does not point at ${card.card_id}`);
      if (!this.card(e.old_card)) throw new Error(`ledger: edge names unknown card ${e.old_card}`);
    }
    if (!this.state.records.some((r) => r.record_id === record.record_id)) {
      this.append("records", record);
      this.state.records.push(record);
    }
    this.append("cards", card);
    this.state.cards.push(card);
    for (const e of edges) {
      this.append("edges", e);
      this.state.edges.push(e);
    }
    if (value !== null) {
      const line: ValueLine = { card_id: card.card_id, value, source: "human" };
      this.append("values", line);
      this.state.values.set(card.card_id, value);
    }
  }

  withdraw(card_id: string, reason?: string): void {
    if (!this.card(card_id)) throw new Error(`ledger: cannot withdraw unknown or already withdrawn card ${card_id}`);
    const line: WithdrawLine = { withdrawn: card_id, at: chicagoIso(this.now()), ...(reason ? { reason } : {}) };
    this.append("cards", line);
    this.state.withdrawn.add(card_id);
  }

  putCandidate(c: Candidate): void {
    this.append("candidates", c);
    this.state.candidates.set(c.candidate_id, c);
  }

  // Back to the seeded ledger. Not called by the assistant; the demo harness does.
  reset(): void {
    rmSync(this.dir, { recursive: true, force: true });
    this.writeSeed();
    this.load();
  }

  get stamp(): string {
    return chicagoIso(this.now());
  }
}

// ---- validation ------------------------------------------------------------------------------------

const MODES = new Set<CardMode>(["decides", "mentions", "gives_reason", "proposes"]);
const RELATIONS = new Set<Relation>(["REPLACES", "SAME", "REFINES", "UNRELATED"]);

function validateRecord(v: unknown, where: string): SourceRecord {
  const o = v as Record<string, unknown>;
  for (const k of ["record_id", "text", "author", "source_recorded_at"]) if (typeof o[k] !== "string") throw new LedgerUnreadable(where, `record field ${k} must be a string`);
  return { record_id: o.record_id as string, source_type: "client_message", source_version: "v1", text: o.text as string, author: o.author as string, source_recorded_at: o.source_recorded_at as string, thread_id: typeof o.thread_id === "string" ? o.thread_id : "morgan" };
}

export function validateCard(v: unknown, where: string): CheckedCard {
  const o = v as Record<string, unknown>;
  for (const k of ["card_id", "record_id", "quote", "topic", "scope", "decided_at", "effective", "decided_by"]) {
    if (typeof o[k] !== "string") throw new LedgerUnreadable(where, `card field ${k} must be a string`);
  }
  if (!MODES.has(o.mode as CardMode)) throw new LedgerUnreadable(where, `card mode ${String(o.mode)} is not one of ${[...MODES].join(", ")}`);
  if (!Array.isArray(o.facets) || !o.facets.length || o.facets.some((f) => typeof f !== "string")) throw new LedgerUnreadable(where, "card facets must be a non-empty string array");
  if (o.result !== "PASS") throw new LedgerUnreadable(where, `a confirmed card must have result PASS, not ${String(o.result)}`);
  return {
    card_id: o.card_id as string,
    record_id: o.record_id as string,
    quote: o.quote as string,
    mode: o.mode as CardMode,
    topic: o.topic as string,
    facets: [...(o.facets as string[])],
    scope: o.scope as string,
    decided_at: o.decided_at as string,
    effective: o.effective as string,
    decided_by: o.decided_by as string,
    source: "human",
    result: "PASS",
  };
}

function validateEdge(v: unknown, where: string): EdgeLine {
  const o = v as Record<string, unknown>;
  if (typeof o.old_card !== "string" || typeof o.new_card !== "string") throw new LedgerUnreadable(where, "edge needs old_card and new_card");
  if (!RELATIONS.has(o.relation as Relation)) throw new LedgerUnreadable(where, `edge relation ${String(o.relation)} is not one of ${[...RELATIONS].join(", ")}`);
  const source = o.source === "human" || o.source === "model" || o.source === "seed" ? o.source : "seed";
  return { old_card: o.old_card, new_card: o.new_card, relation: o.relation as Relation, source };
}
