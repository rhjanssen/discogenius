import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleRescanFolders } from "../handlers/library-handlers.js";

/**
 * Executor for RescanFolders
 * Dispatches to the command handler via the IExecuteCommand contract.
 */
export class RescanFoldersCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleRescanFolders(job, ctx);
    }
}
