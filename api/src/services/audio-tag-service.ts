import fs from "fs";
import * as mm from "music-metadata";
import { db } from "../database.js";
import { type MetadataConfig, type WriteAudioTagsPolicy, getConfigSection } from "./config.js";
import { writeMetadata, removeAllTags } from "./audioUtils.js";
import {
  type MusicBrainzRecording,
  type MusicBrainzRelease,
  generateFingerprint,
  lookupAcoustId,
  lookupMusicBrainzRecording,
  lookupMusicBrainzRecordingsByIsrc,
  lookupMusicBrainzReleasesByBarcode,
} from "./fingerprint.js";
import { normalizeComparableText, stringSimilarity } from "./import-matching-utils.js";
import { resolveStoredLibraryPath } from "./library-paths.js";

type RetagTrackRow = {
  id: number;
  artist_id: number;
  album_id: number | null;
  media_id: number;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  extension: string;
  file_fingerprint: string | null;
  primary_artist_name: string;
  media_title: string;
  media_version: string | null;
  media_duration: number | null;
  media_release_date: string | null;
  media_track_number: number | null;
  media_volume_number: number | null;
  media_isrc: string | null;
  media_copyright: string | null;
  media_replay_gain: number | null;
  media_peak: number | null;
  album_title: string | null;
  album_version: string | null;
  album_release_date: string | null;
  album_num_volumes: number | null;
  album_upc: string | null;
  album_review_text: string | null;
  media_credits: string | null;
  media_mbid: string | null;
  media_explicit: number | null;
  album_mbid: string | null;
  album_mb_release_group_id: string | null;
  artist_mbid: string | null;
};

type ManagedTag = {
  key: string;
  label: string;
  ffmpegKey: string;
  targetValue: string;
  aliases?: string[];
};

export type RetagDifference = {
  field: string;
  oldValue: string | null;
  newValue: string | null;
};

export type RetagPreviewItem = {
  id: number;
  artistId: number;
  albumId: number | null;
  mediaId: number;
  path: string;
  missing: boolean;
  changes: RetagDifference[];
  error?: string;
};

export type RetagStatusSummary = {
  enabled: boolean;
  total: number;
  retagNeeded: number;
  missing: number;
  sample: RetagPreviewItem[];
};

export type RetagApplyResult = {
  retagged: number;
  skipped: number;
  missing: number;
  errors: Array<{ id: number; error: string }>;
};

export type RetagScopeOptions = {
  artistId?: string;
  albumId?: string;
  limit?: number;
  offset?: number;
};

function buildFullTitle(title: string | null | undefined, version: string | null | undefined): string {
  const baseTitle = String(title || "").trim() || "Unknown Track";
  const normalizedVersion = String(version || "").trim();

  if (!normalizedVersion) {
    return baseTitle;
  }

  return baseTitle.toLowerCase().includes(normalizedVersion.toLowerCase())
    ? baseTitle
    : `${baseTitle} (${normalizedVersion})`;
}

/**
 * Resolve the effective tag write policy from config, supporting both the
 * legacy boolean `write_audio_metadata` and the new Lidarr-aligned enum
 * `write_audio_tags_policy`.
 */
function resolveTagPolicy(config: MetadataConfig): WriteAudioTagsPolicy {
  if (config.write_audio_tags_policy) return config.write_audio_tags_policy;
  return config.write_audio_metadata === true ? "all_files" : "no";
}

function isRetagMaintenanceEnabled(config: MetadataConfig): boolean {
  return resolveTagPolicy(config) !== "no" || config.embed_replaygain !== false || config.enable_fingerprinting === true;
}

function normalizeReleaseDate(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const match = raw.match(/^\d{4}(?:-\d{2}-\d{2})?/);
  return match ? match[0] : raw;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    const normalizedItems = value
      .map((item) => normalizeValue(item))
      .filter((item): item is string => Boolean(item));
    return normalizedItems.length > 0 ? normalizedItems.join(", ") : null;
  }

  if (typeof value === "object") {
    const maybePosition = value as { no?: number; of?: number; text?: unknown };
    if (typeof maybePosition.no === "number" || typeof maybePosition.of === "number") {
      const no = Number.isFinite(maybePosition.no) ? Number(maybePosition.no) : null;
      const of = Number.isFinite(maybePosition.of) ? Number(maybePosition.of) : null;
      if (no !== null && of !== null && of > 0) {
        return `${no}/${of}`;
      }
      if (no !== null) {
        return String(no);
      }
      if (of !== null && of > 0) {
        return `0/${of}`;
      }
    }

    if ("text" in maybePosition) {
      return normalizeValue(maybePosition.text);
    }

    return collapseWhitespace(String(value));
  }

  return collapseWhitespace(String(value));
}

function normalizeComparableValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = collapseWhitespace(value);
  return normalized ? normalized : null;
}

