/**
 * requestAccountSwitch.ts — ask the *wallet* to re-pick an account.
 *
 * ## The problem this solves
 *
 * A dapp cannot revoke a wallet's authorisation. `useDisconnect()` clears wagmi's own
 * state; the wallet keeps its "this site is connected" grant, so the next `connect()` sees
 * `isAuthorized() === true` and returns the same account with no prompt.
 *
 * That made "Use a different wallet" a lie. It offered a choice of **connector** — Coinbase
 * versus MetaMask versus injected — while the user was asking for a different **account**.
 * Choosing the same connector reconnected them silently to the address they were trying to
 * leave, with no way out from inside the app. On the registration path, that means a worker
 * who connects the wrong address on their first visit is stuck with it.
 *
 * `wallet_requestPermissions` with `eth_accounts` is the standard way to ask a wallet to
 * show its account picker again even when a grant already exists (EIP-2255). Support is not
 * universal, which is why this reports what happened rather than throwing: a wallet that
 * cannot do it needs the user told the truth, not a silent no-op.
 */

import type { Connector } from "wagmi";

export type AccountSwitchResult =
  /** The wallet showed its picker and the user chose. Safe to connect. */
  | "prompted"
  /** The user dismissed the wallet's picker. Do nothing — this is not an error. */
  | "rejected"
  /** The wallet has no such method. Fall back, and say so. */
  | "unsupported";

/** EIP-1193: the method is not implemented by this provider. */
const METHOD_NOT_FOUND = -32601;
/** EIP-1193: the user rejected the request. */
const USER_REJECTED = 4001;

interface ProviderError {
  code?: number;
  message?: string;
}

function codeOf(err: unknown): number | undefined {
  const e = err as ProviderError & { cause?: ProviderError };
  return e?.code ?? e?.cause?.code;
}

/**
 * Ask `connector`'s wallet to re-prompt for an account.
 *
 * Never throws: every outcome is one a caller has to handle in the UI anyway, and an
 * exception here would surface as a red error box on a user action that is not an error.
 */
export async function requestAccountSwitch(
  connector: Connector,
): Promise<AccountSwitchResult> {
  let provider: unknown;
  try {
    provider = await connector.getProvider();
  } catch {
    return "unsupported";
  }

  const request = (provider as { request?: (a: unknown) => Promise<unknown> })?.request;
  if (typeof request !== "function") return "unsupported";

  try {
    await request.call(provider, {
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
    return "prompted";
  } catch (err) {
    const code = codeOf(err);
    if (code === USER_REJECTED) return "rejected";
    if (code === METHOD_NOT_FOUND) return "unsupported";

    // Wallets are inconsistent about codes for "I don't do that". Anything that is not a
    // clear rejection is treated as unsupported, because the fallback — showing the picker
    // and explaining — is safe, whereas swallowing it would leave the button silent again.
    const message = String((err as ProviderError)?.message ?? "").toLowerCase();
    if (message.includes("not supported") || message.includes("unsupported")) {
      return "unsupported";
    }
    if (message.includes("reject") || message.includes("denied")) return "rejected";
    return "unsupported";
  }
}
