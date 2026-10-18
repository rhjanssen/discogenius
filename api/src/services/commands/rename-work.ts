import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { db, withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { RenameTrackFileService } from "../mediafiles/rename-track-file-service.js";
import { FileMutationJournal } from "../mediafiles/file-mutation-journal.js";
import { decodeSyntheticId, tableIdColumn } from "../mediafiles/rename-track-file-paths.js";
import type { RenameApplyResult } from "../mediafiles/library-files.js";
import type { CommandModel } from "./command-model.js";
import type { CommandHandlerContext } from "./handlers/handler-context.js";
import { CommandContinuation } from "./command-continuation.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import { FILE_CHECKPOINT_POISON_ERROR, FILE_CHECKPOINT_RESTART_LIMIT } from "./command-liveness-policy.js";

type Plan = { command_id: number; generation: number; config_revision: string; total: number; cursor: number;
    result: string };
export interface RenameCheckpointReclaim {
    cursor: number; total: number; skippedFiles: number;
}
const empty = (): RenameApplyResult => ({ renamed: 0, skipped: 0, conflicts: 0, missing: 0, cleanedDirectories: 0, errors: [] });
const identityFields = ["artist_metadata_id", "artist_id", "recording_id", "track_id", "track_file_id", "album_edition_id",
    "release_group_id", "file_type", "canonical_artist_mbid", "canonical_recording_mbid", "canonical_track_mbid",
    "canonical_release_mbid", "canonical_release_group_mbid"];
function identity(id: number): string {
    const decoded = decodeSyntheticId(id);
    const row = db.prepare(`SELECT * FROM ${decoded.tableName} WHERE ${tableIdColumn(decoded.tableName)} = ?`)
        .get(decoded.id) as Record<string, unknown> | undefined;
    return JSON.stringify(row ? Object.fromEntries(identityFields.map(key => [key, row[key] ?? null])) : null);
}
function assertOwner(job: CommandModel): void {
    if (!job.worker_id || !db.prepare("SELECT 1 FROM commands WHERE id = ? AND status = 'started' AND worker_id = ?")
        .get(job.id, job.worker_id)) throw new Error("Rename execution ownership changed");
}
const getPlan = (id: number): Plan | undefined => db.prepare("SELECT * FROM CommandRenamePlans WHERE command_id = ?").get(id) as Plan | undefined;

/** Same inputs the rename unit hashes. A resumed plan must match this byte for byte. */
export function renamePlanRevision(): string {
    return createHash("sha256").update(JSON.stringify({
        path: getConfigSection("path"), naming: getConfigSection("naming"), metadata: getConfigSection("metadata"),
    })).digest("hex");
}
function outcomes(plan: Plan): Array<{ file_id: number; identity_snapshot: string; result: string }> {
    return db.prepare("SELECT file_id, identity_snapshot, result FROM CommandRenameWork WHERE command_id = ? AND generation = ? AND result IS NOT NULL ORDER BY ordinal")
        .all(plan.command_id, plan.generation) as Array<{ file_id: number; identity_snapshot: string; result: string }>;
}

/** A restart found this file claimed and not settled. Count the claim. At the
 * bound, record a per-file error and leave every settled row alone. */
export function reclaimRenameCheckpoint(commandId: number): RenameCheckpointReclaim {
    return db.transaction(() => {
        const plan = getPlan(commandId);
        if (!plan) return { cursor: 0, total: 0, skippedFiles: 0 };
        const row = db.prepare(`SELECT ordinal, file_id, restart_claims FROM CommandRenameWork
            WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
            .get(commandId, plan.generation, plan.cursor) as { ordinal: number; file_id: number; restart_claims: number } | undefined;
        let skippedFiles = 0;
        if (row) {
            const claims = Number(row.restart_claims) + 1;
            if (claims >= FILE_CHECKPOINT_RESTART_LIMIT) {
                const aggregate = JSON.parse(plan.result) as RenameApplyResult;
                aggregate.skipped += 1;
                aggregate.errors.push({ id: row.file_id, error: FILE_CHECKPOINT_POISON_ERROR });
                const fileResult: RenameApplyResult = { ...empty(), skipped: 1, errors: [{ id: row.file_id, error: FILE_CHECKPOINT_POISON_ERROR }] };
                db.prepare(`UPDATE CommandRenameWork SET status = 'settled', restart_claims = ?, result = ?
                    WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                    .run(claims, JSON.stringify(fileResult), commandId, plan.generation, row.ordinal);
                db.prepare("UPDATE CommandRenamePlans SET cursor = cursor + 1, result = ? WHERE command_id = ? AND cursor = ?")
                    .run(JSON.stringify(aggregate), commandId, plan.cursor);
                skippedFiles = 1;
            } else {
                db.prepare(`UPDATE CommandRenameWork SET status = 'pending', restart_claims = ?
                    WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                    .run(claims, commandId, plan.generation, row.ordinal);
            }
        }
        const next = getPlan(commandId)!;
        return { cursor: next.cursor, total: next.total, skippedFiles };
    })();
}

/** File paths may change through a linked-extra move. Catalogue identity may
 * not. Each physical mutation has its own recovery journal; the command plan
 * settles bounded work and releases disk admission between dispatches.
 * Settled rows survive a process restart. */
export async function runRenameWorkUnit(job: CommandModel, ctx: CommandHandlerContext,
    resolveIds: () => number[] | Promise<number[]>, reconcileSidecars: boolean): Promise<RenameApplyResult> {
    assertOwner(job);
    const revision = renamePlanRevision();
    let plan = getPlan(job.id);
    if (plan && plan.config_revision !== revision) throw new Error("Rename settings changed during this plan. Start a new rename with the current settings.");
    if (!plan) {
        const ids = [...new Set(await Promise.resolve(resolveIds()))];
        if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid rename file identity");
        const files = ids.map(id => ({ id, identity: identity(id) }));
        await withSqliteWriteGate(() => db.transaction(() => {
            assertOwner(job);
            // Same rule as retag: the plan row commits with every work row,
            // so a row that already exists is complete and must not be refilled.
            if (getPlan(job.id)) return;
            db.prepare("INSERT INTO CommandRenamePlans (command_id, config_revision, total, result) VALUES (?, ?, ?, ?)")
                .run(job.id, revision, files.length, JSON.stringify(empty()));
            const insert = db.prepare(`INSERT INTO CommandRenameWork
                (command_id, generation, ordinal, file_id, identity_snapshot) VALUES (?, 1, ?, ?, ?)`);
            files.forEach((file, ordinal) => insert.run(job.id, ordinal, file.id, file.identity));
        })(), "rename:plan");
        plan = getPlan(job.id)!;
    }
    if (plan.cursor === plan.total) {
        const failed = outcomes(plan).filter(item => (JSON.parse(item.result) as RenameApplyResult).errors
            .some(error => error.error !== FILE_CHECKPOINT_POISON_ERROR));
        if (failed.length > 0) {
            plan = await withSqliteWriteGate(() => db.transaction(() => {
                assertOwner(job);
                const insert = db.prepare("INSERT INTO CommandRenameWork (command_id, generation, ordinal, file_id, identity_snapshot) VALUES (?, ?, ?, ?, ?)");
                failed.forEach((item, ordinal) => insert.run(job.id, plan!.generation + 1, ordinal, item.file_id, item.identity_snapshot));
                db.prepare("UPDATE CommandRenamePlans SET generation = generation + 1, total = ?, cursor = 0, result = ? WHERE command_id = ?")
                    .run(failed.length, JSON.stringify(empty()), job.id);
                return getPlan(job.id)!;
            })(), "rename:failed-files");
        }
    }
    const started = performance.now();
    let settled = 0;
    const resumed = job.payload?.restartResume ? "resumed after restart - " : "";
    while (plan.cursor < plan.total) {
        if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Rename cancellation requested");
        if (FileMutationJournal.hasPending()) throw new Error("Recover pending file mutations before continuing rename");
        const file = await withSqliteWriteGate(() => {
            assertOwner(job);
            const item = db.prepare("SELECT file_id, identity_snapshot FROM CommandRenameWork WHERE command_id = ? AND generation = ? AND ordinal = ? AND status IN ('pending', 'started')")
                .get(job.id, plan!.generation, plan!.cursor) as { file_id: number; identity_snapshot: string } | undefined;
            if (!item) throw new Error("Rename cursor does not identify a pending file");
            const current = identity(item.file_id);
            const refused = current !== "null" && current !== item.identity_snapshot;
            db.prepare("UPDATE CommandRenameWork SET status = 'started' WHERE command_id = ? AND generation = ? AND ordinal = ?").run(job.id, plan!.generation, plan!.cursor);
            return { ...item, refused };
        }, "rename:file-intent");
        // Refuse this file without stopping every subsequent file in a library
        // plan. Keep its error and original identity for review/manual retry.
        const result: RenameApplyResult = file.refused
            ? { ...empty(), errors: [{ id: file.file_id, error: `File #${file.file_id} changed catalogue identity during rename` }] }
            : await RenameTrackFileService.executeRenameFiles([file.file_id], {
            reconcileSeparatedSidecars: reconcileSidecars, boundedSidecarReconciliation: true,
        });
        plan = await withSqliteWriteGate(() => db.transaction(() => {
            assertOwner(job);
            const current = identity(file.file_id);
            if (!file.refused && current !== "null" && current !== file.identity_snapshot) throw new Error(`File #${file.file_id} changed identity before rename settlement`);
            const aggregate = JSON.parse(plan!.result) as RenameApplyResult;
            for (const key of ["renamed", "skipped", "conflicts", "missing", "cleanedDirectories"] as const) aggregate[key] += result[key];
            const written = db.prepare("UPDATE CommandRenameWork SET status = 'settled', result = ? WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'")
                .run(JSON.stringify(result), job.id, plan!.generation, plan!.cursor);
            if (written.changes !== 1) throw new Error("Rename outcome lost its work item");
            db.prepare("UPDATE CommandRenamePlans SET cursor = cursor + 1, result = ? WHERE command_id = ?")
                .run(JSON.stringify(aggregate), job.id);
            return getPlan(job.id)!;
        })(), "rename:file-settled");
        ctx.updateCommandDescription(job, { progress: 5 + Math.floor(plan.cursor / Math.max(plan.total, 1) * 90),
            description: `Rename - ${resumed}processed ${plan.cursor}/${plan.total} files` });
        settled++;
        if (settled >= 25 || performance.now() - started >= 30_000) break;
        await ctx.yieldToEventLoop();
    }
    if (plan.cursor < plan.total) throw new CommandContinuation({ renameWork: { version: 1 } });
    const result = JSON.parse(plan.result) as RenameApplyResult;
    result.errors = outcomes(plan).flatMap(item => (JSON.parse(item.result) as RenameApplyResult).errors);
    return result;
}
