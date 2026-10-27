// JSONL trace of every step the action layer takes. This task uses no model and spends no money, but
// the shape keeps `model` and `usd` so a later task can log a guarded model call on the same line.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chicagoIso } from "../calendar/port.ts";

export type TraceEvent = {
  at: string; // ISO 8601, America/Chicago offset
  session_id: string;
  action: string; // detect | plan | execute.start | execute.step | execute.revert | execute.result | draft | undo
  ref?: string; // conflict_id, plan_id, event_id or undo token the line is about
  step?: number;
  outcome: string;
  details?: Record<string, unknown>;
  model: null | { model: string; call_id: string }; // null in this task: no model is called
  usd: null | number; // null in this task: nothing is spent
};

export type TraceInput = Omit<TraceEvent, "at" | "model" | "usd"> & Partial<Pick<TraceEvent, "model" | "usd">>;

export interface Trace {
  write(e: TraceInput): TraceEvent;
}

export class MemoryTrace implements Trace {
  readonly events: TraceEvent[] = [];
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  write(e: TraceInput): TraceEvent {
    const full: TraceEvent = { at: chicagoIso(this.now()), model: null, usd: null, ...e };
    this.events.push(full);
    return full;
  }
}

export class JsonlTrace implements Trace {
  readonly path: string;
  private readonly now: () => number;
  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
    mkdirSync(dirname(path), { recursive: true });
  }
  write(e: TraceInput): TraceEvent {
    const full: TraceEvent = { at: chicagoIso(this.now()), model: null, usd: null, ...e };
    appendFileSync(this.path, JSON.stringify(full) + "\n");
    return full;
  }
}
