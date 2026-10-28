// The JSON handlers, each bound to one judge's sandbox. Every button press is one request = one action_id
// for the spend wall and the trace. A refusal anywhere comes back as { error, reason } for the panel to show
// in red where the user clicked.
import { randomUUID } from "node:crypto";
import { detectConflicts } from "../action/detect.ts";
import type { Conflict } from "../action/detect.ts";
import { executePlan } from "../action/execute.ts";
import type { ExecutionResult } from "../action/execute.ts";
import { planConflict } from "../action/plan.ts";
import type { ActionPlan } from "../action/plan.ts";
import type { Lookup, SeatsView } from "../action/seats-view.ts";
import { undo } from "../action/undo.ts";
import type { UndoResult } from "../action/undo.ts";
import type { CalEvent } from "../calendar/port.ts";
import { confirm, discard } from "../chat/confirm.ts";
import type { ConfirmEdits } from "../chat/confirm.ts";
import { explainPlan } from "../chat/explain.ts";
import { checkCandidate, intake } from "../chat/intake.ts";
import { relate } from "../chat/relate.ts";
import type { CheckedCard, Relation, SourceRecord } from "../engine/types.ts";
import type { Candidate } from "../ledger/store.ts";
import type { Draft } from "../outbox/drafts.ts";
import type { GuardStatus } from "../spend/guard.ts";
import { WEEKDAYS, chicagoIso } from "../time/chicago.ts";
import type { JudgeSandbox, SandboxManager, StoredPlan } from "./sessions.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, error: string, reason: string) {
    super(error);
    this.name = "ApiError";
    this.status = status;
    this.reason = reason;
  }
}

export type SeatRow = {
  key: string;
  topic: string;
  facet: string;
  scope: string;
  state: string;
  in_effect: { card_id: string; quote: string; decided_at: string; decided_by: string; effective?: string; value?: string } | null;
  replaced: { card_id: string; quote: string; decided_at: string } | null;
  cards: string[];
  refuses: string | null; // what the assistant will refuse because of this seat's state
};

export type ConflictView = { conflict_id: string; at: string; a: CalEvent; b: CalEvent; overlap: { start: string; end: string }; plan_id?: string };

export type StateView = {
  judge: string;
  session_id: string;
  clock: string;
  wall: { enabled: boolean; reason?: string; model?: string; mode: "live" | "sample"; session_committed_usd: number; session_limit_usd: number };
  chat: ReturnType<JudgeSandbox["chat"]>;
  candidates: Candidate[];
  seats: SeatRow[];
  calendar: { events: CalEvent[] };
  conflicts: ConflictView[];
  plans: Record<string, StoredPlan>;
  outbox: Draft[];
  spend: GuardStatus;
};

const refusalFor = (row: Omit<SeatRow, "refuses">, reason: string | undefined): string | null => {
  if (row.state === "PASS") return null;
  const what =
    row.topic === "priority"
      ? `plan any conflict involving a ${row.facet} event ("which of these two comes first?")`
      : row.topic === "movable"
        ? `move a ${row.facet} event (treated as not movable)`
        : row.topic === "pickup_backup"
          ? `draft a handoff for a ${row.facet} pickup (conflict reported only)`
          : "move anything outside ±2 h of its slot (no working-hours decision)";
  return `Will refuse to ${what}${reason ? ` — ${reason}` : ""}`;
};

// One row per seat the vocabulary knows, resolved at the demo clock.
export function seatRows(seats: SeatsView, categories: string[], clock: number): SeatRow[] {
  const rows: SeatRow[] = [];
  const push = (topic: string, facet: string, scope: string, l: Lookup<unknown>) => {
    const base = {
      key: l.key,
      topic,
      facet,
      scope,
      state: l.state,
      in_effect: l.card_id && l.quote ? { card_id: l.card_id, quote: l.quote, decided_at: l.decided_at ?? "", decided_by: l.decided_by ?? "", effective: l.effective, value: l.value === undefined ? undefined : typeof l.value === "object" ? JSON.stringify(l.value) : String(l.value) } : null,
      replaced: l.replaced,
      cards: l.cards,
    };
    rows.push({ ...base, refuses: refusalFor(base, l.reason) });
  };
  for (const c of categories) push("priority", c, "global", seats.priority(c, clock));
  for (const c of categories) push("movable", c, "global", seats.movable(c, clock));
  for (const w of WEEKDAYS) push("pickup_backup", w, "kids", seats.pickupBackup(w, clock));
  push("working_hours", "work", "global", seats.workingHours(clock));
  return rows;
}

