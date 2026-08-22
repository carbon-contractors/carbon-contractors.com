import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, maskWallet, maskEmail, maskMeta } from "@/lib/logging";

describe("logging sanitization (CC-009 / ADR-0002 D9)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe("maskWallet", () => {
    it("masks 42-char hex wallet address", () => {
      expect(maskWallet("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234...5678");
    });

    it("returns short strings unchanged", () => {
      expect(maskWallet("0x123")).toBe("0x123");
    });
  });

  describe("maskEmail", () => {
    it("masks typical email addresses", () => {
      expect(maskEmail("alice@example.com")).toBe("a***e@example.com");
      expect(maskEmail("bob@gmail.com")).toBe("b***b@gmail.com");
      expect(maskEmail("contact.user@sub.domain.org")).toBe("c***r@sub.domain.org");
    });

    it("handles short usernames gracefully", () => {
      expect(maskEmail("a@b.com")).toBe("a***@b.com");
      expect(maskEmail("ab@b.com")).toBe("a***b@b.com");
    });

    it("returns non-email string unchanged", () => {
      expect(maskEmail("not-an-email")).toBe("not-an-email");
    });
  });

  describe("maskMeta", () => {
    it("recursively masks wallets and emails in metadata", () => {
      const input = {
        wallet: "0x1234567890abcdef1234567890abcdef12345678",
        email: "contractor@example.com",
        count: 5,
        nested: {
          user_email: "nested.user@service.io",
          payer_wallet: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        },
      };

      const result = maskMeta(input);
      expect(result).toEqual({
        wallet: "0x1234...5678",
        email: "c***r@example.com",
        count: 5,
        nested: {
          user_email: "n***r@service.io",
          payer_wallet: "0xabcd...abcd",
        },
      });
    });

    it("masks emails and wallets in arrays", () => {
      const input = {
        wallets: ["0x1234567890abcdef1234567890abcdef12345678"],
        emails: ["test@example.com"],
        objects: [{ email: "user@domain.com" }],
      };

      const result = maskMeta(input);
      expect(result).toEqual({
        wallets: ["0x1234...5678"],
        emails: ["t***t@example.com"],
        objects: [{ email: "u***r@domain.com" }],
      });
    });

    it("redacts task payload keys to prevent retention leaks", () => {
      const input = {
        payment_request_id: "pr_123",
        task_description: "Fix the plumbing at 123 Main St",
        acceptance_spec: { location: { lat: -31.95, lng: 115.86 } },
        evidence_bundle: { photos: ["https://bucket/img.jpg"] },
        spec_json: '{"check":"gps"}',
      };

      const result = maskMeta(input);
      expect(result).toEqual({
        payment_request_id: "pr_123",
        task_description: "[REDACTED_PAYLOAD]",
        acceptance_spec: "[REDACTED_PAYLOAD]",
        evidence_bundle: "[REDACTED_PAYLOAD]",
        spec_json: "[REDACTED_PAYLOAD]",
      });
    });
  });

  describe("log() output", () => {
    it("formats Wazuh-compatible single-line JSON with ts and masked fields", () => {
      log("info", "test_event", {
        wallet: "0x1234567890abcdef1234567890abcdef12345678",
        email: "worker@example.com",
        task_description: "Secret project",
      });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(String(consoleSpy.mock.calls[0][0]));
      expect(output.level).toBe("info");
      expect(output.event).toBe("test_event");
      expect(typeof output.ts).toBe("number");
      expect(output.wallet).toBe("0x1234...5678");
      expect(output.email).toBe("w***r@example.com");
      expect(output.task_description).toBe("[REDACTED_PAYLOAD]");
    });
  });
});
