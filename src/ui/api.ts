// The JSON handlers, each bound to one judge's sandbox. Every button press is one request = one action_id
// for the spend wall and the trace. A refusal anywhere comes back as { error, reason } for the panel to show
// in red where the user clicked.
import { randomUUID } from "node:crypto";
import { detectConflicts } from "../action/detect.ts";
import type { Conflict } from "../action/detect.ts";
import { CALENDAR_TIMEOUT_MS, executePlan, matches, withTimeout } from "../action/execute.ts";
import type { ExecutionResult } from "../action/execute.ts";
import { planConflict } from "../action/plan.ts";
import type { ActionPlan } from "../action/plan.ts";
import type { Lookup, SeatsView } from "../action/seats-view.ts";
import { undo } from "../action/undo.ts";
import type { UndoResult } from "../action/undo.ts";
import type { CalEvent } from "../calendar/port.ts";
import { confirm, discard, readableCardId } from "../chat/confirm.ts";
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

// covered_by: one of the two events is covered by someone who said yes — handled, shown, not planned again.
export type ConflictView = { conflict_id: string; at: string; a: CalEvent; b: CalEvent; overlap: { start: string; end: string }; plan_id?: string; pair: string; covered_by?: string };

const pairOf = (a: CalEvent, b: CalEvent) => [a.event_id, b.event_id].sort().join("|");

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
  // Every card in the judge's ledger, so the screen can quote the card a plan used even when it is not in
  // force today (said today, in force from tomorrow), and strike through what it replaced.
  cards: Record<string, { quote: string; decided_at: string; decided_by: string; effective: string; replaces: string[] }>;
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

