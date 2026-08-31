/**
 * escrow-abi-drift.test.ts — reading an escrow older than the ABI.
 *
 * ## The failure this exists for
 *
 * The app's ABI and the deployed bytecode are separate pieces of config. `escrow-abi.ts`
 * is generated from `contracts/`, and `NEXT_PUBLIC_ESCROW_CONTRACT` is an environment
 * variable, so "new code against an old address" is a normal intermediate state at every
 * redeploy — not an error condition.
 *
 * PR #153 added `Task.disputedAt` (ADR-0006 D3) and regenerated the ABI. The deployed
 * Sepolia contract predates it, so `getTask` returned twelve words against a thirteen-word
 * ABI and viem threw. `/api/tasks` caught that into `on_chain: null`, and the dashboard —
 * which gates every worker action on `task.on_chain` — silently dropped the submit button,
 * the claim button, and the on-chain badge. No error anywhere. A worker owed money would
 * have seen an empty card.
 *
 * Two properties are pinned here, and the second is the one a mock cannot reach:
 *
 *  1. the mismatch is **detected and recovered**, not swallowed and not fatal;
 *  2. `LEGACY_GET_TASK_ABI`'s field order is **actually right**.
 *
 * (2) needs real ABI decoding, so these tests build genuine returndata with
 * `encodeAbiParameters` and answer `eth_call` with it through a stub transport. A test
 * that mocked `readContract` and handed back a decoded object would pass just as happily
 * with the tuple in the wrong order, and the symptom of that is `amount` decoding out of
 * `specHash` — a wrong number reported confidently, which is worse than the throw.
 *
 * Hermetic (CC-060): the transport is a function, so nothing reaches the network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  encodeAbiParameters,
  type AbiParameter,
  type EIP1193RequestFn,
} from "viem";

const ESCROW = "0xb9bF8dAC51f62cA237F2C439c63c9D8f16FD2ef7";
const AGENT = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const SPEC_HASH = ("0x" + "aa".repeat(32)) as `0x${string}`;
const EVIDENCE_HASH = ("0x" + "bb".repeat(32)) as `0x${string}`;
const VERDICT_HASH = ("0x" + "cc".repeat(32)) as `0x${string}`;
const ATTESTATION = ("0x" + "dd".repeat(32)) as `0x${string}`;

const AMOUNT = BigInt(25_000_000); // 25 USDC — a value that is obvious when decoded wrongly
const DEADLINE = BigInt(1_800_000_000);
const SUBMITTED_AT = BigInt(1_790_000_000);
const REVIEW_WINDOW = 259_200; // 72h
const DISPUTED_AT = BigInt(1_790_100_000);
const ARBITRATION_WINDOW = 7 * 24 * 60 * 60;

/**
 * The twelve-field struct as every escrow deployed before 2026-08-28 returns it.
 * Duplicated from the frozen constant in escrow.ts on purpose — a test that imported
 * the thing it is checking would pass under any wrong-but-self-consistent order.
 */
const LEGACY_FIELDS: readonly AbiParameter[] = [
  { name: "agent", type: "address" },
  { name: "deadline", type: "uint64" },
  { name: "reviewWindow", type: "uint32" },
  { name: "worker", type: "address" },
  { name: "submittedAt", type: "uint64" },
  { name: "state", type: "uint8" },
  { name: "verdictPassed", type: "bool" },
  { name: "amount", type: "uint256" },
  { name: "specHash", type: "bytes32" },
  { name: "evidenceHash", type: "bytes32" },
  { name: "verdictHash", type: "bytes32" },
  { name: "attestationUid", type: "bytes32" },
];

/** The current struct: identical, with disputedAt inserted after verdictPassed. */
const CURRENT_FIELDS: readonly AbiParameter[] = [
  ...LEGACY_FIELDS.slice(0, 7),
  { name: "disputedAt", type: "uint64" },
  ...LEGACY_FIELDS.slice(7),
];

/**
 * `fields` decides whether `disputedAt` is on the wire at all — that is what makes a
 * "legacy deployment" legacy. `disputedAt` is the value when it is, and viem ignores a
 * value whose component is absent, so the two are independent on purpose.
 */
