import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// CC-040: the error-alert relay. The properties that matter, in order of how badly
// they break when wrong:
//   1. It never throws — an alerting path that can take down the request it observes
//      is worse than no alerting path (same rule as notifications/delivery.ts).
//   2. It dedups — a retry loop must not page once per request.
//   3. It does not ship the error message to the webhook — the message can contain
//      user input or task content; the relay carries class + route + digest only.

vi.mock("@/lib/logging", () => ({
  log: vi.fn(),
}));

const realFetch = globalThis.fetch;

describe("instrumentation error relay", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.MONITOR_WEBHOOK_URL = "https://discord.test/hook";
    delete process.env.ALERT_DEDUP_MS;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MONITOR_WEBHOOK_URL;
  });

  async function loadHook() {
    return await import("@/instrumentation");
  }

  const ctx = { routerKind: "App Router", routePath: "/api/tasks", routeType: "route" };
  const req = { path: "/api/tasks", method: "POST", headers: {} };

  it("relays an uncaught error to the webhook and never throws", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hook = await loadHook();
    await expect(
      hook.onRequestError(new Error("boom"), req, ctx),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("https://discord.test/hook");
    const body = JSON.parse(init.body);
    expect(body.content).toContain("/api/tasks");
    expect(body.content).toContain("Error");
  });

  it("does not ship the error message to the webhook", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hook = await loadHook();
    await hook.onRequestError(new Error("SECRET task content in message"), req, ctx);

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(init.body).not.toContain("SECRET");
  });

  it("dedups identical (error, route) pairs within the window", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hook = await loadHook();
    for (let i = 0; i < 5; i++) {
      await hook.onRequestError(new Error("same"), req, ctx);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not dedup distinct routes", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hook = await loadHook();
    await hook.onRequestError(new Error("x"), req, ctx);
    await hook.onRequestError(new Error("x"), { ...req, path: "/api/offers" }, { ...ctx, routePath: "/api/offers" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("relay failure is contained — a webhook error never propagates", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hook = await loadHook();
    await expect(
      hook.onRequestError(new Error("boom"), req, ctx),
    ).resolves.toBeUndefined();
  });

  it("is log-only when MONITOR_WEBHOOK_URL is unset", async () => {
    delete process.env.MONITOR_WEBHOOK_URL;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hook = await loadHook();
    await hook.onRequestError(new Error("boom"), req, ctx);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
