"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSignMessage } from "wagmi";
import { keccak256, toHex } from "viem";
import Link from "next/link";
import { CATEGORIES, validateCategorySelection } from "@/lib/categories";
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

// ── Profile editing (CC-021) — mirrors the PATCH /api/profile validation ─────

const AVAILABILITY_OPTIONS = ["available", "busy", "offline"] as const;
const MAX_RATE_USDC = 10_000;

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
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stakeInput, setStakeInput] = useState("");
  const [unstakeInput, setUnstakeInput] = useState("");
  const [disputeOpen, setDisputeOpen] = useState<Record<string, boolean>>({});
  const [disputeLoading, setDisputeLoading] = useState<string | null>(null);
  const [stakeStep, setStakeStep] = useState<"idle" | "approving" | "staking" | "unstaking">("idle");
  const [editOpen, setEditOpen] = useState(false);
  const [rateInput, setRateInput] = useState("");
  const [editCategories, setEditCategories] = useState<string[]>([]);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { writeContract, data: txHash } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
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
      fetch(`/api/profile?wallet=${address}`).then((r) => r.json()),
    ])
      .then(([tasksData, repData, profileData]) => {
        if (tasksData.ok) setTasks(tasksData.tasks);
        if (repData.ok) setReputation(repData.reputation);
        if (profileData.ok) {
          setProfile(profileData.profile);
          // Seed the edit form with the current values so saving an untouched
          // form is a no-op update rather than a surprise rewrite.
          setRateInput(String(profileData.profile.rate_usdc));
          setEditCategories(profileData.profile.categories);
        }
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

  // ── Profile editing (CC-021) ───────────────────────────────────────────────
  // Every change is wallet-signed and sent to PATCH /api/profile, which verifies
  // the signature server-side before writing with the service role.

  async function submitProfileUpdate(updates: {
    availability?: string;
    rate_usdc?: number;
    categories?: string[];
  }) {
    if (!address) return;
    setProfileSaving(true);
    setProfileMsg(null);
    try {
      // The server rejects messages older than 5 minutes and requires the
      // payload wallet to match the signer.
      const message = JSON.stringify({
        action: "profile-update",
        wallet: address,
        timestamp: Math.floor(Date.now() / 1000),
        ...updates,
      });
      const signature = await signMessageAsync({ message });

      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, message, signature }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setProfile(data.profile);
        setProfileMsg({ ok: true, text: "Profile updated" });
      } else {
        setProfileMsg({ ok: false, text: data.error ?? "Update failed" });
      }
    } catch {
      setProfileMsg({ ok: false, text: "Signing cancelled or request failed" });
    } finally {
      setProfileSaving(false);
    }
  }

  function handleAvailabilityChange(next: string) {
    if (profileSaving || next === profile?.availability) return;
    void submitProfileUpdate({ availability: next });
  }

  function handleSaveProfile() {
    const rate = parseFloat(rateInput);
    if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE_USDC || Math.round(rate * 100) / 100 !== rate) {
      setProfileMsg({
        ok: false,
        text: `Rate must be a positive number up to ${MAX_RATE_USDC} USDC with at most 2 decimal places`,
      });
      return;
    }
    const catResult = validateCategorySelection(editCategories);
    if (!catResult.valid) {
      setProfileMsg({ ok: false, text: catResult.error });
      return;
    }
    void submitProfileUpdate({ rate_usdc: rate, categories: editCategories });
  }

  function toggleEditCategory(slug: string) {
    setEditCategories((prev) =>
      prev.includes(slug) ? prev.filter((c) => c !== slug) : [...prev, slug],
    );
  }

  return (
    <PageShell>
      <div className={styles.content}>
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
                <div className={styles.profileRate}>
                  {profile.rate_usdc} USDC/hr
                </div>

                {/* Availability — one click signs and PATCHes immediately (CC-021) */}
                <div className={styles.availabilityRow}>
                  <span className={styles.availabilityLabel}>Availability</span>
                  <div className={styles.availabilityToggle}>
                    {AVAILABILITY_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => handleAvailabilityChange(option)}
                        disabled={profileSaving}
                        className={`${styles.availabilityOption} ${
                          profile.availability === option ? styles.availabilityActive : ""
                        } ${option === "available" ? styles.availabilityAvailable : ""} ${
                          option === "busy" ? styles.availabilityBusy : ""
                        } ${option === "offline" ? styles.availabilityOffline : ""
                        }`}
                      >
                        {option === "available"
                          ? "Available"
                          : option === "busy"
                            ? "Busy"
                            : "Offline"}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  className={styles.profileEditToggle}
                  onClick={() => {
                    setEditOpen((prev) => !prev);
                    setProfileMsg(null);
                  }}
                >
                  {editOpen ? "Cancel" : "Edit profile"}
                </button>

                {editOpen && (
                  <div className={styles.profileEditForm}>
                    <label className={styles.profileFieldLabel}>
                      Rate (USDC/hr)
                      <input
                        type="number"
                        min="0.01"
                        max={MAX_RATE_USDC}
                        step="0.01"
                        value={rateInput}
                        onChange={(e) => setRateInput(e.target.value)}
                        className={styles.profileInput}
                      />
                    </label>
                    <div className={styles.profileFieldLabel}>
                      Categories (max 2)
                      <div className={styles.categoryPicker}>
                        {CATEGORIES.map((cat) => (
                          <label key={cat.slug} className={styles.categoryOption}>
                            <input
                              type="checkbox"
                              checked={editCategories.includes(cat.slug)}
                              onChange={() => toggleEditCategory(cat.slug)}
                              disabled={
                                !editCategories.includes(cat.slug) && editCategories.length >= 2
                              }
                            />
                            {cat.label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleSaveProfile}
                      disabled={profileSaving}
                      className={styles.profileSaveBtn}
                    >
                      {profileSaving ? "Confirm in wallet..." : "Save changes"}
                    </button>
                    <p className={styles.profileEditNote}>
                      Saving asks your wallet to sign the update — the server
                      verifies the signature before applying it.
                    </p>
                  </div>
                )}

                {profileMsg && (
                  <p className={profileMsg.ok ? styles.profileMsgOk : styles.profileMsgErr}>
                    {profileMsg.text}
                  </p>
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
                  <Link href="/connect">registered your services</Link> so agents
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
      </div>
    </PageShell>
  );
}
