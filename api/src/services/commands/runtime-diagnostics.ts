import { monitorEventLoopDelay } from "node:perf_hooks";
import { readIntEnv } from "../../utils/env.js";
import { NON_DOWNLOAD_COMMAND_NAMES } from "./command-names.js";
import { resolveCommandNoProgressTimeoutMs } from "./command-liveness-policy.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import { CommandWorkerPool } from "./worker/command-worker-pool.js";
import { writeLockDiagnostics } from "./worker/sqlite-write-lock.js";
import { walMaintenanceDiagnostics } from "../database/wal-maintenance.js";

interface SlowRequestSnapshot {
  method: string;
  path: string;
  durationMs: number;
  statusCode: number;
  finishedAt: string;
}

const slowRequestThresholdMs = readIntEnv("DISCOGENIUS_SLOW_REQUEST_MS", 1500, 100);
const eventLoopResolutionMs = readIntEnv("DISCOGENIUS_EVENT_LOOP_RESOLUTION_MS", 20, 5);
const requestLatencySampleSize = readIntEnv("DISCOGENIUS_REQUEST_LATENCY_SAMPLES", 4096, 100);
const eventLoopHistogram = monitorEventLoopDelay({ resolution: eventLoopResolutionMs });

let diagnosticsStarted = false;
let startedAt = Date.now();
let inFlightRequests = 0;
let inFlightStreamingRequests = 0;
let totalRequests = 0;
let totalStreamingRequests = 0;
let slowRequests = 0;
let lastSlowRequest: SlowRequestSnapshot | null = null;
const requestLatenciesMs = new Array<number>(requestLatencySampleSize);
let requestLatencySamples = 0;
let nextRequestLatencySample = 0;

function nanosecondsToMilliseconds(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Number((value / 1_000_000).toFixed(2));
}

function shouldTrackPath(path: string) {
  return path === "/health" || path.startsWith("/api") || path.startsWith("/app-auth");
}

function isStreamingLikePath(path: string) {
  return (
    path === "/api/v1/events" ||
    path === "/api/v1/queue/progress-stream" ||
    path === "/api/v1/artist/import-stream"
  );
}

function recordRequestLatency(durationMs: number) {
  requestLatenciesMs[nextRequestLatencySample] = durationMs;
  nextRequestLatencySample = (nextRequestLatencySample + 1) % requestLatencySampleSize;
  requestLatencySamples = Math.min(requestLatencySamples + 1, requestLatencySampleSize);
}

function requestLatencySnapshot() {
  if (requestLatencySamples === 0) {
    return {
      sampleCount: 0,
      capacity: requestLatencySampleSize,
      minMs: 0,
      meanMs: 0,
      maxMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    };
  }

  const sorted = requestLatenciesMs
    .slice(0, requestLatencySamples)
    .sort((left, right) => left - right);
  const percentile = (value: number) => {
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((value / 100) * sorted.length) - 1),
    );
    return sorted[index] ?? 0;
  };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const rounded = (value: number) => Number(value.toFixed(2));

  return {
    sampleCount: sorted.length,
    capacity: requestLatencySampleSize,
    minMs: rounded(sorted[0] ?? 0),
    meanMs: rounded(total / sorted.length),
    maxMs: rounded(sorted[sorted.length - 1] ?? 0),
    p50Ms: rounded(percentile(50)),
    p95Ms: rounded(percentile(95)),
    p99Ms: rounded(percentile(99)),
  };
}

export function startRuntimeDiagnostics() {
  if (diagnosticsStarted) {
    return;
  }

  diagnosticsStarted = true;
  startedAt = Date.now();
  eventLoopHistogram.enable();
}

