/**
 * Reusable Supabase mock for tests.
 * Returns a chainable builder that mimics the Supabase client API.
 */

import { vi } from "vitest";

export interface MockQueryResult {
  data: unknown;
  error: null | { message: string; code?: string };
}

export function createMockSupabase(result: MockQueryResult) {
  const chainable = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    contains: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    // NOR-322: the session library filters on null checks and ranges and reads
    // single-or-nothing rows.
    is: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    single: vi.fn().mockResolvedValue(result),
    then: vi.fn((cb) =>
      cb(result)
    ),
  };

  // Make non-single queries resolve directly
  chainable.order.mockResolvedValue(result);
  chainable.limit.mockResolvedValue(result);
  chainable.select.mockReturnValue(chainable);
  chainable.contains.mockReturnValue(chainable);

  const mockClient = {
    from: vi.fn().mockReturnValue(chainable),
  };

  return { mockClient, chainable };
}