function formatPosition(no: number | null | undefined, of: number | null | undefined): string | null {
  const position = Number(no || 0);
  const total = Number(of || 0);

  if (position <= 0 && total <= 0) {
    return null;
  }

  if (total > 0) {
    return `${Math.max(position, 0)}/${total}`;
  }

  return String(position);
}

function formatReplayGain(value: number | null | undefined): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const prefix = numeric >= 0 ? "+" : "";
  return `${prefix}${numeric.toFixed(2)} dB`;
}

function formatReplayPeak(value: number | null | undefined): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return numeric.toFixed(6);
}

function normalizeIdentifier(value: string | null | undefined): string {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type FingerprintRecordingMatch = {
  recording: MusicBrainzRecording;
  titleScore: number;
  artistScore: number;
  albumScore: number;
  durationDelta: number | null;
  isrcMatch: boolean;
  score: number;
};

type MusicBrainzReleaseMatch = {
  release: MusicBrainzRelease;
  titleScore: number;
  artistScore: number;
  yearScore: number;
  score: number;
};

function evaluateFingerprintRecordingMatch(row: RetagTrackRow, recording: MusicBrainzRecording): FingerprintRecordingMatch {
  const normalizedTrackTitle = normalizeComparableText(row.media_title);
  const normalizedPrimaryArtist = normalizeComparableText(row.primary_artist_name);
  const normalizedAlbumTitle = normalizeComparableText(row.album_title || "");
  const normalizedRecordingTitle = normalizeComparableText(recording.title);
  const recordingArtistScores = recording.artists.map((artistName) => stringSimilarity(
    normalizedPrimaryArtist,
    normalizeComparableText(artistName),
  ));
  const recordingAlbumScores = recording.releaseTitles.map((releaseTitle) => stringSimilarity(
    normalizedAlbumTitle,
    normalizeComparableText(releaseTitle),
  ));
  const titleScore = normalizedTrackTitle
    ? stringSimilarity(normalizedTrackTitle, normalizedRecordingTitle)
    : 0;
  const artistScore = normalizedPrimaryArtist && recordingArtistScores.length > 0
    ? Math.max(...recordingArtistScores)
    : 0;
  const albumScore = normalizedAlbumTitle && recordingAlbumScores.length > 0
    ? Math.max(...recordingAlbumScores)
    : 0;
  const normalizedTrackIsrc = normalizeIdentifier(row.media_isrc);
  const isrcMatch = normalizedTrackIsrc.length > 0
    && recording.isrcs.some((isrc) => normalizeIdentifier(isrc) === normalizedTrackIsrc);

  const rowDuration = Number(row.media_duration || 0);
  const recordingDuration = Number(recording.durationSeconds || 0);
  const durationDelta = rowDuration > 0 && recordingDuration > 0
    ? Math.abs(rowDuration - recordingDuration)
    : null;

  let score = 0;
  if (isrcMatch) {
    score += 4;
  }

  score += titleScore * 3;
  score += artistScore * 2;
  score += albumScore;

  if (durationDelta !== null) {
    if (durationDelta <= 2) {
      score += 1;
    } else if (durationDelta <= 5) {
      score += 0.5;
    } else if (durationDelta > 12) {
      score -= 1;
    }
  }

  return {
    recording,
    titleScore,
    artistScore,
    albumScore,
    durationDelta,
    isrcMatch,
    score,
  };
}

function isAcceptableFingerprintMatch(match: FingerprintRecordingMatch): boolean {
  if (match.isrcMatch) {
    return true;
  }

  if (match.titleScore < 0.9) {
    return false;
  }

  if (match.artistScore > 0 && match.artistScore < 0.72) {
    return false;
  }

  if (match.durationDelta !== null && match.durationDelta > 10) {
    return false;
  }

  return match.score >= 4.1;
}

function evaluateMusicBrainzReleaseMatch(row: RetagTrackRow, release: MusicBrainzRelease): MusicBrainzReleaseMatch {
  const normalizedAlbumTitle = normalizeComparableText(row.album_title || "");
  const normalizedPrimaryArtist = normalizeComparableText(row.primary_artist_name);
  const normalizedReleaseTitle = normalizeComparableText(release.title);
  const titleScore = normalizedAlbumTitle
    ? stringSimilarity(normalizedAlbumTitle, normalizedReleaseTitle)
    : 0;
  const artistScore = normalizedPrimaryArtist && release.artistCredits.length > 0
    ? Math.max(...release.artistCredits.map((credit) => stringSimilarity(
      normalizedPrimaryArtist,
      normalizeComparableText(credit.name),
    )))
    : 0;

  const currentYear = normalizeReleaseDate(row.album_release_date || row.media_release_date)?.slice(0, 4) || "";
  const releaseYear = String(release.date || "").slice(0, 4);
  const yearScore = currentYear && releaseYear
    ? (currentYear === releaseYear ? 1 : 0)
    : 0;

  let score = titleScore * 3 + artistScore * 2 + yearScore;
  if (normalizeIdentifier(row.album_upc) && normalizeIdentifier(release.barcode) === normalizeIdentifier(row.album_upc)) {
    score += 3;
  }

  return {
    release,
    titleScore,
    artistScore,
    yearScore,
    score,
  };
}

function isAcceptableReleaseMatch(match: MusicBrainzReleaseMatch): boolean {
  if (match.titleScore < 0.85) {
    return false;
  }

  if (match.artistScore > 0 && match.artistScore < 0.72) {
    return false;
  }

  return match.score >= 4.2;
}

function buildNativeTagAliases(rawId: string): string[] {
  const normalized = rawId.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const aliases = new Set<string>([normalized]);
  if (normalized.startsWith("txxx:")) {
    aliases.add(normalized.slice(5));
  }
  if (normalized.startsWith("----:com.apple.itunes:")) {
    aliases.add(normalized.slice("----:com.apple.itunes:".length));
  }
  if (normalized.startsWith("com.apple.itunes:")) {
    aliases.add(normalized.slice("com.apple.itunes:".length));
  }
  if (normalized.includes(":")) {
    aliases.add(normalized.split(":").pop() || normalized);
  }

  return Array.from(aliases);
}

function buildNativeLookup(metadata: mm.IAudioMetadata): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const tagSet of Object.values(metadata.native || {})) {
    for (const tag of tagSet as Array<{ id?: string; value?: unknown }>) {
      const value = normalizeValue(tag?.value);
      if (!value) {
        continue;
      }

      for (const alias of buildNativeTagAliases(String(tag?.id || ""))) {
        if (!lookup.has(alias)) {
          lookup.set(alias, value);
        }
      }
    }
  }

  return lookup;
}

