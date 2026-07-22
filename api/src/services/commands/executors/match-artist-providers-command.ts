import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleMatchArtistProviders } from "../handlers/refresh-handlers.js";

/**
 * Executor for MatchArtistProviders
 * Dispatches to the command handler via the IExecuteCommand contract.
 */
export class MatchArtistProvidersCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleMatchArtistProviders(job, ctx);
    }
}
