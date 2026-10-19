import { createHash } from "node:crypto";
import { db, withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { AudioTagService, type RetagApplyResult, type RetagScopeOptions } from "../mediafiles/audio-tag-service.js";
import { VideoTagService } from "../mediafiles/video-tag-service.js";
import type { CommandModel } from "./command-model.js";
import type { RetagWorkCheckpoint } from "./command-bodies.js";
import {
    CommandFileWorkRepository as Work,
    albumFolderOf,
    planIsComplete,
    type AlbumOutcome,
    type FileWorkPlan,
} from "./command-file-work-repository.js";
import { fileCheckpointResumePrefix } from "./command-file-checkpoint.js";
import type { CommandHandlerContext } from "./handlers/handler-context.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import { withAlbumFolder, withHddIoPermit, type DiskAdmissionMeta } from "./disk-admission.js";

/** The plan is valid only for the tag settings and the strip/retag mode that
 * built it. A restart must reproduce this exact value and then skip selection. */
export function retagPlanRevision(stripOnly = false): string {
    return createHash("sha256").update(JSON.stringify({
        metadata: getConfigSection("metadata"), quality: getConfigSection("quality"), stripOnly,
    })).digest("hex");
}

export type RetagWorkSource =
    | (() => number[])
    | { kind: "ids"; load: () => number[] }
    | { kind: "scope"; options: RetagScopeOptions; includeVideo?: boolean };

type AlbumFile = { ordinal: number; id: number; fileType: string | null; filePath: string | null };
type RetagSession = {
    apply: (ids: number[], options?: { deferPersistence?: boolean }) => Promise<RetagApplyResult>;
    warmAlbumCovers?: (ids: number[]) => Promise<void>;
    warnings?: () => string[];
    close: () => void;
};

const emptyResult = (): RetagApplyResult => ({ retagged: 0, skipped: 0, missing: 0, errors: [] });

function normalizeSource(source: RetagWorkSource): Exclude<RetagWorkSource, () => number[]> {
    if (typeof source === "function") return { kind: "ids", load: source };
    return source;
}

/**
 * One album at a time. The first album is inserted and started before the
 * rest of the scope exists in the plan. A complete plan (including one written
 * by the previous process) is not reselected.
 *
 * An unchanged album costs one indexed read and one write: settle the skips,
 * advance the cursor, and append the next album. No file is opened. An album
 * that needs tag writes adds one claim write before the first open, then one
 * settle write after the bytes. Each file takes the album-folder lock and one
 * HDD I/O permit, and drops both before the next file so a waiting import of
 * this album can enter. The permit is never held across the settle write.
 */
export async function runRetagWorkUnit(
    job: CommandModel,
    ctx: CommandHandlerContext,
    source: RetagWorkSource,
    stripOnly = false,
): Promise<RetagApplyResult & { identityChanged?: number[]; identityChangedCount?: number }> {
    if (!job.worker_id) throw new Error("Retag work requires an execution owner");
    const owner = job.worker_id;
    const revision = retagPlanRevision(stripOnly);
    const existing = Work.get(job.id);
    if (existing && existing.config_revision !== revision) {
        throw new Error("Tag settings changed during this retag plan. Start a new retag with the current settings.");
    }
    const normalized = normalizeSource(source);
    let idCache: number[] | null = null;
    const explicitIds = (): number[] => {
        if (idCache) return idCache;
        if (normalized.kind !== "ids") return [];
        idCache = [...new Set(normalized.load())];
        if (idCache.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid retag file identity");
        return idCache;
    };
    let plan = existing;
    if (plan && planIsComplete(plan) && plan.cursor === plan.total && plan.error_count > 0) {
        plan = await withSqliteWriteGate(() => Work.retryFailed(job.id, owner), "retag:failed-files");
    }
    const session = stripOnly ? null : AudioTagService.createRetagSession();
    const resumed = fileCheckpointResumePrefix(job.payload);
    const prior = (job.payload as { retagWork?: RetagWorkCheckpoint }).retagWork;
    const identityChanged = [...(prior?.identityChanged ?? [])];
    let identityChangedCount = prior?.identityChangedCount ?? identityChanged.length;
    const noteIdentityChange = (fileId: number) => {
        identityChangedCount++;
        if (identityChanged.length < 500 && !identityChanged.includes(fileId)) identityChanged.push(fileId);
        console.warn(`[Retag] File #${fileId} changed catalogue identity during command ${job.id}; re-planned that file only`);
    };
    const meta: DiskAdmissionMeta = { role: "retag", commandId: job.id, reason: "retag album files" };
    const selectAlbum = (generation: number): { folder: string; ids: number[] } | null => {
        if (plan && planIsComplete(plan) && plan.generation === generation && plan.cursor >= plan.total) return null;
        if (normalized.kind === "scope") {
            return AudioTagService.nextScopeAlbum(job.id, generation, normalized.options, normalized.includeVideo === true);
        }
        return nextExplicitAlbum(job.id, generation, explicitIds());
    };
    try {
        if (!plan) {
            const first = selectAlbum(1);
            const prepared = first ? Work.prepare(first.ids) : null;
            await withSqliteWriteGate(() => {
                Work.openPlan(job.id, owner, revision, stripOnly ? "strip" : "retag");
                if (prepared?.length) Work.appendAlbum(job.id, owner, prepared);
                else Work.markPlanComplete(job.id, owner);
            }, "retag:plan");
            plan = Work.get(job.id);
            if (!plan) throw new Error("Retag plan was not stored");
        }
        while (plan.cursor < plan.total || !planIsComplete(plan)) {
            if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Retag cancellation requested");
            if (!Work.executionOwned(job.id, owner)) throw new Error("Retag execution ownership changed");
            if (plan.cursor >= plan.total) {
                const upcoming = selectAlbum(plan.generation);
                if (!upcoming) {
                    await withSqliteWriteGate(() => Work.markPlanComplete(job.id, owner), "retag:plan-complete");
                    plan = Work.get(job.id)!;
                    break;
                }
                const prepared = Work.prepare(upcoming.ids);
                await withSqliteWriteGate(() => Work.appendAlbum(job.id, owner, prepared), "retag:append");
                plan = Work.get(job.id)!;
                continue;
            }
            await ctx.yieldToEventLoop();
            if (!Work.executionOwned(job.id, owner)) throw new Error("Retag execution ownership changed");
            const album = Work.albumFromCursor(job.id);
            if (!album || album.files.length === 0) throw new Error("Retag work cursor does not identify a pending file");
            plan = await runAlbum(job, ctx, owner, stripOnly, session, meta, album, noteIdentityChange, () => {
                const current = Work.get(job.id);
                if (!current || planIsComplete(current)) return null;
                const upcoming = normalized.kind === "scope"
                    ? AudioTagService.nextScopeAlbum(job.id, current.generation, normalized.options, normalized.includeVideo === true)
                    : nextExplicitAlbum(job.id, current.generation, explicitIds());
                return upcoming ? Work.prepare(upcoming.ids) : null;
            });
            ctx.updateCommandDescription(job, {
                progress: 5 + Math.floor(plan.cursor / Math.max(plan.total, 1) * 90),
                description: `${stripOnly ? "Strip tags" : "Retag"} - ${resumed}processed ${plan.cursor}${planIsComplete(plan) ? `/${plan.total}` : ""} files`,
            });
            await ctx.yieldToEventLoop();
        }
    } finally {
        session?.close();
    }
    plan = Work.get(job.id) ?? plan;
    if (!plan) return { ...emptyResult(), identityChanged, identityChangedCount };
    return {
        retagged: plan.retagged, skipped: plan.skipped, missing: plan.missing, errors: Work.errors(job.id),
        warnings: session?.warnings?.() ?? [],
        identityChanged, identityChangedCount,
    };
}

async function runAlbum(
    job: CommandModel,
    ctx: CommandHandlerContext,
    owner: string,
    stripOnly: boolean,
    session: RetagSession | null,
    meta: DiskAdmissionMeta,
    album: { folder: string; files: AlbumFile[] },
    noteIdentityChange: (fileId: number) => void,
    nextFiles: () => ReturnType<typeof Work.prepare> | null,
): Promise<FileWorkPlan> {
    const forceOpen = new Set<number>();
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const unchanged = stripOnly
            ? new Map<number, string>()
            : AudioTagService.unchangedManagedFiles(album.files.map(file => file.id));
        for (const id of forceOpen) unchanged.delete(id);
        const needsIo = (file: AlbumFile) => file.fileType === "video" || file.fileType === null || !unchanged.has(file.id);
        const ioFiles = album.files.filter(needsIo);
        const upcoming = nextFiles();
        if (ioFiles.length === 0) {
            const outcomes: AlbumOutcome[] = album.files.map(file => ({
                ordinal: file.ordinal,
                id: file.id,
                expectFingerprint: unchanged.get(file.id),
                result: { ...emptyResult(), skipped: 1 },
            }));
            try {
                return await withAlbumFolder(album.folder, meta, () => withSqliteWriteGate(
                    () => Work.finishAlbum(job.id, owner, outcomes, upcoming),
                    "retag:album-skip",
                ));
            } catch (error) {
                if (!recoverableAlbum(error) || attempt === 1) throw error;
                for (const file of album.files) forceOpen.add(file.id);
                continue;
            }
        }
        const drifted = await withSqliteWriteGate(
            () => Work.claimAlbum(job.id, owner, ioFiles.map(file => file.ordinal)),
            "retag:album-claim",
        );
        for (const fileId of drifted) noteIdentityChange(fileId);
        if (!Work.executionOwned(job.id, owner)) throw new Error("Retag execution ownership changed");
        const trackIds = ioFiles.filter(file => file.fileType === "track").map(file => file.id);
        if (session?.warmAlbumCovers && trackIds.length > 0) await session.warmAlbumCovers(trackIds);
        const outcomes: AlbumOutcome[] = [];
        for (const file of album.files) {
            if (!needsIo(file)) {
                outcomes.push({
                    ordinal: file.ordinal,
                    id: file.id,
                    expectFingerprint: unchanged.get(file.id),
                    result: { ...emptyResult(), skipped: 1 },
                });
                continue;
            }
            await ctx.yieldToEventLoop();
            if (!Work.executionOwned(job.id, owner)) throw new Error("Retag execution ownership changed");
            const applied = await withAlbumFolder(album.folder, meta, () => withHddIoPermit(meta, () => applyOne(file, stripOnly, session)));
            outcomes.push({
                ordinal: file.ordinal,
                id: file.id,
                result: countsFor(file.id, applied),
                fact: applied.fileFacts?.[0],
            });
        }
        try {
            return await withAlbumFolder(album.folder, meta, () => withSqliteWriteGate(
                () => Work.finishAlbum(job.id, owner, outcomes, upcoming),
                "retag:album-settled",
            ));
        } catch (error) {
            if (!recoverableAlbum(error) || attempt === 1) throw error;
            for (const file of album.files) forceOpen.add(file.id);
        }
    }
    throw new Error("Retag album did not settle");
}

function recoverableAlbum(error: unknown): boolean {
    return error instanceof Error && (/fingerprint changed/.test(error.message) || /changed catalogue identity/.test(error.message));
}

function countsFor(id: number, result: RetagApplyResult): RetagApplyResult {
    const errors = result.errors.filter(error => error.id === id);
    if (result.retagged > 0) return { retagged: 1, skipped: 0, missing: 0, errors };
    if (result.missing > 0) return { ...emptyResult(), missing: 1 };
    if (errors.length > 0) return { ...emptyResult(), errors };
    if (result.skipped > 0) return { ...emptyResult(), skipped: 1 };
    return { ...emptyResult(), skipped: 1 };
}

async function applyOne(
    file: AlbumFile,
    stripOnly: boolean,
    session: RetagSession | null,
): Promise<RetagApplyResult> {
    if (file.fileType === null) return { ...emptyResult(), missing: 1 };
    if (stripOnly) return AudioTagService.stripTags([file.id], { deferPersistence: true });
    if (file.fileType === "video") return VideoTagService.apply([file.id], { deferPersistence: true });
    if (!session) return { ...emptyResult(), errors: [{ id: file.id, error: "Retag session is closed" }] };
    return session.apply([file.id], { deferPersistence: true });
}

function nextExplicitAlbum(commandId: number, generation: number, ids: number[]): { folder: string; ids: number[] } | null {
    const planned = new Set((db.prepare(`SELECT track_file_id FROM CommandFileWork
        WHERE command_id = ? AND generation = ?`).all(commandId, generation) as Array<{ track_file_id: number }>)
        .map(row => row.track_file_id));
    const remaining = ids.filter(id => !planned.has(id));
    if (remaining.length === 0) return null;
    const rows = db.prepare(`SELECT id, file_path FROM TrackFiles WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(remaining)) as Array<{ id: number; file_path: string }>;
    const pathOf = new Map(rows.map(row => [row.id, row.file_path]));
    const folder = albumFolderOf(pathOf.get(remaining[0]) ?? "");
    const album: number[] = [];
    for (const id of remaining) {
        if (albumFolderOf(pathOf.get(id) ?? "") !== folder) break;
        album.push(id);
    }
    return { folder, ids: album };
}
