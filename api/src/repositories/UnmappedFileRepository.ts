import Database from "better-sqlite3";
import { BaseRepository } from "./BaseRepository.js";

export interface UnmappedFile {
    id: number;
    file_path: string;
    relative_path: string;
    library_root: string;
    filename: string;
    extension: string;
    file_size: number | null;
    duration: number | null;
    bitrate: number | null;
    sample_rate: number | null;
    bit_depth: number | null;
    channels: number | null;
    codec: string | null;
    detected_artist: string | null;
    detected_album: string | null;
    detected_track: string | null;
    audio_quality: string | null;
    reason: string | null;
    ignored: boolean;
    created_at?: string;
    updated_at?: string;
}

function mapRow(row: any): UnmappedFile {
    return {
        ...row,
        ignored: row.ignored === 1 || row.ignored === true,
    };
}

export class UnmappedFileRepository extends BaseRepository<UnmappedFile, number> {
    constructor(db: Database.Database) {
        super(db);
    }

    findById(id: number): UnmappedFile | undefined {
        const row = this.prepare("SELECT * FROM unmapped_files WHERE id = ?").get(id) as any;
        return row ? mapRow(row) : undefined;
    }

    findAll(limit?: number, offset?: number): UnmappedFile[] {
        const sql = limit !== undefined
            ? `SELECT * FROM unmapped_files ORDER BY detected_artist ASC, detected_album ASC, filename ASC LIMIT ? OFFSET ?`
            : `SELECT * FROM unmapped_files ORDER BY detected_artist ASC, detected_album ASC, filename ASC`;
        const rows = (limit !== undefined
            ? this.prepare(sql).all(limit, offset || 0)
            : this.prepare(sql).all()) as any[];
        return rows.map(mapRow);
    }

    findByIds(ids: number[]): UnmappedFile[] {
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => "?").join(",");
        const rows = this.prepare(`SELECT * FROM unmapped_files WHERE id IN (${placeholders})`).all(...ids) as any[];
        return rows.map(mapRow);
    }

    findByDirectory(relativeDirectory: string, libraryRoot?: string): UnmappedFile[] {
        const normalizedPrefix = relativeDirectory.replace(/\\/g, "/");
        const sql = libraryRoot
            ? `
                SELECT * FROM unmapped_files
                WHERE relative_path LIKE ? || '%'
                  AND library_root = ?
                ORDER BY filename ASC
              `
            : `
                SELECT * FROM unmapped_files
                WHERE relative_path LIKE ? || '%'
                ORDER BY filename ASC
              `;
        const rows = (libraryRoot
            ? this.prepare(sql).all(normalizedPrefix, libraryRoot)
            : this.prepare(sql).all(normalizedPrefix)) as any[];
        return rows.map(mapRow);
    }

    count(): number {
        const result = this.prepare("SELECT COUNT(*) as count FROM unmapped_files").get() as { count: number };
        return result.count;
    }

    setIgnored(id: number, ignored: boolean): void {
        this.prepare(`
            UPDATE unmapped_files
            SET ignored = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(ignored ? 1 : 0, id);
    }

    setIgnoredByIds(ids: number[], ignored: boolean): void {
        if (ids.length === 0) return;
        const placeholders = ids.map(() => "?").join(",");
        this.prepare(`
            UPDATE unmapped_files
            SET ignored = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id IN (${placeholders})
        `).run(ignored ? 1 : 0, ...ids);
    }

    delete(id: number): void {
        this.prepare("DELETE FROM unmapped_files WHERE id = ?").run(id);
    }

    deleteByIds(ids: number[]): void {
        if (ids.length === 0) return;
        const placeholders = ids.map(() => "?").join(",");
        this.prepare(`DELETE FROM unmapped_files WHERE id IN (${placeholders})`).run(...ids);
    }
}