import fs from "fs";
import path from "path";
import { db } from "../database.js";
import { Config } from "./config.js";
import { getConfigSection } from "./config.js";
import { getNamingConfig, renderFileStem, renderRelativePath, type NamingContext, type LibraryRoot } from "./naming.js";
import { getCurrentLibraryRootPath, resolveLibraryRootKey, resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import { normalizeResolvedPath } from "./path-utils.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "./history-events.js";

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
};

type TrackedAssetRow = LibraryFileRow & {
  relative_path: string | null;
  library_root: string;
  expected_path: string | null;
  verified_at: string | null;
  modified_at: string | null;
  created_at: string | null;
};

const TRACKED_ASSET_FILE_TYPES = new Set([
  "cover",
  "video_cover",
  "video_thumbnail",
  "bio",
  "review",
  "lyrics",
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

export type LibraryFileUpsertParams = {
  artistId: string;
  albumId?: string | null;
  mediaId?: string | null;
  filePath: string;
  libraryRoot: string;
  fileType: "track" | "video" | "cover" | "video_cover" | "video_thumbnail" | "bio" | "review" | "lyrics" | string;
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

function moveFileCrossDevice(sourcePath: string, destPath: string) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    fs.renameSync(sourcePath, destPath);
  } catch {
    fs.copyFileSync(sourcePath, destPath);
    fs.rmSync(sourcePath, { force: true });
  }
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

  static computeExpectedPath(row: LibraryFileRow): { expectedPath: string | null; reason?: string } {
    const libraryRootKey = resolveLibraryRootKey(row.library_root, row.file_path);
    if (!libraryRootKey) return { expectedPath: null, reason: `unsupported_library_root:${row.library_root}` };

    const libraryRootPath = getCurrentLibraryRootPath(libraryRootKey);

    const naming = getNamingConfig();
    const metadataConfig = getConfigSection("metadata");

    const artist = db.prepare("SELECT name FROM artists WHERE id = ?").get(row.artist_id) as any;
    const artistName = (artist?.name as string | undefined) || "Unknown Artist";

    const contextBase: NamingContext = { artistName };

    // Videos (do not use album folder)
    if (row.file_type === "video") {
      const video = row.media_id
        ? (db.prepare("SELECT title FROM media WHERE id = ? AND type = 'Music Video'").get(row.media_id) as any)
        : null;
      const ext = row.extension || path.extname(row.file_path).replace(".", "");
      const context: NamingContext = { ...contextBase, videoTitle: video?.title || "Unknown Video" };

      const artistFolder = renderRelativePath(naming.artist_folder, context);
      const fileStem = renderFileStem(naming.video_file, context);
      const fileName = `${fileStem}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    if (row.file_type === "video_thumbnail") {
      const video = row.media_id
        ? (db.prepare("SELECT title FROM media WHERE id = ? AND type = 'Music Video'").get(row.media_id) as any)
        : null;
      const ext = row.extension || "jpg";
      const context: NamingContext = { ...contextBase, videoTitle: video?.title || "Unknown Video" };

      const artistFolder = renderRelativePath(naming.artist_folder, context);
      const fileStem = renderFileStem(naming.video_file, context);
      const fileName = `${fileStem}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    // Album-scoped types (track, lyrics, cover, review)
    if (!row.album_id) {
      // Artist-scoped types (bio, artist picture cover)
      if (row.file_type === "bio") {
        const artistFolder = renderRelativePath(naming.artist_folder, contextBase);
        return { expectedPath: path.join(libraryRootPath, artistFolder, "bio.txt") };
      }

      if (row.file_type === "cover") {
        const artistFolder = renderRelativePath(naming.artist_folder, contextBase);
        const name = metadataConfig.artist_picture_name || "folder.jpg";
        return { expectedPath: path.join(libraryRootPath, artistFolder, name) };
      }

      return { expectedPath: null, reason: "missing_album_id" };
    }

    const album = db.prepare("SELECT title, version, release_date, num_volumes FROM albums WHERE id = ?").get(row.album_id) as any;
    if (!album) return { expectedPath: null, reason: "album_not_found" };

    const releaseYear = getReleaseYear(album.release_date);
    const albumContext: NamingContext = {
      ...contextBase,
      albumTitle: album.title,
      albumVersion: album.version || null,
      releaseYear,
    };

    const artistFolder = renderRelativePath(naming.artist_folder, albumContext);

    const pickTrackTemplate = (numVolumes: number) =>
      numVolumes > 1 ? naming.album_track_path_multi : naming.album_track_path_single;

    const deriveAlbumDirRelativeFromTemplate = (trackTemplate: string) => {
      const templateSegments = (trackTemplate || "").split(/[\\/]+/g).filter(Boolean);
      const templateDirSegments = templateSegments.slice(0, -1);
      const volumeDirIndex = templateDirSegments.findIndex((seg) => seg.includes("{volumeNumber"));

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

    if (row.file_type === "track") {
      if (!row.media_id) return { expectedPath: null, reason: "missing_media_id" };
      const track = db.prepare("SELECT title, version, track_number, volume_number FROM media WHERE id = ?").get(row.media_id) as any;
      if (!track) return { expectedPath: null, reason: "track_not_found" };

      const ext = row.extension || path.extname(row.file_path).replace(".", "");
      const trackContext: NamingContext = {
        ...albumContext,
        trackTitle: track.title,
        trackVersion: track.version || null,
        trackNumber: track.track_number,
        volumeNumber: track.volume_number,
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

      const track = db.prepare("SELECT title, version, track_number, volume_number FROM media WHERE id = ?").get(row.media_id) as any;
      if (!track) return { expectedPath: null, reason: "track_not_found" };

      const ext = (trackFile?.extension as string | undefined) || "flac";
      const trackContext: NamingContext = {
        ...albumContext,
        trackTitle: track.title,
        trackVersion: track.version || null,
        trackNumber: track.track_number,
        volumeNumber: track.volume_number,
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

    if (albumId && !mediaId && (fileType === "cover" || fileType === "video_cover" || fileType === "review")) {
      return {
        sql: "album_id = ? AND media_id IS NULL AND file_type = ?",
        values: [albumId, fileType],
      };
    }

    if (!albumId && !mediaId && (fileType === "cover" || fileType === "bio")) {
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
        SELECT id
        FROM library_files
        WHERE media_id = ? AND file_type = ?
        ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
        LIMIT 1
      `).get(params.mediaId, params.fileType, params.filePath) as { id: number } | undefined;

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

    return Number(info.lastInsertRowid || 0);
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

      db.prepare("DELETE FROM library_files WHERE id = ?").run(row.id);
      removed += 1;
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
      WHERE file_type IN ('cover', 'video_cover', 'video_thumbnail', 'bio', 'review', 'lyrics')
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
      SELECT id, file_path, relative_path, library_root
      FROM library_files
      WHERE file_type IN ('cover', 'video_cover', 'video_thumbnail', 'bio', 'review', 'lyrics')
        ${artistId ? "AND artist_id = ?" : ""}
      ORDER BY id ASC
    `).all(...(artistId ? [artistId] : [])) as Array<{
      id: number;
      file_path: string;
      relative_path: string | null;
      library_root: string | null;
    }>;

    let removed = 0;
    const deleteRow = db.prepare("DELETE FROM library_files WHERE id = ?");

    for (const row of rows) {
      const resolvedPath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });

      if (fs.existsSync(resolvedPath)) {
        continue;
      }

      deleteRow.run(row.id);
      removed += 1;
    }

    if (removed > 0) {
      console.log(`[LibraryFiles] Removed ${removed} stale tracked sidecar row(s).`);
    }

    return { removed };
  }

  private static getRenameRows(options: RenameScopeOptions = {}, includePaging = true): LibraryFileRow[] {
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;

    const where: string[] = [];
    const params: any[] = [];

    if (options.artistId) {
      where.push("artist_id = ?");
      params.push(options.artistId);
    }
    if (options.albumId) {
      where.push("album_id = ?");
      params.push(options.albumId);
    }
    if (options.libraryRoot) {
      where.push("library_root = ?");
      params.push(options.libraryRoot);
    }
    if (options.fileTypes && options.fileTypes.length > 0) {
      where.push(`file_type IN (${options.fileTypes.map(() => "?").join(",")})`);
      params.push(...options.fileTypes);
    }

    const sql = `
      SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, extension
      FROM library_files
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      ${includePaging ? "LIMIT ? OFFSET ?" : ""}
    `;
    if (includePaging) {
      params.push(limit, offset);
    }

    return db.prepare(sql).all(...params) as LibraryFileRow[];
  }

  private static evaluateRenameRows(rows: LibraryFileRow[]): RenamePreviewItem[] {
    const updates: Array<{ id: number; expectedPath: string | null; needsRename: number }> = [];
    const relativePathUpdates: Array<{ id: number; relativePath: string }> = [];
    const findConflict = db.prepare(`
      SELECT id
      FROM library_files
      WHERE id != ?
        AND (file_path = ? OR expected_path = ?)
      LIMIT 1
    `);

    const results: RenamePreviewItem[] = rows.map((row) => {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      const missing = !fs.existsSync(resolvedFilePath);

      const { expectedPath, reason } = this.computeExpectedPath(row);
      const needsRename = Boolean(expectedPath && normalizeResolvedPath(expectedPath) !== normalizeResolvedPath(resolvedFilePath));

      let conflict = false;
      if (expectedPath) {
        conflict = normalizeResolvedPath(expectedPath) !== normalizeResolvedPath(resolvedFilePath)
          && (fs.existsSync(expectedPath) || Boolean(findConflict.get(row.id, expectedPath, expectedPath)));
      }

      updates.push({ id: row.id, expectedPath, needsRename: needsRename ? 1 : 0 });

      try {
        const root = resolveLibraryRootPath(row.library_root, resolvedFilePath);
        if (root) {
          relativePathUpdates.push({
            id: row.id,
            relativePath: path.relative(root, resolvedFilePath),
          });
        }
      } catch {
        // ignore relative path drift until the next successful scan
      }

      return {
        id: row.id,
        file_type: row.file_type,
        library_root: row.library_root || "",
        artist_id: row.artist_id,
        album_id: row.album_id,
        media_id: row.media_id,
        file_path: resolvedFilePath,
        expected_path: expectedPath,
        needs_rename: needsRename,
        conflict,
        missing,
        reason,
      };
    });

    // Persist expected_path + needs_rename (best-effort)
    const update = db.prepare("UPDATE library_files SET expected_path = ?, needs_rename = ? WHERE id = ?");
    db.transaction(() => {
      for (const u of updates) update.run(u.expectedPath, u.needsRename, u.id);
    })();

    const relUpdate = db.prepare(`
      UPDATE library_files
      SET relative_path = ?
      WHERE id = ?
    `);
    db.transaction(() => {
      for (const updateRow of relativePathUpdates) {
        relUpdate.run(updateRow.relativePath, updateRow.id);
      }
    })();

    return results;
  }

  static previewRenames(options: RenameScopeOptions = {}): RenamePreviewItem[] {
    return this.evaluateRenameRows(this.getRenameRows(options, true));
  }

  static getRenameStatus(options: RenameScopeOptions = {}, sampleLimit = 10): RenameStatusSummary {
    const results = this.evaluateRenameRows(this.getRenameRows(options, false));
    const actionable = results.filter((item) => item.needs_rename || item.conflict || item.missing);

    return {
      total: results.length,
      renameNeeded: results.filter((item) => item.needs_rename).length,
      conflicts: results.filter((item) => item.conflict).length,
      missing: results.filter((item) => item.missing).length,
      sample: actionable.slice(0, Math.max(0, sampleLimit)),
    };
  }

  static applyRenamesByQuery(options: RenameScopeOptions = {}): RenameApplyResult {
    const ids = this.evaluateRenameRows(this.getRenameRows(options, false))
      .filter((item) => item.needs_rename)
      .map((item) => item.id);

    return this.applyRenames(ids);
  }

  static applyRenames(ids: number[]): RenameApplyResult {
    const result: RenameApplyResult = { renamed: 0, skipped: 0, conflicts: 0, missing: 0, cleanedDirectories: 0, errors: [] };
    if (!ids || ids.length === 0) return result;

    const findConflict = db.prepare(`
      SELECT id
      FROM library_files
      WHERE id != ?
        AND (file_path = ? OR expected_path = ?)
      LIMIT 1
    `);

    for (const id of ids) {
      try {
        const row = db.prepare(`
          SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, extension
          FROM library_files
          WHERE id = ?
        `).get(id) as LibraryFileRow | undefined;

        if (!row) {
          result.skipped++;
          continue;
        }

        const resolvedFilePath = resolveStoredLibraryPath({
          filePath: row.file_path,
          libraryRoot: row.library_root,
          relativePath: row.relative_path,
        });

        if (!fs.existsSync(resolvedFilePath)) {
          result.missing++;
          continue;
        }

        const computed = this.computeExpectedPath(row);
        if (!computed.expectedPath) {
          result.skipped++;
          continue;
        }

        const expectedPath = computed.expectedPath;
        const samePath = normalizeResolvedPath(expectedPath) === normalizeResolvedPath(resolvedFilePath);
        if (samePath) {
          db.prepare("UPDATE library_files SET expected_path = ?, needs_rename = 0, verified_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(expectedPath, id);
          result.skipped++;
          continue;
        }

        const dbConflict = findConflict.get(id, expectedPath, expectedPath) as any;
        const fsConflict = fs.existsSync(expectedPath);
        if (dbConflict || fsConflict) {
          db.prepare("UPDATE library_files SET expected_path = ?, needs_rename = 1 WHERE id = ?")
            .run(expectedPath, id);
          result.conflicts++;
          continue;
        }

        const oldDir = path.dirname(resolvedFilePath);
        moveFileCrossDevice(resolvedFilePath, expectedPath);

        const root = resolveLibraryRootPath(row.library_root, resolvedFilePath) || path.dirname(expectedPath);

        const relativePath = root ? path.relative(root, expectedPath) : path.basename(expectedPath);
        const filename = path.basename(expectedPath);
        const extension = path.extname(expectedPath).replace(".", "");
        const stats = fs.statSync(expectedPath);

        db.prepare(`
          UPDATE library_files
          SET file_path = ?,
              relative_path = ?,
              library_root = ?,
              filename = ?,
              extension = ?,
              expected_path = ?,
              needs_rename = 0,
              modified_at = ?,
              verified_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          expectedPath,
          relativePath,
          root,
          filename,
          extension,
          expectedPath,
          stats.mtime.toISOString(),
          id
        );

        try {
          recordHistoryEvent({
            artistId: row.artist_id,
            albumId: row.album_id,
            mediaId: row.media_id,
            libraryFileId: row.id,
            eventType: HISTORY_EVENT_TYPES.TrackFileRenamed,
            data: {
              fromPath: resolvedFilePath,
              toPath: expectedPath,
              fileType: row.file_type,
            },
          });
        } catch (historyError) {
          console.warn(`[LibraryFiles] Failed to record rename history for row ${row.id}:`, historyError);
        }

        const stopDir = root;
        removeEmptyParents(oldDir, stopDir);

        result.renamed++;
      } catch (e: any) {
        result.errors.push({ id, error: e?.message || String(e) });
      }
    }

    if (result.renamed > 0) {
      result.cleanedDirectories = this.cleanEmptyDirectories();
    }

    return result;
  }

  static pruneUnmonitoredFiles(artistId: string): { deleted: number; missing: number; errors: number } {
    const artist = db.prepare(`SELECT monitor FROM artists WHERE id = ?`).get(artistId) as any;
    const artistMonitored = Boolean(artist?.monitor);

    // Discogenius keeps Lidarr's default expectation that unmonitoring an artist does not implicitly wipe the artist folder.
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
    if (!metadataConfig.save_album_review) {
      selectors.push({ sql: "artist_id = ? AND file_type = 'review'", params: [artistId] });
    }
    if (!metadataConfig.save_artist_bio) {
      selectors.push({ sql: "artist_id = ? AND file_type = 'bio'", params: [artistId] });
    }

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

  /**
   * Remove all empty directories under each library root.
   * Walks bottom-up so nested empty dirs are cleaned in a single pass.
   */
  static cleanEmptyDirectories(): number {
    const roots = [
      Config.getMusicPath(),
      Config.getVideoPath(),
    ].filter(Boolean);

    try {
      const atmosPath = Config.getAtmosPath();
      if (atmosPath) roots.push(atmosPath);
    } catch { /* atmos path may not be configured */ }

    let removed = 0;

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      removed += this.removeEmptyDirsRecursive(root, root);
    }

    if (removed > 0) {
      console.log(`[LibraryFiles] Cleaned ${removed} empty director${removed === 1 ? 'y' : 'ies'}`);
    }

    return removed;
  }

  private static removeEmptyDirsRecursive(dir: string, root: string): number {
    let removed = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          removed += this.removeEmptyDirsRecursive(path.join(dir, entry.name), root);
        }
      }
      // Re-read after recursion — children may have been removed
      if (dir !== root) {
        const remaining = fs.readdirSync(dir);
        if (remaining.length === 0) {
          fs.rmdirSync(dir);
          removed++;
        }
      }
    } catch { /* permission error or race — skip */ }
    return removed;
  }
}
