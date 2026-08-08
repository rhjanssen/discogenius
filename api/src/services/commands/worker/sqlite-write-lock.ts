/**
 * The process-global SQLite write lock.
 *
 * `withSqliteWriteGate` used to be a module-scope promise tail in
 * `database.ts`. Command workers are real `worker_threads` Workers, and each
 * thread loads its own copy of every module — so each got its *own* gate. Two
 * RefreshArtist workers and a MatchArtistProviders worker could all believe
 * they held it and then contend for SQLite's single writer lock, which is what
 * produced the `SQLITE_BUSY` claims, the skipped scheduled-task syncs and the
 * expired MatchArtistProviders leases in the 500-artist run.
 *
 * The lock is now owned by the main thread and requested over the existing
 * worker bridge. That is the smallest design that is actually process-global:
 * a worker-local mutex cannot be made correct, and routing every write through
 * a writer actor would mean rewriting every call site.
 *
 * Two properties matter beyond correctness:
 *
 *  - **Waiting is asynchronous.** A worker awaits a message rather than
 *    blocking, so it keeps its event loop free and its lease heartbeat alive
 *    while another command writes.
 *  - **A dying holder does not deadlock the process.** The owner releases every
 *    lock held by a worker when that worker exits; otherwise one crash would
 *    stop all writing forever.
 */
import { randomUUID } from "node:crypto";
import { parentPort } from "node:worker_threads";
import { isCommandWorker } from "./command-worker-protocol.js";

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
  return {
    held: heldBy != null,
    heldByOwner: heldBy?.ownerId ?? null,
    heldByLabel: heldBy?.label ?? null,
    heldForMs: heldBy ? Date.now() - heldBy.since : 0,
    longestHoldMs: longestHold.heldMs,
    longestHoldLabel: longestHold.label || null,
    waitingLabels: waiters.map((waiter) => waiter.label),
    queueDepth: waiters.length,
    grants: stats.grants,
    averageWaitMs: stats.grants === 0 ? 0 : Math.round(stats.totalWaitMs / stats.grants),
    maxWaitMs: stats.maxWaitMs,
    maxQueueDepth: stats.maxQueueDepth,
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

/* ── Client side: whichever thread is asking ────────────────────────── */

const pendingGrants = new Map<string, () => void>();
let workerListenerAttached = false;

function attachWorkerListener(): void {
  if (workerListenerAttached || !parentPort) return;
  workerListenerAttached = true;
  parentPort.on("message", (message: { kind?: string; requestId?: string }) => {
    if (message?.kind !== "writeLockGranted" || !message.requestId) return;
    const grant = pendingGrants.get(message.requestId);
    if (!grant) return;
    pendingGrants.delete(message.requestId);
    grant();
  });
}

/**
 * Take the process-global write lock, run `work`, release it.
 *
 * On the main thread this is a direct queue entry. Inside a command worker it
 * is a round trip to the owner — asynchronous, so the worker stays responsive
 * and keeps heartbeating while it waits.
 */
export async function withGlobalSqliteWriteLock<T>(
  work: () => T | Promise<T>,
  onStats?: (stats: WriteLockWaitStats) => void,
  label = "unlabelled",
): Promise<T> {
  const requestId = randomUUID();
  const queuedAt = Date.now();
  let queueDepthAtGrant = 0;

  if (isCommandWorker() && parentPort) {
    attachWorkerListener();
    await new Promise<void>((resolve) => {
      pendingGrants.set(requestId, resolve);
      parentPort!.postMessage({ kind: "writeLockAcquire", requestId, label });
    });
  } else {
    await new Promise<void>((resolve) => {
      queueDepthAtGrant = waiters.length;
      ownerAcquire(requestId, "main", resolve, label);
    });
  }

  const grantedAt = Date.now();
  try {
    return await work();
  } finally {
    if (isCommandWorker() && parentPort) {
      pendingGrants.delete(requestId);
      parentPort.postMessage({ kind: "writeLockRelease", requestId });
    } else {
      ownerRelease(requestId);
    }
    onStats?.({
      waitedMs: grantedAt - queuedAt,
      heldMs: Date.now() - grantedAt,
      queueDepth: queueDepthAtGrant,
    });
  }
}
