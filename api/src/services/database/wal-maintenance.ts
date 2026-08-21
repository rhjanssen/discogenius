/**
 * Main-thread supervisor for the WAL maintenance thread.
 *
 * Owns the worker's lifecycle, relays its write-gate requests to the
 * process-global lock (which lives on this thread), and keeps the last few
 * checkpoint attempts so `/health` can answer whether forcing a checkpoint
 * window actually reclaims the file under load. See `wal-maintenance-worker.ts`
 * for why the checkpoint cannot run here.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { DB_PATH } from "../config/bootstrap.js";
import { sqliteWriteMutexWorkerData } from "../../database/sqlite-write-mutex.js";
import {
  ownerAcquire,
  ownerRelease,
  ownerReleaseAllFor,
} from "../commands/worker/sqlite-write-lock.js";
import type { WalMaintenanceAttempt, WalWorkerToMain } from "./wal-maintenance-worker.js";

/** Keep the tail, not the history: enough to see a trend, bounded in memory. */
const ATTEMPT_HISTORY = 10;

const recentAttempts: WalMaintenanceAttempt[] = [];
let worker: Worker | null = null;
let ownerId = "";

function readIntEnv(name: string, fallback: number, min: number): number {
  const raw = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

function resolveSpawn(): { entry: string; workerData: Record<string, unknown> } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const isCompiled = here.includes(`${path.sep}dist${path.sep}`) || here.endsWith(`${path.sep}dist`);
  const walMaintenance = {
    dbPath: DB_PATH,
    intervalMs: readIntEnv("DISCOGENIUS_WAL_MAINTENANCE_INTERVAL_MS", 10_000, 1_000),
    // Above 256 MB a WAL is already costing every reader real CPU per lookup,
    // and well short of the multi-gigabyte territory that made the library
    // unusable. Below it, letting the log breathe is cheaper than forcing
    // windows that interrupt writers.
    highWaterBytes: readIntEnv("DISCOGENIUS_WAL_HIGH_WATER_BYTES", 256 * 1024 * 1024, 16 * 1024 * 1024),
    checkpointTimeoutMs: readIntEnv("DISCOGENIUS_WAL_CHECKPOINT_TIMEOUT_MS", 2_000, 100),
  };

  if (isCompiled) {
    return { entry: path.join(here, "wal-maintenance-worker.js"), workerData: { walMaintenance, ...sqliteWriteMutexWorkerData() } };
  }
  // Under tsx the loader is not propagated into worker threads; reuse the
  // command pool's bootstrap, which registers it before importing the entry.
  return {
    entry: path.join(here, "..", "commands", "worker", "command-worker-bootstrap.mjs"),
    workerData: {
      walMaintenance,
      ...sqliteWriteMutexWorkerData(),
      __entry: pathToFileURL(path.join(here, "wal-maintenance-worker.ts")).href,
    },
  };
}

export function startWalMaintenance(): void {
  if (worker) return;
  if (process.env.DISCOGENIUS_WAL_MAINTENANCE === "0") {
    console.log("🗒️  WAL maintenance thread disabled by configuration");
    return;
  }

  const { entry, workerData } = resolveSpawn();
  ownerId = `wal-maintenance:${process.pid}`;
  const spawned = new Worker(entry, { workerData });
  worker = spawned;

  spawned.on("message", (message: WalWorkerToMain) => {
    switch (message?.kind) {
      case "writeLockAcquire":
        ownerAcquire(message.requestId, ownerId, () => {
          spawned.postMessage({ kind: "writeLockGranted", requestId: message.requestId });
        }, message.label);
        break;
      case "writeLockRelease":
        ownerRelease(message.requestId);
        break;
      case "walAttempt":
        recentAttempts.push(message.attempt);
        if (recentAttempts.length > ATTEMPT_HISTORY) recentAttempts.shift();
        {
          const { walBytesBefore, walBytesAfter, busy, tookMs, waitedForGateMs } = message.attempt;
          const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)}MB`;
          console.warn(
            `[WalMaintenance] forced checkpoint ${mb(walBytesBefore)} -> ${mb(walBytesAfter)}`
            + ` busy=${busy} took=${tookMs}ms gateWait=${waitedForGateMs}ms`,
          );
        }
        break;
      default:
        break;
    }
  });

  const handleExit = (reason: string) => {
    // Never leave the gate held by a thread that no longer exists — one crash
    // here would otherwise stop every writer in the process.
    ownerReleaseAllFor(ownerId);
    if (worker === spawned) worker = null;
    console.warn(`[WalMaintenance] thread stopped (${reason})`);
  };
  spawned.on("error", (error) => handleExit(String(error?.message || error)));
  spawned.on("exit", (code) => handleExit(`exit code ${code}`));
  spawned.unref();
}

export async function stopWalMaintenance(): Promise<void> {
  const spawned = worker;
  if (!spawned) return;
  worker = null;
  try {
    spawned.postMessage({ kind: "shutdown" });
    await spawned.terminate();
  } catch {
    // best-effort shutdown
  }
  ownerReleaseAllFor(ownerId);
}

export function walMaintenanceDiagnostics(): {
  running: boolean;
  attempts: number;
  lastAttempt: WalMaintenanceAttempt | null;
  /** Bytes reclaimed across the retained window — 0 means forcing isn't working. */
  reclaimedBytes: number;
} {
  const reclaimedBytes = recentAttempts.reduce(
    (total, attempt) => total + Math.max(0, attempt.walBytesBefore - attempt.walBytesAfter),
    0,
  );
  return {
    running: worker != null,
    attempts: recentAttempts.length,
    lastAttempt: recentAttempts.length > 0 ? recentAttempts[recentAttempts.length - 1] : null,
    reclaimedBytes,
  };
}
