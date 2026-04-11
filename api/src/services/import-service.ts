import fs from "fs";
import path from "path";
import { getAlbum, getVideo } from "./tidal.js";
import { RefreshAlbumService } from "./refresh-album-service.js";
import { Config } from "./config.js";
import {
    updateAlbumDownloadStatus,
    updateArtistDownloadStatusFromMedia,
} from "./download-state.js";
import { getExistingImportedMediaConflictPath } from "./import-decision/conflicts.js";
import { importMatcherService } from "./import-matcher-service.js";
import { manualImportService } from "./manual-import-service.js";
import type { LibraryRoot } from "./naming.js";
import {
    collectSiblingSidecarTargets,
    finalizeImportedDirectories,
    resolveImportedLibraryFileId,
    type ImportedDirectoryMapping,
} from "./import-finalize-service.js";
import {
    getTopLevelImportFolder,
    scanImportDirectory,
    summarizeAutoImportedCandidate,
} from "./import-discovery.js";
import {
    matchTrackForFile,
} from "./import-matching-utils.js";
import type { ImportDecisionMode } from "./import-decision/types.js";
import type {
    AutoImportedGroupSummary,
    ImportCandidate,
    LocalFile,
    LocalGroup,
    RootFolderImportProgressEvent,
    TidalMatch,
} from "./import-types.js";

export type {
    AutoImportedGroupSummary,
    ImportCandidate,
    LocalFile,
    LocalGroup,
    RootFolderImportProgressEvent,
    TidalMatch,
} from "./import-types.js";
import { extractReleaseGroup } from "./import-matching-utils.js";

export class ImportService {
    private candidates: ImportCandidate[] = [];
    private autoImportedGroups: AutoImportedGroupSummary[] = [];

    /**
     * Scans all configured root folders. When `targetFolders` is provided,
     * only the matching subdirectories are walked (scoped scan) instead of
     * traversing the entire root tree and post-filtering.
     */
    async scanRootFolders(options: {
        monitorImported?: boolean;
        targetFolders?: Set<string>;
        onProgress?: (event: RootFolderImportProgressEvent) => void;
    } = {}): Promise<ImportCandidate[]> {
        this.candidates = []; // Reset for now. In real app we might merge/update.
        this.autoImportedGroups = [];
        const monitorImported = options.monitorImported ?? true;
        const targetFolders = options.targetFolders;

        const roots = [
            { path: Config.getMusicPath(), name: 'Music', context: 'music', libraryRoot: 'music' as const },
            { path: Config.getAtmosPath(), name: 'Atmos', context: 'atmos', libraryRoot: 'spatial_music' as const },
            { path: Config.getVideoPath(), name: 'Videos', context: 'video', libraryRoot: 'music_videos' as const }
        ];

        const scannedRoots: Array<{
            root: (typeof roots)[number];
            groups: LocalGroup[];
        }> = [];

        for (const root of roots) {
            console.log(`Scanning root: ${root.path} (${root.context})`);
            try {
                let scopedGroups: LocalGroup[];

                if (targetFolders && targetFolders.size > 0) {
                    // Scoped scan: walk only the target subdirectories (not the full root)
                    scopedGroups = [];
                    for (const folderName of targetFolders) {
                        // Find the actual cased folder name on disk
                        const actualName = await this.resolveActualFolderName(root.path, folderName);
                        if (!actualName) continue;

                        const subPath = path.join(root.path, actualName);
                        try {
                            await fs.promises.access(subPath);
                        } catch {
                            continue;
                        }

                        const groups = await scanImportDirectory(subPath, root.path, root.libraryRoot);
                        scopedGroups.push(...groups);
                    }
                } else {
                    // Full scan: walk entire root (for manual import and unscoped discovery)
                    scopedGroups = await scanImportDirectory(root.path, root.path, root.libraryRoot);
                }

                scannedRoots.push({
                    root,
                    groups: scopedGroups,
                });
            } catch (err) {
                console.error(`Failed to scan root ${root.path}:`, err);
            }
        }

        const totalFiles = scannedRoots.reduce((sum, entry) => {
            return sum + entry.groups.reduce((groupSum, group) => groupSum + group.files.length, 0);
        }, 0);
        const totalGroups = scannedRoots.reduce((sum, entry) => sum + entry.groups.length, 0);

        if (totalFiles > 0) {
            options.onProgress?.({
                message: `Reading file 0/${totalFiles}`,
                currentFileNum: 0,
                totalFiles,
                currentGroupNum: 0,
                totalGroups,
            });
        }

        let processedFiles = 0;
        let processedGroups = 0;

        for (const { root, groups } of scannedRoots) {
            try {
                const rootFileOffset = processedFiles;
                const rootGroupOffset = processedGroups;
                const rootFileTotal = groups.reduce((sum, group) => sum + group.files.length, 0);

                const rootCandidates = await this.findMatches(groups, root.context as any, {
                    onProgress: (event) => {
                        const currentFileNum = rootFileOffset + event.currentFileNum;
                        const currentGroupNum = rootGroupOffset + event.currentGroupNum;
                        options.onProgress?.({
                            message: `Reading file ${currentFileNum}/${totalFiles}`,
                            currentFileNum,
                            totalFiles,
                            currentGroupNum,
                            totalGroups,
                        });
                    },
                }, "ExistingFiles");

                processedFiles = rootFileOffset + rootFileTotal;
                processedGroups = rootGroupOffset + groups.length;
                // Auto-import only when every local file mapped cleanly to the chosen release.
                const toImport = rootCandidates.filter((candidate) => {
                    const bestMatch = candidate.matches[0];
                    return Boolean(bestMatch?.autoImportReady);
                });
                const toReview = rootCandidates.filter(c => !toImport.includes(c));

                if (toImport.length > 0) {
                    console.log(`Auto-importing ${toImport.length} albums from ${root.name}`);
                    await this.importFiles(toImport, true, monitorImported);

                    for (const imported of toImport) {
                        if (imported.group.status !== "imported") {
                            this.candidates.push(imported);
                            continue;
                        }

                        const summary = summarizeAutoImportedCandidate(imported);
                        if (summary) {
                            this.autoImportedGroups.push(summary);
                        }
                    }
                }

                this.candidates.push(...toReview);
            } catch (err) {
                console.error(`Failed to scan root ${root.path}:`, err);
            }
        }

        return this.candidates;
    }

