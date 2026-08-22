import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";
import {
  parseAndHashEvidenceBundle,
  hashEvidenceBundlePreimage,
  EvidenceBundleValidationError,
  MAX_EVIDENCE_BYTES,
} from "@/lib/checker/evidence-hash";

const VALID_BUNDLE = JSON.stringify({
  taskId: "abc123",
  artifacts: [{ uri: "https://example.com/1.jpg" }],
});

describe("evidence bundle hashing (CC-092)", () => {
  it("hashes the verbatim bytes to a pinned vector", () => {
    // The worker computes this before calling submitWork; the verdict service
    // recomputes it from a caller-supplied bundle and compares against the
    // on-chain evidenceHash. A change to the preimage is a change to what the
    // chain already committed to, so this must fail here, not there.
    expect(hashEvidenceBundlePreimage(VALID_BUNDLE)).toBe(
      "0xdf9446c1f909ebc246066dacb95a121af5ff64bbe45a1670ee8adea98d01de0a",
    );
    expect(hashEvidenceBundlePreimage(VALID_BUNDLE)).toBe(keccak256(toHex(VALID_BUNDLE)));
    expect(parseAndHashEvidenceBundle(VALID_BUNDLE).hash).toBe(
      hashEvidenceBundlePreimage(VALID_BUNDLE),
    );
  });

  it("returns the caller's exact string as the preimage, unmodified", () => {
    const spaced = '{ "taskId" : "abc" , "artifacts" : [ { "uri" : "x" } ] }';
    const parsed = parseAndHashEvidenceBundle(spaced);

    expect(parsed.preimage).toBe(spaced);
    expect(parsed.hash).toBe(keccak256(toHex(spaced)));
  });

  it("does NOT canonicalise — key order changes the hash though the bundle is the same", () => {
    const a = '{"taskId":"abc","artifacts":[{"uri":"x"}]}';
    const b = '{"artifacts":[{"uri":"x"}],"taskId":"abc"}';

    expect(parseAndHashEvidenceBundle(a).hash).not.toBe(parseAndHashEvidenceBundle(b).hash);
    expect(parseAndHashEvidenceBundle(a).bundle).toEqual(parseAndHashEvidenceBundle(b).bundle);
  });

  it("parses every field the checker (CC-083) reads", () => {
    const raw = JSON.stringify({
      taskId: "abc",
      artifacts: [
        {
          uri: "https://example.com/1.jpg",
          mimeType: "image/jpeg",
          exif: {
            lat: -37.8136,
            lon: 144.9631,
            dateTimeOriginal: "2026:08:20 04:12:09",
            cameraMake: "Apple",
            cameraModel: "iPhone 15",
          },
          c2paAiGenerated: false,
          phash: "abcd1234",
        },
      ],
      submittedAt: "2026-08-20T04:15:00Z",
    });

    const parsed = parseAndHashEvidenceBundle(raw);
    expect(parsed.bundle.artifacts[0].exif?.cameraModel).toBe("iPhone 15");
    expect(parsed.bundle.submittedAt).toBe("2026-08-20T04:15:00Z");
  });

  it("rejects malformed JSON", () => {
    expect(() => parseAndHashEvidenceBundle("{not json")).toThrow(
      EvidenceBundleValidationError,
    );
  });

  it("rejects a bundle with no artifacts", () => {
    expect(() =>
      parseAndHashEvidenceBundle(JSON.stringify({ taskId: "abc", artifacts: [] })),
    ).toThrow(/artifacts/);
  });

  it("rejects unknown fields instead of ignoring them", () => {
    expect(() =>
      parseAndHashEvidenceBundle(
        JSON.stringify({
          taskId: "abc",
          artifacts: [{ uri: "x", unknownField: true }],
        }),
      ),
    ).toThrow(EvidenceBundleValidationError);
  });

  it("rejects a preimage over the size cap before parsing it", () => {
    const huge = "x".repeat(MAX_EVIDENCE_BYTES + 1);
    expect(() => parseAndHashEvidenceBundle(huge)).toThrow(/exceeds/);
  });
});
