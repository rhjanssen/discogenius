import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleRetagArtist } from "../handlers/library-handlers.js";

/**
 * Executor for RetagArtist
 * Wraps the legacy handler to implement the new Lidarr-style IExecuteCommand contract.
 */
export class RetagArtistCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleRetagArtist(job, ctx);
    }
}
