import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import { Config, getConfigSection } from "../config/config.js";
import { getNamingConfig, renderRelativePath, resolveArtistFolderFromRecord, type NamingContext } from "../config/naming.js";
import {
    downloadAlbumVideoCover,
    downloadVideoThumbnail,
    saveAlbumNfoFile,
    saveArtistNfoFile,
    saveLyricsFile,
    saveVideoNfoFile,
} from "./metadata-files.js";
import { embedVideoThumbnail, hasEmbeddedVideoThumbnail, writeVideoTags } from "./audioUtils.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { LibraryFilesService } from "./library-files.js";
import { AudioTagService } from "./audio-tag-service.js";
import { getCanonicalAlbumMetadata } from "../metadata/canonical-album-metadata.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { syncCachedMediaCoverToFile } from "../metadata/media-cover-service.js";
import {
    findAdjacentLyricSidecar,
    lyricSidecarPath,
    SYNCHRONIZED_LYRIC_EXTENSION,
} from "../extras/lyrics/lyric-sidecar.js";
import { resolveAlbumVideoCoverForLibrary } from "./organizer.js";
import { providerResolvedAlbumIdSql } from "../providers/provider-item-artist-scope.js";



type ProviderAlbumOfferRow = {
    provider?: string | null;
    provider_id?: string | null;
    release_mbid?: string | null;
    quality?: string | null;
    title?: string | null;
    version?: string | null;
    release_date?: string | null;
    cover?: string | null;
};

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
                try {
                    const artistRow = db.prepare("SELECT mbid FROM Artists WHERE id = ?").get(artistId) as { mbid?: string | null } | undefined;
                    const artistMbid = artistRow?.mbid ? String(artistRow.mbid) : artistId;
                    const syncResult = syncCachedMediaCoverToFile({
                        entityId: artistMbid,
                        coverEntity: "Artist",
                        coverTypes: ["poster", "headshot"],
                        outputPath: picPath,
                    });
                    if (syncResult === "written") {
                        result.downloaded++;
                    } else {
                        result.skipped++;
                    }
                    if (fs.existsSync(picPath)) {
                        this.upsertLibraryFile({
                            artistId,
                            filePath: picPath,
                            libraryRoot,
                            fileType: "cover",
                            expectedPath: picPath,
                        });
                    }
                } catch {
                    result.failed++;
                }
            }

            if (metadataConfig.save_nfo) {
                const nfoPath = path.join(artistDir, "artist.nfo");
                try {
                    const updated = await saveArtistNfoFile(artistId, nfoPath);
                    this.upsertLibraryFile({
                        artistId,
                        filePath: nfoPath,
                        libraryRoot,
                        fileType: "nfo",
                        expectedPath: nfoPath,
                    });
                    if (updated) {
                        result.downloaded++;
                    } else {
                        result.skipped++;
                    }
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
        // Canonical-first: backfill each selected edition independently in
        // every library that owns imported audio for it. Grouping only by
        // release group wrote one cover.jpg / album.nfo and stole it between
        // sibling edition folders (All This Bad Blood vs Bad Blood X).
        const albums = db.prepare(`
      SELECT
        lf.release_group_id,
        lf.library_id,
        lf.album_edition_id,
        release_group.mbid AS canonical_release_group_mbid,
        edition.mbid AS edition_mbid,
        CASE WHEN EXISTS (
          SELECT 1
          FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
          WHERE allowed.value = 'spatial'
        ) THEN 'spatial' ELSE 'stereo' END AS library_class
      FROM TrackFiles lf
      JOIN Albums release_group
        ON release_group.id = lf.release_group_id
      JOIN AlbumEditions edition
        ON edition.id = lf.album_edition_id
      JOIN LibraryEditions library_edition
        ON library_edition.library_id = lf.library_id
       AND library_edition.edition_id = lf.album_edition_id
      JOIN Libraries library
        ON library.id = lf.library_id
      JOIN quality_profiles quality_profile
        ON quality_profile.id = library.quality_profile_id
      WHERE lf.artist_id = ?
        AND lf.file_type = 'track'
        AND lf.release_group_id IS NOT NULL
        AND lf.library_id IS NOT NULL
        AND lf.album_edition_id IS NOT NULL
      GROUP BY lf.release_group_id, lf.library_id, lf.album_edition_id
    `).all(artistId) as any[];
        const processedLibraryAlbums = new Set<string>();

        for (const sourceAlbum of albums) {
            const canonicalReleaseGroupMbid = String(sourceAlbum.canonical_release_group_mbid || "").trim();
            const librarySlot = String(sourceAlbum.library_class || "stereo");
            const libraryAlbumKey = `${sourceAlbum.library_id}:${sourceAlbum.release_group_id}:${sourceAlbum.album_edition_id}`;
            if (processedLibraryAlbums.has(libraryAlbumKey)) {
                continue;
            }
            processedLibraryAlbums.add(libraryAlbumKey);

            const selectedPlan = canonicalReleaseGroupMbid
                ? db.prepare(`
                    SELECT
                      plan.provider AS selected_provider,
                      provider_release.provider_id AS selected_provider_id,
                      selected_release.mbid AS selected_release_mbid,
                      (
                        SELECT COALESCE(NULLIF(TRIM(variant.provider_quality_label), ''), variant.quality_class)
                        FROM AcquisitionPlanTracks plan_track
                        JOIN ProviderItemAudioVariants variant
                          ON variant.id = plan_track.provider_audio_variant_id
                        WHERE plan_track.plan_id = plan.id
                        ORDER BY CASE variant.quality_class
                          WHEN 'spatial' THEN 0
                          WHEN 'hires-lossless' THEN 1
                          WHEN 'lossless' THEN 2
                          ELSE 3 END,
                          variant.id
                        LIMIT 1
                      ) AS quality,
                      provider_release.title,
                      provider_release.version,
                      provider_release.release_date,
                      COALESCE(
                        provider_release.cover_id,
                        provider_release.artwork_url
                      ) AS cover
                    FROM LibraryEditions library_release
                    JOIN AlbumEditions selected_release
                      ON selected_release.id = library_release.edition_id
                    JOIN SelectedAcquisitionPlans plan
                      ON plan.library_edition_id = library_release.id
                     AND plan.state = 'current'
                    JOIN AcquisitionPlanSources plan_source
                      ON plan_source.plan_id = plan.id
                     AND plan_source.role = 'primary'
                    JOIN ProviderEditionMatches release_match
                      ON release_match.id = plan_source.provider_edition_match_id
                     AND release_match.match_state = 'accepted'
                    JOIN ProviderItems provider_release
                      ON provider_release.id = release_match.provider_edition_item_id
                    WHERE library_release.library_id = ?
                      AND library_release.edition_id = ?
                    ORDER BY plan_source.sort_order, plan_source.id
                    LIMIT 1
                `).get(sourceAlbum.library_id, sourceAlbum.album_edition_id) as {
                    selected_provider?: string | null;
                    selected_provider_id?: string | null;
                    selected_release_mbid?: string | null;
                    quality?: string | null;
                    title?: string | null;
                    version?: string | null;
                    release_date?: string | null;
                    cover?: string | null;
                } | undefined
                : undefined;
            const albumProviderItem = selectedPlan
                ? {
                    provider: selectedPlan.selected_provider,
                    provider_id: selectedPlan.selected_provider_id,
                    release_mbid: selectedPlan.selected_release_mbid,
                    quality: selectedPlan.quality,
                    title: selectedPlan.title,
                    version: selectedPlan.version,
                    release_date: selectedPlan.release_date,
                    cover: selectedPlan.cover,
                } satisfies ProviderAlbumOfferRow
                : undefined;
            const selectedProviderAlbumId = String(selectedPlan?.selected_provider_id || "").trim() || null;
            const representativeAlbumId = String(albumProviderItem?.provider_id || selectedProviderAlbumId || "").trim() || null;
            const canonicalReleaseMbid = String(sourceAlbum.edition_mbid || selectedPlan?.selected_release_mbid || "").trim()
                || (sourceAlbum.album_edition_id
                    ? (db.prepare("SELECT mbid FROM AlbumEditions WHERE id = ?")
                        .get(sourceAlbum.album_edition_id) as { mbid?: string | null } | undefined)?.mbid
                    : null)
                || null;
            const canonicalAlbum = getCanonicalAlbumMetadata({
                canonicalReleaseGroupMbid,
                canonicalReleaseMbid,
            });
            const albumData: ProviderAlbumOfferRow = albumProviderItem || {};
            const album = {
                id: representativeAlbumId,
                title: canonicalAlbum?.title || albumData.title || null,
                version: albumData.version || null,
                release_date: canonicalAlbum?.releaseDate || albumData.release_date || null,
                num_volumes: canonicalAlbum?.volumeCount || 1,
                video_cover: canonicalAlbum?.videoCover || null,
                quality: albumProviderItem?.quality || albumData.quality || null,
                mbid: canonicalAlbum?.albumMbid || null,
                mb_release_group_id: canonicalReleaseGroupMbid,
                provider: albumProviderItem?.provider || selectedPlan?.selected_provider || null,
            };
            // Fetch a representative ON-DISK track per library root so sidecars are
            // written into the album's ACTUAL folder. Using only the expected folder
            // (from the naming template) silently skipped every album whose files sit
            // at a path that differs from the current template (e.g. not yet renamed),
            // which is why cover.jpg / .nfo never regenerated for those albums.
            const libraryRootRows = (db.prepare(`
      SELECT lf.library_root, MIN(lf.file_path) AS file_path, MIN(lf.relative_path) AS relative_path
      FROM TrackFiles lf
      WHERE lf.artist_id = ?
        AND lf.file_type = 'track'
        AND lf.library_root IS NOT NULL
        AND lf.release_group_id = ?
        AND lf.library_id = ?
        AND lf.album_edition_id = ?
      GROUP BY lf.library_root
      ORDER BY lf.library_root ASC
    `).all(artistId, sourceAlbum.release_group_id, sourceAlbum.library_id, sourceAlbum.album_edition_id) as Array<{ library_root: string | null; file_path: string | null; relative_path: string | null }>)
                .filter((row) => String(row.library_root || "").trim());

            for (const libraryRootRow of libraryRootRows) {
                const libraryRoot = String(libraryRootRow.library_root || "").trim();
                const actualAlbumDir = libraryRootRow.file_path
                    ? path.dirname(resolveStoredLibraryPath({
                        filePath: libraryRootRow.file_path,
                        libraryRoot: libraryRootRow.library_root,
                        relativePath: libraryRootRow.relative_path,
                    }))
                    : null;
                const expectedAlbumNfoPath = LibraryFilesService.computeExpectedPath({
                    id: -1,
                    artist_id: artistId as unknown as number,
                    album_id: (album.id || null) as unknown as number,
                    media_id: null,
                    file_path: "",
                    relative_path: null,
                    library_root: libraryRoot,
                    file_type: "nfo",
                    extension: "nfo",
                }).expectedPath;
                // Prefer the real on-disk folder; fall back to the expected path.
                const albumDir = (actualAlbumDir && fs.existsSync(actualAlbumDir))
                    ? actualAlbumDir
                    : (expectedAlbumNfoPath
                        ? path.dirname(expectedAlbumNfoPath)
                        : this.resolveAlbumDir(libraryRoot, artistFolder, album, naming));
                if (!albumDir || !fs.existsSync(albumDir)) continue;

                if (metadataConfig.save_album_cover) {
                    const coverName = metadataConfig.album_cover_name || "cover.jpg";
                    const coverPath = path.join(albumDir, coverName);
                    try {
                        const syncResult = syncCachedMediaCoverToFile({
                            entityId: canonicalReleaseGroupMbid,
                            coverEntity: "Album",
                            coverTypes: "cover",
                            outputPath: coverPath,
                        });
                        if (syncResult === "written") {
                            result.downloaded++;
                        } else {
                            result.skipped++;
                        }
                        if (fs.existsSync(coverPath)) {
                            this.upsertLibraryFile({
                                artistId,
                                albumId: album.id ? String(album.id) : null,
                                filePath: coverPath,
                                libraryRoot,
                                fileType: "cover",
                                expectedPath: coverPath,
                                provider: album.provider,
                                providerEntityType: "album",
                                providerId: album.id ? String(album.id) : null,
                                canonicalReleaseGroupMbid,
                                canonicalReleaseMbid,
                                librarySlot,
                            });
                            const trackFileIds = (db.prepare(`
                                SELECT id
                                FROM TrackFiles
                                WHERE artist_id = ?
                                  AND file_type = 'track'
                                  AND release_group_id = ?
                                  AND library_id = ?
                                  AND album_edition_id = ?
                                  AND library_root = ?
                                ORDER BY id ASC
                            `).all(
                                artistId,
                                sourceAlbum.release_group_id,
                                sourceAlbum.library_id,
                                sourceAlbum.album_edition_id,
                                libraryRoot,
                            ) as Array<{ id: number }>).map((row) => row.id);
                            await AudioTagService.syncEmbeddedCovers(trackFileIds);
                        }
                    } catch (error) {
                        console.warn(
                            `[LibraryScan] Failed album cover sidecar ${coverPath}:`,
                            error instanceof Error ? error.message : error,
                        );
                        result.failed++;
                    }

                    const resolvedVideoCover = album.id ? await resolveAlbumVideoCoverForLibrary({
                        storedVideoCover: album.video_cover,
                        provider: album.provider,
                        providerAlbumId: String(album.id),
                        releaseGroupMbid: canonicalReleaseGroupMbid,
                    }) : null;
                    if (resolvedVideoCover) {
                        const videoCoverName = `${path.parse(coverName).name}.mp4`;
                        const videoCoverPath = path.join(albumDir, videoCoverName);
                        if (!fs.existsSync(videoCoverPath)) {
                            try {
                                // Saved sidecar artwork always uses the highest available
                                // resolution, independent of metadata.album_cover_resolution
                                // (which only caps the UI's cached display thumbnail).
                                await downloadAlbumVideoCover(
                                    String(resolvedVideoCover),
                                    "origin",
                                    videoCoverPath,
                                    {
                                        provider: album.provider,
                                        providerAlbumId: String(album.id),
                                        releaseGroupMbid: canonicalReleaseGroupMbid,
                                    },
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
                            result.skipped++;
                        }
                    }
                }

                if (metadataConfig.save_nfo) {
                    const nfoPath = path.join(albumDir, "album.nfo");
                    try {
                        const updated = await saveAlbumNfoFile(canonicalReleaseGroupMbid, nfoPath, {
                            releaseGroupMbid: canonicalReleaseGroupMbid,
                            releaseMbid: canonicalReleaseMbid,
                            librarySlot,
                            provider: album.provider,
                            providerAlbumId: album.id ? String(album.id) : null,
                        });
                        this.upsertLibraryFile({
                            artistId,
                            albumId: album.id ? String(album.id) : null,
                            filePath: nfoPath,
                            libraryRoot,
                            fileType: "nfo",
                            expectedPath: nfoPath,
                            provider: album.provider,
                            providerEntityType: "album",
                            providerId: album.id ? String(album.id) : null,
                            canonicalReleaseGroupMbid,
                            canonicalReleaseMbid,
                            librarySlot,
                        });
                        if (updated) {
                            result.downloaded++;
                        } else {
                            result.skipped++;
                        }
                    } catch (error) {
                        console.warn(
                            `[LibraryScan] Failed album NFO ${nfoPath}:`,
                            error instanceof Error ? error.message : error,
                        );
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
          COALESCE(lf.provider, pi.provider) AS provider,
          'track' AS provider_entity_type,
          COALESCE(lf.provider_id, pi.provider_id) AS provider_id,
          ${providerResolvedAlbumIdSql({
              itemAlias: "pi",
              libraryIdExpr: "lf.library_id",
          })} AS album_id
        FROM TrackFiles lf
        LEFT JOIN ProviderItems pi
          ON pi.entity_type = 'track'
         AND lf.provider IS NOT NULL
         AND pi.provider = lf.provider
         AND (
            (
              lf.provider_id IS NOT NULL
              AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
            )
            OR (
              lf.provider_id IS NULL
              -- Provider-free TrackFiles: reach the offer through its accepted
              -- typed track match instead of the retired MBID shadow columns.
              AND EXISTS (
                SELECT 1
                FROM ProviderEditionMembers member
                JOIN ProviderTrackMatches track_match
                  ON track_match.provider_edition_member_id = member.id
                 AND track_match.match_state = 'accepted'
                LEFT JOIN Tracks canonical_track ON canonical_track.id = track_match.track_id
                JOIN Recordings canonical_recording ON canonical_recording.id = track_match.recording_id
                WHERE member.member_item_id = pi.id
                  AND (
                    (lf.canonical_track_mbid IS NOT NULL AND canonical_track.mbid = lf.canonical_track_mbid)
                    OR (lf.canonical_recording_mbid IS NOT NULL AND canonical_recording.mbid = lf.canonical_recording_mbid)
                  )
              )
            )
         )
        WHERE lf.artist_id = ?
          AND lf.file_type = 'track'
      )
      SELECT *
      FROM track_candidates track
      WHERE track.provider_id IS NOT NULL
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
            const existingSidecar = findAdjacentLyricSidecar(track.file_path, { normalizeExtension: true });
            if (existingSidecar) {
                this.upsertLibraryFile({
                    artistId,
                    albumId: track.album_id ? String(track.album_id) : null,
                    mediaId: String(track.provider_id),
                    filePath: existingSidecar.filePath,
                    libraryRoot: String(track.library_root || "").trim() || Config.getMusicPath(),
                    fileType: "lyrics",
                    expectedPath: existingSidecar.filePath,
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
                result.skipped++;
                continue;
            }

            try {
                const requestedPath = lyricSidecarPath(track.file_path, SYNCHRONIZED_LYRIC_EXTENSION);
                const savedPath = await saveLyricsFile(String(track.provider_id), requestedPath, track.provider);
                if (fs.existsSync(savedPath)) {
                    this.upsertLibraryFile({
                        artistId,
                        albumId: track.album_id ? String(track.album_id) : null,
                        mediaId: String(track.provider_id),
                        filePath: savedPath,
                        libraryRoot: String(track.library_root || "").trim() || Config.getMusicPath(),
                        fileType: "lyrics",
                        expectedPath: savedPath,
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
        if (metadataConfig.save_video_thumbnail || metadataConfig.embed_video_thumbnail !== false) {
            const resolution = metadataConfig.video_thumbnail_resolution || "origin";

            const thumbnailVideos = db.prepare(`
      SELECT
        lf.id AS track_file_id,
        lf.library_id,
        lf.file_path,
        lf.provider_id AS media_id,
        lf.library_root,
        lf.library_slot,
        lf.canonical_artist_mbid,
        lf.canonical_recording_mbid,
        COALESCE(lf.provider, pi.provider) AS provider,
        COALESCE(lf.provider_id, pi.provider_id) AS provider_id,
        ${providerResolvedAlbumIdSql({
            itemAlias: "pi",
            libraryIdExpr: "lf.library_id",
        })} AS album_id,
        r.id AS recording_id
      FROM TrackFiles lf
      LEFT JOIN ProviderItems pi
        ON lf.provider IS NOT NULL
       AND pi.provider = lf.provider
       AND pi.entity_type = 'video'
       AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
      LEFT JOIN ProviderVideoMatches video_match
        ON video_match.provider_video_item_id = pi.id
       AND video_match.match_state = 'accepted'
      LEFT JOIN Recordings r ON r.id = video_match.recording_id
      WHERE lf.artist_id = ?
        AND lf.file_type = 'video'
        AND COALESCE(lf.provider_id, pi.provider_id) IS NOT NULL
    `).all(artistId) as Array<{
                track_file_id: number;
                library_id: number;
                file_path: string;
                media_id: string | null;
                library_root: string | null;
                library_slot: string | null;
                canonical_artist_mbid: string | null;
                canonical_recording_mbid: string | null;
                provider: string | null;
                provider_id: string;
                album_id: string | null;
                recording_id: number | null;
            }>;

            for (const video of thumbnailVideos) {
                const videoDir = path.dirname(video.file_path);
                const videoStem = path.parse(video.file_path).name;
                const persistentThumbPath = path.join(videoDir, `${videoStem}.jpg`);
                const transientThumbPath = path.join(videoDir, `.${videoStem}.embed-thumb.jpg`);
                const thumbPath = metadataConfig.save_video_thumbnail ? persistentThumbPath : transientThumbPath;

                try {
                    const alreadyEmbedded = metadataConfig.embed_video_thumbnail !== false
                        ? await hasEmbeddedVideoThumbnail(video.file_path)
                        : true;
                    const needsEmbedding = metadataConfig.embed_video_thumbnail !== false && !alreadyEmbedded;
                    let downloadedThumbnail = false;

                    if (metadataConfig.save_video_thumbnail || needsEmbedding) {
                        const syncResult = await downloadVideoThumbnail("", resolution as any, thumbPath, {
                            provider: video.provider,
                            providerId: video.provider_id,
                            videoId: video.recording_id ?? video.canonical_recording_mbid,
                        });
                        downloadedThumbnail = syncResult === "written";
                        // A cache miss is expected until refresh/match acquires the
                        // canonical recording cover. Do not turn it into a failed
                        // sidecar job or fetch from the provider here.
                        if (syncResult === "missing" && !fs.existsSync(thumbPath)) {
                            result.skipped++;
                            continue;
                        }
                    }

                    if (metadataConfig.save_video_thumbnail && fs.existsSync(thumbPath)) {
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
                            libraryId: video.library_id,
                            provider: video.provider,
                            providerEntityType: "video",
                            providerId: String(video.provider_id),
                            canonicalArtistMbid: video.canonical_artist_mbid,
                            canonicalRecordingMbid: video.canonical_recording_mbid,
                        });
                    }

                    let embeddedThumbnail = false;
                    const shouldEmbed = metadataConfig.embed_video_thumbnail !== false
                        && (needsEmbedding || downloadedThumbnail);
                    if (shouldEmbed && fs.existsSync(thumbPath)) {
                        embeddedThumbnail = await embedVideoThumbnail(video.file_path, thumbPath);
                        if (embeddedThumbnail) {
                            const stat = fs.statSync(video.file_path);
                            db.prepare(`
                              UPDATE TrackFiles
                              SET file_size = ?, modified_at = ?, verified_at = CURRENT_TIMESTAMP
                              WHERE id = ?
                            `).run(stat.size, stat.mtime.toISOString(), video.track_file_id);
                        }
                    }

                    if (!metadataConfig.save_video_thumbnail && fs.existsSync(transientThumbPath)) {
                        fs.rmSync(transientThumbPath, { force: true });
                    }

                    const savedThumbnailReady = !metadataConfig.save_video_thumbnail || fs.existsSync(persistentThumbPath);
                    const embeddedThumbnailReady = !shouldEmbed || embeddedThumbnail;
                    if (!savedThumbnailReady || !embeddedThumbnailReady) {
                        result.failed++;
                    } else if (downloadedThumbnail || embeddedThumbnail) {
                        result.downloaded++;
                    } else {
                        result.skipped++;
                    }
                } catch (error) {
                    if (!metadataConfig.save_video_thumbnail && fs.existsSync(transientThumbPath)) {
                        fs.rmSync(transientThumbPath, { force: true });
                    }
                    console.warn(`[MetadataBackfill] Failed video thumbnail processing for ${video.provider}:${video.provider_id}:`, error);
                    result.failed++;
                }
            }
        }

        if (metadataConfig.save_nfo) {
            const videos = db.prepare(`
      SELECT
        lf.id AS track_file_id,
        lf.library_id,
        lf.file_path,
        lf.provider_id AS media_id,
        lf.library_root,
        lf.library_slot,
        lf.canonical_artist_mbid,
        lf.canonical_recording_mbid,
        COALESCE(lf.provider, pi.provider, 'tidal') AS provider,
        COALESCE(lf.provider_id, pi.provider_id) AS provider_id,
        ${providerResolvedAlbumIdSql({
            itemAlias: "pi",
            libraryIdExpr: "lf.library_id",
        })} AS album_id,
        -- A music video's album identity is the release group of the audio
        -- recording it is related to (provider_video_for), resolved canonically.
        related_release.mbid AS canonical_release_mbid,
        related_group.mbid AS canonical_release_group_mbid
      FROM TrackFiles lf
      JOIN ProviderItems pi
        ON pi.provider = lf.provider
       AND pi.entity_type = 'video'
       AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
      LEFT JOIN ProviderVideoMatches video_match
        ON video_match.provider_video_item_id = pi.id
       AND video_match.match_state = 'accepted'
      LEFT JOIN RecordingRelations relation
        ON relation.source_recording_id = video_match.recording_id
       AND relation.relation_type IN ('provider_video_for', 'music_video_for')
      LEFT JOIN Tracks related_track ON related_track.recording_id = relation.target_recording_id
      LEFT JOIN AlbumEditions related_release ON related_release.id = related_track.album_edition_id
      LEFT JOIN Albums related_group ON related_group.id = related_release.release_group_id
      WHERE lf.artist_id = ?
        AND lf.file_type = 'video'
        AND COALESCE(lf.provider_id, pi.provider_id) IS NOT NULL
    `).all(artistId) as Array<{
                track_file_id: number;
                library_id: number;
                file_path: string;
                media_id: string | null;
                library_root: string | null;
                library_slot: string | null;
                canonical_artist_mbid: string | null;
                canonical_recording_mbid: string | null;
                provider: string | null;
                provider_id: string;
                album_id: string | null;
                canonical_release_mbid: string | null;
                canonical_release_group_mbid: string | null;
            }>;

            for (const video of videos) {
                const nfoPath = path.join(path.dirname(video.file_path), `${path.parse(video.file_path).name}.nfo`);
                try {
                    await saveVideoNfoFile(String(video.provider_id), nfoPath, video.provider);
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
                        libraryId: video.library_id,
                        provider: video.provider,
                        providerEntityType: "video",
                        providerId: String(video.provider_id),
                        canonicalArtistMbid: video.canonical_artist_mbid,
                        canonicalRecordingMbid: video.canonical_recording_mbid,
                        canonicalReleaseMbid: video.canonical_release_mbid,
                        canonicalReleaseGroupMbid: video.canonical_release_group_mbid,
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
             pi.copyright AS provider_copyright,
             ar.name AS artist_name,
             album.title AS album_title
      FROM TrackFiles lf
      JOIN ProviderItems pi
        ON pi.provider = lf.provider
       AND pi.entity_type = 'video'
       AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
      JOIN ProviderVideoMatches video_match
        ON video_match.provider_video_item_id = pi.id
       AND video_match.match_state = 'accepted'
      JOIN Recordings r ON r.id = video_match.recording_id
      JOIN Artists ar ON ar.id = lf.artist_id
      LEFT JOIN Albums album ON album.id = (
        SELECT CASE
          WHEN COUNT(DISTINCT canonical_release.release_group_id) = 1
          THEN MAX(canonical_release.release_group_id)
        END
        FROM ProviderEditionMembers member
        JOIN ProviderEditionMatches release_match
          ON release_match.provider_edition_item_id = member.provider_edition_item_id
         AND release_match.match_state = 'accepted'
        JOIN AlbumEditions canonical_release ON canonical_release.id = release_match.edition_id
        WHERE member.member_item_id = pi.id
      )
      WHERE lf.artist_id = ?
        AND lf.file_type = 'video'
    `).all(artistId) as Array<{
                file_path: string;
                media_id: string;
                media_title: string;
                media_version: string | null;
                media_release_date: string | null;
                provider_copyright: string | null;
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
                const copyright = String(video.provider_copyright || "").trim() || undefined;

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
            albumDisambiguation: canonicalAlbum?.disambiguation || null,
            editionTitle: canonicalAlbum?.editionTitle || canonicalAlbum?.title || album.title,
            editionDisambiguation: canonicalAlbum?.editionDisambiguation || null,
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
        libraryId?: number | null;
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
