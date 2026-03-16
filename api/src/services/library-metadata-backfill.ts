import fs from "fs";
import path from "path";
import { db } from "../database.js";
import { Config, getConfigSection } from "./config.js";
import { getNamingConfig, renderRelativePath, type NamingContext } from "./naming.js";
import {
    downloadAlbumCover,
    downloadAlbumVideoCover,
    downloadArtistPicture,
    downloadVideoThumbnail,
    saveBioFile,
    saveReviewFile,
    saveLyricsFile,
} from "./metadata-files.js";
import { embedVideoThumbnail, writeVideoTags } from "./audioUtils.js";
import { LibraryFilesService } from "./library-files.js";

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

        const artist = db.prepare("SELECT name FROM artists WHERE id = ?").get(artistId) as any;
        if (!artist) return result;

        const artistFolder = renderRelativePath(naming.artist_folder, { artistName: artist.name });

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
      FROM library_files
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
        const hasFiles = db.prepare("SELECT 1 FROM library_files WHERE artist_id = ? LIMIT 1").get(artistId);
        if (!hasFiles) return;

        const libraryRoots = Array.from(new Set(
            (db.prepare(`
                SELECT DISTINCT library_root
                FROM library_files
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
                        const resolution = typeof metadataConfig.artist_picture_resolution === "string"
                            ? parseInt(metadataConfig.artist_picture_resolution, 10)
                            : metadataConfig.artist_picture_resolution;
                        const safeRes = (resolution === 160 || resolution === 320 || resolution === 480 || resolution === 750) ? resolution : 750;
                        await downloadArtistPicture(artistId, safeRes as 160 | 320 | 480 | 750, picPath);
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

            if (metadataConfig.save_artist_bio) {
                const bioPath = path.join(artistDir, "bio.txt");
                if (!fs.existsSync(bioPath)) {
                    try {
                        await saveBioFile(artistId, bioPath);
                        if (fs.existsSync(bioPath)) {
                            this.upsertLibraryFile({
                                artistId,
                                filePath: bioPath,
                                libraryRoot,
                                fileType: "bio",
                                expectedPath: bioPath,
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
    }

    private async fillAlbumMetadata(
        artistId: string,
        artistFolder: string,
        metadataConfig: any,
        naming: ReturnType<typeof getNamingConfig>,
        result: MetadataFillResult,
    ) {
        const musicRoot = Config.getMusicPath();

        const albums = db.prepare(`
      SELECT DISTINCT a.id, a.title, a.version, a.release_date, a.num_volumes, a.video_cover, a.quality
      FROM albums a
      JOIN album_artists aa ON a.id = aa.album_id
      WHERE aa.artist_id = ?
        AND a.monitor = 1
        AND EXISTS (
          SELECT 1 FROM library_files lf
          JOIN media m ON m.id = lf.media_id
          WHERE m.album_id = a.id AND lf.file_type = 'track'
        )
    `).all(artistId) as any[];

        for (const album of albums) {
            const albumDir = this.resolveAlbumDir(musicRoot, artistFolder, album, naming);
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
                                libraryRoot: musicRoot,
                                fileType: "cover",
                                expectedPath: coverPath,
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
                                    libraryRoot: musicRoot,
                                    fileType: "video_cover",
                                    expectedPath: videoCoverPath,
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

            if (metadataConfig.save_album_review) {
                const reviewPath = path.join(albumDir, "review.txt");
                if (!fs.existsSync(reviewPath)) {
                    try {
                        await saveReviewFile(String(album.id), reviewPath);
                        if (fs.existsSync(reviewPath)) {
                            this.upsertLibraryFile({
                                artistId,
                                albumId: String(album.id),
                                filePath: reviewPath,
                                libraryRoot: musicRoot,
                                fileType: "review",
                                expectedPath: reviewPath,
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
    }

    private async fillTrackMetadata(
        artistId: string,
        metadataConfig: any,
        result: MetadataFillResult,
    ) {
        if (!metadataConfig.save_lyrics) return;

        const tracks = db.prepare(`
      SELECT lf.file_path, lf.media_id
      FROM library_files lf
      WHERE lf.artist_id = ?
        AND lf.file_type = 'track'
        AND lf.media_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM library_files lf2
          WHERE lf2.media_id = lf.media_id AND lf2.file_type = 'lyrics'
        )
    `).all(artistId) as Array<{ file_path: string; media_id: number }>;

        for (const track of tracks) {
            const ext = path.extname(track.file_path);
            const lrcPath = track.file_path.replace(new RegExp(`${ext.replace('.', '\\.')}$`), ".lrc");
            if (fs.existsSync(lrcPath)) {
                result.skipped++;
                continue;
            }

            try {
                await saveLyricsFile(String(track.media_id), lrcPath);
                if (fs.existsSync(lrcPath)) {
                    const media = db.prepare("SELECT album_id FROM media WHERE id = ?").get(track.media_id) as any;
                    this.upsertLibraryFile({
                        artistId,
                        albumId: media?.album_id ? String(media.album_id) : null,
                        mediaId: String(track.media_id),
                        filePath: lrcPath,
                        libraryRoot: path.dirname(track.file_path).split(path.sep).slice(0, -2).join(path.sep) || Config.getMusicPath(),
                        fileType: "lyrics",
                        expectedPath: lrcPath,
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
        // ---- Thumbnail backfill ----
        if (metadataConfig.save_video_thumbnail) {
            const videoRoot = Config.getVideoPath();
            const resolution = metadataConfig.video_thumbnail_resolution || "1080x720";

            const thumbnailVideos = db.prepare(`
      SELECT lf.file_path, lf.media_id, m.cover
      FROM library_files lf
      JOIN media m ON m.id = lf.media_id
      WHERE lf.artist_id = ?
        AND lf.file_type = 'video'
        AND m.cover IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM library_files lf2
          WHERE lf2.media_id = lf.media_id AND lf2.file_type = 'video_thumbnail'
        )
    `).all(artistId) as Array<{ file_path: string; media_id: number; cover: string }>;

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
                        const media = db.prepare("SELECT album_id FROM media WHERE id = ?").get(video.media_id) as any;
                        this.upsertLibraryFile({
                            artistId,
                            albumId: media?.album_id ? String(media.album_id) : null,
                            mediaId: String(video.media_id),
                            filePath: thumbPath,
                            libraryRoot: videoRoot,
                            fileType: "video_thumbnail",
                            expectedPath: thumbPath,
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

        // ---- Video tag backfill ----
        if (metadataConfig.write_audio_metadata) {
            const tagVideos = db.prepare(`
      SELECT lf.file_path, lf.media_id,
             m.title AS media_title,
             m.version AS media_version,
             m.release_date AS media_release_date,
             m.copyright AS media_copyright,
             ar.name AS artist_name,
             al.title AS album_title,
             al.copyright AS album_copyright
      FROM library_files lf
      JOIN media m ON m.id = lf.media_id
      JOIN artists ar ON ar.id = lf.artist_id
      LEFT JOIN albums al ON al.id = m.album_id
      WHERE lf.artist_id = ?
        AND lf.file_type = 'video'
    `).all(artistId) as Array<{
                file_path: string;
                media_id: number;
                media_title: string;
                media_version: string | null;
                media_release_date: string | null;
                media_copyright: string | null;
                artist_name: string;
                album_title: string | null;
                album_copyright: string | null;
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
                const copyright = video.media_copyright || video.album_copyright || undefined;

                try {
                    const proposedTags = {
                        title: videoTitle || undefined,
                        artist: video.artist_name ? [video.artist_name] : undefined,
                        album_artist: video.artist_name || undefined,
                        album: video.album_title || undefined,
                        date,
                        comment: `https://listen.tidal.com/video/${video.media_id}`,
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
        const releaseYear = album.release_date
            ? (String(album.release_date).match(/^(\d{4})/)?.[1] || null)
            : null;

        const albumContext: NamingContext = {
            artistName: "",
            albumTitle: album.title,
            albumVersion: album.version || null,
            releaseYear,
        };

        const numVolumes = Number(album.num_volumes || 1);
        const trackTemplate = numVolumes > 1 ? naming.album_track_path_multi : naming.album_track_path_single;

        const templateSegments = (trackTemplate || "").split(/[\\/]+/g).filter(Boolean);
        const templateDirSegments = templateSegments.slice(0, -1);
        const volumeDirIndex = templateDirSegments.findIndex((seg) => seg.includes("{volumeNumber"));

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

export const libraryMetadataBackfillService = new LibraryMetadataBackfillService();
