// Builds an ActionPlan for one conflict from the decisions in force. Code orders the candidates; no model.
// Any seat the plan depends on that is not PASS → the whole plan is `refused`, naming the seat and cards.
import { createHash } from "node:crypto";
import type { CalEvent, Weekday } from "../calendar/port.ts";
import { chicagoIso, chicagoLocal, chicagoParts, instant } from "../calendar/port.ts";
import type { Conflict } from "./detect.ts";
import { intersects, occupied } from "./detect.ts";
import type { Lookup, SeatsView, WorkingHours } from "./seats-view.ts";

export type StepKind = "reschedule_own" | "draft_message" | "draft_handoff";

export type PlanStep = {
  kind: StepKind;
  target_event_id: string;
  before: Partial<CalEvent>; // always carries version, start, end
  after?: Partial<CalEvent>; // reschedule_own: the new start/end
  draft?: { to: string[]; subject: string; body: string };
};

export type Refusal = { reason: string; seats: string[]; cards: string[] };

export type ActionPlan = {
  plan_id: string; // hash(conflict_id + seat_versions + event versions)
  conflict_id: string;
  at: string; // the instant the seats were resolved at (the conflict's start), for re-resolution
  status: "ready" | "refused";
  refusal?: Refusal;
  winner?: string; // event id that stays
  loser?: string; // event id that yields
  depends_on_seats: string[];
  seat_versions: string[]; // "<seat key>=<card id in force>"
  steps: PlanStep[];
  explanation: string;
};

export type PlanContext = {
  events: CalEvent[]; // the calendar as read (the free-slot search avoids all of them)
  seats: SeatsView;
  horizonDays?: number; // how many days ahead a slot may be looked for (default 5)
  slotStepMin?: number; // default 15
};

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const fmt = (iso: string) => {
  const p = chicagoParts(instant(iso));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.weekday[0].toUpperCase()}${p.weekday.slice(1, 3)} ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
};
const cite = (l: Lookup<unknown>) => `"${l.quote}" (decided ${l.decided_at} by ${l.decided_by}${l.replaced ? `, replacing "${l.replaced.quote}" of ${l.replaced.decided_at}` : ""})`;

export function planConflict(conflict: Conflict, ctx: PlanContext): ActionPlan {
  const at = instant(conflict.overlap.start);
  const depends: string[] = [];
  const versions: string[] = [];
  const note = (l: Lookup<unknown>) => {
    if (!depends.includes(l.key)) {
      depends.push(l.key);
      versions.push(`${l.key}=${l.card_id ?? "-"}`);
    }
  };
  const finish = (partial: Omit<ActionPlan, "plan_id" | "conflict_id" | "at" | "depends_on_seats" | "seat_versions">): ActionPlan => {
    const plan_id = hash([conflict.conflict_id, ...versions, `${conflict.a.event_id}@${conflict.a.version}`, `${conflict.b.event_id}@${conflict.b.version}`].join("|"));
    return { plan_id, conflict_id: conflict.conflict_id, at: conflict.overlap.start, depends_on_seats: depends, seat_versions: versions, ...partial };
  };
  const refuse = (reason: string, lookups: Lookup<unknown>[]): ActionPlan =>
    finish({ status: "refused", refusal: { reason, seats: lookups.map((l) => l.key), cards: [...new Set(lookups.flatMap((l) => l.cards))] }, steps: [], explanation: `Refused: ${reason}` });

  // 1. Which comes first.
  const pa = ctx.seats.priority(conflict.a.category, at);
  const pb = ctx.seats.priority(conflict.b.category, at);
  note(pa);
  note(pb);
  const bad = [pa, pb].filter((l) => l.state !== "PASS");
  if (bad.length) return refuse(`which of these two comes first? ${bad.map((l) => l.reason).join("; ")}`, bad);
  if (pa.value === pb.value) return refuse(`which of these two comes first? ${conflict.a.category} and ${conflict.b.category} both have rank ${pa.value}`, [pa, pb]);
  const aWins = (pa.value as number) < (pb.value as number);
  const winner = aWins ? conflict.a : conflict.b;
  const loser = aWins ? conflict.b : conflict.a;
  const winnerLookup = aWins ? pa : pb;
  const loserLookup = aWins ? pb : pa;
  const why = `"${loser.title}" (${fmt(loser.start)}) yields to "${winner.title}" (${fmt(winner.start)}): ${loser.category} has rank ${loserLookup.value} and ${winner.category} rank ${winnerLookup.value}, by ${cite(winnerLookup)}${loserLookup.card_id !== winnerLookup.card_id ? ` and ${cite(loserLookup)}` : ""}.`;
  const before: Partial<CalEvent> = { version: loser.version, start: loser.start, end: loser.end };

  // 2. A pickup I cannot make → hand off to the backup in force; never mark it covered.
  if (loser.category === "kids_pickup") {
    const weekday = chicagoParts(instant(loser.start)).weekday as Weekday;
    const backup = ctx.seats.pickupBackup(weekday, at);
    note(backup);
    if (backup.state !== "PASS") return refuse(`who covers the ${weekday} pickup? ${backup.reason}`, [backup]);
    if (loser.attendees.length) return refuse(`the pickup "${loser.title}" has other attendees (${loser.attendees.join(", ")}); the assistant only hands off its owner's own pickups`, []);
    const to = backup.value as string;
    const body = `Hi ${to},\n\nCould you cover Theo's pickup on ${fmt(loser.start)} (${loser.location ?? "usual place"})? I have "${winner.title}" from ${fmt(winner.start)} to ${fmt(winner.end)} and cannot make it.\n\nPlease reply yes or no — I will not count it as covered until you confirm.\n\nThanks,\nMorgan`;
    return finish({
      status: "ready",
      winner: winner.event_id,
      loser: loser.event_id,
      steps: [{ kind: "draft_handoff", target_event_id: loser.event_id, before, draft: { to: [to], subject: `Theo pickup ${fmt(loser.start)} — can you cover?`, body } }],
      explanation: `${why} The ${weekday} backup is ${to}, by ${cite(backup)}. A handoff message to ${to} is drafted; the pickup stays on the calendar as not covered until ${to} confirms.`,
    });
  }

  // 3. Other attendees → draft only; the calendar is never touched.
  const hours = ctx.seats.workingHours(at);
  note(hours);
  const window = hours.state === "PASS" ? (hours.value as WorkingHours) : null;
  if (loser.attendees.length) {
    const slots = findSlots(loser, ctx.events, window, 2, ctx);
    if (!slots.length) return refuse(`no free slot ${window ? "inside working hours" : "within ±2 h on the same day (no working-hours decision)"} to offer ${loser.attendees.join(", ")} for "${loser.title}"`, [hours]);
    const options = slots.map((s, i) => `  ${i + 1}. ${fmt(s.start)} – ${fmt(s.end)}`).join("\n");
    const body = `Hi ${loser.attendees.join(", ")},\n\nI need to move "${loser.title}" (currently ${fmt(loser.start)} – ${fmt(loser.end)}). Would either of these work for you?\n\n${options}\n\nNothing is changed yet; I will update the invitation once you pick one.\n\nThanks,\nMorgan`;
    return finish({
      status: "ready",
      winner: winner.event_id,
      loser: loser.event_id,
      steps: [{ kind: "draft_message", target_event_id: loser.event_id, before, draft: { to: [...loser.attendees], subject: `Move "${loser.title}"? Two options`, body } }],
      explanation: `${why} "${loser.title}" has other attendees (${loser.attendees.join(", ")}), so it is not moved: a message with two candidate slots is drafted${window ? ` inside working hours ${cite(hours)}` : " within ±2 h of the original slot (no working-hours decision)"}.`,
    });
  }

  // 4. Only me → move it, if the decisions allow.
  const movable = ctx.seats.movable(loser.category, at);
  note(movable);
  if (movable.state !== "PASS") return refuse(`may "${loser.title}" be moved? ${movable.reason}; treated as not movable`, [movable]);
  if (movable.value !== true) return refuse(`"${loser.title}" may not be moved: ${cite(movable)}`, [movable]);
  const slots = findSlots(loser, ctx.events, window, 1, ctx);
  if (!slots.length) return refuse(`no free slot ${window ? "inside working hours" : "within ±2 h on the same day (no working-hours decision)"} for "${loser.title}"`, [hours]);
  const slot = slots[0];
  return finish({
    status: "ready",
    winner: winner.event_id,
    loser: loser.event_id,
    steps: [{ kind: "reschedule_own", target_event_id: loser.event_id, before, after: { start: slot.start, end: slot.end } }],
    explanation: `${why} "${loser.title}" may be moved, by ${cite(movable)}. Earliest free slot ${window ? `inside working hours (${cite(hours)})` : "within ±2 h of the original slot, same day (no working-hours decision)"}: ${fmt(slot.start)} – ${fmt(slot.end)}.`,
  });
}

