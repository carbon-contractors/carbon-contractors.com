import { describe, it, expect, vi, beforeEach } from "vitest";
// Static, not dynamic: `vi.mock` is hoisted above it, and loading the MCP SDK graph
// lazily inside the first test charged ~8s of cold module resolution to that test's
// timeout on Windows.
import { createMcpServer } from "@/lib/mcp/server";

/**
 * ADR-0010 — request_human_work's evidence_upload argument: validated against
 * the committed evidence_bucket before any row exists, encrypted bound to the
 * new task, stored, reported back, and never logged. Plus open item 2: a
 * warning when the criteria want files but no bucket was given.
 */

const mockGetHumanByWallet = vi.fn();
vi.mock("@/lib/db/whitepages", () => ({
  getHumanByWallet: (...args: unknown[]) => mockGetHumanByWallet(...args),
  searchByCategory: vi.fn(),
  getAllHumans: vi.fn(),
  getHumanById: vi.fn(),
  getDistinctCategories: vi.fn(),
}));

const mockCreateFundingOffer = vi.fn();
const mockCountCommittedTasks = vi.fn();
vi.mock("@/lib/payments/funding", () => ({
  createFundingOffer: (...args: unknown[]) => mockCreateFundingOffer(...args),
  replayFundingOffer: vi.fn(),
}));

const mockLimit = vi.fn();
vi.mock("@/lib/ratelimit", () => ({
  taskCreationRateLimiter: { limit: (...args: unknown[]) => mockLimit(...args) },
}));

vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: vi.fn(),
  updateTaskStatus: vi.fn(),
  countCommittedTasks: (...args: unknown[]) => mockCountCommittedTasks(...args),
  findTaskByIdempotencyKey: vi.fn().mockResolvedValue(null),
  WORKER_CONCURRENCY_CAP: 3,
}));

const mockGetChannelsForContractor = vi.fn();
vi.mock("@/lib/db/notifications", () => ({
  registerNotificationChannel: vi.fn(),
  getChannelsForContractor: (...args: unknown[]) => mockGetChannelsForContractor(...args),
}));

const mockNotifyContractor = vi.fn();
vi.mock("@/lib/notifications/dispatch", () => ({
  notifyContractor: (...args: unknown[]) => mockNotifyContractor(...args),
}));

vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: vi.fn(),
  getTaskResolvedOutcome: vi.fn(),
  getEscrowConfig: () => ({
    address: "0xEscrow00000000000000000000000000000000",
    chainId: 84532,
    chainName: "Base Sepolia",
  }),
  toTaskId: (paymentRequestId: string) => `0xtaskid-${paymentRequestId}`,
}));

vi.mock("@/lib/contracts/signer", () => ({
  resolveDisputeOnChain: vi.fn(),
}));

// CC-075: the inline AWOL check runs on every hire. Default to "not
// triggered" — its own behaviour is covered in awol.test.ts.
const mockEvaluateAwolAtBooking = vi.fn().mockResolvedValue({
  evaluated: false,
  triggered: false,
  signal: null,
  consecutiveLapsedOffers: 0,
  consecutiveExpiredTasks: 0,
});
vi.mock("@/lib/awol", () => ({
  evaluateAwolAtBooking: (...args: unknown[]) => mockEvaluateAwolAtBooking(...args),
}));

const mockConfigured = vi.fn();
const mockEncrypt = vi.fn();
vi.mock("@/lib/evidence/credential-crypto", () => ({
  isEvidenceEncryptionConfigured: () => mockConfigured(),
  encryptCredential: (...args: unknown[]) => mockEncrypt(...args),
}));

const mockStore = vi.fn();
vi.mock("@/lib/db/upload-credentials", () => ({
  storeUploadCredential: (...args: unknown[]) => mockStore(...args),
}));

const mockLog = vi.fn();
vi.mock("@/lib/logging", () => ({ log: (...args: unknown[]) => mockLog(...args) }));

const AGENT_WALLET = "0xAGENTagentAGENTagentAGENTagentAGENTagent";
const WORKER_WALLET = "0xWORKERworkerWORKERworkerWORKERworkerWORK";

const BUCKET_SPEC = JSON.stringify({
  schema_version: 1,
  criteria: { min_artefacts: 2 },
  evidence_bucket: { provider: "s3", target: "s3://agent-evidence" },
});

const CREDENTIAL = {
  access_key_id: "AKIAEXAMPLEKEY",
  secret_access_key: "very-secret-value",
  region: "ap-southeast-2",
};

