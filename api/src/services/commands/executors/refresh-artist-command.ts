import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleRefreshArtist } from "../handlers/refresh-handlers.js";

/**
 * Executor for RefreshArtist
 * Wraps the legacy handler to implement the new Lidarr-style IExecuteCommand contract.
 */
export class RefreshArtistCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleRefreshArtist(job, ctx);
    }
}
