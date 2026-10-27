// The calendar the assistant acts on, and the shape of one event. v1 moves only the owner's own events:
// no create, no delete. Every timestamp is ISO 8601 with an explicit America/Chicago offset; every
// comparison uses instants (epoch ms), never wall-clock strings.

export type CategoryKey = string; // one of the categories in data/vocab.yaml (kids_pickup, work_focus, …)

export interface CalEvent {
  event_id: string;
  version: string; // changes on every write; update() refuses a stale one
  title: string;
  start: string; // ISO 8601 with offset
  end: string; // ISO 8601 with offset, after start
  all_day?: boolean;
  owner: "me";
  attendees: string[]; // anyone besides "me" → the event can only be drafted about, never moved
  category: CategoryKey;
  location?: string;
  buffer_before_min?: number;
  buffer_after_min?: number;
}

export interface CalendarPort {
  list(range: { start: string; end: string }): Promise<CalEvent[]>;
  get(event_id: string): Promise<CalEvent | null>;
  // Throws VersionMismatch when expected_version is not the event's current version.
  update(event_id: string, patch: Partial<CalEvent>, expected_version: string): Promise<CalEvent>;
}

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarError";
  }
}

export class VersionMismatch extends CalendarError {
  readonly event_id: string;
  readonly expected: string;
  readonly actual: string;
  constructor(event_id: string, expected: string, actual: string) {
    super(`event ${event_id}: expected version ${expected} but the calendar has ${actual}`);
    this.name = "VersionMismatch";
    this.event_id = event_id;
    this.expected = expected;
    this.actual = actual;
  }
}

// ---- time ------------------------------------------------------------------------------------------

// Full ISO datetime with an explicit offset. Anything else (a bare date, a datetime without offset) is
// refused by the calendar: it is not an instant.
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)$/;

export function instant(iso: string, what = "timestamp"): number {
  if (!OFFSET_ISO.test(iso)) throw new CalendarError(`${what} ${JSON.stringify(iso)} is not an ISO 8601 datetime with an offset`);
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new CalendarError(`${what} ${JSON.stringify(iso)} does not parse`);
  return t;
}

const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "long",
  timeZoneName: "longOffset",
});

export type ChicagoParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string; offset: string; dayKey: string };

export function chicagoParts(ms: number): ChicagoParts {
  const p: Record<string, string> = {};
  for (const part of FMT.formatToParts(new Date(ms))) p[part.type] = part.value;
  const offset = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.replace("GMT", "");
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: p.weekday.toLowerCase(), offset, dayKey: `${p.year}-${p.month}-${p.day}` };
}

// ISO 8601 with the Chicago offset in force at that instant, e.g. 2026-11-01T01:30:00-06:00.
export function chicagoIso(ms: number): string {
  const p = chicagoParts(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${p.offset}`;
}

// The instant of a Chicago wall-clock time. During the repeated hour when DST ends (01:00–02:00 on
// 2026-11-01) the first occurrence (CDT) is returned; during the skipped hour in March the clock is
// moved forward.
export function chicagoLocal(year: number, month: number, day: number, hour: number, minute = 0): number {
  for (const offsetHours of [5, 6]) {
    const candidate = Date.UTC(year, month - 1, day, hour + offsetHours, minute);
    const p = chicagoParts(candidate);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) return candidate;
  }
  return Date.UTC(year, month - 1, day, hour + 6, minute); // skipped hour: the CST reading, one hour later on the wall
}

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
