import fs from "fs";
import { db } from "../../../database.js";
import { isSpatialAudioQuality } from "../../../utils/spatial-audio.js";
import { resolveStoredLibraryPath } from "../../mediafiles/library-paths.js";
import { streamingProviderManager } from "../../providers/index.js";
import type { ProviderLyrics } from "../../providers/streaming-provider.js";
import { LyricFileService, type LyricFileRow } from "./lyric-file-service.js";
import { classifyLyricsForSidecar } from "./lyric-sidecar.js";

export type ResolvedLyrics = {
  text: string;
  subtitles: string;
  provider: string;
  lyricsProvider?: string | null;
  matchType: "exact" | "shared_from_related_recording";
  sourceProviderId?: string | null;
  sourceFileId?: number | null;
};

type ProviderTrackLyricsRow = {
  provider: string;
  id: string;
  artist_id: string | null;
  album_id: string | null;
  title: string;
  track_number: number | null;
  volume_number: number | null;
  duration: number | null;
  quality: string | null;
  mbid: string | null;
  type: string | null;
  release_group_mbid: string | null;
  release_mbid: string | null;
  track_mbid: string | null;
  recording_mbid: string | null;
  recording_id: number | null;
};

type CandidateRow = ProviderTrackLyricsRow & {
  source_release_group_mbid: string | null;
  candidate_release_group_mbid: string | null;
};

type LyricCandidateRow = CandidateRow & {
  lyric_file_id: number;
  lyric_file_path: string;
  lyric_relative_path: string | null;
  lyric_library_root: string | null;
  lyric_extension: string | null;
  lyric_provider: string | null;
  lyric_provider_id: string | null;
  lyric_recording_mbid: string | null;
};

function nullableText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeTitle(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*(atmos|spatial|360\s*ra|dolby)[^)]*\)/gi, " ")
    .replace(/\[[^\]]*(atmos|spatial|360\s*ra|dolby)[^\]]*\]/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function durationDelta(left: number | null, right: number | null): number {
  const a = Number(left || 0);
  const b = Number(right || 0);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.abs(a - b);
}

function providerLyricsToResolved(
  provider: string,
  lyrics: ProviderLyrics,
  matchType: ResolvedLyrics["matchType"],
  sourceProviderId: string,
): ResolvedLyrics {
  const classified = classifyLyricsForSidecar(lyrics);
  return {
    text: classified?.text || "",
    subtitles: classified?.subtitles || "",
    provider,
    lyricsProvider: lyrics.provider || null,
    matchType,
    sourceProviderId,
  };
}

function lyricFileToResolved(
  provider: string,
  row: LyricFileRow,
  matchType: ResolvedLyrics["matchType"],
  sourceProviderId?: string | null,
): ResolvedLyrics | null {
  const resolvedPath = resolveStoredLibraryPath({
    filePath: row.file_path,
    libraryRoot: row.library_root,
    relativePath: row.relative_path,
  });

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const content = fs.readFileSync(resolvedPath, "utf-8");
  if (!content.trim()) {
    return null;
  }

  // Do not infer synchronization from `.lrc` alone. Older downloaders could
  // emit timestamp-free content under that extension; classifying the actual
  // content keeps cached sidecars and embedded tags semantically correct.
  const classified = classifyLyricsForSidecar({
    subtitles: content,
    text: content,
  });
  if (!classified) return null;

  return {
    text: classified.text,
    subtitles: classified.subtitles,
    provider: row.provider || provider,
    lyricsProvider: null,
    matchType,
    sourceProviderId: sourceProviderId ?? row.provider_id ?? null,
    sourceFileId: row.id,
  };
}

