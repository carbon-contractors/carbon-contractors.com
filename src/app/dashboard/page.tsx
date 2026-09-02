"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSignMessage } from "wagmi";
import { keccak256, toHex } from "viem";
import Link from "next/link";
import { CATEGORIES, validateCategorySelection } from "@/lib/categories";
import {
  parseAndHashEvidenceBundle,
  EvidenceBundleValidationError,
} from "@/lib/checker/evidence-hash";
import { parseSpecCriteria, parseSpecForDisplay } from "@/lib/spec/display";
import type { AcceptanceSpec } from "@/lib/spec/schema";
import { explainContractError } from "@/lib/contracts/reverts";
import {
  buildEvidenceBundleJson,
  emptyArtifactDraft,
  type EvidenceArtifactDraft,
} from "@/lib/evidence/draft";
import {
  loadStoredDrafts,
  saveStoredDrafts,
  type StoredEvidenceDrafts,
} from "@/lib/evidence/draft-store";
import {
  parseVerdictPayload,
  verdictTupleForContract,
} from "@/lib/contracts/verdict-json";
import type { CheckResult } from "@/lib/checker/types";
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

// CC-092: the v2 write paths. submitWork echoes the task's committed specHash
// as specVersionAck — that is what makes goalpost-moving impossible. The
// verdict-carrying calls take the tuple + signature from /api/verdict.
const VERDICT_TUPLE_COMPONENTS = [
  { name: "taskId", type: "bytes32" },
  { name: "specHash", type: "bytes32" },
  { name: "evidenceHash", type: "bytes32" },
  { name: "checkerHash", type: "bytes32" },
  { name: "passed", type: "bool" },
  { name: "breakdownHash", type: "bytes32" },
  { name: "expiry", type: "uint256" },
  { name: "nonce", type: "uint256" },
] as const;

