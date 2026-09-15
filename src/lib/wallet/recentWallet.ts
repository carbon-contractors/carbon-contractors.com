/**
 * recentWallet.ts — app-owned "you connected here before" marker (CC-071).
 *
 * ## Why this exists
 *
 * The Base Account SDK does persist a session (localStorage key
 * `base-acc-sdk.store`) and restores it on a fresh page load — verified
 * empirically by running the installed SDK headlessly (CC-071, 2026-09-16):
 * a seeded store makes `eth_accounts` return the address again, so
 * `isAuthorized()` works with no retry loop. But the SDK also *wipes* that
 * store on several paths we do not control — `Signer.cleanup()` runs after
 * send/sign-while-disconnected, and the provider auto-disconnects (wiping the
 * store) on any `unauthorized` error, e.g. a user dismissing a popup prompt.
 * Any of those leaves the persisted session gone, so after a hard reload
 * `isAuthorized()` legitimately finds nothing and no resume can be offered
 * (the exact real-device failure recorded in CC-071 on 2026-08-09).
 *
 * wagmi's own `recentConnectorId` marker cannot fill this gap: `disconnect()`
 * does not clear it — it *re-writes* it — so it cannot tell "reloaded" apart
 * from "deliberately disconnected". This marker is ours: written on every
 * successful connection, cleared only on an explicit disconnect, so it means
 * precisely "this device connected here before and did not ask to leave."
 *
 * Stored through wagmi's `config.storage` (same prefix/serialization as
 * wagmi's own keys, e.g. `wagmi.recentConnectorId`) so it lives wherever
 * wagmi's persisted state lives — localStorage in the browser, and nothing
 * at all when storage is unavailable (private browsing), in which case the
 * resume feature degrades to exactly its previous behaviour.
 */

import type { Config } from "wagmi";

const STORAGE_KEY = "cc.recentWallet";

type WagmiStorage = Config["storage"];

/**
 * The connector id the user last connected with, if any and not since
 * explicitly disconnected. Never throws: storage being unavailable just means
 * "no marker", which is the pre-CC-071-fallback status quo.
 */
export async function getRecentWalletId(
  storage: WagmiStorage,
): Promise<string | null> {
  try {
    const value = await storage?.getItem<string, string, null>(STORAGE_KEY);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Record the connector the user just connected with. Fire-and-forget safe:
 * losing the write only costs the resume fallback, never correctness.
 */
export async function setRecentWalletId(
  storage: WagmiStorage,
  connectorId: string,
): Promise<void> {
  try {
    await storage?.setItem(STORAGE_KEY, connectorId);
  } catch {
    // private browsing / quota exceeded — the marker is an enhancement, not
    // a guarantee; failing silently here is the intended degradation.
  }
}

/**
 * Forget the marker. Called on an explicit disconnect so that "Disconnect"
 * means what it says: the next visit starts from a clean "Connect Wallet",
 * not an offer to resume the session the user just chose to end.
 */
export async function clearRecentWalletId(
  storage: WagmiStorage,
): Promise<void> {
  try {
    await storage?.removeItem(STORAGE_KEY);
  } catch {
    // same reasoning as setRecentWalletId — nothing here is worth an error
    // on a user action that already succeeded.
  }
}
