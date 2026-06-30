import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleLibraryBulkAction } from "../handlers/library-bulk-action-handler.js";

export class LibraryBulkActionCommand implements IExecuteCommand<"LibraryBulkAction"> {
    async execute(job: CommandModelOf<"LibraryBulkAction">, ctx: CommandHandlerContext): Promise<void> {
        await handleLibraryBulkAction(job, ctx);
    }
}
