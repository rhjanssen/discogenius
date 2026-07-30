import path from "path";
import { db } from "../../database.js";

/**
 * Album organize: file↔provider matching + catalog-first track row resolution.
 * DB reads only — no FS side effects or Organizer class state.
 */

export function normalizeBundledVideoTitle(value: unknown): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function loadBundledVideoTrackCandidates(
  provider: string,
  albumIds: string[],
): Array<{ provider_id: string; title: string; track_number: number | null }> {
  if (!provider || albumIds.length === 0) {
    return [];
  }
  const placeholders = albumIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT
      CAST(member_item.provider_id AS TEXT) AS provider_id,
      COALESCE(member.contextual_title, member_item.title, '') AS title,
      member.position AS track_number
    FROM ProviderItems provider_release
    JOIN ProviderEditionMembers member
      ON member.provider_edition_item_id = provider_release.id
    JOIN ProviderItems member_item
      ON member_item.id = member.member_item_id
     AND member_item.entity_type = 'track'
    WHERE provider_release.provider = ?
      AND provider_release.entity_type = 'release'
      AND provider_release.provider_id IN (${placeholders})
    ORDER BY member.medium_position ASC, member.position ASC, member_item.provider_id ASC
  `).all(provider, ...albumIds) as Array<{ provider_id: string; title: string; track_number: number | null }>;
}

export type MatchedAlbumTrackRow = {
  id: string | number;
  album_id: string | number | null;
  artist_id: string | number | null;
  title: string | null;
  version: string | null;
  explicit: number | null;
  quality: string | null;
  track_number: number | null;
  volume_number: number | null;
  mbid: string | null;
  canonical_track_mbid: string | null;
  canonical_recording_mbid: string | null;
};

/** Provider track ids that have a materialized offer row for the album(s). */
export function loadProviderTrackIdSet(albumIds: string[], provider = ""): Set<string> {
  if (albumIds.length === 0) {
    return new Set();
  }
  const placeholders = albumIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT CAST(member_item.provider_id AS TEXT) AS provider_id
    FROM ProviderItems provider_release
    JOIN ProviderEditionMembers member
      ON member.provider_edition_item_id = provider_release.id
    JOIN ProviderItems member_item
      ON member_item.id = member.member_item_id
     AND member_item.entity_type = 'track'
    WHERE provider_release.entity_type = 'release'
      AND provider_release.provider_id IN (${placeholders})
      AND (? = '' OR provider_release.provider = ?)
  `).all(...albumIds, provider, provider) as Array<{ provider_id: string }>;
  return new Set(rows.map((row) => String(row.provider_id)));
}

/**
 * Fast path: basename === provider track id. Numeric basenames with no offer
 * are reported so the caller can refresh and retry.
 */
export function matchAlbumFilesByProviderId(
  files: string[],
  providerTrackIds: Set<string>,
): { matched: Map<string, string>; missingProviderIds: Set<string> } {
  const matched = new Map<string, string>();
  const missingProviderIds = new Set<string>();
  for (const filePath of files) {
    const baseName = path.basename(filePath, path.extname(filePath));
    if (!baseName) {
      continue;
    }

    if (providerTrackIds.has(baseName)) {
      matched.set(filePath, baseName);
    } else if (/^\d+$/.test(baseName)) {
      missingProviderIds.add(baseName);
    }
  }
  return { matched, missingProviderIds };
}

/**
 * Apple Music album-bundled videos stage as `NN. Title.mp4`. Match against
 * materialized VIDEO-slot track offers by exact normalized title (+ optional
 * position). Ambiguous titles are left unmatched for manual recovery.
 * Mutates `matched` in place.
 */