function providerTrackProjectionJoins(itemAlias: string): string {
  const matchAlias = `${itemAlias}_match`;
  const memberAlias = `${itemAlias}_member`;
  const releaseMatchAlias = `${itemAlias}_release_match`;
  const trackAlias = `${itemAlias}_track`;
  const recordingAlias = `${itemAlias}_recording`;
  const releaseAlias = `${itemAlias}_release`;
  const groupAlias = `${itemAlias}_group`;
  const artistAlias = `${itemAlias}_artist`;
  const variantAlias = `${itemAlias}_variant`;
  return `
    LEFT JOIN ProviderTrackMatches ${matchAlias}
      ON ${matchAlias}.id = (
        SELECT candidate_match.id
        FROM ProviderTrackMatches candidate_match
        JOIN ProviderEditionMembers candidate_member
          ON candidate_member.id = candidate_match.provider_edition_member_id
        JOIN ProviderEditionMatches candidate_release_match
          ON candidate_release_match.id = candidate_match.provider_edition_match_id
         AND candidate_release_match.match_state = 'accepted'
        WHERE candidate_member.member_item_id = ${itemAlias}.id
          AND candidate_match.match_state = 'accepted'
        ORDER BY
          CASE WHEN candidate_match.track_id IS NULL THEN 1 ELSE 0 END,
          CASE candidate_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
          candidate_match.confidence DESC,
          candidate_match.updated_at DESC
        LIMIT 1
      )
    LEFT JOIN ProviderEditionMembers ${memberAlias}
      ON ${memberAlias}.id = ${matchAlias}.provider_edition_member_id
    LEFT JOIN ProviderEditionMatches ${releaseMatchAlias}
      ON ${releaseMatchAlias}.id = ${matchAlias}.provider_edition_match_id
     AND ${releaseMatchAlias}.match_state = 'accepted'
    LEFT JOIN Tracks ${trackAlias} ON ${trackAlias}.id = ${matchAlias}.track_id
    LEFT JOIN Recordings ${recordingAlias} ON ${recordingAlias}.id = ${matchAlias}.recording_id
    LEFT JOIN AlbumReleases ${releaseAlias} ON ${releaseAlias}.id = ${releaseMatchAlias}.release_id
    LEFT JOIN Albums ${groupAlias} ON ${groupAlias}.id = ${releaseAlias}.release_group_id
    LEFT JOIN ArtistMetadata ${artistAlias}
      ON ${artistAlias}.id = COALESCE(
        ${groupAlias}.artist_metadata_id,
        ${recordingAlias}.artist_metadata_id
      )
    LEFT JOIN ProviderItemAudioVariants ${variantAlias}
      ON ${variantAlias}.id = (
        SELECT candidate_variant.id
        FROM ProviderItemAudioVariants candidate_variant
        WHERE candidate_variant.provider_item_id = ${itemAlias}.id
          AND LOWER(COALESCE(candidate_variant.availability, 'unknown')) != 'unavailable'
        ORDER BY
          CASE candidate_variant.quality_class
            WHEN 'lossless' THEN 0
            WHEN 'hires-lossless' THEN 1
            WHEN 'lossy' THEN 2
            WHEN 'spatial' THEN 3
            ELSE 4
          END,
          candidate_variant.id
        LIMIT 1
      )
  `;
}

function loadProviderTrack(provider: string, providerMediaId: string | number): ProviderTrackLyricsRow | null {
  const row = db.prepare(`
    SELECT
      pi.provider,
      CAST(pi.provider_id AS TEXT) AS id,
      CAST(pi_artist.mbid AS TEXT) AS artist_id,
      CAST(pi_group.mbid AS TEXT) AS album_id,
      COALESCE(pi_track.title, pi_recording.title, pi.title) AS title,
      pi_track.position AS track_number,
      pi_track.medium_position AS volume_number,
      COALESCE(ROUND(pi.duration_ms / 1000.0), ROUND(pi_recording.length_ms / 1000.0)) AS duration,
      COALESCE(pi_variant.provider_quality_label, pi_variant.quality_class) AS quality,
      pi_recording.mbid AS mbid,
      pi.entity_type AS type,
      pi_group.mbid AS release_group_mbid,
      pi_release.mbid AS release_mbid,
      pi_track.mbid AS track_mbid,
      pi_recording.mbid AS recording_mbid,
      pi_match.recording_id
    FROM ProviderItems pi
    ${providerTrackProjectionJoins("pi")}
    WHERE pi.provider = ?
      AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
      AND pi.entity_type = 'track'
    ORDER BY pi.updated_at DESC
    LIMIT 1
  `).get(provider, String(providerMediaId)) as ProviderTrackLyricsRow | undefined;

  return row ?? null;
}

