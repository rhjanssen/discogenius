import { db } from "../../database.js";

/**
 * Provider item -> MusicBrainz match graph (the `ProviderItemMatches` table).
 *
 * ProviderItems stores provider-native offer facts. ProviderItemMatches stores
 * only the edge from a provider item to explicit MusicBrainz identifiers.
 */

export interface ProviderReleaseMatchInput {
  provider: string;
  /** Provider album id (the match source). */
  providerId: string;
  /** Owning provider album id; for a release match this equals providerId. */
  providerAlbumId?: string | null;
  /** Target MusicBrainz release MBID. */
  releaseMbid: string;
  status?: string | null;
  confidence?: number | null;
  method?: string | null;
  /** Pre-serialized JSON evidence. */
  evidence?: string | null;
}

export interface ReleaseAvailabilityProvider {
  provider: string;
  providerAlbumId: string | null;
  providerAlbumIds?: string[];
  quality: string | null;
  librarySlot: string | null;
  status: string | null;
  confidence: number | null;
  matchKind?: "direct" | "composite";
  coverageSummary?: string | null;
}

export interface ReleaseAvailability {
  releaseMbid: string;
  title: string | null;
  disambiguation: string | null;
  status: string | null;
  date: string | null;
  country: string | null;
  format: string | null;
  mediumCount: number | null;
  trackCount: number | null;
  duration: number | null;
  availability: ReleaseAvailabilityProvider[];
}

export interface ReleaseGroupAvailability {
  releaseGroupMbid: string;
  /** slot name -> selected release MBID (from ReleaseGroupSlots). */
  selectedReleaseBySlot: Record<string, string | null>;
  releases: ReleaseAvailability[];
}

const COMPOSITE_PROVIDER_ID_SEPARATOR = ";";

