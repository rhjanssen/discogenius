import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { AudioTagService, type RetagApplyResult } from "../mediafiles/audio-tag-service.js";
import { VideoTagService } from "../mediafiles/video-tag-service.js";
import type { CommandModel } from "./command-model.js";
import type { RetagWorkCheckpoint } from "./command-bodies.js";
import { CommandFileWorkRepository as Work } from "./command-file-work-repository.js";
import { fileCheckpointResumePrefix } from "./command-file-checkpoint.js";
import { CommandContinuation } from "./command-continuation.js";
import type { CommandHandlerContext } from "./handlers/handler-context.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import { hasPendingImportHandoff } from "./import-admission.js";

/** The plan is valid only for the tag settings and the strip/retag mode that
 * built it. A restart must reproduce this exact value and then skip selection. */
export function retagPlanRevision(stripOnly = false): string {
    return createHash("sha256").update(JSON.stringify({
        metadata: getConfigSection("metadata"), quality: getConfigSection("quality"), stripOnly,
    })).digest("hex");
}

/** A dispatch owns the disk slot for up to 250 settled files or 120 seconds,
 * but hands it back after the current file as soon as a finished download is
 * waiting to import. (A fixed 25-file/30s slice re-queued the command every
 * ~20s and dropped the per-album cover cache each time.) Settled CommandFileWork
 * rows are the checkpoint. A process restart continues this plan and redoes
 * at most the file that was claimed and not settled. */
export async function runRetagWorkUnit(
    job: CommandModel,
    ctx: CommandHandlerContext,
    resolveIds: () => number[],
    stripOnly = false,
): Promise<RetagApplyResult & { identityChanged?: number[]; identityChangedCount?: number }> {
    if (!job.worker_id) throw new Error("Retag work requires an execution owner");
    const owner = job.worker_id;
    const revision = retagPlanRevision(stripOnly);
    let plan = Work.get(job.id);
    if (plan && plan.config_revision !== revision) {
        throw new Error("Tag settings changed during this retag plan. Start a new retag with the current settings.");
    }
    if (!plan?.plan_complete) {
        const files = Work.prepare(resolveIds());
        await withSqliteWriteGate(() => Work.create(job.id, owner, revision, files, stripOnly ? "strip" : "retag"), "retag:plan");
        plan = Work.get(job.id)!;
    }
    if (plan.cursor === plan.total && plan.error_count > 0) {
        plan = await withSqliteWriteGate(() => Work.retryFailed(job.id, owner), "retag:failed-files");
    }
    const started = performance.now();
    let settled = 0;
    const session = AudioTagService.createRetagSession();
    const resumed = fileCheckpointResumePrefix(job.payload);
    const prior = (job.payload as { retagWork?: RetagWorkCheckpoint }).retagWork;
    const identityChanged = [...(prior?.identityChanged ?? [])];
    let identityChangedCount = prior?.identityChangedCount ?? identityChanged.length;
    const noteIdentityChange = (fileId: number) => {
        identityChangedCount++;
        if (identityChanged.length < 500 && !identityChanged.includes(fileId)) identityChanged.push(fileId);
        console.warn(`[Retag] File #${fileId} changed catalogue identity during command ${job.id}; re-planned that file only`);
    };
    const raceAttempts = new Map<number, number>();
    try {
        while (plan.cursor < plan.total) {
            if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Retag cancellation requested");
            const replanned = await withSqliteWriteGate(() => Work.replanChangedIdentity(job.id, owner), "retag:replan");
            if (replanned !== null) noteIdentityChange(replanned);
            // Claim before the file is opened. A crash during the write leaves
            // this row `started`, which restart recovery can count and reclaim.
            let claimed: { id: number; fileType: string | null };
            try {
                claimed = await withSqliteWriteGate(() => Work.begin(job.id, owner), "retag:file-claim");
            } catch (error) {
                if (!(error instanceof Error) || !/changed (catalogue )?identity/.test(error.message)) throw error;
                const replannedAgain = await withSqliteWriteGate(() => Work.replanChangedIdentity(job.id, owner), "retag:replan");
                if (replannedAgain !== null) noteIdentityChange(replannedAgain);
                continue;
            }
            const result = claimed.fileType === null
                ? { retagged: 0, skipped: 0, missing: 1, errors: [] }
                : stripOnly
                    ? await AudioTagService.stripTags([claimed.id])
                : claimed.fileType === "video"
                    ? await VideoTagService.apply([claimed.id])
                    : await session.apply([claimed.id]);
            const unchanged = result.retagged === 0 && result.errors.length === 0
                && result.skipped + result.missing === 1;
            try {
                plan = unchanged
                    ? await withSqliteWriteGate(() => Work.settleDirect(job.id, owner, claimed.id, result), "retag:unchanged")
                    : await withSqliteWriteGate(() => Work.settle(job.id, owner, claimed.id, result), "retag:file-settled");
            } catch (error) {
                if (!(error instanceof Error) || !/changed (catalogue )?identity/.test(error.message)) throw error;
                // The file was re-identified between planning and settling. Re-plan
                // just this item and process it again; after repeated races, record
                // it as skipped so one busy file can never abort the whole command.
                const attempts = (raceAttempts.get(claimed.id) ?? 0) + 1;
                raceAttempts.set(claimed.id, attempts);
                const replannedAgain = await withSqliteWriteGate(() => Work.replanChangedIdentity(job.id, owner), "retag:replan");
                if (replannedAgain !== null) noteIdentityChange(replannedAgain);
                if (attempts < 3) continue;
                plan = await withSqliteWriteGate(() => Work.settleDirect(job.id, owner, claimed.id,
                    { retagged: 0, skipped: 1, missing: 0, errors: [] }), "retag:identity-dropped");
            }
            ctx.updateCommandDescription(job, {
                progress: 5 + Math.floor(plan.cursor / Math.max(plan.total, 1) * 90),
                description: `${stripOnly ? "Strip tags" : "Retag"} - ${resumed}processed ${plan.cursor}/${plan.total} files`,
            });
            settled++;
            if (settled >= 250 || performance.now() - started >= 120_000) break;
            if (settled % 5 === 0 && hasPendingImportHandoff()) break;
            await ctx.yieldToEventLoop();
        }
    } finally {
        session.close();
    }
    if (plan.cursor < plan.total) {
        throw new CommandContinuation({ retagWork: { version: 1, identityChanged, identityChangedCount } });
    }
    return { retagged: plan.retagged, skipped: plan.skipped, missing: plan.missing, errors: Work.errors(job.id),
        identityChanged, identityChangedCount };
}
