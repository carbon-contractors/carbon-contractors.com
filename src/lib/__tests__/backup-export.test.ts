import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * backup-export.test.ts (CC-107) — the engine behind /api/cron/backup-export.
 *
 * What this file pins is not "it copies rows" — that would need a live
 * database and a live bucket. It pins the properties that make the export
 * trustworthy as a backup and safe under D8:
 *
 *   1. The privacy boundary is enforced, not assumed: adding a forbidden
 *      column or table to the spec throws at startup.
 *   2. The manifest records what is deliberately absent, so nobody has to
 *      re-derive the exclusions from the ADR years later.
 *   3. Verification is real: the sha256 compared is of the bytes R2 returned,
 *      not of the bytes we meant to send.
 *   4. A failing table does not sink the run, and `ok` is false when anything
 *      failed or went unverified — the heartbeat polarity depends on it.
 *
 * Supabase, R2 and config are mocked at the boundary (CC-060 shape): nothing
 * here can reach the network.
 */

// ── Mocks at the boundary ────────────────────────────────────────────────────

// A mutable config the individual tests can shape, retention-route-test style.
let mockConfig: Record<string, string | undefined> = {
  SUPABASE_URL: "https://db.abc123def456ghi789jk.supabase.co",
  R2_ACCOUNT_ID: "acct123",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  BACKUP_R2_BUCKET: "bucket",
};
vi.mock("@/lib/config", () => ({ getConfig: () => mockConfig }));

// PostgrestBuilder-style chainable query mock. limit() is the terminal call
// in the engine, so it resolves the {data,error} pair; each page of each
// table consumes one mockImplementationOnce.
const mockLimit = vi.fn();
vi.mock("@/lib/db/client", () => {
  const chain = {
    select: () => chain,
    order: () => chain,
    limit: (...a: unknown[]) => mockLimit(...a),
    gt: () => chain,
  };
  return { getSupabaseAdmin: () => ({ from: () => chain }) };
});

// A faithful bucket by default: GET returns the exact bytes of the most
// recent PUT for that key. Tests override with mockImplementationOnce to
// corrupt individual read-backs.
const mockPutObject = vi.fn();
const mockGetObject = vi.fn(async (_c: unknown, bucket: string, key: string) => {
  const call = mockPutObject.mock.calls.find(
    (c) => (c[1] as string) === bucket && (c[2] as string) === key,
  );
  if (!call) throw new Error(`no PUT for ${key}`);
  return call[3] as Buffer;
});
vi.mock("@/lib/r2", () => ({
  putObject: (...a: unknown[]) => mockPutObject(...(a as [unknown, string, string, Buffer, string])),
  getObject: (...a: unknown[]) => mockGetObject(...(a as [unknown, string, string])),
}));

const mockLog = vi.fn();
vi.mock("@/lib/logging", () => ({ log: (...a: unknown[]) => mockLog(...a) }));

import {
  assertSpecCompliance,
  buildNdjson,
  buildManifest,
  exportTier1ToR2,
  TIER1_TABLES,
  FORBIDDEN_COLUMNS,
  EXPORT_RULE_VERSION,
  projectRefFromUrl,
} from "@/lib/db/backup-export";

const HUMAN_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  wallet: "0xabc",
  categories: ["react"],
  rate_usdc: 50,
  availability: "available",
  reputation_score: 80,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

