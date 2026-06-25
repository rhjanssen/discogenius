import type { CommandModelOf } from "../command-model.js";
import type { CommandName } from "../command-names.js";
import type { CommandHandlerContext } from "../handlers/handler-context.js";

export interface IExecuteCommand<K extends CommandName = CommandName> {
    execute(job: CommandModelOf<K>, ctx: CommandHandlerContext): Promise<void>;
}
