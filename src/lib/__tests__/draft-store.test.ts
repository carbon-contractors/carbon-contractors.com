import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadStoredDrafts,
  saveStoredDrafts,
  type StoredEvidenceDrafts,
} from "@/lib/evidence/draft-store";
import { emptyArtifactDraft } from "@/lib/evidence/draft";

/**
 * NOR-328 — drafts persist in the worker's own browser only (the platform
 * stores no bundles, CC-083). The store must round-trip, survive corruption
 * as an empty draft, never throw when storage is disabled, and cap its size
 * by dropping oldest entries first.
 */

const WALLET = "0x1234567890abcdef1234567890abcdef12345678";

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

function installStorage(storage: unknown) {
  vi.stubGlobal("window", { localStorage: storage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("draft-store (NOR-328)", () => {
  it("round-trips drafts per wallet", () => {
    installStorage(new FakeStorage());
    const drafts: Record<string, StoredEvidenceDrafts> = {
      pr_1: { artifacts: [{ ...emptyArtifactDraft(), uri: "https://a" }], submittedHash: "0xabc" },
    };
    saveStoredDrafts(WALLET, drafts);
    const loaded = loadStoredDrafts(WALLET);
    expect(loaded.pr_1?.artifacts[0].uri).toBe("https://a");
    expect(loaded.pr_1?.submittedHash).toBe("0xabc");
  });

  it("keys storage per wallet — another wallet sees nothing", () => {
    installStorage(new FakeStorage());
    saveStoredDrafts(WALLET, { pr_1: { artifacts: [] } });
    expect(loadStoredDrafts("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual({});
  });

  it("recovers as empty from corrupt JSON", () => {
    const storage = new FakeStorage();
    installStorage(storage);
    storage.setItem(`cc_evidence_drafts_${WALLET}`, "{not json");
    expect(loadStoredDrafts(WALLET)).toEqual({});
  });

  it("recovers as empty when storage is disabled (throwing)", () => {
    installStorage({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => saveStoredDrafts(WALLET, { pr_1: { artifacts: [] } })).not.toThrow();
    expect(loadStoredDrafts(WALLET)).toEqual({});
  });

  it("drops oldest entries first past the size cap", () => {
    installStorage(new FakeStorage());
    const fat: Record<string, StoredEvidenceDrafts> = {};
    for (let i = 0; i < 400; i++) {
      fat[`pr_${i}`] = {
        artifacts: [
          { ...emptyArtifactDraft(), uri: `https://example.test/${i}/${"x".repeat(1400)}` },
        ],
      };
    }
    saveStoredDrafts(WALLET, fat);
    const loaded = loadStoredDrafts(WALLET);
    expect(Object.keys(loaded).length).toBeGreaterThan(0);
    expect(Object.keys(loaded).length).toBeLessThan(400);
    expect(loaded[`pr_0`]).toBeUndefined(); // oldest dropped
    expect(loaded[`pr_399`]).toBeDefined(); // newest kept
  });
});
