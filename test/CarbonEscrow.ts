/**
 * test/CarbonEscrow.ts — CC-082
 *
 * The first Solidity tests this repo has had. That is not incidental: CarbonEscrow v1
 * shipped, was deployed, and was described in CLAUDE.md as working, while containing a
 * defect (CC-080) that made its central function unreachable by anyone. Nothing caught it
 * because nothing ever executed the contract.
 *
 * So the suite is organised around the *properties* ADR-0001 claims, not around function
 * coverage. Each describe block below names a property, and the tests exist to make that
 * property fail loudly if someone changes the state machine underneath it.
 *
 * Run with `npm run test:contracts`. Hermetic by construction — every test runs against
 * an edr-simulated network with a MockERC20 stand-in for USDC, so CC-060's rule that a
 * test never touches a live network holds here too.
 */

import { expect } from "chai";
import { network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

const { ethers, networkHelpers } = await network.create();
const { time, loadFixture } = networkHelpers;

/**
 * `ethers.deployContract` returns a bare `BaseContract` — the hardhat-typechain plugin is
 * configured but emits nothing under Hardhat 3, so there are no generated per-contract
 * types to bind to. Method names are therefore checked at runtime by the suite
 * below rather than by tsc. If typechain starts emitting, replace this with the generated
 * `CarbonEscrow` / `MockERC20` types and the call sites need no other change.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DeployedContract = any;

// ── Fixtures and helpers ──────────────────────────────────────────────────────

const USDC_DECIMALS = 6;
const AMOUNT = 25_000_000n; // 25 USDC
const REVIEW_WINDOW = 72 * 60 * 60; // 72h, comfortably inside MIN..MAX
const DEADLINE_OFFSET = 7 * 24 * 60 * 60; // 7 days

const TASK_ID = ethers.keccak256(ethers.toUtf8Bytes("payment-request-1"));
const SPEC_HASH = ethers.keccak256(ethers.toUtf8Bytes("acceptance-spec-v1"));
const EVIDENCE_HASH = ethers.keccak256(ethers.toUtf8Bytes("evidence-bundle"));
const CHECKER_HASH = ethers.keccak256(ethers.toUtf8Bytes("checker-bundle-v1"));
const BREAKDOWN_HASH = ethers.keccak256(ethers.toUtf8Bytes("per-check-breakdown"));
const ATTESTATION_UID = ethers.keccak256(ethers.toUtf8Bytes("eas-uid"));
const ZERO_BYTES32 = ethers.ZeroHash;

const State = {
  None: 0n,
  Funded: 1n,
  Delivered: 2n,
  Completed: 3n,
  Disputed: 4n,
  Arbitrating: 5n,
  Resolved: 6n,
  Expired: 7n,
} as const;

const Route = { AgentConfirmed: 0n, ReviewElapsed: 1n, PassingVerdict: 2n } as const;

const VERDICT_TYPES = {
  Verdict: [
    { name: "taskId", type: "bytes32" },
    { name: "specHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "checkerHash", type: "bytes32" },
    { name: "passed", type: "bool" },
    { name: "breakdownHash", type: "bytes32" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

interface VerdictValue {
  taskId: string;
  specHash: string;
  evidenceHash: string;
  checkerHash: string;
  passed: boolean;
  breakdownHash: string;
  expiry: bigint;
  nonce: bigint;
}

async function deployFixture() {
  const [deployer, agent, worker, verdictSigner, outsider] = await ethers.getSigners();

  const usdc: DeployedContract = await ethers.deployContract("MockERC20", [
    "USD Coin",
    "USDC",
    USDC_DECIMALS,
  ]);
  await usdc.waitForDeployment();

  const escrow: DeployedContract = await ethers.deployContract("CarbonEscrow", [
    await usdc.getAddress(),
    verdictSigner.address,
  ]);
  await escrow.waitForDeployment();

  // Fund the agent generously — several tests create more than one task.
  await usdc.mint(agent.address, AMOUNT * 100n);
  await usdc.connect(agent).approve(await escrow.getAddress(), AMOUNT * 100n);

  return { usdc, escrow, deployer, agent, worker, verdictSigner, outsider };
}

/** Funds a task with the standard parameters. Returns the deadline actually used. */
async function fund(
  escrow: DeployedContract,
  agent: HardhatEthersSigner,
  worker: HardhatEthersSigner,
  overrides: {
    taskId?: string;
    amount?: bigint;
    deadlineOffset?: number;
    reviewWindow?: number;
    specHash?: string;
  } = {},
) {
  const deadline = BigInt((await time.latest()) + (overrides.deadlineOffset ?? DEADLINE_OFFSET));
  await escrow
    .connect(agent)
    .createTask(
      overrides.taskId ?? TASK_ID,
      worker.address,
      overrides.amount ?? AMOUNT,
      deadline,
      overrides.reviewWindow ?? REVIEW_WINDOW,
      overrides.specHash ?? SPEC_HASH,
    );
  return deadline;
}

/** Funds a task and submits work against it — the state most tests start from. */
async function fundAndSubmit(
  escrow: DeployedContract,
  agent: HardhatEthersSigner,
  worker: HardhatEthersSigner,
  overrides: Parameters<typeof fund>[3] = {},
) {
  const deadline = await fund(escrow, agent, worker, overrides);
  await escrow
    .connect(worker)
    .submitWork(
      overrides.taskId ?? TASK_ID,
      EVIDENCE_HASH,
      overrides.specHash ?? SPEC_HASH,
      ZERO_BYTES32,
    );
  return deadline;
}

function buildVerdict(overrides: Partial<VerdictValue> = {}): VerdictValue {
  return {
    taskId: TASK_ID,
    specHash: SPEC_HASH,
    evidenceHash: EVIDENCE_HASH,
    checkerHash: CHECKER_HASH,
    passed: true,
    breakdownHash: BREAKDOWN_HASH,
    expiry: 2_000_000_000n,
    nonce: 1n,
    ...overrides,
  };
}

async function signVerdict(
  escrow: DeployedContract,
  signer: HardhatEthersSigner,
  verdict: VerdictValue,
  domainOverrides: Record<string, unknown> = {},
) {
  const domain = {
    name: "CarbonEscrow",
    version: "2",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await escrow.getAddress(),
    ...domainOverrides,
  };
  return signer.signTypedData(domain, VERDICT_TYPES, verdict);
}

/** The tuple order createTask/claim functions expect for a Verdict calldata argument. */
function asTuple(v: VerdictValue) {
  return [
    v.taskId,
    v.specHash,
    v.evidenceHash,
    v.checkerHash,
    v.passed,
    v.breakdownHash,
    v.expiry,
    v.nonce,
  ];
}

// ── Deployment ────────────────────────────────────────────────────────────────

describe("CarbonEscrow — deployment", () => {
  it("records the USDC address and the deployer as owner", async () => {
    const { escrow, usdc, deployer } = await loadFixture(deployFixture);
    expect(await escrow.usdc()).to.equal(await usdc.getAddress());
    expect(await escrow.owner()).to.equal(deployer.address);
    expect(await escrow.totalLocked()).to.equal(0n);
  });

  it("seeds the initial verdict signer, and nobody else", async () => {
    const { escrow, verdictSigner, outsider } = await loadFixture(deployFixture);
    expect(await escrow.acceptedSigners(verdictSigner.address)).to.equal(true);
    expect(await escrow.acceptedSigners(outsider.address)).to.equal(false);
  });

  it("exposes the review-window bounds it enforces", async () => {
    const { escrow } = await loadFixture(deployFixture);
    expect(await escrow.MIN_REVIEW_WINDOW()).to.equal(12n * 60n * 60n);
    expect(await escrow.MAX_REVIEW_WINDOW()).to.equal(14n * 24n * 60n * 60n);
  });
});

// ── createTask ────────────────────────────────────────────────────────────────

describe("CarbonEscrow — createTask", () => {
  it("moves USDC into escrow, records the commitment, and emits", async () => {
    const { escrow, usdc, agent, worker } = await loadFixture(deployFixture);
    const escrowAddress = await escrow.getAddress();
    const deadline = BigInt((await time.latest()) + DEADLINE_OFFSET);

    await expect(
      escrow
        .connect(agent)
        .createTask(TASK_ID, worker.address, AMOUNT, deadline, REVIEW_WINDOW, SPEC_HASH),
    )
      .to.emit(escrow, "TaskCreated")
      .withArgs(TASK_ID, agent.address, worker.address, AMOUNT, deadline, REVIEW_WINDOW, SPEC_HASH);

    const task = await escrow.getTask(TASK_ID);
    expect(task.agent).to.equal(agent.address);
    expect(task.worker).to.equal(worker.address);
    expect(task.amount).to.equal(AMOUNT);
    expect(task.deadline).to.equal(deadline);
    expect(task.reviewWindow).to.equal(BigInt(REVIEW_WINDOW));
    expect(task.specHash).to.equal(SPEC_HASH);
    expect(task.state).to.equal(State.Funded);
    expect(task.submittedAt).to.equal(0n);

    expect(await usdc.balanceOf(escrowAddress)).to.equal(AMOUNT);
    expect(await escrow.totalLocked()).to.equal(AMOUNT);
  });

  it("records the funder as the agent — not whoever relayed the call", async () => {
    // CC-080's root cause: the platform signer is structurally the wrong sender for every
    // agent-gated function, because createTask writes msg.sender as the agent.
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker);
    expect((await escrow.getTask(TASK_ID)).agent).to.equal(agent.address);
  });

  it("rejects a duplicate taskId", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker);
    await expect(fund(escrow, agent, worker)).to.be.revertedWithCustomError(
      escrow,
      "TaskAlreadyExists",
    );
  });

  it("rejects a zero worker, a zero amount, and a deadline in the past", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    const deadline = BigInt((await time.latest()) + DEADLINE_OFFSET);

    await expect(
      escrow
        .connect(agent)
        .createTask(TASK_ID, ethers.ZeroAddress, AMOUNT, deadline, REVIEW_WINDOW, SPEC_HASH),
    ).to.be.revertedWithCustomError(escrow, "InvalidWorker");

    await expect(
      escrow
        .connect(agent)
        .createTask(TASK_ID, worker.address, 0n, deadline, REVIEW_WINDOW, SPEC_HASH),
    ).to.be.revertedWithCustomError(escrow, "ZeroAmount");

    await expect(
      escrow
        .connect(agent)
        .createTask(
          TASK_ID,
          worker.address,
          AMOUNT,
          BigInt(await time.latest()),
          REVIEW_WINDOW,
          SPEC_HASH,
        ),
    ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
  });

  it("enforces both review-window bounds", async () => {
    // Both directions matter. Too short and the worker can claim before the agent has any
    // chance to look; too long and the agent stalls a delivered worker indefinitely.
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    const min = Number(await escrow.MIN_REVIEW_WINDOW());
    const max = Number(await escrow.MAX_REVIEW_WINDOW());

    await expect(
      fund(escrow, agent, worker, { reviewWindow: min - 1 }),
    ).to.be.revertedWithCustomError(escrow, "InvalidReviewWindow");

    await expect(
      fund(escrow, agent, worker, { reviewWindow: max + 1 }),
    ).to.be.revertedWithCustomError(escrow, "InvalidReviewWindow");

    // Both boundaries themselves are valid.
    await fund(escrow, agent, worker, { reviewWindow: min, taskId: ethers.id("min") });
    await fund(escrow, agent, worker, { reviewWindow: max, taskId: ethers.id("max") });
  });

  it("accepts a zero specHash — the app layer mandates a spec, not the contract", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker, { specHash: ZERO_BYTES32 });
    expect((await escrow.getTask(TASK_ID)).specHash).to.equal(ZERO_BYTES32);
  });

  it("reverts when the agent has not approved enough USDC", async () => {
    const { escrow, usdc, agent, worker } = await loadFixture(deployFixture);
    await usdc.connect(agent).approve(await escrow.getAddress(), 0n);
    await expect(fund(escrow, agent, worker)).to.be.revertedWithCustomError(
      usdc,
      "ERC20InsufficientAllowance",
    );
  });
});

