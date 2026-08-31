import { handleReplanAcquisition } from "../handlers/acquisition-handlers.js";
import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";

export class ReplanAcquisitionCommand implements IExecuteCommand<"ReplanAcquisition"> {
  async execute(
    job: CommandModelOf<"ReplanAcquisition">,
    ctx: CommandHandlerContext,
  ): Promise<void> {
    await handleReplanAcquisition(job, ctx);
  }
}
