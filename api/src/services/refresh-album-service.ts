import { db } from "../database.js";
import {
    getAlbum,
    getAlbumCredits,
    getAlbumItemsCredits,
    getAlbumReview,
    getAlbumSimilar,
    getAlbumTracks,
} from "./tidal.js";
import { getConfigSection } from "./config.js";
import { createCooperativeBatcher } from "../utils/concurrent.js";
import { resolveArtistFolderForPersistence } from "./artist-paths.js";
import { ScanLevel, type ScanOptions } from "./scan-types.js";
import { isRefreshDue, shouldRefreshTracks } from "./scan-refresh-state.js";
import { enrichAlbumWithMusicBrainzRelease } from "./musicbrainz-release-catalog.js";

type SimilarAlbumSeed = {
    albumId: string;
    artistId: string;
};

export class RefreshAlbumService {
    private static shouldEnrichMusicBrainzReleases(): boolean {
        return process.env.DISCOGENIUS_ENABLE_MUSICBRAINZ_RELEASE_MATCHING !== "false";
    }

    private static async enrichAlbumMusicBrainz(albumId: string, force: boolean = false): Promise<void> {
        if (!this.shouldEnrichMusicBrainzReleases()) {
            return;
        }

        try {
            const result = await enrichAlbumWithMusicBrainzRelease(albumId, { force });
            if (result.matched) {
                console.log(
                    `[MusicBrainz] Matched album ${albumId} to release ${result.releaseId}` +
                    ` (confidence=${result.confidence?.toFixed(2)}, tracks=${result.updatedTracks || 0})`
                );
            }
        } catch (error: any) {
            console.warn(`[MusicBrainz] Failed to enrich album ${albumId}:`, error?.message || error);
        }
    }

    static getScanLevel(albumId: string): ScanLevel {
        const album = db.prepare(`
            SELECT
                a.id,
                a.review_text,
                a.credits,
                COUNT(m.id) as track_count
            FROM albums a
            LEFT JOIN media m ON a.id = m.album_id AND m.type != 'Music Video'
            WHERE a.id = ?
            GROUP BY a.id
        `).get(albumId) as {
            id?: string;
            review_text?: string | null;
            credits?: string | null;
            track_count?: number;
        } | undefined;

        if (!album) {
            return ScanLevel.NONE;
        }

        if (album.credits) {
            return ScanLevel.DEEP;
        }

        if (album.review_text !== null && album.review_text !== undefined && Number(album.track_count || 0) > 0) {
            return ScanLevel.SHALLOW;
        }

        if (album.id) {
            return ScanLevel.BASIC;
        }

        return ScanLevel.NONE;
    }

