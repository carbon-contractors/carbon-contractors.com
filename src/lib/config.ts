/**
 * config.ts
 * Centralized, Zod-validated environment configuration.
 * Validates on first access and caches the result.
 */

import { z } from "zod";

// ── Set-but-empty env vars (CC-097) ──────────────────────────────────────────
//
// An env var that is PRESENT BUT EMPTY arrives as "" rather than undefined. A blank
// field in the Vercel dashboard, a `VAR=` line in a .env file, `docker run -e VAR`
// and an unset GitHub Actions secret all produce it. `??` only catches null and
// undefined, so it does not select the default — that is Lessons-Learned §24.
//
// Zod does not save you from it by itself, which is the part that made CC-097 worth
// filing. Two traps:
//
//   • `.default()` fires on undefined only, so "" reaches the inner schema.
//   • `z.coerce.number()` on "" is **0**, not NaN, because `Number("") === 0`.
//
// So `z.coerce.number().default(60)` on a blank RATE_LIMIT_MAX_REQUESTS yields a
// limit of zero — denying every request — rather than the documented 60. And
// `z.coerce.number().int().nonnegative().optional()` on a blank ESCROW_DEPLOY_BLOCK
// yields 0, which is a *valid* block number, so it scans from genesis and passes the
// `=== undefined` guard in escrow.ts that exists to warn about exactly that.
//
// Blank is therefore treated as unset. That is what an operator clearing a field
// means, and it keeps the documented default reachable instead of turning a blank
// field into an outage. Anything else non-numeric still throws here, at the boundary,
// rather than becoming a NaN that every comparison downstream quietly answers
// `false` to.

/** "" and whitespace-only become undefined; everything else passes through. */
const blankAsUnset = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

/**
 * A positive integer env var with a default. Blank or unset takes the default;
 * `"0"`, `"-1"`, `"12.5"` and `"abc"` all throw.
 */
const envInt = (fallback: number) =>
  z.preprocess(
    (v) => (blankAsUnset(v) === undefined ? fallback : v),
    z.coerce.number().int().positive(),
  );

/** Wraps an optional schema so a blank value reads as absent, not as present-and-empty. */
const envOptional = <T extends z.ZodType>(schema: T) => z.preprocess(blankAsUnset, schema);

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// Defined separately from the main schema, and parsed separately by
// getRateLimitConfig(), because middleware.ts and ratelimit.ts read these at module
// scope. Routing them through the full getConfig() would make every /api/* route —
// and the coming-soon gate, which runs in the same middleware — depend on
// SUPABASE_SERVICE_ROLE_KEY and friends being present. The shape is shared, so there
// is still exactly one definition of each field.

const rateLimitShape = {
  RATE_LIMIT_WINDOW_MS: envInt(60_000), // 1 min
  RATE_LIMIT_MAX_REQUESTS: envInt(60),
  TASK_CREATE_LIMIT_PER_HOUR: envInt(30),
};

const rateLimitSchema = z.object(rateLimitShape);

export type RateLimitConfig = z.infer<typeof rateLimitSchema>;

