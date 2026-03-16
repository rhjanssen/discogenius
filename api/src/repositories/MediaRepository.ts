import Database from "better-sqlite3";
import { BaseRepository } from "./BaseRepository.js";

/**
 * Media entity - unified representation for tracks and videos
 * Based on the new schema where media table stores both types
 * 
 * Type values:
 * - Tracks: type inherits from album type (ALBUM, EP, SINGLE)
 * - Videos: type = 'Music Video' (may or may not have album_id)
 * 
 * Quality values (stored in `quality` column):
 * - For tracks: mediaMetadata.tags from Tidal API (LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS)
 * - For videos: video quality from Tidal API (MP4_1080P, MP4_720P, etc.)
 */
export interface Media {
    id: number;                    // TIDAL track or video id (primary key)
    artist_id: number;             // Main artist id
    album_id?: number;             // Album id (NULL for videos, set for tracks)
    title: string;                 // Track or video title
    version?: string;              // version specifier (Remastered, etc)
    release_date?: string;         // Original release date
    type: string;                  // Media type: ALBUM/EP/SINGLE (for tracks) or 'Music Video'
    explicit: boolean;             // Whether track is explicit or clean
    quality: string;               // For tracks: metadata tag (LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS)
    // For videos: video quality (MP4_1080P, MP4_720P, etc.)
    user_date_added?: string;      // When added to TIDAL favorites

    // Positioning (primarily for tracks)
    track_number?: number;         // Track number on album
    volume_number?: number;        // Volume number on album
    duration?: number;             // Duration in seconds
    popularity?: number;           // TIDAL popularity score

    // Music Theory
    bpm?: number;                  // Beats per minute
    key?: string;                  // Musical key (C, D, etc)
    key_scale?: string;            // Major/minor

    // Audio Engineering
    peak?: number;                 // Peak amplitude
    replay_gain?: number;          // For normalization

    // Metadata
    credits?: string;              // JSON object of track credits
    copyright?: string;
    isrc?: string;

    // Monitoring & Filtering
    monitor: boolean;              // whether to scan and download this media
    monitored_at?: string;         // when monitoring was enabled
    monitor_lock: boolean;         // whether monitoring is locked
    locked_at?: string;            // when lock was enabled
    last_scanned?: string;         // last time this media was scanned for changes
    downloaded: boolean;           // whether this media has been downloaded
    redundant?: string;            // If redundant, points to the id of the better version
}

export interface MediaInsert {
    id: number;
    artist_id: number;
    album_id?: number;
    title: string;
    version?: string;
    release_date?: string;
    type: string;                  // 'track' or 'video'
    explicit?: boolean;
    quality?: string;
    user_date_added?: string;
    track_number?: number;
    volume_number?: number;
    duration?: number;
    popularity?: number;
    bpm?: number;
    key?: string;
    key_scale?: string;
    peak?: number;
    replay_gain?: number;
    credits?: string;
    copyright?: string;
    isrc?: string;
    monitor?: boolean;
}

/**
 * Library types for categorization
 */
export type LibraryType = 'music' | 'dolby_atmos' | 'music_video';

/**
 * Quality profiles based on tidal-dl-ng download settings
 * Maps to tidal-dl-ng quality_audio: 'LOW' | 'HIGH' | 'LOSSLESS' | 'HIRES_LOSSLESS'
 */
export type QualityProfile = 'max' | 'high' | 'normal' | 'low';

/**
 * Audio quality tags from Tidal's mediaMetadata.tags
 * These are the only values we store for tracks (videos use different quality values)
 */
export type AudioQualityTag = 'HIRES_LOSSLESS' | 'LOSSLESS' | 'DOLBY_ATMOS';

/**
 * Video quality values from Tidal's video.quality field
 */
export type VideoQuality = 'MP4_1080P' | 'MP4_720P' | 'MP4_480P' | 'MP4_360P';

/**
 * Helper function to extract the highest quality tag from mediaMetadata.tags
 * Quality priority: DOLBY_ATMOS > HIRES_LOSSLESS > LOSSLESS
 * 
 * Note: When the API returns both HIRES_LOSSLESS and LOSSLESS, we only store
 * the highest quality tag (HIRES_LOSSLESS)
 */
export function getHighestQualityTag(tags: string[] | string | null | undefined): string {
    if (!tags) return 'LOSSLESS';

    const tagArray = typeof tags === 'string'
        ? tags.split(',').map(t => t.trim()).filter(Boolean)
        : tags;

    // Priority order (highest first)
    const priorityOrder = ['DOLBY_ATMOS', 'HIRES_LOSSLESS', 'LOSSLESS'];

    for (const priority of priorityOrder) {
        if (tagArray.includes(priority)) {
            return priority;
        }
    }

    return 'LOSSLESS';
}

