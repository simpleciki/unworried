// Conflict detection, pure code. The occupied interval of an event is [start − buffer_before,
// end + buffer_after); two intervals that intersect conflict, touching ends do not. All-day events
// conflict only with all-day events (v1 limitation). Everything is compared as instants.
import { createHash } from "node:crypto";
import type { CalEvent } from "../calendar/port.ts";
import { chicagoIso, instant } from "../calendar/port.ts";

export type Interval = { start: number; end: number }; // epoch ms, half-open

export type Conflict = {
  conflict_id: string; // hash of the sorted event ids + versions: the same conflict found twice has the same id
  a: CalEvent; // the earlier-starting event
  b: CalEvent;
  overlap: { start: string; end: string }; // of the occupied intervals, ISO with Chicago offset
};

export function occupied(e: CalEvent): Interval {
  return {
    start: instant(e.start, `event ${e.event_id} start`) - (e.buffer_before_min ?? 0) * 60_000,
    end: instant(e.end, `event ${e.event_id} end`) + (e.buffer_after_min ?? 0) * 60_000,
  };
}

export const intersects = (x: Interval, y: Interval) => x.start < y.end && y.start < x.end;

export function conflictId(a: CalEvent, b: CalEvent): string {
  const parts = [`${a.event_id}@${a.version}`, `${b.event_id}@${b.version}`].sort();
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 16);
}

export function detectConflicts(events: CalEvent[]): Conflict[] {
  const sorted = [...events].sort((x, y) => instant(x.start) - instant(y.start) || x.event_id.localeCompare(y.event_id));
  const out: Conflict[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (Boolean(a.all_day) !== Boolean(b.all_day)) continue;
      const x = occupied(a);
      const y = occupied(b);
      if (!intersects(x, y)) continue;
      out.push({ conflict_id: conflictId(a, b), a, b, overlap: { start: chicagoIso(Math.max(x.start, y.start)), end: chicagoIso(Math.min(x.end, y.end)) } });
    }
  }
  return out;
}
