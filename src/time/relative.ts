// When a sentence says when an arrangement starts ("from next week", "from tomorrow", "from November 2nd"),
// the date is worked out here, by code, from the moment the message was sent (America/Chicago) — never left
// to the model. Intake compares the model's `effective` with this and the code wins. A phrase people read two
// ways ("next Thursday" said on a Tuesday) is reported as ambiguous with both readings, so the user picks.
import { chicagoIso, chicagoMidnight, chicagoParts, WEEKDAYS } from "./chicago.ts";

export type RelativeStart =
  | { kind: "date"; effective: string; phrase: string; reading: string }
  | { kind: "ambiguous"; phrase: string; readings: string[] };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAY_MS = 86_400_000;

type Day = { year: number; month: number; day: number };
const addDays = (d: Day, n: number): Day => {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
};
const midnightIso = (d: Day) => chicagoIso(chicagoMidnight(d.year, d.month, d.day));
const label = (d: Day) => {
  const w = WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()];
  return `${w[0].toUpperCase()}${w.slice(1, 3)} ${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
};

export function resolveRelativeStart(text: string, sentAt: string): RelativeStart | null {
  const sent = Date.parse(sentAt);
  if (Number.isNaN(sent)) return null;
  const p = chicagoParts(sent);
  const today: Day = { year: p.year, month: p.month, day: p.day };
  const dow = WEEKDAYS.indexOf(p.weekday as (typeof WEEKDAYS)[number]); // 0 = Sunday
  const t = text.toLowerCase();
  const date = (phrase: string, d: Day): RelativeStart => ({ kind: "date", effective: midnightIso(d), phrase, reading: `"${phrase}" said on ${label(today)} = ${label(d)}` });

  let m: RegExpMatchArray | null;
  if ((m = t.match(/\b(from now on|starting now|effective immediately|as of now)\b/))) return { kind: "date", effective: chicagoIso(sent), phrase: m[1], reading: `"${m[1]}" = the moment it was said` };
  if ((m = t.match(/\b((?:from|starting|as of) today)\b/))) return date(m[1], today);
  if ((m = t.match(/\b((?:from|starting|as of) tomorrow)\b/))) return date(m[1], addDays(today, 1));
  // Weeks start on Monday: "next week" said on Tuesday 11/3 is Monday 11/9.
  if ((m = t.match(/\b((?:from |starting )?next week)\b/))) return date(m[1], addDays(today, (8 - dow) % 7 || 7));
  if ((m = t.match(/\b((?:from |starting )?next month)\b/))) return date(m[1], p.month === 12 ? { year: p.year + 1, month: 1, day: 1 } : { year: p.year, month: p.month + 1, day: 1 });
  // "next Thursday" on a Tuesday: this coming Thursday, or the one a week later. Ask, don't guess.
  if ((m = t.match(/\b((?:from |starting )?next (sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b(?!s)/))) {
    const ahead = (WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number]) - dow + 7) % 7 || 7;
    return { kind: "ambiguous", phrase: m[1], readings: [label(addDays(today, ahead)), label(addDays(today, ahead + 7))] };
  }
  // "from Thursday" / "starting Thursday" / "this Thursday": the coming one (a plural, "Thursdays", is a
  // repeating day, not a start date, and is left alone).
  if ((m = t.match(/\b((?:from|starting|this) (sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b(?!s)/))) {
    const ahead = (WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number]) - dow + 7) % 7 || 7;
    return date(m[1], addDays(today, ahead));
  }
  // "from November 2nd": that day, in the year that puts it nearest after the message (a date more than
  // about six months back is read as next year's).
  if ((m = t.match(/\b((?:from|starting|as of|on|beginning) (january|february|march|april|may|june|july|august|september|october|november|december) (\d{1,2})(?:st|nd|rd|th)?)\b/))) {
    const month = MONTHS.indexOf(m[2]) + 1;
    const day = Number(m[3]);
    let d: Day = { year: p.year, month, day };
    if (Date.UTC(d.year, month - 1, day) < Date.UTC(p.year, p.month - 1, p.day) - 183 * DAY_MS) d = { year: p.year + 1, month, day };
    const check = new Date(Date.UTC(d.year, month - 1, day));
    if (check.getUTCMonth() + 1 !== month) return null; // "February 30th": not a date; leave it to the user
    return date(m[1], d);
  }
  return null;
}
