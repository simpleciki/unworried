// Export a calendar to iCalendar text (RFC 5545). Instants are written in UTC (…Z) so no reader has to
// know the Chicago rules; all-day events are written as DATE values. Extra fields travel in X- properties
// so the test's minimal parser can rebuild the same events.
import type { CalEvent } from "./port.ts";
import { chicagoParts, instant } from "./port.ts";

const pad = (n: number) => String(n).padStart(2, "0");

function utcStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function dateStamp(ms: number): string {
  const p = chicagoParts(ms);
  return `${p.year}${pad(p.month)}${pad(p.day)}`;
}

// TEXT escaping per RFC 5545 §3.3.11.
export const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
export const unescapeText = (s: string) => s.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

// Lines longer than 75 octets are folded with CRLF + one space.
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function toIcs(events: CalEvent[], calendarName = "unworried sandbox"): string {
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//unworried//sandbox//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${escapeText(calendarName)}`];
  for (const e of events) {
    const start = instant(e.start, `event ${e.event_id} start`);
    const end = instant(e.end, `event ${e.event_id} end`);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${e.event_id}`);
    lines.push(`SEQUENCE:${sequenceOf(e.version)}`);
    lines.push(`X-UNWORRIED-VERSION:${escapeText(e.version)}`);
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(start)}`);
      lines.push(`DTEND;VALUE=DATE:${dateStamp(end)}`);
      // The exact instants too, so the round trip is lossless whatever the reader does with DATE values.
      lines.push(`X-UNWORRIED-START:${e.start}`);
      lines.push(`X-UNWORRIED-END:${e.end}`);
    } else {
      lines.push(`DTSTART:${utcStamp(start)}`);
      lines.push(`DTEND:${utcStamp(end)}`);
      lines.push(`X-UNWORRIED-START:${e.start}`);
      lines.push(`X-UNWORRIED-END:${e.end}`);
    }
    lines.push(`CATEGORIES:${escapeText(e.category)}`);
    lines.push(`ORGANIZER;CN=me:mailto:me@invalid`);
    for (const a of e.attendees) lines.push(`ATTENDEE;CN=${escapeText(a)}:mailto:attendee@invalid`);
    if (e.location !== undefined) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.buffer_before_min !== undefined) lines.push(`X-UNWORRIED-BUFFER-BEFORE:${e.buffer_before_min}`);
    if (e.buffer_after_min !== undefined) lines.push(`X-UNWORRIED-BUFFER-AFTER:${e.buffer_after_min}`);
    if (e.covered_by !== undefined) {
      lines.push(`DESCRIPTION:${escapeText(`Covered by ${e.covered_by}: they said yes. (unworried, sandbox ${e.version})`)}`);
      lines.push(`X-UNWORRIED-COVERED-BY:${escapeText(e.covered_by)}`);
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

const sequenceOf = (version: string) => {
  const m = version.match(/(\d+)$/);
  return m ? +m[1] : 0;
};

// Undo line folding (the inverse of fold), for readers.
export const unfold = (text: string) => text.replace(/\r\n[ \t]/g, "");
