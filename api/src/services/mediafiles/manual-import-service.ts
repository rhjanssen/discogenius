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
import type { MetadataConfig } from "../config/config.js";
import { resolveVideoTypeSuffix } from "./library-files.js";

// Manually-imported files are a user's own pre-existing library files, not a
// fresh Discogenius download ("not a new download" case) — only
// tag them when the policy explicitly asks for ALL files, not just new ones.
export function shouldTagManuallyImportedFiles(config: MetadataConfig): boolean {
    return config.write_audio_tags_policy === "all_files";
}

export interface ManualImportSummary {
    requested: number;
    imported: number;
    duplicates: number;
    skipped: number;
    /**
     * Authoritative operation result: requested item id -> the TrackFiles row it
     * created. Callers attach canonical/provider authority to exactly this row
     * instead of rediscovering it by canonical mbid.
     *
     * REQUIRED, and exhaustive for `imported`: there is exactly one entry per
     * imported file, every key is one of the submitted item ids, and the entry
     * count equals `imported`. A summary that claims an import it cannot identify
     * is a bug, not a degraded result, so the importer throws instead of
     * returning one.
     */
    importedFileIds: Record<string, number>;
}

export class ManualImportService {
    async bulkImportUnmapped(
        items: { id: number, providerId: string }[],
        options?: { libraryRootPath?: string },
    ): Promise<ManualImportSummary> {
        const { db } = await import("../../database.js");
        const { streamingProviderManager } = await import("../providers/index.js");
        const { RefreshAlbumService } = await import("../music/refresh-album-service.js");
        const { Config } = await import("../config/config.js");
        const { getNamingConfig, renderRelativePath, resolveArtistFolderFromRecord } = await import("../config/naming.js");
        const { resolveArtistFolderForPersistence } = await import("../music/artist-paths.js");
        const { calculateFingerprint, parseAudioFile, deriveQuality, deriveVideoQuality } = await import("./audioUtils.js");
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
            /** Derived from probedMetrics — the file's own quality, not the provider's. */
            quality: string | null;
            probedMetrics: Awaited<ReturnType<typeof parseAudioFile>>;
            rootPath: string;
            expectedPath: string;
            relativePath: string;
            expectedRelPath: string;
            needsRename: number;
            fileType: "video" | "track";
            fullPathTemplate: string;
            artistFolder: string;
            canonicalTrackMbid: string | null;
            canonicalReleaseGroupMbid: string | null;
            canonicalArtistMbid: string | null;
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

                // Fetch track/video metadata from local catalog DB or active streaming provider.
                let trackData: any;
                const cleanMbid = item.providerId.replace(/^mbid-/, "");
                const isMbid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanMbid);

                if (!isVideo && isMbid) {
                    // 1. Try single track match in catalog DB
                    const dbTrack = db.prepare(`
                        SELECT
                            t.mbid AS id,
                            t.mbid AS providerId,
                            t.title,
                            t.position AS trackNumber,
                            t.medium_position AS volumeNumber,
                            COALESCE(r.length_ms, t.length_ms, 0) AS duration,
                            rel.release_group_mbid,
                            rel.mbid AS albumMbid,
                            rg.title AS albumTitle,
                            a.mbid AS artistMbid,
                            a.name AS artistName
                        FROM Tracks t
                        JOIN AlbumReleases rel ON rel.mbid = t.release_mbid
                        JOIN Albums rg ON rg.mbid = rel.release_group_mbid
                        JOIN Artists a ON a.mbid = rg.artist_mbid
                        LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
                        WHERE t.mbid = ?
                    `).get(cleanMbid) as any;

                    if (dbTrack) {
                        trackData = {
                            id: dbTrack.id,
                            providerId: dbTrack.providerId,
                            title: dbTrack.title,
                            duration: dbTrack.duration,
                            trackNumber: dbTrack.trackNumber,
                            volumeNumber: dbTrack.volumeNumber,
                            artist: { id: dbTrack.artistMbid, providerId: dbTrack.artistMbid, name: dbTrack.artistName },
                            album: { id: dbTrack.release_group_mbid, providerId: dbTrack.release_group_mbid, title: dbTrack.albumTitle },
                        };
                    } else {
                        // 2. Try release group or release MBID match
                        const dbTracks = db.prepare(`
                            SELECT
                                t.mbid AS id,
                                t.mbid AS providerId,
                                t.title,
                                t.position AS trackNumber,
                                t.medium_position AS volumeNumber,
                                COALESCE(r.length_ms, t.length_ms, 0) AS duration,
                                rel.release_group_mbid,
                                rel.mbid AS albumMbid,
                                rg.title AS albumTitle,
                                a.mbid AS artistMbid,
                                a.name AS artistName
                            FROM Tracks t
                            JOIN AlbumReleases rel ON rel.mbid = t.release_mbid
                            JOIN Albums rg ON rg.mbid = rel.release_group_mbid
                            JOIN Artists a ON a.mbid = rg.artist_mbid
                            LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
                            WHERE rel.release_group_mbid = ? OR rel.mbid = ?
                            ORDER BY t.medium_position ASC, t.position ASC
                        `).all(cleanMbid, cleanMbid) as any[];

                        if (dbTracks.length > 0) {
                            let best = dbTracks[0];
                            const lowerFilename = file.filename.toLowerCase();
                            for (const t of dbTracks) {
                                if (lowerFilename.includes(t.title.toLowerCase()) ||
                                    lowerFilename.includes(` ${t.trackNumber} `) ||
                                    lowerFilename.startsWith(`${t.trackNumber} -`) ||
                                    lowerFilename.startsWith(`0${t.trackNumber}`)) {
                                    best = t;
                                    break;
                                }
                            }
                            trackData = {
                                id: best.id,
                                providerId: best.providerId,
                                title: best.title,
                                duration: best.duration,
                                trackNumber: best.trackNumber,
                                volumeNumber: best.volumeNumber,
                                artist: { id: best.artistMbid, providerId: best.artistMbid, name: best.artistName },
                                album: { id: best.release_group_mbid, providerId: best.release_group_mbid, title: best.albumTitle },
                            };
                        }
                    }
                }

