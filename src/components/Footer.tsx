import Link from "next/link";
import Image from "next/image";
import styles from "./Footer.module.css";

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.built}>
          <span className={styles.builtText}>BUILT ON</span>
          <Image
            src="/base-mark.svg"
            alt="Base"
            width={20}
            height={20}
            className={styles.baseMark}
          />
          <span className={styles.builtText}>BASE</span>
        </div>

        <div className={styles.links}>
          <Link href="/learn" className={styles.link}>LEARN</Link>
          <Link href="/mcp-info" className={styles.link}>MCP DOCS</Link>
          <a
            href="https://github.com/carbon-contractors/carbon-contractors.com"
            className={styles.link}
            target="_blank"
            rel="noopener noreferrer"
          >
            GITHUB
          </a>
        </div>

        <div className={styles.copyright}>
          CARBON&#8209;CONTRACTORS.COM &nbsp;&middot;&nbsp; EST. 2026
        </div>
      </div>
    </footer>
  );
}
