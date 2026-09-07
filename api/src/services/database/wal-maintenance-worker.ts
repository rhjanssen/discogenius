/**
 * Checkpoint large WAL files on a dedicated thread. A bounded TRUNCATE wait
 * can find a reader gap without blocking HTTP. Writer admission prevents new
 * application writes during the attempt; readers may still make it time out.
 * Report the outcome and WAL sizes so operators can verify reclamation.
 */
import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import {
  withSqliteWriteMutexAsync,
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

export type WalWorkerToMain = { kind: "walAttempt"; attempt: WalMaintenanceAttempt };

export type MainToWalWorker =
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
  return withSqliteWriteMutexAsync(() => {
    const waitedMs = Date.now() - queuedAt;
    return { value: work(), waitedMs };
  }, _label);
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