function getLookupValue(lookup: Map<string, string>, aliases: string[]): string | null {
  for (const alias of aliases) {
    const value = lookup.get(alias.toLowerCase());
    if (value) {
      return value;
    }
  }

  return null;
}

function getCurrentTagValue(metadata: mm.IAudioMetadata, lookup: Map<string, string>, tag: ManagedTag): string | null {
  const common = metadata.common as Record<string, any>;

  switch (tag.key) {
    case "title":
      return normalizeValue(common.title);
    case "artist":
      return normalizeValue(common.artist || common.artists);
    case "album_artist":
      return normalizeValue(common.albumartist || common.albumartists);
    case "album":
      return normalizeValue(common.album);
    case "track":
      return formatPosition(common.track?.no ?? null, common.track?.of ?? null);
    case "disc":
      return formatPosition(common.disk?.no ?? null, common.disk?.of ?? null);
    case "date":
      return normalizeReleaseDate(common.date || (common.year ? String(common.year) : null));
    case "isrc":
      return normalizeValue(common.isrc);
    case "copyright":
      return normalizeValue(common.copyright);
    default:
      return getLookupValue(lookup, [tag.ffmpegKey, ...(tag.aliases || [])]);
  }
}

export class AudioTagService {
  private static getTrackCount(options: RetagScopeOptions = {}): number {
    const where: string[] = ["lf.file_type = 'track'"];
    const params: Array<string> = [];

    if (options.artistId) {
      where.push("lf.artist_id = ?");
      params.push(options.artistId);
    }
    if (options.albumId) {
      where.push("lf.album_id = ?");
      params.push(options.albumId);
    }

    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM library_files lf
      WHERE ${where.join(" AND ")}
    `).get(...params) as { count?: number } | undefined;

    return Number(row?.count || 0);
  }

  private static getTrackRows(options: RetagScopeOptions = {}, includePaging = true): RetagTrackRow[] {
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;
    const where: string[] = ["lf.file_type = 'track'"];
    const params: Array<string | number> = [];

    if (options.artistId) {
      where.push("lf.artist_id = ?");
      params.push(options.artistId);
    }
    if (options.albumId) {
      where.push("lf.album_id = ?");
      params.push(options.albumId);
    }

    const sql = `
      SELECT
        lf.id,
        lf.artist_id,
        lf.album_id,
        lf.media_id,
        lf.file_path,
        lf.relative_path,
        lf.library_root,
        lf.extension,
        lf.fingerprint AS file_fingerprint,
        artist.name AS primary_artist_name,
        m.title AS media_title,
        m.version AS media_version,
        m.duration AS media_duration,
        m.release_date AS media_release_date,
        m.track_number AS media_track_number,
        m.volume_number AS media_volume_number,
        m.isrc AS media_isrc,
        m.copyright AS media_copyright,
        m.replay_gain AS media_replay_gain,
        m.peak AS media_peak,
        a.title AS album_title,
        a.version AS album_version,
        a.release_date AS album_release_date,
        a.num_volumes AS album_num_volumes,
        a.upc AS album_upc,
        a.review_text AS album_review_text,
        m.credits AS media_credits,
        m.mbid AS media_mbid,
        m.explicit AS media_explicit,
        a.mbid AS album_mbid,
        a.mb_release_group_id AS album_mb_release_group_id,
        artist.mbid AS artist_mbid
      FROM library_files lf
      JOIN media m ON m.id = lf.media_id
      LEFT JOIN albums a ON a.id = lf.album_id
      JOIN artists artist ON artist.id = lf.artist_id
      WHERE ${where.join(" AND ")}
      ORDER BY lf.artist_id, lf.album_id, COALESCE(m.volume_number, 1), COALESCE(m.track_number, 0), lf.id
      ${includePaging ? "LIMIT ? OFFSET ?" : ""}
    `;

    if (includePaging) {
      params.push(limit, offset);
    }

    return db.prepare(sql).all(...params) as RetagTrackRow[];
  }

  private static getTrackRowsByIds(ids: number[]): RetagTrackRow[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(",");
    return db.prepare(`
      SELECT
        lf.id,
        lf.artist_id,
        lf.album_id,
        lf.media_id,
        lf.file_path,
        lf.relative_path,
        lf.library_root,
        lf.extension,
        lf.fingerprint AS file_fingerprint,
        artist.name AS primary_artist_name,
        m.title AS media_title,
        m.version AS media_version,
        m.duration AS media_duration,
        m.release_date AS media_release_date,
        m.track_number AS media_track_number,
        m.volume_number AS media_volume_number,
        m.isrc AS media_isrc,
        m.copyright AS media_copyright,
        m.replay_gain AS media_replay_gain,
        m.peak AS media_peak,
        a.title AS album_title,
        a.version AS album_version,
        a.release_date AS album_release_date,
        a.num_volumes AS album_num_volumes,
        a.upc AS album_upc,
        a.review_text AS album_review_text,
        m.credits AS media_credits,
        m.mbid AS media_mbid,
        m.explicit AS media_explicit,
        a.mbid AS album_mbid,
        a.mb_release_group_id AS album_mb_release_group_id,
        artist.mbid AS artist_mbid
      FROM library_files lf
      JOIN media m ON m.id = lf.media_id
      LEFT JOIN albums a ON a.id = lf.album_id
      JOIN artists artist ON artist.id = lf.artist_id
      WHERE lf.id IN (${placeholders})
      ORDER BY lf.artist_id, lf.album_id, COALESCE(m.volume_number, 1), COALESCE(m.track_number, 0), lf.id
    `).all(...ids) as RetagTrackRow[];
  }

  private static getTrackArtistNames(mediaId: number, fallbackArtistName: string): string[] {
    const rows = db.prepare(`
      SELECT DISTINCT artist.name
      FROM media_artists ma
      JOIN artists artist ON artist.id = ma.artist_id
      WHERE ma.media_id = ?
      ORDER BY CASE ma.type WHEN 'MAIN' THEN 0 WHEN 'ARTIST' THEN 0 WHEN 'FEATURED' THEN 1 ELSE 2 END, artist.name
    `).all(mediaId) as Array<{ name?: string }>;

    const names = rows.map((row) => String(row.name || "").trim()).filter(Boolean);
    return names.length > 0 ? names : [fallbackArtistName];
  }

  private static getAlbumArtistNames(albumId: number | null, fallbackArtistName: string): string[] {
    if (!albumId) {
      return [fallbackArtistName];
    }

    const rows = db.prepare(`
      SELECT DISTINCT artist.name
      FROM album_artists aa
      JOIN artists artist ON artist.id = aa.artist_id
      WHERE aa.album_id = ?
      ORDER BY COALESCE(aa.ord, 9999), artist.name
    `).all(albumId) as Array<{ name?: string }>;

    const names = rows.map((row) => String(row.name || "").trim()).filter(Boolean);
    return names.length > 0 ? names : [fallbackArtistName];
  }

  private static getTrackCountForDisc(albumId: number | null, volumeNumber: number): number | null {
    if (!albumId) {
      return null;
    }

    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM media
      WHERE album_id = ?
        AND type != 'Music Video'
        AND COALESCE(volume_number, 1) = ?
    `).get(albumId, volumeNumber) as { count?: number } | undefined;

