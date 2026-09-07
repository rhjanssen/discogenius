/**
 * Process-wide SQLite writer mutex.
 *
 * Lidarr runs three command threads against one SQLite file with
 * `BusyTimeout = 1000` and no per-route retry loops. That works because those
 * threads *block* on the lock and ASP.NET still serves other requests from the
 * thread pool. Discogenius cannot copy the blocking part on the HTTP event loop,
 * so Discogenius adds asynchronous admission for its shared SQLite writer.
 * This mutex is a Node adaptation, not an implementation copied from Lidarr.
 *
 * Command / download / WAL workers take the mutex synchronously (`Atomics.wait`).
 * Async HTTP/scheduler writes take it with `Atomics.waitAsync` so the event loop
 * stays free. Re-entrant: a transaction that already holds the mutex does not
 * wait on itself.
 */
import { isMainThread, workerData } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";

export const SQLITE_WRITE_MUTEX_WORKER_DATA_KEY = "sqliteWriteMutex";
export const SQLITE_WRITE_MUTEX_OWNER_WORKER_DATA_KEY = "sqliteWriteMutexOwner";

const MUTEX_GLOBAL_KEY = "__discogeniusSqliteWriteMutexSab";

const OWNER_INDEX = 0;
const TOKEN_ALLOCATOR_INDEX = 1;
const ACQUIRED_AT_SECONDS_INDEX = 2;
const WAITING_WRITERS_INDEX = 3;
const GRANTS_INDEX = 4;
const TOTAL_WAIT_MS_INDEX = 5;
const MAX_WAIT_MS_INDEX = 6;
const MAX_QUEUE_DEPTH_INDEX = 7;
const MAX_HOLD_MS_INDEX = 8;
const TICKET_INDEX = 9;
const HELD_SLOT_INDEX = 10;
const LABEL_CELLS = 48;
const LONGEST_LABEL_INDEX = 11;
const QUEUE_START = LONGEST_LABEL_INDEX + LABEL_CELLS;
const QUEUE_CAPACITY = 256;
const SLOT_CELLS = 2 + LABEL_CELLS;
const MUTEX_BYTE_LENGTH = (QUEUE_START + QUEUE_CAPACITY * SLOT_CELLS) * Int32Array.BYTES_PER_ELEMENT;

type MutexTls = { holds: number; context: symbol | null };

const tls: MutexTls = { holds: 0, context: null };
const writeContext = new AsyncLocalStorage<symbol>();

function readWorkerDataMutex(): SharedArrayBuffer | null {
  const data = workerData as Record<string, unknown> | null;
  const value = data?.[SQLITE_WRITE_MUTEX_WORKER_DATA_KEY];
  return value instanceof SharedArrayBuffer ? value : null;
}

export function getOrCreateSqliteWriteMutexSab(): SharedArrayBuffer {
  const globalState = globalThis as Record<string, unknown>;
  const existing = globalState[MUTEX_GLOBAL_KEY];
  if (existing instanceof SharedArrayBuffer && existing.byteLength >= MUTEX_BYTE_LENGTH) {
    return existing;
  }

  const fromWorker = readWorkerDataMutex();
  if (fromWorker && fromWorker.byteLength >= MUTEX_BYTE_LENGTH) {
    globalState[MUTEX_GLOBAL_KEY] = fromWorker;
    return fromWorker;
  }

  if (!isMainThread && fromWorker) {
    throw new Error(`Inherited SQLite writer mutex is ${fromWorker.byteLength} bytes; expected at least ${MUTEX_BYTE_LENGTH}`);
  }

  // The first two cells are the current owner and token allocator. The rest
  // are shared contention counters so health reports the mutex workers really
  // use instead of the retired postMessage owner queue.
  // The owner token lets a parent release a dead worker's lock. A one-bit
  // mutex stayed locked forever when the watchdog terminated a worker in the
  // middle of a SQLite write.
  const created = new SharedArrayBuffer(MUTEX_BYTE_LENGTH);
  globalState[MUTEX_GLOBAL_KEY] = created;
  return created;
}

function mutexView(): Int32Array {
  return new Int32Array(getOrCreateSqliteWriteMutexSab());
}

export function allocateSqliteWriteMutexOwnerToken(): number {
  const view = mutexView();
  let token = Atomics.add(view, TOKEN_ALLOCATOR_INDEX, 1) + 1;
  if (token <= 0) {
    Atomics.store(view, TOKEN_ALLOCATOR_INDEX, 1);
    token = 1;
  }
  return token;
}

let localOwnerToken = 0;

