/**
 * discovery-config.mjs — env + constants validation for the CC-032 discovery-stage harness.
 *
 * Pure module, no side effects, no network — unit-tested from
 * scripts/lifecycle/__tests__/discovery-stage.test.mjs. The CLI entry
 * (discovery-stage.mjs) self-executes on import, so everything testable lives
 * here instead (same precedent as config.mjs / funding-stage.mjs).
 *
 * Deliberately narrower than the funding-stage config:
 *
 *  - NO RPC URL. Discovery is entirely off-chain: registration and profile
 *    updates are signed messages verified by the SERVER's public client, and
 *    the MCP read tools need no chain access at all. A harness that demanded
 *    an RPC it never uses would just be one more way to not run.
 *  - The wallet var is DISCOVERY_WALLET_PRIVATE_KEY — a THIRD name, on purpose.
 *    It must be a throwaway EOA that holds nothing and will never fund
 *    anything: its only role is to sign the registration/profile messages
 *    that make the discovery loop provable end to end. Reusing
 *    AGENT_WALLET_PRIVATE_KEY would work technically but couples a test row
 *    to a wallet that later matters in CC-077's money path; reusing
 *    DEPLOYER_PRIVATE_KEY would make the platform owner discoverable as a
 *    worker in the production whitepages. Generate a fresh one
 *    (--generate-wallet), use it once, record it in the run log.
 *  - As with the funding harness, the key's VALUE is never returned, logged,
 *    or printed — presence and format only.
 *
 * Blank is not unset (CC-097): `VAR=` arrives as "" and must read as missing.
 */

export const DISCOVERY_ENV_NAMES = {
  walletKey: "DISCOVERY_WALLET_PRIVATE_KEY",
  baseUrl: "NEXT_PUBLIC_BASE_URL",
  network: "NEXT_PUBLIC_BASE_NETWORK",
};

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Validate every input the discovery harness needs. Collects ALL problems
 * before reporting — one shot, not a scavenger hunt (same rule as
 * validateLifecycleConfig).
 *
 * @param {Record<string, string|undefined>} env — usually process.env; passed
 *   in so tests drive it without touching the real environment.
 * @param {{ ephemeralWallet?: boolean }} [opts] — true when --generate-wallet
 *   was passed: the run will mint its own throwaway key, so the env var is
 *   not required (and is ignored if present).
 * @returns {{ ok: boolean, problems: string[], config: object|null }}
 *   `config` is null when !ok; on success it carries everything except the
 *   private key (the env var NAME rides along so the runner can read the value
 *   only at the moment of use).
 */
export function validateDiscoveryConfig(env, opts = {}) {
  const problems = [];

  // Presence and FORMAT only. The value is deliberately not captured.
  // Skippable entirely when the run mints an ephemeral key (--generate-wallet).
  const walletKey = env[DISCOVERY_ENV_NAMES.walletKey]?.trim();
  if (!walletKey && !opts.ephemeralWallet) {
    problems.push(
      `${DISCOVERY_ENV_NAMES.walletKey} is not set. A THROWAWAY EOA key (0x + 64 hex) that holds nothing — it only signs the registration message. Never DEPLOYER_PRIVATE_KEY, never AGENT_WALLET_PRIVATE_KEY (see scripts/lifecycle/README.md, CC-032). Generate one with --generate-wallet.`,
    );
  } else if (walletKey && !PRIVATE_KEY_RE.test(walletKey)) {
    problems.push(
      `${DISCOVERY_ENV_NAMES.walletKey} is malformed — expected 0x followed by 64 hex characters. The value is never printed; only its shape is checked.`,
    );
  }

  const baseUrl = env[DISCOVERY_ENV_NAMES.baseUrl]?.trim();
  if (!baseUrl) {
    problems.push(
      `${DISCOVERY_ENV_NAMES.baseUrl} is not set. The harness registers and reads through the deployment's /api/* and MCP endpoints (e.g. https://www.carbon-contractors.com — note the www, apex answers 307).`,
    );
  } else if (!HTTP_URL_RE.test(baseUrl)) {
    problems.push(`${DISCOVERY_ENV_NAMES.baseUrl} is not an http(s) URL: got "${baseUrl}"`);
  }

  // The whitepages and MCP tools this harness exercises are live in the
  // production testnet deployment; a mainnet-flavoured environment would aim
  // the same reads at a deployment whose humans table is a different world.
  const network = env[DISCOVERY_ENV_NAMES.network]?.trim();
  if (network && network !== "testnet") {
    problems.push(
      `${DISCOVERY_ENV_NAMES.network} is "${network}" but this harness targets the base-sepolia deployment (discovery is off-chain, but the whitepages it reads is testnet production). CC-032 proves discovery on the live testnet deployment; mainnet is CC-034.`,
    );
  }

  if (problems.length > 0) return { ok: false, problems, config: null };

  return {
    ok: true,
    problems: [],
    config: {
      baseUrl: baseUrl.replace(/\/+$/, ""), // trailing slash would double up in path joins
      walletKeyEnvName: DISCOVERY_ENV_NAMES.walletKey,
    },
  };
}

/** Operator-facing failure message — every problem, numbered, README pointer. */
export function discoveryConfigFailureMessage(problems) {
  return [
    "MISCONFIGURED — the discovery-stage harness cannot run. All problems:",
    "",
    ...problems.map((p, i) => `${i + 1}. ${p}`),
    "",
    "See scripts/lifecycle/README.md (Discovery stage / Prerequisites).",
  ].join("\n");
}
