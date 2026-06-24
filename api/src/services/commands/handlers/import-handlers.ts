import { FollowedArtistsImportService } from "../../providers/followed-artists-import.js";
import { appEvents, AppEvent } from "../app-events.js";
import type { CommandHandler } from "./handler-context.js";

/**
 * Import distinct artists from a provider list (followed artists, a playlist,
 * favorite tracks, or a home-screen mix) as monitored artists, queueing a
 * per-artist refresh for each. Runs on a command worker so the long per-artist
 * loop (MB identity resolve + canonical sync + monitor) never blocks the main
 * HTTP/SSE thread. Per-artist progress is emitted as IMPORT_ARTISTS_PROGRESS
 * events (bridged from the worker to the main thread) for the import modal's SSE
 * stream to relay.
 */
export const handleImportProviderArtists: CommandHandler<"ImportProviderArtists"> = async (job, ctx) => {
    const { providerId, importCategory, importListId, importLabel } = job.payload;
    const label = importLabel || importCategory;

    ctx.updateCommandDescription(job, {
        progress: 2,
        description: `Importing artists from ${label}`,
    });

    const summary = await FollowedArtistsImportService.importArtists({
        providerId,
        selection: { category: importCategory, listId: importListId },
        onEvent: (event) => {
            const { type, ...data } = event;
            appEvents.emit(AppEvent.IMPORT_ARTISTS_PROGRESS, {
                commandId: job.id,
                event: type,
                data: data as Record<string, unknown>,
            });
            const total = Number((data as { total?: number }).total);
            const progress = Number((data as { progress?: number }).progress);
            if (type === "artist-progress" && total > 0) {
                ctx.updateCommandDescription(job, {
                    progress: Math.min(99, Math.round((progress / total) * 100)),
                });
            }
        },
    });

    // Terminal event so SSE subscribers can resolve and close the stream.
    appEvents.emit(AppEvent.IMPORT_ARTISTS_PROGRESS, {
        commandId: job.id,
        event: "complete",
        data: summary as unknown as Record<string, unknown>,
    });
    ctx.updateCommandDescription(job, { progress: 100, description: summary.message });
};
