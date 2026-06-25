import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleCheckUpgrades } from "../handlers/curation-handlers.js";

/**
 * Executor for CheckUpgrades
 * Wraps the legacy handler to implement the new Lidarr-style IExecuteCommand contract.
 */
export class CheckUpgradesCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleCheckUpgrades(job, ctx);
    }
}
