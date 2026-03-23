import Link from "next/link";
import PageShell from "@/components/PageShell";
import { CATEGORY_DETAILS, MAX_CATEGORIES } from "@/lib/categories";
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

              <p className={styles.disrupts}>
                <span className={styles.disruptsLabel}>Disrupts:</span>{" "}
                {cat.disrupts}
              </p>
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
