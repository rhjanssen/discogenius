/**
 * Cross-thread single-writer mutex for SQLite.
 *
 * SQLite allows only one writer at a time, and running multiple writer threads
 * (the command worker pool + the main thread) does NOT increase write throughput
 * — writes serialise on SQLite's write lock regardless. What concurrent writers
 * *do* produce is contention: under refresh load the workers race for the lock,
 * SQLite hands it out unfairly, and a low-frequency writer (a user action on the
 * main thread, or a peer worker) gets starved into `database is locked`.
 *
 * This mutex makes writes fair at the application level: a writer acquires the
 * mutex before opening its write transaction and releases it after commit, so
 * only one writer ever contends for SQLite's lock at a time. Workers acquire
 * synchronously (`Atomics.wait`) — they run off the event loop, so blocking is
 * fine. The main thread acquires with `Atomics.waitAsync`, which yields a promise
 * instead of freezing the event loop, and takes priority (workers yield to a
 * waiting main writer) so a user action is never starved by the worker pool.
 *
 * The lock state lives in a SharedArrayBuffer created on the main thread and
 * passed to each worker via `workerData`. When no buffer is installed (unit tests,
 * single-connection contexts) every call is a no-op.
 *
 * SAFETY: acquisition is bounded. If a writer can't acquire within its timeout it
 * logs and *degrades* — it proceeds without the mutex and lets SQLite's own
 * busy_timeout + retry serialise the write (the pre-mutex behaviour). So any
 * residual bug in this hand-rolled lock can only ever cause a graceful slowdown,
 * never a permanent deadlock.
 *
 * Reentrancy: only the synchronous (worker) path is reentrant — a write
 * transaction acquires once and the statements it runs must not deadlock
 * re-acquiring (safe with a plain counter because a worker is a single sync flow).
 * The async (main) path is strictly non-reentrant: `withWriteAsync` is its sole
 * acquirer (the db proxy never auto-acquires on main) and its callback is
 * synchronous, so main write sections never nest.
 */

// Shared lock state: [LOCK] 0=free/1=held, [MAIN_WAITING] count of main writers waiting.
const LOCK = 0;
const MAIN_WAITING = 1;
const FREE = 0;
const HELD = 1;

// Acquisition timeouts before degrading to unserialised (SQLite-backstopped) writes.
const WORKER_MAX_WAIT_MS = 60_000; // workers are off the event loop; they can wait
const MAIN_MAX_WAIT_MS = 20_000;   // bound a user request's wait
const WAIT_SLICE_MS = 1_000;       // re-check the lock at least this often

// `Atomics.waitAsync` (Node 16+) isn't in this project's TS lib target yet, so
// type it locally rather than bumping the lib for the whole codebase.
type AtomicsWaitAsync = (
  typedArray: Int32Array,
  index: number,
  value: number,
) => { async: false; value: "not-equal" | "timed-out" } | { async: true; value: Promise<"ok" | "timed-out"> };
const atomicsWaitAsync = (Atomics as unknown as { waitAsync: AtomicsWaitAsync }).waitAsync;

let lockArray: Int32Array | null = null;
let syncDepth = 0; // worker-only reentrancy depth (per-thread module instance)
let degradeWarned = false;

