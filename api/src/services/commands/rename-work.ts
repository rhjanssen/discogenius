import { createHash } from "node:crypto";
import { db, withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { RenameTrackFileService } from "../mediafiles/rename-track-file-service.js";
import { FileMutationJournal } from "../mediafiles/file-mutation-journal.js";
import { decodeSyntheticId, tableIdColumn } from "../mediafiles/rename-track-file-paths.js";
import type { RenameApplyResult } from "../mediafiles/library-files.js";
import type { CommandModel } from "./command-model.js";
import type { CommandHandlerContext } from "./handlers/handler-context.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import { FILE_CHECKPOINT_POISON_ERROR, FILE_CHECKPOINT_RESTART_LIMIT } from "./command-liveness-policy.js";
import { albumFolderOf } from "./command-file-work-repository.js";

type Plan = { command_id: number; generation: number; config_revision: string; total: number; cursor: number;
    result: string; plan_complete?: number };
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

function renamePlanComplete(plan: Plan): boolean {
    return plan.plan_complete !== 0;
}

/** A restart found this album claimed and not settled. Count the claim on
 * every started row at or after the cursor. At the bound, poison only the
 * cursor file and put the rest back to pending. Settled rows stay settled. */
export function reclaimRenameCheckpoint(commandId: number): RenameCheckpointReclaim {
    return db.transaction(() => {
        const plan = getPlan(commandId);
        if (!plan) return { cursor: 0, total: 0, skippedFiles: 0 };
        const started = db.prepare(`SELECT ordinal, file_id, restart_claims FROM CommandRenameWork
            WHERE command_id = ? AND generation = ? AND ordinal >= ? AND status = 'started'
            ORDER BY ordinal`)
            .all(commandId, plan.generation, plan.cursor) as Array<{ ordinal: number; file_id: number; restart_claims: number }>;
        let skippedFiles = 0;
        const cursorRow = started.find(row => row.ordinal === plan.cursor);
        if (cursorRow && Number(cursorRow.restart_claims) + 1 >= FILE_CHECKPOINT_RESTART_LIMIT) {
            const claims = Number(cursorRow.restart_claims) + 1;
            const aggregate = JSON.parse(plan.result) as RenameApplyResult;
            aggregate.skipped += 1;
            aggregate.errors.push({ id: cursorRow.file_id, error: FILE_CHECKPOINT_POISON_ERROR });
            const fileResult: RenameApplyResult = { ...empty(), skipped: 1, errors: [{ id: cursorRow.file_id, error: FILE_CHECKPOINT_POISON_ERROR }] };
            db.prepare(`UPDATE CommandRenameWork SET status = 'settled', restart_claims = ?, result = ?
                WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                .run(claims, JSON.stringify(fileResult), commandId, plan.generation, cursorRow.ordinal);
            db.prepare("UPDATE CommandRenamePlans SET cursor = cursor + 1, result = ? WHERE command_id = ? AND cursor = ?")
                .run(JSON.stringify(aggregate), commandId, plan.cursor);
            for (const row of started) {
                if (row.ordinal === cursorRow.ordinal) continue;
                db.prepare(`UPDATE CommandRenameWork SET status = 'pending', restart_claims = ?
                    WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                    .run(Number(row.restart_claims) + 1, commandId, plan.generation, row.ordinal);
            }
            skippedFiles = 1;
        } else {
            for (const row of started) {
                db.prepare(`UPDATE CommandRenameWork SET status = 'pending', restart_claims = ?
                    WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                    .run(Number(row.restart_claims) + 1, commandId, plan.generation, row.ordinal);
            }
        }
        const next = getPlan(commandId)!;
        return { cursor: next.cursor, total: next.total, skippedFiles };
    })();
}

function renameFolder(fileId: number): string {
    const decoded = decodeSyntheticId(fileId);
    const row = db.prepare(`SELECT file_path FROM ${decoded.tableName} WHERE ${tableIdColumn(decoded.tableName)} = ?`)
        .get(decoded.id) as { file_path?: string } | undefined;
    return albumFolderOf(row?.file_path ?? `${decoded.tableName}:${decoded.id}`);
}

function nextRenameAlbum(ids: number[], planned: Set<number>): number[] | null {
    const remaining = ids.filter(id => !planned.has(id));
    if (remaining.length === 0) return null;
    const folder = renameFolder(remaining[0]);
    const album: number[] = [];
    for (const id of remaining) {
        if (renameFolder(id) !== folder) break;
        album.push(id);
    }
    return album;
}

/** One album at a time. A complete plan is not reselected. The album's files
 * are claimed together, renamed one at a time (the journal holds the folder
 * lock), and settled in one write. There is no 25-file disk slice: the lease
 * heartbeat covers the command, and folder locks keep an import from waiting
 * behind the whole library. */
export async function runRenameWorkUnit(job: CommandModel, ctx: CommandHandlerContext,
    resolveIds: () => number[] | Promise<number[]>, reconcileSidecars: boolean): Promise<RenameApplyResult> {
    assertOwner(job);
    const revision = renamePlanRevision();
    let plan = getPlan(job.id);
    if (plan && plan.config_revision !== revision) throw new Error("Rename settings changed during this plan. Start a new rename with the current settings.");
    let cached: number[] | null = null;
    const loadIds = async (): Promise<number[]> => {
        if (cached) return cached;
        cached = [...new Set(await Promise.resolve(resolveIds()))];
        if (cached.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid rename file identity");
        return cached;
    };
    if (!plan) {
        const first = nextRenameAlbum(await loadIds(), new Set());
        await withSqliteWriteGate(() => db.transaction(() => {
            assertOwner(job);
            if (getPlan(job.id)) return;
            db.prepare(`INSERT INTO CommandRenamePlans (command_id, config_revision, total, result, plan_complete)
                VALUES (?, ?, 0, ?, 0)`).run(job.id, revision, JSON.stringify(empty()));
            if (!first) {
                db.prepare("UPDATE CommandRenamePlans SET plan_complete = 1 WHERE command_id = ?").run(job.id);
                return;
            }
            const insert = db.prepare(`INSERT INTO CommandRenameWork
                (command_id, generation, ordinal, file_id, identity_snapshot) VALUES (?, 1, ?, ?, ?)`);
            first.forEach((id, ordinal) => insert.run(job.id, ordinal, id, identity(id)));
            db.prepare("UPDATE CommandRenamePlans SET total = ? WHERE command_id = ?").run(first.length, job.id);
        })(), "rename:plan");
        plan = getPlan(job.id)!;
    }
    if (renamePlanComplete(plan) && plan.cursor === plan.total) {
        const failed = outcomes(plan).filter(item => (JSON.parse(item.result) as RenameApplyResult).errors
            .some(error => error.error !== FILE_CHECKPOINT_POISON_ERROR));
        if (failed.length > 0) {
            plan = await withSqliteWriteGate(() => db.transaction(() => {
                assertOwner(job);
                const insert = db.prepare("INSERT INTO CommandRenameWork (command_id, generation, ordinal, file_id, identity_snapshot) VALUES (?, ?, ?, ?, ?)");
                failed.forEach((item, ordinal) => insert.run(job.id, plan!.generation + 1, ordinal, item.file_id, item.identity_snapshot));
                db.prepare(`UPDATE CommandRenamePlans SET generation = generation + 1, total = ?, cursor = 0, result = ?,
                    plan_complete = 1 WHERE command_id = ?`).run(failed.length, JSON.stringify(empty()), job.id);
                return getPlan(job.id)!;
            })(), "rename:failed-files");
        }
    }
    const resumed = job.payload?.restartResume ? "resumed after restart - " : "";
    while (plan.cursor < plan.total || !renamePlanComplete(plan)) {
        if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Rename cancellation requested");
        if (FileMutationJournal.hasPending()) throw new Error("Recover pending file mutations before continuing rename");
        if (plan.cursor >= plan.total) {
            const planned = new Set((db.prepare("SELECT file_id FROM CommandRenameWork WHERE command_id = ? AND generation = ?")
                .all(job.id, plan.generation) as Array<{ file_id: number }>).map(row => row.file_id));
            const album = nextRenameAlbum(await loadIds(), planned);
            if (!album) {
                await withSqliteWriteGate(() => {
                    assertOwner(job);
                    db.prepare("UPDATE CommandRenamePlans SET plan_complete = 1 WHERE command_id = ?").run(job.id);
                }, "rename:plan-complete");
                plan = getPlan(job.id)!;
                break;
            }
            await withSqliteWriteGate(() => db.transaction(() => {
                assertOwner(job);
                const current = getPlan(job.id)!;
                const insert = db.prepare(`INSERT INTO CommandRenameWork
                    (command_id, generation, ordinal, file_id, identity_snapshot) VALUES (?, ?, ?, ?, ?)`);
                album.forEach((id, index) => insert.run(job.id, current.generation, current.total + index, id, identity(id)));
                db.prepare("UPDATE CommandRenamePlans SET total = total + ? WHERE command_id = ?").run(album.length, job.id);
            })(), "rename:append");
            plan = getPlan(job.id)!;
            continue;
        }
        const albumRows = db.prepare(`SELECT work.ordinal, work.file_id, work.identity_snapshot, track.file_path
            FROM CommandRenameWork work
            LEFT JOIN TrackFiles track ON track.id = work.file_id
            WHERE work.command_id = ? AND work.generation = ? AND work.ordinal >= ? AND work.status != 'settled'
            ORDER BY work.ordinal`).all(job.id, plan.generation, plan.cursor) as Array<{
            ordinal: number; file_id: number; identity_snapshot: string; file_path: string | null;
        }>;
        const folder = albumFolderOf(albumRows[0]?.file_path ?? renameFolder(albumRows[0]?.file_id ?? 0));
        const album: typeof albumRows = [];
        for (const row of albumRows) {
            if (albumFolderOf(row.file_path ?? renameFolder(row.file_id)) !== folder) break;
            album.push(row);
        }
        if (album.length === 0) throw new Error("Rename cursor does not identify a pending file");
        await withSqliteWriteGate(() => db.transaction(() => {
            assertOwner(job);
            const mark = db.prepare(`UPDATE CommandRenameWork SET status = 'started'
                WHERE command_id = ? AND generation = ? AND ordinal = ? AND status IN ('pending', 'started')`);
            for (const row of album) mark.run(job.id, plan!.generation, row.ordinal);
        })(), "rename:album-claim");
        const settled: Array<{ ordinal: number; fileId: number; identity: string; refused: boolean; result: RenameApplyResult }> = [];
        for (const row of album) {
            await ctx.yieldToEventLoop();
            assertOwner(job);
            if (FileMutationJournal.hasPending()) throw new Error("Recover pending file mutations before continuing rename");
            const current = identity(row.file_id);
            const refused = current !== "null" && current !== row.identity_snapshot;
            const result: RenameApplyResult = refused
                ? { ...empty(), errors: [{ id: row.file_id, error: `File #${row.file_id} changed catalogue identity during rename` }] }
                : await RenameTrackFileService.executeRenameFiles([row.file_id], {
                    reconcileSeparatedSidecars: reconcileSidecars, boundedSidecarReconciliation: true,
                });
            settled.push({ ordinal: row.ordinal, fileId: row.file_id, identity: row.identity_snapshot, refused, result });
        }
        const plannedIds = new Set((db.prepare(
            "SELECT file_id FROM CommandRenameWork WHERE command_id = ? AND generation = ?").all(job.id, plan.generation) as Array<{ file_id: number }>).map(row => row.file_id));
        const upcoming = renamePlanComplete(plan) ? null : nextRenameAlbum(await loadIds(), plannedIds);
        plan = await withSqliteWriteGate(() => db.transaction(() => {
            assertOwner(job);
            const currentPlan = getPlan(job.id)!;
            const aggregate = JSON.parse(currentPlan.result) as RenameApplyResult;
            let cursor = currentPlan.cursor;
            for (const item of settled) {
                const current = identity(item.fileId);
                if (!item.refused && current !== "null" && current !== item.identity) {
                    throw new Error(`File #${item.fileId} changed identity before rename settlement`);
                }
                for (const key of ["renamed", "skipped", "conflicts", "missing", "cleanedDirectories"] as const) aggregate[key] += item.result[key];
                aggregate.errors.push(...item.result.errors);
                const written = db.prepare(`UPDATE CommandRenameWork SET status = 'settled', result = ?
                    WHERE command_id = ? AND generation = ? AND ordinal = ? AND status = 'started'`)
                    .run(JSON.stringify(item.result), job.id, currentPlan.generation, item.ordinal);
                if (written.changes !== 1) throw new Error("Rename outcome lost its work item");
                cursor += 1;
            }
            db.prepare("UPDATE CommandRenamePlans SET cursor = ?, result = ? WHERE command_id = ?")
                .run(cursor, JSON.stringify(aggregate), job.id);
            if (upcoming && upcoming.length > 0) {
                const insert = db.prepare(`INSERT INTO CommandRenameWork
                    (command_id, generation, ordinal, file_id, identity_snapshot) VALUES (?, ?, ?, ?, ?)`);
                const total = cursor;
                upcoming.forEach((id, index) => insert.run(job.id, currentPlan.generation, total + index, id, identity(id)));
                db.prepare("UPDATE CommandRenamePlans SET total = total + ? WHERE command_id = ?").run(upcoming.length, job.id);
            } else if (!renamePlanComplete(currentPlan)) {
                db.prepare("UPDATE CommandRenamePlans SET plan_complete = 1 WHERE command_id = ?").run(job.id);
            }
            return getPlan(job.id)!;
        })(), "rename:album-settled");
        ctx.updateCommandDescription(job, {
            progress: 5 + Math.floor(plan.cursor / Math.max(plan.total, 1) * 90),
            description: `Rename - ${resumed}processed ${plan.cursor}${renamePlanComplete(plan) ? `/${plan.total}` : ""} files`,
        });
        await ctx.yieldToEventLoop();
    }
    const result = JSON.parse(plan.result) as RenameApplyResult;
    result.errors = outcomes(plan).flatMap(item => (JSON.parse(item.result) as RenameApplyResult).errors);
    return result;
}