function currentOwnerToken(): number {
  if (localOwnerToken > 0) return localOwnerToken;
  const data = workerData as Record<string, unknown> | null;
  const inherited = Number(data?.[SQLITE_WRITE_MUTEX_OWNER_WORKER_DATA_KEY]);
  localOwnerToken = Number.isInteger(inherited) && inherited > 0
    ? inherited
    : allocateSqliteWriteMutexOwnerToken();
  return localOwnerToken;
}

export function sqliteWriteMutexWorkerData(): Record<string, SharedArrayBuffer | number> {
  return {
    [SQLITE_WRITE_MUTEX_WORKER_DATA_KEY]: getOrCreateSqliteWriteMutexSab(),
    [SQLITE_WRITE_MUTEX_OWNER_WORKER_DATA_KEY]: allocateSqliteWriteMutexOwnerToken(),
  };
}

export function holdsSqliteWriteMutex(): boolean {
  return tls.holds > 0 && (tls.context === null || writeContext.getStore() === tls.context);
}

/** True when any thread in this process currently holds the writer mutex. */
export function isSqliteWriteMutexHeld(): boolean {
  return Atomics.load(mutexView(), OWNER_INDEX) !== 0;
}

function atomicMax(view: Int32Array, index: number, value: number): void {
  let current = Atomics.load(view, index);
  while (value > current) {
    const observed = Atomics.compareExchange(view, index, current, value);
    if (observed === current) return;
    current = observed;
  }
}

function writeLabel(view: Int32Array, offset: number, label: string): void {
  const bytes = new Uint8Array(view.buffer, offset * 4, LABEL_CELLS * 4);
  bytes.fill(0);
  new TextEncoder().encodeInto(label, bytes.subarray(0, bytes.length - 1));
}

function readLabel(view: Int32Array, offset: number): string | null {
  const bytes = new Uint8Array(view.buffer, offset * 4, LABEL_CELLS * 4);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end)) || null;
}

function busyError(): Error & { code: string } {
  return Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
}

type WriteRequest = { slot: number; waitingSince: number };

function enqueueWrite(view: Int32Array, label: string): WriteRequest {
  const owner = currentOwnerToken();
  for (let index = 0; index < QUEUE_CAPACITY; index++) {
    const slot = QUEUE_START + index * SLOT_CELLS;
    if (Atomics.compareExchange(view, slot, 0, owner) !== 0) continue;
    const waitingSince = beginMutexWait(view);
    writeLabel(view, slot + 2, label);
    let ticket = Atomics.add(view, TICKET_INDEX, 1) + 1;
    if ((ticket | 0) === 0) ticket = Atomics.add(view, TICKET_INDEX, 1) + 1;
    Atomics.store(view, slot + 1, ticket);
    Atomics.notify(view, OWNER_INDEX);
    return { slot, waitingSince };
  }
  throw busyError();
}

function abandonWrite(view: Int32Array, request: WriteRequest): void {
  Atomics.store(view, request.slot + 1, 0);
  Atomics.store(view, request.slot, 0);
  Atomics.sub(view, WAITING_WRITERS_INDEX, 1);
  Atomics.notify(view, OWNER_INDEX);
}

function grantWrite(view: Int32Array, request: WriteRequest): boolean {
  if (Atomics.load(view, OWNER_INDEX) !== 0) return false;
  const ticket = Atomics.load(view, request.slot + 1);
  for (let index = 0; index < QUEUE_CAPACITY; index++) {
    const slot = QUEUE_START + index * SLOT_CELLS;
    if (slot === request.slot || Atomics.load(view, slot) === 0) continue;
    const other = Atomics.load(view, slot + 1);
    // Zero means another thread is publishing a request. It will notify us.
    // Signed subtraction also preserves order across the ticket counter wrap.
    if (other === 0 || ((other - ticket) | 0) < 0) return false;
  }
  if (Atomics.compareExchange(view, OWNER_INDEX, 0, currentOwnerToken()) !== 0) return false;
  Atomics.store(view, HELD_SLOT_INDEX, request.slot);
  tls.holds = 1;
  recordMutexAcquired(view, request.waitingSince);
  return true;
}

function beginMutexWait(view: Int32Array): number {
  const depth = Atomics.add(view, WAITING_WRITERS_INDEX, 1) + 1;
  atomicMax(view, MAX_QUEUE_DEPTH_INDEX, depth + (Atomics.load(view, OWNER_INDEX) !== 0 ? 1 : 0));
  return Date.now();
}

