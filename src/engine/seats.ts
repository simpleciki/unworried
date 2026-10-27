// The seat graph. A seat is (topic, facet, scope); each accepted card sits on one seat per facet.
// Order on a seat comes only from relation judgments (REPLACES / SAME / REFINES) checked against
// decided_at. Unjudged cards on the same seat coexist; they are never ordered by time alone.
import type { CheckedCard, RelationEdge, Result, Seat, SourceRecord } from "./types.ts";
import { holdsSeat } from "./seat-types.ts";
import type { Link, SeatResolution } from "./seat-types.ts";

export type { Link, SeatResolution } from "./seat-types.ts";
import { seatKey } from "./types.ts";
import { compare, parseTime } from "./time.ts";
import type { Vocab } from "./vocab.ts";
import { scopeChain } from "./vocab.ts";

const ms = (iso: string) => parseTime(iso)?.start ?? Number.NaN;

export class SeatGraph {
  readonly cards = new Map<string, CheckedCard>();
  readonly bySeat = new Map<string, string[]>();
  readonly links: Link[] = [];
  private records: Map<string, SourceRecord>;

  constructor(cards: CheckedCard[], edges: RelationEdge[], records: SourceRecord[], private vocab: Vocab) {
    this.records = new Map(records.map((r) => [r.record_id, r]));
    for (const c of cards) {
      if (c.result !== "PASS" || !holdsSeat(c, vocab)) continue;
      this.cards.set(c.card_id, c);
      for (const facet of c.facets) {
        const k = seatKey({ topic: c.topic, facet, scope: c.scope });
        this.bySeat.set(k, [...(this.bySeat.get(k) ?? []), c.card_id]);
      }
    }
    for (const e of edges) this.addEdge(e);
  }

  private addEdge(e: RelationEdge) {
    const a = this.cards.get(e.old_card);
    const b = this.cards.get(e.new_card);
    if (!a || !b || e.relation === "UNRELATED") return;
    const order = compare(a.decided_at, b.decided_at);
    let status: Link["status"] = "ok";
    let why: string = order;
    if (order === "after") {
      status = "conflict";
      why = "replacement predates what it replaces";
    } else if (order === "incomparable") {
      status = "conflict";
      why = "decision times cannot be compared";
    } else if (order === "overlap") {
      const ref = this.explicitReference(a, b);
      status = ref ? "ok" : "conflict";
      why = ref ? "overlapping times; newer card explicitly references the older one" : "overlapping times, no explicit reference";
    }
    this.links.push({ from: a.card_id, to: b.card_id, relation: e.relation, status, why });
  }

  // The newer record names the older one: same quote id, or repeats the older quote's opening words.
  private explicitReference(a: CheckedCard, b: CheckedCard): boolean {
    const newer = this.records.get(b.record_id)?.text ?? "";
    const older = this.records.get(a.record_id);
    if (older?.row_key && newer.includes(older.row_key)) return true;
    const opening = a.quote.split(/\s+/).slice(0, 5).join(" ");
    return opening.split(" ").length >= 3 && newer.toLowerCase().includes(opening.toLowerCase());
  }

  cardsOn(seat: Seat): CheckedCard[] {
    return (this.bySeat.get(seatKey(seat)) ?? []).map((id) => this.cards.get(id)!);
  }

  private linksOn(ids: Set<string>): Link[] {
    return this.links.filter((l) => ids.has(l.from) && ids.has(l.to));
  }

