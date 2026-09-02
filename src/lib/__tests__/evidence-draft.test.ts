import { describe, it, expect } from "vitest";
import {
  buildEvidenceBundleJson,
  emptyArtifactDraft,
  type EvidenceArtifactDraft,
} from "@/lib/evidence/draft";
import { parseAndHashEvidenceBundle } from "@/lib/checker/evidence-hash";

/**
 * NOR-327 — the structured form's builder. The property that matters: every
 * builder success parses through the checker's own schema (the form can never
 * produce a bundle the verdict route would reject for shape), and every
 * failure is a plain sentence naming the artefact and field.
 */

const TASK = "pr_123";

function draft(overrides: Partial<EvidenceArtifactDraft> = {}): EvidenceArtifactDraft {
  return { ...emptyArtifactDraft(), uri: "https://example.test/a.jpg", ...overrides };
}

describe("buildEvidenceBundleJson (NOR-327)", () => {
  it("produces a bundle that passes the checker's own schema", () => {
    const built = buildEvidenceBundleJson(TASK, [draft()]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = parseAndHashEvidenceBundle(built.json); // throws on any shape problem
    expect(parsed.bundle.taskId).toBe(TASK);
    expect(parsed.bundle.artifacts[0].uri).toBe("https://example.test/a.jpg");
  });

  it("carries taskId, optional fields when filled, and omits empty ones", () => {
    const built = buildEvidenceBundleJson(TASK, [
      draft({
        mimeType: "image/jpeg",
        lat: " -37.8136 ",
        lon: "144.9631",
        dateTimeOriginal: "2026-09-02T14:33:00Z",
        cameraMake: "Canon",
        cameraModel: "EOS R5",
        phash: "ff00ff00ff00ff00",
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const bundle = JSON.parse(built.json);
    const a = bundle.artifacts[0];
    expect(a.mimeType).toBe("image/jpeg");
    expect(a.exif).toEqual({
      lat: -37.8136,
      lon: 144.9631,
      dateTimeOriginal: "2026-09-02T14:33:00Z",
      cameraMake: "Canon",
      cameraModel: "EOS R5",
    });
    expect(a.c2paAiGenerated).toBeUndefined();
    expect(a.phash).toBe("ff00ff00ff00ff00");

    const emptyBuilt = buildEvidenceBundleJson(TASK, [draft()]);
    const emptyArtifact = JSON.parse((emptyBuilt as { ok: true; json: string }).json).artifacts[0];
    expect(emptyArtifact.exif).toBeUndefined();
    expect(emptyArtifact.mimeType).toBeUndefined();
  });

  it("sets c2paAiGenerated only when ticked", () => {
    const built = buildEvidenceBundleJson(TASK, [draft({ c2paAiGenerated: true })]);
    const artifact = JSON.parse((built as { ok: true; json: string }).json).artifacts[0];
    expect(artifact.c2paAiGenerated).toBe(true);
  });

  it("fails with a plain sentence when a link is missing", () => {
    const built = buildEvidenceBundleJson(TASK, [draft({ uri: "   " })]);
    expect(built).toEqual({
      ok: false,
      error: "Artefact 1: a link (URI) is required.",
    });
  });

  it("rejects half-supplied GPS with a plain sentence", () => {
    const built = buildEvidenceBundleJson(TASK, [draft({ lat: "-37.8136", lon: "" })]);
    expect(built).toEqual({
      ok: false,
      error: "Artefact 1: GPS needs both latitude and longitude.",
    });
  });

  it("rejects out-of-range coordinates", () => {
    const built = buildEvidenceBundleJson(TASK, [draft({ lat: "91", lon: "0" })]);
    expect(built).toEqual({
      ok: false,
      error: "Artefact 1: latitude must be a number between -90 and 90.",
    });
  });

  it("refuses an empty bundle", () => {
    expect(buildEvidenceBundleJson(TASK, [])).toEqual({
      ok: false,
      error: "Add at least one artefact.",
    });
  });

  it("numbers artefacts the way the worker sees them", () => {
    const built = buildEvidenceBundleJson(TASK, [draft(), draft({ uri: "" })]);
    expect(built).toEqual({
      ok: false,
      error: "Artefact 2: a link (URI) is required.",
    });
  });
});
