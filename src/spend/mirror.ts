// An off-machine copy of the spend ledger, for hosts whose disk does not survive a restart (a free web
// service that sleeps when idle). The local JSONL file stays the working copy; the mirror is one file in a
// private GitHub repository, written through the contents API with a token scoped to that repository only.
//
// restore() runs once at startup, before the guard opens the ledger. push() runs after every reserve — the
// guard awaits it and sends nothing to the model unless the mirror holds the reserve — and after every
// settle (not awaited by the caller; a lost settle leaves the reserve counted in full on the next start,
// which over-counts, never under-counts). Pushes are serial and each carries the sha it replaces, so a
// second writer is a loud conflict, never a silent overwrite.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type MirrorFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export type MirrorConfig = { repo: string; path: string; token: string; branch: string };

export class MirrorError extends Error {}

export interface LedgerMirror {
  restore(localPath: string): Promise<"restored" | "absent" | "same">;
  push(read: () => string): Promise<void>;
}

export class GitHubLedgerMirror implements LedgerMirror {
  private readonly cfg: MirrorConfig;
  private readonly fetchFn: MirrorFetch;
  private sha: string | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(cfg: MirrorConfig, fetchFn: MirrorFetch = fetch as unknown as MirrorFetch) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cfg.repo)) throw new MirrorError(`LEDGER_MIRROR_REPO ${JSON.stringify(cfg.repo)} must be owner/name`);
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }

  // LEDGER_MIRROR_REPO, LEDGER_MIRROR_TOKEN (both or neither), LEDGER_MIRROR_PATH (default
  // spend-ledger.jsonl), LEDGER_MIRROR_BRANCH (default main). Neither set → null (no mirror, local disk only).
  static fromEnv(env: NodeJS.ProcessEnv): GitHubLedgerMirror | null {
    const repo = env.LEDGER_MIRROR_REPO || "";
    const token = env.LEDGER_MIRROR_TOKEN || "";
    if (!repo && !token) return null;
    if (!repo || !token) throw new MirrorError("LEDGER_MIRROR_REPO and LEDGER_MIRROR_TOKEN must be set together");
    return new GitHubLedgerMirror({ repo, token, path: env.LEDGER_MIRROR_PATH || "spend-ledger.jsonl", branch: env.LEDGER_MIRROR_BRANCH || "main" });
  }

  private url(withRef: boolean): string {
    const path = this.cfg.path.split("/").map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${this.cfg.repo}/contents/${path}${withRef ? `?ref=${encodeURIComponent(this.cfg.branch)}` : ""}`;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "unworried-ledger-mirror" };
  }

  // Never echoes the token: only the status and GitHub's own message.
  private async failure(what: string, res: { status: number; text(): Promise<string> }): Promise<MirrorError> {
    let message = "";
    try {
      message = String((JSON.parse(await res.text()) as { message?: unknown }).message ?? "");
    } catch {
      /* body not JSON */
    }
    return new MirrorError(`ledger mirror ${what}: HTTP ${res.status}${message ? ` (${message})` : ""}`);
  }

  // Remote absent → "absent", local untouched (a missing ledger keeps model calls off; nothing is created).
  // Local missing → the remote is written there. Local present and equal → "same". Local present and
  // different → refuse: two copies that disagree about money are resolved by a person, not by a rule.
  async restore(localPath: string): Promise<"restored" | "absent" | "same"> {
    const res = await this.fetchFn(this.url(true), { method: "GET", headers: this.headers() });
    if (res.status === 404) return "absent";
    if (!res.ok) throw await this.failure("restore", res);
    const body = JSON.parse(await res.text()) as { sha?: string; content?: string; encoding?: string };
    if (!body.sha || typeof body.content !== "string" || body.encoding !== "base64") throw new MirrorError("ledger mirror restore: the response is not a base64 file");
    const text = Buffer.from(body.content, "base64").toString("utf8");
    this.sha = body.sha;
    if (existsSync(localPath)) {
      if (readFileSync(localPath, "utf8") === text) return "same";
      throw new MirrorError(`ledger mirror restore: ${localPath} exists and differs from the mirror; resolve by hand before enabling model calls`);
    }
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, text);
    return "restored";
  }

  // Serial: each push waits for the one before it and reads the file when its turn comes, so the mirror
  // only ever moves forward.
  push(read: () => string): Promise<void> {
    const p = this.chain.then(() => this.put(read()));
    this.chain = p.catch(() => {});
    return p;
  }

  private async put(text: string): Promise<void> {
    const lines = text.split("\n").filter(Boolean).length;
    const body = JSON.stringify({ message: `spend ledger: ${lines} lines`, content: Buffer.from(text, "utf8").toString("base64"), branch: this.cfg.branch, ...(this.sha ? { sha: this.sha } : {}) });
    const res = await this.fetchFn(this.url(false), { method: "PUT", headers: { ...this.headers(), "content-type": "application/json" }, body });
    if (!res.ok) throw await this.failure(res.status === 409 || res.status === 422 ? "conflict (another writer, or a stale sha)" : "push", res);
    const out = JSON.parse(await res.text()) as { content?: { sha?: string } };
    if (!out.content?.sha) throw new MirrorError("ledger mirror push: the response has no sha");
    this.sha = out.content.sha;
  }
}