function encodeTask(
  fields: readonly AbiParameter[],
  state: number,
  disputedAt: bigint = BigInt(0),
) {
  const values: Record<string, unknown> = {
    agent: AGENT,
    deadline: DEADLINE,
    reviewWindow: REVIEW_WINDOW,
    worker: WORKER,
    submittedAt: SUBMITTED_AT,
    state,
    verdictPassed: false,
    amount: AMOUNT,
    specHash: SPEC_HASH,
    evidenceHash: EVIDENCE_HASH,
    verdictHash: VERDICT_HASH,
    attestationUid: ATTESTATION,
    disputedAt,
  };
  // `as never` rather than a structural type: viem types the values array positionally
  // against the params, and the whole point here is to feed it a shape the current ABI
  // does not describe.
  return encodeAbiParameters(
    [{ type: "tuple", components: fields as AbiParameter[] }],
    [values] as never,
  );
}

type CallAnswer = { data?: `0x${string}`; throws?: unknown };

/**
 * What the stub transport answers eth_call with, in order.
 *
 * A queue rather than a single value, because the fallback makes a *second* eth_call and
 * the two answers have to be able to differ. With one shared answer the "unrelated error"
 * test passed for the wrong reason: a broadened matcher fired the fallback, the fallback
 * hit the same throwing answer, and the call rejected anyway — so the test could not tell
 * a narrow matcher from a broad one. Mutation-testing found that; the queue fixes it.
 */
let callQueue: CallAnswer[] = [];

/** The last answer repeats, so a test that only cares about one call passes one. */
function nextAnswer(): CallAnswer {
  return callQueue.length > 1 ? callQueue.shift()! : (callQueue[0] ?? {});
}

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  const request: EIP1193RequestFn = (async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return "0x14a34"; // Base Sepolia
    if (method === "eth_call") {
      const answer = nextAnswer();
      if (answer.throws) throw answer.throws;
      return answer.data;
    }
    throw new Error(`unexpected RPC method in a hermetic test: ${method}`);
  }) as EIP1193RequestFn;

  return {
    ...actual,
    // A REAL client over a stub transport, so viem's own ABI decoding runs. That is the
    // whole point: it is the decoder, not our dispatch logic, that catches a wrong tuple.
    //
    // `batch` is dropped deliberately. escrow.ts enables batch.multicall (CC-070), which
    // rewrites even a single readContract into an aggregate3 call against multicall3 —
    // so the stub would be answering a multicall with a Task struct, and the decode error
    // that produces looks exactly like the width mismatch these tests are about. Testing
    // the decoder means the call has to reach the decoder unwrapped.
    createPublicClient: (args: Record<string, unknown>) => {
      const withoutBatch = { ...args };
      delete withoutBatch.batch;
      return actual.createPublicClient({
        ...withoutBatch,
        // retryCount 0 is not a detail. viem's transports retry three times by default,
        // so a queued failure was silently retried into the NEXT queued answer — the
        // "unrelated read failure" test saw a success and could not tell the fallback
        // fired from the transport papering over the throw.
        transport: actual.custom({ request }, { retryCount: 0 }),
      } as Parameters<typeof actual.createPublicClient>[0]);
    },
  };
});

function stubEnv() {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
  vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
  vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  vi.stubEnv("NEXT_PUBLIC_ESCROW_CONTRACT", ESCROW);
}

