// NebiusProvider over a fake transport. Nothing here reaches the network.
import { describe, expect, it } from "vitest";
import { NebiusProvider } from "./nebius.ts";
import { ProviderError } from "./provider.ts";

const BASE = "http://127.0.0.1:1/v1/";

type Seen = { url: string; init: RequestInit };
function transport(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    const s = { url, init };
    seen.push(s);
    return respond(s);
  };
  return { seen, fetchFn };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("NebiusProvider", () => {
  it("posts an OpenAI-style completion and returns text, model, latency and usage", async () => {
    const t = transport(() => json({ model: "nvidia/answered-by", choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    let clock = 1000;
    const p = new NebiusProvider({ apiKey: "test-only", baseUrl: BASE, fetchFn: t.fetchFn, now: () => (clock += 25) });
    const r = await p.chat({ model: "nvidia/some-model", system: "sys", user: "hi", temperature: 0.2, maxTokens: 256 });
    expect(r).toEqual({ text: "hello", model: "nvidia/answered-by", latencyMs: 25, usage: { input_tokens: 7, output_tokens: 3 } });
    expect(t.seen[0].url).toBe("http://127.0.0.1:1/v1/chat/completions"); // trailing slash on the base is tolerated
    expect(t.seen[0].init.method).toBe("POST");
    expect((t.seen[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-only");
    expect(JSON.parse(String(t.seen[0].init.body))).toEqual({
      model: "nvidia/some-model",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 256,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("omits usage when the server reports none (the guard then books the worst case)", async () => {
    const t = transport(() => json({ choices: [{ message: { content: "x" } }] }));
    const p = new NebiusProvider({ apiKey: "k", baseUrl: BASE, fetchFn: t.fetchFn });
    const r = await p.chat({ model: "m", user: "hi", maxTokens: 10 });
    expect(r.usage).toBeUndefined();
    expect(r.model).toBe("m"); // falls back to the requested id
  });

  it("401/403 → unauthorized, with account details redacted", async () => {
    const t = transport(() => json({ error: { message: "Invalid key for account acct_12345 owned by someone" } }, 401));
    const p = new NebiusProvider({ apiKey: "k", baseUrl: BASE, fetchFn: t.fetchFn });
    const err = await p.chat({ model: "m", user: "hi", maxTokens: 10 }).catch((e) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("unauthorized");
    expect((err as ProviderError).message).not.toContain("acct_12345");
    expect((err as ProviderError).message).toContain("for account [redacted]");
  });

  it("5xx and 4xx → http with the status; the guard decides what to retry", async () => {
    const p5 = new NebiusProvider({ apiKey: "k", baseUrl: BASE, fetchFn: transport(() => new Response("upstream down", { status: 503 })).fetchFn });
    await expect(p5.chat({ model: "m", user: "hi", maxTokens: 10 })).rejects.toMatchObject({ kind: "http", status: 503 });
    const p4 = new NebiusProvider({ apiKey: "k", baseUrl: BASE, fetchFn: transport(() => json({ error: "no such model" }, 404)).fetchFn });
    await expect(p4.chat({ model: "m", user: "hi", maxTokens: 10 })).rejects.toMatchObject({ kind: "http", status: 404 });
  });

  it("times out", async () => {
    const t = transport((s) => new Promise<Response>((_, reject) => s.init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))));
    const p = new NebiusProvider({ apiKey: "k", baseUrl: BASE, fetchFn: t.fetchFn, timeoutMs: 5 });
    await expect(p.chat({ model: "m", user: "hi", maxTokens: 10 })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("refuses to call without a model id or a token cap, and to construct without a base URL", async () => {
    const t = transport(() => json({}));
    const p = new NebiusProvider({ apiKey: "k", baseUrl: BASE, fetchFn: t.fetchFn });
    await expect(p.chat({ model: "", user: "hi", maxTokens: 10 })).rejects.toThrow(/NEBIUS_MODEL not set/);
    await expect(p.chat({ model: "m", user: "hi" })).rejects.toThrow(/maxTokens is required/);
    expect(t.seen).toHaveLength(0);
    expect(() => new NebiusProvider({ apiKey: "k", baseUrl: "", fetchFn: t.fetchFn })).toThrow(/NEBIUS_BASE_URL not set/);
    expect(() => new NebiusProvider({ apiKey: "", baseUrl: BASE, fetchFn: t.fetchFn })).toThrow(/apiKey is required/);
  });

  it("a malformed success body is an error, not an empty reply", async () => {
    const p = new NebiusProvider({ apiKey: "k", baseUrl: BASE, fetchFn: transport(() => json({ choices: [] })).fetchFn });
    await expect(p.chat({ model: "m", user: "hi", maxTokens: 10 })).rejects.toThrow(/no choices\[0\]\.message\.content/);
  });
});
