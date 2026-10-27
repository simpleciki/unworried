// Card verification: the quote must really be in its record, keys must exist in the vocab,
// and decisions must come from someone allowed to make them.
import type { CheckedCard, DecisionCard, EventSink, SourceRecord } from "./types.ts";
import { noEvents } from "./types.ts";
import type { Vocab } from "./vocab.ts";
import { applyDeciderCheck, keyProblems } from "./vocab.ts";

export function normaliseText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function verifyCards(
  cards: DecisionCard[],
  records: SourceRecord[],
  vocab: Vocab,
  emit: EventSink = noEvents,
): CheckedCard[] {
  const byId = new Map(records.map((r) => [r.record_id, r]));
  return cards.map((raw) => {
    const rec = byId.get(raw.record_id);
    if (!rec) return { ...raw, result: "REJECTED", reason: `unknown record ${raw.record_id}` };
    if (!normaliseText(rec.text).includes(normaliseText(raw.quote))) {
      return { ...raw, result: "REJECTED", reason: "quote not found in record text" };
    }
    if (!vocab.scopes.has(raw.scope)) return { ...raw, result: "OUT_OF_SCOPE", reason: `unknown scope ${raw.scope}` };
    const problems = keyProblems(vocab, raw);
    if (problems.length) return { ...raw, result: "REJECTED", reason: problems.join("; ") };
    const card = applyDeciderCheck(vocab, raw, emit);
    return { ...card, result: "PASS" };
  });
}
