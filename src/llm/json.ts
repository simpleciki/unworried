// Reads the JSON value a model was asked to return. Strict about shape: after trimming, the reply must
// start with { or [, or the JSON must sit inside a ``` fence (first character { or [). Anything else is
// prose (often a numbered plan that quotes an example object from our own prompt) and throws
// "reply was prose, not JSON", so client.json() retries and nothing is cached. Text after the first
// complete value is ignored.
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const body = text.trim();
  const src = /^[[{]/.test(body) ? body : fenced && /^[[{]/.test(fenced) ? fenced : null;
  if (src === null) throw new Error("reply was prose, not JSON");
  const end = matchingEnd(src, 0);
  if (end < 0) throw new Error("invalid JSON: unterminated object");
  let value: unknown;
  try {
    value = JSON.parse(src.slice(0, end + 1));
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }
  // JSON.parse keeps the LAST of two equal keys, silently. On 2026-10-27 the intake model wrote a correct
  // card and then `"cards": []` in the same object, and the card vanished; a repeated key is an invalid
  // reply (client.json() retries with this message), never a quiet overwrite.
  const dup = duplicateKey(src.slice(0, end + 1));
  if (dup !== null) throw new Error(`invalid JSON: the key "${dup}" appears twice in one object; give each key once`);
  return value;
}

// The first key that appears twice in the same object, at any depth; null when every object is clean.
export function duplicateKey(s: string): string | null {
  const stack: { obj: boolean; keys: Set<string>; wantKey: boolean }[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      let str = "";
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\") str += s[j] + s[++j];
        else str += s[j];
      }
      const top = stack[stack.length - 1];
      if (top?.obj && top.wantKey) {
        if (top.keys.has(str)) return str;
        top.keys.add(str);
        top.wantKey = false;
      }
      i = j;
    } else if (c === "{") stack.push({ obj: true, keys: new Set(), wantKey: true });
    else if (c === "[") stack.push({ obj: false, keys: new Set(), wantKey: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.obj) top.wantKey = true;
    }
  }
  return null;
}

export const isProseError = (message: string | undefined) => !!message && message.includes("reply was prose, not JSON");

// Index of the bracket closing the one at start, skipping brackets inside strings; -1 if unclosed.
function matchingEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Small schema helpers: each throws with a message the retry prompt can quote back to the model.
export function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be an object`);
  return v as Record<string, unknown>;
}
export function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what} must be an array`);
  return v;
}
export function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} must be a string`);
  return v;
}
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new Error(`${what} must be one of ${allowed.join(", ")}`);
  return v as T;
}
export function strArr(v: unknown, what: string): string[] {
  return arr(v, what).map((x, i) => str(x, `${what}[${i}]`));
}
