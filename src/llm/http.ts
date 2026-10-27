// Response helpers for the Meterless Runtime client.
import { ProviderError } from "./provider.ts";

type ModelsResponse = {
  data?: Array<{ id?: string }>;
};

export type ChatCompletionResponse = {
  model?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
};

export async function parseModelIds(response: Response): Promise<string[]> {
  let payload: ModelsResponse;
  try {
    payload = (await response.json()) as ModelsResponse;
  } catch {
    return [];
  }
  const items = Array.isArray(payload.data) ? payload.data : [];
  return items
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.startsWith("meterless/"));
}

export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return error.kind === "timeout" || (error.kind === "http" && (error.status ?? 0) >= 500);
}

// An upstream model the runtime routed to is gone. The runtime wraps this in its own error body
// (code provider_error, meterless_detail like "nvidia_410: ...") and its HTTP status may be any 4xx/5xx,
// so the body decides, not the status.
const DEAD = /end of (its )?life|no longer available|has been (retired|removed|decommissioned)|\b(404|410)\b|_(404|410)\b/i;
// Upstream says this account may not use the model (checked before DEAD: it also carries a 404).
const UNAVAILABLE = /not found for account|not entitled|not available (to|for) (this|your) account|no access to (this )?model/i;

// Account identifiers never leave this function: everything after "for account" is cut.
export const redactAccount = (s: string) => s.replace(/for account[\s\S]*/gi, "for account [redacted]");

type ErrorBody = { error?: { message?: unknown; code?: unknown; meterless_detail?: unknown; meterless?: Record<string, unknown> } };

export function classifyRoute(bodyText: string): { kind: "dead" | "unavailable" | null; model?: string; message: string } {
  let payload: ErrorBody;
  try {
    payload = JSON.parse(bodyText) as ErrorBody;
  } catch {
    // A truncated body is not valid JSON; if it is still a provider error, read the raw text.
    if (!/provider_error|nvidia_\d{3}/i.test(bodyText)) return { kind: null, message: redactAccount(bodyText) };
    const raw = redactAccount(bodyText);
    const model = raw.match(/model\s+\\?['"`]([^'"`\\]+)\\?['"`]/i)?.[1];
    return { kind: UNAVAILABLE.test(bodyText) ? "unavailable" : DEAD.test(raw) ? "dead" : null, model, message: raw };
  }
  const err = payload?.error;
  if (!err || err.code !== "provider_error") return { kind: null, message: redactAccount(bodyText) };
  const text = redactAccount([err.message, err.meterless_detail].filter((x) => typeof x === "string").join(" | "));
  // The upstream model: a field the runtime may attach, else a quoted model name in the text.
  const meta = err.meterless ?? {};
  const field = ["upstream_model", "routed_model", "resolved_model", "provider_model", "model"].map((k) => meta[k]).find((v) => typeof v === "string" && !v.startsWith("meterless/")) as string | undefined;
  const model = field ?? text.match(/model\s+['"`]([^'"`]+)['"`]/i)?.[1];
  const kind = UNAVAILABLE.test(text) ? "unavailable" : DEAD.test(text) ? "dead" : null;
  return { kind, model, message: text };
}

export function classifyRouteDead(bodyText: string): { dead: boolean; model?: string; message: string } {
  const r = classifyRoute(bodyText);
  return { dead: r.kind === "dead", model: r.model, message: r.message };
}

export function routeError(bodyText: string, status: number): ProviderError | null {
  const r = classifyRoute(bodyText);
  if (r.kind === "dead") return new ProviderError("route_dead", r.message, status, r.model);
  if (r.kind === "unavailable") return new ProviderError("route_unavailable", r.message, status, r.model);
  return null;
}

export function throwIfFailed(response: Response, bodyText: string): void {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError("unauthorized", redactAccount(bodyText) || `HTTP ${response.status}`, response.status);
  }
  throw routeError(bodyText, response.status) ?? new ProviderError("http", redactAccount(bodyText) || `HTTP ${response.status}`, response.status);
}

export async function safeText(response: Response): Promise<string> {
  try {
    return await response.clone().text();
  } catch {
    return "";
  }
}
