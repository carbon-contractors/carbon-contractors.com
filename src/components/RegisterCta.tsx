"use client";

import Link from "next/link";
import { useIsRegistered } from "@/lib/wallet/useIsRegistered";

/**
 * "Register as a worker", unless the connected wallet already is one — then it
 * goes to the dashboard instead of back through a registration form the worker
 * has already completed (2026-09-28 walkthrough).
 */
export default function RegisterCta({ className }: { className?: string }) {
  const registered = useIsRegistered();
  return registered ? (
    <Link href="/dashboard" className={className}>
      GO TO YOUR DASHBOARD
    </Link>
  ) : (
    <Link href="/connect" className={className}>
      REGISTER AS A WORKER
    </Link>
  );
}
