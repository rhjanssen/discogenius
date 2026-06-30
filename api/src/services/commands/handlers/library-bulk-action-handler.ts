import { LibraryBulkActionService } from "../../music/library-bulk-actions.js";
import type { CommandHandler } from "./handler-context.js";

export const handleLibraryBulkAction: CommandHandler<"LibraryBulkAction"> = async (job, ctx) => {
    const ids = Array.isArray(job.payload.entityIds) ? job.payload.entityIds.map((id) => String(id)) : [];

    if (ids.length === 0) {
        ctx.updateCommandDescription(job, {
            progress: 100,
            description: "No library items selected",
        });
        return;
    }

    ctx.updateCommandDescription(job, {
        progress: 5,
        description: `Applying ${job.payload.action} to ${ids.length} ${job.payload.entity}${ids.length === 1 ? "" : "s"}`,
    });

    const result = await LibraryBulkActionService.apply(job.payload.entity, job.payload.action, ids);

    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Bulk ${job.payload.action} complete: ${result.updated} updated, ${result.queued} queued, ${result.missing} missing`,
    });
};
