/**
 * draft.ts — build an evidence bundle from the dashboard's structured form
 * (NOR-327, CC-101). Pure and client-safe: no React, no fetch.
 *
 * The schema field is `artifacts` — the checker's spelling; every piece of
 * worker-facing copy says "artefact". The form keeps every field as a string
 * and this builder does the typing, so a worker never meets a JSON error that
 * is really a typing error: each problem surfaces as a plain sentence naming
 * the artefact and the field.
 *
 * Empty optional fields are omitted entirely. The schema is `.strict()`, so an
 * empty string would arrive as a value that means nothing and be rejected —
 * omission is the honest shape for "not provided".
 */

import { MAX_EVIDENCE_BYTES } from "@/lib/checker/evidence-hash";

export interface EvidenceArtifactDraft {
  uri: string;
  mimeType: string;
  lat: string;
  lon: string;
  dateTimeOriginal: string;
  cameraMake: string;
  cameraModel: string;
  c2paAiGenerated: boolean;
  phash: string;
}

export function emptyArtifactDraft(): EvidenceArtifactDraft {
  return {
    uri: "",
    mimeType: "",
    lat: "",
    lon: "",
    dateTimeOriginal: "",
    cameraMake: "",
    cameraModel: "",
    c2paAiGenerated: false,
    phash: "",
  };
}

export type DraftBuild =
  | { ok: true; json: string }
  | { ok: false; error: string };

export function buildEvidenceBundleJson(
  taskId: string,
  drafts: EvidenceArtifactDraft[],
): DraftBuild {
  const artifacts: Record<string, unknown>[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const n = i + 1;

    const uri = d.uri.trim();
    if (!uri) {
      return { ok: false, error: `Artefact ${n}: a link (URI) is required.` };
    }
    if (uri.length > 2000) {
      return {
        ok: false,
        error: `Artefact ${n}: the link is longer than 2000 characters.`,
      };
    }
    const artifact: Record<string, unknown> = { uri };

    const mimeType = d.mimeType.trim();
    if (mimeType) {
      if (mimeType.length > 200) {
        return {
          ok: false,
          error: `Artefact ${n}: the file type is longer than 200 characters.`,
        };
      }
      artifact.mimeType = mimeType;
    }

    const exif: Record<string, unknown> = {};
    const lat = d.lat.trim();
    const lon = d.lon.trim();
    if (lat || lon) {
      if (!lat || !lon) {
        return {
          ok: false,
          error: `Artefact ${n}: GPS needs both latitude and longitude.`,
        };
      }
      const latN = Number(lat);
      const lonN = Number(lon);
      if (!Number.isFinite(latN) || latN < -90 || latN > 90) {
        return {
          ok: false,
          error: `Artefact ${n}: latitude must be a number between -90 and 90.`,
        };
      }
      if (!Number.isFinite(lonN) || lonN < -180 || lonN > 180) {
        return {
          ok: false,
          error: `Artefact ${n}: longitude must be a number between -180 and 180.`,
        };
      }
      exif.lat = latN;
      exif.lon = lonN;
    }
    const dateTimeOriginal = d.dateTimeOriginal.trim();
    if (dateTimeOriginal) {
      if (dateTimeOriginal.length > 64) {
        return {
          ok: false,
          error: `Artefact ${n}: the capture time is longer than 64 characters.`,
        };
      }
      exif.dateTimeOriginal = dateTimeOriginal;
    }
    const cameraMake = d.cameraMake.trim();
    if (cameraMake) {
      if (cameraMake.length > 200) {
        return {
          ok: false,
          error: `Artefact ${n}: the camera make is longer than 200 characters.`,
        };
      }
      exif.cameraMake = cameraMake;
    }
    const cameraModel = d.cameraModel.trim();
    if (cameraModel) {
      if (cameraModel.length > 200) {
        return {
          ok: false,
          error: `Artefact ${n}: the camera model is longer than 200 characters.`,
        };
      }
      exif.cameraModel = cameraModel;
    }
    if (Object.keys(exif).length > 0) {
      artifact.exif = exif;
    }

    if (d.c2paAiGenerated) {
      artifact.c2paAiGenerated = true;
    }

    const phash = d.phash.trim();
    if (phash) {
      if (phash.length > 256) {
        return {
          ok: false,
          error: `Artefact ${n}: the visual fingerprint is longer than 256 characters.`,
        };
      }
      artifact.phash = phash;
    }

    artifacts.push(artifact);
  }

  if (artifacts.length === 0) {
    return { ok: false, error: "Add at least one artefact." };
  }
  if (artifacts.length > 200) {
    return { ok: false, error: "A bundle holds at most 200 artefacts." };
  }

  const json = JSON.stringify({ taskId, artifacts });
  if (json.length > MAX_EVIDENCE_BYTES) {
    return {
      ok: false,
      error: `The bundle is larger than ${MAX_EVIDENCE_BYTES} characters — remove or shorten artefacts.`,
    };
  }
  return { ok: true, json };
}
