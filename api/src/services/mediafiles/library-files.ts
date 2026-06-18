import fs from "fs";
import path from "path";
import { db, batchDelete, batchRun } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { getNamingConfig, renderFileStem, renderRelativePath, resolveArtistFolderFromRecord, type NamingContext, type library_root } from "../config/naming.js";
import { getCurrentLibraryRootPath, resolveLibraryRootKey, resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import { normalizeComparablePath, normalizeResolvedPath } from "./path-utils.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../jobs/history-events.js";
import { emitFileAdded, emitFileDeleted, emitFileUpgraded } from "../jobs/app-events.js";
import { resolveLibraryFileIdentity, type library_slot } from "./library-file-identity.js";
import { resolveCanonicalTrackPosition } from "../metadata/canonical-track-position.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { renderAudioRelativePathForLibrary } from "./audio-library-path.js";
import { getCanonicalAlbumMetadata } from "../metadata/canonical-album-metadata.js";
import { ExtraFileService, isExtraFileType, isLyricExtraFileType, isMetadataExtraFileType } from "../extras/files/extra-file-service.js";
import { LyricFileService } from "../extras/lyrics/lyric-file-service.js";
import { MetadataFileService } from "../extras/metadata/files/metadata-file-service.js";

type LibraryFileRow = {
  id: number;
  artist_id: number;
  album_id: number | null;
  media_id: number | null;
  canonical_artist_mbid?: string | null;
  canonical_release_group_mbid?: string | null;
  canonical_release_mbid?: string | null;
  canonical_track_mbid?: string | null;
  canonical_recording_mbid?: string | null;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  file_type: string;
  extension: string;
  library_slot?: string | null;
  provider?: string | null;
  provider_entity_type?: string | null;
  provider_id?: string | null;
  // Quality metadata
  quality?: string | null;
  codec?: string | null;
  bitrate?: number | null;
  sample_rate?: number | null;
  bit_depth?: number | null;
  channels?: number | null;
};

type TrackedAssetRow = LibraryFileRow & {
  relative_path: string | null;
  library_root: string;
  expected_path: string | null;
  verified_at: string | null;
  modified_at: string | null;
  created_at: string | null;
};

type ExistingLibraryFileIdentity = {
  id: number;
  artist_id: number;
  album_id: number | null;
  media_id: number | null;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  file_type: string;
  quality: string | null;
};

type CanonicalVideoLookupRow = {
  mbid: string | null;
  title: string | null;
  is_video: number | null;
  metadata_status: string | null;
};

type CanonicalTrackLookupRow = {
  mbid: string;
  title: string | null;
  position: number | null;
  medium_position: number | null;
  recording_mbid: string | null;
  recording_title: string | null;
  recording_artist_mbid: string | null;
};

function getCanonicalIdentityForLibraryFile(row: LibraryFileRow): ReturnType<typeof resolveLibraryFileIdentity> {
  return resolveLibraryFileIdentity({
    artistId: row.artist_id,
    albumId: row.album_id,
    mediaId: row.media_id,
    fileType: row.file_type,
    quality: row.quality,
    libraryRoot: row.library_root,
    librarySlot: row.library_slot,
    provider: row.provider,
    providerEntityType: row.provider_entity_type,
    providerId: row.provider_id,
    canonicalArtistMbid: row.canonical_artist_mbid,
    canonicalReleaseGroupMbid: row.canonical_release_group_mbid,
    canonicalReleaseMbid: row.canonical_release_mbid,
    canonicalTrackMbid: row.canonical_track_mbid,
    canonicalRecordingMbid: row.canonical_recording_mbid,
  });
}

function getCanonicalVideoMetadataByMbid(recordingMbid: string | null | undefined): CanonicalVideoLookupRow | null {
  const mbid = String(recordingMbid || "").trim();
  if (!mbid) {
    return null;
  }

  return (db.prepare(`
    SELECT mbid,
           title,
           is_video AS is_video,
           metadata_status AS metadata_status
    FROM Recordings
    WHERE mbid = ?
      AND is_video = 1
    LIMIT 1
  `).get(mbid) as CanonicalVideoLookupRow | undefined) ?? null;
}

function getCanonicalVideoMetadataForRow(row: LibraryFileRow, recordingMbid: string | null | undefined): CanonicalVideoLookupRow | null {
  const byMbid = getCanonicalVideoMetadataByMbid(recordingMbid);
  if (byMbid) {
    return byMbid;
  }

  const provider = String(row.provider || "").trim();
  const providerId = String(row.provider_id || row.media_id || "").trim();
  if (!providerId) {
    return null;
  }

  const providerClause = provider ? "pi.provider = ? AND" : "";
  const params = provider ? [provider, providerId] : [providerId];
  return (db.prepare(`
    SELECT recording.mbid,
           recording.title,
           recording.is_video AS is_video,
           recording.metadata_status AS metadata_status
    FROM ProviderItems pi
    JOIN Recordings recording ON recording.id = pi.recording_id
    WHERE ${providerClause}
      pi.entity_type = 'video'
      AND pi.provider_id = ?
      AND recording.is_video = 1
    ORDER BY pi.updated_at DESC
    LIMIT 1
  `).get(...params) as CanonicalVideoLookupRow | undefined) ?? null;
}

function getCanonicalTrackMetadata(trackMbid: string | null | undefined): CanonicalTrackLookupRow | null {
  const mbid = String(trackMbid || "").trim();
  if (!mbid) {
    return null;
  }

  return (db.prepare(`
    SELECT t.mbid,
           t.title,
           t.position,
           t.medium_position,
           t.recording_mbid,
           r.title AS recording_title,
           r.artist_mbid AS recording_artist_mbid
    FROM Tracks t
    LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
    WHERE t.mbid = ?
    LIMIT 1
  `).get(mbid) as CanonicalTrackLookupRow | undefined) ?? null;
}

export type RenamePreviewItem = {
  id: number;
  file_type: string;
  library_root: string;
  artist_id: number;
  album_id: number | null;
  media_id: number | null;
  file_path: string;
  expected_path: string | null;
  needs_rename: boolean;
  conflict: boolean;
  missing: boolean;
  reason?: string;
};

export type RenameApplyResult = {
  renamed: number;
  skipped: number;
  conflicts: number;
  missing: number;
  cleanedDirectories: number;
  errors: Array<{ id: number; error: string }>;
};

export type RenameScopeOptions = {
  artistId?: string;
  albumId?: string;
  libraryRoot?: string;
  fileTypes?: string[];
  limit?: number;
  offset?: number;
};

export type RenameStatusSummary = {
  total: number;
  renameNeeded: number;
  conflicts: number;
  missing: number;
  sample: RenamePreviewItem[];
};

type LibraryFileEventInput = {
  libraryFileId?: number | null;
  artistId: string | number;
  albumId?: string | number | null;
  mediaId?: string | number | null;
  fileType: string;
  filePath: string;
  libraryRoot?: string | null;
  quality?: string | null;
  previousPath?: string | null;
  previousQuality?: string | null;
  reason?: string | null;
  missing?: boolean;
};

export type LibraryFileUpsertParams = {
  artistId: string;
  albumId?: string | null;
  mediaId?: string | null;
  filePath: string;
  libraryRoot: string;
  fileType: "track" | "video" | "cover" | "video_cover" | "video_thumbnail" | "nfo" | "lyrics" | string;
  quality?: string | null;
  namingTemplate?: string | null;
  expectedPath?: string | null;
  bitDepth?: number | null;
  sampleRate?: number | null;
  bitrate?: number | null;
  codec?: string | null;
  channels?: number | null;
  fingerprint?: string | null;
  removeFromUnmapped?: boolean;
  canonicalArtistMbid?: string | null;
  canonicalReleaseGroupMbid?: string | null;
  canonicalReleaseMbid?: string | null;
  canonicalTrackMbid?: string | null;
  canonicalRecordingMbid?: string | null;
  provider?: string | null;
  providerEntityType?: string | null;
  providerId?: string | null;
  librarySlot?: library_slot | string | null;
};

type ResolvableLibraryFileRow = {
  file_path: string;
  relative_path?: string | null;
  library_root?: string | null;
};

type RebaseLibraryFileRow = {
  id: number;
  artist_id: number;
  album_id: number | null;
  media_id: number | null;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  file_type: string;
  quality: string | null;
};

function toTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getReleaseYear(releaseDate: string | null | undefined): string | null {
  if (!releaseDate) return null;
  const match = String(releaseDate).match(/^(\d{4})/);
  return match ? match[1] : null;
}

function splitPathSegments(value: string | null | undefined): string[] {
  return String(value || "")
    .split(/[\\/]+/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function rebaseRelativePathPrefix(relativePath: string, sourcePrefix: string, destinationPrefix: string): string | null {
  const relativeSegments = splitPathSegments(relativePath);
  const sourceSegments = splitPathSegments(sourcePrefix);
  const destinationSegments = splitPathSegments(destinationPrefix);

  if (sourceSegments.length === 0 || relativeSegments.length < sourceSegments.length) {
    return null;
  }

  for (let index = 0; index < sourceSegments.length; index += 1) {
    if (normalizeComparablePath(relativeSegments[index]) !== normalizeComparablePath(sourceSegments[index])) {
      return null;
    }
  }

  const suffix = relativeSegments.slice(sourceSegments.length);
  return destinationSegments.length > 0 ? path.join(...destinationSegments, ...suffix) : path.join(...suffix);
}

function hasMeaningfulLibraryFileChange(
  existing: ExistingLibraryFileIdentity,
  next: {
    artistId: string;
    albumId?: string | null;
    mediaId?: string | null;
    filePath: string;
    relativePath: string | null;
    libraryRoot: string | null;
    fileType: string;
    quality?: string | null;
  },
): boolean {
  return (
    existing.artist_id !== Number(next.artistId) ||
    (existing.album_id ?? null) !== (next.albumId ? Number(next.albumId) : null) ||
    (existing.media_id ?? null) !== (next.mediaId ? Number(next.mediaId) : null) ||
    normalizeResolvedPath(existing.file_path) !== normalizeResolvedPath(next.filePath) ||
    (existing.relative_path ?? null) !== (next.relativePath ?? null) ||
    (existing.library_root ?? null) !== (next.libraryRoot ?? null) ||
    existing.file_type !== next.fileType ||
    (existing.quality ?? null) !== (next.quality ?? null)
  );
}

export function removeEmptyParents(startDir: string, stopDir: string) {
  const stop = path.resolve(stopDir);
  let current = path.resolve(startDir);

  while (current.startsWith(stop) && current !== stop) {
    try {
      const entries = fs.readdirSync(current);
      if (entries.length > 0) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function normalizeInlineVideoTitle(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(?:official|music|lyric|lyrics|visualizer|visualiser|video|hd|4k)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map a provider video title to a Plex extras suffix
 * (-behindthescenes / -concert / -interview / -live / -lyrics / -video).
 *
 * Classification is best-effort from title qualifiers: providers often title a
 * lyric video plainly ("Pompeii"), which can only default to "-video". Keyword
 * checks are word-bounded and biased toward parenthetical/bracketed qualifiers
 * so song titles like "Oblivion" or "Alive" never classify as live recordings.
 */
export function resolvePlexVideoSuffix(title: string | null | undefined): string {
  const text = String(title || "").trim();
  if (!text) return "-video";
  const normalized = text.toLowerCase();

  if (/behind[\s-]*the[\s-]*scenes/.test(normalized)) return "-behindthescenes";
  if (/\binterview\b/.test(normalized)) return "-interview";

  // Qualifier text: parenthetical/bracketed groups plus anything after " - ".
  const qualifiers = [
    ...[...normalized.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] || m[2] || ""),
    ...(normalized.split(/\s+[-–—]\s+/).slice(1)),
  ].join(" ");

  if (/\blyrics?\b/.test(qualifiers) || /\blyrics?\s+video\b/.test(normalized)) return "-lyrics";
  if (/\bconcert\b/.test(qualifiers)) return "-concert";
  if (/\blive\b/.test(qualifiers) || /\blive\s+(at|from|in|session|performance|lounge)\b/.test(normalized)) return "-live";

  return "-video";
}

function resolveCanonicalInlineAudioExpectedPath(artistId: number, videoTitle: string): string | null {
  if (!videoTitle) return null;

  const artist = db.prepare("SELECT name, mbid, path FROM Artists WHERE id = ?").get(artistId) as any;
  if (!artist) return null;
  const artistMbId = artist.mbid ? String(artist.mbid) : String(artistId);

  const tracks = db.prepare(`
    SELECT t.title,
           t.position,
           t.number,
           t.medium_position,
           ar.mbid AS release_mbid,
           ar.release_group_mbid,
           a.title AS album_title,
           a.primary_type,
           a.first_release_date,
           COALESCE(rgs.monitored, 0) AS wanted,
           COALESCE(c.included, 0) AS included,
           CASE WHEN rgs.selected_release_mbid = ar.mbid THEN 1 ELSE 0 END AS selected_release
    FROM Tracks t
    JOIN AlbumReleases ar ON ar.mbid = t.release_mbid
    JOIN Albums a ON a.mbid = ar.release_group_mbid
    LEFT JOIN ReleaseGroupSlots rgs
      ON rgs.artist_mbid = ?
     AND rgs.release_group_mbid = ar.release_group_mbid
     AND rgs.slot = 'stereo'
    LEFT JOIN ArtistReleaseGroupCuration c
      ON c.source_artist_mbid = ?
     AND c.release_group_mbid = ar.release_group_mbid
    WHERE a.artist_mbid = ?
    ORDER BY included DESC,
             wanted DESC,
             CASE a.primary_type WHEN 'Album' THEN 0 WHEN 'EP' THEN 1 WHEN 'Single' THEN 2 ELSE 3 END,
             selected_release DESC,
             a.first_release_date ASC,
             ar.mbid ASC,
             t.position ASC
  `).all(artistMbId, artistMbId, artistMbId) as Array<{
    title?: string | null;
    position?: number | null;
    number?: string | null;
    medium_position?: number | null;
    album_title?: string | null;
    primary_type?: string | null;
    first_release_date?: string | null;
    release_group_mbid?: string | null;
  }>;
  const track = tracks.find((candidate) => normalizeInlineVideoTitle(candidate.title) === videoTitle);
  if (!track?.album_title) return null;

  const naming = getNamingConfig();
  const artistName = String(artist.name || "Unknown Artist");
  const artistFolder = resolveArtistFolderFromRecord({
    name: artistName,
    mbid: artistMbId,
    path: artist.path || null,
  });
  const renderedTrackPath = renderRelativePath(naming.album_track_path_single, {
    artistName,
    artistId: String(artistId),
    artistMbId,
    albumTitle: track.album_title,
    albumMbId: track.release_group_mbid || null,
    albumType: track.primary_type || null,
    releaseYear: getReleaseYear(track.first_release_date),
    trackTitle: track.title || "Unknown Track",
    trackNumber: Number(track.position || track.number || 0),
    volumeNumber: Number(track.medium_position || 1),
  });
  return path.join(getCurrentLibraryRootPath("music"), artistFolder, `${renderedTrackPath}.flac`);
}

function resolveExpectedLibraryRootKey(row: LibraryFileRow): library_root | null {
  const resolved = resolveLibraryRootKey(row.library_root, row.file_path);
  if (resolved) {
    return resolved;
  }

  const slot = String(row.library_slot || "").trim().toLowerCase();
  if (slot === "video" || row.file_type === "video" || row.file_type === "video_thumbnail") {
    return "videos";
  }
  if (slot === "spatial" || isSpatialAudioQuality(row.quality)) {
    return "spatial";
  }
  if (slot === "stereo" || row.file_type === "track" || row.file_type === "lyrics") {
    return "music";
  }

  if (row.file_type === "video" || row.file_type === "video_thumbnail" || row.library_slot === "video") {
    return "videos";
  }

  const videoProviderId = String(row.provider_id || row.media_id || "").trim();
  if (videoProviderId) {
    const isVideo = db.prepare(`
      SELECT 1
      FROM ProviderItems pi
      JOIN Recordings r ON r.id = pi.recording_id
      WHERE pi.entity_type = 'video'
        AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
        AND r.is_video = 1
      LIMIT 1
    `).get(videoProviderId);
    if (isVideo) {
      return "videos";
    }
  }

  return null;
}

export class LibraryFilesService {
  private static buildFileEventPayload(input: LibraryFileEventInput) {
    return {
      libraryFileId: input.libraryFileId ?? null,
      artistId: String(input.artistId),
      albumId: input.albumId == null ? null : String(input.albumId),
      mediaId: input.mediaId == null ? null : String(input.mediaId),
      fileType: input.fileType,
      filePath: input.filePath,
      libraryRoot: input.libraryRoot ?? null,
      quality: input.quality ?? null,
      previousPath: input.previousPath ?? null,
      previousQuality: input.previousQuality ?? null,
      reason: input.reason ?? null,
      missing: input.missing === true,
      timestamp: new Date().toISOString(),
    };
  }

  static emitFileAdded(input: LibraryFileEventInput) {
    emitFileAdded(this.buildFileEventPayload(input));
  }

  static emitFileDeleted(input: LibraryFileEventInput) {
    emitFileDeleted(this.buildFileEventPayload(input));
  }

  static emitFileUpgraded(input: LibraryFileEventInput) {
    emitFileUpgraded(this.buildFileEventPayload(input));
  }

  static isTrackedAssetFileType(fileType: string): boolean {
    return isExtraFileType(fileType);
  }

  static resolveExistingFiles<T extends ResolvableLibraryFileRow>(rows: T[]): T[] {
    const resolvedRows: T[] = [];

    for (const row of rows) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root ?? null,
        relativePath: row.relative_path ?? null,
      });

      if (!fs.existsSync(resolvedFilePath)) {
        continue;
      }

      const resolvedRoot = row.library_root
        ? resolveLibraryRootPath(row.library_root, row.file_path)
        : null;

      resolvedRows.push({
        ...row,
        file_path: resolvedFilePath,
        relative_path: resolvedRoot
          ? path.relative(resolvedRoot, resolvedFilePath)
          : row.relative_path ?? null,
        library_root: resolvedRoot ?? row.library_root ?? null,
      });
    }

    return resolvedRows;
  }

  static rebaseArtistPathsAfterMove(options: {
    artistId: string;
    sourcePath: string;
    destinationPath: string;
  }): { updated: number } {
    const rows = db.prepare(`
      SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, quality
      FROM TrackFiles
      WHERE artist_id = ?
    `).all(options.artistId) as RebaseLibraryFileRow[];

    let updated = 0;

    const update = db.prepare(`
      UPDATE TrackFiles
      SET file_path = ?,
          relative_path = ?,
          expected_path = ?,
          needs_rename = 0,
          verified_at = CURRENT_TIMESTAMP,
          modified_at = CASE
            WHEN ? IS NOT NULL THEN ?
            ELSE modified_at
          END
      WHERE id = ?
    `);

    for (const row of rows) {
      const currentRoot = resolveLibraryRootPath(row.library_root, row.file_path);
      if (!currentRoot) {
        continue;
      }

      const currentRelativePath = row.relative_path || path.relative(currentRoot, row.file_path);
      const rebasedRelativePath = rebaseRelativePathPrefix(
        currentRelativePath,
        options.sourcePath,
        options.destinationPath,
      );

      if (!rebasedRelativePath) {
        continue;
      }

      const nextFilePath = path.join(currentRoot, rebasedRelativePath);
      let modifiedAt: string | null = null;
      try {
        modifiedAt = fs.statSync(nextFilePath).mtime.toISOString();
      } catch {
        modifiedAt = null;
      }

      update.run(
        nextFilePath,
        rebasedRelativePath,
        nextFilePath,
        modifiedAt,
        modifiedAt,
        row.id,
      );

      this.emitFileUpgraded({
        libraryFileId: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        fileType: row.file_type,
        filePath: nextFilePath,
        libraryRoot: row.library_root,
        quality: row.quality,
        previousPath: row.file_path,
        reason: "artist-folder-move",
      });

      updated += 1;
    }

    // Rebase sidecar tables
    const sidecarTables = ["MetadataFiles", "LyricFiles", "ExtraFiles"] as const;
    for (const table of sidecarTables) {
      const fileTypeSql = table === "LyricFiles" ? "'lyrics' AS file_type" : "file_type AS file_type";
      const qualitySql = table === "LyricFiles" ? "quality AS quality" : "NULL AS quality";

      const sidecarRows = db.prepare(`
        SELECT id AS id,
          artist_id AS artist_id,
          album_id AS album_id,
          media_id AS media_id,
          file_path AS file_path,
          relative_path AS relative_path,
          library_root AS library_root,
          ${fileTypeSql},
          ${qualitySql}
        FROM ${table}
        WHERE artist_id = ?
      `).all(options.artistId) as RebaseLibraryFileRow[];

      const sidecarUpdate = db.prepare(`
        UPDATE ${table}
        SET file_path = ?,
            relative_path = ?,
            expected_path = ?,
            needs_rename = 0,
            last_updated = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      for (const row of sidecarRows) {
        const currentRoot = resolveLibraryRootPath(row.library_root, row.file_path);
        if (!currentRoot) {
          continue;
        }

        const currentRelativePath = row.relative_path || path.relative(currentRoot, row.file_path);
        const rebasedRelativePath = rebaseRelativePathPrefix(
          currentRelativePath,
          options.sourcePath,
          options.destinationPath,
        );

        if (!rebasedRelativePath) {
          continue;
        }

        const nextFilePath = path.join(currentRoot, rebasedRelativePath);

        sidecarUpdate.run(
          nextFilePath,
          rebasedRelativePath,
          nextFilePath,
          row.id,
        );

        this.emitFileUpgraded({
          libraryFileId: row.id,
          artistId: row.artist_id,
          albumId: row.album_id,
          mediaId: row.media_id,
          fileType: row.file_type,
          filePath: nextFilePath,
          libraryRoot: row.library_root,
          quality: row.quality,
          previousPath: row.file_path,
          reason: "artist-folder-move",
        });

        updated += 1;
      }
    }

    return { updated };
  }

  static computeExpectedPath(row: LibraryFileRow): { expectedPath: string | null; reason?: string } {
    const pathConfig = getConfigSection("path");
    const videoFolderLayout = pathConfig?.video_folder_layout || "separated";
    const canonicalIdentity = getCanonicalIdentityForLibraryFile(row);
    const canonicalVideo = getCanonicalVideoMetadataForRow(row, canonicalIdentity.canonicalRecordingMbid);

    if (videoFolderLayout === "inline" && row.media_id && (row.file_type === "video" || row.file_type === "video_thumbnail" || row.file_type === "nfo")) {
      if (canonicalVideo) {
        const recordingMbid = canonicalIdentity.canonicalRecordingMbid || null;
        // The audio counterpart of this video lives in the canonical TrackFiles
        // graph, matched by recording mbid; if there isn't an imported audio file
        // we fall back to the canonical title-based resolver below.
        const audioTrack = recordingMbid
          ? db.prepare(`
            SELECT id, artist_id, album_id, media_id,
                   canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
                   file_path, relative_path, library_root, file_type, extension, quality, codec, bitrate, sample_rate, bit_depth, channels
            FROM TrackFiles
            WHERE canonical_recording_mbid = ? AND file_type = 'track'
            LIMIT 1
          `).get(recordingMbid) as LibraryFileRow | undefined
          : undefined;

        const inlineVideoTitle = normalizeInlineVideoTitle(canonicalVideo.title);

        let audioExpectedPath: string | null = audioTrack
          ? LibraryFilesService.computeExpectedPath(audioTrack).expectedPath
          : null;
        audioExpectedPath ||= resolveCanonicalInlineAudioExpectedPath(row.artist_id, inlineVideoTitle);

        if (audioExpectedPath) {
            const audioExpectedDir = path.dirname(audioExpectedPath);
            const audioExpectedStem = path.parse(audioExpectedPath).name;
            let ext = row.extension || "";
            if (!ext) {
              if (row.file_type === "video") {
                ext = (row.file_path ? path.extname(row.file_path).replace(".", "") : "") || "mp4";
              } else if (row.file_type === "video_thumbnail") {
                ext = "jpg";
              } else if (row.file_type === "nfo") {
                ext = "nfo";
              }
            }
          const trackedVideo = row.file_type !== "video"
            ? db.prepare(`
                SELECT id, artist_id, album_id, media_id,
                       canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
                       file_path, relative_path, library_root, file_type, extension, quality, codec, bitrate, sample_rate, bit_depth, channels
                FROM TrackFiles
                WHERE media_id = ? AND file_type = 'video'
                LIMIT 1
              `).get(row.media_id) as LibraryFileRow | undefined
            : undefined;
          const trackedVideoExpected = trackedVideo
            ? LibraryFilesService.computeExpectedPath(trackedVideo).expectedPath
            : null;
          if (trackedVideoExpected) {
            return { expectedPath: path.join(path.dirname(trackedVideoExpected), `${path.parse(trackedVideoExpected).name}.${ext}`) };
          }

          const videoTypeSuffix = resolvePlexVideoSuffix(canonicalVideo.title);
          const baseExpectedPath = path.join(audioExpectedDir, `${audioExpectedStem}${videoTypeSuffix}.${ext}`);
          const conflict = row.file_type === "video"
            ? db.prepare("SELECT id FROM TrackFiles WHERE file_type = 'video' AND file_path = ? AND id != ? LIMIT 1")
              .get(baseExpectedPath, row.id)
            : null;
          return {
            expectedPath: conflict
              ? path.join(audioExpectedDir, `${audioExpectedStem}${videoTypeSuffix} {TIDAL-${row.media_id}}.${ext}`)
              : baseExpectedPath,
          };
        }
      }
    }

    const libraryRootKey = resolveExpectedLibraryRootKey(row);
    if (!libraryRootKey) return { expectedPath: null, reason: `unsupported_library_root:${row.library_root}` };

    const libraryRootPath = getCurrentLibraryRootPath(libraryRootKey);

    const naming = getNamingConfig();
    const metadataConfig = getConfigSection("metadata");

    const artist = db.prepare("SELECT name, mbid, path FROM Artists WHERE id = ?").get(row.artist_id) as any;
    const artistName = (artist?.name as string | undefined) || "Unknown Artist";
    const artistMbId = artist?.mbid ? String(artist.mbid) : null;
    const artistFolder = resolveArtistFolderFromRecord({
      name: artistName,
      mbid: artistMbId,
      path: artist?.path || null,
    });

    const contextBase: NamingContext = {
      provider: row.provider || "tidal",
      artistName,
      artistId: String(row.artist_id),
      artistMbId,
    };

    // Videos (do not use album folder). Resolved from the canonical Recordings
    // entity (via getCanonicalVideoMetadataForRow, which falls back to
    // ProviderItems.recording_id for mbid-less provider videos), not ProviderMedia.
    if (row.file_type === "video") {
      if (!canonicalVideo) {
        return { expectedPath: null, reason: "video_not_found" };
      }
      const ext = row.extension || path.extname(row.file_path).replace(".", "");
      const context: NamingContext = {
        ...contextBase,
        videoTitle: canonicalVideo.title || "Unknown Video",
        trackId: row.media_id != null ? String(row.media_id) : null,
        videoId: row.media_id != null ? String(row.media_id) : null,
        explicit: false,
        quality: row.quality || null,
        codec: row.codec || null,
        bitrate: row.bitrate || null,
        sampleRate: row.sample_rate || null,
        bitDepth: row.bit_depth || null,
        channels: row.channels || null,
      };

      const fileStem = renderFileStem(naming.video_file, context);
      const videoTypeSuffix = resolvePlexVideoSuffix(canonicalVideo.title);
      const suffixToAppend = fileStem.endsWith(videoTypeSuffix) ? "" : videoTypeSuffix;
      const fileName = `${fileStem}${suffixToAppend}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    if (row.file_type === "video_thumbnail") {
      if (!canonicalVideo) {
        return { expectedPath: null, reason: "video_not_found" };
      }
      const ext = row.extension || "jpg";
      const context: NamingContext = {
        ...contextBase,
        videoTitle: canonicalVideo.title || "Unknown Video",
        trackId: row.media_id != null ? String(row.media_id) : null,
        videoId: row.media_id != null ? String(row.media_id) : null,
        explicit: false,
        quality: row.quality || null,
        codec: row.codec || null,
        bitrate: row.bitrate || null,
        sampleRate: row.sample_rate || null,
        bitDepth: row.bit_depth || null,
        channels: row.channels || null,
      };

      // Sidecars must share the video file's stem (including the Plex extras
      // suffix) so Plex/Kodi pair them with the video.
      const fileStem = renderFileStem(naming.video_file, context);
      const videoTypeSuffix = resolvePlexVideoSuffix(canonicalVideo.title);
      const suffixToAppend = fileStem.endsWith(videoTypeSuffix) ? "" : videoTypeSuffix;
      const fileName = `${fileStem}${suffixToAppend}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    if (row.file_type === "nfo" && row.media_id) {
      if (canonicalVideo) {
        const context: NamingContext = {
          ...contextBase,
          videoTitle: canonicalVideo.title || "Unknown Video",
          trackId: String(row.media_id),
          videoId: String(row.media_id),
          explicit: false,
          quality: row.quality || null,
          codec: row.codec || null,
          bitrate: row.bitrate || null,
          sampleRate: row.sample_rate || null,
          bitDepth: row.bit_depth || null,
          channels: row.channels || null,
        };
        const fileStem = renderFileStem(naming.video_file, context);
        const videoTypeSuffix = resolvePlexVideoSuffix(canonicalVideo.title);
        const suffixToAppend = fileStem.endsWith(videoTypeSuffix) ? "" : videoTypeSuffix;
        return { expectedPath: path.join(libraryRootPath, artistFolder, `${fileStem}${suffixToAppend}.nfo`) };
      }
    }

    // Album-scoped types (track, lyrics, cover, NFO)
    if (!row.album_id && !canonicalIdentity.canonicalReleaseGroupMbid) {
      // Artist-scoped types (artist NFO and artist picture cover)
      if (row.file_type === "nfo") {
        return { expectedPath: path.join(libraryRootPath, artistFolder, "artist.nfo") };
      }

      if (row.file_type === "cover") {
        const name = metadataConfig.artist_picture_name || "folder.jpg";
        return { expectedPath: path.join(libraryRootPath, artistFolder, name) };
      }

      return { expectedPath: null, reason: "missing_album_id" };
    }

    // Canonical-first album naming context. Audio files always carry a canonical
    // release-group identity (the gap-fill guarantees it); we resolve naming from
    // Albums/AlbumReleases via getCanonicalAlbumMetadata rather than ProviderAlbums.
    const trackedIdentity = row.media_id
      ? db.prepare(`
          SELECT canonical_release_group_mbid, canonical_release_mbid
          FROM TrackFiles
          WHERE media_id = ?
            AND file_type = 'track'
            AND canonical_release_group_mbid IS NOT NULL
          ORDER BY CASE WHEN library_slot = ? THEN 0 ELSE 1 END, id ASC
          LIMIT 1
        `).get(row.media_id, row.library_slot || "stereo") as {
          canonical_release_group_mbid: string | null;
          canonical_release_mbid: string | null;
        } | undefined
      : undefined;
    const releaseGroupMbid = trackedIdentity?.canonical_release_group_mbid || canonicalIdentity.canonicalReleaseGroupMbid;
    const canonicalAlbum = getCanonicalAlbumMetadata({
      canonicalReleaseGroupMbid: releaseGroupMbid,
      canonicalReleaseMbid: trackedIdentity?.canonical_release_mbid || canonicalIdentity.canonicalReleaseMbid,
    });
    if (!canonicalAlbum) return { expectedPath: null, reason: "album_not_found" };

    const releaseYear = getReleaseYear(canonicalAlbum.releaseDate);
    const albumContext: NamingContext = {
      ...contextBase,
      albumId: String(row.album_id ?? releaseGroupMbid ?? ""),
      albumTitle: canonicalAlbum.title || "Unknown Album",
      albumType: canonicalAlbum.albumType || null,
      albumMbId: canonicalAlbum.albumMbid || releaseGroupMbid || null,
      albumVersion: null,
      releaseYear,
      explicit: false,
    };

    const pickTrackTemplate = (numVolumes: number) =>
      numVolumes > 1 ? naming.album_track_path_multi : naming.album_track_path_single;

    const deriveAlbumDirRelativeFromTemplate = (trackTemplate: string) => {
      const templateSegments = (trackTemplate || "").split(/[\\/]+/g).filter(Boolean);
      const templateDirSegments = templateSegments.slice(0, -1);
      const volumeDirIndex = templateDirSegments.findIndex((seg) => /\{[^}]*?(?:volumeNumber|medium)/i.test(seg));

      const renderedTrackPath = renderRelativePath(trackTemplate, {
        ...albumContext,
        trackTitle: "Track",
        trackNumber: 1,
        volumeNumber: 1,
      });
      const renderedSegments = renderedTrackPath.split(/[\\/]+/g).filter(Boolean);
      const dirSegments = renderedSegments.slice(0, -1);

      if (dirSegments.length === 0) return "";
      if (volumeDirIndex >= 0) return volumeDirIndex > 0 ? path.join(...dirSegments.slice(0, volumeDirIndex)) : "";
      return path.join(...dirSegments);
    };

    const trackTemplateForAlbum = pickTrackTemplate(Number(canonicalAlbum.volumeCount || 1));
    const albumDirRelative = deriveAlbumDirRelativeFromTemplate(trackTemplateForAlbum);
    const albumDir = path.join(libraryRootPath, artistFolder, albumDirRelative);

    if (row.file_type === "cover") {
      const name = metadataConfig.album_cover_name || "cover.jpg";
      return { expectedPath: path.join(albumDir, name) };
    }

    if (row.file_type === "video_cover") {
      const coverName = metadataConfig.album_cover_name || "cover.jpg";
      const videoCoverName = `${path.parse(coverName).name}.mp4`;
      return { expectedPath: path.join(albumDir, videoCoverName) };
    }

    if (row.file_type === "nfo" && !row.media_id) {
      return { expectedPath: path.join(albumDir, "album.nfo") };
    }

    if (row.file_type === "track") {
      if (!row.media_id && !canonicalIdentity.canonicalTrackMbid) return { expectedPath: null, reason: "missing_media_id" };
      const canonicalTrack = getCanonicalTrackMetadata(canonicalIdentity.canonicalTrackMbid);
      if (!canonicalTrack) return { expectedPath: null, reason: "track_not_found" };

      const trackArtist = canonicalTrack.recording_artist_mbid
        ? (db.prepare("SELECT name, mbid FROM ArtistMetadata WHERE mbid = ?").get(canonicalTrack.recording_artist_mbid) as any)
        : null;

      const ext = row.extension || path.extname(row.file_path).replace(".", "");
      const canonicalPosition = resolveCanonicalTrackPosition({
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        fileType: row.file_type,
        quality: row.quality,
        libraryRoot: row.library_root,
        librarySlot: row.library_slot,
      });
      const trackContext: NamingContext = {
        ...albumContext,
        trackTitle: canonicalPosition?.title || canonicalTrack?.title || canonicalTrack?.recording_title || "Unknown Track",
        trackId: String(row.media_id ?? canonicalTrack?.mbid ?? ""),
        trackMbId: canonicalTrack?.mbid || null,
        trackVersion: null,
        explicit: false,
        trackArtistName: (trackArtist?.name as string | undefined) || artistName,
        trackArtistMbId: trackArtist?.mbid ? String(trackArtist.mbid) : artistMbId,
        trackNumber: canonicalPosition?.trackNumber ?? canonicalTrack?.position,
        volumeNumber: canonicalPosition?.volumeNumber ?? canonicalTrack?.medium_position,
        // Quality metadata from TrackFiles
        quality: row.quality || null,
        codec: row.codec || null,
        bitrate: row.bitrate || null,
        sampleRate: row.sample_rate || null,
        bitDepth: row.bit_depth || null,
        channels: row.channels || null,
      };

      const trackTemplate = pickTrackTemplate(Number(canonicalAlbum.volumeCount || 1));
      const renderedTrackPath = renderRelativePath(trackTemplate, trackContext);
      const baseExpectedPath = path.join(libraryRootPath, artistFolder, `${renderedTrackPath}.${ext}`);
      const relativeTrackPath = renderAudioRelativePathForLibrary({
        relativePath: renderedTrackPath,
        quality: row.quality,
        musicRoot: getCurrentLibraryRootPath("music"),
        spatialRoot: getCurrentLibraryRootPath("spatial"),
        mustDisambiguate: Boolean(db.prepare(`
          SELECT id FROM TrackFiles
          WHERE file_type = 'track' AND file_path = ? AND id != ?
          LIMIT 1
        `).get(baseExpectedPath, row.id)),
      });
      const fileName = `${relativeTrackPath}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    if (row.file_type === "lyrics") {
      if (!row.media_id && !canonicalIdentity.canonicalTrackMbid) return { expectedPath: null, reason: "missing_media_id" };
      const trackFile = db.prepare(`
        SELECT extension FROM TrackFiles
        WHERE (
            (media_id IS NOT NULL AND media_id = ?)
            OR (canonical_track_mbid IS NOT NULL AND canonical_track_mbid = ?)
          )
          AND file_type = 'track' AND library_slot = ?
        ORDER BY id ASC
        LIMIT 1
      `).get(row.media_id, canonicalIdentity.canonicalTrackMbid, row.library_slot || "stereo") as any || db.prepare(`
        SELECT extension FROM TrackFiles
        WHERE (
            (media_id IS NOT NULL AND media_id = ?)
            OR (canonical_track_mbid IS NOT NULL AND canonical_track_mbid = ?)
          )
          AND file_type = 'track'
        ORDER BY id ASC
        LIMIT 1
      `).get(row.media_id, canonicalIdentity.canonicalTrackMbid) as any;

      const canonicalTrack = getCanonicalTrackMetadata(canonicalIdentity.canonicalTrackMbid);
      if (!canonicalTrack) return { expectedPath: null, reason: "track_not_found" };

      const trackArtist = canonicalTrack.recording_artist_mbid
        ? (db.prepare("SELECT name, mbid FROM ArtistMetadata WHERE mbid = ?").get(canonicalTrack.recording_artist_mbid) as any)
        : null;

      const ext = (trackFile?.extension as string | undefined) || "flac";
      const canonicalPosition = resolveCanonicalTrackPosition({
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        fileType: row.file_type,
        quality: row.quality,
        libraryRoot: row.library_root,
        librarySlot: row.library_slot,
      });
      const trackContext: NamingContext = {
        ...albumContext,
        trackTitle: canonicalPosition?.title || canonicalTrack?.title || canonicalTrack?.recording_title || "Unknown Track",
        trackId: String(row.media_id ?? canonicalTrack?.mbid ?? ""),
        trackMbId: canonicalTrack?.mbid || null,
        trackVersion: null,
        explicit: false,
        trackArtistName: (trackArtist?.name as string | undefined) || artistName,
        trackArtistMbId: trackArtist?.mbid ? String(trackArtist.mbid) : artistMbId,
        trackNumber: canonicalPosition?.trackNumber ?? canonicalTrack?.position,
        volumeNumber: canonicalPosition?.volumeNumber ?? canonicalTrack?.medium_position,
        // Quality metadata from TrackFiles
        quality: row.quality || null,
        codec: row.codec || null,
        bitrate: row.bitrate || null,
        sampleRate: row.sample_rate || null,
        bitDepth: row.bit_depth || null,
        channels: row.channels || null,
      };

      const trackTemplate = pickTrackTemplate(Number(canonicalAlbum.volumeCount || 1));
      const relativeTrackPath = renderAudioRelativePathForLibrary({
        relativePath: renderRelativePath(trackTemplate, trackContext),
        quality: row.quality,
        musicRoot: getCurrentLibraryRootPath("music"),
        spatialRoot: getCurrentLibraryRootPath("spatial"),
      });
      const trackPath = path.join(libraryRootPath, artistFolder, `${relativeTrackPath}.${ext}`);
      const lrcPath = trackPath.replace(new RegExp(`${path.extname(trackPath)}$`), ".lrc");
      return { expectedPath: lrcPath };
    }

    return { expectedPath: null, reason: `unsupported_file_type:${row.file_type}` };
  }

  private static getSidecarIdentity(
    tableName: "MetadataFiles" | "LyricFiles" | "ExtraFiles",
    params: {
      artistId: string;
      albumId?: string | null;
      mediaId?: string | null;
      fileType: string;
      librarySlot?: string | null;
    }
  ): { sql: string; values: Array<string | null> } | null {
    const { artistId, albumId, mediaId, fileType, librarySlot } = params;
    const slotValue = librarySlot || "stereo";

    if (mediaId) {
      if (tableName === "LyricFiles") {
        return {
          sql: "media_id = ? AND library_slot = ?",
          values: [mediaId, slotValue],
        };
      } else {
        return {
          sql: "media_id = ? AND file_type = ? AND library_slot = ?",
          values: [mediaId, fileType, slotValue],
        };
      }
    }

    if (albumId && !mediaId) {
      if (tableName === "LyricFiles") {
        return {
          sql: "album_id = ? AND media_id IS NULL AND library_slot = ?",
          values: [albumId, slotValue],
        };
      } else {
        return {
          sql: "album_id = ? AND media_id IS NULL AND file_type = ? AND library_slot = ?",
          values: [albumId, fileType, slotValue],
        };
      }
    }

    if (!albumId && !mediaId) {
      if (tableName === "LyricFiles") {
        return {
          sql: "artist_id = ? AND album_id IS NULL AND media_id IS NULL AND library_slot = ?",
          values: [artistId, slotValue],
        };
      } else {
        return {
          sql: "artist_id = ? AND album_id IS NULL AND media_id IS NULL AND file_type = ? AND library_slot = ?",
          values: [artistId, fileType, slotValue],
        };
      }
    }

    return null;
  }

  static findTrackedAssetRecordId(params: {
    artistId: string;
    albumId?: string | null;
    mediaId?: string | null;
    fileType: string;
    preferredPath?: string | null;
    librarySlot?: string | null;
  }): number | null {
    const tableName = isLyricExtraFileType(params.fileType) ? "LyricFiles" :
                      isMetadataExtraFileType(params.fileType) ? "MetadataFiles" : "ExtraFiles";

    const identity = this.getSidecarIdentity(tableName, params);
    if (!identity) {
      return null;
    }

    const row = db.prepare(`
      SELECT id
      FROM ${tableName}
      WHERE ${identity.sql}
      ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, last_updated DESC, id DESC
      LIMIT 1
    `).get(...identity.values, params.preferredPath || "") as { id: number } | undefined;

    return row?.id ?? null;
  }

  private static upsertExtraFileRecord(
    params: LibraryFileUpsertParams,
    identity: ReturnType<typeof resolveLibraryFileIdentity>,
  ): void {
    if (!isExtraFileType(params.fileType)) {
      return;
    }

    const input = {
      artistId: params.artistId,
      albumId: params.albumId || null,
      mediaId: params.mediaId || null,
      filePath: params.filePath,
      libraryRoot: params.libraryRoot,
      fileType: params.fileType,
      provider: identity.provider,
      providerEntityType: identity.providerEntityType,
      providerId: identity.providerId,
      librarySlot: identity.librarySlot,
      quality: params.quality || null,
      expectedPath: params.expectedPath || params.filePath,
      canonicalArtistMbid: identity.canonicalArtistMbid,
      canonicalReleaseGroupMbid: identity.canonicalReleaseGroupMbid,
      canonicalReleaseMbid: identity.canonicalReleaseMbid,
      canonicalTrackMbid: identity.canonicalTrackMbid,
      canonicalRecordingMbid: identity.canonicalRecordingMbid,
    };

    if (isLyricExtraFileType(params.fileType)) {
      LyricFileService.upsert(input);
      return;
    }

    if (isMetadataExtraFileType(params.fileType)) {
      MetadataFileService.upsert(input);
      return;
    }

    ExtraFileService.upsert(input);
  }

  static upsertLibraryFile(params: LibraryFileUpsertParams) {
    const relativePath = path.relative(params.libraryRoot, params.filePath);
    const filename = path.basename(params.filePath);
    const extension = path.extname(params.filePath).replace(".", "");
    const existingPathRow = db.prepare(`
      SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, quality
      FROM TrackFiles
      WHERE file_path = ?
      LIMIT 1
    `).get(params.filePath) as ExistingLibraryFileIdentity | undefined;

    let fileSize: number | null = null;
    let modifiedAt: string | null = null;

    try {
      const stats = fs.statSync(params.filePath);
      fileSize = stats.size;
      modifiedAt = stats.mtime.toISOString();
    } catch {
      // Allow DB reconciliation even when the file is not yet materialized.
    }

    const expectedPath = params.expectedPath || params.filePath;
    const canonicalIdentity = resolveLibraryFileIdentity(params);

    if (this.isTrackedAssetFileType(params.fileType)) {
      const tableName = isLyricExtraFileType(params.fileType) ? "LyricFiles" :
                        isMetadataExtraFileType(params.fileType) ? "MetadataFiles" : "ExtraFiles";
      const selectQuality = tableName === "LyricFiles" ? "Quality" : "NULL AS Quality";

      const existingSidecarRow = db.prepare(`
        SELECT id, file_path, library_root, relative_path, ${selectQuality}
        FROM ${tableName}
        WHERE file_path = ?
        LIMIT 1
      `).get(params.filePath) as { id: number; file_path: string; library_root: string; relative_path: string; Quality?: string | null } | undefined;

      this.upsertExtraFileRecord(params, canonicalIdentity);
      const insertedId = ExtraFileService.findIdByPath(tableName, params.filePath) || 0;

      if (params.removeFromUnmapped !== false) {
        db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(params.filePath);
      }

      this.enforceTrackedAssetIdentity({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        librarySlot: canonicalIdentity.librarySlot,
      });

      if (!existingSidecarRow) {
        this.emitFileAdded({
          libraryFileId: insertedId || null,
          artistId: params.artistId,
          albumId: params.albumId || null,
          mediaId: params.mediaId || null,
          fileType: params.fileType,
          filePath: params.filePath,
          libraryRoot: params.libraryRoot,
          quality: params.quality || null,
        });
      } else if (
        normalizeResolvedPath(existingSidecarRow.file_path) !== normalizeResolvedPath(params.filePath) ||
        (existingSidecarRow.Quality ?? null) !== (params.quality ?? null)
      ) {
        this.emitFileUpgraded({
          libraryFileId: insertedId,
          artistId: params.artistId,
          albumId: params.albumId || null,
          mediaId: params.mediaId || null,
          fileType: params.fileType,
          filePath: params.filePath,
          libraryRoot: params.libraryRoot,
          quality: params.quality || null,
          previousPath: existingSidecarRow.file_path,
          previousQuality: existingSidecarRow.Quality || null,
        });
      }

      return insertedId;
    }

    if (params.mediaId && (params.fileType === "track" || params.fileType === "video")) {
      const existingRow = db.prepare(`
        SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, quality
        FROM TrackFiles
        WHERE media_id = ? AND file_type = ? AND library_slot = ?
        ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
        LIMIT 1
      `).get(params.mediaId, params.fileType, canonicalIdentity.librarySlot, params.filePath) as ExistingLibraryFileIdentity | undefined;

      if (existingRow) {
        const rowToUpdate = existingPathRow && existingPathRow.id !== existingRow.id
          ? existingPathRow
          : existingRow;

        if (rowToUpdate.id !== existingRow.id) {
          db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(existingRow.id);
        }

        db.prepare(`
          UPDATE TrackFiles
          SET artist_id = ?,
              album_id = ?,
              media_id = ?,
              canonical_artist_mbid = COALESCE(?, canonical_artist_mbid),
              canonical_release_group_mbid = COALESCE(?, canonical_release_group_mbid),
              canonical_release_mbid = COALESCE(?, canonical_release_mbid),
              canonical_track_mbid = COALESCE(?, canonical_track_mbid),
              canonical_recording_mbid = COALESCE(?, canonical_recording_mbid),
              provider = COALESCE(?, provider),
              provider_entity_type = COALESCE(?, provider_entity_type),
              provider_id = COALESCE(?, provider_id),
              library_slot = COALESCE(?, library_slot),
              file_path = ?,
              relative_path = ?,
              library_root = ?,
              filename = ?,
              extension = ?,
              file_size = ?,
              file_type = ?,
              quality = ?,
              naming_template = COALESCE(?, naming_template),
              expected_path = ?,
              needs_rename = CASE WHEN ? IS NOT NULL AND ? != ? THEN 1 ELSE 0 END,
              modified_at = ?,
              verified_at = CURRENT_TIMESTAMP,
              bit_depth = COALESCE(?, bit_depth),
              sample_rate = COALESCE(?, sample_rate),
              bitrate = COALESCE(?, bitrate),
              codec = COALESCE(?, codec),
              channels = COALESCE(?, channels),
              fingerprint = COALESCE(?, fingerprint)
          WHERE id = ?
        `).run(
          params.artistId,
          params.albumId || null,
          params.mediaId || null,
          canonicalIdentity.canonicalArtistMbid,
          canonicalIdentity.canonicalReleaseGroupMbid,
          canonicalIdentity.canonicalReleaseMbid,
          canonicalIdentity.canonicalTrackMbid,
          canonicalIdentity.canonicalRecordingMbid,
          canonicalIdentity.provider,
          canonicalIdentity.providerEntityType,
          canonicalIdentity.providerId,
          canonicalIdentity.librarySlot,
          params.filePath,
          relativePath,
          params.libraryRoot,
          filename,
          extension,
          fileSize,
          params.fileType,
          params.quality || null,
          params.namingTemplate || null,
          expectedPath,
          expectedPath,
          expectedPath,
          params.filePath,
          modifiedAt,
          params.bitDepth || null,
          params.sampleRate || null,
          params.bitrate || null,
          params.codec || null,
          params.channels || null,
          params.fingerprint || null,
          rowToUpdate.id,
        );

        db.prepare(`
          DELETE FROM TrackFiles
          WHERE media_id = ? AND file_type = ? AND library_slot = ? AND id != ?
        `).run(params.mediaId, params.fileType, canonicalIdentity.librarySlot, rowToUpdate.id);

        if (params.removeFromUnmapped !== false) {
          db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(params.filePath);
        }

        if (hasMeaningfulLibraryFileChange(rowToUpdate, {
          artistId: params.artistId,
          albumId: params.albumId || null,
          mediaId: params.mediaId || null,
          filePath: params.filePath,
          relativePath,
          libraryRoot: params.libraryRoot,
          fileType: params.fileType,
          quality: params.quality || null,
        })) {
          this.emitFileUpgraded({
            libraryFileId: existingRow.id,
            artistId: params.artistId,
            albumId: params.albumId || null,
            mediaId: params.mediaId || null,
            fileType: params.fileType,
            filePath: params.filePath,
            libraryRoot: params.libraryRoot,
            quality: params.quality || null,
            previousPath: rowToUpdate.file_path,
            previousQuality: rowToUpdate.quality || null,
          });
        }

        return rowToUpdate.id;
      }
    }

    if (this.isTrackedAssetFileType(params.fileType)) {
      const existingTrackedAssetId = this.findTrackedAssetRecordId({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        preferredPath: params.filePath,
        librarySlot: canonicalIdentity.librarySlot,
      });

      if (existingTrackedAssetId !== null) {
        const existingTrackedAsset = db.prepare(`
          SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, quality
          FROM TrackFiles
          WHERE id = ?
          LIMIT 1
        `).get(existingTrackedAssetId) as ExistingLibraryFileIdentity | undefined;
        const rowToUpdate = existingPathRow && existingPathRow.id !== existingTrackedAssetId
          ? existingPathRow
          : existingTrackedAsset;

        if (!rowToUpdate) {
          return existingTrackedAssetId;
        }

        if (rowToUpdate.id !== existingTrackedAssetId) {
          db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(existingTrackedAssetId);
        }

        db.prepare(`
          UPDATE TrackFiles
          SET artist_id = ?,
              album_id = ?,
              media_id = ?,
              canonical_artist_mbid = COALESCE(?, canonical_artist_mbid),
              canonical_release_group_mbid = COALESCE(?, canonical_release_group_mbid),
              canonical_release_mbid = COALESCE(?, canonical_release_mbid),
              canonical_track_mbid = COALESCE(?, canonical_track_mbid),
              canonical_recording_mbid = COALESCE(?, canonical_recording_mbid),
              provider = COALESCE(?, provider),
              provider_entity_type = COALESCE(?, provider_entity_type),
              provider_id = COALESCE(?, provider_id),
              library_slot = COALESCE(?, library_slot),
              file_path = ?,
              relative_path = ?,
              library_root = ?,
              filename = ?,
              extension = ?,
              file_size = ?,
              file_type = ?,
              quality = ?,
              naming_template = COALESCE(?, naming_template),
              expected_path = ?,
              needs_rename = CASE WHEN ? IS NOT NULL AND ? != ? THEN 1 ELSE 0 END,
              modified_at = ?,
              verified_at = CURRENT_TIMESTAMP,
              bit_depth = COALESCE(?, bit_depth),
              sample_rate = COALESCE(?, sample_rate),
              bitrate = COALESCE(?, bitrate),
              codec = COALESCE(?, codec),
              channels = COALESCE(?, channels),
              fingerprint = COALESCE(?, fingerprint)
          WHERE id = ?
        `).run(
          params.artistId,
          params.albumId || null,
          params.mediaId || null,
          canonicalIdentity.canonicalArtistMbid,
          canonicalIdentity.canonicalReleaseGroupMbid,
          canonicalIdentity.canonicalReleaseMbid,
          canonicalIdentity.canonicalTrackMbid,
          canonicalIdentity.canonicalRecordingMbid,
          canonicalIdentity.provider,
          canonicalIdentity.providerEntityType,
          canonicalIdentity.providerId,
          canonicalIdentity.librarySlot,
          params.filePath,
          relativePath,
          params.libraryRoot,
          filename,
          extension,
          fileSize,
          params.fileType,
          params.quality || null,
          params.namingTemplate || null,
          expectedPath,
          expectedPath,
          expectedPath,
          params.filePath,
          modifiedAt,
          params.bitDepth || null,
          params.sampleRate || null,
          params.bitrate || null,
          params.codec || null,
          params.channels || null,
          params.fingerprint || null,
          rowToUpdate.id,
        );

        if (params.removeFromUnmapped !== false) {
          db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(params.filePath);
        }

        this.enforceTrackedAssetIdentity({
          artistId: params.artistId,
          albumId: params.albumId || null,
          mediaId: params.mediaId || null,
          fileType: params.fileType,
          librarySlot: canonicalIdentity.librarySlot,
        });

        if (
          rowToUpdate
          && hasMeaningfulLibraryFileChange(rowToUpdate, {
            artistId: params.artistId,
            albumId: params.albumId || null,
            mediaId: params.mediaId || null,
            filePath: params.filePath,
            relativePath,
            libraryRoot: params.libraryRoot,
            fileType: params.fileType,
            quality: params.quality || null,
          })
        ) {
          this.emitFileUpgraded({
            libraryFileId: rowToUpdate.id,
            artistId: params.artistId,
            albumId: params.albumId || null,
            mediaId: params.mediaId || null,
            fileType: params.fileType,
            filePath: params.filePath,
            libraryRoot: params.libraryRoot,
            quality: params.quality || null,
            previousPath: rowToUpdate.file_path,
            previousQuality: rowToUpdate.quality || null,
          });
        }

        return rowToUpdate.id;
      }
    }

    const insert = db.prepare(`
      INSERT INTO TrackFiles (
        artist_id, album_id, media_id,
        canonical_artist_mbid, canonical_release_group_mbid,
        canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
        provider, provider_entity_type, provider_id, library_slot,
        file_path, relative_path, library_root,
        filename, extension, file_size,
        file_type, quality,
        naming_template, expected_path, needs_rename,
        modified_at, verified_at,
        bit_depth, sample_rate, bitrate, codec, channels,
        fingerprint
      ) VALUES (
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, 0,
        ?, CURRENT_TIMESTAMP,
        ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(file_path) DO UPDATE SET
        artist_id = excluded.artist_id,
        album_id = excluded.album_id,
        media_id = excluded.media_id,
        canonical_artist_mbid = COALESCE(excluded.canonical_artist_mbid, TrackFiles.canonical_artist_mbid),
        canonical_release_group_mbid = COALESCE(excluded.canonical_release_group_mbid, TrackFiles.canonical_release_group_mbid),
        canonical_release_mbid = COALESCE(excluded.canonical_release_mbid, TrackFiles.canonical_release_mbid),
        canonical_track_mbid = COALESCE(excluded.canonical_track_mbid, TrackFiles.canonical_track_mbid),
        canonical_recording_mbid = COALESCE(excluded.canonical_recording_mbid, TrackFiles.canonical_recording_mbid),
        provider = COALESCE(excluded.provider, TrackFiles.provider),
        provider_entity_type = COALESCE(excluded.provider_entity_type, TrackFiles.provider_entity_type),
        provider_id = COALESCE(excluded.provider_id, TrackFiles.provider_id),
        library_slot = COALESCE(excluded.library_slot, TrackFiles.library_slot),
        relative_path = excluded.relative_path,
        library_root = excluded.library_root,
        filename = excluded.filename,
        extension = excluded.extension,
        file_size = excluded.file_size,
        file_type = excluded.file_type,
        quality = excluded.quality,
        naming_template = COALESCE(excluded.naming_template, TrackFiles.naming_template),
        expected_path = excluded.expected_path,
        needs_rename = CASE WHEN excluded.expected_path IS NOT NULL AND excluded.expected_path != excluded.file_path THEN 1 ELSE 0 END,
        modified_at = excluded.modified_at,
        verified_at = CURRENT_TIMESTAMP,
        bit_depth = COALESCE(excluded.bit_depth, TrackFiles.bit_depth),
        sample_rate = COALESCE(excluded.sample_rate, TrackFiles.sample_rate),
        bitrate = COALESCE(excluded.bitrate, TrackFiles.bitrate),
        codec = COALESCE(excluded.codec, TrackFiles.codec),
        channels = COALESCE(excluded.channels, TrackFiles.channels),
        fingerprint = COALESCE(excluded.fingerprint, TrackFiles.fingerprint)
    `);

    const info = insert.run(
      params.artistId,
      params.albumId || null,
      params.mediaId || null,
      canonicalIdentity.canonicalArtistMbid,
      canonicalIdentity.canonicalReleaseGroupMbid,
      canonicalIdentity.canonicalReleaseMbid,
      canonicalIdentity.canonicalTrackMbid,
      canonicalIdentity.canonicalRecordingMbid,
      canonicalIdentity.provider,
      canonicalIdentity.providerEntityType,
      canonicalIdentity.providerId,
      canonicalIdentity.librarySlot,
      params.filePath,
      relativePath,
      params.libraryRoot,
      filename,
      extension,
      fileSize,
      params.fileType,
      params.quality || null,
      params.namingTemplate || null,
      expectedPath,
      modifiedAt,
      params.bitDepth || null,
      params.sampleRate || null,
      params.bitrate || null,
      params.codec || null,
      params.channels || null,
      params.fingerprint || null,
    );

    if (params.removeFromUnmapped !== false) {
      db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(params.filePath);
    }

    if (this.isTrackedAssetFileType(params.fileType)) {
      this.enforceTrackedAssetIdentity({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        librarySlot: canonicalIdentity.librarySlot,
      });
    }

    const insertedId = Number(info.lastInsertRowid || existingPathRow?.id || 0);

    if (!existingPathRow) {
      this.emitFileAdded({
        libraryFileId: insertedId || null,
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        filePath: params.filePath,
        libraryRoot: params.libraryRoot,
        quality: params.quality || null,
      });
    } else if (hasMeaningfulLibraryFileChange(existingPathRow, {
      artistId: params.artistId,
      albumId: params.albumId || null,
      mediaId: params.mediaId || null,
      filePath: params.filePath,
      relativePath,
      libraryRoot: params.libraryRoot,
      fileType: params.fileType,
      quality: params.quality || null,
    })) {
      this.emitFileUpgraded({
        libraryFileId: existingPathRow.id,
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        filePath: params.filePath,
        libraryRoot: params.libraryRoot,
        quality: params.quality || null,
        previousPath: existingPathRow.file_path,
        previousQuality: existingPathRow.quality || null,
      });
    }

    return insertedId;
  }

  private static compareTrackedAssets(left: TrackedAssetRow, right: TrackedAssetRow): number {
    const score = (row: TrackedAssetRow) => {
      const resolvedPath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      const computedExpectedPath =
        row.expected_path || this.computeExpectedPath(row).expectedPath || null;
      const normalizedExpected = computedExpectedPath ? normalizeResolvedPath(computedExpectedPath) : "";
      const normalizedResolvedPath = normalizeResolvedPath(resolvedPath);
      const normalizedStoredPath = normalizeResolvedPath(row.file_path);

      return {
        resolvedMatchesExpected: normalizedExpected && normalizedResolvedPath === normalizedExpected ? 1 : 0,
        storedMatchesExpected: normalizedExpected && normalizedStoredPath === normalizedExpected ? 1 : 0,
        exists: fs.existsSync(resolvedPath) ? 1 : 0,
        verified: row.verified_at ? 1 : 0,
        modifiedAt: toTimestamp(row.modified_at),
        createdAt: toTimestamp(row.created_at),
        id: row.id,
      };
    };

    const leftScore = score(left);
    const rightScore = score(right);

    return (
      rightScore.resolvedMatchesExpected - leftScore.resolvedMatchesExpected ||
      rightScore.storedMatchesExpected - leftScore.storedMatchesExpected ||
      rightScore.exists - leftScore.exists ||
      rightScore.verified - leftScore.verified ||
      rightScore.modifiedAt - leftScore.modifiedAt ||
      rightScore.createdAt - leftScore.createdAt ||
      rightScore.id - leftScore.id
    );
  }

  static enforceTrackedAssetIdentity(params: {
    artistId: string;
    albumId?: string | null;
    mediaId?: string | null;
    fileType: string;
    librarySlot?: string | null;
  }): { removed: number } {
    const tableName = isLyricExtraFileType(params.fileType) ? "LyricFiles" :
                      isMetadataExtraFileType(params.fileType) ? "MetadataFiles" : "ExtraFiles";

    const identity = this.getSidecarIdentity(tableName, params);
    if (!identity) {
      return { removed: 0 };
    }

    const fileTypeSelect = tableName === "LyricFiles" ? "'lyrics' AS file_type" : "file_type AS file_type";

    const rows = db.prepare(`
      SELECT id AS id,
        artist_id AS artist_id,
        album_id AS album_id,
        media_id AS media_id,
        file_path AS file_path,
        relative_path AS relative_path,
        library_root AS library_root,
        ${fileTypeSelect},
        extension AS extension,
        expected_path AS expected_path,
        last_updated AS verified_at,
        last_updated AS modified_at,
        added AS created_at
      FROM ${tableName}
      WHERE ${identity.sql}
      ORDER BY id DESC
    `).all(...identity.values) as TrackedAssetRow[];

    if (rows.length <= 1) {
      return { removed: 0 };
    }

    const [keep, ...remove] = [...rows].sort((left, right) => this.compareTrackedAssets(left, right));
    const keepResolvedPath = normalizeResolvedPath(resolveStoredLibraryPath({
      filePath: keep.file_path,
      libraryRoot: keep.library_root,
      relativePath: keep.relative_path,
    }));

    let removed = 0;
    const idsToDelete: number[] = [];
    for (const row of remove) {
      const resolvedPath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });

      try {
        if (normalizeResolvedPath(resolvedPath) !== keepResolvedPath && fs.existsSync(resolvedPath)) {
          fs.rmSync(resolvedPath, { force: true });
          const root = resolveLibraryRootPath(row.library_root, row.file_path);
          if (root) {
            removeEmptyParents(path.dirname(resolvedPath), root);
          }
        }
      } catch (error) {
        console.warn(`[${tableName}] Failed removing duplicate ${row.file_type} file ${resolvedPath}:`, error);
      }

      idsToDelete.push(row.id);
      this.emitFileDeleted({
        libraryFileId: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        fileType: row.file_type,
        filePath: resolvedPath,
        libraryRoot: row.library_root,
        reason: "duplicate-tracked-asset",
        missing: !fs.existsSync(resolvedPath),
      });
      removed += 1;
    }

    if (idsToDelete.length > 0) {
      batchDelete(tableName, idsToDelete);
    }

    if (removed > 0) {
      console.log(`[${tableName}] Removed ${removed} duplicate tracked ${keep.file_type} file(s) for artist ${params.artistId}.`);
    }

    return { removed };
  }

  static pruneDuplicateTrackedAssets(artistId?: string): { removed: number } {
    let removed = 0;
    const params = artistId ? [artistId] : [];

    // MetadataFiles duplicates
    const metadataGroups = db.prepare(`
      SELECT artist_id AS artist_id, album_id AS album_id, media_id AS media_id, file_type AS file_type, library_slot AS library_slot
      FROM MetadataFiles
      ${artistId ? "WHERE artist_id = ?" : ""}
      GROUP BY artist_id, album_id, media_id, file_type, library_slot
      HAVING COUNT(*) > 1
    `).all(...params) as Array<{
      artist_id: string;
      album_id: string | null;
      media_id: string | null;
      file_type: string;
      library_slot: string;
    }>;

    for (const group of metadataGroups) {
      removed += this.enforceTrackedAssetIdentity({
        artistId: group.artist_id,
        albumId: group.album_id,
        mediaId: group.media_id,
        fileType: group.file_type,
        librarySlot: group.library_slot,
      }).removed;
    }

    // ExtraFiles duplicates
    const extraGroups = db.prepare(`
      SELECT artist_id AS artist_id, album_id AS album_id, media_id AS media_id, file_type AS file_type, library_slot AS library_slot
      FROM ExtraFiles
      ${artistId ? "WHERE artist_id = ?" : ""}
      GROUP BY artist_id, album_id, media_id, file_type, library_slot
      HAVING COUNT(*) > 1
    `).all(...params) as Array<{
      artist_id: string;
      album_id: string | null;
      media_id: string | null;
      file_type: string;
      library_slot: string;
    }>;

    for (const group of extraGroups) {
      removed += this.enforceTrackedAssetIdentity({
        artistId: group.artist_id,
        albumId: group.album_id,
        mediaId: group.media_id,
        fileType: group.file_type,
        librarySlot: group.library_slot,
      }).removed;
    }

    // LyricFiles duplicates
    const lyricGroups = db.prepare(`
      SELECT artist_id AS artist_id, album_id AS album_id, media_id AS media_id, library_slot AS library_slot
      FROM LyricFiles
      ${artistId ? "WHERE artist_id = ?" : ""}
      GROUP BY artist_id, album_id, media_id, library_slot
      HAVING COUNT(*) > 1
    `).all(...params) as Array<{
      artist_id: string;
      album_id: string | null;
      media_id: string | null;
      library_slot: string;
    }>;

    for (const group of lyricGroups) {
      removed += this.enforceTrackedAssetIdentity({
        artistId: group.artist_id,
        albumId: group.album_id,
        mediaId: group.media_id,
        fileType: "lyrics",
        librarySlot: group.library_slot,
      }).removed;
    }

    return { removed };
  }

  static pruneStaleTrackedAssets(artistId?: string): { removed: number } {
    let totalRemoved = 0;
    const params = artistId ? [artistId] : [];

    const tables = [
      { name: "MetadataFiles", fileTypeSql: "file_type AS file_type", qualitySql: "NULL AS quality" },
      { name: "ExtraFiles", fileTypeSql: "file_type AS file_type", qualitySql: "NULL AS quality" },
      { name: "LyricFiles", fileTypeSql: "'lyrics' AS file_type", qualitySql: "quality AS quality" },
    ] as const;

    for (const table of tables) {
      const rows = db.prepare(`
        SELECT id AS id,
          artist_id AS artist_id,
          album_id AS album_id,
          media_id AS media_id,
          file_path AS file_path,
          relative_path AS relative_path,
          library_root AS library_root,
          ${table.fileTypeSql},
          ${table.qualitySql}
        FROM ${table.name}
        ${artistId ? "WHERE artist_id = ?" : ""}
        ORDER BY id ASC
      `).all(...params) as Array<{
        id: number;
        artist_id: number;
        album_id: number | null;
        media_id: number | null;
        file_path: string;
        relative_path: string | null;
        library_root: string | null;
        file_type: string;
        quality: string | null;
      }>;

      const idsToDelete: number[] = [];

      for (const row of rows) {
        const resolvedPath = resolveStoredLibraryPath({
          filePath: row.file_path,
          libraryRoot: row.library_root,
          relativePath: row.relative_path,
        });

        if (fs.existsSync(resolvedPath)) {
          continue;
        }

        idsToDelete.push(row.id);
        this.emitFileDeleted({
          libraryFileId: row.id,
          artistId: row.artist_id,
          albumId: row.album_id,
          mediaId: row.media_id,
          fileType: row.file_type,
          filePath: resolvedPath,
          libraryRoot: row.library_root,
          quality: row.quality,
          reason: "stale-tracked-asset",
          missing: true,
        });
      }

      if (idsToDelete.length > 0) {
        batchDelete(table.name, idsToDelete);
        console.log(`[${table.name}] Removed ${idsToDelete.length} stale tracked sidecar row(s).`);
        totalRemoved += idsToDelete.length;
      }
    }

    return { removed: totalRemoved };
  }

  /**
   * Canonical delete-candidate selection for {@link pruneUnmonitoredFiles}.
   *
   * A file is kept (monitored) when the canonical entity behind it is monitored
   * or user-locked:
   *  - audio (any file carrying a `canonical_release_group_mbid`): its
   *    `ReleaseGroupSlots` row for that release group + `library_slot`;
   *  - video / recording-scoped files: their `Recordings` row, matched by
   *    `canonical_recording_mbid` or — for mbid-less provider videos — via
   *    `ProviderItems.recording_id` keyed on `provider_id`+`provider_entity_type`.
   *
   * A file is a prune candidate only when it has at least one canonical anchor
   * (release group, recording, or a resolvable provider video) AND none of those
   * anchors are monitored/locked. Files with no canonical anchor at all are left
   * untouched (unclassifiable — never auto-deleted). Replaces the old
   * `ProviderMedia.monitored`/`ProviderAlbums.monitored` linkage.
   */
  static selectUnmonitoredFileRows(artistId: string): Array<{
    id: number;
    artist_id: number;
    file_type: string;
    quality: string | null;
    file_path: string;
    library_root: string;
    album_id: number | null;
    media_id: number | null;
  }> {
    return db.prepare(`
      SELECT lf.id, lf.artist_id, lf.album_id, lf.media_id, lf.file_type, lf.quality, lf.file_path, lf.library_root
      FROM TrackFiles lf
      JOIN Artists art ON art.id = lf.artist_id
      LEFT JOIN ReleaseGroupSlots rgs
        ON rgs.artist_mbid = art.mbid
       AND rgs.release_group_mbid = lf.canonical_release_group_mbid
       AND rgs.slot = lf.library_slot
      LEFT JOIN Recordings rec
        ON rec.mbid = lf.canonical_recording_mbid
      LEFT JOIN ProviderItems pi
        ON lf.canonical_recording_mbid IS NULL
       AND lf.provider_entity_type IS NOT NULL
       AND pi.entity_type = lf.provider_entity_type
       AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
      LEFT JOIN Recordings vrec ON vrec.id = pi.recording_id
      WHERE lf.artist_id = ?
        -- must have at least one canonical anchor to be classifiable
        AND (
          lf.canonical_release_group_mbid IS NOT NULL
          OR lf.canonical_recording_mbid IS NOT NULL
          OR vrec.id IS NOT NULL
        )
        -- and none of the anchors may be monitored or user-locked
        AND COALESCE(rgs.monitored, 0) = 0 AND COALESCE(rgs.monitored_lock, 0) = 0
        AND COALESCE(rec.monitored, 0) = 0 AND COALESCE(rec.monitored_lock, 0) = 0
        AND COALESCE(vrec.monitored, 0) = 0 AND COALESCE(vrec.monitored_lock, 0) = 0
    `).all(artistId) as Array<{
      id: number;
      artist_id: number;
      file_type: string;
      quality: string | null;
      file_path: string;
      library_root: string;
      album_id: number | null;
      media_id: number | null;
    }>;
  }

  static pruneUnmonitoredFiles(artistId: string): { deleted: number; missing: number; errors: number } {
    const artist = db.prepare(`SELECT monitored FROM Artists WHERE id = ?`).get(artistId) as any;
    const artistMonitored = Boolean(artist?.monitored);

    // Unmonitoring an artist does not implicitly wipe the artist folder.
    // Automatic cleanup only applies while the artist remains managed and curation explicitly unmonitors child items.
    if (!artistMonitored) {
      return { deleted: 0, missing: 0, errors: 0 };
    }

    const rows = LibraryFilesService.selectUnmonitoredFileRows(artistId);

    if (rows.length === 0) {
      return { deleted: 0, missing: 0, errors: 0 };
    }

    let deleted = 0;
    let missing = 0;
    let errors = 0;

    for (const row of rows) {
      let canRemove = true;
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
      });
      const exists = fs.existsSync(resolvedFilePath);
      if (exists) {
        try {
          fs.rmSync(resolvedFilePath, { force: true });
        } catch (error) {
          console.warn(`[TrackFiles] Failed to delete ${resolvedFilePath}:`, error);
          canRemove = false;
          errors += 1;
        }
      } else {
        missing += 1;
      }

      if (!canRemove) continue;

      db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(row.id);

      try {
        recordHistoryEvent({
          artistId: row.artist_id,
          albumId: row.album_id,
          mediaId: row.media_id,
          libraryFileId: row.id,
          eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
          quality: row.quality,
          data: {
            deletedPath: resolvedFilePath,
            fileType: row.file_type,
            missing: !exists,
          },
        });
      } catch (historyError) {
        console.warn(`[TrackFiles] Failed to record prune history for row ${row.id}:`, historyError);
      }

      this.emitFileDeleted({
        libraryFileId: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        fileType: row.file_type,
        filePath: resolvedFilePath,
        libraryRoot: row.library_root,
        quality: row.quality,
        reason: "prune-unmonitored",
        missing: !exists,
      });

      deleted += exists ? 1 : 0;

      const root = resolveLibraryRootPath(row.library_root, row.file_path);

      if (root) {
        removeEmptyParents(path.dirname(resolvedFilePath), root);
      }
    }

    return { deleted, missing, errors };
  }

  /**
   * Remove library files whose type is disabled in the current metadata settings.
   * For example, if save_album_cover is false, delete all 'cover' files for albums.
   * If save_lyrics is false, delete all 'lyrics' files. Etc.
   *
   * This ensures that toggling a metadata setting off cleans up existing files,
   * and is also useful after importing from another library that had different settings.
   */
  static pruneDisabledMetadataFiles(artistId: string): { deleted: number; missing: number; errors: number } {
    const metadataConfig = getConfigSection("metadata");

    const rows: Array<{
      id: number;
      artist_id: number;
      album_id: number | null;
      media_id: number | null;
      file_type: string;
      quality: string | null;
      file_path: string;
      library_root: string;
      tableName: "MetadataFiles" | "LyricFiles";
    }> = [];

    // Check MetadataFiles
    const metaSelectors: string[] = [];
    if (!metadataConfig.save_album_cover) {
      metaSelectors.push("(file_type = 'cover' AND album_id IS NOT NULL) OR file_type = 'video_cover'");
    }
    if (!metadataConfig.save_artist_picture) {
      metaSelectors.push("file_type = 'cover' AND album_id IS NULL AND media_id IS NULL");
    }
    if (!metadataConfig.save_video_thumbnail) {
      metaSelectors.push("file_type = 'video_thumbnail'");
    }
    if (!metadataConfig.save_nfo) {
      metaSelectors.push("file_type = 'nfo'");
    }

    if (metaSelectors.length > 0) {
      const metaRows = db.prepare(`
        SELECT id AS id,
          artist_id AS artist_id,
          album_id AS album_id,
          media_id AS media_id,
          file_type AS file_type,
          NULL AS quality,
          file_path AS file_path,
          library_root AS library_root
        FROM MetadataFiles
        WHERE artist_id = ? AND (${metaSelectors.join(" OR ")})
      `).all(artistId) as any[];

      for (const row of metaRows) {
        rows.push({ ...row, tableName: "MetadataFiles" });
      }
    }

    // Check LyricFiles
    if (!metadataConfig.save_lyrics) {
      const lyricRows = db.prepare(`
        SELECT id AS id,
          artist_id AS artist_id,
          album_id AS album_id,
          media_id AS media_id,
          'lyrics' AS file_type,
          quality AS quality,
          file_path AS file_path,
          library_root AS library_root
        FROM LyricFiles
        WHERE artist_id = ?
      `).all(artistId) as any[];

      for (const row of lyricRows) {
        rows.push({ ...row, tableName: "LyricFiles" });
      }
    }

    if (rows.length === 0) {
      return { deleted: 0, missing: 0, errors: 0 };
    }

    let deleted = 0;
    let missing = 0;
    let errors = 0;

    for (const row of rows) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
      });
      const exists = fs.existsSync(resolvedFilePath);
      if (exists) {
        try {
          fs.rmSync(resolvedFilePath, { force: true });
          deleted++;
        } catch (error) {
          console.warn(`[${row.tableName}] Failed to delete disabled metadata file ${resolvedFilePath}:`, error);
          errors++;
          continue;
        }
      } else {
        missing++;
      }

      db.prepare(`DELETE FROM ${row.tableName} WHERE id = ?`).run(row.id);

      try {
        recordHistoryEvent({
          artistId: row.artist_id,
          albumId: row.album_id,
          mediaId: row.media_id,
          libraryFileId: row.id,
          eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
          quality: row.quality,
          data: {
            deletedPath: resolvedFilePath,
            fileType: row.file_type,
            missing: !exists,
          },
        });
      } catch (historyError) {
        console.warn(`[${row.tableName}] Failed to record disabled metadata prune history for row ${row.id}:`, historyError);
      }

      this.emitFileDeleted({
        libraryFileId: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        fileType: row.file_type,
        filePath: resolvedFilePath,
        libraryRoot: row.library_root,
        quality: row.quality,
        reason: "prune-disabled-metadata",
        missing: !exists,
      });

      const root = resolveLibraryRootPath(row.library_root, row.file_path);

      if (root) {
        removeEmptyParents(path.dirname(resolvedFilePath), root);
      }
    }

    if (deleted > 0 || missing > 0) {
      console.log(`[Metadata/LyricFiles] Disabled metadata cleanup for artist ${artistId}: ${deleted} deleted, ${missing} already missing`);
    }

    return { deleted, missing, errors };
  }

}
