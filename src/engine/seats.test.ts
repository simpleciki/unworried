import { describe, expect, it } from "vitest";
import { SeatGraph } from "./seats.ts";
import { at, card, rec, replaces, vocab } from "./fixtures.test-helpers.ts";

const labor = (scope = "client:c1") => ({ topic: "price", facet: "price.labor", scope });
const material = (scope = "client:c1") => ({ topic: "price", facet: "price.material", scope });

describe("seat graph", () => {
  it("partial replacement: labor takes the new rate, material keeps the old one", () => {
    const r1 = rec("Labor $90/h, material as listed.", "2026-03-01T09:00:00-06:00");
    const r2 = rec("Labor is $98/h from now. Leave material as approved.", "2026-04-08T09:00:00-05:00");
    const oldLabor = card("labor.old", r1, { quote: "Labor $90/h" });
    const oldMat = card("mat.old", r1, { quote: "material as listed", facets: ["price.material"] });
    const newLabor = card("labor.new", r2, { quote: "Labor is $98/h from now" });
    const g = new SeatGraph([oldLabor, oldMat, newLabor], [replaces("labor.old", "labor.new")], [r1, r2], vocab);
    expect(g.current(labor())).toBe("labor.new");
    expect(g.current(material())).toBe("mat.old");
  });

  it("revert: A -> B -> A' ends on A'", () => {
    const rs = ["A", "B", "A again"].map((t, i) => rec(t, `2026-03-0${i + 2}T09:00:00-06:00`));
    const cards = [card("A", rs[0]), card("B", rs[1]), card("A2", rs[2])];
    const g = new SeatGraph(cards, [replaces("A", "B"), replaces("B", "A2")], rs, vocab);
    const r = g.resolve(labor());
    expect(r.current_card).toBe("A2");
    expect(r.chain).toEqual(["A2", "B", "A"]);
    expect(r.state).toBe("PASS");
  });

  it("two facets of the same message coexist without conflict", () => {
    const r1 = rec("Labor $90/h and material at list.", "2026-03-02T09:00:00-06:00");
    const g = new SeatGraph(
      [card("l", r1, { quote: "Labor $90/h" }), card("m", r1, { quote: "material at list", facets: ["price.material"] })],
      [],
      [r1],
      vocab,
    );
    expect(g.resolve(labor()).state).toBe("PASS");
    expect(g.resolve(material()).state).toBe("PASS");
    expect(g.links).toHaveLength(0);
  });

  it("decided but not yet in effect: answers the old value and names the scheduled change", () => {
    const r1 = rec("Labor $88/h.", "2026-03-02T09:00:00-06:00");
    const r2 = rec("From 1 June labor is $96/h.", "2026-05-12T10:15:00-05:00");
    const g = new SeatGraph(
      [card("old", r1), card("new", r2, { effective: "2026-06-01T00:00:00-05:00" })],
      [replaces("old", "new")],
      [r1, r2],
      vocab,
    );
    const may20 = g.resolve(labor(), at("2026-05-20T09:00:00-05:00"));
    expect(may20.current_card).toBe("new");
    expect(may20.in_effect_card).toBe("old");
    expect(may20.scheduled).toBe("new");
    const june2 = g.resolve(labor(), at("2026-06-02T09:00:00-05:00"));
    expect(june2.in_effect_card).toBe("new");
    expect(june2.scheduled).toBeNull();
  });

  it("a late record is ordered by decided_at, not by when it was written", () => {
    const r1 = rec("Approved v1.", "2026-04-21T10:30:00-05:00");
    const note = rec("Writing this late: approved on the 22nd call.", "2026-04-27T08:40:00-05:00", "p.office");
    const late = card("late", note, { topic: "approval", facets: ["approval.status"], scope: "job:j1", decided_at: "2026-04-22T14:10:00-05:00", effective: "2026-04-22T14:10:00-05:00" });
    const g = new SeatGraph([late], [], [r1, note], vocab);
    const seat = { topic: "approval", facet: "approval.status", scope: "job:j1" };
    expect(g.current(seat, at("2026-04-24T09:00:00-05:00"))).toBe("late");
    // As recorded on the 24th, the note did not exist yet.
    expect(g.asRecorded(seat, at("2026-04-24T09:00:00-05:00")).current_card).toBeNull();
  });

  it("a replacement that predates what it replaces is an unresolved conflict", () => {
    const r1 = rec("New rule.", "2026-03-01T09:00:00-06:00");
    const r2 = rec("Old rule.", "2026-03-05T09:00:00-06:00");
    const g = new SeatGraph([card("old", r2), card("new", r1)], [replaces("old", "new")], [r1, r2], vocab);
    expect(g.resolve(labor()).state).toBe("UNRESOLVED_CONFLICT");
  });

  it("overlapping times need an explicit reference; incomparable times conflict", () => {
    const r1 = rec("Cap $2500 for Q-X-01.", "2026-03-10T08:00:00-05:00");
    const r2 = rec("Cap lifted (was set on Q-X-01).", "2026-03-20T08:00:00-05:00");
    r1.row_key = "Q-X-01";
    const withRef = new SeatGraph(
      [card("a", r1, { decided_at: "2026-03" }), card("b", r2, { decided_at: "2026-03-20" })],
      [replaces("a", "b")],
      [r1, r2],
      vocab,
    );
    expect(withRef.links[0].status).toBe("ok");
    const noTime = new SeatGraph([card("a", r1, { decided_at: "unknown" }), card("b", r2)], [replaces("a", "b")], [r1, r2], vocab);
    expect(noTime.links[0].status).toBe("conflict");
  });

  it("rejecting a later version does not take the in-effect slot from the approval of an earlier one", () => {
    const r1 = rec("Approved v1.", "2026-03-31T08:55:00-05:00");
    const r2 = rec("Rejected. I cannot tell what is live.", "2026-04-27T15:30:00-05:00");
    const seatOf = { topic: "approval", facets: ["approval.status"], scope: "job:j1" };
    const g = new SeatGraph([card("ok", r1, seatOf), card("no", r2, { ...seatOf, mode: "gives_reason" })], [], [r1, r2], vocab);
    const r = g.resolve({ topic: "approval", facet: "approval.status", scope: "job:j1" }, at("2026-05-01T09:00:00-05:00"));
    expect(r.current_card).toBe("no"); // the latest thing that happened on the seat
    expect(r.in_effect_card).toBe("ok"); // what still stands
    expect(r.coexisting).toEqual(["ok"]);
  });

  it("for decisions made at the same moment, in-effect is the one already in force", () => {
    const r1 = rec("Keep the four-line shape.", "2026-03-06T16:40:00-06:00");
    const r2 = rec("From 1 June you may send a lump sum. Until then keep the four-line shape.", "2026-05-15T10:00:00-05:00");
    const s = { topic: "scope", facets: ["scope.structure"] };
    const g = new SeatGraph(
      [
        card("old", r1, s),
        card("until", r2, { ...s, quote: "Until then keep the four-line shape" }),
        card("new", r2, { ...s, quote: "From 1 June you may send a lump sum", effective: "2026-06-01T00:00:00-05:00" }),
      ],
      [replaces("old", "new")],
      [r1, r2],
      vocab,
    );
    const r = g.resolve({ topic: "scope", facet: "scope.structure", scope: "client:c1" }, at("2026-05-20T12:00:00-05:00"));
    expect(r.current_card).toBe("new");
    expect(r.in_effect_card).toBe("until");
    expect(r.scheduled).toBe("new");
  });

  it("a newer client-wide decision outranks an older job-level one on the same facet", () => {
    const r1 = rec("Fix the routing before I read the numbers.", "2026-04-09T15:40:00-05:00");
    const r2 = rec("You may CC Tomas from 20 May.", "2026-05-20T09:30:00-05:00");
    const s = { topic: "client_rule", facets: ["client_rule.cap"] };
    const g = new SeatGraph([card("job", r1, { ...s, scope: "job:j1" }), card("client", r2, s)], [], [r1, r2], vocab);
    const seat = { topic: "client_rule", facet: "client_rule.cap", scope: "job:j1" };
    expect(g.resolve(seat, at("2026-05-22T10:00:00-05:00")).current_card).toBe("client");
    expect(g.resolve(seat, at("2026-05-01T10:00:00-05:00")).current_card).toBe("job");
  });

  it("falls back from an empty job seat to the client seat and says so", () => {
    const r1 = rec("Labor $90/h.", "2026-03-02T09:00:00-06:00");
    const g = new SeatGraph([card("l", r1)], [], [r1], vocab);
    const r = g.resolve(labor("job:j1"));
    expect(r.current_card).toBe("l");
    expect(r.scope_fallback).toBe(true);
    expect(r.scope_used).toBe("client:c1");
  });
});