function recordMutexAcquired(view: Int32Array, waitingSince: number | null): void {
  const waitedMs = waitingSince == null
    ? 0
    : Math.min(0x7fffffff, Math.max(0, Date.now() - waitingSince));
  if (waitingSince != null) Atomics.sub(view, WAITING_WRITERS_INDEX, 1);
  Atomics.store(view, ACQUIRED_AT_SECONDS_INDEX, Math.floor(Date.now() / 1000));
  Atomics.add(view, GRANTS_INDEX, 1);
  Atomics.add(view, TOTAL_WAIT_MS_INDEX, Math.min(waitedMs, 0x7fffffff));
  atomicMax(view, MAX_WAIT_MS_INDEX, waitedMs);
}

function recordMutexReleased(view: Int32Array): void {
  const acquiredAt = Atomics.exchange(view, ACQUIRED_AT_SECONDS_INDEX, 0);
  if (acquiredAt > 0) {
    const heldMs = Math.max(0, Date.now() - acquiredAt * 1000);
    if (heldMs >= Atomics.load(view, MAX_HOLD_MS_INDEX)) {
      const slot = Atomics.load(view, HELD_SLOT_INDEX);
      writeLabel(view, LONGEST_LABEL_INDEX, slot ? readLabel(view, slot + 2) || "" : "");
      atomicMax(view, MAX_HOLD_MS_INDEX, heldMs);
    }
  }
}

function releaseMutexOwner(view: Int32Array, ownerToken: number, exited = false): boolean {
  // Mark the owner as releasing before clearing its timestamp. A direct
  // owner-to-zero CAS lets a waiting worker acquire between those operations
  // and the old owner then wipes the new owner's start time.
  const observed = Atomics.compareExchange(view, OWNER_INDEX, ownerToken, -ownerToken);
  if (observed !== ownerToken && !(exited && observed === -ownerToken)) {
    return false;
  }
  recordMutexReleased(view);
  const slot = Atomics.exchange(view, HELD_SLOT_INDEX, 0);
  if (slot) {
    Atomics.store(view, slot + 1, 0);
    Atomics.store(view, slot, 0);
  }
  Atomics.store(view, OWNER_INDEX, 0);
  Atomics.notify(view, OWNER_INDEX);
  return true;
}

export function sqliteWriteMutexDiagnostics(): {
  held: boolean;
  ownerToken: number | null;
  heldForMs: number;
  queueDepth: number;
  grants: number;
  averageWaitMs: number;
  maxWaitMs: number;
  maxQueueDepth: number;
  longestHoldMs: number;
  heldByLabel: string | null;
  longestHoldLabel: string | null;
  waitingLabels: string[];
} {
  const view = mutexView();
  const rawOwnerToken = Atomics.load(view, OWNER_INDEX);
  const ownerToken = Math.abs(rawOwnerToken);
  const acquiredAt = Atomics.load(view, ACQUIRED_AT_SECONDS_INDEX);
  const grants = Math.max(0, Atomics.load(view, GRANTS_INDEX));
  const totalWaitMs = Math.max(0, Atomics.load(view, TOTAL_WAIT_MS_INDEX));
  const heldSlot = Atomics.load(view, HELD_SLOT_INDEX);
  const waitingLabels: string[] = [];
  for (let index = 0; index < QUEUE_CAPACITY; index++) {
    const slot = QUEUE_START + index * SLOT_CELLS;
    if (slot !== heldSlot && Atomics.load(view, slot) !== 0) {
      waitingLabels.push(readLabel(view, slot + 2) || "unlabelled");
    }
  }
  return {
    held: rawOwnerToken !== 0,
    ownerToken: ownerToken || null,
    heldForMs: rawOwnerToken !== 0 && acquiredAt > 0
      ? Math.max(0, Date.now() - acquiredAt * 1000)
      : 0,
    queueDepth: Math.max(0, Atomics.load(view, WAITING_WRITERS_INDEX)),
    grants,
    averageWaitMs: grants === 0 ? 0 : Math.round(totalWaitMs / grants),
    maxWaitMs: Math.max(0, Atomics.load(view, MAX_WAIT_MS_INDEX)),
    maxQueueDepth: Math.max(0, Atomics.load(view, MAX_QUEUE_DEPTH_INDEX)),
    longestHoldMs: Math.max(0, Atomics.load(view, MAX_HOLD_MS_INDEX)),
    heldByLabel: heldSlot ? readLabel(view, heldSlot + 2) : null,
    longestHoldLabel: readLabel(view, LONGEST_LABEL_INDEX),
    waitingLabels,
  };
}

export function tryAcquireSqliteWriteMutex(label = "synchronous write"): boolean {
  if (holdsSqliteWriteMutex()) {
    tls.holds += 1;
    return true;
  }
  const view = mutexView();
  if (Atomics.load(view, OWNER_INDEX) !== 0) return false;
  // Admission uses the actual tickets below. A worker can die between updating
  // a diagnostic counter and publishing/removing its ticket.
  const request = enqueueWrite(view, label);
  if (grantWrite(view, request)) return true;
  abandonWrite(view, request);
  return false;
}

