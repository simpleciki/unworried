// One user message → 0..n candidate cards. The model proposes (through the spending wall, wrapped in
// ModelClient); code verifies every field and moves anything it cannot verify into `unsure`; nothing enters
// the ledger until the user confirms. When the wall is off, a rule fallback produces an all-unsure
// candidate for sentences that look like decisions, and nothing for the rest.
import { randomUUID } from "node:crypto";
import { applyDeciderCheck, keyProblems } from "../engine/vocab.ts";
import type { Vocab } from "../engine/vocab.ts";
import { parseTime } from "../engine/time.ts";
import type { CardMode, Seat } from "../engine/types.ts";
import type { SeatGraph } from "../engine/seats.ts";
import { normaliseText } from "../engine/verify.ts";
import { MemoryCache } from "../llm/cache.ts";
import type { ResponseCache } from "../llm/cache.ts";
import { CallBudget, ModelClient } from "../llm/client.ts";
import { arr, obj, oneOf, str, strArr } from "../llm/json.ts";
import type { SpendGuard } from "../spend/guard.ts";
import type { Candidate, CandidateCard, LedgerStore } from "../ledger/store.ts";
import { parseMovable, parsePickupBackup, parsePriority, parseWorkingHours } from "../action/seats-view.ts";
import { chicagoIso } from "../time/chicago.ts";
import { resolveRelativeStart } from "../time/relative.ts";
import { intakePrompt } from "./prompts.ts";
import type { VocabExtras } from "./prompts.ts";

export type IntakeMessage = { message_id: string; session_id: string; text: string; sent_at: string };

export type IntakeDeps = {
  guard: SpendGuard;
  store: LedgerStore;
  extras: VocabExtras;
  action_id: string;
  cache?: ResponseCache;
  now?: () => number;
  newId?: () => string;
};

export type IntakeResult = { candidates: Candidate[]; mode: "model" | "rules"; note?: string };

// What the model is asked to return, before any verification.
export type RawCard = {
  quote: string;
  mode: CardMode;
  topic: string;
  facet: string;
  scope: string;
  decided_by: string;
  effective: string | null;
  decided_at: string | null;
  value: string | null;
  unsure: string[];
};

const MODES = ["decides", "mentions", "proposes", "gives_reason"] as const;

const strOrNull = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined) return null;
  return str(v, what);
};

export function parseIntakeReply(v: unknown): { cards: RawCard[] } {
  const o = obj(v, "reply");
  const cards = arr(o.cards, "cards").map((c, i) => {
    const card = obj(c, `cards[${i}]`);
    return {
      quote: str(card.quote, `cards[${i}].quote`),
      mode: oneOf(card.mode, MODES, `cards[${i}].mode`),
      topic: str(card.topic, `cards[${i}].topic`),
      facet: str(card.facet, `cards[${i}].facet`),
      scope: str(card.scope, `cards[${i}].scope`),
      decided_by: str(card.decided_by ?? "me", `cards[${i}].decided_by`),
      effective: strOrNull(card.effective, `cards[${i}].effective`),
      decided_at: strOrNull(card.decided_at, `cards[${i}].decided_at`),
      value: strOrNull(card.value, `cards[${i}].value`),
      unsure: card.unsure === undefined ? [] : strArr(card.unsure, `cards[${i}].unsure`),
    };
  });
  return { cards };
}

// Sentences that look like a decision, for the rule fallback (no model).
export const DECISION_MARKERS = /\b(from now on|from (next|this|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d)|instead|change(?:s|d)? to|switch(?:es|ed)? to|no longer|picks? up|may (?:not )?be moved|backup|comes? first|rank \d|working hours|change of plan)\b/i;

const QUESTION = /\?\s*$/;
const PROPOSAL = /^\s*(should|shall|maybe|could|what if|how about|perhaps)\b/i;

export const VALUE_PARSERS: Record<string, (s: string) => unknown> = {
  priority: parsePriority,
  movable: parseMovable,
  pickup_backup: parsePickupBackup,
  working_hours: parseWorkingHours,
};

