/**
 * SQLite write-lock diagnostics and the labeled `withGlobalSqliteWriteLock`
 * helper.
 *
 * Exclusion itself is the SharedArrayBuffer mutex in `sqlite-write-mutex.ts`
 * (Lidarr-shaped: one writer for the process). This module keeps the owner
 * queue for WAL-maintenance message relay and for tests that inspect fairness
 * / crash recovery. Command workers no longer ask for the lock over postMessage;
 * `db.prepare().run()` takes the mutex directly.
 */
import {
  acquireSqliteWriteMutexAsync,
  releaseSqliteWriteMutex,
  sqliteWriteMutexDiagnostics,
} from "../../../database/sqlite-write-mutex.js";

export interface WriteLockWaitStats {
  /** Milliseconds spent waiting for the lock, before the work ran. */
  waitedMs: number;
  /** Milliseconds the work itself held the lock. */
  heldMs: number;
  /** Requests queued behind this one at the moment it was granted. */
  queueDepth: number;
}

type Waiter = {
  requestId: string;
  ownerId: string;
  /** Which write section asked. Diagnostics name this, not the worker id. */
  label: string;
  grant: () => void;
  queuedAt: number;
};

/* ── Owner side: the main thread ────────────────────────────────────── */

const waiters: Waiter[] = [];
let heldBy: { requestId: string; ownerId: string; label: string; since: number } | null = null;

/** Cumulative contention, surfaced by runtime diagnostics. */
const stats = { grants: 0, totalWaitMs: 0, maxWaitMs: 0, maxQueueDepth: 0 };

/**
 * The longest single hold seen, and which section held it.
 *
 * A worker id answers "who is stuck" but not "doing what", and three rounds of
 * narrowing gate scope by reading stack traces after the fact is two rounds too
 * many. Every acquisition carries a label so one reading names the call site.
 */
const longestHold = { label: "", ownerId: "", heldMs: 0 };

function pump(): void {
  if (heldBy || waiters.length === 0) return;
  const next = waiters.shift()!;
  heldBy = { requestId: next.requestId, ownerId: next.ownerId, label: next.label, since: Date.now() };
  const waited = Date.now() - next.queuedAt;
  stats.grants += 1;
  stats.totalWaitMs += waited;
  stats.maxWaitMs = Math.max(stats.maxWaitMs, waited);
  next.grant();
}

/**
 * Queue a request on the owner. `grant` is invoked when the lock is theirs.
 *
 * `ownerId` identifies the requesting worker (or `"main"`) so the lock can be
 * reclaimed if that worker dies holding it.
 */
export function ownerAcquire(
  requestId: string,
  ownerId: string,
  grant: () => void,
  label = "unlabelled",
): void {
  waiters.push({ requestId, ownerId, label, grant, queuedAt: Date.now() });
  // Measured at enqueue: how many writers wanted the lock at once. Measuring at
  // grant time instead reports 1 forever, because the queue has already been
  // drained by one by then.
  stats.maxQueueDepth = Math.max(stats.maxQueueDepth, waiters.length + (heldBy ? 1 : 0));
  pump();
}

export function ownerRelease(requestId: string): void {
  if (heldBy?.requestId === requestId) {
    const heldMs = Date.now() - heldBy.since;
    // `>=` so a sub-millisecond hold still names a section: reporting null
    // because nothing yet exceeded zero is worse than naming the last holder.
    if (heldMs >= longestHold.heldMs) {
      longestHold.heldMs = heldMs;
      longestHold.label = heldBy.label;
      longestHold.ownerId = heldBy.ownerId;
    }
    heldBy = null;
    pump();
    return;
  }
  // A release for something never granted: drop it from the queue instead, so
  // an abandoned request cannot wedge the line.
  const index = waiters.findIndex((waiter) => waiter.requestId === requestId);
  if (index >= 0) waiters.splice(index, 1);
}

/**
 * Reclaim everything a worker held or was waiting for. Called when a worker
 * exits or errors — without this, one crash while holding the lock stops the
 * whole process writing.
 */
export function ownerReleaseAllFor(ownerId: string): void {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    if (waiters[index].ownerId === ownerId) waiters.splice(index, 1);
  }
  if (heldBy?.ownerId === ownerId) {
    heldBy = null;
    pump();
  }
}

export function writeLockDiagnostics(): {
  held: boolean;
  heldByOwner: string | null;
  /** Which write section holds it right now. */
  heldByLabel: string | null;
  heldForMs: number;
  /** The longest single hold since boot, and the section responsible. */
  longestHoldMs: number;
  longestHoldLabel: string | null;
  /** Sections currently queued, so a stall names its victims too. */
  waitingLabels: string[];
  queueDepth: number;
  grants: number;
  averageWaitMs: number;
  maxWaitMs: number;
  maxQueueDepth: number;
} {
  const active = sqliteWriteMutexDiagnostics();
  const legacyLongestWins = longestHold.heldMs >= active.longestHoldMs;
  const combinedGrants = active.grants + stats.grants;
  const combinedWaitMs = active.averageWaitMs * active.grants + stats.totalWaitMs;
  return {
    held: active.held || heldBy != null,
    heldByOwner: active.held
      ? `mutex-owner-${active.ownerToken}`
      : heldBy?.ownerId ?? null,
    heldByLabel: active.held ? null : heldBy?.label ?? null,
    heldForMs: active.held ? active.heldForMs : heldBy ? Date.now() - heldBy.since : 0,
    longestHoldMs: Math.max(active.longestHoldMs, longestHold.heldMs),
    longestHoldLabel: legacyLongestWins ? longestHold.label || null : null,
    waitingLabels: waiters.map((waiter) => waiter.label),
    queueDepth: active.queueDepth + waiters.length,
    grants: combinedGrants,
    averageWaitMs: combinedGrants === 0 ? 0 : Math.round(combinedWaitMs / combinedGrants),
    maxWaitMs: Math.max(active.maxWaitMs, stats.maxWaitMs),
    maxQueueDepth: Math.max(active.maxQueueDepth, stats.maxQueueDepth),
  };
}

/** Test seam: forget all state between cases. */
export function resetWriteLockForTests(): void {
  waiters.length = 0;
  heldBy = null;
  longestHold.heldMs = 0;
  longestHold.label = "";
  longestHold.ownerId = "";
  stats.grants = 0;
  stats.totalWaitMs = 0;
  stats.maxWaitMs = 0;
  stats.maxQueueDepth = 0;
}

/**
 * Take the process-wide writer mutex, run `work`, release it.
 *
 * The mutex lives in a SharedArrayBuffer shared with every worker thread, so
 * this is the Lidarr-shaped "one writer" — not a per-thread promise tail and
 * not a SQLITE_BUSY retry loop. Waiting is async (`waitAsync`) so the HTTP
 * event loop and worker heartbeats stay alive.
 */
export async function withGlobalSqliteWriteLock<T>(
  work: () => T | Promise<T>,
  onStats?: (stats: WriteLockWaitStats) => void,
  _label = "unlabelled",
): Promise<T> {
  const queuedAt = Date.now();
  await acquireSqliteWriteMutexAsync();
  const grantedAt = Date.now();
  try {
    return await work();
  } finally {
    releaseSqliteWriteMutex();
    onStats?.({
      waitedMs: grantedAt - queuedAt,
      heldMs: Date.now() - grantedAt,
      queueDepth: 0,
    });
  }
}
