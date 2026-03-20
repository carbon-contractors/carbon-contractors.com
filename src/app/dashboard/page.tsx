"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import {
  ConnectWallet,
  Wallet,
  WalletDropdown,
  WalletDropdownDisconnect,
} from "@coinbase/onchainkit/wallet";
import { Address, Avatar, Name, Identity } from "@coinbase/onchainkit/identity";
import { keccak256, toHex } from "viem";
import Link from "next/link";
import styles from "./dashboard.module.css";

// ── ABIs for write operations ───────────────────────────────────────────────

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

const STAKE_ABI = [
  {
    type: "function",
    name: "stake",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "unstake",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const DISPUTE_ABI = [
  {
    type: "function",
    name: "disputeTask",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ── USDC address (set via env var — differs per network) ────────────────────

const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS!;
const USDC_DECIMALS = 6;

// ── Types ───────────────────────────────────────────────────────────────────

interface OnChainState {
  state: string;
  amount_wei: string;
  deadline: number;
}

interface Task {
  id: string;
  payment_request_id: string;
  from_agent_wallet: string;
  to_human_wallet: string;
  task_description: string;
  amount_usdc: number;
  deadline_unix: number;
  status: string;
  tx_hash: string | null;
  escrow_contract: string | null;
  created_at: string;
  on_chain: OnChainState | null;
}

interface ReputationBreakdown {
  completion: number;
  volume: number;
  recency: number;
  stake: number;
  total: number;
}

interface Reputation {
  wallet: string;
  score: number;
  breakdown: ReputationBreakdown;
  tasks: {
    total: number;
    completed: number;
    disputed: number;
    total_earned_usdc: number;
    completion_rate: number | null;
  };
  stake: {
    amount_usdc: number;
    staked_at: number;
    slashed_total_usdc: number;
    contract: string | null;
  };
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatDeadline(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusClass(status: string): string {
  switch (status) {
    case "pending":
      return styles.statusPending;
    case "active":
      return styles.statusActive;
    case "completed":
      return styles.statusCompleted;
    case "disputed":
      return styles.statusDisputed;
    case "expired":
      return styles.statusExpired;
    default:
      return styles.statusExpired;
  }
}

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reputation, setReputation] = useState<Reputation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stakeInput, setStakeInput] = useState("");
  const [unstakeInput, setUnstakeInput] = useState("");
  const [disputeOpen, setDisputeOpen] = useState<Record<string, boolean>>({});
  const [disputeLoading, setDisputeLoading] = useState<string | null>(null);
  const [stakeStep, setStakeStep] = useState<"idle" | "approving" | "staking" | "unstaking">("idle");

  const { writeContract, data: txHash } = useWriteContract();
  const { isSuccess: txConfirmed } = useWaitForTransactionReceipt({ hash: txHash });

  const stakeContractAddress = reputation?.stake?.contract as `0x${string}` | undefined;

  const fetchData = useCallback(() => {
    if (!isConnected || !address) {
      setTasks([]);
      setReputation(null);
      return;
    }

    setLoading(true);
    setError("");

    Promise.all([
      fetch(`/api/tasks?wallet=${address}`).then((r) => r.json()),
      fetch(`/api/reputation?wallet=${address}`).then((r) => r.json()),
    ])
      .then(([tasksData, repData]) => {
        if (tasksData.ok) setTasks(tasksData.tasks);
        if (repData.ok) setReputation(repData.reputation);
        if (!tasksData.ok && !repData.ok) {
          setError("Failed to fetch data");
        }
      })
      .catch(() => setError("Network error"))
      .finally(() => setLoading(false));
  }, [isConnected, address]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Refresh after tx confirms
  useEffect(() => {
    if (txConfirmed) {
      setStakeStep("idle");
      setStakeInput("");
      setUnstakeInput("");
      fetchData();
    }
  }, [txConfirmed, fetchData]);

  function handleStake() {
    if (!stakeContractAddress || !stakeInput) return;
    const amountWei = BigInt(Math.round(parseFloat(stakeInput) * 10 ** USDC_DECIMALS));

    if (stakeStep === "idle") {
      // Step 1: Approve USDC
      setStakeStep("approving");
      writeContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [stakeContractAddress, amountWei],
      });
    }
  }

  // After approval confirmed, do the actual stake
  useEffect(() => {
    if (txConfirmed && stakeStep === "approving" && stakeContractAddress && stakeInput) {
      const amountWei = BigInt(Math.round(parseFloat(stakeInput) * 10 ** USDC_DECIMALS));
      setStakeStep("staking");
      writeContract({
        address: stakeContractAddress,
        abi: STAKE_ABI,
        functionName: "stake",
        args: [amountWei],
      });
    }
  }, [txConfirmed, stakeStep, stakeContractAddress, stakeInput, writeContract]);

  function handleUnstake() {
    if (!stakeContractAddress || !unstakeInput) return;
    const amountWei = BigInt(Math.round(parseFloat(unstakeInput) * 10 ** USDC_DECIMALS));
    setStakeStep("unstaking");
    writeContract({
      address: stakeContractAddress,
      abi: STAKE_ABI,
      functionName: "unstake",
      args: [amountWei],
    });
  }

  const cooldownReady = reputation?.stake?.staked_at
    ? reputation.stake.staked_at + 7 * 24 * 3600 <= Date.now() / 1000
    : true;

  const cooldownDate = reputation?.stake?.staked_at
    ? new Date((reputation.stake.staked_at + 7 * 24 * 3600) * 1000)
    : null;

  const escrowContract = process.env.NEXT_PUBLIC_ESCROW_CONTRACT as `0x${string}` | undefined;

  async function handleDispute(task: Task) {
    if (!escrowContract) return;
    setDisputeLoading(task.payment_request_id);
    try {
      // 1. Call escrow.disputeTask on-chain
      const taskIdBytes32 = keccak256(toHex(task.payment_request_id));
      writeContract({
        address: escrowContract,
        abi: DISPUTE_ABI,
        functionName: "disputeTask",
        args: [taskIdBytes32],
      });
      // 2. Update DB via REST
      await fetch("/api/dispute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_request_id: task.payment_request_id }),
      });
    } catch {
      // on-chain tx may fail — DB update still attempted
    } finally {
      setDisputeLoading(null);
      fetchData();
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.title}>
          Carbon Contractors
        </Link>
        <Wallet>
          <ConnectWallet />
          <WalletDropdown>
            <Identity hasCopyAddressOnClick>
              <Avatar />
              <Name />
              <Address />
            </Identity>
            <WalletDropdownDisconnect />
          </WalletDropdown>
        </Wallet>
      </header>

      <main className={styles.main}>
        {!isConnected ? (
          <div className={styles.hero}>
            <h2>Worker Dashboard</h2>
            <p>
              Connect your wallet to view tasks assigned to you by AI agents.
            </p>
          </div>
        ) : (
          <>
            {loading && <p className={styles.loading}>Loading...</p>}
            {error && <p style={{ color: "#ff4444" }}>{error}</p>}

            {/* ── Reputation + Staking ────────────────────────────────── */}
            {reputation && (
              <div className={styles.reputationRow}>
                <div className={styles.reputationCard}>
                  <div className={styles.scoreDisplay}>
                    <span className={styles.scoreNumber}>
                      {reputation.score}
                    </span>
                    <span className={styles.scoreLabel}>Reputation</span>
                  </div>
                  <div className={styles.breakdownGrid}>
                    <div className={styles.breakdownItem}>
                      <span className={styles.breakdownValue}>
                        {reputation.breakdown.completion}
                      </span>
                      <span className={styles.breakdownLabel}>Completion</span>
                    </div>
                    <div className={styles.breakdownItem}>
                      <span className={styles.breakdownValue}>
                        {reputation.breakdown.volume}
                      </span>
                      <span className={styles.breakdownLabel}>Volume</span>
                    </div>
                    <div className={styles.breakdownItem}>
                      <span className={styles.breakdownValue}>
                        {reputation.breakdown.recency}
                      </span>
                      <span className={styles.breakdownLabel}>Recency</span>
                    </div>
                    <div className={styles.breakdownItem}>
                      <span className={styles.breakdownValue}>
                        {reputation.breakdown.stake}
                      </span>
                      <span className={styles.breakdownLabel}>Stake</span>
                    </div>
                  </div>
                  <div className={styles.reputationStats}>
                    <span>{reputation.tasks.completed} completed</span>
                    <span>{reputation.tasks.total_earned_usdc} USDC earned</span>
                    {reputation.tasks.completion_rate !== null && (
                      <span>{reputation.tasks.completion_rate}% rate</span>
                    )}
                  </div>
                </div>

                {stakeContractAddress && (
                  <div className={styles.stakePanel}>
                    <h3 className={styles.stakePanelTitle}>USDC Stake</h3>
                    <div className={styles.stakeAmount}>
                      {reputation.stake.amount_usdc} USDC
                    </div>
                    {reputation.stake.slashed_total_usdc > 0 && (
                      <div className={styles.slashedNote}>
                        {reputation.stake.slashed_total_usdc} USDC slashed
                      </div>
                    )}

                    <div className={styles.stakeActions}>
                      <div className={styles.stakeInputGroup}>
                        <input
                          type="number"
                          placeholder="Amount (min 20)"
                          value={stakeInput}
                          onChange={(e) => setStakeInput(e.target.value)}
                          className={styles.stakeInput}
                          min="20"
                          step="1"
                        />
                        <button
                          onClick={handleStake}
                          disabled={
                            stakeStep !== "idle" || !stakeInput || parseFloat(stakeInput) < 20
                          }
                          className={styles.stakeBtn}
                        >
                          {stakeStep === "approving"
                            ? "Approving..."
                            : stakeStep === "staking"
                              ? "Staking..."
                              : "Stake"}
                        </button>
                      </div>

                      {reputation.stake.amount_usdc > 0 && (
                        <div className={styles.stakeInputGroup}>
                          <input
                            type="number"
                            placeholder="Amount to unstake"
                            value={unstakeInput}
                            onChange={(e) => setUnstakeInput(e.target.value)}
                            className={styles.stakeInput}
                            max={reputation.stake.amount_usdc}
                            step="1"
                          />
                          <button
                            onClick={handleUnstake}
                            disabled={
                              stakeStep !== "idle" ||
                              !unstakeInput ||
                              !cooldownReady
                            }
                            className={styles.unstakeBtn}
                          >
                            {stakeStep === "unstaking"
                              ? "Unstaking..."
                              : "Unstake"}
                          </button>
                        </div>
                      )}

                      {!cooldownReady && cooldownDate && (
                        <p className={styles.cooldownNote}>
                          Cooldown until{" "}
                          {cooldownDate.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Tasks ──────────────────────────────────────────────── */}
            <h2 className={styles.pageTitle}>Your Tasks</h2>

            {!loading && !error && tasks.length === 0 && (
              <div className={styles.emptyState}>
                <p>No tasks assigned yet.</p>
                <p>
                  Make sure you&apos;ve{" "}
                  <Link href="/connect">registered your skills</Link> so agents
                  can find you.
                </p>
              </div>
            )}

            {tasks.length > 0 && (
              <div className={styles.taskList}>
                {tasks.map((task) => (
                  <div key={task.id} className={styles.taskCard}>
                    <div className={styles.taskHeader}>
                      <span
                        className={`${styles.statusBadge} ${statusClass(task.status)}`}
                      >
                        {task.status}
                      </span>
                      <span className={styles.amount}>
                        {task.amount_usdc} USDC
                      </span>
                    </div>
                    <p className={styles.description}>
                      {task.task_description}
                    </p>
                    <div className={styles.meta}>
                      <span>
                        <span className={styles.metaLabel}>Agent: </span>
                        <span className={styles.metaValue}>
                          {truncateAddress(task.from_agent_wallet)}
                        </span>
                      </span>
                      <span>
                        <span className={styles.metaLabel}>Deadline: </span>
                        <span className={styles.metaValue}>
                          {formatDeadline(task.deadline_unix)}
                        </span>
                      </span>
                      <span>
                        <span className={styles.metaLabel}>ID: </span>
                        <span className={styles.metaValue}>
                          {task.payment_request_id.slice(0, 12)}...
                        </span>
                      </span>
                      {task.on_chain && (
                        <span className={styles.onChainBadge}>
                          on-chain: {task.on_chain.state}
                        </span>
                      )}
                    </div>

                    {/* Dispute section for active tasks */}
                    {task.status === "active" && escrowContract && (
                      <div className={styles.disputeSection}>
                        <button
                          className={styles.disputeToggle}
                          onClick={() =>
                            setDisputeOpen((prev) => ({
                              ...prev,
                              [task.id]: !prev[task.id],
                            }))
                          }
                        >
                          {disputeOpen[task.id] ? "Cancel" : "Dispute this task"}
                        </button>
                        {disputeOpen[task.id] && (
                          <div className={styles.disputeForm}>
                            <p className={styles.disputeWarning}>
                              Disputing will freeze escrowed funds until the
                              platform owner resolves the dispute.
                            </p>
                            <button
                              className={styles.disputeBtn}
                              onClick={() => handleDispute(task)}
                              disabled={disputeLoading === task.payment_request_id}
                            >
                              {disputeLoading === task.payment_request_id
                                ? "Submitting..."
                                : "Confirm Dispute"}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
