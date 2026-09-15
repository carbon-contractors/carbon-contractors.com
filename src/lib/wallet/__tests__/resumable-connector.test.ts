/**
 * CC-071 unit tests: the resume-decision logic, split into a pure module
 * (resolveResumableConnector) plus the app-owned recentWallet marker that
 * backs tier 2.
 *
 * Hermetic: wagmi is imported only as types (erased at runtime), so these
 * tests exercise the real decision code without loading wagmi's React
 * bindings or the Base Account SDK.
 *
 * The behaviour under test is grounded in the empirical findings recorded in
 * docs/backlog/CC-071.md (2026-09-16): the Base Account SDK restores a
 * session from `base-acc-sdk.store` when the store survives a reload
 * (tier 1 path), but wipes that store on `unauthorized` errors and
 * `Signer.cleanup()` (the tier 2 path) — and wagmi's own
 * `recentConnectorId` marker cannot fill tier 2 because `disconnect()`
 * re-writes it rather than clearing it.
 */
import { describe, expect, it } from "vitest";
import { resolveResumableConnector } from "@/lib/wallet/resolveResumableConnector";
import {
  clearRecentWalletId,
  getRecentWalletId,
  setRecentWalletId,
} from "@/lib/wallet/recentWallet";
import type { Connector, Config } from "wagmi";

type Storage = Config["storage"];

function makeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: async (key: string) => {
      map.delete(key);
    },
  } as unknown as Storage;
}

function makeConnector(
  id: string,
  authorized: boolean | "throw" = false,
): Connector {
  return {
    id,
    isAuthorized: async () => {
      if (authorized === "throw") throw new Error("boom");
      return authorized;
    },
  } as unknown as Connector;
}

describe("resolveResumableConnector (CC-071)", () => {
  it("tier 1: returns a connector with a live authorized session", async () => {
    const a = makeConnector("io.metaMask", false);
    const b = makeConnector("baseAccount", true);
    const result = await resolveResumableConnector(
      [a, b],
      makeStorage(),
    );
    expect(result).toBe(b);
  });

  it("tier 1: checks the most recently used connector first", async () => {
    const calls: string[] = [];
    const a = {
      id: "baseAccount",
      isAuthorized: async () => {
        calls.push("baseAccount");
        return true;
      },
    } as unknown as Connector;
    const b = {
      id: "io.metaMask",
      isAuthorized: async () => {
        calls.push("io.metaMask");
        return false;
      },
    } as unknown as Connector;
    // recentConnectorId says metaMask was used last -> it is checked first
    const result = await resolveResumableConnector(
      [a, b],
      makeStorage({ recentConnectorId: "io.metaMask" }),
    );
    expect(result).toBe(a); // ...but baseAccount is the one that is authorized
    expect(calls).toEqual(["io.metaMask", "baseAccount"]);
  });

  it("tier 1: a connector whose isAuthorized() throws is skipped, not fatal", async () => {
    const a = makeConnector("broken", "throw");
    const b = makeConnector("baseAccount", true);
    const result = await resolveResumableConnector(
      [a, b],
      makeStorage(),
    );
    expect(result).toBe(b);
  });

  it("tier 2: no live session, but cc.recentWallet marker set -> resume still offered (the SDK store-wipe path)", async () => {
    // Every connector reports unauthorized: this is the hard-reload case
    // where the Base Account SDK wiped its own store (unauthorized error or
    // Signer.cleanup()), which is exactly the real-device gap from
    // 2026-08-09 that this fix closes.
    const a = makeConnector("baseAccount", false);
    const b = makeConnector("io.metaMask", false);
    const result = await resolveResumableConnector(
      [a, b],
      makeStorage({ "cc.recentWallet": "baseAccount" }),
    );
    expect(result).toBe(a);
  });

  it("tier 2: marker pointing at a connector that no longer exists -> no resume", async () => {
    const a = makeConnector("baseAccount", false);
    const result = await resolveResumableConnector(
      [a],
      makeStorage({ "cc.recentWallet": "io.rainbow" }),
    );
    expect(result).toBeNull();
  });

  it("first-time visitor: no live session, no marker -> null (normal Connect Wallet flow)", async () => {
    const a = makeConnector("baseAccount", false);
    const result = await resolveResumableConnector([a], makeStorage());
    expect(result).toBeNull();
  });

  it("no storage at all (private browsing) -> degrades to tier 1 only, no crash", async () => {
    const a = makeConnector("baseAccount", true);
    const result = await resolveResumableConnector([a], null);
    expect(result).toBe(a);
  });

  it("storage that throws on read -> no resume offered, no crash", async () => {
    const a = makeConnector("baseAccount", false);
    const throwing = {
      getItem: async () => {
        throw new Error("quota / private mode");
      },
      setItem: async () => {},
      removeItem: async () => {},
    } as unknown as Storage;
    const result = await resolveResumableConnector([a], throwing);
    expect(result).toBeNull();
  });
});

describe("recentWallet marker (CC-071 tier 2)", () => {
  it("set then get round-trips the connector id", async () => {
    const storage = makeStorage();
    await setRecentWalletId(storage, "baseAccount");
    expect(await getRecentWalletId(storage)).toBe("baseAccount");
  });

  it("clear forgets the marker (explicit disconnect path)", async () => {
    const storage = makeStorage({ "cc.recentWallet": "baseAccount" });
    await clearRecentWalletId(storage);
    expect(await getRecentWalletId(storage)).toBeNull();
  });

  it("get with no storage (private browsing) -> null", async () => {
    expect(await getRecentWalletId(null)).toBeNull();
  });

  it("set with failing storage -> does not throw (marker is an enhancement, not a guarantee)", async () => {
    const throwing = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error("quota exceeded");
      },
      removeItem: async () => {
        throw new Error("quota exceeded");
      },
    } as unknown as Storage;
    await expect(setRecentWalletId(throwing, "baseAccount")).resolves.toBeUndefined();
    await expect(clearRecentWalletId(throwing)).resolves.toBeUndefined();
  });
});
