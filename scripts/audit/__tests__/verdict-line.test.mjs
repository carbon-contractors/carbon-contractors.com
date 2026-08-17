import { describe, it, expect } from "vitest";
import { verdictLine } from "../verdict-line.mjs";
import { isTransient, shortError } from "../rpc-retry.mjs";

// The exact shape that produced a useless Discord alert on 2026-08-17: viem's message ends
// with its version footer, and the old fallback returned the last line.
const VIEM_CRASH = `── Concurrent escrow per funding agent ──
network   testnet (chain 84532)
block timestamp read failed: HttpRequestError: HTTP request failed.

Status: 429
URL: https://sepolia.base.org
Details: Too Many Requests

Version: viem@2.55.10`;

describe("verdictLine (CC-085)", () => {
  it("does not report viem's version footer as the verdict", () => {
    const line = verdictLine(VIEM_CRASH);

    expect(line).not.toBe("Version: viem@2.55.10");
    expect(line).not.toMatch(/^Version:/);
  });

  it("says the monitor crashed, and carries the diagnosable part", () => {
    const line = verdictLine(VIEM_CRASH);

    expect(line).toContain("CRASHED before reporting a verdict");
    expect(line).toContain("HttpRequestError");
    expect(line).toContain("Status: 429");
  });

  it("picks the verdict marker when one is present, not the last line", () => {
    const out = ["header noise", "CLEAN — both limbs have headroom.", "Version: viem@2.55.10"].join("\n");

    expect(verdictLine(out)).toBe("CLEAN — both limbs have headroom.");
  });

  it("recognises TRANSIENT as a verdict rather than treating it as a crash", () => {
    const out = "TRANSIENT — RPC unreachable after retries: HTTP request failed.";

    expect(verdictLine(out)).toBe(out);
    expect(verdictLine(out)).not.toContain("CRASHED");
  });

  it("appends the bullet detail that follows a violation", () => {
    const out = ["VIOLATION — 2 problem(s):", "· per-client limb over 80%", "· annual limb breached", "trailing noise"].join("\n");
    const line = verdictLine(out);

    expect(line).toContain("VIOLATION — 2 problem(s):");
    expect(line).toContain("· annual limb breached");
    expect(line).not.toContain("trailing noise");
  });

  it("survives empty output instead of throwing", () => {
    expect(verdictLine("")).toContain("no output");
  });

  it("ignores stack frames when looking for something useful", () => {
    const out = ["Error: boom", "    at foo (/a/b.mjs:1:1)", "    at bar (/a/c.mjs:2:2)"].join("\n");
    const line = verdictLine(out);

    expect(line).toContain("Error: boom");
    expect(line).not.toContain("at foo");
  });
});

describe("rpc-retry classification (CC-085)", () => {
  it("treats transport and rate-limit failures as transient", () => {
    for (const msg of [
      "HTTP request failed.\nStatus: 429",
      "fetch failed",
      "socket hang up",
      "connect ETIMEDOUT 1.2.3.4:443",
      "503 Service Unavailable",
    ]) {
      expect(isTransient(new Error(msg)), msg).toBe(true);
    }
  });

  it("does NOT retry a revert or a real contract error", () => {
    // Retrying these just delays a genuine finding — they are the alert, not noise.
    for (const msg of [
      "execution reverted: NotAgent()",
      "ContractFunctionExecutionError: The contract function reverted.",
      "Invalid address",
    ]) {
      expect(isTransient(new Error(msg)), msg).toBe(false);
    }
  });

  it("shortError takes the first line, not viem's version footer", () => {
    const err = new Error("HTTP request failed.\n\nStatus: 429\n\nVersion: viem@2.55.10");

    expect(shortError(err)).toBe("HTTP request failed.");
  });
});
