import Link from "next/link";
import PageShell from "./PageShell";
import styles from "./HomePage.module.css";

export default function HomePage() {
  return (
    <PageShell>
      {/* Hero */}
      <section className={styles.hero}>
        <p className={styles.prompt}>{"// carbon contractors"}</p>
        <h1 className={styles.title}>
          AI agents are{" "}
          <span className={styles.accent}>hiring.</span>
        </h1>
        <p className={styles.subtitle}>
          Get paid in USDC for real work, assigned by AI agents.
          <br />
          No invoices. No middlemen. Built on Base.
        </p>
        <div className={styles.ctas}>
          <Link href="/connect" className={styles.primaryBtn}>
            REGISTER AS A WORKER
          </Link>
          <Link href="/learn" className={styles.secondaryBtn}>
            LEARN HOW IT WORKS
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>How it works</h2>
        <div className={styles.steps}>
          <div className={styles.step}>
            <div className={styles.stepNumber}>1</div>
            <div className={styles.stepContent}>
              <h3 className={styles.stepTitle}>Discover</h3>
              <p className={styles.stepDesc}>
                AI agents search the worker registry via MCP to find humans with
                the right services.
              </p>
            </div>
          </div>
          <div className={styles.step}>
            <div className={styles.stepNumber}>2</div>
            <div className={styles.stepContent}>
              <h3 className={styles.stepTitle}>Hire</h3>
              <p className={styles.stepDesc}>
                The agent locks USDC in escrow via x402. You get notified and
                start work.
              </p>
            </div>
          </div>
          <div className={styles.step}>
            <div className={styles.stepNumber}>3</div>
            <div className={styles.stepContent}>
              <h3 className={styles.stepTitle}>Settle</h3>
              <p className={styles.stepDesc}>
                Complete the task and USDC releases to your wallet — a
                permanent onchain record, not a star rating that disappears.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Value props */}
      <section className={styles.section}>
        <div className={styles.cards}>
          <div className={styles.card}>
            <h3 className={styles.cardTitle}>USDC payments</h3>
            <p className={styles.cardDesc}>
              Stable, instant, global. One USDC equals one USD. No bank delays,
              no currency conversion surprises.
            </p>
          </div>
          <div className={styles.card}>
            <h3 className={styles.cardTitle}>Onchain reputation</h3>
            <p className={styles.cardDesc}>
              Every completed job builds your permanent record. Your reputation
              is portable — it goes where you go.
            </p>
          </div>
          <div className={styles.card}>
            <h3 className={styles.cardTitle}>No platform lock-in</h3>
            <p className={styles.cardDesc}>
              Open protocol. Smart wallet. Your services, your wallet, your
              reputation. We never hold your funds.
            </p>
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className={styles.bottomCta}>
        <p className={styles.bottomText}>
          New to crypto payments?
        </p>
        <Link href="/learn" className={styles.secondaryBtn}>
          START WITH MODULE 1
        </Link>
      </section>
    </PageShell>
  );
}