  // Resolve one seat exactly (no fallback). asOf limits to decisions made by then (decided_at),
  // recordedBy additionally limits to cards whose record existed by then (the "as recorded" view).
  resolveExact(seat: Seat, asOf?: number, recordedBy?: number): SeatResolution {
    const visible = this.cardsOn(seat).filter((c) => {
      if (asOf !== undefined && !(ms(c.decided_at) <= asOf)) return false;
      if (recordedBy !== undefined) {
        const rec = this.records.get(c.record_id);
        if (!rec || !(ms(rec.source_recorded_at) <= recordedBy)) return false;
      }
      return true;
    });
    const base: SeatResolution = {
      seat,
      scope_used: seat.scope,
      scope_fallback: false,
      state: "NOT_FOUND",
      current_card: null,
      in_effect_card: null,
      coexisting: [],
      chain: [],
      conflicts: [],
      scheduled: null,
    };
    if (!visible.length) return base;
    const ids = new Set(visible.map((c) => c.card_id));
    const links = this.linksOn(ids);
    const ok = links.filter((l) => l.status === "ok");
    const conflicts = links.filter((l) => l.status === "conflict");
    const succeeded = new Set(ok.map((l) => l.from));
    // Latest decision first; for the same moment, the one that reaches further (later effective start) first.
    const latestFirst = (x: CheckedCard, y: CheckedCard) => ms(y.decided_at) - ms(x.decided_at) || ms(y.effective) - ms(x.effective);
    const heads = visible.filter((c) => !succeeded.has(c.card_id)).sort(latestFirst);
    const head = heads[0];
    // Walk back from a head along accepted links.
    const pred = new Map(ok.map((l) => [l.to, l.from]));
    const chainOf = (start: string) => {
      const out = [start];
      for (let p = pred.get(start); p && !out.includes(p); p = pred.get(p)) out.push(p);
      return out;
    };
    const chain = chainOf(head.card_id);
    // In effect: for every head, the first card back along its chain whose effective start has arrived.
    // Among those, a decision outranks a stated reason (a reason explains, it does not decide: rejecting
    // a later version does not undo the approval of an earlier one); then the most recent wins.
    const arrived = (id: string) => asOf === undefined || ms(this.cards.get(id)!.effective) <= asOf;
    const inForce = heads
      .map((h) => chainOf(h.card_id).find(arrived))
      .filter((id): id is string => !!id)
      .map((id) => this.cards.get(id)!)
      .sort((x, y) => Number(x.mode === "gives_reason") - Number(y.mode === "gives_reason") || latestFirst(x, y));
    const inEffect = inForce[0]?.card_id ?? null;
    return {
      ...base,
      state: conflicts.length ? "UNRESOLVED_CONFLICT" : "PASS",
      current_card: head.card_id,
      in_effect_card: inEffect,
      coexisting: heads.slice(1).map((c) => c.card_id),
      chain,
      conflicts,
      scheduled: asOf !== undefined && ms(head.effective) > asOf ? head.card_id : null,
    };
  }

  // Seat lookup with scope fallback: job -> client -> global. The answer says when it fell back.
  // A broader seat also wins when its decision is newer than everything on the narrower seat:
  // a client-wide change made later outranks an older job-level remark on the same facet.
  resolve(seat: Seat, asOf?: number): SeatResolution {
    const found = scopeChain(this.vocab, seat.scope)
      .map((scope) => this.resolveExact({ ...seat, scope }, asOf))
      .filter((r) => r.state !== "NOT_FOUND");
    if (!found.length) return { ...this.resolveExact(seat, asOf), seat };
    const decidedAt = (r: SeatResolution) => ms(this.cards.get(r.current_card!)!.decided_at);
    let best = found[0];
    for (const r of found.slice(1)) {
      const head = this.cards.get(r.current_card!)!;
      if (head.mode === "decides" && decidedAt(r) > decidedAt(best)) best = r;
    }
    return { ...best, seat, scope_fallback: best.scope_used !== seat.scope };
  }

  current(seat: Seat, asOf?: number) {
    return this.resolve(seat, asOf).current_card;
  }
  inEffect(seat: Seat, asOf: number) {
    return this.resolve(seat, asOf).in_effect_card;
  }
  asRecorded(seat: Seat, asOf: number) {
    return this.resolveExact(seat, asOf, asOf);
  }

  // Final status of every card at the end of the data (for the seat table and H-MEM).
  cardStatus(): Record<string, { result: Result; replaced_by?: string }> {
    const out: Record<string, { result: Result; replaced_by?: string }> = {};
    for (const id of this.cards.keys()) out[id] = { result: "PASS" };
    for (const l of this.links) {
      if (l.status === "conflict") {
        out[l.from] = { result: "UNRESOLVED_CONFLICT" };
        out[l.to] = { result: "UNRESOLVED_CONFLICT" };
      } else if (l.relation === "REPLACES" && out[l.from].result !== "UNRESOLVED_CONFLICT") {
        out[l.from] = { result: "REPLACED_BY_SUCCESSOR", replaced_by: l.to };
      }
    }
    return out;
  }

  seatTable() {
    const seats: Record<string, ReturnType<SeatGraph["resolveExact"]>> = {};
    for (const k of [...this.bySeat.keys()].sort()) {
      const [topic, facet, scope] = k.split("|");
      seats[k] = this.resolveExact({ topic, facet, scope });
    }
    return { seats, cards: this.cardStatus(), links: this.links };
  }
}
