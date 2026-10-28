// A model-written explanation of an ActionPlan, checked sentence by sentence against the plan's own
// facts: a sentence that names anything the plan does not (a person, a time, a number, a title) is removed
// and listed under `explanation_removed`. The plan's template `explanation` is never replaced; the prose
// is a separate field, and the template is the fallback when the wall is off or the model fails.
import { MemoryCache } from "../llm/cache.ts";
import type { ResponseCache } from "../llm/cache.ts";
import { CallBudget, ModelClient } from "../llm/client.ts";
import { obj, strArr } from "../llm/json.ts";
import type { SpendGuard } from "../spend/guard.ts";
import type { ActionPlan } from "../action/plan.ts";
import type { Lookup } from "../action/seats-view.ts";
import { explainPrompt } from "./prompts.ts";

export type ExplainDeps = { guard: SpendGuard; session_id: string; action_id: string; cache?: ResponseCache };
export type Explanation = { explanation_prose: string; explanation_removed: string[]; mode: "model" | "template"; note?: string };

export const MAX_SENTENCES = 4;

export function parseExplainReply(v: unknown): { sentences: string[] } {
  return { sentences: strArr(obj(v, "reply").sentences, "sentences") };
}

// Words a sentence may use without the plan saying them.
const ALLOW = new Set(["the", "this", "that", "it", "so", "because", "your", "you", "i", "we", "a", "an", "no", "nothing", "since", "if", "then", "when", "after", "before", "first", "second", "next", "also", "but", "and", "or", "until", "please", "note", "to", "is", "are", "was", "were", "not", "for", "with", "on", "at", "in", "of", "as", "by", "has", "have", "had", "will", "would", "can", "cannot", "may", "moved", "move", "moving", "yields", "stays", "keeps", "drafted", "draft", "confirm", "confirms", "confirmed", "handoff", "message", "pickup", "meeting", "flight", "block", "calendar", "plan", "refused", "unsure", "decision", "decided", "replaced", "replacing", "earlier", "later", "instead", "nobody", "both", "which", "one", "two", "three", "four", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december", "morgan", "me", "my", "theo", "theo's", "yes", "ok", "there", "here", "they", "them", "their", "its", "he", "she", "him", "her", "who", "what", "where", "why", "how", "ask", "asks", "asked", "tell", "told", "need", "needs", "still", "now", "today", "tomorrow", "week", "day", "time", "slot", "free", "inside", "working", "hours", "same", "other", "own", "any", "all", "each", "every", "new", "old", "from", "into", "about", "over", "under", "between", "than", "once"]);

// Tokens that carry facts: capitalised words and anything with a digit.
const FACT_TOKEN = /\b(?:[A-Z][A-Za-z'’-]+|[0-9][0-9:./\-]*)\b/g;

export function checkSentence(sentence: string, facts: string): { ok: boolean; unsupported: string[] } {
  const haystack = facts.toLowerCase();
  const unsupported: string[] = [];
  for (const m of sentence.matchAll(FACT_TOKEN)) {
    const token = m[0].replace(/[.,;:]+$/, "");
    const low = token.toLowerCase();
    if (ALLOW.has(low) || ALLOW.has(low.replace(/['’]s$/, ""))) continue;
    if (!haystack.includes(low)) unsupported.push(token);
  }
  return { ok: unsupported.length === 0, unsupported };
}

// The assistant only drafts: a sentence saying something is (or will be) sent, emailed, texted or notified
// is removed even when every name in it is in the plan. A negated one ("never sent", "is not sent") stays.
const SENDING = /\b(send|sends|sending|sent|emails?|emailed|emailing|texts?|texted|texting|notif(?:y|ies|ied|ying))\b/gi;
const NEGATION = /\b(never|not|no|won't|isn't|aren't|wasn't|doesn't|don't|cannot|can't|nothing)\b[^.]{0,30}$/i;
export function claimsSending(sentence: string): boolean {
  for (const m of sentence.matchAll(SENDING)) if (!NEGATION.test(sentence.slice(0, m.index))) return true;
  return false;
}

// The plan never says what day it is now, so a sentence that does ("Since today is Thursday", said for a
// Tuesday on 2026-10-27) is removed: every word in it may be in the plan and it is still false.
const NOW_WORDS = /\b(today|tonight|this (?:morning|afternoon|evening)|right now|currently)\b/i;
const DAY_OR_DATE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i;
export function claimsToday(sentence: string): boolean {
  return NOW_WORDS.test(sentence) && DAY_OR_DATE.test(sentence);
}

export function factsOf(plan: ActionPlan, lookups: Lookup<unknown>[]): string {
  const parts = [plan.explanation, plan.refusal?.reason ?? "", JSON.stringify(plan.steps), plan.at, plan.conflict_id, plan.plan_id];
  for (const l of lookups) parts.push(l.key, l.state, l.quote ?? "", l.decided_at ?? "", l.decided_by ?? "", l.effective ?? "", l.reason ?? "", String(l.value ?? ""), l.replaced?.quote ?? "", l.replaced?.decided_at ?? "", ...l.cards);
  return parts.join("\n");
}

export async function explainPlan(plan: ActionPlan, lookups: Lookup<unknown>[], deps: ExplainDeps): Promise<Explanation> {
  const template = (note: string): Explanation => ({ explanation_prose: plan.explanation, explanation_removed: [], mode: "template", note });
  const state = deps.guard.state();
  if (!state.enabled || !state.model) return template(`the model is off (${state.reason ?? "no model configured"}); template explanation`);
  const provider = deps.guard.asProvider({ session_id: deps.session_id, action_id: deps.action_id, kind: "explain" });
  const client = new ModelClient(provider, deps.cache ?? new MemoryCache(), new CallBudget(2));
  const { system, user } = explainPrompt({ plan, lookups });
  let sentences: string[];
  try {
    const reply = await client.json({ stage: "explain", agent: "explain", model: state.model, system, user }, parseExplainReply, 1);
    if (!reply.value) return template(`the model's reply could not be used (${reply.error}); template explanation`);
    sentences = reply.value.sentences;
  } catch (e) {
    return template(`the model call was refused (${(e as Error).message}); template explanation`);
  }
  const facts = factsOf(plan, lookups);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    if (claimsSending(s)) {
      removed.push(`${s} (says it sends; the assistant only drafts, never sends)`);
      continue;
    }
    if (claimsToday(s)) {
      removed.push(`${s} (says what day it is now; the plan does not)`);
      continue;
    }
    const check = checkSentence(s, facts);
    if (check.ok && kept.length < MAX_SENTENCES) kept.push(s);
    else removed.push(check.ok ? `${s} (beyond ${MAX_SENTENCES} sentences)` : `${s} (not in the plan: ${check.unsupported.join(", ")})`);
  }
  if (!kept.length) return { ...template("every model sentence was unsupported; template explanation"), explanation_removed: removed };
  return { explanation_prose: kept.join(" "), explanation_removed: removed, mode: "model" };
}