// The lookups a plan depended on, re-read from the current seats view (for the explanation prompt).
export function lookupsFor(plan: ActionPlan, seats: SeatsView): Lookup<unknown>[] {
  const at = Date.parse(plan.at);
  return plan.depends_on_seats.map((key) => {
    const [topic, facet] = key.split("|");
    if (topic === "priority") return seats.priority(facet, at);
    if (topic === "movable") return seats.movable(facet, at);
    if (topic === "pickup_backup") return seats.pickupBackup(facet as (typeof WEEKDAYS)[number], at);
    return seats.workingHours(at);
  });
}

export class Api {
  constructor(private readonly m: SandboxManager) {}

  private wallView(sb: JudgeSandbox) {
    const s = this.m.guard.state();
    const { mode } = this.m.guardFor();
    const committed = s.ledger.totals?.bySession[sb.session_id] ?? 0;
    return { enabled: s.enabled, reason: s.reason, model: s.model, mode, session_committed_usd: committed, session_limit_usd: this.m.guard.limits.sessionUsd };
  }

  async conflicts(sb: JudgeSandbox, opts: { all?: boolean } = {}): Promise<ConflictView[]> {
    const events = await sb.calendar.all();
    return detectConflicts(events)
      .filter((c) => opts.all || Date.parse(c.overlap.start) >= this.m.clock)
      .map((c) => ({ conflict_id: c.conflict_id, at: c.overlap.start, a: c.a, b: c.b, overlap: c.overlap, plan_id: [...sb.plans.values()].find((p) => p.plan.conflict_id === c.conflict_id)?.plan.plan_id }));
  }

  async state(sb: JudgeSandbox): Promise<StateView> {
    const seats = sb.ledger.seatsView(this.m.knownAt());
    return {
      judge: sb.judge,
      session_id: sb.session_id,
      clock: chicagoIso(this.m.clock),
      wall: this.wallView(sb),
      chat: sb.chat(),
      candidates: sb.ledger.candidates("pending"),
      seats: seatRows(seats, Object.keys(this.m.extras.categories), this.m.knownAt()),
      calendar: { events: await sb.calendar.all() },
      conflicts: await this.conflicts(sb),
      plans: Object.fromEntries(sb.plans),
      outbox: sb.outbox.list(),
      spend: this.m.guard.status(sb.session_id),
    };
  }

  // Panel 1: one sentence → candidates (intake, then relation for each decision with cards on its seat).
  async chat(sb: JudgeSandbox, text: string, action_id: string): Promise<{ message_id: string; candidates: Candidate[]; mode: "model" | "rules"; note?: string }> {
    if (typeof text !== "string" || !text.trim()) throw new ApiError(400, "empty", "type a sentence first");
    if (text.length > 2000) throw new ApiError(400, "too_long", "one sentence at a time, please (2,000 characters max)");
    const { guard } = this.m.guardFor();
    const message_id = `u-${randomUUID().slice(0, 8)}`;
    const sent_at = chicagoIso(this.m.chatNow());
    sb.say({ message_id, sent_at, from: "me", text });
    sb.trace.write({ session_id: sb.session_id, action: "ui.chat", ref: action_id, outcome: "intake", details: { message_id } });
    const r = await intake({ message_id, session_id: sb.session_id, text, sent_at }, { guard, store: sb.ledger, extras: this.m.extras, action_id, cache: sb.cache, now: () => this.m.chatNow() });
    const candidates: Candidate[] = [];
    for (const c of r.candidates) {
      const related = c.card.mode === "decides" && c.same_seat.length ? (await relate(c, { guard, store: sb.ledger, action_id, cache: sb.cache })).candidate : c;
      candidates.push(related);
    }
    const reply = candidates.length ? `${candidates.length} candidate card${candidates.length > 1 ? "s" : ""} to confirm — nothing is recorded yet.${r.note ? ` ${r.note}` : ""}` : `No arrangement in that sentence, so no card.${r.note ? ` ${r.note}` : ""}`;
    sb.say({ message_id: `a-${randomUUID().slice(0, 8)}`, sent_at: chicagoIso(this.m.chatNow()), from: "assistant", text: reply });
    return { message_id, candidates, mode: r.mode, ...(r.note ? { note: r.note } : {}) };
  }

