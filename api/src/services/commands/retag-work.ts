import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { AudioTagService, type RetagApplyResult } from "../mediafiles/audio-tag-service.js";
import { VideoTagService } from "../mediafiles/video-tag-service.js";
import type { CommandModel } from "./command-model.js";
import type { RetagWorkCheckpoint } from "./command-bodies.js";
import { CommandFileWorkRepository as Work, type FileWorkPlan } from "./command-file-work-repository.js";
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
 * at most the file that was claimed and not settled.
 *
 * Steady state is one write-gate transaction per file: settling file N claims
 * file N+1. The first file of a dispatch is claimed on its own. An unchanged
 * identity check is a read and does not take the gate. */
export async function runRetagWorkUnit(
    job: CommandModel,
    ctx: CommandHandlerContext,
    resolveIds: () => number[],
    stripOnly = false,
): Promise<RetagApplyResult & { identityChanged?: number[]; identityChangedCount?: number }> {
    if (!job.worker_id) throw new Error("Retag work requires an execution owner");
    const owner = job.worker_id;
    const revision = retagPlanRevision(stripOnly);
    const existing = Work.get(job.id);
    if (existing && existing.config_revision !== revision) {
        throw new Error("Tag settings changed during this retag plan. Start a new retag with the current settings.");
    }
    let plan: FileWorkPlan;
    if (!existing) {
        const files = Work.prepare(resolveIds());
        await withSqliteWriteGate(() => Work.create(job.id, owner, revision, files, stripOnly ? "strip" : "retag"), "retag:plan");
        const stored = Work.get(job.id);
        if (!stored) throw new Error("Retag plan was not stored");
        plan = stored;
    } else {
        plan = existing;
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
    let claimed: { id: number; fileType: string | null } | null = null;
    const identityError = (error: unknown): error is Error => error instanceof Error && /changed (catalogue )?identity/.test(error.message);
    const refreshDrift = async (): Promise<void> => {
        if (!Work.identityDrifted(job.id)) return;
        const replanned = await withSqliteWriteGate(() => Work.replanChangedIdentity(job.id, owner), "retag:replan");
        if (replanned !== null) noteIdentityChange(replanned);
        claimed = null;
    };
    try {
        while (plan.cursor < plan.total) {
            if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Retag cancellation requested");
            // The next file may already be claimed by the previous settle. Do not
            // open it once this worker no longer owns the command.
            if (claimed && !Work.executionOwned(job.id, owner)) throw new Error("Retag execution ownership changed");
            await refreshDrift();
            if (!claimed) {
                // Claim before the file is opened. A crash during the write leaves
                // this row `started`, which restart recovery can count and reclaim.
                try {
                    claimed = await withSqliteWriteGate(() => Work.begin(job.id, owner), "retag:file-claim");
                } catch (error) {
                    if (!identityError(error)) throw error;
                    const replannedAgain = await withSqliteWriteGate(() => Work.replanChangedIdentity(job.id, owner), "retag:replan");
                    if (replannedAgain !== null) noteIdentityChange(replannedAgain);
                    continue;
                }
            }
            const current = claimed;
            const result = current.fileType === null
                ? { retagged: 0, skipped: 0, missing: 1, errors: [] }
                : stripOnly
                    ? await AudioTagService.stripTags([current.id])
                : current.fileType === "video"
                    ? await VideoTagService.apply([current.id])
                    : await session.apply([current.id]);
            const unchanged = result.retagged === 0 && result.errors.length === 0
                && result.skipped + result.missing === 1;
            const nextSettled = settled + 1;
            const claimNext: boolean = plan.cursor + 1 < plan.total
                && nextSettled < 250
                && performance.now() - started < 120_000
                && !(nextSettled % 5 === 0 && hasPendingImportHandoff())
                && !CommandQueueManager.get(job.id)?.payload.cancelRequested;
            const label = claimNext ? "retag:settle-and-claim" : unchanged ? "retag:unchanged" : "retag:file-settled";
            try {
                const step = await withSqliteWriteGate((): {
                    plan: FileWorkPlan;
                    next: { id: number; fileType: string | null } | null;
                    replannedId: number | null;
                } => Work.settleAndClaimNext(job.id, owner, current.id, result, claimNext), label);
                plan = step.plan;
                if (step.replannedId !== null) noteIdentityChange(step.replannedId);
                claimed = step.next;
            } catch (error) {
                if (!identityError(error)) throw error;
                // The file was re-identified between planning and settling. Re-plan
                // just this item and process it again; after repeated races, record
                // it as skipped so one busy file can never abort the whole command.
                const attempts = (raceAttempts.get(current.id) ?? 0) + 1;
                raceAttempts.set(current.id, attempts);
                const replannedAgain = await withSqliteWriteGate(() => Work.replanChangedIdentity(job.id, owner), "retag:replan");
                if (replannedAgain !== null) noteIdentityChange(replannedAgain);
                claimed = null;
                if (attempts < 3) continue;
                const dropped = await withSqliteWriteGate((): {
                    plan: FileWorkPlan;
                    next: { id: number; fileType: string | null } | null;
                    replannedId: number | null;
                } => Work.settleAndClaimNext(job.id, owner, current.id,
                    { retagged: 0, skipped: 1, missing: 0, errors: [] }, claimNext), "retag:identity-dropped");
                plan = dropped.plan;
                if (dropped.replannedId !== null) noteIdentityChange(dropped.replannedId);
                claimed = dropped.next;
            }
            ctx.updateCommandDescription(job, {
                progress: 5 + Math.floor(plan.cursor / Math.max(plan.total, 1) * 90),
                description: `${stripOnly ? "Strip tags" : "Retag"} - ${resumed}processed ${plan.cursor}/${plan.total} files`,
            });
            settled++;
            if (!claimNext) break;
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
