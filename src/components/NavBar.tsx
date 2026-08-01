"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import styles from "./NavBar.module.css";

const NAV_LINKS = [
  { href: "/services", label: "SERVICES" },
  { href: "/learn", label: "LEARN" },
  { href: "/connect", label: "REGISTER" },
  { href: "/dashboard", label: "DASHBOARD" },
  { href: "/mcp-info", label: "MCP DOCS" },
];

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [dropdownOpen, setDropdownOpen] = useState(false);

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
          <div className={styles.walletDropdown}>
            <span className={styles.walletFullAddress}>{address}</span>
            <button
              className={styles.walletDisconnect}
              onClick={() => {
                disconnect();
                setDropdownOpen(false);
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
        <div className={styles.walletDropdown}>
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              className={styles.walletDropdownItem}
              onClick={() => {
                connect({ connector });
                setDropdownOpen(false);
              }}
            >
              {connector.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function NavBar() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <nav className={styles.nav}>
      <div className={styles.inner}>
        <Link href="/" className={styles.logo}>
          CARBON CONTRACTORS
        </Link>

        <button
          className={styles.hamburger}
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle navigation"
        >
          <span className={menuOpen ? styles.barOpen : styles.bar} />
          <span className={menuOpen ? styles.barOpen : styles.bar} />
          <span className={menuOpen ? styles.barOpen : styles.bar} />
        </button>

        <div className={`${styles.links} ${menuOpen ? styles.linksOpen : ""}`}>
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={styles.link}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </div>

        <WalletButton />
      </div>
    </nav>
  );
}
