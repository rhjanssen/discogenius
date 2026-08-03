/**
 * Acquisition coverage units: which MusicBrainz recordings count as the same
 * "ownable song" for monitoring / set-cover — without rewriting catalog MBIDs.
 *
 * Edges (union-find):
 *   1. Same normalized title + near-equal duration (clean/explicit twins, MB
 *      length drift). ≤2s or ≤2% length delta.
 *   2. Shared ISRC (when either catalog or match evidence carries one).
 *   3. Shared provider track — the same (provider, provider_track_item) has
 *      accepted matches to two recordings (Japan studio MBID vs deluxe MBID
 *      both linked to the same TIDAL track).
 *
 * Matching itself may use UPC/ISRC/title/duration; this layer only *consumes*
 * accepted match edges and soft pairing for coverage decisions.
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

export function normalizeIsrcCode(value: string | null | undefined): string {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Map each recording id to a stable coverage-unit id (the minimum recording id
 * in its equivalence class). Unpaired recordings map to themselves.
 *
 * @param sharedProviderTracks optional groups of recordings that match the same
 *   provider track item — the bidirectional match evidence that collapses
 *   orphan region MBIDs onto the deluxe/standard product.
 */
export function buildRecordingCoverageUnitMap(
  tracks: readonly TrackRecordingEvidence[],
  sharedProviderTracks: readonly SharedProviderTrackLink[] = [],
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

  const ensure = (recordingId: number): void => {
    if (!parent.has(recordingId)) parent.set(recordingId, recordingId);
  };

  // 1. Title + near-equal duration.
  const byTitle = new Map<string, Array<{ recordingId: number; lengthMs: number }>>();
  for (const track of tracks) {
    const recordingId = Number(track.recordingId);
    if (!Number.isFinite(recordingId) || recordingId <= 0) continue;
    ensure(recordingId);

    const title = normalizeCoverageTitle(track.title);
    if (!title) continue;
    const lengthMs = track.lengthMs == null || !Number.isFinite(track.lengthMs)
      ? null
      : Math.round(Number(track.lengthMs));
    // Duration is required for title pairing — title-only is too loose.
    if (lengthMs == null || lengthMs <= 0) continue;

    const group = byTitle.get(title) || [];
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

  // 2. Shared ISRC — same code on two recordings ⇒ same unit.
  const byIsrc = new Map<string, number>();
  for (const track of tracks) {
    const recordingId = Number(track.recordingId);
    if (!Number.isFinite(recordingId) || recordingId <= 0) continue;
    ensure(recordingId);
    for (const raw of track.isrcs || []) {
      const isrc = normalizeIsrcCode(raw);
      if (!isrc) continue;
      const existing = byIsrc.get(isrc);
      if (existing != null) union(existing, recordingId);
      else byIsrc.set(isrc, recordingId);
    }
  }

  // 3. Shared provider track item — accepted matches on both sides.
  for (const link of sharedProviderTracks) {
    const ids = [...new Set(
      (link.recordingIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0),
    )];
    if (ids.length < 2) continue;
    for (const id of ids) ensure(id);
    const root = ids[0];
    for (let i = 1; i < ids.length; i += 1) union(root, ids[i]);
  }

  const unitByRecording = new Map<number, number>();
  for (const recordingId of parent.keys()) {
    unitByRecording.set(recordingId, find(recordingId));
  }
  return unitByRecording;
}

/** @deprecated Prefer {@link buildRecordingCoverageUnitMap} — alias for call sites. */
export const buildAcquisitionUnitMap = buildRecordingCoverageUnitMap;

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

/** Minimal surface used by loadAcquisitionUnitMapFromDb (better-sqlite3 Database). */
type SqliteLike = {
  // better-sqlite3 Statement generics are too strict for a structural type —
  // accept any prepared statement that can run .all().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prepare: (sql: string) => { all: (...args: any[]) => any[] };
};

/**
 * Load acquisition-unit evidence from the active DB: all tracks, ISRCs on
 * recordings + provider track items, and groups of recordings that share an
 * accepted provider track match.
 */
export function loadAcquisitionUnitMapFromDb(db: SqliteLike): Map<number, number> {
  const trackRows = db.prepare(`
    SELECT
      track.recording_id AS recordingId,
      recording.title AS title,
      recording.length_ms AS lengthMs,
      recording.isrcs AS recordingIsrcs
    FROM Tracks track
    JOIN Recordings recording ON recording.id = track.recording_id
    WHERE track.recording_id IS NOT NULL
  `).all() as Array<{
    recordingId: number;
    title: string;
    lengthMs: number | null;
    recordingIsrcs: string | null;
  }>;

  // Provider ISRCs attached via accepted track matches (often richer than catalog).
  const providerIsrcRows = db.prepare(`
    SELECT
      track_match.recording_id AS recordingId,
      provider_item.isrc AS isrc
    FROM ProviderTrackMatches track_match
    JOIN ProviderItems provider_item
      ON provider_item.id = track_match.provider_track_item_id
    WHERE track_match.match_state = 'accepted'
      AND track_match.recording_id IS NOT NULL
      AND provider_item.isrc IS NOT NULL
      AND TRIM(provider_item.isrc) != ''
  `).all() as Array<{ recordingId: number; isrc: string }>;

  const isrcsByRecording = new Map<number, Set<string>>();
  const addIsrc = (recordingId: number, isrc: string) => {
    const normalized = normalizeIsrcCode(isrc);
    if (!normalized || recordingId <= 0) return;
    const set = isrcsByRecording.get(recordingId) || new Set<string>();
    set.add(normalized);
    isrcsByRecording.set(recordingId, set);
  };
  for (const row of trackRows) {
    for (const isrc of parseRecordingIsrcs(row.recordingIsrcs)) {
      addIsrc(row.recordingId, isrc);
    }
  }
  for (const row of providerIsrcRows) {
    addIsrc(row.recordingId, row.isrc);
  }

  const evidence: TrackRecordingEvidence[] = trackRows.map((row) => ({
    recordingId: row.recordingId,
    title: row.title,
    lengthMs: row.lengthMs,
    isrcs: [...(isrcsByRecording.get(row.recordingId) || [])],
  }));

  // Same provider track item accepted against multiple recordings.
  const sharedRows = db.prepare(`
    SELECT
      provider_item.provider AS provider,
      provider_item.id AS providerTrackItemId,
      track_match.recording_id AS recordingId
    FROM ProviderTrackMatches track_match
    JOIN ProviderItems provider_item
      ON provider_item.id = track_match.provider_track_item_id
    WHERE track_match.match_state = 'accepted'
      AND track_match.recording_id IS NOT NULL
  `).all() as Array<{
    provider: string;
    providerTrackItemId: number;
    recordingId: number;
  }>;

  const byProviderTrack = new Map<string, Set<number>>();
  for (const row of sharedRows) {
    const key = `${row.provider}\0${row.providerTrackItemId}`;
    const set = byProviderTrack.get(key) || new Set<number>();
    set.add(row.recordingId);
    byProviderTrack.set(key, set);
  }
  const sharedProviderTracks: SharedProviderTrackLink[] = [];
  for (const recordingIds of byProviderTrack.values()) {
    if (recordingIds.size >= 2) {
      sharedProviderTracks.push({ recordingIds: [...recordingIds] });
    }
  }

  return buildRecordingCoverageUnitMap(evidence, sharedProviderTracks);
}
