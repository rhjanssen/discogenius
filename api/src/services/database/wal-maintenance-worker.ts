/**
 * WAL maintenance: the deliberate escape from an unbounded write-ahead log.
 *
 * Measured on the release candidate: under sustained multi-worker ingest the
 * `.db-wal` grew 1.13 → 1.46 → 1.75 GB in about a minute against a 2 GB main
 * database, then fell back to its 64 MB `journal_size_limit` once the load
 * subsided — with no restart in between. So checkpoints were *not* starved:
 * PASSIVE returned `busy=0 lag=0` throughout. The WAL simply cannot **wrap**
 * (reuse its file space) until a checkpoint completes at a moment when no
 * reader still needs the old snapshot, and with three command workers plus the
 * main thread reading essentially continuously, that moment never arrives
 * during a burst. So the log appends monotonically, and every reader then pays
 * to search a multi-gigabyte WAL index — which is what made ordinary curation
 * look catastrophic.
 *
 * The existing main-thread tick escalates to `wal_checkpoint(TRUNCATE)` with
 * `busy_timeout = 0`. That can only ever succeed by luck: it bails on the first
 * conflicting reader rather than waiting for a gap. Raising its timeout is not
 * an option, because a blocking checkpoint on the Node HTTP thread stalls every
 * request and SSE stream in the process.
 *
 * Hence a thread of its own. It holds its own connection, and when the WAL
 * crosses a high-water mark it takes the process-global write gate (so no new
 * frames are appended while it works) and gives TRUNCATE a **finite** wait to
 * find a reader gap. Blocking there blocks only this thread. Every attempt is
 * reported back for `/health`, because the honest question — does forcing the
 * window actually reclaim the file under real load? — is measurable, and this
 * is the thing that measures it.
 */
import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import {
  acquireSqliteWriteMutexAsync,
  releaseSqliteWriteMutex,
} from "../../database/sqlite-write-mutex.js";

export interface WalMaintenanceAttempt {
  at: string;
  /** WAL size before the attempt, bytes. */
  walBytesBefore: number;
  walBytesAfter: number;
  /** `busy` from the checkpoint pragma: 1 means it gave up waiting. */
  busy: number;
  /** Frames in the WAL, and how many were copied back. */
  log: number;
  checkpointed: number;
  /** Wall time of the checkpoint itself, excluding the gate wait. */
  tookMs: number;
  waitedForGateMs: number;
  mode: "TRUNCATE" | "PASSIVE";
  error?: string;
}

export type WalWorkerToMain =
  | { kind: "walAttempt"; attempt: WalMaintenanceAttempt }
  | { kind: "writeLockAcquire"; requestId: string; label?: string }
  | { kind: "writeLockRelease"; requestId: string };

export type MainToWalWorker =
  | { kind: "writeLockGranted"; requestId: string }
  | { kind: "shutdown" };

interface WalMaintenanceConfig {
  dbPath: string;
  /** How often to look at the WAL. */
  intervalMs: number;
  /** Force a checkpoint window once the WAL exceeds this many bytes. */
  highWaterBytes: number;
  /** How long TRUNCATE may block THIS thread hunting for a reader gap. */
  checkpointTimeoutMs: number;
}

const config = (workerData as { walMaintenance?: WalMaintenanceConfig } | null)?.walMaintenance;
if (!config || !parentPort) {
  throw new Error("wal-maintenance-worker spawned without configuration");
}
const port = parentPort;

const db = new Database(config.dbPath, { fileMustExist: true });
db.pragma("journal_mode = WAL");

let shuttingDown = false;

port.on("message", (message: MainToWalWorker) => {
  if (message?.kind === "shutdown") {
    shuttingDown = true;
  }
});

/**
 * Take the process writer mutex so checkpoint does not overlap command writes.
 * Waiting is async, so this thread stays responsive.
 */
async function withWriteGate<T>(_label: string, work: () => T): Promise<{ value: T; waitedMs: number }> {
  const queuedAt = Date.now();
  await acquireSqliteWriteMutexAsync();
  try {
    return { value: work(), waitedMs: Date.now() - queuedAt };
  } finally {
    releaseSqliteWriteMutex();
  }
}

function walBytes(): number {
  try {
    return fs.statSync(`${config!.dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(): Promise<void> {
  const before = walBytes();

  // Below the high-water mark the log is doing its job; a PASSIVE pass is
  // cheap, never blocks, and keeps frames moving back into the main database.
  if (before < config!.highWaterBytes) {
    try {
      db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      // Contended — the next tick will do it.
    }
    return;
  }

  // Past the mark, force the window the WAL never gets on its own.
  let outcome: WalMaintenanceAttempt;
  try {
    const { value, waitedMs } = await withWriteGate("wal:checkpoint", () => {
      const previousTimeout = db.pragma("busy_timeout", { simple: true });
      const startedAt = Date.now();
      try {
        // A *finite* wait, not zero: the readers this has to outlast are
        // individual auto-commit statements, so gaps do occur — they just
        // never coincide with the instant a zero-timeout attempt fires.
        db.pragma(`busy_timeout = ${config!.checkpointTimeoutMs}`);
        const rows = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
          busy?: number;
          log?: number;
          checkpointed?: number;
        }>;
        const row = rows?.[0] ?? {};
        return {
          busy: Number(row.busy ?? 0),
          log: Number(row.log ?? 0),
          checkpointed: Number(row.checkpointed ?? 0),
          tookMs: Date.now() - startedAt,
        };
      } finally {
        db.pragma(`busy_timeout = ${previousTimeout}`);
      }
    });
    outcome = {
      at: new Date().toISOString(),
      walBytesBefore: before,
      walBytesAfter: walBytes(),
      mode: "TRUNCATE",
      waitedForGateMs: waitedMs,
      ...value,
    };
  } catch (error: any) {
    outcome = {
      at: new Date().toISOString(),
      walBytesBefore: before,
      walBytesAfter: walBytes(),
      mode: "TRUNCATE",
      waitedForGateMs: 0,
      busy: 1,
      log: 0,
      checkpointed: 0,
      tookMs: 0,
      error: String(error?.message || error),
    };
  }

  port.postMessage({ kind: "walAttempt", attempt: outcome } satisfies WalWorkerToMain);
}

async function loop(): Promise<void> {
  while (!shuttingDown) {
    try {
      await tick();
    } catch (error) {
      console.warn("[WalMaintenance] checkpoint tick failed:", error);
    }
    await sleep(config!.intervalMs);
  }
  try {
    db.close();
  } catch {
    // Shutting down anyway.
  }
}

void loop();
