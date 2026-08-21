"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSignMessage } from "wagmi";
import { keccak256, toHex } from "viem";
import Link from "next/link";
import { CATEGORIES, validateCategorySelection } from "@/lib/categories";
import PageShell from "@/components/PageShell";
import { isNewWorker } from "@/lib/reputation/compute";
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

type ChannelType = "email" | "webhook" | "telegram" | "discord";

interface Channel {
  id: string;
  type: ChannelType;
  address: string;
  accepts_auto_booking: boolean;
}

const CHANNEL_TYPES: { value: ChannelType; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "webhook", label: "Webhook" },
  { value: "telegram", label: "Telegram" },
  { value: "discord", label: "Discord" },
];

const CHANNEL_EXPLAINERS: Record<ChannelType, string> = {
  email:
    "Notifications are sent to this email address. It is stored privately and never shown on your public profile.",
  webhook:
    "An HTTPS URL that receives a POST request when something happens. Use an automation endpoint or webhook relay you control.",
  telegram:
    "Your Telegram chat ID — a number, not your @username. Message @userinfobot on Telegram to find yours (group chats have negative IDs).",
  discord:
    "Your Discord user ID — a long number, not your @handle. Enable Developer Mode in Discord, then right-click your name and choose Copy User ID.",
};

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

  // CC-011: the staking panel starts collapsed for workers with no stake. The override
  // is null until the user toggles, so the default tracks `hasStake` as it loads.
  const [stakeOpenOverride, setStakeOpenOverride] = useState<boolean | null>(null);

  // ── Notification channels (CC-073) ────────────────────────────────────────
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsLoaded, setChannelsLoaded] = useState(false);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState("");
  const [channelFormOpen, setChannelFormOpen] = useState(false);
  const [newChannelType, setNewChannelType] = useState<ChannelType>("email");
  const [newChannelAddress, setNewChannelAddress] = useState("");
  const [channelBusy, setChannelBusy] = useState(false);

  const { writeContract, data: txHash } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const { isSuccess: txConfirmed } = useWaitForTransactionReceipt({ hash: txHash });

  const stakeContractAddress = reputation?.stake?.contract as `0x${string}` | undefined;

  // CC-010: 0 tasks + 0 stake means "new", not "score of zero".
  const newWorker = reputation
    ? isNewWorker({
        totalTasks: reputation.tasks.total,
        stakeAmountUsdc: reputation.stake.amount_usdc,
      })
    : false;

  const hasStake = (reputation?.stake?.amount_usdc ?? 0) > 0;
  const stakeOpen = stakeOpenOverride ?? hasStake;

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

  // ── Notification channels (CC-073) ──────────────────────────────────────

  // Every channels call needs a fresh challenge-response signature (CC-004),
  // so each load/add/remove prompts one wallet signature.
  async function signedChannelHeaders(): Promise<Record<string, string>> {
    if (!address) throw new Error("Wallet not connected");
    const challengeRes = await fetch("/api/basedhuman.mcp/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: address }),
    });
    const { nonce, message } = await challengeRes.json();
    const signature = await signMessageAsync({ message });
    return {
      "Content-Type": "application/json",
      "x-caller-wallet": address,
      "x-caller-signature": signature,
      "x-caller-nonce": nonce,
    };
  }

  async function loadChannels() {
    if (!address) return;
    setChannelsLoading(true);
    setChannelsError("");
    try {
      const res = await fetch("/api/channels", {
        headers: await signedChannelHeaders(),
      });
      const data = await res.json();
      if (data.ok) {
        setChannels(data.channels);
        setChannelsLoaded(true);
      } else {
        setChannelsError(data.error ?? "Failed to load channels");
      }
    } catch {
      setChannelsError("Network error");
    } finally {
      setChannelsLoading(false);
    }
  }

  async function handleAddChannel() {
    if (!newChannelAddress.trim()) return;
    setChannelBusy(true);
    setChannelsError("");
    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: await signedChannelHeaders(),
        body: JSON.stringify({
          type: newChannelType,
          address: newChannelAddress,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        // One channel per type — replace any existing channel of that type.
        setChannels((prev) => [
          ...prev.filter((c) => c.type !== data.channel.type),
          data.channel,
        ]);
        setChannelFormOpen(false);
        setNewChannelAddress("");
      } else {
        setChannelsError(data.error ?? "Failed to add channel");
      }
    } catch {
      setChannelsError("Network error");
    } finally {
      setChannelBusy(false);
    }
  }

  async function handleRemoveChannel(channel: Channel) {
    if (
      !window.confirm(
        `Remove this ${channel.type} channel (${channel.address})? You will sign one message to confirm.`
      )
    ) {
      return;
    }
    setChannelBusy(true);
    setChannelsError("");
    try {
      const res = await fetch("/api/channels", {
        method: "DELETE",
        headers: await signedChannelHeaders(),
        body: JSON.stringify({ channel_id: channel.id }),
      });
      const data = await res.json();
      if (data.ok) {
        setChannels((prev) => prev.filter((c) => c.id !== channel.id));
      } else {
        setChannelsError(data.error ?? "Failed to remove channel");
      }
    } catch {
      setChannelsError("Network error");
    } finally {
      setChannelBusy(false);
    }
  }

  // Reset the channels view when the wallet changes
  useEffect(() => {
    setChannels([]);
    setChannelsLoaded(false);
    setChannelFormOpen(false);
    setChannelsError("");
  }, [address]);

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
                  {newWorker ? (
                    // CC-010: a freshly registered worker has no history to score —
                    // show that as a state, not as a big red zero.
                    <>
                      <div className={styles.scoreDisplay}>
                        <span className={styles.scoreNew}>New</span>
                        <span className={styles.scoreLabel}>Reputation</span>
                      </div>
                      <p className={styles.newWorkerNote}>
                        No history yet — your score builds as you complete tasks.
                      </p>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>

                {stakeContractAddress && (
                  <div className={styles.stakePanel}>
                    <div className={styles.stakePanelHeader}>
                      <h3 className={styles.stakePanelTitle}>
                        USDC Stake
                        {!hasStake && (
                          <span className={styles.optionalTag}>optional</span>
                        )}
                      </h3>
                      <button
                        className={styles.stakeToggle}
                        onClick={() => setStakeOpenOverride(!stakeOpen)}
                      >
                        {stakeOpen
                          ? "Hide"
                          : hasStake
                            ? "Manage stake"
                            : "Add a stake"}
                      </button>
                    </div>

                    <p className={styles.stakeExplainer}>
                      Optional: Boost search rank and credibility with a stake
                      deposit. Staking is not required to receive jobs.
                    </p>

                    {stakeOpen && (
                      <>
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
                      </>
                    )}
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

            {/* ── Notification Channels (CC-073) ────────────────────── */}
            <h2 className={styles.pageTitle}>Notification Channels</h2>
            <div className={styles.channelsCard}>
              <p className={styles.channelsIntro}>
                Choose how agents notify you when a task is assigned. Your
                wallet will be asked to sign a message to prove ownership —
                channel destinations are private and never shown on your
                public profile.
              </p>

              {channelsError && (
                <p className={styles.channelsError}>{channelsError}</p>
              )}

              {!channelsLoaded ? (
                <button
                  className={styles.channelsLoadBtn}
                  onClick={loadChannels}
                  disabled={channelsLoading}
                >
                  {channelsLoading ? "Confirm in wallet..." : "Manage channels"}
                </button>
              ) : (
                <>
                  {channels.length === 0 && (
                    <p className={styles.channelsEmpty}>
                      No notification channels yet. Add one below so agents
                      can reach you when you&apos;re hired.
                    </p>
                  )}

                  {channels.length > 0 && (
                    <ul className={styles.channelList}>
                      {channels.map((channel) => (
                        <li key={channel.id} className={styles.channelRow}>
                          <span
                            className={`${styles.channelBadge} ${styles[`channel_${channel.type}`] ?? ""}`}
                          >
                            {channel.type}
                          </span>
                          <span className={styles.channelAddress}>
                            {channel.address}
                          </span>
                          <button
                            className={styles.channelRemoveBtn}
                            onClick={() => handleRemoveChannel(channel)}
                            disabled={channelBusy}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {channelFormOpen ? (
                    <div className={styles.channelForm}>
                      <label className={styles.channelFieldLabel}>
                        Type
                        <select
                          className={styles.channelSelect}
                          value={newChannelType}
                          onChange={(e) =>
                            setNewChannelType(e.target.value as ChannelType)
                          }
                        >
                          {CHANNEL_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.channelFieldLabel}>
                        Destination
                        <input
                          type="text"
                          className={styles.channelInput}
                          value={newChannelAddress}
                          onChange={(e) => setNewChannelAddress(e.target.value)}
                          placeholder={
                            newChannelType === "email"
                              ? "you@example.com"
                              : newChannelType === "webhook"
                                ? "https://example.com/hook"
                                : newChannelType === "telegram"
                                  ? "123456789"
                                  : "123456789012345678"
                          }
                        />
                      </label>
                      <p className={styles.channelExplainer}>
                        {CHANNEL_EXPLAINERS[newChannelType]}
                      </p>
                      <div className={styles.channelFormActions}>
                        <button
                          className={styles.channelAddBtn}
                          onClick={handleAddChannel}
                          disabled={channelBusy || !newChannelAddress.trim()}
                        >
                          {channelBusy ? "Signing..." : "Sign & Save"}
                        </button>
                        <button
                          className={styles.channelCancelBtn}
                          onClick={() => {
                            setChannelFormOpen(false);
                            setNewChannelAddress("");
                            setChannelsError("");
                          }}
                          disabled={channelBusy}
                        >
                          Cancel
                        </button>
                      </div>
                      {channels.length > 0 && (
                        <p className={styles.channelUpdateNote}>
                          Adding a channel of a type you already have replaces
                          the existing one.
                        </p>
                      )}
                    </div>
                  ) : (
                    <button
                      className={styles.channelsLoadBtn}
                      onClick={() => setChannelFormOpen(true)}
                    >
                      + Add channel
                    </button>
                  )}
                </>
              )}
            </div>

            {/* ── Tasks ──────────────────────────────────────────────── */}
            <h2 className={styles.pageTitle}>Your Tasks</h2>

            {!loading && !error && tasks.length === 0 && (
              <div className={styles.emptyState}>
                {profile ? (
                  // CC-010: this worker is already listed in the whitepages — never
                  // send them back to /connect.
                  <>
                    <p>You&apos;re listed — agents can now find and hire you.</p>
                    <p>No tasks yet.</p>
                  </>
                ) : (
                  <>
                    <p>No tasks assigned yet.</p>
                    <p>
                      Make sure you&apos;ve{" "}
                      <Link href="/connect">registered your services</Link> so agents
                      can find you.
                    </p>
                  </>
                )}
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
