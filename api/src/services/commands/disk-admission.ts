/**
 * Per-album-folder locks and a global HDD I/O permit.
 *
 * Lock order, never inverted:
 * 1. Album-folder lock (`withAlbumFolder` / `withAlbumFolders`).
 *    A rename that touches two folders takes both in one call. Paths are
 *    normalized and sorted; the distinct hash lanes are then acquired in
 *    ascending lane index. Lane index is a total order, so a hash collision
 *    cannot deadlock (it only serializes extra folders). Never nest a new
 *    folder lock while one is already held, and never take a folder lock
 *    while an I/O permit or the SQLite write gate is held.
 * 2. HDD I/O permit (`withHddIoPermit`). Only while a folder lock is held,
 *    and never while the SQLite write gate is held. Drop the permit before
 *    any write gate. Default limit is 1 (spinning disks); override with
 *    DISCOGENIUS_HDD_IO_LIMIT (clamped to 1..8). The permit is a FIFO ticket
 *    queue: a holder that drops it and asks again takes a new ticket, so a
 *    task that is already waiting cannot be starved. Import priority is the
 *    folder lock only; it does not jump this queue.
 * 3. SQLite write gate. `enterWriteGate` refuses to run while a permit is
 *    held. No file or network I/O belongs inside the gate.
 *
 * Import waiters outrank retag, rename, and rescan on a folder. On release,
 * if an import is waiting the lane becomes IMPORT_RESERVED and only an import
 * may take it. A retag therefore has to drop the folder between files so a
 * waiting import of that album enters before the next file.
 *
 * The buffer is one SharedArrayBuffer inherited by command and download
 * workers, same pattern as the media-file lock. `releaseExitedDiskAdmissionOwner`
 * runs only after the physical worker has exited, so a killed worker cannot
 * leave a folder lock or an I/O permit behind. 256 lanes: the same folder
 * always hashes to the same lane.
 *
 * Every wait is visible in `diskAdmissionSnapshot` and is logged once when
 * the wait starts. Reasons:
 * - "album folder lock held by <role> command <id> on <folder>"
 * - "folder reserved for a waiting import"
 * - "HDD I/O permit (<in use>/<limit> in use)"
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isMainThread, workerData } from "node:worker_threads";
import { normalizeResolvedPath } from "../mediafiles/path-utils.js";

export const DISK_ADMISSION_KEY = "diskAdmission";
export const DISK_ADMISSION_OWNER_KEY = "diskAdmissionOwner";

const GLOBAL_KEY = "__discogeniusDiskAdmission";
const LANES = 256;
const FREE = 0;
const IMPORT_RESERVED = -2;
const MAX_IO = 8;
const PATH_BYTES = 192;
const REASON_BYTES = 160;
const WAIT_SLOTS = 48;

const TOKEN = 0;
const IO_LIMIT = 1;
const IO_IN_USE = 2;
const IO_WAITERS = 3;
const INIT = 4;
const IO_OWNER_START = 5;
const HEADER = 13;

const LANE_STRIDE = 5;
const LANE_BASE = HEADER;
const LANE_STATE = 0;
const LANE_IMPORT_WAITERS = 1;
const LANE_OTHER_WAITERS = 2;
const LANE_ROLE = 3;
const LANE_COMMAND = 4;

const WAIT_STRIDE = 7;
const WAIT_BASE = LANE_BASE + LANES * LANE_STRIDE;
const WAIT_ACTIVE = 0;
const WAIT_KIND = 1;
const WAIT_ROLE = 2;
const WAIT_COMMAND = 3;
const WAIT_LANE = 4;
const WAIT_SINCE = 5;
const WAIT_TOKEN = 6;
const WAIT_INTS = WAIT_BASE + WAIT_SLOTS * WAIT_STRIDE;
const IO_TICKET = WAIT_INTS;
const IO_QUEUE_CAPACITY = 256;
const IO_QUEUE_STRIDE = 2;
const IO_QUEUE_START = IO_TICKET + 1;
const INT_COUNT = IO_QUEUE_START + IO_QUEUE_CAPACITY * IO_QUEUE_STRIDE;

const PATH_REGION = INT_COUNT * 4;
const REASON_REGION = PATH_REGION + LANES * PATH_BYTES;
const WAIT_FOLDER_REGION = REASON_REGION + WAIT_SLOTS * REASON_BYTES;
const TOTAL_BYTES = WAIT_FOLDER_REGION + WAIT_SLOTS * PATH_BYTES;

const ROLE_CODE = { import: 1, retag: 2, rename: 3, rescan: 4, other: 5 } as const;
const CODE_ROLE = ["", "import", "retag", "rename", "rescan", "other"] as const;

export type DiskRole = keyof typeof ROLE_CODE;

export type DiskAdmissionMeta = {
  role: DiskRole;
  commandId: number;
  /** Included in the wait log when this attempt has to wait. */
  reason?: string;
};

