import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import { readLibraryStats } from "./library-stats-reader.js";

try {
    const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
    let value;
    try {
        // Keep catalogue totals and file totals on one consistent snapshot.
        value = db.transaction(() => readLibraryStats(db)).deferred();
    } finally {
        db.close();
    }
    parentPort!.postMessage({ value });
} catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
    parentPort!.close();
}
