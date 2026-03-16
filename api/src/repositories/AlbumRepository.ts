import Database from "better-sqlite3";
import { BaseRepository } from "./BaseRepository.js";

/**
 * Album entity matching the new schema
 * Note: id is now INT (TIDAL album id) as primary key
 */
export interface Album {
    id: number;                    // TIDAL album id (primary key)
    artist_id: number;             // Main artist id
    title: string;                 // Album title
    version?: string;              // Album version (Deluxe, Remastered, etc)
    release_date?: string;         // Original release date
    type: string;                  // Main release type: ALBUM/EP/SINGLE
    explicit: boolean;             // Whether album is explicit or clean
    quality: string;               // retrieved from media_metadata_tag
    user_date_added?: string;      // When added to TIDAL favorites

    // Media
    cover?: string;                // Album cover UUID
    vibrant_color?: string;        // Hex color code of dominant cover color
    video_cover?: string;          // animated cover UUID

    // Counts
    num_tracks: number;            // Number of tracks
    num_volumes: number;           // Number of volumes
    num_videos: number;            // Number of videos
    duration: number;              // Total duration in seconds
    popularity?: number;           // TIDAL popularity score

    // Review
    review_text?: string;          // Full review text
    review_source?: string;        // Source of review
    review_last_updated?: string;  // When review was last updated

    // Metadata
    similar_albums?: string;       // JSON array of similar album IDs
    credits?: string;              // JSON object of album credits
    copyright?: string;            // Album copyright info
    upc?: string;                  // Universal Product Code

    // Categorization (for Plex compatibility)
    module?: string;               // Page section: ALBUMS/EPSANDSINGLES/etc
    mb_primary?: string;           // MusicBrainz primary type
    mb_secondary?: string;         // MusicBrainz secondary: live/compilation/remix

    // Monitoring & Filtering
    monitor?: boolean;             // whether to scan and download tracks
    monitored_at?: string;         // when monitoring was enabled
    monitor_lock?: boolean;        // whether monitoring is locked
    locked_at?: string;            // when lock was enabled
    last_scanned?: string;         // last time this album was scanned
    downloaded?: number;           // percentage of album's tracks downloaded
    redundant?: string;            // If redundant, points to the id of the better version
}

export interface AlbumInsert {
    id: number;
    artist_id: number;
    title: string;
    version?: string;
    release_date?: string;
    type?: string;
    explicit?: boolean;
    quality?: string;
    user_date_added?: string;
    cover?: string;
    vibrant_color?: string;
    video_cover?: string;
    num_tracks?: number;
    num_volumes?: number;
    num_videos?: number;
    duration?: number;
    popularity?: number;
    similar_albums?: string;
    credits?: string;
    copyright?: string;
    upc?: string;
    module?: string;
    mb_primary?: string;
    mb_secondary?: string;
    monitor?: boolean;
    monitor_lock?: boolean;
}

/**
 * Album Repository - handles all album database operations
 * Updated for new schema where id is INT primary key
 */
export class AlbumRepository extends BaseRepository<Album, number> {
    constructor(db: Database.Database) {
        super(db);
    }

    findById(id: number): Album | undefined {
        return this.prepare("SELECT * FROM albums WHERE id = ?")
            .get(id) as Album | undefined;
    }

    findAll(limit: number = 100, offset: number = 0): Album[] {
        return this.prepare("SELECT * FROM albums ORDER BY release_date DESC LIMIT ? OFFSET ?")
            .all(limit, offset) as Album[];
    }

    findByArtist(artistId: number, limit?: number, offset?: number): Album[] {
        const sql = limit !== undefined
            ? "SELECT * FROM albums WHERE artist_id = ? ORDER BY release_date DESC LIMIT ? OFFSET ?"
            : "SELECT * FROM albums WHERE artist_id = ? ORDER BY release_date DESC";

        const params = limit !== undefined ? [artistId, limit, offset || 0] : [artistId];
        return this.prepare(sql).all(...params) as Album[];
    }

    findMonitored(): Album[] {
        return this.prepare("SELECT * FROM albums WHERE monitor = 1 ORDER BY release_date DESC")
            .all() as Album[];
    }

    count(): number {
        const result = this.prepare("SELECT COUNT(*) as count FROM albums").get() as { count: number };
        return result.count;
    }

    countByArtist(artistId: number): number {
        const result = this.prepare("SELECT COUNT(*) as count FROM albums WHERE artist_id = ?")
            .get(artistId) as { count: number };
        return result.count;
    }

    countMonitored(): number {
        const result = this.prepare("SELECT COUNT(*) as count FROM albums WHERE monitor = 1")
            .get() as { count: number };
        return result.count;
    }

    countDownloaded(): number {
        const result = this.prepare("SELECT COUNT(*) as count FROM albums WHERE downloaded = 100")
            .get() as { count: number };
        return result.count;
    }

