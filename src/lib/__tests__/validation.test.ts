import { describe, it, expect } from "vitest";
import { isValidWalletAddress, isValidEmail, MAX_EMAIL_LEN } from "@/lib/validation";

describe("isValidWalletAddress", () => {
  it("accepts a well-formed 0x address", () => {
    expect(isValidWalletAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe(true);
  });

  it("rejects a wrong-length or missing-prefix string", () => {
    expect(isValidWalletAddress("1234567890abcdef1234567890abcdef12345678")).toBe(false);
    expect(isValidWalletAddress("0x1234")).toBe(false);
  });
});

describe("isValidEmail", () => {
  it("accepts a plausible email address", () => {
    expect(isValidEmail("worker@example.com")).toBe(true);
  });

  it("rejects a string with no @ or domain", () => {
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("worker@")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidEmail("")).toBe(false);
  });

  it("rejects an address over the RFC 5321 length bound", () => {
    const long = "a".repeat(MAX_EMAIL_LEN) + "@example.com";
    expect(isValidEmail(long)).toBe(false);
  });
});