    const count = Number(row?.count || 0);
    return count > 0 ? count : null;
  }

  private static async enrichMusicBrainzMetadata(row: RetagTrackRow, config: MetadataConfig): Promise<RetagTrackRow> {
    let nextRow = { ...row };

    if (nextRow.album_upc && (!nextRow.album_mbid || !nextRow.album_mb_release_group_id || !nextRow.artist_mbid)) {
      const releases = await lookupMusicBrainzReleasesByBarcode(nextRow.album_upc);
      let bestReleaseMatch: MusicBrainzReleaseMatch | null = null;

      for (const release of releases) {
        const candidate = evaluateMusicBrainzReleaseMatch(nextRow, release);
        if (!isAcceptableReleaseMatch(candidate)) {
          continue;
        }

        if (!bestReleaseMatch || candidate.score > bestReleaseMatch.score) {
          bestReleaseMatch = candidate;
        }
      }

      if (bestReleaseMatch) {
        const primaryArtistCredit = bestReleaseMatch.release.artistCredits[0];
        db.prepare(`
          UPDATE albums
          SET mbid = COALESCE(mbid, ?),
              mb_release_group_id = COALESCE(mb_release_group_id, ?)
          WHERE id = ?
        `).run(bestReleaseMatch.release.id, bestReleaseMatch.release.releaseGroupId, nextRow.album_id);

        if (primaryArtistCredit?.id) {
          db.prepare(`
            UPDATE artists
            SET mbid = COALESCE(mbid, ?)
            WHERE id = ?
          `).run(primaryArtistCredit.id, nextRow.artist_id);
        }

        nextRow = {
          ...nextRow,
          album_mbid: nextRow.album_mbid || bestReleaseMatch.release.id,
          album_mb_release_group_id: nextRow.album_mb_release_group_id || bestReleaseMatch.release.releaseGroupId,
          artist_mbid: nextRow.artist_mbid || primaryArtistCredit?.id || null,
        };
      }
    }

    if (nextRow.media_isrc && !nextRow.media_mbid) {
      const recordings = await lookupMusicBrainzRecordingsByIsrc(nextRow.media_isrc);
      let bestIsrcMatch: FingerprintRecordingMatch | null = null;

      for (const recording of recordings) {
        const candidate = evaluateFingerprintRecordingMatch(nextRow, recording);
        if (!isAcceptableFingerprintMatch(candidate)) {
          continue;
        }

        if (!bestIsrcMatch || candidate.score > bestIsrcMatch.score) {
          bestIsrcMatch = candidate;
        }
      }

      if (bestIsrcMatch) {
        const primaryArtistCredit = bestIsrcMatch.recording.artistCredits?.[0];
        db.prepare(`
          UPDATE media
          SET mbid = COALESCE(mbid, ?)
          WHERE id = ?
        `).run(bestIsrcMatch.recording.id, nextRow.media_id);

        if (primaryArtistCredit?.id) {
          db.prepare(`
            UPDATE artists
            SET mbid = COALESCE(mbid, ?)
            WHERE id = ?
          `).run(primaryArtistCredit.id, nextRow.artist_id);
        }

        nextRow = {
          ...nextRow,
          media_mbid: bestIsrcMatch.recording.id,
          artist_mbid: nextRow.artist_mbid || primaryArtistCredit?.id || null,
        };
      }
    }

    if (!config.enable_fingerprinting) {
      return nextRow;
    }

    const resolvedPath = resolveStoredLibraryPath({
      filePath: nextRow.file_path,
      libraryRoot: nextRow.library_root,
      relativePath: nextRow.relative_path,
    });

    if (!fs.existsSync(resolvedPath)) {
      return nextRow;
    }

    let fingerprint = nextRow.file_fingerprint;
    let fingerprintDuration = Number(nextRow.media_duration || 0) || null;

    if (!fingerprint) {
      try {
        const fingerprintResult = await generateFingerprint(resolvedPath);
        fingerprint = fingerprintResult.fingerprint;
        fingerprintDuration = fingerprintResult.duration || fingerprintDuration;

        db.prepare(`
          UPDATE library_files
          SET fingerprint = ?, verified_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(fingerprint, nextRow.id);
      } catch (error) {
        console.warn(`[Retag] Failed to fingerprint ${resolvedPath}:`, error);
        return nextRow;
      }
    }

    if (nextRow.media_mbid || !fingerprint || !fingerprintDuration) {
      return {
        ...nextRow,
        file_fingerprint: fingerprint,
        media_duration: fingerprintDuration ?? nextRow.media_duration,
      };
    }

    let bestFingerprintMatch: FingerprintRecordingMatch | null = null;
    const recordingIds = await lookupAcoustId(fingerprint, fingerprintDuration);
    for (const recordingId of recordingIds.slice(0, 5)) {
      const recording = await lookupMusicBrainzRecording(recordingId);
      if (!recording) {
        continue;
      }

      const candidate = evaluateFingerprintRecordingMatch(nextRow, recording);
      if (!isAcceptableFingerprintMatch(candidate)) {
        continue;
      }

      if (!bestFingerprintMatch || candidate.score > bestFingerprintMatch.score) {
        bestFingerprintMatch = candidate;
      }
    }

    if (!bestFingerprintMatch) {
      return {
        ...nextRow,
        file_fingerprint: fingerprint,
        media_duration: fingerprintDuration ?? nextRow.media_duration,
      };
    }

    const fallbackIsrc = !nextRow.media_isrc && bestFingerprintMatch.recording.isrcs.length > 0
      ? bestFingerprintMatch.recording.isrcs[0]
      : null;
    const primaryArtistCredit = bestFingerprintMatch.recording.artistCredits?.[0];

    db.prepare(`
      UPDATE media
      SET mbid = COALESCE(mbid, ?),
          isrc = COALESCE(isrc, ?)
      WHERE id = ?
    `).run(bestFingerprintMatch.recording.id, fallbackIsrc, nextRow.media_id);

    if (primaryArtistCredit?.id) {
      db.prepare(`
        UPDATE artists
        SET mbid = COALESCE(mbid, ?)
        WHERE id = ?
      `).run(primaryArtistCredit.id, nextRow.artist_id);
    }

    return {
      ...nextRow,
      file_fingerprint: fingerprint,
      media_duration: fingerprintDuration ?? nextRow.media_duration,
      media_mbid: bestFingerprintMatch.recording.id,
      media_isrc: nextRow.media_isrc || fallbackIsrc,
      artist_mbid: nextRow.artist_mbid || primaryArtistCredit?.id || null,
    };
  }

  private static buildDesiredTags(row: RetagTrackRow, config: MetadataConfig): ManagedTag[] {
    const fallbackArtistName = String(row.primary_artist_name || "").trim() || "Unknown Artist";
    const artistNames = this.getTrackArtistNames(row.media_id, fallbackArtistName);
    const albumArtistNames = this.getAlbumArtistNames(row.album_id, fallbackArtistName);
    const discNumber = Number(row.media_volume_number || 1);
    const discCount = Number(row.album_num_volumes || 1);
    const trackCount = this.getTrackCountForDisc(row.album_id, discNumber);
    const releaseDate = normalizeReleaseDate(row.media_release_date || row.album_release_date);

    const tags: ManagedTag[] = [];

    if (resolveTagPolicy(config) !== "no") {
      tags.push(
        {
          key: "title",
          label: "Title",
          ffmpegKey: "title",
          targetValue: buildFullTitle(row.media_title, row.media_version),
        },
        {
          key: "artist",
          label: "Artist",
          ffmpegKey: "artist",
          targetValue: artistNames.join(", "),
        },
        {
          key: "album_artist",
          label: "Album Artist",
          ffmpegKey: "album_artist",
          targetValue: albumArtistNames.join(", "),
        },
        {
          key: "album",
          label: "Album",
          ffmpegKey: "album",
          targetValue: buildFullTitle(row.album_title || "Unknown Album", row.album_version),
        },
      );

      const trackPosition = formatPosition(row.media_track_number, trackCount);
      if (trackPosition) {
        tags.push({
          key: "track",
          label: "Track",
          ffmpegKey: "track",
          targetValue: trackPosition,
        });
      }

      const discPosition = formatPosition(discNumber, discCount);
      if (discPosition) {
        tags.push({
          key: "disc",
          label: "Disc",
          ffmpegKey: "disc",
          targetValue: discPosition,
        });
      }

      if (releaseDate) {
        tags.push({
          key: "date",
          label: "Date",
          ffmpegKey: "date",
          targetValue: releaseDate,
        });
      }

      if (row.media_isrc) {
        tags.push({
          key: "isrc",
          label: "ISRC",
          ffmpegKey: "isrc",
          targetValue: String(row.media_isrc),
        });
      }

      if (row.media_copyright) {
        tags.push({
          key: "copyright",
          label: "Copyright",
          ffmpegKey: "copyright",
          targetValue: String(row.media_copyright),
        });
      }

      if (row.album_upc) {
        tags.push({
          key: "barcode",
          label: config.upc_target,
          ffmpegKey: config.upc_target,
          targetValue: String(row.album_upc),
          aliases: ["barcode", "upc", "ean"],
        });
      }

      if (config.write_tidal_url) {
        tags.push({
          key: "tidal_url",
          label: "TIDAL URL",
          ffmpegKey: "TIDAL_URL",
          targetValue: `https://listen.tidal.com/track/${row.media_id}`,
          aliases: ["tidal_url", "url", "purl"],
        });
      }

      if (row.media_mbid) {
        tags.push({
          key: "musicbrainz_recordingid",
          label: "MusicBrainz Recording ID",
          ffmpegKey: "musicbrainz_recordingid",
          targetValue: String(row.media_mbid),
          aliases: [
            "musicbrainz_recordingid",
            "musicbrainzrecordingid",
            "musicbrainz recording id",
            "musicbrainz_trackid",
            "musicbrainztrackid",
          ],
        });
      }

      if (row.album_mbid) {
        tags.push({
          key: "musicbrainz_albumid",
          label: "MusicBrainz Release ID",
          ffmpegKey: "musicbrainz_albumid",
          targetValue: String(row.album_mbid),
          aliases: ["musicbrainz_albumid", "musicbrainzalbumid", "musicbrainz album id"],
        });
      }

      if (row.artist_mbid) {
        tags.push({
          key: "musicbrainz_albumartistid",
          label: "MusicBrainz Album Artist ID",
          ffmpegKey: "musicbrainz_albumartistid",
          targetValue: String(row.artist_mbid),
          aliases: ["musicbrainz_albumartistid", "musicbrainzalbumartistid", "musicbrainz album artist id"],
        });
        tags.push({
          key: "musicbrainz_artistid",
          label: "MusicBrainz Artist ID",
          ffmpegKey: "musicbrainz_artistid",
          targetValue: String(row.artist_mbid),
          aliases: ["musicbrainz_artistid", "musicbrainzartistid", "musicbrainz artist id"],
        });
      }

      if (row.album_mb_release_group_id) {
        tags.push({
          key: "musicbrainz_releasegroupid",
          label: "MusicBrainz Release Group ID",
          ffmpegKey: "musicbrainz_releasegroupid",
          targetValue: String(row.album_mb_release_group_id),
          aliases: ["musicbrainz_releasegroupid", "musicbrainzreleasegroupid", "musicbrainz release group id"],
        });
      }

      if (row.media_explicit !== null && row.media_explicit !== undefined) {
        tags.push({
          key: "itunesadvisory",
          label: "iTunes Advisory",
          ffmpegKey: "ITUNESADVISORY",
          targetValue: String(Number(row.media_explicit) ? 1 : 0),
          aliases: ["itunesadvisory", "rtng", "rating"],
        });
      }

      if (config.embed_album_review && row.album_review_text) {
        const reviewText = row.album_review_text.length > 4096
          ? row.album_review_text.slice(0, 4093) + "..."
          : row.album_review_text;
        tags.push({
          key: "comment",
          label: "Comment (Album Review)",
          ffmpegKey: "comment",
          targetValue: reviewText,
          aliases: ["comment", "\xa9cmt"],
        });
      }

      // Role credits (Vocalist, Composer, Producer, etc.) — same convention as Orpheus.
      if (row.media_credits) {
        try {
          const credits = JSON.parse(row.media_credits) as Array<{ type?: unknown; contributors?: Array<{ name?: unknown }> }>;
          for (const credit of credits) {
            const role = String(credit.type || "").trim().replace(/[:\\/*?"<>|$]/g, "");
            if (!role) continue;
            const contributors = (credit.contributors ?? [])
              .map((c) => String(c.name || "").trim())
              .filter(Boolean)
              .join(", ");
            if (!contributors) continue;
            tags.push({
              key: `credit_${role.toLowerCase()}`,
              label: role,
              ffmpegKey: role,
              targetValue: contributors,
            });
          }
        } catch {
          // malformed credits JSON — skip silently
        }
      }
    }

    if (config.embed_replaygain) {
      const replayGain = formatReplayGain(row.media_replay_gain);
      if (replayGain) {
        tags.push({
          key: "replaygain_track_gain",
          label: "ReplayGain Track Gain",
          ffmpegKey: "REPLAYGAIN_TRACK_GAIN",
          targetValue: replayGain,
          aliases: ["replaygain_track_gain"],
        });
      }

      const replayPeak = formatReplayPeak(row.media_peak);
      if (replayPeak) {
        tags.push({
          key: "replaygain_track_peak",
          label: "ReplayGain Track Peak",
          ffmpegKey: "REPLAYGAIN_TRACK_PEAK",
          targetValue: replayPeak,
          aliases: ["replaygain_track_peak"],
        });
      }
    }

    return tags.filter((tag) => Boolean(normalizeComparableValue(tag.targetValue)));
  }

  private static async evaluateRow(row: RetagTrackRow, config: MetadataConfig): Promise<RetagPreviewItem> {
    const resolvedPath = resolveStoredLibraryPath({
      filePath: row.file_path,
      libraryRoot: row.library_root,
      relativePath: row.relative_path,
    });

    if (!fs.existsSync(resolvedPath)) {
      return {
        id: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        path: resolvedPath,
        missing: true,
        changes: [],
      };
    }

    const desiredTags = this.buildDesiredTags(row, config);
    if (desiredTags.length === 0) {
      return {
        id: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        path: resolvedPath,
        missing: false,
        changes: [],
      };
    }

    try {
      const metadata = await mm.parseFile(resolvedPath, { skipCovers: true, duration: false });
      const lookup = buildNativeLookup(metadata);
      const changes = desiredTags.reduce<RetagDifference[]>((result, tag) => {
        const currentValue = getCurrentTagValue(metadata, lookup, tag);
        if (normalizeComparableValue(currentValue) !== normalizeComparableValue(tag.targetValue)) {
          result.push({
            field: tag.label,
            oldValue: currentValue,
            newValue: tag.targetValue,
          });
        }
        return result;
      }, []);

      return {
        id: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        path: resolvedPath,
        missing: false,
        changes,
      };
    } catch (error) {
      return {
        id: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        path: resolvedPath,
        missing: false,
        error: error instanceof Error ? error.message : "Metadata read failed",
        changes: [{
          field: "Metadata",
          oldValue: "Unreadable",
          newValue: "Re-tag file",
        }],
      };
    }
  }

  private static async evaluateRows(rows: RetagTrackRow[], config: MetadataConfig): Promise<RetagPreviewItem[]> {
    const results: RetagPreviewItem[] = [];

    for (const row of rows) {
      results.push(await this.evaluateRow(row, config));
    }

    return results;
  }

  static async preview(options: RetagScopeOptions = {}): Promise<RetagPreviewItem[]> {
    const config = getConfigSection("metadata") as MetadataConfig;
    if (!isRetagMaintenanceEnabled(config)) {
      return [];
    }

    const rows = this.getTrackRows(options, true);
    const items = await this.evaluateRows(rows, config);
    return items.filter((item) => item.missing || item.changes.length > 0);
  }

  static async getStatus(options: RetagScopeOptions = {}, sampleLimit = 10): Promise<RetagStatusSummary> {
    const config = getConfigSection("metadata") as MetadataConfig;
    const total = this.getTrackCount(options);

    if (!isRetagMaintenanceEnabled(config)) {
      return {
        enabled: false,
        total,
        retagNeeded: 0,
        missing: 0,
        sample: [],
      };
    }

    const items = await this.evaluateRows(this.getTrackRows(options, false), config);
    const actionable = items.filter((item) => item.missing || item.changes.length > 0);

    return {
      enabled: true,
      total,
      retagNeeded: actionable.filter((item) => !item.missing && item.changes.length > 0).length,
      missing: items.filter((item) => item.missing).length,
      sample: actionable.slice(0, Math.max(0, sampleLimit)),
    };
  }

  static async apply(ids: number[]): Promise<RetagApplyResult> {
    const config = getConfigSection("metadata") as MetadataConfig;
    if (!isRetagMaintenanceEnabled(config)) {
      throw new Error("Enable fingerprinting, imported audio tag correction, or ReplayGain tagging before applying retag operations.");
    }

    const result: RetagApplyResult = {
      retagged: 0,
      skipped: 0,
      missing: 0,
      errors: [],
    };

    if (!ids || ids.length === 0) {
      return result;
    }

    const rowsById = new Map(this.getTrackRowsByIds(ids).map((row) => [row.id, row]));
    const updateFileRecord = db.prepare(`
      UPDATE library_files
      SET file_size = ?, modified_at = ?, verified_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const pendingUpdates: Array<[number, string, number]> = []; // [size, mtime, id]

    for (const id of ids) {
      const row = rowsById.get(id);
      if (!row) {
        result.skipped++;
        continue;
      }

      const enrichedRow = await this.enrichMusicBrainzMetadata(row, config);

      const resolvedPath = resolveStoredLibraryPath({
        filePath: enrichedRow.file_path,
        libraryRoot: enrichedRow.library_root,
        relativePath: enrichedRow.relative_path,
      });

      if (!fs.existsSync(resolvedPath)) {
        result.missing++;
        continue;
      }

      const preview = await this.evaluateRow(enrichedRow, config);
      if (!preview.missing && preview.changes.length === 0) {
        result.skipped++;
        continue;
      }

      const desiredTags = Object.fromEntries(
        this.buildDesiredTags(enrichedRow, config).map((tag) => [tag.ffmpegKey, tag.targetValue]),
      );

      // Scrub all existing tags before writing (Lidarr's ScrubAudioTags)
      if (config.scrub_audio_tags) {
        const scrubbed = await removeAllTags(resolvedPath);
        if (!scrubbed) {
          result.errors.push({ id, error: "Tag scrub failed" });
          continue;
        }
      }

      const success = await writeMetadata(resolvedPath, desiredTags);
      if (!success) {
        result.errors.push({ id, error: "Metadata write failed" });
        continue;
      }

      const stat = fs.statSync(resolvedPath);
      pendingUpdates.push([stat.size, stat.mtime.toISOString(), id]);
      result.retagged++;
    }

    // Commit all DB updates in a single transaction
    if (pendingUpdates.length > 0) {
      db.transaction(() => {
        for (const [size, mtime, id] of pendingUpdates) {
          updateFileRecord.run(size, mtime, id);
        }
      })();
    }

    return result;
  }

  static async applyForMediaIds(mediaIds: Array<string | number>): Promise<RetagApplyResult> {
    const uniqueMediaIds = Array.from(new Set(mediaIds.map((id) => String(id).trim()).filter(Boolean)));
    if (uniqueMediaIds.length === 0) {
      return {
        retagged: 0,
        skipped: 0,
        missing: 0,
        errors: [],
      };
    }

    const placeholders = uniqueMediaIds.map(() => "?").join(",");
    const libraryFileIds = db.prepare(`
      SELECT id
      FROM library_files
      WHERE file_type = 'track'
        AND media_id IN (${placeholders})
    `).all(...uniqueMediaIds) as Array<{ id: number }>;

    return this.apply(libraryFileIds.map((row) => row.id));
  }

  static async applyByQuery(options: RetagScopeOptions = {}): Promise<RetagApplyResult> {
    const config = getConfigSection("metadata") as MetadataConfig;
    if (!isRetagMaintenanceEnabled(config)) {
      throw new Error("Enable fingerprinting, imported audio tag correction, or ReplayGain tagging before applying retag operations.");
    }

    const items = await this.evaluateRows(this.getTrackRows(options, false), config);
    const ids = items
      .filter((item) => !item.missing && item.changes.length > 0)
      .map((item) => item.id);

    return this.apply(ids);
  }
}
