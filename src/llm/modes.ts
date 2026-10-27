// Routing modes for text tasks: the fallback order, the modes that are never used, the human's
// override (METERLESS_MODE_ORDER), and a memory of modes whose upstream model was found dead.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const P = "meterless/";

// Tried in this order when a route's upstream model is gone.
export const FALLBACK_MODES = ["auto", "deep", "text", "fusion", "code", "judge", "cluster"].map((m) => P + m);

// Never for text tasks: a 1B on-device model, and modes built for other media.
export const BLOCKED_MODES = ["local", "image", "video", "speech", "music", "embed", "transcribe", "perception", "vision"].map((m) => P + m);

export const isBlocked = (mode: string) => BLOCKED_MODES.includes(mode);
// A pinned provider model id ("vendor/name", e.g. nvidia/NVIDIA-Nemotron-Nano-9B-v2), sent as is. A
// Nebius run pins one id this way and uses no Meterless routing mode at all.
export const PROVIDER_MODEL = /^[a-z0-9-]+\/[A-Za-z0-9._\-]+$/;

// Default route when METERLESS_MODE_ORDER is not set: pinned upstream models, best first. Chosen from the
// extraction prose rate measured on 2026-10-22 (replies that were a plan, not JSON): ultra-550b 63/63,
// super-vl 8/16, lightning 4/33. So: lightning, then super; never ultra.
export const DEFAULT_MODE_ORDER = ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-super-120b-a12b"];
// Upstream models never used, pinned or as a fallback (same measurement: it answers in prose).
export const EXCLUDED_MODELS = ["nvidia/nemotron-3-ultra-550b-a55b"];
const normalise = (m: string) => (m.startsWith(P) || PROVIDER_MODEL.test(m) ? m : P + m);

// "judge", "deep,judge" or "nvidia/nemotron-3.5-lightning-30b-a3b": the human pins or reorders routes
// without a code change.
export function parseModeOrder(value: string | undefined): string[] | undefined {
  if (!value || !value.trim()) return undefined;
  const modes = value.split(",").map((m) => normalise(m.trim())).filter((m) => m !== P);
  for (const m of modes) {
    if (EXCLUDED_MODELS.includes(m)) throw new Error(`METERLESS_MODE_ORDER: ${m} is excluded (it answered extraction in prose 63/63 on 2026-10-22)`);
    if (PROVIDER_MODEL.test(m)) continue;
    if (isBlocked(m)) throw new Error(`METERLESS_MODE_ORDER: ${m} is not allowed for text tasks`);
    if (!FALLBACK_MODES.includes(m)) throw new Error(`METERLESS_MODE_ORDER: unknown mode ${m} (allowed: ${FALLBACK_MODES.join(", ")}, or a model id like nvidia/<name>)`);
  }
  return [...new Set(modes)];
}

export type DeadEntry = { dead_model: string; reason: "dead" | "unavailable"; detail: string; first_seen: string; last_seen: string };

// Modes found dead in earlier runs are tried last. An entry expires 6 hours after it was last seen,
// so an upstream that gets fixed is tried again.
export const DEAD_TTL_MS = 6 * 60 * 60 * 1000;

export interface DeadModes {
  isDead(mode: string): DeadEntry | undefined;
  markDead(mode: string, model: string, reason?: "dead" | "unavailable", detail?: string): void;
  markAlive(mode: string): void;
}

export class MemoryDeadModes implements DeadModes {
  protected entries: Record<string, DeadEntry> = {};
  constructor(protected now: () => number = Date.now) {}
  isDead(mode: string) {
    const e = this.entries[mode];
    return e && this.now() - Date.parse(e.last_seen) < DEAD_TTL_MS ? e : undefined;
  }
  markDead(mode: string, model: string, reason: "dead" | "unavailable" = "dead", detail = "") {
    const at = new Date(this.now()).toISOString();
    const prev = this.entries[mode];
    this.entries[mode] = { dead_model: model, reason, detail: detail.slice(0, 300), first_seen: prev?.first_seen ?? at, last_seen: at };
    this.save();
  }
  markAlive(mode: string) {
    if (!(mode in this.entries)) return;
    delete this.entries[mode];
    this.save();
  }
  protected save() {}
}

// state/dead-modes.json: { "<mode>": { dead_model, first_seen, last_seen } }
export class FileDeadModes extends MemoryDeadModes {
  constructor(
    private file: string,
    now: () => number = Date.now,
  ) {
    super(now);
    if (existsSync(file)) this.entries = JSON.parse(readFileSync(file, "utf8")) as Record<string, DeadEntry>;
  }
  protected save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.entries, null, 2) + "\n");
  }
}

// Candidate modes for one call: the human's order if set, else the agent's mode (or the one that stuck)
// then the fallback order. Unlisted and blocked modes are dropped; known-dead modes go to the end.
export function candidateModes(first: string, opts: { order?: string[]; available?: string[]; dead?: DeadModes }): string[] {
  // A pinned provider model id with no human-set order has no fallback: the Meterless modes are not
  // required for a run against another provider, and a dead pinned model is reported, not rerouted.
  if (!opts.order?.length && PROVIDER_MODEL.test(first) && !first.startsWith(P)) return [first];
  // /v1/models lists routing modes only; a pinned provider model id is passed through as is.
  const listed = (m: string) => PROVIDER_MODEL.test(m) || !opts.available || opts.available.includes(m);
  const all = [...new Set(opts.order?.length ? opts.order : [first, ...FALLBACK_MODES])].filter((m) => !isBlocked(m) && !EXCLUDED_MODELS.includes(m) && listed(m));
  const alive = all.filter((m) => !opts.dead?.isDead(m));
  return [...alive, ...all.filter((m) => !alive.includes(m))];
}
