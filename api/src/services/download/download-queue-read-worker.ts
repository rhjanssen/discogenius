import Database from "better-sqlite3";
import { parentPort } from "node:worker_threads";
import { readQueuePage, type QueuePageQuery } from "./download-queue-reader.js";

let cachedDbPath: string | null = null;
let cachedDb: Database.Database | null = null;

function openReadOnlyDb(dbPath: string): Database.Database {
  if (cachedDb && cachedDbPath === dbPath) {
    return cachedDb;
  }
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      // Ignore close errors when rotating DB path
    }
    cachedDb = null;
  }
  cachedDb = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
  cachedDbPath = dbPath;
  return cachedDb;
}

parentPort!.on("message", (msg: { requestId: number; dbPath: string; params: QueuePageQuery }) => {
  try {
    const db = openReadOnlyDb(msg.dbPath);
    const value = db.transaction(() => readQueuePage(db, msg.params)).deferred();
    parentPort!.postMessage({ requestId: msg.requestId, value });
  } catch (error) {
    // Reset cached connection on error in case the DB file was replaced or rotated.
    if (cachedDb) {
      try {
        cachedDb.close();
      } catch {
        // Ignore
      }
      cachedDb = null;
      cachedDbPath = null;
    }
    parentPort!.postMessage({
      requestId: msg.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
