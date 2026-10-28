// The outbox holds drafts. Nothing is ever sent: there is no mail or SMS integration and no send
// method. A draft is text the user may copy; its status is always "draft". The user may record the
// answer they got back (they sent it; nothing here reads their messages): one reply per draft.
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
  reply?: DraftReply;
};

export type DraftReply = {
  answer: "yes" | "no";
  recorded_at: string; // when the user recorded it, ISO 8601 with Chicago offset
  undo_token?: string; // a "yes" that changed the calendar can be undone with this
  readback?: { event_id: string; version: string; covered_by?: string };
  undone?: boolean;
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

  get(draft_id: string): Draft | undefined {
    const d = this.drafts.find((x) => x.draft_id === draft_id);
    return d ? { ...d, to: [...d.to] } : undefined;
  }

  // Throws if the draft is unknown or already has a reply.
  recordReply(draft_id: string, reply: Omit<DraftReply, "recorded_at">): DraftReply {
    const d = this.drafts.find((x) => x.draft_id === draft_id);
    if (!d) throw new Error(`no draft ${draft_id}`);
    if (d.reply) throw new Error(`draft ${draft_id} already has a reply (${d.reply.answer})`);
    d.reply = { ...reply, recorded_at: chicagoIso(this.now()) };
    if (this.path) appendFileSync(this.path, JSON.stringify({ reply_to: draft_id, ...d.reply }) + "\n");
    return { ...d.reply };
  }

  markUndone(undo_token: string): void {
    const d = this.drafts.find((x) => x.reply?.undo_token === undo_token);
    if (d?.reply) d.reply.undone = true;
  }

  list(): Draft[] {
    return this.drafts.map((d) => ({ ...d, to: [...d.to], ...(d.reply ? { reply: { ...d.reply } } : {}) }));
  }
}
