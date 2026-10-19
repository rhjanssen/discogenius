import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CONFIG_DIR } from "../config/bootstrap.js";
import { withAlbumFolder, withHddIoPermit, type DiskAdmissionMeta } from "../commands/disk-admission.js";
import { fsyncDirectory } from "./media-file-rewrite.js";

/**
 * Crash window for an in-place tag write: the original bytes used to live only
 * in memory between the patched write and verify/restore. A killed process
 * (deploy, OOM, container stop) left a torn moov or tag header.
 *
 * The undo bytes are a sibling of the media file. The intent is that sibling
 * plus a pointer in the config spool, both fsynced (file and directory) before
 * the original is mutated. FileMutationJournal.recoverPending() is the only
 * recovery entry: it takes the album-folder lock, then the HDD permit, and
 * either restores the pre-write bytes or drops the backup once the post-write
 * image matches. SQLite is not used here. Recording a FileMutationJournal row
 * would take the write gate while the caller already holds the HDD permit.
 */
export class InPlaceTagCrash extends Error {
  constructor() {
    super("in-place tag write interrupted after the patched bytes were fsynced and before verify");
    this.name = "InPlaceTagCrash";
  }
}

let crashAfterWrite = false;

/** Next armed in-place write throws after fsync and does not restore. */
export function crashNextInPlaceTagWrite(): void {
  crashAfterWrite = true;
}

/** Drop a crash hook that the write under test never reached. */
export function clearInPlaceTagCrashHooks(): void {
  crashAfterWrite = false;
}

export function isInPlaceTagCrash(error: unknown): boolean {
  return error instanceof InPlaceTagCrash;
}

type IntentPhase = "preparing" | "armed" | "verified";

type Intent = {
  id: string;
  filePath: string;
  offset: number;
  length: number;
  originalSize: number;
  preImageSha256: string;
  phase: IntentPhase;
  postImageSha256: string | null;
  postSize: number | null;
  /** Bytes hashed from `offset`. Header rewrites keep `length`. A tail rewrite
   * hashes through EOF, because the moov may grow. */
  postLength: number | null;
};

export type ArmedUndo = {
  id: string;
  filePath: string;
  offset: number;
  length: number;
  originalSize: number;
  preImageSha256: string;
};

function spoolRoot(): string {
  return path.join(CONFIG_DIR, "tag-undo");
}

function undoBin(dir: string, id: string): string {
  return path.join(dir, `.discogenius-tag-undo-${id}.bin`);
}

function undoJson(dir: string, id: string): string {
  return path.join(dir, `.discogenius-tag-undo-${id}.json`);
}

function indexPath(id: string): string {
  return path.join(spoolRoot(), id);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeDurable(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    if (typeof data === "string") fs.writeSync(fd, data);
    else fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readRegion(file: string, offset: number, length: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, offset);
    if (read !== length) throw new Error(`Short read restoring ${file}`);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function readIntent(jsonPath: string): Intent | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Intent;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.filePath !== "string") return null;
    if (parsed.phase !== "preparing" && parsed.phase !== "armed" && parsed.phase !== "verified") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeIntent(intent: Intent): void {
  const jsonPath = undoJson(path.dirname(intent.filePath), intent.id);
  writeDurable(jsonPath, JSON.stringify(intent));
  fsyncDirectory(path.dirname(intent.filePath));
}

export function armInPlaceUndo(filePath: string, offset: number, undo: Buffer, originalSize: number): ArmedUndo {
  if (offset < 0 || undo.length === 0 || originalSize < offset + undo.length) {
    throw new Error("In-place undo is outside the original file");
  }
  const id = randomUUID();
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  const preImageSha256 = sha256(undo);
  const preparing: Intent = {
    id,
    filePath: resolved,
    offset,
    length: undo.length,
    originalSize,
    preImageSha256,
    phase: "preparing",
    postImageSha256: null,
    postSize: null,
    postLength: null,
  };
  // The pointer exists before any byte of the original changes. Recovery of
  // `preparing` only deletes leftovers; it does not touch the media file.
  writeIntent(preparing);
  writeDurable(indexPath(id), undoJson(dir, id));
  fsyncDirectory(spoolRoot());
  writeDurable(undoBin(dir, id), undo);
  fsyncDirectory(dir);
  const armed: Intent = { ...preparing, phase: "armed" };
  writeIntent(armed);
  return {
    id,
    filePath: resolved,
    offset,
    length: undo.length,
    originalSize,
    preImageSha256,
  };
}

export function fsyncMediaFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Test hook, called only after the patched bytes and their fsync. */
export function noteInPlaceWriteFinished(): void {
  if (!crashAfterWrite) return;
  crashAfterWrite = false;
  throw new InPlaceTagCrash();
}

export function markInPlaceUndoVerified(armed: ArmedUndo): void {
  const size = fs.statSync(armed.filePath).size;
  if (size < armed.offset) throw new Error("In-place tag write shrunk the file below the patched region");
  // A header rewrite (offset 0) keeps its length and the file size, so the
  // hash stays on the tag region and does not read the audio. A tail rewrite
  // replaces every byte from the offset through EOF and may resize.
  const postLength = armed.offset === 0 ? armed.length : size - armed.offset;
  const postSize = armed.offset === 0 ? armed.originalSize : size;
  if (armed.offset === 0 && size !== armed.originalSize) {
    throw new Error("In-place header write changed the file size");
  }
  if (postLength <= 0) throw new Error("In-place tag write left an empty patched region");
  const post = readRegion(armed.filePath, armed.offset, postLength);
  const intent = readIntent(undoJson(path.dirname(armed.filePath), armed.id));
  if (!intent || intent.phase !== "armed") throw new Error("In-place tag intent disappeared before verify");
  writeIntent({
    ...intent,
    phase: "verified",
    postImageSha256: sha256(post),
    postSize,
    postLength,
  });
}

export function discardInPlaceUndo(id: string, filePath: string): void {
  const dir = path.dirname(path.resolve(filePath));
  fs.rmSync(undoBin(dir, id), { force: true });
  fs.rmSync(undoJson(dir, id), { force: true });
  fsyncDirectory(dir);
  fs.rmSync(indexPath(id), { force: true });
  if (fs.existsSync(spoolRoot())) fsyncDirectory(spoolRoot());
}

export function restoreInPlaceUndo(armed: Pick<ArmedUndo, "id" | "filePath" | "offset" | "originalSize" | "preImageSha256">): void {
  const bin = undoBin(path.dirname(armed.filePath), armed.id);
  const undo = fs.readFileSync(bin);
  if (sha256(undo) !== armed.preImageSha256) throw new Error("In-place undo bytes no longer match the intent");
  const fd = fs.openSync(armed.filePath, "r+");
  try {
    const written = fs.writeSync(fd, undo, 0, undo.length, armed.offset);
    if (written !== undo.length) throw new Error("Short write restoring an in-place tag");
    fs.ftruncateSync(fd, armed.originalSize);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(armed.filePath));
}

function regionMatches(file: string, offset: number, size: number, length: number, hash: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size !== size || offset < 0 || length < 0 || offset + length > size) return false;
  return sha256(readRegion(file, offset, length)) === hash;
}