export type DiskAdmissionWait = {
  kind: "folder" | "io";
  role: DiskRole | "";
  commandId: number;
  folder: string;
  reason: string;
  sinceMs: number;
  lane: number;
};

export type DiskAdmissionHolder = {
  lane: number;
  folder: string;
  role: DiskRole | "";
  commandId: number;
  reservedForImport: boolean;
};

export type DiskAdmissionSnapshot = {
  ioLimit: number;
  ioInUse: number;
  ioWaiters: number;
  holders: DiskAdmissionHolder[];
  waits: DiskAdmissionWait[];
};

/**
 * What this async flow holds. AsyncLocalStorage hands the store to every
 * continuation created inside `run`, including timers, `setImmediate`,
 * fire-and-forget promises and event-listener callbacks that outlive the
 * section. A depth counter therefore answered "was this flow *started* inside
 * a lock?", not "is the lock held now?". A download-queue wake scheduled by a
 * command-status event inside a SQLite write section made every later import
 * look like it held the write gate (deploy d2ae132a, 19 Oct 2026).
 *
 * Each hold is an object that is marked released when its section settles.
 * Code that inherited a released hold sees through it to the enclosing live
 * hold (`parent`), or to nothing.
 */
type AdmissionContext = {
  lanes: Set<number>;
  folders: string[];
  permitDepth: number;
  released: boolean;
  parent: AdmissionContext | null;
};

type WriteGateHold = { released: boolean };

type WaitDraft = {
  kind: "folder" | "io";
  role: DiskRole;
  commandId: number;
  lane: number;
  folder: string;
  reason: string;
  token: number;
};

const admissionContext = new AsyncLocalStorage<AdmissionContext>();
const writeGateHold = new AsyncLocalStorage<WriteGateHold>();