function warnDegrade(where: string): void {
  if (!degradeWarned) {
    degradeWarned = true;
    console.warn(`[write-lock] ${where} acquire timed out; proceeding unserialised (SQLite busy_timeout backstop). Further warnings suppressed.`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWriteLockBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(8);
}

export function installWriteLockBuffer(buffer: SharedArrayBuffer | null | undefined): void {
  if (buffer) {
    lockArray = new Int32Array(buffer);
  }
}

export function isWriteLockInstalled(): boolean {
  return lockArray !== null;
}

let mainBuffer: SharedArrayBuffer | null = null;

/**
 * Get (creating once) the shared lock buffer. Call on the main thread to obtain
 * the buffer to hand to workers via workerData; also installs it for the main
 * thread so its async writes participate in the same mutex.
 */
export function getSharedWriteLockBuffer(): SharedArrayBuffer {
  if (!mainBuffer) {
    mainBuffer = createWriteLockBuffer();
    installWriteLockBuffer(mainBuffer);
  }
  return mainBuffer;
}

/** Worker acquire (sync, reentrant, yields to a waiting main writer). Returns whether the mutex is held. */
function acquireWriteSync(): boolean {
  if (!lockArray) return false;
  if (syncDepth > 0) { syncDepth += 1; return true; }
  const deadline = Date.now() + WORKER_MAX_WAIT_MS;
  for (;;) {
    // Yield to any waiting main-thread writer (priority).
    let mainWaiting = Atomics.load(lockArray, MAIN_WAITING);
    while (mainWaiting > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { warnDegrade("worker"); return false; }
      Atomics.wait(lockArray, MAIN_WAITING, mainWaiting, Math.min(remaining, WAIT_SLICE_MS));
      mainWaiting = Atomics.load(lockArray, MAIN_WAITING);
    }
    if (Atomics.compareExchange(lockArray, LOCK, FREE, HELD) === FREE) {
      // A main writer may have started waiting between our check and the CAS —
      // hand it the lock rather than holding for a chunk.
      if (Atomics.load(lockArray, MAIN_WAITING) > 0) {
        Atomics.store(lockArray, LOCK, FREE);
        Atomics.notify(lockArray, LOCK); // wake all waiters so the main writer can win
        continue;
      }
      syncDepth = 1;
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { warnDegrade("worker"); return false; }
    Atomics.wait(lockArray, LOCK, HELD, Math.min(remaining, WAIT_SLICE_MS));
  }
}

function releaseWriteSync(held: boolean): void {
  if (!lockArray || !held) return;
  if (syncDepth > 1) { syncDepth -= 1; return; }
  syncDepth = 0;
  Atomics.store(lockArray, LOCK, FREE);
  Atomics.notify(lockArray, LOCK);
}

/** Main acquire (async, non-reentrant, priority over workers). Returns whether the mutex is held. */
async function acquireWriteAsync(): Promise<boolean> {
  if (!lockArray) return false;
  Atomics.add(lockArray, MAIN_WAITING, 1); // signal workers to yield
  try {
    const deadline = Date.now() + MAIN_MAX_WAIT_MS;
    for (;;) {
      if (Atomics.compareExchange(lockArray, LOCK, FREE, HELD) === FREE) {
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { warnDegrade("main"); return false; }
      const result = atomicsWaitAsync(lockArray, LOCK, HELD);
      if (result.async) {
        // Race the wakeup against a timeout slice so a missed notify can't hang us.
        await Promise.race([result.value, delay(Math.min(remaining, WAIT_SLICE_MS))]);
      }
    }
  } finally {
    // No longer waiting (we either hold the lock or degraded). Wake workers if we
    // were the last main writer queued.
    if (Atomics.sub(lockArray, MAIN_WAITING, 1) === 1) {
      Atomics.notify(lockArray, MAIN_WAITING);
    }
  }
}

function releaseWriteAsync(held: boolean): void {
  if (!lockArray || !held) return;
  Atomics.store(lockArray, LOCK, FREE);
  Atomics.notify(lockArray, LOCK);
}

/** Run a synchronous write section holding the mutex (worker path). */
export function withWriteSync<T>(fn: () => T): T {
  const held = acquireWriteSync();
  try {
    return fn();
  } finally {
    releaseWriteSync(held);
  }
}

/** Run a synchronous write section, acquiring the mutex without freezing the event loop (main path). */
export async function withWriteAsync<T>(fn: () => T): Promise<T> {
  const held = await acquireWriteAsync();
  try {
    return fn();
  } finally {
    releaseWriteAsync(held);
  }
}
