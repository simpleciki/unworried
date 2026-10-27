// A scripted provider for tests: no network. The responder sees each request and returns the reply.
import type { ChatProvider, ChatRequest, ChatResult, ProviderStatus } from "./provider.ts";

export class FakeProvider implements ChatProvider {
  readonly id = "fake";
  readonly calls: ChatRequest[] = [];
  constructor(
    private responder: (req: ChatRequest, n: number) => string,
    private models: string[] = ["meterless/auto"],
    private answeredAs = "fake/model",
  ) {}
  async status(): Promise<ProviderStatus> {
    return "online";
  }
  async listModels() {
    return this.models;
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls.push(req);
    return { text: this.responder(req, this.calls.length), model: this.answeredAs, latencyMs: 1 };
  }
}