function getProviderItemRecordingId(provider: string, providerMediaId: string): number | null {
  const row = db.prepare(`
    SELECT track_match.recording_id
    FROM ProviderItems item
    JOIN ProviderEditionMembers member ON member.member_item_id = item.id
    JOIN ProviderTrackMatches track_match
      ON track_match.provider_edition_member_id = member.id
     AND track_match.match_state = 'accepted'
    JOIN ProviderEditionMatches release_match
      ON release_match.id = track_match.provider_edition_match_id
     AND release_match.match_state = 'accepted'
    WHERE item.provider = ?
      AND item.entity_type = 'track'
      AND CAST(item.provider_id AS TEXT) = CAST(? AS TEXT)
    ORDER BY
      CASE track_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
      track_match.confidence DESC
    LIMIT 1
  `).get(provider, providerMediaId) as { recording_id?: number | null } | undefined;

  return row?.recording_id == null ? null : Number(row.recording_id);
}

function getRecordingIdForMedia(provider: string, media: ProviderTrackLyricsRow): number | null {
  if (media.recording_id != null) {
    return Number(media.recording_id);
  }

  const foreignRecordingId = nullableText(media.mbid);
  if (foreignRecordingId) {
    const row = db.prepare(`
      SELECT id
      FROM Recordings
      WHERE foreign_recording_id = ? OR mbid = ?
      LIMIT 1
    `).get(foreignRecordingId, foreignRecordingId) as { id?: number | null } | undefined;
    if (row?.id != null) {
      return Number(row.id);
    }
  }

  return getProviderItemRecordingId(provider, media.id);
}

function loadLyricFileForMedia(provider: string, media: ProviderTrackLyricsRow): LyricFileRow | null {
  return LyricFileService.findByProviderTrack(provider, media.id);
}

function loadLyricFileForForeignRecording(foreignRecordingId: string | null): LyricFileRow | null {
  if (!foreignRecordingId) {
    return null;
  }

  return LyricFileService.findByForeignRecording(foreignRecordingId);
}

function candidateScore(media: ProviderTrackLyricsRow, candidate: CandidateRow): number {
  let score = 0;
  if (nullableText(media.mbid) && nullableText(candidate.mbid) === nullableText(media.mbid)) {
    score -= 200;
  }
  if (candidate.source_release_group_mbid && candidate.candidate_release_group_mbid === candidate.source_release_group_mbid) {
    score -= 40;
  }
  if (!isSpatialAudioQuality(candidate.quality) && isSpatialAudioQuality(media.quality)) {
    score -= 20;
  }
  if (Number(candidate.track_number || 0) === Number(media.track_number || 0)) {
    score -= 10;
  }
  if (Number(candidate.volume_number || 1) === Number(media.volume_number || 1)) {
    score -= 4;
  }
  score += Math.min(durationDelta(media.duration, candidate.duration), 30);
  return score;
}

