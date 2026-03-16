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
        const { getNamingConfig, renderRelativePath } = await import("./naming.js");
        const { calculateFingerprint } = await import("./audioUtils.js");

        const namingConfig = getNamingConfig();

        const audioInsertedIds: number[] = [];
        const audioDirMappings = new Map<string, ImportedDirectoryMapping>();
        const videoInsertedIds: number[] = [];
        const videoDirMappings = new Map<string, ImportedDirectoryMapping>();

        for (const item of items) {
            try {
                const file = db.prepare("SELECT * FROM unmapped_files WHERE id = ?").get(item.id) as any;
                if (!file) {
                    console.warn(`[Bulk Import] Unmapped file ID ${item.id} not found.`);
                    continue;
                }

                const extension = String(file.extension || path.extname(file.file_path)).replace(/^\./, "").toLowerCase();
                const isVideo = file.library_root === "music_videos" || ["mp4", "mkv", "m4v", "mov", "webm", "ts"].includes(extension);

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
                            console.log(`[Bulk Import] getAlbumTracks returned ${tracks.length} tracks`);

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
                if (artistId) {
                    const existingArtist = db.prepare("SELECT id FROM artists WHERE id = ?").get(artistId);
                    if (!existingArtist) {
                        try {
                            const remoteArtist = await getArtist(artistId);
                            db.prepare(`
                                INSERT OR IGNORE INTO artists (id, name, picture, popularity, monitor)
                                VALUES (?, ?, ?, ?, 0)
                            `).run(artistId, remoteArtist.name, remoteArtist.picture || null, remoteArtist.popularity || 0);
                        } catch (e) {
                            db.prepare("INSERT OR IGNORE INTO artists (id, name, monitor) VALUES (?, ?, 0)")
                                .run(artistId, trackData.artist?.name || trackData.artist_name || "Unknown Artist");
                        }
                    }
                }

                const albumId = trackData.album?.id || trackData.album_id;
                if (albumId) {
                    try {
                        await scanAlbumShallow(albumId.toString());
                    } catch (e) {
                        console.warn(`[Bulk Import] Could not perform shallow scan for album ${albumId}`);
                    }
                    db.prepare(`
                        UPDATE albums
                        SET monitor = 1,
                            monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
                        WHERE id = ? AND monitor_lock = 0
                    `).run(albumId);
                    db.prepare(`
                        INSERT OR IGNORE INTO album_artists (album_id, artist_id, type, group_type, module)
                        VALUES (?, ?, 'MAIN', 'ALBUMS', NULL)
                    `).run(albumId, artistId);
                }

                const albumRow = albumId ? db.prepare("SELECT * FROM albums WHERE id = ?").get(albumId) as any : null;

                if (isVideo) {
                    db.prepare(`
                        INSERT INTO media (
                            id, artist_id, album_id, title, version, release_date, type,
                            explicit, quality, duration, popularity, cover,
                            monitor
                        ) VALUES (?, ?, ?, ?, ?, ?, 'Music Video', ?, ?, ?, ?, ?, 1)
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
                            monitor = CASE WHEN monitor_lock = 0 OR monitor_lock IS NULL THEN 1 ELSE monitor END
                    `).run(
                        item.tidalId,
                        artistId,
                        albumId || null,
                        trackData.title || "Unknown Video",
                        trackData.version || null,
                        trackData.release_date || null,
                        trackData.explicit ? 1 : 0,
                        trackData.quality || "MP4_1080P",
                        trackData.duration || 0,
                        trackData.popularity || 0,
                        trackData.image_id || null,
                    );
                }

                let fingerprint = null;
                try {
                    fingerprint = await calculateFingerprint(file.file_path);
                } catch (e) {
                    // Best effort only.
                }

                const stats = fs.statSync(file.file_path);
                const ext = extension;

                const storedLibraryRoot = String(file.library_root || "");
                const normalizedLibraryRoot = (() => {
                    if (storedLibraryRoot === "music" || storedLibraryRoot === "spatial_music" || storedLibraryRoot === "music_videos") {
                        return storedLibraryRoot;
                    }

                    const normalizedStored = storedLibraryRoot.toLowerCase();
                    const videoPath = Config.getVideoPath().toLowerCase();
                    const atmosPath = Config.getAtmosPath()?.toLowerCase();

                    if (normalizedStored === videoPath || normalizedStored.includes(`${path.sep}videos`) || normalizedStored.includes("/videos")) {
                        return "music_videos";
                    }

                    if (atmosPath && normalizedStored === atmosPath) {
                        return "spatial_music";
                    }

                    return isVideo ? "music_videos" : "music";
                })();
                const libraryRootKey = normalizedLibraryRoot;
                const quality = trackData.quality || (isVideo ? "MP4_1080P" : "LOSSLESS");

                const releaseYear = albumRow?.release_date ? String(albumRow.release_date).slice(0, 4) : null;
                const isMultiDisc = Number(albumRow?.num_volumes || 1) > 1;
                const trackTemplate = isMultiDisc ? namingConfig.album_track_path_multi : namingConfig.album_track_path_single;
                const fullPathTemplate = isVideo ? path.join(namingConfig.artist_folder, namingConfig.video_file) : path.join(namingConfig.artist_folder, trackTemplate);

                const expectedRelPath = renderRelativePath(fullPathTemplate, {
                    artistName: trackData.artist?.name || trackData.artist_name || "Unknown Artist",
                    albumTitle: trackData.album?.title || trackData.album_title || "Unknown Album",
                    albumVersion: albumRow?.version,
                    releaseYear,
                    trackTitle: trackData.title,
                    trackNumber: trackData.trackNumber || trackData.track_num || 1,
                    volumeNumber: trackData.volumeNumber || trackData.volume_num || 1,
                    explicit: Boolean(albumRow?.explicit),
                    videoTitle: trackData.title
                }) + "." + (ext.replace(".", ""));

                let rootPath = Config.getMusicPath();
                if (libraryRootKey === "music_videos") rootPath = Config.getVideoPath();
                else if (quality === "DOLBY_ATMOS") rootPath = Config.getAtmosPath();

                const expectedPath = path.join(rootPath, expectedRelPath);
                const relativePath = path.relative(rootPath, file.file_path);

                const normalizedActual = relativePath.split(path.sep).join("/");
                const normalizedExpected = expectedRelPath.split(path.sep).join("/");
                const needsRename = normalizedActual !== normalizedExpected ? 1 : 0;

                const fileType = isVideo ? "video" : "track";
                const existingLibraryFile = db.prepare(`
                    SELECT id, file_path, relative_path, library_root
                    FROM library_files
                    WHERE media_id = ? AND file_type = ?
                    ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
                    LIMIT 1
                `).get(item.tidalId, fileType, file.file_path) as {
                    id: number;
                    file_path: string;
                    relative_path: string | null;
                    library_root: string | null;
                } | undefined;

                const existingLibraryFilePath = existingLibraryFile
                    ? resolveStoredLibraryPath({
                        filePath: existingLibraryFile.file_path,
                        libraryRoot: existingLibraryFile.library_root,
                        relativePath: existingLibraryFile.relative_path,
                    })
                    : null;
                const sameTrackedPath = existingLibraryFilePath
                    ? normalizeResolvedPath(existingLibraryFilePath) === normalizeResolvedPath(file.file_path)
                    : false;
                const existingTrackedFilePresent = existingLibraryFilePath ? fs.existsSync(existingLibraryFilePath) : false;

                if (existingLibraryFile && existingTrackedFilePresent && !sameTrackedPath) {
                    db.prepare(`
                        UPDATE unmapped_files
                        SET reason = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run("Duplicate of an existing imported library file", item.id);
                    console.warn(
                        `[Bulk Import] Skipping duplicate mapped file ${file.file_path} for media ${item.tidalId}; existing file ${existingLibraryFilePath} is already tracked.`
                    );
                    continue;
                }

                if (existingLibraryFile && sameTrackedPath) {
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
                            duration = ?,
                            file_type = ?,
                            quality = ?,
                            needs_rename = ?,
                            naming_template = ?,
                            expected_path = ?,
                            original_filename = ?,
                            fingerprint = COALESCE(?, fingerprint),
                            modified_at = ?,
                            verified_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(
                        artistId,
                        albumId,
                        item.tidalId,
                        file.file_path,
                        relativePath,
                        libraryRootKey,
                        file.filename,
                        ext.replace(".", ""),
                        stats.size,
                        trackData.duration || 0,
                        fileType,
                        quality,
                        needsRename,
                        fullPathTemplate,
                        expectedPath,
                        file.filename,
                        fingerprint || null,
                        stats.mtime.toISOString(),
                        existingLibraryFile.id,
                    );
                    db.prepare(`
                        DELETE FROM library_files
                        WHERE media_id = ? AND file_type = ? AND id != ?
                    `).run(item.tidalId, fileType, existingLibraryFile.id);
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
                            media_id = excluded.media_id,
                            album_id = excluded.album_id,
                            artist_id = excluded.artist_id,
                            needs_rename = excluded.needs_rename,
                            expected_path = excluded.expected_path,
                            fingerprint = excluded.fingerprint,
                            verified_at = CURRENT_TIMESTAMP
                    `).run({
                        artistId,
                        albumId,
                        mediaId: item.tidalId,
                        filePath: file.file_path,
                        relativePath: relativePath,
                        libraryRoot: libraryRootKey,
                        filename: file.filename,
                        extension: ext.replace(".", ""),
                        fileSize: stats.size,
                        duration: trackData.duration || 0,
                        fileType,
                        quality,
                        needsRename,
                        namingTemplate: fullPathTemplate,
                        expectedPath,
                        originalFilename: file.filename,
                        fingerprint: fingerprint || null,
                        modifiedAt: stats.mtime.toISOString()
                    });
                }

                const libraryFileId = resolveImportedLibraryFileId(file.file_path);
                if (libraryFileId !== null) {
                    const oldDir = path.dirname(file.file_path);
                    const destDir = path.dirname(expectedPath);
                    const targetIds = isVideo ? videoInsertedIds : audioInsertedIds;
                    const targetMappings = isVideo ? videoDirMappings : audioDirMappings;

                    targetIds.push(libraryFileId);
                    targetMappings.set(oldDir, {
                        destDir,
                        artistId: String(artistId),
                        albumId: albumId ? String(albumId) : null,
                        libraryRootPath: rootPath,
                    });
                }

                db.prepare(`
                    UPDATE media
                    SET monitor = 1,
                        monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
                    WHERE id = ?
                `)
                    .run(item.tidalId);

                if (albumId) {
                    try {
                        updateAlbumDownloadStatus(String(albumId));
                    } catch {
                        // Best-effort status refresh only; the import itself already succeeded.
                    }
                } else {
                    updateArtistDownloadStatusFromMedia(String(item.tidalId));
                }

                db.prepare("DELETE FROM unmapped_files WHERE id = ?").run(item.id);
            } catch (innerError: any) {
                console.error(`[Bulk Import] Failed strictly mapping file ${item.id} to TIDAL ${item.tidalId}:`, innerError);
            }
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
