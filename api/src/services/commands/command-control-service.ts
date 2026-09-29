import { withSqliteWriteGate } from "../../database.js";
import { CommandManager } from "./command.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import { CommandWorkerPool } from "./worker/command-worker-pool.js";
import { DOWNLOAD_OR_IMPORT_COMMAND_NAMES } from "./command-names.js";

/** Keep the command's resource reservation until its worker has exited. A
 * cancelled database row alone does not prove the filesystem writer stopped. */
export async function cancelNonDownloadCommand(commandId: number): Promise<boolean> {
    const job = CommandQueueManager.get(commandId);
    if (!job) return false;
    if (job.status !== "started" && job.status !== "queued") return false;
    if ((DOWNLOAD_OR_IMPORT_COMMAND_NAMES as readonly string[]).includes(job.name)) {
        throw new Error("Downloads must be cancelled through the download processor");
    }
    if (job.status === "started" && job.worker_id) {
        if (CommandManager.getDefinition(job.name).requiresDiskAccess) {
            return withSqliteWriteGate(() => Boolean(CommandQueueManager.updateState(commandId, {
                workerId: job.worker_id!, payloadPatch: { cancelRequested: true, description: "Cancellation requested" },
            })), "commands:request-cancel");
        }
        await CommandWorkerPool.abortCommandAndWait(commandId, job.worker_id, "Command cancelled by user");
    }
    return withSqliteWriteGate(() => {
        const current = CommandQueueManager.get(commandId);
        if (current?.status === "started" && current.worker_id !== job.worker_id) {
            throw new Error("Command started a new work unit while cancellation was waiting; retry cancellation");
        }
        CommandQueueManager.cancel(commandId);
        return true;
    }, "commands:cancel");
}
