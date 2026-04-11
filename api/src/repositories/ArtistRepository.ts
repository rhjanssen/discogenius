import Database from "better-sqlite3";
import { BaseRepository } from "./BaseRepository.js";
import { resolveArtistFolderForPersistence } from "../services/artist-paths.js";

/**
 * Artist entity matching the new schema
 * Note: id is now INT (TIDAL artist id) as primary key, not tidal_id
 */
export interface Artist {
    id: number;                    // TIDAL artist id (primary key)
    name: string;                  // Artist name
    picture?: string;              // Artist picture UUID
    popularity?: number;           // TIDAL popularity score
    artist_types?: string;         // JSON array: ["ARTIST", "CONTRIBUTOR", ...ETC]
    artist_roles?: string;         // JSON array of role objects
    user_date_added?: string;      // When added to TIDAL favorites
    similar_artists?: string;      // JSON array of similar artist IDs
    path?: string;                 // Resolved library folder path

    // Biography
    bio_text?: string;             // Full biography text
    bio_source?: string;           // Source of biography
    bio_last_updated?: string;     // When biography was last updated

    // Monitoring & Lock Mechanism
    monitor?: boolean;             // whether to scan/download and watch for changes
    monitored_at?: string;         // when monitoring was enabled
    last_scanned?: string;         // last time this artist was scanned for new releases
    downloaded?: number;           // percentage of artist's monitored media downloaded (0-100)
}

export interface ArtistInsert {
    id: number;
    name: string;
    picture?: string;
    popularity?: number;
    artist_types?: string;
    artist_roles?: string;
    user_date_added?: string;
    similar_artists?: string;
    bio_text?: string;
    bio_source?: string;
    monitor?: boolean;
    path?: string;
}

/**
 * Artist Repository - handles all artist database operations
 * Updated for new schema where id is INT primary key
 */
export class ArtistRepository extends BaseRepository<Artist, number> {
    constructor(db: Database.Database) {
        super(db);
    }

    findById(id: number): Artist | undefined {
        return this.prepare("SELECT * FROM artists WHERE id = ?")
            .get(id) as Artist | undefined;
    }

    findAll(limit: number = 100, offset: number = 0): Artist[] {
        return this.prepare("SELECT * FROM artists ORDER BY name LIMIT ? OFFSET ?")
            .all(limit, offset) as Artist[];
    }

    findMonitored(): Artist[] {
        return this.prepare("SELECT * FROM artists WHERE monitor = 1 ORDER BY name")
            .all() as Artist[];
    }

    count(): number {
        const result = this.prepare("SELECT COUNT(*) as count FROM artists").get() as { count: number };
        return result.count;
    }

    /**
     * Insert or ignore artist (useful for featured artists)
     */
    insertOrIgnore(artist: ArtistInsert): void {
        const artistPath = artist.path || resolveArtistFolderForPersistence({
            artistId: artist.id,
            artistName: artist.name,
        });
        this.prepare(`
            INSERT OR IGNORE INTO artists (
                id, name, picture, popularity, artist_types, artist_roles, 
                user_date_added, similar_artists, bio_text, bio_source, monitor, path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            artist.id,
            artist.name,
            artist.picture || null,
            artist.popularity || null,
            artist.artist_types || null,
            artist.artist_roles || null,
            artist.user_date_added || null,
            artist.similar_artists || null,
            artist.bio_text || null,
            artist.bio_source || null,
            artist.monitor ? 1 : 0,
            artistPath || null
        );
    }

    /**
     * Insert artist (will error if already exists)
     */
    insert(artist: ArtistInsert): void {
        const artistPath = artist.path || resolveArtistFolderForPersistence({
            artistId: artist.id,
            artistName: artist.name,
        });
        this.prepare(`
            INSERT INTO artists (
                id, name, picture, popularity, artist_types, artist_roles, 
                user_date_added, similar_artists, bio_text, bio_source, monitor, path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            artist.id,
            artist.name,
            artist.picture || null,
            artist.popularity || null,
            artist.artist_types || null,
            artist.artist_roles || null,
            artist.user_date_added || null,
            artist.similar_artists || null,
            artist.bio_text || null,
            artist.bio_source || null,
            artist.monitor ? 1 : 0,
            artistPath || null
        );
    }

    /**
     * Update artist
     */
    update(id: number, updates: Partial<Artist>): void {
        const fields: string[] = [];
        const values: any[] = [];

        const fieldMap: Record<string, any> = {
            monitor: updates.monitor !== undefined ? (updates.monitor ? 1 : 0) : undefined,
            downloaded: updates.downloaded,
            bio_text: updates.bio_text,
            bio_source: updates.bio_source,
            picture: updates.picture,
            popularity: updates.popularity,
            path: updates.path,
        };

        for (const [key, value] of Object.entries(fieldMap)) {
            if (value !== undefined) {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }

        if (fields.length === 0) return;

        values.push(id);
        this.prepare(`UPDATE artists SET ${fields.join(", ")} WHERE id = ?`)
            .run(...values);
    }

    /**
     * Mark artist as scanned
     */
    markScanned(id: number): void {
        this.prepare("UPDATE artists SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?")
            .run(id);
    }

    /**
     * Set artist monitoring status
     */
    setMonitored(id: number, monitored: boolean): void {
        this.prepare(`
            UPDATE artists SET 
                monitor = ?, 
                monitored_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE monitored_at END
            WHERE id = ?
        `).run(monitored ? 1 : 0, monitored ? 1 : 0, id);
    }

    delete(id: number): void {
        this.prepare("DELETE FROM artists WHERE id = ?").run(id);
    }
}