const BASE_ARGS = {
  to_human_wallet: WORKER_WALLET,
  task_description: "Photograph the switchboard in Rack Room 2",
  amount_usdc: 25,
  deadline_hours: 24,
  review_window_hours: 48,
  acceptance_spec: BUCKET_SPEC,
};

async function call(args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer({ callerWallet: AGENT_WALLET }) as any;
  const result = await server._registeredTools["request_human_work"].handler(args);
  return { result, json: JSON.parse(result.content[0].text) };
}

describe("request_human_work evidence_upload (ADR-0010)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue({ success: true, remaining: 29, retryAfterS: 0 });
    mockGetHumanByWallet.mockResolvedValue({
      id: "human-uuid",
      wallet: WORKER_WALLET.toLowerCase(),
      categories: ["delivery-errands"],
      rate_usdc: 40,
      availability: "available",
      reputation_score: 80,
    });
    mockCreateFundingOffer.mockResolvedValue({
      status: "awaiting_funding",
      payment_request_id: "pr_1",
      worker_status: "pending",
      offer_expiry_unix: 9999999999,
    });
    mockGetChannelsForContractor.mockResolvedValue([]);
    mockNotifyContractor.mockResolvedValue({ notified_channels: 0 });
    mockCountCommittedTasks.mockResolvedValue(0);
    mockConfigured.mockReturnValue(true);
    mockEncrypt.mockResolvedValue('{"v":1,"wk":"x","iv":"y","tag":"z","ct":"w"}');
    mockStore.mockResolvedValue(undefined);
  });

  it("encrypts bound to the new task, stores it, and reports the cap", async () => {
    const { json } = await call({ ...BASE_ARGS, evidence_upload: { ...CREDENTIAL, max_upload_mb: 10 } });
    expect(json.ok).toBe(true);
    expect(mockEncrypt).toHaveBeenCalledWith(
      { accessKeyId: "AKIAEXAMPLEKEY", secretAccessKey: "very-secret-value", region: "ap-southeast-2" },
      "pr_1",
    );
    expect(mockStore).toHaveBeenCalledWith({
      payment_request_id: "pr_1",
      provider: "s3",
      credential_envelope: '{"v":1,"wk":"x","iv":"y","tag":"z","ct":"w"}',
      max_upload_bytes: 10 * 1024 * 1024,
    });
    expect(json.evidence_upload).toEqual({ enabled: true, max_upload_bytes: 10 * 1024 * 1024 });
    expect(json.warnings).toBeUndefined();
  });

  it("never echoes or logs the credential", async () => {
    const { json } = await call({ ...BASE_ARGS, evidence_upload: CREDENTIAL });
    const everything = JSON.stringify(json) + JSON.stringify(mockLog.mock.calls);
    expect(everything).not.toContain("very-secret-value");
    expect(everything).not.toContain("AKIAEXAMPLEKEY");
  });

  it("refuses before creating a row when the spec names no bucket", async () => {
    const { result, json } = await call({
      ...BASE_ARGS,
      acceptance_spec: '{"schema_version":1,"criteria":{"min_artefacts":2}}',
      evidence_upload: CREDENTIAL,
    });
    expect(result.isError).toBe(true);
    expect(json.reason).toBe("evidence_upload_invalid");
    expect(mockCreateFundingOffer).not.toHaveBeenCalled();
  });

  it("refuses an endpoint that is not an allowed storage host", async () => {
    const { result } = await call({
      ...BASE_ARGS,
      evidence_upload: { ...CREDENTIAL, endpoint: "https://evil.example.com" },
    });
    expect(result.isError).toBe(true);
    expect(mockCreateFundingOffer).not.toHaveBeenCalled();
  });

  it("refuses when the deployment has no evidence key configured", async () => {
    mockConfigured.mockReturnValue(false);
    const { result, json } = await call({ ...BASE_ARGS, evidence_upload: CREDENTIAL });
    expect(result.isError).toBe(true);
    expect(json.reason).toBe("evidence_upload_unavailable");
    expect(mockCreateFundingOffer).not.toHaveBeenCalled();
  });

  it("keeps the hire when storing fails, but says uploads are off", async () => {
    mockStore.mockRejectedValue(new Error("db down"));
    const { json } = await call({ ...BASE_ARGS, evidence_upload: CREDENTIAL });
    expect(json.ok).toBe(true);
    expect(json.evidence_upload.enabled).toBe(false);
    expect(json.evidence_upload.error).toContain("paste links");
  });

  it("warns when criteria require files but no credential was given (open item 2)", async () => {
    const { json } = await call(BASE_ARGS);
    expect(json.ok).toBe(true);
    expect(json.warnings?.[0]).toContain("evidence_upload");
    expect(mockEncrypt).not.toHaveBeenCalled();
  });
});
