/**
 * vitest.setup.ts — CC-060. Makes the test suite hermetic.
 *
 * Two guarantees, both enforced rather than documented:
 *
 *   1. No test can reach the network. Every client in this codebase (viem, supabase-js)
 *      goes through global fetch, so replacing it with a thrower makes an accidental
 *      real request impossible instead of merely unlikely.
 *
 *   2. No test runs with credentials or endpoints that could sign or transact for real.
 *
 * Why this exists: signer.test.ts once called completeTaskOnChain inside a bare
 * try/catch, asserting only that a mock had been reached. The assumption was that
 * simulateContract would fail "since there's no RPC" — but getChainConfig() falls back
 * to the public Base Sepolia endpoint, and an eth_call against a codeless address
 * *succeeds*. So writeContract ran and broadcast a real transaction
 * (0x1cc38f04…, block 44801606). The test stayed green for months while doing it.
 *
 * The suite also competed with anything else using that public endpoint, which is what
 * made it flaky: 3, then 10, then 13 failures observed on unchanged trees, each time
 * followed by a clean run.
 *
 * Escape hatch: ALLOW_TEST_NETWORK=1 disables the fetch guard, for a deliberate
 * integration test run. Never set it in CI.
 */

// ── 1. Strip anything that could sign, transact, or reach a real service ────────
//
// Measured 2026-08-13: Vitest does not load .env.local into process.env, so these are
// already absent in practice. Deleting them anyway is defence in depth — the moment
// someone adds dotenv loading, changes the runner, or exports one of these in their
// shell, the suite would silently gain the ability to sign with a real key. A test run
// must never depend on that not having happened.
//
// Note these are deleted, not blanked. `z.string().optional()` accepts "" as present,
// so blanking would leave config validation seeing a set-but-empty value.
const FORBIDDEN_ENV = [
  // Signing keys — DEPLOYER_PRIVATE_KEY was the escrow owner until CC-059.
  "DEPLOYER_PRIVATE_KEY",
  "GCP_KMS_KEY_PATH",
  "GCP_PROJECT_NUMBER",
  "GCP_WORKLOAD_IDENTITY_POOL_ID",
  "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
  "GCP_SERVICE_ACCOUNT_EMAIL",
  // Real RPC endpoints. Unset, escrow.ts and signer.ts fall back to the public
  // endpoint — which is the flakiness this issue is about. The fetch guard below
  // catches it either way; removing these makes the intent explicit.
  "BASE_SEPOLIA_RPC_URL",
  "BASE_MAINNET_RPC_URL",
  // Live contract addresses. Tests stub their own; a real one here would mean a test
  // could eth_call, or worse write to, a deployed contract.
  "NEXT_PUBLIC_ESCROW_CONTRACT",
  "NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT",
  "ESCROW_DEPLOY_BLOCK",
];

for (const key of FORBIDDEN_ENV) {
  delete process.env[key];
}

// ── 2. Block the network ────────────────────────────────────────────────────────

if (process.env.ALLOW_TEST_NETWORK !== "1") {
  const blocked = (input: unknown): string => {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    if (input && typeof input === "object" && "url" in input) {
      return String((input as { url: unknown }).url);
    }
    return "<unknown>";
  };

  globalThis.fetch = (async (input: unknown) => {
    // Logged as well as thrown. A test with a bare try/catch would otherwise swallow
    // this and stay green while the code underneath still tried to reach the network —
    // which is the exact failure mode this issue is about. Grep for this marker.
    console.error(`[CC-060 BLOCKED] ${blocked(input)}`);
    throw new Error(
      [
        `CC-060: blocked a real network request to ${blocked(input)}`,
        "",
        "The test suite is hermetic by design. A test that reaches the network is",
        "non-deterministic, competes with anything else using the same endpoint, and —",
        "on a write path — can broadcast a real transaction.",
        "",
        "Mock at the boundary instead:",
        "  • viem      vi.mock('viem', ...) replacing createPublicClient/createWalletClient",
        "              (see src/lib/__tests__/escrow-chunked.test.ts)",
        "  • supabase  vi.mock('@/lib/db/client', ...)",
        "",
        "If you genuinely need a live call, run it as a script under scripts/audit/",
        "rather than as a unit test. ALLOW_TEST_NETWORK=1 bypasses this guard locally;",
        "never set it in CI.",
      ].join("\n"),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}
