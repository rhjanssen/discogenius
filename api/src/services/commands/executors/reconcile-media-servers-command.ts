import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleReconcileMediaServers } from "../handlers/maintenance-handlers.js";

export class ReconcileMediaServersCommand implements IExecuteCommand<any> {
  async execute(job: CommandModelOf<"ReconcileMediaServers">, ctx: CommandHandlerContext): Promise<void> {
    await handleReconcileMediaServers(job, ctx);
  }
}
