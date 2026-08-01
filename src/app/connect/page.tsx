"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useSignMessage } from "wagmi";
import PageShell from "@/components/PageShell";
import WalletConnectButton from "@/components/WalletConnectButton";
import { CATEGORIES, MAX_CATEGORIES } from "@/lib/categories";
import styles from "./connect.module.css";

export default function ConnectPage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [rateUsdc, setRateUsdc] = useState("");
  const [status, setStatus] = useState<
    "idle" | "signing" | "submitting" | "success" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // Auto-redirect to dashboard 2s after successful registration
  useEffect(() => {
    if (status !== "success") return;
    const timer = setTimeout(() => router.push("/dashboard"), 2000);
    return () => clearTimeout(timer);
  }, [status, router]);

  function toggleCategory(slug: string) {
    setSelectedCategories((prev) => {
      if (prev.includes(slug)) return prev.filter((s) => s !== slug);
      if (prev.length >= MAX_CATEGORIES) return prev;
      return [...prev, slug];
    });
  }

  async function handleRegister() {
    if (!address || selectedCategories.length === 0 || !rateUsdc) return;

    setStatus("signing");
    setErrorMsg("");

    try {
      const message = JSON.stringify({
        action: "register_worker",
        wallet: address,
        categories: selectedCategories,
        rate_usdc: Number(rateUsdc),
        nonce: crypto.randomUUID(),
        timestamp: Math.floor(Date.now() / 1000),
      });

      const signature = await signMessageAsync({ message });

      setStatus("submitting");

      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature, wallet: address }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Registration failed");
      }

      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
    }
  }

  const atMax = selectedCategories.length >= MAX_CATEGORIES;

  return (
    <PageShell>
      <div className={styles.content}>
        {!isConnected ? (
          <div className={styles.hero}>
            <h2>Register as a Worker</h2>
            <p>
              Connect your wallet to register your services on the Base-Human
              whitepages. AI agents will be able to discover and hire you via
              MCP.
            </p>
            <p className={styles.subtle}>
              No seed phrases. No browser extensions. Just a passkey.
            </p>
            <div className={styles.heroConnect}>
              <WalletConnectButton />
            </div>
          </div>
        ) : status === "success" ? (
          <div className={styles.hero}>
            <h2>Registered</h2>
            <p>
              Your wallet is now in the whitepages. AI agents can find you by
              your services and hire you directly.
            </p>
            <p className={styles.mono}>{address}</p>
            <p className={styles.subtle}>Redirecting to dashboard...</p>
          </div>
        ) : (
          <div className={styles.form}>
            <h2>Your Services</h2>
            <p>Choose up to 2 service categories. Agents find you by these.</p>
            <div className={styles.categories}>
              {CATEGORIES.map((cat) => {
                const selected = selectedCategories.includes(cat.slug);
                const disabled = !selected && atMax;
                return (
                  <button
                    key={cat.slug}
                    className={`${styles.category} ${selected ? styles.categoryActive : ""} ${disabled ? styles.categoryDisabled : ""}`}
                    onClick={() => toggleCategory(cat.slug)}
                    disabled={disabled}
                    type="button"
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
            <p className={styles.selectionHint}>
              {selectedCategories.length} / {MAX_CATEGORIES} selected
            </p>

            <h2>Hourly Rate (USDC)</h2>
            <input
              type="number"
              min="1"
              step="1"
              placeholder="e.g. 150"
              value={rateUsdc}
              onChange={(e) => setRateUsdc(e.target.value)}
              className={styles.input}
            />

            <button
              className={styles.register}
              disabled={
                selectedCategories.length === 0 ||
                !rateUsdc ||
                status === "signing" ||
                status === "submitting"
              }
              onClick={handleRegister}
            >
              {status === "signing"
                ? "Sign with wallet..."
                : status === "submitting"
                  ? "Registering..."
                  : "Sign & Register"}
            </button>

            {status === "error" && (
              <p className={styles.error}>{errorMsg}</p>
            )}
          </div>
        )}
      </div>
    </PageShell>
  );
}
