import fs from "fs";
import path from "path";
import {
    updateAlbumDownloadStatus,
    updateArtistDownloadStatusFromMedia,
} from "./download-state.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { normalizeResolvedPath } from "./path-utils.js";
import {
    finalizeImportedDirectories,
    resolveImportedLibraryFileId,
    type ImportedDirectoryMapping,
} from "./import-finalize-service.js";

export class ManualImportApplyService {
    async bulkImportUnmapped(items: { id: number, tidalId: string }[]): Promise<void> {
        const { db } = await import("../database.js");
        const { getTrack, getArtist, getVideo } = await import("./tidal.js");
        const { scanAlbumShallow } = await import("./scanner.js");
        const { Config } = await import("./config.js");
        const { getNamingConfig, renderRelativePath, resolveArtistFolder, resolveArtistFolderFromRecord } = await import("./naming.js");
        const { calculateFingerprint } = await import("./audioUtils.js");

        const namingConfig = getNamingConfig();

        // ── Phase 1: Async collection ───────────────────────────────────
        // Fetch all remote metadata, fingerprints, and FS stats before touching the DB.
        interface CollectedItem {
            id: number;
            tidalId: string;
            file: any;
            trackData: any;
            artistId: string;
            artistInfo: { name: string; picture: string | null; popularity: number } | null;
            artistRow: { name: string; mbid: string | null; path: string | null } | null;
            albumId: string | null;
            isVideo: boolean;
            fingerprint: string | null;
            stats: fs.Stats;
            extension: string;
            libraryRootKey: string;
            quality: string;
            rootPath: string;
            expectedPath: string;
            relativePath: string;
            expectedRelPath: string;
            needsRename: number;
            fileType: "video" | "track";
            fullPathTemplate: string;
            artistFolder: string;
        }

        const collected: CollectedItem[] = [];

        for (const item of items) {
            try {
                const file = db.prepare("SELECT * FROM unmapped_files WHERE id = ?").get(item.id) as any;
                if (!file) {
                    console.warn(`[Bulk Import] Unmapped file ID ${item.id} not found.`);
                    continue;
                }

                const extension = String(file.extension || path.extname(file.file_path)).replace(/^\./, "").toLowerCase();
                const isVideo = file.library_root === "music_videos" || ["mp4", "mkv", "m4v", "mov", "webm", "ts"].includes(extension);

                // Fetch track/video metadata from TIDAL API
                let trackData: any;
                if (isVideo) {
                    try {
                        trackData = await getVideo(item.tidalId);
                    } catch (videoError: any) {
                        console.error(`[Bulk Import] Could not resolve video ${item.tidalId} for file ${file.filename}`, videoError);
                        continue;
                    }
                } else {
                    try {
                        trackData = await getTrack(item.tidalId);
                    } catch (e: any) {
                        console.warn(`[Bulk Import] getTrack(${item.tidalId}) failed: ${e.message}. Trying getAlbumTracks...`);
                        try {
                            const { getAlbumTracks } = await import("./tidal.js");
                            const tracks = await getAlbumTracks(item.tidalId);

                            let bestTrack = tracks.length > 0 ? tracks[0] : null;
                            const lowerFilename = file.filename.toLowerCase();
                            for (const t of tracks) {
                                if (lowerFilename.includes(t.title.toLowerCase()) ||
                                    lowerFilename.includes(` ${t.track_number} `) ||
                                    lowerFilename.startsWith(`${t.track_number} -`) ||
                                    lowerFilename.startsWith(`0${t.track_number}`)) {
                                    bestTrack = t;
                                    break;
                                }
                            }

                            if (bestTrack) {
                                trackData = await getTrack(bestTrack.tidal_id);
                                console.log(`[Bulk Import] Resolved album ${item.tidalId} to track ${bestTrack.tidal_id} for file ${file.filename}`);
                            } else {
                                throw new Error("No tracks found in album");
                            }
                        } catch (e2: any) {
                            console.error(`[Bulk Import] Could not resolve album ${item.tidalId} for file ${file.filename}`, e2);
                            continue;
                        }
                    }
                }
                if (!trackData) continue;

                const artistId = trackData.artist?.id?.toString() || trackData.artist_id?.toString();

                // Fetch artist info if needed (check DB first to avoid redundant API calls)
                let artistInfo: CollectedItem["artistInfo"] = null;
                if (artistId) {
                    const existingArtist = db.prepare("SELECT id FROM artists WHERE id = ?").get(artistId);
                    if (!existingArtist) {
                        const fallbackName = trackData.artist?.name || trackData.artist_name || "Unknown Artist";
                        try {
                            const remoteArtist = await getArtist(artistId);
                            artistInfo = { name: remoteArtist.name, picture: remoteArtist.picture || null, popularity: remoteArtist.popularity || 0 };
                        } catch {
                            artistInfo = { name: fallbackName, picture: null, popularity: 0 };
                        }
                    }
                }

                // Read artist row for naming (may have been inserted in a prior iteration's commit — read fresh)
                const artistRow = artistId
                    ? db.prepare("SELECT name, mbid, path FROM artists WHERE id = ?").get(artistId) as any
                    : null;

                // Scan album metadata from TIDAL
                const albumId = (trackData.album?.id || trackData.album_id)?.toString() || null;
                if (albumId) {
                    try { await scanAlbumShallow(albumId); } catch {
                        console.warn(`[Bulk Import] Could not perform shallow scan for album ${albumId}`);
                    }
                }

                // Read album row for naming (may have been created by scanAlbumShallow)
                const albumRow = albumId ? db.prepare("SELECT * FROM albums WHERE id = ?").get(albumId) as any : null;

                // Fingerprint + filesystem stats
                let fingerprint: string | null = null;
                try { fingerprint = await calculateFingerprint(file.file_path); } catch { /* best effort */ }

                const stats = fs.statSync(file.file_path);

                // Compute paths and naming
                const storedLibraryRoot = String(file.library_root || "");
                const libraryRootKey = (() => {
                    if (["music", "spatial_music", "music_videos"].includes(storedLibraryRoot)) return storedLibraryRoot;
                    const norm = storedLibraryRoot.toLowerCase();
                    const videoPath = Config.getVideoPath().toLowerCase();
                    const atmosPath = Config.getAtmosPath()?.toLowerCase();
                    if (norm === videoPath || norm.includes(`${path.sep}videos`) || norm.includes("/videos")) return "music_videos";
                    if (atmosPath && norm === atmosPath) return "spatial_music";
                    return isVideo ? "music_videos" : "music";
                })();

                const quality = trackData.quality || (isVideo ? "MP4_1080P" : "LOSSLESS");
                const artistFolder = resolveArtistFolderFromRecord({
                    name: artistRow?.name || trackData.artist?.name || trackData.artist_name || "Unknown Artist",
                    mbid: artistRow?.mbid || null,
                    path: artistRow?.path || null,
                });

                const releaseYear = albumRow?.release_date ? String(albumRow.release_date).slice(0, 4) : null;
                const isMultiDisc = Number(albumRow?.num_volumes || 1) > 1;
                const trackTemplate = isMultiDisc ? namingConfig.album_track_path_multi : namingConfig.album_track_path_single;
                const fullPathTemplate = isVideo ? path.join(artistFolder, namingConfig.video_file) : path.join(artistFolder, trackTemplate);

                const expectedRelPath = renderRelativePath(fullPathTemplate, {
                    artistName: artistRow?.name || trackData.artist?.name || trackData.artist_name || "Unknown Artist",
                    artistMbId: artistRow?.mbid || null,
                    albumTitle: trackData.album?.title || trackData.album_title || "Unknown Album",
                    albumVersion: albumRow?.version,
                    releaseYear,
                    trackTitle: trackData.title,
                    trackNumber: trackData.trackNumber || trackData.track_num || 1,
                    volumeNumber: trackData.volumeNumber || trackData.volume_num || 1,
                    explicit: Boolean(albumRow?.explicit),
                    videoTitle: trackData.title
                }) + "." + extension;

                let rootPath = Config.getMusicPath();
                if (libraryRootKey === "music_videos") rootPath = Config.getVideoPath();
                else if (quality === "DOLBY_ATMOS") rootPath = Config.getAtmosPath();

                const expectedPath = path.join(rootPath, expectedRelPath);
                const relativePath = path.relative(rootPath, file.file_path);
                const needsRename = relativePath.split(path.sep).join("/") !== expectedRelPath.split(path.sep).join("/") ? 1 : 0;

                collected.push({
                    id: item.id,
                    tidalId: item.tidalId,
                    file,
                    trackData,
                    artistId,
                    artistInfo,
                    artistRow,
                    albumId,
                    isVideo,
                    fingerprint,
                    stats,
                    extension,
                    libraryRootKey,
                    quality,
                    rootPath,
                    expectedPath,
                    relativePath,
                    expectedRelPath,
                    needsRename,
                    fileType: isVideo ? "video" : "track",
                    fullPathTemplate,
                    artistFolder,
                });
            } catch (outerError: any) {
                console.error(`[Bulk Import] Failed collecting metadata for file ${item.id} → TIDAL ${item.tidalId}:`, outerError);
            }
        }

        if (collected.length === 0) return;

        // ── Phase 2: Single-transaction DB commit ───────────────────────
        // All reads for control-flow decisions and all writes happen in one transaction.
        const audioInsertedIds: number[] = [];
        const audioDirMappings = new Map<string, ImportedDirectoryMapping>();
        const videoInsertedIds: number[] = [];
        const videoDirMappings = new Map<string, ImportedDirectoryMapping>();
        const statusUpdates: Array<{ albumId: string | null; tidalId: string }> = [];

        db.transaction(() => {
            for (const c of collected) {
                // Ensure artist exists
                if (c.artistId && c.artistInfo) {
                    db.prepare(`
                        INSERT OR IGNORE INTO artists (id, name, picture, popularity, monitor, path)
                        VALUES (?, ?, ?, ?, 0, ?)
                    `).run(
                        c.artistId,
                        c.artistInfo.name,
                        c.artistInfo.picture,
                        c.artistInfo.popularity,
                        resolveArtistFolder(c.artistInfo.name)
                    );
                }

                // Album monitor + album_artists
                if (c.albumId) {
                    db.prepare(`
                        UPDATE albums SET monitor = 1, monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
                        WHERE id = ? AND monitor_lock = 0
                    `).run(c.albumId);
                    db.prepare(`
                        INSERT OR IGNORE INTO album_artists (album_id, artist_id, type, group_type, module)
                        VALUES (?, ?, 'MAIN', 'ALBUMS', NULL)
                    `).run(c.albumId, c.artistId);
                }

                // Video media upsert
                if (c.isVideo) {
                    db.prepare(`
                        INSERT INTO media (
                            id, artist_id, album_id, title, version, release_date, type,
                            explicit, quality, duration, popularity, cover, monitor
                        ) VALUES (?, ?, ?, ?, ?, ?, 'Music Video', ?, ?, ?, ?, ?, 1)
                        ON CONFLICT(id) DO UPDATE SET
                            artist_id = excluded.artist_id, album_id = excluded.album_id,
                            title = excluded.title, version = excluded.version,
                            release_date = excluded.release_date, explicit = excluded.explicit,
                            quality = excluded.quality, duration = excluded.duration,
                            popularity = excluded.popularity,
                            cover = COALESCE(excluded.cover, cover),
                            monitor = CASE WHEN monitor_lock = 0 OR monitor_lock IS NULL THEN 1 ELSE monitor END
                    `).run(
                        c.tidalId, c.artistId, c.albumId || null,
                        c.trackData.title || "Unknown Video", c.trackData.version || null,
                        c.trackData.release_date || null, c.trackData.explicit ? 1 : 0,
                        c.trackData.quality || "MP4_1080P", c.trackData.duration || 0,
                        c.trackData.popularity || 0, c.trackData.image_id || null,
                    );
                }

                // Check for existing library file
                const existingLibraryFile = db.prepare(`
                    SELECT id, file_path, relative_path, library_root FROM library_files
                    WHERE media_id = ? AND file_type = ?
                    ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
                    LIMIT 1
                `).get(c.tidalId, c.fileType, c.file.file_path) as {
                    id: number; file_path: string; relative_path: string | null; library_root: string | null;
                } | undefined;

                const existingLibraryFilePath = existingLibraryFile
                    ? resolveStoredLibraryPath({
                        filePath: existingLibraryFile.file_path,
                        libraryRoot: existingLibraryFile.library_root,
                        relativePath: existingLibraryFile.relative_path,
                    })
                    : null;
                const sameTrackedPath = existingLibraryFilePath
                    ? normalizeResolvedPath(existingLibraryFilePath) === normalizeResolvedPath(c.file.file_path)
                    : false;
                const existingTrackedFilePresent = existingLibraryFilePath ? fs.existsSync(existingLibraryFilePath) : false;

                if (existingLibraryFile && existingTrackedFilePresent && !sameTrackedPath) {
                    db.prepare(`
                        UPDATE unmapped_files SET reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
                    `).run("Duplicate of an existing imported library file", c.id);
                    console.warn(`[Bulk Import] Skipping duplicate: ${c.file.file_path} for media ${c.tidalId}`);
                    continue;
                }

                if (existingLibraryFile && sameTrackedPath) {
                    db.prepare(`
                        UPDATE library_files SET
                            artist_id=?, album_id=?, media_id=?, file_path=?, relative_path=?,
                            library_root=?, filename=?, extension=?, file_size=?, duration=?,
                            file_type=?, quality=?, needs_rename=?, naming_template=?,
                            expected_path=?, original_filename=?,
                            fingerprint = COALESCE(?, fingerprint),
                            modified_at=?, verified_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(
                        c.artistId, c.albumId, c.tidalId, c.file.file_path, c.relativePath,
                        c.libraryRootKey, c.file.filename, c.extension, c.stats.size,
                        c.trackData.duration || 0, c.fileType, c.quality, c.needsRename,
                        c.fullPathTemplate, c.expectedPath, c.file.filename,
                        c.fingerprint, c.stats.mtime.toISOString(),
                        existingLibraryFile.id,
                    );
                    db.prepare(`DELETE FROM library_files WHERE media_id = ? AND file_type = ? AND id != ?`)
                        .run(c.tidalId, c.fileType, existingLibraryFile.id);
                } else {
                    db.prepare(`
                        INSERT INTO library_files (
                            artist_id, album_id, media_id,
                            file_path, relative_path, library_root,
                            filename, extension, file_size, duration,
                            file_type, quality, needs_rename,
                            naming_template, expected_path,
                            original_filename, fingerprint,
                            modified_at, verified_at
                        ) VALUES (
                            @artistId, @albumId, @mediaId,
                            @filePath, @relativePath, @libraryRoot,
                            @filename, @extension, @fileSize, @duration,
                            @fileType, @quality, @needsRename,
                            @namingTemplate, @expectedPath,
                            @originalFilename, @fingerprint,
                            @modifiedAt, CURRENT_TIMESTAMP
                        )
                        ON CONFLICT(file_path) DO UPDATE SET
                            media_id = excluded.media_id, album_id = excluded.album_id,
                            artist_id = excluded.artist_id, needs_rename = excluded.needs_rename,
                            expected_path = excluded.expected_path, fingerprint = excluded.fingerprint,
                            verified_at = CURRENT_TIMESTAMP
                    `).run({
                        artistId: c.artistId, albumId: c.albumId, mediaId: c.tidalId,
                        filePath: c.file.file_path, relativePath: c.relativePath,
                        libraryRoot: c.libraryRootKey, filename: c.file.filename,
                        extension: c.extension, fileSize: c.stats.size,
                        duration: c.trackData.duration || 0, fileType: c.fileType,
                        quality: c.quality, needsRename: c.needsRename,
                        namingTemplate: c.fullPathTemplate, expectedPath: c.expectedPath,
                        originalFilename: c.file.filename, fingerprint: c.fingerprint,
                        modifiedAt: c.stats.mtime.toISOString(),
                    });
                }

                // Monitor media + remove from unmapped
                db.prepare(`
                    UPDATE media SET monitor = 1, monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP) WHERE id = ?
                `).run(c.tidalId);
                db.prepare("DELETE FROM unmapped_files WHERE id = ?").run(c.id);

                // Track finalization targets (outside transaction, post-commit)
                const libraryFileId = resolveImportedLibraryFileId(c.file.file_path);
                if (libraryFileId !== null) {
                    const oldDir = path.dirname(c.file.file_path);
                    const destDir = path.dirname(c.expectedPath);
                    const targetIds = c.isVideo ? videoInsertedIds : audioInsertedIds;
                    const targetMappings = c.isVideo ? videoDirMappings : audioDirMappings;
                    targetIds.push(libraryFileId);
                    targetMappings.set(oldDir, {
                        destDir,
                        artistId: String(c.artistId),
                        albumId: c.albumId ? String(c.albumId) : null,
                        libraryRootPath: c.rootPath,
                    });
                }

                statusUpdates.push({ albumId: c.albumId, tidalId: c.tidalId });
            }
        })();

        // ── Phase 3: Post-commit cache refresh + finalization ────────────
        for (const su of statusUpdates) {
            try {
                if (su.albumId) {
                    updateAlbumDownloadStatus(su.albumId);
                } else {
                    updateArtistDownloadStatusFromMedia(su.tidalId);
                }
            } catch { /* best-effort */ }
        }

        if (audioInsertedIds.length > 0) {
            await finalizeImportedDirectories({
                importedFileIds: audioInsertedIds,
                dirMappings: audioDirMappings,
                imageFileType: "cover",
            });
        }

        if (videoInsertedIds.length > 0) {
            await finalizeImportedDirectories({
                importedFileIds: videoInsertedIds,
                dirMappings: videoDirMappings,
                imageFileType: "video_thumbnail",
            });
        }
    }
}

export const manualImportApplyService = new ManualImportApplyService();
