// Turns a time phrase a model copied from a record ("17 March 2026 at 09:20", "1 June", "2026-06-01")
// into an ISO time with an America/Chicago offset. Code decides the time, never the model.
// No phrase, or one this reader cannot place, falls back to when the record was written.
import { chicagoOffsetMinutes, parseTime } from "./time.ts";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthIndex = (m: string) => MONTHS.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)));

function offset(y: number, m: number, d: number): string {
  const min = chicagoOffsetMinutes(y, m, d);
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function iso(y: number, m: number, d: number, hh = 0, mm = 0): string | null {
  const dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null; // e.g. 31 June
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m + 1)}-${p(d)}T${p(hh)}:${p(mm)}:00${offset(y, m, d)}`;
}

export type PhraseResult = { iso: string; source: "phrase" | "record_time" };

export function parsePhrase(phrase: string | null | undefined, recordIso: string): PhraseResult {
  const fallback: PhraseResult = { iso: recordIso, source: "record_time" };
  const p = (phrase ?? "").trim();
  if (!p || /^(record[_ ]time|now|today|immediately|n\/a|none|null)$/i.test(p)) return fallback;
  const year = Number(recordIso.slice(0, 4));

  if (parseTime(p) && /T\d{2}:\d{2}/.test(p)) return { iso: p, source: "phrase" }; // full ISO with offset
  let m = p.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (m) {
    const out = iso(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
    return out ? { iso: out, source: "phrase" } : fallback;
  }
  const time = p.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/);
  const hh = time ? +time[1] : 0;
  const mm = time ? +time[2] : 0;
  // "17 March 2026", "17 March", "the 17th of March"
  m = p.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})(?:,?\s+(\d{4}))?/);
  if (m && monthIndex(m[2]) >= 0) {
    const out = iso(m[3] ? +m[3] : year, monthIndex(m[2]), +m[1], hh, mm);
    return out ? { iso: out, source: "phrase" } : fallback;
  }
  // "March 17, 2026", "June 1"
  m = p.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (m && monthIndex(m[1]) >= 0) {
    const out = iso(m[3] ? +m[3] : year, monthIndex(m[1]), +m[2], hh, mm);
    return out ? { iso: out, source: "phrase" } : fallback;
  }
  return fallback;
}
