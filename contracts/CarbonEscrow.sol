// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title CarbonEscrow
 * @notice Holds USDC in escrow while a human completes work for an AI agent.
 *
 * @dev v2 — implements ADR-0001 (D1, D2, D4, D6) and its Amendment 1 (A1.1, A1.2).
 *
 * ## What v1 got wrong
 *
 * v1 had exactly one clock: task deadline -> expireTask -> refund agent. Silence therefore
 * always resolved in the agent's favour. The worker could deliver, the agent could simply
 * never call completeTask, the deadline would pass, and the agent got their money back
 * automatically. No bad actor required. The escrow gave the worker nothing but a locked
 * stake and the appearance of protection.
 *
 * ## The v2 shape
 *
 *   None -> Funded -> Delivered -> Completed
 *              |          |            ^
 *              |          |            +-- releaseAfterReview (window elapsed, worker claims)
 *              |          |            +-- claimWithVerdict   (passing verdict presented)
 *              |          |            +-- completeTask       (agent pays, any time)
 *              |          +-------> Disputed -> Arbitrating -> Resolved
 *              +--> Expired (deadline passed with no submission, agent claims refund)
 *
 * Two clocks, so silence resolves in favour of whichever party last took a verifiable
 * action. The worker who never submits loses to the deadline; the agent who ignores a
 * submission loses to the review window.
 *
 * ## Verdicts are signatures, not transactions (Amendment 1 A1.1)
 *
 * There is deliberately no postVerdict function. A verdict is signed off-chain by an
 * accepted signer and handed to the parties; whoever acts presents the signature and the
 * contract recovers the signer. The platform therefore makes no transaction in any
 * settlement path — no gas, no nonce management, no signer liveness between a worker and
 * their money. v2-of-the-design (permissionless verdicts against a bond) becomes a change
 * to the accepted-signer set rather than a rewrite.
 *
 * ## Custody (ADR-0001 D9)
 *
 * Every disbursement destination is task.worker or task.agent, both fixed at funding. No
 * arbitrary destination is reachable by anyone, owner included. That holds against a
 * compromised owner key, and it is the property the regulatory position rests on.
 */
