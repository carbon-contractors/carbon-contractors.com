import Link from "next/link";
import path from "path";
import fs from "fs";
import PageShell from "@/components/PageShell";
import MarkdownContent from "@/components/MarkdownContent";
import styles from "../legal.module.css";

export const metadata = {
  title: "Privacy Policy | Carbon Contractors",
  description:
    "What Carbon Contractors collects, why, where it's stored, and how to request deletion.",
};

export default function PrivacyPage() {
  const filePath = path.join(process.cwd(), "src", "legal", "privacy.md");
  const content = fs.readFileSync(filePath, "utf-8");

  return (
    <PageShell>
      <div className={styles.container}>
        <Link href="/" className={styles.backLink}>
          &larr; HOME
        </Link>
        <p className={styles.prompt}>{"// privacy policy"}</p>
        <h1 className={styles.title}>What we collect, and why.</h1>
        <article className={styles.article}>
          <MarkdownContent content={content} />
        </article>
      </div>
    </PageShell>
  );
}