describe("getOnChainTask against an escrow older than the ABI", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    stubEnv();
    callQueue = [];
  });

  it("decodes the legacy twelve-field struct correctly and flags the missing clock", async () => {
    // Every assertion below is really an assertion about LEGACY_GET_TASK_ABI's field
    // ORDER. Get it wrong and these do not fail cleanly — amount decodes out of
    // specHash and the numbers come back plausible-looking and false.
    callQueue = [{ data: encodeTask(LEGACY_FIELDS, 4 /* Disputed */) }];

    const { getOnChainTask } = await import("@/lib/contracts/escrow");
    const task = await getOnChainTask("pr_legacy");

    expect(task.agent.toLowerCase()).toBe(AGENT);
    expect(task.worker.toLowerCase()).toBe(WORKER);
    expect(task.amount).toBe(AMOUNT);
    expect(task.deadline).toBe(DEADLINE);
    expect(task.state).toBe("Disputed");
    expect(task.reviewWindow).toBe(REVIEW_WINDOW);
    expect(task.submittedAt).toBe(SUBMITTED_AT);
    expect(task.specHash).toBe(SPEC_HASH);
    expect(task.evidenceHash).toBe(EVIDENCE_HASH);
    expect(task.verdictHash).toBe(VERDICT_HASH);
    expect(task.attestationUid).toBe(ATTESTATION);

    // The point of the flag: this deployment has no clock, so there is nothing to
    // claim and the dashboard must not offer a button that would revert.
    expect(task.arbitrationClock).toBe(false);
    expect(task.disputedAt).toBe(BigInt(0));
  });

  it("reads disputedAt and the arbitration deadline from a current deployment", async () => {
    callQueue = [{ data: encodeTask(CURRENT_FIELDS, 4 /* Disputed */, DISPUTED_AT) }];

    const { getOnChainTask } = await import("@/lib/contracts/escrow");
    const task = await getOnChainTask("pr_current");

    expect(task.arbitrationClock).toBe(true);
    expect(task.disputedAt).toBe(DISPUTED_AT);
    expect(task.arbitrationDeadline).toBe(DISPUTED_AT + BigInt(ARBITRATION_WINDOW));
    // Unchanged fields still land where they should — the insert did not shift anything.
    expect(task.amount).toBe(AMOUNT);
    expect(task.specHash).toBe(SPEC_HASH);
  });

  it("leaves the deadline in 1970 for a task that was never disputed", async () => {
    // Deliberately not clamped to null. arbitrationDeadline is documented as meaningless
    // while disputedAt is 0, and every caller gates on state — but if one ever forgets,
    // a 1970 timestamp is a value that looks wrong on sight rather than one that reads
    // as "claimable now" in a comparison.
    callQueue = [{ data: encodeTask(CURRENT_FIELDS, 2 /* Delivered */) }];

    const { getOnChainTask } = await import("@/lib/contracts/escrow");
    const task = await getOnChainTask("pr_delivered");

    expect(task.state).toBe("Delivered");
    expect(task.disputedAt).toBe(BigInt(0));
    expect(task.arbitrationDeadline).toBe(BigInt(ARBITRATION_WINDOW));
    expect(task.arbitrationClock).toBe(true);
  });

  it("does not treat an unrelated read failure as an old deployment", async () => {
    // The guard that keeps the fallback honest. Retrying on ANY error would report the
    // legacy shape for a wrong address, a reverting call or an RPC fault — inventing a
    // task rather than failing.
    //
    // The two answers must differ for this to prove anything: the first call fails with
    // something that is not a width mismatch, and the second would succeed. A narrow
    // matcher never makes the second call and the caller sees the failure. A broad one
    // swallows a network fault and returns a task that reads as real.
    callQueue = [
      { throws: new Error("connection reset by peer") },
      { data: encodeTask(LEGACY_FIELDS, 4 /* Disputed */) },
    ];

    const { getOnChainTask } = await import("@/lib/contracts/escrow");
    await expect(getOnChainTask("pr_broken")).rejects.toThrow();
  });

  it("does not fall back when the returndata is wider than the ABI", async () => {
    // The other direction: an escrow NEWER than this build. Decoding succeeds — viem
    // ignores trailing words — so there is nothing to detect and nothing to recover.
    // Asserted so the asymmetry is deliberate rather than discovered: this build can
    // read a future contract's first thirteen fields, and any fourteenth is invisible
    // to it. If a later field ever becomes load-bearing, that is a code change here,
    // not something the fallback will paper over.
    const wider: readonly AbiParameter[] = [
      ...CURRENT_FIELDS,
      { name: "somethingLater", type: "uint256" },
    ];
    callQueue = [
      {
        data: encodeAbiParameters(
          [{ type: "tuple", components: wider as AbiParameter[] }],
          [
            {
              agent: AGENT,
              deadline: DEADLINE,
              reviewWindow: REVIEW_WINDOW,
              worker: WORKER,
              submittedAt: SUBMITTED_AT,
              state: 4,
              verdictPassed: false,
              disputedAt: DISPUTED_AT,
              amount: AMOUNT,
              specHash: SPEC_HASH,
              evidenceHash: EVIDENCE_HASH,
              verdictHash: VERDICT_HASH,
              attestationUid: ATTESTATION,
              somethingLater: BigInt(99),
            },
          ] as never,
        ),
      },
    ];

    const { getOnChainTask } = await import("@/lib/contracts/escrow");
    const task = await getOnChainTask("pr_future");

    expect(task.arbitrationClock).toBe(true);
    expect(task.disputedAt).toBe(DISPUTED_AT);
    expect(task.amount).toBe(AMOUNT);
  });
});
