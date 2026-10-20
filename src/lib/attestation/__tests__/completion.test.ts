/**
 * completion.test.ts — signing the worker's completion attestation (CC-036, ADR-0008 A3).
 *
 * Signs with a throwaway Hardhat key and verifies the result the way an EAS SDK verifier
 * would: the signature recovers to the signer under the off-chain domain and types, and the
 * UID is the SDK's UID for the signed message (vectors pinned in offchain.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeAbiParameters, verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const mocks = vi.hoisted(() => ({
  getOnChainTask: vi.fn(),
  getTaskCompletion: vi.fn(),
  readEasDomainInputs: vi.fn(),
}));

vi.mock("@/lib/contracts/escrow", () => ({
  EAS_ADDRESS: "0x4200000000000000000000000000000000000021",
  getEscrowConfig: () => ({
    address: "0xc6aa99a8226b679C71945dd9545685896a91E4d3",
    chainId: 84532,
    chainName: "Base Sepolia",
  }),
  toTaskId: () => `0x${"ab".repeat(32)}`,
  getOnChainTask: mocks.getOnChainTask,
  getTaskCompletion: mocks.getTaskCompletion,
  readEasDomainInputs: mocks.readEasDomainInputs,
}));

// Hardhat account #0 — a published test key, never a real one.
const SIGNER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
vi.mock("@/lib/contracts/signer", () => ({ getPlatformAccount: async () => SIGNER }));

import {
  buildCompletionMessage,
  checkerHashFor,
  completionSalt,
  routeFor,
  signCompletionAttestation,
  CompletionAttestationError,
} from "../completion";
import { CompletionRoute, COMPLETION_FIELDS } from "../schema";
import { OFFCHAIN_ATTEST_TYPES, offchainDomain, offchainUid } from "../offchain";
import { getCheckerHash } from "@/lib/checker/hash";

const WORKER = "0x1234567890AbcdEF1234567890aBcdef12345678" as Address;
const AGENT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address;
const ESCROW = "0xc6aa99a8226b679C71945dd9545685896a91E4d3" as Address;
const TASK_ID = `0x${"ab".repeat(32)}` as Hex;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const EAS = "0x4200000000000000000000000000000000000021" as Address;

function onChainTask(overrides: Record<string, unknown> = {}) {
  return {
    agent: AGENT,
    worker: WORKER,
    amount: BigInt(25_000_000),
    state: "Completed",
    specHash: `0x${"0a".repeat(32)}`,
    evidenceHash: `0x${"0b".repeat(32)}`,
    verdictHash: `0x${"0c".repeat(32)}`,
    ...overrides,
  };
}

const COMPLETION = { routeRaw: 2, completedAt: BigInt(1760832000), amount: BigInt(25_000_000) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOnChainTask.mockResolvedValue(onChainTask());
  mocks.getTaskCompletion.mockResolvedValue(COMPLETION);
  // The real Base Sepolia values (chain-constants.json, read from chain 2026-08-31).
  mocks.readEasDomainInputs.mockResolvedValue({
    version: "1.2.0",
    domainSeparator: "0x64d609c088b8729a2fe70a363f7f8fa40a76a40dea7f87597fc4505053a8ac68",
  });
});

describe("routeFor", () => {
  it("passes contract routes 0–4 through unchanged", () => {
    for (const r of [0, 1, 2, 3, 4]) {
      expect(routeFor({ ...COMPLETION, routeRaw: r })).toBe(r);
    }
  });
  it("maps an owner ruling for the worker to ArbitrationRuling", () => {
    expect(routeFor({ ...COMPLETION, routeRaw: null })).toBe(CompletionRoute.ArbitrationRuling);
  });
  it("refuses a route the build does not know, including the off-contract value from the chain", () => {
    expect(() => routeFor({ ...COMPLETION, routeRaw: 5 })).toThrow(CompletionAttestationError);
    expect(() => routeFor({ ...COMPLETION, routeRaw: 9 })).toThrow(/Unknown completion route/);
  });
});

describe("checkerHashFor", () => {
  it("is zero when no verdict was presented", () => {
    expect(checkerHashFor(ZERO32)).toBe(ZERO32);
  });
  it("is the v1 checker hash when a verdict was presented", () => {
    expect(checkerHashFor(`0x${"0c".repeat(32)}`)).toBe(getCheckerHash());
  });
});

describe("buildCompletionMessage", () => {
  const build = () =>
    buildCompletionMessage({
      taskId: TASK_ID,
      escrow: ESCROW,
      chainId: 84532,
      onChain: onChainTask() as never,
      completion: COMPLETION,
    });

  it("is deterministic: the same completion always yields the same UID (A3.2)", () => {
    expect(offchainUid(build())).toBe(offchainUid(build()));
  });

  it("salts per chain, escrow and task", () => {
    const base = completionSalt(84532, ESCROW, TASK_ID);
    expect(completionSalt(8453, ESCROW, TASK_ID)).not.toBe(base);
    expect(completionSalt(84532, AGENT, TASK_ID)).not.toBe(base);
    expect(completionSalt(84532, ESCROW, `0x${"cd".repeat(32)}`)).not.toBe(base);
  });

  it("takes the recipient from the chain, lowercased, and encodes the record positionally", () => {
    const m = build();
    expect(m.recipient).toBe(WORKER.toLowerCase());
    expect(m.time).toBe(COMPLETION.completedAt);
    expect(m.revocable).toBe(false);
    const decoded = decodeAbiParameters(
      COMPLETION_FIELDS.map(({ name, type }) => ({ name, type })),
      m.data,
    );
    expect(decoded[0]).toBe(TASK_ID);
    expect((decoded[1] as string).toLowerCase()).toBe(ESCROW.toLowerCase());
    expect(decoded[2]).toBe(BigInt(84532));
    expect((decoded[3] as string).toLowerCase()).toBe(AGENT.toLowerCase());
    expect(decoded[4]).toBe(BigInt(25_000_000));
    expect(decoded[5]).toBe(CompletionRoute.PassingVerdict);
    expect(decoded[6]).toBe(COMPLETION.completedAt);
    expect(decoded[10]).toBe(getCheckerHash());
  });
});

describe("signCompletionAttestation", () => {
  it("signs a message an SDK verifier accepts, with the SDK's UID", async () => {
    const a = await signCompletionAttestation("pr", WORKER);
    expect(a.signer).toBe(SIGNER.address);
    expect(a.sig.domain).toEqual({
      name: "EAS Attestation",
      version: "1.2.0",
      chainId: "84532",
      verifyingContract: EAS,
    });

    const message = {
      version: 2,
      schema: a.sig.message.schema as Hex,
      recipient: a.sig.message.recipient as Address,
      time: BigInt(a.sig.message.time as string),
      expirationTime: BigInt(a.sig.message.expirationTime as string),
      revocable: a.sig.message.revocable as boolean,
      refUID: a.sig.message.refUID as Hex,
      data: a.sig.message.data as Hex,
      salt: a.sig.message.salt as Hex,
    };
    const { r, s, v } = a.sig.signature;
    const valid = await verifyTypedData({
      address: SIGNER.address,
      domain: offchainDomain(EAS, 84532, "1.2.0"),
      types: OFFCHAIN_ATTEST_TYPES,
      primaryType: "Attest",
      message,
      signature: `${r}${s.slice(2)}${v.toString(16).padStart(2, "0")}` as Hex,
    });
    expect(valid).toBe(true);
    expect(a.sig.uid).toBe(offchainUid(message));
  });

  it("returns the same UID when asked twice — one completion, one attestation", async () => {
    const [a, b] = [await signCompletionAttestation("pr"), await signCompletionAttestation("pr")];
    expect(a.sig.uid).toBe(b.sig.uid);
  });

  it("refuses a caller who is not the on-chain worker, before signing", async () => {
    const spy = vi.spyOn(SIGNER, "signTypedData");
    await expect(signCompletionAttestation("pr", AGENT)).rejects.toMatchObject({
      reason: "forbidden",
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("refuses a task that has not paid its worker", async () => {
    mocks.getOnChainTask.mockResolvedValue(onChainTask({ state: "Expired" }));
    mocks.getTaskCompletion.mockResolvedValue(null);
    await expect(signCompletionAttestation("pr", WORKER)).rejects.toMatchObject({
      reason: "not_completed",
    });
  });

  it("refuses to sign when the EAS version does not reproduce the chain's domain separator", async () => {
    mocks.readEasDomainInputs.mockResolvedValue({
      version: "1.3.0",
      domainSeparator: "0x64d609c088b8729a2fe70a363f7f8fa40a76a40dea7f87597fc4505053a8ac68",
    });
    await expect(signCompletionAttestation("pr", WORKER)).rejects.toThrow(/refusing to sign/);
  });
});
