// Price table: model id → USD per 1M input tokens and per 1M output tokens.
// Prices live in config, never in code paths: NEBIUS_PRICES_JSON (an object keyed by model id) wins,
// else config/prices.json. A model id with no price is refused by the guard; nothing is guessed.
import { readFileSync } from "node:fs";

export type Price = { input_per_m: number; output_per_m: number; source?: string };
export type PriceTable = Record<string, Price>;

export const DEFAULT_PRICES_PATH = "config/prices.json";

export class PriceTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceTableError";
  }
}

function validate(raw: unknown, origin: string): PriceTable {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PriceTableError(`${origin}: expected an object keyed by model id`);
  const table: PriceTable = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (model.startsWith("_")) continue; // "_comment"-style keys carry notes, not prices
    if (!value || typeof value !== "object") throw new PriceTableError(`${origin}: price for ${model} must be an object`);
    const p = value as Record<string, unknown>;
    for (const field of ["input_per_m", "output_per_m"] as const) {
      const n = p[field];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new PriceTableError(`${origin}: ${model}.${field} must be a non-negative number`);
    }
    table[model] = {
      input_per_m: p.input_per_m as number,
      output_per_m: p.output_per_m as number,
      ...(typeof p.source === "string" ? { source: p.source } : {}),
    };
  }
  return table;
}

export function parsePriceTable(json: string, origin: string): PriceTable {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new PriceTableError(`${origin}: invalid JSON (${(e as Error).message})`);
  }
  return validate(raw, origin);
}

// Env first, then the config file. Throws (loudly) when neither can be read.
export function loadPrices(env: NodeJS.ProcessEnv = process.env, configPath = DEFAULT_PRICES_PATH): PriceTable {
  const fromEnv = env.NEBIUS_PRICES_JSON;
  if (fromEnv && fromEnv.trim()) return parsePriceTable(fromEnv, "NEBIUS_PRICES_JSON");
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (e) {
    throw new PriceTableError(`${configPath}: cannot read price table (${(e as Error).message})`);
  }
  return parsePriceTable(text, configPath);
}

export function priceFor(table: PriceTable, model: string): Price | undefined {
  return table[model];
}

// Worst-case cost of one call in USD. Input upper bound = UTF-8 bytes ÷ 2 (over-estimates on purpose);
// output upper bound = max_tokens.
export function worstCaseUsd(price: Price, promptText: string, maxTokens: number): { usd: number; inputTokensBound: number } {
  const inputTokensBound = Math.ceil(Buffer.byteLength(promptText, "utf8") / 2);
  const usd = (inputTokensBound / 1_000_000) * price.input_per_m + (maxTokens / 1_000_000) * price.output_per_m;
  return { usd: round8(usd), inputTokensBound };
}

export function actualUsd(price: Price, usage: { input_tokens: number; output_tokens: number }): number {
  return round8((usage.input_tokens / 1_000_000) * price.input_per_m + (usage.output_tokens / 1_000_000) * price.output_per_m);
}

export const round8 = (n: number) => Math.round(n * 1e8) / 1e8;
