import { describe, it, expect } from "vitest";
import { SEED_HUMANS } from "../seed.ts";
import {
  CATEGORIES,
  MAX_CATEGORIES,
  MIN_CATEGORIES,
} from "../../src/lib/categories.ts";

// CC-017: `npm run seed` broke twice over — the pre-migration-008 `skills` column,
// and migration 014's CHECK (wallet = lower(wallet)) would reject the old
// checksummed demo addresses (CC-002). These tests pin both invariants so the
// script cannot drift back into "runs only until you run it" territory.
describe("seed data (CC-017)", () => {
  it("has seed humans to validate", () => {
    expect(SEED_HUMANS.length).toBeGreaterThanOrEqual(5);
  });

  it("writes categories, never the pre-migration-008 skills column", () => {
    for (const h of SEED_HUMANS) {
      expect(h).not.toHaveProperty("skills");
      expect(Array.isArray(h.categories)).toBe(true);
    }
  });

  it("uses valid category slugs within the min/max bounds", () => {
    const validSlugs = new Set(CATEGORIES.map((c) => c.slug));
    for (const h of SEED_HUMANS) {
      expect(h.categories.length).toBeGreaterThanOrEqual(MIN_CATEGORIES);
      expect(h.categories.length).toBeLessThanOrEqual(MAX_CATEGORIES);
      for (const slug of h.categories) {
        expect(validSlugs.has(slug)).toBe(true);
      }
    }
  });

  it("writes lowercase wallets (migration 014 CHECK)", () => {
    for (const h of SEED_HUMANS) {
      expect(h.wallet).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });

  it("has unique wallets, so the upsert stays idempotent", () => {
    const wallets = SEED_HUMANS.map((h) => h.wallet);
    expect(new Set(wallets).size).toBe(wallets.length);
  });
});
