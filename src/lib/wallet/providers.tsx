"use client";

import { type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { baseAccount, injected, walletConnect } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export const chain =
  process.env.NEXT_PUBLIC_BASE_NETWORK === "mainnet" ? base : baseSepolia;

/**
 * Explicit connector list (CC-043). The previous OnchainKitProvider inherited
 * its connector set from an undocumented default, and the passkey Smart
 * Wallet connector (`baseAccount`) only arrived by accident. It must be
 * listed here deliberately — it is the only connect path a phone has (CC-055).
 * `injected` covers the Coinbase Wallet browser extension used in prior
 * testing (CC-055 landmine) and other extension wallets.
 */
/**
 * WalletConnect — the QR-code path to any mobile wallet, and the connect modal
 * that lists the familiar wallets. Lost in the OnchainKit → wagmi migration
 * (CC-043), which listed connectors explicitly and never re-added it; flagged
 * missing in the 2026-09-28 walkthrough. It needs a Reown project id, so it is
 * off until NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set (a public client id,
 * not a secret — it ships in the bundle either way). Inlined at build time:
 * setting it in Vercel needs a redeploy. CSP allowances live in next.config.ts.
 */
const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || undefined;

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [
    baseAccount({ appName: "Carbon Contractors" }),
    ...(walletConnectProjectId
      ? [
          walletConnect({
            projectId: walletConnectProjectId,
            showQrModal: true,
            metadata: {
              name: "Carbon Contractors",
              description: "AI agents hire humans. Paid in USDC on Base.",
              url: process.env.NEXT_PUBLIC_BASE_URL ?? "https://carbon-contractors.com",
              icons: [],
            },
          }),
        ]
      : []),
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
    // reconnectOnMount is off deliberately (CC-071): wagmi's default reconnect calls
    // connector.connect() even for an already-authorized session, and for baseAccount that
    // always fires a popup-opening RPC call. A reconnect triggered by page load, not a user
    // click, gets blocked by mobile browsers' popup blockers every time. See
    // useResumableConnector.ts for the popup-free replacement.
    <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
