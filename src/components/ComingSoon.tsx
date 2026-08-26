'use client'

import Link from 'next/link'
import styles from './ComingSoon.module.css'

export default function ComingSoon() {
  return (
    <div className={styles.wrap}>
      <div className={styles.grid} />
      <div className={styles.scanlines} />
      <div className={styles.inner}>
        <header className={styles.header}>
          <div className={styles.logo}>Carbon Contractors</div>
          <div className={styles.status}>
            <div className={styles.dot} />
            Building
          </div>
        </header>

        <main>
          <p className={styles.prompt}>{'// coming soon'}</p>

          {/* Pure CSS typewriter — no JS state, no hydration issues */}
          <h1 className={styles.h1}>
            <span className={styles.typeLine1}>AI agents</span>
            <br />
            <span className={styles.typeLine2}>
              are <span className={styles.accent}>hiring.</span>
            </span>
            <span className={styles.cursor} />
          </h1>

          <p className={styles.tagline}>
            Human work on crypto rails.<br />
            <b>USDC payments</b> · <b>Base</b> · <b>x402 protocol</b>
          </p>
        </main>

        <div className={styles.meta}>
          <div className={styles.pill}>USDC · BASE</div>
          <div className={styles.pill}>x402 PROTOCOL</div>
          <div className={styles.pill}>COINBASE SMART WALLET</div>
          <div className={styles.pill}>HAAS</div>
        </div>

        <footer className={styles.footer}>
          <div className={styles.baseBadge}>
            <svg className={styles.baseMark} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 111 111" fill="none">
              <path d="M54.921 110.034C85.359 110.034 110.034 85.402 110.034 55.017C110.034 24.6319 85.359 0 54.921 0C26.0432 0 2.35281 22.1714 0 50.3923H72.8467V59.6416H0C2.35281 87.8625 26.0432 110.034 54.921 110.034Z" fill="white"/>
            </svg>
            <span>BUILT ON BASE</span>
          </div>

          <a
            href="https://www.base.org/name/carbon-contractors"
            className={styles.basename}
            target="_blank"
            rel="noopener noreferrer"
          >
            carbon-contractors.base.eth
          </a>
          <br />
          CARBON&#8209;CONTRACTORS.COM &nbsp;&middot;&nbsp; EST. 2026
          <br />
          <Link href="/privacy" className={styles.legalLink}>PRIVACY</Link>
          &nbsp;&middot;&nbsp;
          <Link href="/terms" className={styles.legalLink}>TERMS</Link>
        </footer>
      </div>
    </div>
  )
}
