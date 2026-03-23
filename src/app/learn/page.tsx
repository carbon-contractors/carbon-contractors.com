import Link from "next/link";
import PageShell from "@/components/PageShell";
import { LEARN_MODULES } from "@/lib/learn/modules";
import styles from "./learn.module.css";

export const metadata = {
  title: "Learn | Carbon Contractors",
  description:
    "Six modules covering USDC, wallets, x402 payments, and getting paid by AI agents.",
};

export default function LearnHub() {
  return (
    <PageShell>
      <div className={styles.header}>
        <p className={styles.prompt}>{"// learn"}</p>
        <h1 className={styles.title}>
          Crypto payments,<br />
          explained <span className={styles.accent}>simply.</span>
        </h1>
        <p className={styles.subtitle}>
          Six short modules. No jargon. Everything you need to get paid onchain.
        </p>
      </div>

      <div className={styles.grid}>
        {LEARN_MODULES.map((mod) => (
          <Link
            key={mod.slug}
            href={`/learn/${mod.slug}`}
            className={styles.card}
          >
            <div className={styles.cardNumber}>
              <span className={styles.number}>{mod.moduleNumber}</span>
            </div>
            <div className={styles.cardBody}>
              <h2 className={styles.cardTitle}>{mod.title}</h2>
              <p className={styles.cardDesc}>{mod.description}</p>
              <span className={styles.cardMeta}>{mod.readTime} read</span>
            </div>
          </Link>
        ))}
      </div>
    </PageShell>
  );
}