const SUBMIT_WORK_ABI = [
  {
    type: "function",
    name: "submitWork",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "specVersionAck", type: "bytes32" },
      { name: "attestationUid", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const RELEASE_AFTER_REVIEW_ABI = [
  {
    type: "function",
    name: "releaseAfterReview",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * ADR-0006 D3. The counterpart to releaseAfterReview one state along: when an
 * arbitration runs out of time without a ruling, the worker claims by default.
 *
 * A separate function, not a flag on the other one — so the dashboard has to pick, and
 * picking wrong reverts. That is the whole reason `arbitrationClock` is plumbed through
 * from the chain read rather than assumed.
 */
const RELEASE_AFTER_ARBITRATION_ABI = [
  {
    type: "function",
    name: "releaseAfterArbitration",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const CLAIM_WITH_VERDICT_ABI = [
  {
    type: "function",
    name: "claimWithVerdict",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "verdict", type: "tuple", components: VERDICT_TUPLE_COMPONENTS },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const DISPUTE_ABI = [
  {
    type: "function",
    name: "disputeTask",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "verdict", type: "tuple", components: VERDICT_TUPLE_COMPONENTS },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** CC-036 slot — zero until EAS lands. */
const ZERO_ATTESTATION_UID = "0x0000000000000000000000000000000000000000000000000000000000000000";

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
  /** CC-092: the v2 projection /api/tasks serves — drives the write paths. */
  reviewWindow: number;
  submittedAt: number;
  reviewDeadline: number;
  /** 0 unless the task was disputed. ADR-0006 D3. */
  disputedAt: number;
  /** When `releaseAfterArbitration` opens. Meaningless while `disputedAt` is 0. */
  arbitrationDeadline: number;
  /**
   * Whether the deployed escrow has the arbitration clock. False against a contract
   * deployed before 2026-08-28 — do not render the timeout claim in that case.
   */
  arbitrationClock: boolean;
  specHash: string;
  evidenceHash: string;
  verdictHash: string;
  verdictPassed: boolean;
  worker: string;
  agent: string;
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
  /** When a pending offer lapses; null once decided (CC-094). */
  offer_expiry_unix: number | null;
  /** Verbatim spec JSON. Display-only here — the hash preimage is the agent's string (CC-084). */
  acceptance_spec: string | null;
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

/** NOR-330: a recorded slash, linking the on-chain event to its dispute. */
interface StakeSlash {
  id: string;
  amount_usdc: number;
  payment_request_id: string | null;
  tx_hash: string;
  slashed_at: string;
}

/** One row of the dashboard session list (ADR-0009 D5). */
interface SessionInfo {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
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

/** Relative time from now, for countdown-adjacent copy (NOR-325). */
function formatIn(unix: number, nowSec: number): string {
  const secs = Math.max(0, unix - nowSec);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return "under a minute";
}

function statusClass(status: string): string {
  switch (status) {
    case "pending":
      return styles.statusPending;
    // NOR-324: accepted is agreed-but-unfunded — it must not read as expired.
    case "accepted":
      return styles.statusAccepted;
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

/** Which per-task affordance is open — CC-092's three evidence-bundle flows. */
type TaskAction = "submit" | "claim-early" | "dispute";

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const [tasks, setTasks] = useState<Task[]>([]);
  // NOR-326: the server's own cap and the caller's committed count, so the
  // offer card warns before an accept 409s.
  const [workerConcurrency, setWorkerConcurrency] = useState<{
    committed: number;
    cap: number;
  } | null>(null);
  const [slashes, setSlashes] = useState<StakeSlash[]>([]);
  const [reputation, setReputation] = useState<Reputation | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);
  // CC-026: each endpoint reports its own failure, so a single broken one is
  // visible instead of presenting as "no work available".
  const [errors, setErrors] = useState<{ tasks: string | null; reputation: string | null }>({
    tasks: null,
    reputation: null,
  });

  const [stakeInput, setStakeInput] = useState("");
  const [unstakeInput, setUnstakeInput] = useState("");

  // ── Task actions (CC-092) ────────────────────────────────────────────────
  // One open action per task at a time — submit, claim-early and dispute all
  // take the same evidence-bundle textarea.
  const [actionOpen, setActionOpen] = useState<Record<string, TaskAction>>({});
  const [evidenceDrafts, setEvidenceDrafts] = useState<Record<string, EvidenceArtifactDraft[]>>({});
  // NOR-328: the bundle hash actually committed on-chain per task, so the
  // claim-early form can prove a match instead of hoping.
  const [submittedHashes, setSubmittedHashes] = useState<Record<string, string>>({});

  // Drafts survive reloads — they live in this browser only, keyed per wallet.
  // The platform still stores nothing (CC-083), so there is no retention ripple.
  useEffect(() => {
    if (!address) return;
    const stored = loadStoredDrafts(address);
    const drafts: Record<string, EvidenceArtifactDraft[]> = {};
    const hashes: Record<string, string> = {};
    for (const [id, entry] of Object.entries(stored)) {
      if (entry && Array.isArray(entry.artifacts)) drafts[id] = entry.artifacts;
      if (entry && typeof entry.submittedHash === "string") hashes[id] = entry.submittedHash;
    }
    setEvidenceDrafts((prev) => ({ ...drafts, ...prev }));
    setSubmittedHashes((prev) => ({ ...hashes, ...prev }));
  }, [address]);

  useEffect(() => {
    if (!address) return;
    const stored: Record<string, StoredEvidenceDrafts> = {};
    for (const [id, artifacts] of Object.entries(evidenceDrafts)) {
      stored[id] = { artifacts, submittedHash: submittedHashes[id] };
    }
    saveStoredDrafts(address, stored);
  }, [address, evidenceDrafts, submittedHashes]);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<
    Record<string, { ok: boolean; text: string; checks?: CheckResult[] }>
  >({});
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
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsLoaded, setChannelsLoaded] = useState(false);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState("");
  const [channelFormOpen, setChannelFormOpen] = useState(false);
  const [newChannelType, setNewChannelType] = useState<ChannelType>("email");
  const [newChannelAddress, setNewChannelAddress] = useState("");
  const [channelBusy, setChannelBusy] = useState(false);
  // CC-074: per-row busy flag so toggling one channel's auto-booking does not
  // disable every other control in the panel.
  const [autoBookBusy, setAutoBookBusy] = useState<string | null>(null);

  const { writeContract, writeContractAsync, data: txHash } = useWriteContract();
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

  // Tasks require proof of wallet ownership (CC-093): an unsigned fetch only
  // returns the public projection, which has no task_description. Same
  // challenge round trip the dispute flow uses.
  // ── Session (NOR-322 / ADR-0009) ──────────────────────────────────────────
  // One wallet signature mints a 30-day session; everything off-chain rides
  // the httpOnly cookie after that. The only further prompts are the wallet's
  // own native ones on actual contract writes — a session is not a wallet.
  const sessionRef = useRef<{ minting: Promise<boolean> | null }>({ minting: null });

  const ensureSession = useCallback(async (): Promise<boolean> => {
    if (!address) return false;
    if (sessionRef.current.minting) return sessionRef.current.minting;
    const mint = (async () => {
      try {
        const challengeRes = await fetch("/api/basedhuman.mcp/challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress: address }),
        });
        const { nonce, message } = await challengeRes.json();
        const signature = await signMessageAsync({ message });
        const res = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            walletAddress: address,
            nonce,
            signature,
            name: "Dashboard",
          }),
        });
        return res.ok;
      } catch {
        // Signature declined or the round trip failed — the caller surfaces
        // the server's own 401 copy, so nothing fails silently.
        return false;
      } finally {
        sessionRef.current.minting = null;
      }
    })();
    sessionRef.current.minting = mint;
    return mint;
  }, [address, signMessageAsync]);

  const authHeaders = useCallback((): Record<string, string> => {
    // The session rides the httpOnly SameSite=Strict cookie; this only
    // carries the JSON content type.
    return { "Content-Type": "application/json" };
  }, []);

  /** 401 → the session expired mid-flight; mint once and retry (NOR-322). */
  const fetchWithSession = useCallback(
    async (input: string, init?: RequestInit): Promise<Response> => {
      let res = await fetch(input, init);
      if (res.status === 401) {
        if (await ensureSession()) {
          res = await fetch(input, init);
        }
      }
      return res;
    },
    [ensureSession],
  );
  const fetchTasks = useCallback(async () => {
    if (!isConnected || !address) {
      setTasks([]);
      return;
    }
    try {
      const res = await fetchWithSession("/api/tasks");
      const data = await res.json();
      if (data.ok) {
        setTasks(data.tasks);
        setWorkerConcurrency(data.worker_concurrency ?? null);
        // NOR-328: drop local drafts for tasks no longer in the list — they
        // are finished or purged, and the browser cache should follow.
        const known = new Set(
          (data.tasks as { payment_request_id: string }[]).map((t) => t.payment_request_id),
        );
        setEvidenceDrafts((prev) => {
          const next = Object.fromEntries(
            Object.entries(prev).filter(([id]) => known.has(id)),
          );
          return Object.keys(next).length === Object.keys(prev).length ? prev : next;
        });
        setSubmittedHashes((prev) => {
          const next = Object.fromEntries(
            Object.entries(prev).filter(([id]) => known.has(id)),
          );
          return Object.keys(next).length === Object.keys(prev).length ? prev : next;
        });
      } else {
        setTasks([]);
        setErrors((prev) => ({ ...prev, tasks: "Failed to fetch tasks" }));
      }
    } catch {
      // Signature declined or the round trip failed — without it the server
      // will not release task content, by design.
      setTasks([]);
      setErrors((prev) => ({ ...prev, tasks: "Sign the verification message to view your tasks" }));
    }
  }, [isConnected, address, fetchWithSession]);

  const fetchData = useCallback(() => {
    if (!isConnected || !address) {
      setTasks([]);
      setReputation(null);
      setProfile(null);
      return;
    }

    setLoading(true);
    setErrors({ tasks: null, reputation: null });

    fetchTasks();
    Promise.all([
      fetch(`/api/reputation?wallet=${address}`).then((r) => r.json()),
      fetch(`/api/profile?wallet=${address}`).then((r) => r.json()),
    ])
      .then(([repData, profileData]) => {
        // fetchTasks() above owns errors.tasks on its own signed round trip —
        // this Promise.all only ever touches errors.reputation, and does so
        // with the updater form since the two requests resolve independently.
        if (repData.ok) {
          setReputation(repData.reputation);
          setSlashes(repData.slashes ?? []);
        } else {
          setErrors((prev) => ({
            ...prev,
            reputation: repData.error ?? "Failed to fetch reputation",
          }));
        }
        if (profileData.ok) {
          setProfile(profileData.profile);
          // Seed the edit form with the current values so saving an untouched
          // form is a no-op update rather than a surprise rewrite.
          setRateInput(String(profileData.profile.rate_usdc));
          setEditCategories(profileData.profile.categories);
        }
      })
      .catch(() => setErrors((prev) => ({ ...prev, reputation: "Network error" })))
      .finally(() => setLoading(false));
  }, [isConnected, address, fetchTasks]);

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

  // Review-deadline comparisons in render. Not reactive to the second — a
  // refresh after the window closes flips the claim button.
  const nowSec = Math.floor(Date.now() / 1000);

  // ── Task actions (CC-092): submit, claim, dispute ────────────────────────
  // All three prove wallet ownership the same way (CC-004): one challenge-
  // response signature per REST call.

  function taskIdOf(task: Task): `0x${string}` {
    return keccak256(toHex(task.payment_request_id));
  }

  /** Open one action per task; closing clears its message. */
  function toggleAction(taskId: string, action: TaskAction) {
    setActionOpen((prev) => {
      const next = { ...prev };
      if (next[taskId] === action) delete next[taskId];
      else next[taskId] = action;
      return next;
    });
    setActionMsg((prev) => {
      if (!(taskId in prev)) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }

  /**
   * NOR-327: the structured evidence form, shared by the three evidence-bundle
   * flows. The task's spec decides which optional fields appear — the form
   * mirrors the deal the same way the offer card's criteria rows do, from the
   * same validation (parseSpecCriteria). No JSON anywhere.
   */
  function evidenceForm(task: Task, criteria: AcceptanceSpec["criteria"] | null) {
    const drafts = evidenceDrafts[task.id] ?? [];
    const minArtefacts = criteria?.min_artefacts;
    // NOR-328: live comparison against the bundle committed on-chain, so a
    // mismatch is a sentence on screen rather than a silent checker failure.
    const onChainHash = task.on_chain?.evidenceHash ?? null;
    const build = buildEvidenceBundleJson(task.payment_request_id, drafts);
    const draftHash = build.ok ? keccak256(toHex(build.json)) : null;
    const hashMatch =
      onChainHash && draftHash
        ? draftHash.toLowerCase() === onChainHash.toLowerCase()
        : null;
    const update = (index: number, patch: Partial<EvidenceArtifactDraft>) => {
      setEvidenceDrafts((prev) => ({
        ...prev,
        [task.id]: (prev[task.id] ?? []).map((d, i) =>
          i === index ? { ...d, ...patch } : d,
        ),
      }));
    };
    return (
      <div className={styles.evidenceForm}>
        {typeof minArtefacts === "number" && (
          <p className={styles.evidenceGuidance}>
            This task requires at least {minArtefacts} artefact
            {minArtefacts === 1 ? "" : "s"} — {drafts.length} added.
          </p>
        )}
        {drafts.length === 0 && (
          <p className={styles.evidenceGuidance}>
            Add each artefact: its link, plus any details this task checks. No
            JSON needed — the bundle is built for you.
          </p>
        )}
        {onChainHash && (
          <p className={styles.evidenceGuidance}>
            {hashMatch === null
              ? "Add your artefacts to compare against the bundle committed on-chain."
              : hashMatch
                ? "Matches the bundle committed on-chain."
                : "This doesn't match the bundle committed on-chain — your payment is bound to the committed bundle, so check the links and details."}
          </p>
        )}
        {drafts.map((d, i) => (
          <div key={i} className={styles.artefactCard}>
            <div className={styles.artefactHeader}>
              <span className={styles.artefactIndex}>Artefact {i + 1}</span>
              <button
                type="button"
                className={styles.artefactRemove}
                onClick={() =>
                  setEvidenceDrafts((prev) => ({
                    ...prev,
                    [task.id]: (prev[task.id] ?? []).filter((_, j) => j !== i),
                  }))
                }
              >
                Remove
              </button>
            </div>
            <label className={styles.artefactLabel}>
              Link to the artefact (URI)
              <input
                className={styles.artefactInput}
                value={d.uri}
                spellCheck={false}
                placeholder="https://…"
                onChange={(e) => update(i, { uri: e.target.value })}
              />
            </label>
            <label className={styles.artefactLabel}>
              File type — optional, e.g. image/jpeg
              <input
                className={styles.artefactInput}
                value={d.mimeType}
                spellCheck={false}
                onChange={(e) => update(i, { mimeType: e.target.value })}
              />
            </label>
            {criteria?.exif_gps_within_m !== undefined && (
              <div className={styles.artefactRow}>
                <label className={styles.artefactLabel}>
                  Latitude — this task checks location
                  <input
                    className={styles.artefactInput}
                    value={d.lat}
                    inputMode="decimal"
                    placeholder="-37.8136"
                    onChange={(e) => update(i, { lat: e.target.value })}
                  />
                </label>
                <label className={styles.artefactLabel}>
                  Longitude
                  <input
                    className={styles.artefactInput}
                    value={d.lon}
                    inputMode="decimal"
                    placeholder="144.9631"
                    onChange={(e) => update(i, { lon: e.target.value })}
                  />
                </label>
              </div>
            )}
            {criteria?.captured_after !== undefined && (
              <label className={styles.artefactLabel}>
                Capture time — as recorded by the camera, e.g. 2026-09-02T14:33:00Z
                <input
                  className={styles.artefactInput}
                  value={d.dateTimeOriginal}
                  spellCheck={false}
                  onChange={(e) => update(i, { dateTimeOriginal: e.target.value })}
                />
              </label>
            )}
            {criteria?.provenance?.require_camera_model !== undefined && (
              <div className={styles.artefactRow}>
                <label className={styles.artefactLabel}>
                  Camera make — this task checks the camera
                  <input
                    className={styles.artefactInput}
                    value={d.cameraMake}
                    spellCheck={false}
                    onChange={(e) => update(i, { cameraMake: e.target.value })}
                  />
                </label>
                <label className={styles.artefactLabel}>
                  Camera model
                  <input
                    className={styles.artefactInput}
                    value={d.cameraModel}
                    spellCheck={false}
                    onChange={(e) => update(i, { cameraModel: e.target.value })}
                  />
                </label>
              </div>
            )}
            {criteria?.provenance?.reject_c2pa_ai_generated !== undefined && (
              <label className={styles.artefactCheckboxRow}>
                <input
                  type="checkbox"
                  checked={d.c2paAiGenerated}
                  onChange={(e) => update(i, { c2paAiGenerated: e.target.checked })}
                />
                This artefact is AI-generated
                {criteria.provenance.reject_c2pa_ai_generated && (
                  <span className={styles.artefactHint}>
                    {" "}
                    — this task rejects AI-generated content
                  </span>
                )}
              </label>
            )}
            {criteria?.phash_max_similarity_to !== undefined && (
              <label className={styles.artefactLabel}>
                Visual fingerprint (phash) — compared against this task&apos;s reference images
                <input
                  className={styles.artefactInput}
                  value={d.phash}
                  spellCheck={false}
                  onChange={(e) => update(i, { phash: e.target.value })}
                />
              </label>
            )}
            {criteria === null && (
              <p className={styles.artefactHint}>
                This task&apos;s criteria could not be read — only the link can
                be declared. Ask the hiring agent to re-issue the offer if in
                doubt.
              </p>
            )}
          </div>
        ))}
        <button
          type="button"
          className={styles.artefactAdd}
          onClick={() =>
            setEvidenceDrafts((prev) => ({
              ...prev,
              [task.id]: [...(prev[task.id] ?? []), emptyArtifactDraft()],
            }))
          }
        >
          + Add artefact
        </button>
        <p className={styles.evidenceGuidance}>
          The platform stores hashes only. Your wallet commits this
          bundle&apos;s hash — keep the artefacts at those links unchanged
          until you are paid.
        </p>
      </div>
    );
  }

  function actionChecks(checks: CheckResult[] | undefined) {
    if (!checks || checks.length === 0) return null;
    return (
      <ul className={styles.checkList}>
        {checks.map((c) => (
          <li
            key={c.check}
            className={c.passed ? styles.checkPass : styles.checkFail}
          >
            {c.check}: {c.passed ? "passed" : (c.reason ?? "failed")}
          </li>
        ))}
      </ul>
    );
  }

  /** Validates the form draft and returns its parse — or shows the error. */
  function parseDraft(task: Task) {
    const build = buildEvidenceBundleJson(
      task.payment_request_id,
      evidenceDrafts[task.id] ?? [],
    );
    if (!build.ok) {
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: { ok: false, text: build.error },
      }));
      return null;
    }
    try {
      return parseAndHashEvidenceBundle(build.json);
    } catch (err) {
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: {
          ok: false,
          text:
            err instanceof EvidenceBundleValidationError
              ? err.message
              : "Could not build the evidence bundle.",
        },
      }));
      return null;
    }
  }

  /** NOR-324: the worker's decision on a pending offer (CC-094 endpoints). */
  async function handleOfferResponse(
    task: Task,
    decision: "accept" | "decline",
  ) {
    if (!address) return;
    setActionBusy(task.payment_request_id);
    try {
      const res = await fetchWithSession(`/api/offers/${decision}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ payment_request_id: task.payment_request_id }),
      });
      const data = await res.json();
      if (!data.ok) {
        // The server's rejection copy is already worker-facing (CC-094): the
        // lapse message, the concurrency-cap message. Show it verbatim.
        setActionMsg((prev) => ({
          ...prev,
          [task.id]: {
            ok: false,
            text: data.error ?? "Could not record your decision.",
          },
        }));
        return;
      }
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: {
          ok: true,
          text:
            decision === "accept"
              ? "Offer accepted. The task becomes active once the hiring agent funds it — you will see it here."
              : "Offer declined. The hiring agent is free to re-target immediately.",
        },
      }));
      await fetchTasks();
    } catch {
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: {
          ok: false,
          text: "Signature declined or the request failed — your answer was not recorded.",
        },
      }));
    } finally {
      setActionBusy(null);
    }
  }

  /** Funded → Delivered. The hash is computed client-side; only it goes on-chain. */
  async function handleSubmitWork(task: Task) {
    if (!escrowContract || !address || !task.on_chain) return;
    const parsed = parseDraft(task);
    if (!parsed) return;
    setActionBusy(task.payment_request_id);
    setActionMsg((prev) => ({
      ...prev,
      [task.id]: { ok: true, text: "Confirm submitWork in your wallet…" },
    }));
    try {
      await writeContractAsync({
        address: escrowContract,
        abi: SUBMIT_WORK_ABI,
        functionName: "submitWork",
        args: [
          taskIdOf(task),
          parsed.hash,
          task.on_chain.specHash as `0x${string}`,
          ZERO_ATTESTATION_UID,
        ],
      });
      // NOR-328: remember the committed hash so claim-early/dispute prefill
      // from the submitted bundle and can prove a match on-screen.
      setSubmittedHashes((prev) => ({ ...prev, [task.id]: parsed.hash }));
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: { ok: true, text: "Work submitted. The review window is now running." },
      }));
    } catch (err) {
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: {
          ok: false,
          // NOR-329: "you cancelled" is not "the chain said no" — keep them apart.
          text: explainContractError(
            err,
            "submitWork was not sent — cancelled or rejected in your wallet.",
          ),
        },
      }));
    } finally {
      setActionBusy(null);
      fetchData();
    }
  }

  /** Delivered + review window elapsed → pull-payment claim, no verdict needed. */
  async function handleClaimAfterReview(task: Task) {
    if (!escrowContract || !address) return;
    setActionBusy(task.payment_request_id);
    setActionMsg((prev) => ({
      ...prev,
      [task.id]: { ok: true, text: "Confirm releaseAfterReview in your wallet…" },
    }));
    try {
      await writeContractAsync({
        address: escrowContract,
        abi: RELEASE_AFTER_REVIEW_ABI,
        functionName: "releaseAfterReview",
        args: [taskIdOf(task)],
      });
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: { ok: true, text: "Claim submitted — payment will arrive once the transaction confirms." },
      }));
    } catch (err) {
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: {
          ok: false,
          text: explainContractError(
            err,
            "Claim was not sent — cancelled or rejected in your wallet.",
          ),
        },
      }));
    } finally {
      setActionBusy(null);
      fetchData();
    }
  }

  /**
   * Disputed/Arbitrating + arbitration window elapsed → pull-payment claim (ADR-0006 D3).
   *
   * The worker's last resort, and the one they reach having already delivered, waited out
   * a review window, and been through a dispute. No verdict, no owner, no platform
   * transaction: the clock ran out and the default is the worker.
   */
  async function handleClaimAfterArbitration(task: Task) {
    if (!escrowContract || !address) return;
    setActionBusy(task.payment_request_id);
    setActionMsg((prev) => ({
      ...prev,
      [task.id]: { ok: true, text: "Confirm releaseAfterArbitration in your wallet…" },
    }));
    try {
      await writeContractAsync({
        address: escrowContract,
        abi: RELEASE_AFTER_ARBITRATION_ABI,
        functionName: "releaseAfterArbitration",
        args: [taskIdOf(task)],
      });
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: { ok: true, text: "Claim submitted — payment will arrive once the transaction confirms." },
      }));
    } catch (err) {
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: {
          ok: false,
          text: explainContractError(
            err,
            "Claim was not sent — cancelled or rejected in your wallet.",
          ),
        },
      }));
    } finally {
      setActionBusy(null);
      fetchData();
    }
  }

  /** Delivered + passing verdict → claim without waiting out the window. */
  async function handleClaimEarly(task: Task) {
    if (!escrowContract || !address) return;
    const parsed = parseDraft(task);
    if (!parsed) return;
    // NOR-328: claim-early claims the SUBMITTED work — a bundle differing from
    // the on-chain commitment can only yield a failing verdict, so say so
    // before the wallet is involved rather than after a silent checker miss.
    const onChainHash = task.on_chain?.evidenceHash;
    if (onChainHash && parsed.hash.toLowerCase() !== onChainHash.toLowerCase()) {
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: {
          ok: false,
          text:
            "This bundle doesn't match the one committed when you submitted work (the on-chain hash differs). Claim-early claims the submitted work — fix the artefacts above, or wait out the review window and claim without a verdict.",
        },
      }));
      return;
    }
    setActionBusy(task.payment_request_id);
    try {
      const res = await fetchWithSession("/api/verdict", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          payment_request_id: task.payment_request_id,
          evidence_bundle: parsed.preimage,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setActionMsg((prev) => ({
          ...prev,
          [task.id]: { ok: false, text: data.error ?? "Verdict request failed", checks: data.checks },
        }));
        return;
      }
      const verdict = parseVerdictPayload(data.verdict);
      if (!verdict.passed) {
        // The platform signs what the checker found, pass or fail — a failure
        // just means early claim is not available (CC-092's worker-facing note).
        setActionMsg((prev) => ({
          ...prev,
          [task.id]: {
            ok: false,
            text: "The evidence did not pass the acceptance checks, so there is no passing verdict to claim with. You can still wait out the review window, or dispute with this failing verdict.",
            checks: data.checks,
          },
        }));
        return;
      }
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: { ok: true, text: "Passing verdict obtained — confirm claimWithVerdict in your wallet…" },
      }));
      await writeContractAsync({
        address: escrowContract,
        abi: CLAIM_WITH_VERDICT_ABI,
        functionName: "claimWithVerdict",
        args: [taskIdOf(task), verdictTupleForContract(verdict), data.signature],
      });
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: { ok: true, text: "Claim submitted — payment will arrive once the transaction confirms." },
      }));
    } catch (err) {
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: {
          ok: false,
          text:
            err instanceof Error && err.message.startsWith("verdict field")
              ? `The verdict response was malformed: ${err.message}`
              : explainContractError(
                  err,
                  "Claim was not sent — cancelled, rejected in your wallet, or the request failed.",
                ),
        },
      }));
    } finally {
      setActionBusy(null);
      fetchData();
    }
  }

  /**
   * Dispute (ADR-0001 D2): v2 has no bare-assertion dispute, so the flow is
   * verdict-first — obtain a failing signed verdict from /api/verdict, present
   * disputeTask on-chain from this wallet, then record it in the DB via
   * /api/dispute (which reads the now-Disputed chain state).
   */
  async function handleDispute(task: Task) {
    if (!escrowContract || !address) return;
    const parsed = parseDraft(task);
    if (!parsed) return;
    setActionBusy(task.payment_request_id);
    try {
      const res = await fetchWithSession("/api/verdict", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          payment_request_id: task.payment_request_id,
          evidence_bundle: parsed.preimage,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setActionMsg((prev) => ({
          ...prev,
          [task.id]: { ok: false, text: data.error ?? "Verdict request failed", checks: data.checks },
        }));
        return;
      }
      const verdict = parseVerdictPayload(data.verdict);
      if (verdict.passed) {
        setActionMsg((prev) => ({
          ...prev,
          [task.id]: {
            ok: false,
            text: "Cannot dispute: the verdict passed — the evidence satisfies the acceptance spec.",
            checks: data.checks,
          },
        }));
        return;
      }
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: { ok: true, text: "Failing verdict obtained — confirm disputeTask in your wallet…" },
      }));
      await writeContractAsync({
        address: escrowContract,
        abi: DISPUTE_ABI,
        functionName: "disputeTask",
        args: [taskIdOf(task), verdictTupleForContract(verdict), data.signature],
      });
      // Now on-chain Disputed (or the tx failed above). Best-effort DB sync —
      // the transaction may not be mined yet when the route reads the chain,
      // and a failure here leaves the chain ahead of the DB, which
      // /api/dispute's chain-first path reconciles on retry.
      let recorded = false;
      try {
        const syncRes = await fetchWithSession("/api/dispute", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ payment_request_id: task.payment_request_id }),
        });
        recorded = (await syncRes.json()).ok === true;
      } catch {
        // Signing a second message may have been declined — the chain state is
        // what matters; nothing to undo.
      }
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: {
          ok: true,
          text: recorded
            ? "Dispute submitted on-chain and recorded."
            : "Dispute submitted on-chain. The database will catch up on your next dispute attempt or a refresh.",
        },
      }));
    } catch (err) {
      setActionMsg((prev) => ({
        ...prev,
        [task.id]: {
          ok: false,
          text:
            err instanceof Error && err.message.startsWith("verdict field")
              ? `The verdict response was malformed: ${err.message}`
              : explainContractError(
                  err,
                  "Dispute was not sent — cancelled, rejected in your wallet, or the request failed.",
                ),
        },
      }));
    } finally {
      setActionBusy(null);
      fetchData();
    }
  }

  // ── Notification channels (CC-073) ──────────────────────────────────────

  // Every channels call needs a fresh challenge-response signature (CC-004),
  // so each load/add/remove prompts one wallet signature — the same round trip
  // the task actions above use.
  // ── Session list (NOR-322 / ADR-0009 D5) ──────────────────────────────
  async function loadSessions() {
    if (!isConnected || !address) return;
    setSessionsLoading(true);
    setSessionsError("");
    try {
      const res = await fetchWithSession("/api/auth/session");
      const data = await res.json();
      if (data.ok) {
        setSessions(data.sessions ?? []);
        setSessionsLoaded(true);
      } else {
        setSessionsError(data.error ?? "Failed to load sessions");
      }
    } catch {
      setSessionsError("Network error");
    } finally {
      setSessionsLoading(false);
    }
  }

  async function handleRevokeSession(session: SessionInfo) {
    setSessionBusy(true);
    setSessionsError("");
    try {
      const res = await fetch("/api/auth/session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: session.id }),
      });
      const data = await res.json();
      if (data.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== session.id));
      } else {
        setSessionsError(data.error ?? "Failed to revoke session");
      }
    } catch {
      setSessionsError("Network error");
    } finally {
      setSessionBusy(false);
    }
  }

  async function handleRevokeAllSessions() {
    setSessionBusy(true);
    setSessionsError("");
    try {
      const res = await fetch("/api/auth/session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const data = await res.json();
      if (data.ok) {
        // This session is gone too — the next off-chain action mints a new
        // one with a single signature.
        setSessions([]);
        setSessionsLoaded(true);
      } else {
        setSessionsError(data.error ?? "Failed to revoke sessions");
      }
    } catch {
      setSessionsError("Network error");
    } finally {
      setSessionBusy(false);
    }
  }

  // Load the session list whenever a wallet connects; clear it when one leaves.
  useEffect(() => {
    setSessions([]);
    setSessionsLoaded(false);
    setSessionsError("");
  }, [address]);

  useEffect(() => {
    if (isConnected && address) {
      loadSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address]);

  async function loadChannels() {
    if (!address) return;
    setChannelsLoading(true);
    setChannelsError("");
    try {
      const res = await fetchWithSession("/api/channels", {
        headers: authHeaders(),
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
      const res = await fetchWithSession("/api/channels", {
        method: "POST",
        headers: authHeaders(),
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
      const res = await fetchWithSession("/api/channels", {
        method: "DELETE",
        headers: authHeaders(),
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

  // CC-074: toggle accepts_auto_booking on one channel. Enabling is the
  // consequential direction, so it gets an explicit confirm spelling out what
  // is being pre-authorised.
  async function handleToggleAutoBooking(channel: Channel, next: boolean) {
    if (next) {
      const confirmed = window.confirm(
        `Turn on auto-booking for this ${channel.type} channel?\n\n` +
          "Hiring agents will be able to commit you directly to tasks " +
          "matching your listed categories and rate — accepted on your " +
          "behalf, with no confirmation step."
      );
      if (!confirmed) return;
    }
    setAutoBookBusy(channel.id);
    setChannelsError("");
    try {
      const res = await fetchWithSession("/api/channels", {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({
          channel_id: channel.id,
          accepts_auto_booking: next,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setChannels((prev) =>
          prev.map((c) => (c.id === data.channel.id ? data.channel : c)),
        );
      } else {
        setChannelsError(data.error ?? "Failed to update auto-booking");
      }
    } catch {
      setChannelsError("Network error");
    } finally {
      setAutoBookBusy(null);
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
  // Changes ride the session (ADR-0009) to PATCH /api/profile, which still
  // enforces the payload's action, wallet binding and freshness before writing
  // with the service role. The per-save wallet signature is gone.

  async function submitProfileUpdate(updates: {
    availability?: string;
    rate_usdc?: number;
    categories?: string[];
  }) {
    if (!address) return;
    setProfileSaving(true);
    setProfileMsg(null);
    try {
      // The server still rejects messages older than 5 minutes and requires
      // the payload wallet to match the session wallet — only the per-save
      // signature is gone (ADR-0009).
      const message = JSON.stringify({
        action: "profile-update",
        wallet: address,
        timestamp: Math.floor(Date.now() / 1000),
        ...updates,
      });

      const res = await fetchWithSession("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, message }),
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
            {(errors.tasks || errors.reputation) && (
              <div className={styles.fetchErrorBanner}>
                {errors.tasks && (
                  <p className={styles.fetchError}>Tasks: {errors.tasks}</p>
                )}
                {errors.reputation && (
                  <p className={styles.fetchError}>Reputation: {errors.reputation}</p>
                )}
                <button
                  className={styles.retryButton}
                  onClick={fetchData}
                  disabled={loading}
                >
                  {loading ? "Retrying..." : "Retry"}
                </button>
              </div>
            )}

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
                        {reputation.stake.slashed_total_usdc > 0 &&
                          slashes.length > 0 && (
                            <div className={styles.slashList}>
                              {slashes.map((slash) => {
                                const task = tasks.find(
                                  (t) =>
                                    t.payment_request_id ===
                                    slash.payment_request_id,
                                );
                                return (
                                  <div key={slash.id} className={styles.slashRow}>
                                    <span className={styles.slashAmount}>
                                      {slash.amount_usdc} USDC
                                    </span>
                                    <span className={styles.slashWhen}>
                                      {formatDeadline(
                                        Math.floor(
                                          new Date(slash.slashed_at).getTime() /
                                            1000,
                                        ),
                                      )}
                                    </span>
                                    {task ? (
                                      <a
                                        className={styles.slashTaskLink}
                                        href={`#task-${task.payment_request_id}`}
                                      >
                                        dispute on{" "}
                                        {task.payment_request_id.slice(0, 12)}…
                                      </a>
                                    ) : (
                                      <span className={styles.slashWhen}>
                                        {slash.payment_request_id
                                          ? `task ${slash.payment_request_id.slice(0, 12)}…`
                                          : "task not recorded"}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
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
                      Saving uses your dashboard session — profile edits
                      need no wallet signature.
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

            {/* ── Sessions (NOR-322 / ADR-0009) ─────────────────────── */}
            <h2 className={styles.pageTitle}>Active sessions</h2>
            <div className={styles.channelsCard}>
              <p className={styles.channelsIntro}>
                Your dashboard signs once to open a session that rides this
                browser for 30 days. Revoke anything you do not recognise —
                a session can never move money; on-chain actions always need
                your wallet anyway.
              </p>

              {sessionsError && (
                <p className={styles.channelsError}>{sessionsError}</p>
              )}

              {sessionsLoading && (
                <p className={styles.channelsIntro}>Loading sessions…</p>
              )}

              {sessionsLoaded && sessions.length === 0 && (
                <p className={styles.channelsIntro}>No active sessions.</p>
              )}

              {sessions.map((session) => (
                <div key={session.id} className={styles.sessionRow}>
                  <div className={styles.sessionMeta}>
                    <span className={styles.sessionName}>
                      {session.name ?? "Unnamed session"}
                    </span>
                    <span className={styles.sessionDates}>
                      Last used{" "}
                      {formatDeadline(
                        Math.floor(new Date(session.last_used_at).getTime() / 1000),
                      )}{" "}
                      · expires{" "}
                      {formatDeadline(
                        Math.floor(new Date(session.expires_at).getTime() / 1000),
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.sessionRevokeBtn}
                    onClick={() => handleRevokeSession(session)}
                    disabled={sessionBusy}
                  >
                    Revoke
                  </button>
                </div>
              ))}

              {sessions.length > 0 && (
                <button
                  type="button"
                  className={styles.sessionRevokeBtn}
                  onClick={handleRevokeAllSessions}
                  disabled={sessionBusy}
                >
                  Sign out everywhere
                </button>
              )}
            </div>

            {/* ── Notification Channels (CC-073) ────────────────────── */}
            <h2 className={styles.pageTitle}>Notification Channels</h2>
            <div className={styles.channelsCard}>
              <p className={styles.channelsIntro}>
                Choose how agents notify you when a task is assigned.
                Channel destinations are private and never shown on your
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
                    <>
                      {/* CC-074: the consequence of the toggle is spelled out
                          here, not hidden behind a tooltip. */}
                      <div className={styles.autoBookingNote}>
                        <strong>Auto-booking is off by default.</strong> Turn it
                        on for a channel and any hiring agent can commit you
                        directly to tasks matching your listed categories and
                        rate — the booking is accepted on your behalf, with no
                        manual confirmation step. This is not a minor setting:
                        you are pre-authorising work without being asked each
                        time. Leave it off and each offer waits for you to
                        accept or decline it yourself.
                      </div>
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
                              type="button"
                              role="switch"
                              aria-checked={channel.accepts_auto_booking}
                              aria-label={`Auto-booking for this ${channel.type} channel`}
                              className={`${styles.autoBookToggle} ${
                                channel.accepts_auto_booking
                                  ? styles.autoBookToggleOn
                                  : ""
                              }`}
                              onClick={() =>
                                handleToggleAutoBooking(
                                  channel,
                                  !channel.accepts_auto_booking,
                                )
                              }
                              disabled={autoBookBusy === channel.id}
                            >
                              <span className={styles.autoBookKnob} />
                              <span className={styles.autoBookToggleLabel}>
                                {autoBookBusy === channel.id
                                  ? "Signing..."
                                  : channel.accepts_auto_booking
                                    ? "Auto-book on"
                                    : "Auto-book off"}
                              </span>
                            </button>
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
                    </>
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

            {!loading && !errors.tasks && tasks.length === 0 && (
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
                {[...tasks]
                  .sort(
                    (a, b) =>
                      Number(b.status === "pending") -
                      Number(a.status === "pending"),
                  )
                  .map((task) => {
                  const isWorkerForTask = Boolean(
                    address &&
                      task.to_human_wallet.toLowerCase() === address.toLowerCase(),
                  );
                  const busy = actionBusy === task.payment_request_id;
                  const specDisplay = parseSpecForDisplay(task.acceptance_spec);
                  const specCriteria = parseSpecCriteria(task.acceptance_spec);
                  return (
                  <div
                    key={task.id}
                    id={`task-${task.payment_request_id}`}
                    className={
                      task.status === "pending" && isWorkerForTask
                        ? `${styles.taskCard} ${styles.taskCardOffer}`
                        : styles.taskCard
                    }
                  >
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

                    {/* ── Pending offer — the deal, before the decision (NOR-323) ── */}
                    {isWorkerForTask && task.status === "pending" && (
                      <div className={styles.offerSection}>
                        <p className={styles.offerHeading}>
                          Offer — awaiting your decision
                        </p>
                        {task.offer_expiry_unix && (
                          <p className={styles.offerExpiry}>
                            Lapses {formatDeadline(task.offer_expiry_unix)} — in{" "}
                            {formatIn(task.offer_expiry_unix, nowSec)}. After
                            that it closes automatically.
                          </p>
                        )}
                        <p className={styles.specTitle}>Acceptance criteria</p>
                        {specDisplay.ok ? (
                          <dl className={styles.specList}>
                            {specDisplay.rows.map((row) => (
                              <div key={row.key} className={styles.specRow}>
                                <dt className={styles.specLabel}>
                                  {row.label}:{" "}
                                  <span className={styles.specValue}>{row.value}</span>
                                </dt>
                                <dd className={styles.specDesc}>{row.description}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <p className={styles.specWarning}>
                            The acceptance criteria could not be read (
                            {specDisplay.reason}). Ask the hiring agent to re-issue
                            this offer before accepting.
                          </p>
                        )}
                        <p className={styles.actionNote}>
                          Accepting does not move any money — the task only
                          becomes active once the hiring agent funds it after
                          your acceptance. Declining is free, carries no
                          penalty, and frees the agent to re-target.
                        </p>
                        {workerConcurrency &&
                          (workerConcurrency.committed >= workerConcurrency.cap ? (
                            <p className={styles.offerExpiry}>
                              You&apos;re at your cap of {workerConcurrency.cap}{" "}
                              committed tasks (accepted + active) — complete one
                              or let one lapse before accepting another.
                            </p>
                          ) : (
                            <p className={styles.offerExpiry}>
                              You have {workerConcurrency.committed} of{" "}
                              {workerConcurrency.cap} committed tasks (accepted +
                              active).
                            </p>
                          ))}
                        <div className={styles.offerActions}>
                          <button
                            className={styles.actionBtn}
                            onClick={() => handleOfferResponse(task, "accept")}
                            disabled={
                              busy ||
                              (workerConcurrency !== null &&
                                workerConcurrency.committed >= workerConcurrency.cap)
                            }
                          >
                            {busy ? "Working..." : "Accept offer"}
                          </button>
                          <button
                            className={styles.declineBtn}
                            onClick={() => handleOfferResponse(task, "decline")}
                            disabled={busy}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── Submit work (CC-092): Funded → Delivered ─────── */}
                    {isWorkerForTask &&
                      escrowContract &&
                      task.on_chain &&
                      task.status === "active" &&
                      task.on_chain.state === "Funded" && (
                        <div className={styles.workerActionSection}>
                          <button
                            className={styles.actionToggle}
                            onClick={() => toggleAction(task.id, "submit")}
                          >
                            {actionOpen[task.id] === "submit"
                              ? "Cancel"
                              : "Submit work"}
                          </button>
                          {actionOpen[task.id] === "submit" && (
                            <div className={styles.actionForm}>
                              <p className={styles.actionNote}>
                                Add each artefact below — the platform
                                stores hashes only, and your wallet commits
                                the bundle&apos;s hash (plus an
                                acknowledgement of the committed acceptance
                                criteria) with submitWork.
                              </p>
                              {evidenceForm(task, specCriteria)}
                              <button
                                className={styles.actionBtn}
                                onClick={() => handleSubmitWork(task)}
                                disabled={busy}
                              >
                                {busy ? "Working..." : "Submit work"}
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                    {/* ── Claim payment (CC-092): Delivered → Completed ── */}
                    {isWorkerForTask &&
                      escrowContract &&
                      task.on_chain?.state === "Delivered" &&
                      task.status !== "completed" && (
                        <div className={styles.workerActionSection}>
                          {nowSec >= task.on_chain.reviewDeadline ? (
                            <button
                              className={styles.actionBtn}
                              onClick={() => handleClaimAfterReview(task)}
                              disabled={busy}
                            >
                              {busy ? "Working..." : "Claim Payment (Review Expired)"}
                            </button>
                          ) : (
                            <p className={styles.actionNote}>
                              Work delivered. The review window closes{" "}
                              {formatDeadline(task.on_chain.reviewDeadline)}
                              — after that, claim payment here.
                            </p>
                          )}
                          <button
                            className={styles.actionToggle}
                            onClick={() => toggleAction(task.id, "claim-early")}
                          >
                            {actionOpen[task.id] === "claim-early"
                              ? "Cancel"
                              : "Claim Early (With Verdict)"}
                          </button>
                          {actionOpen[task.id] === "claim-early" && (
                            <div className={styles.actionForm}>
                              <p className={styles.actionNote}>
                                The artefacts you submitted are below —
                                check they still match. The platform checks
                                the bundle against the committed acceptance
                                criteria; if it passes, your wallet claims
                                immediately with the signed verdict — no
                                waiting out the review window.
                              </p>
                              {evidenceForm(task, specCriteria)}
                              <button
                                className={styles.actionBtn}
                                onClick={() => handleClaimEarly(task)}
                                disabled={busy}
                              >
                                {busy ? "Working..." : "Claim early"}
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                    {/* ── Claim after arbitration timeout (ADR-0006 D3) ── */}
                    {isWorkerForTask &&
                      escrowContract &&
                      (task.on_chain?.state === "Disputed" ||
                        task.on_chain?.state === "Arbitrating") && (
                        <div className={styles.workerActionSection}>
                          {!task.on_chain.arbitrationClock ? (
                            <p className={styles.actionNote}>
                              This task is under dispute. The escrow contract it was
                              funded on has no arbitration deadline, so it can only be
                              resolved by the platform — there is nothing to claim here.
                            </p>
                          ) : nowSec >= task.on_chain.arbitrationDeadline ? (
                            <>
                              <p className={styles.actionNote}>
                                The arbitration deadline passed without a ruling. Under
                                the escrow&apos;s terms the task now defaults to you.
                              </p>
                              <button
                                className={styles.actionBtn}
                                onClick={() => handleClaimAfterArbitration(task)}
                                disabled={busy}
                              >
                                {busy ? "Working..." : "Claim Payment (Arbitration Expired)"}
                              </button>
                            </>
                          ) : (
                            <p className={styles.actionNote}>
                              This task is under dispute. If it is not resolved by{" "}
                              {formatDeadline(task.on_chain.arbitrationDeadline)}, the
                              payment defaults to you and you can claim it here — no
                              ruling needed.
                            </p>
                          )}
                        </div>
                      )}

                    {/* ── Dispute (ADR-0001 D2): verdict-first ─────────── */}
                    {escrowContract &&
                      task.on_chain?.state === "Delivered" &&
                      nowSec < task.on_chain.reviewDeadline &&
                      task.status !== "disputed" && (
                        <div className={styles.disputeSection}>
                          <button
                            className={styles.disputeToggle}
                            onClick={() => toggleAction(task.id, "dispute")}
                          >
                            {actionOpen[task.id] === "dispute"
                              ? "Cancel"
                              : "Dispute this task"}
                          </button>
                          {actionOpen[task.id] === "dispute" && (
                            <div className={styles.disputeForm}>
                              <p className={styles.disputeWarning}>
                                A dispute needs a signed failing verdict —
                                there is no bare-assertion dispute. Build the
                                task&apos;s evidence bundle below and the
                                platform computes the verdict from the
                                committed acceptance criteria; your wallet
                                then submits disputeTask, freezing the funds
                                until resolution. It must land before the
                                review window closes.
                              </p>
                              {evidenceForm(task, specCriteria)}
                              <button
                                className={styles.disputeBtn}
                                onClick={() => handleDispute(task)}
                                disabled={busy}
                              >
                                {busy ? "Working..." : "Confirm Dispute"}
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                    {actionMsg[task.id] && (
                      <div
                        className={
                          actionMsg[task.id].ok
                            ? styles.actionMsgOk
                            : styles.actionMsgErr
                        }
                      >
                        <p>{actionMsg[task.id].text}</p>
                        {actionChecks(actionMsg[task.id].checks)}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}
