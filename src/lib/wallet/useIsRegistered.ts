"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";

/**
 * Whether the connected wallet already has a whitepages listing. `true` /
 * `false` once known; `null` while disconnected or still checking, so callers
 * can keep the "register" affordance until there is a definite answer.
 *
 * `/api/profile` is the public projection (humans is world-readable by
 * design, CC-030), so this costs no signature. Shared through react-query so
 * the nav and a page's CTA make one request between them, not one each.
 */
export function useIsRegistered(): boolean | null {
  const { address, isConnected } = useAccount();
  const wallet = address?.toLowerCase();
  const { data } = useQuery({
    queryKey: ["is-registered", wallet],
    enabled: Boolean(isConnected && wallet),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const res = await fetch(`/api/profile?wallet=${wallet}`);
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`profile lookup failed: ${res.status}`);
      const body = (await res.json()) as { ok?: boolean };
      return body.ok === true;
    },
  });
  if (!isConnected || !wallet) return null;
  return data ?? null;
}
