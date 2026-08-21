"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSignMessage } from "wagmi";
import { keccak256, toHex } from "viem";
import Link from "next/link";
import PageShell from "@/components/PageShell";
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

interface Profile {
  wallet: string;
  categories: string[];
  rate_usdc: number;
  availability: string;
}

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
  acceptance_spec: string | null;
  spec_hash: string | null;
  spec_schema_version: number | null;
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

interface AuthHeaders extends Record<string, string> {
  "x-caller-wallet": string;
  "x-caller-signature": string;
  "x-caller-nonce": string;
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

function AcceptanceSpecDisplay({
  specJson,
  specHash,
  version,
}: {
  specJson: string | null;
  specHash: string | null;
  version: number | null;
}) {
  if (!specJson) {
    return (
      <div className={styles.specSection}>
        <div className={styles.specHeader}>
          <span className={styles.specTitle}>Acceptance Criteria</span>
        </div>
        <p className={styles.specUnstructured}>
          Unstructured task — qualitative review by hiring agent (no automated checks).
        </p>
      </div>
    );
  }

  let criteria: {
    min_artefacts?: number;
    exif_gps_within_m?: { lat: number; lon: number; radius_m: number };
    captured_after?: string;
    provenance?: { require_camera_model?: boolean; reject_c2pa_ai_generated?: boolean };
    phash_max_similarity_to?: { source: string; threshold: number };
  } | null = null;

  let bucket: { provider: string; target: string } | null = null;

  try {
    const parsed = JSON.parse(specJson);
    criteria = parsed.criteria;
    bucket = parsed.evidence_bucket;
  } catch {
    return null;
  }

  const items: React.ReactNode[] = [];

  if (criteria?.min_artefacts) {
    items.push(
      <div key="artefacts" className={styles.specCriterion}>
        <span className={styles.specCriterionIcon}>✓</span>
        <span>
          <strong>Artifacts:</strong> {criteria.min_artefacts} evidence file(s) required
        </span>
      </div>,
    );
  }

  if (criteria?.exif_gps_within_m) {
    const { lat, lon, radius_m } = criteria.exif_gps_within_m;
    items.push(
      <div key="gps" className={styles.specCriterion}>
        <span className={styles.specCriterionIcon}>✓</span>
        <span>
          <strong>GPS Radius:</strong> [{lat.toFixed(4)}, {lon.toFixed(4)}] within {radius_m}m
        </span>
      </div>,
    );
  }

  if (criteria?.captured_after) {
    const afterText =
      criteria.captured_after === "task_funding_block_timestamp"
        ? "Must be captured after task funding block"
        : `Captured after ${criteria.captured_after}`;
    items.push(
      <div key="captured_after" className={styles.specCriterion}>
        <span className={styles.specCriterionIcon}>✓</span>
        <span>
          <strong>Capture Window:</strong> {afterText}
        </span>
      </div>,
    );
  }

  if (criteria?.provenance) {
    const prov = criteria.provenance;
    const provParts: string[] = [];
    if (prov.require_camera_model) provParts.push("Camera Make/Model metadata required");
    if (prov.reject_c2pa_ai_generated) provParts.push("AI Generation rejected (C2PA)");
    if (provParts.length > 0) {
      items.push(
        <div key="provenance" className={styles.specCriterion}>
          <span className={styles.specCriterionIcon}>✓</span>
          <span>
            <strong>Provenance:</strong> {provParts.join(" · ")}
          </span>
        </div>,
      );
    }
  }

  if (criteria?.phash_max_similarity_to) {
    const { source, threshold } = criteria.phash_max_similarity_to;
    items.push(
      <div key="phash" className={styles.specCriterion}>
        <span className={styles.specCriterionIcon}>✓</span>
        <span>
          <strong>Visual Similarity:</strong> Max {Math.round(threshold * 100)}% similarity to {source}
        </span>
      </div>,
    );
  }

  if (bucket) {
    items.push(
      <div key="bucket" className={styles.specCriterion}>
        <span className={styles.specCriterionIcon}>✓</span>
        <span>
          <strong>Evidence Store:</strong> {bucket.provider.toUpperCase()} ({bucket.target})
        </span>
      </div>,
    );
  }

  return (
    <div className={styles.specSection}>
      <div className={styles.specHeader}>
        <span className={styles.specTitle}>Machine-Checkable Spec</span>
        <div className={styles.specBadges}>
          <span className={styles.specVersionBadge}>v{version ?? 1}</span>
          {specHash && (
            <span className={styles.specHashBadge} title={specHash}>
              {specHash.slice(0, 10)}...{specHash.slice(-6)}
            </span>
          )}
        </div>
      </div>
      <div className={styles.specCriteriaList}>
        {items.length > 0 ? (
          items
        ) : (
          <p className={styles.specUnstructured}>No machine criteria committed</p>
        )}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reputation, setReputation] = useState<Reputation | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [authHeaders, setAuthHeaders] = useState<AuthHeaders | null>(null);
  const [authError, setAuthError] = useState("");
  const [error, setError] = useState("");
  const [stakeInput, setStakeInput] = useState("");
  const [unstakeInput, setUnstakeInput] = useState("");
  const [disputeOpen, setDisputeOpen] = useState<Record<string, boolean>>({});
  const [disputeLoading, setDisputeLoading] = useState<string | null>(null);
  const [stakeStep, setStakeStep] = useState<"idle" | "approving" | "staking" | "unstaking">("idle");

  const { writeContract, data: txHash } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const { isSuccess: txConfirmed } = useWaitForTransactionReceipt({ hash: txHash });

  const stakeContractAddress = reputation?.stake?.contract as `0x${string}` | undefined;

  // Clear state on disconnect or wallet change
  useEffect(() => {
    setAuthHeaders(null);
    setTasks([]);
    setReputation(null);
    setProfile(null);
    setAuthError("");
  }, [address, isConnected]);

  const authenticateWallet = useCallback(async () => {
    if (!address) return;
    setAuthenticating(true);
    setAuthError("");
    try {
      const challengeRes = await fetch("/api/basedhuman.mcp/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address }),
      });
      const challengeData = await challengeRes.json();
      if (!challengeRes.ok || !challengeData.nonce) {
        throw new Error(challengeData.error || "Failed to obtain authentication challenge");
      }

      const signature = (await signMessageAsync({
        message: challengeData.message,
      })) as `0x${string}`;

      const headers: AuthHeaders = {
        "x-caller-wallet": address,
        "x-caller-signature": signature,
        "x-caller-nonce": challengeData.nonce,
      };

      setAuthHeaders(headers);

      // Fetch private tasks immediately with authenticated headers
      const tasksRes = await fetch("/api/tasks", { headers }).then((r) => r.json());
      if (tasksRes.ok) {
        setTasks(tasksRes.tasks);
      } else {
        setAuthError(tasksRes.error || "Failed to fetch private tasks");
      }
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : "Authentication cancelled or failed");
    } finally {
      setAuthenticating(false);
    }
  }, [address, signMessageAsync]);

  const fetchData = useCallback(() => {
    if (!isConnected || !address) {
      setTasks([]);
      setReputation(null);
      return;
    }

    setLoading(true);
    setError("");

    const fetchTasksPromise = authHeaders
      ? fetch("/api/tasks", { headers: authHeaders }).then((r) => r.json())
      : Promise.resolve(null);

    Promise.all([
      fetchTasksPromise,
      fetch(`/api/reputation?wallet=${address}`).then((r) => r.json()),
      fetch(`/api/profile?wallet=${address}`).then((r) => r.json()),
    ])
      .then(([tasksData, repData, profileData]) => {
        if (tasksData?.ok) setTasks(tasksData.tasks);
        if (repData?.ok) setReputation(repData.reputation);
        if (profileData?.ok) setProfile(profileData.profile);
        if (!repData?.ok && !profileData?.ok) {
          setError("Failed to fetch profile/reputation data");
        }
      })
      .catch(() => setError("Network error"))
      .finally(() => setLoading(false));
  }, [isConnected, address, authHeaders]);

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
    if (!escrowContract || !address) return;
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

      // 2. Prove wallet ownership (CC-004), then update DB via REST
      const challengeRes = await fetch("/api/basedhuman.mcp/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address }),
      });
      const { nonce, message } = await challengeRes.json();
      const signature = await signMessageAsync({ message });

      await fetch("/api/dispute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-caller-wallet": address,
          "x-caller-signature": signature,
          "x-caller-nonce": nonce,
        },
        body: JSON.stringify({ payment_request_id: task.payment_request_id }),
      });
    } catch {
      // on-chain tx or signing may fail — best-effort
    } finally {
      setDisputeLoading(null);
      fetchData();
    }
  }

  return (
    <PageShell>
      <div className={styles.content}>
        {!isConnected ? (
          <div className={styles.hero}>
            <h2>Worker Dashboard</h2>
            <p>Connect your wallet to view tasks assigned to you by AI agents.</p>
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
                    <span className={styles.scoreNumber}>{reputation.score}</span>
                    <span className={styles.scoreLabel}>Reputation</span>
                  </div>
                  <div className={styles.breakdownGrid}>
                    <div className={styles.breakdownItem}>
                      <span className={styles.breakdownValue}>{reputation.breakdown.completion}</span>
                      <span className={styles.breakdownLabel}>Completion</span>
                    </div>
                    <div className={styles.breakdownItem}>
                      <span className={styles.breakdownValue}>{reputation.breakdown.volume}</span>
                      <span className={styles.breakdownLabel}>Volume</span>
                    </div>
                    <div className={styles.breakdownItem}>
                      <span className={styles.breakdownValue}>{reputation.breakdown.recency}</span>
                      <span className={styles.breakdownLabel}>Recency</span>
                    </div>
                    <div className={styles.breakdownItem}>
                      <span className={styles.breakdownValue}>{reputation.breakdown.stake}</span>
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
                    <div className={styles.stakeAmount}>{reputation.stake.amount_usdc} USDC</div>
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
                          disabled={stakeStep !== "idle" || !stakeInput || parseFloat(stakeInput) < 20}
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
                            disabled={stakeStep !== "idle" || !unstakeInput || !cooldownReady}
                            className={styles.unstakeBtn}
                          >
                            {stakeStep === "unstaking" ? "Unstaking..." : "Unstake"}
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

            {/* ── Profile ─────────────────────────────────────────────── */}
            {profile && (
              <div className={styles.profileCard}>
                <h3 className={styles.profileTitle}>Your Profile</h3>
                <div className={styles.profileCategories}>
                  {profile.categories.map((cat) => (
                    <span key={cat} className={styles.profileCategoryBadge}>
                      {cat}
                    </span>
                  ))}
                </div>
                <div className={styles.profileRate}>{profile.rate_usdc} USDC/hr</div>
              </div>
            )}

            {/* ── Tasks ──────────────────────────────────────────────── */}
            <h2 className={styles.pageTitle}>Your Tasks</h2>

            {!authHeaders ? (
              <div className={styles.authPromptCard}>
                <p className={styles.authPromptText}>
                  Task descriptions and acceptance criteria are private. Sign a challenge with your
                  connected wallet to securely access your task list.
                </p>
                {authError && <p style={{ color: "#ff4444", fontSize: "0.8rem" }}>{authError}</p>}
                <button
                  onClick={authenticateWallet}
                  disabled={authenticating}
                  className={styles.authPromptBtn}
                >
                  {authenticating ? "Verifying Signature..." : "Sign to View Tasks"}
                </button>
              </div>
            ) : (
              <>
                {!loading && tasks.length === 0 && (
                  <div className={styles.emptyState}>
                    <p>No tasks assigned yet.</p>
                    <p>
                      Make sure you&apos;ve <Link href="/connect">registered your services</Link> so
                      agents can find you.
                    </p>
                  </div>
                )}

                {tasks.length > 0 && (
                  <div className={styles.taskList}>
                    {tasks.map((task) => (
                      <div key={task.id} className={styles.taskCard}>
                        <div className={styles.taskHeader}>
                          <span className={`${styles.statusBadge} ${statusClass(task.status)}`}>
                            {task.status}
                          </span>
                          <span className={styles.amount}>{task.amount_usdc} USDC</span>
                        </div>
                        <p className={styles.description}>{task.task_description}</p>

                        {/* Machine-checkable Acceptance Spec display (CC-084) */}
                        <AcceptanceSpecDisplay
                          specJson={task.acceptance_spec}
                          specHash={task.spec_hash}
                          version={task.spec_schema_version}
                        />

                        <div className={styles.meta} style={{ marginTop: "0.75rem" }}>
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
                                  Disputing will freeze escrowed funds until the platform owner
                                  resolves the dispute.
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
          </>
        )}
      </div>
    </PageShell>
  );
}