    /**
     * Returns current candidates that need manual attention.
     */
    getUnmapped(): ImportCandidate[] {
        return this.candidates.filter(c => c.group.status !== 'imported');
    }

    getAutoImported(): AutoImportedGroupSummary[] {
        return [...this.autoImportedGroups];
    }

    /**
     * Manually maps a local group to a specific Tidal album and imports it.
     */
    async mapGroup(groupId: string, tidalId: string): Promise<boolean> {
        const candidate = this.candidates.find(c => c.group.id === groupId);
        if (!candidate) {
            throw new Error(`Group not found: ${groupId}`);
        }

        const isVideo = candidate.group.libraryRoot === "music_videos";

        if (isVideo) {
            let tidalVideo;
            try {
                tidalVideo = await getVideo(tidalId);
            } catch (e) {
                throw new Error(`Failed to fetch Tidal video ${tidalId}`);
            }

            if (!tidalVideo) {
                throw new Error(`Tidal video ${tidalId} not found`);
            }

            candidate.matches = [{
                item: tidalVideo,
                itemType: "video",
                score: 1.0,
                matchType: "exact"
            }];
        } else {
            let tidalAlbum;
            try {
                tidalAlbum = await getAlbum(tidalId);
            } catch (e) {
                throw new Error(`Failed to fetch Tidal album ${tidalId}`);
            }

            if (!tidalAlbum) {
                throw new Error(`Tidal album ${tidalId} not found`);
            }

            candidate.matches = [{
                item: tidalAlbum,
                itemType: "album",
                score: 1.0,
                matchType: "exact"
            }];
        }

        // Import
        await this.importFiles([candidate]);
        return true;
    }

