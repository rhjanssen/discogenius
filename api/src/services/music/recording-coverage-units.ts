/**
 * Shared vocabulary for coverage decisions: title/ISRC normalisation and
 * rewriting recording ids through a resolved unit map.
 *
 * Clean/explicit labelling is a rendition question, not a coverage one — it
 * lives in `rendition-policy.ts`.
 *
 * Deciding *which* recordings share a coverage unit lives in
 * `coverage-identity.ts`; the union-find that used to live here merged whole
 * equivalence classes across unrelated songs on one ambiguous provider match.
 */

export type TrackRecordingEvidence = {
  recordingId: number;
  title: string;
  lengthMs: number | null;
  /** Normalized ISRC codes (optional). */
  isrcs?: readonly string[];
};

/**
 * Recordings that accepted-match the same provider track item.
 * Callers group by (provider, provider_track_item_id).
 */
export type SharedProviderTrackLink = {
  recordingIds: readonly number[];
};

export function normalizeCoverageTitle(title: string): string {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[''`´]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** True when two durations are close enough to treat as the same performance. */
export function coverageLengthsMatch(
  leftMs: number | null | undefined,
  rightMs: number | null | undefined,
): boolean {
  if (leftMs == null || rightMs == null) return false;
  const left = Math.round(Number(leftMs));
  const right = Math.round(Number(rightMs));
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) {
    return false;
  }
  const diff = Math.abs(left - right);
  if (diff <= 2000) return true;
  return diff / Math.max(left, right) <= 0.02;
}

export function normalizeIsrcCode(value: string | null | undefined): string {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Rewrite a set of recording ids through the coverage-unit map. */
export function mapRecordingsToCoverageUnits(
  recordingIds: ReadonlySet<number> | readonly number[],
  unitByRecording: ReadonlyMap<number, number>,
): Set<number> {
  const result = new Set<number>();
  for (const recordingId of recordingIds) {
    result.add(unitByRecording.get(recordingId) ?? recordingId);
  }
  return result;
}

/** Parse Recordings.isrcs JSON text (or comma list) into normalized codes. */
export function parseRecordingIsrcs(raw: string | null | undefined): string[] {
  const text = String(raw || "").trim();
  if (!text || text === "[]" || text === "null") return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => normalizeIsrcCode(String(v))).filter(Boolean);
    }
  } catch {
    // fall through
  }
  return text.split(/[,\s]+/).map(normalizeIsrcCode).filter(Boolean);
}
