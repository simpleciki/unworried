// Time as closed intervals [start, end] in epoch ms. Full ISO datetimes must carry an offset;
// coarse forms (date, month, ISO week, quarter) are read as America/Chicago local calendar spans.

export type Interval = { start: number; end: number };
export type Order = "before" | "after" | "overlap" | "incomparable";

const DAY = 86_400_000;

// US daylight time: second Sunday of March 02:00 to first Sunday of November 02:00 (local).
function nthSunday(year: number, month: number, n: number): number {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + (n - 1) * 7;
}

export function chicagoOffsetMinutes(year: number, month: number, day: number): number {
  const md = month * 100 + day;
  const dstStart = 2 * 100 + nthSunday(year, 2, 2);
  const dstEnd = 10 * 100 + nthSunday(year, 10, 1);
  return md >= dstStart && md < dstEnd ? -300 : -360;
}

function localMidnight(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day) - chicagoOffsetMinutes(year, month, day) * 60_000;
}

function span(y: number, m: number, d: number, days: number): Interval {
  const start = localMidnight(y, m, d);
  const endDay = new Date(Date.UTC(y, m, d + days));
  return {
    start,
    end: localMidnight(endDay.getUTCFullYear(), endDay.getUTCMonth(), endDay.getUTCDate()) - 1,
  };
}

export function parseTime(value: string | null | undefined): Interval | null {
  if (!value) return null;
  const v = value.trim();
  let m: RegExpMatchArray | null;
  if ((m = v.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)$/))) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : { start: t, end: t };
  }
  if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return span(+m[1], +m[2] - 1, +m[3], 1);
  if ((m = v.match(/^(\d{4})-(\d{2})$/))) {
    const days = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
    return span(+m[1], +m[2] - 1, 1, days);
  }
  if ((m = v.match(/^(\d{4})-W(\d{2})$/))) {
    // ISO week 1 contains 4 January; weeks start on Monday.
    const jan4 = new Date(Date.UTC(+m[1], 0, 4));
    const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY + (+m[2] - 1) * 7 * DAY);
    return span(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate(), 7);
  }
  if ((m = v.match(/^(\d{4})-Q([1-4])$/))) {
    const q = +m[2] - 1;
    const days = (Date.UTC(+m[1], q * 3 + 3, 1) - Date.UTC(+m[1], q * 3, 1)) / DAY;
    return span(+m[1], q * 3, 1, days);
  }
  return null; // datetimes without an offset are refused, not guessed
}

export function compare(a: string | Interval | null | undefined, b: string | Interval | null | undefined): Order {
  const x = typeof a === "string" ? parseTime(a) : (a ?? null);
  const y = typeof b === "string" ? parseTime(b) : (b ?? null);
  if (!x || !y) return "incomparable";
  if (x.end < y.start) return "before";
  if (x.start > y.end) return "after";
  return "overlap";
}

// Instant used for "<= D" checks: the end of a coarse as-of value, the instant itself otherwise.
export function asOfMs(value: string): number {
  const t = parseTime(value);
  if (!t) throw new Error(`unparseable as_of: ${value}`);
  return t.end;
}

export const startMs = (value: string): number => {
  const t = parseTime(value);
  if (!t) throw new Error(`unparseable time: ${value}`);
  return t.start;
};

// Local calendar day number (America/Chicago) as written in an offset timestamp.
export const localDayNumber = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY;