export function hasPendingInPlaceTagUndo(): boolean {
  const root = spoolRoot();
  if (!fs.existsSync(root)) return false;
  return fs.readdirSync(root).length > 0;
}

function discardPreparing(id: string, jsonPath: string | null): void {
  if (jsonPath && fs.existsSync(jsonPath)) {
    const intent = readIntent(jsonPath);
    const dir = intent ? path.dirname(intent.filePath) : path.dirname(jsonPath);
    fs.rmSync(undoBin(dir, id), { force: true });
    fs.rmSync(jsonPath, { force: true });
    fsyncDirectory(dir);
  }
  fs.rmSync(indexPath(id), { force: true });
  fsyncDirectory(spoolRoot());
}

async function recoverOne(id: string): Promise<void> {
  const pointer = indexPath(id);
  let jsonPath: string;
  try {
    jsonPath = fs.readFileSync(pointer, "utf8").trim();
  } catch {
    fs.rmSync(pointer, { force: true });
    return;
  }
  const intent = readIntent(jsonPath);
  if (!intent || intent.phase === "preparing") {
    // Armed is the first phase that is allowed to mutate. A torn intent means
    // the original was not patched.
    discardPreparing(id, fs.existsSync(jsonPath) ? jsonPath : null);
    return;
  }
  const meta: DiskAdmissionMeta = { role: "retag", commandId: 0, reason: "recover in-place tag write" };
  await withAlbumFolder(path.dirname(intent.filePath), meta, async () => {
    await withHddIoPermit(meta, async () => {
      if (!fs.existsSync(intent.filePath)) {
        throw new Error(`In-place tag target is missing: ${intent.filePath}`);
      }
      const matchesPre = regionMatches(intent.filePath, intent.offset, intent.originalSize, intent.length, intent.preImageSha256);
      const matchesPost = intent.phase === "verified"
        && intent.postImageSha256 != null
        && intent.postSize != null
        && intent.postLength != null
        && regionMatches(intent.filePath, intent.offset, intent.postSize, intent.postLength, intent.postImageSha256);
      if (matchesPost || matchesPre) {
        discardInPlaceUndo(intent.id, intent.filePath);
        return;
      }
      restoreInPlaceUndo(intent);
      if (!regionMatches(intent.filePath, intent.offset, intent.originalSize, intent.length, intent.preImageSha256)) {
        throw new Error(`Restored tag bytes do not match the pre-write image: ${intent.filePath}`);
      }
      discardInPlaceUndo(intent.id, intent.filePath);
    });
  });
}

export async function recoverInPlaceTagUndos(): Promise<string[]> {
  const root = spoolRoot();
  if (!fs.existsSync(root)) return [];
  const ids = fs.readdirSync(root).sort();
  const errors: string[] = [];
  for (const id of ids) {
    try {
      await recoverOne(id);
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}
