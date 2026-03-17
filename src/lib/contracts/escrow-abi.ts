/**
 * escrow-abi.ts
 * ABI for CarbonEscrow contract — used by viem for type-safe contract calls.
 * Generated from: contracts/CarbonEscrow.sol
 */

export const CARBON_ESCROW_ABI = [
  // ── Constructor ─────────────────────────────────────────────────────────────
  {
    type: "constructor",
    inputs: [{ name: "_usdc", type: "address" }],
    stateMutability: "nonpayable",
  },

  // ── Write functions ─────────────────────────────────────────────────────────
  {
    type: "function",
    name: "createTask",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "worker", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "completeTask",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "disputeTask",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "resolveDispute",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "releaseToWorker", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "expireTask",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },

  // ── Read functions ──────────────────────────────────────────────────────────
  {
    type: "function",
    name: "getTask",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "agent", type: "address" },
          { name: "worker", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "state", type: "uint8" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "usdc",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalLocked",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },

  // ── Events ──────────────────────────────────────────────────────────────────
  {
    type: "event",
    name: "TaskCreated",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "worker", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TaskCompleted",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TaskDisputed",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "by", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TaskResolved",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "releasedToWorker", type: "bool", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TaskExpired",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "refunded", type: "uint256", indexed: false },
    ],
  },

  // ── Errors ──────────────────────────────────────────────────────────────────
  {
    type: "error",
    name: "TaskAlreadyExists",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidWorker",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroAmount",
    inputs: [],
  },
  {
    type: "error",
    name: "DeadlinePassed",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidState",
    inputs: [
      { name: "current", type: "uint8" },
      { name: "expected", type: "uint8" },
    ],
  },
  {
    type: "error",
    name: "NotParty",
    inputs: [],
  },
  {
    type: "error",
    name: "NotExpired",
    inputs: [],
  },
] as const;
