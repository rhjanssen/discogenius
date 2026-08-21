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

const MUTEX_GLOBAL_KEY = "__discogeniusSqliteWriteMutexSab";

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
  if (existing instanceof SharedArrayBuffer) {
    return existing;
  }

  const fromWorker = readWorkerDataMutex();
  if (fromWorker) {
    globalState[MUTEX_GLOBAL_KEY] = fromWorker;
    return fromWorker;
  }

  const created = new SharedArrayBuffer(4);
  globalState[MUTEX_GLOBAL_KEY] = created;
  return created;
}

export function sqliteWriteMutexWorkerData(): Record<string, SharedArrayBuffer> {
  return { [SQLITE_WRITE_MUTEX_WORKER_DATA_KEY]: getOrCreateSqliteWriteMutexSab() };
}

function lockView(): Int32Array {
  return new Int32Array(getOrCreateSqliteWriteMutexSab());
}

export function holdsSqliteWriteMutex(): boolean {
  return tls.holds > 0;
}

/** True when any thread in this process currently holds the writer mutex. */
export function isSqliteWriteMutexHeld(): boolean {
  return Atomics.load(lockView(), 0) === 1;
}

export function tryAcquireSqliteWriteMutex(): boolean {
  if (tls.holds > 0) {
    tls.holds += 1;
    return true;
  }
  if (Atomics.compareExchange(lockView(), 0, 0, 1) === 0) {
    tls.holds = 1;
    return true;
  }
  return false;
}

export function acquireSqliteWriteMutexSync(timeoutMs?: number): void {
  if (tls.holds > 0) {
    tls.holds += 1;
    return;
  }
  const lock = lockView();
  const deadline = timeoutMs == null ? null : Date.now() + Math.max(0, timeoutMs);
  while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) {
    const remaining = deadline == null ? Infinity : deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error("database is locked");
      (error as { code?: string }).code = "SQLITE_BUSY";
      throw error;
    }
    const waitMs = Number.isFinite(remaining) ? Math.min(remaining, 1_000_000) : undefined;
    Atomics.wait(lock, 0, 1, waitMs);
  }
  tls.holds = 1;
}

export async function acquireSqliteWriteMutexAsync(): Promise<void> {
  // Do not re-enter across an `await`. Two concurrent async writers on the
  // same thread (HTTP + timer, or two route handlers) must take turns, which
  // is what Lidarr's one-writer model does. Nested *sync* `.run` still
  // re-enters via `acquireSqliteWriteMutexSync`.
  const lock = lockView();
  while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) {
    const waitAsync = (Atomics as typeof Atomics & {
      waitAsync?: (typedArray: Int32Array, index: number, value: number) => (
        { async: false; value: "ok" | "not-equal" | "timed-out" }
        | { async: true; value: Promise<"ok" | "timed-out"> }
      );
    }).waitAsync;
    if (typeof waitAsync === "function") {
      const result = waitAsync(lock, 0, 1);
      if (result.async) {
        await result.value;
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  tls.holds = 1;
}

export function releaseSqliteWriteMutex(): void {
  if (tls.holds <= 0) return;
  tls.holds -= 1;
  if (tls.holds > 0) return;
  const lock = lockView();
  Atomics.store(lock, 0, 0);
  Atomics.notify(lock, 0);
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
        acquireSqliteWriteMutexSync(1_000);
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
