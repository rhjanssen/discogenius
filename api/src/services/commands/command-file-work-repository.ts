import { db } from "../../database.js";
import type { RetagApplyResult } from "../mediafiles/audio-tag-service.js";
import { FILE_CHECKPOINT_POISON_ERROR, FILE_CHECKPOINT_RESTART_LIMIT } from "./command-liveness-policy.js";

export interface FileWorkPlan {
    command_id: number;
    config_revision: string;
    generation: number;
    total: number;
    cursor: number;
    retagged: number;
    skipped: number;
    missing: number;
    error_count: number;
    /** 1 when every album is in the plan. Absent rows from a pre-migration
     * reader are treated as complete. Streaming plans store 0 until the last
     * album is appended. */
    plan_complete?: number;
}

export interface FileCheckpointReclaim {
    cursor: number;
    total: number;
    skippedFiles: number;
}

const identityFields = ["artist_metadata_id", "recording_id", "track_id", "album_edition_id", "release_group_id",
    "library_id", "file_type", "canonical_artist_mbid", "canonical_recording_mbid", "canonical_track_mbid",
    "canonical_release_mbid", "canonical_release_group_mbid"] as const;
type FileRow = Record<(typeof identityFields)[number], string | number | null> & {
    id: number; file_path: string; file_size: number | null; modified_at: string | null;
};
type PlannedFile = { id: number; identity: string };
const fileColumns = `id, file_path, file_size, modified_at, ${identityFields.join(", ")}`;
const snapshot = (row: FileRow | undefined): string => JSON.stringify(row
    ? Object.fromEntries(identityFields.map(field => [field, row[field] ?? null])) : null);

/** Parent directory of a library path. The album key is this string; SQLite
 * character-class trimming is not used because it would eat extra characters. */
export function albumFolderOf(filePath: string): string {
    const normalized = filePath.replaceAll("\\", "/");
    const index = normalized.lastIndexOf("/");
    return index <= 0 ? normalized : normalized.slice(0, index);
}

export function planIsComplete(plan: Pick<FileWorkPlan, "plan_complete">): boolean {
    return plan.plan_complete !== 0;
}

/** Indexed operation records are the authority. Command payloads contain only
 * a small UI marker. An album settles in one write; the library-wide id list
 * is never rewritten. */
export class CommandFileWorkRepository {
    private static assertOwner(commandId: number, workerId: string): void {
        if (!this.executionOwned(commandId, workerId)) {
            throw new Error("Retag execution ownership changed");
        }
    }

    /** Read-only. A pre-claimed file must not be opened after ownership was retired. */
    static executionOwned(commandId: number, workerId: string): boolean {
        return Boolean(db.prepare("SELECT 1 FROM commands WHERE id = ? AND status = 'started' AND worker_id = ?").get(commandId, workerId));
    }

    /** Read-only. The common retag file has not moved, so this must not take the write gate. */
    static identityDrifted(commandId: number): boolean {
        const plan = this.get(commandId);
        if (!plan) return false;
        const file = db.prepare(`SELECT track_file_id, identity_snapshot FROM CommandFileWork
            WHERE command_id = ? AND generation = ? AND ordinal = ? AND status IN ('pending', 'started')`)
            .get(commandId, plan.generation, plan.cursor) as { track_file_id: number; identity_snapshot: string } | undefined;
        if (!file) return false;
        const current = db.prepare(`SELECT ${fileColumns} FROM TrackFiles WHERE id = ?`).get(file.track_file_id) as FileRow | undefined;
        if (!current) return false;
        return snapshot(current) !== file.identity_snapshot;
    }

    static get(commandId: number): FileWorkPlan | undefined {
        return db.prepare("SELECT * FROM CommandFileWorkPlans WHERE command_id = ?").get(commandId) as FileWorkPlan | undefined;
    }

