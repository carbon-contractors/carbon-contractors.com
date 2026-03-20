import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getSupabase: () => ({ from: mockFrom }),
}));

vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_ANON_KEY", "key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_ONCHAINKIT_API_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

import {
  searchBySkill,
  getAllHumans,
  getHumanByWallet,
  getDistinctSkills,
} from "@/lib/db/whitepages";

function makeChain(result: { data: unknown; error: unknown }) {
  // Every method returns the chain itself, with the last call resolving
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => chain;

  chain.select = vi.fn().mockImplementation(self);
  chain.contains = vi.fn().mockImplementation(self);
  chain.eq = vi.fn().mockImplementation(self);
  chain.order = vi.fn().mockImplementation(self);
  chain.single = vi.fn().mockResolvedValue(result);

  // Make the chain itself thenable (for await without .single())
  chain.then = vi.fn((resolve) => resolve(result));

  return chain;
}

describe("whitepages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searchBySkill queries with contains and returns results", async () => {
    const humans = [
      { wallet: "0xA", skills: ["solidity"], reputation_score: 90 },
    ];
    const chain = makeChain({ data: humans, error: null });
    mockFrom.mockReturnValue(chain);

    const results = await searchBySkill("solidity");
    expect(results).toEqual(humans);
    expect(mockFrom).toHaveBeenCalledWith("humans");
    expect(chain.contains).toHaveBeenCalledWith("skills", ["solidity"]);
    expect(chain.order).toHaveBeenCalledTimes(2);
  });

  it("getAllHumans returns full list", async () => {
    const humans = [{ wallet: "0x1" }, { wallet: "0x2" }];
    const chain = makeChain({ data: humans, error: null });
    mockFrom.mockReturnValue(chain);

    const results = await getAllHumans();
    expect(results).toHaveLength(2);
  });

  it("getHumanByWallet returns single human", async () => {
    const human = { id: "1", wallet: "0xABC" };
    const chain = makeChain({ data: human, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getHumanByWallet("0xABC");
    expect(result).toEqual(human);
  });

  it("getDistinctSkills returns deduplicated sorted skills", async () => {
    const humans = [
      { skills: ["solidity", "typescript"] },
      { skills: ["typescript", "rust"] },
    ];
    const chain = makeChain({ data: humans, error: null });
    mockFrom.mockReturnValue(chain);

    const skills = await getDistinctSkills();
    expect(skills).toEqual(["rust", "solidity", "typescript"]);
  });
});
