// Response cache on disk: one JSON file per call, keyed by SHA-256 of (model id, system, user, temperature).
// Re-runs read the cache first, so a repeated run makes no new calls. A "tee" directory receives a copy
// of every entry used (record:samples fills cache/samples/ this way).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// mode = the routing mode that produced the reply (differs from the requested one after a route fallback).
export type CachedResponse = { text: string; model: string; mode?: string };
// namespace: a setting that changes the reply but not the prompt (e.g. "thinking-off"). Absent = the original
// four-part key, so every reply cached before namespaces existed keeps its key.
export type CacheKeyInput = { model: string; system: string; user: string; temperature: number; namespace?: string };

export function cacheKey(k: CacheKeyInput): string {
  const parts: unknown[] = [k.model, k.system, k.user, k.temperature];
  if (k.namespace) parts.push(k.namespace);
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

// The same key with every timestamp in the prompt cut to its date. A message's send time carries the
// second it was typed (the chat clock), so a reply recorded for a demo sentence never matched the same
// sentence typed by a judge: replays missed and SAMPLE mode fell back to an all-unsure card. Dates the
// reply implies are worked out again by code from the real send time, so the day is what the reply
// depends on. The prompt the model sees is unchanged; only the lookup is.
export function dayKey(k: CacheKeyInput): string {
  return cacheKey({ ...k, user: dayOnly(k.user) });
}

export function dayOnly(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?/g, "$1");
}

export interface ResponseCache {
  get(key: string): CachedResponse | undefined;
  set(key: string, value: CachedResponse): void;
}

export class FileCache implements ResponseCache {
  constructor(
    private dir: string,
    private opts: { readOnly?: boolean; tee?: string } = {},
  ) {}

  private file(dir: string, key: string) {
    return join(dir, `${key}.json`);
  }

  get(key: string): CachedResponse | undefined {
    const f = this.file(this.dir, key);
    if (!existsSync(f)) return undefined;
    if (this.opts.tee) {
      mkdirSync(this.opts.tee, { recursive: true });
      copyFileSync(f, this.file(this.opts.tee, key));
    }
    return JSON.parse(readFileSync(f, "utf8")) as CachedResponse;
  }

  set(key: string, value: CachedResponse): void {
    if (this.opts.readOnly) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(this.dir, key), JSON.stringify(value) + "\n");
    if (this.opts.tee) {
      mkdirSync(this.opts.tee, { recursive: true });
      writeFileSync(this.file(this.opts.tee, key), JSON.stringify(value) + "\n");
    }
  }
}

export class MemoryCache implements ResponseCache {
  readonly entries = new Map<string, CachedResponse>();
  get(key: string) {
    return this.entries.get(key);
  }
  set(key: string, value: CachedResponse) {
    this.entries.set(key, value);
  }
}