/**
 * Get quality rank based on quality profile and library type
 * 
 * Quality profiles for standard music library:
 * - Max: HIRES_LOSSLESS > LOSSLESS, exclude DOLBY_ATMOS
 * - High/Normal/Low: LOSSLESS > HIRES_LOSSLESS, exclude DOLBY_ATMOS
 * 
 * For Dolby Atmos library: Only DOLBY_ATMOS content included
 * For Music Videos: Ranked by resolution (1080p > 720p > 480p > 360p)
 * 
 * @param quality - The quality tag (HIRES_LOSSLESS, LOSSLESS, DOLBY_ATMOS) or video quality
 * @param profile - The quality profile setting (max, high, normal, low)
 * @param libraryType - The library type (music, dolby_atmos, music_video)
 * @returns Rank number (higher is better), -1 if should be excluded
 */
export function getQualityRank(
    quality: string | null | undefined,
    profile: QualityProfile = 'max',
    libraryType: LibraryType = 'music'
): number {
    if (!quality) return 0;

    const normalizedQuality = quality.toUpperCase();

    // Handle music videos - ranked by resolution, no filtering
    if (libraryType === 'music_video') {
        const videoRanks: Record<string, number> = {
            'MP4_1080P': 4,
            'MP4_720P': 3,
            'MP4_480P': 2,
            'MP4_360P': 1,
        };
        return videoRanks[normalizedQuality] || 0;
    }

    // Handle Dolby Atmos library - only DOLBY_ATMOS is valid
    if (libraryType === 'dolby_atmos') {
        return normalizedQuality === 'DOLBY_ATMOS' ? 1 : -1; // -1 means exclude
    }

    // Standard music library - exclude DOLBY_ATMOS
    if (normalizedQuality === 'DOLBY_ATMOS') {
        return -1; // Exclude from standard music library
    }

    // Quality ranking for standard music library based on profile
    if (profile === 'max') {
        // Max profile: Prefer Hi-Res (24-bit) over standard Lossless (16-bit)
        const ranks: Record<string, number> = {
            'HIRES_LOSSLESS': 2,
            'LOSSLESS': 1,
        };
        return ranks[normalizedQuality] || 0;
    } else {
        // High/Normal/Low profiles: Prefer standard Lossless over Hi-Res
        // For these profiles, we download Lossless and let tidal-dl-ng handle conversion
        // Hi-Res files are larger with no benefit when converting to lossy
        const ranks: Record<string, number> = {
            'LOSSLESS': 2,
            'HIRES_LOSSLESS': 1,
        };
        return ranks[normalizedQuality] || 0;
    }
}

/**
 * Filter media items by library type
 * 
 * @param items - Array of items with quality property
 * @param libraryType - Target library type
 * @returns Filtered array with only items appropriate for the library
 */
export function filterByLibraryType<T extends { quality?: string | null }>(
    items: T[],
    libraryType: LibraryType
): T[] {
    return items.filter(item => {
        const rank = getQualityRank(item.quality, 'max', libraryType);
        return rank >= 0; // -1 means exclude
    });
}

/**
 * Check if a quality tag is valid for a library type
 */
export function isQualityValidForLibrary(
    quality: string | null | undefined,
    libraryType: LibraryType
): boolean {
    return getQualityRank(quality, 'max', libraryType) >= 0;
}

/**
 * Media Repository - handles all media (tracks and videos) database operations
 * Unified table approach as per new schema
 */
export class MediaRepository extends BaseRepository<Media, number> {
    constructor(db: Database.Database) {
        super(db);
    }

    findById(id: number): Media | undefined {
        return this.prepare("SELECT * FROM media WHERE id = ?")
            .get(id) as Media | undefined;
    }

    findAll(limit: number = 100, offset: number = 0): Media[] {
        return this.prepare("SELECT * FROM media ORDER BY id DESC LIMIT ? OFFSET ?")
            .all(limit, offset) as Media[];
    }

    /**
     * Find media by logical type (track or video)
     * Videos have type = 'Music Video', tracks have any other type (ALBUM, EP, SINGLE)
     */
    findByType(type: 'track' | 'video', limit: number = 100, offset: number = 0): Media[] {
        if (type === 'track') {
            return this.prepare("SELECT * FROM media WHERE type != 'Music Video' ORDER BY id DESC LIMIT ? OFFSET ?")
                .all(limit, offset) as Media[];
        } else {
            return this.prepare("SELECT * FROM media WHERE type = 'Music Video' ORDER BY id DESC LIMIT ? OFFSET ?")
                .all(limit, offset) as Media[];
        }
    }

