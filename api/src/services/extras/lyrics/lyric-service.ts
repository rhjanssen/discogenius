import fs from "fs";
import { db } from "../../../database.js";
import { isSpatialAudioQuality } from "../../../utils/spatial-audio.js";
import { resolveStoredLibraryPath } from "../../library-paths.js";
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

type ProviderMediaLyricsRow = {
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
};

type CandidateRow = ProviderMediaLyricsRow & {
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
    filePath: row.FilePath,
    libraryRoot: row.LibraryRoot,
    relativePath: row.RelativePath,
  });

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const content = fs.readFileSync(resolvedPath, "utf-8");
  if (!content.trim()) {
    return null;
  }

  const extension = nullableText(row.Extension)?.toLowerCase();
  const isSynced = extension === "lrc";

  return {
    text: isSynced ? "" : content,
    subtitles: isSynced ? content : "",
    provider: row.Provider || provider,
    lyricsProvider: null,
    matchType,
    sourceProviderId: sourceProviderId ?? row.ProviderId ?? null,
    sourceFileId: row.Id,
  };
}

function loadProviderMedia(providerMediaId: string | number): ProviderMediaLyricsRow | null {
  const row = db.prepare(`
    SELECT
      CAST(id AS TEXT) AS id,
      CAST(artist_id AS TEXT) AS artist_id,
      CAST(album_id AS TEXT) AS album_id,
      title,
      track_number,
      volume_number,
      duration,
      quality,
      mbid,
      type
    FROM ProviderMedia
    WHERE CAST(id AS TEXT) = CAST(? AS TEXT)
      AND type != 'Music Video'
    LIMIT 1
  `).get(String(providerMediaId)) as ProviderMediaLyricsRow | undefined;

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

function getRecordingIdForMedia(provider: string, media: ProviderMediaLyricsRow): number | null {
  const foreignRecordingId = nullableText(media.mbid);
  if (foreignRecordingId) {
    const row = db.prepare(`
      SELECT Id
      FROM Recordings
      WHERE ForeignRecordingId = ? OR mbid = ?
      LIMIT 1
    `).get(foreignRecordingId, foreignRecordingId) as { Id?: number | null } | undefined;
    if (row?.Id != null) {
      return Number(row.Id);
    }
  }

  return getProviderItemRecordingId(provider, media.id);
}

function loadLyricFileForMedia(provider: string, media: ProviderMediaLyricsRow): LyricFileRow | null {
  return LyricFileService.findByProviderTrack(provider, media.id);
}

function loadLyricFileForForeignRecording(foreignRecordingId: string | null): LyricFileRow | null {
  if (!foreignRecordingId) {
    return null;
  }

  return LyricFileService.findByForeignRecording(foreignRecordingId);
}

function candidateScore(media: ProviderMediaLyricsRow, candidate: CandidateRow): number {
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

function sameRecordingCandidate(media: ProviderMediaLyricsRow, candidate: CandidateRow): boolean {
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

function findCachedCounterpart(media: ProviderMediaLyricsRow): LyricCandidateRow | null {
  const normalized = normalizeTitle(media.title);
  if (!normalized || !media.artist_id) {
    return null;
  }

  const rows = db.prepare(`
    SELECT
      CAST(candidate.id AS TEXT) AS id,
      CAST(candidate.artist_id AS TEXT) AS artist_id,
      CAST(candidate.album_id AS TEXT) AS album_id,
      candidate.title,
      candidate.track_number,
      candidate.volume_number,
      candidate.duration,
      candidate.quality,
      candidate.mbid,
      candidate.type,
      source_album.mb_release_group_id AS source_release_group_mbid,
      candidate_album.mb_release_group_id AS candidate_release_group_mbid,
      lf.Id AS lyric_file_id,
      lf.FilePath AS lyric_file_path,
      lf.RelativePath AS lyric_relative_path,
      lf.LibraryRoot AS lyric_library_root,
      lf.Extension AS lyric_extension,
      lf.Provider AS lyric_provider,
      lf.ProviderId AS lyric_provider_id,
      lf.CanonicalRecordingMbid AS lyric_recording_mbid
    FROM ProviderMedia candidate
    JOIN LyricFiles lf
      ON CAST(lf.MediaId AS TEXT) = CAST(candidate.id AS TEXT)
    LEFT JOIN ProviderAlbums source_album ON CAST(source_album.id AS TEXT) = CAST(? AS TEXT)
    LEFT JOIN ProviderAlbums candidate_album ON CAST(candidate_album.id AS TEXT) = CAST(candidate.album_id AS TEXT)
    WHERE CAST(candidate.artist_id AS TEXT) = CAST(? AS TEXT)
      AND CAST(candidate.id AS TEXT) != CAST(? AS TEXT)
      AND candidate.type != 'Music Video'
      AND candidate.title IS NOT NULL
  `).all(media.album_id, media.artist_id, media.id) as LyricCandidateRow[];

  return rows
    .filter((row) => sameRecordingCandidate(media, row))
    .sort((left, right) => candidateScore(media, left) - candidateScore(media, right))[0] ?? null;
}

function findSourceCandidates(media: ProviderMediaLyricsRow): CandidateRow[] {
  const normalized = normalizeTitle(media.title);
  if (!normalized || !media.artist_id) {
    return [];
  }

  const rows = db.prepare(`
    SELECT
      CAST(candidate.id AS TEXT) AS id,
      CAST(candidate.artist_id AS TEXT) AS artist_id,
      CAST(candidate.album_id AS TEXT) AS album_id,
      candidate.title,
      candidate.track_number,
      candidate.volume_number,
      candidate.duration,
      candidate.quality,
      candidate.mbid,
      candidate.type,
      source_album.mb_release_group_id AS source_release_group_mbid,
      candidate_album.mb_release_group_id AS candidate_release_group_mbid
    FROM ProviderMedia candidate
    LEFT JOIN ProviderAlbums source_album ON CAST(source_album.id AS TEXT) = CAST(? AS TEXT)
    LEFT JOIN ProviderAlbums candidate_album ON CAST(candidate_album.id AS TEXT) = CAST(candidate.album_id AS TEXT)
    WHERE CAST(candidate.artist_id AS TEXT) = CAST(? AS TEXT)
      AND CAST(candidate.id AS TEXT) != CAST(? AS TEXT)
      AND candidate.type != 'Music Video'
      AND candidate.title IS NOT NULL
  `).all(media.album_id, media.artist_id, media.id) as CandidateRow[];

  return rows
    .filter((row) => sameRecordingCandidate(media, row))
    .sort((left, right) => candidateScore(media, left) - candidateScore(media, right))
    .slice(0, 8);
}

function lyricCandidateFile(candidate: LyricCandidateRow): LyricFileRow {
  return {
    Id: candidate.lyric_file_id,
    ArtistId: candidate.artist_id || "",
    AlbumId: candidate.album_id,
    TrackFileId: null,
    MediaId: candidate.id,
    RelativePath: candidate.lyric_relative_path || candidate.lyric_file_path,
    FilePath: candidate.lyric_file_path,
    LibraryRoot: candidate.lyric_library_root || "",
    Extension: candidate.lyric_extension || "",
    Provider: candidate.lyric_provider,
    ProviderEntityType: "track",
    ProviderId: candidate.lyric_provider_id,
    LibrarySlot: "stereo",
    Quality: candidate.quality,
    CanonicalRecordingMbid: candidate.lyric_recording_mbid,
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

function recordSharedLyricsRelation(provider: string, media: ProviderMediaLyricsRow, sourceMedia: ProviderMediaLyricsRow): void {
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
      SourceRecordingId,
      TargetRecordingId,
      SourceForeignRecordingId,
      TargetForeignRecordingId,
      RelationType,
      Source,
      Confidence,
      UpdatedAt
    ) VALUES (?, ?, ?, ?, 'same_lyrical_content', 'discogenius', 0.92, CURRENT_TIMESTAMP)
  `).run(
    sourceRecordingId,
    targetRecordingId,
    sourceForeignRecordingId,
    targetForeignRecordingId,
  );
}

export async function getLyricsForProviderMedia(providerMediaId: string | number): Promise<ResolvedLyrics | null> {
  const media = loadProviderMedia(providerMediaId);
  if (!media) {
    return null;
  }

  const provider = streamingProviderManager.getDefaultStreamingProvider().id;
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
