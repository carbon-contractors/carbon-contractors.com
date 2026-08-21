"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSignMessage } from "wagmi";
import type { Hash } from "viem";
import Link from "next/link";
import PageShell from "@/components/PageShell";
import { CARBON_ESCROW_ABI } from "@/lib/contracts/escrow-abi";
import {
  ZERO_BYTES32,
  computeEvidenceHash,
  parseBytes32,
  paymentIdToTaskId,
  toVerdictTuple,
} from "@/lib/contracts/worker-actions";
import type { SerializedVerdict } from "@/lib/contracts/verdict-signer";
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

// Escrow write calls (submitWork, releaseAfterReview, claimWithVerdict,
// disputeTask — CC-092) use the generated CARBON_ESCROW_ABI, so the client can
// never drift from the deployed contract.

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
  /** CC-092 — the worker write path keys off these. */
  review_deadline?: number;
  spec_hash?: string;
  evidence_hash?: string;
  worker?: string;
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

// ── Worker write path (CC-092) ───────────────────────────────────────────────
//
// submitWork, releaseAfterReview, claimWithVerdict and disputeTask are all
// worker-signed from the connected wallet — the platform is never the sender
// (ADR-0001 A1.2/A1.3). Each action keys off the *on-chain* task state, not the
// DB projection: the chain is the authority on money.

type WriteContractFn = ReturnType<typeof useWriteContract>["writeContract"];