export function matchAppleMusicBundledVideoFiles(params: {
  files: string[];
  matched: Map<string, string>;
  provider: string;
  albumIds: string[];
  videoExtensions: Set<string>;
}): void {
  const { files, matched, provider, albumIds, videoExtensions } = params;
  if (provider.toLowerCase() !== "apple-music" || albumIds.length === 0) {
    return;
  }

  const candidates = loadBundledVideoTrackCandidates(provider, albumIds);
  const usedProviderIds = new Set(matched.values());
  for (const filePath of files) {
    if (matched.has(filePath) || !videoExtensions.has(path.extname(filePath).toLowerCase())) {
      continue;
    }

    const baseName = path.basename(filePath, path.extname(filePath));
    const filenameMatch = /^(\d+)\.\s+(.+)$/.exec(baseName);
    if (!filenameMatch) {
      continue;
    }

    const taskPosition = Number(filenameMatch[1]);
    const normalizedTitle = normalizeBundledVideoTitle(filenameMatch[2]);
    if (!normalizedTitle) {
      continue;
    }

    const titleMatches = candidates.filter((candidate) =>
      !usedProviderIds.has(candidate.provider_id)
      && normalizeBundledVideoTitle(candidate.title) === normalizedTitle
    );
    const positionedMatches = titleMatches.filter((candidate) => candidate.track_number === taskPosition);
    const matchedCandidate = positionedMatches.length === 1
      ? positionedMatches[0]
      : (positionedMatches.length === 0 && titleMatches.length === 1 ? titleMatches[0] : null);
    if (!matchedCandidate) {
      continue;
    }

    matched.set(filePath, matchedCandidate.provider_id);
    usedProviderIds.add(matchedCandidate.provider_id);
  }
}

/**
 * Resolve a staged provider track id to a catalog Tracks row on the selected
 * release. Positions always come from Tracks — never from provider
 * match_evidence disc/track numbers (native album layout ≠ hybrid release).
 */
function resolveCanonicalTrackOnRelease(params: {
  editionMbid: string;
  trackMbid?: string | null;
  recordingMbid?: string | null;
  isrc?: string | null;
}): {
  mbid: string;
  recording_mbid: string;
  title: string;
  position: number;
  medium_position: number;
} | undefined {
  const trackMbid = String(params.trackMbid || "").trim() || null;
  const recordingMbid = String(params.recordingMbid || "").trim() || null;
  if (trackMbid || recordingMbid) {
    const byIdentity = db.prepare(`
      SELECT t.mbid, t.recording_mbid, t.title, t.position, t.medium_position
      FROM Tracks t
      WHERE t.edition_mbid = ?
        AND (
          (? IS NOT NULL AND t.mbid = ?)
          OR (? IS NOT NULL AND t.recording_mbid = ?)
        )
      ORDER BY
        CASE
          WHEN ? IS NOT NULL AND t.mbid = ? THEN 0
          ELSE 1
        END,
        t.medium_position,
        t.position
      LIMIT 1
    `).get(
      params.editionMbid,
      trackMbid,
      trackMbid,
      recordingMbid,
      recordingMbid,
      trackMbid,
      trackMbid,
    ) as {
      mbid: string;
      recording_mbid: string;
      title: string;
      position: number;
      medium_position: number;
    } | undefined;
    if (byIdentity) {
      return byIdentity;
    }
  }

  // Stereo multi-disc offers (e.g. Bastille GMTF vol 3) can have ISRCs without
  // track/recording MBIDs written back onto ProviderItems. Match catalog by ISRC
  // so album import does not treat those files as unmatched extras.
  const isrc = String(params.isrc || "").trim().toUpperCase();
  if (!isrc) {
    return undefined;
  }
  return db.prepare(`
    SELECT t.mbid, t.recording_mbid, t.title, t.position, t.medium_position
    FROM Tracks t
    JOIN Recordings r ON r.mbid = t.recording_mbid
    WHERE t.edition_mbid = ?
      AND r.isrcs IS NOT NULL
      AND TRIM(r.isrcs) != ''
      AND (
        (
          json_valid(r.isrcs)
          AND EXISTS (
            SELECT 1
            FROM json_each(r.isrcs) AS isrc_row
            WHERE UPPER(TRIM(COALESCE(isrc_row.value, ''))) = ?
          )
        )
        OR (
          NOT json_valid(r.isrcs)
          AND UPPER(TRIM(r.isrcs)) = ?
        )
      )
    ORDER BY t.medium_position, t.position
    LIMIT 1
  `).get(params.editionMbid, isrc, isrc) as {
    mbid: string;
    recording_mbid: string;
    title: string;
    position: number;
    medium_position: number;
  } | undefined;
}

