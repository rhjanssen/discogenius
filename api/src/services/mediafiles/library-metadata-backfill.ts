import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import { Config, getConfigSection } from "../config/config.js";
import { getNamingConfig, renderRelativePath, resolveArtistFolderFromRecord, type NamingContext } from "../config/naming.js";
import {
    downloadAlbumCover,
    downloadAlbumVideoCover,
    downloadArtistPicture,
    downloadVideoThumbnail,
    saveAlbumNfoFile,
    saveArtistNfoFile,
    saveLyricsFile,
    saveVideoNfoFile,
} from "./metadata-files.js";
import { embedVideoThumbnail, writeVideoTags } from "./audioUtils.js";
import { LibraryFilesService } from "./library-files.js";
import { getCanonicalAlbumMetadata } from "../metadata/canonical-album-metadata.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";

function parseProviderData(raw: string | null | undefined): Record<string, any> {
    try {
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
    } catch {
        return {};
    }
}

function firstProviderIdFromSlot(value: string | null | undefined): string | null {
    return String(value || "")
        .split(";")
        .map((id) => id.trim())
        .find(Boolean) || null;
}

export interface MetadataFillResult {
    downloaded: number;
    failed: number;
    skipped: number;
}

class LibraryMetadataBackfillService {
    private _writtenVideoTagFingerprints = new Map<string, string>();

    async fillMissingMetadataFiles(artistId: string): Promise<MetadataFillResult> {
        const metadataConfig = getConfigSection("metadata");
        const naming = getNamingConfig();
        const result: MetadataFillResult = { downloaded: 0, failed: 0, skipped: 0 };

        const artist = db.prepare("SELECT name, mbid, path FROM Artists WHERE id = ?").get(artistId) as any;
        if (!artist) return result;

        const artistFolder = resolveArtistFolderFromRecord({
            name: artist.name,
            mbid: artist.mbid || null,
            path: artist.path || null,
        });

        await this.fillArtistMetadata(artistId, artistFolder, metadataConfig, result);
        await this.fillAlbumMetadata(artistId, artistFolder, metadataConfig, naming, result);
        await this.fillTrackMetadata(artistId, metadataConfig, result);
        await this.fillVideoMetadata(artistId, metadataConfig, result);

        if (result.downloaded > 0 || result.failed > 0) {
            console.log(
                `[LibraryScan] Metadata backfill for artist ${artistId}: ` +
                `${result.downloaded} downloaded, ${result.failed} failed, ${result.skipped} skipped`
            );
        }

        return result;
    }

    async fillMissingMetadataFilesForLibrary(): Promise<MetadataFillResult> {
        const artistRows = db.prepare(`
      SELECT DISTINCT artist_id
      FROM TrackFiles
      WHERE artist_id IS NOT NULL
      ORDER BY artist_id ASC
    `).all() as Array<{ artist_id: number }>;

        const totals: MetadataFillResult = { downloaded: 0, failed: 0, skipped: 0 };

        for (const row of artistRows) {
            const result = await this.fillMissingMetadataFiles(String(row.artist_id));
            totals.downloaded += result.downloaded;
            totals.failed += result.failed;
            totals.skipped += result.skipped;
        }

        return totals;
    }