    findByAlbum(albumId: number): Media[] {
        return this.prepare("SELECT * FROM media WHERE album_id = ? ORDER BY volume_number, track_number")
            .all(albumId) as Media[];
    }

    findByArtist(artistId: number, type?: 'track' | 'video', limit?: number, offset?: number): Media[] {
        let sql = "SELECT * FROM media WHERE artist_id = ?";
        const params: any[] = [artistId];

        if (type === 'track') {
            sql += " AND type != 'Music Video'";
        } else if (type === 'video') {
            sql += " AND type = 'Music Video'";
        }

        sql += " ORDER BY release_date DESC";

        if (limit !== undefined) {
            sql += " LIMIT ? OFFSET ?";
            params.push(limit, offset || 0);
        }

        return this.prepare(sql).all(...params) as Media[];
    }

    count(type?: 'track' | 'video'): number {
        let sql: string;
        if (type === 'track') {
            sql = "SELECT COUNT(*) as count FROM media WHERE type != 'Music Video'";
        } else if (type === 'video') {
            sql = "SELECT COUNT(*) as count FROM media WHERE type = 'Music Video'";
        } else {
            sql = "SELECT COUNT(*) as count FROM media";
        }
        const result = this.prepare(sql).get() as { count: number };
        return result.count;
    }

    countByAlbum(albumId: number): number {
        const result = this.prepare("SELECT COUNT(*) as count FROM media WHERE album_id = ?")
            .get(albumId) as { count: number };
        return result.count;
    }

    countDownloaded(type?: 'track' | 'video'): number {
        let sql: string;
        if (type === 'track') {
            sql = "SELECT COUNT(*) as count FROM media WHERE type != 'Music Video' AND downloaded = 1";
        } else if (type === 'video') {
            sql = "SELECT COUNT(*) as count FROM media WHERE type = 'Music Video' AND downloaded = 1";
        } else {
            sql = "SELECT COUNT(*) as count FROM media WHERE downloaded = 1";
        }
        const result = this.prepare(sql).get() as { count: number };
        return result.count;
    }

    countMonitored(type?: 'track' | 'video'): number {
        let sql: string;
        if (type === 'track') {
            sql = "SELECT COUNT(*) as count FROM media WHERE type != 'Music Video' AND monitor = 1";
        } else if (type === 'video') {
            sql = "SELECT COUNT(*) as count FROM media WHERE type = 'Music Video' AND monitor = 1";
        } else {
            sql = "SELECT COUNT(*) as count FROM media WHERE monitor = 1";
        }
        const result = this.prepare(sql).get() as { count: number };
        return result.count;
    }

    /**
     * Insert a single media item
     */
    insert(media: MediaInsert): void {
        this.prepare(`
            INSERT INTO media (
                id, artist_id, album_id, title, version, release_date, type,
                explicit, quality, user_date_added, track_number, volume_number,
                duration, popularity, bpm, key, key_scale, peak, replay_gain,
                credits, copyright, isrc, monitor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            media.id,
            media.artist_id,
            media.album_id || null,
            media.title,
            media.version || null,
            media.release_date || null,
            media.type,
            media.explicit ? 1 : 0,
            media.quality || 'LOSSLESS',
            media.user_date_added || null,
            media.track_number || null,
            media.volume_number || 1,
            media.duration || null,
            media.popularity || null,
            media.bpm || null,
            media.key || null,
            media.key_scale || null,
            media.peak || null,
            media.replay_gain || null,
            media.credits || null,
            media.copyright || null,
            media.isrc || null,
            media.monitor ? 1 : 0
        );
    }

    /**
     * Bulk insert media in a transaction
     */
    bulkInsert(mediaItems: MediaInsert[]): number {
        if (mediaItems.length === 0) return 0;

        return this.transaction(() => {
            const stmt = this.prepare(`
                INSERT INTO media (
                    id, artist_id, album_id, title, version, release_date, type,
                    explicit, quality, user_date_added, track_number, volume_number,
                    duration, popularity, bpm, key, key_scale, peak, replay_gain,
                    credits, copyright, isrc, monitor
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            let insertedCount = 0;
            for (const media of mediaItems) {
                stmt.run(
                    media.id,
                    media.artist_id,
                    media.album_id || null,
                    media.title,
                    media.version || null,
                    media.release_date || null,
                    media.type,
                    media.explicit ? 1 : 0,
                    media.quality || 'LOSSLESS',
                    media.user_date_added || null,
                    media.track_number || null,
                    media.volume_number || 1,
                    media.duration || null,
                    media.popularity || null,
                    media.bpm || null,
                    media.key || null,
                    media.key_scale || null,
                    media.peak || null,
                    media.replay_gain || null,
                    media.credits || null,
                    media.copyright || null,
                    media.isrc || null,
                    media.monitor ? 1 : 0
                );
                insertedCount++;
            }
            return insertedCount;
        });
    }