// Code verifies a candidate's fields against the message, the vocabulary and the value shapes. A field
// that fails is listed in `unsure` (never dropped, never defaulted). Returns the possibly adjusted card.
export function checkCandidate(card: CandidateCard, value: string | null, text: string, vocab: Vocab, extras: VocabExtras): { card: CandidateCard; value: string | null; unsure: string[]; notes: string[] } {
  const unsure = new Set<string>();
  const notes: string[] = [];
  const out: CandidateCard = { ...card };

  if (!out.quote || !normaliseText(text).includes(normaliseText(out.quote))) unsure.add("quote");
  // Mode: the message's own shape wins over the model's label.
  if (QUESTION.test(text) && out.mode === "decides") {
    out.mode = "mentions";
    notes.push("a question is a mention, not a decision");
  } else if (PROPOSAL.test(text) && out.mode === "decides") {
    out.mode = "proposes";
    notes.push("a suggestion is a proposal, not a decision");
  }
  if (!vocab.topics.has(out.topic)) unsure.add("topic");
  if (!vocab.facets.has(out.facet)) unsure.add("facet");
  if (!vocab.scopes.has(out.scope)) unsure.add("scope");
  if (vocab.topics.has(out.topic) && vocab.facets.has(out.facet)) {
    const problems = keyProblems(vocab, { ...out, card_id: "", record_id: "", facets: [out.facet], decided_at: "", effective: "" });
    if (problems.length) unsure.add("facet");
  }
  if (out.decided_by !== "me" && !(out.decided_by in extras.people)) unsure.add("decided_by");
  else if (out.mode === "decides") {
    const checked = applyDeciderCheck(vocab, { ...out, card_id: "", record_id: "", facets: [out.facet], decided_at: out.decided_at ?? "", effective: out.effective ?? "" });
    if (checked.mode !== out.mode) {
      out.mode = checked.mode;
      notes.push(`${out.decided_by} may not decide ${out.topic}: recorded as a mention`);
    }
  }
  if (out.decided_at === null) out.decided_at = out.source_recorded_at; // the contract: decided when sent, unless the sentence says otherwise
  else if (!parseTime(out.decided_at)) unsure.add("decided_at");

  if (out.mode === "decides") {
    // A start date the sentence says in words is worked out by code from when it was sent; the code wins.
    const rel = resolveRelativeStart(text, out.source_recorded_at);
    if (rel?.kind === "date" && (out.effective === null || out.effective.slice(0, 10) !== rel.effective.slice(0, 10))) {
      notes.push(`start date set by the clock${out.effective ? `, not the model (it said ${out.effective.slice(0, 10)})` : ""}: ${rel.reading}`);
      out.effective = rel.effective;
    } else if (rel?.kind === "ambiguous") {
      unsure.add("effective");
      notes.push(`"${rel.phrase}" can mean ${rel.readings.join(" or ")} — pick the start date`);
    }
    if (out.effective === null) unsure.add("effective");
    else if (!parseTime(out.effective)) unsure.add("effective");
    const parse = VALUE_PARSERS[out.topic];
    if (value === null || (parse && parse(value) === null)) unsure.add("value");
  } else {
    // A mention or proposal holds no seat: it needs neither an effective date nor a value.
    if (out.effective === null) out.effective = out.decided_at;
    value = null;
  }
  return { card: out, value, unsure: [...unsure], notes };
}

// The cards a new decision must be related to: the seat's current heads (a replaced card is history) plus
// any card on the seat that cannot be dated (the user must say how the new one relates to it).
export function seatHeads(graph: SeatGraph, seat: Seat): string[] {
  const r = graph.resolveExact(seat);
  const heads = r.current_card ? [r.current_card, ...r.coexisting] : [];
  const undated = graph.cardsOn(seat).filter((c) => parseTime(c.decided_at) === null).map((c) => c.card_id);
  return [...new Set([...heads, ...undated])];
}

export async function intake(msg: IntakeMessage, deps: IntakeDeps): Promise<IntakeResult> {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomUUID());
  const vocab = deps.store.vocab;

  const finish = (raws: RawCard[], mode: "model" | "rules", note?: string): IntakeResult => {
    const graph = deps.store.graph();
    const candidates = raws.map((raw) => {
      const base: CandidateCard = { quote: raw.quote, mode: raw.mode, topic: raw.topic, facet: raw.facet, scope: raw.scope, decided_by: raw.decided_by, decided_at: raw.decided_at, effective: raw.effective, source_recorded_at: msg.sent_at };
      const checked = checkCandidate(base, raw.value, msg.text, vocab, deps.extras);
      const unsure = [...new Set([...checked.unsure, ...raw.unsure.filter((f) => f in base || f === "value")])];
      const same_seat = vocab.topics.has(checked.card.topic) && vocab.facets.has(checked.card.facet) && vocab.scopes.has(checked.card.scope) ? seatHeads(graph, { topic: checked.card.topic, facet: checked.card.facet, scope: checked.card.scope }) : [];
      const c: Candidate = {
        candidate_id: newId(),
        session_id: msg.session_id,
        message_id: msg.message_id,
        sent_at: msg.sent_at,
        text: msg.text,
        card: checked.card,
        value: checked.value,
        unsure,
        ...(note || checked.notes.length ? { note: [note, ...checked.notes].filter(Boolean).join("; ") } : {}),
        same_seat,
        relations: {},
        status: "pending",
        created_at: chicagoIso(now()),
        mode_of_origin: mode,
      };
      deps.store.putCandidate(c);
      return c;
    });
    return { candidates, mode, ...(note ? { note } : {}) };
  };

  // Rule fallback: no model. A marker sentence → one all-unsure candidate; anything else → nothing.
  const rules = (why: string): IntakeResult => {
    if (!DECISION_MARKERS.test(msg.text)) return { candidates: [], mode: "rules", note: why };
    // The whole message stands in for the quote; the user trims it, so it is unsure too.
    const raw: RawCard = { quote: msg.text, mode: QUESTION.test(msg.text) ? "mentions" : PROPOSAL.test(msg.text) ? "proposes" : "decides", topic: "", facet: "", scope: "", decided_by: "me", effective: null, decided_at: null, value: null, unsure: ["quote"] };
    return finish([raw], "rules", `the model is off; fill the card yourself (${why})`);
  };

  const state = deps.guard.state();
  if (!state.enabled || !state.model) return rules(state.reason ?? "no model configured");

  const provider = deps.guard.asProvider({ session_id: msg.session_id, action_id: deps.action_id, kind: "intake" });
  const client = new ModelClient(provider, deps.cache ?? new MemoryCache(), new CallBudget(2));
  const { system, user } = intakePrompt({ text: msg.text, sent_at: msg.sent_at, vocab, extras: deps.extras });
  let reply: Awaited<ReturnType<typeof client.json<{ cards: RawCard[] }>>>;
  try {
    reply = await client.json({ stage: "intake", agent: "intake", model: state.model, system, user }, parseIntakeReply, 1);
  } catch (e) {
    return rules(`the model call was refused: ${(e as Error).message}`);
  }
  if (!reply.value) return rules(`the model's reply could not be used: ${reply.error ?? "no JSON"}`);
  return finish(reply.value.cards, "model");
}
