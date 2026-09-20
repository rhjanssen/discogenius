import { Worker } from "node:worker_threads";
import { DB_PATH } from "../config/bootstrap.js";
import type { LibraryStatsContract } from "../../contracts/catalog.js";
import { appEvents, AppEvent, type CommandEventPayload } from "../commands/app-events.js";

export class LibraryStatsQueryService {
    private static readonly SNAPSHOT_TTL_MS = 10_000;
    private static cachedSnapshot: { value: LibraryStatsContract; createdAtMs: number } | null = null;
    private static pending: Promise<LibraryStatsContract> | null = null;
    private static generation = 0;

    static clearCache(): void {
        this.generation++;
        this.cachedSnapshot = null;
    }

    static async getSnapshot(): Promise<LibraryStatsContract> {
        const cached = this.cachedSnapshot;
        if (cached) {
            if (Date.now() - cached.createdAtMs >= this.SNAPSHOT_TTL_MS) {
                void this.computeSnapshot().catch(error => console.warn("[STATS] Background stats refresh failed:", error));
            }
            return cached.value;
        }
        return this.computeSnapshot();
    }

    private static computeSnapshot(): Promise<LibraryStatsContract> {
        if (this.pending) return this.pending;
        const generation = this.generation;
        // Open a short-lived read-only connection. Large catalog counters must
        // never block HTTP or retain a WAL reader between refreshes.
        const source = import.meta.url.endsWith(".ts");
        const entry = new URL(source
            ? "../commands/worker/command-worker-bootstrap.mjs"
            : "./library-stats-worker.js", import.meta.url);
        const worker = new Worker(entry, {
            execArgv: [],
            workerData: {
                dbPath: DB_PATH,
                ...(source ? { __entry: new URL("./library-stats-worker.ts", import.meta.url).href } : {}),
            },
        });
        this.pending = new Promise<LibraryStatsContract>((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                settled = true;
                void worker.terminate();
                reject(new Error("Library statistics read timed out"));
            }, 60_000);
            worker.once("message", (message: { value?: LibraryStatsContract; error?: string }) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (message.error || !message.value) {
                    reject(new Error(message.error || "Library statistics worker returned no result"));
                    return;
                }
                if (generation === this.generation) {
                    this.cachedSnapshot = { value: message.value, createdAtMs: Date.now() };
                }
                resolve(message.value);
            });
            worker.once("error", error => {
                settled = true;
                clearTimeout(timeout);
                reject(error);
            });
            worker.once("exit", code => {
                clearTimeout(timeout);
                if (!settled) reject(new Error(`Library statistics worker exited before returning a result (${code})`));
            });
        }).finally(() => { this.pending = null; });
        return this.pending;
    }
}

// Keep the server-side snapshot coherent with mutations performed by command
// workers as well as direct file/config operations. Worker events are bridged
// back onto this main-thread emitter by the worker protocol.
const invalidateLibraryStats = () => LibraryStatsQueryService.clearCache();
appEvents.on(AppEvent.ARTIST_REFRESH_COMPLETE, invalidateLibraryStats);
appEvents.on(AppEvent.ARTIST_SCANNED, invalidateLibraryStats);
appEvents.on(AppEvent.CONFIG_UPDATED, invalidateLibraryStats);
appEvents.on(AppEvent.LIBRARY_UPDATED, invalidateLibraryStats);
appEvents.on(AppEvent.FILE_ADDED, invalidateLibraryStats);
appEvents.on(AppEvent.FILE_DELETED, invalidateLibraryStats);
appEvents.on(AppEvent.FILE_UPGRADED, invalidateLibraryStats);
appEvents.on(AppEvent.COMMAND_UPDATED, (event: CommandEventPayload) => {
    if (
        event.status === "completed"
        || event.status === "failed"
        || event.status === "cancelled"
    ) {
        invalidateLibraryStats();
    }
});