// ── submitWork ────────────────────────────────────────────────────────────────

describe("CarbonEscrow — submitWork", () => {
  it("freezes the evidence, starts the review clock, and emits WorkSubmitted", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker);

    await expect(
      escrow.connect(worker).submitWork(TASK_ID, EVIDENCE_HASH, SPEC_HASH, ATTESTATION_UID),
    ).to.emit(escrow, "WorkSubmitted");

    const submittedAt = BigInt(await time.latest());
    const task = await escrow.getTask(TASK_ID);
    expect(task.state).to.equal(State.Delivered);
    expect(task.evidenceHash).to.equal(EVIDENCE_HASH);
    expect(task.submittedAt).to.equal(submittedAt);
    expect(task.attestationUid).to.equal(ATTESTATION_UID);
    expect(await escrow.reviewDeadline(TASK_ID)).to.equal(submittedAt + BigInt(REVIEW_WINDOW));
  });

  it("accepts the CC-036 attestation slot as zero until EAS lands", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    expect((await escrow.getTask(TASK_ID)).attestationUid).to.equal(ZERO_BYTES32);
  });

  it("is worker-only", async () => {
    const { escrow, agent, worker, outsider } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker);
    for (const caller of [agent, outsider]) {
      await expect(
        escrow.connect(caller).submitWork(TASK_ID, EVIDENCE_HASH, SPEC_HASH, ZERO_BYTES32),
      ).to.be.revertedWithCustomError(escrow, "NotWorker");
    }
  });

  it("rejects an evidence hash of zero", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker);
    await expect(
      escrow.connect(worker).submitWork(TASK_ID, ZERO_BYTES32, SPEC_HASH, ZERO_BYTES32),
    ).to.be.revertedWithCustomError(escrow, "ZeroEvidenceHash");
  });

  it("rejects a submission against a spec the worker was not shown", async () => {
    // ADR-0001 D4: this is what makes goalpost-moving impossible rather than merely
    // detectable after the fact.
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker);
    await expect(
      escrow
        .connect(worker)
        .submitWork(TASK_ID, EVIDENCE_HASH, ethers.id("some-other-spec"), ZERO_BYTES32),
    ).to.be.revertedWithCustomError(escrow, "SpecAckMismatch");
  });

  it("rejects a submission after the delivery deadline", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    const deadline = await fund(escrow, agent, worker);
    await time.increaseTo(deadline);
    await expect(
      escrow.connect(worker).submitWork(TASK_ID, EVIDENCE_HASH, SPEC_HASH, ZERO_BYTES32),
    ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
  });

  it("cannot be called twice", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    await expect(
      escrow.connect(worker).submitWork(TASK_ID, EVIDENCE_HASH, SPEC_HASH, ZERO_BYTES32),
    ).to.be.revertedWithCustomError(escrow, "InvalidState");
  });
});