function splitProviderAlbumIds(value: unknown): string[] {
  return String(value || "")
    .split(/[;+]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function joinProviderAlbumIds(values: readonly string[]): string {
  return values.join(COMPOSITE_PROVIDER_ID_SEPARATOR);
}

function sameProviderAlbumSet(left: unknown, right: unknown): boolean {
  const leftIds = splitProviderAlbumIds(left);
  const rightIds = splitProviderAlbumIds(right);
  return leftIds.length > 0
    && leftIds.length === rightIds.length
    && leftIds.every((id, index) => id === rightIds[index]);
}

/** Additively upsert a provider-album -> MB-release match candidate. */
export function upsertProviderReleaseMatch(input: ProviderReleaseMatchInput): void {
  const providerItemId = String(input.providerId);
  const providerAlbumId = input.providerAlbumId != null ? String(input.providerAlbumId) : providerItemId;
  const updated = db.prepare(`
    UPDATE ProviderItemMatches
    SET
      provider_album_id = ?,
      status = ?,
      confidence = ?,
      method = ?,
      evidence = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE provider = ?
      AND provider_item_type = 'album'
      AND provider_item_id = ?
      AND musicbrainz_artist_mbid IS NULL
      AND musicbrainz_release_mbid = ?
      AND musicbrainz_track_mbid IS NULL
      AND musicbrainz_recording_mbid IS NULL
  `).run(
    providerAlbumId,
    input.status ?? null,
    input.confidence ?? null,
    input.method ?? null,
    input.evidence ?? null,
    input.provider,
    providerItemId,
    input.releaseMbid,
  );
  if (updated.changes > 0) return;

  db.prepare(`
    INSERT INTO ProviderItemMatches (
      provider, provider_item_type, provider_item_id, provider_album_id,
      musicbrainz_release_mbid, status, confidence, method, evidence, updated_at
    ) VALUES (?, 'album', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    input.provider,
    providerItemId,
    providerAlbumId,
    input.releaseMbid,
    input.status ?? null,
    input.confidence ?? null,
    input.method ?? null,
    input.evidence ?? null,
  );
}

/** Library slots that can hold a selected release. */
export const SLOTS = ["stereo", "spatial", "video"] as const;
export type Slot = (typeof SLOTS)[number];

export interface SetSlotSelectionInput {
  releaseGroupMbid: string;
  slot: string;
  releaseMbid: string;
  provider?: string | null;
  providerAlbumId?: string | null;
}

interface ProviderReleaseOfferRow {
  provider: string;
  provider_item_id: string;
  quality: string | null;
  status: string | null;
  confidence: number | null;
  method: string | null;
  evidence: string | null;
  data: string | null;
}

interface TargetTrackRow {
  mbid: string;
  recording_mbid: string | null;
  title: string | null;
  length_ms: number | null;
  medium_position: number | null;
  position: number | null;
}

interface ProviderAlbumCoverageCandidate {
  provider: string;
  providerAlbumId: string;
  quality: string | null;
  librarySlot: string | null;
  coveredTrackMbids: Set<string>;
  evidence: Array<{
    targetTrackMbid: string;
    targetRecordingMbid: string | null;
    providerTrackTitle: string;
    providerTrackIsrc: string | null;
    durationDeltaSeconds: number | null;
  }>;
}

interface ProviderTrackLike {
  title?: unknown;
  isrc?: unknown;
  duration?: unknown;
}

interface ProviderAlbumRow {
  provider: string;
  provider_item_id: string;
  quality: string | null;
  library_slot: string | null;
  data: string | null;
}

/**
 * Switch which MB release fills a given slot for a release group (the write half
 * of the Lidarr-style release switcher). Selection-only: this does not change a
 * slot's monitored / monitored_lock state — monitoring stays orthogonal. When no
 * provider is supplied, the best (highest-confidence) matched provider offer for
 * the chosen release is used. Returns the refreshed availability.
 */
export function setSlotSelection(input: SetSlotSelectionInput): ReleaseGroupAvailability {
  if (!(SLOTS as readonly string[]).includes(input.slot)) {
    throw new Error(`unknown slot: ${input.slot}`);
  }

  const releaseInGroup = db.prepare(
    `SELECT 1 FROM AlbumReleases WHERE mbid = ? AND release_group_mbid = ?`,
  ).get(input.releaseMbid, input.releaseGroupMbid);
  if (!releaseInGroup) {
    throw new Error(`release ${input.releaseMbid} is not in release group ${input.releaseGroupMbid}`);
  }

  let provider = input.provider ?? null;
  let providerAlbumId = input.providerAlbumId ?? null;
  let offer: ProviderReleaseOfferRow | undefined;
  if (provider && providerAlbumId && splitProviderAlbumIds(providerAlbumId).length > 1) {
    const availability = getReleaseGroupAvailability(input.releaseGroupMbid);
    const release = availability.releases.find((item) => item.releaseMbid === input.releaseMbid);
    const composite = release?.availability.find((item) =>
      item.matchKind === "composite"
      && item.provider === provider
      && sameProviderAlbumSet(item.providerAlbumId, providerAlbumId)
    );
    if (!composite) {
      throw new Error(`composite provider offer ${provider}:${providerAlbumId} does not cover release ${input.releaseMbid}`);
    }
    const providerAlbumIds = composite.providerAlbumIds?.length
      ? composite.providerAlbumIds
      : splitProviderAlbumIds(providerAlbumId);
    providerAlbumId = joinProviderAlbumIds(providerAlbumIds);
    offer = {
      provider,
      provider_item_id: providerAlbumId,
      quality: composite.quality,
      status: composite.status,
      confidence: composite.confidence,
      method: "strict_composite_track_coverage",
      evidence: JSON.stringify({
        matchKind: "composite",
        providerAlbumIds,
        coverageSummary: composite.coverageSummary,
      }),
      data: null,
    };
  } else if (provider && providerAlbumId) {
    offer = db.prepare(`
      SELECT
        pm.provider,
        pm.provider_item_id,
        pi.quality,
        pm.status,
        pm.confidence,
        pm.method,
        pm.evidence,
        pi.data
      FROM ProviderItemMatches pm
      LEFT JOIN ProviderItems pi
        ON pi.provider = pm.provider
       AND pi.entity_type = 'album'
       AND CAST(pi.provider_id AS TEXT) = CAST(pm.provider_item_id AS TEXT)
      WHERE pm.provider_item_type = 'album'
        AND pm.musicbrainz_release_mbid = ?
        AND pm.provider = ?
        AND CAST(pm.provider_item_id AS TEXT) = CAST(? AS TEXT)
        AND (pm.status IS NULL OR LOWER(pm.status) <> 'rejected')
      LIMIT 1
    `).get(input.releaseMbid, provider, providerAlbumId) as ProviderReleaseOfferRow | undefined;
    if (!offer) {
      throw new Error(`provider offer ${provider}:${providerAlbumId} does not match release ${input.releaseMbid}`);
    }
  } else {
    offer = db.prepare(`
      SELECT
        pm.provider,
        pm.provider_item_id,
        pi.quality,
        pm.status,
        pm.confidence,
        pm.method,
        pm.evidence,
        pi.data
      FROM ProviderItemMatches pm
      LEFT JOIN ProviderItems pi
        ON pi.provider = pm.provider
       AND pi.entity_type = 'album'
       AND CAST(pi.provider_id AS TEXT) = CAST(pm.provider_item_id AS TEXT)
      WHERE pm.provider_item_type = 'album'
        AND pm.musicbrainz_release_mbid = ?
        AND (pm.status IS NULL OR LOWER(pm.status) <> 'rejected')
      ORDER BY (pm.confidence IS NULL), pm.confidence DESC, pm.updated_at DESC
      LIMIT 1
    `).get(input.releaseMbid) as ProviderReleaseOfferRow | undefined;
    provider = provider ?? offer?.provider ?? null;
    providerAlbumId = providerAlbumId ?? offer?.provider_item_id ?? null;
  }

  const result = db.prepare(`
    UPDATE ReleaseGroupSlots
    SET selected_release_mbid = ?,
        selected_provider = ?,
        selected_provider_id = ?,
        quality = ?,
        match_status = ?,
        match_confidence = ?,
        match_method = ?,
        match_evidence = ?,
        provider_data = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE release_group_mbid = ? AND slot = ?
  `).run(
    input.releaseMbid,
    provider,
    providerAlbumId,
    offer?.quality ?? null,
    offer?.status ?? null,
    offer?.confidence ?? null,
    offer?.method ?? null,
    offer?.evidence ?? null,
    offer?.data ?? null,
    input.releaseGroupMbid,
    input.slot,
  );

  if (result.changes === 0) {
    const artist = db.prepare(`SELECT artist_mbid FROM Albums WHERE mbid = ?`)
      .get(input.releaseGroupMbid) as { artist_mbid?: string } | undefined;
    if (!artist?.artist_mbid) {
      throw new Error(`unknown release group ${input.releaseGroupMbid}`);
    }
    db.prepare(`
      INSERT INTO ReleaseGroupSlots (
        artist_mbid, release_group_mbid, slot, monitored,
        selected_release_mbid, selected_provider, selected_provider_id,
        quality, match_status, match_confidence, match_method, match_evidence, provider_data
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artist.artist_mbid,
      input.releaseGroupMbid,
      input.slot,
      input.releaseMbid,
      provider,
      providerAlbumId,
      offer?.quality ?? null,
      offer?.status ?? null,
      offer?.confidence ?? null,
      offer?.method ?? null,
      offer?.evidence ?? null,
      offer?.data ?? null,
    );
  }

  return getReleaseGroupAvailability(input.releaseGroupMbid);
}

/**
 * Read: per-release streaming availability for a MusicBrainz release group.
 * Lists every MB release in the group, with the providers that have a matched
 * provider album for it, plus which release is currently selected per slot.
 */
export function getReleaseGroupAvailability(releaseGroupMbid: string): ReleaseGroupAvailability {
  const rows = db.prepare(`
    SELECT
      ar.mbid             AS release_mbid,
      ar.title            AS title,
      ar.disambiguation   AS disambiguation,
      ar.status           AS release_status,
      ar.date             AS date,
      ar.country          AS country,
      ar.media_count      AS media_count,
      ar.track_count      AS track_count,
      (
        SELECT GROUP_CONCAT(format_label, ', ')
        FROM (
          SELECT
            CASE
              WHEN COUNT(*) > 1 THEN CAST(COUNT(*) AS TEXT) || 'x' || COALESCE(NULLIF(TRIM(format), ''), 'Unknown')
              ELSE COALESCE(NULLIF(TRIM(format), ''), 'Unknown')
            END AS format_label,
            MIN(position) AS first_position
          FROM AlbumReleaseMedia
          WHERE release_mbid = ar.mbid
            AND position > 0
          GROUP BY COALESCE(NULLIF(TRIM(format), ''), 'Unknown')
          ORDER BY first_position
        )
      ) AS release_format,
      (
        SELECT CAST(ROUND(SUM(COALESCE(length_ms, 0)) / 1000.0) AS INTEGER)
        FROM Tracks
        WHERE release_mbid = ar.mbid
      ) AS duration_seconds,
      pm.provider         AS provider,
      pm.provider_album_id AS provider_album_id,
      pm.status           AS status,
      pm.confidence       AS confidence,
      pi.quality          AS quality,
      pi.library_slot     AS library_slot
    FROM AlbumReleases ar
    LEFT JOIN ProviderItemMatches pm
      ON pm.provider_item_type = 'album'
     AND pm.musicbrainz_release_mbid = ar.mbid
     AND EXISTS (
       SELECT 1
       FROM ProviderItems current_pi
       WHERE current_pi.provider = pm.provider
         AND current_pi.entity_type = 'album'
         AND CAST(current_pi.provider_id AS TEXT) = CAST(pm.provider_item_id AS TEXT)
         AND (
           current_pi.release_mbid IS NULL
           OR current_pi.release_mbid = pm.musicbrainz_release_mbid
         )
     )
    LEFT JOIN ProviderItems pi
      ON pi.provider = pm.provider
     AND pi.entity_type = 'album'
     AND CAST(pi.provider_id AS TEXT) = CAST(pm.provider_item_id AS TEXT)
    WHERE ar.release_group_mbid = ?
    ORDER BY
      (ar.date IS NULL),
      ar.date,
      ar.mbid,
      CASE pi.library_slot
        WHEN 'stereo' THEN 0
        WHEN 'spatial' THEN 1
        WHEN 'video' THEN 2
        ELSE 9
      END,
      CASE
        WHEN UPPER(COALESCE(pi.quality, '')) IN ('HIRES_LOSSLESS', 'HI_RES_LOSSLESS') THEN 100
        WHEN UPPER(COALESCE(pi.quality, '')) = 'LOSSLESS' THEN 90
        WHEN UPPER(COALESCE(pi.quality, '')) LIKE '%ATMOS%' THEN 80
        WHEN UPPER(COALESCE(pi.quality, '')) LIKE '%SPATIAL%' THEN 70
        WHEN UPPER(COALESCE(pi.quality, '')) = 'HIGH' THEN 20
        WHEN UPPER(COALESCE(pi.quality, '')) = 'LOW' THEN 10
        ELSE 0
      END DESC,
      pm.confidence DESC,
      pm.provider_album_id ASC
  `).all(releaseGroupMbid) as Array<{
    release_mbid: string;
    title: string | null;
    disambiguation: string | null;
    release_status: string | null;
    date: string | null;
    country: string | null;
    release_format: string | null;
    media_count: number | null;
    track_count: number | null;
    duration_seconds: number | null;
    provider: string | null;
    provider_album_id: string | null;
    status: string | null;
    confidence: number | null;
    quality: string | null;
    library_slot: string | null;
  }>;

  const byRelease = new Map<string, ReleaseAvailability>();
  for (const r of rows) {
    let rel = byRelease.get(r.release_mbid);
    if (!rel) {
      rel = {
        releaseMbid: r.release_mbid,
        title: r.title,
        disambiguation: r.disambiguation,
        status: r.release_status,
        date: r.date,
        country: r.country,
        format: r.release_format,
        mediumCount: r.media_count,
        trackCount: r.track_count,
        duration: r.duration_seconds,
        availability: [],
      };
      byRelease.set(r.release_mbid, rel);
    }
    if (r.provider) {
      rel.availability.push({
        provider: r.provider,
        providerAlbumId: r.provider_album_id,
        quality: r.quality,
        librarySlot: r.library_slot,
        status: r.status,
        confidence: r.confidence,
        matchKind: "direct",
      });
    }
  }

  appendStrictCompositeCoverage(releaseGroupMbid, byRelease);

  const slotRows = db.prepare(`
    SELECT slot, selected_release_mbid FROM ReleaseGroupSlots WHERE release_group_mbid = ?
  `).all(releaseGroupMbid) as Array<{ slot: string; selected_release_mbid: string | null }>;
  const selectedReleaseBySlot: Record<string, string | null> = {};
  for (const s of slotRows) selectedReleaseBySlot[s.slot] = s.selected_release_mbid ?? null;

  return {
    releaseGroupMbid,
    selectedReleaseBySlot,
    releases: Array.from(byRelease.values()),
  };
}

function appendStrictCompositeCoverage(releaseGroupMbid: string, byRelease: Map<string, ReleaseAvailability>): void {
  const groupArtist = db.prepare(`
    SELECT artist_mbid
    FROM AlbumReleases
    WHERE release_group_mbid = ? AND artist_mbid IS NOT NULL
    ORDER BY date IS NULL, date, mbid
    LIMIT 1
  `).get(releaseGroupMbid) as { artist_mbid: string } | undefined;
  if (!groupArtist?.artist_mbid) return;

  const providerAlbums = db.prepare(`
    SELECT provider, provider_id AS provider_item_id, quality, library_slot, data
    FROM ProviderItems
    WHERE entity_type = 'album'
      AND artist_mbid = ?
      AND data IS NOT NULL
      AND (match_status IS NULL OR LOWER(match_status) <> 'rejected')
  `).all(groupArtist.artist_mbid) as ProviderAlbumRow[];

  if (providerAlbums.length < 2) return;

  for (const release of byRelease.values()) {
    if (release.availability.some((offer) => offer.matchKind !== "composite")) {
      continue;
    }

    const targetTracks = db.prepare(`
      SELECT mbid, recording_mbid, title, length_ms, medium_position, position
      FROM Tracks
      WHERE release_mbid = ?
      ORDER BY medium_position, position, mbid
    `).all(release.releaseMbid) as TargetTrackRow[];

    if (targetTracks.length < 2) continue;

    const candidates = providerAlbums
      .map((album) => buildProviderAlbumCoverageCandidate(album, targetTracks))
      .filter((candidate): candidate is ProviderAlbumCoverageCandidate => Boolean(candidate));

    for (const selected of chooseStrictComposites(candidates, targetTracks)) {
      const orderedSelected = orderCompositeByTargetTrack(selected, targetTracks);
      const provider = orderedSelected[0].provider;
      const providerAlbumIds = orderedSelected.map((candidate) => candidate.providerAlbumId);
      const qualities = orderedSelected.map((candidate) => candidate.quality).filter(Boolean) as string[];
      const quality = chooseLowestCompositeQuality(qualities);
      const librarySlot = orderedSelected.find((candidate) => candidate.librarySlot)?.librarySlot ?? null;
      const evidence = orderedSelected.flatMap((candidate) => candidate.evidence);

      release.availability.push({
        provider,
        providerAlbumId: joinProviderAlbumIds(providerAlbumIds),
        providerAlbumIds,
        quality,
        librarySlot,
        status: "verified",
        confidence: 1,
        matchKind: "composite",
        coverageSummary: `${targetTracks.length}/${targetTracks.length} tracks from ${orderedSelected.length} provider albums`,
      });

      // Keep the in-memory evidence reachable while debugging via the service
      // without expanding the public contract into a large per-track payload yet.
      void evidence;
    }
  }
}

function orderCompositeByTargetTrack(
  selected: ProviderAlbumCoverageCandidate[],
  targetTracks: TargetTrackRow[],
): ProviderAlbumCoverageCandidate[] {
  const positionByMbid = new Map(targetTracks.map((track, index) => [track.mbid, index]));
  return [...selected].sort((a, b) => {
    const firstA = Math.min(...Array.from(a.coveredTrackMbids, (mbid) => positionByMbid.get(mbid) ?? Number.MAX_SAFE_INTEGER));
    const firstB = Math.min(...Array.from(b.coveredTrackMbids, (mbid) => positionByMbid.get(mbid) ?? Number.MAX_SAFE_INTEGER));
    return firstA - firstB || a.providerAlbumId.localeCompare(b.providerAlbumId);
  });
}

function buildProviderAlbumCoverageCandidate(
  album: ProviderAlbumRow,
  targetTracks: TargetTrackRow[],
): ProviderAlbumCoverageCandidate | null {
  let parsed: unknown;
  try {
    parsed = album.data ? JSON.parse(album.data) : null;
  } catch {
    return null;
  }
  const providerTracks = Array.isArray((parsed as { tracks?: unknown } | null)?.tracks)
    ? ((parsed as { tracks: unknown[] }).tracks as ProviderTrackLike[])
    : [];
  if (providerTracks.length === 0 || providerTracks.length > targetTracks.length) return null;

  const coveredTrackMbids = new Set<string>();
  const evidence: ProviderAlbumCoverageCandidate["evidence"] = [];

  for (const providerTrack of providerTracks) {
    const matches = targetTracks.filter((target) => {
      if (coveredTrackMbids.has(target.mbid)) return false;
      return providerTrackMatchesTarget(providerTrack, target);
    });
    if (matches.length !== 1) return null;
    const target = matches[0];
    coveredTrackMbids.add(target.mbid);
    const providerDuration = numericProviderDuration(providerTrack.duration);
    evidence.push({
      targetTrackMbid: target.mbid,
      targetRecordingMbid: target.recording_mbid,
      providerTrackTitle: String(providerTrack.title || ""),
      providerTrackIsrc: typeof providerTrack.isrc === "string" ? providerTrack.isrc : null,
      durationDeltaSeconds: providerDuration != null && target.length_ms != null
        ? Math.abs(providerDuration - target.length_ms / 1000)
        : null,
    });
  }

  if (coveredTrackMbids.size === 0) return null;
  return {
    provider: album.provider,
    providerAlbumId: String(album.provider_item_id),
    quality: album.quality,
    librarySlot: album.library_slot,
    coveredTrackMbids,
    evidence,
  };
}

function providerTrackMatchesTarget(providerTrack: ProviderTrackLike, target: TargetTrackRow): boolean {
  const providerTitle = normalizeTrackTitle(providerTrack.title);
  const targetTitle = normalizeTrackTitle(target.title);
  if (!providerTitle || !targetTitle || providerTitle !== targetTitle) return false;

  const providerDuration = numericProviderDuration(providerTrack.duration);
  if (providerDuration == null || target.length_ms == null) return true;
  return Math.abs(providerDuration - target.length_ms / 1000) <= 4;
}

function normalizeTrackTitle(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(edit|single version|radio edit|mtv unplugged)\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function numericProviderDuration(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function chooseStrictComposites(
  candidates: ProviderAlbumCoverageCandidate[],
  targetTracks: TargetTrackRow[],
): ProviderAlbumCoverageCandidate[][] {
  const targetMbids = new Set(targetTracks.map((track) => track.mbid));
  const byProvider = new Map<string, ProviderAlbumCoverageCandidate[]>();
  for (const candidate of candidates) {
    const list = byProvider.get(candidate.provider) ?? [];
    list.push(candidate);
    byProvider.set(candidate.provider, list);
  }

  const selections: ProviderAlbumCoverageCandidate[][] = [];
  const selectionKeys = new Set<string>();
  for (const providerCandidates of byProvider.values()) {
    const partial = providerCandidates
      .filter((candidate) => candidate.coveredTrackMbids.size < targetMbids.size)
      .sort(compareCompositeCandidates);

    for (const quality of Array.from(new Set(partial.map((candidate) => normalizeCompositeQuality(candidate.quality)))).sort(compareCompositeQualityDesc)) {
      const selected = findExactCover(
        partial.filter((candidate) => normalizeCompositeQuality(candidate.quality) === quality),
        targetMbids,
        [],
        new Set<string>(),
        0,
      );
      if (selected && selected.length > 1) {
        const key = compositeSelectionKey(selected);
        if (!selectionKeys.has(key)) {
          selectionKeys.add(key);
          selections.push(selected);
        }
      }
    }

    if (selections.length === 0) {
      const selected = findExactCover(partial, targetMbids, [], new Set<string>(), 0);
      if (selected && selected.length > 1) {
        const key = compositeSelectionKey(selected);
        selectionKeys.add(key);
        selections.push(selected);
      }
    }
  }
  return selections.sort((left, right) =>
    compareCompositeQualityDesc(
      normalizeCompositeQuality(chooseLowestCompositeQuality(left.map((candidate) => candidate.quality).filter(Boolean) as string[])),
      normalizeCompositeQuality(chooseLowestCompositeQuality(right.map((candidate) => candidate.quality).filter(Boolean) as string[])),
    ) || compositeSelectionKey(left).localeCompare(compositeSelectionKey(right)),
  );
}

function compareCompositeCandidates(a: ProviderAlbumCoverageCandidate, b: ProviderAlbumCoverageCandidate): number {
  return b.coveredTrackMbids.size - a.coveredTrackMbids.size
    || compareCompositeQualityDesc(normalizeCompositeQuality(a.quality), normalizeCompositeQuality(b.quality))
    || a.providerAlbumId.localeCompare(b.providerAlbumId);
}

function compositeSelectionKey(selected: ProviderAlbumCoverageCandidate[]): string {
  return selected.map((candidate) => candidate.providerAlbumId).sort().join(COMPOSITE_PROVIDER_ID_SEPARATOR);
}

function normalizeCompositeQuality(value: string | null | undefined): string {
  const q = String(value || "").toUpperCase();
  if (q.includes("ATMOS") || q.includes("SPATIAL")) return "DOLBY_ATMOS";
  if (q.includes("HIRES")) return "HIRES_LOSSLESS";
  if (q.includes("LOSSLESS")) return "LOSSLESS";
  if (q.includes("HIGH")) return "HIGH";
  if (q.includes("LOW")) return "LOW";
  return "";
}

function compositeQualityRank(quality: string): number {
  if (quality === "DOLBY_ATMOS") return 4;
  if (quality === "HIRES_LOSSLESS") return 3;
  if (quality === "LOSSLESS") return 2;
  if (quality === "HIGH") return 1;
  return 0;
}

function compareCompositeQualityDesc(left: string, right: string): number {
  return compositeQualityRank(right) - compositeQualityRank(left) || left.localeCompare(right);
}

function findExactCover(
  candidates: ProviderAlbumCoverageCandidate[],
  targetMbids: Set<string>,
  selected: ProviderAlbumCoverageCandidate[],
  covered: Set<string>,
  startIndex: number,
): ProviderAlbumCoverageCandidate[] | null {
  if (covered.size === targetMbids.size) return [...selected];
  if (selected.length >= 4) return null;

  for (let i = startIndex; i < candidates.length; i++) {
    const candidate = candidates[i];
    let overlaps = false;
    for (const trackMbid of candidate.coveredTrackMbids) {
      if (covered.has(trackMbid)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;

    const nextCovered = new Set(covered);
    for (const trackMbid of candidate.coveredTrackMbids) nextCovered.add(trackMbid);
    const result = findExactCover(candidates, targetMbids, [...selected, candidate], nextCovered, i + 1);
    if (result) return result;
  }
  return null;
}

function chooseLowestCompositeQuality(qualities: string[]): string | null {
  if (qualities.length === 0) return null;
  const rank = (quality: string) => {
    const q = quality.toUpperCase();
    if (q.includes("ATMOS") || q.includes("SPATIAL")) return 4;
    if (q.includes("HIRES")) return 3;
    if (q.includes("LOSSLESS")) return 2;
    if (q.includes("HIGH")) return 1;
    return 0;
  };
  return [...qualities].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
