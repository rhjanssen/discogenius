import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleRenameArtist } from "../handlers/library-handlers.js";

/**
 * Executor for RenameArtist
 * Dispatches to the command handler via the IExecuteCommand contract.
 */
export class RenameArtistCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleRenameArtist(job, ctx);
    }
}
