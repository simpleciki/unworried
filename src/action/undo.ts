// undo(token) restores each event's `before` — only if nobody changed the event since the plan ran.
// All-or-nothing: the versions are checked first; one mismatch refuses the whole undo. A token is
// single-use.
import type { CalEvent, CalendarPort } from "../calendar/port.ts";
import type { ActionStore } from "./execute.ts";
import { CALENDAR_TIMEOUT_MS, matches, withTimeout } from "./execute.ts";
import type { Trace } from "./trace.ts";

export type UndoResult = {
  status: "restored" | "refused" | "needs_attention";
  reason?: string;
  events: { event_id: string; outcome: "restored" | "unchanged" | "failed"; readback?: Partial<CalEvent>; error?: string }[];
};

export async function undo(token: string, deps: { calendar: CalendarPort; store: ActionStore; trace: Trace; session_id: string; timeoutMs?: number }): Promise<UndoResult> {
  const ms = deps.timeoutMs ?? CALENDAR_TIMEOUT_MS;
  const t = (outcome: string, details?: Record<string, unknown>) => deps.trace.write({ session_id: deps.session_id, action: "undo", ref: token, outcome, details });
  const rec = deps.store.undo.get(token);
  if (!rec) {
    t("refused", { reason: "unknown or already used undo token" });
    return { status: "refused", reason: "unknown or already used undo token", events: [] };
  }
  // Check every version before touching anything.
  const currents = new Map<string, CalEvent>();
  for (const w of rec.writes) {
    const current = await withTimeout(deps.calendar.get(w.event_id), ms, `read ${w.event_id}`);
    if (!current) {
      t("refused", { event_id: w.event_id, reason: "event not found" });
      return { status: "refused", reason: `event ${w.event_id} not found`, events: [] };
    }
    if (current.version !== w.written_version) {
      t("refused", { event_id: w.event_id, reason: "changed after the plan ran", written: w.written_version, current: current.version });
      return { status: "refused", reason: `this event was changed after the plan ran: ${w.event_id} is at version ${current.version}, the plan wrote ${w.written_version}`, events: [{ event_id: w.event_id, outcome: "unchanged", readback: { version: current.version, start: current.start, end: current.end } }] };
    }
    currents.set(w.event_id, current);
  }
  const out: UndoResult = { status: "restored", events: [] };
  for (const w of [...rec.writes].reverse()) {
    try {
      await withTimeout(deps.calendar.update(w.event_id, w.before, currents.get(w.event_id)!.version), ms, `restore ${w.event_id}`);
      const back = await withTimeout(deps.calendar.get(w.event_id), ms, `read back ${w.event_id}`);
      const mismatch = matches(back, w.before);
      if (mismatch) throw new Error(`read-back differs: ${mismatch}`);
      out.events.push({ event_id: w.event_id, outcome: "restored", readback: { version: back!.version, start: back!.start, end: back!.end } });
    } catch (e) {
      out.status = "needs_attention";
      out.reason = `restoring ${w.event_id} failed: ${(e as Error).message}`;
      const current = await deps.calendar.get(w.event_id).catch(() => null);
      out.events.push({ event_id: w.event_id, outcome: "failed", error: (e as Error).message, readback: current ? { version: current.version, start: current.start, end: current.end } : undefined });
    }
  }
  deps.store.undo.delete(token);
  t(out.status, { plan_id: rec.plan_id, events: out.events.map((e) => `${e.event_id}:${e.outcome}`) });
  return out;
}
