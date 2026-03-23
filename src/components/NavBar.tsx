"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ConnectWallet,
  Wallet,
  WalletDropdown,
  WalletDropdownDisconnect,
} from "@coinbase/onchainkit/wallet";
import { Address, Avatar, Name, Identity } from "@coinbase/onchainkit/identity";
import styles from "./NavBar.module.css";

const NAV_LINKS = [
  { href: "/services", label: "SERVICES" },
  { href: "/learn", label: "LEARN" },
  { href: "/connect", label: "REGISTER" },
  { href: "/dashboard", label: "DASHBOARD" },
  { href: "/mcp-info", label: "MCP DOCS" },
];

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

        <div className={styles.wallet}>
          <Wallet>
            <ConnectWallet>
              <Avatar className={styles.avatar} />
              <Name />
            </ConnectWallet>
            <WalletDropdown>
              <Identity className={styles.identity} hasCopyAddressOnClick>
                <Avatar />
                <Name />
                <Address />
              </Identity>
              <WalletDropdownDisconnect />
            </WalletDropdown>
          </Wallet>
        </div>
      </div>
    </nav>
  );
}