function sameRecordingCandidate(media: ProviderTrackLyricsRow, candidate: CandidateRow): boolean {
  const mediaRecordingMbid = nullableText(media.mbid);
  const candidateRecordingMbid = nullableText(candidate.mbid);
  const sameTrackNumber = media.track_number == null
    || candidate.track_number == null
    || Number(media.track_number) === Number(candidate.track_number);
  const sameVolume = media.volume_number == null
    || candidate.volume_number == null
    || Number(media.volume_number) === Number(candidate.volume_number);
  const fuzzySame = normalizeTitle(candidate.title) === normalizeTitle(media.title)
    && sameTrackNumber
    && sameVolume
    && durationDelta(media.duration, candidate.duration) <= 12;

  if (mediaRecordingMbid && candidateRecordingMbid) {
    if (candidateRecordingMbid === mediaRecordingMbid) {
      return true;
    }
    // Stereo and Atmos mixes are distinct MusicBrainz recordings but share
    // lyrical content. Allow sharing only for a stereo↔spatial pair with a
    // matching title/position/duration — never across unrelated MBIDs.
    const spatialPair = isSpatialAudioQuality(media.quality) !== isSpatialAudioQuality(candidate.quality);
    return spatialPair && fuzzySame;
  }

  return fuzzySame;
}

function findCachedCounterpart(media: ProviderTrackLyricsRow): LyricCandidateRow | null {
  const normalized = normalizeTitle(media.title);
  if (!normalized || !media.artist_id) {
    return null;
  }
  const candidateProviders = streamingProviderManager.getAllStreamingProviders().map((provider) => provider.id);
  if (candidateProviders.length === 0) {
    return null;
  }
  const providerPlaceholders = candidateProviders.map(() => "?").join(",");

  const rows = db.prepare(`
    SELECT
      candidate.provider,
      CAST(candidate.provider_id AS TEXT) AS id,
      CAST(candidate_artist.mbid AS TEXT) AS artist_id,
      CAST(candidate_group.mbid AS TEXT) AS album_id,
      COALESCE(candidate_track.title, candidate_recording.title, candidate.title) AS title,
      candidate_track.position AS track_number,
      candidate_track.medium_position AS volume_number,
      COALESCE(ROUND(candidate.duration_ms / 1000.0), ROUND(candidate_recording.length_ms / 1000.0)) AS duration,
      COALESCE(candidate_variant.provider_quality_label, candidate_variant.quality_class) AS quality,
      candidate_recording.mbid AS mbid,
      candidate.entity_type AS type,
      ? AS source_release_group_mbid,
      candidate_group.mbid AS candidate_release_group_mbid,
      candidate_group.mbid AS release_group_mbid,
      candidate_release.mbid AS release_mbid,
      candidate_track.mbid AS track_mbid,
      candidate_recording.mbid AS recording_mbid,
      candidate_match.recording_id,
      lf.id AS lyric_file_id,
      lf.file_path AS lyric_file_path,
      lf.relative_path AS lyric_relative_path,
      lf.library_root AS lyric_library_root,
      lf.extension AS lyric_extension,
      lf.provider AS lyric_provider,
      lf.provider_id AS lyric_provider_id,
      lf.canonical_recording_mbid AS lyric_recording_mbid
    FROM ProviderItems candidate
    ${providerTrackProjectionJoins("candidate")}
    JOIN LyricFiles lf
      ON (
        (lf.provider = candidate.provider
          AND lf.provider_entity_type = 'track'
          AND CAST(lf.provider_id AS TEXT) = CAST(candidate.provider_id AS TEXT))
        OR (candidate_track.mbid IS NOT NULL AND lf.canonical_track_mbid = candidate_track.mbid)
        OR (candidate_recording.mbid IS NOT NULL AND lf.canonical_recording_mbid = candidate_recording.mbid)
      )
    WHERE candidate.provider IN (${providerPlaceholders})
      AND CAST(candidate_artist.mbid AS TEXT) = CAST(? AS TEXT)
      AND NOT (
        candidate.provider = ?
        AND CAST(candidate.provider_id AS TEXT) = CAST(? AS TEXT)
      )
      AND candidate.entity_type = 'track'
      AND COALESCE(candidate_track.title, candidate_recording.title, candidate.title) IS NOT NULL
  `).all(
    media.release_group_mbid,
    ...candidateProviders,
    media.artist_id,
    media.provider,
    media.id,
  ) as LyricCandidateRow[];

  return rows
    .filter((row) => sameRecordingCandidate(media, row))
    .sort((left, right) => {
      const scoreDelta = candidateScore(media, left) - candidateScore(media, right);
      return scoreDelta || streamingProviderManager.getProviderPreferenceRank(left.provider)
        - streamingProviderManager.getProviderPreferenceRank(right.provider);
    })[0] ?? null;
}