export function acquireSqliteWriteMutexSync(timeoutMs: number = 15_000, label = "synchronous write"): void {
  if (holdsSqliteWriteMutex()) {
    tls.holds += 1;
    return;
  }
  // Waiting here would prevent the unrelated async owner on this thread
  // from resuming and releasing its lock.
  if (tls.holds > 0) throw busyError();
  const lock = mutexView();
  const deadline = timeoutMs == null ? null : Date.now() + Math.max(0, timeoutMs);
  const request = enqueueWrite(lock, label);
  while (true) {
    const observedOwner = Atomics.load(lock, OWNER_INDEX);
    if (grantWrite(lock, request)) return;
    const remaining = deadline == null ? Infinity : deadline - Date.now();
    if (remaining <= 0) {
      abandonWrite(lock, request);
      throw busyError();
    }
    const waitMs = Number.isFinite(remaining) ? Math.min(remaining, 1_000_000) : undefined;
    Atomics.wait(lock, OWNER_INDEX, observedOwner, Math.min(waitMs ?? 100, 100));
  }
}

export async function acquireSqliteWriteMutexAsync(label = "asynchronous write", context: symbol | null = null): Promise<void> {
  // Unrelated async writers on the same thread must take turns. The wrapper
  // recognizes nested calls through AsyncLocalStorage before reaching here.
  const lock = mutexView();
  const request = enqueueWrite(lock, label);
  while (true) {
    const observedOwner = Atomics.load(lock, OWNER_INDEX);
    if (grantWrite(lock, request)) {
      tls.context = context;
      return;
    }
    const waitAsync = (Atomics as typeof Atomics & {
      waitAsync?: (typedArray: Int32Array, index: number, value: number, timeout?: number) => (
        { async: false; value: "ok" | "not-equal" | "timed-out" }
        | { async: true; value: Promise<"ok" | "timed-out"> }
      );
    }).waitAsync;
    if (typeof waitAsync === "function") {
      const result = waitAsync(lock, OWNER_INDEX, observedOwner, 100);
      if (result.async) {
        await result.value;
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

export function releaseSqliteWriteMutex(): void {
  if (tls.holds <= 0) return;
  tls.holds -= 1;
  if (tls.holds > 0) return;
  tls.context = null;
  const lock = mutexView();
  releaseMutexOwner(lock, currentOwnerToken());
}

/** Release a lock owned by a worker that has physically exited. */
export function forceReleaseSqliteWriteMutexOwner(ownerToken: number): boolean {
  if (!Number.isInteger(ownerToken) || ownerToken <= 0) return false;
  const lock = mutexView();
  // A worker can exit after marking itself as releasing. Only its supervisor,
  // after physical exit, may finish that interrupted release.
  const released = releaseMutexOwner(lock, ownerToken, true);
  let removed = false;
  for (let index = 0; index < QUEUE_CAPACITY; index++) {
    const slot = QUEUE_START + index * SLOT_CELLS;
    if (Atomics.load(lock, slot) === ownerToken) {
      abandonWrite(lock, { slot, waitingSince: 0 });
      removed = true;
    }
  }
  return released || removed;
}

/**
 * Run a synchronous SQLite write with the process mutex held.
 *
 * Workers block until they own the mutex (Lidarr command threads). The HTTP
 * thread never blocks: its callers must await the asynchronous write gate.
 */
export function withSqliteWriteMutexSync<T>(work: () => T, label = "synchronous write"): T {
  const nested = holdsSqliteWriteMutex();
  if (!nested) {
    if (isMainThread) {
      if (!tryAcquireSqliteWriteMutex(label)) throw busyError();
    } else {
      acquireSqliteWriteMutexSync(15_000, label);
    }
  }
  try {
    return work();
  } finally {
    if (!nested) {
      releaseSqliteWriteMutex();
    }
  }
}

/** Async HTTP/scheduler writes: wait without freezing the event loop. */
export async function withSqliteWriteMutexAsync<T>(work: () => T | Promise<T>, label = "asynchronous write"): Promise<T> {
  if (holdsSqliteWriteMutex()) return work();
  const context = Symbol(label);
  await acquireSqliteWriteMutexAsync(label, context);
  try {
    const result = writeContext.run(context, work);
    // Release synchronous work before yielding. Keeping an empty write section
    // locked for another microtask can collide with an unrelated worker callback.
    return result instanceof Promise ? await result : result;
  } finally {
    releaseSqliteWriteMutex();
  }
}
