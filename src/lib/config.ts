/**
 * config.ts
 * Centralized, Zod-validated environment configuration.
 * Validates on first access and caches the result.
 */

import { z } from "zod";

const envSchema = z.object({
  // ── Required ──────────────────────────────────────────────────────────────
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // ── Network (required — no default, must be set explicitly) ──────────────
  NEXT_PUBLIC_BASE_NETWORK: z.enum(["testnet", "mainnet"]),

  // ── Contracts (optional — may not be deployed yet) ────────────────────────
  NEXT_PUBLIC_ESCROW_CONTRACT: z.string().optional(),
  NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT: z.string().optional(),
  BASE_SEPOLIA_RPC_URL: z.string().optional(),
  BASE_MAINNET_RPC_URL: z.string().optional(),

  // ── Event-query bounds (CC-070) ───────────────────────────────────────────
  // The block CarbonEscrow was deployed at. Every getLogs query starts here
  // instead of genesis: at ~45M blocks deep, scanning from 0 in 10k windows is
  // ~22,700 requests per query, versus ~635 from the deploy block. Derive it with
  //   node --env-file=.env.local scripts/audit/find-deploy-block.mjs
  // and re-derive it after the mainnet deploy (CC-034). If unset, queries fall
  // back to genesis and log a warning — correct, but far slower than necessary.
  ESCROW_DEPLOY_BLOCK: z.coerce.number().int().nonnegative().optional(),

  // Maximum block span a single eth_getLogs call may cover. This is a property of
  // the RPC provider, not the protocol. Measured 2026-08-11 on the public
  // sepolia.base.org endpoint: 10,000 accepted, 50,000 rejected with
  // "eth_getLogs is limited to a 10,000 range". CC-070 was originally filed
  // against a 2,000 limit, so this moves — hence config, not a constant. Paid
  // providers generally allow much larger spans; raise this when one is in use.
  RPC_MAX_BLOCK_RANGE: z.coerce.number().int().positive().default(10_000),

  // ── USDC contract address (required — differs per network) ────────────────
  NEXT_PUBLIC_USDC_ADDRESS: z.string().min(1),

  // ── x402 / Platform ───────────────────────────────────────────────────────
  NEXT_PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  PLATFORM_WALLET_ADDRESS: z.string().optional(),

  // ── Deploy (optional — only needed for Hardhat scripts) ───────────────────
  DEPLOYER_PRIVATE_KEY: z.string().optional(),
  CDP_API_KEY: z.string().optional(),

  // ── GCP Cloud KMS (optional — production signer via HSM) ─────────────────
  GCP_KMS_KEY_PATH: z.string().optional(),
  GCP_PROJECT_NUMBER: z.string().optional(),
  GCP_WORKLOAD_IDENTITY_POOL_ID: z.string().optional(),
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: z.string().optional(),
  GCP_SERVICE_ACCOUNT_EMAIL: z.string().optional(),

  // ── Session management ────────────────────────────────────────────────────
  SESSION_TIMEOUT_MS: z.coerce.number().default(1_800_000), // 30 min
  MAX_SESSIONS: z.coerce.number().default(100),

  // ── Rate limiting ─────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000), // 1 min
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(60),

  // ── /learn + Stables affiliate (optional — set when affiliate approved) ──
  NEXT_PUBLIC_STABLES_AFFILIATE_URL: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

let _config: AppConfig | null = null;

/**
 * Returns the validated config, parsing env vars on first call.
 * Throws a descriptive error if required vars are missing.
 */
/** For testing only — resets the cached config so getConfig() re-parses env vars. */
export function _resetConfig(): void {
  _config = null;
}

export function getConfig(): AppConfig {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  _config = Object.freeze(result.data) as AppConfig;
  return _config;
}
