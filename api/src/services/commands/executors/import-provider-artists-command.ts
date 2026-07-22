import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleImportProviderArtists } from "../handlers/import-handlers.js";

/**
 * Executor for ImportProviderArtists
 * Dispatches to the command handler via the IExecuteCommand contract.
 */
export class ImportProviderArtistsCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleImportProviderArtists(job, ctx);
    }
}