  // Panel 1: confirm or discard. "I cannot date this" (decided_at = "unknown") is handled here and only
  // here (decision 003-3): the card is written undated and never ordered against the others.
  confirm(sb: JudgeSandbox, candidate_id: string, edits: ConfirmEdits & { cannot_date?: boolean }, action_id: string) {
    const c = sb.ledger.candidate(candidate_id);
    if (!c) throw new ApiError(404, "unknown_candidate", `no candidate ${candidate_id} in this sandbox`);
    if (c.status !== "pending") throw new ApiError(409, "not_pending", `candidate is already ${c.status}`);
    sb.trace.write({ session_id: sb.session_id, action: "ui.confirm", ref: action_id, outcome: edits.cannot_date ? "undated" : "confirm", details: { candidate_id } });
    if (edits.cannot_date) {
      // The other fields are checked as usual; the two dates are placeholders for the check and are written as "unknown".
      const merged = { ...c.card, ...(edits.card ?? {}), decided_at: c.sent_at, effective: c.sent_at, source_recorded_at: c.sent_at };
      const value = edits.value !== undefined ? edits.value : c.value;
      const checked = checkCandidate(merged, value, c.text, sb.ledger.vocab, this.m.extras);
      if (checked.unsure.length) throw new ApiError(422, "unsure", `cannot confirm: still unsure about ${checked.unsure.join(", ")}`);
      const card_id = edits.card_id ?? `card.${candidate_id}`;
      const card: CheckedCard = { card_id, record_id: c.message_id, quote: checked.card.quote, mode: checked.card.mode, topic: checked.card.topic, facets: [checked.card.facet], scope: checked.card.scope, decided_at: "unknown", effective: "unknown", decided_by: checked.card.decided_by, source: "human", result: "PASS" };
      const record: SourceRecord = { record_id: c.message_id, source_type: "client_message", source_version: "v1", text: c.text, author: "me", source_recorded_at: c.sent_at, thread_id: "morgan" };
      sb.ledger.addCard(card, record, [], checked.card.mode === "decides" ? checked.value : null);
      sb.ledger.putCandidate({ ...c, card: { ...checked.card, decided_at: "unknown", effective: "unknown" }, value: checked.value, unsure: [], status: "confirmed", card_id });
      sb.say({ message_id: `a-${randomUUID().slice(0, 8)}`, sent_at: chicagoIso(this.m.chatNow()), from: "assistant", text: `✓ Recorded undated: "${card.quote}" — I cannot order it against other arrangements on its seat, so conflicts there will be refused and both shown to you.`, card_ids: [card_id] });
      return { ok: true as const, card, undated: true, seat: `${card.topic}|${card.facets[0]}|${card.scope}` };
    }
    const r = confirm(candidate_id, edits, { store: sb.ledger, extras: this.m.extras, clock: this.m.knownAt() });
    if (!r.ok) throw new ApiError(422, "unsure", r.reason);
    const relations = Object.entries({ ...c.relations, ...(edits.relations ?? {}) }).filter(([, rel]) => rel !== "UNRELATED") as [string, Relation][];
    const replaced = relations.map(([id, rel]) => `${rel.toLowerCase()} ${id}`).join(", ");
    sb.say({ message_id: `a-${randomUUID().slice(0, 8)}`, sent_at: chicagoIso(this.m.chatNow()), from: "assistant", text: `✓ Recorded: "${r.card.quote}" — decided ${r.card.decided_at}, in force from ${r.card.effective}${replaced ? `; ${replaced}` : ""}${r.holds_seat ? "" : " (a mention or proposal: holds no seat)"}.`, card_ids: [r.card.card_id] });
    return r;
  }

