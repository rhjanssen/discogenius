import { CommandTrigger } from "../commands/command-trigger.js";
import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import { Config, getConfigSection } from "../config/config.js";
import { resolveArtistFolderFromRecord } from "../config/naming.js";
import { ensureEmptyArtistFoldersIfEnabled } from "../music/artist-paths.js";
import { ImportService } from "./import-service.js";
import { getUnmappedMediaMetrics } from "../music/library-media-metrics.js";
import { clearRootFolderReviewEntries, persistRootReviewCandidates } from "./library-scan-root-review.js";
import { relinkUnresolvedLibraryFiles } from "./library-scan-relink.js";
import { matchAudioFileByMetadata, resolveCatalogTrackFromEmbeddedMbids } from "./library-scan-metadata-match.js";
import {
    PROVIDER_RESOLVED_ALBUM_ID_SQL,
    LEGACY_FOLDER_SCAN_MEMBER_ARTIST_SCOPE_SQL,
    LEGACY_FOLDER_SCAN_RELEASE_ARTIST_SCOPE_SQL,
} from "../providers/provider-item-artist-scope.js";

/**
 * Internal identity of a provider resource. `provider_id` is only unique WITHIN
 * a (provider, entity_type) pair, so it is never an identity on its own.
 */
type ProviderItemIdentity = {
    itemId: number;
    provider: string;
    entityType: string;
    providerId: string;
};
import { resolveLibraryRootKey, resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import {
    updateAlbumDownloadStatus,
    updateArtistDownloadStatusFromMedia,
} from "../download/download-state.js";
import { getManagedArtists } from "../music/managed-artists.js";
import {
    queueArtistWorkflow,
} from "../music/artist-workflow.js";
import { LibraryFilesService } from "./library-files.js";
import { libraryMetadataBackfillService, type MetadataFillResult } from "./library-metadata-backfill.js";
import { createCooperativeBatcher, yieldToEventLoop } from "../../utils/concurrent.js";
import { isLyricSidecarExtension } from "../extras/lyrics/lyric-sidecar.js";
import { shouldRematchUnmatchedFiles, type ScanFileFilter } from "./scan-file-filter.js";

// ============================================================================
// Types
// ============================================================================

const MEDIA_EXTENSIONS = new Set([
    '.flac', '.alac', '.wav', '.aiff', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma',
    '.ape', '.mp2',
    '.mp4', '.m4v', '.mkv', '.mov', '.avi', '.ts', '.webm'
]);

const IGNORED_SCAN_DIRECTORIES = new Set([
    '.appledouble',
    '.git',
    '.vs',
    '.@__thumb',
    '@eadir',
    '$recycle.bin',
    'system volume information',
    'extras',
    'extrafanart',
    'plex versions',
]);

const IGNORED_SCAN_FILES = new Set([
    '.ds_store',
    'thumbs.db',
    '.partial~',
]);

function shouldSkipScanDirectory(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized.startsWith('.') || IGNORED_SCAN_DIRECTORIES.has(normalized);
}

function shouldSkipScanFile(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized.startsWith('._') || IGNORED_SCAN_FILES.has(normalized);
}

export interface DiskScanResult {
    /** DB records removed because file no longer exists on disk */
    orphansRemoved: number;
    /** New files found on disk and indexed into track_files */
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
    /**
     * Lidarr FilterFilesType. `known` skips rematching unmatched existing files.
     * Default `matched` keeps the historical scanArtist behaviour.
     */
    filter?: ScanFileFilter;
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
    /** Persist unmatched media candidates discovered during the scan. */
    trackUnmappedFiles?: boolean;
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

type LibraryRootKey = "music" | "spatial" | "videos";

/** Pre-built file index from a single-pass root walk, keyed by lowercased folder name. */
type RootFileIndex = Map<string, Map<string, string[]>>; // rootPath → (folderKey → files)

function usesNestedArtistFolders(): boolean {
    const row = db.prepare(`
        SELECT 1
        FROM Artists
        WHERE path IS NOT NULL
          AND TRIM(path) != ''
          AND (path LIKE '%/%' OR path LIKE '%\\%')
        LIMIT 1
    `).get();

    return Boolean(row);
}

// ============================================================================
// Disk Scan Service
// ============================================================================

/**
 * DiskScanService — Reconciles the track_files DB with actual disk state
 * and handles metadata file backfill.
 *
 * Disk scan service for library file reconciliation:
 * 1. Clean orphaned records (DB entries for files that no longer exist)
 * 2. Index new files found on disk (manually placed files)
 * 3. Update changed files (size/mtime mismatch)
 * 4. Backfill missing metadata files (covers, NFO, lyrics, etc.)
 */
export class DiskScanService {
    // ==========================================================================
    // Public API — Scan(folders, filter, addNewArtists, artistIds)
    // ==========================================================================

    /**
     * Unified disk scan entry point.
     *
     * - No options or empty options → scan all managed artists (reconcile track_files with disk)
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
                    trackUnmappedFiles: options.trackUnmappedFiles,
                    filter: options.filter,
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
            }, {
                trackUnmappedFiles: options.trackUnmappedFiles,
                filter: options.filter,
            });
            result.artists = reconcileResult.artists;
            result.orphansRemoved = reconcileResult.totalOrphans;
            result.filesIndexed = reconcileResult.filesIndexed;
            result.filesUpdated = reconcileResult.filesUpdated;
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
                    monitorArtist: options.monitorNewArtists ?? getConfigSection("monitoring").monitor_new_artists,
                    fullProcessing: options.fullProcessing ?? false,
                    trigger: options.trigger ?? CommandTrigger.Manual,
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
    // Disk Scan — Reconcile track_files with disk reality
    // ==========================================================================

    /**
     * Delete any unmapped_files records where the file no longer exists on disk.
     */
    static pruneUnmappedFiles(): number {
        let unmappedOrphans = 0;
        const unmappedRows = db.prepare("SELECT id, file_path FROM UnmappedFiles").all() as Array<{ id: number; file_path: string }>;
        for (const row of unmappedRows) {
            if (!fs.existsSync(row.file_path)) {
                db.prepare("DELETE FROM UnmappedFiles WHERE id = ?").run(row.id);
                unmappedOrphans++;
            }
        }
        return unmappedOrphans;
    }

    /**
     * Scan an artist's library directories and reconcile track_files with disk.
     *
     * Phase A: Remove DB records for files that no longer exist on disk.
     * Phase B: Walk artist directories, index any files not yet in track_files.
     * Phase C: Update records where file size/mtime has changed.
     *
     * When called from `reconcileAllArtists`, a pre-built `fileIndex` is passed
     * so that each library root is walked only once (single-pass).
     */
    private static async scanArtist(
        artistId: string,
        options?: {
            onProgress?: (event: ArtistScanProgress) => void;
            fileIndex?: RootFileIndex;
            trackUnmappedFiles?: boolean;
            filter?: ScanFileFilter;
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
            trackUnmappedFiles: options?.trackUnmappedFiles,
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

        // Phase D/E rematch unmatched existing files. Lidarr FilterFilesType.Known
        // skips this: only new files and size/mtime changes. Matched/None rematch.
        if (shouldRematchUnmatchedFiles(options?.filter ?? "matched")) {
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

            const phaseE = await this.backfillCanonicalLinksFromTags(artistId);
            result.filesUpdated += phaseE.healed;
        }

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
     * Self-heal canonical catalog links from a file's embedded MusicBrainz tags.
     * Targets only rows that are already tracked but carry no canonical linkage
     * (canonical_track_mbid AND canonical_recording_mbid are NULL) — such rows sit
     * on disk yet never count as downloaded because the download-status join keys
     * on canonical_track_mbid / canonical_recording_mbid. Because it is scoped to
     * the broken rows only, this is a no-op (single indexed query, zero file
     * reads) for a healthy library.
     */
    private static async backfillCanonicalLinksFromTags(artistId: string): Promise<{ healed: number }> {
        const brokenRows = db.prepare(`
            SELECT id, file_path, relative_path, library_root, library_slot
            FROM TrackFiles
            WHERE artist_id = ?
              AND file_type = 'track'
              AND canonical_track_mbid IS NULL
              AND canonical_recording_mbid IS NULL
        `).all(artistId) as Array<{
            id: number;
            file_path: string;
            relative_path: string | null;
            library_root: string;
            library_slot: string | null;
        }>;

        if (brokenRows.length === 0) return { healed: 0 };

        let healed = 0;
        const touchedReleaseGroups = new Set<string>();

        for (const row of brokenRows) {
            const filePath = resolveStoredLibraryPath({
                filePath: row.file_path,
                libraryRoot: row.library_root,
                relativePath: row.relative_path,
            });
            if (!fs.existsSync(filePath)) continue;

            let musicbrainzRecordingId: string | null = null;
            let musicbrainzTrackId: string | null = null;
            let musicbrainzAlbumId: string | null = null;
            try {
                const mm = await import("music-metadata");
                const metadata = await mm.parseFile(filePath, { duration: false, skipCovers: true });
                musicbrainzRecordingId = metadata.common.musicbrainz_recordingid || null;
                musicbrainzTrackId = metadata.common.musicbrainz_trackid || null;
                musicbrainzAlbumId = metadata.common.musicbrainz_albumid || null;
            } catch {
                // Unreadable tags — leave the row untouched for the next pass.
                continue;
            }
            if (!musicbrainzRecordingId && !musicbrainzTrackId) continue;

            const link = resolveCatalogTrackFromEmbeddedMbids(
                { musicbrainzRecordingId, musicbrainzTrackId, musicbrainzAlbumId },
                row.library_slot || "stereo",
            );
            if (!link) continue;

            db.prepare(`
                UPDATE TrackFiles
                SET canonical_track_mbid = COALESCE(canonical_track_mbid, ?),
                    canonical_recording_mbid = COALESCE(canonical_recording_mbid, ?),
                    canonical_release_mbid = COALESCE(canonical_release_mbid, ?),
                    canonical_release_group_mbid = COALESCE(canonical_release_group_mbid, ?),
                    verified_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(link.trackMbid, link.recordingMbid, link.releaseMbid, link.releaseGroupMbid, row.id);
            healed++;
            if (link.releaseGroupMbid) touchedReleaseGroups.add(link.releaseGroupMbid);
        }

        for (const releaseGroupMbid of touchedReleaseGroups) {
            updateAlbumDownloadStatus(releaseGroupMbid);
        }

        if (healed > 0) {
            console.log(
                `[DiskScan] Artist ${artistId}: self-healed canonical catalog links for ${healed} track file(s) from embedded MB tags`,
            );
        }
        return { healed };
    }

    /**
     * Scan ALL managed artists' library directories and reconcile track_files
     * with disk. Walks each library root once and builds a file index so that
     * individual artist scans avoid redundant filesystem walks (single-pass
     * collection scan).
     *
     * Used by RescanFolders to detect missing files across the entire library.
     */
    private static async reconcileAllArtists(
        onProgress?: (event: FullLibraryScanProgress) => void,
        options?: { trackUnmappedFiles?: boolean; filter?: ScanFileFilter },
    ): Promise<{ artists: number; totalOrphans: number; totalFlagsReset: number; filesIndexed: number; filesUpdated: number; unmappedOrphans: number }> {
        const artists = getManagedArtists({ includeLibraryFiles: true })
            .map((artist) => ({ id: String(artist.id), name: artist.name || String(artist.id) }));
        let totalOrphans = 0;
        let totalFlagsReset = 0;
        let filesIndexed = 0;
        let filesUpdated = 0;
        let unmappedOrphans = 0;

        // The prebuilt root index only works when artist folders are single-segment.
        // Nested artist-folder templates should scan exact artist paths instead.
        const usePrebuiltRootIndex = !usesNestedArtistFolders();
        const fileIndex: RootFileIndex = new Map();
        const musicPath = Config.getMusicPath();
        const filtering = Config.getFilteringConfig();
        const videoPath = filtering.include_videos === true ? Config.getVideoPath() : null;
        const spatialPath = filtering.include_spatial === true ? Config.getSpatialPath() : null;

        if (usePrebuiltRootIndex) {
            fileIndex.set(musicPath, await this.buildRootFileIndex(musicPath));
            if (videoPath) {
                fileIndex.set(videoPath, await this.buildRootFileIndex(videoPath));
            }
            if (spatialPath) {
                fileIndex.set(spatialPath, await this.buildRootFileIndex(spatialPath));
            }
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
                fileIndex: usePrebuiltRootIndex ? fileIndex : undefined,
                trackUnmappedFiles: options?.trackUnmappedFiles,
                filter: options?.filter,
            });
            totalOrphans += result.orphansRemoved;
            totalFlagsReset += result.downloadFlagsReset;
            filesIndexed += result.filesIndexed;
            filesUpdated += result.filesUpdated;
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

        if (totalOrphans > 0 || totalFlagsReset > 0 || filesIndexed > 0 || filesUpdated > 0 || unmappedOrphans > 0) {
            console.log(
                `[DiskScan] Full library disk reconciliation: ` +
                `${artists.length} artists scanned, ` +
                `${totalOrphans} library orphans removed, ` +
                `${filesIndexed} new files indexed, ` +
                `${filesUpdated} files updated, ` +
                `${unmappedOrphans} unmapped orphans removed, ` +
                `${totalFlagsReset} download flags reset`
            );
        }

        return { artists: artists.length, totalOrphans, totalFlagsReset, filesIndexed, filesUpdated, unmappedOrphans };
    }

    /**
    * Phase A: Remove track_files records whose file no longer exists on disk.
     */
    private static cleanOrphanedRecords(artistId: string): { removed: number; flagsReset: number } {
        const rows = db.prepare(`
      SELECT id, file_path, relative_path, library_root,
             provider_id AS media_id,
             provider AS media_provider,
             canonical_release_group_mbid,
             file_type
      FROM TrackFiles
      WHERE artist_id = ?
    `).all(artistId) as Array<{
            id: number;
            file_path: string;
            relative_path: string | null;
            library_root: string;
            media_provider: string | null;
            media_id: number | null;
            canonical_release_group_mbid: string | null;
            file_type: string;
        }>;

        let removed = 0;
        let flagsReset = 0;
        // Release groups touched by removals — invalidates album + RG + artist
        // download-status caches. Canonical linking always writes
        // canonical_release_group_mbid alongside the track/recording mbid (they
        // are resolved and stored as a set), so the RG mbid is present on every
        // canonically-linked row, including provider-free ones with a null
        // provider_id. Provider-only rows are covered by provider_id below.
        const affectedReleaseGroupMbids = new Set<string>();
        // Keyed by provider + provider_id, never provider_id alone: two providers
        // may legitimately use the same id for unrelated resources.
        const affectedMedia = new Map<string, { mediaId: string; provider: string | null }>();

        for (const row of rows) {
            const resolvedPath = resolveStoredLibraryPath({
                filePath: row.file_path,
                libraryRoot: row.library_root,
                relativePath: row.relative_path,
            });
            if (fs.existsSync(resolvedPath)) continue;

            // File is gone — remove DB record
            db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(row.id);
            LibraryFilesService.emitFileDeleted({
                libraryFileId: row.id,
                artistId,
                albumId: null,
                mediaId: row.media_id,
                fileType: row.file_type,
                filePath: resolvedPath,
                libraryRoot: row.library_root,
                reason: "scan-orphaned-record",
                missing: true,
            });
            removed++;

            if (row.canonical_release_group_mbid) {
                affectedReleaseGroupMbids.add(String(row.canonical_release_group_mbid));
            }
            if (row.media_id) {
                const mediaId = String(row.media_id);
                const provider = row.media_provider ?? null;
                affectedMedia.set(`${provider ?? ""}|${mediaId}`, { mediaId, provider });
            }
        }

        // updateAlbumDownloadStatus(rgMbid) invalidates the album, RG-scoped, and
        // owning-artist caches — the fix for deleted albums lingering as
        // "downloaded" until an incidental cache expiry.
        for (const releaseGroupMbid of affectedReleaseGroupMbids) {
            updateAlbumDownloadStatus(releaseGroupMbid);
            flagsReset += 1;
        }

        for (const { mediaId, provider } of affectedMedia.values()) {
            updateArtistDownloadStatusFromMedia(mediaId, provider);
            flagsReset += 1;
        }

        return { removed, flagsReset };
    }

    /**
     * When "Create empty artist folders" just created folders for a monitored
     * artist that has nothing downloaded yet, drop the artist picture and NFO in
     * too so the folder is immediately usable by a media server. Respects the
     * user's Save Artist Pictures / Save NFO Files choices, and never overwrites
     * files that already exist. Best-effort: a failure here never fails the scan.
     */
    private static async populateEmptyArtistFolderMetadata(artistId: string, folders: string[]): Promise<void> {
        try {
            const metadataConfig = getConfigSection("metadata");
            const wantPicture = metadataConfig.save_artist_picture === true;
            const wantNfo = metadataConfig.save_nfo === true;
            if (!wantPicture && !wantNfo) {
                return;
            }

            const { saveArtistNfoFile } = await import("./metadata-files.js");
            const { syncCachedMediaCoverToFile } = await import("../metadata/media-cover-service.js");
            const artist = db.prepare("SELECT mbid FROM Artists WHERE id = ? LIMIT 1")
                .get(artistId) as { mbid?: string | null } | undefined;
            const artistPicName = metadataConfig.artist_picture_name || "folder.jpg";

            for (const folder of folders) {
                if (wantPicture) {
                    const picPath = path.join(folder, artistPicName);
                    try {
                        syncCachedMediaCoverToFile({
                            entityId: artist?.mbid || artistId,
                            coverEntity: "Artist",
                            coverTypes: ["poster", "headshot"],
                            outputPath: picPath,
                        });
                    } catch (error) {
                        console.warn(`[DiskScan] Failed to write artist picture for empty folder ${folder}:`, error);
                    }
                }
                if (wantNfo) {
                    const nfoPath = path.join(folder, "artist.nfo");
                    try {
                        await saveArtistNfoFile(artistId, nfoPath);
                    } catch (error) {
                        console.warn(`[DiskScan] Failed to write artist NFO for empty folder ${folder}:`, error);
                    }
                }
            }
        } catch (error) {
            console.warn(`[DiskScan] populateEmptyArtistFolderMetadata failed for artist ${artistId}:`, error);
        }
    }

    /**
     * Phase B: Walk the artist's directories on disk and index any files not yet
     * in track_files. Attempts to match files to known media by path patterns.
     *
     * When a pre-built `fileIndex` is provided (from `reconcileAllArtists`), the
     * walk is skipped and the cached file list is used instead.
     */
    private static async indexNewFiles(
        artistId: string,
        options?: {
            onProgress?: (event: ArtistScanProgress) => void;
            fileIndex?: RootFileIndex;
            trackUnmappedFiles?: boolean;
        },
    ): Promise<{ indexed: number }> {
        const artist = db.prepare("SELECT name, mbid, path FROM Artists WHERE id = ?").get(artistId) as any;
        if (!artist) return { indexed: 0 };

        const artistFolder = resolveArtistFolderFromRecord(artist);
        const ensuredEmptyFolders = ensureEmptyArtistFoldersIfEnabled(artistFolder);
        if (ensuredEmptyFolders.length > 0) {
            await DiskScanService.populateEmptyArtistFolderMetadata(artistId, ensuredEmptyFolders);
        }

        // Collect all existing file paths for this artist (for quick lookup)
        const existingPaths = new Set(
            (db.prepare("SELECT file_path, relative_path, library_root FROM TrackFiles WHERE artist_id = ?").all(artistId) as Array<{
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
        const filtering = Config.getFilteringConfig();
        const roots: Array<{ key: LibraryRootKey; dir: string }> = [
            { key: "music", dir: path.join(Config.getMusicPath(), artistFolder) },
        ];
        if (filtering.include_videos === true) {
            roots.push({ key: "videos", dir: path.join(Config.getVideoPath(), artistFolder) });
        }

        const spatialPath = Config.getSpatialPath();
        if (filtering.include_spatial === true && spatialPath) {
            roots.push({ key: "spatial", dir: path.join(spatialPath, artistFolder) });
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
                : key === "spatial"
                    ? Config.getSpatialPath()
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
                let match = this.matchFileToMedia(filePath, artistId, key);
                let matchProvider: string | null = null;
                let canonicalLink: {
                    canonicalTrackMbid: string | null;
                    canonicalRecordingMbid: string | null;
                    canonicalReleaseMbid: string | null;
                    canonicalReleaseGroupMbid: string | null;
                    librarySlot: string | null;
                } | null = null;

                // Stem/expected-path miss: rematch audio via tags + sibling album offers
                // so Discogenius-organized files are not stuck in UnmappedFiles.
                let unmappedReason: string | null = null;
                let parsedForUnmapped: {
                    detectedArtist: string;
                    detectedAlbum: string | null;
                    detectedTrack: string | null;
                    metrics: ReturnType<typeof getUnmappedMediaMetrics>;
                    relative: string;
                    stats: fs.Stats;
                    ext: string;
                } | null = null;

                if (!match && options?.trackUnmappedFiles !== false) {
                    const ext = path.extname(resolved).toLowerCase();
                    if (MEDIA_EXTENSIONS.has(ext)) {
                        try {
                            const stats = fs.statSync(resolved);
                            const relative = path.relative(rootPath, resolved);
                            const segments = relative.split(path.sep);
                            let detectedArtist = segments.length >= 1 ? segments[0] : artist.name;
                            let detectedAlbum = segments.length >= 2 ? segments[1] : null;
                            let detectedTrack: string | null = null;
                            let metrics = getUnmappedMediaMetrics(undefined, ext);
                            let musicbrainzRecordingId: string | null = null;
                            let musicbrainzTrackId: string | null = null;
                            let musicbrainzAlbumId: string | null = null;
                            let isrc: string | string[] | null = null;

                            try {
                                const mm = await import("music-metadata");
                                const metadata = await mm.parseFile(resolved, { duration: true, skipCovers: true });
                                if (metadata.common.artist) detectedArtist = metadata.common.artist;
                                if (metadata.common.album) detectedAlbum = metadata.common.album;
                                if (metadata.common.title) detectedTrack = metadata.common.title;
                                musicbrainzRecordingId = metadata.common.musicbrainz_recordingid || null;
                                // music-metadata maps the MUSICBRAINZ_RELEASETRACKID tag
                                // (Discogenius' "MusicBrainz Release Track Id" = the track
                                // MBID = Tracks.mbid = canonical_track_mbid) to
                                // common.musicbrainz_trackid. This is the most precise
                                // catalog key, so read it for catalog-direct linking.
                                musicbrainzTrackId = metadata.common.musicbrainz_trackid || null;
                                musicbrainzAlbumId = metadata.common.musicbrainz_albumid || null;
                                isrc = metadata.common.isrc || null;
                                metrics = getUnmappedMediaMetrics(metadata.format, ext);
                                if (!metrics.duration) {
                                    const { probeMediaDuration } = await import("./audioUtils.js");
                                    const durationFfprobe = await probeMediaDuration(resolved);
                                    if (durationFfprobe) metrics.duration = Math.round(durationFfprobe);
                                }
                            } catch {
                                // Fall back to folder guesses when tags are unreadable.
                            }

                            parsedForUnmapped = {
                                detectedArtist,
                                detectedAlbum,
                                detectedTrack,
                                metrics,
                                relative,
                                stats,
                                ext,
                            };

                            const audioExtensions = new Set([".flac", ".m4a", ".mp3", ".aac", ".wav", ".ogg", ".opus", ".aif", ".aiff", ".wma", ".ape", ".mp2"]);
                            if (audioExtensions.has(ext)) {
                                const metadataMatch = matchAudioFileByMetadata(resolved, artistId, key, {
                                    title: detectedTrack,
                                    album: detectedAlbum,
                                    artist: detectedArtist,
                                    isrc,
                                    musicbrainzRecordingId,
                                    musicbrainzTrackId,
                                    musicbrainzAlbumId,
                                    durationSeconds: metrics.duration || null,
                                });
                                if (metadataMatch?.duplicateOfExisting) {
                                    const isSelfTrackFile = Boolean(
                                        metadataMatch.existingFilePath === resolved ||
                                        db.prepare("SELECT 1 FROM TrackFiles WHERE file_path = ? LIMIT 1").get(resolved)
                                    );
                                    if (isSelfTrackFile) {
                                        db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(resolved);
                                        unmappedReason = null;
                                    } else {
                                        unmappedReason = "Duplicate of an existing imported library file";
                                    }
                                } else if (metadataMatch) {
                                    match = {
                                        albumId: metadataMatch.albumId,
                                        mediaId: metadataMatch.mediaId,
                                        fileType: metadataMatch.fileType,
                                        quality: metadataMatch.quality,
                                    };
                                    matchProvider = metadataMatch.provider;
                                    canonicalLink = {
                                        canonicalTrackMbid: metadataMatch.canonicalTrackMbid ?? null,
                                        canonicalRecordingMbid: metadataMatch.canonicalRecordingMbid ?? null,
                                        canonicalReleaseMbid: metadataMatch.canonicalReleaseMbid ?? null,
                                        canonicalReleaseGroupMbid: metadataMatch.canonicalReleaseGroupMbid ?? null,
                                        librarySlot: metadataMatch.librarySlot ?? null,
                                    };
                                } else {
                                    unmappedReason = "No matching release found in catalog";
                                }
                            } else {
                                unmappedReason = "No matching provider item found";
                            }
                        } catch (e) {
                            console.error(`[DiskScan] Failed to inspect unmatched file ${resolved}:`, e);
                        }
                    }
                }

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
                        provider: matchProvider,
                        canonicalTrackMbid: canonicalLink?.canonicalTrackMbid ?? null,
                        canonicalRecordingMbid: canonicalLink?.canonicalRecordingMbid ?? null,
                        canonicalReleaseMbid: canonicalLink?.canonicalReleaseMbid ?? null,
                        canonicalReleaseGroupMbid: canonicalLink?.canonicalReleaseGroupMbid ?? null,
                        librarySlot: canonicalLink?.librarySlot ?? null,
                    });

                    if (match.mediaId && (match.fileType === "track" || match.fileType === "video")) {
                        shouldPromoteArtist = true;
                        if (match.fileType === "video") {
                            // A video file on disk is evidence the library
                            // wants the video, so the selection is asserted.
                            db.prepare(`
                                INSERT INTO LibraryVideos (
                                    library_id, video_recording_id, selection_mode,
                                    placement_mode, reason, selected_at, updated_at
                                )
                                SELECT library.id, (
                                    SELECT MIN(video_match.recording_id)
                                    FROM ProviderItems item
                                    JOIN ProviderVideoMatches video_match
                                      ON video_match.provider_video_item_id = item.id
                                     AND video_match.match_state = 'accepted'
                                    WHERE item.entity_type = 'video'
                                      AND CAST(item.provider_id AS TEXT) = CAST(? AS TEXT)
                                      AND (? IS NULL OR item.provider = ?)
                                    HAVING COUNT(DISTINCT video_match.recording_id) = 1
                                ), 'auto', 'separated',
                                       'library_scan', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                                FROM Libraries library
                                JOIN quality_profiles library_quality_profile
                                  ON library_quality_profile.id = library.quality_profile_id
                                WHERE library.enabled = 1
                                  AND EXISTS (
                                    SELECT 1
                                    FROM json_each(COALESCE(library_quality_profile.allowed_source_formats, '[]')) allowed_format
                                    WHERE allowed_format.value = 'video'
                                  )
                                ON CONFLICT(library_id, video_recording_id) DO NOTHING
                            `).run(match.mediaId, matchProvider, matchProvider);
                        }

                        if (match.albumId && match.fileType === "track") {
                            const providerItem = db.prepare(`
                                SELECT MIN(release.release_group_id) AS release_group_id
                                FROM ProviderItems item
                                JOIN ProviderEditionMatches release_match
                                  ON release_match.provider_edition_item_id = item.id
                                 AND release_match.match_state = 'accepted'
                                JOIN AlbumEditions release ON release.id = release_match.edition_id
                                WHERE item.entity_type = 'release'
                                  AND CAST(item.provider_id AS TEXT) = CAST(? AS TEXT)
                                  AND (? IS NULL OR item.provider = ?)
                                HAVING COUNT(DISTINCT release.release_group_id) = 1
                            `).get(match.albumId, matchProvider, matchProvider) as {
                                release_group_id?: number;
                            } | undefined;

                            if (providerItem?.release_group_id != null) {
                                // Finding files for an Album in a Library root
                                // is evidence the Library wants it, so the row
                                // is asserted rather than a flag flipped. A
                                // locked Album is left exactly as the user set
                                // it.
                                db.prepare(`
                                    INSERT INTO LibraryAlbums (
                                      library_id, release_group_id, selection_mode,
                                      locked, reason, curation_version, updated_at
                                    )
                                    SELECT id, ?, 'auto', 0, 'library_scan', 1, CURRENT_TIMESTAMP
                                    FROM Libraries
                                    WHERE root_path = ? AND enabled = 1
                                    ON CONFLICT(library_id, release_group_id) DO UPDATE SET
                                      updated_at = CURRENT_TIMESTAMP
                                `).run(providerItem.release_group_id, rootPath);
                            }
                            updateAlbumDownloadStatus(match.albumId);
                        } else {
                            // matchProvider is the resolved provider identity for this
                            // stem; pass it so the recompute cannot hit a same-id
                            // resource belonging to a different provider.
                            updateArtistDownloadStatusFromMedia(match.mediaId, matchProvider);
                        }
                    }

                    indexed++;
                    existingPaths.add(resolved);

                    // Cleanup any existing unmapped_file record for this path
                    db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(resolved);
                } else if (options?.trackUnmappedFiles !== false && parsedForUnmapped && unmappedReason) {
                    try {
                        const {
                            detectedArtist,
                            detectedAlbum,
                            detectedTrack,
                            metrics,
                            relative,
                            stats,
                            ext,
                        } = parsedForUnmapped;
                        db.prepare(`
                            INSERT INTO UnmappedFiles (
                                file_path, relative_path, library_root, filename, extension, file_size, duration,
                                bitrate, sample_rate, bit_depth, channels, codec,
                                detected_artist, detected_album, detected_track, audio_quality, reason
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(file_path) DO UPDATE SET
                                relative_path = excluded.relative_path,
                                library_root = excluded.library_root,
                                file_size = excluded.file_size,
                                duration = COALESCE(excluded.duration, duration),
                                bitrate = COALESCE(excluded.bitrate, bitrate),
                                sample_rate = COALESCE(excluded.sample_rate, sample_rate),
                                bit_depth = COALESCE(excluded.bit_depth, bit_depth),
                                channels = COALESCE(excluded.channels, channels),
                                codec = COALESCE(excluded.codec, codec),
                                detected_artist = COALESCE(excluded.detected_artist, detected_artist),
                                detected_album = COALESCE(excluded.detected_album, detected_album),
                                detected_track = COALESCE(excluded.detected_track, detected_track),
                                audio_quality = COALESCE(excluded.audio_quality, audio_quality),
                                reason = excluded.reason,
                                updated_at = CURRENT_TIMESTAMP
                        `).run(
                            resolved,
                            relative,
                            key,
                            path.basename(resolved),
                            ext,
                            stats.size,
                            metrics.duration,
                            metrics.bitrate,
                            metrics.sampleRate,
                            metrics.bitDepth,
                            metrics.channels,
                            metrics.codec,
                            detectedArtist,
                            detectedAlbum,
                            detectedTrack,
                            metrics.audioQuality,
                            unmappedReason
                        );
                    } catch (e) {
                        console.error(`[DiskScan] Failed to track unmapped file ${resolved}:`, e);
                    }
                }
            }
        }

        if (shouldPromoteArtist) {
            db.prepare(`
                UPDATE Artists
                SET monitored = 1,
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

    /**
     * Phase C: Check existing track_files for size/mtime changes and update records.
     */
    private static updateChangedFiles(artistId: string): { updated: number } {
        const rows = db.prepare(`
      SELECT id, file_path, relative_path, library_root, file_size, modified_at, file_type
      FROM TrackFiles
      WHERE artist_id = ?
    `).all(artistId) as Array<{
            id: number;
            file_path: string;
            relative_path: string | null;
            library_root: string;
            file_size: number | null;
            modified_at: string | null;
            file_type: string;
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
          UPDATE TrackFiles
          SET file_size = ?, modified_at = ?, verified_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(stats.size, currentMtime, row.id);
                LibraryFilesService.emitFileUpgraded({
                    libraryFileId: row.id,
                    artistId,
                    fileType: row.file_type,
                    filePath: resolvedPath,
                    libraryRoot: row.library_root,
                    reason: "scan-file-changed",
                });
                updated++;
            } else {
                // Just update verified_at timestamp
                db.prepare("UPDATE TrackFiles SET verified_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
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
     *   - Album NFO (if save_nfo enabled and file missing)
     *   - Track lyrics (if save_lyrics is enabled and neither `.lrc` nor `.txt` exists)
     *
     * For each monitored artist with library files:
     *   - Artist picture (if save_artist_picture enabled and file missing)
     *   - Artist NFO (if save_nfo enabled and file missing)
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
     * Runs as part of scan({ addNewArtists: true }).
     *
     * @param onProgress Optional callback for progress reporting (SSE etc.)
     */
    private static async discoverNewArtists(
        onProgress?: (event: DiscoveryProgress) => void,
        options?: { monitorArtist?: boolean; fullProcessing?: boolean; trigger?: number },
    ): Promise<DiscoveryResult> {
        const shouldMonitor = options?.monitorArtist ?? getConfigSection("monitoring").monitor_new_artists;
        const trigger = options?.trigger ?? CommandTrigger.Manual;
        const result: DiscoveryResult = {
            knownFolders: 0,
            artistsAdded: [],
            unmatchedFolders: [],
            totalFolders: 0,
        };

        // Build a lookup of expected folder names for all known DB artists
        const allArtists = db.prepare("SELECT id, name, mbid, path FROM Artists").all() as Array<{
            id: number;
            name: string;
            mbid?: string | null;
            path?: string | null;
        }>;
        const managedArtistIds = new Set(
            getManagedArtists({ includeLibraryFiles: true }).map((artist) => String(artist.id))
        );
        const knownFolderToArtistId = new Map<string, number>();
        for (const a of allArtists) {
            if (!managedArtistIds.has(String(a.id))) {
                continue;
            }
            const folder = resolveArtistFolderFromRecord(a);
            knownFolderToArtistId.set(folder.toLowerCase(), a.id);
        }

        // Gather all unique library roots to scan
        const filtering = Config.getFilteringConfig();
        const roots = new Set<string>();
        roots.add(Config.getMusicPath());
        if (filtering.include_videos === true) {
            roots.add(Config.getVideoPath());
        }
        const spatialPath = Config.getSpatialPath();
        if (filtering.include_spatial === true && spatialPath) roots.add(spatialPath);

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
        libraryRoot: LibraryRootKey,
    ): { albumId: string | null; mediaId: string | null; fileType: string; quality: string | null } | null {
        // The scanned root is the only trustworthy statement about which library
        // this file belongs to; provider audio variants describe source
        // capability, not what is on disk, so they never decide it.
        const scanningVideoRoot = libraryRoot === "videos";
        const ext = path.extname(filePath).toLowerCase();
        const basename = path.basename(filePath);
        const stem = path.parse(filePath).name;

        const metadataConfig = getConfigSection("metadata");
        const artistPicName = metadataConfig.artist_picture_name || "folder.jpg";
        const albumCoverName = metadataConfig.album_cover_name || "cover.jpg";

        // Artist picture (in artist dir root)
        if (basename === artistPicName) {
            // Could be artist picture or album cover — check depth
            // Artist picture is directly under artist folder, album cover is under album subfolder
            const parentDir = path.basename(path.dirname(filePath));
            const artist = db.prepare("SELECT name, mbid, path FROM Artists WHERE id = ?").get(artistId) as any;
            if (artist) {
                const artistDirName = path.basename(resolveArtistFolderFromRecord(artist));
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

        if (isLyricSidecarExtension(ext)) {
            // Try to match to a track by looking for an audio file with same stem
            const identity = this.findTrackIdentityByStem(stem, artistId)
                || this.findTrackIdentityByTrackedSibling(filePath, artistId);
            if (!identity) return null;
            // A lyric sidecar lives in its album folder; when the track's release
            // context is ambiguous (one provider track on several releases), fall
            // back to the folder just like the cover does rather than guessing.
            const albumId = this.resolveAlbumIdForItem(identity.itemId)
                || this.findAlbumIdFromPath(filePath, artistId);
            return { albumId, mediaId: identity.providerId, fileType: "lyrics", quality: null };
        }

        // Audio files
        const audioExtensions = new Set([".flac", ".m4a", ".mp3", ".aac", ".wav", ".ogg", ".opus", ".aif", ".aiff", ".wma", ".ape", ".mp2"]);
        if (audioExtensions.has(ext)) {
            // Try to match by provider ID in filename
            const identity = this.findTrackIdentityByStem(stem, artistId);
            if (identity) {
                return {
                    albumId: this.resolveAlbumIdForItem(identity.itemId),
                    mediaId: identity.providerId,
                    fileType: "track",
                    // Provider audio variants describe what the SOURCE can offer,
                    // not what this file on disk actually is. Imported quality is
                    // read from the file's own tracked technical facts; the media
                    // probe fills it in when this row is new.
                    quality: this.importedQualityForFile(filePath),
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

        // Video files. Outside the video root a container like .mp4 is only a
        // music video when a video resource actually claims it, so the same
        // identity check applies — but we never let a music-root .mp4 fall
        // through to the video-thumbnail branch below.
        const videoExtensions = new Set([".mp4", ".ts", ".mkv", ".webm"]);
        if (videoExtensions.has(ext)) {
            const identity = this.findVideoIdentityByStem(stem, artistId);
            if (identity) {
                return {
                    albumId: this.resolveAlbumIdForItem(identity.itemId),
                    mediaId: identity.providerId,
                    fileType: "video",
                    quality: this.importedQualityForFile(filePath),
                };
            }

            return null;
        }

        // Image files that match a known video stem (video thumbnails). Only the
        // video root produces those; an image beside audio is album art, which
        // the cover branches above already claimed.
        if (scanningVideoRoot && (ext === ".jpg" || ext === ".png")) {
            const identity = this.findVideoIdentityByStem(stem, artistId);
            if (identity) {
                return {
                    albumId: this.resolveAlbumIdForItem(identity.itemId),
                    mediaId: identity.providerId,
                    fileType: "video_thumbnail",
                    quality: null,
                };
            }
        }

        return null;
    }

    /**
     * A provider resource's internal identity. `provider_id` alone is NOT an
     * identity — the same id occurs across providers and entity types (an Apple
     * album id can equal a TIDAL track id), so every lookup resolves and carries
     * `ProviderItems.id` plus the (provider, entity_type, provider_id) triple.
     */
    private static resolveProviderIdentity(row: {
        id?: number | null;
        provider?: string | null;
        entity_type?: string | null;
        provider_id?: string | number | null;
    } | undefined): ProviderItemIdentity | null {
        if (!row || row.id == null) return null;
        return {
            itemId: Number(row.id),
            provider: String(row.provider || ""),
            entityType: String(row.entity_type || ""),
            providerId: String(row.provider_id ?? ""),
        };
    }

    /**
     * The unambiguous provider release context for a provider item, or null.
     * Keyed on ProviderItems.id, never on a bare provider_id.
     */
    private static resolveAlbumIdForItem(itemId: number): string | null {
        const row = db.prepare(`
            SELECT ${PROVIDER_RESOLVED_ALBUM_ID_SQL} AS album_id
            FROM ProviderItems pi
            WHERE pi.id = ?
        `).get(itemId) as { album_id?: string | null } | undefined;
        return row?.album_id ? String(row.album_id) : null;
    }

    /**
     * Actual imported quality for a file already tracked on disk. Provider
     * capability never stands in for it: an offer may advertise Atmos while the
     * file present is the stereo rendition. Returns null for a file we have not
     * probed yet, letting the import/probe path fill it in.
     */
    private static importedQualityForFile(filePath: string): string | null {
        const row = db.prepare(`
            SELECT COALESCE(NULLIF(TRIM(imported_quality), ''), NULLIF(TRIM(quality), '')) AS quality
            FROM TrackFiles
            WHERE file_path = ?
            LIMIT 1
        `).get(path.resolve(filePath)) as { quality?: string | null } | undefined;
        return row?.quality ? String(row.quality) : null;
    }

    // ==========================================================================
    // Private: Lookup helpers
    // ==========================================================================

    /**
     * Resolve a provider TRACK/VIDEO identity from a filename stem that embeds a
     * provider id. Returns the full identity (ProviderItems.id + provider +
     * entity_type + provider_id): a bare provider id is ambiguous across
     * providers and entity types, so a stem match that hits more than one
     * provider resource is rejected rather than resolved arbitrarily.
     */
    private static findTrackIdentityByStem(stem: string, artistId: string): ProviderItemIdentity | null {
        const candidateIds: string[] = [];
        if (/^\d+$/.test(stem)) candidateIds.push(stem);
        const idMatch = stem.match(/\b(\d{6,})\b/);
        if (idMatch) candidateIds.push(idMatch[1]);

        for (const providerId of candidateIds) {
            const rows = db.prepare(`
                SELECT pi.id, pi.provider, pi.entity_type, pi.provider_id
                FROM ProviderItems pi
                WHERE pi.entity_type IN ('track', 'video')
                  AND CAST(pi.provider_id AS TEXT) = @providerId
                  AND ${LEGACY_FOLDER_SCAN_MEMBER_ARTIST_SCOPE_SQL}
                ORDER BY pi.updated_at DESC
            `).all({ providerId, artistId }) as Array<any>;
            // Same id under two providers (or as both a track and a video) is not
            // an identity — refuse instead of picking the most recently updated.
            if (rows.length === 1) {
                const identity = this.resolveProviderIdentity(rows[0]);
                if (identity) return identity;
            }
        }

        return null;
    }

    private static findTrackIdentityByTrackedSibling(filePath: string, artistId: string): ProviderItemIdentity | null {
        const stem = path.parse(filePath).name;
        const rows = db.prepare(`
          SELECT lf.provider, lf.provider_entity_type, lf.provider_id, lf.file_path
          FROM TrackFiles lf
          WHERE lf.artist_id = ?
            AND lf.provider_id IS NOT NULL
            AND lf.file_type = 'track'
        `).all(artistId) as Array<{
            provider: string | null;
            provider_entity_type: string | null;
            provider_id: string;
            file_path: string;
        }>;

        const sibling = rows.find((row) =>
            path.dirname(row.file_path) === path.dirname(filePath)
            && path.parse(row.file_path).name === stem
        );
        if (!sibling?.provider_id || !sibling.provider) return null;

        // Re-resolve the sibling's stored triple to a real ProviderItems row so
        // callers get an internal id, never a bare provider_id.
        const item = db.prepare(`
            SELECT pi.id, pi.provider, pi.entity_type, pi.provider_id
            FROM ProviderItems pi
            WHERE CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
              AND pi.provider = ?
              AND pi.entity_type = COALESCE(?, 'track')
            LIMIT 1
        `).get(
            sibling.provider_id,
            sibling.provider,
            sibling.provider_entity_type,
        ) as any;
        return this.resolveProviderIdentity(item);
    }

    /**
     * Try to find a provider VIDEO identity whose canonical title matches the stem.
     */
    private static findVideoIdentityByStem(stem: string, artistId: string): ProviderItemIdentity | null {
        const embedded = this.findTrackIdentityByStem(stem, artistId);
        if (embedded?.entityType === "video") {
            return embedded;
        }
        if (embedded) {
            // The stem's id resolved to a non-video resource; look for the video
            // sharing that provider's id within the same provider only.
            const exactVideo = db.prepare(`
              SELECT pi.id, pi.provider, pi.entity_type, pi.provider_id
              FROM ProviderItems pi
              WHERE pi.entity_type = 'video'
                AND pi.provider = @provider
                AND CAST(pi.provider_id AS TEXT) = @providerId
                AND ${LEGACY_FOLDER_SCAN_MEMBER_ARTIST_SCOPE_SQL}
              LIMIT 1
            `).get({ provider: embedded.provider, providerId: embedded.providerId, artistId }) as any;
            const identity = this.resolveProviderIdentity(exactVideo);
            if (identity) return identity;
        }

        const videos = db.prepare(`
            SELECT pi.id, pi.provider, pi.entity_type, pi.provider_id, r.title
            FROM ProviderItems pi
            JOIN ProviderVideoMatches video_match
              ON video_match.provider_video_item_id = pi.id
             AND video_match.match_state = 'accepted'
            JOIN Recordings r ON r.id = video_match.recording_id
            WHERE pi.entity_type = 'video'
              AND ${LEGACY_FOLDER_SCAN_MEMBER_ARTIST_SCOPE_SQL}
        `).all({ artistId }) as Array<any>;

        const titleMatches = videos.filter((video) =>
            stem.includes(video.title) || String(video.title).includes(stem));
        return titleMatches.length === 1 ? this.resolveProviderIdentity(titleMatches[0]) : null;
    }

    /**
     * Try to find the album_id from a file path by checking parent directory patterns.
     */
    private static findAlbumIdFromPath(filePath: string, artistId: string): string | null {
        const dirName = path.basename(path.dirname(filePath));

        // Try to match directory name against album titles
        const albums = db.prepare(`
            SELECT DISTINCT pi.provider_id AS id, pi.title
            FROM ProviderItems pi
            WHERE pi.entity_type = 'release'
              AND ${LEGACY_FOLDER_SCAN_RELEASE_ARTIST_SCOPE_SQL}
        `).all({ artistId }) as Array<{ id: string; title: string }>;

        for (const album of albums) {
            if (dirName.includes(album.title) || album.title.includes(dirName)) {
                return album.id;
            }
        }

        return null;
    }

    /**
     * Try finding media by comparing the file path to expected_path computed for known tracks.
     */
    private static findMediaByExpectedPath(filePath: string, artistId: string): { albumId: string | null; mediaId: string; quality: string | null } | null {
        const resolved = path.resolve(filePath);

        // Check if any track's expected path matches this file. The provider join
        // carries the FULL identity triple (provider + entity_type + provider_id):
        // matching on provider_id alone would attach an Apple offer to a TIDAL
        // file whenever the two ids collide. Quality is the file's own imported
        // quality, never a provider capability.
        const match = db.prepare(`
            SELECT
              lf.provider_id AS media_id,
              ${PROVIDER_RESOLVED_ALBUM_ID_SQL} AS album_id,
              COALESCE(NULLIF(TRIM(lf.imported_quality), ''), NULLIF(TRIM(lf.quality), '')) AS quality
            FROM TrackFiles lf
            JOIN ProviderItems pi
              ON CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
             AND pi.entity_type = COALESCE(lf.provider_entity_type, pi.entity_type)
             AND pi.entity_type IN ('track', 'video')
             AND (lf.provider IS NULL OR pi.provider = lf.provider)
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
     * scanning the full library (single-pass collection).
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
     * Collect audio/video files from a directory tree.
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
                        if (shouldSkipScanDirectory(entry.name)) {
                            await cooperateEntryWalk();
                            continue;
                        }
                        queue.push(fullPath);
                    } else if (entry.isFile()) {
                        if (shouldSkipScanFile(entry.name)) {
                            await cooperateEntryWalk();
                            continue;
                        }
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
     * Simple upsert into track_files (subset of OrganizerService.upsertLibraryFile).
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
        provider?: string | null;
        canonicalTrackMbid?: string | null;
        canonicalRecordingMbid?: string | null;
        canonicalReleaseMbid?: string | null;
        canonicalReleaseGroupMbid?: string | null;
        librarySlot?: string | null;
    }) {
        LibraryFilesService.upsertLibraryFile({
            ...params,
            removeFromUnmapped: false,
        });
    }
}
