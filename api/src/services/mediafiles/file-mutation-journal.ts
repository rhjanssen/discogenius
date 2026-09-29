import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { db, withSqliteWriteGate } from "../../database.js";
import { tableIdColumn, type RenameTableName } from "./rename-track-file-paths.js";

type Intent = {
    id: string; table_name: RenameTableName; row_id: number;
    operation: "move" | "delete"; phase: "prepared" | "committed";
    source_path: string; destination_path: string; temporary_path: string;
    source_stat: string; source_sha256: string | null; row_snapshot: string;
};
const identityFields = ["file_path", "relative_path", "library_root", "library_slot", "artist_id", "artist_metadata_id",
    "recording_id", "track_id", "album_edition_id", "release_group_id", "canonical_artist_mbid",
    "canonical_recording_mbid", "canonical_track_mbid", "canonical_release_mbid", "canonical_release_group_mbid"];
const snapshot = (row: Record<string, unknown>) => JSON.stringify(Object.fromEntries(identityFields.map(k => [k, row[k] ?? null])));
function statIdentity(file: string): string {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error(`File mutation requires a regular file: ${file}`);
    return JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtime: String(stat.mtimeNs) });
}
async function sha256(file: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
}

/** Filesystem and SQLite cannot share a transaction. Persist intent first,
 * commit its acknowledgement with the exact file row, and recover uncommitted
 * moves by restoring the previous path. Unknown or changed files fail closed. */
