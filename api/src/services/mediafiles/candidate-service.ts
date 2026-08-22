import { db } from "../../database.js";

/**
 * A catalog-only candidate release group discovered for a group of local files.
 *
 * Mirrors the shape Lidarr's identification pipeline consumes from
 * CandidateService.GetDbCandidatesFromTags — a candidate album (release group)
 * resolved purely from the local database, never a streaming provider. The
 * fields intentionally match what IdentificationService.getAlbumScore reads
 * (title/name, artist_name/artist.name, num_tracks) so these candidates can be
 * scored by the existing Munkres pipeline unchanged.
 */
export interface CatalogAlbumCandidate {
    id: string;
    mbid: string;
    title: string;
    artist_name: string;
    artist: { id: string | null; name: string };
    num_tracks: number;
}

export interface CatalogVideoCandidate {
    id: string;
    mbid: string;
    title: string;
    artist_name: string;
    artist: { id: string | null; name: string };
    duration: number | null;
}

// Same tokeniser search.ts uses for the CatalogSearch FTS table so album-title
// discovery here behaves identically to the global search box.
function toFtsPrefixQuery(value: string): string | null {
    const tokens = value.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
    if (tokens.length === 0) return null;
    return tokens
        .slice(0, 8)
        .map((token) => `"${token.replace(/"/g, '""')}"*`)
        .join(" AND ");
}

/**
 * Catalog-only candidate discovery (Lidarr: CandidateService).
 *
 * Given the artist/album tags detected for a folder group of local files, this
 * returns candidate release groups drawn exclusively from the local catalog
 * (Albums = release groups, Artists, AlbumEditions, CatalogSearch FTS). It never
 * calls a streaming provider — the streaming provider is only ever used to
 * *download* audio, not to identify local files, exactly like Lidarr identifies
 * against its own MusicBrainz-synced database.
 */
export class CatalogCandidateService {
    static getReleaseGroupCandidates(opts: {
        artist?: string | null;
        album?: string | null;
        limit?: number;
    }): CatalogAlbumCandidate[] {
        const artist = (opts.artist || "").trim();
        const album = (opts.album || "").trim();
        const limit = opts.limit ?? 8;

        if (!artist && !album) return [];

        let mbids: string[] = [];

        // Tier 1 — artist + album title (Lidarr GetDbCandidates: artist tag → album candidates).
        if (artist && album) {
            mbids = (db.prepare(`
                SELECT DISTINCT al.mbid
                FROM Albums al
                JOIN Artists a ON a.mbid = al.artist_mbid
                LEFT JOIN AlbumEditions e ON e.release_group_id = al.id
                WHERE a.name LIKE ? AND (al.title LIKE ? OR e.title LIKE ?)
                LIMIT ?
            `).all(`%${artist}%`, `%${album}%`, `%${album}%`, limit) as Array<{ mbid: string }>).map((r) => r.mbid);
        }

        // Tier 2 — album-title FTS (handles punctuation/ordering the LIKE misses).
        if (mbids.length === 0 && album) {
            const fts = toFtsPrefixQuery(album);
            if (fts) {
                mbids = (db.prepare(`
                    SELECT entity_id AS mbid
                    FROM CatalogSearch
                    WHERE CatalogSearch MATCH ? AND entity_type = 'album'
                    LIMIT ?
                `).all(fts, limit) as Array<{ mbid: string }>).map((r) => r.mbid);
            }
        }

        // Tier 3 — token AND LIKE across title + artist name (last-resort fuzzy).
        if (mbids.length === 0) {
            const tokens = [artist, album].filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
            if (tokens.length > 0) {
                const conditions = tokens.map(() => "(al.title LIKE ? OR e.title LIKE ? OR a.name LIKE ?)").join(" AND ");
                const params = tokens.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);
                mbids = (db.prepare(`
                    SELECT DISTINCT al.mbid
                    FROM Albums al
                    LEFT JOIN Artists a ON a.mbid = al.artist_mbid
                    LEFT JOIN AlbumEditions e ON e.release_group_id = al.id
                    WHERE ${conditions}
                    LIMIT ?
                `).all(...params, limit) as Array<{ mbid: string }>).map((r) => r.mbid);
            }
        }

        if (mbids.length === 0) return [];

        const marks = mbids.map(() => "?").join(", ");
        const rows = db.prepare(`
            SELECT
                al.mbid AS id,
                al.title AS title,
                a.name AS artist_name,
                a.mbid AS artist_mbid,
                (
                    SELECT MAX(rel.track_count)
                    FROM AlbumEditions rel
                    WHERE rel.release_group_mbid = al.mbid
                ) AS num_tracks
            FROM Albums al
            LEFT JOIN Artists a ON a.mbid = al.artist_mbid
            WHERE al.mbid IN (${marks})
        `).all(...mbids) as Array<{
            id: string;
            title: string;
            artist_name: string | null;
            artist_mbid: string | null;
            num_tracks: number | null;
        }>;

        return rows.map((row) => ({
            id: row.id,
            mbid: row.id,
            title: row.title,
            artist_name: row.artist_name || "",
            artist: { id: row.artist_mbid, name: row.artist_name || "" },
            num_tracks: Number(row.num_tracks || 0),
        }));
    }

    static getVideoRecordingCandidates(opts: {
        artist?: string | null;
        title?: string | null;
        limit?: number;
    }): CatalogVideoCandidate[] {
        const artist = String(opts.artist || "").trim();
        const title = String(opts.title || "").trim();
        const limit = Math.max(1, Math.min(50, opts.limit ?? 12));
        if (!artist && !title) return [];

        const clauses = ["recording.is_video = 1"];
        const params: Array<string | number> = [];
        if (title) {
            clauses.push("recording.title LIKE ?");
            params.push(`%${title}%`);
        }
        if (artist) {
            clauses.push(`(
                artist.name LIKE ?
                OR recording.artist_credit LIKE ?
            )`);
            params.push(`%${artist}%`, `%${artist}%`);
        }
        params.push(limit);

        return (db.prepare(`
            SELECT
              recording.mbid AS id,
              recording.title,
              artist.name AS artist_name,
              COALESCE(artist.mbid, recording.artist_mbid) AS artist_mbid,
              recording.length_ms
            FROM Recordings recording
            LEFT JOIN ArtistMetadata artist
              ON artist.id = recording.artist_metadata_id
            WHERE ${clauses.join(" AND ")}
            ORDER BY recording.title, recording.mbid
            LIMIT ?
        `).all(...params) as Array<{
            id: string;
            title: string;
            artist_name: string | null;
            artist_mbid: string | null;
            length_ms: number | null;
        }>).map((row) => ({
            id: row.id,
            mbid: row.id,
            title: row.title,
            artist_name: row.artist_name || "",
            artist: { id: row.artist_mbid, name: row.artist_name || "" },
            duration: row.length_ms == null ? null : row.length_ms / 1000,
        }));
    }
}
