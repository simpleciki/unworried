// Candidate vs the cards already on its seat: one `relate` call proposes REPLACES / REFINES / SAME /
// UNRELATED per existing card; a Skeptic check in code keeps a verdict only when the two quotes support
// it. Unsupported → UNRELATED, which leaves both cards on the seat, so the action layer refuses and asks.
// The user may override on confirmation; a human relation wins and is recorded as such.
import { compare } from "../engine/time.ts";
import type { CheckedCard, Relation } from "../engine/types.ts";
import { normaliseText } from "../engine/verify.ts";
import { MemoryCache } from "../llm/cache.ts";
import type { ResponseCache } from "../llm/cache.ts";
import { CallBudget, ModelClient } from "../llm/client.ts";
import { arr, obj, oneOf, str } from "../llm/json.ts";
import type { SpendGuard } from "../spend/guard.ts";
import type { Candidate, CandidateCard, LedgerStore } from "../ledger/store.ts";
import { relatePrompt } from "./prompts.ts";

export type RelateDeps = { guard: SpendGuard; store: LedgerStore; action_id: string; cache?: ResponseCache };
export type RelateResult = { candidate: Candidate; mode: "model" | "rules"; note?: string };

const RELATIONS = ["REPLACES", "REFINES", "SAME", "UNRELATED"] as const;

export function parseRelateReply(v: unknown): { relations: Array<{ card_id: string; relation: Relation; because: string }> } {
  const o = obj(v, "reply");
  return {
    relations: arr(o.relations, "relations").map((r, i) => {
      const x = obj(r, `relations[${i}]`);
      return { card_id: str(x.card_id, `relations[${i}].card_id`), relation: oneOf(x.relation, RELATIONS, `relations[${i}].relation`), because: typeof x.because === "string" ? x.because : "" };
    }),
  };
}

const STOP = new Set(["that", "this", "with", "from", "then", "than", "them", "they", "have", "will", "when", "what", "which", "there", "their", "about", "into", "also", "only", "just", "more", "some", "other", "people", "comes", "come", "picks", "pick", "theo", "me", "my", "the", "and", "for", "now", "may", "not", "be", "moved", "too", "by", "assistant"]);
const words = (s: string) => new Set(normaliseText(s).toLowerCase().replace(/[^a-z0-9: -]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));

// Is this verdict supported by the two quotes (and their dates)? Returns the relation to keep.
export function skepticCheck(candidate: CandidateCard, candidateValue: string | null, existing: CheckedCard, existingValue: string | undefined, verdict: Relation): { relation: Relation; note: string } {
  if (verdict === "UNRELATED") return { relation: "UNRELATED", note: "model: unrelated; both cards stay on the seat" };
  const shared = [...words(candidate.quote)].filter((w) => words(existing.quote).has(w));
  const sameValue = candidateValue !== null && existingValue !== undefined && normaliseText(candidateValue).toLowerCase() === normaliseText(existingValue).toLowerCase();
  if (verdict === "SAME") {
    if (sameValue || normaliseText(candidate.quote).toLowerCase() === normaliseText(existing.quote).toLowerCase()) return { relation: "SAME", note: "same value or same words" };
    return { relation: "UNRELATED", note: `SAME not supported: values differ (${candidateValue ?? "none"} vs ${existingValue ?? "none"}) and the words differ` };
  }
  // REPLACES / REFINES: the new decision must not predate the old one, and the quotes must be about the same thing.
  const order = candidate.decided_at ? compare(existing.decided_at, candidate.decided_at) : "incomparable";
  if (order === "after") return { relation: "UNRELATED", note: `${verdict} not supported: the candidate (${candidate.decided_at}) was decided before ${existing.card_id} (${existing.decided_at})` };
  if (order === "incomparable") return { relation: "UNRELATED", note: `${verdict} not supported: the two decision times cannot be compared (${candidate.decided_at ?? "unknown"} vs ${existing.decided_at})` };
  if (!shared.length && !sameValue) return { relation: "UNRELATED", note: `${verdict} not supported: the quotes share no content word ("${candidate.quote}" vs "${existing.quote}")` };
  return { relation: verdict, note: `${verdict} supported: ${shared.length ? `shared words ${shared.join(", ")}` : "same value"}; decided ${order === "before" ? "later" : "around the same time"}` };
}

export async function relate(candidate: Candidate, deps: RelateDeps): Promise<RelateResult> {
  if (!candidate.same_seat.length || candidate.card.mode !== "decides") return { candidate, mode: "rules", note: "nothing on the seat to relate to" };
  const existing = candidate.same_seat.map((id) => deps.store.card(id)).filter((c): c is CheckedCard => !!c);
  const relations: Record<string, Relation> = {};
  const relation_notes: Record<string, string> = {};
  const persist = (mode: "model" | "rules", note?: string): RelateResult => {
    const next: Candidate = { ...candidate, relations, relation_notes, ...(note ? { note: [candidate.note, note].filter(Boolean).join("; ") } : {}) };
    deps.store.putCandidate(next);
    return { candidate: next, mode, ...(note ? { note } : {}) };
  };

  const state = deps.guard.state();
  if (!state.enabled || !state.model) {
    for (const c of existing) {
      relations[c.card_id] = "UNRELATED";
      relation_notes[c.card_id] = `the model is off (${state.reason}); say on confirmation whether this replaces ${c.card_id}`;
    }
    return persist("rules", "the model is off; relations left UNRELATED for you to set");
  }

  const provider = deps.guard.asProvider({ session_id: candidate.session_id, action_id: deps.action_id, kind: "relate" });
  const client = new ModelClient(provider, deps.cache ?? new MemoryCache(), new CallBudget(2));
  const { system, user } = relatePrompt({ candidate: candidate.card, candidateValue: candidate.value, existing: existing.map((card) => ({ card, value: deps.store.valueOf(card.card_id) })) });
  let proposed = new Map<string, Relation>();
  let note: string | undefined;
  try {
    const reply = await client.json({ stage: "relate", agent: "relate", model: state.model, system, user }, parseRelateReply, 1);
    if (reply.value) proposed = new Map(reply.value.relations.map((r) => [r.card_id, r.relation]));
    else note = `the model's reply could not be used (${reply.error}); relations left UNRELATED`;
  } catch (e) {
    note = `the model call was refused (${(e as Error).message}); relations left UNRELATED`;
  }
  for (const c of existing) {
    const verdict = proposed.get(c.card_id) ?? "UNRELATED";
    const checked = skepticCheck(candidate.card, candidate.value, c, deps.store.valueOf(c.card_id), verdict);
    relations[c.card_id] = checked.relation;
    relation_notes[c.card_id] = proposed.has(c.card_id) ? checked.note : "model gave no verdict for this card";
  }
  return persist(note ? "rules" : "model", note);
}
