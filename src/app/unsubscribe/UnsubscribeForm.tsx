"use client";

import { useState } from "react";
import Link from "next/link";
import styles from "./unsubscribe.module.css";

export default function UnsubscribeForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit() {
    if (!email || !email.includes("@")) return;
    setStatus("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/waitlist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? "Something went wrong");
        setStatus("error");
      } else {
        setStatus("done");
      }
    } catch {
      setErrorMsg("Network error — try again");
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <p className={styles.success}>
        If that email was on our list, it&apos;s been removed. No confirmation email, no
        further steps — that&apos;s it.
      </p>
    );
  }

  return (
    <>
      <p className={styles.subtitle}>
        Enter the email you signed up with. We&apos;ll take it off the waitlist immediately —
        see our <Link href="/privacy">privacy policy</Link> for what else we hold and how to
        ask us to delete it.
      </p>
      <input
        className={styles.input}
        type="email"
        placeholder="your@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        disabled={status === "submitting"}
      />
      <button
        className={styles.submit}
        onClick={handleSubmit}
        disabled={status === "submitting" || !email}
      >
        {status === "submitting" ? "Removing..." : "Unsubscribe"}
      </button>
      {status === "error" && <p className={styles.error}>{errorMsg}</p>}
    </>
  );
}