  discard(sb: JudgeSandbox, candidate_id: string, action_id: string) {
    const c = sb.ledger.candidate(candidate_id);
    if (!c) throw new ApiError(404, "unknown_candidate", `no candidate ${candidate_id} in this sandbox`);
    if (c.status !== "pending") throw new ApiError(409, "not_pending", `candidate is already ${c.status}`);
    sb.trace.write({ session_id: sb.session_id, action: "ui.discard", ref: action_id, outcome: "discarded", details: { candidate_id } });
    return discard(candidate_id, { store: sb.ledger });
  }

  // Panel 3: plan one conflict (code), then the checked explanation (model when the wall is on).
  async plan(sb: JudgeSandbox, conflict_id: string, action_id: string, opts: { all?: boolean } = {}): Promise<StoredPlan> {
    const conflicts = await this.conflicts(sb, { all: true });
    const view = conflicts.find((c) => c.conflict_id === conflict_id);
    if (!view) throw new ApiError(404, "unknown_conflict", `no conflict ${conflict_id} on this calendar now (events may have moved)`);
    if (!opts.all && Date.parse(view.overlap.start) < this.m.clock) throw new ApiError(409, "in_the_past", `this conflict is before the demo clock; use the contrast view`);
    const conflict: Conflict = { conflict_id: view.conflict_id, a: view.a, b: view.b, overlap: view.overlap };
    const events = await sb.calendar.all();
    const seats = sb.ledger.seatsView(this.m.knownAt());
    const plan = planConflict(conflict, { events, seats });
    const { guard } = this.m.guardFor();
    const explanation = await explainPlan(plan, lookupsFor(plan, seats), { guard, session_id: sb.session_id, action_id, cache: sb.cache });
    sb.trace.write({ session_id: sb.session_id, action: "plan", ref: plan.plan_id, outcome: plan.status, details: { action_id, conflict_id, steps: plan.steps.map((s) => s.kind), explanation_mode: explanation.mode } });
    const stored: StoredPlan = { plan, explanation, created_at: chicagoIso(this.m.chatNow()) };
    sb.plans.set(plan.plan_id, stored);
    return stored;
  }

  async approve(sb: JudgeSandbox, plan_id: string, action_id: string): Promise<ExecutionResult> {
    const stored = sb.plans.get(plan_id);
    if (!stored) throw new ApiError(404, "unknown_plan", `no plan ${plan_id} in this sandbox; plan the conflict first`);
    sb.trace.write({ session_id: sb.session_id, action: "ui.approve", ref: action_id, outcome: "approved", details: { plan_id } });
    const result = await executePlan(stored.plan, { approved: true, session_id: sb.session_id, calendar: sb.calendar, seats: sb.ledger.seatsView(this.m.knownAt()), outbox: sb.outbox, trace: sb.trace, store: sb.actions });
    stored.result = result;
    return result;
  }

  async undo(sb: JudgeSandbox, token: string, action_id: string): Promise<UndoResult> {
    sb.trace.write({ session_id: sb.session_id, action: "ui.undo", ref: action_id, outcome: "requested", details: { token } });
    const r = await undo(token, { calendar: sb.calendar, store: sb.actions, trace: sb.trace, session_id: sb.session_id });
    for (const p of sb.plans.values()) if (p.result?.undo_token === token) p.undo = r;
    return r;
  }

  // D7: the T10 contrast — the two Monday focus-block conflicts (10/26, before the clock; 11/2, before the
  // clock too) planned side by side, reachable although the main list shows only conflicts at or after the clock.
  async contrast(sb: JudgeSandbox, action_id: string): Promise<{ pairs: StoredPlan[] }> {
    const all = await this.conflicts(sb, { all: true });
    const focus = all.filter((c) => /Monday focus block/.test(c.a.title) || /Monday focus block/.test(c.b.title));
    const pairs: StoredPlan[] = [];
    for (const c of focus) pairs.push(await this.plan(sb, c.conflict_id, action_id, { all: true }));
    return { pairs };
  }
}
