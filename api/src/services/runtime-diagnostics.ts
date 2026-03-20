import { monitorEventLoopDelay } from "node:perf_hooks";
import { readIntEnv } from "../utils/env.js";

interface SlowRequestSnapshot {
  method: string;
  path: string;
  durationMs: number;
  statusCode: number;
  finishedAt: string;
}

const slowRequestThresholdMs = readIntEnv("DISCOGENIUS_SLOW_REQUEST_MS", 1500, 100);
const eventLoopResolutionMs = readIntEnv("DISCOGENIUS_EVENT_LOOP_RESOLUTION_MS", 20, 5);
const eventLoopHistogram = monitorEventLoopDelay({ resolution: eventLoopResolutionMs });

let diagnosticsStarted = false;
let startedAt = Date.now();
let inFlightRequests = 0;
let inFlightStreamingRequests = 0;
let totalRequests = 0;
let totalStreamingRequests = 0;
let slowRequests = 0;
let lastSlowRequest: SlowRequestSnapshot | null = null;

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
    path === "/api/events" ||
    path === "/api/queue/progress-stream" ||
    path === "/api/monitoring/check-stream" ||
    path === "/api/artists/import-followed-stream" ||
    path === "/api/library-files/scan-roots-now"
  );
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
    },
    eventLoopLag: {
      minMs: nanosecondsToMilliseconds(eventLoopHistogram.min),
      meanMs: nanosecondsToMilliseconds(eventLoopHistogram.mean),
      maxMs: nanosecondsToMilliseconds(eventLoopHistogram.max),
      p95Ms: nanosecondsToMilliseconds(eventLoopHistogram.percentile(95)),
      p99Ms: nanosecondsToMilliseconds(eventLoopHistogram.percentile(99)),
    },
    lastSlowRequest,
  };
}
