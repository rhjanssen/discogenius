import { FollowedArtistsImportService } from "../../providers/followed-artists-import.js";
import { UnmappedFilesService } from "../../mediafiles/unmapped-files.js";
import { CanonicalManualImportService } from "../../mediafiles/canonical-manual-import-service.js";
import { ManualImportService } from "../../mediafiles/manual-import-service.js";
import { db } from "../../../database.js";
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
    const { providerId, importCategory, importListId, importLabel, importArtistIds } = job.payload;
    const label = importLabel || importCategory;

    ctx.updateCommandDescription(job, {
        progress: 2,
        description: `Importing artists from ${label}`,
    });

    const summary = await FollowedArtistsImportService.importArtists({
        providerId,
        selection: { category: importCategory, listId: importListId },
        providerArtistIds: importArtistIds,
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

export const handleImportUnmappedFiles: CommandHandler<"ImportUnmappedFiles"> = async (job, ctx) => {
    const items = Array.isArray(job.payload.items) ? job.payload.items : [];
    const canonical = job.payload.canonical;

    if (items.length === 0 && !canonical) {
        ctx.updateCommandDescription(job, {
            progress: 100,
            description: "No unmapped files to import",
        });
        return;
    }

    const importCount = canonical?.mappings.length ?? items.length;
    ctx.updateCommandDescription(job, {
        progress: 5,
        description: `Importing ${importCount} mapped file${importCount === 1 ? "" : "s"}`,
    });

    const summary = canonical
        ? await new CanonicalManualImportService(
            db,
            (legacyItems, options) => new ManualImportService().bulkImportUnmapped(legacyItems, options),
        ).import(canonical)
        : await new UnmappedFilesService().bulkMap(items);

    // Report what actually happened, not a blanket success — a silent no-op
    // (nothing resolved, all duplicates) must be visible in the activity log.
    const parts: string[] = [];
    if (summary.imported > 0) parts.push(`Imported ${summary.imported} file${summary.imported === 1 ? "" : "s"}`);
    if (summary.duplicates > 0) parts.push(`${summary.duplicates} already in library`);
    if (summary.skipped > 0) parts.push(`${summary.skipped} could not be matched`);
    const description = parts.length > 0 ? parts.join(" · ") : "No files were imported";

    ctx.updateCommandDescription(job, { progress: 100, description });
};