export function cardsView(store: { cards(): { card_id: string; quote: string; decided_at: string; decided_by: string; effective: string }[]; edges(): { old_card: string; new_card: string; relation: string }[] }): StateView["cards"] {
  const out: StateView["cards"] = {};
  for (const c of store.cards()) out[c.card_id] = { quote: c.quote, decided_at: c.decided_at, decided_by: c.decided_by, effective: c.effective, replaces: [] };
  for (const e of store.edges()) if (e.relation === "REPLACES" && out[e.new_card]) out[e.new_card].replaces.push(e.old_card);
  return out;
}

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
      .map((c) => {
        const pair = pairOf(c.a, c.b);
        const covered_by = c.a.covered_by ?? c.b.covered_by;
        const plan_id = [...sb.plans.values()].filter((p) => p.plan.conflict_id === c.conflict_id || p.pair === pair).at(-1)?.plan.plan_id; // the latest plan for it
        return { conflict_id: c.conflict_id, at: c.overlap.start, a: c.a, b: c.b, overlap: c.overlap, pair, ...(plan_id ? { plan_id } : {}), ...(covered_by ? { covered_by } : {}) };
      });
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
      cards: cardsView(sb.ledger),
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
      const card_id = edits.card_id ?? readableCardId(sb.ledger, { ...checked.card, decided_at: null });
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
    if (view.covered_by) throw new ApiError(409, "covered", `${view.covered_by} said yes and covers this one; undo that first to plan it again`);
    const conflict: Conflict = { conflict_id: view.conflict_id, a: view.a, b: view.b, overlap: view.overlap };
    const events = await sb.calendar.all();
    const seats = sb.ledger.seatsView(this.m.knownAt());
    const plan = planConflict(conflict, { events, seats });
    // Plan again with nothing changed → the same plan id: return it as stored (its approval and undo kept,
    // no second model call), moved to the end so it is this conflict's latest plan.
    const existing = sb.plans.get(plan.plan_id);
    if (existing) {
      sb.plans.delete(plan.plan_id);
      sb.plans.set(plan.plan_id, existing);
      return existing;
    }
    const { guard } = this.m.guardFor();
    const explanation = await explainPlan(plan, lookupsFor(plan, seats), { guard, session_id: sb.session_id, action_id, cache: sb.cache });
    sb.trace.write({ session_id: sb.session_id, action: "plan", ref: plan.plan_id, outcome: plan.status, details: { action_id, conflict_id, steps: plan.steps.map((s) => s.kind), explanation_mode: explanation.mode } });
    const stored: StoredPlan = { plan, explanation, created_at: chicagoIso(this.m.chatNow()), pair: view.pair };
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
    if (r.status === "restored") sb.outbox.markUndone(token);
    return r;
  }

  // The answer to a handoff the parent sent. They record it (nothing here reads their messages). "yes" →
  // the event is written as covered by that person, read back, and can be undone; the conflict is handled.
  // "no" → recorded, nothing on the calendar changes, the conflict still needs them.
  async reply(sb: JudgeSandbox, draft_id: string, answer: string, action_id: string) {
    if (answer !== "yes" && answer !== "no") throw new ApiError(400, "bad_answer", 'answer must be "yes" or "no"');
    const d = sb.outbox.get(draft_id);
    if (!d) throw new ApiError(404, "unknown_draft", `no draft ${draft_id} in this outbox`);
    if (d.kind !== "handoff") throw new ApiError(409, "not_a_handoff", "only a handoff asks someone to cover; record replies to it there");
    if (d.reply) throw new ApiError(409, "already_replied", `already recorded: ${d.to.join(", ")} said ${d.reply.answer}`);
    const step = sb.plans.get(d.plan_id)?.plan.steps.find((s) => s.kind === "draft_handoff");
    if (!step) throw new ApiError(409, "no_plan", `the plan behind this draft is gone (sandbox reset?)`);
    const who = d.to[0];
    const title = (await sb.calendar.get(step.target_event_id))?.title ?? step.target_event_id;
    sb.trace.write({ session_id: sb.session_id, action: "ui.reply", ref: action_id, outcome: answer, details: { draft_id, event_id: step.target_event_id, who } });
    if (answer === "no") {
      sb.outbox.recordReply(draft_id, { answer: "no" });
      sb.say({ message_id: `a-${randomUUID().slice(0, 8)}`, sent_at: chicagoIso(this.m.chatNow()), from: "assistant", text: `Noted: ${who} said no. "${title}" is still yours — nothing on your calendar changed. Tell me who else can cover, then plan again.` });
      return { status: "declined" as const, event_id: step.target_event_id };
    }
    const ms = CALENDAR_TIMEOUT_MS;
    const current = await withTimeout(sb.calendar.get(step.target_event_id), ms, `read ${step.target_event_id}`);
    if (!current) throw new ApiError(409, "event_gone", `event ${step.target_event_id} is not on the calendar`);
    if (current.covered_by) throw new ApiError(409, "covered", `${current.covered_by} already covers this one`);
    const written = await withTimeout(sb.calendar.update(current.event_id, { covered_by: who }, current.version), ms, `update ${current.event_id}`);
    const back = await withTimeout(sb.calendar.get(current.event_id), ms, `read back ${current.event_id}`);
    const mismatch = matches(back, { covered_by: who });
    if (mismatch) {
      await sb.calendar.update(current.event_id, { covered_by: undefined }, written.version).catch(() => undefined);
      sb.trace.write({ session_id: sb.session_id, action: "reply.write", ref: current.event_id, outcome: "failed", details: { mismatch } });
      throw new ApiError(500, "readback_failed", `the calendar did not keep it: ${mismatch}; nothing recorded`);
    }
    const token = randomUUID();
    sb.actions.undo.set(token, { token, plan_id: d.plan_id, session_id: sb.session_id, writes: [{ event_id: current.event_id, before: { covered_by: undefined }, written_version: written.version }] });
    const readback = { event_id: back!.event_id, version: back!.version, covered_by: back!.covered_by };
    sb.outbox.recordReply(draft_id, { answer: "yes", undo_token: token, readback });
    sb.trace.write({ session_id: sb.session_id, action: "reply.write", ref: current.event_id, outcome: "covered", details: { who, version: back!.version } });
    sb.say({ message_id: `a-${randomUUID().slice(0, 8)}`, sent_at: chicagoIso(this.m.chatNow()), from: "assistant", text: `✓ ${who} said yes. "${title}" is covered by ${who} — calendar read back ${back!.version}. You can undo it.` });
    return { status: "covered" as const, event_id: current.event_id, readback, undo_token: token };
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
