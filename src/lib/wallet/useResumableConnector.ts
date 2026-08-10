"use client";

import { useEffect, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import type { Connector } from "wagmi";

/**
 * Finds a previously-authorized connector without ever calling `connect()` — so nothing
 * opens a popup on page load.
 *
 * wagmi's default `reconnectOnMount` behaviour (see `WagmiProvider` in `providers.tsx`,
 * where it's disabled) calls `connector.isAuthorized()` and then, if true, calls
 * `connector.connect({ isReconnecting: true })` anyway. For `baseAccount`, `connect()`
 * unconditionally fires the SDK's `wallet_connect` RPC, which opens a popup window — and an
 * automatic reconnect on page load is not a user gesture, so mobile browsers block that
 * popup. The result: a real, previously-authorized session gets silently wiped out on every
 * refresh, which reads to a user as "the connect button re-triggers the connection request
 * every time" (CC-071).
 *
 * This checks `isAuthorized()` only (a plain read-only call, e.g. `eth_accounts` for
 * `baseAccount` — no popup) and returns the connector to resume, if any, so the UI can offer
 * a one-tap "Resume session" action. That tap is a real user gesture, so if the connector's
 * own `connect()` does need to open a popup, it's allowed to.
 */
export function useResumableConnector(): Connector | null {
  const config = useConfig();
  const { isConnected } = useAccount();
  const [resumable, setResumable] = useState<Connector | null>(null);

  useEffect(() => {
    // No need to check anything once connected -- WalletConnectButton already gates on
    // `isConnected` before it ever reads this hook's return value, so a stale `resumable`
    // sitting unused in state here is harmless.
    if (isConnected) return;

    let cancelled = false;

    (async () => {
      let recentConnectorId: string | undefined;
      try {
        recentConnectorId = await config.storage?.getItem("recentConnectorId") ?? undefined;
      } catch {
        // storage unavailable (e.g. private browsing) -- fall through, try connectors in order
      }

      const ordered = recentConnectorId
        ? [
            ...config.connectors.filter((c) => c.id === recentConnectorId),
            ...config.connectors.filter((c) => c.id !== recentConnectorId),
          ]
        : config.connectors;

      for (const connector of ordered) {
        if (cancelled) return;
        try {
          if (await connector.isAuthorized()) {
            if (!cancelled) setResumable(connector);
            return;
          }
        } catch {
          // this connector can't tell us -- try the next one
        }
      }

      if (!cancelled) setResumable(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [isConnected, config]);

  return resumable;
}
