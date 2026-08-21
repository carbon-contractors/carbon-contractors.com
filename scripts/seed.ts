/**
 * seed.ts
 * Populates the humans table with mock data for development.
 * Usage: npm run seed
 *
 * SAFETY: Refuses to run against production or mainnet databases.
 * Uses service role key (anon role is read-only after migration 003).
 *
 * Wallets are lowercase (migration 014 CHECKs wallet = lower(wallet), CC-002) and
 * categories come from src/lib/categories.ts (migration 008, CC-017). SEED_HUMANS is
 * exported so scripts/__tests__/seed.test.mjs can pin both invariants without
 * triggering the env guards below.
 */

import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { validateCategorySelection } from "../src/lib/categories";

export const SEED_HUMANS = [
  {
    wallet: "0xa1b2c3d4e5f6000000000000000000000000aaaa",
    categories: ["delivery-errands", "post-parcels"],
    rate_usdc: 150,
    availability: "available",
    reputation_score: 97,
  },
  {
    wallet: "0xb2c3d4e5f6a7000000000000000000000000bbbb",
    categories: ["personal-assistant", "event-setup"],
    rate_usdc: 120,
    availability: "available",
    reputation_score: 91,
  },
  {
    wallet: "0xc3d4e5f6a7b8000000000000000000000000cccc",
    categories: ["photo-verification", "delivery-errands"],
    rate_usdc: 200,
    availability: "busy",
    reputation_score: 99,
  },
  {
    wallet: "0xd4e5f6a7b8c9000000000000000000000000dddd",
    categories: ["cleaning", "home-maintenance"],
    rate_usdc: 100,
    availability: "available",
    reputation_score: 85,
  },
  {
    wallet: "0xe5f6a7b8c9d0000000000000000000000000eeee",
    categories: ["moving-hauling", "garden-outdoors"],
    rate_usdc: 175,
    availability: "offline",
    reputation_score: 88,
  },
];

export async function seed() {
  // ── Production guard ──────────────────────────────────────────────────────
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_BASE_NETWORK === "mainnet"
  ) {
    console.error("ERROR: Seed script cannot run against production/mainnet");
    process.exit(1);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars");
    process.exit(1);
  }

  for (const h of SEED_HUMANS) {
    const check = validateCategorySelection(h.categories);
    if (!check.valid) {
      console.error(`ERROR: seed human ${h.wallet}: ${check.error}`);
      process.exit(1);
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Upsert so the script is idempotent
  const { data, error } = await supabase
    .from("humans")
    .upsert(SEED_HUMANS, { onConflict: "wallet" })
    .select("wallet");

  if (error) {
    console.error("Seed failed:", error.message);
    process.exit(1);
  }

  console.log(`Seeded ${data.length} humans:`);
  for (const h of data) {
    console.log(`  ${h.wallet}`);
  }
}

// Run only when invoked directly (`npm run seed`), not when imported by a test.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  seed();
}
