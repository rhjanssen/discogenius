import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleLowCouplingMaintenance } from "../handlers/maintenance-handlers.js";

/**
 * Executor for Maintenance
 * Dispatches to the command handler via the IExecuteCommand contract.
 */
export class MaintenanceCommand implements IExecuteCommand<any> {
    async execute(job: any, ctx: CommandHandlerContext): Promise<void> {
        await handleLowCouplingMaintenance(job, ctx);
    }
}
