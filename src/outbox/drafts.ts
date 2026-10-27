// The outbox holds drafts. Nothing is ever sent: there is no mail or SMS integration and no send
// method. A draft is text the user may copy; its status is always "draft".
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { chicagoIso } from "../calendar/port.ts";

export type DraftKind = "message" | "handoff";

export type Draft = {
  draft_id: string;
  plan_id: string;
  kind: DraftKind;
  to: string[];
  subject: string;
  body: string;
  created_at: string; // ISO 8601, America/Chicago offset
  status: "draft"; // the only status there is
};

export class Outbox {
  private readonly drafts: Draft[] = [];
  private readonly path?: string;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: { path?: string; now?: () => number; newId?: () => string } = {}) {
    this.path = opts.path;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => randomUUID());
    if (this.path) mkdirSync(dirname(this.path), { recursive: true });
  }

  add(input: { plan_id: string; kind: DraftKind; to: string[]; subject: string; body: string }): Draft {
    if (!input.to.length) throw new Error("a draft needs at least one recipient");
    const d: Draft = { draft_id: this.newId(), ...input, to: [...input.to], created_at: chicagoIso(this.now()), status: "draft" };
    this.drafts.push(d);
    if (this.path) appendFileSync(this.path, JSON.stringify(d) + "\n");
    return d;
  }

  list(): Draft[] {
    return this.drafts.map((d) => ({ ...d, to: [...d.to] }));
  }
}
