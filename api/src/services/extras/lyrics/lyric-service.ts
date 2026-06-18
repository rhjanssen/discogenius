import fs from "fs";
import { db } from "../../../database.js";
import { isSpatialAudioQuality } from "../../../utils/spatial-audio.js";
import { resolveStoredLibraryPath } from "../../mediafiles/library-paths.js";
import { streamingProviderManager } from "../../providers/index.js";
import type { ProviderLyrics } from "../../providers/streaming-provider.js";
import { LyricFileService, type LyricFileRow } from "./lyric-file-service.js";

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
  return {
    text: lyrics.text || "",
    subtitles: lyrics.subtitles || "",
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

  const extension = nullableText(row.extension)?.toLowerCase();
  const isSynced = extension === "lrc";

  return {
    text: isSynced ? "" : content,
    subtitles: isSynced ? content : "",
    provider: row.provider || provider,
    lyricsProvider: null,
    matchType,
    sourceProviderId: sourceProviderId ?? row.provider_id ?? null,
    sourceFileId: row.id,
  };
}

function loadProviderTrack(provider: string, providerMediaId: string | number): ProviderTrackLyricsRow | null {
  const row = db.prepare(`
    SELECT
      pi.provider,
      CAST(pi.provider_id AS TEXT) AS id,
      CAST(pi.artist_mbid AS TEXT) AS artist_id,
      CAST(pi.album_id AS TEXT) AS album_id,
      COALESCE(t.title, r.title, pi.title) AS title,
      t.position AS track_number,
      t.medium_position AS volume_number,
      COALESCE(pi.duration, ROUND(r.length_ms / 1000.0)) AS duration,
      pi.quality,
      COALESCE(r.mbid, pi.recording_mbid) AS mbid,
      pi.entity_type AS type,
      pi.release_group_mbid,
      pi.release_mbid,
      pi.track_mbid,
      pi.recording_mbid,
      pi.recording_id
    FROM ProviderItems pi
    LEFT JOIN Tracks t
      ON (pi.track_mbid IS NOT NULL AND t.mbid = pi.track_mbid)
      OR (pi.track_mbid IS NULL
          AND pi.release_mbid IS NOT NULL
          AND pi.recording_mbid IS NOT NULL
          AND t.release_mbid = pi.release_mbid
          AND t.recording_mbid = pi.recording_mbid)
    LEFT JOIN Recordings r
      ON (pi.recording_id IS NOT NULL AND r.id = pi.recording_id)
      OR (pi.recording_mbid IS NOT NULL AND r.mbid = pi.recording_mbid)
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
    SELECT recording_id
    FROM ProviderItems
    WHERE provider = ?
      AND entity_type = 'track'
      AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
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
  const sameTrackNumber = media.track_number == null
    || candidate.track_number == null
    || Number(media.track_number) === Number(candidate.track_number);
  const sameVolume = media.volume_number == null
    || candidate.volume_number == null
    || Number(media.volume_number) === Number(candidate.volume_number);

  return normalizeTitle(candidate.title) === normalizeTitle(media.title)
    && sameTrackNumber
    && sameVolume
    && durationDelta(media.duration, candidate.duration) <= 12;
}

function findCachedCounterpart(media: ProviderTrackLyricsRow): LyricCandidateRow | null {
  const normalized = normalizeTitle(media.title);
  if (!normalized || !media.artist_id) {
    return null;
  }

  const rows = db.prepare(`
    SELECT
      candidate.provider,
      CAST(candidate.provider_id AS TEXT) AS id,
      CAST(candidate.artist_mbid AS TEXT) AS artist_id,
      CAST(candidate.album_id AS TEXT) AS album_id,
      COALESCE(t.title, r.title, candidate.title) AS title,
      t.position AS track_number,
      t.medium_position AS volume_number,
      COALESCE(candidate.duration, ROUND(r.length_ms / 1000.0)) AS duration,
      candidate.quality,
      COALESCE(r.mbid, candidate.recording_mbid) AS mbid,
      candidate.entity_type AS type,
      ? AS source_release_group_mbid,
      candidate.release_group_mbid AS candidate_release_group_mbid,
      candidate.release_group_mbid,
      candidate.release_mbid,
      candidate.track_mbid,
      candidate.recording_mbid,
      candidate.recording_id,
      lf.id AS lyric_file_id,
      lf.file_path AS lyric_file_path,
      lf.relative_path AS lyric_relative_path,
      lf.library_root AS lyric_library_root,
      lf.extension AS lyric_extension,
      lf.provider AS lyric_provider,
      lf.provider_id AS lyric_provider_id,
      lf.canonical_recording_mbid AS lyric_recording_mbid
    FROM ProviderItems candidate
    LEFT JOIN Tracks t
      ON (candidate.track_mbid IS NOT NULL AND t.mbid = candidate.track_mbid)
      OR (candidate.track_mbid IS NULL
          AND candidate.release_mbid IS NOT NULL
          AND candidate.recording_mbid IS NOT NULL
          AND t.release_mbid = candidate.release_mbid
          AND t.recording_mbid = candidate.recording_mbid)
    LEFT JOIN Recordings r
      ON (candidate.recording_id IS NOT NULL AND r.id = candidate.recording_id)
      OR (candidate.recording_mbid IS NOT NULL AND r.mbid = candidate.recording_mbid)
    JOIN LyricFiles lf
      ON (
        (lf.provider = candidate.provider
          AND lf.provider_entity_type = 'track'
          AND CAST(lf.provider_id AS TEXT) = CAST(candidate.provider_id AS TEXT))
        OR CAST(lf.media_id AS TEXT) = CAST(candidate.provider_id AS TEXT)
        OR (candidate.track_mbid IS NOT NULL AND lf.canonical_track_mbid = candidate.track_mbid)
        OR (candidate.recording_mbid IS NOT NULL AND lf.canonical_recording_mbid = candidate.recording_mbid)
      )
    WHERE candidate.provider = ?
      AND CAST(candidate.artist_mbid AS TEXT) = CAST(? AS TEXT)
      AND CAST(candidate.provider_id AS TEXT) != CAST(? AS TEXT)
      AND candidate.entity_type = 'track'
      AND COALESCE(t.title, r.title, candidate.title) IS NOT NULL
  `).all(media.release_group_mbid, media.provider, media.artist_id, media.id) as LyricCandidateRow[];

  return rows
    .filter((row) => sameRecordingCandidate(media, row))
    .sort((left, right) => candidateScore(media, left) - candidateScore(media, right))[0] ?? null;
}

function findSourceCandidates(media: ProviderTrackLyricsRow): CandidateRow[] {
  const normalized = normalizeTitle(media.title);
  if (!normalized || !media.artist_id) {
    return [];
  }

  const rows = db.prepare(`
    SELECT
      candidate.provider,
      CAST(candidate.provider_id AS TEXT) AS id,
      CAST(candidate.artist_mbid AS TEXT) AS artist_id,
      CAST(candidate.album_id AS TEXT) AS album_id,
      COALESCE(t.title, r.title, candidate.title) AS title,
      t.position AS track_number,
      t.medium_position AS volume_number,
      COALESCE(candidate.duration, ROUND(r.length_ms / 1000.0)) AS duration,
      candidate.quality,
      COALESCE(r.mbid, candidate.recording_mbid) AS mbid,
      candidate.entity_type AS type,
      ? AS source_release_group_mbid,
      candidate.release_group_mbid AS candidate_release_group_mbid,
      candidate.release_group_mbid,
      candidate.release_mbid,
      candidate.track_mbid,
      candidate.recording_mbid,
      candidate.recording_id
    FROM ProviderItems candidate
    LEFT JOIN Tracks t
      ON (candidate.track_mbid IS NOT NULL AND t.mbid = candidate.track_mbid)
      OR (candidate.track_mbid IS NULL
          AND candidate.release_mbid IS NOT NULL
          AND candidate.recording_mbid IS NOT NULL
          AND t.release_mbid = candidate.release_mbid
          AND t.recording_mbid = candidate.recording_mbid)
    LEFT JOIN Recordings r
      ON (candidate.recording_id IS NOT NULL AND r.id = candidate.recording_id)
      OR (candidate.recording_mbid IS NOT NULL AND r.mbid = candidate.recording_mbid)
    WHERE candidate.provider = ?
      AND CAST(candidate.artist_mbid AS TEXT) = CAST(? AS TEXT)
      AND CAST(candidate.provider_id AS TEXT) != CAST(? AS TEXT)
      AND candidate.entity_type = 'track'
      AND COALESCE(t.title, r.title, candidate.title) IS NOT NULL
  `).all(media.release_group_mbid, media.provider, media.artist_id, media.id) as CandidateRow[];

  return rows
    .filter((row) => sameRecordingCandidate(media, row))
    .sort((left, right) => candidateScore(media, left) - candidateScore(media, right))
    .slice(0, 8);
}

function lyricCandidateFile(candidate: LyricCandidateRow): LyricFileRow {
  return {
    id: candidate.lyric_file_id,
    artist_id: candidate.artist_id || "",
    album_id: candidate.album_id,
    track_file_id: null,
    media_id: candidate.id,
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

async function fetchProviderLyrics(providerMediaId: string): Promise<ProviderLyrics | null> {
  const provider = streamingProviderManager.getDefaultStreamingProvider();
  try {
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
  if (media.id === sourceMedia.id) {
    return;
  }

  const targetRecordingId = getRecordingIdForMedia(provider, media);
  const sourceRecordingId = getRecordingIdForMedia(provider, sourceMedia);
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

export async function getLyricsForProviderMedia(providerMediaId: string | number): Promise<ResolvedLyrics | null> {
  const provider = streamingProviderManager.getDefaultStreamingProvider().id;
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
    ? lyricFileToResolved(provider, lyricCandidateFile(cachedCounterpart), "shared_from_related_recording", cachedCounterpart.id)
    : null;
  if (cachedCounterpart && cachedCounterpartLyrics) {
    recordSharedLyricsRelation(provider, media, cachedCounterpart);
    return cachedCounterpartLyrics;
  }

  const exactLyrics = await fetchProviderLyrics(media.id);
  if (exactLyrics) {
    return providerLyricsToResolved(provider, exactLyrics, "exact", media.id);
  }

  for (const candidate of findSourceCandidates(media)) {
    const candidateFile = loadLyricFileForMedia(provider, candidate)
      ?? loadLyricFileForForeignRecording(nullableText(candidate.mbid));
    const candidateFileLyrics = candidateFile
      ? lyricFileToResolved(provider, candidateFile, "shared_from_related_recording", candidate.id)
      : null;
    if (candidateFileLyrics) {
      recordSharedLyricsRelation(provider, media, candidate);
      return candidateFileLyrics;
    }

    const candidateLyrics = await fetchProviderLyrics(candidate.id);
    if (candidateLyrics) {
      recordSharedLyricsRelation(provider, media, candidate);
      return providerLyricsToResolved(provider, candidateLyrics, "shared_from_related_recording", candidate.id);
    }
  }

  return null;
}
