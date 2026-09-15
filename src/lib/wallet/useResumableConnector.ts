"use client";

import { useEffect, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import type { Connector } from "wagmi";
import { resolveResumableConnector } from "@/lib/wallet/resolveResumableConnector";

/**
 * Finds a connector to resume a previous session with, without ever calling
 * `connect()` unprompted — so nothing opens a popup on page load.
 *
 * wagmi's default `reconnectOnMount` behaviour (see `WagmiProvider` in
 * `providers.tsx`, where it's disabled) calls `connector.isAuthorized()` and
 * then, if true, calls `connector.connect({ isReconnecting: true })` anyway.
 * For `baseAccount`, `connect()` unconditionally fires the SDK's
 * `wallet_connect` RPC, which opens a popup window — and an automatic
 * reconnect on page load is not a user gesture, so mobile browsers block
 * that popup. The result: a real, previously-authorized session gets silently
 * wiped out on every refresh, which reads to a user as "the connect button
 * re-triggers the connection request every time" (CC-071).
 *
 * The two-tier decision (live `isAuthorized()` session first, then the
 * app-owned `cc.recentWallet` marker) lives in resolveResumableConnector.ts,
 * where it is unit-tested without React. This hook just runs it on mount and
 * holds the result for the UI.
 *
 * Returns the connector to resume with, if any, so the UI can offer a
 * one-tap "Resume Session" action instead of re-running the whole
 * first-visit flow.
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
      const result = await resolveResumableConnector(
        config.connectors,
        config.storage,
      );
      if (!cancelled) setResumable(result);
    })();

    return () => {
      cancelled = true;
    };
  }, [isConnected, config]);

  return resumable;
}