    private async fillArtistMetadata(
        artistId: string,
        artistFolder: string,
        metadataConfig: any,
        result: MetadataFillResult,
    ) {
        const hasFiles = db.prepare("SELECT 1 FROM TrackFiles WHERE artist_id = ? LIMIT 1").get(artistId);
        if (!hasFiles) return;

        const libraryRoots = Array.from(new Set(
            (db.prepare(`
                SELECT DISTINCT library_root
                FROM TrackFiles
                WHERE artist_id = ?
                  AND file_type IN ('track', 'video')
                  AND library_root IS NOT NULL
            `).all(artistId) as Array<{ library_root: string | null }>).map((row) => String(row.library_root || '').trim()).filter(Boolean),
        ));

        for (const libraryRoot of libraryRoots) {
            const artistDir = path.join(libraryRoot, artistFolder);
            if (!fs.existsSync(artistDir)) {
                continue;
            }

            if (metadataConfig.save_artist_picture) {
                const picName = metadataConfig.artist_picture_name || "folder.jpg";
                const picPath = path.join(artistDir, picName);
                if (!fs.existsSync(picPath)) {
                    try {
                        const rawResolution = metadataConfig.artist_picture_resolution;
                        const parsedResolution = rawResolution === "origin" ? "origin" : Number(rawResolution);
                        const safeRes = parsedResolution === "origin" || Number.isFinite(parsedResolution)
                            ? parsedResolution
                            : 500;
                        await downloadArtistPicture(artistId, safeRes as number | "origin", picPath);
                        if (fs.existsSync(picPath)) {
                            this.upsertLibraryFile({
                                artistId,
                                filePath: picPath,
                                libraryRoot,
                                fileType: "cover",
                                expectedPath: picPath,
                            });
                            result.downloaded++;
                        } else {
                            result.failed++;
                        }
                    } catch {
                        result.failed++;
                    }
                } else {
                    result.skipped++;
                }
            }

            if (metadataConfig.save_nfo) {
                const nfoPath = path.join(artistDir, "artist.nfo");
                try {
                    await saveArtistNfoFile(artistId, nfoPath);
                    this.upsertLibraryFile({
                        artistId,
                        filePath: nfoPath,
                        libraryRoot,
                        fileType: "nfo",
                        expectedPath: nfoPath,
                    });
                    result.downloaded++;
                } catch {
                    result.failed++;
                }
            }
        }
    }