function liveAdmission(): AdmissionContext | null {
  let ctx = admissionContext.getStore() ?? null;
  while (ctx && ctx.released) ctx = ctx.parent;
  return ctx;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

/** Run `fn` and call `release` once it has settled, sync or async. */
function runHold<T>(fn: () => T, release: () => void): T {
  let result: T;
  try {
    result = fn();
  } catch (error) {
    release();
    throw error;
  }
  if (!isPromiseLike(result)) {
    release();
    return result;
  }
  return Promise.resolve(result).then(
    (value) => { release(); return value; },
    (error) => { release(); throw error; },
  ) as T;
}
let ownerToken = 0;

function configuredLimit(): number {
  const raw = process.env.DISCOGENIUS_HDD_IO_LIMIT;
  if (raw == null || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return 1;
  return Math.min(MAX_IO, Math.max(1, parsed));
}

function sab(): SharedArrayBuffer {
  const state = globalThis as Record<string, unknown>;
  const existing = state[GLOBAL_KEY];
  if (existing instanceof SharedArrayBuffer && existing.byteLength >= TOTAL_BYTES) return existing;
  const inherited = (workerData as Record<string, unknown> | null)?.[DISK_ADMISSION_KEY];
  if (inherited instanceof SharedArrayBuffer) {
    if (inherited.byteLength < TOTAL_BYTES) {
      throw new Error(`Inherited disk admission buffer is ${inherited.byteLength} bytes; expected at least ${TOTAL_BYTES}`);
    }
    state[GLOBAL_KEY] = inherited;
    return inherited;
  }
  if (!isMainThread) throw new Error("Disk admission worker did not inherit the admission buffer");
  const created = new SharedArrayBuffer(TOTAL_BYTES);
  state[GLOBAL_KEY] = created;
  return created;
}

function ints(): Int32Array {
  const view = new Int32Array(sab());
  if (Atomics.load(view, INIT) === 1) return view;
  if (!isMainThread) throw new Error("Disk admission buffer was not initialized");
  // Publish the limit and the token seed before INIT so a later reader cannot
  // observe a zero token allocator. Main-thread JavaScript does not interleave
  // this sequence with itself; workers only attach after workerData() returns.
  Atomics.store(view, IO_LIMIT, configuredLimit());
  Atomics.store(view, TOKEN, 1);
  Atomics.store(view, INIT, 1);
  return view;
}

function bytes(): Uint8Array {
  return new Uint8Array(sab());
}

function writeText(offset: number, length: number, text: string): void {
  const region = bytes().subarray(offset, offset + length);
  region.fill(0);
  new TextEncoder().encodeInto(text, region.subarray(0, Math.max(0, length - 1)));
}

function readText(offset: number, length: number): string {
  const region = bytes().subarray(offset, offset + length);
  const end = region.indexOf(0);
  return new TextDecoder().decode(end === -1 ? region : region.subarray(0, end));
}

function allocateOwner(): number {
  const token = Atomics.add(ints(), TOKEN, 1);
  return token > 0 ? token : 1;
}

function currentOwner(): number {
  if (ownerToken > 0) return ownerToken;
  const inherited = Number((workerData as Record<string, unknown> | null)?.[DISK_ADMISSION_OWNER_KEY]);
  ownerToken = Number.isInteger(inherited) && inherited > 0 ? inherited : allocateOwner();
  return ownerToken;
}

export function diskAdmissionWorkerData(): Record<string, SharedArrayBuffer | number> {
  ints();
  return {
    [DISK_ADMISSION_KEY]: sab(),
    [DISK_ADMISSION_OWNER_KEY]: allocateOwner(),
  };
}

export function hddIoLimit(): number {
  return Atomics.load(ints(), IO_LIMIT);
}

/** Test and operator hook. Refuses while any permit is outstanding. */
export function configureHddIoLimit(limit: number): void {
  const view = ints();
  if (Atomics.load(view, IO_IN_USE) !== 0) {
    throw new Error("cannot change the HDD I/O limit while permits are held");
  }
  for (let slot = 0; slot < MAX_IO; slot += 1) {
    if (Atomics.load(view, IO_OWNER_START + slot) !== 0) {
      throw new Error("cannot change the HDD I/O limit while permits are held");
    }
  }
  const clamped = Math.min(MAX_IO, Math.max(1, Math.floor(limit)));
  Atomics.store(view, IO_LIMIT, clamped);
}

function laneOf(folder: string): number {
  let hash = 2166136261;
  for (const char of folder) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % LANES;
}

/** Hash lane for a folder. Collisions only add serialization; they do not deadlock. */
export function albumFolderLane(folder: string): number {
  return laneOf(normalizeResolvedPath(folder));
}

function laneBase(lane: number): number {
  return LANE_BASE + lane * LANE_STRIDE;
}

function roleCode(role: DiskRole): number {
  return ROLE_CODE[role] ?? ROLE_CODE.other;
}

function roleName(code: number): DiskRole | "" {
  return CODE_ROLE[code] ?? "";
}

export function writeGateIsHeld(): boolean {
  const hold = writeGateHold.getStore();
  return hold !== undefined && !hold.released;
}

export function ioPermitIsHeld(): boolean {
  return (liveAdmission()?.permitDepth ?? 0) > 0;
}

/**
 * Mark the current async flow as inside the SQLite write gate.
 * Callers wrap the body that already holds the process write mutex.
 */
export function enterWriteGate<T>(fn: () => T): T {
  if (ioPermitIsHeld()) {
    throw new Error("SQLite write gate entered while an HDD I/O permit is held");
  }
  // Nested section of a live gate: the outer section owns the release.
  if (writeGateIsHeld()) return fn();
  const hold: WriteGateHold = { released: false };
  return writeGateHold.run(hold, () => runHold(fn, () => { hold.released = true; }));
}

function assertMayAcquireFolder(): void {
  if (writeGateIsHeld()) {
    throw new Error("album folder lock requested while the SQLite write gate is held");
  }
  if (ioPermitIsHeld()) {
    throw new Error("album folder lock requested while an HDD I/O permit is held");
  }
}

function tryTakeLane(view: Int32Array, base: number, token: number, isImport: boolean): boolean {
  if (isImport) {
    if (Atomics.compareExchange(view, base + LANE_STATE, FREE, token) === FREE) return true;
    return Atomics.compareExchange(view, base + LANE_STATE, IMPORT_RESERVED, token) === IMPORT_RESERVED;
  }
  if (Atomics.load(view, base + LANE_IMPORT_WAITERS) > 0) return false;
  if (Atomics.load(view, base + LANE_STATE) === IMPORT_RESERVED) return false;
  return Atomics.compareExchange(view, base + LANE_STATE, FREE, token) === FREE;
}

function publishHolder(lane: number, meta: DiskAdmissionMeta, folder: string): void {
  const view = ints();
  const base = laneBase(lane);
  Atomics.store(view, base + LANE_ROLE, roleCode(meta.role));
  Atomics.store(view, base + LANE_COMMAND, meta.commandId | 0);
  writeText(PATH_REGION + lane * PATH_BYTES, PATH_BYTES, folder);
}

function clearHolder(lane: number): void {
  const view = ints();
  const base = laneBase(lane);
  Atomics.store(view, base + LANE_ROLE, 0);
  Atomics.store(view, base + LANE_COMMAND, 0);
  writeText(PATH_REGION + lane * PATH_BYTES, PATH_BYTES, "");
}

function releaseLane(lane: number): void {
  const view = ints();
  const token = currentOwner();
  const base = laneBase(lane);
  const next = Atomics.load(view, base + LANE_IMPORT_WAITERS) > 0 ? IMPORT_RESERVED : FREE;
  clearHolder(lane);
  if (Atomics.compareExchange(view, base + LANE_STATE, token, next) === token) {
    Atomics.notify(view, base + LANE_STATE);
  }
}

function folderWaitReason(lane: number, meta: DiskAdmissionMeta): string {
  const view = ints();
  const base = laneBase(lane);
  const state = Atomics.load(view, base + LANE_STATE);
  if (state === IMPORT_RESERVED) return "folder reserved for a waiting import";
  const holderRole = roleName(Atomics.load(view, base + LANE_ROLE)) || "unknown";
  const holderCommand = Atomics.load(view, base + LANE_COMMAND);
  const folder = readText(PATH_REGION + lane * PATH_BYTES, PATH_BYTES);
  const where = folder ? ` on ${folder}` : "";
  const extra = meta.reason ? ` (${meta.reason})` : "";
  return `album folder lock held by ${holderRole} command ${holderCommand}${where}${extra}`;
}

function ioWaitReason(): string {
  const view = ints();
  return `HDD I/O permit (${Atomics.load(view, IO_IN_USE)}/${Atomics.load(view, IO_LIMIT)} in use)`;
}

function beginWait(draft: WaitDraft): number {
  const view = ints();
  for (let slot = 0; slot < WAIT_SLOTS; slot += 1) {
    const index = WAIT_BASE + slot * WAIT_STRIDE;
    if (Atomics.compareExchange(view, index + WAIT_ACTIVE, 0, 1) !== 0) continue;
    Atomics.store(view, index + WAIT_KIND, draft.kind === "folder" ? 1 : 2);
    Atomics.store(view, index + WAIT_ROLE, roleCode(draft.role));
    Atomics.store(view, index + WAIT_COMMAND, draft.commandId | 0);
    Atomics.store(view, index + WAIT_LANE, draft.lane);
    Atomics.store(view, index + WAIT_SINCE, Math.floor(Date.now() / 1000));
    Atomics.store(view, index + WAIT_TOKEN, draft.token);
    writeText(REASON_REGION + slot * REASON_BYTES, REASON_BYTES, draft.reason);
    writeText(WAIT_FOLDER_REGION + slot * PATH_BYTES, PATH_BYTES, draft.folder);
    return slot;
  }
  return -1;
}

function updateWait(slot: number, reason: string): void {
  if (slot < 0) return;
  writeText(REASON_REGION + slot * REASON_BYTES, REASON_BYTES, reason);
}

function clearWait(slot: number): void {
  if (slot < 0) return;
  const view = ints();
  const index = WAIT_BASE + slot * WAIT_STRIDE;
  Atomics.store(view, index + WAIT_KIND, 0);
  Atomics.store(view, index + WAIT_ROLE, 0);
  Atomics.store(view, index + WAIT_COMMAND, 0);
  Atomics.store(view, index + WAIT_LANE, 0);
  Atomics.store(view, index + WAIT_SINCE, 0);
  Atomics.store(view, index + WAIT_TOKEN, 0);
  writeText(REASON_REGION + slot * REASON_BYTES, REASON_BYTES, "");
  writeText(WAIT_FOLDER_REGION + slot * PATH_BYTES, PATH_BYTES, "");
  Atomics.store(view, index + WAIT_ACTIVE, 0);
}

async function waitFor(view: Int32Array, index: number, expected: number): Promise<void> {
  const waitAsync = (Atomics as typeof Atomics & {
    waitAsync?: (typed: Int32Array, index: number, value: number, timeout: number) => { value: Promise<string> | string };
  }).waitAsync;
  if (waitAsync) {
    await waitAsync(view, index, expected, 100).value;
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function acquireLane(lane: number, meta: DiskAdmissionMeta, folder: string): Promise<void> {
  const view = ints();
  const token = currentOwner();
  const base = laneBase(lane);
  const isImport = meta.role === "import";
  const waiterIndex = base + (isImport ? LANE_IMPORT_WAITERS : LANE_OTHER_WAITERS);
  let waiting = false;
  let waitSlot = -1;
  let logged = false;
  try {
    while (true) {
      if (tryTakeLane(view, base, token, isImport)) {
        publishHolder(lane, meta, folder);
        return;
      }
      // Stay counted as a waiter across the timeout so a release cannot miss
      // the import reservation. The count drops in finally, after we own the lane.
      if (!waiting) {
        Atomics.add(view, waiterIndex, 1);
        waiting = true;
      }
      if (tryTakeLane(view, base, token, isImport)) {
        publishHolder(lane, meta, folder);
        return;
      }
      const observed = Atomics.load(view, base + LANE_STATE);
      if (tryTakeLane(view, base, token, isImport)) {
        publishHolder(lane, meta, folder);
        return;
      }
      const reason = folderWaitReason(lane, meta);
      if (!logged) {
        waitSlot = beginWait({
          kind: "folder",
          role: meta.role,
          commandId: meta.commandId,
          lane,
          folder,
          reason,
          token,
        });
        console.info(`[disk-admission] ${meta.role} command ${meta.commandId} waiting: ${reason}`);
        logged = true;
      } else {
        updateWait(waitSlot, reason);
      }
      await waitFor(view, base + LANE_STATE, observed);
    }
  } finally {
    if (waiting) Atomics.sub(view, waiterIndex, 1);
    clearWait(waitSlot);
  }
}

function orderedLanes(folders: string[]): number[] {
  return [...new Set(folders.map(laneOf))].sort((left, right) => left - right);
}

async function withFolders<T>(folders: string[], meta: DiskAdmissionMeta, fn: () => Promise<T>): Promise<T> {
  const normalized = [...new Set(folders.map((folder) => normalizeResolvedPath(folder)))].filter((folder) => folder.length > 0).sort();
  if (normalized.length === 0) return fn();
  const lanes = orderedLanes(normalized);
  const current = liveAdmission();
  // Same folders on this flow are re-entrant, including while a permit or the
  // write gate is held. A new folder is a new acquisition and must follow the
  // lock order.
  if (current && current.lanes.size > 0 && lanes.every((lane) => current.lanes.has(lane))) return fn();
  assertMayAcquireFolder();
  if (current && current.lanes.size > 0) {
    throw new Error("nested album folder lock; acquire every folder together with withAlbumFolders");
  }
  const acquired: number[] = [];
  try {
    for (const lane of lanes) {
      const folder = normalized.find((candidate) => laneOf(candidate) === lane) ?? normalized[0];
      await acquireLane(lane, meta, folder);
      acquired.push(lane);
    }
    const ctx: AdmissionContext = {
      lanes: new Set(acquired), folders: normalized, permitDepth: 0, released: false, parent: null,
    };
    try {
      return await admissionContext.run(ctx, fn);
    } finally {
      ctx.released = true;
    }
  } finally {
    for (const lane of acquired.reverse()) releaseLane(lane);
  }
}

/** One album directory. Re-entrant for the same folder on this async flow. */
export function withAlbumFolder<T>(folder: string, meta: DiskAdmissionMeta, fn: () => Promise<T>): Promise<T> {
  return withFolders([folder], meta, fn);
}

/**
 * Every folder a single rename needs. Paths may be passed in any order; the
 * implementation sorts them and locks lanes in ascending index.
 */
export function withAlbumFolders<T>(folders: readonly string[], meta: DiskAdmissionMeta, fn: () => Promise<T>): Promise<T> {
  return withFolders([...folders], meta, fn);
}

type IoRequest = { slot: number };

/** Publish a ticket before taking a slot. Ticket 0 means the publisher has
 * the queue cell but has not stored the number yet, and it counts as ahead
 * so a half-published request cannot be overtaken. */
function publishIoRequest(view: Int32Array, token: number): IoRequest {
  for (let index = 0; index < IO_QUEUE_CAPACITY; index += 1) {
    const slot = IO_QUEUE_START + index * IO_QUEUE_STRIDE;
    if (Atomics.compareExchange(view, slot, 0, token) !== 0) continue;
    let ticket = Atomics.add(view, IO_TICKET, 1) + 1;
    if ((ticket | 0) === 0) ticket = Atomics.add(view, IO_TICKET, 1) + 1;
    Atomics.store(view, slot + 1, ticket);
    Atomics.notify(view, IO_IN_USE);
    return { slot };
  }
  throw new Error("HDD I/O permit queue is full");
}

function clearIoRequest(view: Int32Array, request: IoRequest): void {
  Atomics.store(view, request.slot + 1, 0);
  Atomics.store(view, request.slot, 0);
  Atomics.notify(view, IO_IN_USE);
}

function clearIoQueueForOwner(view: Int32Array, token: number): void {
  let cleared = false;
  for (let index = 0; index < IO_QUEUE_CAPACITY; index += 1) {
    const slot = IO_QUEUE_START + index * IO_QUEUE_STRIDE;
    if (Atomics.load(view, slot) !== token) continue;
    Atomics.store(view, slot + 1, 0);
    Atomics.store(view, slot, 0);
    cleared = true;
  }
  if (cleared) Atomics.notify(view, IO_IN_USE);
}

/** How many queued tickets are strictly ahead of ours. Null while our own
 * ticket is still unpublished. Signed subtraction keeps order across wrap. */
function ticketsAhead(view: Int32Array, request: IoRequest): number | null {
  const ticket = Atomics.load(view, request.slot + 1);
  if (ticket === 0) return null;
  let ahead = 0;
  for (let index = 0; index < IO_QUEUE_CAPACITY; index += 1) {
    const slot = IO_QUEUE_START + index * IO_QUEUE_STRIDE;
    if (slot === request.slot || Atomics.load(view, slot) === 0) continue;
    const other = Atomics.load(view, slot + 1);
    if (other === 0 || ((other - ticket) | 0) < 0) ahead += 1;
  }
  return ahead;
}

function tryTakePermit(view: Int32Array, token: number, request: IoRequest): number {
  const ahead = ticketsAhead(view, request);
  if (ahead == null) return -1;
  const limit = Atomics.load(view, IO_LIMIT);
  const inUse = Atomics.load(view, IO_IN_USE);
  if (ahead >= limit - inUse) return -1;
  for (let slot = 0; slot < limit; slot += 1) {
    if (Atomics.compareExchange(view, IO_OWNER_START + slot, 0, token) !== 0) continue;
    Atomics.add(view, IO_IN_USE, 1);
    const stillAhead = ticketsAhead(view, request);
    const freeBeforeUs = Atomics.load(view, IO_LIMIT) - (Atomics.load(view, IO_IN_USE) - 1);
    if (stillAhead != null && stillAhead < freeBeforeUs) {
      clearIoRequest(view, request);
      return slot;
    }
    Atomics.sub(view, IO_IN_USE, 1);
    if (Atomics.compareExchange(view, IO_OWNER_START + slot, token, 0) === token) {
      Atomics.notify(view, IO_IN_USE);
    }
    return -1;
  }
  return -1;
}

function releasePermitSlot(slot: number): void {
  const view = ints();
  const token = currentOwner();
  if (Atomics.compareExchange(view, IO_OWNER_START + slot, token, 0) !== token) return;
  Atomics.sub(view, IO_IN_USE, 1);
  Atomics.notify(view, IO_IN_USE);
}

async function acquirePermit(meta: DiskAdmissionMeta, folder: string): Promise<number> {
  const view = ints();
  const token = currentOwner();
  let request: IoRequest | null = null;
  let waiting = false;
  let waitSlot = -1;
  let logged = false;
  try {
    request = publishIoRequest(view, token);
    while (true) {
      const slot = tryTakePermit(view, token, request);
      if (slot >= 0) return slot;
      if (!waiting) {
        Atomics.add(view, IO_WAITERS, 1);
        waiting = true;
      }
      const observed = Atomics.load(view, IO_IN_USE);
      const again = tryTakePermit(view, token, request);
      if (again >= 0) return again;
      const reason = ioWaitReason();
      if (!logged) {
        waitSlot = beginWait({
          kind: "io",
          role: meta.role,
          commandId: meta.commandId,
          lane: -1,
          folder,
          reason,
          token,
        });
        console.info(`[disk-admission] ${meta.role} command ${meta.commandId} waiting: ${reason}`);
        logged = true;
      } else {
        updateWait(waitSlot, reason);
      }
      await waitFor(view, IO_IN_USE, observed);
    }
  } finally {
    if (waiting) Atomics.sub(view, IO_WAITERS, 1);
    clearWait(waitSlot);
    if (request && Atomics.load(view, request.slot) === token) clearIoRequest(view, request);
  }
}

/**
 * Global cap on concurrent file reads and writes. The folder lock must already
 * be held, and the permit must be dropped before `enterWriteGate`.
 */
export async function withHddIoPermit<T>(meta: DiskAdmissionMeta, fn: () => Promise<T>): Promise<T> {
  if (writeGateIsHeld()) throw new Error("HDD I/O permit requested while the SQLite write gate is held");
  const ctx = liveAdmission();
  if (!ctx || ctx.lanes.size === 0) throw new Error("HDD I/O permit requested without an album folder lock");
  // Nested permit on this flow reuses the slot. A sibling task in the parent
  // flow has its own store, so it cannot clear this depth and then take the
  // write gate while the permit is still held.
  if (ctx.permitDepth > 0) return fn();
  const slot = await acquirePermit(meta, ctx.folders.join(", "));
  const holding: AdmissionContext = {
    lanes: ctx.lanes, folders: ctx.folders, permitDepth: 1, released: false, parent: ctx,
  };
  try {
    return await admissionContext.run(holding, fn);
  } finally {
    holding.released = true;
    releasePermitSlot(slot);
  }
}

export function diskAdmissionSnapshot(): DiskAdmissionSnapshot {
  const view = ints();
  const holders: DiskAdmissionHolder[] = [];
  for (let lane = 0; lane < LANES; lane += 1) {
    const base = laneBase(lane);
    const state = Atomics.load(view, base + LANE_STATE);
    if (state === FREE) continue;
    holders.push({
      lane,
      folder: readText(PATH_REGION + lane * PATH_BYTES, PATH_BYTES),
      role: roleName(Atomics.load(view, base + LANE_ROLE)),
      commandId: Atomics.load(view, base + LANE_COMMAND),
      reservedForImport: state === IMPORT_RESERVED,
    });
  }
  const waits: DiskAdmissionWait[] = [];
  for (let slot = 0; slot < WAIT_SLOTS; slot += 1) {
    const index = WAIT_BASE + slot * WAIT_STRIDE;
    if (Atomics.load(view, index + WAIT_ACTIVE) !== 1) continue;
    const kindCode = Atomics.load(view, index + WAIT_KIND);
    waits.push({
      kind: kindCode === 2 ? "io" : "folder",
      role: roleName(Atomics.load(view, index + WAIT_ROLE)),
      commandId: Atomics.load(view, index + WAIT_COMMAND),
      folder: readText(WAIT_FOLDER_REGION + slot * PATH_BYTES, PATH_BYTES),
      reason: readText(REASON_REGION + slot * REASON_BYTES, REASON_BYTES),
      sinceMs: Atomics.load(view, index + WAIT_SINCE) * 1000,
      lane: Atomics.load(view, index + WAIT_LANE),
    });
  }
  return {
    ioLimit: Atomics.load(view, IO_LIMIT),
    ioInUse: Atomics.load(view, IO_IN_USE),
    ioWaiters: Atomics.load(view, IO_WAITERS),
    holders,
    waits,
  };
}

/** Call only after the physical worker has exited, never on a logical timeout. */
export function releaseExitedDiskAdmissionOwner(token: number): void {
  if (!Number.isInteger(token) || token <= 0) return;
  const view = ints();
  for (let lane = 0; lane < LANES; lane += 1) {
    const base = laneBase(lane);
    if (Atomics.load(view, base + LANE_STATE) !== token) continue;
    const next = Atomics.load(view, base + LANE_IMPORT_WAITERS) > 0 ? IMPORT_RESERVED : FREE;
    clearHolder(lane);
    if (Atomics.compareExchange(view, base + LANE_STATE, token, next) === token) {
      Atomics.notify(view, base + LANE_STATE);
    }
  }
  let releasedPermit = false;
  for (let slot = 0; slot < MAX_IO; slot += 1) {
    if (Atomics.compareExchange(view, IO_OWNER_START + slot, token, 0) !== token) continue;
    Atomics.sub(view, IO_IN_USE, 1);
    releasedPermit = true;
  }
  if (releasedPermit) Atomics.notify(view, IO_IN_USE);
  clearIoQueueForOwner(view, token);
  for (let slot = 0; slot < WAIT_SLOTS; slot += 1) {
    const index = WAIT_BASE + slot * WAIT_STRIDE;
    if (Atomics.load(view, index + WAIT_TOKEN) === token) clearWait(slot);
  }
}
