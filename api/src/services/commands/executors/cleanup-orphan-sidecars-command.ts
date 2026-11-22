import { withSqliteWriteGate } from "../../../database.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import type { CommandModelOf } from "../command-model.js";
import { CommandQueueManager } from "../command-queue-manager.js";
import type { CommandHandlerContext } from "../handlers/handler-context.js";
import {
  OrphanSidecarConflictError,
  applyOrphanSidecarCleanup,
  loadOrphanSidecarPreviewCommand,
  previewOrphanSidecarCleanup,
} from "../../mediafiles/orphan-sidecar-cleanup.js";

export class CleanupOrphanSidecarsCommand implements IExecuteCommand<"CleanupOrphanSidecars"> {
  async execute(job: CommandModelOf<"CleanupOrphanSidecars">, ctx: CommandHandlerContext): Promise<void> {
    if (job.payload.dryRun === true) {
      const report = await previewOrphanSidecarCleanup({
        libraryRoot: job.payload.libraryRoot,
        artistId: job.payload.artistId,
        yieldToEventLoop: () => ctx.yieldToEventLoop(),
        onProgress: (progress, description) => ctx.updateCommandDescription(job, { progress, description }),
      });
      const summary = `Dry run complete: ${report.orphanCount} orphan sidecar(s) found${report.scanTruncated ? " (capped)" : ""}`;
      await withSqliteWriteGate(() => {
        CommandQueueManager.updateState<"CleanupOrphanSidecars">(job.id, {
          workerId: job.worker_id ?? undefined,
          progress: 100,
          payloadPatch: { previewReport: report, description: summary },
        });
      }, "cleanup:orphan-sidecar-preview");
      return;
    }

    const previewRecord = loadOrphanSidecarPreviewCommand({ commandId: job.payload.previewCommandId, requireCompleted: true });
    if (!previewRecord?.report) {
      throw new OrphanSidecarConflictError("No completed dry-run preview found; run orphan-sidecars preview before applying");
    }

    const result = await applyOrphanSidecarCleanup({
      confirm: job.payload.confirm === true,
      confirmationToken: job.payload.confirmationToken ?? "",
      preview: previewRecord.report,
      pruneEmptyFolders: job.payload.pruneEmptyFolders === true,
      filePaths: job.payload.filePaths,
      yieldToEventLoop: () => ctx.yieldToEventLoop(),
      onProgress: (progress, description) => ctx.updateCommandDescription(job, { progress, description }),
    });

    ctx.updateCommandDescription(job, {
      progress: 100,
      description: `${result.deleted} orphan sidecar(s) removed, ${result.deletedDbRows} stale DB row(s) cleaned, ${result.skippedProtected} protected, ${result.skippedChanged} changed`,
    });
    if (result.errors.length > 0) {
      throw new Error(`Orphan sidecar cleanup hit ${result.errors.length} error(s): ${result.errors[0].filePath}: ${result.errors[0].error}`);
    }
  }
}
