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
    plan_complete: number;
}

export interface FileCheckpointReclaim {
    cursor: number;
    total: number;
    skippedFiles: number;
    planComplete: boolean;
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

/** Indexed operation records are the authority. Command payloads contain only
 * a small UI marker; settling one file never rewrites the library-wide ID plan. */
export class CommandFileWorkRepository {
    private static assertOwner(commandId: number, workerId: string): void {
        if (!db.prepare("SELECT 1 FROM commands WHERE id = ? AND status = 'started' AND worker_id = ?").get(commandId, workerId)) {
            throw new Error("Retag execution ownership changed");
        }
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
            const existing = this.get(commandId);
            if (existing?.plan_complete) return;
            const insert = db.prepare(`INSERT INTO CommandFileWork (command_id, generation, ordinal, track_file_id, identity_snapshot)
                VALUES (?, ?, ?, ?, ?)`);
            if (!existing) {
                db.prepare(`INSERT INTO CommandFileWorkPlans
                    (command_id, operation, config_revision, total, plan_complete)
                    VALUES (?, ?, ?, ?, 0)`)
                    .run(commandId, operation, revision, files.length);
                files.forEach((file, ordinal) => insert.run(commandId, 1, ordinal, file.id, file.identity));
                db.prepare("UPDATE CommandFileWorkPlans SET plan_complete = 1, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?")
                    .run(commandId);
                return;
            }
            if (existing.config_revision !== revision) {
                throw new Error("Tag settings changed during this retag plan. Start a new retag with the current settings.");
            }
            const settled = db.prepare(`SELECT COUNT(*) AS n FROM CommandFileWork
                WHERE command_id = ? AND generation = ? AND status = 'settled'`)
                .get(commandId, existing.generation) as { n: number };
            if (Number(settled.n) === 0) {
                db.prepare("DELETE FROM CommandFileWork WHERE command_id = ? AND generation = ?")
                    .run(commandId, existing.generation);
                files.forEach((file, ordinal) => insert.run(commandId, existing.generation, ordinal, file.id, file.identity));
                db.prepare(`UPDATE CommandFileWorkPlans SET operation = ?, total = ?, cursor = 0, retagged = 0,
                    skipped = 0, missing = 0, error_count = 0, plan_complete = 1, updated_at = CURRENT_TIMESTAMP
                    WHERE command_id = ?`).run(operation, files.length, commandId);
                return;
            }
            const present = new Set((db.prepare(`SELECT track_file_id FROM CommandFileWork
                WHERE command_id = ? AND generation = ?`).all(commandId, existing.generation) as Array<{ track_file_id: number }>)
                .map(row => row.track_file_id));
            let ordinal = Number((db.prepare(`SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM CommandFileWork
                WHERE command_id = ? AND generation = ?`).get(commandId, existing.generation) as { ordinal: number }).ordinal) + 1;
            for (const file of files) {
                if (present.has(file.id)) continue;
                insert.run(commandId, existing.generation, ordinal, file.id, file.identity);
                ordinal += 1;
            }
            const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM CommandFileWork
                WHERE command_id = ? AND generation = ?`).get(commandId, existing.generation) as { n: number }).n);
            db.prepare(`UPDATE CommandFileWorkPlans SET total = ?, plan_complete = 1, updated_at = CURRENT_TIMESTAMP
                WHERE command_id = ?`).run(total, commandId);
        })();
    }

    /** A process restart left the cursor row claimed. Count that claim, give
     * the file back, or settle it as a per-file error once the bound is hit.
     * Settled rows are not touched. */
    static reclaimInFlight(commandId: number): FileCheckpointReclaim {
        return db.transaction(() => {
            const plan = this.get(commandId);
            if (!plan) return { cursor: 0, total: 0, skippedFiles: 0, planComplete: false };
            const file = db.prepare(`SELECT ordinal, track_file_id, restart_claims FROM CommandFileWork
                WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                .get(commandId, plan.generation, plan.cursor) as {
                ordinal: number; track_file_id: number; restart_claims: number;
            } | undefined;
            let skippedFiles = 0;
            if (file) {
                const claims = Number(file.restart_claims) + 1;
                if (claims >= FILE_CHECKPOINT_RESTART_LIMIT) {
                    db.prepare(`UPDATE CommandFileWork SET status = 'settled', restart_claims = ?, retagged = 0,
                        skipped = 1, missing = 0, error = ?, settled_at = CURRENT_TIMESTAMP
                        WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                        .run(claims, JSON.stringify([FILE_CHECKPOINT_POISON_ERROR]), commandId, plan.generation, file.ordinal);
                    db.prepare(`UPDATE CommandFileWorkPlans SET cursor = cursor + 1, skipped = skipped + 1,
                        error_count = error_count + 1, updated_at = CURRENT_TIMESTAMP
                        WHERE command_id = ? AND cursor = ?`).run(commandId, plan.cursor);
                    skippedFiles = 1;
                } else {
                    db.prepare(`UPDATE CommandFileWork SET status = 'pending', restart_claims = ?, started_at = NULL
                        WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                        .run(claims, commandId, plan.generation, file.ordinal);
                }
            }
            const next = this.get(commandId)!;
            return {
                cursor: next.cursor,
                total: next.total,
                skippedFiles,
                planComplete: next.plan_complete === 1,
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
                retagged = 0, skipped = 0, missing = 0, error_count = 0, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?`)
                .run(files.length, commandId);
            return this.get(commandId)!;
        })();
    }
}
