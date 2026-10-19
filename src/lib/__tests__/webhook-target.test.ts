import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type dns from "node:dns";

// CC-108. node:https is replaced so no socket is ever opened (CC-060): each test
// decides what the "server" answers, and asserts what the client was told to do.
const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: mockRequest }, request: mockRequest }));

import {
  isBlockedAddress,
  checkWebhookUrl,
  resolveWebhookTarget,
  createGuardedLookup,
  postJsonToWebhook,
  BLOCKED_TARGET_CODE,
} from "@/lib/notifications/webhook-target";

/** A fake ClientRequest that answers with `status`, or fails with `error`. */
function fakeRequest(answer: { status?: number; error?: NodeJS.ErrnoException; hang?: boolean }) {
  const req = Object.assign(new EventEmitter(), {
    end: vi.fn(() => {
      if (answer.hang) return;
      setImmediate(() => {
        if (answer.error) req.emit("error", answer.error);
        else req.emit("response", Object.assign(new EventEmitter(), { statusCode: answer.status, resume: vi.fn() }));
      });
    }),
    destroy: vi.fn(),
  });
  return req;
}

const lookupReturning = (addresses: string[]) =>
  ((_host: string, _opts: unknown, cb: (e: Error | null, a: dns.LookupAddress[]) => void) =>
    cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))) as unknown as typeof dns.lookup;

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12:3456::1",
    "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "not-an-ip",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe("checkWebhookUrl", () => {
  it.each([
    ["http://hooks.example.com/", "not_https"],
    ["https://hooks.example.com:8443/", "port_not_allowed"],
    ["https://localhost/", "internal_hostname"],
    ["https://svc.internal/", "internal_hostname"],
    ["https://printer.local/", "internal_hostname"],
    ["https://10.0.0.5/", "private_address"],
    ["https://[::1]/", "private_address"],
    ["https://[::ffff:169.254.169.254]/", "private_address"],
  ])("rejects %s as %s", (url, reason) => {
    expect(checkWebhookUrl(url)).toEqual({ ok: false, reason });
  });

  it("accepts a public https URL on the default or explicit 443 port", () => {
    expect(checkWebhookUrl("https://hooks.example.com/x")).toEqual({ ok: true });
    expect(checkWebhookUrl("https://hooks.example.com:443/x")).toEqual({ ok: true });
  });
});

describe("resolveWebhookTarget", () => {
  it("rejects a hostname with any private record among public ones", async () => {
    const result = await resolveWebhookTarget("https://hooks.example.com/", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    expect(result).toEqual({ ok: false, reason: "private_address" });
  });

  it("rejects a hostname that does not resolve", async () => {
    const result = await resolveWebhookTarget("https://nope.example.com/", async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });
    expect(result).toEqual({ ok: false, reason: "unresolvable" });
  });

  it("accepts a hostname that resolves public only", async () => {
    const result = await resolveWebhookTarget("https://hooks.example.com/", async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    expect(result).toEqual({ ok: true });
  });
});

describe("createGuardedLookup — the connect-time check", () => {
  it("fails the connection when the name resolves private (DNS rebinding)", async () => {
    const guarded = createGuardedLookup(lookupReturning(["127.0.0.1"]));
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      guarded("rebind.example.com", {}, (e) => resolve(e)),
    );
    expect(err?.code).toBe(BLOCKED_TARGET_CODE);
  });

  it("returns the single-address form when Node did not ask for all", async () => {
    const guarded = createGuardedLookup(lookupReturning(["93.184.216.34"]));
    const [err, address, family] = await new Promise<unknown[]>((resolve) =>
      guarded("hooks.example.com", {}, (...args: unknown[]) => resolve(args)),
    );
    expect(err).toBeNull();
    expect(address).toBe("93.184.216.34");
    expect(family).toBe(4);
  });

  it("returns the list form when Node asked for all", async () => {
    const guarded = createGuardedLookup(lookupReturning(["93.184.216.34", "2606:4700::1111"]));
    const [err, list] = await new Promise<unknown[]>((resolve) =>
      guarded("hooks.example.com", { all: true }, (...args: unknown[]) => resolve(args)),
    );
    expect(err).toBeNull();
    expect(list).toHaveLength(2);
  });
});

describe("postJsonToWebhook — delivery", () => {
  beforeEach(() => mockRequest.mockReset());

  it("refuses a stored private-literal URL without opening a request", async () => {
    const result = await postJsonToWebhook("https://169.254.169.254/latest", "{}", {}, 1000);
    expect(result).toEqual({ ok: false, transient: false, error: "blocked_target" });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("refuses a non-443 port at delivery, for rows written before CC-108", async () => {
    const result = await postJsonToWebhook("https://hooks.example.com:6379/", "{}", {}, 1000);
    expect(result.error).toBe("blocked_target");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("connects through the guarded lookup", async () => {
    mockRequest.mockReturnValue(fakeRequest({ status: 204 }));
    const result = await postJsonToWebhook("https://hooks.example.com/x", "{}", { "x-a": "1" }, 1000);
    expect(result).toEqual({ ok: true, status: 204, transient: false });
    const opts = mockRequest.mock.calls[0][1];
    expect(typeof opts.lookup).toBe("function");
    expect(opts.method).toBe("POST");
    expect(opts.headers["x-a"]).toBe("1");
  });

  it("does not follow a redirect — a 302 to an internal host is a failed delivery", async () => {
    mockRequest.mockReturnValue(fakeRequest({ status: 302 }));
    const result = await postJsonToWebhook("https://hooks.example.com/x", "{}", {}, 1000);
    expect(result).toEqual({ ok: false, status: 302, transient: false, error: "http_302" });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("classifies a guarded-lookup refusal as permanent, not a network fault", async () => {
    mockRequest.mockReturnValue(
      fakeRequest({ error: Object.assign(new Error("blocked"), { code: BLOCKED_TARGET_CODE }) }),
    );
    const result = await postJsonToWebhook("https://rebind.example.com/x", "{}", {}, 1000);
    expect(result).toEqual({ ok: false, transient: false, error: "blocked_target" });
  });

  it("classifies an ordinary socket error as transient", async () => {
    mockRequest.mockReturnValue(
      fakeRequest({ error: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
    );
    const result = await postJsonToWebhook("https://hooks.example.com/x", "{}", {}, 1000);
    expect(result).toEqual({ ok: false, transient: true, error: "network_error" });
  });

  it("times out the whole exchange", async () => {
    const req = fakeRequest({ hang: true });
    mockRequest.mockReturnValue(req);
    const result = await postJsonToWebhook("https://hooks.example.com/x", "{}", {}, 5);
    expect(result).toEqual({ ok: false, transient: true, error: "timeout" });
    expect(req.destroy).toHaveBeenCalled();
  });
});