function findSourceCandidates(media: ProviderTrackLyricsRow): CandidateRow[] {
  const normalized = normalizeTitle(media.title);
  if (!normalized || !media.artist_id) {
    return [];
  }

  const lyricProviders = streamingProviderManager.getAllStreamingProviders()
    .filter((provider) => provider.capabilities.lyrics && typeof provider.getLyrics === "function")
    .map((provider) => provider.id);
  if (lyricProviders.length === 0) {
    return [];
  }
  const providerPlaceholders = lyricProviders.map(() => "?").join(",");

  const rows = db.prepare(`
    SELECT
      candidate.provider,
      CAST(candidate.provider_id AS TEXT) AS id,
      CAST(candidate_artist.mbid AS TEXT) AS artist_id,
      CAST(candidate_group.mbid AS TEXT) AS album_id,
      COALESCE(candidate_track.title, candidate_recording.title, candidate.title) AS title,
      candidate_track.position AS track_number,
      candidate_track.medium_position AS volume_number,
      COALESCE(ROUND(candidate.duration_ms / 1000.0), ROUND(candidate_recording.length_ms / 1000.0)) AS duration,
      COALESCE(candidate_variant.provider_quality_label, candidate_variant.quality_class) AS quality,
      candidate_recording.mbid AS mbid,
      candidate.entity_type AS type,
      ? AS source_release_group_mbid,
      candidate_group.mbid AS candidate_release_group_mbid,
      candidate_group.mbid AS release_group_mbid,
      candidate_release.mbid AS release_mbid,
      candidate_track.mbid AS track_mbid,
      candidate_recording.mbid AS recording_mbid,
      candidate_match.recording_id
    FROM ProviderItems candidate
    ${providerTrackProjectionJoins("candidate")}
    WHERE candidate.provider IN (${providerPlaceholders})
      AND CAST(candidate_artist.mbid AS TEXT) = CAST(? AS TEXT)
      AND NOT (
        candidate.provider = ?
        AND CAST(candidate.provider_id AS TEXT) = CAST(? AS TEXT)
      )
      AND candidate.entity_type = 'track'
      AND COALESCE(candidate_track.title, candidate_recording.title, candidate.title) IS NOT NULL
  `).all(media.release_group_mbid, ...lyricProviders, media.artist_id, media.provider, media.id) as CandidateRow[];

  return rows
    .filter((row) => sameRecordingCandidate(media, row))
    .sort((left, right) => {
      const scoreDelta = candidateScore(media, left) - candidateScore(media, right);
      return scoreDelta || streamingProviderManager.getProviderPreferenceRank(left.provider)
        - streamingProviderManager.getProviderPreferenceRank(right.provider);
    })
    .slice(0, 8);
}

function lyricCandidateFile(candidate: LyricCandidateRow): LyricFileRow {
  return {
    id: candidate.lyric_file_id,
    artist_id: candidate.artist_id || "",
    track_file_id: null,
    relative_path: candidate.lyric_relative_path || candidate.lyric_file_path,
    file_path: candidate.lyric_file_path,
    library_root: candidate.lyric_library_root || "",
    extension: candidate.lyric_extension || "",
    provider: candidate.lyric_provider,
    provider_entity_type: "track",
    provider_id: candidate.lyric_provider_id,
    library_slot: "stereo",
    quality: candidate.quality,
    canonical_recording_mbid: candidate.lyric_recording_mbid,
  };
}

