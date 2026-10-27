// data/vocab.yaml: allowed topics / facets / scopes, the scope parent chain, and who may decide what.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionCard, EventSink } from "./types.ts";
import { noEvents } from "./types.ts";

export type Vocab = {
  topics: Set<string>;
  facets: Set<string>;
  scopes: Set<string>;
  parent: Record<string, string>;
  deciders: Record<string, string[]>;
};

// Minimal YAML reader for the shapes vocab.yaml uses: nested maps, "- item" lists, [] and quoted keys.
export function parseYaml(text: string): Record<string, unknown> {
  type Frame = { indent: number; obj: Record<string, unknown>; parent?: Record<string, unknown>; key?: string };
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, obj: root }];
  const unquote = (v: string) => v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^ */)![0].length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const frame = stack[stack.length - 1];
    if (line.startsWith("- ")) {
      if (!frame.parent || !frame.key) continue;
      if (!Array.isArray(frame.parent[frame.key])) frame.parent[frame.key] = [];
      (frame.parent[frame.key] as unknown[]).push(unquote(line.slice(2).trim()));
      continue;
    }
    const m = line.match(/^("[^"]*"|[^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = unquote(m[1]);
    const rest = m[2].trim();
    if (rest === "") {
      const child: Record<string, unknown> = {};
      frame.obj[key] = child;
      stack.push({ indent, obj: child, parent: frame.obj, key });
    } else if (rest === "[]") frame.obj[key] = [];
    else frame.obj[key] = unquote(rest);
  }
  return root;
}

export function loadVocab(root: string): Vocab {
  return vocabFrom(parseYaml(readFileSync(join(root, "data/vocab.yaml"), "utf8")));
}

export function vocabFrom(y: Record<string, unknown>): Vocab {
  const keys = (k: string) => new Set(Object.keys((y[k] ?? {}) as object));
  return {
    topics: keys("topics"),
    facets: keys("facets"),
    scopes: keys("scopes"),
    parent: (y.scope_parent ?? {}) as Record<string, string>,
    deciders: (y.deciders ?? {}) as Record<string, string[]>,
  };
}

// job -> client -> global
export function scopeChain(v: Vocab, scope: string): string[] {
  const chain = [scope];
  const seen = new Set(chain);
  let cur = scope;
  while (v.parent[cur] && !seen.has(v.parent[cur])) {
    cur = v.parent[cur];
    chain.push(cur);
    seen.add(cur);
  }
  if (!seen.has("global") && v.scopes.has("global")) chain.push("global");
  return chain;
}

export function keyProblems(v: Vocab, c: DecisionCard): string[] {
  const out: string[] = [];
  if (!v.topics.has(c.topic)) out.push(`unknown topic ${c.topic}`);
  for (const f of c.facets) if (!v.facets.has(f)) out.push(`unknown facet ${f}`);
  return out;
}

// A contractor can only propose. A "decides" card from someone outside deciders[topic] becomes "mentions".
export function applyDeciderCheck(v: Vocab, c: DecisionCard, emit: EventSink = noEvents): DecisionCard {
  const allowed = v.deciders[c.topic];
  if (c.mode !== "decides" || !allowed || allowed.includes(c.decided_by)) return c;
  emit({
    action: "decider_downgrade",
    ref: c.card_id,
    outcome: "decides->mentions",
    details: { topic: c.topic, decided_by: c.decided_by },
  });
  return { ...c, mode: "mentions" };
}
