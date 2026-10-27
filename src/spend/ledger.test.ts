// S10 (DST day buckets) and the ledger's bookkeeping invariants.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpendLedger, chicagoDay, chicagoDayBounds, chicagoIso } from "./ledger.ts";

let dir: string;
let path: string;
let clock = Date.parse("2026-11-03T09:00:00-06:00");
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unworried-ledger-"));
  path = join(dir, "ledger.jsonl");
  clock = Date.parse("2026-11-03T09:00:00-06:00");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("S10 — a day bucket is one America/Chicago calendar day", () => {
  it("2026-11-01 is 25 hours long and every instant in it lands in the same bucket", () => {
    // Independent oracle: the two midnights written with the offsets in force at each.
    const start = Date.parse("2026-11-01T00:00:00-05:00");
    const end = Date.parse("2026-11-02T00:00:00-06:00");
    expect(end - start).toBe(25 * 60 * 60 * 1000);
    expect(chicagoDayBounds("2026-11-01")).toEqual({ start, end });
    expect(chicagoIso(start)).toBe("2026-11-01T00:00:00.000-05:00");
    expect(chicagoIso(end - 1)).toBe("2026-11-01T23:59:59.999-06:00");
    // The day DST starts is 23 hours; an ordinary day is 24.
    const h = (d: string) => (chicagoDayBounds(d).end - chicagoDayBounds(d).start) / 3_600_000;
    expect(h("2026-03-08")).toBe(23);
    expect(h("2026-11-03")).toBe(24);
    expect(h("2026-10-31")).toBe(24);
    for (const iso of ["2026-11-01T00:00:00-05:00", "2026-11-01T01:30:00-05:00", "2026-11-01T01:30:00-06:00", "2026-11-01T12:00:00-06:00", "2026-11-01T23:59:59.999-06:00"]) {
      expect(chicagoDay(Date.parse(iso))).toBe("2026-11-01");
    }
    // The two wall-clock "01:30" instants are an hour apart and both inside the day.
    expect(Date.parse("2026-11-01T01:30:00-06:00") - Date.parse("2026-11-01T01:30:00-05:00")).toBe(3_600_000);
    expect(chicagoDay(Date.parse("2026-10-31T23:59:59.999-05:00"))).toBe("2026-10-31");
    expect(chicagoDay(Date.parse("2026-11-02T00:00:00-06:00"))).toBe("2026-11-02");
    // UTC would split this day differently: 2026-11-01T22:00-06:00 is already 11-02 in UTC.
    expect(new Date("2026-11-01T22:00:00-06:00").toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(chicagoDay(Date.parse("2026-11-01T22:00:00-06:00"))).toBe("2026-11-01");
  });

  it("ledger totals by day follow the Chicago day across the DST change", () => {
    const ledger = SpendLedger.create(path, now);
    const book = (iso: string, id: string, usd: number) => {
      clock = Date.parse(iso);
      ledger.reserve({ call_id: id, session_id: "s", action_id: "a", call_kind: "k", model: "m", usd, input_tokens_bound: 1, max_tokens: 1, attempt: 1 });
      ledger.settle(id, { actualUsd: usd, booked: "usage", outcome: "ok" });
    };
    book("2026-10-31T23:30:00-05:00", "c1", 0.01);
    book("2026-11-01T01:30:00-05:00", "c2", 0.02); // before the fall-back
    book("2026-11-01T01:30:00-06:00", "c3", 0.03); // after the fall-back, same calendar day
    book("2026-11-01T23:30:00-06:00", "c4", 0.04);
    book("2026-11-02T00:30:00-06:00", "c5", 0.05);
    expect(ledger.totals().byDay).toEqual({ "2026-10-31": 0.01, "2026-11-01": 0.09, "2026-11-02": 0.05 });
    expect(ledger.committed({ day: "2026-11-01" })).toBe(0.09);
  });

  it("chicagoIso round-trips the instant and carries the offset in force", () => {
    for (const iso of ["2026-11-01T06:59:59.000Z", "2026-11-01T07:00:00.000Z", "2026-07-04T12:00:00.000Z"]) {
      const ms = Date.parse(iso);
      expect(Date.parse(chicagoIso(ms))).toBe(ms);
    }
    expect(chicagoIso(Date.parse("2026-11-01T06:59:59Z"))).toBe("2026-11-01T01:59:59.000-05:00");
    expect(chicagoIso(Date.parse("2026-11-01T07:00:00Z"))).toBe("2026-11-01T01:00:00.000-06:00");
  });
});

describe("ledger bookkeeping", () => {
  it("a settle refunds the difference, is attributed to the reserve's day, and survives a reopen", () => {
    const ledger = SpendLedger.create(path, now);
    clock = Date.parse("2026-11-03T23:59:59-06:00");
    ledger.reserve({ call_id: "c1", session_id: "s", action_id: "a", call_kind: "k", model: "m", usd: 0.001, input_tokens_bound: 1, max_tokens: 1, attempt: 1 });
    clock += 5_000; // settles after midnight
    ledger.settle("c1", { actualUsd: 0.0004, booked: "usage", outcome: "ok", usage: { input_tokens: 1, output_tokens: 2 } });
    expect(ledger.totals().byDay).toEqual({ "2026-11-03": 0.0004 });
    const reopened = SpendLedger.open(path, now);
    expect(reopened.totals()).toEqual(ledger.totals());
    expect(reopened.size).toBe(3);
    expect(reopened.last(1)[0]).toMatchObject({ kind: "settle", usd: -0.0006, actual_usd: 0.0004 });
  });

  it("unsettled reservations count in full; actualInWindow uses the reserve instant", () => {
    const ledger = SpendLedger.create(path, now);
    ledger.reserve({ call_id: "c1", session_id: "s", action_id: "a", call_kind: "k", model: "m", usd: 0.5, input_tokens_bound: 1, max_tokens: 1, attempt: 1 });
    expect(ledger.committed()).toBe(0.5);
    expect(ledger.actualInWindow(clock - 60_000, clock)).toBe(0.5);
    ledger.settle("c1", { actualUsd: 0.1, booked: "usage", outcome: "ok" });
    expect(ledger.committed()).toBe(0.1);
    expect(ledger.actualInWindow(clock - 60_000, clock)).toBe(0.1);
    expect(ledger.actualInWindow(clock + 1, clock + 60_000)).toBe(0);
  });

  it("refuses to be created over an existing file, to open an empty one, or to settle twice", () => {
    const ledger = SpendLedger.create(path, now);
    expect(() => SpendLedger.create(path, now)).toThrow(/already exists/);
    ledger.reserve({ call_id: "c1", session_id: "s", action_id: "a", call_kind: "k", model: "m", usd: 0.5, input_tokens_bound: 1, max_tokens: 1, attempt: 1 });
    ledger.settle("c1", { actualUsd: 0.1, booked: "usage", outcome: "ok" });
    expect(() => ledger.settle("c1", { actualUsd: 0.1, booked: "usage", outcome: "ok" })).toThrow(/already settled/);
    expect(() => ledger.settle("nope", { actualUsd: 0.1, booked: "usage", outcome: "ok" })).toThrow(/unknown call/);
    expect(() => SpendLedger.open(join(dir, "missing.jsonl"), now)).toThrow(/file is missing/);
  });
});