export function resolveMatchedCanonicalAlbumTrackRow(params: {
  provider: string;
  trackId: string;
  editionMbid: string;
  fallbackAlbumId: string;
  fallbackAlbumIds?: string[];
  fallbackArtistId: string;
  fallbackQuality: string | null;
}): MatchedAlbumTrackRow | null {
  const providerTrack = db.prepare(`
    SELECT
      pi.provider_id,
      pi.version,
      pi.explicit,
      COALESCE(variant.provider_quality_label, variant.quality_class) AS quality,
      provider_release.provider_id AS album_id,
      canonical_track.mbid AS track_mbid,
      recording.mbid AS recording_mbid,
      pi.isrc,
      canonical_release.mbid AS canonical_release_mbid
    FROM ProviderItems pi
    JOIN ProviderEditionMembers member
      ON member.member_item_id = pi.id
    JOIN ProviderItems provider_release
      ON provider_release.id = member.provider_edition_item_id
    JOIN ProviderTrackMatches track_match
      ON track_match.provider_edition_member_id = member.id
     AND track_match.match_state = 'accepted'
    JOIN ProviderEditionMatches release_match
      ON release_match.id = track_match.provider_edition_match_id
     AND release_match.match_state = 'accepted'
    JOIN AlbumEditions canonical_release
      ON canonical_release.id = release_match.edition_id
    LEFT JOIN Tracks canonical_track
      ON canonical_track.id = track_match.track_id
    JOIN Recordings recording
      ON recording.id = track_match.recording_id
    LEFT JOIN ProviderItemAudioVariants variant
      ON variant.id = (
        SELECT candidate.id
        FROM ProviderItemAudioVariants candidate
        WHERE candidate.provider_item_id = pi.id
        ORDER BY
          CASE candidate.availability WHEN 'available' THEN 0 ELSE 1 END,
          candidate.id
        LIMIT 1
      )
    WHERE pi.provider = ?
      AND pi.entity_type = 'track'
      AND pi.provider_id = ?
    ORDER BY
      CASE WHEN canonical_release.mbid = ? THEN 0 ELSE 1 END,
      CASE WHEN track_match.decision_source = 'manual' THEN 0 ELSE 1 END,
      track_match.confidence DESC,
      pi.updated_at DESC
    LIMIT 1
  `).get(params.provider, params.trackId, params.editionMbid) as any;

  if (providerTrack) {
    // Catalog-first: bind via Tracks on the selected/hybrid release only.
    // Never use provider match_evidence disc/track numbers — those are the
    // native album layout (e.g. Come As You Are #1) and mis-number Softly.
    const canonicalTrack = resolveCanonicalTrackOnRelease({
      editionMbid: params.editionMbid,
      trackMbid: providerTrack.track_mbid,
      recordingMbid: providerTrack.recording_mbid,
      isrc: providerTrack.isrc,
    });

    if (!canonicalTrack) {
      return null;
    }

    return {
      id: providerTrack.provider_id || params.trackId,
      album_id: providerTrack.album_id || params.fallbackAlbumId,
      artist_id: params.fallbackArtistId,
      title: canonicalTrack.title,
      version: providerTrack.version || null,
      explicit: providerTrack.explicit ?? null,
      quality: providerTrack.quality || params.fallbackQuality,
      track_number: canonicalTrack.position,
      volume_number: canonicalTrack.medium_position,
      mbid: canonicalTrack.recording_mbid,
      canonical_track_mbid: canonicalTrack.mbid,
      canonical_recording_mbid: canonicalTrack.recording_mbid,
    };
  }

  // Last resort: treat trackId as a canonical MB track id on the release.
  const canonicalTrack = db.prepare(`
    SELECT
      CAST(t.id AS TEXT) AS id,
      ? AS album_id,
      ? AS artist_id,
      t.title,
      NULL AS version,
      NULL AS explicit,
      ? AS quality,
      t.position AS track_number,
      t.medium_position AS volume_number,
      t.recording_mbid AS mbid,
      t.mbid AS canonical_track_mbid,
      t.recording_mbid AS canonical_recording_mbid
    FROM Tracks t
    WHERE t.edition_mbid = ?
      AND CAST(t.id AS TEXT) = ?
    LIMIT 1
  `).get(
    params.fallbackAlbumId,
    params.fallbackArtistId,
    params.fallbackQuality,
    params.editionMbid,
    params.trackId,
  ) as MatchedAlbumTrackRow | undefined;

  return canonicalTrack || null;
}
