/**
 * resolveResumableConnector — the pure connector-resolution half of CC-071's
 * resume feature, split out of useResumableConnector.ts so it is unit-testable
 * without React (the hook keeps the effect/state; this does the deciding).
 *
 * Runtime imports are type-only (erased) plus recentWallet — deliberately
 * hermetic so the test suite can exercise the full two-tier decision without
 * loading wagmi's React bindings.
 *
 * Two-tier detection, most-trustworthy first:
 *
 * 1. `connector.isAuthorized()` — a plain read-only call (e.g. `eth_accounts`
 *    for `baseAccount`, no popup). When this returns true the session is
 *    live in the Base Account SDK's own persisted store
 *    (`base-acc-sdk.store`) and resume will complete with no further prompt.
 *    Verified empirically headlessly against the installed SDK (CC-071,
 *    2026-09-16): a seeded store makes `eth_accounts` return the address
 *    again after a full "page load".
 *
 * 2. Our `cc.recentWallet` marker — the user connected on this device before
 *    and did not explicitly disconnect, but the SDK's own session record is
 *    gone (it wipes its store on several paths we do not control: any
 *    `unauthorized` error triggers an auto-disconnect that clears it, and
 *    `Signer.cleanup()` does too after send/sign-while-disconnected —
 *    verified in the SDK source during CC-071, 2026-09-16). Offering Resume
 *    here is still correct UX: the tap is a real user gesture, so if the
 *    connector's `connect()` needs a popup, the browser allows it — and if
 *    the underlying grant survives, it completes with no passkey re-prompt.
 *
 * Never calls `connect()` and never rejects: every await is guarded, storage
 * being unavailable (private browsing) degrades to "no resume offered",
 * which is the pre-CC-071-fallback status quo.
 */

import type { Connector, Config } from "wagmi";
import { getRecentWalletId } from "@/lib/wallet/recentWallet";

type WagmiStorage = Config["storage"]; // Storage | null

export async function resolveResumableConnector(
  connectors: readonly Connector[],
  storage: WagmiStorage,
): Promise<Connector | null> {
  // wagmi's own "most recent connector" marker — ordering hint only. It
  // cannot carry the tier-2 meaning because disconnect() re-writes rather
  // than clears it (see recentWallet.ts).
  let recentConnectorId: string | undefined;
  try {
    recentConnectorId =
      (await storage?.getItem("recentConnectorId")) ?? undefined;
  } catch {
    // storage unavailable (e.g. private browsing) -- fall through, try connectors in order
  }

  const byId = new Map(connectors.map((c) => [c.id, c]));
  const ordered = recentConnectorId
    ? [
        ...connectors.filter((c) => c.id === recentConnectorId),
        ...connectors.filter((c) => c.id !== recentConnectorId),
      ]
    : connectors;

  // Tier 1: a live, silently-restorable session.
  for (const connector of ordered) {
    try {
      if (await connector.isAuthorized()) {
        return connector;
      }
    } catch {
      // this connector can't tell us -- try the next one
    }
  }

  // Tier 2: no live session, but the user has connected here before and
  // did not explicitly disconnect.
  const recentWalletId = await getRecentWalletId(storage);
  if (recentWalletId) {
    const connector = byId.get(recentWalletId);
    if (connector) {
      return connector;
    }
  }

  return null;
}