async function fetchProviderLyrics(providerId: string, providerMediaId: string): Promise<ProviderLyrics | null> {
  try {
    const provider = streamingProviderManager.getStreamingProvider(providerId);
    const lyrics = await provider.getLyrics?.(providerMediaId) ?? null;
    if (!lyrics?.subtitles && !lyrics?.text) {
      return null;
    }
    return lyrics;
  } catch {
    return null;
  }
}

function recordSharedLyricsRelation(provider: string, media: ProviderTrackLyricsRow, sourceMedia: ProviderTrackLyricsRow): void {
  if (media.provider === sourceMedia.provider && media.id === sourceMedia.id) {
    return;
  }

  const targetRecordingId = getRecordingIdForMedia(provider, media);
  const sourceRecordingId = getRecordingIdForMedia(sourceMedia.provider, sourceMedia);
  const targetForeignRecordingId = nullableText(media.mbid);
  const sourceForeignRecordingId = nullableText(sourceMedia.mbid);

  if (!targetRecordingId && !sourceRecordingId && !targetForeignRecordingId && !sourceForeignRecordingId) {
    return;
  }

  db.prepare(`
    INSERT OR IGNORE INTO RecordingRelations (
      source_recording_id,
      target_recording_id,
      source_foreign_recording_id,
      target_foreign_recording_id,
      relation_type, source, confidence,
      updated_at
    ) VALUES (?, ?, ?, ?, 'same_lyrical_content', 'discogenius', 0.92, CURRENT_TIMESTAMP)
  `).run(
    sourceRecordingId,
    targetRecordingId,
    sourceForeignRecordingId,
    targetForeignRecordingId,
  );
}

export async function getLyricsForProviderMedia(
  providerMediaId: string | number,
  requestedProvider?: string | null,
): Promise<ResolvedLyrics | null> {
  const provider = String(requestedProvider || "").trim()
    || streamingProviderManager.getDefaultStreamingProvider().id;
  const media = loadProviderTrack(provider, providerMediaId);
  if (!media) {
    return null;
  }

  const exactFile = loadLyricFileForMedia(provider, media)
    ?? loadLyricFileForForeignRecording(nullableText(media.mbid));
  const exactResolved = exactFile ? lyricFileToResolved(provider, exactFile, "exact", media.id) : null;
  if (exactResolved) {
    return exactResolved;
  }

  const cachedCounterpart = findCachedCounterpart(media);
  const cachedCounterpartLyrics = cachedCounterpart
    ? lyricFileToResolved(cachedCounterpart.provider, lyricCandidateFile(cachedCounterpart), "shared_from_related_recording", cachedCounterpart.id)
    : null;
  if (cachedCounterpart && cachedCounterpartLyrics) {
    recordSharedLyricsRelation(provider, media, cachedCounterpart);
    return cachedCounterpartLyrics;
  }

  const exactLyrics = await fetchProviderLyrics(provider, media.id);
  if (exactLyrics) {
    return providerLyricsToResolved(provider, exactLyrics, "exact", media.id);
  }

  for (const candidate of findSourceCandidates(media)) {
    const candidateFile = loadLyricFileForMedia(candidate.provider, candidate)
      ?? loadLyricFileForForeignRecording(nullableText(candidate.mbid));
    const candidateFileLyrics = candidateFile
      ? lyricFileToResolved(candidate.provider, candidateFile, "shared_from_related_recording", candidate.id)
      : null;
    if (candidateFileLyrics) {
      recordSharedLyricsRelation(provider, media, candidate);
      return candidateFileLyrics;
    }

    const candidateLyrics = await fetchProviderLyrics(candidate.provider, candidate.id);
    if (candidateLyrics) {
      recordSharedLyricsRelation(provider, media, candidate);
      return providerLyricsToResolved(candidate.provider, candidateLyrics, "shared_from_related_recording", candidate.id);
    }
  }

  return null;
}
