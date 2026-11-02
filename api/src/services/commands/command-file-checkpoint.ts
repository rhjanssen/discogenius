import type { CommandName } from "./command-names.js";
import { getCommandDefinition } from "./command-registry.js";
import { CommandFileWorkRepository } from "./command-file-work-repository.js";
import { reclaimRenameCheckpoint } from "./rename-work.js";
import type { FileWorkRestartResume } from "./command-bodies.js";

export interface FileCheckpointDisplay {
    progress: number;
    progressCurrent: number;
    progressTotal: number;
    description: string;
    settled: number;
    total: number;
    skippedFiles: number;
}

export function fileCheckpointResumePrefix(payload: { restartResume?: FileWorkRestartResume } | null | undefined): string {
    return payload?.restartResume ? "resumed after restart - " : "";
}

/** Reclaim the in-flight file and describe the command from the checkpoint.
 * Returns null for commands that are not file-checkpoint resumable. Runs
 * inside the caller's transaction so a failed requeue does not burn a claim. */
export function prepareFileCheckpointResume(name: CommandName, commandId: number): FileCheckpointDisplay | null {
    const kind = getCommandDefinition(name).fileWorkCheckpoint;
    if (!kind) return null;
    const checkpoint = kind === "rename"
        ? reclaimRenameCheckpoint(commandId)
        : CommandFileWorkRepository.reclaimInFlight(commandId);
    const label = kind === "rename" ? "Rename" : "Retag";
    const description = checkpoint.total > 0
        ? `${label} — resumed after restart, ${checkpoint.cursor}/${checkpoint.total} files already settled`
        : `${label} — resumed after restart; choosing files`;
    const progress = checkpoint.total > 0
        ? Math.min(99, 5 + Math.floor(checkpoint.cursor / checkpoint.total * 90))
        : 1;
    return {
        progress,
        progressCurrent: checkpoint.cursor,
        progressTotal: Math.max(checkpoint.total, 1),
        description,
        settled: checkpoint.cursor,
        total: checkpoint.total,
        skippedFiles: checkpoint.skippedFiles,
    };
}