const envSchema = z.object({
  // ── Required ──────────────────────────────────────────────────────────────
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // ── Network (required — no default, must be set explicitly) ──────────────
  NEXT_PUBLIC_BASE_NETWORK: z.enum(["testnet", "mainnet"]),

  // ── Contracts (optional — may not be deployed yet) ────────────────────────
  // envOptional, not bare .optional(): a blank NEXT_PUBLIC_ESCROW_CONTRACT would
  // otherwise arrive as "" and be treated as a configured address (CC-097).
  NEXT_PUBLIC_ESCROW_CONTRACT: envOptional(z.string().optional()),
  NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT: envOptional(z.string().optional()),
  BASE_SEPOLIA_RPC_URL: envOptional(z.string().optional()),
  BASE_MAINNET_RPC_URL: envOptional(z.string().optional()),

  // ── Event-query bounds (CC-070) ───────────────────────────────────────────
  // The block CarbonEscrow was deployed at. Every getLogs query starts here
  // instead of genesis: at ~45M blocks deep, scanning from 0 in 10k windows is
  // ~22,700 requests per query, versus ~635 from the deploy block. Derive it with
  //   node --env-file=.env.local scripts/audit/find-deploy-block.mjs
  // and re-derive it after the mainnet deploy (CC-034). If unset, queries fall
  // back to genesis and log a warning — correct, but far slower than necessary.
  //
  // envOptional matters here specifically: without it a blank value coerces to 0,
  // which is a valid block number, so escrow.ts's `=== undefined` check passes and
  // the warning above never fires. Blank must read as unset for that guard to work.
  ESCROW_DEPLOY_BLOCK: envOptional(z.coerce.number().int().nonnegative().optional()),

  // Maximum block span a single eth_getLogs call may cover. This is a property of
  // the RPC provider, not the protocol. Measured 2026-08-11 on the public
  // sepolia.base.org endpoint: 10,000 accepted, 50,000 rejected with
  // "eth_getLogs is limited to a 10,000 range". CC-070 was originally filed
  // against a 2,000 limit, so this moves — hence config, not a constant. Paid
  // providers generally allow much larger spans; raise this when one is in use.
  RPC_MAX_BLOCK_RANGE: envInt(10_000),

  // ── USDC contract address (required — differs per network) ────────────────
  NEXT_PUBLIC_USDC_ADDRESS: z.string().min(1),

  // ── x402 / Platform ───────────────────────────────────────────────────────
  NEXT_PUBLIC_BASE_URL: envOptional(z.string().default("http://localhost:3000")),
  PLATFORM_WALLET_ADDRESS: envOptional(z.string().optional()),

  // ── Deploy (optional — only needed for Hardhat scripts) ───────────────────
  DEPLOYER_PRIVATE_KEY: envOptional(z.string().optional()),
  CDP_API_KEY: envOptional(z.string().optional()),

  // ── GCP Cloud KMS (optional — production signer via HSM) ─────────────────
  // A blank GCP_KMS_KEY_PATH must read as "no HSM configured", not as a configured
  // key path of "", which is what selects the signer implementation (CC-097).
  GCP_KMS_KEY_PATH: envOptional(z.string().optional()),
  GCP_PROJECT_NUMBER: envOptional(z.string().optional()),
  GCP_WORKLOAD_IDENTITY_POOL_ID: envOptional(z.string().optional()),
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: envOptional(z.string().optional()),
  GCP_SERVICE_ACCOUNT_EMAIL: envOptional(z.string().optional()),

  // ── Session management ────────────────────────────────────────────────────
  SESSION_TIMEOUT_MS: envInt(1_800_000), // 30 min
  MAX_SESSIONS: envInt(100),

  // ── Emergency Intake Kill Switch (ADR-0003 D4 / CC-086) ───────────────────
  // When active ("true" / "1" / "yes"), blocks new task creation across MCP
  // and APIs while keeping in-flight tasks, claims, and reviews unpaused.
  NEXT_PUBLIC_INTAKE_PAUSED: envOptional(z.string().default("false")),
  NEXT_PUBLIC_INTAKE_PAUSE_NOTICE: envOptional(
    z
      .string()
      .default(
        "Task intake is temporarily paused for system maintenance. In-flight tasks and settlements continue normally."
      )
  ),

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Shape shared with getRateLimitConfig() — see rateLimitShape above.
  ...rateLimitShape,

  // NEXT_PUBLIC_STABLES_AFFILIATE_URL was removed by CC-029. Nothing ever read it,
  // the affiliate relationship it anticipated never existed, and the provider was
  // winding down. There are deliberately no affiliate or referral vars here — if a
  // commercial relationship is ever added, it gets disclosed in the /learn copy
  // rather than represented only by a config key. Remove it from the Vercel
  // environment too.
});

export type AppConfig = z.infer<typeof envSchema>;

let _config: AppConfig | null = null;
let _rateLimitConfig: RateLimitConfig | null = null;

/** For testing only — resets the cached config so getConfig() re-parses env vars. */
export function _resetConfig(): void {
  _config = null;
  _rateLimitConfig = null;
}

function describeFailure(error: z.ZodError): string {
  const issues = error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  return `Invalid environment configuration:\n${issues}`;
}

/**
 * Check whether task intake is temporarily paused (ADR-0003 D4 / CC-086).
 * Safe to call in any context without throwing.
 */
export function isIntakePaused(): { paused: boolean; notice: string } {
  try {
    const config = getConfig();
    const val = config.NEXT_PUBLIC_INTAKE_PAUSED?.toLowerCase();
    const paused = val === "true" || val === "1" || val === "yes";
    const notice =
      config.NEXT_PUBLIC_INTAKE_PAUSE_NOTICE ||
      "Task intake is temporarily paused for system maintenance. In-flight tasks and settlements continue normally.";
    return { paused, notice };
  } catch {
    const val = process.env.NEXT_PUBLIC_INTAKE_PAUSED?.toLowerCase();
    const paused = val === "true" || val === "1" || val === "yes";
    const notice =
      process.env.NEXT_PUBLIC_INTAKE_PAUSE_NOTICE ||
      "Task intake is temporarily paused for system maintenance. In-flight tasks and settlements continue normally.";
    return { paused, notice };
  }
}

/**
 * Returns the validated config, parsing env vars on first call.
 * Throws a descriptive error if required vars are missing.
 */
export function getConfig(): AppConfig {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(describeFailure(result.error));
  }

  _config = Object.freeze(result.data) as AppConfig;
  return _config;
}

/**
 * The rate-limiting knobs, validated on their own (CC-097).
 *
 * Deliberately narrower than getConfig(). middleware.ts reads these at module scope
 * on the edge runtime, and the same middleware hosts the coming-soon gate — so
 * requiring the full environment here would mean a missing Supabase key takes down
 * the gate as well as the API.
 *
 * A blank value takes the documented default. A malformed one (`"abc"`, `"0"`,
 * `"-5"`) throws, which at module scope means the route fails to initialise. That is
 * the intended polarity for a security control: a rate limiter that cannot read its
 * own configuration must not come up silently permissive, which is precisely what
 * `parseInt("") -> NaN` used to do.
 */
export function getRateLimitConfig(): RateLimitConfig {
  if (_rateLimitConfig) return _rateLimitConfig;

  const result = rateLimitSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(describeFailure(result.error));
  }

  _rateLimitConfig = Object.freeze(result.data) as RateLimitConfig;
  return _rateLimitConfig;
}
