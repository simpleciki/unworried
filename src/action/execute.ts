// Executes an approved plan: re-check the seats → run steps in order → read back after every write →
// roll back in reverse on any failure. Drafts go to the outbox only; nothing is ever sent. The same
// plan_id executed twice returns the stored first result and writes nothing.
import { randomUUID } from "node:crypto";
import type { CalEvent, CalendarPort } from "../calendar/port.ts";
import { instant } from "../calendar/port.ts";
import type { Outbox } from "../outbox/drafts.ts";
import type { ActionPlan, PlanStep } from "./plan.ts";
import type { SeatsView } from "./seats-view.ts";
import type { Trace } from "./trace.ts";

export type StepOutcome = "done" | "drafted" | "failed" | "reverted" | "skipped";

export type ExecutionResult = {
  plan_id: string;
  status: "executed" | "drafted" | "refused" | "rolled_back" | "needs_attention";
  reason?: string;
  steps: { index: number; outcome: StepOutcome; readback?: Partial<CalEvent>; error?: string; draft_id?: string }[];
  undo_token?: string; // only when executed
};

export type UndoRecord = {
  token: string;
  plan_id: string;
  session_id: string;
  writes: { event_id: string; before: Partial<CalEvent>; written_version: string }[];
};

// Per-process memory of results and undo tokens. The caller keeps one per session.
export class ActionStore {
  readonly results = new Map<string, ExecutionResult>();
  readonly undo = new Map<string, UndoRecord>();
}

export type ExecuteDeps = {
  approved: boolean; // the user's approval, as a caller flag (no UI in this task)
  session_id: string;
  calendar: CalendarPort;
  seats: SeatsView; // built from the CURRENT seat graph, so changed arrangements are noticed
  outbox: Outbox;
  trace: Trace;
  store: ActionStore;
  timeoutMs?: number; // calendar ops, default 2 s
  newToken?: () => string;
};

export const CALENDAR_TIMEOUT_MS = 2_000;

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Every field of `expected` must equal the read-back event (instants for start/end).
export function matches(actual: CalEvent | null, expected: Partial<CalEvent>): string | null {
  if (!actual) return "event not found on read-back";
  for (const [k, v] of Object.entries(expected)) {
    if (k === "version") continue;
    const got = (actual as unknown as Record<string, unknown>)[k];
    if ((k === "start" || k === "end") && typeof v === "string" && typeof got === "string") {
      if (instant(got) !== instant(v)) return `${k} is ${got}, expected ${v}`;
      continue;
    }
    if (JSON.stringify(got) !== JSON.stringify(v)) return `${k} is ${JSON.stringify(got)}, expected ${JSON.stringify(v)}`;
  }
  return null;
}

const strip = (p: Partial<CalEvent>): Partial<CalEvent> => {
  const { version: _v, event_id: _id, ...rest } = p;
  return rest;
};

