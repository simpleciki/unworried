export type ProviderStatus = "online" | "unauthorized" | "offline";

// route_dead: the runtime routed the request to an upstream model that no longer exists (end of life,
// upstream 404/410). Retrying the same route cannot help; another routing mode might.
// route_unavailable: the upstream model exists but this account is not entitled to it (upstream 404
// "Not found for account"). Handled like route_dead.
// refused: the spending wall (src/spend/guard.ts) declined the call before it was sent; the message
// names the limit. Retrying cannot help until a human raises the limit or the window passes.
export type ProviderErrorKind = "timeout" | "http" | "unauthorized" | "offline" | "route_dead" | "route_unavailable" | "refused";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly deadModel?: string;

  constructor(kind: ProviderErrorKind, message: string, status?: number, deadModel?: string) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    this.deadModel = deadModel;
  }
}

export interface ChatRequest {
  model: string;
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number; // required by providers that bill per token (Nebius); fixed per call kind by the guard
}

export interface ChatResult {
  text: string;
  model: string;
  latencyMs: number;
  usage?: { input_tokens: number; output_tokens: number }; // as the server reports it; absent → the guard books the worst case
}

export interface ChatProvider {
  id: string;
  status(): Promise<ProviderStatus>;
  listModels(): Promise<string[]>;
  chat(req: ChatRequest): Promise<ChatResult>;
}
