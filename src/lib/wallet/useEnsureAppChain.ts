"use client";

import { useCallback } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { chain as appChain } from "./providers";

/**
 * Every contract write must land on the app's chain. wagmi's writeContract
 * without a `chainId` skips viem's chain assertion entirely, so a wallet parked
 * on another network either rejects the request (read as "you cancelled") or —
 * worse — broadcasts it to that network, where the escrow address holds
 * nothing and the call burns gas to no effect (2026-09-28 walkthrough, NOR-321).
 *
 * Call this before a write, and pass `chainId: appChain.id` to the write
 * itself so viem refuses rather than proceeds if the switch didn't take.
 */
export function useEnsureAppChain(): () => Promise<void> {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  return useCallback(async () => {
    if (chainId === appChain.id) return;
    await switchChainAsync({ chainId: appChain.id });
  }, [chainId, switchChainAsync]);
}
