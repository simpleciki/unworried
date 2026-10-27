// ChatProvider for Nebius Token Factory (OpenAI-compatible chat completions).
//
// Only src/spend/guard.ts may construct this class (test S8 enforces it): every call must be reserved
// in the spend ledger first. The base URL is never hardcoded — it comes from NEBIUS_BASE_URL; the
// fetch function is injectable so tests use a fake transport and never reach the network.
import type { ChatProvider, ChatRequest, ChatResult, ProviderStatus } from "./provider.ts";
import { ProviderError } from "./provider.ts";
import { redactAccount, safeText } from "./http.ts";
import { isAbortError } from "./limiter.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type NebiusOptions = {
  apiKey: string;
  baseUrl: string; // e.g. the value of NEBIUS_BASE_URL; must end in the API version path the docs give
  fetchFn?: FetchLike;
  timeoutMs?: number; // default 30 s
  now?: () => number;
};

type CompletionResponse = {
  model?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

export class NebiusProvider implements ChatProvider {
  readonly id = "nebius";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: NebiusOptions) {
    if (!opts.apiKey) throw new ProviderError("unauthorized", "apiKey is required; the guard supplies it from the environment");
    if (!opts.baseUrl || !/^https?:\/\//.test(opts.baseUrl)) throw new ProviderError("offline", "NEBIUS_BASE_URL not set (must be an http(s) URL; see .env.example)");
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private async request(path: string, init: Omit<RequestInit, "headers" | "signal">): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers: this.headers(), signal: controller.signal });
    } catch (e) {
      if (isAbortError(e)) throw new ProviderError("timeout", `Token Factory did not answer within ${this.timeoutMs} ms`);
      throw new ProviderError("offline", `Token Factory unreachable: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async status(): Promise<ProviderStatus> {
    try {
      const r = await this.request("/models", { method: "GET" });
      if (r.status === 401 || r.status === 403) return "unauthorized";
      return r.ok ? "online" : "offline";
    } catch (e) {
      return e instanceof ProviderError && e.kind === "unauthorized" ? "unauthorized" : "offline";
    }
  }

  async listModels(): Promise<string[]> {
    const r = await this.request("/models", { method: "GET" });
    const body = await safeText(r);
    failIfNotOk(r, body);
    try {
      const payload = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
      return (payload.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    } catch {
      return [];
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (!req.model) throw new ProviderError("http", "NEBIUS_MODEL not set");
    if (!Number.isInteger(req.maxTokens) || (req.maxTokens as number) <= 0) throw new ProviderError("http", "maxTokens is required: a call without a token cap has no worst-case cost");
    const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.user }];
    const body = JSON.stringify({ model: req.model, messages, max_tokens: req.maxTokens, temperature: req.temperature ?? 0 });
    const started = this.now();
    const r = await this.request("/chat/completions", { method: "POST", body });
    const text = await safeText(r);
    failIfNotOk(r, text);
    let payload: CompletionResponse;
    try {
      payload = JSON.parse(text) as CompletionResponse;
    } catch {
      throw new ProviderError("http", "Token Factory returned a non-JSON body", r.status);
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new ProviderError("http", "Token Factory reply has no choices[0].message.content", r.status);
    const u = payload.usage;
    const usage = u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number" ? { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } : undefined;
    return {
      text: content,
      model: typeof payload.model === "string" ? payload.model : req.model,
      latencyMs: this.now() - started,
      ...(usage ? { usage } : {}),
    };
  }
}

// 401/403 → unauthorized without echoing account details; anything else non-2xx → http with the status.
// The guard retries "timeout" and 5xx "http" once; 4xx is never retried.
function failIfNotOk(r: Response, bodyText: string): void {
  if (r.ok) return;
  if (r.status === 401 || r.status === 403) throw new ProviderError("unauthorized", redactAccount(bodyText) || `HTTP ${r.status}`, r.status);
  throw new ProviderError("http", redactAccount(bodyText).slice(0, 300) || `HTTP ${r.status}`, r.status);
}