    private async fillAlbumMetadata(
        artistId: string,
        artistFolder: string,
        metadataConfig: any,
        naming: ReturnType<typeof getNamingConfig>,
        result: MetadataFillResult,
    ) {
        // Canonical-first: the set of album slots to backfill is the distinct
        // (release group, library slot) pairs of this artist's tracked audio files.
        const albums = db.prepare(`
      SELECT DISTINCT lf.canonical_release_group_mbid AS canonical_release_group_mbid, lf.library_slot
      FROM TrackFiles lf
      WHERE lf.artist_id = ?
        AND lf.file_type = 'track'
        AND lf.canonical_release_group_mbid IS NOT NULL
    `).all(artistId) as any[];
        const processedAlbumSlots = new Set<string>();

        for (const sourceAlbum of albums) {
            const canonicalReleaseGroupMbid = String(sourceAlbum.canonical_release_group_mbid || "").trim();
            const librarySlot = String(sourceAlbum.library_slot || "stereo");
            const albumSlotKey = `${librarySlot}:${canonicalReleaseGroupMbid || sourceAlbum.id}`;
            if (processedAlbumSlots.has(albumSlotKey)) {
                continue;
            }
            processedAlbumSlots.add(albumSlotKey);

            const selectedSlot = canonicalReleaseGroupMbid
                ? db.prepare(`
                    SELECT selected_provider, selected_provider_id, selected_release_mbid
                    FROM ReleaseGroupSlots
                    WHERE release_group_mbid = ?
                      AND slot = ?
                      AND selected_provider_id IS NOT NULL
                    LIMIT 1
                `).get(canonicalReleaseGroupMbid, librarySlot) as {
                    selected_provider?: string | null;
                    selected_provider_id?: string | null;
                    selected_release_mbid?: string | null;
                } | undefined
                : undefined;
            const selectedProviderAlbumId = firstProviderIdFromSlot(selectedSlot?.selected_provider_id);
            // Album metadata for sidecar generation comes from the canonical graph
            // plus the album's ProviderItems offer (provider asset ids/quality live
            // in ProviderItems.data), not ProviderAlbums.
            const albumProviderItem = selectedProviderAlbumId
                ? db.prepare(`
                    SELECT provider, provider_id, release_mbid, quality, data
                    FROM ProviderItems
                    WHERE entity_type = 'album' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                    ORDER BY updated_at DESC
                    LIMIT 1
                `).get(selectedProviderAlbumId) as {
                    provider?: string | null;
                    provider_id?: string | null;
                    release_mbid?: string | null;
                    quality?: string | null;
                    data?: string | null;
                } | undefined
                : db.prepare(`
                    SELECT provider, provider_id, release_mbid, quality, data
                    FROM ProviderItems
                    WHERE entity_type = 'album'
                      AND release_group_mbid = ?
                      AND library_slot = ?
                    ORDER BY updated_at DESC
                    LIMIT 1
                `).get(canonicalReleaseGroupMbid, librarySlot) as {
                    provider?: string | null;
                    provider_id?: string | null;
                    release_mbid?: string | null;
                    quality?: string | null;
                    data?: string | null;
                } | undefined;
            const representativeAlbumId = String(albumProviderItem?.provider_id || selectedProviderAlbumId || "").trim() || null;
            const canonicalReleaseMbid = selectedSlot?.selected_release_mbid || albumProviderItem?.release_mbid || null;
            const canonicalAlbum = getCanonicalAlbumMetadata({
                canonicalReleaseGroupMbid,
                canonicalReleaseMbid,
            });
            const albumData = parseProviderData(albumProviderItem?.data);
            const album = {
                id: representativeAlbumId,
                title: canonicalAlbum?.title || albumData.title || null,
                version: albumData.version || null,
                release_date: canonicalAlbum?.releaseDate || albumData.release_date || null,
                num_volumes: canonicalAlbum?.volumeCount || albumData.num_volumes || 1,
                video_cover: canonicalAlbum?.videoCover || albumData.video_cover || null,
                quality: albumProviderItem?.quality || albumData.quality || null,
                mbid: canonicalAlbum?.albumMbid || null,
                mb_release_group_id: canonicalReleaseGroupMbid,
                provider: albumProviderItem?.provider || selectedSlot?.selected_provider || "tidal",
            };
            if (!album.id) {
                continue;
            }
            const libraryRoots = (db.prepare(`
      SELECT DISTINCT lf.library_root
      FROM TrackFiles lf
      WHERE lf.artist_id = ?
        AND lf.file_type = 'track'
        AND lf.library_root IS NOT NULL
        AND lf.canonical_release_group_mbid = ?
      ORDER BY lf.library_root ASC
    `).all(artistId, canonicalReleaseGroupMbid) as Array<{ library_root: string | null }>)
                .map((row) => String(row.library_root || "").trim())
                .filter(Boolean);

            for (const libraryRoot of libraryRoots) {
                const expectedAlbumNfoPath = LibraryFilesService.computeExpectedPath({
                    id: -1,
                    artist_id: artistId as unknown as number,
                    album_id: album.id as unknown as number,
                    media_id: null,
                    file_path: "",
                    relative_path: null,
                    library_root: libraryRoot,
                    file_type: "nfo",
                    extension: "nfo",
                }).expectedPath;
                const albumDir = expectedAlbumNfoPath
                    ? path.dirname(expectedAlbumNfoPath)
                    : this.resolveAlbumDir(libraryRoot, artistFolder, album, naming);
                if (!albumDir || !fs.existsSync(albumDir)) continue;

                if (metadataConfig.save_album_cover) {
                    const coverName = metadataConfig.album_cover_name || "cover.jpg";
                    const coverPath = path.join(albumDir, coverName);
                    if (!fs.existsSync(coverPath)) {
                        try {
                            await downloadAlbumCover(
                                String(album.id),
                                metadataConfig.album_cover_resolution as any,
                                coverPath,
                            );
                            if (fs.existsSync(coverPath)) {
                                this.upsertLibraryFile({
                                    artistId,
                                    albumId: String(album.id),
                                    filePath: coverPath,
                                    libraryRoot,
                                    fileType: "cover",
                                    expectedPath: coverPath,
                                    provider: album.provider,
                                    providerEntityType: "album",
                                    providerId: String(album.id),
                                    canonicalReleaseGroupMbid,
                                    canonicalReleaseMbid,
                                    librarySlot,
                                });
                                result.downloaded++;
                            } else {
                                result.failed++;
                            }
                        } catch {
                            result.failed++;
                        }
                    } else {
                        result.skipped++;
                    }

                    if (album.video_cover) {
                        const videoCoverName = `${path.parse(coverName).name}.mp4`;
                        const videoCoverPath = path.join(albumDir, videoCoverName);
                        if (!fs.existsSync(videoCoverPath)) {
                            try {
                                await downloadAlbumVideoCover(
                                    String(album.video_cover),
                                    metadataConfig.album_cover_resolution as any,
                                    videoCoverPath,
                                );
                                if (fs.existsSync(videoCoverPath)) {
                                    this.upsertLibraryFile({
                                        artistId,
                                        albumId: String(album.id),
                                        filePath: videoCoverPath,
                                        libraryRoot,
                                        fileType: "video_cover",
                                        expectedPath: videoCoverPath,
                                        provider: album.provider,
                                        providerEntityType: "album",
                                        providerId: String(album.id),
                                        canonicalReleaseGroupMbid,
                                        canonicalReleaseMbid,
                                        librarySlot,
                                    });
                                    result.downloaded++;
                                } else {
                                    result.failed++;
                                }
                            } catch {
                                result.failed++;
                            }
                        } else {
                            result.skipped++;
                        }
                    }
                }

                if (metadataConfig.save_nfo) {
                    const nfoPath = path.join(albumDir, "album.nfo");
                    try {
                        await saveAlbumNfoFile(String(album.id), nfoPath);
                        this.upsertLibraryFile({
                            artistId,
                            albumId: String(album.id),
                            filePath: nfoPath,
                            libraryRoot,
                            fileType: "nfo",
                            expectedPath: nfoPath,
                            provider: album.provider,
                            providerEntityType: "album",
                            providerId: String(album.id),
                            canonicalReleaseGroupMbid,
                            canonicalReleaseMbid,
                            librarySlot,
                        });
                        result.downloaded++;
                    } catch {
                        result.failed++;
                    }
                }
            }
        }
    }

