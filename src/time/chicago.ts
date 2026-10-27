// America/Chicago clock helpers shared by the spend ledger, the calendar and the action layer.
// Every function works on instants (epoch ms); the wall-clock rendering carries the offset in force at
// that instant, so the day DST ends (2026-11-01) is 25 hours long and the day it starts is 23.

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

// Offset in force at an instant, in minutes east of UTC (−300 CDT, −360 CST).
export function chicagoOffsetAt(ms: number): number {
  const off = chicagoParts(ms).offset;
  const sign = off.startsWith("-") ? -1 : 1;
  return sign * (+off.slice(1, 3) * 60 + +off.slice(4, 6));
}

const pad = (n: number) => String(n).padStart(2, "0");

// ISO 8601 with the Chicago offset in force at that instant, e.g. 2026-11-01T01:30:00-06:00
// (with `millis`, 2026-11-01T01:30:00.000-06:00).
export function chicagoIso(ms: number, millis = false): string {
  const p = chicagoParts(ms);
  const frac = millis ? `.${String(((ms % 1000) + 1000) % 1000).padStart(3, "0")}` : "";
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${frac}${p.offset}`;
}

export const chicagoDay = (ms: number) => chicagoIso(ms).slice(0, 10);

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

// Midnight of a Chicago calendar day as an instant: 05:00Z under CDT, 06:00Z under CST, decided by the
// offset in force at that midnight (not by the date's "usual" offset).
export function chicagoMidnight(year: number, month: number, day: number): number {
  const cst = Date.UTC(year, month - 1, day, 6);
  return chicagoOffsetAt(cst - 3_600_000) === -300 ? cst - 3_600_000 : cst;
}

// [start, end) in epoch ms of one Chicago calendar day.
export function chicagoDayBounds(day: string): { start: number; end: number } {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`not a calendar day: ${day}`);
  const start = chicagoMidnight(+m[1], +m[2], +m[3]);
  const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  const end = chicagoMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return { start, end };
}

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
