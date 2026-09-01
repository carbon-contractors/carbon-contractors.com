/**
 * request-account-switch.test.ts — asking a wallet to re-pick an account.
 *
 * The defect this closes: "Use a different wallet" offered a choice of *connector* while
 * the user was asking for a different *account*. Because a dapp cannot revoke a wallet's
 * grant, choosing the same connector reconnected them silently to the address they were
 * trying to leave — with no way out from inside the app. On the registration path that
 * means a worker who connects the wrong address on their first visit is stuck with it.
 *
 * The three outcomes below are not equivalent, and conflating any two reintroduces the
 * bug in a different shape:
 *
 *   prompted    the wallet asked — connect, and take whatever it returns
 *   rejected    the user dismissed their own wallet — do NOTHING, this is not an error
 *   unsupported the wallet cannot re-prompt — fall back AND say so, because falling back
 *               silently is what the original code did
 */
import { describe, it, expect, vi } from "vitest";
import type { Connector } from "wagmi";
import { requestAccountSwitch } from "@/lib/wallet/requestAccountSwitch";

/** A connector whose provider answers `request` however the test says. */
function connectorWith(request: unknown): Connector {
  return {
    getProvider: async () => (request === undefined ? {} : { request }),
  } as unknown as Connector;
}

function providerError(code: number, message = "") {
  return Object.assign(new Error(message), { code });
}

describe("requestAccountSwitch", () => {
  it("asks the wallet with the EIP-2255 permissions request", async () => {
    const request = vi.fn().mockResolvedValue([{ parentCapability: "eth_accounts" }]);
    const result = await requestAccountSwitch(connectorWith(request));

    expect(result).toBe("prompted");
    // The exact shape matters: `wallet_requestPermissions` for `eth_accounts` is what makes
    // a wallet re-show its picker even though a grant already exists. Anything else either
    // does nothing or returns the current account without asking.
    expect(request).toHaveBeenCalledWith({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  });

  it("reports a user dismissal as rejected, not as failure", async () => {
    // 4001 is the user closing their own wallet popup. Treating that as an error would put
    // a red box on screen for someone who simply changed their mind.
    const result = await requestAccountSwitch(
      connectorWith(vi.fn().mockRejectedValue(providerError(4001, "User rejected the request"))),
    );
    expect(result).toBe("rejected");
  });

  it("trusts the CODE over the message, both ways", async () => {
    // Mutation testing caught this gap: the earlier rejection test used the message
    // "User rejected the request", so the message-sniffing fallback answered it and the
    // code check was never actually exercised. Removing the code check still passed.
    //
    // These two carry codes and say nothing useful in the message, so only the code can
    // decide. Message-sniffing exists for wallets that omit codes — it must not be what
    // the common path depends on.
    expect(
      await requestAccountSwitch(connectorWith(vi.fn().mockRejectedValue(providerError(4001, "")))),
    ).toBe("rejected");
    expect(
      await requestAccountSwitch(
        connectorWith(vi.fn().mockRejectedValue(providerError(-32601, ""))),
      ),
    ).toBe("unsupported");
  });

  it("reports a wallet without the method as unsupported", async () => {
    const result = await requestAccountSwitch(
      connectorWith(vi.fn().mockRejectedValue(providerError(-32601, "Method not found"))),
    );
    expect(result).toBe("unsupported");
  });

  it("treats an unrecognised failure as unsupported rather than swallowing it", async () => {
    // Wallets are inconsistent about codes for "I don't do that". Unsupported is the safe
    // reading because it leads to telling the user something true; silence is what the
    // original bug was.
    const result = await requestAccountSwitch(
      connectorWith(vi.fn().mockRejectedValue(new Error("something odd happened"))),
    );
    expect(result).toBe("unsupported");
  });

  it("reads rejection and unsupported out of the message when there is no code", async () => {
    expect(
      await requestAccountSwitch(connectorWith(vi.fn().mockRejectedValue(new Error("User denied")))),
    ).toBe("rejected");
    expect(
      await requestAccountSwitch(
        connectorWith(vi.fn().mockRejectedValue(new Error("Not supported by this wallet"))),
      ),
    ).toBe("unsupported");
  });

  it("is unsupported when the provider has no request method at all", async () => {
    expect(await requestAccountSwitch(connectorWith(undefined))).toBe("unsupported");
  });

  it("is unsupported when the connector cannot produce a provider", async () => {
    const connector = {
      getProvider: async () => {
        throw new Error("no provider");
      },
    } as unknown as Connector;
    expect(await requestAccountSwitch(connector)).toBe("unsupported");
  });

  it("never throws, whatever the wallet does", async () => {
    // The caller runs this from a click handler. An exception here would surface as an
    // error on a user action that is not an error.
    for (const thrown of [null, undefined, "a string", { weird: true }, 42]) {
      const result = await requestAccountSwitch(
        connectorWith(vi.fn().mockRejectedValue(thrown)),
      );
      expect(["prompted", "rejected", "unsupported"]).toContain(result);
    }
  });
});
