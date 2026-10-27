// Sandbox calendar: one JSON file per session id, copied from data/calendar-seed.json on first use.
// Two sessions never see each other's writes; reset() returns a session to the seed. Writes are
// optimistic: update() carries the version the caller last saw and refuses if it has moved on.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CalEvent, CalendarPort } from "./port.ts";
import { CalendarError, VersionMismatch, instant } from "./port.ts";

export const DEFAULT_SEED_PATH = "data/calendar-seed.json";

type SessionFile = { session: string; seed: string; copied_at: string; events: CalEvent[] };

const SESSION_ID = /^[A-Za-z0-9._-]{1,64}$/;

// Validates one event as it comes from a file: shape, instants with offsets, start before end.
export function validateEvent(raw: unknown, where: string): CalEvent {
  if (!raw || typeof raw !== "object") throw new CalendarError(`${where}: event is not an object`);
  const e = raw as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof e[k] !== "string" || !(e[k] as string).length) throw new CalendarError(`${where}: event ${String(e.event_id ?? "?")} field ${k} must be a non-empty string`);
    return e[k] as string;
  };
  const event_id = str("event_id");
  const start = instant(str("start"), `${where}: event ${event_id} start`);
  const end = instant(str("end"), `${where}: event ${event_id} end`);
  if (!(start < end)) throw new CalendarError(`${where}: event ${event_id} ends before it starts`);
  if (e.owner !== "me") throw new CalendarError(`${where}: event ${event_id} owner must be "me"`);
  if (!Array.isArray(e.attendees) || e.attendees.some((a) => typeof a !== "string")) throw new CalendarError(`${where}: event ${event_id} attendees must be a string array`);
  for (const k of ["buffer_before_min", "buffer_after_min"]) {
    if (e[k] !== undefined && (typeof e[k] !== "number" || (e[k] as number) < 0)) throw new CalendarError(`${where}: event ${event_id} ${k} must be a non-negative number`);
  }
  const out: CalEvent = {
    event_id,
    version: str("version"),
    title: str("title"),
    start: e.start as string,
    end: e.end as string,
    owner: "me",
    attendees: [...(e.attendees as string[])],
    category: str("category"),
  };
  if (e.all_day !== undefined) out.all_day = Boolean(e.all_day);
  if (typeof e.location === "string") out.location = e.location;
  if (typeof e.buffer_before_min === "number") out.buffer_before_min = e.buffer_before_min;
  if (typeof e.buffer_after_min === "number") out.buffer_after_min = e.buffer_after_min;
  return out;
}

export function readSeed(path: string): CalEvent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CalendarError(`seed ${path}: cannot read (${(e as Error).message})`);
  }
  const events = Array.isArray(raw) ? raw : (raw as { events?: unknown })?.events;
  if (!Array.isArray(events) || events.length === 0) throw new CalendarError(`seed ${path}: no events array`);
  const out = events.map((e, i) => validateEvent(e, `seed ${path} [${i}]`));
  const ids = new Set<string>();
  for (const e of out) {
    if (ids.has(e.event_id)) throw new CalendarError(`seed ${path}: duplicate event_id ${e.event_id}`);
    ids.add(e.event_id);
  }
  return out;
}

export class JsonCalendarStore implements CalendarPort {
  readonly session: string;
  readonly file: string;
  private readonly seedPath: string;
  private readonly now: () => number;

  constructor(opts: { dir: string; session: string; seedPath?: string; now?: () => number }) {
    if (!SESSION_ID.test(opts.session)) throw new CalendarError(`session id ${JSON.stringify(opts.session)} must match ${SESSION_ID}`);
    this.session = opts.session;
    this.seedPath = opts.seedPath ?? DEFAULT_SEED_PATH;
    this.file = join(opts.dir, `${opts.session}.json`);
    this.now = opts.now ?? Date.now;
    mkdirSync(opts.dir, { recursive: true });
    if (!existsSync(this.file)) this.copySeed();
  }

  private copySeed() {
    const events = readSeed(this.seedPath);
    this.save({ session: this.session, seed: this.seedPath, copied_at: new Date(this.now()).toISOString(), events });
  }

  private load(): SessionFile {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (e) {
      throw new CalendarError(`sandbox ${this.file}: cannot read (${(e as Error).message})`);
    }
    const f = raw as SessionFile;
    if (!f || !Array.isArray(f.events)) throw new CalendarError(`sandbox ${this.file}: no events array`);
    return { ...f, events: f.events.map((e, i) => validateEvent(e, `sandbox ${this.file} [${i}]`)) };
  }

  // Write to a temp file, then rename: a crash mid-write never leaves a half-written sandbox.
  private save(f: SessionFile) {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n");
    renameSync(tmp, this.file);
  }

  async list(range: { start: string; end: string }): Promise<CalEvent[]> {
    const s = instant(range.start, "range.start");
    const e = instant(range.end, "range.end");
    if (!(s < e)) throw new CalendarError("range.end must be after range.start");
    return this.load()
      .events.filter((ev) => instant(ev.start) < e && instant(ev.end) > s)
      .sort((a, b) => instant(a.start) - instant(b.start) || a.event_id.localeCompare(b.event_id))
      .map(clone);
  }

  async get(event_id: string): Promise<CalEvent | null> {
    const ev = this.load().events.find((x) => x.event_id === event_id);
    return ev ? clone(ev) : null;
  }

  async update(event_id: string, patch: Partial<CalEvent>, expected_version: string): Promise<CalEvent> {
    const f = this.load();
    const i = f.events.findIndex((x) => x.event_id === event_id);
    if (i < 0) throw new CalendarError(`event ${event_id} not found in session ${this.session}`);
    const current = f.events[i];
    if (current.version !== expected_version) throw new VersionMismatch(event_id, expected_version, current.version);
    if (patch.event_id !== undefined && patch.event_id !== event_id) throw new CalendarError("event_id cannot be changed");
    if (patch.owner !== undefined && patch.owner !== "me") throw new CalendarError('owner must stay "me"');
    const { version: _ignored, ...fields } = patch;
    const next = validateEvent({ ...current, ...fields, version: bump(current.version) }, `update ${event_id}`);
    f.events[i] = next;
    this.save(f);
    return clone(next);
  }

  // Back to the seed. Not part of CalendarPort: the assistant never calls it; the demo harness does.
  reset(): void {
    rmSync(this.file, { force: true });
    this.copySeed();
  }

  async all(): Promise<CalEvent[]> {
    return this.load().events.map(clone);
  }
}

const clone = (e: CalEvent): CalEvent => ({ ...e, attendees: [...e.attendees] });

// v1 → v2 → … ; a version that is not of that form gets a numeric suffix.
export function bump(version: string): string {
  const m = version.match(/^(.*?)(\d+)$/);
  return m ? `${m[1]}${+m[2] + 1}` : `${version}.1`;
}