    private async fillTrackMetadata(
        artistId: string,
        metadataConfig: any,
        result: MetadataFillResult,
    ) {
        if (!metadataConfig.save_lyrics) return;

        const tracks = db.prepare(`
      WITH track_candidates AS (
        SELECT
          lf.id AS track_file_id,
          lf.file_path,
          lf.provider_id AS media_id,
          lf.library_root,
          lf.library_slot,
          lf.canonical_artist_mbid,
          lf.canonical_release_group_mbid,
          lf.canonical_release_mbid,
          lf.canonical_track_mbid,
          lf.canonical_recording_mbid,
          COALESCE(lf.provider, pi.provider, 'tidal') AS provider,
          'track' AS provider_entity_type,
          COALESCE(lf.provider_id, pi.provider_id) AS provider_id,
          pi.album_id AS album_id
        FROM TrackFiles lf
        LEFT JOIN ProviderItems pi
          ON pi.entity_type = 'track'
         AND (
            (
              lf.provider_id IS NOT NULL
              AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
            )
            OR (
              lf.provider_id IS NULL
              AND (
                (lf.canonical_track_mbid IS NOT NULL AND pi.track_mbid = lf.canonical_track_mbid)
                OR (lf.canonical_recording_mbid IS NOT NULL AND pi.recording_mbid = lf.canonical_recording_mbid)
              )
            )
         )
        WHERE lf.artist_id = ?
          AND lf.file_type = 'track'
      )
      SELECT *
      FROM track_candidates track
      WHERE track.provider_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM LyricFiles lyric
          WHERE lyric.library_slot IS track.library_slot
            AND (
              (lyric.provider_entity_type = 'track' AND CAST(lyric.provider_id AS TEXT) = CAST(track.provider_id AS TEXT))
              OR CAST(lyric.media_id AS TEXT) = CAST(track.provider_id AS TEXT)
              OR (
                track.canonical_recording_mbid IS NOT NULL
                AND lyric.canonical_recording_mbid = track.canonical_recording_mbid
              )
            )
        )
      GROUP BY track.track_file_id
    `).all(artistId) as Array<{
            track_file_id: number;
            file_path: string;
            media_id: string | null;
            library_root: string | null;
            library_slot: string | null;
            canonical_artist_mbid: string | null;
            canonical_release_group_mbid: string | null;
            canonical_release_mbid: string | null;
            canonical_track_mbid: string | null;
            canonical_recording_mbid: string | null;
            provider: string | null;
            provider_entity_type: string | null;
            provider_id: string;
            album_id: string | null;
        }>;

        for (const track of tracks) {
            const ext = path.extname(track.file_path);
            const lrcPath = track.file_path.replace(new RegExp(`${ext.replace('.', '\\.')}$`), ".lrc");
            if (fs.existsSync(lrcPath)) {
                result.skipped++;
                continue;
            }

            try {
                await saveLyricsFile(String(track.provider_id), lrcPath);
                if (fs.existsSync(lrcPath)) {
                    this.upsertLibraryFile({
                        artistId,
                        albumId: track.album_id ? String(track.album_id) : null,
                        mediaId: String(track.provider_id),
                        filePath: lrcPath,
                        libraryRoot: String(track.library_root || "").trim() || Config.getMusicPath(),
                        fileType: "lyrics",
                        expectedPath: lrcPath,
                        librarySlot: track.library_slot,
                        trackFileId: track.track_file_id,
                        provider: track.provider,
                        providerEntityType: "track",
                        providerId: String(track.provider_id),
                        canonicalArtistMbid: track.canonical_artist_mbid,
                        canonicalReleaseGroupMbid: track.canonical_release_group_mbid,
                        canonicalReleaseMbid: track.canonical_release_mbid,
                        canonicalTrackMbid: track.canonical_track_mbid,
                        canonicalRecordingMbid: track.canonical_recording_mbid,
                    });
                    result.downloaded++;
                } else {
                    result.failed++;
                }
            } catch {
                result.skipped++;
            }
        }
    }

