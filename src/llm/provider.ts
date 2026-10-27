export type ProviderStatus = "online" | "unauthorized" | "offline";

// route_dead: the runtime routed the request to an upstream model that no longer exists (end of life,
// upstream 404/410). Retrying the same route cannot help; another routing mode might.
// route_unavailable: the upstream model exists but this account is not entitled to it (upstream 404
// "Not found for account"). Handled like route_dead.
export type ProviderErrorKind = "timeout" | "http" | "unauthorized" | "offline" | "route_dead" | "route_unavailable";

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
}

export interface ChatResult {
  text: string;
  model: string;
  latencyMs: number;
}

export interface ChatProvider {
  id: string;
  status(): Promise<ProviderStatus>;
  listModels(): Promise<string[]>;
  chat(req: ChatRequest): Promise<ChatResult>;
}
