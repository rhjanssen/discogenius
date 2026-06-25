import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleCurateArtist } from "../handlers/curation-handlers.js";

/**
 * Executor for CurateArtist
 * Wraps the legacy handler to implement the new Lidarr-style IExecuteCommand contract.
 */
export class CurateArtistCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleCurateArtist(job, ctx);
    }
}
