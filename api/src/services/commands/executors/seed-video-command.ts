import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleSeedVideo } from "../handlers/refresh-handlers.js";

/**
 * Executor for SeedVideo
 * Dispatches to the command handler via the IExecuteCommand contract.
 */
export class SeedVideoCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleSeedVideo(job, ctx);
    }
}
