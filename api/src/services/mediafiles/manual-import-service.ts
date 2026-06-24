import fs from "fs";
import path from "path";
import {
    updateAlbumDownloadStatus,
    updateArtistDownloadStatusFromMedia,
} from "../download/download-state.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { normalizeResolvedPath } from "./path-utils.js";
import {
    finalizeImportedDirectories,
    resolveImportedLibraryFileId,
    type ImportedDirectoryMapping,
} from "./import-finalize-service.js";

export class ManualImportService {
    async bulkImportUnmapped(items: { id: number, providerId: string }[]): Promise<void> {
        const { db } = await import("../../database.js");
        const { streamingProviderManager } = await import("../providers/index.js");
        const { RefreshAlbumService } = await import("../music/refresh-album-service.js");
        const { Config } = await import("../config/config.js");
        const { getNamingConfig, renderRelativePath, resolveArtistFolderFromRecord } = await import("../config/naming.js");
        const { resolveArtistFolderForPersistence } = await import("../music/artist-paths.js");
        const { calculateFingerprint } = await import("./audioUtils.js");
        const { isSpatialAudioQuality } = await import("../../utils/spatial-audio.js");
        const { resolveLibraryFileIdentity } = await import("./library-file-identity.js");
        const { resolveCanonicalTrackPosition } = await import("../metadata/canonical-track-position.js");
        const { getCanonicalAlbumMetadata } = await import("../metadata/canonical-album-metadata.js");

        const namingConfig = getNamingConfig();
        const provider = streamingProviderManager.getDefaultStreamingProvider();

        // ── Phase 1: Async collection ───────────────────────────────────
        // Fetch all remote metadata, fingerprints, and FS stats before touching the DB.
        interface CollectedItem {
            id: number;
            providerId: string;
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
                const file = db.prepare("SELECT * FROM UnmappedFiles WHERE id = ?").get(item.id) as any;
                if (!file) {
                    console.warn(`[Bulk Import] Unmapped file ID ${item.id} not found.`);
                    continue;
                }

                const extension = String(file.extension || path.extname(file.file_path)).replace(/^\./, "").toLowerCase();
                const isVideo = file.library_root === "videos" || ["mp4", "mkv", "m4v", "mov", "webm", "ts"].includes(extension);

                // Fetch track/video metadata from the active streaming provider.
                let trackData: any;
                if (isVideo) {
                    try {
                        trackData = await provider.getVideo?.(item.providerId);
                    } catch (videoError: any) {
                        console.error(`[Bulk Import] Could not resolve video ${item.providerId} for file ${file.filename}`, videoError);
                        continue;
                    }
                } else {
                    try {
                        trackData = await provider.getTrack(item.providerId);
                    } catch (e: any) {
                        console.warn(`[Bulk Import] getTrack(${item.providerId}) failed: ${e.message}. Trying getAlbumTracks...`);
                        try {
                            const tracks = await provider.getAlbumTracks(item.providerId);

                            let bestTrack = tracks.length > 0 ? tracks[0] : null;
                            const lowerFilename = file.filename.toLowerCase();
                            for (const t of tracks) {
                                if (lowerFilename.includes(t.title.toLowerCase()) ||
                                    lowerFilename.includes(` ${t.trackNumber} `) ||
                                    lowerFilename.startsWith(`${t.trackNumber} -`) ||
                                    lowerFilename.startsWith(`0${t.trackNumber}`)) {
                                    bestTrack = t;
                                    break;
                                }
                            }

                            if (bestTrack) {
                                trackData = await provider.getTrack(bestTrack.providerId);
                                console.log(`[Bulk Import] Resolved album ${item.providerId} to track ${bestTrack.providerId} for file ${file.filename}`);
                            } else {
                                throw new Error("No tracks found in album");
                            }
                        } catch (e2: any) {
                            console.error(`[Bulk Import] Could not resolve album ${item.providerId} for file ${file.filename}`, e2);
                            continue;
                        }
                    }
                }
                if (!trackData) continue;

                const artistId = trackData.artist?.providerId?.toString()
                    || trackData.artist?.id?.toString()
                    || trackData.artist_id?.toString();

                // Fetch artist info if needed (check DB first to avoid redundant API calls)
                let artistInfo: CollectedItem["artistInfo"] = null;
                if (artistId) {
                    const existingArtist = db.prepare("SELECT id FROM Artists WHERE id = ?").get(artistId);
                    if (!existingArtist) {
                        const fallbackName = trackData.artist?.name || trackData.artist_name || "Unknown Artist";
                        try {
                            const remoteArtist = await provider.getArtist(artistId);
                            artistInfo = { name: remoteArtist.name, picture: remoteArtist.picture || null, popularity: remoteArtist.popularity || 0 };
                        } catch {
                            artistInfo = { name: fallbackName, picture: null, popularity: 0 };
                        }
                    }
                }

                // Read artist row for naming (may have been inserted in a prior iteration's commit — read fresh)
                const artistRow = artistId
                    ? db.prepare("SELECT name, mbid, path FROM Artists WHERE id = ?").get(artistId) as any
                    : null;

                // Scan provider album metadata when the imported item belongs to an album.
                const albumId = (trackData.album?.providerId || trackData.album?.id || trackData.album_id)?.toString() || null;
                if (albumId) {
                    try { await RefreshAlbumService.scanShallow(albumId); } catch {
                        console.warn(`[Bulk Import] Could not perform shallow scan for album ${albumId}`);
                    }
                }

                // Read album offer for naming (created by RefreshAlbumService.scanShallow)
                const albumRow = albumId ? db.prepare(`
                    SELECT release_group_mbid AS mb_release_group_id, release_mbid AS mbid,
                           release_date, version, explicit, NULL AS num_volumes
                    FROM ProviderItems
                    WHERE entity_type = 'album' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                    ORDER BY updated_at DESC
                    LIMIT 1
                `).get(albumId) as any : null;

                // Fingerprint + filesystem stats
                let fingerprint: string | null = null;
                try { fingerprint = await calculateFingerprint(file.file_path); } catch { /* best effort */ }

                const stats = fs.statSync(file.file_path);

                // Compute paths and naming
                const storedLibraryRoot = String(file.library_root || "");
                const libraryRootKey = (() => {
                    if (["music", "spatial", "videos"].includes(storedLibraryRoot)) return storedLibraryRoot;
                    const norm = storedLibraryRoot.toLowerCase();
                    const videoPath = Config.getVideoPath().toLowerCase();
                    const spatialPath = Config.getSpatialPath()?.toLowerCase();
                    if (norm === videoPath || norm.includes(`${path.sep}videos`) || norm.includes("/videos")) return "videos";
                    if (spatialPath && norm === spatialPath) return "spatial";
                    return isVideo ? "videos" : "music";
                })();

                const quality = trackData.quality || (isVideo ? "MP4_1080P" : "LOSSLESS");
                const artistFolder = resolveArtistFolderFromRecord({
                    name: artistRow?.name || trackData.artist?.name || trackData.artist_name || "Unknown Artist",
                    mbid: artistRow?.mbid || null,
                    path: artistRow?.path || null,
                });

                const releaseYear = albumRow?.release_date ? String(albumRow.release_date).slice(0, 4) : null;
                const canonicalIdentity = !isVideo && albumId
                    ? resolveLibraryFileIdentity({
                        artistId,
                        albumId,
                        mediaId: item.providerId,
                        fileType: "track",
                        quality,
                        libraryRoot: libraryRootKey,
                    })
                    : null;
                const canonicalAlbum = getCanonicalAlbumMetadata({
                    canonicalReleaseGroupMbid: canonicalIdentity?.canonicalReleaseGroupMbid || albumRow?.mb_release_group_id,
                    canonicalReleaseMbid: canonicalIdentity?.canonicalReleaseMbid || albumRow?.mbid,
                });
                const canonicalPosition = !isVideo && albumId
                    ? resolveCanonicalTrackPosition({
                        artistId,
                        albumId,
                        mediaId: item.providerId,
                        fileType: "track",
                        quality,
                        libraryRoot: libraryRootKey,
                    })
                    : null;
                const canonicalReleaseYear = String(canonicalAlbum?.releaseDate || releaseYear || "").slice(0, 4) || null;
                const isMultiDisc = Number(canonicalAlbum?.volumeCount || albumRow?.num_volumes || 1) > 1;
                const trackTemplate = isMultiDisc ? namingConfig.album_track_path_multi : namingConfig.album_track_path_single;
                const fullPathTemplate = isVideo ? path.join(artistFolder, namingConfig.video_file) : path.join(artistFolder, trackTemplate);

                const expectedRelPath = renderRelativePath(fullPathTemplate, {
                    artistName: artistRow?.name || trackData.artist?.name || trackData.artist_name || "Unknown Artist",
                    artistMbId: artistRow?.mbid || null,
                    albumTitle: canonicalAlbum?.title || trackData.album?.title || trackData.album_title || "Unknown Album",
                    albumVersion: canonicalAlbum ? null : albumRow?.version,
                    releaseYear: canonicalReleaseYear,
                    trackTitle: canonicalPosition?.title || trackData.title,
                    trackNumber: canonicalPosition?.trackNumber ?? trackData.trackNumber ?? trackData.track_num ?? 1,
                    volumeNumber: canonicalPosition?.volumeNumber ?? trackData.volumeNumber ?? trackData.volume_num ?? 1,
                    explicit: Boolean(albumRow?.explicit),
                    videoTitle: trackData.title
                }) + "." + extension;

                let rootPath = Config.getMusicPath();
                if (libraryRootKey === "videos") rootPath = Config.getVideoPath();
                else if (isSpatialAudioQuality(quality)) rootPath = Config.getSpatialPath();

                const expectedPath = path.join(rootPath, expectedRelPath);
                const relativePath = path.relative(rootPath, file.file_path);
                const needsRename = relativePath.split(path.sep).join("/") !== expectedRelPath.split(path.sep).join("/") ? 1 : 0;

                collected.push({
                    id: item.id,
                    providerId: item.providerId,
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
                console.error(`[Bulk Import] Failed collecting metadata for file ${item.id} → TIDAL ${item.providerId}:`, outerError);
            }
        }

        if (collected.length === 0) return;

        // ── Phase 2: Single-transaction DB commit ───────────────────────
        // All reads for control-flow decisions and all writes happen in one transaction.
        const audioInsertedIds: number[] = [];
        const audioDirMappings = new Map<string, ImportedDirectoryMapping>();
        const videoInsertedIds: number[] = [];
        const videoDirMappings = new Map<string, ImportedDirectoryMapping>();
        const statusUpdates: Array<{ albumId: string | null; providerId: string }> = [];

        // Pre-pass (outside the transaction — RefreshVideoService opens its own):
        // ensure each video's canonical Recordings(is_video=1) + ProviderItems offer
        // so the in-transaction Recordings.monitored flip below has a row to hit.
        const videoEntries = collected.filter((c) => c.isVideo);
        if (videoEntries.length > 0) {
            const { RefreshVideoService } = await import("../music/refresh-video-service.js");
            for (const c of videoEntries) {
                RefreshVideoService.upsertArtistVideos(String(c.artistId), [{
                    ...c.trackData,
                    provider_id: c.providerId,
                    album_id: c.albumId || null,
                    title: c.trackData.title || "Unknown Video",
                    quality: c.trackData.quality || "MP4_1080P",
                    provider: provider.id,
                }]);
            }
        }

        db.transaction(() => {
            for (const c of collected) {
                // Ensure artist exists
                if (c.artistId && c.artistInfo) {
                    db.prepare(`
                        INSERT OR IGNORE INTO artists (id, name, picture, popularity, monitored, path)
                        VALUES (?, ?, ?, ?, 0, ?)
                    `).run(
                        c.artistId,
                        c.artistInfo.name,
                        c.artistInfo.picture,
                        c.artistInfo.popularity,
                        resolveArtistFolderForPersistence({
                            artistId: c.artistId,
                            artistName: c.artistInfo.name,
                        })
                    );
                }

                // Album monitoring is canonical: the slot + Albums row carry it.
                // (AlbumArtists is canonical/Servarr Metadata Server; the legacy provider relation
                // write is dropped.) The video canonical graph is ensured in a
                // pre-pass before this transaction (RefreshVideoService); here we
                // only flip the canonical monitored flags.
                if (c.albumId) {
                    const rgMbid = db.prepare(`
                        SELECT release_group_mbid FROM ProviderItems
                        WHERE entity_type = 'album' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                        ORDER BY updated_at DESC LIMIT 1
                    `).get(c.albumId) as { release_group_mbid?: string | null } | undefined;
                    if (rgMbid?.release_group_mbid) {
                        db.prepare(`
                            UPDATE ReleaseGroupSlots SET monitored = 1, updated_at = CURRENT_TIMESTAMP
                            WHERE release_group_mbid = ? AND monitored_lock = 0
                        `).run(rgMbid.release_group_mbid);
                        db.prepare(`
                            UPDATE Albums SET monitored = 1, updated_at = CURRENT_TIMESTAMP WHERE mbid = ?
                        `).run(rgMbid.release_group_mbid);
                    }
                }

                if (c.isVideo) {
                    db.prepare(`
                        UPDATE Recordings
                        SET monitored = 1,
                            monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = (
                            SELECT recording_id FROM ProviderItems
                            WHERE entity_type = 'video' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                              AND recording_id IS NOT NULL
                            LIMIT 1
                        )
                    `).run(c.providerId);
                }

                // Check for existing library file
                const existingLibraryFile = db.prepare(`
                    SELECT id, file_path, relative_path, library_root FROM TrackFiles
                    WHERE provider = ?
                      AND provider_entity_type = ?
                      AND provider_id = ?
                      AND file_type = ?
                      AND library_slot = ?
                    ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
                    LIMIT 1
                `).get(provider.id, c.fileType, c.providerId, c.fileType, c.libraryRootKey === "spatial" ? "spatial" : c.isVideo ? "video" : "stereo", c.file.file_path) as {
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
                        UPDATE UnmappedFiles SET reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
                    `).run("Duplicate of an existing imported library file", c.id);
                    console.warn(`[Bulk Import] Skipping duplicate: ${c.file.file_path} for media ${c.providerId}`);
                    continue;
                }

                if (existingLibraryFile && sameTrackedPath) {
                    db.prepare(`
                        UPDATE TrackFiles SET
                            artist_id=?,
                            provider=?, provider_entity_type=?, provider_id=?, library_slot=?,
                            file_path=?, relative_path=?,
                            library_root=?, filename=?, extension=?, file_size=?, duration=?,
                            file_type=?, quality=?, needs_rename=?, naming_template=?,
                            expected_path=?, original_filename=?,
                            fingerprint = COALESCE(?, fingerprint),
                            modified_at=?, verified_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(
                        c.artistId,
                        provider.id, c.fileType, c.providerId, c.libraryRootKey === "spatial" ? "spatial" : c.isVideo ? "video" : "stereo",
                        c.file.file_path, c.relativePath,
                        c.libraryRootKey, c.file.filename, c.extension, c.stats.size,
                        c.trackData.duration || 0, c.fileType, c.quality, c.needsRename,
                        c.fullPathTemplate, c.expectedPath, c.file.filename,
                        c.fingerprint, c.stats.mtime.toISOString(),
                        existingLibraryFile.id,
                    );
                    db.prepare(`
                        DELETE FROM TrackFiles
                        WHERE provider = ?
                          AND provider_entity_type = ?
                          AND provider_id = ?
                          AND file_type = ?
                          AND library_slot = ?
                          AND id != ?
                    `).run(provider.id, c.fileType, c.providerId, c.fileType, c.libraryRootKey === "spatial" ? "spatial" : c.isVideo ? "video" : "stereo", existingLibraryFile.id);
                } else {
                    db.prepare(`
                        INSERT INTO TrackFiles (
                            artist_id,
                            provider, provider_entity_type, provider_id, library_slot,
                            file_path, relative_path, library_root,
                            filename, extension, file_size, duration,
                            file_type, quality, needs_rename,
                            naming_template, expected_path,
                            original_filename, fingerprint,
                            modified_at, verified_at
                        ) VALUES (
                            @artistId,
                            @provider, @providerEntityType, @providerIdValue, @librarySlot,
                            @filePath, @relativePath, @libraryRoot,
                            @filename, @extension, @fileSize, @duration,
                            @fileType, @quality, @needsRename,
                            @namingTemplate, @expectedPath,
                            @originalFilename, @fingerprint,
                            @modifiedAt, CURRENT_TIMESTAMP
                        )
                        ON CONFLICT(file_path) DO UPDATE SET
                            provider = COALESCE(excluded.provider, provider),
                            provider_entity_type = COALESCE(excluded.provider_entity_type, provider_entity_type),
                            provider_id = COALESCE(excluded.provider_id, provider_id),
                            library_slot = COALESCE(excluded.library_slot, library_slot),
                            artist_id = excluded.artist_id, needs_rename = excluded.needs_rename,
                            expected_path = excluded.expected_path, fingerprint = excluded.fingerprint,
                            verified_at = CURRENT_TIMESTAMP
                    `).run({
                        artistId: c.artistId, albumId: c.albumId, mediaId: c.providerId,
                        provider: provider.id, providerEntityType: c.fileType, providerIdValue: c.providerId,
                        librarySlot: c.libraryRootKey === "spatial" ? "spatial" : c.isVideo ? "video" : "stereo",
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

                // Monitoring is canonical now (slot for albums, Recordings for
                // videos — both set above); just remove from unmapped.
                db.prepare("DELETE FROM UnmappedFiles WHERE id = ?").run(c.id);

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

                statusUpdates.push({ albumId: c.albumId, providerId: c.providerId });
            }
        })();

        // ── Phase 3: Post-commit cache refresh + finalization ────────────
        for (const su of statusUpdates) {
            try {
                if (su.albumId) {
                    updateAlbumDownloadStatus(su.albumId);
                } else {
                    updateArtistDownloadStatusFromMedia(su.providerId);
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

export const manualImportService = new ManualImportService();