                if (!trackData) {
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

                // Refresh provider album metadata when the imported item belongs to
                // a *provider* album. Catalog (MBID) imports already have their
                // metadata locally, so we never make a provider round-trip for them.
                const albumId = (trackData.album?.providerId || trackData.album?.id || trackData.album_id)?.toString() || null;
                const albumIsMbid = !!albumId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(albumId.replace(/^mbid-/, ""));
                if (albumId && !albumIsMbid) {
                    try { await RefreshAlbumService.refreshMetadata(albumId); } catch {
                        console.warn(`[Bulk Import] Could not refresh album metadata for album ${albumId}`);
                    }
                }

                // Read album offer for naming (created by RefreshAlbumService.refreshMetadata)
                // Optional provider provenance for naming. Canonical identity comes
                // from the selected Release/Track; this only fills provider-native
                // extras, and stays null for a manual import with no provider item.
                const albumRow = albumId ? db.prepare(`
                    SELECT release_group.mbid AS mb_release_group_id,
                           canonical_release.mbid AS mbid,
                           COALESCE(canonical_release.date, pi.release_date) AS release_date,
                           pi.version,
                           pi.explicit,
                           canonical_release.media_count AS num_volumes
                    FROM ProviderItems pi
                    LEFT JOIN ProviderEditionMatches release_match
                      ON release_match.provider_edition_item_id = pi.id
                     AND release_match.match_state = 'accepted'
                    LEFT JOIN AlbumReleases canonical_release ON canonical_release.id = release_match.release_id
                    LEFT JOIN Albums release_group ON release_group.id = canonical_release.release_group_id
                    WHERE pi.entity_type = 'release'
                      AND pi.provider = ?
                      AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
                    ORDER BY pi.updated_at DESC
                    LIMIT 1
                `).get(provider.id, albumId) as any : null;

                // Fingerprint + filesystem stats
                let fingerprint: string | null = null;
                try { fingerprint = await calculateFingerprint(file.file_path); } catch { /* best effort */ }

                const stats = fs.statSync(file.file_path);

                // A manually imported file is the user's OWN existing file, so its
                // quality is a property of the bytes on disk. Probe them. The
                // provider's `quality` describes what the provider could serve —
                // source capability / provenance — and defaulting an unclassified
                // file to LOSSLESS made a 128kbit MP3 claim lossless, which then
                // suppressed every future upgrade for it.
                const probedMetrics = await parseAudioFile(file.file_path);

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

                const quality = isVideo
                    ? deriveVideoQuality(probedMetrics)
                    : deriveQuality(extension, probedMetrics);
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

                const videoVariant = isVideo
                    ? (db.prepare(`
                        SELECT recording.video_variant AS video_variant, recording.title AS recording_title
                        FROM ProviderItems pi
                        LEFT JOIN ProviderVideoMatches video_match
                          ON video_match.provider_video_item_id = pi.id
                         AND video_match.match_state = 'accepted'
                        LEFT JOIN Recordings recording ON recording.id = video_match.recording_id
                        WHERE pi.entity_type = 'video'
                          AND pi.provider = ?
                          AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
                        ORDER BY pi.updated_at DESC
                        LIMIT 1
                      `).get(provider.id, item.providerId) as { video_variant?: string | null; recording_title?: string | null } | undefined)
                    : undefined;
                const videoTitle = videoVariant?.recording_title || trackData.title;

                const expectedRelPath = renderRelativePath(fullPathTemplate, {
                    artistName: artistRow?.name || trackData.artist?.name || trackData.artist_name || "Unknown Artist",
                    artistMbId: artistRow?.mbid || null,
                    albumTitle: canonicalAlbum?.title || trackData.album?.title || trackData.album_title || "Unknown Album",
                    releaseYear: canonicalReleaseYear,
                    trackTitle: canonicalPosition?.title || trackData.title,
                    trackNumber: canonicalPosition?.trackNumber ?? trackData.trackNumber ?? trackData.track_num ?? 1,
                    volumeNumber: canonicalPosition?.volumeNumber ?? trackData.volumeNumber ?? trackData.volume_num ?? 1,
                    explicit: Boolean(albumRow?.explicit),
                    videoTitle,
                    videoType: isVideo
                        ? resolveVideoTypeSuffix(videoTitle, videoVariant?.video_variant)
                        : undefined,
                }) + "." + extension;

                let rootPath = options?.libraryRootPath || Config.getMusicPath();
                if (!options?.libraryRootPath && libraryRootKey === "videos") rootPath = Config.getVideoPath();
                else if (!options?.libraryRootPath && isSpatialAudioQuality(quality)) rootPath = Config.getSpatialPath();

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
                    probedMetrics,
                    rootPath,
                    expectedPath,
                    relativePath,
                    expectedRelPath,
                    needsRename,
                    fileType: isVideo ? "video" : "track",
                    fullPathTemplate,
                    artistFolder,
                    canonicalTrackMbid: canonicalIdentity?.canonicalTrackMbid || (trackData.id ? String(trackData.id).replace(/^mbid-/, "") : null),
                    canonicalReleaseGroupMbid: canonicalIdentity?.canonicalReleaseGroupMbid || albumRow?.mb_release_group_id || (trackData.album?.id ? String(trackData.album.id).replace(/^mbid-/, "") : null),
                    canonicalArtistMbid: canonicalIdentity?.canonicalArtistMbid || artistRow?.mbid || (trackData.artist?.id ? String(trackData.artist.id).replace(/^mbid-/, "") : null),
                });
            } catch (outerError: any) {
                console.error(`[Bulk Import] Failed collecting metadata for file ${item.id} → TIDAL ${item.providerId}:`, outerError);
            }
        }

        if (collected.length === 0) {
            return { requested: items.length, imported: 0, duplicates: 0, skipped: items.length, importedFileIds: {} };
        }

        let duplicateCount = 0;

        // ── Phase 2: Single-transaction DB commit ───────────────────────
        // All reads for control-flow decisions and all writes happen in one transaction.
        const audioInsertedIds: number[] = [];
        const audioDirMappings = new Map<string, ImportedDirectoryMapping>();
        const videoInsertedIds: number[] = [];
        const videoDirMappings = new Map<string, ImportedDirectoryMapping>();
        const statusUpdates: Array<{ albumId: string | null; providerId: string }> = [];
        // Requested item id -> the TrackFiles row it actually created.
        const importedFileIds: Record<string, number> = {};

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
                    quality: c.trackData.quality || null,
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

                if (c.isVideo) {
                    db.prepare(`
                        UPDATE Recordings
                        SET monitored = 1,
                            monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = (
                            SELECT match.recording_id
                            FROM ProviderItems item
                            JOIN ProviderVideoMatches match
                              ON match.provider_video_item_id = item.id
                             AND match.match_state = 'accepted'
                            WHERE item.entity_type = 'video'
                              AND item.provider = ?
                              AND CAST(item.provider_id AS TEXT) = CAST(? AS TEXT)
                            ORDER BY
                              CASE match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
                              match.confidence DESC,
                              match.id
                            LIMIT 1
                        )
                    `).run(provider.id, c.providerId);
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
                    duplicateCount++;
                    continue;
                }

                if (existingLibraryFile && sameTrackedPath) {
                    db.prepare(`
                        UPDATE TrackFiles SET
                            artist_id=?,
                            canonical_track_mbid=?, canonical_release_group_mbid=?, canonical_artist_mbid=?,
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
                        c.canonicalTrackMbid, c.canonicalReleaseGroupMbid, c.canonicalArtistMbid,
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
                            canonical_track_mbid, canonical_release_group_mbid, canonical_artist_mbid,
                            provider, provider_entity_type, provider_id, library_slot,
                            file_path, relative_path, library_root,
                            filename, extension, file_size, duration,
                            file_type, quality, imported_quality, needs_rename,
                            bitrate, sample_rate, bit_depth, channels, codec,
                            video_codec, width, height,
                            naming_template, expected_path,
                            original_filename, fingerprint,
                            modified_at, verified_at
                        ) VALUES (
                            @artistId,
                            @canonicalTrackMbid, @canonicalReleaseGroupMbid, @canonicalArtistMbid,
                            @provider, @providerEntityType, @providerIdValue, @librarySlot,
                            @filePath, @relativePath, @libraryRoot,
                            @filename, @extension, @fileSize, @duration,
                            @fileType, @quality, @quality, @needsRename,
                            @bitrate, @sampleRate, @bitDepth, @channels, @codec,
                            @videoCodec, @width, @height,
                            @namingTemplate, @expectedPath,
                            @originalFilename, @fingerprint,
                            @modifiedAt, CURRENT_TIMESTAMP
                        )
                        ON CONFLICT(file_path) DO UPDATE SET
                            canonical_track_mbid = COALESCE(excluded.canonical_track_mbid, canonical_track_mbid),
                            canonical_release_group_mbid = COALESCE(excluded.canonical_release_group_mbid, canonical_release_group_mbid),
                            canonical_artist_mbid = COALESCE(excluded.canonical_artist_mbid, canonical_artist_mbid),
                            provider = COALESCE(excluded.provider, provider),
                            provider_entity_type = COALESCE(excluded.provider_entity_type, provider_entity_type),
                            provider_id = COALESCE(excluded.provider_id, provider_id),
                            library_slot = COALESCE(excluded.library_slot, library_slot),
                            artist_id = excluded.artist_id, needs_rename = excluded.needs_rename,
                            expected_path = excluded.expected_path, fingerprint = excluded.fingerprint,
                            -- Probed technical facts describe the bytes on disk, so a
                            -- re-import always refreshes them (and the quality derived
                            -- from them) rather than preserving a stale claim.
                            quality = excluded.quality,
                            imported_quality = excluded.imported_quality,
                            duration = COALESCE(excluded.duration, duration),
                            bitrate = excluded.bitrate,
                            sample_rate = excluded.sample_rate,
                            bit_depth = excluded.bit_depth,
                            channels = excluded.channels,
                            codec = excluded.codec,
                            video_codec = excluded.video_codec,
                            width = excluded.width,
                            height = excluded.height,
                            verified_at = CURRENT_TIMESTAMP
                    `).run({
                        artistId: c.artistId, albumId: c.albumId, mediaId: c.providerId,
                        canonicalTrackMbid: c.canonicalTrackMbid,
                        canonicalReleaseGroupMbid: c.canonicalReleaseGroupMbid,
                        canonicalArtistMbid: c.canonicalArtistMbid,
                        provider: provider.id, providerEntityType: c.fileType, providerIdValue: c.providerId,
                        librarySlot: c.libraryRootKey === "spatial" ? "spatial" : c.isVideo ? "video" : "stereo",
                        filePath: c.file.file_path, relativePath: c.relativePath,
                        libraryRoot: c.libraryRootKey, filename: c.file.filename,
                        extension: c.extension, fileSize: c.stats.size,
                        // The probed duration is the file's own; fall back to the
                        // provider's only when the probe could not read one.
                        duration: c.probedMetrics.duration ?? c.trackData.duration ?? 0,
                        fileType: c.fileType,
                        quality: c.quality, needsRename: c.needsRename,
                        bitrate: c.probedMetrics.bitrate ?? null,
                        sampleRate: c.probedMetrics.sampleRate ?? null,
                        bitDepth: c.probedMetrics.bitDepth ?? null,
                        channels: c.probedMetrics.channels ?? null,
                        codec: c.probedMetrics.codec ?? null,
                        videoCodec: c.probedMetrics.videoCodec ?? null,
                        width: c.probedMetrics.width ?? null,
                        height: c.probedMetrics.height ?? null,
                        namingTemplate: c.fullPathTemplate, expectedPath: c.expectedPath,
                        originalFilename: c.file.filename, fingerprint: c.fingerprint,
                        modifiedAt: c.stats.mtime.toISOString(),
                    });
                }

                // Monitoring is canonical now (slot for albums, Recordings for
                // videos — both set above); just remove from unmapped.
                db.prepare("DELETE FROM UnmappedFiles WHERE id = ?").run(c.id);

                // Track finalization targets (outside transaction, post-commit).
                // Fail closed: the TrackFiles row for this path was just written in
                // this transaction, so not finding it means the write and read paths
                // disagree. Counting the item as imported without an operation
                // identity would hand the caller a file it cannot address, so abort
                // the batch rather than report an import we cannot name.
                const libraryFileId = resolveImportedLibraryFileId(c.file.file_path);
                if (libraryFileId === null) {
                    throw new Error(
                        `[Bulk Import] Imported ${c.file.file_path} (item ${c.id}) but no TrackFiles row resolved for it; refusing to report an unidentifiable import`,
                    );
                }
                // Authoritative operation result: exactly which TrackFiles row
                // this requested item produced. Callers must not rediscover it.
                importedFileIds[String(c.id)] = libraryFileId;
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

                statusUpdates.push({ albumId: c.albumId, providerId: c.providerId });
            }
        })();

        // ── Phase 3: Post-commit cache refresh + finalization ────────────
        for (const su of statusUpdates) {
            try {
                if (su.albumId) {
                    updateAlbumDownloadStatus(su.albumId);
                } else {
                    // Scope to the active provider — an unscoped provider_id can
                    // collide with another provider's resource.
                    updateArtistDownloadStatusFromMedia(su.providerId, provider.id);
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

        // ── Phase 4: Tag rules for pre-existing files, if the policy asks
        // for ALL files (not just Discogenius's own downloads). Video is
        // excluded — AudioTagService only handles file_type = 'track' rows.
        if (audioInsertedIds.length > 0) {
            const { getConfigSection } = await import("../config/config.js");
            const metadataConfig = getConfigSection("metadata");
            if (shouldTagManuallyImportedFiles(metadataConfig)) {
                try {
                    const { AudioTagService } = await import("./audio-tag-service.js");
                    await AudioTagService.apply(audioInsertedIds);
                } catch (error) {
                    console.warn("[ManualImport] Failed to apply audio tag rules:", error);
                }
            }
        }

        const imported = statusUpdates.length;

        // The operation result must agree with what the summary claims and with what
        // was actually submitted. Any disagreement means a caller would attach
        // canonical/provider authority to the wrong row (or to nothing), so surface
        // it here rather than let it travel.
        const requestedIds = new Set(items.map((item) => String(item.id)));
        const reportedIds = Object.keys(importedFileIds);
        const unknownKeys = reportedIds.filter((key) => !requestedIds.has(key));
        if (unknownKeys.length > 0) {
            throw new Error(
                `[Bulk Import] importedFileIds reports ${unknownKeys.length} item id(s) that were never submitted: ${unknownKeys.join(", ")}`,
            );
        }
        if (reportedIds.length !== imported) {
            throw new Error(
                `[Bulk Import] importedFileIds has ${reportedIds.length} entr(y/ies) but the summary claims ${imported} imported file(s)`,
            );
        }
        const distinctFileIds = new Set(Object.values(importedFileIds));
        if (distinctFileIds.size !== reportedIds.length) {
            throw new Error(
                `[Bulk Import] importedFileIds maps ${reportedIds.length} item(s) onto only ${distinctFileIds.size} distinct TrackFiles row(s)`,
            );
        }
        for (const [key, fileId] of Object.entries(importedFileIds)) {
            if (!Number.isInteger(fileId) || fileId <= 0) {
                throw new Error(
                    `[Bulk Import] importedFileIds[${key}] is not a valid TrackFiles id: ${String(fileId)}`,
                );
            }
        }

        return {
            requested: items.length,
            imported,
            duplicates: duplicateCount,
            skipped: Math.max(0, items.length - imported - duplicateCount),
            importedFileIds,
        };
    }
}

export const manualImportService = new ManualImportService();
