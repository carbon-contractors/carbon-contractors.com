"use client";

import { useState } from "react";
import Link from "next/link";
import WalletConnectButton from "./WalletConnectButton";
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
          <span className={`${styles.bar} ${menuOpen ? styles.barOpen : ""}`} />
          <span className={`${styles.bar} ${menuOpen ? styles.barOpen : ""}`} />
          <span className={`${styles.bar} ${menuOpen ? styles.barOpen : ""}`} />
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
          <div className={styles.walletMobile}>
            <WalletConnectButton
              onAction={() => setMenuOpen(false)}
              dropdownAlign="left"
            />
          </div>
        </div>

        <div className={styles.walletDesktop}>
          <WalletConnectButton />
        </div>
      </div>
    </nav>
  );
}