export function trackRuntimeRequest(method: string, path: string) {
  const normalizedPath = path.split("?", 1)[0] || path;

  if (!shouldTrackPath(normalizedPath)) {
    return () => {};
  }

  const started = process.hrtime.bigint();
  const isStreamingRequest = isStreamingLikePath(normalizedPath);

  if (isStreamingRequest) {
    inFlightStreamingRequests += 1;
  } else {
    inFlightRequests += 1;
  }

  let completed = false;

  return (statusCode: number) => {
    if (completed) {
      return;
    }

    completed = true;
    if (isStreamingRequest) {
      inFlightStreamingRequests = Math.max(0, inFlightStreamingRequests - 1);
      totalStreamingRequests += 1;
    } else {
      inFlightRequests = Math.max(0, inFlightRequests - 1);
      totalRequests += 1;
    }

    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (!isStreamingRequest) {
      recordRequestLatency(durationMs);
    }
    if (isStreamingRequest || durationMs < slowRequestThresholdMs) {
      return;
    }

    slowRequests += 1;
    lastSlowRequest = {
      method,
      path: normalizedPath,
      durationMs: Number(durationMs.toFixed(2)),
      statusCode,
      finishedAt: new Date().toISOString(),
    };

    console.warn(
      `[PERF] Slow request ${method} ${normalizedPath} took ${lastSlowRequest.durationMs}ms (status ${statusCode})`,
    );
  };
}

export function getRuntimeDiagnosticsSnapshot() {
  let commandRuntime: {
    leases: ReturnType<typeof CommandQueueManager.getLeaseMetrics>;
    workerPool: ReturnType<typeof CommandWorkerPool.getSnapshot>;
    /**
     * Contention on the process-global SQLite write lock. Sustained queue depth
     * or a large `maxWaitMs` is the signal that a write phase is too long — the
     * shape that used to surface only as SQLITE_BUSY and expired leases.
     */
    sqliteWriteLock: ReturnType<typeof writeLockDiagnostics>;
    /**
     * Whether forcing a checkpoint window actually reclaims the WAL. A run of
     * attempts with `busy=1` and `reclaimedBytes` near zero means the log is
     * still growing unbounded and the readers were never out of the way.
     */
    walMaintenance: ReturnType<typeof walMaintenanceDiagnostics>;
  } | null = null;
  try {
    const noProgressOverrideMs = readIntEnv("DISCOGENIUS_COMMAND_NO_PROGRESS_MS", 0, 0);
    commandRuntime = {
      leases: CommandQueueManager.getLeaseMetrics({
        types: NON_DOWNLOAD_COMMAND_NAMES,
        noProgressMs: noProgressOverrideMs > 0 ? noProgressOverrideMs : undefined,
        resolveNoProgressMs: resolveCommandNoProgressTimeoutMs,
      }),
      workerPool: CommandWorkerPool.getSnapshot(),
      sqliteWriteLock: writeLockDiagnostics(),
      walMaintenance: walMaintenanceDiagnostics(),
    };
  } catch {
    // Diagnostics can be read during early bootstrap before the active schema
    // exists. The HTTP health path will include lease state once DB init ends.
  }

  return {
    uptimeMs: Date.now() - startedAt,
    inFlightRequests,
    inFlightStreamingRequests,
    totalRequests,
    totalStreamingRequests,
    slowRequests,
    thresholds: {
      slowRequestMs: slowRequestThresholdMs,
      eventLoopResolutionMs,
      requestLatencySamples: requestLatencySampleSize,
    },
    requestLatency: requestLatencySnapshot(),
    eventLoopLag: {
      minMs: nanosecondsToMilliseconds(eventLoopHistogram.min),
      meanMs: nanosecondsToMilliseconds(eventLoopHistogram.mean),
      maxMs: nanosecondsToMilliseconds(eventLoopHistogram.max),
      p95Ms: nanosecondsToMilliseconds(eventLoopHistogram.percentile(95)),
      p99Ms: nanosecondsToMilliseconds(eventLoopHistogram.percentile(99)),
    },
    lastSlowRequest,
    commands: commandRuntime,
  };
}