    static async scanBasic(
        albumId: string,
        artistId?: string,
        moduleOverride?: string | null,
        options: ScanOptions = {},
    ): Promise<void> {
        console.log(`[RefreshAlbumService] scanBasic for ${albumId}`);

        const monitoringConfig = getConfigSection("monitoring");
        const existingRow = db.prepare("SELECT id, last_scanned FROM albums WHERE id = ?").get(albumId) as any;
        const shouldRefreshAlbum =
            !existingRow ||
            options.forceUpdate === true ||
            isRefreshDue(existingRow?.last_scanned, monitoringConfig.album_refresh_days);

        if (existingRow && !shouldRefreshAlbum) {
            console.log(`[RefreshAlbumService] scanBasic skipped for ${albumId} (fresh)`);
            return;
        }

        const albumData = await getAlbum(albumId);
        const forceUpdate = options.forceUpdate === true;

        const primaryArtistId = albumData.artist_id || artistId;
        if (primaryArtistId) {
            const artistExists = db.prepare("SELECT id FROM artists WHERE id = ?").get(primaryArtistId);
            if (!artistExists) {
                const primaryArtistName = albumData.artist_name || "Unknown Artist";
                db.prepare(`INSERT INTO artists(id, name, monitor, path) VALUES(?, ?, 0, ?)`)
                    .run(primaryArtistId, primaryArtistName, resolveArtistFolderForPersistence({
                        artistId: primaryArtistId,
                        artistName: primaryArtistName,
                    }));
            }
        }

        const existing = db.prepare("SELECT id, monitor, monitor_lock FROM albums WHERE id = ?").get(albumId) as any;
        const existingModuleRow = artistId
            ? (db.prepare("SELECT module FROM album_artists WHERE album_id = ? AND artist_id = ?").get(albumId, artistId) as any)
            : null;
        const module = moduleOverride ?? existingModuleRow?.module ?? null;

        if (!existing) {
            db.prepare(`
                INSERT INTO albums (
                    id, artist_id, title, version, release_date, type, explicit, quality,
                    cover, vibrant_color, video_cover,
                    num_tracks, num_volumes, num_videos, duration, popularity, copyright, upc,
                    mb_primary, mb_secondary, monitor, last_scanned
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(
                albumId,
                primaryArtistId,
                albumData.title,
                albumData.version || null,
                albumData.release_date,
                albumData.type || "ALBUM",
                albumData.explicit ? 1 : 0,
                albumData.quality,
                albumData.cover,
                albumData.vibrant_color || null,
                albumData.video_cover || null,
                albumData.num_tracks || 0,
                albumData.num_volumes || 1,
                albumData.num_videos || 0,
                albumData.duration || 0,
                albumData.popularity || null,
                albumData.copyright || null,
                albumData.upc || null,
                this.getMusicBrainzPrimary(albumData.type, module, albumData.title),
                this.getMusicBrainzSecondary(albumData.type, module, albumData.title),
                0,
            );
        } else {
            const updateSql = forceUpdate
                ? `
                UPDATE albums SET
                    artist_id=?,
                    title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                    cover=?, vibrant_color=?, video_cover=?,
                    num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                    mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
                WHERE id=?
            `
                : `
                UPDATE albums SET
                    artist_id=COALESCE(?, artist_id),
                    title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                    cover=?, vibrant_color=COALESCE(?, vibrant_color), video_cover=COALESCE(?, video_cover),
                    num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                    mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
                WHERE id=?
            `;

            db.prepare(updateSql).run(
                primaryArtistId ?? null,
                albumData.title,
                albumData.version || null,
                albumData.release_date,
                albumData.type || "ALBUM",
                albumData.explicit ? 1 : 0,
                albumData.quality,
                albumData.cover,
                albumData.vibrant_color || null,
                albumData.video_cover || null,
                albumData.num_tracks || 0,
                albumData.num_volumes || 1,
                albumData.num_videos || 0,
                albumData.duration || 0,
                albumData.popularity || null,
                albumData.copyright || null,
                albumData.upc || null,
                this.getMusicBrainzPrimary(albumData.type, module, albumData.title),
                this.getMusicBrainzSecondary(albumData.type, module, albumData.title),
                albumId,
            );
        }

        await this.enrichAlbumMusicBrainz(albumId, forceUpdate);

        const includeSimilar = options.includeSimilarAlbums !== false || options.seedSimilarAlbums === true;
        const similarAlbums = includeSimilar
            ? await this.storeSimilarAlbums(albumId, forceUpdate)
            : [];

        if (options.seedSimilarAlbums !== false) {
            const { RefreshArtistService } = await import("./refresh-artist-service.js");

            for (const similar of similarAlbums) {
                try {
                    await RefreshArtistService.scanShallow(similar.artistId, {
                        monitorArtist: false,
                        includeSimilarArtists: false,
                        seedSimilarArtists: false,
                    });
                    await this.scanShallow(similar.albumId, {
                        includeSimilarAlbums: false,
                        seedSimilarAlbums: false,
                    });
                } catch (error) {
                    console.warn(`[RefreshAlbumService] Failed to seed similar album ${similar.albumId}:`, error);
                }
            }
        }

        console.log(`[RefreshAlbumService] scanBasic complete for ${albumId}`);
    }

    static async scanShallow(albumId: string, options: ScanOptions = {}): Promise<void> {
        console.log(`[RefreshAlbumService] scanShallow for ${albumId}`);

        const monitoringConfig = getConfigSection("monitoring");
        const existing = db.prepare(`SELECT review_text, last_scanned FROM albums WHERE id = ?`).get(albumId) as any;
        const shouldRefreshAlbumMeta =
            options.forceUpdate === true ||
            !existing ||
            isRefreshDue(existing?.last_scanned, monitoringConfig.album_refresh_days);

        if (shouldRefreshAlbumMeta) {
            await this.scanBasic(albumId, undefined, undefined, options);
        } else {
            console.log(`[RefreshAlbumService] Skipping album metadata refresh for ${albumId} (fresh)`);
        }

        const shouldRefreshTrackList =
            options.forceUpdate === true ||
            shouldRefreshTracks(albumId, monitoringConfig.track_refresh_days);
        if (shouldRefreshTrackList) {
            await this.scanTracks(albumId);
        } else {
            console.log(`[RefreshAlbumService] Skipping track refresh for album ${albumId} (fresh)`);
        }

        const shouldRefreshReview =
            options.forceUpdate === true ||
            existing?.review_text == null ||
            shouldRefreshAlbumMeta;

        if (shouldRefreshReview) {
            try {
                const review = await getAlbumReview(albumId);
                const reviewText = review?.text ?? null;
                const reviewSource = review?.source ?? null;
                const reviewUpdated = review?.lastUpdated ?? null;

                if (review !== null && review !== undefined) {
                    db.prepare(`
                        UPDATE albums
                        SET review_text = ?, review_source = ?, review_last_updated = ?
                        WHERE id = ?
                    `).run(reviewText ?? "", reviewSource, reviewUpdated, albumId);
                } else if (options.forceUpdate === true || existing?.review_text == null) {
                    db.prepare(`
                        UPDATE albums
                        SET review_text = ?, review_source = ?, review_last_updated = ?
                        WHERE id = ?
                    `).run("", reviewSource, reviewUpdated, albumId);
                }
            } catch (error) {
                console.warn(`[RefreshAlbumService] Failed to fetch review for album ${albumId}:`, error);
            }
        } else {
            console.log(`[RefreshAlbumService] Skipping review refresh for album ${albumId} (fresh)`);
        }

        console.log(`[RefreshAlbumService] scanShallow complete for ${albumId}`);
    }

    static async scanDeep(albumId: string, options: ScanOptions = {}): Promise<void> {
        console.log(`[RefreshAlbumService] scanDeep for ${albumId}`);

        const currentLevel = this.getScanLevel(albumId);
        if (options.forceUpdate || currentLevel < ScanLevel.SHALLOW) {
            console.log(`[RefreshAlbumService] Album ${albumId} running SHALLOW scan (refresh=${options.forceUpdate === true})`);
            await this.scanShallow(albumId, options);
        }

        try {
            const credits = await getAlbumCredits(albumId);
            if (credits && credits.length > 0) {
                db.prepare("UPDATE albums SET credits = ? WHERE id = ?")
                    .run(JSON.stringify(credits), albumId);
            }
        } catch (error) {
            console.warn(`[RefreshAlbumService] Failed to fetch credits for album ${albumId}:`, error);
        }

        try {
            const trackCreditsMap = await getAlbumItemsCredits(albumId);
            if (trackCreditsMap.size > 0) {
                const updateTrackCredits = db.prepare("UPDATE media SET credits = ? WHERE id = ? AND album_id = ?");
                db.transaction(() => {
                    for (const [trackId, credits] of trackCreditsMap) {
                        updateTrackCredits.run(JSON.stringify(credits), trackId, albumId);
                    }
                })();
            }
        } catch (error) {
            console.warn(`[RefreshAlbumService] Failed to fetch per-track credits for album ${albumId}:`, error);
        }

        db.prepare("UPDATE albums SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?").run(albumId);

        console.log(`[RefreshAlbumService] scanDeep complete for ${albumId}`);
    }

    static async scanTracks(albumId: string): Promise<void> {
        const tracks = await getAlbumTracks(albumId);
        console.log(`[RefreshAlbumService] Fetched ${tracks.length} tracks for album ${albumId}`);

        const album = db.prepare("SELECT id, artist_id, type, monitor FROM albums WHERE id = ?").get(albumId) as any;
        if (!album) {
            console.warn(`[RefreshAlbumService] Album ${albumId} not found, skipping tracks`);
            return;
        }

        const trackInsert = db.prepare(`
            INSERT INTO media (
                id, artist_id, album_id, title, version, release_date, type, explicit, quality,
                track_number, volume_number, duration, popularity,
                bpm, key, key_scale, peak, replay_gain,
                credits, copyright, isrc, monitor, last_scanned, downloaded
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0)
        `);

        const trackUpdate = db.prepare(`
            UPDATE media SET
                artist_id=?,
                title=?, version=?, release_date=?, explicit=?, quality=?,
                track_number=?, volume_number=?, duration=?, popularity=?,
                bpm=?, key=?, key_scale=?, peak=?, replay_gain=?,
                credits=?, copyright=?, last_scanned=CURRENT_TIMESTAMP
            WHERE id=? AND album_id=?
        `);

        const selectArtist = db.prepare("SELECT id FROM artists WHERE id = ?");
        const insertArtist = db.prepare("INSERT INTO artists(id, name, monitor, path) VALUES(?, ?, 0, ?)");
        const selectMedia = db.prepare("SELECT id, monitor, monitor_lock FROM media WHERE id = ? AND album_id = ?");

        const cooperateTrackStore = createCooperativeBatcher(25);
        const trackBatch: any[] = [];
        for (const track of tracks) {
            const trackArtistId = track.artist_id || album.artist_id;
            track.artist_id = trackArtistId;
            trackBatch.push(track);

            if (trackBatch.length >= 25 || track === tracks[tracks.length - 1]) {
                db.transaction(() => {
                    for (const currentTrack of trackBatch) {
                        const currentTrackArtistId = currentTrack.artist_id;

                        if (currentTrackArtistId && currentTrackArtistId !== album.artist_id) {
                            const artistExists = selectArtist.get(currentTrackArtistId);
                            if (!artistExists) {
                                let artistName = "Unknown Artist";
                                if (currentTrack.artists && Array.isArray(currentTrack.artists)) {
                                    const found = currentTrack.artists.find((artist: any) => String(artist.id) === String(currentTrackArtistId));
                                    if (found) {
                                        artistName = found.name;
                                    }
                                }

                                insertArtist.run(currentTrackArtistId, artistName, resolveArtistFolderForPersistence({
                                    artistId: currentTrackArtistId,
                                    artistName,
                                }));
                            }
                        }

                        const exists = selectMedia.get(currentTrack.tidal_id, albumId) as any;

                        let shouldMonitor = exists?.monitor || (album?.monitor ? 1 : 0);
                        if (exists?.monitor_lock) {
                            shouldMonitor = exists.monitor;
                        }

                        if (!exists) {
                            trackInsert.run(
                                currentTrack.tidal_id,
                                currentTrackArtistId,
                                albumId,
                                currentTrack.title,
                                currentTrack.version || null,
                                currentTrack.release_date || null,
                                album.type,
                                currentTrack.explicit ? 1 : 0,
                                currentTrack.quality,
                                currentTrack.track_number || 0,
                                currentTrack.volume_number || 1,
                                currentTrack.duration,
                                currentTrack.popularity || 0,
                                currentTrack.bpm || null,
                                currentTrack.key || null,
                                currentTrack.key_scale || null,
                                currentTrack.peak || null,
                                currentTrack.replay_gain || null,
                                null,
                                currentTrack.copyright || null,
                                currentTrack.isrc || null,
                                shouldMonitor,
                            );
                        } else {
                            trackUpdate.run(
                                currentTrackArtistId,
                                currentTrack.title,
                                currentTrack.version || null,
                                currentTrack.release_date || null,
                                currentTrack.explicit ? 1 : 0,
                                currentTrack.quality,
                                currentTrack.track_number || 0,
                                currentTrack.volume_number || 1,
                                currentTrack.duration,
                                currentTrack.popularity || 0,
                                currentTrack.bpm || null,
                                currentTrack.key || null,
                                currentTrack.key_scale || null,
                                currentTrack.peak || null,
                                currentTrack.replay_gain || null,
                                null,
                                currentTrack.copyright || null,
                                currentTrack.tidal_id,
                                albumId,
                            );
                        }

                        this.storeTrackArtists(currentTrack);
                    }
                })();
                trackBatch.length = 0;
                await cooperateTrackStore();
            }
        }
    }

    static async upsertArtistAlbum(
        album: any,
        scanningArtistId: string,
        albumModuleMap: Map<string, string>,
        options: ScanOptions,
    ): Promise<boolean> {
        const forceUpdate = options.forceUpdate === true;
        const primaryArtistId = album.artist_id;

        const artistExists = db.prepare("SELECT id FROM artists WHERE id = ?").get(primaryArtistId);
        if (!artistExists && primaryArtistId !== scanningArtistId) {
            const primaryArtistName = album.artist_name || "Unknown Artist";
            db.prepare("INSERT INTO artists (id, name, monitor, path) VALUES (?, ?, 0, ?)")
                .run(primaryArtistId, primaryArtistName, resolveArtistFolderForPersistence({
                    artistId: primaryArtistId,
                    artistName: primaryArtistName,
                }));
        }

        const exists = db.prepare("SELECT id, monitor, monitor_lock FROM albums WHERE id = ?").get(album.tidal_id) as any;
        const shouldMonitor = exists?.monitor || 0;
        const moduleFromPage = albumModuleMap.get(album.tidal_id) || album._module || null;

        if (!exists) {
            db.prepare(`
                INSERT INTO albums (
                    id, artist_id, title, version, release_date, type, explicit, quality,
                    cover, vibrant_color, video_cover,
                    num_tracks, num_volumes, num_videos, duration, popularity, copyright, upc,
                    mb_primary, mb_secondary, monitor
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                album.tidal_id,
                primaryArtistId,
                album.title,
                album.version || null,
                album.release_date,
                album.type || "ALBUM",
                album.explicit ? 1 : 0,
                album.quality,
                album.cover,
                album.vibrant_color || null,
                album.video_cover || null,
                album.num_tracks || 0,
                album.num_volumes || 1,
                album.num_videos || 0,
                album.duration || 0,
                album.popularity || null,
                album.copyright || null,
                album.upc || null,
                this.getMusicBrainzPrimary(album.type, moduleFromPage, album.title),
                this.getMusicBrainzSecondary(album.type, moduleFromPage, album.title),
                shouldMonitor,
            );
        } else {
            const updateSql = forceUpdate
                ? `
                UPDATE albums SET
                    artist_id=?,
                    title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                    cover=?, vibrant_color=?, video_cover=?,
                    num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                    mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
                WHERE id=?
            `
                : `
                UPDATE albums SET
                    artist_id=COALESCE(?, artist_id),
                    title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                    cover=?, vibrant_color=COALESCE(?, vibrant_color), video_cover=COALESCE(?, video_cover),
                    num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                    mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
                WHERE id=?
            `;

            db.prepare(updateSql).run(
                primaryArtistId ?? null,
                album.title,
                album.version || null,
                album.release_date,
                album.type || "ALBUM",
                album.explicit ? 1 : 0,
                album.quality,
                album.cover,
                album.vibrant_color || null,
                album.video_cover || null,
                album.num_tracks || 0,
                album.num_volumes || 1,
                album.num_videos || 0,
                album.duration || 0,
                album.popularity || null,
                album.copyright || null,
                album.upc || null,
                this.getMusicBrainzPrimary(album.type, moduleFromPage, album.title),
                this.getMusicBrainzSecondary(album.type, moduleFromPage, album.title),
                album.tidal_id,
            );
        }

        await this.enrichAlbumMusicBrainz(String(album.tidal_id), forceUpdate);

        const albumGroup = album._group_type || album._group || "ALBUMS";

        const upsertScannedRelation = db.prepare(`
            INSERT INTO album_artists (album_id, artist_id, artist_name, ord, type, group_type, module)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(artist_id, album_id) DO UPDATE SET
                artist_name = COALESCE(excluded.artist_name, album_artists.artist_name),
                ord = COALESCE(excluded.ord, album_artists.ord),
                type = excluded.type,
                group_type = excluded.group_type,
                module = excluded.module
        `);

        const upsertRelatedRelation = db.prepare(`
            INSERT INTO album_artists (album_id, artist_id, artist_name, ord, type, group_type, module)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(artist_id, album_id) DO UPDATE SET
                artist_name = COALESCE(excluded.artist_name, album_artists.artist_name),
                ord = COALESCE(excluded.ord, album_artists.ord),
                type = excluded.type,
                group_type = COALESCE(album_artists.group_type, excluded.group_type),
                module = COALESCE(album_artists.module, excluded.module)
        `);

        const participants = new Map<string, { name: string | null; ord: number | null }>();
        const setParticipant = (participantArtistId: string, name: string | null, ord: number | null) => {
            if (!participantArtistId) return;
            const key = String(participantArtistId);
            if (!participants.has(key)) {
                participants.set(key, { name, ord });
                return;
            }

            const current = participants.get(key)!;
            participants.set(key, {
                name: current.name || name,
                ord: current.ord ?? ord,
            });
        };

        setParticipant(scanningArtistId, scanningArtistId === primaryArtistId ? album.artist_name || null : null, 0);
        setParticipant(primaryArtistId, album.artist_name || null, 0);

        if (album.artists && Array.isArray(album.artists)) {
            for (let index = 0; index < album.artists.length; index += 1) {
                const artist = album.artists[index];
                const otherArtistId = artist?.id?.toString?.() ?? String(artist?.id ?? "");
                if (!otherArtistId || otherArtistId === "undefined" || otherArtistId === "null") continue;
                setParticipant(otherArtistId, artist?.name || null, index);
            }
        }

        const scanningType = primaryArtistId === scanningArtistId ? "MAIN" : "APPEARS_ON";
        const scanningParticipant = participants.get(String(scanningArtistId));
        upsertScannedRelation.run(
            album.tidal_id,
            scanningArtistId,
            scanningParticipant?.name || null,
            scanningParticipant?.ord ?? null,
            scanningType,
            albumGroup,
            moduleFromPage,
        );

        if (primaryArtistId && primaryArtistId !== scanningArtistId) {
            const primaryParticipant = participants.get(String(primaryArtistId));
            upsertRelatedRelation.run(
                album.tidal_id,
                primaryArtistId,
                primaryParticipant?.name || album.artist_name || null,
                primaryParticipant?.ord ?? 0,
                "MAIN",
                null,
                null,
            );
        }

        if (album.artists && Array.isArray(album.artists)) {
            for (const artist of album.artists) {
                const otherArtistId = artist?.id?.toString?.() ?? String(artist?.id ?? "");
                if (!otherArtistId || otherArtistId === "undefined" || otherArtistId === "null") continue;
                if (otherArtistId !== scanningArtistId && otherArtistId !== primaryArtistId) {
                    const otherArtistExists = db.prepare("SELECT id FROM artists WHERE id = ?").get(otherArtistId);
                    if (!otherArtistExists) {
                        const otherArtistName = artist.name || "Unknown Artist";
                        db.prepare("INSERT INTO artists(id, name, monitor, path) VALUES(?, ?, 0, ?)")
                            .run(otherArtistId, otherArtistName, resolveArtistFolderForPersistence({
                                artistId: otherArtistId,
                                artistName: otherArtistName,
                            }));
                    }
                    const participant = participants.get(otherArtistId);
                    upsertRelatedRelation.run(
                        album.tidal_id,
                        otherArtistId,
                        participant?.name || artist.name || null,
                        participant?.ord ?? null,
                        "MAIN",
                        null,
                        null,
                    );
                }
            }
        }

        return !exists;
    }

    private static async storeSimilarAlbums(
        albumId: string,
        forceUpdate: boolean = false,
    ): Promise<SimilarAlbumSeed[]> {
        try {
            const similarAlbums = await getAlbumSimilar(albumId);
            const ids = new Set<string>();
            const pairs: SimilarAlbumSeed[] = [];

            const upsertArtist = db.prepare(`
                INSERT INTO artists (id, name, monitor, path)
                VALUES (?, ?, 0, ?)
                ON CONFLICT(id) DO UPDATE SET
                    ${forceUpdate
                        ? `
                    name = excluded.name,
                    path = COALESCE(artists.path, excluded.path)
                    `
                        : `
                    name = COALESCE(excluded.name, name),
                    path = COALESCE(artists.path, excluded.path)
                    `}
            `);

            const upsertAlbum = db.prepare(`
                INSERT INTO albums (
                    id, artist_id, title, version, release_date, type, explicit, quality,
                    cover, vibrant_color, video_cover,
                    num_tracks, num_volumes, num_videos, duration, popularity, copyright, upc,
                    mb_primary, mb_secondary, monitor
                ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 0, 1, 0, 0, ?, NULL, NULL, NULL, NULL, 0)
                ON CONFLICT(id) DO UPDATE SET
                    ${forceUpdate
                        ? `
                    artist_id = excluded.artist_id,
                    title = excluded.title,
                    release_date = excluded.release_date,
                    cover = excluded.cover,
                    type = excluded.type,
                    explicit = excluded.explicit,
                    quality = excluded.quality,
                    popularity = excluded.popularity
                    `
                        : `
                    artist_id = COALESCE(excluded.artist_id, artist_id),
                    title = COALESCE(excluded.title, title),
                    release_date = COALESCE(excluded.release_date, release_date),
                    cover = COALESCE(excluded.cover, cover),
                    type = COALESCE(excluded.type, type),
                    explicit = COALESCE(excluded.explicit, explicit),
                    quality = COALESCE(excluded.quality, quality),
                    popularity = COALESCE(excluded.popularity, popularity)
                    `}
            `);

            const deleteRelations = db.prepare("DELETE FROM similar_albums WHERE album_id = ?");
            const insertRelation = db.prepare(`
                INSERT OR IGNORE INTO similar_albums (album_id, similar_album_id)
                VALUES (?, ?)
            `);

            const transaction = db.transaction((items: any[]) => {
                deleteRelations.run(albumId);
                for (const similarAlbum of items) {
                    const similarAlbumId = similarAlbum?.tidal_id?.toString?.() ?? String(similarAlbum?.tidal_id ?? "");
                    const similarArtistId = similarAlbum?.artist_id?.toString?.() ?? String(similarAlbum?.artist_id ?? "");
                    if (!similarAlbumId || !similarArtistId) continue;
                    if (similarAlbumId === String(albumId)) continue;
                    if (ids.has(similarAlbumId)) continue;
                    ids.add(similarAlbumId);
                    pairs.push({ albumId: similarAlbumId, artistId: similarArtistId });
                    upsertArtist.run(
                        similarArtistId,
                        similarAlbum?.artist_name || "Unknown Artist",
                        resolveArtistFolderForPersistence({
                            artistId: similarArtistId,
                            artistName: similarAlbum?.artist_name || "Unknown Artist",
                        }),
                    );
                    upsertAlbum.run(
                        similarAlbumId,
                        similarArtistId,
                        similarAlbum?.title || "Unknown Album",
                        similarAlbum?.release_date || null,
                        similarAlbum?.type || "ALBUM",
                        similarAlbum?.explicit ? 1 : 0,
                        similarAlbum?.quality || null,
                        similarAlbum?.cover || null,
                        similarAlbum?.popularity || null,
                    );
                    insertRelation.run(albumId, similarAlbumId);
                }
            });

            transaction(similarAlbums || []);
            return pairs;
        } catch (error) {
            console.warn(`[RefreshAlbumService] Failed to fetch/store similar albums for ${albumId}:`, error);
        }

        return [];
    }

    private static storeTrackArtists(track: any): void {
        const mediaId = track?.tidal_id?.toString?.() ?? String(track?.tidal_id ?? "");
        if (!mediaId) return;

        db.prepare("DELETE FROM media_artists WHERE media_id = ?").run(mediaId);

        let trackArtists = [];
        try {
            trackArtists = typeof track.artists === "string"
                ? JSON.parse(track.artists)
                : (track.artists || []);
        } catch {
            trackArtists = [];
        }

        if (!Array.isArray(trackArtists)) trackArtists = [];

        const primaryArtistId = track?.artist_id?.toString?.() ?? String(track?.artist_id ?? "");
        const primaryArtistName = track?.artist_name || null;

        const upsertArtist = db.prepare(`
            INSERT INTO artists (id, name, picture, popularity, monitor, path)
            VALUES (?, ?, ?, 0, 0, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = CASE
                    WHEN artists.name = 'Unknown Artist' AND excluded.name <> 'Unknown Artist' THEN excluded.name
                    ELSE artists.name
                END,
                picture = COALESCE(artists.picture, excluded.picture),
                path = COALESCE(artists.path, excluded.path)
        `);

        const insertMediaArtist = db.prepare(`
            INSERT INTO media_artists (media_id, artist_id, type) VALUES (?, ?, ?)
        `);

        const normalizeRole = (value: unknown): "MAIN" | "FEATURED" | null => {
            if (value === null || value === undefined) return null;
            const normalized = String(value).trim().toUpperCase();
            if (!normalized) return null;
            if (normalized === "MAIN" || normalized === "PRIMARY") return "MAIN";
            if (normalized === "FEATURED" || normalized === "FEATURE") return "FEATURED";
            return null;
        };

        const byArtistId = new Map<string, { name: string; picture: string | null; type: "MAIN" | "FEATURED" }>();

        for (const artist of trackArtists) {
            const artistId = artist?.id?.toString?.() ?? String(artist?.id ?? "");
            if (!artistId || artistId === "undefined" || artistId === "null") continue;

            const roleFromApi = normalizeRole(artist?.type);
            const inferredRole: "MAIN" | "FEATURED" =
                roleFromApi ?? (primaryArtistId && artistId === primaryArtistId ? "MAIN" : "FEATURED");

            const name = artist?.name || (artistId === primaryArtistId ? (primaryArtistName || "Unknown Artist") : "Unknown Artist");
            const picture = artist?.picture || null;

            const existing = byArtistId.get(artistId);
            if (!existing) {
                byArtistId.set(artistId, { name, picture, type: inferredRole });
                continue;
            }

            const mergedType: "MAIN" | "FEATURED" = (existing.type === "MAIN" || inferredRole === "MAIN") ? "MAIN" : "FEATURED";
            byArtistId.set(artistId, {
                name: existing.name !== "Unknown Artist" ? existing.name : name,
                picture: existing.picture ?? picture,
                type: mergedType,
            });
        }

        if (primaryArtistId && !byArtistId.has(primaryArtistId)) {
            byArtistId.set(primaryArtistId, {
                name: primaryArtistName || "Unknown Artist",
                picture: null,
                type: "MAIN",
            });
        }

        const transaction = db.transaction(() => {
            for (const [artistId, info] of byArtistId) {
                const artistName = info.name || "Unknown Artist";
                upsertArtist.run(artistId, artistName, info.picture, resolveArtistFolderForPersistence({
                    artistId,
                    artistName,
                }));
                insertMediaArtist.run(mediaId, artistId, info.type);
            }
        });

        transaction();
    }

    private static getMusicBrainzPrimary(tidalType: string | undefined, module: string | undefined, title: string = ""): string {
        if (this.getMusicBrainzSecondary(tidalType, module, title) !== null) {
            return "album";
        }
        const type = (tidalType || "ALBUM").toUpperCase();
        switch (type) {
            case "SINGLE": return "single";
            case "EP": return "ep";
            case "ALBUM":
            default: return "album";
        }
    }

    private static getMusicBrainzSecondary(tidalType: string | undefined, module: string | undefined, title: string = ""): string | null {
        const normalizedModule = (module || "").toUpperCase();
        const lowerTitle = (title || "").toLowerCase();

        if (normalizedModule === "LIVE" || normalizedModule === "ARTIST_LIVE_ALBUMS") return "live";
        if (normalizedModule === "COMPILATION" || normalizedModule === "ARTIST_COMPILATIONS") return "compilation";
        if (normalizedModule === "DJ_MIXES") return "dj-mix";
        if (normalizedModule === "APPEARS_ON") return null;

        if (lowerTitle.includes("soundtrack") || lowerTitle.includes("o.s.t.") || lowerTitle.includes("original score") || lowerTitle.includes("motion picture")) {
            return "soundtrack";
        }
        if (lowerTitle.includes("remix") || lowerTitle.includes("remixed") || lowerTitle.includes("remixes")) {
            return "remix";
        }

        return null;
    }
}
