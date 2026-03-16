import fs from "fs";
import path from "path";
import * as mm from "music-metadata";
import { db } from "../database.js";
import { Config } from "./config.js";
import { downloadAlbumCover, downloadAlbumVideoCover, downloadArtistPicture, downloadVideoThumbnail, saveBioFile, saveReviewFile, saveLyricsFile } from "./metadata-files.js";
import { getArtist, getTrack, getVideo } from "./tidal.js";
import { getNamingConfig, renderFileStem, renderRelativePath } from "./naming.js";
import { parseAudioFile, deriveQuality, deriveVideoQuality, convertToMp4, embedVideoThumbnail } from "./audioUtils.js";
import { generateFingerprint, lookupAcoustId } from "./fingerprint.js";
import { LibraryFilesService, removeEmptyParents } from "./library-files.js";
import { resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import { getDownloadWorkspacePath } from "./download-routing.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "./history-events.js";


type OrganizeType = "album" | "track" | "video" | "playlist";

type OrganizeRequest = {
  type: OrganizeType | string;
  tidalId?: string;
  downloadPath?: string;
  onProgress?: (progress: {
    phase: "importing" | "finalizing";
    currentFileNum?: number;
    totalFiles?: number;
    currentTrack?: string;
    statusMessage?: string;
  }) => void;
};

export type OrganizeResult = {
  type: OrganizeType;
  tidalId: string;
  processedTrackIds: string[];   // Track IDs that were successfully organized
  totalTracksInStaging: number;  // How many media files were found in the download workspace
  expectedTracks?: number;       // How many tracks the album should have (for albums)
};

type AlbumTrackRow = {
  id: number;
  title: string;
  version: string | null;
  track_number: number | null;
  volume_number: number | null;
  isrc: string | null;
};

type StagedAudioMetadata = {
  title?: string;
  trackNumber?: number;
  volumeNumber?: number;
  isrc?: string;
};

const getAlbumVideoCoverName = (albumCoverName: string) => {
  const parsedName = path.parse(albumCoverName);
  return `${parsedName.name}.mp4`;
};

export class OrganizerService {
  private static readonly AUDIO_EXTENSIONS = new Set([
    ".flac",
    ".m4a",
    ".mp3",
    ".aac",
    ".wav",
    ".ogg",
    ".opus",
    ".aif",
    ".aiff",
  ]);

  private static readonly VIDEO_EXTENSIONS = new Set([
    ".mp4",
    ".mkv",
    ".mov",
    ".m4v",
    ".webm",
    ".ts",
  ]);

  private static sanitizeFilename(name: string): string {
    return (name || "Unknown").replace(/[<>:"/\\|?*]/g, "").trim();
  }

  private static normalizeMatchText(value: string | null | undefined): string {
    return (value || "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private static buildTrackMatchTitles(track: AlbumTrackRow): string[] {
    const titles = new Set<string>();
    const baseTitle = this.normalizeMatchText(track.title);
    if (baseTitle) {
      titles.add(baseTitle);
    }

    if (track.version) {
      const combined = this.normalizeMatchText(`${track.title} ${track.version}`);
      if (combined) {
        titles.add(combined);
      }
      const parenthesized = this.normalizeMatchText(`${track.title} (${track.version})`);
      if (parenthesized) {
        titles.add(parenthesized);
      }
    }

    return Array.from(titles);
  }

  private static async readStagedAudioMetadata(filePath: string): Promise<StagedAudioMetadata> {
    try {
      const metadata = await mm.parseFile(filePath, { duration: false, skipCovers: true });
      const common = metadata.common;
      return {
        title: common.title || undefined,
        trackNumber: typeof common.track?.no === "number" ? common.track.no : undefined,
        volumeNumber: typeof common.disk?.no === "number" ? common.disk.no : undefined,
        isrc: Array.isArray(common.isrc) ? common.isrc[0] : common.isrc || undefined,
      };
    } catch {
      return {};
    }
  }

  private static parseNumericTrackPositionFromPath(filePath: string): {
    trackNumber?: number;
    volumeNumber?: number;
  } {
    const baseName = path.basename(filePath, path.extname(filePath));
    if (!/^\d+$/.test(baseName)) {
      return {};
    }

    const parentDir = path.basename(path.dirname(filePath));
    const cdMatch = parentDir.match(/^CD\s+(\d+)$/i);
    if (cdMatch) {
      return {
        trackNumber: Number(baseName),
        volumeNumber: Number(cdMatch[1]),
      };
    }

    return {
      trackNumber: Number(baseName),
      volumeNumber: 1,
    };
  }

  private static findTrackMatchByMetadata(
    metadata: StagedAudioMetadata,
    unmatchedTracks: AlbumTrackRow[],
  ): AlbumTrackRow | null {
    const normalizedIsrc = metadata.isrc?.trim().toUpperCase();
    if (normalizedIsrc) {
      const isrcMatch = unmatchedTracks.find((track) => track.isrc?.trim().toUpperCase() === normalizedIsrc);
      if (isrcMatch) {
        return isrcMatch;
      }
    }

    const normalizedTitle = this.normalizeMatchText(metadata.title);
    const trackNumber = metadata.trackNumber;
    const volumeNumber = metadata.volumeNumber ?? 1;

    const positionedCandidates = typeof trackNumber === "number"
      ? unmatchedTracks.filter((track) =>
        Number(track.track_number || 0) === trackNumber
        && Number(track.volume_number || 1) === volumeNumber,
      )
      : [];

    if (positionedCandidates.length === 1) {
      return positionedCandidates[0];
    }

    if (positionedCandidates.length > 1 && normalizedTitle) {
      const titledCandidate = positionedCandidates.find((track) => this.buildTrackMatchTitles(track).includes(normalizedTitle));
      if (titledCandidate) {
        return titledCandidate;
      }
    }

    if (normalizedTitle) {
      const titleCandidates = unmatchedTracks.filter((track) => this.buildTrackMatchTitles(track).includes(normalizedTitle));
      if (titleCandidates.length === 1) {
        return titleCandidates[0];
      }
    }

    return null;
  }

  private static async matchAlbumFilesToTracks(
    albumId: string,
    files: string[],
  ): Promise<Map<string, string>> {
    const trackRows = db.prepare(`
      SELECT id, title, version, track_number, volume_number, isrc
      FROM media
      WHERE album_id = ? AND type != 'Music Video'
      ORDER BY volume_number, track_number, id
    `).all(albumId) as AlbumTrackRow[];

    const remainingTracks = [...trackRows];
    const matches = new Map<string, string>();

    for (const filePath of files) {
      const baseName = path.basename(filePath, path.extname(filePath));
      if (!/^\d+$/.test(baseName)) {
        continue;
      }

      const index = remainingTracks.findIndex((track) => String(track.id) === baseName);
      if (index < 0) {
        continue;
      }

      const [matchedTrack] = remainingTracks.splice(index, 1);
      matches.set(filePath, String(matchedTrack.id));
    }

    for (const filePath of files) {
      if (matches.has(filePath)) {
        continue;
      }

      const numericPosition = this.parseNumericTrackPositionFromPath(filePath);
      const numericTrackMatch = this.findTrackMatchByMetadata(numericPosition, remainingTracks);
      if (numericTrackMatch) {
        const index = remainingTracks.findIndex((track) => track.id === numericTrackMatch.id);
        if (index >= 0) {
          remainingTracks.splice(index, 1);
        }
        matches.set(filePath, String(numericTrackMatch.id));
        continue;
      }

      const metadata = await this.readStagedAudioMetadata(filePath);
      const matchedTrack = this.findTrackMatchByMetadata(metadata, remainingTracks);
      if (!matchedTrack) {
        continue;
      }

      const index = remainingTracks.findIndex((track) => track.id === matchedTrack.id);
      if (index >= 0) {
        remainingTracks.splice(index, 1);
      }
      matches.set(filePath, String(matchedTrack.id));
    }

    return matches;
  }

  /**
   * Retroactively prune disabled metadata files (covers, bios, lyrics, etc.) 
   * based on the current configuration.
   */
  public static async pruneDisabledMetadata(): Promise<void> {
    const config = Config.getMetadataConfig();
    console.log('[Organizer] Pruning disabled metadata files...');

    let deletedCount = 0;

    const selectors: Array<string> = [];
    if (!config.save_album_cover) {
      selectors.push("(file_type = 'cover' AND album_id IS NOT NULL)");
      selectors.push("file_type = 'video_cover'");
    }
    if (!config.save_artist_picture) {
      selectors.push("file_type = 'cover' AND album_id IS NULL AND media_id IS NULL");
    }
    if (!config.save_artist_bio) selectors.push("file_type = 'bio'");
    if (!config.save_album_review) selectors.push("file_type = 'review'");
    if (!config.save_lyrics) selectors.push("file_type = 'lyrics'");
    if (!config.save_video_thumbnail) selectors.push("file_type = 'video_thumbnail'");

    if (selectors.length === 0) {
      console.log('[Organizer] No metadata types are disabled. Pruning skipped.');
      return;
    }

    const filesToPrune = db.prepare(`
      SELECT id, file_path, file_type, library_root
      FROM library_files 
      WHERE ${selectors.join(" OR ")}
    `).all() as { id: number; file_path: string; file_type: string; library_root: string }[];

    if (filesToPrune.length === 0) {
      console.log('[Organizer] No orphaned files found to prune.');
      return;
    }

    // Process deletions
    const deleteStmt = db.prepare(`DELETE FROM library_files WHERE id = ?`);

    db.transaction(() => {
      for (const file of filesToPrune) {
        try {
          const resolvedFilePath = resolveStoredLibraryPath({
            filePath: file.file_path,
            libraryRoot: file.library_root,
          });
          if (fs.existsSync(resolvedFilePath)) {
            fs.unlinkSync(resolvedFilePath);
          }
          deleteStmt.run(file.id);
          deletedCount++;
        } catch (error) {
          console.error(`[Organizer] Failed to prune ${file.file_type} file: ${file.file_path}`, error);
        }
      }
    })();

    console.log(`[Organizer] Pruning complete. Deleted ${deletedCount} disabled sidecar(s).`);
  }

  private static ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  }

  private static isMediaFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) return false;
    return this.AUDIO_EXTENSIONS.has(ext) || this.VIDEO_EXTENSIONS.has(ext);
  }

  private static findFilesRecursively(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findFilesRecursively(fullPath));
        continue;
      }
      if (this.isMediaFile(fullPath)) results.push(fullPath);
    }
    return results;
  }

  private static commonPathPrefix(paths: string[]): string {
    if (paths.length === 0) return "";

    const split = (p: string) =>
      p
        .split(/[\\/]+/g)
        .filter(Boolean)
        .filter((seg) => seg !== "." && seg !== "..");

    let prefix = split(paths[0]);
    for (const p of paths.slice(1)) {
      const segs = split(p);
      while (prefix.length > 0 && !prefix.every((seg, i) => segs[i] === seg)) {
        prefix = prefix.slice(0, -1);
      }
      if (prefix.length === 0) break;
    }

    return prefix.length > 0 ? path.join(...prefix) : "";
  }

  private static deriveAlbumDirRelativeFromTrackPath(trackTemplate: string, relativeTrackPath: string): string {
    const renderedSegments = relativeTrackPath.split(/[\\/]+/g).filter(Boolean);
    const dirSegments = renderedSegments.slice(0, -1);
    if (dirSegments.length === 0) return "";

    const templateSegments = (trackTemplate || "").split(/[\\/]+/g).filter(Boolean);
    const templateDirSegments = templateSegments.slice(0, -1);

    const volumeDirIndex = templateDirSegments.findIndex((seg) => seg.includes("{volumeNumber"));
    if (volumeDirIndex >= 0) {
      return volumeDirIndex > 0 ? path.join(...dirSegments.slice(0, volumeDirIndex)) : "";
    }

    return path.join(...dirSegments);
  }

  private static findDirectoryByName(rootDir: string, dirName: string): string | null {
    if (!fs.existsSync(rootDir)) return null;

    const stack: string[] = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(current, entry.name);
        if (entry.name === dirName) return fullPath;
        stack.push(fullPath);
      }
    }

    return null;
  }

  /**
   * Remove old library files for a media item when a new file replaces them.
   * This handles the case where the extension changes (e.g. .m4a → .flac during upgrade)
   * so the new file goes to a different path and the old file would be orphaned.
   */
  private static cleanupOldMediaFiles(mediaId: string, newFilePath: string, fileType: "track" | "video") {
    const oldFiles = db.prepare(
      `SELECT id, artist_id, album_id, media_id, file_path, library_root, quality
       FROM library_files
       WHERE media_id = ? AND file_type = ? AND file_path != ?`
    ).all(mediaId, fileType, newFilePath) as Array<{
      id: number;
      artist_id: number;
      album_id: number | null;
      media_id: number | null;
      file_path: string;
      library_root: string;
      quality: string | null;
    }>;
    const normalizedNewFilePath = path.resolve(newFilePath);

    for (const old of oldFiles) {
      try {
        const resolvedFilePath = resolveStoredLibraryPath({
          filePath: old.file_path,
          libraryRoot: old.library_root,
        });
        const isSameResolvedFile = path.resolve(resolvedFilePath) === normalizedNewFilePath;

        if (!isSameResolvedFile && fs.existsSync(resolvedFilePath)) {
          fs.rmSync(resolvedFilePath, { force: true });
          console.log(`[Organizer] Deleted old ${fileType} file (replaced by upgrade): ${resolvedFilePath}`);

          try {
            recordHistoryEvent({
              artistId: old.artist_id,
              albumId: old.album_id,
              mediaId: old.media_id,
              libraryFileId: old.id,
              eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
              quality: old.quality,
              data: {
                deletedPath: resolvedFilePath,
                replacementPath: newFilePath,
                fileType,
              },
            });
          } catch (historyError) {
            console.warn(`[Organizer] Failed to record replacement delete history for ${resolvedFilePath}:`, historyError);
          }

          // Clean up empty parent directories left behind
          const libraryRoot = this.resolveLibraryRoot(resolvedFilePath, old.library_root);
          if (libraryRoot) {
            removeEmptyParents(path.dirname(resolvedFilePath), libraryRoot);
          }
        }
        db.prepare("DELETE FROM library_files WHERE id = ?").run(old.id);
      } catch (e) {
        console.warn(`[Organizer] Failed to delete old ${fileType} file: ${old.file_path}`, e);
      }
    }
  }

  private static normalizeResolvedPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private static getExpectedLinkedSidecarPath(
    mediaPath: string,
    fileType: "lyrics" | "video_thumbnail",
  ): string {
    if (fileType === "lyrics") {
      return mediaPath.replace(new RegExp(`${path.extname(mediaPath)}$`), ".lrc");
    }

    return path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}.jpg`);
  }

  private static relocateLinkedSidecar(params: {
    artistId: string;
    albumId?: string | null;
    mediaId: string;
    mediaPath: string;
    libraryRoot: string;
    fileType: "lyrics" | "video_thumbnail";
    quality?: string | null;
    namingTemplate?: string | null;
  }): string {
    const expectedPath = this.getExpectedLinkedSidecarPath(params.mediaPath, params.fileType);
    const normalizedExpectedPath = this.normalizeResolvedPath(expectedPath);
    const sidecars = db.prepare(`
      SELECT id, file_path, library_root
      FROM library_files
      WHERE media_id = ? AND file_type = ?
      ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
    `).all(params.mediaId, params.fileType, expectedPath) as Array<{
      id: number;
      file_path: string;
      library_root: string;
    }>;

    let hasExpectedSidecar = fs.existsSync(expectedPath);

    for (const sidecar of sidecars) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: sidecar.file_path,
        libraryRoot: sidecar.library_root,
      });
      const normalizedResolvedPath = this.normalizeResolvedPath(resolvedFilePath);

      if (!fs.existsSync(resolvedFilePath)) {
        db.prepare("DELETE FROM library_files WHERE id = ?").run(sidecar.id);
        continue;
      }

      if (normalizedResolvedPath === normalizedExpectedPath) {
        hasExpectedSidecar = true;
        continue;
      }

      try {
        if (!hasExpectedSidecar) {
          this.moveFileCrossDevice(resolvedFilePath, expectedPath);
          hasExpectedSidecar = true;

          const sourceRoot = this.resolveLibraryRoot(resolvedFilePath, sidecar.library_root);
          if (sourceRoot) {
            removeEmptyParents(path.dirname(resolvedFilePath), sourceRoot);
          }
        } else {
          fs.rmSync(resolvedFilePath, { force: true });

          const sourceRoot = this.resolveLibraryRoot(resolvedFilePath, sidecar.library_root);
          if (sourceRoot) {
            removeEmptyParents(path.dirname(resolvedFilePath), sourceRoot);
          }
        }
      } catch (error) {
        console.warn(`[Organizer] Failed to relocate ${params.fileType} sidecar ${resolvedFilePath}`, error);
      }
    }

    if (fs.existsSync(expectedPath)) {
      this.upsertLibraryFile({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId,
        filePath: expectedPath,
        libraryRoot: params.libraryRoot,
        fileType: params.fileType,
        quality: params.quality || null,
        namingTemplate: params.namingTemplate || null,
        expectedPath,
      });

      db.prepare(`
        DELETE FROM library_files
        WHERE media_id = ? AND file_type = ? AND file_path != ?
      `).run(params.mediaId, params.fileType, expectedPath);
    }

    return expectedPath;
  }

  private static relocateSingletonSidecar(params: {
    artistId: string;
    albumId?: string | null;
    expectedPath: string;
    libraryRoot: string;
    fileType: "cover" | "video_cover" | "bio" | "review";
    quality?: string | null;
    namingTemplate?: string | null;
  }): string {
    const normalizedExpectedPath = this.normalizeResolvedPath(params.expectedPath);
    const scopedRows = params.albumId
      ? db.prepare(`
        SELECT id, file_path, library_root
        FROM library_files
        WHERE artist_id = ?
          AND album_id = ?
          AND media_id IS NULL
          AND COALESCE(library_root, '') = COALESCE(?, '')
          AND file_type = ?
        ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
      `).all(params.artistId, params.albumId, params.libraryRoot, params.fileType, params.expectedPath)
      : db.prepare(`
        SELECT id, file_path, library_root
        FROM library_files
        WHERE artist_id = ?
          AND album_id IS NULL
          AND media_id IS NULL
          AND COALESCE(library_root, '') = COALESCE(?, '')
          AND file_type = ?
        ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
      `).all(params.artistId, params.libraryRoot, params.fileType, params.expectedPath);

    let hasExpectedSidecar = fs.existsSync(params.expectedPath);

    for (const sidecar of scopedRows as Array<{ id: number; file_path: string; library_root: string }>) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: sidecar.file_path,
        libraryRoot: sidecar.library_root,
      });
      const normalizedResolvedPath = this.normalizeResolvedPath(resolvedFilePath);

      if (!fs.existsSync(resolvedFilePath)) {
        db.prepare("DELETE FROM library_files WHERE id = ?").run(sidecar.id);
        continue;
      }

      if (normalizedResolvedPath === normalizedExpectedPath) {
        hasExpectedSidecar = true;
        continue;
      }

      try {
        if (!hasExpectedSidecar) {
          this.moveFileCrossDevice(resolvedFilePath, params.expectedPath);
          hasExpectedSidecar = true;
        } else {
          fs.rmSync(resolvedFilePath, { force: true });
        }

        const sourceRoot = this.resolveLibraryRoot(resolvedFilePath, sidecar.library_root);
        if (sourceRoot) {
          removeEmptyParents(path.dirname(resolvedFilePath), sourceRoot);
        }
      } catch (error) {
        console.warn(`[Organizer] Failed to relocate ${params.fileType} sidecar ${resolvedFilePath}`, error);
      }
    }

    if (fs.existsSync(params.expectedPath)) {
      this.upsertLibraryFile({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: null,
        filePath: params.expectedPath,
        libraryRoot: params.libraryRoot,
        fileType: params.fileType,
        quality: params.quality || null,
        namingTemplate: params.namingTemplate || null,
        expectedPath: params.expectedPath,
      });

      if (params.albumId) {
        db.prepare(`
          DELETE FROM library_files
          WHERE artist_id = ?
            AND album_id = ?
            AND media_id IS NULL
            AND COALESCE(library_root, '') = COALESCE(?, '')
            AND file_type = ?
            AND file_path != ?
        `).run(params.artistId, params.albumId, params.libraryRoot, params.fileType, params.expectedPath);
      } else {
        db.prepare(`
          DELETE FROM library_files
          WHERE artist_id = ?
            AND album_id IS NULL
            AND media_id IS NULL
            AND COALESCE(library_root, '') = COALESCE(?, '')
            AND file_type = ?
            AND file_path != ?
        `).run(params.artistId, params.libraryRoot, params.fileType, params.expectedPath);
      }
    }

    return params.expectedPath;
  }

  private static cleanupSiblingMediaVariants(newFilePath: string, fileType: "track" | "video") {
    const targetPath = path.resolve(newFilePath);
    const targetDir = path.dirname(targetPath);
    const targetStem = path.parse(targetPath).name;
    if (!fs.existsSync(targetDir)) {
      return;
    }

    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      const siblingPath = path.join(targetDir, entry.name);
      if (path.resolve(siblingPath) === targetPath) {
        continue;
      }

      const siblingExt = path.extname(entry.name).toLowerCase();
      const isMediaSibling = this.AUDIO_EXTENSIONS.has(siblingExt) || this.VIDEO_EXTENSIONS.has(siblingExt);
      if (!isMediaSibling || path.parse(entry.name).name !== targetStem) {
        continue;
      }

      try {
        const siblingLibraryFiles = db.prepare(
          `SELECT id, artist_id, album_id, media_id, quality
           FROM library_files
           WHERE file_path = ? AND file_type = ?`
        ).all(siblingPath, fileType) as Array<{
          id: number;
          artist_id: number;
          album_id: number | null;
          media_id: number | null;
          quality: string | null;
        }>;

        for (const siblingRow of siblingLibraryFiles) {
          try {
            recordHistoryEvent({
              artistId: siblingRow.artist_id,
              albumId: siblingRow.album_id,
              mediaId: siblingRow.media_id,
              libraryFileId: siblingRow.id,
              eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
              quality: siblingRow.quality,
              data: {
                deletedPath: siblingPath,
                replacementPath: newFilePath,
                fileType,
              },
            });
          } catch (historyError) {
            console.warn(`[Organizer] Failed to record sibling ${fileType} delete history for ${siblingPath}:`, historyError);
          }
        }

        fs.rmSync(siblingPath, { force: true });
        db.prepare("DELETE FROM library_files WHERE file_path = ? AND file_type = ?").run(siblingPath, fileType);
        console.log(`[Organizer] Deleted conflicting ${fileType} variant: ${siblingPath}`);
      } catch (error) {
        console.warn(`[Organizer] Failed to delete conflicting ${fileType} variant: ${siblingPath}`, error);
      }
    }
  }

  /** Return the library root that contains the given absolute path, or null. */
  private static resolveLibraryRoot(filePath: string, libraryRoot?: string | null): string | null {
    const mappedRoot = resolveLibraryRootPath(libraryRoot, filePath);
    if (mappedRoot) return mappedRoot;

    const resolved = path.resolve(filePath);
    for (const root of [Config.getMusicPath(), Config.getVideoPath(), Config.getAtmosPath()]) {
      if (root && resolved.startsWith(path.resolve(root))) return root;
    }
    return null;
  }

  private static moveFileCrossDevice(sourcePath: string, destPath: string) {
    this.ensureDir(path.dirname(destPath));

    try {
      fs.renameSync(sourcePath, destPath);
    } catch {
      fs.copyFileSync(sourcePath, destPath);
      fs.rmSync(sourcePath, { force: true });
    }
  }

  private static upsertLibraryFile(params: {
    artistId: string;
    albumId?: string | null;
    mediaId?: string | null;
    filePath: string;
    libraryRoot: string;
    fileType: "track" | "video" | "cover" | "video_cover" | "video_thumbnail" | "bio" | "review" | "lyrics";
    quality?: string | null;
    namingTemplate?: string | null;
    expectedPath?: string | null;
    bitDepth?: number | null;
    sampleRate?: number | null;
    bitrate?: number | null;
    codec?: string | null;
    channels?: number | null;
    fingerprint?: string | null;
  }): number {
    return LibraryFilesService.upsertLibraryFile({
      ...params,
      removeFromUnmapped: true,
    });
  }

  private static getReleaseYear(releaseDate: string | null | undefined): string | null {
    if (!releaseDate) return null;
    const match = releaseDate.match(/^(\d{4})/);
    return match ? match[1] : null;
  }

  public static async organizeDownload(raw: OrganizeRequest): Promise<OrganizeResult> {
    const type: OrganizeType =
      raw.type === "DownloadAlbum" ? "album" :
        raw.type === "DownloadVideo" ? "video" :
          raw.type === "DownloadTrack" ? "track" :
            (raw.type as OrganizeType);

    const tidalId = raw.tidalId;
    if (!tidalId) {
      throw new Error("Missing tidal id for organizer");
    }

    const downloadPath = raw.downloadPath || getDownloadWorkspacePath(type as OrganizeType, tidalId);
    const onProgress = raw.onProgress;
    const metadataConfig = Config.getMetadataConfig();

    const musicRoot = Config.getMusicPath();
    const spatialRoot = Config.getAtmosPath();
    const videoRoot = Config.getVideoPath();

    [musicRoot, spatialRoot, videoRoot].forEach((root) => this.ensureDir(root));

    if (type === "album") {
      const { scanAlbumShallow } = await import("./scanner.js");
      await scanAlbumShallow(tidalId);

      const album = db.prepare("SELECT * FROM albums WHERE id = ?").get(tidalId) as any;
      if (!album) throw new Error(`Album ${tidalId} not found in DB after scan`);

      const artistId = String(album.artist_id);
      let artistName = (db.prepare("SELECT name FROM artists WHERE id = ?").get(artistId) as any)?.name as string | undefined;
      if (!artistName) {
        const remoteArtist = await getArtist(artistId);
        artistName = remoteArtist.name;
        db.prepare("INSERT OR IGNORE INTO artists (id, name, picture, popularity, monitor) VALUES (?, ?, ?, ?, 0)")
          .run(artistId, artistName, remoteArtist.picture || null, remoteArtist.popularity || 0);
      }

      const year = this.getReleaseYear(album.release_date);
      const resolvedArtistName = artistName || "Unknown Artist";
      const naming = getNamingConfig();
      const artistFolder = renderRelativePath(naming.artist_folder, {
        artistName: resolvedArtistName,
        artistId,
      });

      const isSpatial = ["DOLBY_ATMOS", "SONY_360RA", "360"].includes((album.quality || "").toUpperCase());
      const targetRoot = isSpatial ? spatialRoot : musicRoot;

      const trackTemplate = Number(album.num_volumes || 1) > 1
        ? naming.album_track_path_multi
        : naming.album_track_path_single;

      const sourceAlbumDir = downloadPath;
      if (!fs.existsSync(sourceAlbumDir)) {
        throw new Error(`[Organizer] Could not locate download folder for album ${tidalId} in ${downloadPath}`);
      }

      const files = this.findFilesRecursively(sourceAlbumDir);
      if (files.length === 0) {
        throw new Error(`[Organizer] No media files found for album ${tidalId} in ${sourceAlbumDir}`);
      }

      const audioFiles = files.filter((file) => this.AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()));
      const matchedTrackIdsByFile = await this.matchAlbumFilesToTracks(tidalId, audioFiles);
      if (audioFiles.length > 0 && matchedTrackIdsByFile.size === 0) {
        throw new Error(`[Organizer] Could not match downloaded album files for ${tidalId} to Discogenius tracks in ${sourceAlbumDir}`);
      }

      const totalImportableTracks = audioFiles.length;
      onProgress?.({
        phase: "importing",
        currentFileNum: 0,
        totalFiles: totalImportableTracks,
        statusMessage: "Importing downloaded album files",
      });

      const renderedTrackDirs: string[] = [];
      const destFiles: Array<{ trackId: string; destFile: string; ext: string }> = [];
      let sampleRelativeTrackPath: string | null = null;
      const processedEmbeddedVideoIds = new Set<string>();

      for (const srcFile of files) {
        const ext = path.extname(srcFile).toLowerCase();
        const base = path.basename(srcFile, ext);
        const idFromName = /^\d+$/.test(base) ? base : null;

        if (this.VIDEO_EXTENSIONS.has(ext) && idFromName) {
          if (!processedEmbeddedVideoIds.has(idFromName)) {
            processedEmbeddedVideoIds.add(idFromName);
            try {
              await this.organizeDownload({ type: "video", tidalId: idFromName, downloadPath: sourceAlbumDir });
            } catch (error) {
              console.warn(`[Organizer] Skipping embedded video ${idFromName} while organizing album ${tidalId}:`, error);
            }
          }
          continue;
        }

        if (!this.AUDIO_EXTENSIONS.has(ext)) {
          continue;
        }

        const trackId = matchedTrackIdsByFile.get(srcFile) || idFromName;
        const trackRow = trackId
          ? (db.prepare("SELECT * FROM media WHERE id = ? AND album_id = ? AND type != 'Music Video'").get(trackId, tidalId) as any)
          : null;

        if (!trackId || !trackRow) {
          continue;
        }

        const trackTitle = trackRow.title || "Unknown Track";
        const trackNumber = Number(trackRow.track_number || 0);
        const volumeNumber = Number(trackRow.volume_number || 1);

        const relativeTrackPath = renderRelativePath(trackTemplate, {
          artistName: resolvedArtistName,
          artistId,
          albumTitle: album.title,
          albumId: tidalId,
          albumVersion: album.version || null,
          releaseYear: year,
          trackTitle,
          trackId,
          trackVersion: trackRow.version || null,
          explicit: trackRow.explicit === 1,
          trackNumber,
          volumeNumber,
        });

        if (!sampleRelativeTrackPath) sampleRelativeTrackPath = relativeTrackPath;

        const trackDirRel = path.dirname(relativeTrackPath);
        if (trackDirRel && trackDirRel !== ".") {
          renderedTrackDirs.push(trackDirRel);
        }

        const destFile = path.join(targetRoot, artistFolder, `${relativeTrackPath}${ext}`);
        this.moveFileCrossDevice(srcFile, destFile);

        const metrics = await parseAudioFile(destFile);
        const derivedQuality = deriveQuality(ext, metrics);

        let fileFingerprint: string | null = null;
        if (metadataConfig.enable_fingerprinting) {
          try {
            const fp = await generateFingerprint(destFile);
            fileFingerprint = fp.fingerprint;
            const mbids = await lookupAcoustId(fp.fingerprint, fp.duration);
            if (mbids.length > 0) {
              const trackMbid = mbids[0];
              const mediaIdStr = trackRow?.id ? String(trackRow.id) : trackId;
              db.prepare("UPDATE media SET mbid = ? WHERE id = ?").run(trackMbid, mediaIdStr);
            }
          } catch (error: any) {
            console.warn(`[Organizer] Fingerprint logic failed (fpcalc missing or API error) for ${destFile}:`, error.message);
          }
        }

        const libraryFileId = this.upsertLibraryFile({
          artistId,
          albumId: tidalId,
          mediaId: trackRow?.id ? String(trackRow.id) : trackId,
          filePath: destFile,
          libraryRoot: targetRoot,
          fileType: "track",
          quality: derivedQuality,
          namingTemplate: "default",
          expectedPath: destFile,
          bitDepth: metrics.bitDepth,
          sampleRate: metrics.sampleRate,
          bitrate: metrics.bitrate,
          codec: metrics.codec,
          channels: metrics.channels,
          fingerprint: fileFingerprint,
        });

        const mediaIdStr = trackRow?.id ? String(trackRow.id) : trackId;
        try {
          recordHistoryEvent({
            artistId,
            albumId: tidalId,
            mediaId: mediaIdStr,
            libraryFileId,
            eventType: HISTORY_EVENT_TYPES.TrackFileImported,
            quality: derivedQuality,
            sourceTitle: trackTitle,
            data: {
              importedPath: destFile,
            },
          });
        } catch (historyError) {
          console.warn(`[Organizer] Failed to record track import history for ${mediaIdStr}:`, historyError);
        }

        if (mediaIdStr) {
          this.cleanupOldMediaFiles(mediaIdStr, destFile, "track");
          this.cleanupSiblingMediaVariants(destFile, "track");
        }

        if (metadataConfig.save_lyrics && trackId) {
          try {
            const lrcPath = this.relocateLinkedSidecar({
              artistId,
              albumId: tidalId,
              mediaId: trackId,
              mediaPath: destFile,
              libraryRoot: targetRoot,
              fileType: "lyrics",
              quality: trackRow?.quality || album.quality,
            });
            if (!fs.existsSync(lrcPath)) {
              await saveLyricsFile(trackId, lrcPath);
            }

            if (fs.existsSync(lrcPath)) {
              this.upsertLibraryFile({
                artistId,
                albumId: tidalId,
                mediaId: trackId,
                filePath: lrcPath,
                libraryRoot: targetRoot,
                fileType: "lyrics",
                quality: trackRow?.quality || album.quality,
                namingTemplate: null,
                expectedPath: lrcPath,
              });
            }
          } catch {
            // ignore
          }
        }

        destFiles.push({ trackId, destFile, ext });
        onProgress?.({
          phase: "importing",
          currentFileNum: destFiles.length,
          totalFiles: totalImportableTracks,
          currentTrack: trackTitle,
          statusMessage: `Importing ${trackTitle}`,
        });
      }

      onProgress?.({
        phase: "finalizing",
        currentFileNum: destFiles.length,
        totalFiles: totalImportableTracks,
        statusMessage: "Finalizing album metadata",
      });

      const albumDirRelative = sampleRelativeTrackPath
        ? this.deriveAlbumDirRelativeFromTrackPath(trackTemplate, sampleRelativeTrackPath)
        : this.commonPathPrefix(renderedTrackDirs);
      const targetAlbumDir = path.join(targetRoot, artistFolder, albumDirRelative);
      this.ensureDir(targetAlbumDir);

      const artistDir = path.join(targetRoot, artistFolder);
      this.ensureDir(artistDir);
      const artistPicPath = path.join(artistDir, metadataConfig.artist_picture_name || "folder.jpg");
      if (metadataConfig.save_artist_picture) {
        this.relocateSingletonSidecar({
          artistId,
          expectedPath: artistPicPath,
          libraryRoot: targetRoot,
          fileType: "cover",
        });
      }
      if (metadataConfig.save_artist_picture && !fs.existsSync(artistPicPath)) {
        const resolution = typeof metadataConfig.artist_picture_resolution === "string"
          ? parseInt(metadataConfig.artist_picture_resolution, 10)
          : metadataConfig.artist_picture_resolution;
        const safeRes = (resolution === 160 || resolution === 320 || resolution === 480 || resolution === 750) ? resolution : 750;
        await downloadArtistPicture(artistId, safeRes, artistPicPath);
        if (fs.existsSync(artistPicPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId: null,
            mediaId: null,
            filePath: artistPicPath,
            libraryRoot: targetRoot,
            fileType: "cover",
            quality: null,
            namingTemplate: null,
            expectedPath: artistPicPath,
          });
        }
      }

      const albumCoverPath = path.join(targetAlbumDir, metadataConfig.album_cover_name || "cover.jpg");
      if (metadataConfig.save_album_cover) {
        this.relocateSingletonSidecar({
          artistId,
          albumId: tidalId,
          expectedPath: albumCoverPath,
          libraryRoot: targetRoot,
          fileType: "cover",
        });
      }
      if (metadataConfig.save_album_cover && !fs.existsSync(albumCoverPath)) {
        await downloadAlbumCover(tidalId, metadataConfig.album_cover_resolution as any, albumCoverPath);
        if (fs.existsSync(albumCoverPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId: tidalId,
            mediaId: null,
            filePath: albumCoverPath,
            libraryRoot: targetRoot,
            fileType: "cover",
            quality: null,
            namingTemplate: null,
            expectedPath: albumCoverPath,
          });
        }
      }

      const albumVideoCoverName = getAlbumVideoCoverName(metadataConfig.album_cover_name || "cover.jpg");
      const albumVideoCoverPath = path.join(targetAlbumDir, albumVideoCoverName);
      if (metadataConfig.save_album_cover && album.video_cover) {
        this.relocateSingletonSidecar({
          artistId,
          albumId: tidalId,
          expectedPath: albumVideoCoverPath,
          libraryRoot: targetRoot,
          fileType: "video_cover",
        });
      }
      if (metadataConfig.save_album_cover && album.video_cover && !fs.existsSync(albumVideoCoverPath)) {
        await downloadAlbumVideoCover(String(album.video_cover), metadataConfig.album_cover_resolution as any, albumVideoCoverPath);
        if (fs.existsSync(albumVideoCoverPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId: tidalId,
            mediaId: null,
            filePath: albumVideoCoverPath,
            libraryRoot: targetRoot,
            fileType: "video_cover",
            quality: null,
            namingTemplate: null,
            expectedPath: albumVideoCoverPath,
          });
        }
      }

      const bioPath = path.join(artistDir, "bio.txt");
      if (metadataConfig.save_artist_bio) {
        this.relocateSingletonSidecar({
          artistId,
          expectedPath: bioPath,
          libraryRoot: targetRoot,
          fileType: "bio",
        });
      }
      if (metadataConfig.save_artist_bio && !fs.existsSync(bioPath)) {
        try {
          await saveBioFile(artistId, bioPath);
          if (fs.existsSync(bioPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId: null,
              mediaId: null,
              filePath: bioPath,
              libraryRoot: targetRoot,
              fileType: "bio",
              quality: null,
              namingTemplate: null,
              expectedPath: bioPath,
            });
          }
        } catch {
          // ignore
        }
      }

      const reviewPath = path.join(targetAlbumDir, "review.txt");
      if (metadataConfig.save_album_review) {
        this.relocateSingletonSidecar({
          artistId,
          albumId: tidalId,
          expectedPath: reviewPath,
          libraryRoot: targetRoot,
          fileType: "review",
        });
      }
      if (metadataConfig.save_album_review && !fs.existsSync(reviewPath)) {
        try {
          await saveReviewFile(tidalId, reviewPath);
          if (fs.existsSync(reviewPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId: tidalId,
              mediaId: null,
              filePath: reviewPath,
              libraryRoot: targetRoot,
              fileType: "review",
              quality: null,
              namingTemplate: null,
              expectedPath: reviewPath,
            });
          }
        } catch {
          // ignore
        }
      }

      return {
        type: "album",
        tidalId,
        processedTrackIds: destFiles.map((file) => file.trackId),
        totalTracksInStaging: files.length,
        expectedTracks: Number(album.num_tracks || 0),
      };
    }

    if (type === "track") {
      const allFiles = this.findFilesRecursively(downloadPath);
      const src =
        allFiles.find(f => path.basename(f, path.extname(f)) === tidalId) ||
        (allFiles.length === 1 ? allFiles[0] : null) ||
        allFiles.find(f => path.basename(f).includes(tidalId));
      if (!src) {
        throw new Error(`[Organizer] Could not locate downloaded file for track ${tidalId} in ${downloadPath}`);
      }

      const trackData = await getTrack(tidalId);
      onProgress?.({
        phase: "importing",
        currentFileNum: 0,
        totalFiles: 1,
        currentTrack: trackData?.title,
        statusMessage: "Importing downloaded track",
      });
      const albumId = trackData?.album_id ? String(trackData.album_id) : null;
      if (!albumId) throw new Error(`Track ${tidalId} missing album_id`);

      // Ensure album + tracks in DB for naming + review (and to locate track metadata)
      const { scanAlbumShallow } = await import("./scanner.js");
      await scanAlbumShallow(albumId);

      const album = db.prepare("SELECT * FROM albums WHERE id = ?").get(albumId) as any;
      if (!album) throw new Error(`Album ${albumId} not found in DB after scan`);

      const trackRow = db.prepare("SELECT * FROM media WHERE id = ?").get(tidalId) as any;
      if (!trackRow) throw new Error(`Track ${tidalId} not found in DB after scan`);

      const artistId = String(album.artist_id);
      let artistName =
        (db.prepare("SELECT name FROM artists WHERE id = ?").get(artistId) as any)?.name as string | undefined;
      if (!artistName) {
        const remoteArtist = await getArtist(artistId);
        artistName = remoteArtist.name;
        db.prepare("INSERT OR IGNORE INTO artists (id, name, picture, popularity, monitor) VALUES (?, ?, ?, ?, 0)")
          .run(artistId, artistName, remoteArtist.picture || null, remoteArtist.popularity || 0);
      }

      const year = this.getReleaseYear(album.release_date);
      const resolvedArtistName = artistName || "Unknown Artist";
      const naming = getNamingConfig();

      const artistFolder = renderRelativePath(naming.artist_folder, {
        artistName: resolvedArtistName,
        artistId
      });

      const isSpatial = ["DOLBY_ATMOS", "SONY_360RA", "360"].includes((album.quality || "").toUpperCase());
      const targetRoot = isSpatial ? spatialRoot : musicRoot;

      const ext = path.extname(src);
      const trackTitle = trackRow.title || trackData.title || path.basename(src, ext);
      const trackNumber = Number(trackRow.track_number || trackData.track_number || 0);
      const volumeNumber = Number(trackRow.volume_number || trackData.volume_number || 1);

      const trackTemplate = Number(album.num_volumes || 1) > 1
        ? naming.album_track_path_multi
        : naming.album_track_path_single;

      const relativeTrackPath = renderRelativePath(trackTemplate, {
        artistName: resolvedArtistName,
        artistId,
        albumTitle: album.title,
        albumId,
        albumVersion: album.version || null,
        releaseYear: year,
        trackTitle,
        trackId: tidalId,
        trackNumber,
        volumeNumber,
        trackVersion: trackRow.version || null,
      });

      const dest = path.join(targetRoot, artistFolder, `${relativeTrackPath}${ext}`);
      this.moveFileCrossDevice(src, dest);

      // Analyze file quality
      const metrics = await parseAudioFile(dest);
      const derivedQuality = deriveQuality(ext, metrics);

      const metadataConfig = Config.getMetadataConfig();

      let fileFingerprint: string | null = null;
      if (metadataConfig.enable_fingerprinting) {
        try {
          const fp = await generateFingerprint(dest);
          fileFingerprint = fp.fingerprint;
          const mbids = await lookupAcoustId(fp.fingerprint, fp.duration);
          if (mbids.length > 0) {
            const trackMbid = mbids[0];
            db.prepare("UPDATE media SET mbid = ? WHERE id = ?").run(trackMbid, tidalId);
          }
        } catch (e: any) {
          console.warn(`[Organizer] Fingerprint logic failed (fpcalc missing or API error) for ${dest}:`, e.message);
        }
      }

      const libraryFileId = this.upsertLibraryFile({
        artistId,
        albumId,
        mediaId: tidalId,
        filePath: dest,
        libraryRoot: targetRoot,
        fileType: "track",
        quality: derivedQuality,
        namingTemplate: "default",
        expectedPath: dest,
        bitDepth: metrics.bitDepth,
        sampleRate: metrics.sampleRate,
        bitrate: metrics.bitrate,
        codec: metrics.codec,
        channels: metrics.channels,
        fingerprint: fileFingerprint
      });

      try {
        recordHistoryEvent({
          artistId,
          albumId,
          mediaId: tidalId,
          libraryFileId,
          eventType: HISTORY_EVENT_TYPES.TrackFileImported,
          quality: derivedQuality,
          sourceTitle: trackTitle,
          data: {
            importedPath: dest,
          },
        });
      } catch (historyError) {
        console.warn(`[Organizer] Failed to record track import history for ${tidalId}:`, historyError);
      }

      // Keep the track branch aligned with album/video organization so quality
      // changes replace the previous file instead of leaving duplicates behind.
      this.cleanupOldMediaFiles(tidalId, dest, "track");
      this.cleanupSiblingMediaVariants(dest, "track");

      if (metadataConfig.save_lyrics) {
        try {
          const lrcPath = this.relocateLinkedSidecar({
            artistId,
            albumId,
            mediaId: tidalId,
            mediaPath: dest,
            libraryRoot: targetRoot,
            fileType: "lyrics",
            quality: trackRow?.quality || album.quality,
          });
          if (!fs.existsSync(lrcPath)) {
            await saveLyricsFile(tidalId, lrcPath);
          }

          if (fs.existsSync(lrcPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId,
              mediaId: tidalId,
              filePath: lrcPath,
              libraryRoot: targetRoot,
              fileType: "lyrics",
              quality: trackRow?.quality || album.quality,
              namingTemplate: null,
              expectedPath: lrcPath,
            });
          }
        } catch {
          // ignore
        }
      }

      // Extras (cover, artist picture, bio, review) - ensure they exist when downloading individual tracks
      const artistDir = path.join(targetRoot, artistFolder);
      this.ensureDir(artistDir);
      const artistPicPath = path.join(artistDir, metadataConfig.artist_picture_name || "folder.jpg");
      if (metadataConfig.save_artist_picture) {
        this.relocateSingletonSidecar({
          artistId,
          expectedPath: artistPicPath,
          libraryRoot: targetRoot,
          fileType: "cover",
        });
      }
      if (metadataConfig.save_artist_picture && !fs.existsSync(artistPicPath)) {
        const resolution = typeof metadataConfig.artist_picture_resolution === "string"
          ? parseInt(metadataConfig.artist_picture_resolution, 10)
          : metadataConfig.artist_picture_resolution;
        const safeRes = (resolution === 160 || resolution === 320 || resolution === 480 || resolution === 750) ? resolution : 750;
        await downloadArtistPicture(artistId, safeRes, artistPicPath);
        if (fs.existsSync(artistPicPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId: null,
            mediaId: null,
            filePath: artistPicPath,
            libraryRoot: targetRoot,
            fileType: "cover",
            quality: null,
            namingTemplate: null,
            expectedPath: artistPicPath,
          });
        }
      }

      const albumDirRelative = this.deriveAlbumDirRelativeFromTrackPath(trackTemplate, relativeTrackPath);
      const targetAlbumDir = path.join(targetRoot, artistFolder, albumDirRelative);
      this.ensureDir(targetAlbumDir);

      const albumCoverPath = path.join(targetAlbumDir, metadataConfig.album_cover_name || "cover.jpg");
      if (metadataConfig.save_album_cover) {
        this.relocateSingletonSidecar({
          artistId,
          albumId,
          expectedPath: albumCoverPath,
          libraryRoot: targetRoot,
          fileType: "cover",
        });
      }
      if (metadataConfig.save_album_cover && !fs.existsSync(albumCoverPath)) {
        await downloadAlbumCover(albumId, metadataConfig.album_cover_resolution as any, albumCoverPath);
        if (fs.existsSync(albumCoverPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId,
            mediaId: null,
            filePath: albumCoverPath,
            libraryRoot: targetRoot,
            fileType: "cover",
            quality: null,
            namingTemplate: null,
            expectedPath: albumCoverPath,
          });
        }
      }

      const albumVideoCoverName = getAlbumVideoCoverName(metadataConfig.album_cover_name || "cover.jpg");
      const albumVideoCoverPath = path.join(targetAlbumDir, albumVideoCoverName);
      if (metadataConfig.save_album_cover && album.video_cover) {
        this.relocateSingletonSidecar({
          artistId,
          albumId,
          expectedPath: albumVideoCoverPath,
          libraryRoot: targetRoot,
          fileType: "video_cover",
        });
      }
      if (metadataConfig.save_album_cover && album.video_cover && !fs.existsSync(albumVideoCoverPath)) {
        await downloadAlbumVideoCover(String(album.video_cover), metadataConfig.album_cover_resolution as any, albumVideoCoverPath);
        if (fs.existsSync(albumVideoCoverPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId,
            mediaId: null,
            filePath: albumVideoCoverPath,
            libraryRoot: targetRoot,
            fileType: "video_cover",
            quality: null,
            namingTemplate: null,
            expectedPath: albumVideoCoverPath,
          });
        }
      }

      const bioPath = path.join(artistDir, "bio.txt");
      if (metadataConfig.save_artist_bio) {
        this.relocateSingletonSidecar({
          artistId,
          expectedPath: bioPath,
          libraryRoot: targetRoot,
          fileType: "bio",
        });
      }
      if (metadataConfig.save_artist_bio && !fs.existsSync(bioPath)) {
        try {
          await saveBioFile(artistId, bioPath);
          if (fs.existsSync(bioPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId: null,
              mediaId: null,
              filePath: bioPath,
              libraryRoot: targetRoot,
              fileType: "bio",
              quality: null,
              namingTemplate: null,
              expectedPath: bioPath,
            });
          }
        } catch {
          // ignore
        }
      }

      const reviewPath = path.join(targetAlbumDir, "review.txt");
      if (metadataConfig.save_album_review) {
        this.relocateSingletonSidecar({
          artistId,
          albumId,
          expectedPath: reviewPath,
          libraryRoot: targetRoot,
          fileType: "review",
        });
      }
      if (metadataConfig.save_album_review && !fs.existsSync(reviewPath)) {
        try {
          await saveReviewFile(albumId, reviewPath);
          if (fs.existsSync(reviewPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId,
              mediaId: null,
              filePath: reviewPath,
              libraryRoot: targetRoot,
              fileType: "review",
              quality: null,
              namingTemplate: null,
              expectedPath: reviewPath,
            });
          }
        } catch {
          // ignore
        }
      }

      onProgress?.({
        phase: "finalizing",
        currentFileNum: 1,
        totalFiles: 1,
        currentTrack: trackTitle,
        statusMessage: `Finalizing ${trackTitle}`,
      });

      // Return result for track
      return {
        type: "track",
        tidalId,
        processedTrackIds: [tidalId],
        totalTracksInStaging: 1,
      };
    }

    if (type === "video") {
      const allFiles = this.findFilesRecursively(downloadPath);
      const src =
        allFiles.find(f => path.basename(f, path.extname(f)) === tidalId) ||
        (allFiles.length === 1 ? allFiles[0] : null) ||
        allFiles.find(f => path.basename(f).includes(tidalId));
      if (!src) {
        if (allFiles.length === 0) {
          throw new Error(`Download failed: No files were downloaded. The video might be unavailable or DRM protected.`);
        }
        throw new Error(`Download failed: Could not locate video file in downloaded files.`);
      }

      // Ensure video exists in DB
      let fetchedVideoData: any | null = null;
      let video = db.prepare("SELECT * FROM media WHERE id = ? AND type = 'Music Video'").get(tidalId) as any;
      if (!video) {
        fetchedVideoData = await getVideo(tidalId);
        const videoData = fetchedVideoData;
        const videoCoverId = videoData.image_id || null;

        // Ensure artist exists
        const videoArtistId = videoData.artist_id ? String(videoData.artist_id) : null;
        if (!videoArtistId || !/^\d+$/.test(videoArtistId)) {
          throw new Error(`[Organizer] Video ${tidalId} missing valid artist_id`);
        }

        const exists = db.prepare("SELECT id FROM artists WHERE id = ?").get(videoArtistId) as any;
        if (!exists) {
          try {
            const a = await getArtist(videoArtistId);
            db.prepare("INSERT OR IGNORE INTO artists (id, name, picture, popularity, monitor) VALUES (?, ?, ?, ?, 0)")
              .run(videoArtistId, a.name, a.picture || null, a.popularity || 0);
          } catch {
            // ignore
          }
        }

        // Upsert video
        db.prepare(`
          INSERT INTO media (
            id, artist_id, album_id, title, version, release_date, type,
            explicit, quality, duration, popularity, cover,
            monitor, downloaded
          ) VALUES (?, ?, ?, ?, ?, ?, 'Music Video', ?, ?, ?, ?, ?, 0, 0)
          ON CONFLICT(id) DO UPDATE SET
            artist_id=excluded.artist_id,
          album_id=excluded.album_id,
          title=excluded.title,
          version=excluded.version,
          release_date=excluded.release_date,
            explicit=excluded.explicit,
            quality=excluded.quality,
            duration=excluded.duration,
            popularity=excluded.popularity,
            cover=COALESCE(excluded.cover, cover)
        `).run(
          tidalId,
          videoArtistId,
          videoData.album_id || null,
          videoData.title,
          null,
          videoData.release_date || null,
          videoData.explicit ? 1 : 0,
          videoData.quality || null,
          videoData.duration || null,
          videoData.popularity || 0,
          videoCoverId,
        );

        video = db.prepare("SELECT * FROM media WHERE id = ? AND type = 'Music Video'").get(tidalId) as any;
      }
      if (!video) throw new Error(`Video ${tidalId} not found in DB after fetch`);

      onProgress?.({
        phase: "importing",
        currentFileNum: 0,
        totalFiles: 1,
        currentTrack: video.title,
        statusMessage: "Importing downloaded video",
      });

      const artistId = String(video.artist_id);
      let artistName = (db.prepare("SELECT name FROM artists WHERE id = ?").get(artistId) as any)?.name as string | undefined;
      if (!artistName) {
        const remoteArtist = await getArtist(artistId);
        artistName = remoteArtist.name;
        db.prepare("INSERT OR IGNORE INTO artists (id, name, picture, popularity, monitor) VALUES (?, ?, ?, ?, 0)")
          .run(artistId, artistName, remoteArtist.picture || null, remoteArtist.popularity || 0);
      }

      const resolvedArtistName = artistName || "Unknown Artist";
      const naming = getNamingConfig();
      const artistFolder = renderRelativePath(naming.artist_folder, {
        artistName: resolvedArtistName,
        artistId,
        videoTitle: video.title
      });
      const targetDir = path.join(videoRoot, artistFolder);
      this.ensureDir(targetDir);

      const ext = path.extname(src);
      const destName = `${renderFileStem(naming.video_file, {
        artistName: resolvedArtistName,
        artistId,
        trackId: tidalId,
        videoTitle: video.title
      })}.mp4`;
      const dest = path.join(targetDir, destName);

      // Convert to MP4 directly from source into destination if not already MP4
      if (ext !== '.mp4') {
        console.log(`[Organizer] Converting video ${src} to ${dest}...`);
        const success = await convertToMp4(src, dest);
        if (!success) {
          throw new Error(`[Organizer] MP4 conversion failed for ${src}`);
        }
        // Cleanup the parsed source TS/MKV file if successful
        try { fs.rmSync(src, { force: true }); } catch (e) { console.warn('Failed to delete source video', e); }
      } else {
        this.moveFileCrossDevice(src, dest);
      }

      // Analyze file quality/resolution from the actual downloaded file.
      const metrics = await parseAudioFile(dest);
      const derivedVideoQuality = deriveVideoQuality(metrics) ?? video.quality ?? null;

      const libraryFileId = this.upsertLibraryFile({
        artistId,
        albumId: video.album_id ? String(video.album_id) : null,
        mediaId: tidalId,
        filePath: dest,
        libraryRoot: videoRoot,
        fileType: "video",
        quality: derivedVideoQuality,
        namingTemplate: "default",
        expectedPath: dest,
        bitDepth: metrics.bitDepth,
        sampleRate: metrics.sampleRate,
        bitrate: metrics.bitrate,
        codec: metrics.codec,
        channels: metrics.channels
      });

      try {
        recordHistoryEvent({
          artistId,
          albumId: video.album_id ? String(video.album_id) : null,
          mediaId: tidalId,
          libraryFileId,
          eventType: HISTORY_EVENT_TYPES.TrackFileImported,
          quality: derivedVideoQuality,
          sourceTitle: video.title,
          data: {
            importedPath: dest,
          },
        });
      } catch (historyError) {
        console.warn(`[Organizer] Failed to record video import history for ${tidalId}:`, historyError);
      }

      // Clean up any other old files for this video (handles extension changes beyond .ts → .mp4)
      this.cleanupOldMediaFiles(tidalId, dest, "video");
      this.cleanupSiblingMediaVariants(dest, "video");

      if (metadataConfig.save_video_thumbnail || metadataConfig.embed_video_thumbnail !== false) {
        const persistentCoverPath = metadataConfig.save_video_thumbnail
          ? this.relocateLinkedSidecar({
            artistId,
            albumId: video.album_id ? String(video.album_id) : null,
            mediaId: tidalId,
            mediaPath: dest,
            libraryRoot: videoRoot,
            fileType: "video_thumbnail",
            quality: derivedVideoQuality,
            namingTemplate: "default",
          })
          : null;
        const transientCoverPath = persistentCoverPath ? null : path.join(path.dirname(dest), `.${path.parse(dest).name}.embed-thumb.jpg`);
        const coverPath = persistentCoverPath || transientCoverPath;
        let coverId = video.cover ? String(video.cover) : (fetchedVideoData?.image_id || null);
        if (!coverId) {
          try {
            fetchedVideoData = fetchedVideoData ?? await getVideo(tidalId);
            coverId = fetchedVideoData?.image_id || null;
            if (coverId) {
              db.prepare("UPDATE media SET cover = COALESCE(?, cover) WHERE id = ? AND type = 'Music Video'")
                .run(coverId, tidalId);
              video.cover = coverId;
            }
          } catch {
            // ignore
          }
        }

        if (coverId) {
          const videoThumbnailResolution = metadataConfig.video_thumbnail_resolution || "1080x720";
          if (coverPath && !fs.existsSync(coverPath)) {
            await downloadVideoThumbnail(coverId, videoThumbnailResolution as any, coverPath);
          }
        }

        if (persistentCoverPath && fs.existsSync(persistentCoverPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId: video.album_id ? String(video.album_id) : null,
            mediaId: tidalId,
            filePath: persistentCoverPath,
            libraryRoot: videoRoot,
            fileType: "video_thumbnail",
            quality: derivedVideoQuality,
            namingTemplate: "default",
            expectedPath: persistentCoverPath,
          });
        }

        if (metadataConfig.embed_video_thumbnail !== false && coverPath && fs.existsSync(coverPath)) {
          await embedVideoThumbnail(dest, coverPath);
        }

        if (!persistentCoverPath && transientCoverPath && fs.existsSync(transientCoverPath)) {
          fs.rmSync(transientCoverPath, { force: true });
        }
      }

      onProgress?.({
        phase: "finalizing",
        currentFileNum: 1,
        totalFiles: 1,
        currentTrack: video.title,
        statusMessage: `Finalizing ${video.title}`,
      });

      // Return result for video
      return {
        type: "video",
        tidalId,
        processedTrackIds: [tidalId],
        totalTracksInStaging: 1,
      };
    }

    // Fallback for any unhandled type (shouldn't happen)
    throw new Error(`[Organizer] Unhandled type: ${type}`);
  }
}
