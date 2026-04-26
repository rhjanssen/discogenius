import fs from "fs";
import path from "path";
import { db, batchDelete, batchRun } from "../database.js";
import { getConfigSection } from "./config.js";
import { getNamingConfig, renderFileStem, renderRelativePath, resolveArtistFolderFromRecord, type NamingContext, type LibraryRoot } from "./naming.js";
import { getCurrentLibraryRootPath, resolveLibraryRootKey, resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import { normalizeComparablePath, normalizeResolvedPath } from "./path-utils.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "./history-events.js";
import { emitFileAdded, emitFileDeleted, emitFileUpgraded } from "./app-events.js";

type LibraryFileRow = {
  id: number;
  artist_id: number;
  album_id: number | null;
  media_id: number | null;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  file_type: string;
  extension: string;
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

const TRACKED_ASSET_FILE_TYPES = new Set([
  "cover",
  "video_cover",
  "video_thumbnail",
  "bio",
  "review",
  "lyrics",
  "nfo",
] as const);

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
  fileType: "track" | "video" | "cover" | "video_cover" | "video_thumbnail" | "bio" | "review" | "lyrics" | "nfo" | string;
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
    return TRACKED_ASSET_FILE_TYPES.has(fileType as typeof TRACKED_ASSET_FILE_TYPES extends Set<infer T> ? T : never);
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
      FROM library_files
      WHERE artist_id = ?
    `).all(options.artistId) as RebaseLibraryFileRow[];

    let updated = 0;

    const update = db.prepare(`
      UPDATE library_files
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

    return { updated };
  }

  static computeExpectedPath(row: LibraryFileRow): { expectedPath: string | null; reason?: string } {
    const libraryRootKey = resolveLibraryRootKey(row.library_root, row.file_path);
    if (!libraryRootKey) return { expectedPath: null, reason: `unsupported_library_root:${row.library_root}` };

    const libraryRootPath = getCurrentLibraryRootPath(libraryRootKey);

    const naming = getNamingConfig();
    const metadataConfig = getConfigSection("metadata");

    const artist = db.prepare("SELECT name, mbid, path FROM artists WHERE id = ?").get(row.artist_id) as any;
    const artistName = (artist?.name as string | undefined) || "Unknown Artist";
    const artistMbId = artist?.mbid ? String(artist.mbid) : null;
    const artistFolder = resolveArtistFolderFromRecord({
      name: artistName,
      mbid: artistMbId,
      path: artist?.path || null,
    });

    const contextBase: NamingContext = {
      artistName,
      artistId: String(row.artist_id),
      artistMbId,
    };

    // Videos (do not use album folder)
    if (row.file_type === "video") {
      const video = row.media_id
        ? (db.prepare("SELECT id, title, explicit FROM media WHERE id = ? AND type = 'Music Video'").get(row.media_id) as any)
        : null;
      const ext = row.extension || path.extname(row.file_path).replace(".", "");
      const context: NamingContext = {
        ...contextBase,
        videoTitle: video?.title || "Unknown Video",
        trackId: video?.id != null ? String(video.id) : row.media_id != null ? String(row.media_id) : null,
        explicit: video?.explicit === 1,
      };

      const fileStem = renderFileStem(naming.video_file, context);
      const fileName = `${fileStem}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    if (row.file_type === "video_thumbnail") {
      const video = row.media_id
        ? (db.prepare("SELECT id, title, explicit FROM media WHERE id = ? AND type = 'Music Video'").get(row.media_id) as any)
        : null;
      const ext = row.extension || "jpg";
      const context: NamingContext = {
        ...contextBase,
        videoTitle: video?.title || "Unknown Video",
        trackId: video?.id != null ? String(video.id) : row.media_id != null ? String(row.media_id) : null,
        explicit: video?.explicit === 1,
      };

      const fileStem = renderFileStem(naming.video_file, context);
      const fileName = `${fileStem}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    // Album-scoped types (track, lyrics, cover, NFO)
    if (!row.album_id) {
      // Artist-scoped types (artist NFO, legacy bio, artist picture cover)
      if (row.file_type === "nfo") {
        return { expectedPath: path.join(libraryRootPath, artistFolder, "artist.nfo") };
      }

      if (row.file_type === "bio") {
        return { expectedPath: path.join(libraryRootPath, artistFolder, "bio.txt") };
      }

      if (row.file_type === "cover") {
        const name = metadataConfig.artist_picture_name || "folder.jpg";
        return { expectedPath: path.join(libraryRootPath, artistFolder, name) };
      }

      return { expectedPath: null, reason: "missing_album_id" };
    }

    const album = db.prepare("SELECT id, title, type, mb_primary, mbid, version, explicit, release_date, num_volumes FROM albums WHERE id = ?").get(row.album_id) as any;
    if (!album) return { expectedPath: null, reason: "album_not_found" };

    const releaseYear = getReleaseYear(album.release_date);
    const albumContext: NamingContext = {
      ...contextBase,
      albumId: String(album.id ?? row.album_id),
      albumTitle: album.title,
      albumType: album.type || album.mb_primary || null,
      albumMbId: album.mbid || null,
      albumVersion: album.version || null,
      releaseYear,
      explicit: album.explicit === 1,
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

    const trackTemplateForAlbum = pickTrackTemplate(Number(album.num_volumes || 1));
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

    if (row.file_type === "review") {
      return { expectedPath: path.join(albumDir, "review.txt") };
    }

    if (row.file_type === "nfo") {
      return { expectedPath: path.join(albumDir, "album.nfo") };
    }

    if (row.file_type === "track") {
      if (!row.media_id) return { expectedPath: null, reason: "missing_media_id" };
      const track = db.prepare("SELECT id, title, version, track_number, volume_number, artist_id, explicit, mbid FROM media WHERE id = ?").get(row.media_id) as any;
      if (!track) return { expectedPath: null, reason: "track_not_found" };

      const trackArtist = track.artist_id != null
        ? (db.prepare("SELECT name, mbid FROM artists WHERE id = ?").get(track.artist_id) as any)
        : null;

      const ext = row.extension || path.extname(row.file_path).replace(".", "");
      const trackContext: NamingContext = {
        ...albumContext,
        trackTitle: track.title,
        trackId: String(track.id ?? row.media_id),
        trackMbId: track.mbid || null,
        trackVersion: track.version || null,
        explicit: track.explicit === 1,
        trackArtistName: (trackArtist?.name as string | undefined) || artistName,
        trackArtistMbId: trackArtist?.mbid ? String(trackArtist.mbid) : artistMbId,
        trackNumber: track.track_number,
        volumeNumber: track.volume_number,
        // Quality metadata from library_files
        quality: row.quality || null,
        codec: row.codec || null,
        bitrate: row.bitrate || null,
        sampleRate: row.sample_rate || null,
        bitDepth: row.bit_depth || null,
        channels: row.channels || null,
      };

      const trackTemplate = pickTrackTemplate(Number(album.num_volumes || 1));
      const relativeTrackPath = renderRelativePath(trackTemplate, trackContext);
      const fileName = `${relativeTrackPath}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    if (row.file_type === "lyrics") {
      if (!row.media_id) return { expectedPath: null, reason: "missing_media_id" };
      const trackFile = db.prepare(`
        SELECT extension FROM library_files
        WHERE media_id = ? AND file_type = 'track'
        ORDER BY id ASC
        LIMIT 1
      `).get(row.media_id) as any;

      const track = db.prepare("SELECT id, title, version, track_number, volume_number, artist_id, explicit, mbid FROM media WHERE id = ?").get(row.media_id) as any;
      if (!track) return { expectedPath: null, reason: "track_not_found" };

      const trackArtist = track.artist_id != null
        ? (db.prepare("SELECT name, mbid FROM artists WHERE id = ?").get(track.artist_id) as any)
        : null;

      const ext = (trackFile?.extension as string | undefined) || "flac";
      const trackContext: NamingContext = {
        ...albumContext,
        trackTitle: track.title,
        trackId: String(track.id ?? row.media_id),
        trackMbId: track.mbid || null,
        trackVersion: track.version || null,
        explicit: track.explicit === 1,
        trackArtistName: (trackArtist?.name as string | undefined) || artistName,
        trackArtistMbId: trackArtist?.mbid ? String(trackArtist.mbid) : artistMbId,
        trackNumber: track.track_number,
        volumeNumber: track.volume_number,
        // Quality metadata from library_files
        quality: row.quality || null,
        codec: row.codec || null,
        bitrate: row.bitrate || null,
        sampleRate: row.sample_rate || null,
        bitDepth: row.bit_depth || null,
        channels: row.channels || null,
      };

      const trackTemplate = pickTrackTemplate(Number(album.num_volumes || 1));
      const relativeTrackPath = renderRelativePath(trackTemplate, trackContext);
      const trackPath = path.join(libraryRootPath, artistFolder, `${relativeTrackPath}.${ext}`);
      const lrcPath = trackPath.replace(new RegExp(`${path.extname(trackPath)}$`), ".lrc");
      return { expectedPath: lrcPath };
    }

    return { expectedPath: null, reason: `unsupported_file_type:${row.file_type}` };
  }

  private static getTrackedAssetIdentity(params: {
    artistId: string;
    albumId?: string | null;
    mediaId?: string | null;
    fileType: string;
  }):
    | { sql: string; values: Array<string | null> }
    | null {
    const { artistId, albumId, mediaId, fileType } = params;

    if (mediaId && (fileType === "lyrics" || fileType === "video_thumbnail")) {
      return {
        sql: "media_id = ? AND file_type = ?",
        values: [mediaId, fileType],
      };
    }

    if (albumId && !mediaId && (fileType === "cover" || fileType === "video_cover" || fileType === "review" || fileType === "nfo")) {
      return {
        sql: "album_id = ? AND media_id IS NULL AND file_type = ?",
        values: [albumId, fileType],
      };
    }

    if (!albumId && !mediaId && (fileType === "cover" || fileType === "bio" || fileType === "nfo")) {
      return {
        sql: "artist_id = ? AND album_id IS NULL AND media_id IS NULL AND file_type = ?",
        values: [artistId, fileType],
      };
    }

    return null;
  }

  static findTrackedAssetRecordId(params: {
    artistId: string;
    albumId?: string | null;
    mediaId?: string | null;
    fileType: string;
    preferredPath?: string | null;
  }): number | null {
    const identity = this.getTrackedAssetIdentity(params);
    if (!identity) {
      return null;
    }

    const row = db.prepare(`
      SELECT id
      FROM library_files
      WHERE ${identity.sql}
      ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
      LIMIT 1
    `).get(...identity.values, params.preferredPath || "") as { id: number } | undefined;

    return row?.id ?? null;
  }

  static upsertLibraryFile(params: LibraryFileUpsertParams) {
    const relativePath = path.relative(params.libraryRoot, params.filePath);
    const filename = path.basename(params.filePath);
    const extension = path.extname(params.filePath).replace(".", "");
    const existingPathRow = db.prepare(`
      SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, quality
      FROM library_files
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

    if (params.mediaId && (params.fileType === "track" || params.fileType === "video")) {
      const existingRow = db.prepare(`
        SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, quality
        FROM library_files
        WHERE media_id = ? AND file_type = ?
        ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
        LIMIT 1
      `).get(params.mediaId, params.fileType, params.filePath) as ExistingLibraryFileIdentity | undefined;

      if (existingRow) {
        db.prepare(`
          UPDATE library_files
          SET artist_id = ?,
              album_id = ?,
              media_id = ?,
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
          existingRow.id,
        );

        db.prepare(`
          DELETE FROM library_files
          WHERE media_id = ? AND file_type = ? AND id != ?
        `).run(params.mediaId, params.fileType, existingRow.id);

        if (params.removeFromUnmapped !== false) {
          db.prepare("DELETE FROM unmapped_files WHERE file_path = ?").run(params.filePath);
        }

        if (hasMeaningfulLibraryFileChange(existingRow, {
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
            previousPath: existingRow.file_path,
            previousQuality: existingRow.quality || null,
          });
        }

        return existingRow.id;
      }
    }

    if (this.isTrackedAssetFileType(params.fileType)) {
      const existingTrackedAssetId = this.findTrackedAssetRecordId({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        preferredPath: params.filePath,
      });

      if (existingTrackedAssetId !== null) {
        const existingTrackedAsset = db.prepare(`
          SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, quality
          FROM library_files
          WHERE id = ?
          LIMIT 1
        `).get(existingTrackedAssetId) as ExistingLibraryFileIdentity | undefined;

        db.prepare(`
          UPDATE library_files
          SET artist_id = ?,
              album_id = ?,
              media_id = ?,
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
          existingTrackedAssetId,
        );

        if (params.removeFromUnmapped !== false) {
          db.prepare("DELETE FROM unmapped_files WHERE file_path = ?").run(params.filePath);
        }

        this.enforceTrackedAssetIdentity({
          artistId: params.artistId,
          albumId: params.albumId || null,
          mediaId: params.mediaId || null,
          fileType: params.fileType,
        });

        if (
          existingTrackedAsset
          && hasMeaningfulLibraryFileChange(existingTrackedAsset, {
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
            libraryFileId: existingTrackedAsset.id,
            artistId: params.artistId,
            albumId: params.albumId || null,
            mediaId: params.mediaId || null,
            fileType: params.fileType,
            filePath: params.filePath,
            libraryRoot: params.libraryRoot,
            quality: params.quality || null,
            previousPath: existingTrackedAsset.file_path,
            previousQuality: existingTrackedAsset.quality || null,
          });
        }

        return existingTrackedAssetId;
      }
    }

    const insert = db.prepare(`
      INSERT INTO library_files (
        artist_id, album_id, media_id,
        file_path, relative_path, library_root,
        filename, extension, file_size,
        file_type, quality,
        naming_template, expected_path, needs_rename,
        modified_at, verified_at,
        bit_depth, sample_rate, bitrate, codec, channels,
        fingerprint
      ) VALUES (
        ?, ?, ?,
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
        relative_path = excluded.relative_path,
        library_root = excluded.library_root,
        filename = excluded.filename,
        extension = excluded.extension,
        file_size = excluded.file_size,
        file_type = excluded.file_type,
        quality = excluded.quality,
        naming_template = COALESCE(excluded.naming_template, library_files.naming_template),
        expected_path = excluded.expected_path,
        needs_rename = CASE WHEN excluded.expected_path IS NOT NULL AND excluded.expected_path != excluded.file_path THEN 1 ELSE 0 END,
        modified_at = excluded.modified_at,
        verified_at = CURRENT_TIMESTAMP,
        bit_depth = COALESCE(excluded.bit_depth, library_files.bit_depth),
        sample_rate = COALESCE(excluded.sample_rate, library_files.sample_rate),
        bitrate = COALESCE(excluded.bitrate, library_files.bitrate),
        codec = COALESCE(excluded.codec, library_files.codec),
        channels = COALESCE(excluded.channels, library_files.channels),
        fingerprint = COALESCE(excluded.fingerprint, library_files.fingerprint)
    `);

    const info = insert.run(
      params.artistId,
      params.albumId || null,
      params.mediaId || null,
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
      db.prepare("DELETE FROM unmapped_files WHERE file_path = ?").run(params.filePath);
    }

    if (this.isTrackedAssetFileType(params.fileType)) {
      this.enforceTrackedAssetIdentity({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
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
  }): { removed: number } {
    const identity = this.getTrackedAssetIdentity(params);
    if (!identity) {
      return { removed: 0 };
    }

    const rows = db.prepare(`
      SELECT
        id,
        artist_id,
        album_id,
        media_id,
        file_path,
        relative_path,
        library_root,
        file_type,
        extension,
        expected_path,
        verified_at,
        modified_at,
        created_at
      FROM library_files
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
        console.warn(`[LibraryFiles] Failed removing duplicate ${row.file_type} file ${resolvedPath}:`, error);
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
      batchDelete("library_files", idsToDelete);
    }

    if (removed > 0) {
      console.log(`[LibraryFiles] Removed ${removed} duplicate tracked ${keep.file_type} file(s) for artist ${params.artistId}.`);
    }

    return { removed };
  }

  static pruneDuplicateTrackedAssets(artistId?: string): { removed: number } {
    const groups = db.prepare(`
      SELECT artist_id, album_id, media_id, file_type, COUNT(*) AS count
      FROM library_files
      WHERE file_type IN ('cover', 'video_cover', 'video_thumbnail', 'bio', 'review', 'lyrics', 'nfo')
        ${artistId ? "AND artist_id = ?" : ""}
      GROUP BY artist_id, album_id, media_id, file_type
      HAVING COUNT(*) > 1
    `).all(...(artistId ? [artistId] : [])) as Array<{
      artist_id: number;
      album_id: number | null;
      media_id: number | null;
      file_type: string;
      count: number;
    }>;

    let removed = 0;
    for (const group of groups) {
      removed += this.enforceTrackedAssetIdentity({
        artistId: String(group.artist_id),
        albumId: group.album_id !== null ? String(group.album_id) : null,
        mediaId: group.media_id !== null ? String(group.media_id) : null,
        fileType: group.file_type,
      }).removed;
    }

    return { removed };
  }

  static pruneStaleTrackedAssets(artistId?: string): { removed: number } {
    const rows = db.prepare(`
      SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, quality
      FROM library_files
      WHERE file_type IN ('cover', 'video_cover', 'video_thumbnail', 'bio', 'review', 'lyrics', 'nfo')
        ${artistId ? "AND artist_id = ?" : ""}
      ORDER BY id ASC
    `).all(...(artistId ? [artistId] : [])) as Array<{
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
      batchDelete("library_files", idsToDelete);
      console.log(`[LibraryFiles] Removed ${idsToDelete.length} stale tracked sidecar row(s).`);
    }

    return { removed: idsToDelete.length };
  }

  static pruneUnmonitoredFiles(artistId: string): { deleted: number; missing: number; errors: number } {
    const artist = db.prepare(`SELECT monitor FROM artists WHERE id = ?`).get(artistId) as any;
    const artistMonitored = Boolean(artist?.monitor);

    // Unmonitoring an artist does not implicitly wipe the artist folder.
    // Automatic cleanup only applies while the artist remains managed and curation explicitly unmonitors child items.
    if (!artistMonitored) {
      return { deleted: 0, missing: 0, errors: 0 };
    }

    const rows = [
      ...db.prepare(`
        SELECT lf.id, lf.artist_id, lf.album_id, lf.media_id, lf.file_type, lf.quality, lf.file_path, lf.library_root
        FROM library_files lf
        LEFT JOIN media m ON m.id = lf.media_id
        WHERE lf.artist_id = ?
          AND lf.media_id IS NOT NULL
          AND (m.monitor = 0 OR m.monitor IS NULL)
          AND (m.monitor_lock = 0 OR m.monitor_lock IS NULL)
      `).all(artistId),
      ...db.prepare(`
        SELECT lf.id, lf.artist_id, lf.album_id, lf.media_id, lf.file_type, lf.quality, lf.file_path, lf.library_root
        FROM library_files lf
        LEFT JOIN albums a ON a.id = lf.album_id
        WHERE lf.artist_id = ?
          AND lf.media_id IS NULL
          AND lf.album_id IS NOT NULL
          AND (a.monitor = 0 OR a.monitor IS NULL)
          AND (a.monitor_lock = 0 OR a.monitor_lock IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM media m2
            WHERE m2.album_id = a.id AND m2.monitor = 1
          )
      `).all(artistId),
    ] as Array<{
      id: number;
      artist_id: number;
      file_type: string;
      quality: string | null;
      file_path: string;
      library_root: string;
      album_id: number | null;
      media_id: number | null;
    }>;

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
          console.warn(`[LibraryFiles] Failed to delete ${resolvedFilePath}:`, error);
          canRemove = false;
          errors += 1;
        }
      } else {
        missing += 1;
      }

      if (!canRemove) continue;

      db.prepare("DELETE FROM library_files WHERE id = ?").run(row.id);

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
        console.warn(`[LibraryFiles] Failed to record prune history for row ${row.id}:`, historyError);
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

    const selectors: Array<{ sql: string; params: unknown[] }> = [];
    if (!metadataConfig.save_album_cover) {
      selectors.push({
        sql: "artist_id = ? AND ((file_type = 'cover' AND album_id IS NOT NULL) OR file_type = 'video_cover')",
        params: [artistId],
      });
    }
    if (!metadataConfig.save_artist_picture) {
      selectors.push({
        sql: "artist_id = ? AND file_type = 'cover' AND album_id IS NULL AND media_id IS NULL",
        params: [artistId],
      });
    }
    if (!metadataConfig.save_video_thumbnail) {
      selectors.push({ sql: "artist_id = ? AND file_type = 'video_thumbnail'", params: [artistId] });
    }
    if (!metadataConfig.save_lyrics) {
      selectors.push({ sql: "artist_id = ? AND file_type = 'lyrics'", params: [artistId] });
    }
    if (!metadataConfig.save_nfo) {
      selectors.push({ sql: "artist_id = ? AND file_type = 'nfo'", params: [artistId] });
    }
    // Always prune legacy .txt bio and review files
    selectors.push({ sql: "artist_id = ? AND file_type = 'review'", params: [artistId] });
    selectors.push({ sql: "artist_id = ? AND file_type = 'bio'", params: [artistId] });

    if (selectors.length === 0) {
      return { deleted: 0, missing: 0, errors: 0 };
    }

    const rows = selectors.flatMap(({ sql, params }) =>
      db.prepare(`
        SELECT id, artist_id, album_id, media_id, file_type, quality, file_path, library_root
        FROM library_files
        WHERE ${sql}
      `).all(...params) as Array<{
        id: number;
        artist_id: number;
        album_id: number | null;
        media_id: number | null;
        file_type: string;
        quality: string | null;
        file_path: string;
        library_root: string;
      }>
    );

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
          console.warn(`[LibraryFiles] Failed to delete disabled metadata file ${resolvedFilePath}:`, error);
          errors++;
          continue;
        }
      } else {
        missing++;
      }

      db.prepare("DELETE FROM library_files WHERE id = ?").run(row.id);

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
        console.warn(`[LibraryFiles] Failed to record disabled metadata prune history for row ${row.id}:`, historyError);
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
      console.log(`[LibraryFiles] Disabled metadata cleanup for artist ${artistId}: ${deleted} deleted, ${missing} already missing`);
    }

    return { deleted, missing, errors };
  }

}
