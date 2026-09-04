/**
 * Process-wide SQLite writer mutex.
 *
 * Lidarr runs three command threads against one SQLite file with
 * `BusyTimeout = 1000` and no per-route retry loops. That works because those
 * threads *block* on the lock and ASP.NET still serves other requests from the
 * thread pool. Discogenius cannot copy the blocking part on the HTTP event loop,
 * but it can copy the important half: **one writer at a time, at the app
 * layer**, so SQLite almost never sees overlapping connections.
 *
 * Command / download / WAL workers take the mutex synchronously (`Atomics.wait`).
 * Async HTTP/scheduler writes take it with `Atomics.waitAsync` so the event loop
 * stays free. Re-entrant: a transaction that already holds the mutex does not
 * wait on itself.
 */
import { isMainThread, workerData } from "node:worker_threads";

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
const MUTEX_BYTE_LENGTH = 9 * Int32Array.BYTES_PER_ELEMENT;

type MutexTls = { holds: number };

const tls: MutexTls = { holds: 0 };

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
  return tls.holds > 0;
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
    atomicMax(view, MAX_HOLD_MS_INDEX, Math.max(0, Date.now() - acquiredAt * 1000));
  }
}

function releaseMutexOwner(view: Int32Array, ownerToken: number): boolean {
  // Mark the owner as releasing before clearing its timestamp. A direct
  // owner-to-zero CAS lets a waiting worker acquire between those operations
  // and the old owner then wipes the new owner's start time.
  if (Atomics.compareExchange(view, OWNER_INDEX, ownerToken, -ownerToken) !== ownerToken) {
    return false;
  }
  recordMutexReleased(view);
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
} {
  const view = mutexView();
  const rawOwnerToken = Atomics.load(view, OWNER_INDEX);
  const ownerToken = Math.abs(rawOwnerToken);
  const acquiredAt = Atomics.load(view, ACQUIRED_AT_SECONDS_INDEX);
  const grants = Math.max(0, Atomics.load(view, GRANTS_INDEX));
  const totalWaitMs = Math.max(0, Atomics.load(view, TOTAL_WAIT_MS_INDEX));
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
  };
}

export function tryAcquireSqliteWriteMutex(): boolean {
  if (tls.holds > 0) {
    tls.holds += 1;
    return true;
  }
  const view = mutexView();
  if (Atomics.compareExchange(view, OWNER_INDEX, 0, currentOwnerToken()) === 0) {
    tls.holds = 1;
    recordMutexAcquired(view, null);
    return true;
  }
  return false;
}

export function acquireSqliteWriteMutexSync(timeoutMs: number = 15_000): void {
  if (tls.holds > 0) {
    tls.holds += 1;
    return;
  }
  const lock = mutexView();
  const ownerToken = currentOwnerToken();
  const deadline = timeoutMs == null ? null : Date.now() + Math.max(0, timeoutMs);
  let waitingSince: number | null = null;
  while (Atomics.compareExchange(lock, OWNER_INDEX, 0, ownerToken) !== 0) {
    if (waitingSince == null) waitingSince = beginMutexWait(lock);
    const remaining = deadline == null ? Infinity : deadline - Date.now();
    if (remaining <= 0) {
      Atomics.sub(lock, WAITING_WRITERS_INDEX, 1);
      const error = new Error("database is locked");
      (error as { code?: string }).code = "SQLITE_BUSY";
      throw error;
    }
    const waitMs = Number.isFinite(remaining) ? Math.min(remaining, 1_000_000) : undefined;
    const observedOwner = Atomics.load(lock, OWNER_INDEX);
    if (observedOwner !== 0) Atomics.wait(lock, OWNER_INDEX, observedOwner, waitMs);
  }
  tls.holds = 1;
  recordMutexAcquired(lock, waitingSince);
}

export async function acquireSqliteWriteMutexAsync(): Promise<void> {
  // Do not re-enter across an `await`. Two concurrent async writers on the
  // same thread (HTTP + timer, or two route handlers) must take turns, which
  // is what Lidarr's one-writer model does. Nested *sync* `.run` still
  // re-enters via `acquireSqliteWriteMutexSync`.
  const lock = mutexView();
  const ownerToken = currentOwnerToken();
  let waitingSince: number | null = null;
  while (Atomics.compareExchange(lock, OWNER_INDEX, 0, ownerToken) !== 0) {
    if (waitingSince == null) waitingSince = beginMutexWait(lock);
    const waitAsync = (Atomics as typeof Atomics & {
      waitAsync?: (typedArray: Int32Array, index: number, value: number) => (
        { async: false; value: "ok" | "not-equal" | "timed-out" }
        | { async: true; value: Promise<"ok" | "timed-out"> }
      );
    }).waitAsync;
    if (typeof waitAsync === "function") {
      const observedOwner = Atomics.load(lock, OWNER_INDEX);
      if (observedOwner === 0) continue;
      const result = waitAsync(lock, OWNER_INDEX, observedOwner);
      if (result.async) {
        await result.value;
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  tls.holds = 1;
  recordMutexAcquired(lock, waitingSince);
}

export function releaseSqliteWriteMutex(): void {
  if (tls.holds <= 0) return;
  tls.holds -= 1;
  if (tls.holds > 0) return;
  const lock = mutexView();
  releaseMutexOwner(lock, currentOwnerToken());
}

/** Release a lock owned by a worker that has physically exited. */
export function forceReleaseSqliteWriteMutexOwner(ownerToken: number): boolean {
  if (!Number.isInteger(ownerToken) || ownerToken <= 0) return false;
  const lock = mutexView();
  return releaseMutexOwner(lock, ownerToken);
}

/**
 * Run a synchronous SQLite write with the process mutex held.
 *
 * Workers block until they own the mutex (Lidarr command threads). The HTTP
 * thread tries a non-blocking acquire first; if another writer holds it, it
 * waits up to Lidarr's 1s BusyTimeout rather than overlapping connections.
 */
export function withSqliteWriteMutexSync<T>(work: () => T): T {
  const nested = holdsSqliteWriteMutex();
  if (!nested) {
    if (isMainThread) {
      if (!tryAcquireSqliteWriteMutex()) {
        acquireSqliteWriteMutexSync(15_000);
      }
    } else {
      acquireSqliteWriteMutexSync();
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
export async function withSqliteWriteMutexAsync<T>(work: () => T | Promise<T>): Promise<T> {
  await acquireSqliteWriteMutexAsync();
  try {
    return await work();
  } finally {
    releaseSqliteWriteMutex();
  }
}
