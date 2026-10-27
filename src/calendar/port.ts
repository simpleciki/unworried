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

export { chicagoParts, chicagoIso, chicagoLocal, WEEKDAYS } from "../time/chicago.ts";
export type { ChicagoParts, Weekday } from "../time/chicago.ts";
