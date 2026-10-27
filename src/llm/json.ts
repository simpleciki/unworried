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
  try {
    return JSON.parse(src.slice(0, end + 1));
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }
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
