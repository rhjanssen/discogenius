import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleApplyCuration } from "../handlers/curation-handlers.js";

/**
 * Executor for ApplyCuration
 * Wraps the legacy handler to implement the new Lidarr-style IExecuteCommand contract.
 */
export class ApplyCurationCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleApplyCuration(job, ctx);
    }
}
