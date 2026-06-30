import type { CommandHandlerContext } from "../handlers/handler-context.js";
import type { CommandModelOf } from "../command-model.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import { handleImportUnmappedFiles } from "../handlers/import-handlers.js";

export class ImportUnmappedFilesCommand implements IExecuteCommand<"ImportUnmappedFiles"> {
    async execute(job: CommandModelOf<"ImportUnmappedFiles">, ctx: CommandHandlerContext): Promise<void> {
        await handleImportUnmappedFiles(job, ctx);
    }
}