export class FileMutationJournal {
    private static get(id: string): Intent {
        const intent = db.prepare("SELECT * FROM FileMutationJournal WHERE id = ?").get(id) as Intent | undefined;
        if (!intent) throw new Error("File mutation intent is missing");
        return intent;
    }
    private static row(intent: Intent): Record<string, unknown> | undefined {
        return db.prepare(`SELECT * FROM ${intent.table_name} WHERE ${tableIdColumn(intent.table_name)} = ?`)
            .get(intent.row_id) as Record<string, unknown> | undefined;
    }
    static hasPending(): boolean {
        return Boolean(db.prepare("SELECT 1 FROM FileMutationJournal LIMIT 1").get());
    }
    static async prepare(table: RenameTableName, rowId: number, storedPath: string, source: string,
        destination: string | null): Promise<string> {
        const id = randomUUID();
        const operation = destination === null ? "delete" : "move";
        const target = destination ?? path.join(path.dirname(source), `.discogenius-delete-${id}${path.extname(source)}`);
        const temporary = path.join(path.dirname(target), `.discogenius-move-${id}.partial`);
        const sourceStat = statIdentity(source);
        if (fs.existsSync(target)) throw new Error(`Mutation destination already exists: ${target}`);
        await withSqliteWriteGate(() => {
            const row = db.prepare(`SELECT * FROM ${table} WHERE ${tableIdColumn(table)} = ?`).get(rowId) as Record<string, unknown> | undefined;
            if (!row || row.file_path !== storedPath) throw new Error("File row changed before move intent");
            db.prepare(`INSERT INTO FileMutationJournal
                (id, table_name, row_id, operation, source_path, destination_path, temporary_path, source_stat, row_snapshot)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, table, rowId, operation, source, target, temporary, sourceStat, snapshot(row));
        }, "file-mutation:intent");
        return id;
    }
    static async move(id: string): Promise<string> {
        const intent = this.get(id);
        if (statIdentity(intent.source_path) !== intent.source_stat || fs.existsSync(intent.destination_path)) {
            throw new Error("File changed after its move intent");
        }
        fs.mkdirSync(path.dirname(intent.destination_path), { recursive: true });
        try {
            fs.linkSync(intent.source_path, intent.destination_path);
            fs.unlinkSync(intent.source_path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
            // Cross-device copying needs byte identity, whereas an ordinary
            // rename retains the original inode and requires no full-file read.
            const digest = await sha256(intent.source_path);
            if (statIdentity(intent.source_path) !== intent.source_stat) throw new Error("Source changed during move hashing");
            await withSqliteWriteGate(() => db.prepare("UPDATE FileMutationJournal SET source_sha256 = ? WHERE id = ? AND phase = 'prepared'")
                .run(digest, id), "file-mutation:copy-intent");
            fs.copyFileSync(intent.source_path, intent.temporary_path, fs.constants.COPYFILE_EXCL);
            if (await sha256(intent.temporary_path) !== digest) throw new Error("Cross-device copy verification failed");
            if (statIdentity(intent.source_path) !== intent.source_stat) throw new Error("Source changed during move copying");
            // Publish without replacing an external destination that appeared
            // during the copy. The temporary file is on the destination device.
            fs.linkSync(intent.temporary_path, intent.destination_path);
            fs.unlinkSync(intent.temporary_path);
            if (statIdentity(intent.source_path) !== intent.source_stat) throw new Error("Source changed before move removal");
            fs.unlinkSync(intent.source_path);
        }
        return intent.destination_path;
    }
    /** Called inside the same transaction as the file-row update/deletion. */
    static assertBeforeCommit(id: string): void {
        const intent = this.get(id);
        const row = this.row(intent);
        if (intent.phase !== "prepared" || !row || snapshot(row) !== intent.row_snapshot) {
            throw new Error("File identity changed before rename commit");
        }
    }
    static markCommitted(id: string): void {
        if (db.prepare("UPDATE FileMutationJournal SET phase = 'committed' WHERE id = ? AND phase = 'prepared'").run(id).changes !== 1) {
            throw new Error("File mutation commit lost its intent");
        }
    }
    private static async matches(intent: Intent, file: string): Promise<boolean> {
        if (!fs.existsSync(file)) return false;
        return intent.source_sha256 ? await sha256(file) === intent.source_sha256 : statIdentity(file) === intent.source_stat;
    }
    private static async recoverIntent(id: string): Promise<void> {
        const intent = this.get(id);
        const row = this.row(intent);
        if (intent.phase === "prepared") {
            if (!row || snapshot(row) !== intent.row_snapshot) throw new Error(`Uncommitted mutation ${id} has changed database identity`);
            const sourceExists = fs.existsSync(intent.source_path);
            const targetExists = fs.existsSync(intent.destination_path);
            if (sourceExists && !await this.matches(intent, intent.source_path)) throw new Error(`Mutation source changed: ${intent.source_path}`);
            if (targetExists && !await this.matches(intent, intent.destination_path)) throw new Error(`Mutation target changed: ${intent.destination_path}`);
            if (!sourceExists && !targetExists) throw new Error(`Both mutation paths are missing for ${id}`);
            if (targetExists) {
                if (sourceExists) fs.unlinkSync(intent.destination_path);
                else {
                    fs.mkdirSync(path.dirname(intent.source_path), { recursive: true });
                    try {
                        fs.linkSync(intent.destination_path, intent.source_path);
                        fs.unlinkSync(intent.destination_path);
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
                        const rollbackTemporary = path.join(path.dirname(intent.source_path), `.discogenius-rollback-${id}.partial`);
                        if (fs.existsSync(rollbackTemporary)) fs.unlinkSync(rollbackTemporary);
                        fs.copyFileSync(intent.destination_path, rollbackTemporary, fs.constants.COPYFILE_EXCL);
                        if (!await this.matches(intent, rollbackTemporary)) throw new Error("Rollback copy verification failed");
                        fs.linkSync(rollbackTemporary, intent.source_path);
                        fs.unlinkSync(rollbackTemporary);
                        fs.unlinkSync(intent.destination_path);
                    }
                }
            }
        } else if (intent.operation === "delete") {
            if (row) throw new Error("Committed duplicate deletion still has a database row");
            if (fs.existsSync(intent.destination_path)) {
                if (!await this.matches(intent, intent.destination_path)) throw new Error("Staged duplicate changed before cleanup");
                fs.unlinkSync(intent.destination_path);
            }
        } else if (!row || row.file_path !== intent.destination_path || !await this.matches(intent, intent.destination_path)) {
            throw new Error("Committed move has no matching destination file row");
        }
        // This UUID path belongs exclusively to the persisted intent. Never
        // remove an unrecognized source/destination to resolve ambiguity.
        if (fs.existsSync(intent.temporary_path)) fs.unlinkSync(intent.temporary_path);
        const rollbackTemporary = path.join(path.dirname(intent.source_path), `.discogenius-rollback-${id}.partial`);
        if (fs.existsSync(rollbackTemporary)) fs.unlinkSync(rollbackTemporary);
        await withSqliteWriteGate(() => db.prepare("DELETE FROM FileMutationJournal WHERE id = ?").run(id), "file-mutation:settled");
    }
    static async recoverOne(id: string): Promise<void> {
        try { await this.recoverIntent(id); }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            try {
                await withSqliteWriteGate(() => db.prepare("UPDATE FileMutationJournal SET recovery_error = ? WHERE id = ?")
                    .run(message, id), "file-mutation:recovery-error");
            } catch {
                // Preserve the recovery failure if recording it also fails.
                // The unsettled intent still blocks further disk mutations.
            }
            throw error;
        }
    }
    static async recoverPending(): Promise<string[]> {
        const ids = db.prepare("SELECT id FROM FileMutationJournal ORDER BY created_at, id").all() as Array<{ id: string }>;
        const errors: string[] = [];
        for (const { id } of ids) {
            try { await this.recoverOne(id); }
            catch (error) { errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        return errors;
    }
}