    /**
     * Insert album
     */
    insert(album: AlbumInsert): void {
        this.prepare(`
            INSERT INTO albums (
                id, artist_id, title, version, release_date, type,
                explicit, quality, user_date_added, cover, vibrant_color, video_cover,
                num_tracks, num_volumes, num_videos, duration, popularity,
                similar_albums, credits, copyright, upc,
                module, mb_primary, mb_secondary,
                monitor, monitor_lock
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            album.id,
            album.artist_id,
            album.title,
            album.version || null,
            album.release_date || null,
            album.type || 'ALBUM',
            album.explicit ? 1 : 0,
            album.quality || 'LOSSLESS',
            album.user_date_added || null,
            album.cover || null,
            album.vibrant_color || null,
            album.video_cover || null,
            album.num_tracks || 0,
            album.num_volumes || 1,
            album.num_videos || 0,
            album.duration || 0,
            album.popularity || null,
            album.similar_albums || null,
            album.credits || null,
            album.copyright || null,
            album.upc || null,
            album.module || null,
            album.mb_primary || null,
            album.mb_secondary || null,
            album.monitor ? 1 : 0,
            album.monitor_lock ? 1 : 0
        );
    }

    /**
     * Bulk insert albums in a transaction
     * Returns number of albums inserted
     */
    bulkInsert(albums: AlbumInsert[]): number {
        if (albums.length === 0) return 0;

        return this.transaction(() => {
            const stmt = this.prepare(`
                INSERT INTO albums (
                    id, artist_id, title, version, release_date, type,
                    explicit, quality, user_date_added, cover, vibrant_color, video_cover,
                    num_tracks, num_volumes, num_videos, duration, popularity,
                    similar_albums, credits, copyright, upc,
                    module, mb_primary, mb_secondary,
                    monitor, monitor_lock
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            let insertedCount = 0;
            for (const album of albums) {
                stmt.run(
                    album.id,
                    album.artist_id,
                    album.title,
                    album.version || null,
                    album.release_date || null,
                    album.type || 'ALBUM',
                    album.explicit ? 1 : 0,
                    album.quality || 'LOSSLESS',
                    album.user_date_added || null,
                    album.cover || null,
                    album.vibrant_color || null,
                    album.video_cover || null,
                    album.num_tracks || 0,
                    album.num_volumes || 1,
                    album.num_videos || 0,
                    album.duration || 0,
                    album.popularity || null,
                    album.similar_albums || null,
                    album.credits || null,
                    album.copyright || null,
                    album.upc || null,
                    album.module || null,
                    album.mb_primary || null,
                    album.mb_secondary || null,
                    album.monitor ? 1 : 0,
                    album.monitor_lock ? 1 : 0
                );
                insertedCount++;
            }
            return insertedCount;
        });
    }

    /**
     * Upsert album (insert or update)
     */
    upsert(album: AlbumInsert): void {
        this.prepare(`
            INSERT INTO albums (
                id, artist_id, title, version, release_date, type,
                explicit, quality, user_date_added, cover, vibrant_color, video_cover,
                num_tracks, num_volumes, num_videos, duration, popularity,
                similar_albums, credits, copyright, upc,
                module, mb_primary, mb_secondary,
                monitor, monitor_lock
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                version = excluded.version,
                release_date = COALESCE(excluded.release_date, release_date),
                cover = COALESCE(excluded.cover, cover),
                type = excluded.type,
                quality = excluded.quality,
                num_tracks = excluded.num_tracks,
                num_volumes = excluded.num_volumes,
                duration = excluded.duration,
                popularity = COALESCE(excluded.popularity, popularity)
        `).run(
            album.id,
            album.artist_id,
            album.title,
            album.version || null,
            album.release_date || null,
            album.type || 'ALBUM',
            album.explicit ? 1 : 0,
            album.quality || 'LOSSLESS',
            album.user_date_added || null,
            album.cover || null,
            album.vibrant_color || null,
            album.video_cover || null,
            album.num_tracks || 0,
            album.num_volumes || 1,
            album.num_videos || 0,
            album.duration || 0,
            album.popularity || null,
            album.similar_albums || null,
            album.credits || null,
            album.copyright || null,
            album.upc || null,
            album.module || null,
            album.mb_primary || null,
            album.mb_secondary || null,
            album.monitor ? 1 : 0,
            album.monitor_lock ? 1 : 0
        );
    }

    /**
     * Update album fields
     */
    update(id: number, updates: Partial<Album>): void {
        const fields: string[] = [];
        const values: any[] = [];

        const fieldMap: Record<string, any> = {
            monitor: updates.monitor !== undefined ? (updates.monitor ? 1 : 0) : undefined,
            monitor_lock: updates.monitor_lock !== undefined ? (updates.monitor_lock ? 1 : 0) : undefined,
            review_text: updates.review_text,
            quality: updates.quality,
            downloaded: updates.downloaded,
        };

        for (const [key, value] of Object.entries(fieldMap)) {
            if (value !== undefined) {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }

        if (fields.length === 0) return;

        values.push(id);
        this.prepare(`UPDATE albums SET ${fields.join(", ")} WHERE id = ?`)
            .run(...values);
    }

    /**
     * Set album monitoring status
     */
    setMonitored(id: number, monitored: boolean): void {
        this.prepare(`
            UPDATE albums SET 
                monitor = ?, 
                monitored_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE monitored_at END
            WHERE id = ?
        `).run(monitored ? 1 : 0, monitored ? 1 : 0, id);
    }

    /**
     * Lock album monitoring (prevents auto-changes)
     */
    setLocked(id: number, locked: boolean, wantedState?: boolean): void {
        if (wantedState !== undefined) {
            this.prepare(`
                UPDATE albums SET 
                    monitor_lock = ?, 
                    monitor = ?,
                    locked_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE locked_at END
                WHERE id = ?
            `).run(locked ? 1 : 0, wantedState ? 1 : 0, locked ? 1 : 0, id);
        } else {
            this.prepare(`
                UPDATE albums SET 
                    monitor_lock = ?, 
                    locked_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE locked_at END
                WHERE id = ?
            `).run(locked ? 1 : 0, locked ? 1 : 0, id);
        }
    }

    delete(id: number): void {
        this.prepare("DELETE FROM albums WHERE id = ?").run(id);
    }
}