    static prepare(ids: number[]): PlannedFile[] {
        const unique = [...new Set(ids)];
        if (unique.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid retag file identity");
        const rows = db.prepare(`SELECT ${fileColumns} FROM TrackFiles WHERE id IN (SELECT value FROM json_each(?))`)
            .all(JSON.stringify(unique)) as FileRow[];
        const byId = new Map(rows.map(row => [row.id, row]));
        return unique.map(id => ({ id, identity: snapshot(byId.get(id)) }));
    }

    static create(commandId: number, workerId: string, revision: string, files: PlannedFile[], operation: "retag" | "strip" = "retag"): void {
        db.transaction(() => {
            this.assertOwner(commandId, workerId);
            // The plan row and every work row commit together. A row that
            // already exists is the complete plan, including one written by
            // the previous process before this column set existed.
            if (this.get(commandId)) return;
            db.prepare("INSERT INTO CommandFileWorkPlans (command_id, operation, config_revision, total) VALUES (?, ?, ?, ?)")
                .run(commandId, operation, revision, files.length);
            const insert = db.prepare(`INSERT INTO CommandFileWork (command_id, generation, ordinal, track_file_id, identity_snapshot)
                VALUES (?, 1, ?, ?, ?)`);
            files.forEach((file, ordinal) => insert.run(commandId, ordinal, file.id, file.identity));
        })();
    }

    /** A process restart left one or more album files claimed. Count that
     * claim on every started row at or after the cursor. At the bound, poison
     * only the cursor file and put the rest of the album back to pending.
     * Settled rows are not touched. A pre-migration plan has a single started
     * row at the cursor; that row still resumes. */
    static reclaimInFlight(commandId: number): FileCheckpointReclaim {
        return db.transaction(() => {
            const plan = this.get(commandId);
            if (!plan) return { cursor: 0, total: 0, skippedFiles: 0 };
            const started = db.prepare(`SELECT ordinal, track_file_id, restart_claims FROM CommandFileWork
                WHERE command_id = ? AND generation = ? AND ordinal >= ? AND status = 'started'
                ORDER BY ordinal`)
                .all(commandId, plan.generation, plan.cursor) as Array<{
                ordinal: number; track_file_id: number; restart_claims: number;
            }>;
            let skippedFiles = 0;
            const cursorRow = started.find(row => row.ordinal === plan.cursor);
            if (cursorRow && Number(cursorRow.restart_claims) + 1 >= FILE_CHECKPOINT_RESTART_LIMIT) {
                const claims = Number(cursorRow.restart_claims) + 1;
                db.prepare(`UPDATE CommandFileWork SET status = 'settled', restart_claims = ?, retagged = 0,
                    skipped = 1, missing = 0, error = ?, settled_at = CURRENT_TIMESTAMP
                    WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                    .run(claims, JSON.stringify([FILE_CHECKPOINT_POISON_ERROR]), commandId, plan.generation, cursorRow.ordinal);
                db.prepare(`UPDATE CommandFileWorkPlans SET cursor = cursor + 1, skipped = skipped + 1,
                    error_count = error_count + 1, updated_at = CURRENT_TIMESTAMP
                    WHERE command_id = ? AND cursor = ?`).run(commandId, plan.cursor);
                for (const row of started) {
                    if (row.ordinal === cursorRow.ordinal) continue;
                    db.prepare(`UPDATE CommandFileWork SET status = 'pending', restart_claims = ?, started_at = NULL
                        WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                        .run(Number(row.restart_claims) + 1, commandId, plan.generation, row.ordinal);
                }
                skippedFiles = 1;
            } else {
                for (const row of started) {
                    db.prepare(`UPDATE CommandFileWork SET status = 'pending', restart_claims = ?, started_at = NULL
                        WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                        .run(Number(row.restart_claims) + 1, commandId, plan.generation, row.ordinal);
                }
            }
            const next = this.get(commandId)!;
            return {
                cursor: next.cursor,
                total: next.total,
                skippedFiles,
            };
        })();
    }

    static peek(commandId: number, workerId: string): { id: number; fileType: string | null } {
        this.assertOwner(commandId, workerId);
        const plan = this.get(commandId)!;
        const file = db.prepare(`SELECT track_file_id FROM CommandFileWork
            WHERE command_id = ? AND generation = ? AND ordinal = ? AND status IN ('pending', 'started')`)
            .get(commandId, plan.generation, plan.cursor) as { track_file_id: number } | undefined;
        if (!file) throw new Error("Retag work cursor does not identify a pending file");
        const current = db.prepare("SELECT file_type FROM TrackFiles WHERE id = ?").get(file.track_file_id) as {
            file_type: string | null;
        } | undefined;
        return { id: file.track_file_id, fileType: current?.file_type == null ? null : String(current.file_type) };
    }

    /** Record a skip or a missing file without a separate intent transaction. */
    static settleDirect(commandId: number, workerId: string, fileId: number, result: RetagApplyResult): FileWorkPlan {
        const counts = [result.retagged, result.skipped, result.missing];
        if (result.retagged !== 0 || result.errors.length !== 0
            || counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > 1)
            || result.skipped + result.missing !== 1) {
            throw new Error(`Retag unchanged outcome must identify exactly file #${fileId}`);
        }
        return db.transaction(() => {
            this.assertOwner(commandId, workerId);
            const plan = this.get(commandId)!;
            const expected = db.prepare(`SELECT identity_snapshot, status FROM CommandFileWork
                WHERE command_id = ? AND generation = ? AND ordinal = ? AND track_file_id = ?`)
                .get(commandId, plan.generation, plan.cursor, fileId) as {
                identity_snapshot: string;
                status: string;
            } | undefined;
            const current = db.prepare(`SELECT ${fileColumns} FROM TrackFiles WHERE id = ?`).get(fileId) as FileRow | undefined;
            if (!expected || (expected.status !== "pending" && expected.status !== "started")
                || (current && snapshot(current) !== expected.identity_snapshot)
                || (!current && result.missing === 0)) {
                throw new Error(`File #${fileId} changed identity before its retag outcome was committed`);
            }
            const written = db.prepare(`UPDATE CommandFileWork SET status = 'settled', retagged = 0, skipped = ?, missing = ?,
                error = NULL, settled_at = CURRENT_TIMESTAMP
                WHERE command_id = ? AND generation = ? AND ordinal = ? AND track_file_id = ? AND status IN ('pending', 'started')`)
                .run(result.skipped, result.missing, commandId, plan.generation, plan.cursor, fileId);
            if (written.changes !== 1) throw new Error("Retag file outcome does not own the current work item");
            db.prepare(`UPDATE CommandFileWorkPlans SET cursor = cursor + 1, skipped = skipped + ?,
                missing = missing + ?, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?`)
                .run(result.skipped, result.missing, commandId);
            return this.get(commandId)!;
        })();
    }

    /** Per-file isolation: a concurrent import or redownload may re-identify one
     * planned file. Re-plan only that work item against its current catalogue
     * identity instead of failing the library-wide command. Returns the file id
     * when its snapshot was replaced, null when it was unchanged or is missing. */
    static replanChangedIdentity(commandId: number, workerId: string): number | null {
        return db.transaction(() => {
            this.assertOwner(commandId, workerId);
            const plan = this.get(commandId)!;
            const file = db.prepare(`SELECT track_file_id, identity_snapshot FROM CommandFileWork
                WHERE command_id = ? AND generation = ? AND ordinal = ? AND status IN ('pending', 'started')`)
                .get(commandId, plan.generation, plan.cursor) as { track_file_id: number; identity_snapshot: string } | undefined;
            if (!file) return null;
            const current = db.prepare(`SELECT ${fileColumns} FROM TrackFiles WHERE id = ?`).get(file.track_file_id) as FileRow | undefined;
            if (!current || snapshot(current) === file.identity_snapshot) return null;
            db.prepare(`UPDATE CommandFileWork SET identity_snapshot = ?, status = 'pending'
                WHERE command_id = ? AND generation = ? AND ordinal = ?`)
                .run(snapshot(current), commandId, plan.generation, plan.cursor);
            return file.track_file_id;
        })();
    }

    static begin(commandId: number, workerId: string): { id: number; fileType: string | null } {
        return db.transaction(() => {
            this.assertOwner(commandId, workerId);
            const plan = this.get(commandId)!;
            const file = db.prepare(`SELECT track_file_id, identity_snapshot FROM CommandFileWork
                WHERE command_id = ? AND generation = ? AND ordinal = ? AND status IN ('pending', 'started')`)
                .get(commandId, plan.generation, plan.cursor) as { track_file_id: number; identity_snapshot: string } | undefined;
            if (!file) throw new Error("Retag work cursor does not identify a pending file");
            const current = db.prepare(`SELECT ${fileColumns} FROM TrackFiles WHERE id = ?`).get(file.track_file_id) as FileRow | undefined;
            if (current && snapshot(current) !== file.identity_snapshot) {
                throw new Error(`File #${file.track_file_id} changed catalogue identity during the retag plan`);
            }
            db.prepare(`UPDATE CommandFileWork SET status = 'started', intent_path = ?, intent_size = ?,
                intent_modified_at = ?, started_at = CURRENT_TIMESTAMP
                WHERE command_id = ? AND generation = ? AND ordinal = ?`)
                .run(current?.file_path ?? null, current?.file_size ?? null, current?.modified_at ?? null,
                    commandId, plan.generation, plan.cursor);
            return { id: file.track_file_id, fileType: current?.file_type == null ? null : String(current.file_type) };
        })();
    }

    /** Claim the cursor file. A drifted identity is refreshed here so the caller's
     * settle of the previous file is not rolled back. */
    private static claimCursor(commandId: number, plan: FileWorkPlan): {
        id: number; fileType: string | null; replannedId: number | null;
    } {
        const file = db.prepare(`SELECT track_file_id, identity_snapshot FROM CommandFileWork
            WHERE command_id = ? AND generation = ? AND ordinal = ? AND status IN ('pending', 'started')`)
            .get(commandId, plan.generation, plan.cursor) as { track_file_id: number; identity_snapshot: string } | undefined;
        if (!file) throw new Error("Retag work cursor does not identify a pending file");
        const current = db.prepare(`SELECT ${fileColumns} FROM TrackFiles WHERE id = ?`).get(file.track_file_id) as FileRow | undefined;
        const drifted = Boolean(current && snapshot(current) !== file.identity_snapshot);
        const identity = drifted && current ? snapshot(current) : file.identity_snapshot;
        db.prepare(`UPDATE CommandFileWork SET status = 'started', identity_snapshot = ?, intent_path = ?, intent_size = ?,
            intent_modified_at = ?, started_at = CURRENT_TIMESTAMP
            WHERE command_id = ? AND generation = ? AND ordinal = ?`)
            .run(identity, current?.file_path ?? null, current?.file_size ?? null, current?.modified_at ?? null,
                commandId, plan.generation, plan.cursor);
        return {
            id: file.track_file_id,
            fileType: current?.file_type == null ? null : String(current.file_type),
            replannedId: drifted ? file.track_file_id : null,
        };
    }

    /** Settle file N and, when the dispatch will open another file, claim N+1
     * in the same transaction. A crash still leaves exactly one `started` row. */
    static settleAndClaimNext(
        commandId: number,
        workerId: string,
        fileId: number,
        result: RetagApplyResult,
        claimNext: boolean,
    ): { plan: FileWorkPlan; next: { id: number; fileType: string | null } | null; replannedId: number | null } {
        return db.transaction(() => {
            const unchanged = result.retagged === 0 && result.errors.length === 0
                && result.skipped + result.missing === 1;
            const plan = unchanged
                ? this.settleDirect(commandId, workerId, fileId, result)
                : this.settle(commandId, workerId, fileId, result);
            if (!claimNext || plan.cursor >= plan.total) return { plan, next: null, replannedId: null };
            const claimed = this.claimCursor(commandId, plan);
            return { plan, next: { id: claimed.id, fileType: claimed.fileType }, replannedId: claimed.replannedId };
        })();
    }

    static settle(commandId: number, workerId: string, fileId: number, result: RetagApplyResult): FileWorkPlan {
        const counts = [result.retagged, result.skipped, result.missing];
        if (counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > 1)
            || counts.reduce((sum, count) => sum + count, 0) > 1
            || (counts.every(count => count === 0) && result.errors.length === 0)
            || result.errors.some(error => error.id !== fileId)) {
            throw new Error(`Retag outcome must identify exactly file #${fileId}`);
        }
        return db.transaction(() => {
            this.assertOwner(commandId, workerId);
            const plan = this.get(commandId)!;
            const expected = db.prepare(`SELECT identity_snapshot FROM CommandFileWork
                WHERE command_id = ? AND generation = ? AND ordinal = ? AND track_file_id = ?`)
                .get(commandId, plan.generation, plan.cursor, fileId) as { identity_snapshot: string } | undefined;
            const current = db.prepare(`SELECT ${fileColumns} FROM TrackFiles WHERE id = ?`).get(fileId) as FileRow | undefined;
            if (!expected || (current && snapshot(current) !== expected.identity_snapshot)
                || (!current && result.missing === 0)) {
                throw new Error(`File #${fileId} changed identity before its retag outcome was committed`);
            }
            const written = db.prepare(`UPDATE CommandFileWork SET status = 'settled', retagged = ?, skipped = ?, missing = ?,
                error = ?, settled_at = CURRENT_TIMESTAMP
                WHERE command_id = ? AND generation = ? AND ordinal = ? AND track_file_id = ? AND status = 'started'`)
                .run(result.retagged, result.skipped, result.missing,
                    result.errors.length ? JSON.stringify(result.errors.map(item => item.error)) : null,
                    commandId, plan.generation, plan.cursor, fileId);
            if (written.changes !== 1) throw new Error("Retag file outcome does not own the current work item");
            db.prepare(`UPDATE CommandFileWorkPlans SET cursor = cursor + 1, retagged = retagged + ?, skipped = skipped + ?,
                missing = missing + ?, error_count = error_count + ?, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?`)
                .run(result.retagged, result.skipped, result.missing, result.errors.length, commandId);
            return this.get(commandId)!;
        })();
    }

    static errors(commandId: number): Array<{ id: number; error: string }> {
        const plan = this.get(commandId)!;
        const rows = db.prepare(`SELECT track_file_id, error FROM CommandFileWork
            WHERE command_id = ? AND generation = ? AND error IS NOT NULL ORDER BY ordinal`)
            .all(commandId, plan.generation) as Array<{ track_file_id: number; error: string }>;
        return rows.flatMap(row => (JSON.parse(row.error) as string[]).map(error => ({ id: row.track_file_id, error })));
    }

    /** A manual retry preserves prior-generation evidence and selects only
     * failed file identities. Successful files are never reselected by position. */
    static retryFailed(commandId: number, workerId: string): FileWorkPlan {
        return db.transaction(() => {
            this.assertOwner(commandId, workerId);
            const plan = this.get(commandId)!;
            const files = (db.prepare(`SELECT track_file_id, identity_snapshot, error FROM CommandFileWork
                WHERE command_id = ? AND generation = ? AND error IS NOT NULL ORDER BY ordinal`)
                .all(commandId, plan.generation) as Array<{ track_file_id: number; identity_snapshot: string; error: string }>)
                .filter(file => !file.error.includes(FILE_CHECKPOINT_POISON_ERROR));
            if (files.length === 0) return this.get(commandId)!;
            const insert = db.prepare(`INSERT INTO CommandFileWork (command_id, generation, ordinal, track_file_id, identity_snapshot)
                VALUES (?, ?, ?, ?, ?)`);
            files.forEach((file, ordinal) => insert.run(commandId, plan.generation + 1, ordinal, file.track_file_id, file.identity_snapshot));
            db.prepare(`UPDATE CommandFileWorkPlans SET generation = generation + 1, total = ?, cursor = 0,
                retagged = 0, skipped = 0, missing = 0, error_count = 0, plan_complete = 1, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?`)
                .run(files.length, commandId);
            return this.get(commandId)!;
        })();
    }

    /** Empty streaming plan. A second call leaves an existing plan alone. */
    static openPlan(commandId: number, workerId: string, revision: string, operation: "retag" | "strip"): void {
        db.transaction(() => {
            this.assertOwner(commandId, workerId);
            if (this.get(commandId)) return;
            db.prepare(`INSERT INTO CommandFileWorkPlans
                (command_id, operation, config_revision, total, plan_complete) VALUES (?, ?, ?, 0, 0)`)
                .run(commandId, operation, revision);
        })();
    }

    /** Append one album. Ordinals continue from the current total. */
    static appendAlbum(commandId: number, workerId: string, files: PlannedFile[]): void {
        if (files.length === 0) return;
        db.transaction(() => {
            this.assertOwner(commandId, workerId);
            const plan = this.get(commandId);
            if (!plan || planIsComplete(plan)) return;
            this.insertAlbumRows(commandId, plan, files);
        })();
    }

    private static insertAlbumRows(commandId: number, plan: FileWorkPlan, files: PlannedFile[]): void {
        const insert = db.prepare(`INSERT INTO CommandFileWork (command_id, generation, ordinal, track_file_id, identity_snapshot)
            VALUES (?, ?, ?, ?, ?)`);
        let ordinal = plan.total;
        for (const file of files) {
            insert.run(commandId, plan.generation, ordinal, file.id, file.identity);
            ordinal += 1;
        }
        db.prepare(`UPDATE CommandFileWorkPlans SET total = ?, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?`)
            .run(ordinal, commandId);
    }

    static markPlanComplete(commandId: number, workerId: string): void {
        db.transaction(() => {
            this.assertOwner(commandId, workerId);
            db.prepare(`UPDATE CommandFileWorkPlans SET plan_complete = 1, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?`)
                .run(commandId);
        })();
    }

    /** Unsettled files from the cursor that share the cursor file's folder. */
    static albumFromCursor(commandId: number): {
        folder: string;
        files: Array<{ ordinal: number; id: number; fileType: string | null; filePath: string | null }>;
    } | null {
        const plan = this.get(commandId);
        if (!plan || plan.cursor >= plan.total) return null;
        const rows = db.prepare(`SELECT work.ordinal, work.track_file_id, track.file_path, track.file_type
            FROM CommandFileWork work
            LEFT JOIN TrackFiles track ON track.id = work.track_file_id
            WHERE work.command_id = ? AND work.generation = ? AND work.ordinal >= ? AND work.status != 'settled'
            ORDER BY work.ordinal`).all(commandId, plan.generation, plan.cursor) as Array<{
            ordinal: number; track_file_id: number; file_path: string | null; file_type: string | null;
        }>;
        if (rows.length === 0) return null;
        const folder = albumFolderOf(rows[0].file_path ?? "");
        const files: Array<{ ordinal: number; id: number; fileType: string | null; filePath: string | null }> = [];
        for (const row of rows) {
            if (albumFolderOf(row.file_path ?? "") !== folder) break;
            files.push({
                ordinal: row.ordinal,
                id: row.track_file_id,
                fileType: row.file_type == null ? null : String(row.file_type),
                filePath: row.file_path,
            });
        }
        return { folder, files };
    }

    /** Mark the album's I/O files started before they are opened. A drifted
     * catalogue identity is refreshed here and reported; it does not abort. */
    static claimAlbum(commandId: number, workerId: string, ordinals: number[]): number[] {
        return db.transaction(() => {
            this.assertOwner(commandId, workerId);
            const plan = this.get(commandId)!;
            const drifted: number[] = [];
            for (const ordinal of ordinals) {
                const file = db.prepare(`SELECT track_file_id, identity_snapshot FROM CommandFileWork
                    WHERE command_id = ? AND generation = ? AND ordinal = ? AND status IN ('pending', 'started')`)
                    .get(commandId, plan.generation, ordinal) as { track_file_id: number; identity_snapshot: string } | undefined;
                if (!file) continue;
                const current = db.prepare(`SELECT ${fileColumns} FROM TrackFiles WHERE id = ?`).get(file.track_file_id) as FileRow | undefined;
                let identity = file.identity_snapshot;
                if (current && snapshot(current) !== identity) {
                    identity = snapshot(current);
                    drifted.push(file.track_file_id);
                }
                db.prepare(`UPDATE CommandFileWork SET status = 'started', identity_snapshot = ?, intent_path = ?,
                    intent_size = ?, intent_modified_at = ?, started_at = CURRENT_TIMESTAMP
                    WHERE command_id = ? AND generation = ? AND ordinal = ? AND status IN ('pending', 'started')`)
                    .run(identity, current?.file_path ?? null, current?.file_size ?? null, current?.modified_at ?? null,
                        commandId, plan.generation, ordinal);
            }
            return drifted;
        })();
    }

    /**
     * Settle one album and, when the caller already selected it, append the
     * next album in the same transaction. `nextFiles === null` marks the plan
     * complete. Fingerprints passed in `expectFingerprint` are re-read here;
     * a mismatch rolls the album back so the caller can open those files.
     */
    static finishAlbum(
        commandId: number,
        workerId: string,
        outcomes: AlbumOutcome[],
        nextFiles: PlannedFile[] | null,
    ): FileWorkPlan {
        return db.transaction(() => {
            this.assertOwner(commandId, workerId);
            const plan = this.get(commandId)!;
            let cursor = plan.cursor;
            let retagged = 0;
            let skipped = 0;
            let missing = 0;
            let errorCount = 0;
            for (const item of outcomes) {
                if (item.ordinal !== cursor) throw new Error(`Retag album outcome is not the cursor file #${item.id}`);
                const expected = db.prepare(`SELECT identity_snapshot, status FROM CommandFileWork
                    WHERE command_id = ? AND generation = ? AND ordinal = ? AND track_file_id = ?`)
                    .get(commandId, plan.generation, item.ordinal, item.id) as { identity_snapshot: string; status: string } | undefined;
                const current = db.prepare(`SELECT ${fileColumns}, managed_tag_fingerprint, file_hash FROM TrackFiles WHERE id = ?`)
                    .get(item.id) as (FileRow & { managed_tag_fingerprint: string | null; file_hash: string | null }) | undefined;
                if (!expected || (expected.status !== "pending" && expected.status !== "started")) {
                    throw new Error("Retag file outcome does not own the current work item");
                }
                if (current && snapshot(current) !== expected.identity_snapshot) {
                    throw new Error(`File #${item.id} changed catalogue identity during the retag plan`);
                }
                if (!current && item.result.missing === 0 && item.result.errors.length === 0) {
                    throw new Error(`File #${item.id} changed identity before its retag outcome was committed`);
                }
                if (item.expectFingerprint != null && current) {
                    const stored = current.managed_tag_fingerprint
                        ?? (current.file_hash?.startsWith("retag:v1:") ? current.file_hash : null);
                    if (stored !== item.expectFingerprint) {
                        throw new Error(`fingerprint changed for file #${item.id}`);
                    }
                }
                const result = item.result;
                const written = db.prepare(`UPDATE CommandFileWork SET status = 'settled', retagged = ?, skipped = ?, missing = ?,
                    error = ?, settled_at = CURRENT_TIMESTAMP
                    WHERE command_id = ? AND generation = ? AND ordinal = ? AND track_file_id = ? AND status IN ('pending', 'started')`)
                    .run(result.retagged, result.skipped, result.missing,
                        result.errors.length ? JSON.stringify(result.errors.map(error => error.error)) : null,
                        commandId, plan.generation, item.ordinal, item.id);
                if (written.changes !== 1) throw new Error("Retag file outcome does not own the current work item");
                if (item.fact) {
                    db.prepare(`UPDATE TrackFiles SET file_size = ?, modified_at = ?, managed_tag_fingerprint = ?,
                        verified_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(item.fact.size, item.fact.modifiedAt, item.fact.fingerprint, item.id);
                }
                retagged += result.retagged;
                skipped += result.skipped;
                missing += result.missing;
                errorCount += result.errors.length;
                cursor += 1;
            }
            db.prepare(`UPDATE CommandFileWorkPlans SET cursor = ?, retagged = retagged + ?, skipped = skipped + ?,
                missing = missing + ?, error_count = error_count + ?, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?`)
                .run(cursor, retagged, skipped, missing, errorCount, commandId);
            const updated = this.get(commandId)!;
            if (nextFiles === null) {
                db.prepare(`UPDATE CommandFileWorkPlans SET plan_complete = 1, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?`)
                    .run(commandId);
            } else if (nextFiles.length > 0 && !planIsComplete(updated)) {
                this.insertAlbumRows(commandId, updated, nextFiles);
            }
            return this.get(commandId)!;
        })();
    }
}

export interface AlbumOutcome {
    ordinal: number;
    id: number;
    result: RetagApplyResult;
    /** When set, the settle write re-reads the stored fingerprint and rolls
     * back if a concurrent import changed it. */
    expectFingerprint?: string;
    fact?: { size: number; modifiedAt: string; fingerprint: string | null };
}
