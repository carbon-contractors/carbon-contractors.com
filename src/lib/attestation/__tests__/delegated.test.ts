/**
 * delegated.test.ts — the on-demand delegated publish request (CC-036, ADR-0008 A2.3).
 *
 * The central check rebuilds the digest exactly as EAS's `_verifyAttest` does in the
 * deployed source (1.2.0 and 1.0.1, Basescan 2026-10-19) — abi.encode of the typehash and
 * fields with keccak256(data), under the chain's domain separator — without going through
 * viem's typed-data path, and recovers the signer from the calldata's own (v, r, s). If that
 * recovers to the attester, EAS will accept the request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  recoverAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const mocks = vi.hoisted(() => ({
  getOnChainTask: vi.fn(),
  getTaskCompletion: vi.fn(),
  readEasDelegationInputs: vi.fn(),
  escrowConfig: { chainId: 84532 },
}));

vi.mock("@/lib/contracts/escrow", () => ({
  EAS_ADDRESS: "0x4200000000000000000000000000000000000021",
  getEscrowConfig: () => ({
    address: "0xc6aa99a8226b679C71945dd9545685896a91E4d3",
    chainId: mocks.escrowConfig.chainId,
    chainName: "test",
  }),
  toTaskId: () => `0x${"ab".repeat(32)}`,
  getOnChainTask: mocks.getOnChainTask,
  getTaskCompletion: mocks.getTaskCompletion,
  readEasDelegationInputs: mocks.readEasDelegationInputs,
  readEasDomainInputs: vi.fn(),
}));

const SIGNER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
vi.mock("@/lib/contracts/signer", () => ({ getPlatformAccount: async () => SIGNER }));

import {
  ATTEST_BY_DELEGATION_NO_DEADLINE,
  ATTEST_BY_DELEGATION_WITH_DEADLINE,
  signDelegatedCompletionRequest,
} from "../delegated";
import { completionSchemaUid } from "../schema";

const WORKER = "0x1234567890AbcdEF1234567890aBcdef12345678" as Address;
const AGENT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address;
const NOW = 1_760_900_000;

// Recorded chain values (chain-constants.json): the typehash selects the struct.
const NETWORKS = {
  "base-sepolia": {
    chainId: 84532,
    version: "1.2.0",
    domainSeparator: "0x64d609c088b8729a2fe70a363f7f8fa40a76a40dea7f87597fc4505053a8ac68" as Hex,
    attestTypeHash: "0xf83bb2b0ede93a840239f7e701a54d9bc35f03701f51ae153d601c6947ff3d3f" as Hex,
  },
  "base-mainnet": {
    chainId: 8453,
    version: "1.0.1",
    domainSeparator: "0x441f04bd3fc4b9bbef0e92ccbdd47cebd80211d531918066401ffc7c91fd954b" as Hex,
    attestTypeHash: "0xdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de61" as Hex,
  },
} as const;

function useNetwork(name: keyof typeof NETWORKS, nonce = BigInt(7)) {
  const n = NETWORKS[name];
  mocks.escrowConfig.chainId = n.chainId;
  mocks.readEasDelegationInputs.mockResolvedValue({
    version: n.version,
    domainSeparator: n.domainSeparator,
    attestTypeHash: n.attestTypeHash,
    nonce,
  });
  return n;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOnChainTask.mockResolvedValue({
    agent: AGENT,
    worker: WORKER,
    amount: BigInt(25_000_000),
    state: "Completed",
    specHash: `0x${"0a".repeat(32)}`,
    evidenceHash: `0x${"0b".repeat(32)}`,
    verdictHash: `0x${"00".repeat(32)}`,
  });
  mocks.getTaskCompletion.mockResolvedValue({
    routeRaw: 1,
    completedAt: BigInt(1_760_832_000),
    amount: BigInt(25_000_000),
  });
});

describe("signDelegatedCompletionRequest", () => {
  it("base-sepolia (1.2.0): EAS's own digest recovers to the attester, deadline included", async () => {
    const n = useNetwork("base-sepolia");
    const r = await signDelegatedCompletionRequest("pr", WORKER, NOW);
    expect(r.to).toBe("0x4200000000000000000000000000000000000021");
    expect(r.attester).toBe(SIGNER.address);
    expect(r.deadline).toBe(String(NOW + 3600));
    expect(r.nonce).toBe("7");

    const { args } = decodeFunctionData({ abi: ATTEST_BY_DELEGATION_WITH_DEADLINE, data: r.calldata });
    const req = args[0];
    expect(req.schema).toBe(completionSchemaUid());
    expect(req.data.recipient.toLowerCase()).toBe(WORKER.toLowerCase());
    expect(req.data.value).toBe(BigInt(0));
    expect(req.data.revocable).toBe(false);
    expect(req.attester).toBe(SIGNER.address);

    // EAS 1.2.0 _verifyAttest, transcribed: nonce is the attester's current one.
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint64" },
          { type: "bool" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" },
          { type: "uint256" }, { type: "uint64" },
        ],
        [
          n.attestTypeHash, req.schema, req.data.recipient, req.data.expirationTime,
          req.data.revocable, req.data.refUID, keccak256(req.data.data), req.data.value,
          BigInt(7), req.deadline,
        ],
      ),
    );
    const digest = keccak256(concat(["0x1901", n.domainSeparator, structHash]));
    const { v, r: sr, s } = req.signature;
    const recovered = await recoverAddress({
      hash: digest,
      signature: concat([sr, s, `0x${v.toString(16).padStart(2, "0")}`]),
    });
    expect(recovered).toBe(SIGNER.address);
  });

  it("base-mainnet (1.0.1): no value or deadline in the signed struct, none in the calldata", async () => {
    const n = useNetwork("base-mainnet", BigInt(0));
    const r = await signDelegatedCompletionRequest("pr", WORKER, NOW);
    expect(r.deadline).toBeNull();

    const { args } = decodeFunctionData({ abi: ATTEST_BY_DELEGATION_NO_DEADLINE, data: r.calldata });
    const req = args[0];
    expect("deadline" in req).toBe(false);

    // EAS 1.0.1 _verifyAttest, transcribed.
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint64" },
          { type: "bool" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" },
        ],
        [
          n.attestTypeHash, req.schema, req.data.recipient, req.data.expirationTime,
          req.data.revocable, req.data.refUID, keccak256(req.data.data), BigInt(0),
        ],
      ),
    );
    const digest = keccak256(concat(["0x1901", n.domainSeparator, structHash]));
    const { v, r: sr, s } = req.signature;
    const recovered = await recoverAddress({
      hash: digest,
      signature: concat([sr, s, `0x${v.toString(16).padStart(2, "0")}`]),
    });
    expect(recovered).toBe(SIGNER.address);
  });

  it("encodes different selectors for the two struct shapes, so neither can be sent to the other", async () => {
    useNetwork("base-sepolia");
    const sepolia = await signDelegatedCompletionRequest("pr", WORKER, NOW);
    useNetwork("base-mainnet");
    const mainnet = await signDelegatedCompletionRequest("pr", WORKER, NOW);
    expect(sepolia.calldata.slice(0, 10)).not.toBe(mainnet.calldata.slice(0, 10));
  });

  it("signs at whatever nonce the chain reports now — never a cached one", async () => {
    useNetwork("base-sepolia", BigInt(41));
    expect((await signDelegatedCompletionRequest("pr", WORKER, NOW)).nonce).toBe("41");
    useNetwork("base-sepolia", BigInt(42));
    expect((await signDelegatedCompletionRequest("pr", WORKER, NOW)).nonce).toBe("42");
    expect(mocks.readEasDelegationInputs).toHaveBeenCalledTimes(2);
  });

  it("refuses a non-worker before reading the nonce or signing", async () => {
    useNetwork("base-sepolia");
    const spy = vi.spyOn(SIGNER, "signTypedData");
    await expect(signDelegatedCompletionRequest("pr", AGENT, NOW)).rejects.toMatchObject({
      reason: "forbidden",
    });
    expect(mocks.readEasDelegationInputs).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("refuses the EIP712Proxy's typehash by name (A1.4)", async () => {
    useNetwork("base-sepolia");
    mocks.readEasDelegationInputs.mockResolvedValue({
      ...NETWORKS["base-sepolia"],
      attestTypeHash: "0xea02ffba7dcb45f6fc649714d23f315eef12e3b27f9a7735d8d8bf41eb2b1af1",
      nonce: BigInt(0),
    });
    await expect(signDelegatedCompletionRequest("pr", WORKER, NOW)).rejects.toThrow(/proxy/);
  });

  it("refuses when the version does not reproduce the chain's domain separator", async () => {
    useNetwork("base-sepolia");
    mocks.readEasDelegationInputs.mockResolvedValue({
      ...NETWORKS["base-sepolia"],
      version: "1.3.0",
      nonce: BigInt(0),
    });
    await expect(signDelegatedCompletionRequest("pr", WORKER, NOW)).rejects.toThrow(/refusing to sign/);
  });
});
