import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG_DIR } from "../config/bootstrap.js";
import { isSqliteBusyError } from "../../database.js";
import { tryAcquireSqliteWriteMutex, releaseSqliteWriteMutex } from "../../database/sqlite-write-mutex.js";

/** Retries while another writer holds the process mutex. The last wait is the bound. */
const WRITE_RETRY_WAITS_MS = [0, 25, 50, 100, 200, 400];

export type ArtworkMaterializeFollowUp = {
  entityId: string;
  coverEntity: "Artist" | "Album" | "Edition" | "Video";
  coverTypes: string[];
  outputPath: string;
  libraryRoot?: string | null;
  reason: string;
};

type StoredFollowUp = ArtworkMaterializeFollowUp & { id: string; at: string; file: string };

function followUpDir(): string {
  return path.join(CONFIG_DIR, "artwork-materialize-followups");
}

function durableWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const dirFd = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dirFd); }
  finally { fs.closeSync(dirFd); }
}

function readFollowUps(): StoredFollowUp[] {
  let names: string[] = [];
  try { names = fs.readdirSync(followUpDir()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const items: StoredFollowUp[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(followUpDir(), name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredFollowUp;
      if (!parsed || typeof parsed.outputPath !== "string" || typeof parsed.entityId !== "string") continue;
      items.push({ ...parsed, file });
    } catch { /* A torn file stays until a later drain can read it. */ }
  }
  return items;
}

/** Durable record of a cover the import could not commit because SQLite was busy. */
export function recordArtworkMaterializeFollowUp(item: ArtworkMaterializeFollowUp): void {
  const existing = readFollowUps().find(row => row.outputPath === item.outputPath
    && row.coverEntity === item.coverEntity && row.entityId === item.entityId);
  if (existing) return;
  const id = crypto.randomUUID();
  const stored = { ...item, id, at: new Date().toISOString() };
  durableWrite(path.join(followUpDir(), `${id}.json`), JSON.stringify(stored));
}

export function listArtworkMaterializeFollowUps(): ArtworkMaterializeFollowUp[] {
  return readFollowUps().map(({ file: _file, id: _id, at: _at, ...item }) => item);
}

export function discardArtworkMaterializeFollowUps(outputPath: string): void {
  for (const item of readFollowUps()) {
    if (item.outputPath === outputPath) fs.rmSync(item.file, { force: true });
  }
}

/**
 * Run a short SQLite write. File and network I/O do not belong in `work`.
 * Returns ok:false when the process mutex stays busy for the whole bound.
 */
export function tryShortSqliteWrite<T>(work: () => T, label: string): { ok: true; value: T } | { ok: false } {
  for (let attempt = 0; attempt < WRITE_RETRY_WAITS_MS.length; attempt += 1) {
    const waitMs = WRITE_RETRY_WAITS_MS[attempt];
    if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    if (!tryAcquireSqliteWriteMutex(label)) continue;
    try {
      return { ok: true, value: work() };
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
    } finally {
      releaseSqliteWriteMutex();
    }
  }
  return { ok: false };
}

/** Retry spooled covers once the database can take a short write. */
export async function recoverArtworkMaterializeFollowUps(): Promise<string[]> {
  const items = readFollowUps();
  if (items.length === 0) return [];
  const { materializeMediaCoverToFile } = await import("./media-cover-materialization.js");
  const errors: string[] = [];
  for (const item of items) {
    try {
      const result = await materializeMediaCoverToFile({
        entityId: item.entityId,
        coverEntity: item.coverEntity,
        coverTypes: item.coverTypes,
        outputPath: item.outputPath,
        libraryRoot: item.libraryRoot,
      });
      if (result !== "deferred") fs.rmSync(item.file, { force: true });
    } catch (error) {
      errors.push(`${item.outputPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}