// ── The property that ADR-0001 exists for ─────────────────────────────────────

describe("CarbonEscrow — an agent that does nothing cannot prevent payment", () => {
  it("pays the worker after the review window with no agent action at all", async () => {
    // This is the v1 loss case, inverted. In v1 the same sequence — worker delivers, agent
    // goes silent, clock runs out — refunded the agent and paid the worker nothing.
    const { escrow, usdc, agent, worker } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    await time.increase(REVIEW_WINDOW);

    const before = await usdc.balanceOf(worker.address);
    await expect(escrow.connect(worker).releaseAfterReview(TASK_ID))
      .to.emit(escrow, "TaskCompleted")
      .withArgs(TASK_ID, worker.address, AMOUNT, Route.ReviewElapsed);

    expect(await usdc.balanceOf(worker.address)).to.equal(before + AMOUNT);
    expect((await escrow.getTask(TASK_ID)).state).to.equal(State.Completed);
    expect(await escrow.totalLocked()).to.equal(0n);
  });

  it("keeps paying even past the delivery deadline — once delivered, the deadline is moot", async () => {
    const { escrow, usdc, agent, worker } = await loadFixture(deployFixture);
    const deadline = await fundAndSubmit(escrow, agent, worker);

    await time.increaseTo(deadline + 1n);

    // The v1 refund path is now unreachable for delivered work...
    await expect(escrow.connect(agent).expireTask(TASK_ID)).to.be.revertedWithCustomError(
      escrow,
      "InvalidState",
    );

    // ...and the worker is still paid.
    await time.increase(REVIEW_WINDOW);
    const before = await usdc.balanceOf(worker.address);
    await escrow.connect(worker).releaseAfterReview(TASK_ID);
    expect(await usdc.balanceOf(worker.address)).to.equal(before + AMOUNT);
  });

  it("does not let the worker claim while the window is still open", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    await time.increase(REVIEW_WINDOW - 60);
    await expect(escrow.connect(worker).releaseAfterReview(TASK_ID)).to.be.revertedWithCustomError(
      escrow,
      "ReviewWindowOpen",
    );
  });

  // releaseAfterReview needs `now >= reviewDeadline`; disputeTask needs `now <`. Exact
  // complements, so precisely one is available at any timestamp. The three tests below pin
  // the two seconds either side of the boundary, which is where an off-by-one would either
  // strand the task with neither route open or leave both open at once.
  //
  // Each uses setNextBlockTimestamp rather than increaseTo: increaseTo mines a block AT
  // that time, and the transaction then lands in the *next* block a second later — which
  // is what made the first version of this test assert against the wrong second.

  it("keeps the worker out one second before the window closes", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    const closesAt = await escrow.reviewDeadline(TASK_ID);

    await time.setNextBlockTimestamp(closesAt - 1n);
    await expect(escrow.connect(worker).releaseAfterReview(TASK_ID)).to.be.revertedWithCustomError(
      escrow,
      "ReviewWindowOpen",
    );
  });

  it("lets the worker claim on the exact second the window closes", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    const closesAt = await escrow.reviewDeadline(TASK_ID);

    await time.setNextBlockTimestamp(closesAt);
    await escrow.connect(worker).releaseAfterReview(TASK_ID);
    expect((await escrow.getTask(TASK_ID)).state).to.equal(State.Completed);
  });

  it("closes the dispute route on that same second", async () => {
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    const closesAt = await escrow.reviewDeadline(TASK_ID);

    const verdict = buildVerdict({ passed: false });
    const sig = await signVerdict(escrow, verdictSigner, verdict);

    await time.setNextBlockTimestamp(closesAt);
    await expect(
      escrow.connect(agent).disputeTask(TASK_ID, asTuple(verdict), sig),
    ).to.be.revertedWithCustomError(escrow, "ReviewWindowClosed");
  });

  it("still allows a dispute one second earlier", async () => {
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    const closesAt = await escrow.reviewDeadline(TASK_ID);

    const verdict = buildVerdict({ passed: false });
    const sig = await signVerdict(escrow, verdictSigner, verdict);

    await time.setNextBlockTimestamp(closesAt - 1n);
    await escrow.connect(agent).disputeTask(TASK_ID, asTuple(verdict), sig);
    expect((await escrow.getTask(TASK_ID)).state).to.equal(State.Disputed);
  });

  it("is worker-only, and unreachable before submission", async () => {
    const { escrow, agent, worker, outsider } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker);

    // Not yet delivered.
    await expect(escrow.connect(worker).releaseAfterReview(TASK_ID)).to.be.revertedWithCustomError(
      escrow,
      "InvalidState",
    );

    await escrow.connect(worker).submitWork(TASK_ID, EVIDENCE_HASH, SPEC_HASH, ZERO_BYTES32);
    await time.increase(REVIEW_WINDOW);

    for (const caller of [agent, outsider]) {
      await expect(
        escrow.connect(caller).releaseAfterReview(TASK_ID),
      ).to.be.revertedWithCustomError(escrow, "NotWorker");
    }
  });
});