    private async fillVideoMetadata(
        artistId: string,
        metadataConfig: any,
        result: MetadataFillResult,
    ) {
        const videoRoot = Config.getVideoPath();

        // ---- Thumbnail backfill ----
        if (metadataConfig.save_video_thumbnail) {
            const resolution = metadataConfig.video_thumbnail_resolution || "1080x720";

            const thumbnailVideos = db.prepare(`
      SELECT
        lf.id AS track_file_id,
        lf.file_path,
        lf.provider_id AS media_id,
        lf.library_root,
        lf.library_slot,
        lf.canonical_artist_mbid,
        lf.canonical_recording_mbid,
        COALESCE(lf.provider, pi.provider, 'tidal') AS provider,
        COALESCE(lf.provider_id, pi.provider_id) AS provider_id,
        pi.album_id AS album_id,
        r.cover_image_id AS cover
      FROM TrackFiles lf
      JOIN ProviderItems pi ON pi.entity_type = 'video' AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
      JOIN Recordings r ON r.id = pi.recording_id
      WHERE lf.artist_id = ?
        AND lf.file_type = 'video'
        AND r.cover_image_id IS NOT NULL
        AND COALESCE(lf.provider_id, pi.provider_id) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM MetadataFiles mf
          WHERE (
              (mf.provider_entity_type = 'video' AND CAST(mf.provider_id AS TEXT) = CAST(COALESCE(lf.provider_id, pi.provider_id) AS TEXT))
              OR CAST(mf.media_id AS TEXT) = CAST(COALESCE(lf.provider_id, pi.provider_id) AS TEXT)
            )
            AND mf.file_type = 'video_thumbnail'
        )
    `).all(artistId) as Array<{
                track_file_id: number;
                file_path: string;
                media_id: string | null;
                library_root: string | null;
                library_slot: string | null;
                canonical_artist_mbid: string | null;
                canonical_recording_mbid: string | null;
                provider: string | null;
                provider_id: string;
                album_id: string | null;
                cover: string;
            }>;

            for (const video of thumbnailVideos) {
                const videoDir = path.dirname(video.file_path);
                const videoStem = path.parse(video.file_path).name;
                const thumbPath = path.join(videoDir, `${videoStem}.jpg`);

                if (fs.existsSync(thumbPath)) {
                    result.skipped++;
                    continue;
                }

                try {
                    await downloadVideoThumbnail(video.cover, resolution as any, thumbPath);
                    if (fs.existsSync(thumbPath)) {
                        this.upsertLibraryFile({
                            artistId,
                            albumId: video.album_id ? String(video.album_id) : null,
                            mediaId: String(video.provider_id),
                            filePath: thumbPath,
                            libraryRoot: String(video.library_root || "").trim() || videoRoot,
                            fileType: "video_thumbnail",
                            expectedPath: thumbPath,
                            librarySlot: video.library_slot,
                            trackFileId: video.track_file_id,
                            provider: video.provider,
                            providerEntityType: "video",
                            providerId: String(video.provider_id),
                            canonicalArtistMbid: video.canonical_artist_mbid,
                            canonicalRecordingMbid: video.canonical_recording_mbid,
                        });
                        if (metadataConfig.embed_video_thumbnail !== false) {
                            await embedVideoThumbnail(video.file_path, thumbPath);
                        }
                        result.downloaded++;
                    } else {
                        result.failed++;
                    }
                } catch {
                    result.failed++;
                }
            }
        }

        if (metadataConfig.save_nfo) {
            const videos = db.prepare(`
      SELECT
        lf.id AS track_file_id,
        lf.file_path,
        lf.provider_id AS media_id,
        lf.library_root,
        lf.library_slot,
        lf.canonical_artist_mbid,
        lf.canonical_recording_mbid,
        COALESCE(lf.provider, pi.provider, 'tidal') AS provider,
        COALESCE(lf.provider_id, pi.provider_id) AS provider_id,
        pi.album_id AS album_id
      FROM TrackFiles lf
      JOIN ProviderItems pi ON pi.entity_type = 'video' AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
      WHERE lf.artist_id = ?
        AND lf.file_type = 'video'
        AND COALESCE(lf.provider_id, pi.provider_id) IS NOT NULL
    `).all(artistId) as Array<{
                track_file_id: number;
                file_path: string;
                media_id: string | null;
                library_root: string | null;
                library_slot: string | null;
                canonical_artist_mbid: string | null;
                canonical_recording_mbid: string | null;
                provider: string | null;
                provider_id: string;
                album_id: string | null;
            }>;

            for (const video of videos) {
                const nfoPath = path.join(path.dirname(video.file_path), `${path.parse(video.file_path).name}.nfo`);
                try {
                    await saveVideoNfoFile(String(video.provider_id), nfoPath);
                    this.upsertLibraryFile({
                        artistId,
                        albumId: video.album_id ? String(video.album_id) : null,
                        mediaId: String(video.provider_id),
                        filePath: nfoPath,
                        libraryRoot: String(video.library_root || "").trim() || videoRoot,
                        fileType: "nfo",
                        expectedPath: nfoPath,
                        librarySlot: video.library_slot,
                        trackFileId: video.track_file_id,
                        provider: video.provider,
                        providerEntityType: "video",
                        providerId: String(video.provider_id),
                        canonicalArtistMbid: video.canonical_artist_mbid,
                        canonicalRecordingMbid: video.canonical_recording_mbid,
                    });
                    result.downloaded++;
                } catch {
                    result.failed++;
                }
            }
        }

        // ---- Video tag backfill ----
        if (metadataConfig.write_audio_tags_policy !== "no") {
            const tagVideos = db.prepare(`
      SELECT lf.file_path,
             COALESCE(lf.provider_id, pi.provider_id) AS media_id,
             r.title AS media_title,
             pi.version AS media_version,
             r.release_date AS media_release_date,
             pi.data AS provider_data,
             ar.name AS artist_name,
             album.title AS album_title
      FROM TrackFiles lf
      JOIN ProviderItems pi ON pi.entity_type = 'video' AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
      JOIN Recordings r ON r.id = pi.recording_id
      JOIN Artists ar ON ar.id = lf.artist_id
      LEFT JOIN Albums album ON album.mbid = pi.release_group_mbid
      WHERE lf.artist_id = ?
        AND lf.file_type = 'video'
    `).all(artistId) as Array<{
                file_path: string;
                media_id: string;
                media_title: string;
                media_version: string | null;
                media_release_date: string | null;
                provider_data: string | null;
                artist_name: string;
                album_title: string | null;
            }>;

            for (const video of tagVideos) {
                const ext = path.extname(video.file_path).toLowerCase();
                if (!["mp4", "m4v", "mov"].includes(ext.slice(1))) continue;
                if (!fs.existsSync(video.file_path)) continue;

                const date = video.media_release_date
                    ? (String(video.media_release_date).match(/^\d{4}/)?.[0] || undefined)
                    : undefined;
                const videoTitle = video.media_version
                    ? `${video.media_title} (${video.media_version})`
                    : video.media_title;
                const providerData = parseProviderData(video.provider_data);
                const copyright = String(providerData.copyright || "").trim() || undefined;

                let providerVideoUrl: string | undefined;
                try {
                    providerVideoUrl = buildStreamingMediaUrl("video", String(video.media_id));
                } catch {
                    providerVideoUrl = undefined;
                }

                try {
                    const proposedTags = {
                        title: videoTitle || undefined,
                        artist: video.artist_name ? [video.artist_name] : undefined,
                        album_artist: video.artist_name || undefined,
                        album: video.album_title || undefined,
                        date,
                        comment: providerVideoUrl,
                        copyright,
                    };
                    // Skip if every proposed field is empty/undefined
                    const hasAnyValue = Object.values(proposedTags).some(
                        (v) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
                    );
                    if (!hasAnyValue) {
                        result.skipped++;
                        continue;
                    }
                    // Skip if the tag fingerprint matches what we last wrote this run
                    const tagKey = `${video.media_id}:${video.file_path}`;
                    const tagFingerprint = JSON.stringify(
                        Object.fromEntries(
                            Object.entries(proposedTags)
                                .filter(([, v]) => v !== undefined)
                                .sort(([a], [b]) => a.localeCompare(b)),
                        ),
                    );
                    if (this._writtenVideoTagFingerprints.get(tagKey) === tagFingerprint) {
                        result.skipped++;
                        continue;
                    }
                    await writeVideoTags(video.file_path, proposedTags);
                    this._writtenVideoTagFingerprints.set(tagKey, tagFingerprint);
                } catch {
                    // Non-fatal: continue with other files
                }
            }
        }
    }