export async function executePlan(plan: ActionPlan, deps: ExecuteDeps): Promise<ExecutionResult> {
  const ms = deps.timeoutMs ?? CALENDAR_TIMEOUT_MS;
  const t = (action: string, outcome: string, extra: Partial<{ ref: string; step: number; details: Record<string, unknown> }> = {}) => deps.trace.write({ session_id: deps.session_id, action, outcome, ref: plan.plan_id, ...extra });
  const finish = (r: ExecutionResult, remember = true) => {
    if (remember) deps.store.results.set(plan.plan_id, r);
    t("execute.result", r.status, { details: { reason: r.reason, undo_token: r.undo_token, steps: r.steps.map((s) => s.outcome) } });
    return r;
  };

  const stored = deps.store.results.get(plan.plan_id);
  if (stored) {
    t("execute.start", "replay", { details: { note: "same plan_id already executed; returning the stored result, writing nothing" } });
    return stored;
  }
  t("execute.start", plan.status, { details: { approved: deps.approved, steps: plan.steps.length } });
  if (!deps.approved) return finish({ plan_id: plan.plan_id, status: "refused", reason: "not approved by the user", steps: [] }, false);
  if (plan.status !== "ready") return finish({ plan_id: plan.plan_id, status: "refused", reason: `the plan itself is refused: ${plan.refusal?.reason ?? plan.explanation}`, steps: [] });

  // 1. The arrangements must be the ones the plan was made from.
  const at = instant(plan.at);
  const changed: string[] = [];
  for (const sv of plan.seat_versions) {
    const [key, was] = sv.split("=");
    const now = deps.seats.resolveKey(key, at);
    const current = now.state === "PASS" ? (now.card_id ?? "-") : `${now.state}:${now.card_id ?? "-"}`;
    if (current !== was) changed.push(`${key}: was ${was}, now ${current}`);
  }
  if (changed.length) {
    t("execute.seats", "changed", { details: { changed } });
    return finish({ plan_id: plan.plan_id, status: "refused", reason: `your arrangements changed after this plan was made: ${changed.join("; ")}`, steps: [] });
  }
  t("execute.seats", "unchanged", { details: { seat_versions: plan.seat_versions } });

  // 2. Steps in order, read back after every write.
  const result: ExecutionResult = { plan_id: plan.plan_id, status: "executed", steps: [] };
  const writes: UndoRecord["writes"] = [];
  let failedAt = -1;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    try {
      if (step.kind === "reschedule_own") {
        if (!step.after) throw new Error("reschedule_own step has no `after`");
        if (!step.before.version) throw new Error("reschedule_own step has no expected version");
        const written = await withTimeout(deps.calendar.update(step.target_event_id, strip(step.after), step.before.version), ms, `update ${step.target_event_id}`);
        const back = await withTimeout(deps.calendar.get(step.target_event_id), ms, `read back ${step.target_event_id}`);
        const mismatch = matches(back, step.after);
        if (mismatch) throw new Error(`read-back differs: ${mismatch}`);
        writes.push({ event_id: step.target_event_id, before: strip(step.before), written_version: written.version });
        result.steps.push({ index: i, outcome: "done", readback: { version: back!.version, start: back!.start, end: back!.end } });
        t("execute.step", "done", { step: i, ref: step.target_event_id, details: { kind: step.kind, after: step.after, version: written.version } });
      } else if (step.kind === "draft_message" || step.kind === "draft_handoff") {
        if (!step.draft) throw new Error(`${step.kind} step has no draft`);
        const d = deps.outbox.add({ plan_id: plan.plan_id, kind: step.kind === "draft_message" ? "message" : "handoff", ...step.draft });
        result.steps.push({ index: i, outcome: "drafted", draft_id: d.draft_id });
        t("draft", "drafted", { step: i, ref: d.draft_id, details: { kind: step.kind, to: d.to, subject: d.subject } });
      } else {
        throw new Error(`unknown step kind ${(step as PlanStep).kind}`);
      }
    } catch (e) {
      result.steps.push({ index: i, outcome: "failed", error: (e as Error).message });
      t("execute.step", "failed", { step: i, ref: step.target_event_id, details: { kind: step.kind, error: (e as Error).message } });
      failedAt = i;
      break;
    }
  }

  // 3. Any failure → revert completed writes in reverse order, reading back each revert.
  if (failedAt >= 0) {
    result.status = "rolled_back";
    result.reason = `step ${failedAt} failed: ${result.steps[failedAt].error}`;
    for (const w of [...writes].reverse()) {
      const idx = result.steps.findIndex((s) => s.outcome === "done" && plan.steps[s.index].target_event_id === w.event_id);
      try {
        const current = await withTimeout(deps.calendar.get(w.event_id), ms, `read ${w.event_id}`);
        if (!current) throw new Error("event not found");
        await withTimeout(deps.calendar.update(w.event_id, w.before, current.version), ms, `revert ${w.event_id}`);
        const back = await withTimeout(deps.calendar.get(w.event_id), ms, `read back ${w.event_id}`);
        const mismatch = matches(back, w.before);
        if (mismatch) throw new Error(`read-back after revert differs: ${mismatch}`);
        result.steps[idx] = { ...result.steps[idx], outcome: "reverted", readback: { version: back!.version, start: back!.start, end: back!.end } };
        t("execute.revert", "reverted", { step: idx, ref: w.event_id });
      } catch (e) {
        result.status = "needs_attention";
        const current = await deps.calendar.get(w.event_id).catch(() => null);
        result.steps[idx] = { ...result.steps[idx], error: `revert failed: ${(e as Error).message}`, readback: current ? { version: current.version, start: current.start, end: current.end } : undefined };
        t("execute.revert", "failed", { step: idx, ref: w.event_id, details: { error: (e as Error).message } });
      }
    }
    if (result.status === "needs_attention") result.reason = `${result.reason}; and a revert failed — check the touched events by hand`;
    return finish(result);
  }

  // 4. All steps done.
  if (writes.length) {
    const token = (deps.newToken ?? (() => randomUUID()))();
    deps.store.undo.set(token, { token, plan_id: plan.plan_id, session_id: deps.session_id, writes });
    result.undo_token = token;
    result.status = "executed";
  } else {
    result.status = "drafted";
  }
  return finish(result);
}