// ── completeTask ──────────────────────────────────────────────────────────────

describe("CarbonEscrow — completeTask", () => {
  it("lets the agent pay a delivered task immediately", async () => {
    const { escrow, usdc, agent, worker } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    const before = await usdc.balanceOf(worker.address);
    await expect(escrow.connect(agent).completeTask(TASK_ID))
      .to.emit(escrow, "TaskCompleted")
      .withArgs(TASK_ID, worker.address, AMOUNT, Route.AgentConfirmed);

    expect(await usdc.balanceOf(worker.address)).to.equal(before + AMOUNT);
    expect(await escrow.totalLocked()).to.equal(0n);
  });

  it("lets the agent pay early, before any submission", async () => {
    // ADR-0001 D2: "the paying agent controls release" stands. What D2 removes is the
    // agent's authority to decide *not* to pay, not its ability to pay whenever it likes.
    const { escrow, usdc, agent, worker } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker);

    const before = await usdc.balanceOf(worker.address);
    await escrow.connect(agent).completeTask(TASK_ID);
    expect(await usdc.balanceOf(worker.address)).to.equal(before + AMOUNT);
  });

  it("is agent-only — the platform signer cannot call it", async () => {
    // CC-080 in test form: the platform is `deployer`/`owner` here, and owning the
    // contract buys it nothing on this function.
    const { escrow, agent, worker, deployer, outsider } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    for (const caller of [worker, deployer, outsider]) {
      await expect(escrow.connect(caller).completeTask(TASK_ID)).to.be.revertedWithCustomError(
        escrow,
        "NotAgent",
      );
    }
  });

  it("cannot double-pay", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    await escrow.connect(agent).completeTask(TASK_ID);
    await expect(escrow.connect(agent).completeTask(TASK_ID)).to.be.revertedWithCustomError(
      escrow,
      "InvalidState",
    );
  });
});

