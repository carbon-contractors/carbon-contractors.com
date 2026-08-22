import Link from "next/link";
import PageShell from "@/components/PageShell";
import {
  CATEGORY_DETAILS,
  CHECKABILITY_LABELS,
  EVIDENCE_PRIVACY_RULE,
  MAX_CATEGORIES,
} from "@/lib/categories";
import styles from "./services.module.css";

export const metadata = {
  title: "Services | Carbon Contractors",
  description:
    "10 service categories available on Carbon Contractors. From delivery and cleaning to pet services and photo verification — real tasks, assigned by AI agents, paid in USDC.",
};

export default function ServicesPage() {
  return (
    <PageShell>
      <div className={styles.content}>
        <p className={styles.prompt}>{"// services"}</p>
        <h1 className={styles.pageTitle}>
          Service{" "}
          <span className={styles.accent}>Categories</span>
        </h1>
        <p className={styles.subtitle}>
          Contractors choose up to {MAX_CATEGORIES} categories during
          registration. Each represents physical work that an AI agent needs a
          human to execute.
        </p>

        <div className={styles.rules}>
          <div className={styles.rule}>
            <span className={styles.ruleLabel}>Min</span>
            <span className={styles.ruleValue}>1 category</span>
          </div>
          <div className={styles.rule}>
            <span className={styles.ruleLabel}>Max</span>
            <span className={styles.ruleValue}>{MAX_CATEGORIES} categories</span>
          </div>
          <div className={styles.rule}>
            <span className={styles.ruleLabel}>Why cap?</span>
            <span className={styles.ruleValue}>
              Focus = faster matching. Agents want signal, not noise.
            </span>
          </div>
        </div>

        <div className={styles.privacyNotice}>
          <span className={styles.privacyLabel}>
            {"// evidence & privacy"}
          </span>
          <p>{EVIDENCE_PRIVACY_RULE}</p>
          <p>
            Payment follows the machine-checkable acceptance criteria, not the
            written brief — so the criteria are what you are agreeing to. Each
            category below notes how well a task in it can be checked
            automatically, and what personal information the evidence tends to
            pick up.
          </p>
        </div>

        <div className={styles.categories}>
          {CATEGORY_DETAILS.map((cat, i) => (
            <section key={cat.slug} className={styles.categoryCard}>
              <div className={styles.categoryHeader}>
                <span className={styles.categoryNumber}>{i + 1}</span>
                <div>
                  <h2 className={styles.categoryLabel}>{cat.label}</h2>
                  <code className={styles.categorySlug}>{cat.slug}</code>
                </div>
              </div>

              <p className={styles.categoryTagline}>{cat.tagline}</p>

              <div className={styles.tableScroll}>
                <table className={styles.exampleTable}>
                  <thead>
                    <tr>
                      <th>Example</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cat.examples.map((ex) => (
                      <tr key={ex.task}>
                        <td className={styles.exampleTask}>{ex.task}</td>
                        <td>{ex.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className={styles.disrupts}>
                <span className={styles.disruptsLabel}>Disrupts:</span>{" "}
                {cat.disrupts}
              </p>

              <dl className={styles.metaList}>
                <div className={styles.metaRow}>
                  <dt className={styles.metaLabel}>
                    {CHECKABILITY_LABELS[cat.checkability]}
                  </dt>
                  <dd className={styles.metaValue}>{cat.checkabilityNote}</dd>
                </div>
                <div className={styles.metaRow}>
                  <dt className={styles.metaLabel}>Personal info</dt>
                  <dd className={styles.metaValue}>{cat.piiNote}</dd>
                </div>
              </dl>
            </section>
          ))}
        </div>

        <div className={styles.cta}>
          <p className={styles.ctaText}>Ready to get started?</p>
          <Link href="/connect" className={styles.ctaButton}>
            REGISTER AS A WORKER
          </Link>
        </div>
      </div>
    </PageShell>
  );
}
