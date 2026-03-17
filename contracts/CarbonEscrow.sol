// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CarbonEscrow
 * @notice Holds USDC in escrow while a human completes work for an AI agent.
 *         The agent funds a task, the platform confirms completion, and funds
 *         release to the worker. Disputes are resolved by the platform owner.
 *
 * @dev Task lifecycle:
 *   None → Funded (agent calls createTask with USDC approval)
 *   Funded → Completed (agent confirms, funds release to worker)
 *   Funded → Disputed (either party disputes)
 *   Funded → Expired (anyone calls after deadline, refunds agent)
 *   Disputed → Resolved (owner arbitrates)
 */
contract CarbonEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    enum TaskState {
        None,
        Funded,
        Completed,
        Disputed,
        Resolved,
        Expired
    }

    struct Task {
        address agent;
        address worker;
        uint256 amount;
        uint256 deadline;
        TaskState state;
    }

    /// @notice taskId (bytes32 of payment_request_id) → Task
    mapping(bytes32 => Task) public tasks;

    /// @notice Running total of USDC locked across all active tasks
    uint256 public totalLocked;

    // ── Events ──────────────────────────────────────────────────────────────────

    event TaskCreated(
        bytes32 indexed taskId,
        address indexed agent,
        address indexed worker,
        uint256 amount,
        uint256 deadline
    );

    event TaskCompleted(bytes32 indexed taskId, uint256 amount);
    event TaskDisputed(bytes32 indexed taskId, address by);
    event TaskResolved(bytes32 indexed taskId, bool releasedToWorker, uint256 amount);
    event TaskExpired(bytes32 indexed taskId, uint256 refunded);

    // ── Errors ──────────────────────────────────────────────────────────────────

    error TaskAlreadyExists();
    error InvalidWorker();
    error ZeroAmount();
    error DeadlinePassed();
    error InvalidState(TaskState current, TaskState expected);
    error NotParty();
    error NotExpired();

    // ── Constructor ─────────────────────────────────────────────────────────────

    /**
     * @param _usdc Address of the USDC token contract on Base.
     */
    constructor(address _usdc) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
    }

    // ── Core lifecycle ──────────────────────────────────────────────────────────

    /**
     * @notice Fund a new task. Caller must have approved this contract for `amount`.
     * @param taskId Unique task identifier (keccak256 of payment_request_id)
     * @param worker Address of the human worker
     * @param amount USDC amount (6 decimals on Base)
     * @param deadline Unix timestamp after which the task can be expired
     */
    function createTask(
        bytes32 taskId,
        address worker,
        uint256 amount,
        uint256 deadline
    ) external nonReentrant {
        if (tasks[taskId].state != TaskState.None) revert TaskAlreadyExists();
        if (worker == address(0)) revert InvalidWorker();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlinePassed();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        tasks[taskId] = Task({
            agent: msg.sender,
            worker: worker,
            amount: amount,
            deadline: deadline,
            state: TaskState.Funded
        });

        totalLocked += amount;

        emit TaskCreated(taskId, msg.sender, worker, amount, deadline);
    }

    /**
     * @notice Agent confirms task completion → funds release to worker.
     * @dev Only the agent who funded the task can confirm.
     */
    function completeTask(bytes32 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Funded) {
            revert InvalidState(task.state, TaskState.Funded);
        }
        require(msg.sender == task.agent, "only agent");

        task.state = TaskState.Completed;
        totalLocked -= task.amount;

        usdc.safeTransfer(task.worker, task.amount);

        emit TaskCompleted(taskId, task.amount);
    }

    /**
     * @notice Either party raises a dispute. Funds stay locked until owner resolves.
     */
    function disputeTask(bytes32 taskId) external {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Funded) {
            revert InvalidState(task.state, TaskState.Funded);
        }
        if (msg.sender != task.agent && msg.sender != task.worker) {
            revert NotParty();
        }

        task.state = TaskState.Disputed;

        emit TaskDisputed(taskId, msg.sender);
    }

    /**
     * @notice Platform owner resolves a dispute.
     * @param releaseToWorker If true, worker gets paid. If false, agent is refunded.
     */
    function resolveDispute(
        bytes32 taskId,
        bool releaseToWorker
    ) external onlyOwner nonReentrant {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Disputed) {
            revert InvalidState(task.state, TaskState.Disputed);
        }

        task.state = TaskState.Resolved;
        totalLocked -= task.amount;

        address recipient = releaseToWorker ? task.worker : task.agent;
        usdc.safeTransfer(recipient, task.amount);

        emit TaskResolved(taskId, releaseToWorker, task.amount);
    }

    /**
     * @notice Refund the agent if the deadline has passed and task is still funded.
     * @dev Anyone can call this — no reason to gate it.
     */
    function expireTask(bytes32 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (task.state != TaskState.Funded) {
            revert InvalidState(task.state, TaskState.Funded);
        }
        if (block.timestamp < task.deadline) revert NotExpired();

        task.state = TaskState.Expired;
        totalLocked -= task.amount;

        usdc.safeTransfer(task.agent, task.amount);

        emit TaskExpired(taskId, task.amount);
    }

    // ── View helpers ────────────────────────────────────────────────────────────

    /**
     * @notice Read full task struct.
     */
    function getTask(bytes32 taskId) external view returns (Task memory) {
        return tasks[taskId];
    }
}