function WorkerTaskActions({
  task,
  escrowContract,
  authHeaders,
  writeContract,
  onDone,
}: {
  task: Task;
  escrowContract: `0x${string}`;
  authHeaders: AuthHeaders;
  writeContract: WriteContractFn;
  onDone: () => void;
}) {
  const onChain = task.on_chain;
  const taskId = paymentIdToTaskId(task.payment_request_id);

  const [evidence, setEvidence] = useState("");
  const [attestation, setAttestation] = useState("");
  const [disputeReason, setDisputeReason] = useState("");
  const [busy, setBusy] = useState<"submit" | "claim" | "claim-verdict" | "dispute" | null>(null);
  const [actionError, setActionError] = useState("");

  if (!onChain) return null;
  // Narrowed copy — the early return above doesn't extend into the handlers'
  // closures, but this assignment does.
  const chain: OnChainState = onChain;

  const isFunded = chain.state === "Funded";
  const isDelivered = chain.state === "Delivered";
  const reviewClosed =
    typeof chain.review_deadline === "number" &&
    Date.now() / 1000 >= chain.review_deadline;

  /** Ask the platform verdict service for a signature over this task. */
  async function fetchVerdict(
    passed: boolean,
    failureReason?: string,
  ): Promise<{ verdict: SerializedVerdict; signature: `0x${string}` } | null> {
    const res = await fetch("/api/verdict", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        payment_request_id: task.payment_request_id,
        passed,
        failure_reason: failureReason,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setActionError(data.error || "The platform declined to sign a verdict.");
      return null;
    }
    return {
      verdict: data.verdict as SerializedVerdict,
      signature: data.signature as `0x${string}`,
    };
  }

  async function handleSubmitWork() {
    setBusy("submit");
    setActionError("");
    try {
      if (!evidence.trim()) {
        setActionError("Describe your evidence first — only its hash is published.");
        return;
      }
      // submitWork reverts SpecAckMismatch() unless this echoes the committed
      // specHash exactly — prefer the chain's copy, fall back to the DB's.
      const specVersionAck = (chain.spec_hash ?? task.spec_hash) as Hash | null;
      if (!specVersionAck) {
        setActionError("No committed spec hash available to acknowledge — cannot submit.");
        return;
      }
      let attestationUid: Hash = ZERO_BYTES32;
      if (attestation.trim()) {
        const parsed = parseBytes32(attestation);
        if (!parsed) {
          setActionError("Attestation UID must be a 0x-prefixed 32-byte value.");
          return;
        }
        attestationUid = parsed;
      }
      await writeContract({
        address: escrowContract,
        abi: CARBON_ESCROW_ABI,
        functionName: "submitWork",
        args: [taskId, computeEvidenceHash(evidence), specVersionAck, attestationUid],
      });
      onDone();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "submitWork failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleClaimAfterReview() {
    setBusy("claim");
    setActionError("");
    try {
      await writeContract({
        address: escrowContract,
        abi: CARBON_ESCROW_ABI,
        functionName: "releaseAfterReview",
        args: [taskId],
      });
      onDone();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Claim failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleClaimWithVerdict() {
    setBusy("claim-verdict");
    setActionError("");
    try {
      const signed = await fetchVerdict(true);
      if (!signed) return;
      await writeContract({
        address: escrowContract,
        abi: CARBON_ESCROW_ABI,
        functionName: "claimWithVerdict",
        args: [taskId, toVerdictTuple(signed.verdict), signed.signature],
      });
      onDone();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Claim failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleDispute() {
    setBusy("dispute");
    setActionError("");
    try {
      const signed = await fetchVerdict(false, disputeReason.trim());
      if (!signed) return;
      // On-chain first: the dispute only exists once the contract has it.
      await writeContract({
        address: escrowContract,
        abi: CARBON_ESCROW_ABI,
        functionName: "disputeTask",
        args: [taskId, toVerdictTuple(signed.verdict), signed.signature],
      });
      // Then record it — best-effort; the chain, not the DB, is the authority.
      await fetch("/api/dispute", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          payment_request_id: task.payment_request_id,
          reason: disputeReason.trim(),
          verdict: signed.verdict,
          signature: signed.signature,
        }),
      });
      onDone();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Dispute failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.workerActions}>
      {isFunded && (
        <>
          <p className={styles.actionNote}>
            Deliver your work: describe or link the evidence — only its hash is published
            on-chain, and it freezes the spec you are delivering against.
          </p>
          <textarea
            className={styles.actionTextarea}
            rows={3}
            placeholder="Evidence — description, links, artefact manifest…"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
          <input
            className={styles.actionTextarea}
            placeholder="Attestation UID (optional, 0x…)"
            value={attestation}
            onChange={(e) => setAttestation(e.target.value)}
          />
          <button
            className={styles.actionBtn}
            disabled={busy !== null || !evidence.trim()}
            onClick={handleSubmitWork}
          >
            {busy === "submit" ? "Submitting…" : "Submit work"}
          </button>
        </>
      )}

      {isDelivered && (
        <>
          <p className={styles.actionNote}>
            {reviewClosed
              ? "The review window has closed — claim your payment."
              : chain.review_deadline
                ? `Review window open until ${formatDeadline(chain.review_deadline)} — claim now with a passing verdict, or wait and claim without one.`
                : "Claim now with a passing verdict, or wait out the review window."}
          </p>
          <button
            className={styles.actionBtn}
            disabled={busy !== null || !reviewClosed}
            onClick={handleClaimAfterReview}
          >
            {busy === "claim" ? "Claiming…" : "Claim payment"}
          </button>
          <button
            className={styles.actionBtnSecondary}
            disabled={busy !== null}
            onClick={handleClaimWithVerdict}
          >
            {busy === "claim-verdict" ? "Signing…" : "Claim now with verdict"}
          </button>
          <p className={styles.actionNote}>
            If the platform declines to sign a verdict, waiting out the review window still
            pays — your claim never depends on the platform being reachable.
          </p>

          <div className={styles.disputeForm}>
            <p className={styles.disputeWarning}>
              Escalating a dispute freezes the escrowed funds until the platform owner
              resolves it, and requires the platform to have signed a failing verdict — a
              bare assertion cannot freeze funds.
            </p>
            <textarea
              className={styles.actionTextarea}
              rows={2}
              placeholder="Why this task cannot be completed (min 10 chars)…"
              value={disputeReason}
              onChange={(e) => setDisputeReason(e.target.value)}
            />
            <button
              className={styles.disputeBtn}
              disabled={busy !== null || disputeReason.trim().length < 10}
              onClick={handleDispute}
            >
              {busy === "dispute" ? "Disputing…" : "Raise dispute"}
            </button>
          </div>
        </>
      )}

      {actionError && <p className={styles.actionError}>{actionError}</p>}
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

                        {/* Worker write path: submit / claim / dispute (CC-092).
                            All three are signed by the worker's own wallet and
                            gate on on-chain state, which /api/tasks enriches. */}
                        {escrowContract && address && authHeaders &&
                          task.to_human_wallet.toLowerCase() === address.toLowerCase() && (
                            <WorkerTaskActions
                              task={task}
                              escrowContract={escrowContract}
                              authHeaders={authHeaders}
                              writeContract={writeContract}
                              onDone={fetchData}
                            />
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
