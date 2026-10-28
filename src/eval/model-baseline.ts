// The core-claim eval with a real model as the baseline: the same 13 scenarios, the notes handed to NVIDIA Nemotron
// as plain text (what was said, and when; "unknown" for a note with no date), and the question a parent would ask.
// No ledger, no confirmed links: the model reads the notes the way a person would. It is told the product's own
// rule — if the notes do not say who the backup is that day, ask instead of guessing — so asking is open to it.
// Run only by the author (scripts/eval-model-baseline.ts, real calls); this module builds prompts and reads replies.
import { extractJson, obj, str } from "../llm/json.ts";
import type { Answer, Scenario } from "./core-claim.ts";

export const TODAY = "Tuesday, November 3, 2026, 09:00 (Chicago time)";

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
// "2026-10-03T21:10:00-05:00" → "2026-10-03 21:10" (the local wall time the note carries).
const saidAt = (said: string) => (said === "unknown" ? "unknown — no date on this note" : `${said.slice(0, 10)} ${said.slice(11, 16)}`);

export const SYSTEM = "You are a careful family assistant. You keep a parent's notes about who backs up whom for school pickups, and you help them act on those notes. Reply with JSON only.";

export function modelPrompt(s: Scenario): { system: string; user: string } {
  const notes = s.notes.map((n) => `- [said ${saidAt(n.said)}] "${n.text}"`).join("\n");
  const user = [
    `Today is ${TODAY}.`,
    "",
    "My notes, in the order I wrote them down:",
    notes,
    "",
    `On ${longDate(s.pickup)}, my flight home (15:45–19:30) collides with Theo's pickup at 17:30, so I can't do the pickup.`,
    "Who should I ask to cover it? If my notes don't let you tell who the backup is on that day, ask me instead of guessing.",
    "",
    'Reply with exactly one of: {"ask": "<the person\'s name>"} or {"ask_me": "<one sentence: what you need me to settle>"}.',
  ].join("\n");
  return { system: SYSTEM, user };
}

// A reply that is neither shape counts as wrong (and is reported as unreadable), never as a refusal.
export function readModelAnswer(text: string): { answer: Answer | null; note: string } {
  let v: Record<string, unknown>;
  try {
    v = obj(extractJson(text), "reply");
  } catch (e) {
    return { answer: null, note: `unreadable: ${(e as Error).message}` };
  }
  if ("ask" in v && !("ask_me" in v)) {
    try {
      return { answer: { ask: str(v.ask, "ask").trim() }, note: "" };
    } catch (e) {
      return { answer: null, note: `unreadable: ${(e as Error).message}` };
    }
  }
  if ("ask_me" in v && !("ask" in v)) return { answer: { refuse: true }, note: typeof v.ask_me === "string" ? v.ask_me : "" };
  return { answer: null, note: "unreadable: neither {ask} nor {ask_me}" };
}
