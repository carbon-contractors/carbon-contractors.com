/**
 * verify.ts
 * Wallet signature verification for Carbon Contractors.
 *
 * viem's standalone `verifyMessage` (no client) only recovers a raw ECDSA signer via
 * ecrecover and works for Externally Owned Accounts ONLY -- its own docstring says so:
 * "Does not support Contract Accounts. It is highly recommended to use
 * `publicClient.verifyMessage` instead." Base Account / Coinbase Smart Wallet, the
 * passkey connector this product's entire onboarding pitch is built on
 * (`src/lib/wallet/providers.tsx`), is an ERC-4337 smart contract account. Its
 * signatures are ERC-6492/ERC-1271, not raw ECDSA recoverable to the wallet address --
 * confirmed live 2026-08-08, a real passkey registration failed signature verification
 * outright. Every wallet-signature check in this app must go through a public client so
 * both account types work.
 */
import { createPublicClient, http, type SignableMessage } from "viem";
import { base, baseSepolia } from "viem/chains";
import { getConfig } from "@/lib/config";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _publicClient: any = null;

function getPublicClient() {
  if (_publicClient) return _publicClient;
  const config = getConfig();
  const chain = config.NEXT_PUBLIC_BASE_NETWORK === "mainnet" ? base : baseSepolia;
  const rpcUrl =
    config.NEXT_PUBLIC_BASE_NETWORK === "mainnet"
      ? (config.BASE_MAINNET_RPC_URL ?? chain.rpcUrls.default.http[0])
      : (config.BASE_SEPOLIA_RPC_URL ?? chain.rpcUrls.default.http[0]);
  _publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  return _publicClient;
}

/**
 * Verify that `signature` over `message` was produced by `address`, for either an
 * EOA (ecrecover) or a smart contract account (ERC-6492/ERC-1271, via an on-chain
 * call — this makes a real RPC request, it is not a pure offline check).
 */
export async function verifyWalletSignature(params: {
  address: `0x${string}`;
  message: SignableMessage;
  signature: `0x${string}`;
}): Promise<boolean> {
  const client = getPublicClient();
  return client.verifyMessage(params);
}

/** Reset the cached client (for testing). */
export function _resetVerifyClient(): void {
  _publicClient = null;
}