    /**
     * Upsert media (insert or update)
     */
    upsert(media: MediaInsert): void {
        this.prepare(`
            INSERT INTO media (
                id, artist_id, album_id, title, version, release_date, type,
                explicit, quality, user_date_added, track_number, volume_number,
                duration, popularity, bpm, key, key_scale, peak, replay_gain,
                credits, copyright, isrc, monitor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                version = excluded.version,
                release_date = COALESCE(excluded.release_date, release_date),
                quality = excluded.quality,
                duration = COALESCE(excluded.duration, duration),
                popularity = COALESCE(excluded.popularity, popularity)
        `).run(
            media.id,
            media.artist_id,
            media.album_id || null,
            media.title,
            media.version || null,
            media.release_date || null,
            media.type,
            media.explicit ? 1 : 0,
            media.quality || 'LOSSLESS',
            media.user_date_added || null,
            media.track_number || null,
            media.volume_number || 1,
            media.duration || null,
            media.popularity || null,
            media.bpm || null,
            media.key || null,
            media.key_scale || null,
            media.peak || null,
            media.replay_gain || null,
            media.credits || null,
            media.copyright || null,
            media.isrc || null,
            media.monitor ? 1 : 0
        );
    }

    /**
     * Update media fields
     */
    update(id: number, updates: Partial<Media>): void {
        const fields: string[] = [];
        const values: any[] = [];

        const fieldMap: Record<string, any> = {
            monitor: updates.monitor !== undefined ? (updates.monitor ? 1 : 0) : undefined,
            monitor_lock: updates.monitor_lock !== undefined ? (updates.monitor_lock ? 1 : 0) : undefined,
            downloaded: updates.downloaded !== undefined ? (updates.downloaded ? 1 : 0) : undefined,
            quality: updates.quality,
        };

        for (const [key, value] of Object.entries(fieldMap)) {
            if (value !== undefined) {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }

        if (fields.length === 0) return;

        values.push(id);
        this.prepare(`UPDATE media SET ${fields.join(", ")} WHERE id = ?`)
            .run(...values);
    }

    delete(id: number): void {
        this.prepare("DELETE FROM media WHERE id = ?").run(id);
    }

    /**
     * Delete all media for an album
     */
    deleteByAlbum(albumId: number): void {
        this.prepare("DELETE FROM media WHERE album_id = ?").run(albumId);
    }

    /**
     * Delete all media for an artist
     */
    deleteByArtist(artistId: number): void {
        this.prepare("DELETE FROM media WHERE artist_id = ?").run(artistId);
    }

    // ========== Convenience methods for tracks ==========

    findTrackById(id: number): Media | undefined {
        // Tracks are media items that are not videos (type != 'Music Video')
        return this.prepare("SELECT * FROM media WHERE id = ? AND type != 'Music Video'")
            .get(id) as Media | undefined;
    }

    findTracksByAlbum(albumId: number): Media[] {
        // All media items for an album are tracks by definition
        return this.prepare("SELECT * FROM media WHERE album_id = ? ORDER BY volume_number, track_number")
            .all(albumId) as Media[];
    }

    countTracks(): number {
        return this.count('track');
    }

    countDownloadedTracks(): number {
        return this.countDownloaded('track');
    }

    // ========== Convenience methods for videos ==========

    findVideoById(id: number): Media | undefined {
        // Videos have type = 'Music Video'
        return this.prepare("SELECT * FROM media WHERE id = ? AND type = 'Music Video'")
            .get(id) as Media | undefined;
    }

    findVideosByArtist(artistId: number, limit?: number, offset?: number): Media[] {
        return this.findByArtist(artistId, 'video', limit, offset);
    }

    countVideos(): number {
        return this.count('video');
    }

    countDownloadedVideos(): number {
        return this.countDownloaded('video');
    }

    countMonitoredVideos(): number {
        return this.countMonitored('video');
    }
}
