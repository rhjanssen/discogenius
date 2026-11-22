import type { IExecuteCommand } from "./i-execute-command.js";
import type { CommandModelOf } from "../command-model.js";
import type { CommandHandlerContext } from "../handlers/handler-context.js";
import { applyOrphanSidecarCleanup } from "../../mediafiles/orphan-sidecar-cleanup.js";

export class CleanupOrphanSidecarsCommand implements IExecuteCommand<"CleanupOrphanSidecars"> {
  async execute(job: CommandModelOf<"CleanupOrphanSidecars">, ctx: CommandHandlerContext): Promise<void> {
    const result = await applyOrphanSidecarCleanup({
      confirm: job.payload.confirm === true,
      confirmationToken: job.payload.confirmationToken,
      libraryRoot: job.payload.libraryRoot,
      artistId: job.payload.artistId,
      pruneEmptyFolders: job.payload.pruneEmptyFolders === true,
      filePaths: job.payload.filePaths,
      yieldToEventLoop: () => ctx.yieldToEventLoop(),
      onProgress: (progress, description) => {
        ctx.updateCommandDescription(job, { progress, description });
      },
    });

    const summary = `${result.deleted} orphan sidecar(s) removed`
      + (result.deletedDbRows > 0 ? `, ${result.deletedDbRows} stale DB row(s) cleaned` : "")
      + (result.skippedProtected > 0 ? `, ${result.skippedProtected} protected` : "")
      + (result.skippedChanged > 0 ? `, ${result.skippedChanged} changed` : "")
      + (result.prunedFolders > 0 ? `, ${result.prunedFolders} empty folder(s) pruned` : "");
    ctx.updateCommandDescription(job, { progress: 100, description: summary });

    if (result.errors.length > 0) {
      throw new Error(
        `Orphan sidecar cleanup hit ${result.errors.length} error(s): ${result.errors[0].filePath}: ${result.errors[0].error}`,
      );
    }
  }
}