contract CarbonEscrow is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    /// @notice Bounds on the agent-chosen review window. Both are load-bearing: the lower
    ///         bound stops a worker claiming before the agent has any chance to look, the
    ///         upper bound stops an agent stalling a delivered worker's payment for months.
    uint32 public constant MIN_REVIEW_WINDOW = 12 hours;
    uint32 public constant MAX_REVIEW_WINDOW = 14 days;

    enum TaskState {
        None, // 0
        Funded, // 1
        Delivered, // 2
        Completed, // 3
        Disputed, // 4
        Arbitrating, // 5
        Resolved, // 6
        Expired // 7
    }

    /// @notice How a task reached Completed. Recorded on the event so the off-chain
    ///         projection can distinguish "the agent chose to pay" from "the agent was
    ///         silent and the clock ran out" without replaying the whole task history.
    enum CompletionRoute {
        AgentConfirmed, // 0 — completeTask
        ReviewElapsed, // 1 — releaseAfterReview
        PassingVerdict // 2 — claimWithVerdict
    }

    /**
     * @dev Field order is chosen for storage packing, not readability:
     *      slot 0: agent(20) + deadline(8) + reviewWindow(4)  = 32 bytes
     *      slot 1: worker(20) + submittedAt(8) + state(1) + verdictPassed(1) = 30 bytes
     *      slot 2: amount
     *      slots 3-6: the four commitment hashes
     */
    struct Task {
        address agent;
        uint64 deadline; // delivery deadline; irrelevant once Delivered
        uint32 reviewWindow; // seconds after submittedAt that the agent has to act
        address worker;
        uint64 submittedAt; // 0 until submitWork; starts the review clock
        TaskState state;
        bool verdictPassed; // meaningful only when verdictHash != 0
        uint256 amount;
        bytes32 specHash; // acceptance criteria, committed by the agent at funding
        bytes32 evidenceHash; // the submission, committed by the worker at delivery
        bytes32 verdictHash; // EIP-712 digest of the verdict that was presented
        bytes32 attestationUid; // CC-036 slot — EAS attestation, unused until EAS lands
    }

    /**
     * @notice The off-chain-signed verdict (Amendment 1 A1.1).
     * @dev expiry and nonce are mandatory. An unbounded signed verdict is a replayable
     *      authorisation, and this struct authorises the movement of money.
     */
    struct Verdict {
        bytes32 taskId;
        bytes32 specHash;
        bytes32 evidenceHash;
        bytes32 checkerHash; // content-addressed checker bundle; doubles as ruleVersion
        bool passed;
        bytes32 breakdownHash; // per-check results, held off-chain
        uint256 expiry;
        uint256 nonce;
    }

    bytes32 public constant VERDICT_TYPEHASH =
        keccak256(
            "Verdict(bytes32 taskId,bytes32 specHash,bytes32 evidenceHash,bytes32 checkerHash,bool passed,bytes32 breakdownHash,uint256 expiry,uint256 nonce)"
        );

    /// @notice taskId (bytes32 of payment_request_id) → Task
    mapping(bytes32 => Task) public tasks;

    /// @notice Running total of USDC locked across all active tasks
    uint256 public totalLocked;

    /// @notice Signers whose verdicts this contract will accept.
    mapping(address => bool) public acceptedSigners;

    /// @notice signer → nonce → consumed. Per-signer so two signers cannot collide, and
    ///         so a signer can burn a nonce to revoke a signature they regret issuing.
    mapping(address => mapping(uint256 => bool)) public verdictNonceUsed;

    // ── Events ──────────────────────────────────────────────────────────────────

    event TaskCreated(
        bytes32 indexed taskId,
        address indexed agent,
        address indexed worker,
        uint256 amount,
        uint64 deadline,
        uint32 reviewWindow,
        bytes32 specHash
    );

    /// @dev CC-075 reads this: N consecutive TaskExpired with zero WorkSubmitted is the
    ///      signal that distinguishes "worker went AWOL" from "agent would not accept".
    event WorkSubmitted(
        bytes32 indexed taskId,
        address indexed worker,
        bytes32 evidenceHash,
        uint64 submittedAt,
        bytes32 attestationUid
    );

    event TaskCompleted(
        bytes32 indexed taskId,
        address indexed worker,
        uint256 amount,
        CompletionRoute route
    );

    event TaskDisputed(bytes32 indexed taskId, address indexed by, bytes32 verdictHash);
    event ArbitrationBegun(bytes32 indexed taskId);
    event TaskResolved(bytes32 indexed taskId, bool releasedToWorker, uint256 amount);
    event TaskExpired(bytes32 indexed taskId, uint256 refunded);

    event VerdictSignerUpdated(address indexed signer, bool accepted);
    event VerdictNonceRevoked(address indexed signer, uint256 nonce);

    // ── Errors ──────────────────────────────────────────────────────────────────

    error TaskAlreadyExists();
    error InvalidWorker();
    error ZeroAmount();
    error DeadlinePassed();
    error InvalidReviewWindow();
    error InvalidState(TaskState current, TaskState expected);
    error NotParty();
    error NotWorker();
    error NotAgent();
    error NotExpired();
    error ZeroEvidenceHash();
    error SpecAckMismatch();
    error ReviewWindowOpen();
    error ReviewWindowClosed();
    error VerdictTaskMismatch();
    error VerdictCommitmentMismatch();
    error VerdictExpiredError();
    error VerdictNonceAlreadyUsed();
    error VerdictSignerNotAccepted(address signer);
    error VerdictResultMismatch();
    error ZeroSigner();

    // ── Constructor ─────────────────────────────────────────────────────────────

    /**
     * @param _usdc Address of the USDC token contract on Base.
     * @param initialVerdictSigner Seeded into the accepted-signer set so the contract is
     *        usable from its first block. Pass address(0) to seed nothing.
     */
    constructor(
        address _usdc,
        address initialVerdictSigner
    ) Ownable(msg.sender) EIP712("CarbonEscrow", "2") {
        usdc = IERC20(_usdc);
        if (initialVerdictSigner != address(0)) {
            acceptedSigners[initialVerdictSigner] = true;
            emit VerdictSignerUpdated(initialVerdictSigner, true);
        }
    }

    // ── Core lifecycle ──────────────────────────────────────────────────────────

    /**
     * @notice Fund a new task. Caller must have approved this contract for `amount`.
     * @dev The funder becomes task.agent. There is no path by which the platform funds on
     *      an agent's behalf — see CC-081 Defect 1 for why that mattered.
     * @param taskId Unique task identifier (keccak256 of payment_request_id)
     * @param worker Address of the human worker
     * @param amount USDC amount (6 decimals on Base)
     * @param deadline Unix timestamp after which an unsubmitted task can be expired
     * @param reviewWindow Seconds after submission the agent has to act, MIN..MAX
     * @param specHash Commitment to the acceptance criteria (ADR-0001 D3/D4). May be zero
     *        for a task with no machine-checkable spec; the app layer, not the contract,
     *        is where a spec is made mandatory.
     */
    function createTask(
        bytes32 taskId,
        address worker,
        uint256 amount,
        uint64 deadline,
        uint32 reviewWindow,
        bytes32 specHash
    ) external nonReentrant {
        if (tasks[taskId].state != TaskState.None) revert TaskAlreadyExists();
        if (worker == address(0)) revert InvalidWorker();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlinePassed();
        if (reviewWindow < MIN_REVIEW_WINDOW || reviewWindow > MAX_REVIEW_WINDOW) {
            revert InvalidReviewWindow();
        }

        tasks[taskId] = Task({
            agent: msg.sender,
            deadline: deadline,
            reviewWindow: reviewWindow,
            worker: worker,
            submittedAt: 0,
            state: TaskState.Funded,
            verdictPassed: false,
            amount: amount,
            specHash: specHash,
            evidenceHash: bytes32(0),
            verdictHash: bytes32(0),
            attestationUid: bytes32(0)
        });

        totalLocked += amount;

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit TaskCreated(taskId, msg.sender, worker, amount, deadline, reviewWindow, specHash);
    }

    /**
     * @notice Worker signals delivery. Freezes the evidence and starts the review clock.
     * @dev This is the function whose absence made v1 unfixable: without it, "the worker
     *      did not deliver" and "the agent would not accept" are the same on-chain state.
     * @param evidenceHash Commitment to the submitted work. The bytes stay off-chain.
     * @param specVersionAck The spec the worker believes they are delivering against. Must
     *        equal the committed specHash — this is what makes goalpost-moving impossible
     *        rather than merely detectable.
     * @param attestationUid Optional EAS attestation UID (CC-036). Zero until EAS lands.
     */
    function submitWork(
        bytes32 taskId,
        bytes32 evidenceHash,
        bytes32 specVersionAck,
        bytes32 attestationUid
    ) external {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Funded) {
            revert InvalidState(task.state, TaskState.Funded);
        }
        if (msg.sender != task.worker) revert NotWorker();
        if (evidenceHash == bytes32(0)) revert ZeroEvidenceHash();
        if (specVersionAck != task.specHash) revert SpecAckMismatch();
        // Past the deadline the agent is already entitled to their refund. Allowing a late
        // submission would let a worker force the agent through review by submitting
        // anything at all, a second after the clock they already missed.
        if (block.timestamp >= task.deadline) revert DeadlinePassed();

        task.state = TaskState.Delivered;
        task.submittedAt = uint64(block.timestamp);
        task.evidenceHash = evidenceHash;
        task.attestationUid = attestationUid;

        emit WorkSubmitted(taskId, msg.sender, evidenceHash, uint64(block.timestamp), attestationUid);
    }

    /**
     * @notice Agent confirms completion — funds release to the worker.
     * @dev Agent-only, and callable from Funded as well as Delivered. ADR-0001 D2: "the
     *      paying agent controls release" stands, and an agent may always choose to pay
     *      early. What D2 removes is the agent's authority to decide *not* to pay.
     */
    function completeTask(bytes32 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Funded && task.state != TaskState.Delivered) {
            revert InvalidState(task.state, TaskState.Delivered);
        }
        if (msg.sender != task.agent) revert NotAgent();

        _payOut(taskId, task, task.worker, CompletionRoute.AgentConfirmed);
    }

    /**
     * @notice Worker claims payment once the review window has closed with no valid
     *         failing verdict presented (ADR-0001 D6, Amendment 1 A1.2 and A1.3).
     * @dev Pull-payment: the worker is the motivated party, pays their own gas, and claims
     *      their own money. The earlier "callable by anyone" draft meant nobody was
     *      responsible for calling it.
     *
     *      This is the function that makes agent silence lose. It has no dependency on the
     *      platform signing, transacting, or being reachable at all.
     */
    function releaseAfterReview(bytes32 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Delivered) {
            revert InvalidState(task.state, TaskState.Delivered);
        }
        if (msg.sender != task.worker) revert NotWorker();
        if (block.timestamp < reviewDeadline(taskId)) revert ReviewWindowOpen();

        _payOut(taskId, task, task.worker, CompletionRoute.ReviewElapsed);
    }

    /**
     * @notice Worker claims payment immediately by presenting a passing signed verdict,
     *         without waiting out the review window.
     */
    function claimWithVerdict(
        bytes32 taskId,
        Verdict calldata verdict,
        bytes calldata signature
    ) external nonReentrant {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Delivered) {
            revert InvalidState(task.state, TaskState.Delivered);
        }
        if (msg.sender != task.worker) revert NotWorker();
        if (!verdict.passed) revert VerdictResultMismatch();

        bytes32 digest = _consumeVerdict(taskId, task, verdict, signature);
        task.verdictHash = digest;
        task.verdictPassed = true;

        _payOut(taskId, task, task.worker, CompletionRoute.PassingVerdict);
    }

    /**
     * @notice Raise a dispute over delivered work by presenting a failing signed verdict.
     *         Funds stay locked until the owner resolves.
     *
     * @dev Three things about this function are deliberate and were the hard part of the
     *      design. Read ADR-0001 D2 and D6 before changing any of them.
     *
     *      1. A *signed failing verdict is required*. There is no bare-assertion dispute.
     *         If an agent could block the worker's claim just by calling a function, the
     *         agent would still hold both outcomes — release by completeTask, refusal by
     *         disputing — and the escrow would be back to protecting nobody. Requiring a
     *         verdict means a refusal is re-runnable by anyone, and therefore falsifiable.
     *
     *      2. *Either party may call it*, matching D2. In practice it is the agent, but a
     *         worker is not locked out of escalating.
     *
     *      3. It must land *before the review window closes* (A1.3). After that the worker
     *         is already entitled and releaseAfterReview is open; the two conditions are
     *         exact complements, so exactly one of them is available at any timestamp.
     *
     *      A failing verdict moves to Disputed rather than refunding the agent outright.
     *      Refunding would hand the verdict signer unilateral power to take money off a
     *      worker who has already delivered — precisely the authority D9 exists to bound.
     */
    function disputeTask(
        bytes32 taskId,
        Verdict calldata verdict,
        bytes calldata signature
    ) external {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Delivered) {
            revert InvalidState(task.state, TaskState.Delivered);
        }
        if (msg.sender != task.agent && msg.sender != task.worker) revert NotParty();
        if (verdict.passed) revert VerdictResultMismatch();
        if (block.timestamp >= reviewDeadline(taskId)) revert ReviewWindowClosed();

        bytes32 digest = _consumeVerdict(taskId, task, verdict, signature);
        task.verdictHash = digest;
        task.verdictPassed = false;
        task.state = TaskState.Disputed;

        emit TaskDisputed(taskId, msg.sender, digest);
    }

    /**
     * @notice Owner accepts a dispute for adjudication.
     * @dev Disputed → Arbitrating is a marker, not a gate: resolveDispute works from
     *      either state. It exists so the D8 jury tier has a state to occupy without a
     *      further redeploy, and so an off-chain observer can tell "raised" from "being
     *      worked on".
     */
    function beginArbitration(bytes32 taskId) external onlyOwner {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Disputed) {
            revert InvalidState(task.state, TaskState.Disputed);
        }
        task.state = TaskState.Arbitrating;
        emit ArbitrationBegun(taskId);
    }

    /**
     * @notice Owner arbitrates a dispute.
     * @dev The only two reachable destinations are task.worker and task.agent, both fixed
     *      at funding (ADR-0001 D9). The owner directs which of the two, and nothing else.
     * @param releaseToWorker If true, worker gets paid. If false, agent is refunded.
     */
    function resolveDispute(
        bytes32 taskId,
        bool releaseToWorker
    ) external onlyOwner nonReentrant {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Disputed && task.state != TaskState.Arbitrating) {
            revert InvalidState(task.state, TaskState.Disputed);
        }

        uint256 amount = task.amount;
        address recipient = releaseToWorker ? task.worker : task.agent;

        task.state = TaskState.Resolved;
        totalLocked -= amount;

        usdc.safeTransfer(recipient, amount);

        emit TaskResolved(taskId, releaseToWorker, amount);
    }

    /**
     * @notice Agent claims their refund when the deadline passed with no submission.
     * @dev Agent-only, per Amendment 1 A1.2 — the agent claims their own refund, same
     *      pull-payment principle as releaseAfterReview. In v1 this was callable by
     *      anyone, which combined with the missing submitWork is what let a delivered
     *      task be refunded out from under the worker.
     *
     *      Only reachable from Funded. Once work is Delivered the deadline stops mattering
     *      and the review window governs.
     */
    function expireTask(bytes32 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Funded) {
            revert InvalidState(task.state, TaskState.Funded);
        }
        if (msg.sender != task.agent) revert NotAgent();
        if (block.timestamp < task.deadline) revert NotExpired();

        uint256 amount = task.amount;

        task.state = TaskState.Expired;
        totalLocked -= amount;

        usdc.safeTransfer(task.agent, amount);

        emit TaskExpired(taskId, amount);
    }

    // ── Verdict signer administration ───────────────────────────────────────────

    /**
     * @notice Add or remove a signer whose verdicts this contract accepts.
     * @dev ADR-0001 D9's v2 step — permissionless verdicts against a bond — is a change to
     *      this set plus a bonding contract, not a rewrite of the settlement path.
     */
    function setVerdictSigner(address signer, bool accepted) external onlyOwner {
        if (signer == address(0)) revert ZeroSigner();
        acceptedSigners[signer] = accepted;
        emit VerdictSignerUpdated(signer, accepted);
    }

    /**
     * @notice A signer burns one of their own nonces, revoking any unused signature that
     *         carries it.
     * @dev The only way to un-issue a signed verdict before its expiry. Without it a
     *      verdict signed in error is live until it lapses.
     */
    function revokeVerdictNonce(uint256 nonce) external {
        if (!acceptedSigners[msg.sender]) revert VerdictSignerNotAccepted(msg.sender);
        verdictNonceUsed[msg.sender][nonce] = true;
        emit VerdictNonceRevoked(msg.sender, nonce);
    }

    // ── Internal ────────────────────────────────────────────────────────────────

    /**
     * @dev Validates a presented verdict and consumes its nonce. Reverts unless the
     *      verdict binds this exact task, this exact spec and this exact evidence, is
     *      unexpired, is signed by an accepted signer, and has not been used before.
     * @return digest The EIP-712 digest, recorded as task.verdictHash.
     */
    function _consumeVerdict(
        bytes32 taskId,
        Task storage task,
        Verdict calldata verdict,
        bytes calldata signature
    ) internal returns (bytes32 digest) {
        if (verdict.taskId != taskId) revert VerdictTaskMismatch();
        // Binding both commitments is what stops a verdict about one submission being
        // presented against a different one, and what stops a verdict surviving a spec
        // that was changed after it was signed.
        if (verdict.specHash != task.specHash || verdict.evidenceHash != task.evidenceHash) {
            revert VerdictCommitmentMismatch();
        }
        if (block.timestamp > verdict.expiry) revert VerdictExpiredError();

        digest = verdictDigest(verdict);
        address signer = ECDSA.recover(digest, signature);

        if (!acceptedSigners[signer]) revert VerdictSignerNotAccepted(signer);
        if (verdictNonceUsed[signer][verdict.nonce]) revert VerdictNonceAlreadyUsed();

        verdictNonceUsed[signer][verdict.nonce] = true;
    }

    /// @dev Single exit for every worker payment, so the accounting cannot drift between
    ///      the three routes into Completed.
    function _payOut(
        bytes32 taskId,
        Task storage task,
        address worker,
        CompletionRoute route
    ) internal {
        uint256 amount = task.amount;

        task.state = TaskState.Completed;
        totalLocked -= amount;

        usdc.safeTransfer(worker, amount);

        emit TaskCompleted(taskId, worker, amount, route);
    }

    // ── View helpers ────────────────────────────────────────────────────────────

    /// @notice Read full task struct.
    function getTask(bytes32 taskId) external view returns (Task memory) {
        return tasks[taskId];
    }

    /**
     * @notice Timestamp at which the review window closes and the worker may claim.
     * @dev Reverts nothing for an unsubmitted task — it returns reviewWindow seconds past
     *      the epoch, which is always in the past. Callers gate on state, not on this.
     */
    function reviewDeadline(bytes32 taskId) public view returns (uint256) {
        Task storage task = tasks[taskId];
        return uint256(task.submittedAt) + uint256(task.reviewWindow);
    }

    /**
     * @notice The EIP-712 digest an accepted signer must sign for this verdict.
     * @dev Exposed so the signing service and any third party re-running a check can
     *      confirm exactly what was signed, rather than reimplementing the encoding.
     */
    function verdictDigest(Verdict calldata verdict) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        VERDICT_TYPEHASH,
                        verdict.taskId,
                        verdict.specHash,
                        verdict.evidenceHash,
                        verdict.checkerHash,
                        verdict.passed,
                        verdict.breakdownHash,
                        verdict.expiry,
                        verdict.nonce
                    )
                )
            );
    }

    /// @notice EIP-712 domain separator, for off-chain signers.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