/** Queue page responses: one entry per (table, page) select. */
function pages(...entries: { data?: unknown[]; error?: { code?: string; message: string } | null }[]) {
  mockLimit.mockReset();
  for (const e of entries) {
    mockLimit.mockImplementationOnce(async () =>
      e.error ? { data: null, error: e.error } : { data: e.data ?? [], error: null },
    );
  }
  // Default after the queued entries: empty final page (terminates loops).
  mockLimit.mockImplementation(async () => ({ data: [], error: null }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig = {
    SUPABASE_URL: "https://db.abc123def456ghi789jk.supabase.co",
    R2_ACCOUNT_ID: "acct123",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    BACKUP_R2_BUCKET: "bucket",
  };
});

// ── The D8 boundary ──────────────────────────────────────────────────────────

describe("assertSpecCompliance — the D8 boundary (CC-107)", () => {
  it("accepts the shipped spec", () => {
    expect(() => assertSpecCompliance()).not.toThrow();
  });

  it("rejects task_description added to the tasks allowlist", () => {
    const bad = TIER1_TABLES.map((t) =>
      t.name === "tasks" ? { ...t, columns: [...t.columns, "task_description"] } : t,
    );
    expect(() => assertSpecCompliance(bad)).toThrow(/forbidden column/i);
  });

  it("rejects acceptance_spec added to the tasks allowlist", () => {
    const bad = TIER1_TABLES.map((t) =>
      t.name === "tasks" ? { ...t, columns: [...t.columns, "acceptance_spec"] } : t,
    );
    expect(() => assertSpecCompliance(bad)).toThrow(/forbidden column/i);
  });

  it("rejects sessions (token_hash) via the excluded-table rule", () => {
    const bad = [...TIER1_TABLES, { name: "sessions", columns: ["id"], note: "x" }];
    expect(() => assertSpecCompliance(bad)).toThrow(/excluded table sessions/i);
  });

  it("rejects task_description_history outright", () => {
    const bad = [
      ...TIER1_TABLES,
      { name: "task_description_history", columns: ["id"], note: "x" },
    ];
    expect(() => assertSpecCompliance(bad)).toThrow(/excluded table task_description_history/i);
  });

  it("shipped tasks allowlist never intersects FORBIDDEN_COLUMNS", () => {
    const tasksSpec = TIER1_TABLES.find((t) => t.name === "tasks");
    expect(tasksSpec).toBeDefined();
    const forbidden = FORBIDDEN_COLUMNS.tasks;
    expect(tasksSpec!.columns.some((c) => forbidden.includes(c))).toBe(false);
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("buildNdjson", () => {
  it("writes one JSON object per line, newline-terminated", () => {
    const body = buildNdjson([{ id: "a", x: 1 }, { id: "b", x: 2 }]);
    expect(body.toString("utf8")).toBe('{"id":"a","x":1}\n{"id":"b","x":2}\n');
  });

  it("returns an empty buffer for zero rows — an empty table is still a valid export", () => {
    expect(buildNdjson([]).byteLength).toBe(0);
  });
});

describe("buildManifest", () => {
  it("records absent tables and the exclusion map", () => {
    const manifest = buildManifest(
      {
        rule_version: EXPORT_RULE_VERSION,
        generated_at: "2026-09-16T00:00:00Z",
        project_ref: "abc123def456ghi789jk",
        prefix: "p",
      },
      [
        { name: "humans", status: "exported", rows: 4, verified: true },
        { name: "stake_slashes", status: "absent", rows: 0 },
      ],
    );
    expect(manifest.tables.find((t) => t.name === "stake_slashes")?.status).toBe("absent");
    expect(manifest.excludes["task_description_history"]).toMatch(/task content/i);
    expect(manifest.excludes["sessions"]).toMatch(/token_hash/i);
    expect(manifest.rule_version).toBe(EXPORT_RULE_VERSION);
  });
});

describe("projectRefFromUrl", () => {
  it("derives the ref from the db host form", () => {
    expect(projectRefFromUrl("https://db.abc123def456ghi789jk.supabase.co")).toBe(
      "abc123def456ghi789jk",
    );
  });

  it("throws on garbage rather than exporting under a made-up ref", () => {
    expect(() => projectRefFromUrl("not a url")).toThrow(/project ref/i);
  });
});

// ── The run itself ───────────────────────────────────────────────────────────

describe("exportTier1ToR2", () => {
  it("exports, verifies read-back, and writes the manifest last", async () => {
    // First table gets a row; the default empty pages terminate every loop.
    pages({ data: [HUMAN_ROW] });

    const summary = await exportTier1ToR2(new Date("2026-09-16T04:17:00Z"));

    for (const spec of TIER1_TABLES) {
      expect(summary.tables.find((t) => t.name === spec.name)).toBeDefined();
    }
    const keys = mockPutObject.mock.calls.map((c) => c[2] as string);
    expect(keys.length).toBeGreaterThanOrEqual(TIER1_TABLES.length);
    expect(keys[keys.length - 1]).toMatch(/manifest\.json$/);
    expect(summary.ok).toBe(true);
    expect(summary.prefix).toBe("tier1-backup/abc123def456ghi789jk/2026-09-16/0417Z");
    const humans = summary.tables.find((t) => t.name === "humans");
    expect(humans?.status).toBe("exported");
    expect(humans?.rows).toBe(1);
    expect(humans?.verified).toBe(true);
    expect(humans?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks a table absent when the schema lacks it (migration 024 not applied)", async () => {
    pages(
      { data: [HUMAN_ROW] }, // humans: 1 row
      { error: { code: "PGRST205", message: "Could not find the table" } }, // notification_channels? no — second spec table
    );

    const summary = await exportTier1ToR2(new Date("2026-09-16T04:17:00Z"));

    const absent = summary.tables.find((t) => t.status === "absent");
    expect(absent).toBeDefined();
    expect(absent!.rows).toBe(0);
    expect(summary.ok).toBe(true);
  });

  it("reports failed and poisons ok when a table errors", async () => {
    pages(
      { data: [HUMAN_ROW] },
      { error: { code: "XX000", message: "internal error" } },
    );

    const summary = await exportTier1ToR2(new Date("2026-09-16T04:17:00Z"));

    expect(summary.tables.some((t) => t.status === "failed")).toBe(true);
    expect(summary.ok).toBe(false);
  });

  it("poisons ok when read-back verification fails — a corrupted backup is not a backup", async () => {
    pages({ data: [HUMAN_ROW] });
    mockGetObject.mockImplementationOnce(async () => Buffer.from("corrupted"));

    const summary = await exportTier1ToR2(new Date("2026-09-16T04:17:00Z"));

    expect(summary.tables.some((t) => t.verified === false)).toBe(true);
    expect(summary.ok).toBe(false);
  });

  it("refuses to run at all when the R2 target is unconfigured", async () => {
    mockConfig = { SUPABASE_URL: "https://db.abc123def456ghi789jk.supabase.co" };
    await expect(exportTier1ToR2()).rejects.toThrow(/not configured/i);
  });

  it("a table exporting zero rows is exported (empty ≠ absent)", async () => {
    pages(); // all tables: empty first page

    const summary = await exportTier1ToR2(new Date("2026-09-16T04:17:00Z"));

    const humans = summary.tables.find((t) => t.name === "humans");
    expect(humans?.status).toBe("exported");
    expect(humans?.rows).toBe(0);
    expect(summary.ok).toBe(true);
  });
});
