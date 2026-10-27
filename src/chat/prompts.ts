// The prompts (English) and the rules every prompt states. The model reads ONE sentence the user typed
// and proposes ONE candidate card per decision in it; code verifies every field; the user confirms.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckedCard } from "../engine/types.ts";
import type { Vocab } from "../engine/vocab.ts";
import { parseYaml } from "../engine/vocab.ts";
import type { ActionPlan } from "../action/plan.ts";
import type { Lookup } from "../action/seats-view.ts";
import type { CandidateCard } from "../ledger/store.ts";

export const RULES = [
  "Quote the user's words verbatim: `quote` must be an exact substring of the message, nothing paraphrased.",
  "If the message does not say something, the answer is \"the records do not say\": never infer a date, a person or a reason.",
  "`decided_at` is null unless the sentence itself names an earlier moment the decision was made (\"on 10/3 we agreed\"); the code fills null with the message time.",
  "`effective` is the moment the sentence says the arrangement applies from (\"from next Thursday\" → that date as an ISO date). If the sentence does not say, return null and list \"effective\" under `unsure`. Never copy `decided_at` into `effective`.",
  "A question is `mentions`. A suggestion (\"should we…\", \"maybe we…\") is `proposes`. Only a statement of what now holds is `decides`.",
  "`value` restates the decision in the facet's documented shape, or null (then list \"value\" under `unsure`).",
  "Reply with the JSON object only. No prose before or after it.",
];

export const VALUE_SHAPES: Record<string, string> = {
  priority: "`rank N` — 1 yields to nothing; larger numbers yield to smaller",
  movable: "`may be moved` or `may not be moved`",
  pickup_backup: "`backup <Name>` — who covers the pickup when the user cannot",
  working_hours: "`HH:MM-HH:MM Monday to Friday` (24-hour clock; the weekday range is optional)",
};

export type VocabExtras = { topics: Record<string, string>; facets: Record<string, string>; scopes: Record<string, string>; people: Record<string, string>; categories: Record<string, string> };

// The descriptions data/vocab.yaml carries next to each key (the engine's Vocab keeps only the keys).
export function loadVocabExtras(root: string): VocabExtras {
  const y = parseYaml(readFileSync(join(root, "data/vocab.yaml"), "utf8"));
  const map = (k: string) => Object.fromEntries(Object.entries((y[k] ?? {}) as Record<string, unknown>).map(([a, b]) => [a, typeof b === "string" ? b : ""]));
  return { topics: map("topics"), facets: map("facets"), scopes: map("scopes"), people: map("people"), categories: map("categories") };
}

export function vocabText(vocab: Vocab, extras: VocabExtras): string {
  const list = (title: string, keys: Iterable<string>, desc: Record<string, string>) => `${title}:\n${[...keys].map((k) => `  - ${k}${desc[k] ? ` — ${desc[k]}` : ""}`).join("\n")}`;
  const deciders = Object.entries(vocab.deciders).map(([t, who]) => `  - ${t}: ${who.join(", ")}`).join("\n");
  const shapes = Object.entries(VALUE_SHAPES).map(([t, s]) => `  - ${t}: ${s}`).join("\n");
  return [list("Topics", vocab.topics, extras.topics), list("Facets", vocab.facets, extras.facets), list("Scopes", vocab.scopes, extras.scopes), `Who may decide (anyone else → mentions):\n${deciders}`, `Value shapes by topic:\n${shapes}`].join("\n\n");
}

export function peopleText(extras: VocabExtras): string {
  return `People (all fictional):\n${Object.entries(extras.people)
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join("\n")}`;
}

const JSON_SHAPE = `{ "cards": [ { "quote": string, "mode": "decides" | "mentions" | "proposes" | "gives_reason", "topic": string, "facet": string, "scope": string, "decided_by": string, "effective": string | null, "decided_at": string | null, "value": string | null, "unsure": string[] } ] }`;

export function intakePrompt(args: { text: string; sent_at: string; vocab: Vocab; extras: VocabExtras }): { system: string; user: string } {
  const system = ["You turn one message from the user into zero or more candidate decision cards for a personal decision ledger. The user confirms every card; your job is to propose fields, never to decide.", "", "Rules:", ...RULES.map((r, i) => `${i + 1}. ${r}`), "", vocabText(args.vocab, args.extras), "", peopleText(args.extras), "", "A message with no arrangement in it (small talk, context, a question with no decision) gives an empty cards array."].join("\n");
  const user = [`Message sent at ${args.sent_at} (America/Chicago) by "me":`, "", args.text, "", `Reply with JSON only, in this shape: ${JSON_SHAPE}`].join("\n");
  return { system, user };
}

const RELATION_SHAPE = `{ "relations": [ { "card_id": string, "relation": "REPLACES" | "REFINES" | "SAME" | "UNRELATED", "because": string } ] }`;

export function relatePrompt(args: { candidate: CandidateCard; candidateValue: string | null; existing: Array<{ card: CheckedCard; value?: string }> }): { system: string; user: string } {
  const system = ["You compare a new candidate decision with the decisions already on the same seat and say, for each existing card, how the new one relates to it.", "", "REPLACES: the new decision supersedes the old one from its effective date. REFINES: the new one narrows or adds a condition to the old one, which otherwise still holds. SAME: the two say the same thing. UNRELATED: you cannot tell from the two quotes — when in doubt, UNRELATED; the user will be asked.", "A verdict must be supported by the two quotes alone. Do not use outside knowledge. Reply with JSON only."].join("\n");
  const lines = args.existing.map((e) => `- card_id ${e.card.card_id}: "${e.card.quote}" (decided ${e.card.decided_at}, effective ${e.card.effective}${e.value ? `, value: ${e.value}` : ""})`);
  const user = [`New candidate: "${args.candidate.quote}" (decided ${args.candidate.decided_at ?? "unknown"}, effective ${args.candidate.effective ?? "unknown"}${args.candidateValue ? `, value: ${args.candidateValue}` : ""}).`, "", "Existing cards on the same seat:", ...lines, "", `Reply with JSON only, in this shape: ${RELATION_SHAPE}`].join("\n");
  return { system, user };
}

const EXPLAIN_SHAPE = `{ "sentences": string[] }`;

export function explainPrompt(args: { plan: ActionPlan; lookups: Lookup<unknown>[] }): { system: string; user: string } {
  const system = ["You explain, to the person whose calendar this is, what the assistant plans to do about one conflict and why, in at most four plain sentences.", "", "Rules: use only the facts in the plan below. Copy names, titles, dates and times exactly as written. Do not add reasons the plan does not state; if the plan refuses, say what is unsure and what the person must confirm. Reply with JSON only."].join("\n");
  const seats = args.lookups.map((l) => `- ${l.key}: ${l.state}${l.quote ? ` — "${l.quote}" decided ${l.decided_at} by ${l.decided_by}` : ""}${l.replaced ? ` (replaced "${l.replaced.quote}" of ${l.replaced.decided_at})` : ""}${l.reason ? ` — ${l.reason}` : ""}`);
  const user = [`Plan ${args.plan.plan_id} (${args.plan.status}) for conflict ${args.plan.conflict_id} at ${args.plan.at}.`, "", `Template explanation: ${args.plan.explanation}`, ...(args.plan.refusal ? [`Refusal: ${args.plan.refusal.reason}`] : []), "", `Steps: ${JSON.stringify(args.plan.steps)}`, "", "Seats the plan depends on:", ...seats, "", `Reply with JSON only, in this shape: ${EXPLAIN_SHAPE}`].join("\n");
  return { system, user };
}
