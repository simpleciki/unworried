// A15 — the exported .ics parses back to the same events (minimal parser written here).
import { describe, expect, it } from "vitest";
import { seedEvents } from "../action/fixtures.test-helpers.ts";
import { toIcs, unescapeText, unfold } from "./ics.ts";
import type { CalEvent } from "./port.ts";

// Minimal RFC 5545 reader: unfold, split VEVENTs, read NAME;PARAMS:VALUE lines.
function parseIcs(text: string): CalEvent[] {
  const lines = unfold(text).split("\r\n").filter(Boolean);
  const events: CalEvent[] = [];
  let cur: Record<string, { params: Record<string, string>; value: string }[]> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      const get = (name: string) => cur![name]?.[0]?.value;
      const e: CalEvent = {
        event_id: get("UID")!,
        version: unescapeText(get("X-UNWORRIED-VERSION")!),
        title: unescapeText(get("SUMMARY")!),
        start: get("X-UNWORRIED-START")!,
        end: get("X-UNWORRIED-END")!,
        owner: "me",
        attendees: (cur!.ATTENDEE ?? []).map((a) => unescapeText(a.params.CN)),
        category: unescapeText(get("CATEGORIES")!),
      };
      if (cur!.DTSTART?.[0]?.params.VALUE === "DATE") e.all_day = true;
      if (get("LOCATION") !== undefined) e.location = unescapeText(get("LOCATION")!);
      if (get("X-UNWORRIED-BUFFER-BEFORE") !== undefined) e.buffer_before_min = +get("X-UNWORRIED-BUFFER-BEFORE")!;
      if (get("X-UNWORRIED-BUFFER-AFTER") !== undefined) e.buffer_after_min = +get("X-UNWORRIED-BUFFER-AFTER")!;
      // DTSTART/DTEND in UTC must be the same instants.
      if (!e.all_day) {
        expect(utc(get("DTSTART")!)).toBe(Date.parse(e.start));
        expect(utc(get("DTEND")!)).toBe(Date.parse(e.end));
      }
      events.push(e);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^([A-Z0-9-]+)((?:;[A-Z-]+=[^;:]*)*):(.*)$/);
    if (!m) throw new Error(`unreadable line: ${line}`);
    const params: Record<string, string> = {};
    for (const p of m[2].split(";").filter(Boolean)) {
      const [k, v] = p.split("=");
      params[k] = v;
    }
    (cur[m[1]] ??= []).push({ params, value: m[3] });
  }
  return events;
}

const utc = (stamp: string) => {
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)!;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
};

describe("A15 — ics round trip", () => {
  it("every seed event comes back identical", () => {
    const events = seedEvents();
    const text = toIcs(events);
    expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    const back = parseIcs(text);
    expect(back).toEqual(events);
    expect(back.filter((e) => e.all_day)).toHaveLength(2);
  });

  it("folds long lines to 75 octets and escapes commas and semicolons", () => {
    const e: CalEvent = { event_id: "long", version: "v1", title: "Semi; colon, comma — " + "x".repeat(120), start: "2026-11-03T09:00:00-06:00", end: "2026-11-03T10:00:00-06:00", owner: "me", attendees: ["A, B"], category: "personal", location: "Here; there" };
    const text = toIcs([e]);
    for (const line of text.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(text).toContain("SUMMARY:Semi\\; colon\\, comma");
    expect(parseIcs(text)).toEqual([e]);
  });
});
