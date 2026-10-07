import type { IExecuteCommand } from "./i-execute-command.js";
import type { CommandModelOf } from "../command-model.js";
import type { CommandHandlerContext } from "../handlers/handler-context.js";
import { runCleanupWorkUnit } from "../cleanup-work.js";
export class CleanupLibraryCommand implements IExecuteCommand<"CleanupLibrary"> {
    async execute(job:CommandModelOf<"CleanupLibrary">,ctx:CommandHandlerContext):Promise<void> {
        await runCleanupWorkUnit(job,ctx);
    }
}
