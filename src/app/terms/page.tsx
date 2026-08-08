import Link from "next/link";
import path from "path";
import fs from "fs";
import PageShell from "@/components/PageShell";
import MarkdownContent from "@/components/MarkdownContent";
import styles from "../legal.module.css";

export const metadata = {
  title: "Terms of Service | Carbon Contractors",
  description:
    "The terms for using Carbon Contractors — escrow, disputes, and what the platform is and isn't.",
};

export default function TermsPage() {
  const filePath = path.join(process.cwd(), "src", "legal", "terms.md");
  const content = fs.readFileSync(filePath, "utf-8");

  return (
    <PageShell>
      <div className={styles.container}>
        <Link href="/" className={styles.backLink}>
          &larr; HOME
        </Link>
        <p className={styles.prompt}>{"// terms of service"}</p>
        <h1 className={styles.title}>The rules of the road.</h1>
        <article className={styles.article}>
          <MarkdownContent content={content} />
        </article>
      </div>
    </PageShell>
  );
}
