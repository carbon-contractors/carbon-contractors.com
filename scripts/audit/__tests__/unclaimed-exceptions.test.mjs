import { describe, it, expect } from "vitest";
import { KNOWN_ORPHANS, splitAcknowledged } from "../unclaimed-exceptions.mjs";

// The exception exists so a dead test key cannot page forever. It must never be able to
// hide a REAL unclaimed task, so every way of widening it is pinned here: a different
// task, a different escrow (redeploy), and an entry past review_by must all stay live.

const ORPHAN = KNOWN_ORPHANS[0];
const day = (iso) => Math.floor(Date.parse(iso) / 1000);
const WITHIN = day("2026-10-20T00:00:00Z");
const AFTER = day("2026-11-14T00:00:00Z");

describe("splitAcknowledged", () => {
  it("acknowledges the listed task on the listed escrow, within review_by", () => {
    const rows = [{ taskId: ORPHAN.taskId }];
    const r = splitAcknowledged(rows, ORPHAN.escrow, WITHIN);
    expect(r.live).toEqual([]);
    expect(r.acknowledged).toHaveLength(1);
    expect(r.acknowledged[0].entry.ticket).toBe("CC-079");
  });

  it("matches case-insensitively on both escrow and task id", () => {
    const rows = [{ taskId: ORPHAN.taskId.toUpperCase().replace("0X", "0x") }];
    const r = splitAcknowledged(rows, ORPHAN.escrow.toLowerCase(), WITHIN);
    expect(r.acknowledged).toHaveLength(1);
  });

  it("keeps every other task live — a real worker's task is never hidden", () => {
    const other = { taskId: "0x" + "ab".repeat(32) };
    const r = splitAcknowledged([other, { taskId: ORPHAN.taskId }], ORPHAN.escrow, WITHIN);
    expect(r.live).toEqual([other]);
    expect(r.acknowledged).toHaveLength(1);
  });

  it("does not apply after a redeploy: same task id on a different escrow stays live", () => {
    const row = { taskId: ORPHAN.taskId };
    const r = splitAcknowledged([row], "0x" + "11".repeat(20), WITHIN);
    expect(r.live).toEqual([row]);
    expect(r.acknowledged).toEqual([]);
  });

  it("stops suppressing after review_by and says which entry lapsed", () => {
    const row = { taskId: ORPHAN.taskId };
    const r = splitAcknowledged([row], ORPHAN.escrow, AFTER);
    expect(r.live).toEqual([row]);
    expect(r.acknowledged).toEqual([]);
    expect(r.lapsed).toEqual([ORPHAN]);
  });

  it("still suppresses through the whole of the review_by day (UTC)", () => {
    const lastDay = day(`${ORPHAN.review_by}T23:00:00Z`);
    const r = splitAcknowledged([{ taskId: ORPHAN.taskId }], ORPHAN.escrow, lastDay);
    expect(r.acknowledged).toHaveLength(1);
  });

  it("treats an entry with an unparseable review_by as lapsed, never as permanent", () => {
    const bad = [{ ...ORPHAN, review_by: "someday" }];
    const r = splitAcknowledged([{ taskId: ORPHAN.taskId }], ORPHAN.escrow, WITHIN, bad);
    expect(r.acknowledged).toEqual([]);
    expect(r.live).toHaveLength(1);
  });

  it("every committed entry names a ticket, a reason and a review date", () => {
    for (const e of KNOWN_ORPHANS) {
      expect(e.ticket).toMatch(/^CC-\d+$/);
      expect(e.reason.length).toBeGreaterThan(30);
      expect(Date.parse(`${e.review_by}T00:00:00Z`)).not.toBeNaN();
    }
  });
});
