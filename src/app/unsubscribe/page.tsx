import Link from "next/link";
import PageShell from "@/components/PageShell";
import UnsubscribeForm from "./UnsubscribeForm";
import styles from "./unsubscribe.module.css";

export const metadata = {
  title: "Unsubscribe | Carbon Contractors",
  description: "Remove your email from the Carbon Contractors waitlist.",
};

export default function UnsubscribePage() {
  return (
    <PageShell>
      <div className={styles.container}>
        <Link href="/" className={styles.backLink}>
          &larr; HOME
        </Link>
        <p className={styles.prompt}>{"// unsubscribe"}</p>
        <h1 className={styles.title}>Leave the waitlist.</h1>
        <UnsubscribeForm />
      </div>
    </PageShell>
  );
}
