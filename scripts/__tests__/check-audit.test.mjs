import { describe, it, expect } from "vitest";
import { collectAdvisories, evaluate } from "../check-audit.mjs";

const advisory = (id, name, severity) => ({
  source: 1,
  name,
  title: `${name} problem`,
  url: `https://github.com/advisories/${id}`,
  severity,
});

// The shape npm 11 emits: advisory objects where they live, package names upstream of them.
const report = {
  vulnerabilities: {
    braces: { severity: "high", via: [advisory("GHSA-aaaa", "braces", "high")] },
    micromatch: { severity: "high", via: ["braces"] },
    hono: { severity: "moderate", via: [advisory("GHSA-bbbb", "hono", "moderate")] },
    "proxy-addr": { severity: "critical", via: [advisory("GHSA-cccc", "proxy-addr", "critical")] },
  },
};

const allow = (id, review_by) => ({ id, package: "x", reason: "test", added: "2026-10-01", review_by });

describe("check-audit", () => {
  it("collects each advisory once, from where it lives", () => {
    const ids = collectAdvisories(report).map((a) => a.id).sort();
    expect(ids).toEqual(["GHSA-aaaa", "GHSA-bbbb", "GHSA-cccc"]);
  });

  it("blocks high and critical advisories that are not allowlisted", () => {
    const r = evaluate(report, [], "2026-10-12");
    expect(r.blocking.map((a) => a.id).sort()).toEqual(["GHSA-aaaa", "GHSA-cccc"]);
    expect(r.reportedOnly.map((a) => a.id)).toEqual(["GHSA-bbbb"]);
  });

  it("lets an allowlisted advisory through until its review date, inclusive", () => {
    const r = evaluate(report, [allow("GHSA-aaaa", "2026-10-12")], "2026-10-12");
    expect(r.allowed.map((a) => a.id)).toEqual(["GHSA-aaaa"]);
    expect(r.blocking.map((a) => a.id)).toEqual(["GHSA-cccc"]);
    expect(r.expired).toEqual([]);
  });

  it("fails an allowlist entry past its review date, and stops honouring it", () => {
    const r = evaluate(report, [allow("GHSA-aaaa", "2026-10-11")], "2026-10-12");
    expect(r.expired.map((e) => e.id)).toEqual(["GHSA-aaaa"]);
    expect(r.blocking.map((a) => a.id)).toContain("GHSA-aaaa");
  });

  it("reports an allowlist entry that no longer matches anything", () => {
    const r = evaluate(report, [allow("GHSA-zzzz", "2026-12-31")], "2026-10-12");
    expect(r.unused.map((e) => e.id)).toEqual(["GHSA-zzzz"]);
  });

  it("passes an empty report", () => {
    const r = evaluate({ vulnerabilities: {} }, [], "2026-10-12");
    expect(r.blocking).toEqual([]);
    expect(r.expired).toEqual([]);
  });
});
