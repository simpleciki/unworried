// confirm(candidate, edits) → the user's field edits are applied, the code checks run again, and only a
// candidate with nothing left `unsure` becomes a card (+ edges, + value) in the ledger. discard() drops it.
import type { CheckedCard, Relation, SourceRecord } from "../engine/types.ts";
import type { SeatResolution } from "../engine/seats.ts";
import { seatKey } from "../engine/types.ts";
import type { Candidate, CandidateCard, EdgeLine, LedgerStore } from "../ledger/store.ts";
import { checkCandidate } from "./intake.ts";
import type { VocabExtras } from "./prompts.ts";

export type ConfirmEdits = {
  card?: Partial<CandidateCard>;
  value?: string | null;
  relations?: Record<string, Relation>; // the user's word on how this relates to each existing card; wins over the model
  card_id?: string;
};

export type ConfirmResult =
  | { ok: true; card: CheckedCard; seat: string; resolution: SeatResolution; holds_seat: boolean }
  | { ok: false; reason: string; unsure: string[]; candidate: Candidate };

export type ConfirmDeps = { store: LedgerStore; extras: VocabExtras; clock: number };

export function confirm(candidate_id: string, edits: ConfirmEdits, deps: ConfirmDeps): ConfirmResult {
  const c = deps.store.candidate(candidate_id);
  if (!c) throw new Error(`unknown candidate ${candidate_id}`);
  if (c.status !== "pending") throw new Error(`candidate ${candidate_id} is already ${c.status}`);

  const merged: CandidateCard = { ...c.card, ...(edits.card ?? {}), source_recorded_at: c.sent_at };
  const value = edits.value !== undefined ? edits.value : c.value;
  const checked = checkCandidate(merged, value, c.text, deps.store.vocab, deps.extras);
  if (checked.unsure.length) {
    const next: Candidate = { ...c, card: checked.card, value: checked.value, unsure: checked.unsure };
    deps.store.putCandidate(next);
    return { ok: false, reason: `cannot confirm: still unsure about ${checked.unsure.join(", ")}`, unsure: checked.unsure, candidate: next };
  }

  const card_id = edits.card_id ?? `card.${candidate_id}`;
  const card: CheckedCard = {
    card_id,
    record_id: c.message_id,
    quote: checked.card.quote,
    mode: checked.card.mode,
    topic: checked.card.topic,
    facets: [checked.card.facet],
    scope: checked.card.scope,
    decided_at: checked.card.decided_at!,
    effective: checked.card.effective!,
    decided_by: checked.card.decided_by,
    source: "human",
    result: "PASS",
  };
  const record: SourceRecord = { record_id: c.message_id, source_type: "client_message", source_version: "v1", text: c.text, author: "me", source_recorded_at: c.sent_at, thread_id: "morgan" };
  const holds = card.mode === "decides"; // mentions / proposals hold no seat (engine rule); no edges, no value
  const edges: EdgeLine[] = [];
  if (holds) {
    for (const old of c.same_seat) {
      const human = edits.relations?.[old];
      const relation = human ?? c.relations[old] ?? "UNRELATED";
      if (relation === "UNRELATED") continue;
      if (!deps.store.card(old)) continue;
      edges.push({ old_card: old, new_card: card_id, relation, source: human ? "human" : c.mode_of_origin === "model" ? "model" : "human" });
    }
  }
  deps.store.addCard(card, record, edges, holds ? checked.value : null);
  deps.store.putCandidate({ ...c, card: checked.card, value: checked.value, unsure: [], status: "confirmed", card_id, relations: { ...c.relations, ...(edits.relations ?? {}) } });
  const seat = { topic: card.topic, facet: card.facets[0], scope: card.scope };
  return { ok: true, card, seat: seatKey(seat), resolution: deps.store.graph().resolve(seat, deps.clock), holds_seat: holds };
}

export function discard(candidate_id: string, deps: { store: LedgerStore }): Candidate {
  const c = deps.store.candidate(candidate_id);
  if (!c) throw new Error(`unknown candidate ${candidate_id}`);
  if (c.status !== "pending") throw new Error(`candidate ${candidate_id} is already ${c.status}`);
  const next: Candidate = { ...c, status: "discarded" };
  deps.store.putCandidate(next);
  return next;
}
