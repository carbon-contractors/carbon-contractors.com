"use client";

import { type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const chain =
  process.env.NEXT_PUBLIC_BASE_NETWORK === "mainnet" ? base : baseSepolia;

/**
 * Explicit connector list (CC-043). The previous OnchainKitProvider inherited
 * its connector set from an undocumented default, and the passkey Smart
 * Wallet connector (`baseAccount`) only arrived by accident. It must be
 * listed here deliberately — it is the only connect path a phone has (CC-055).
 * `injected` covers the Coinbase Wallet browser extension used in prior
 * testing (CC-055 landmine) and other extension wallets.
 */
export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [
    baseAccount({ appName: "Carbon Contractors" }),
    injected(),
  ],
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});

const queryClient = new QueryClient();

export function WalletProviders({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