    /**
     * Maps an array of explicitly specified file->tidalId pairs.
     * This bypasses the fuzzy matching and strictly maps the given files to the given Tidal tracks,
     * registering them in the system and cleaning them from the unmapped_files table.
     */
    async bulkImportUnmapped(items: { id: number, tidalId: string }[]): Promise<void> {
        await manualImportService.bulkImportUnmapped(items);
    }


    /**
   * Main entry point to find matches for a set of groups.
   */
    async findMatches(
        groups: LocalGroup[],
        context: "music" | "atmos" | "video" = "music",
        options?: { onProgress?: (event: RootFolderImportProgressEvent) => void },
        mode: ImportDecisionMode = "NewDownload",
    ): Promise<ImportCandidate[]> {
        return importMatcherService.findMatches(groups, context, options, mode);
    }

    async findMatchesForGroup(
        group: LocalGroup,
        context: "music" | "atmos" | "video" = "music",
        mode: ImportDecisionMode = "NewDownload",
    ): Promise<TidalMatch[]> {
        return importMatcherService.findMatchesForGroup(group, context, mode);
    }

    /**
     * Imports selected candidates into the database.
     */
    async importFiles(candidates: ImportCandidate[], isAuto = false, monitorImported = true) {
        const { db } = await import("../database.js");
        const { getNamingConfig, renderRelativePath, resolveArtistFolderFromRecord } = await import("./naming.js");
        const { resolveArtistFolderForPersistence } = await import("./artist-paths.js");
        const { deriveQuality, calculateFingerprint } = await import("./audioUtils.js");

        const namingConfig = getNamingConfig();

        const upsertArtist = db.prepare(`
            INSERT INTO artists (id, name, picture, popularity, monitor, path)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = COALESCE(excluded.name, name),
                picture = COALESCE(excluded.picture, picture),
                popularity = COALESCE(excluded.popularity, popularity),
                path = COALESCE(artists.path, excluded.path),
                monitor = CASE
                    WHEN monitor = 0 AND excluded.monitor = 1 THEN 1
                    ELSE monitor
                END
        `);

        const upsertVideo = db.prepare(`
            INSERT INTO media (
                id, artist_id, album_id, title, version, release_date,
                type, explicit, quality, duration, popularity, cover, monitor
            ) VALUES (?, ?, ?, ?, ?, ?, 'Music Video', ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                artist_id = excluded.artist_id,
                album_id = excluded.album_id,
                title = excluded.title,
                version = excluded.version,
                release_date = excluded.release_date,
                explicit = excluded.explicit,
                quality = excluded.quality,
                duration = excluded.duration,
                popularity = excluded.popularity,
                cover = COALESCE(excluded.cover, cover),
                type = 'Music Video',
                monitor = CASE WHEN monitor_lock = 0 THEN excluded.monitor ELSE monitor END
        `);

        const monitorValue = monitorImported ? 1 : 0;

        const insertLibraryFile = db.prepare(`
            INSERT INTO library_files (
                artist_id, album_id, media_id,
                file_path, relative_path, library_root,
                filename, extension, file_size, duration,
                file_type, quality, needs_rename,
                bit_depth, sample_rate, bitrate, codec, channels,
                naming_template, expected_path,
                original_filename, release_group, fingerprint,
                modified_at, verified_at
            ) VALUES (
                @artistId, @albumId, @mediaId,
                @filePath, @relativePath, @libraryRoot,
                @filename, @extension, @fileSize, @duration,
                @fileType, @quality, @needsRename,
                @bitDepth, @sampleRate, @bitrate, @codec, @channels,
                @namingTemplate, @expectedPath,
                @originalFilename, @releaseGroup, @fingerprint,
                @modifiedAt, CURRENT_TIMESTAMP
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
                duration = excluded.duration,
                file_type = excluded.file_type,
                quality = excluded.quality,
                needs_rename = excluded.needs_rename,
                bit_depth = excluded.bit_depth,
                sample_rate = excluded.sample_rate,
                bitrate = excluded.bitrate,
                codec = excluded.codec,
                channels = excluded.channels,
                naming_template = excluded.naming_template,
                expected_path = excluded.expected_path,
                original_filename = excluded.original_filename,
                release_group = excluded.release_group,
                fingerprint = excluded.fingerprint,
                modified_at = excluded.modified_at,
                verified_at = CURRENT_TIMESTAMP
        `);
        const findExistingMediaLibraryFile = db.prepare(`
            SELECT id
            FROM library_files
            WHERE media_id = ? AND file_type = ?
            ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
            LIMIT 1
        `);
        const updateExistingLibraryFile = db.prepare(`
            UPDATE library_files
            SET artist_id = @artistId,
                album_id = @albumId,
                media_id = @mediaId,
                file_path = @filePath,
                relative_path = @relativePath,
                library_root = @libraryRoot,
                filename = @filename,
                extension = @extension,
                file_size = @fileSize,
                duration = @duration,
                file_type = @fileType,
                quality = @quality,
                needs_rename = @needsRename,
                bit_depth = @bitDepth,
                sample_rate = @sampleRate,
                bitrate = @bitrate,
                codec = @codec,
                channels = @channels,
                naming_template = @namingTemplate,
                expected_path = @expectedPath,
                original_filename = @originalFilename,
                release_group = @releaseGroup,
                fingerprint = COALESCE(@fingerprint, fingerprint),
                modified_at = @modifiedAt,
                verified_at = CURRENT_TIMESTAMP
            WHERE id = @id
        `);
        const deleteDuplicateMediaLibraryFiles = db.prepare(`
            DELETE FROM library_files
            WHERE media_id = ? AND file_type = ? AND id != ?
        `);
        const upsertImportedLibraryFile = (params: Record<string, unknown>) => {
            const mediaId = String(params.mediaId || "");
            const fileType = String(params.fileType || "");
            const filePath = String(params.filePath || "");
            if (mediaId && (fileType === "track" || fileType === "video")) {
                const existingRow = findExistingMediaLibraryFile.get(mediaId, fileType, filePath) as { id: number } | undefined;
                if (existingRow) {
                    updateExistingLibraryFile.run({ ...params, id: existingRow.id });
                    deleteDuplicateMediaLibraryFiles.run(mediaId, fileType, existingRow.id);
                    return;
                }
            }

            insertLibraryFile.run(params);
        };

        for (const candidate of candidates) {
            if (!candidate.matches || candidate.matches.length === 0) continue;

            const match = candidate.matches[0];
            if (isAuto && !match.autoImportReady) continue;
            const conflictPath = getExistingImportedMediaConflictPath(candidate.group, match);
            if (conflictPath) {
                match.rejections = [`Album already imported at ${conflictPath}`];
                match.conflictPath = conflictPath;
                console.warn(
                    `[Import] Skipping auto-import for ${candidate.group.path} because the matched media is already imported from another folder.`
                );
                continue;
            }

            const libraryRootKey = candidate.group.libraryRoot || "music";
            const rootPath = candidate.group.rootPath;
            const importedFileIds: number[] = [];
            const dirMappings = new Map<string, ImportedDirectoryMapping>();
            const explicitSidecarTargets = new Map<string, string>();

            if (match.itemType === "video") {
                const tidalVideo = match.item;
                const videoId = tidalVideo?.id?.toString?.() ?? tidalVideo?.tidal_id?.toString?.();
                if (!videoId) continue;

                let videoData = tidalVideo;
                try {
                    videoData = await getVideo(videoId);
                } catch (e) {
                    console.warn(`[Import] Failed to fetch video ${videoId}, falling back to search data.`);
                }

                const artistId = videoData.artist_id
                    || tidalVideo.artist?.id?.toString?.()
                    || tidalVideo.artists?.[0]?.id?.toString?.();
                if (!artistId) continue;

                const artistName = videoData.artist_name
                    || tidalVideo.artist?.name
                    || tidalVideo.artists?.[0]?.name
                    || "Unknown Artist";
                const artistPicture = tidalVideo.artist?.picture || tidalVideo.artists?.[0]?.picture || null;
                const artistPopularity = videoData.popularity || 0;
                const resolvedArtistFolder = resolveArtistFolderForPersistence({
                    artistId,
                    artistName,
                });

                try {
                    upsertArtist.run(artistId, artistName, artistPicture, artistPopularity, monitorValue, resolvedArtistFolder);
                } catch (e) {
                    console.error(`Failed to upsert artist ${artistId}`, e);
                }

                const artistRow = db.prepare("SELECT name, mbid, path FROM artists WHERE id = ?").get(artistId) as any;
                const artistFolder = resolveArtistFolderFromRecord({
                    name: artistRow?.name || artistName,
                    mbid: artistRow?.mbid || null,
                    path: artistRow?.path || resolvedArtistFolder,
                });

                upsertVideo.run(
                    videoId,
                    artistId,
                    videoData.album_id || null,
                    videoData.title || tidalVideo.title || "Unknown Video",
                    videoData.version || null,
                    videoData.release_date || null,
                    videoData.explicit ? 1 : 0,
                    videoData.quality || tidalVideo.quality || "MP4_1080P",
                    videoData.duration || 0,
                    videoData.popularity || 0,
                    videoData.image_id || tidalVideo.image_id || tidalVideo.imageId || null,
                    monitorValue
                );

                const videoTemplate = path.join(artistFolder, namingConfig.video_file);
                const expectedVideoRel = renderRelativePath(videoTemplate, {
                    artistName,
                    artistMbId: artistRow?.mbid || null,
                    videoTitle: videoData.title || tidalVideo.title || "Unknown Video"
                });

                for (const file of candidate.group.files) {
                    const ext = file.extension;
                    const expectedRelPath = `${expectedVideoRel}${ext}`;
                    const relativePath = path.relative(rootPath, file.path);
                    const normalizedActual = relativePath.split(path.sep).join('/');
                    const normalizedExpected = expectedRelPath.split(path.sep).join('/');
                    const needsRename = normalizedActual !== normalizedExpected ? 1 : 0;
                    const expectedPath = path.join(rootPath, expectedRelPath);

                    const format = (file.metadata?.format || {}) as any;
                    const metrics = {
                        bitrate: format.bitrate,
                        sampleRate: format.sampleRate,
                        bitDepth: format.bitsPerSample,
                        codec: format.codec,
                        channels: format.numberOfChannels,
                        duration: format.duration
                    };

                    const releaseGroup = extractReleaseGroup(file.name);
                    const fingerprint = await calculateFingerprint(file.path);
                    collectSiblingSidecarTargets(file.path, expectedPath, [".jpg", ".jpeg", ".png", ".webp"], explicitSidecarTargets);

                    const stats = await fs.promises.stat(file.path);

                    upsertImportedLibraryFile({
                        artistId,
                        albumId: videoData.album_id || null,
                        mediaId: videoId,
                        filePath: file.path,
                        relativePath,
                        libraryRoot: libraryRootKey,
                        filename: file.name,
                        extension: ext.replace('.', ''),
                        fileSize: file.size,
                        duration: metrics.duration || 0,
                        fileType: "video",
                        quality: videoData.quality || "MP4_1080P",
                        needsRename,
                        bitDepth: metrics.bitDepth || null,
                        sampleRate: metrics.sampleRate || null,
                        bitrate: metrics.bitrate || null,
                        codec: metrics.codec || null,
                        channels: metrics.channels || null,
                        namingTemplate: videoTemplate,
                        expectedPath,
                        originalFilename: file.name,
                        releaseGroup: releaseGroup,
                        fingerprint: fingerprint || null,
                        modifiedAt: stats.mtime.toISOString()
                    });

                    const libraryFileId = resolveImportedLibraryFileId(file.path);
                    if (libraryFileId !== null) {
                        importedFileIds.push(libraryFileId);
                    }

                    db.prepare(`
                        UPDATE media
                        SET monitor = CASE WHEN monitor_lock = 0 THEN 1 ELSE monitor END,
                            monitored_at = CASE WHEN monitor_lock = 0 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
                        WHERE id = ?
                    `).run(videoId);
                    updateArtistDownloadStatusFromMedia(videoId);

                    dirMappings.set(path.dirname(file.path), {
                        destDir: path.dirname(expectedPath),
                        artistId,
                        albumId: videoData.album_id ? String(videoData.album_id) : null,
                        libraryRootPath: rootPath,
                    });
                }

                await finalizeImportedDirectories({
                    importedFileIds,
                    dirMappings,
                    imageFileType: "video_thumbnail",
                    explicitSidecarTargets,
                });

                candidate.group.status = 'imported';
                continue;
            }

            const tidalAlbum = match.item;
            const albumId = tidalAlbum?.id?.toString?.() ?? tidalAlbum?.tidal_id?.toString?.();
            if (!albumId) continue;

            try {
                await RefreshAlbumService.scanShallow(albumId);
            } catch (e) {
                console.error(`[Import] Failed to scan album ${albumId}:`, e);
                continue;
            }

            const albumRow = db.prepare(`
                SELECT id, artist_id, title, version, release_date, num_volumes, explicit
                FROM albums
                WHERE id = ?
            `).get(albumId) as any;

            if (!albumRow) continue;

            const artistId = String(albumRow.artist_id
                || tidalAlbum.artist?.id?.toString?.()
                || tidalAlbum.artists?.[0]?.id?.toString?.()
                || "");
            if (!artistId) continue;

            const artistName = tidalAlbum.artist?.name || tidalAlbum.artists?.[0]?.name || "Unknown Artist";
            const artistPicture = tidalAlbum.artist?.picture || tidalAlbum.artists?.[0]?.picture || null;
            const artistPopularity = tidalAlbum.popularity || 0;
                const resolvedArtistFolder = resolveArtistFolderForPersistence({
                    artistId,
                    artistName,
                });

            try {
                upsertArtist.run(artistId, artistName, artistPicture, artistPopularity, monitorValue, resolvedArtistFolder);
            } catch (e) {
                console.error(`Failed to upsert artist ${artistId}`, e);
            }

            const artistRow = db.prepare("SELECT name, mbid, path FROM artists WHERE id = ?").get(artistId) as any;
            const artistFolder = resolveArtistFolderFromRecord({
                name: artistRow?.name || artistName,
                mbid: artistRow?.mbid || null,
                path: artistRow?.path || resolvedArtistFolder,
            });

            db.prepare(`
                UPDATE artists
                SET monitor = ?,
                    monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
                WHERE id = ?
            `).run(monitorValue, monitorValue, artistId);
            db.prepare(`
                UPDATE albums
                SET monitor = ?,
                    monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
                WHERE id = ? AND monitor_lock = 0
            `).run(monitorValue, monitorValue, albumId);
            db.prepare(`
                UPDATE media
                SET monitor = ?,
                    monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
                WHERE album_id = ? AND monitor_lock = 0
            `).run(monitorValue, monitorValue, albumId);
            db.prepare(`
                INSERT OR IGNORE INTO album_artists (album_id, artist_id, type, group_type, module)
                VALUES (?, ?, 'MAIN', 'ALBUMS', NULL)
            `).run(albumId, artistId);

            const trackRows = db.prepare(`
                SELECT id, title, track_number, volume_number
                FROM media
                WHERE album_id = ? AND type != 'Music Video'
            `).all(albumId) as any[];

            const releaseYear = albumRow.release_date ? String(albumRow.release_date).slice(0, 4) : null;
            const isMultiDisc = Number(albumRow.num_volumes || 1) > 1;
            const trackTemplate = isMultiDisc ? namingConfig.album_track_path_multi : namingConfig.album_track_path_single;
            const fullPathTemplate = path.join(artistFolder, trackTemplate);
            const trackRowsById = new Map(trackRows.map((row) => [String(row.id), row]));

            for (const file of candidate.group.files) {
                try {
                    const mappedTrackId = match.trackIdsByFilePath?.[file.path];
                    const matchedTrack = (mappedTrackId ? trackRowsById.get(String(mappedTrackId)) : null)
                        || matchTrackForFile(file, trackRows);
                    const trackTitle = matchedTrack?.title
                        || file.metadata?.common?.title
                        || path.parse(file.name).name;
                    const trackNumber = matchedTrack?.track_number || file.metadata?.common?.track?.no || 0;
                    const volumeNumber = matchedTrack?.volume_number || file.metadata?.common?.disk?.no || 1;

                    const context = {
                        artistName,
                        artistMbId: artistRow?.mbid || null,
                        albumTitle: albumRow.title,
                        albumVersion: albumRow.version,
                        releaseYear,
                        trackTitle,
                        trackNumber,
                        volumeNumber,
                        explicit: Boolean(albumRow.explicit)
                    };

                    const expectedRelPath = renderRelativePath(fullPathTemplate, context) + file.extension;
                    const relativePath = path.relative(rootPath, file.path);
                    const normalizedActual = relativePath.split(path.sep).join('/');
                    const normalizedExpected = expectedRelPath.split(path.sep).join('/');
                    const needsRename = normalizedActual !== normalizedExpected ? 1 : 0;
                    const expectedPath = path.join(rootPath, expectedRelPath);

                    const format = (file.metadata?.format || {}) as any;
                    const metrics = {
                        bitrate: format.bitrate,
                        sampleRate: format.sampleRate,
                        bitDepth: format.bitsPerSample,
                        codec: format.codec,
                        channels: format.numberOfChannels,
                        duration: format.duration
                    };

                    const ext = file.extension;
                    const quality = deriveQuality(ext, metrics);

                    const releaseGroup = extractReleaseGroup(file.name);
                    const fingerprint = await calculateFingerprint(file.path);
                    collectSiblingSidecarTargets(file.path, expectedPath, [".lrc"], explicitSidecarTargets);

                    const stats = await fs.promises.stat(file.path);

                    upsertImportedLibraryFile({
                        artistId,
                        albumId,
                        mediaId: matchedTrack?.id || null,
                        filePath: file.path,
                        relativePath,
                        libraryRoot: libraryRootKey,
                        filename: file.name,
                        extension: ext.replace('.', ''),
                        fileSize: file.size,
                        duration: metrics.duration || 0,
                        fileType: "track",
                        quality,
                        needsRename,
                        bitDepth: metrics.bitDepth || null,
                        sampleRate: metrics.sampleRate || null,
                        bitrate: metrics.bitrate || null,
                        codec: metrics.codec || null,
                        channels: metrics.channels || null,
                        namingTemplate: fullPathTemplate,
                        expectedPath,
                        originalFilename: file.name,
                        releaseGroup: releaseGroup,
                        fingerprint: fingerprint || null,
                        modifiedAt: stats.mtime.toISOString()
                    });

                    const libraryFileId = resolveImportedLibraryFileId(file.path);
                    if (libraryFileId !== null) {
                        importedFileIds.push(libraryFileId);
                    }

                    if (matchedTrack?.id) {
                        db.prepare(`
                            UPDATE media
                            SET monitor = CASE WHEN monitor_lock = 0 THEN 1 ELSE monitor END,
                                monitored_at = CASE WHEN monitor_lock = 0 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
                            WHERE id = ?
                        `).run(matchedTrack.id);
                    }

                    dirMappings.set(path.dirname(file.path), {
                        destDir: path.dirname(expectedPath),
                        artistId,
                        albumId: String(albumId),
                        libraryRootPath: rootPath,
                    });
                } catch (err) {
                    console.error(`Failed to insert file ${file.path}:`, err);
                }
            }

            await finalizeImportedDirectories({
                importedFileIds,
                dirMappings,
                imageFileType: "cover",
                explicitSidecarTargets,
            });

            updateAlbumDownloadStatus(String(albumId));

            candidate.group.status = 'imported';
        }
    }

    /**
     * Resolve the actual cased folder name on disk from a lowercased name.
     * Returns null if no matching directory is found.
     */
    private async resolveActualFolderName(rootPath: string, lowercaseName: string): Promise<string | null> {
        try {
            const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.toLowerCase() === lowercaseName) {
                    return entry.name;
                }
            }
        } catch {
            // Permission errors
        }
        return null;
    }

}

export const importService = new ImportService();