    private resolveAlbumDir(
        libraryRoot: string,
        artistFolder: string,
        album: any,
        naming: ReturnType<typeof getNamingConfig>,
    ): string | null {
        const canonicalAlbum = getCanonicalAlbumMetadata({
            canonicalReleaseGroupMbid: album.mb_release_group_id,
            canonicalReleaseMbid: album.mbid,
        });
        const releaseYear = canonicalAlbum?.releaseDate || album.release_date
            ? (String(canonicalAlbum?.releaseDate || album.release_date).match(/^(\d{4})/)?.[1] || null)
            : null;

        const albumContext: NamingContext = {
            artistName: "",
            albumTitle: canonicalAlbum?.title || album.title,
            albumVersion: canonicalAlbum ? null : album.version || null,
            releaseYear,
        };

        const numVolumes = Number(canonicalAlbum?.volumeCount || album.num_volumes || 1);
        const trackTemplate = numVolumes > 1 ? naming.album_track_path_multi : naming.album_track_path_single;

        const templateSegments = (trackTemplate || "").split(/[\\/]+/g).filter(Boolean);
        const templateDirSegments = templateSegments.slice(0, -1);
        const volumeDirIndex = templateDirSegments.findIndex((seg) => /\{(?:volumeNumber|medium)(?::|0|\})/i.test(seg));

        const renderedTrackPath = renderRelativePath(trackTemplate, {
            ...albumContext,
            trackTitle: "Track",
            trackNumber: 1,
            volumeNumber: 1,
        });
        const renderedSegments = renderedTrackPath.split(/[\\/]+/g).filter(Boolean);
        const dirSegments = renderedSegments.slice(0, -1);

        let albumDirRelative = "";
        if (dirSegments.length > 0) {
            if (volumeDirIndex >= 0 && volumeDirIndex > 0) {
                albumDirRelative = path.join(...dirSegments.slice(0, volumeDirIndex));
            } else if (volumeDirIndex < 0) {
                albumDirRelative = path.join(...dirSegments);
            }
        }

        return path.join(libraryRoot, artistFolder, albumDirRelative);
    }

    private upsertLibraryFile(params: {
        artistId: string;
        albumId?: string | null;
        mediaId?: string | null;
        trackFileId?: number | null;
        filePath: string;
        libraryRoot: string;
        fileType: string;
        quality?: string | null;
        expectedPath?: string | null;
        librarySlot?: string | null;
        provider?: string | null;
        providerEntityType?: string | null;
        providerId?: string | null;
        canonicalArtistMbid?: string | null;
        canonicalReleaseGroupMbid?: string | null;
        canonicalReleaseMbid?: string | null;
        canonicalTrackMbid?: string | null;
        canonicalRecordingMbid?: string | null;
    }) {
        LibraryFilesService.upsertLibraryFile({
            ...params,
            removeFromUnmapped: false,
        });
    }
}

export const libraryMetadataBackfillService = new LibraryMetadataBackfillService();
