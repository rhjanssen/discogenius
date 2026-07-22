import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleRefreshAlbum } from "../handlers/refresh-handlers.js";

/**
 * Executor for RefreshAlbum
 * Dispatches to the command handler via the IExecuteCommand contract.
 */
export class RefreshAlbumCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleRefreshAlbum(job, ctx);
    }
}
