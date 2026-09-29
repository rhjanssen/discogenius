import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { AudioTagService, type RetagApplyResult } from "../mediafiles/audio-tag-service.js";
import { VideoTagService } from "../mediafiles/video-tag-service.js";
import type { CommandModel } from "./command-model.js";
import { CommandFileWorkRepository as Work } from "./command-file-work-repository.js";
import { CommandContinuation } from "./command-continuation.js";
import type { CommandHandlerContext } from "./handlers/handler-context.js";
import { CommandQueueManager } from "./command-queue-manager.js";

/** A dispatch owns the disk slot for at most 25 settled files or 30 seconds
 * between files. File intents/results are durable indexed records. An in-flight
 * write is deliberately not declared safe for automatic replay. */
export async function runRetagWorkUnit(
    job: CommandModel,
    ctx: CommandHandlerContext,
    resolveIds: () => number[],
    stripOnly = false,
): Promise<RetagApplyResult> {
    if (!job.worker_id) throw new Error("Retag work requires an execution owner");
    const owner = job.worker_id;
    const revision = createHash("sha256").update(JSON.stringify({
        metadata: getConfigSection("metadata"), quality: getConfigSection("quality"),
        stripOnly,
    })).digest("hex");
    let plan = Work.get(job.id);
    if (!plan) {
        const files = Work.prepare(resolveIds());
        await withSqliteWriteGate(() => Work.create(job.id, owner, revision, files, stripOnly ? "strip" : "retag"), "retag:plan");
        plan = Work.get(job.id)!;
    }
    if (plan.config_revision !== revision) {
        throw new Error("Tag settings changed during this retag plan. Start a new retag with the current settings.");
    }
    if (plan.cursor === plan.total && plan.error_count > 0) {
        plan = await withSqliteWriteGate(() => Work.retryFailed(job.id, owner), "retag:failed-files");
    }
    const started = performance.now();
    let settled = 0;
    const session = AudioTagService.createRetagSession();
    try {
        while (plan.cursor < plan.total) {
            if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Retag cancellation requested");
            const file = await withSqliteWriteGate(() => Work.begin(job.id, owner), "retag:file-intent");
            const result = file.fileType === null
                ? { retagged: 0, skipped: 0, missing: 1, errors: [] }
                : stripOnly
                    ? await AudioTagService.stripTags([file.id])
                : file.fileType === "video"
                    ? await VideoTagService.apply([file.id])
                    : await session.apply([file.id]);
            plan = await withSqliteWriteGate(() => Work.settle(job.id, owner, file.id, result), "retag:file-settled");
            ctx.updateCommandDescription(job, {
                progress: 5 + Math.floor(plan.cursor / Math.max(plan.total, 1) * 90),
                description: `${stripOnly ? "Strip tags" : "Retag"} - processed ${plan.cursor}/${plan.total} files`,
            });
            settled++;
            if (settled >= 25 || performance.now() - started >= 30_000) break;
            await ctx.yieldToEventLoop();
        }
    } finally {
        session.close();
    }
    if (plan.cursor < plan.total) {
        throw new CommandContinuation({ retagWork: { version: 1 } });
    }
    return { retagged: plan.retagged, skipped: plan.skipped, missing: plan.missing, errors: Work.errors(job.id) };
}
