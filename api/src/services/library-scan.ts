import fs from "fs";
import path from "path";
import * as mm from "music-metadata";
import { db } from "../database.js";
import { Config, getConfigSection } from "./config.js";
import { getNamingConfig, renderRelativePath } from "./naming.js";
import { UnmappedFilesService } from "./unmapped-files.js";
import { ImportService } from "./import-service.js";
import { getUnmappedMediaMetrics } from "./library-media-metrics.js";
import { clearRootFolderReviewEntries, persistRootReviewCandidates } from "./library-scan-root-review.js";
import { relinkUnresolvedLibraryFiles } from "./library-scan-relink.js";
import { resolveLibraryRootKey, resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import {
    updateAlbumDownloadStatus,
    updateArtistDownloadStatusFromMedia,
} from "./download-state.js";
import { getManagedArtists } from "./managed-artists.js";
import {
    queueArtistWorkflow,
} from "./artist-workflow.js";
import { LibraryFilesService } from "./library-files.js";
import { libraryMetadataBackfillService, type MetadataFillResult } from "./library-metadata-backfill.js";
import { createCooperativeBatcher, yieldToEventLoop } from "../utils/concurrent.js";

// ============================================================================
// Types
// ============================================================================

const MEDIA_EXTENSIONS = new Set([
    '.flac', '.alac', '.wav', '.aiff', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma',
    '.mp4', '.m4v', '.mkv', '.mov', '.avi', '.ts', '.webm'
]);

export interface DiskScanResult {
    /** DB records removed because file no longer exists on disk */
    orphansRemoved: number;
    /** New files found on disk and indexed into library_files */
    filesIndexed: number;
    /** Existing records updated (size/mtime changed) */
    filesUpdated: number;
    /** Media/album downloaded flags that were reset due to missing files */
    downloadFlagsReset: number;
}
export type { MetadataFillResult } from "./library-metadata-backfill.js";

export interface DiscoveryResult {
    /** Folder names that matched existing DB artists (already managed) */
    knownFolders: number;
    /** New artists discovered from scanned files or TIDAL search */
    artistsAdded: Array<{ id: string; name: string; folderName: string }>;
    /** Folder names that couldn't be matched to a TIDAL artist */
    unmatchedFolders: string[];
    /** Total top-level folders scanned */
    totalFolders: number;
}

export interface DiscoveryProgress {
    phase: "discovery" | "evaluation" | "import" | "review" | "complete";
    message: string;
    progress?: number;
    currentFileNum?: number;
    totalFiles?: number;
}

export interface ScanOptions {
    /** Scope scan to specific artist IDs. When omitted, all managed artists are scanned. */
    artistIds?: string[];
    /** Discover and import unknown artist folders found in library roots. */
    addNewArtists?: boolean;
    /** Monitor newly discovered artists. Only relevant when addNewArtists is true. */
    monitorNewArtists?: boolean;
    /** Queue full processing workflow for discovered artists. */
    fullProcessing?: boolean;
    /** Trigger context for any queued workflows. */
    trigger?: number;
    /** Progress callback. */
    onProgress?: (event: ScanProgress) => void;
}

export type ScanProgress = {
    phase: "reconcile" | "discovery" | "evaluation" | "import" | "review" | "complete";
    message: string;
    progress: number;
    artistIndex?: number;
    artistsTotal?: number;
    currentFileNum?: number;
    totalFiles?: number;
};

export interface ScanResult extends DiskScanResult {
    /** Number of artists whose files were reconciled */
    artists: number;
    /** Stale unmapped file records removed */
    unmappedOrphans: number;
    /** Discovery results (only populated when addNewArtists is true) */
    discovery?: DiscoveryResult;
}

type ArtistScanProgress = {
    phase: "cleanup" | "index" | "verify";
    message: string;
    progress: number;
    currentFileNum?: number;
    totalFiles?: number;
};

type FullLibraryScanProgress = {
    phase: "artists" | "unmapped";
    message: string;
    artistIndex: number;
    artistsTotal: number;
    progress?: number;
    currentFileNum?: number;
    totalFiles?: number;
};

type LibraryRootKey = "music" | "spatial_music" | "music_videos";

/** Pre-built file index from a single-pass root walk, keyed by lowercased folder name. */
type RootFileIndex = Map<string, Map<string, string[]>>; // rootPath → (folderKey → files)

// ============================================================================
// Disk Scan Service
// ============================================================================

/**
 * DiskScanService — Reconciles the library_files DB with actual disk state
 * and handles metadata file backfill.
 *
 * Modelled after Lidarr's DiskScanService:
 * 1. Clean orphaned records (DB entries for files that no longer exist)
 * 2. Index new files found on disk (manually placed files)
 * 3. Update changed files (size/mtime mismatch)
 * 4. Backfill missing metadata files (covers, bios, lyrics, etc.)
 */
export class DiskScanService {
    private static readonly unmappedFilesService = new UnmappedFilesService();

    // ==========================================================================
    // Public API — Lidarr-style Scan(folders, filter, addNewArtists, artistIds)
    // ==========================================================================

    /**
     * Unified disk scan entry point, modelled after Lidarr's DiskScanService.Scan().
     *
     * - No options or empty options → scan all managed artists (reconcile library_files with disk)
     * - artistIds provided → scan only those artists' directories
     * - addNewArtists: true → also discover unknown folders and import new artists
     *
     * When scanning all artists, library roots are walked once and a file index is
     * built so that individual artist scans avoid redundant filesystem walks.
     */
    static async scan(options: ScanOptions = {}): Promise<ScanResult> {
        const { artistIds, addNewArtists = false, onProgress } = options;

        const result: ScanResult = {
            artists: 0,
            orphansRemoved: 0,
            filesIndexed: 0,
            filesUpdated: 0,
            downloadFlagsReset: 0,
            unmappedOrphans: 0,
        };

        const isPerArtist = Array.isArray(artistIds) && artistIds.length > 0;

        if (isPerArtist) {
            // Per-artist scan: scan only the specified artists
            for (let i = 0; i < artistIds.length; i++) {
                const artistId = artistIds[i];
                onProgress?.({
                    phase: "reconcile",
                    message: `Scanning artist ${i + 1}/${artistIds.length}`,
                    progress: Math.round((i / artistIds.length) * 90),
                    artistIndex: i + 1,
                    artistsTotal: artistIds.length,
                });
                const artistResult = await this.scanArtist(artistId, {
                    onProgress: (event) => {
                        onProgress?.({
                            phase: "reconcile",
                            message: event.message,
                            progress: event.progress,
                            currentFileNum: event.currentFileNum,
                            totalFiles: event.totalFiles,
                        });
                    },
                });
                result.artists++;
                result.orphansRemoved += artistResult.orphansRemoved;
                result.filesIndexed += artistResult.filesIndexed;
                result.filesUpdated += artistResult.filesUpdated;
                result.downloadFlagsReset += artistResult.downloadFlagsReset;
            }
        } else {
            // Batch scan: reconcile all managed artists with single-pass file index
            const reconcileResult = await this.reconcileAllArtists((event) => {
                const progress = addNewArtists
                    ? Math.min(65, event.progress ?? 35)
                    : Math.min(95, event.progress ?? 50);
                onProgress?.({
                    phase: "reconcile",
                    message: event.message,
                    progress,
                    artistIndex: event.artistIndex,
                    artistsTotal: event.artistsTotal,
                    currentFileNum: event.currentFileNum,
                    totalFiles: event.totalFiles,
                });
            });
            result.artists = reconcileResult.artists;
            result.orphansRemoved = reconcileResult.totalOrphans;
            result.downloadFlagsReset = reconcileResult.totalFlagsReset;
            result.unmappedOrphans = reconcileResult.unmappedOrphans;
        }

        // Discovery phase: find unknown folders and import new artists
        if (addNewArtists) {
            onProgress?.({
                phase: "discovery",
                message: "Discovering new artist folders",
                progress: 70,
            });
            result.discovery = await this.discoverNewArtists(
                (event) => {
                    onProgress?.({
                        phase: event.phase as ScanProgress["phase"],
                        message: event.message,
                        progress: event.progress ?? 85,
                        currentFileNum: event.currentFileNum,
                        totalFiles: event.totalFiles,
                    });
                },
                {
                    monitorArtist: options.monitorNewArtists ?? true,
                    fullProcessing: options.fullProcessing ?? false,
                    trigger: options.trigger ?? 1,
                },
            );
        }

        onProgress?.({
            phase: "complete",
            message: "Scan complete",
            progress: 100,
        });

        return result;
    }

    // ==========================================================================
    // Disk Scan — Reconcile library_files with disk reality
    // ==========================================================================

    /**
     * Delete any unmapped_files records where the file no longer exists on disk.
     */
    static pruneUnmappedFiles(): number {
        let unmappedOrphans = 0;
        const unmappedRows = db.prepare("SELECT id, file_path FROM unmapped_files").all() as Array<{ id: number; file_path: string }>;
        for (const row of unmappedRows) {
            if (!fs.existsSync(row.file_path)) {
                db.prepare("DELETE FROM unmapped_files WHERE id = ?").run(row.id);
                unmappedOrphans++;
            }
        }
        return unmappedOrphans;
    }

    /**
     * Scan an artist's library directories and reconcile library_files with disk.
     *
     * Phase A: Remove DB records for files that no longer exist on disk.
     * Phase B: Walk artist directories, index any files not yet in library_files.
     * Phase C: Update records where file size/mtime has changed.
     *
     * When called from `reconcileAllArtists`, a pre-built `fileIndex` is passed
     * so that each library root is walked only once (Lidarr-style single-pass).
     */
    private static async scanArtist(
        artistId: string,
        options?: {
            onProgress?: (event: ArtistScanProgress) => void;
            fileIndex?: RootFileIndex;
        },
    ): Promise<DiskScanResult> {
        const result: DiskScanResult = {
            orphansRemoved: 0,
            filesIndexed: 0,
            filesUpdated: 0,
            downloadFlagsReset: 0,
        };

        // Phase A: Clean orphaned records
        options?.onProgress?.({
            phase: "cleanup",
            message: "Checking tracked files against disk",
            progress: 10,
        });
        const phaseA = this.cleanOrphanedRecords(artistId);
        result.orphansRemoved = phaseA.removed;
        result.downloadFlagsReset = phaseA.flagsReset;

        // Phase B: Index new files on disk
        options?.onProgress?.({
            phase: "index",
            message: "Importing new files from disk",
            progress: 45,
        });
        const phaseB = await this.indexNewFiles(artistId, {
            onProgress: (event) => {
                options?.onProgress?.(event);
            },
            fileIndex: options?.fileIndex,
        });
        result.filesIndexed = phaseB.indexed;

        // Phase C: Update changed files
        options?.onProgress?.({
            phase: "verify",
            message: "Verifying tracked file changes",
            progress: 80,
        });
        const phaseC = this.updateChangedFiles(artistId);
        result.filesUpdated = phaseC.updated;

        // Phase D: Re-link historical/manual rows that have a file path but no media link.
        const phaseD = relinkUnresolvedLibraryFiles({
            artistId,
            fileExists: (filePath) => fs.existsSync(filePath),
            resolveStoredLibraryPath,
            resolveLibraryRootKey,
            resolveLibraryRootPath,
            getDefaultLibraryRootPath: () => Config.getMusicPath(),
            matchFileToMedia: (filePath, targetArtistId, libraryRoot) => this.matchFileToMedia(filePath, targetArtistId, libraryRoot),
            upsertLibraryFile: (params) => this.upsertLibraryFile(params),
        });
        result.filesUpdated += phaseD.relinked;

        LibraryFilesService.pruneDuplicateTrackedAssets(artistId);

        if (result.orphansRemoved > 0 || result.filesIndexed > 0 || result.filesUpdated > 0) {
            console.log(
                `[DiskScan] Artist ${artistId}: ` +
                `${result.orphansRemoved} orphans removed, ` +
                `${result.filesIndexed} new files indexed, ` +
                `${result.filesUpdated} files updated, ` +
                `${result.downloadFlagsReset} download flags reset`
            );
        }

        return result;
    }

    /**
     * Scan ALL managed artists' library directories and reconcile library_files
     * with disk. Walks each library root once and builds a file index so that
     * individual artist scans avoid redundant filesystem walks (Lidarr-style
     * single-pass collection scan).
     *
     * Used by RescanFolders to detect missing files across the entire library.
     */
    private static async reconcileAllArtists(
        onProgress?: (event: FullLibraryScanProgress) => void,
    ): Promise<{ artists: number; totalOrphans: number; totalFlagsReset: number; unmappedOrphans: number }> {
        const artists = getManagedArtists({ includeLibraryFiles: true })
            .map((artist) => ({ id: String(artist.id), name: artist.name || String(artist.id) }));
        let totalOrphans = 0;
        let totalFlagsReset = 0;
        let unmappedOrphans = 0;

        // Build file index once per root (single-pass, Lidarr-style)
        const fileIndex: RootFileIndex = new Map();
        const musicPath = Config.getMusicPath();
        const videoPath = Config.getVideoPath();
        const atmosPath = Config.getAtmosPath();

        fileIndex.set(musicPath, await this.buildRootFileIndex(musicPath));
        fileIndex.set(videoPath, await this.buildRootFileIndex(videoPath));
        if (atmosPath) {
            fileIndex.set(atmosPath, await this.buildRootFileIndex(atmosPath));
        }

        for (let index = 0; index < artists.length; index += 1) {
            const artist = artists[index];
            const progressBase = artists.length > 0 ? (index / artists.length) : 0;
            const progressSpan = artists.length > 0 ? (1 / artists.length) : 1;
            onProgress?.({
                phase: "artists",
                artistIndex: index + 1,
                artistsTotal: artists.length,
                progress: Math.min(65, 10 + Math.round(progressBase * 50)),
                message: `Reconciling ${artist.name} (${index + 1}/${artists.length})`,
            });
            const result = await this.scanArtist(String(artist.id), {
                onProgress: (event) => {
                    const nestedProgress = progressBase + (progressSpan * (event.progress / 100));
                    const label = event.phase === "index" && event.totalFiles !== undefined
                        ? `Reconciling ${artist.name} (${index + 1}/${artists.length}) - scanning ${event.currentFileNum ?? 0}/${event.totalFiles} files`
                        : `Reconciling ${artist.name} (${index + 1}/${artists.length}) - ${event.message}`;

                    onProgress?.({
                        phase: "artists",
                        artistIndex: index + 1,
                        artistsTotal: artists.length,
                        progress: Math.min(65, 10 + Math.round(nestedProgress * 50)),
                        currentFileNum: event.currentFileNum,
                        totalFiles: event.totalFiles,
                        message: label,
                    });
                },
                fileIndex,
            });
            totalOrphans += result.orphansRemoved;
            totalFlagsReset += result.downloadFlagsReset;
            await yieldToEventLoop();
        }

        // Global cleanup for unmapped files
        onProgress?.({
            phase: "unmapped",
            artistIndex: artists.length,
            artistsTotal: artists.length,
            progress: 68,
            message: "Cleaning stale manual import entries",
        });
        unmappedOrphans = this.pruneUnmappedFiles();

        if (totalOrphans > 0 || totalFlagsReset > 0 || unmappedOrphans > 0) {
            console.log(
                `[DiskScan] Full library disk reconciliation: ` +
                `${artists.length} artists scanned, ` +
                `${totalOrphans} library orphans removed, ` +
                `${unmappedOrphans} unmapped orphans removed, ` +
                `${totalFlagsReset} download flags reset`
            );
        }

        return { artists: artists.length, totalOrphans, totalFlagsReset, unmappedOrphans };
    }

    /**
    * Phase A: Remove library_files records whose file no longer exists on disk.
     */
    private static cleanOrphanedRecords(artistId: string): { removed: number; flagsReset: number } {
        const rows = db.prepare(`
      SELECT id, file_path, relative_path, library_root, media_id, album_id, file_type
      FROM library_files
      WHERE artist_id = ?
    `).all(artistId) as Array<{
            id: number;
            file_path: string;
            relative_path: string | null;
            library_root: string;
            media_id: number | null;
            album_id: number | null;
            file_type: string;
        }>;

        let removed = 0;
        for (const row of rows) {
            const resolvedPath = resolveStoredLibraryPath({
                filePath: row.file_path,
                libraryRoot: row.library_root,
                relativePath: row.relative_path,
            });
            if (fs.existsSync(resolvedPath)) continue;

            // File is gone — remove DB record
            db.prepare("DELETE FROM library_files WHERE id = ?").run(row.id);
            removed++;
        }

        return { removed, flagsReset: 0 };
    }

    /**
     * Phase B: Walk the artist's directories on disk and index any files not yet
     * in library_files. Attempts to match files to known media by path patterns.
     *
     * When a pre-built `fileIndex` is provided (from `reconcileAllArtists`), the
     * walk is skipped and the cached file list is used instead.
     */
    private static async indexNewFiles(
        artistId: string,
        options?: {
            onProgress?: (event: ArtistScanProgress) => void;
            fileIndex?: RootFileIndex;
        },
    ): Promise<{ indexed: number }> {
        const artist = db.prepare("SELECT name FROM artists WHERE id = ?").get(artistId) as any;
        if (!artist) return { indexed: 0 };

        const naming = getNamingConfig();
        const artistFolder = renderRelativePath(naming.artist_folder, { artistName: artist.name });

        // Collect all existing file paths for this artist (for quick lookup)
        const existingPaths = new Set(
            (db.prepare("SELECT file_path, relative_path, library_root FROM library_files WHERE artist_id = ?").all(artistId) as Array<{
                file_path: string;
                relative_path: string | null;
                library_root: string;
            }>)
                .map((row) => resolveStoredLibraryPath({
                    filePath: row.file_path,
                    libraryRoot: row.library_root,
                    relativePath: row.relative_path,
                }))
                .map((filePath) => path.resolve(filePath))
        );

        let indexed = 0;
        let shouldPromoteArtist = false;

        // Scan each library root where this artist might have files
        const roots: Array<{ key: LibraryRootKey; dir: string }> = [
            { key: "music", dir: path.join(Config.getMusicPath(), artistFolder) },
            { key: "music_videos", dir: path.join(Config.getVideoPath(), artistFolder) },
        ];

        const atmosPath = Config.getAtmosPath();
        if (atmosPath) {
            roots.push({ key: "spatial_music", dir: path.join(atmosPath, artistFolder) });
        }

        const scanTargetsByDir = new Map<string, {
            key: LibraryRootKey;
            dir: string;
            rootPath: string;
            allFiles: string[];
        }>();

        const prebuiltIndex = options?.fileIndex;

        for (const { key, dir } of roots) {
            if (!fs.existsSync(dir)) continue;

            const rootPath = key === "music"
                ? Config.getMusicPath()
                : key === "spatial_music"
                    ? Config.getAtmosPath()
                    : Config.getVideoPath();
            if (!rootPath) continue;

            const dirKey = path.resolve(dir);
            if (scanTargetsByDir.has(dirKey)) {
                continue;
            }

            // Use pre-built index if available, otherwise walk directory on demand
            const folderKey = artistFolder.toLowerCase();
            const prebuiltForRoot = prebuiltIndex?.get(rootPath);
            const cachedFiles = prebuiltForRoot?.get(folderKey);
            const allFiles = cachedFiles ?? await this.getMediaFiles(dir);

            scanTargetsByDir.set(dirKey, {
                key,
                dir,
                rootPath,
                allFiles,
            });
        }

        const scanTargets = Array.from(scanTargetsByDir.values());

        const totalFiles = scanTargets.reduce((sum, target) => sum + target.allFiles.length, 0);
        let processedFiles = 0;
        let lastReportedFiles = -1;

        const reportIndexProgress = () => {
            if (totalFiles === 0) {
                options?.onProgress?.({
                    phase: "index",
                    message: "No files found on disk",
                    progress: 75,
                    currentFileNum: 0,
                    totalFiles,
                });
                return;
            }

            if (
                processedFiles !== totalFiles &&
                processedFiles !== 1 &&
                processedFiles - lastReportedFiles < 25
            ) {
                return;
            }

            lastReportedFiles = processedFiles;
            const normalizedProgress = Math.min(75, 45 + Math.round((processedFiles / Math.max(totalFiles, 1)) * 30));
            options?.onProgress?.({
                phase: "index",
                message: `Scanning ${processedFiles}/${totalFiles} files`,
                progress: normalizedProgress,
                currentFileNum: processedFiles,
                totalFiles,
            });
        };

        reportIndexProgress();

        for (const { key, dir, rootPath, allFiles } of scanTargets) {
            if (!rootPath) continue;

            for (const filePath of allFiles) {
                processedFiles += 1;
                reportIndexProgress();

                const resolved = path.resolve(filePath);
                if (existingPaths.has(resolved)) continue;

                // New file on disk — attempt to match and index
                const match = this.matchFileToMedia(filePath, artistId, key);
                if (match) {
                    this.upsertLibraryFile({
                        artistId,
                        albumId: match.albumId,
                        mediaId: match.mediaId,
                        filePath,
                        libraryRoot: rootPath,
                        fileType: match.fileType,
                        quality: match.quality,
                        expectedPath: filePath,
                    });

                    if (match.mediaId && (match.fileType === "track" || match.fileType === "video")) {
                        shouldPromoteArtist = true;
                        db.prepare(`
                            UPDATE media
                            SET monitor = CASE
                                    WHEN monitor_lock = 0 OR monitor_lock IS NULL THEN 1
                                    ELSE monitor
                                END,
                                monitored_at = CASE
                                    WHEN monitor_lock = 0 OR monitor_lock IS NULL THEN COALESCE(monitored_at, CURRENT_TIMESTAMP)
                                    ELSE monitored_at
                                END
                            WHERE id = ?
                        `).run(match.mediaId);
                        if (match.albumId && match.fileType === "track") {
                            db.prepare(`
                                UPDATE albums
                                SET monitor = CASE
                                        WHEN monitor_lock = 0 OR monitor_lock IS NULL THEN 1
                                        ELSE monitor
                                    END,
                                    monitored_at = CASE
                                        WHEN monitor_lock = 0 OR monitor_lock IS NULL THEN COALESCE(monitored_at, CURRENT_TIMESTAMP)
                                        ELSE monitored_at
                                    END
                                WHERE id = ?
                            `).run(match.albumId);
                            db.prepare(`
                                UPDATE media
                                SET monitor = 1,
                                    monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
                                WHERE album_id = ?
                                  AND (monitor_lock = 0 OR monitor_lock IS NULL)
                            `).run(match.albumId);
                            updateAlbumDownloadStatus(match.albumId);
                        } else {
                            updateArtistDownloadStatusFromMedia(match.mediaId);
                        }
                    }

                    indexed++;
                    existingPaths.add(resolved);

                    // Cleanup any existing unmapped_file record for this path
                    db.prepare("DELETE FROM unmapped_files WHERE file_path = ?").run(resolved);
                } else {
                    // No match found in Tidal database. Track this as an unmapped file.
                    try {
                        const stats = fs.statSync(resolved);
                        const ext = path.extname(resolved).toLowerCase();

                        // Only track unrecognized media files (ignore images, text files, NFOs, etc.)
                        if (!MEDIA_EXTENSIONS.has(ext)) continue;

                        // Try to guess artist/album from folder structure
                        const relative = path.relative(rootPath, resolved);
                        const segments = relative.split(path.sep);
                        let detectedArtist = segments.length >= 1 ? segments[0] : artist.name;
                        let detectedAlbum = segments.length >= 2 ? segments[1] : null;
                        let detectedTrack = null;
                        let bitrate: number | null = null;
                        let sampleRate: number | null = null;
                        let bitDepth: number | null = null;
                        let channels: number | null = null;
                        let codec: string | null = null;
                        let audioQuality = null;
                        let duration: number | null = null;

                        // Parse ID3 tags to get real metadata if possible
                        try {
                            const metadata = await mm.parseFile(resolved, { skipCovers: true });
                            if (metadata.common.artist) detectedArtist = metadata.common.artist;
                            else if (metadata.common.albumartist) detectedArtist = metadata.common.albumartist;

                            if (metadata.common.album) detectedAlbum = metadata.common.album;
                            if (metadata.common.title) detectedTrack = metadata.common.title;

                            if (metadata.format) {
                                const metrics = getUnmappedMediaMetrics(metadata.format, ext);
                                duration = metrics.duration;
                                bitrate = metrics.bitrate;
                                sampleRate = metrics.sampleRate;
                                bitDepth = metrics.bitDepth;
                                channels = metrics.channels;
                                codec = metrics.codec;
                                audioQuality = metrics.audioQuality;
                            }
                        } catch (err) {
                            // ignore parse error and fallback to directory structure
                        }

                        db.prepare(`
                            INSERT INTO unmapped_files (
                                file_path, relative_path, library_root, filename, extension, file_size, duration,
                                bitrate, sample_rate, bit_depth, channels, codec,
                                detected_artist, detected_album, detected_track, audio_quality, reason
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(file_path) DO UPDATE SET
                                relative_path = excluded.relative_path,
                                library_root = excluded.library_root,
                                file_size = excluded.file_size,
                                duration = excluded.duration,
                                bitrate = COALESCE(excluded.bitrate, bitrate),
                                sample_rate = COALESCE(excluded.sample_rate, sample_rate),
                                bit_depth = COALESCE(excluded.bit_depth, bit_depth),
                                channels = COALESCE(excluded.channels, channels),
                                codec = COALESCE(excluded.codec, codec),
                                detected_artist = COALESCE(excluded.detected_artist, detected_artist),
                                detected_album = COALESCE(excluded.detected_album, detected_album),
                                detected_track = COALESCE(excluded.detected_track, detected_track),
                                audio_quality = COALESCE(excluded.audio_quality, audio_quality),
                                updated_at = CURRENT_TIMESTAMP
                        `).run(
                            resolved,
                            relative,
                            key,
                            path.basename(resolved),
                            ext,
                            stats.size,
                            duration,
                            bitrate,
                            sampleRate,
                            bitDepth,
                            channels,
                            codec,
                            detectedArtist,
                            detectedAlbum,
                            detectedTrack,
                            audioQuality,
                            "No matching TIDAL track found"
                        );
                    } catch (e) {
                        console.error(`[DiskScan] Failed to track unmapped file ${resolved}:`, e);
                    }
                }
            }

            // Group unmapped files by detected release and let the shared manual-import pipeline
            // evaluate whether the folder is confident enough to auto-import.
            const folderPathPattern = `${dir}${dir.endsWith(path.sep) ? "" : path.sep}%`;
            const folderUnmappedFiles = db.prepare(`
                SELECT * FROM unmapped_files
                WHERE file_path LIKE ?
            `).all(folderPathPattern) as any[];

            if (folderUnmappedFiles.length >= 1) {
                const albumGroups = new Map<string, any[]>();

                for (const f of folderUnmappedFiles) {
                    const artist = f.detected_artist || 'Unknown Artist';
                    const album = f.detected_album || 'Unknown Album';
                    // Skip files with no detected album to avoid bogus grouping
                    if (album === 'Unknown Album' && artist === 'Unknown Artist') continue;

                    const groupKey = `${artist}|${album}`;
                    if (!albumGroups.has(groupKey)) albumGroups.set(groupKey, []);
                    albumGroups.get(groupKey)!.push(f);
                }

                for (const [groupKey, groupFiles] of albumGroups.entries()) {
                    const [consensusArtist, consensusAlbum] = groupKey.split('|');

                    if (consensusArtist && consensusAlbum && consensusAlbum !== 'Unknown Album') {
                        try {
                            console.log(`[DiskScan] Auto-Import feature evaluating "${consensusArtist} - ${consensusAlbum}" (${groupFiles.length} files) in ${dir}`);
                            const explicitAlbumId = this.extractTidalAlbumIdFromPath(groupFiles[0]?.file_path);

                            if (explicitAlbumId) {
                                const directMatch = await this.unmappedFilesService.identifyAgainstAlbum(
                                    groupFiles.map((file) => Number(file.id)),
                                    explicitAlbumId,
                                    "ExistingFiles",
                                );

                                if (directMatch.autoImportReady) {
                                    const mappingPayload = Object.entries(directMatch.mappedTracks).map(([fileId, tidalId]) => ({
                                        id: Number(fileId),
                                        tidalId,
                                    }));

                                    if (mappingPayload.length > 0) {
                                        console.log(`[DiskScan] SUCCESS: Auto-importing ${mappingPayload.length}/${groupFiles.length} files via explicit TIDAL album ${explicitAlbumId}`);
                                        await this.unmappedFilesService.bulkMap(mappingPayload);
                                        indexed += mappingPayload.length;
                                        shouldPromoteArtist = true;
                                        continue;
                                    }
                                }

                                console.log(
                                    `[DiskScan] Explicit TIDAL album ${explicitAlbumId} rejected by import decision pipeline` +
                                    `${directMatch.rejections?.length ? `: ${directMatch.rejections.join(", ")}` : "."}`
                                );
                            }

                            const bestMatch = await this.unmappedFilesService.findBestAlbumCandidate(
                                groupFiles,
                                "ExistingFiles"
                            );
                            if (!bestMatch) {
                                continue;
                            }

                            if (bestMatch.autoImportReady) {
                                const mappingPayload = Object.entries(bestMatch.trackIdsByFilePath || {}).map(([filePath, tidalId]) => ({
                                    id: Number(groupFiles.find((file) => file.file_path === filePath)?.id || 0),
                                    tidalId,
                                })).filter((item) => item.id > 0);

                                if (mappingPayload.length > 0) {
                                    console.log(
                                        `[DiskScan] SUCCESS: Auto-importing ${mappingPayload.length}/${groupFiles.length} files into TIDAL album ` +
                                        `${bestMatch.item.id || bestMatch.item.tidal_id}`
                                    );
                                    await this.unmappedFilesService.bulkMap(mappingPayload);
                                    indexed += mappingPayload.length;
                                    shouldPromoteArtist = true;
                                }
                            } else {
                                console.log(
                                    `[DiskScan] Passing: best match for ${consensusArtist} - ${consensusAlbum} was rejected by import decision pipeline` +
                                    `${bestMatch.rejections?.length ? `: ${bestMatch.rejections.join(", ")}` : "."}`
                                );
                            }
                        } catch (err) {
                            console.error(`[DiskScan] Auto-Import failed for group ${consensusAlbum} in ${dir}:`, err);
                        }
                    }
                }
            }
        }

        if (shouldPromoteArtist) {
            db.prepare(`
                UPDATE artists
                SET monitor = 1,
                    monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
                WHERE id = ?
            `).run(artistId);
        }

        if (totalFiles > 0) {
            options?.onProgress?.({
                phase: "index",
                message: `Scanning ${totalFiles}/${totalFiles} files`,
                progress: 75,
                currentFileNum: totalFiles,
                totalFiles,
            });
        }

        return { indexed };
    }

    private static extractTidalAlbumIdFromPath(filePath?: string | null): string | null {
        if (!filePath) return null;
        const match = filePath.match(/\[TIDAL-(\d+)\]/i);
        return match?.[1] || null;
    }

    /**
     * Phase C: Check existing library_files for size/mtime changes and update records.
     */
    private static updateChangedFiles(artistId: string): { updated: number } {
        const rows = db.prepare(`
      SELECT id, file_path, relative_path, library_root, file_size, modified_at
      FROM library_files
      WHERE artist_id = ?
    `).all(artistId) as Array<{
            id: number;
            file_path: string;
            relative_path: string | null;
            library_root: string;
            file_size: number | null;
            modified_at: string | null;
        }>;

        let updated = 0;
        for (const row of rows) {
            const resolvedPath = resolveStoredLibraryPath({
                filePath: row.file_path,
                libraryRoot: row.library_root,
                relativePath: row.relative_path,
            });
            if (!fs.existsSync(resolvedPath)) continue; // Will be caught by Phase A

            const stats = fs.statSync(resolvedPath);
            const currentMtime = stats.mtime.toISOString();
            const sizeChanged = row.file_size !== null && row.file_size !== stats.size;
            const mtimeChanged = row.modified_at !== null && row.modified_at !== currentMtime;

            if (sizeChanged || mtimeChanged) {
                db.prepare(`
          UPDATE library_files
          SET file_size = ?, modified_at = ?, verified_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(stats.size, currentMtime, row.id);
                updated++;
            } else {
                // Just update verified_at timestamp
                db.prepare("UPDATE library_files SET verified_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
            }
        }

        return { updated };
    }

    // ==========================================================================
    // Step 4b: Metadata Backfill — Download missing metadata files
    // ==========================================================================

    /**
     * Download missing metadata files for monitored items.
     *
     * For each monitored album with downloaded tracks:
     *   - Album cover (if save_album_cover enabled and file missing)
     *   - Album video cover (if save_album_cover enabled, album has video_cover, and file missing)
     *   - Album review (if save_album_review enabled and file missing)
     *   - Track lyrics (if save_lyrics enabled and .lrc missing for downloaded tracks)
     *
     * For each monitored artist with library files:
     *   - Artist picture (if save_artist_picture enabled and file missing)
     *   - Artist bio (if save_artist_bio enabled and file missing)
     *
     * For each downloaded video:
     *   - Video thumbnail (if save_video_thumbnail enabled and file missing)
     */
    static async fillMissingMetadataFiles(artistId: string): Promise<MetadataFillResult> {
        return libraryMetadataBackfillService.fillMissingMetadataFiles(artistId);
    }

    static async fillMissingMetadataFilesForLibrary(): Promise<MetadataFillResult> {
        return libraryMetadataBackfillService.fillMissingMetadataFilesForLibrary();
    }

    // ==========================================================================
    // Step 5: Discover new artists in library roots
    // ==========================================================================

    /**
     * Walk the top-level directories of each library root and discover artist
     * folders that aren't yet in the Discogenius database. The shared import
     * decision pipeline then tries to identify and import those files directly,
     * adding artists/albums/tracks as managed items without forcing an
     * immediate full-artist refresh.
     *
     * Modelled after Lidarr's RescanFolders with addNewArtists=true.
     * Runs as part of scan({ addNewArtists: true }).
     *
     * @param onProgress Optional callback for progress reporting (SSE etc.)
     */
    private static async discoverNewArtists(
        onProgress?: (event: DiscoveryProgress) => void,
        options?: { monitorArtist?: boolean; fullProcessing?: boolean; trigger?: number },
    ): Promise<DiscoveryResult> {
        const shouldMonitor = options?.monitorArtist ?? true;
        const trigger = options?.trigger ?? 1;
        const result: DiscoveryResult = {
            knownFolders: 0,
            artistsAdded: [],
            unmatchedFolders: [],
            totalFolders: 0,
        };

        const naming = getNamingConfig();

        // Build a lookup of expected folder names for all known DB artists
        const allArtists = db.prepare("SELECT id, name FROM artists").all() as Array<{
            id: number;
            name: string;
        }>;
        const managedArtistIds = new Set(
            getManagedArtists({ includeLibraryFiles: true }).map((artist) => String(artist.id))
        );
        const knownFolderToArtistId = new Map<string, number>();
        for (const a of allArtists) {
            if (!managedArtistIds.has(String(a.id))) {
                continue;
            }
            const folder = renderRelativePath(naming.artist_folder, { artistName: a.name });
            knownFolderToArtistId.set(folder.toLowerCase(), a.id);
        }

        // Gather all unique library roots to scan
        const roots = new Set<string>();
        roots.add(Config.getMusicPath());
        roots.add(Config.getVideoPath());
        const atmosPath = Config.getAtmosPath();
        if (atmosPath) roots.add(atmosPath);

        // Collect all unique top-level folder names across all roots
        const seenFolders = new Map<string, string>(); // lowercase → original name
        for (const root of roots) {
            if (!fs.existsSync(root)) continue;
            try {
                const entries = fs.readdirSync(root, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    const lower = entry.name.toLowerCase();
                    if (!seenFolders.has(lower)) {
                        seenFolders.set(lower, entry.name);
                    }
                }
            } catch {
                // Permission errors, etc.
            }
        }

        result.totalFolders = seenFolders.size;
        onProgress?.({
            phase: "discovery",
            message: `Found ${seenFolders.size} top-level folders across ${roots.size} library roots`,
            progress: 70,
        });

        // Check each folder against known artists
        const unknownFolders: string[] = [];
        for (const [lower, originalName] of seenFolders) {
            if (knownFolderToArtistId.has(lower)) {
                result.knownFolders++;
            } else {
                unknownFolders.push(originalName);
            }
        }

        if (unknownFolders.length === 0) {
            onProgress?.({
                phase: "complete",
                message: "All folders match known artists. Nothing to do.",
                progress: 90,
            });
            return result;
        }

        const getTopLevelFolder = (rootPath: string, groupPath: string) => {
            const relativeGroupPath = path.relative(rootPath, groupPath);
            const segments = relativeGroupPath.split(path.sep).filter(Boolean);
            return segments[0] || path.basename(groupPath);
        };

        onProgress?.({
            phase: "evaluation",
            message: "Reading file 0/0",
            progress: 72,
            currentFileNum: 0,
            totalFiles: 0,
        });

        const importer = new ImportService();
        clearRootFolderReviewEntries(roots, unknownFolders);
        const reviewCandidates = await importer.scanRootFolders({
            monitorImported: shouldMonitor,
            targetFolders: new Set(unknownFolders.map((folderName) => folderName.toLowerCase())),
            onProgress: (event) => {
                onProgress?.({
                    phase: "evaluation",
                    message: event.message,
                    progress: event.totalFiles > 0
                        ? Math.min(84, 72 + Math.round((event.currentFileNum / event.totalFiles) * 12))
                        : 72,
                    currentFileNum: event.currentFileNum,
                    totalFiles: event.totalFiles,
                });
            },
        });
        persistRootReviewCandidates(reviewCandidates);
        const autoImported = importer.getAutoImported();
        onProgress?.({
            phase: "import",
            message: `Import decision pipeline finished: ${autoImported.length} auto-imported, ${reviewCandidates.length} queued for manual review.`,
            progress: 86,
        });
        const reviewFolders = new Set(
            reviewCandidates.map((candidate) =>
                getTopLevelFolder(candidate.group.rootPath, candidate.group.path).toLowerCase()
            )
        );
        const fullyImportedFolders = new Set<string>();
        const addedArtistIds = new Set<string>();
        const artistsNeedingMetadataBackfill = new Set<string>();
        const artistNamesById = new Map<string, string>();

        for (let index = 0; index < autoImported.length; index += 1) {
            const summary = autoImported[index];
            const folderKey = summary.folderName.toLowerCase();
            if (!reviewFolders.has(folderKey)) {
                fullyImportedFolders.add(folderKey);
            }

            artistsNeedingMetadataBackfill.add(summary.artistId);
            artistNamesById.set(summary.artistId, summary.artistName);

            const isNewArtist = !managedArtistIds.has(summary.artistId) && !addedArtistIds.has(summary.artistId);
            if (isNewArtist) {
                managedArtistIds.add(summary.artistId);
                addedArtistIds.add(summary.artistId);

                result.artistsAdded.push({
                    id: summary.artistId,
                    name: summary.artistName,
                    folderName: summary.folderName,
                });

                onProgress?.({
                    phase: "import",
                    message: `Importing release ${index + 1}/${autoImported.length}`,
                    progress: autoImported.length > 0
                        ? Math.min(92, 86 + Math.round(((index + 1) / autoImported.length) * 6))
                        : 88,
                });
            } else {
                onProgress?.({
                    phase: "import",
                    message: `Importing release ${index + 1}/${autoImported.length}`,
                    progress: autoImported.length > 0
                        ? Math.min(92, 86 + Math.round(((index + 1) / autoImported.length) * 6))
                        : 88,
                });
            }
        }

        const unresolvedFolders = unknownFolders.filter((folderName) => {
            const folderKey = folderName.toLowerCase();
            return reviewFolders.has(folderKey) || !fullyImportedFolders.has(folderKey);
        });

        for (let index = 0; index < unresolvedFolders.length; index += 1) {
            const folderName = unresolvedFolders[index];
            if (!result.unmatchedFolders.includes(folderName)) {
                result.unmatchedFolders.push(folderName);
            }

            onProgress?.({
                phase: "review",
                message: `Manual review ${index + 1}/${unresolvedFolders.length}`,
                progress: unresolvedFolders.length > 0
                    ? Math.min(94, 92 + Math.round(((index + 1) / unresolvedFolders.length) * 2))
                    : 93,
            });
        }

        for (const artistId of artistsNeedingMetadataBackfill) {
            const artistName = artistNamesById.get(artistId);
            if (!artistName) {
                throw new Error(`Missing artist name for queued workflow artist ${artistId}`);
            }
            if (options?.fullProcessing && shouldMonitor) {
                queueArtistWorkflow({
                    artistId,
                    artistName,
                    workflow: "full-monitoring",
                    trigger,
                });
            } else {
                // Ensure first-pass module assignment by refreshing metadata and reconciling files in this intake flow.
                queueArtistWorkflow({
                    artistId,
                    artistName,
                    workflow: "refresh-scan",
                    trigger,
                });
            }
        }

        console.log(
            `[DiskScan] Root folder scan complete: ` +
            `${result.totalFolders} folders, ` +
            `${result.knownFolders} known, ` +
            `${result.artistsAdded.length} added, ` +
            `${result.unmatchedFolders.length} unmatched`,
        );

        return result;
    }

    // ==========================================================================
    // Private: File matching and indexing helpers
    // ==========================================================================

    /**
     * Try to match a file on disk to a known media entry in the database.
     * Returns match info if we can identify what this file is, or null if unknown.
     */
    private static matchFileToMedia(
        filePath: string,
        artistId: string,
        _libraryRoot: LibraryRootKey,
    ): { albumId: string | null; mediaId: string | null; fileType: string; quality: string | null } | null {
        const ext = path.extname(filePath).toLowerCase();
        const basename = path.basename(filePath);
        const stem = path.parse(filePath).name;

        // Metadata files — match by filename convention
        if (basename === "bio.txt") {
            return { albumId: null, mediaId: null, fileType: "bio", quality: null };
        }

        const metadataConfig = getConfigSection("metadata");
        const artistPicName = metadataConfig.artist_picture_name || "folder.jpg";
        const albumCoverName = metadataConfig.album_cover_name || "cover.jpg";

        // Artist picture (in artist dir root)
        if (basename === artistPicName) {
            // Could be artist picture or album cover — check depth
            // Artist picture is directly under artist folder, album cover is under album subfolder
            const parentDir = path.basename(path.dirname(filePath));
            const naming = getNamingConfig();
            const artist = db.prepare("SELECT name FROM artists WHERE id = ?").get(artistId) as any;
            if (artist) {
                const artistDirName = renderRelativePath(naming.artist_folder, { artistName: artist.name });
                if (parentDir === artistDirName || parentDir === artist.name) {
                    return { albumId: null, mediaId: null, fileType: "cover", quality: null };
                }
            }
            // Otherwise it's likely an album cover
            const albumId = this.findAlbumIdFromPath(filePath, artistId);
            return { albumId, mediaId: null, fileType: "cover", quality: null };
        }

        if (basename === albumCoverName && basename !== artistPicName) {
            const albumId = this.findAlbumIdFromPath(filePath, artistId);
            return { albumId, mediaId: null, fileType: "cover", quality: null };
        }

        // Video cover (.mp4 with cover-like name)
        const albumCoverStem = path.parse(albumCoverName).name;
        if (ext === ".mp4" && stem === albumCoverStem) {
            const albumId = this.findAlbumIdFromPath(filePath, artistId);
            return { albumId, mediaId: null, fileType: "video_cover", quality: null };
        }

        if (basename === "review.txt") {
            const albumId = this.findAlbumIdFromPath(filePath, artistId);
            return { albumId, mediaId: null, fileType: "review", quality: null };
        }

        if (ext === ".lrc") {
            // Try to match to a track by looking for an audio file with same stem
            const mediaId = this.findMediaIdByStem(stem, artistId);
            const albumId = mediaId
                ? (db.prepare("SELECT album_id FROM media WHERE id = ?").get(mediaId) as any)?.album_id?.toString() || null
                : null;
            return { albumId, mediaId, fileType: "lyrics", quality: null };
        }

        // Audio files
        const audioExtensions = new Set([".flac", ".m4a", ".mp3", ".aac", ".wav", ".ogg", ".opus", ".aif", ".aiff"]);
        if (audioExtensions.has(ext)) {
            // Try to match by TIDAL ID in filename
            const mediaId = this.findMediaIdByStem(stem, artistId);
            if (mediaId) {
                const media = db.prepare("SELECT album_id, quality FROM media WHERE id = ?").get(mediaId) as any;
                return {
                    albumId: media?.album_id?.toString() || null,
                    mediaId,
                    fileType: "track",
                    quality: media?.quality || null,
                };
            }

            // Try to match by expected path
            const mediaByPath = this.findMediaByExpectedPath(filePath, artistId);
            if (mediaByPath) {
                return {
                    albumId: mediaByPath.albumId,
                    mediaId: mediaByPath.mediaId,
                    fileType: "track",
                    quality: mediaByPath.quality,
                };
            }

            return null; // Unmatched audio file — skip for now
        }

        // Video files
        const videoExtensions = new Set([".mp4", ".ts", ".mkv", ".webm"]);
        if (videoExtensions.has(ext)) {
            const mediaId = this.findMediaIdByStem(stem, artistId);
            if (mediaId) {
                const media = db.prepare("SELECT album_id, quality FROM media WHERE id = ? AND type = 'Music Video'").get(mediaId) as any;
                if (media) {
                    return {
                        albumId: media.album_id?.toString() || null,
                        mediaId,
                        fileType: "video",
                        quality: media.quality || null,
                    };
                }
            }

            return null;
        }

        // Image files that match a known video stem (video thumbnails)
        if (ext === ".jpg" || ext === ".png") {
            const videoMediaId = this.findVideoIdByStem(stem, artistId);
            if (videoMediaId) {
                const media = db.prepare("SELECT album_id FROM media WHERE id = ?").get(videoMediaId) as any;
                return {
                    albumId: media?.album_id?.toString() || null,
                    mediaId: videoMediaId,
                    fileType: "video_thumbnail",
                    quality: null,
                };
            }
        }

        return null;
    }

    // ==========================================================================
    // Private: Lookup helpers
    // ==========================================================================

    /**
     * Try to find a media ID by checking if the file stem contains a known TIDAL track/media ID.
     */
    private static findMediaIdByStem(stem: string, artistId: string): string | null {
        // Check if stem is directly a TIDAL ID (numeric)
        if (/^\d+$/.test(stem)) {
            const media = db.prepare("SELECT id FROM media WHERE id = ? AND artist_id = ?").get(stem, artistId) as any;
            if (media) return String(media.id);
        }

        // Check if stem contains a TIDAL ID (e.g. "01 - 12345678 - Song Title")
        const idMatch = stem.match(/\b(\d{6,})\b/);
        if (idMatch) {
            const media = db.prepare("SELECT id FROM media WHERE id = ? AND artist_id = ?").get(idMatch[1], artistId) as any;
            if (media) return String(media.id);
        }

        return null;
    }

    /**
     * Try to find a video ID where the title matches the stem.
     */
    private static findVideoIdByStem(stem: string, artistId: string): string | null {
        // Check videos whose title might match the stem
        const videos = db.prepare(`
      SELECT id, title FROM media WHERE artist_id = ? AND type = 'Music Video'
    `).all(artistId) as Array<{ id: number; title: string }>;

        for (const video of videos) {
            if (stem.includes(video.title) || video.title.includes(stem)) {
                return String(video.id);
            }
        }

        return null;
    }

    /**
     * Try to find the album_id from a file path by checking parent directory patterns.
     */
    private static findAlbumIdFromPath(filePath: string, artistId: string): string | null {
        const dirName = path.basename(path.dirname(filePath));

        // Try to match directory name against album titles
        const albums = db.prepare(`
      SELECT a.id, a.title FROM albums a
      JOIN album_artists aa ON a.id = aa.album_id
      WHERE aa.artist_id = ?
    `).all(artistId) as Array<{ id: number; title: string }>;

        for (const album of albums) {
            if (dirName.includes(album.title) || album.title.includes(dirName)) {
                return String(album.id);
            }
        }

        return null;
    }

    /**
     * Try finding media by comparing the file path to expected_path computed for known tracks.
     */
    private static findMediaByExpectedPath(filePath: string, artistId: string): { albumId: string | null; mediaId: string; quality: string | null } | null {
        const resolved = path.resolve(filePath);

        // Check if any track's expected path matches this file
        const match = db.prepare(`
      SELECT lf.media_id, lf.album_id, m.quality
      FROM library_files lf
      JOIN media m ON m.id = lf.media_id
      WHERE lf.artist_id = ? AND lf.expected_path = ?
      LIMIT 1
    `).get(artistId, resolved) as any;

        if (match) {
            return {
                albumId: match.album_id?.toString() || null,
                mediaId: String(match.media_id),
                quality: match.quality || null,
            };
        }

        return null;
    }

    // ==========================================================================
    // Private: Utility methods
    // ==========================================================================

    /**
     * Walk a library root directory once and index all files by their
     * top-level subdirectory. Avoids redundant per-artist walks when
     * scanning the full library (Lidarr-style single-pass collection).
     */
    private static async buildRootFileIndex(rootPath: string): Promise<Map<string, string[]>> {
        const index = new Map<string, string[]>();
        if (!fs.existsSync(rootPath)) return index;

        try {
            const cooperateFolderWalk = createCooperativeBatcher(10);
            const topEntries = fs.readdirSync(rootPath, { withFileTypes: true });
            for (const entry of topEntries) {
                if (!entry.isDirectory()) continue;
                const folderKey = entry.name.toLowerCase();
                const folderPath = path.join(rootPath, entry.name);
                const files = await this.getMediaFiles(folderPath);
                if (files.length > 0) {
                    index.set(folderKey, files);
                }
                await cooperateFolderWalk();
            }
        } catch {
            // Permission errors, etc.
        }
        return index;
    }

    /**
     * Recursively walk a directory and return all file paths.
     * Named to match Lidarr's GetAudioFiles convention.
     */
    private static async getMediaFiles(dir: string): Promise<string[]> {
        const results: string[] = [];
        const queue: string[] = [dir];
        const cooperateEntryWalk = createCooperativeBatcher(200);

        try {
            while (queue.length > 0) {
                const currentDir = queue.pop();
                if (!currentDir) {
                    continue;
                }

                const entries = fs.readdirSync(currentDir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(currentDir, entry.name);
                    if (entry.isDirectory()) {
                        queue.push(fullPath);
                    } else if (entry.isFile()) {
                        results.push(fullPath);
                    }
                    await cooperateEntryWalk();
                }
            }
        } catch {
            // Permission errors, etc.
        }
        return results;
    }

    /**
     * Simple upsert into library_files (subset of OrganizerService.upsertLibraryFile).
     */
    private static upsertLibraryFile(params: {
        artistId: string;
        albumId?: string | null;
        mediaId?: string | null;
        filePath: string;
        libraryRoot: string;
        fileType: string;
        quality?: string | null;
        expectedPath?: string | null;
    }) {
        LibraryFilesService.upsertLibraryFile({
            ...params,
            removeFromUnmapped: false,
        });
    }
}
