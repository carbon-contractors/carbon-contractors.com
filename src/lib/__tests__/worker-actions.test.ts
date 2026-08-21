import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";
import {
  ZERO_BYTES32,
  computeEvidenceHash,
  parseBytes32,
  paymentIdToTaskId,
  toVerdictTuple,
} from "@/lib/contracts/worker-actions";

describe("worker-actions (CC-092 client helpers)", () => {
  it("derives taskId the same way the server's toTaskId does", () => {
    expect(paymentIdToTaskId("pr_1")).toBe(keccak256(toHex("pr_1")));
  });

  it("hashes evidence with the same rule the verdict service uses", () => {
    // hashVerdictField parity — a verdict's evidenceHash must equal what the
    // worker's dashboard would commit for the same evidence string.
    expect(computeEvidenceHash("3 photos of the meter")).toBe(
      keccak256(toHex("3 photos of the meter")),
    );
  });

  it("parseBytes32 accepts a real bytes32 and rejects junk", () => {
    expect(parseBytes32(`0x${"ab".repeat(32)}`)).toBe(`0x${"ab".repeat(32)}`);
    expect(parseBytes32("")).toBeNull();
    expect(parseBytes32("   ")).toBeNull();
    expect(parseBytes32("0x1234")).toBeNull();
    // 63 and 65 hex chars are both wrong — exactly 32 bytes or nothing.
    expect(parseBytes32(`0x${"a".repeat(63)}`)).toBeNull();
    expect(parseBytes32(`0x${"a".repeat(65)}`)).toBeNull();
  });

  it("toVerdictTuple restores bigint expiry/nonce from the serialized strings", () => {
    const tuple = toVerdictTuple({
      taskId: `0x${"a".repeat(64)}`,
      specHash: `0x${"b".repeat(64)}`,
      evidenceHash: `0x${"c".repeat(64)}`,
      checkerHash: `0x${"d".repeat(64)}`,
      passed: true,
      breakdownHash: ZERO_BYTES32,
      expiry: "1800003600",
      nonce: "42",
    });
    expect(tuple.expiry).toBe(BigInt(1800003600));
    expect(tuple.nonce).toBe(BigInt(42));
    expect(tuple.passed).toBe(true);
    expect(tuple.taskId).toBe(`0x${"a".repeat(64)}`);
  });
});
