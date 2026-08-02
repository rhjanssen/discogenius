/**
 * Collapse clean/explicit MusicBrainz recording counterparts into one coverage
 * unit so discography set-cover does not monitor both editions of the same
 * tracklist.
 *
 * Pairing is heuristic: same normalized title + near-equal duration. Exact ms
 * matches fail in practice (clean/explicit twins often differ by a few hundred
 * ms in MusicBrainz). We allow ≤2s or ≤2% length delta. Title-only matches
 * without a duration are still rejected — too loose across a discography.
 */

export type TrackRecordingEvidence = {
  recordingId: number;
  title: string;
  lengthMs: number | null;
};

/** Edition label signal used only for ranking, not for pairing. */
export function editionExplicitLabelScore(
  title: string | null | undefined,
  disambiguation: string | null | undefined,
): number {
  const text = `${title || ""} ${disambiguation || ""}`.toLowerCase();
  if (/\bexplicit\b/.test(text)) return 1;
  if (/\bclean\b|\bcensored\b/.test(text)) return -1;
  return 0;
}

/**
 * Rank for compare-sort: higher is better under the user's preference.
 * Unknown editions sit in the middle so they don't beat a matching preference.
 */
export function editionExplicitPreferenceRank(
  score: number,
  preferExplicit: boolean,
): number {
  if (score === 0) return 1;
  const wantsPositive = preferExplicit ? 1 : -1;
  return score === wantsPositive ? 2 : 0;
}

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

/**
 * Map each recording id to a stable coverage-unit id (the minimum recording id
 * in its equivalence class). Unpaired recordings map to themselves.
 */
export function buildRecordingCoverageUnitMap(
  tracks: readonly TrackRecordingEvidence[],
): Map<number, number> {
  const parent = new Map<number, number>();

  const find = (id: number): number => {
    let root = parent.get(id) ?? id;
    while ((parent.get(root) ?? root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression.
    let current = id;
    while ((parent.get(current) ?? current) !== root) {
      const next = parent.get(current) ?? current;
      parent.set(current, root);
      current = next;
    }
    parent.set(id, root);
    return root;
  };

  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Prefer lower id as root for stable unit ids.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  // Bucket by normalized title, then union near-equal durations within a bucket.
  const byTitle = new Map<string, Array<{ recordingId: number; lengthMs: number }>>();
  for (const track of tracks) {
    const recordingId = Number(track.recordingId);
    if (!Number.isFinite(recordingId) || recordingId <= 0) continue;
    if (!parent.has(recordingId)) parent.set(recordingId, recordingId);

    const title = normalizeCoverageTitle(track.title);
    if (!title) continue;
    const lengthMs = track.lengthMs == null || !Number.isFinite(track.lengthMs)
      ? null
      : Math.round(Number(track.lengthMs));
    // Duration is required for pairing — title-only matches are too loose.
    if (lengthMs == null || lengthMs <= 0) continue;

    const group = byTitle.get(title) || [];
    // Pair against every already-seen same-title recording with a close length.
    for (const prior of group) {
      if (coverageLengthsMatch(prior.lengthMs, lengthMs)) {
        union(prior.recordingId, recordingId);
      }
    }
    if (!group.some((entry) => entry.recordingId === recordingId)) {
      group.push({ recordingId, lengthMs });
    }
    byTitle.set(title, group);
  }

  const unitByRecording = new Map<number, number>();
  for (const recordingId of parent.keys()) {
    unitByRecording.set(recordingId, find(recordingId));
  }
  return unitByRecording;
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
