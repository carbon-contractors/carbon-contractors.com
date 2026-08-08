"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import styles from "./WalletConnectButton.module.css";

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// wagmi's built-in connectors ship developer-facing default names ("Injected") that
// mean nothing to a non-crypto user. Override by connector id, which is stable across
// wagmi versions — connector.name is the very thing being overridden, so it can't also
// be the lookup key.
const CONNECTOR_LABELS: Record<string, string> = {
  injected: "Other Wallet",
};

function connectorLabel(connector: { id: string; name: string }): string {
  return CONNECTOR_LABELS[connector.id] ?? connector.name;
}

interface WalletConnectButtonProps {
  onAction?: () => void;
  /** Which edge the dropdown hangs from — "left" avoids off-screen overflow
   * when the trigger button sits near the left edge (e.g. a mobile menu). */
  dropdownAlign?: "left" | "right";
}

/**
 * Wallet connect/account button with a connector-picker or disconnect dropdown.
 * Shared between NavBar (top bar + mobile menu) and the /connect hero (CC-001)
 * so there's one connect entry point implementation, not several.
 */
export default function WalletConnectButton({
  onAction,
  dropdownAlign = "right",
}: WalletConnectButtonProps) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const dropdownClass = `${styles.walletDropdown} ${dropdownAlign === "left" ? styles.walletDropdownLeft : ""}`;

  if (isConnected && address) {
    return (
      <div className={styles.wallet}>
        <button
          className={styles.walletButton}
          onClick={() => setDropdownOpen((v) => !v)}
        >
          {truncateAddress(address)}
        </button>
        {dropdownOpen && (
          <div className={dropdownClass}>
            <span className={styles.walletFullAddress}>{address}</span>
            <button
              className={styles.walletDisconnect}
              onClick={() => {
                disconnect();
                setDropdownOpen(false);
                onAction?.();
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.wallet}>
      <button
        className={styles.walletButton}
        onClick={() => setDropdownOpen((v) => !v)}
      >
        {isPending ? "Connecting..." : "Connect Wallet"}
      </button>
      {dropdownOpen && (
        <div className={dropdownClass}>
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              className={styles.walletDropdownItem}
              onClick={() => {
                connect({ connector });
                setDropdownOpen(false);
                onAction?.();
              }}
            >
              {connectorLabel(connector)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
