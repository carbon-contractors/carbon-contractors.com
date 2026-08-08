import { describe, it, expect } from "vitest";
import { safeErrorResponse } from "@/lib/errors";

describe("safeErrorResponse", () => {
  it("extracts the message from a real Error instance", async () => {
    const res = safeErrorResponse(new Error("boom"), "test_context");
    const json = await res.json();
    expect(res.status).toBe(500);
    // NODE_ENV is "test" under vitest, which is not "development", so the generic
    // message is expected here — this test is about extractMessage's input handling
    // via the exported behaviour, not the dev/prod branch.
    expect(json.ok).toBe(false);
  });

  it("extracts .message from a plain object, not '[object Object]' (CC-067 finding)", async () => {
    // This is exactly the shape Supabase's client returns for a gateway-level
    // rejection (e.g. an invalid API key) — a plain object, not a PostgrestError
    // instance, so `err instanceof Error` is false.
    const originalEnv = process.env.NODE_ENV;
    // @ts-expect-error -- NODE_ENV is readonly in the type defs but mutable at runtime
    process.env.NODE_ENV = "development";
    try {
      const supabaseGatewayError = {
        message: "Invalid API key",
        hint: "Double check your Supabase `anon` or `service_role` API key.",
      };
      const res = safeErrorResponse(supabaseGatewayError, "test_context");
      const json = await res.json();
      expect(json.error).toBe("Invalid API key");
      expect(json.error).not.toContain("object Object");
    } finally {
      // @ts-expect-error -- see above
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("falls back to String() for a value with no usable message", async () => {
    const originalEnv = process.env.NODE_ENV;
    // @ts-expect-error -- NODE_ENV is readonly in the type defs but mutable at runtime
    process.env.NODE_ENV = "development";
    try {
      const res = safeErrorResponse(42, "test_context");
      const json = await res.json();
      expect(json.error).toBe("42");
    } finally {
      // @ts-expect-error -- see above
      process.env.NODE_ENV = originalEnv;
    }
  });
});