// Earliest free slots for `loser` of the same duration: inside the working-hours window on each day
// from the conflict day forward (or, without a working-hours decision, within ±2 h on the same day),
// whose occupied interval intersects no other event's.
export function findSlots(loser: CalEvent, events: CalEvent[], hours: WorkingHours | null, count: number, opts: { horizonDays?: number; slotStepMin?: number } = {}): { start: string; end: string }[] {
  const step = (opts.slotStepMin ?? 15) * 60_000;
  const horizon = hours ? (opts.horizonDays ?? 5) : 0;
  const start0 = instant(loser.start);
  const duration = instant(loser.end) - start0;
  const bufBefore = (loser.buffer_before_min ?? 0) * 60_000;
  const bufAfter = (loser.buffer_after_min ?? 0) * 60_000;
  const others = events.filter((e) => e.event_id !== loser.event_id && !e.all_day).map(occupied);
  const found: { start: string; end: string }[] = [];
  const p0 = chicagoParts(start0);
  for (let d = 0; d <= horizon && found.length < count; d++) {
    const day = new Date(Date.UTC(p0.year, p0.month - 1, p0.day + d));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const dd = day.getUTCDate();
    let winStart: number;
    let winEnd: number;
    if (hours) {
      const weekday = chicagoParts(chicagoLocal(y, m, dd, 12)).weekday as Weekday;
      if (!hours.days.includes(weekday)) continue;
      winStart = chicagoLocal(y, m, dd, hours.start.hour, hours.start.minute);
      winEnd = hours.end.hour === 24 ? chicagoLocal(y, m, dd + 1, 0, 0) : chicagoLocal(y, m, dd, hours.end.hour, hours.end.minute);
    } else {
      const dayStart = chicagoLocal(y, m, dd, 0, 0);
      const next = new Date(Date.UTC(y, m - 1, dd + 1));
      const dayEnd = chicagoLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
      winStart = Math.max(dayStart, start0 - 2 * 3_600_000);
      winEnd = Math.min(dayEnd, start0 + duration + 2 * 3_600_000);
    }
    for (let s = winStart; s + duration <= winEnd && found.length < count; s += step) {
      if (s === start0) continue; // where it already is
      const candidate = { start: s - bufBefore, end: s + duration + bufAfter };
      if (others.some((o) => intersects(o, candidate))) continue;
      found.push({ start: chicagoIso(s), end: chicagoIso(s + duration) });
    }
  }
  return found;
}
