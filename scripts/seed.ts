/**
 * seed.ts
 * Populates the humans table with mock data for development.
 * Usage: npx tsx scripts/seed.ts
 *
 * SAFETY: Refuses to run against production or mainnet databases.
 * Uses service role key (anon role is read-only after migration 003).
 */

import { createClient } from "@supabase/supabase-js";

// ── Production guard ────────────────────────────────────────────────────────
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SEED_HUMANS = [
  {
    wallet: "0xA1b2C3d4E5f6000000000000000000000000AAAA",
    skills: ["solidity", "smart-contracts", "auditing"],
    rate_usdc: 150,
    availability: "available",
    reputation_score: 97,
  },
  {
    wallet: "0xB2c3D4e5F6a7000000000000000000000000BBBB",
    skills: ["typescript", "nextjs", "api-design"],
    rate_usdc: 120,
    availability: "available",
    reputation_score: 91,
  },
  {
    wallet: "0xC3d4E5f6A7b8000000000000000000000000CCCC",
    skills: ["zk-proofs", "circom", "cryptography"],
    rate_usdc: 200,
    availability: "busy",
    reputation_score: 99,
  },
  {
    wallet: "0xD4e5F6a7B8c9000000000000000000000000DDDD",
    skills: ["python", "data-analysis", "ml"],
    rate_usdc: 100,
    availability: "available",
    reputation_score: 85,
  },
  {
    wallet: "0xE5f6A7b8C9d0000000000000000000000000EEEE",
    skills: ["solidity", "defi", "subgraph"],
    rate_usdc: 175,
    availability: "offline",
    reputation_score: 88,
  },
];

async function seed() {
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

seed();