// ── Signed verdicts ───────────────────────────────────────────────────────────

describe("CarbonEscrow — EIP-712 signed verdicts", () => {
  it("pays the worker immediately on a valid passing verdict", async () => {
    const { escrow, usdc, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    const verdict = buildVerdict({ passed: true });
    const sig = await signVerdict(escrow, verdictSigner, verdict);

    const before = await usdc.balanceOf(worker.address);
    await expect(escrow.connect(worker).claimWithVerdict(TASK_ID, asTuple(verdict), sig))
      .to.emit(escrow, "TaskCompleted")
      .withArgs(TASK_ID, worker.address, AMOUNT, Route.PassingVerdict);

    expect(await usdc.balanceOf(worker.address)).to.equal(before + AMOUNT);

    const task = await escrow.getTask(TASK_ID);
    expect(task.verdictPassed).to.equal(true);
    expect(task.verdictHash).to.equal(await escrow.verdictDigest(asTuple(verdict)));
  });

  it("rejects a verdict signed by anyone outside the accepted set", async () => {
    const { escrow, agent, worker, outsider } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    const verdict = buildVerdict();
    const sig = await signVerdict(escrow, outsider, verdict);

    await expect(escrow.connect(worker).claimWithVerdict(TASK_ID, asTuple(verdict), sig))
      .to.be.revertedWithCustomError(escrow, "VerdictSignerNotAccepted")
      .withArgs(outsider.address);
  });

  it("rejects an expired verdict", async () => {
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    const expiry = BigInt(await time.latest()) + 3600n;
    const verdict = buildVerdict({ expiry });
    const sig = await signVerdict(escrow, verdictSigner, verdict);

    await time.increaseTo(expiry + 1n);
    await expect(
      escrow.connect(worker).claimWithVerdict(TASK_ID, asTuple(verdict), sig),
    ).to.be.revertedWithCustomError(escrow, "VerdictExpiredError");
  });

  it("rejects a replayed nonce", async () => {
    // Amendment 1 A1.1: an unbounded signed verdict is a replayable authorisation, and
    // this struct authorises the movement of money.
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    const secondTask = ethers.id("payment-request-2");

    await fundAndSubmit(escrow, agent, worker);
    const first = buildVerdict({ nonce: 7n });
    await escrow
      .connect(worker)
      .claimWithVerdict(TASK_ID, asTuple(first), await signVerdict(escrow, verdictSigner, first));

    await fundAndSubmit(escrow, agent, worker, { taskId: secondTask });
    const second = buildVerdict({ taskId: secondTask, nonce: 7n });
    await expect(
      escrow
        .connect(worker)
        .claimWithVerdict(
          secondTask,
          asTuple(second),
          await signVerdict(escrow, verdictSigner, second),
        ),
    ).to.be.revertedWithCustomError(escrow, "VerdictNonceAlreadyUsed");
  });

  it("rejects a verdict bound to a different task", async () => {
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    const verdict = buildVerdict({ taskId: ethers.id("some-other-task") });
    const sig = await signVerdict(escrow, verdictSigner, verdict);

    await expect(
      escrow.connect(worker).claimWithVerdict(TASK_ID, asTuple(verdict), sig),
    ).to.be.revertedWithCustomError(escrow, "VerdictTaskMismatch");
  });

  it("rejects a verdict whose spec or evidence commitment does not match the task", async () => {
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    for (const override of [
      { specHash: ethers.id("different-spec") },
      { evidenceHash: ethers.id("different-evidence") },
    ]) {
      const verdict = buildVerdict(override);
      const sig = await signVerdict(escrow, verdictSigner, verdict);
      await expect(
        escrow.connect(worker).claimWithVerdict(TASK_ID, asTuple(verdict), sig),
      ).to.be.revertedWithCustomError(escrow, "VerdictCommitmentMismatch");
    }
  });

  it("rejects a verdict signed for a different contract or chain", async () => {
    // The EIP-712 domain is the only thing stopping a verdict signed against the Sepolia
    // deployment being replayed against the mainnet one.
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    const verdict = buildVerdict();

    const wrongContract = await signVerdict(escrow, verdictSigner, verdict, {
      verifyingContract: ethers.ZeroAddress,
    });
    await expect(
      escrow.connect(worker).claimWithVerdict(TASK_ID, asTuple(verdict), wrongContract),
    ).to.be.revertedWithCustomError(escrow, "VerdictSignerNotAccepted");

    const wrongChain = await signVerdict(escrow, verdictSigner, verdict, { chainId: 1n });
    await expect(
      escrow.connect(worker).claimWithVerdict(TASK_ID, asTuple(verdict), wrongChain),
    ).to.be.revertedWithCustomError(escrow, "VerdictSignerNotAccepted");
  });

  it("will not let a failing verdict be used to claim payment", async () => {
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    const verdict = buildVerdict({ passed: false });
    const sig = await signVerdict(escrow, verdictSigner, verdict);

    await expect(
      escrow.connect(worker).claimWithVerdict(TASK_ID, asTuple(verdict), sig),
    ).to.be.revertedWithCustomError(escrow, "VerdictResultMismatch");
  });

  it("lets a signer revoke a nonce, killing a signature it already issued", async () => {
    const { escrow, agent, worker, verdictSigner, outsider } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    const verdict = buildVerdict({ nonce: 42n });
    const sig = await signVerdict(escrow, verdictSigner, verdict);

    await expect(escrow.connect(outsider).revokeVerdictNonce(42n))
      .to.be.revertedWithCustomError(escrow, "VerdictSignerNotAccepted")
      .withArgs(outsider.address);

    await expect(escrow.connect(verdictSigner).revokeVerdictNonce(42n))
      .to.emit(escrow, "VerdictNonceRevoked")
      .withArgs(verdictSigner.address, 42n);

    await expect(
      escrow.connect(worker).claimWithVerdict(TASK_ID, asTuple(verdict), sig),
    ).to.be.revertedWithCustomError(escrow, "VerdictNonceAlreadyUsed");
  });

  it("stops accepting a signer's verdicts once the owner removes them", async () => {
    const { escrow, agent, worker, verdictSigner, deployer } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    const verdict = buildVerdict();
    const sig = await signVerdict(escrow, verdictSigner, verdict);

    await expect(escrow.connect(deployer).setVerdictSigner(verdictSigner.address, false))
      .to.emit(escrow, "VerdictSignerUpdated")
      .withArgs(verdictSigner.address, false);

    await expect(
      escrow.connect(worker).claimWithVerdict(TASK_ID, asTuple(verdict), sig),
    ).to.be.revertedWithCustomError(escrow, "VerdictSignerNotAccepted");
  });

  it("restricts signer administration to the owner and refuses the zero address", async () => {
    const { escrow, outsider, deployer } = await loadFixture(deployFixture);
    await expect(
      escrow.connect(outsider).setVerdictSigner(outsider.address, true),
    ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    await expect(
      escrow.connect(deployer).setVerdictSigner(ethers.ZeroAddress, true),
    ).to.be.revertedWithCustomError(escrow, "ZeroSigner");
  });
});

// ── disputeTask ───────────────────────────────────────────────────────────────

describe("CarbonEscrow — disputes require a signed failing verdict", () => {
  async function failingVerdict(escrow: DeployedContract, verdictSigner: HardhatEthersSigner, nonce = 1n) {
    const verdict = buildVerdict({ passed: false, nonce });
    return { verdict, sig: await signVerdict(escrow, verdictSigner, verdict) };
  }

  it("moves a delivered task to Disputed and leaves the funds locked", async () => {
    const { escrow, usdc, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    const { verdict, sig } = await failingVerdict(escrow, verdictSigner);

    await expect(escrow.connect(agent).disputeTask(TASK_ID, asTuple(verdict), sig)).to.emit(
      escrow,
      "TaskDisputed",
    );

    const task = await escrow.getTask(TASK_ID);
    expect(task.state).to.equal(State.Disputed);
    expect(task.verdictPassed).to.equal(false);
    expect(task.verdictHash).to.equal(await escrow.verdictDigest(asTuple(verdict)));

    expect(await escrow.totalLocked()).to.equal(AMOUNT);
    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
  });

  it("blocks the worker's automatic claim once raised", async () => {
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    const { verdict, sig } = await failingVerdict(escrow, verdictSigner);
    await escrow.connect(agent).disputeTask(TASK_ID, asTuple(verdict), sig);

    await time.increase(REVIEW_WINDOW);
    await expect(escrow.connect(worker).releaseAfterReview(TASK_ID)).to.be.revertedWithCustomError(
      escrow,
      "InvalidState",
    );
  });

  it("cannot be raised by bare assertion — no verdict, no dispute", async () => {
    // The whole point of ADR-0001 D2. If the agent could block payment just by calling a
    // function, it would still hold both outcomes and the escrow would protect nobody.
    const { escrow, agent, worker, outsider } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);

    const verdict = buildVerdict({ passed: false });
    const forged = await signVerdict(escrow, outsider, verdict);

    await expect(
      escrow.connect(agent).disputeTask(TASK_ID, asTuple(verdict), forged),
    ).to.be.revertedWithCustomError(escrow, "VerdictSignerNotAccepted");
  });

  it("rejects a passing verdict as grounds for dispute", async () => {
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    const verdict = buildVerdict({ passed: true });
    const sig = await signVerdict(escrow, verdictSigner, verdict);

    await expect(
      escrow.connect(agent).disputeTask(TASK_ID, asTuple(verdict), sig),
    ).to.be.revertedWithCustomError(escrow, "VerdictResultMismatch");
  });

  it("must land before the review window closes", async () => {
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    const { verdict, sig } = await failingVerdict(escrow, verdictSigner);

    await time.increase(REVIEW_WINDOW);
    await expect(
      escrow.connect(agent).disputeTask(TASK_ID, asTuple(verdict), sig),
    ).to.be.revertedWithCustomError(escrow, "ReviewWindowClosed");
  });

  it("is open to either party, but not to strangers", async () => {
    const { escrow, agent, worker, verdictSigner, outsider } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    const { verdict, sig } = await failingVerdict(escrow, verdictSigner);

    await expect(
      escrow.connect(outsider).disputeTask(TASK_ID, asTuple(verdict), sig),
    ).to.be.revertedWithCustomError(escrow, "NotParty");

    // The worker may escalate too — D2 grants it to either party.
    await escrow.connect(worker).disputeTask(TASK_ID, asTuple(verdict), sig);
    expect((await escrow.getTask(TASK_ID)).state).to.equal(State.Disputed);
  });

  it("is unreachable before delivery", async () => {
    const { escrow, agent, worker, verdictSigner } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker);
    const { verdict, sig } = await failingVerdict(escrow, verdictSigner);
    await expect(
      escrow.connect(agent).disputeTask(TASK_ID, asTuple(verdict), sig),
    ).to.be.revertedWithCustomError(escrow, "InvalidState");
  });
});

// ── Arbitration ───────────────────────────────────────────────────────────────

describe("CarbonEscrow — arbitration", () => {
  async function disputed() {
    const ctx = await loadFixture(deployFixture);
    await fundAndSubmit(ctx.escrow, ctx.agent, ctx.worker);
    const verdict = buildVerdict({ passed: false });
    const sig = await signVerdict(ctx.escrow, ctx.verdictSigner, verdict);
    await ctx.escrow.connect(ctx.agent).disputeTask(TASK_ID, asTuple(verdict), sig);
    return ctx;
  }

  it("lets the owner mark a dispute as being worked on", async () => {
    const { escrow, deployer } = await disputed();
    await expect(escrow.connect(deployer).beginArbitration(TASK_ID)).to.emit(
      escrow,
      "ArbitrationBegun",
    );
    expect((await escrow.getTask(TASK_ID)).state).to.equal(State.Arbitrating);
  });

  it("restricts beginArbitration and resolveDispute to the owner", async () => {
    const { escrow, agent, worker } = await disputed();
    for (const caller of [agent, worker]) {
      await expect(escrow.connect(caller).beginArbitration(TASK_ID)).to.be.revertedWithCustomError(
        escrow,
        "OwnableUnauthorizedAccount",
      );
      await expect(
        escrow.connect(caller).resolveDispute(TASK_ID, true),
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    }
  });

  it("resolves in the worker's favour", async () => {
    const { escrow, usdc, worker, deployer } = await disputed();
    const before = await usdc.balanceOf(worker.address);

    await expect(escrow.connect(deployer).resolveDispute(TASK_ID, true))
      .to.emit(escrow, "TaskResolved")
      .withArgs(TASK_ID, true, AMOUNT);

    expect(await usdc.balanceOf(worker.address)).to.equal(before + AMOUNT);
    expect((await escrow.getTask(TASK_ID)).state).to.equal(State.Resolved);
    expect(await escrow.totalLocked()).to.equal(0n);
  });

  it("resolves in the agent's favour", async () => {
    const { escrow, usdc, agent, deployer } = await disputed();
    const before = await usdc.balanceOf(agent.address);
    await escrow.connect(deployer).resolveDispute(TASK_ID, false);
    expect(await usdc.balanceOf(agent.address)).to.equal(before + AMOUNT);
    expect(await escrow.totalLocked()).to.equal(0n);
  });

  it("resolves from Arbitrating as well as from Disputed", async () => {
    const { escrow, usdc, worker, deployer } = await disputed();
    await escrow.connect(deployer).beginArbitration(TASK_ID);
    const before = await usdc.balanceOf(worker.address);
    await escrow.connect(deployer).resolveDispute(TASK_ID, true);
    expect(await usdc.balanceOf(worker.address)).to.equal(before + AMOUNT);
  });

  it("reaches no destination other than the two parties fixed at funding", async () => {
    // ADR-0001 D9 — custody settled by bytecode, not policy. There is no argument to
    // resolveDispute that names a recipient, so a compromised owner key cannot invent one.
    const { escrow } = await disputed();
    const fragment = escrow.interface.getFunction("resolveDispute");
    expect(fragment?.inputs.map((i: { type: string }) => i.type)).to.deep.equal([
      "bytes32",
      "bool",
    ]);
  });

  it("cannot resolve a task that was never disputed", async () => {
    const { escrow, agent, worker, deployer } = await loadFixture(deployFixture);
    await fundAndSubmit(escrow, agent, worker);
    await expect(
      escrow.connect(deployer).resolveDispute(TASK_ID, true),
    ).to.be.revertedWithCustomError(escrow, "InvalidState");
  });
});

// ── expireTask ────────────────────────────────────────────────────────────────

describe("CarbonEscrow — expireTask", () => {
  it("refunds the agent when the worker never delivered", async () => {
    const { escrow, usdc, agent, worker } = await loadFixture(deployFixture);
    const deadline = await fund(escrow, agent, worker);
    await time.increaseTo(deadline);

    const before = await usdc.balanceOf(agent.address);
    await expect(escrow.connect(agent).expireTask(TASK_ID))
      .to.emit(escrow, "TaskExpired")
      .withArgs(TASK_ID, AMOUNT);

    expect(await usdc.balanceOf(agent.address)).to.equal(before + AMOUNT);
    expect((await escrow.getTask(TASK_ID)).state).to.equal(State.Expired);
    expect(await escrow.totalLocked()).to.equal(0n);
  });

  it("is agent-only — in v1 anyone could call this", async () => {
    const { escrow, agent, worker, outsider, deployer } = await loadFixture(deployFixture);
    const deadline = await fund(escrow, agent, worker);
    await time.increaseTo(deadline);
    for (const caller of [worker, outsider, deployer]) {
      await expect(escrow.connect(caller).expireTask(TASK_ID)).to.be.revertedWithCustomError(
        escrow,
        "NotAgent",
      );
    }
  });

  it("refuses before the deadline", async () => {
    const { escrow, agent, worker } = await loadFixture(deployFixture);
    await fund(escrow, agent, worker);
    await expect(escrow.connect(agent).expireTask(TASK_ID)).to.be.revertedWithCustomError(
      escrow,
      "NotExpired",
    );
  });
});

// ── Solvency ──────────────────────────────────────────────────────────────────

describe("CarbonEscrow — solvency invariant", () => {
  it("keeps balanceOf(escrow) == totalLocked across every terminal route", async () => {
    // The invariant scripts/audit/verify-escrow-solvency.mjs checks on-chain. Drift here
    // means drift there, and the audit script is the thing standing between a bad
    // accounting change and stranded funds.
    const { escrow, usdc, agent, worker, deployer, verdictSigner } =
      await loadFixture(deployFixture);
    const escrowAddress = await escrow.getAddress();

    const assertSolvent = async () =>
      expect(await usdc.balanceOf(escrowAddress)).to.equal(await escrow.totalLocked());

    // 1. Agent confirms.
    const a = ethers.id("t-agent-confirmed");
    await fundAndSubmit(escrow, agent, worker, { taskId: a });
    await assertSolvent();
    await escrow.connect(agent).completeTask(a);
    await assertSolvent();

    // 2. Review window elapses.
    const b = ethers.id("t-review-elapsed");
    await fundAndSubmit(escrow, agent, worker, { taskId: b });
    await time.increase(REVIEW_WINDOW);
    await escrow.connect(worker).releaseAfterReview(b);
    await assertSolvent();

    // 3. Passing verdict.
    const c = ethers.id("t-passing-verdict");
    await fundAndSubmit(escrow, agent, worker, { taskId: c });
    const pass = buildVerdict({ taskId: c, nonce: 101n });
    await escrow
      .connect(worker)
      .claimWithVerdict(c, asTuple(pass), await signVerdict(escrow, verdictSigner, pass));
    await assertSolvent();

    // 4. Failing verdict, arbitrated to the agent.
    const d = ethers.id("t-disputed");
    await fundAndSubmit(escrow, agent, worker, { taskId: d });
    const fail = buildVerdict({ taskId: d, passed: false, nonce: 102n });
    await escrow
      .connect(agent)
      .disputeTask(d, asTuple(fail), await signVerdict(escrow, verdictSigner, fail));
    await assertSolvent();
    await escrow.connect(deployer).resolveDispute(d, false);
    await assertSolvent();

    // 5. Expiry, with one task left open to prove the invariant is not trivially zero.
    const e = ethers.id("t-expired");
    const deadline = await fund(escrow, agent, worker, { taskId: e, deadlineOffset: 3600 });
    const open = ethers.id("t-still-open");
    await fund(escrow, agent, worker, { taskId: open });

    await time.increaseTo(deadline);
    await escrow.connect(agent).expireTask(e);
    await assertSolvent();

    expect(await escrow.totalLocked()).to.equal(AMOUNT);
  });
});
