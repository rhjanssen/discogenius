import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { db } from "../../database.js";
import { BASE_SCHEMA_VERSION } from "../../database/schema/version.js";
import { Config, CONFIG_DIR, getConfigSection } from "../config/config.js";
import { DB_PATH } from "../config/bootstrap.js";
import { getRuntimeDiagnosticsSnapshot } from "./runtime-diagnostics.js";
import {
  checkCommandAvailability,
  checkWritablePath,
  rollupHealthStatus,
  type BackendCapabilitySnapshot,
  type HealthCheckResult,
  type HealthOverallStatus,
} from "../../utils/health.js";
import {
  getTiddlCapabilitySnapshot,
  getTiddlBinary,
  TIDDL_CONFIG_DIR,
} from "../providers/tidal/tiddl.js";
import { getDownloadQueueControlState } from "../download/download-queue-control.js";
import { CommandNames } from "./command-names.js";

// Single source of truth; see the note on the constant.
const EXPECTED_SCHEMA_VERSION = BASE_SCHEMA_VERSION;
const LAST_DEEP_HEALTH_CONTROL_KEY = "last_deep_health_result";
const CAPABILITY_CACHE_TTL_MS = 60_000;
const GIB = 1024 ** 3;

type RuntimeDiagnosticsSnapshot = ReturnType<typeof getRuntimeDiagnosticsSnapshot>;

export interface DeepDatabaseHealthResult {
  checkedAt: string;
  durationMs: number;
  status: HealthOverallStatus;
  quickCheck: {
    status: "ok" | "error";
    message: string;
    results: string[];
  };
  foreignKeys: {
    status: "ok" | "error";
    violationCount: number;
    sample: Array<Record<string, unknown>>;
  };
  executedOffMainThread: boolean;
  persisted: boolean;
  error?: string;
  persistenceError?: string;
}

export interface HealthDiagnosticsSnapshot {
  checkedAt: string;
  status: HealthOverallStatus;
  runtime: RuntimeDiagnosticsSnapshot;
  paths: {
    config: HealthCheckResult;
    database: HealthCheckResult;
    download: HealthCheckResult;
    library: {
      music: HealthCheckResult;
      spatial: HealthCheckResult;
      video: HealthCheckResult;
    };
    runtime: {
      tiddl: HealthCheckResult;
    };
  };
  tools: {
    ffmpeg: HealthCheckResult;
    tiddl: HealthCheckResult;
  };
  backends: {
    tiddl: BackendCapabilitySnapshot;
  };
  controls: {
    downloadQueue: ReturnType<typeof getDownloadQueueControlState>;
  };
  subsystems: {
    database: {
      schema: HealthCheckResult;
      wal: HealthCheckResult;
      storage: HealthCheckResult;
      deep: HealthCheckResult;
      lastDeepResult: DeepDatabaseHealthResult | null;
    };
    commandQueue: HealthCheckResult;
    scheduledTasks: HealthCheckResult;
    imports: HealthCheckResult;
    statistics: HealthCheckResult;
    catalog: HealthCheckResult;
  };
  issues: HealthCheckResult[];
}

interface CachedCapabilities {
  cacheKey: string;
  expiresAtMs: number;
  ffmpeg: HealthCheckResult;
  tiddlCommand: HealthCheckResult;
  tiddl: BackendCapabilitySnapshot;
}

let cachedCapabilities: CachedCapabilities | null = null;

function flattenChecks(...groups: Array<HealthCheckResult[] | undefined>): HealthCheckResult[] {
  return groups.reduce<HealthCheckResult[]>((acc, group) => {
    if (group) {
      acc.push(...group);
    }
    return acc;
  }, []).filter((check) => check.status !== "ok");
}

function diagnosticFailure(scope: string, displayName: string, error: unknown): HealthCheckResult {
  return {
    scope,
    status: "error",
    message: `${displayName} could not be inspected`,
    details: {
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function safeCheck(
  scope: string,
  displayName: string,
  check: () => HealthCheckResult,
): HealthCheckResult {
  try {
    return check();
  } catch (error) {
    return diagnosticFailure(scope, displayName, error);
  }
}

function disabledDownloadCheck(
  scope: string,
  displayName: string,
  details: Record<string, unknown> = {},
): HealthCheckResult {
  return {
    scope,
    status: "ok",
    message: `${displayName} is not required because downloads are disabled`,
    details: { ...details, disabledBy: "DISCOGENIUS_DISABLE_DOWNLOADS=1" },
  };
}

function markBackendDisabled(snapshot: BackendCapabilitySnapshot): BackendCapabilitySnapshot {
  return {
    ...snapshot,
    status: "healthy",
    available: false,
    ready: false,
    checks: snapshot.checks.map((check) => disabledDownloadCheck(check.scope, check.scope, check.details)),
    notes: ["Download processor is disabled for this runtime."],
  };
}

function getCapabilities(downloadsDisabled: boolean): CachedCapabilities {
  const tiddlBinary = getTiddlBinary();
  const cacheKey = `${downloadsDisabled}:${tiddlBinary}:${process.env.PATH || ""}`;
  if (
    cachedCapabilities
    && cachedCapabilities.cacheKey === cacheKey
    && cachedCapabilities.expiresAtMs > Date.now()
  ) {
    return cachedCapabilities;
  }

  const ffmpeg = downloadsDisabled
    ? disabledDownloadCheck("tools.ffmpeg", "FFmpeg", { command: "ffmpeg" })
    : safeCheck(
      "tools.ffmpeg",
      "FFmpeg",
      () => checkCommandAvailability("tools.ffmpeg", "ffmpeg", "FFmpeg"),
    );
  const tiddlCommand = downloadsDisabled
    ? disabledDownloadCheck("tools.tiddl", "tiddl", { command: tiddlBinary })
    : safeCheck(
      "tools.tiddl",
      "tiddl",
      () => checkCommandAvailability("tools.tiddl", tiddlBinary, "tiddl"),
    );
  const rawTiddl = getTiddlCapabilitySnapshot();
  const tiddl = downloadsDisabled ? markBackendDisabled(rawTiddl) : rawTiddl;

  cachedCapabilities = {
    cacheKey,
    expiresAtMs: Date.now() + CAPABILITY_CACHE_TTL_MS,
    ffmpeg,
    tiddlCommand,
    tiddl,
  };
  return cachedCapabilities;
}

/** Test/configuration hook; ordinary health requests use the one-minute cache. */
export function clearHealthCapabilityCache(): void {
  cachedCapabilities = null;
}

function readNumberEnv(name: string, fallback: number, minimum = 0): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function nearestExistingPath(targetPath: string): string | null {
  let candidate = path.resolve(targetPath);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  const stat = fs.statSync(candidate);
  return stat.isDirectory() ? candidate : path.dirname(candidate);
}

function collectStorageCheck(paths: string[]): HealthCheckResult {
  const errorFreeBytes = readNumberEnv("DISCOGENIUS_DISK_ERROR_FREE_BYTES", GIB, 0);
  const warningFreeBytes = Math.max(
    errorFreeBytes,
    readNumberEnv("DISCOGENIUS_DISK_WARNING_FREE_BYTES", 5 * GIB, 0),
  );
  const volumes = new Map<string, {
    path: string;
    freeBytes: number;
    totalBytes: number;
    freePercent: number;
  }>();

  try {
    for (const configuredPath of paths) {
      const existingPath = nearestExistingPath(configuredPath);
      if (!existingPath) continue;
      const stats = fs.statfsSync(existingPath);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
      // Node's StatsFs typing does not expose fsid consistently across
      // platforms. Capacity plus current free-block count is a cheap,
      // best-effort dedupe for several configured roots on one volume.
      const volumeKey = `${stats.type}:${stats.blocks}:${stats.bsize}:${stats.bfree}`;
      const existing = volumes.get(volumeKey);
      if (!existing || freeBytes < existing.freeBytes) {
        volumes.set(volumeKey, {
          path: existingPath,
          freeBytes,
          totalBytes,
          freePercent: Number(freePercent.toFixed(2)),
        });
      }
    }
  } catch (error) {
    return {
      scope: "database.storage",
      status: "warning",
      message: "Free disk space could not be determined",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }

  const snapshots = [...volumes.values()];
  if (snapshots.length === 0) {
    return {
      scope: "database.storage",
      status: "warning",
      message: "No existing configured volume was available for a free-space check",
      details: { configuredPathCount: paths.length },
    };
  }

  const errors = snapshots.filter((volume) => volume.freeBytes < errorFreeBytes || volume.freePercent < 1);
  const warnings = snapshots.filter((volume) => (
    !errors.includes(volume)
    && (volume.freeBytes < warningFreeBytes || volume.freePercent < 5)
  ));
  const details = {
    volumes: snapshots,
    thresholds: {
      warningFreeBytes,
      errorFreeBytes,
      warningFreePercent: 5,
      errorFreePercent: 1,
    },
  };

  if (errors.length > 0) {
    return {
      scope: "database.storage",
      status: "warning",
      message: `${errors.length} configured volume(s) have critically low free space`,
      details,
    };
  }
  if (warnings.length > 0) {
    return {
      scope: "database.storage",
      status: "warning",
      message: `${warnings.length} configured volume(s) have low free space`,
      details,
    };
  }
  return {
    scope: "database.storage",
    status: "ok",
    message: `Free space is adequate on ${snapshots.length} configured volume(s)`,
    details,
  };
}

function collectSchemaCheck(): HealthCheckResult {
  try {
    const userVersion = Number(db.pragma("user_version", { simple: true }) || 0);
    if (userVersion === 0) {
      return {
        scope: "database.schema",
        status: "warning",
        message: "Database schema has not been initialized yet",
        details: { userVersion, expectedUserVersion: EXPECTED_SCHEMA_VERSION },
      };
    }
    if (userVersion !== EXPECTED_SCHEMA_VERSION) {
      return {
        scope: "database.schema",
        status: "error",
        message: `Database schema ${userVersion} does not match expected schema ${EXPECTED_SCHEMA_VERSION}`,
        details: { userVersion, expectedUserVersion: EXPECTED_SCHEMA_VERSION },
      };
    }

    const journalMode = String(db.pragma("journal_mode", { simple: true }) || "").toLowerCase();
    return {
      scope: "database.schema",
      status: journalMode === "wal" ? "ok" : "warning",
      message: journalMode === "wal"
        ? `Database schema ${userVersion} is active with WAL journaling`
        : `Database schema ${userVersion} is active, but journal mode is ${journalMode || "unknown"}`,
      details: { userVersion, expectedUserVersion: EXPECTED_SCHEMA_VERSION, journalMode },
    };
  } catch (error) {
    return {
      scope: "database.schema",
      status: "warning",
      message: "Database schema state is temporarily unavailable",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function collectWalCheck(): HealthCheckResult {
  const warningBytes = readNumberEnv("DISCOGENIUS_WAL_WARNING_BYTES", 256 * 1024 ** 2, 0);
  const errorBytes = Math.max(
    warningBytes,
    readNumberEnv("DISCOGENIUS_WAL_ERROR_BYTES", 1024 ** 3, 0),
  );
  const walPath = `${DB_PATH}-wal`;
  try {
    const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    const status = walBytes >= warningBytes ? "warning" : "ok";
    return {
      scope: "database.wal",
      status,
      message: walBytes >= errorBytes
        ? "SQLite WAL is critically large; inspect active readers and checkpoint health"
        : status === "warning"
          ? "SQLite WAL is large; inspect long-lived readers and checkpoint progress"
          : "SQLite WAL size is within its configured threshold",
      details: { walPath, walBytes, warningBytes, errorBytes },
    };
  } catch (error) {
    return {
      scope: "database.wal",
      status: "warning",
      message: "SQLite WAL size could not be inspected",
      details: { walPath, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function parseSqliteTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectCommandQueueCheck(runtime: RuntimeDiagnosticsSnapshot): HealthCheckResult {
  try {
    const active = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'started' THEN 1 ELSE 0 END) AS started,
        MIN(CASE
          WHEN status = 'queued'
           AND (retry_after IS NULL OR retry_after <= CURRENT_TIMESTAMP)
          THEN created_at END
        ) AS oldest_eligible_created_at
      FROM commands
      WHERE status IN ('queued', 'started')
    `).get() as {
      queued: number | null;
      started: number | null;
      oldest_eligible_created_at: string | null;
    };
    const commandNames = Object.values(CommandNames);
    const failed = db.prepare(`
      SELECT COUNT(*) AS count
      FROM commands INDEXED BY idx_commands_status_name_completed
      WHERE status = 'failed'
        AND name IN (${commandNames.map(() => "?").join(", ")})
        AND completed_at >= datetime('now', '-24 hours')
    `).get(...commandNames) as { count: number };

    const queued = Number(active.queued) || 0;
    const started = Number(active.started) || 0;
    const failedLast24h = Number(failed.count) || 0;
    const oldestTimestamp = parseSqliteTimestamp(active.oldest_eligible_created_at);
    const oldestEligibleAgeMs = oldestTimestamp == null ? null : Math.max(0, Date.now() - oldestTimestamp);
    const warningAgeMs = readNumberEnv("DISCOGENIUS_QUEUE_AGE_WARNING_MS", 30 * 60_000, 1_000);
    const errorAgeMs = Math.max(
      warningAgeMs,
      readNumberEnv("DISCOGENIUS_QUEUE_AGE_ERROR_MS", 4 * 60 * 60_000, 1_000),
    );
    const commandRuntime = runtime.commands;
    const expiredLeases = commandRuntime?.leases.expiredLeases ?? 0;
    const noProgress = commandRuntime?.leases.noProgress ?? 0;
    const pool = commandRuntime?.workerPool ?? null;
    const deadPool = Boolean(pool?.started && pool.workers.length === 0);
    const staleBusyWorkers = pool?.workers.filter((worker) => (
      worker.busy
      && Date.now() - Date.parse(worker.lastSeenAt) > 2 * 60_000
    )) ?? [];

    const details = {
      queued,
      started,
      failedLast24h,
      oldestEligibleAgeMs,
      expiredLeases,
      noProgress,
      retryScheduled: commandRuntime?.leases.retryScheduled ?? 0,
      workerPoolStarted: pool?.started ?? false,
      workerCount: pool?.workers.length ?? 0,
      staleBusyWorkerIds: staleBusyWorkers.map((worker) => worker.workerId),
      thresholds: { warningAgeMs, errorAgeMs, busyWorkerLastSeenMs: 2 * 60_000 },
    };

    if (
      deadPool
      || expiredLeases > 0
      || staleBusyWorkers.length > 0
      || (oldestEligibleAgeMs != null && oldestEligibleAgeMs >= errorAgeMs)
    ) {
      return {
        scope: "commands.queue",
        status: "error",
        message: "The command queue has a liveness failure requiring operator attention",
        details,
      };
    }
    if (
      noProgress > 0
      || failedLast24h > 0
      || (oldestEligibleAgeMs != null && oldestEligibleAgeMs >= warningAgeMs)
    ) {
      return {
        scope: "commands.queue",
        status: "warning",
        message: "The command queue has recent failures, stalled progress, or an aging backlog",
        details,
      };
    }
    return {
      scope: "commands.queue",
      status: "ok",
      message: queued > 0 || started > 0
        ? `Command queue is making work available (${queued} queued, ${started} started)`
        : "Command queue has no active backlog",
      details,
    };
  } catch (error) {
    return {
      scope: "commands.queue",
      status: "warning",
      message: "Command queue diagnostics are unavailable during database bootstrap",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function collectScheduledTaskCheck(runtime: RuntimeDiagnosticsSnapshot): HealthCheckResult {
  try {
    const tasks = db.prepare(`
      SELECT task_key, name, interval_minutes, enabled, last_queued_at
      FROM scheduled_tasks
      ORDER BY task_key
    `).all() as Array<{
      task_key: string;
      name: string;
      interval_minutes: number;
      enabled: number;
      last_queued_at: string | null;
    }>;

    if (tasks.length === 0) {
      const warmupMs = 60_000;
      return {
        scope: "scheduler.tasks",
        status: runtime.uptimeMs > warmupMs ? "warning" : "ok",
        message: runtime.uptimeMs > warmupMs
          ? "Scheduled task definitions have not been initialized"
          : "Scheduled task definitions are waiting for scheduler startup",
        details: { taskCount: 0, runtimeUptimeMs: runtime.uptimeMs, warmupMs },
      };
    }

    const now = Date.now();
    const overdue = tasks.filter((task) => {
      if (!task.enabled) return false;
      const intervalMs = Math.max(1, Number(task.interval_minutes)) * 60_000;
      const graceMs = Math.max(5 * 60_000, intervalMs);
      const lastQueuedAt = parseSqliteTimestamp(task.last_queued_at);
      if (lastQueuedAt == null) {
        return runtime.uptimeMs > intervalMs + graceMs;
      }
      return now - lastQueuedAt > intervalMs + graceMs;
    });
    const enabled = tasks.filter((task) => Boolean(task.enabled));
    const disabled = tasks.length - enabled.length;
    const details = {
      taskCount: tasks.length,
      enabled: enabled.length,
      disabled,
      overdue: overdue.map((task) => ({
        taskKey: task.task_key,
        name: task.name,
        intervalMinutes: task.interval_minutes,
        lastQueuedAt: task.last_queued_at,
      })),
      policy: "overdue after one full interval of grace",
    };

    return {
      scope: "scheduler.tasks",
      status: overdue.length > 0 ? "warning" : "ok",
      message: overdue.length > 0
        ? `${overdue.length} enabled scheduled task(s) are overdue`
        : `${enabled.length} enabled scheduled task(s) are within their queueing window`,
      details,
    };
  } catch (error) {
    return {
      scope: "scheduler.tasks",
      status: "warning",
      message: "Scheduled task diagnostics are unavailable during database bootstrap",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function collectImportCheck(): HealthCheckResult {
  const staleImportMs = readNumberEnv("DISCOGENIUS_IMPORT_STALE_MS", 2 * 60 * 60_000, 60_000);
  const importCommandNames = [
    "ImportDownload",
    "ImportUnmappedFiles",
    "DownloadTrack",
    "DownloadVideo",
    "DownloadAlbum",
  ];
  const placeholders = importCommandNames.map(() => "?").join(", ");

  try {
    const failed = db.prepare(`
      SELECT COUNT(*) AS count, MAX(completed_at) AS latest
      FROM commands INDEXED BY idx_commands_status_name_completed
      WHERE status = 'failed'
        AND name IN (${placeholders})
        AND completed_at >= datetime('now', '-7 days')
        AND (
          name IN ('ImportDownload', 'ImportUnmappedFiles')
          OR json_extract(payload, '$.downloadState.state') = 'importFailed'
        )
    `).get(...importCommandNames) as { count: number; latest: string | null };
    const active = db.prepare(`
      SELECT id, name, started_at,
             json_extract(payload, '$.downloadState.state') AS import_state
      FROM commands INDEXED BY idx_commands_status_name_started
      WHERE status = 'started'
        AND name IN (${placeholders})
        AND (
          name IN ('ImportDownload', 'ImportUnmappedFiles')
          OR json_extract(payload, '$.downloadState.state') IN ('importPending', 'importing')
        )
      ORDER BY started_at ASC
      LIMIT 100
    `).all(...importCommandNames) as Array<{
      id: number;
      name: string;
      started_at: string | null;
      import_state: string | null;
    }>;

    const stale = active.filter((command) => {
      const startedAt = parseSqliteTimestamp(command.started_at);
      return startedAt != null && Date.now() - startedAt >= staleImportMs;
    });
    const failedCount = Number(failed.count) || 0;
    const details = {
      active: active.length,
      failedLast7Days: failedCount,
      latestFailureAt: failed.latest,
      staleImportMs,
      stale: stale.map((command) => ({
        commandId: command.id,
        commandName: command.name,
        state: command.import_state,
        startedAt: command.started_at,
      })),
    };

    if (stale.length > 0) {
      return {
        scope: "imports.health",
        status: "error",
        message: `${stale.length} import(s) have remained active beyond the stale threshold`,
        details,
      };
    }
    if (failedCount > 0) {
      return {
        scope: "imports.health",
        status: "warning",
        message: `${failedCount} import command(s) failed in the last seven days`,
        details,
      };
    }
    return {
      scope: "imports.health",
      status: "ok",
      message: active.length > 0
        ? `${active.length} import(s) are active within the expected window`
        : "No failed or stale imports were detected",
      details,
    };
  } catch (error) {
    return {
      scope: "imports.health",
      status: "warning",
      message: "Import diagnostics are unavailable during database bootstrap",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function collectStatisticsCheck(): HealthCheckResult {
  try {
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM AlbumLibraryProjectionState) AS album_state_rows,
        (SELECT MAX(updated_at) FROM AlbumLibraryProjectionState) AS album_updated_at,
        (SELECT COUNT(*) FROM TrackLibraryProjectionState) AS track_state_rows,
        (SELECT MAX(updated_at) FROM TrackLibraryProjectionState) AS track_updated_at,
        (SELECT COUNT(*) FROM ArtistStatistics) AS artist_statistics_rows,
        (SELECT MAX(updated_at) FROM ArtistStatistics) AS artist_statistics_updated_at
    `).get() as {
      album_state_rows: number;
      album_updated_at: string | null;
      track_state_rows: number;
      track_updated_at: string | null;
      artist_statistics_rows: number;
      artist_statistics_updated_at: string | null;
    };
    const staleProjections = [
      Number(row.album_state_rows) === 0 ? "album-library" : null,
      Number(row.track_state_rows) === 0 ? "track-library" : null,
    ].filter((value): value is string => value !== null);
    const details = {
      staleProjections,
      albumLibraryProjectionUpdatedAt: row.album_updated_at,
      trackLibraryProjectionUpdatedAt: row.track_updated_at,
      artistStatisticsRows: Number(row.artist_statistics_rows) || 0,
      artistStatisticsUpdatedAt: row.artist_statistics_updated_at,
      dashboardSnapshotCache: "in-memory stale-while-revalidate; age is not persisted",
    };

    return {
      scope: "statistics.freshness",
      status: staleProjections.length > 0 ? "warning" : "ok",
      message: staleProjections.length > 0
        ? `Statistics projections awaiting rebuild: ${staleProjections.join(", ")}`
        : "Persisted library projections are marked current",
      details,
    };
  } catch (error) {
    return {
      scope: "statistics.freshness",
      status: "warning",
      message: "Statistics freshness diagnostics are unavailable during database bootstrap",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function collectCatalogCheck(): HealthCheckResult {
  try {
    const catalog = getConfigSection("catalog");
    return {
      scope: "catalog.configuration",
      status: "ok",
      message: catalog.source === "musicbrainz"
        ? "Local MusicBrainz catalog mode is configured"
        : "Servarr metadata catalog mode is configured",
      details: {
        source: catalog.source,
        musicbrainzHost: catalog.source === "musicbrainz" ? catalog.musicbrainz_host : undefined,
        connectivity: "unknown",
        connectivityPolicy: "The lightweight health probe does not make live catalog requests",
      },
    };
  } catch (error) {
    return diagnosticFailure("catalog.configuration", "Catalog configuration", error);
  }
}

function readLastDeepHealthResult(): DeepDatabaseHealthResult | null {
  try {
    const row = db.prepare(`
      SELECT value
      FROM runtime_controls
      WHERE control_key = ?
    `).get(LAST_DEEP_HEALTH_CONTROL_KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as Partial<DeepDatabaseHealthResult>;
    if (
      typeof parsed.checkedAt !== "string"
      || typeof parsed.durationMs !== "number"
      || (parsed.status !== "healthy" && parsed.status !== "unhealthy" && parsed.status !== "degraded")
      || typeof parsed.quickCheck !== "object"
      || typeof parsed.foreignKeys !== "object"
    ) {
      return null;
    }
    return parsed as DeepDatabaseHealthResult;
  } catch {
    return null;
  }
}

function deepHealthCheckResult(result: DeepDatabaseHealthResult | null, schema: HealthCheckResult): HealthCheckResult {
  if (!result) {
    return {
      scope: "database.deep",
      status: schema.details?.userVersion === 0 ? "ok" : "warning",
      message: schema.details?.userVersion === 0
        ? "Deep database integrity check is waiting for schema initialization"
        : "No completed deep database integrity check has been recorded",
      details: {
        requiredChecks: ["PRAGMA quick_check", "PRAGMA foreign_key_check"],
      },
    };
  }

  const checkedAtMs = Date.parse(result.checkedAt);
  const ageMs = Number.isFinite(checkedAtMs) ? Math.max(0, Date.now() - checkedAtMs) : null;
  const staleAfterMs = readNumberEnv("DISCOGENIUS_DEEP_HEALTH_STALE_MS", 24 * 60 * 60_000, 60_000);
  if (result.status === "unhealthy") {
    return {
      scope: "database.deep",
      status: "error",
      message: "The most recent deep database integrity check failed",
      details: { ...result, ageMs, staleAfterMs },
    };
  }
  if (ageMs == null || ageMs >= staleAfterMs) {
    return {
      scope: "database.deep",
      status: "warning",
      message: "The most recent deep database integrity check is stale",
      details: { ...result, ageMs, staleAfterMs },
    };
  }
  return {
    scope: "database.deep",
    status: "ok",
    message: "The most recent deep database integrity check passed",
    details: { ...result, ageMs, staleAfterMs },
  };
}

function persistDeepHealthResult(
  result: DeepDatabaseHealthResult,
): { result: DeepDatabaseHealthResult; error?: string } {
  const persistedResult: DeepDatabaseHealthResult = { ...result, persisted: true };
  try {
    db.prepare(`
      INSERT INTO runtime_controls (control_key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(control_key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(LAST_DEEP_HEALTH_CONTROL_KEY, JSON.stringify(persistedResult));
    return { result: persistedResult };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        ...result,
        persisted: false,
        persistenceError: message,
      },
      error: message,
    };
  }
}

/**
 * Run the expensive integrity audit used by the CheckHealth command.
 *
 * Production CheckHealth commands execute in the command worker pool, so the
 * synchronous better-sqlite3 PRAGMAs do not block the API event loop. This
 * function is intentionally never called by /health or /system/status.
 */
export function runDeepDatabaseHealthCheck(): DeepDatabaseHealthResult {
  const startedAt = process.hrtime.bigint();
  let result: DeepDatabaseHealthResult;
  try {
    const quickRows = db.pragma("quick_check") as Array<Record<string, unknown>>;
    const quickResults = quickRows.flatMap((row) => Object.values(row).map(String));
    const quickPassed = quickResults.length === 1 && quickResults[0] === "ok";
    let foreignKeyViolationCount = 0;
    const foreignKeySample: Array<Record<string, unknown>> = [];
    for (const row of db.prepare("SELECT * FROM pragma_foreign_key_check").iterate() as Iterable<Record<string, unknown>>) {
      foreignKeyViolationCount += 1;
      if (foreignKeySample.length < 20) foreignKeySample.push(row);
    }
    const foreignKeysPassed = foreignKeyViolationCount === 0;
    result = {
      checkedAt: new Date().toISOString(),
      durationMs: Number((Number(process.hrtime.bigint() - startedAt) / 1_000_000).toFixed(2)),
      status: quickPassed && foreignKeysPassed ? "healthy" : "unhealthy",
      quickCheck: {
        status: quickPassed ? "ok" : "error",
        message: quickPassed ? "PRAGMA quick_check passed" : "PRAGMA quick_check reported database errors",
        results: quickResults.slice(0, 20),
      },
      foreignKeys: {
        status: foreignKeysPassed ? "ok" : "error",
        violationCount: foreignKeyViolationCount,
        sample: foreignKeySample,
      },
      executedOffMainThread: !isMainThread,
      persisted: false,
    };
  } catch (error) {
    result = {
      checkedAt: new Date().toISOString(),
      durationMs: Number((Number(process.hrtime.bigint() - startedAt) / 1_000_000).toFixed(2)),
      status: "unhealthy",
      quickCheck: {
        status: "error",
        message: "Database integrity check could not complete",
        results: [],
      },
      foreignKeys: {
        status: "error",
        violationCount: 0,
        sample: [],
      },
      executedOffMainThread: !isMainThread,
      persisted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return persistDeepHealthResult(result).result;
}

export function collectHealthDiagnosticsSnapshot(
  options: { deepResult?: DeepDatabaseHealthResult } = {},
): HealthDiagnosticsSnapshot {
  const downloadsDisabled = process.env.DISCOGENIUS_DISABLE_DOWNLOADS === "1";
  const pathConfig = getConfigSection("path");
  const downloadPath = Config.getDownloadPath();
  const musicPath = Config.getMusicPath(pathConfig);
  const spatialPath = Config.getSpatialPath(pathConfig);
  const videoPath = Config.getVideoPath(pathConfig);
  const runtime = getRuntimeDiagnosticsSnapshot();

  const configPathCheck = safeCheck(
    "paths.config",
    "Config directory",
    () => checkWritablePath("paths.config", CONFIG_DIR, {
      kind: "dir",
      displayName: "Config directory",
    }),
  );
  const databasePathCheck = safeCheck(
    "paths.database",
    "Database file",
    () => checkWritablePath("paths.database", DB_PATH, {
      kind: "file",
      displayName: "Database file",
    }),
  );
  const downloadPathCheck = safeCheck(
    "paths.download",
    "Download directory",
    () => checkWritablePath("paths.download", downloadPath, {
      kind: "dir",
      displayName: "Download directory",
    }),
  );
  const musicPathCheck = safeCheck(
    "paths.library.music",
    "Music library directory",
    () => checkWritablePath("paths.library.music", musicPath, {
      kind: "dir",
      displayName: "Music library directory",
    }),
  );
  const spatialPathCheck = safeCheck(
    "paths.library.spatial",
    "Spatial library directory",
    () => checkWritablePath("paths.library.spatial", spatialPath, {
      kind: "dir",
      displayName: "Spatial library directory",
    }),
  );
  const videoPathCheck = safeCheck(
    "paths.library.video",
    "Video library directory",
    () => checkWritablePath("paths.library.video", videoPath, {
      kind: "dir",
      displayName: "Video library directory",
    }),
  );
  const tiddlConfigCheck = downloadsDisabled
    ? disabledDownloadCheck("paths.runtime.tiddl", "tiddl config directory", { path: TIDDL_CONFIG_DIR })
    : safeCheck(
      "paths.runtime.tiddl",
      "tiddl config directory",
      () => checkWritablePath("paths.runtime.tiddl", TIDDL_CONFIG_DIR, {
        kind: "dir",
        displayName: "tiddl config directory",
      }),
    );

  const capabilities = getCapabilities(downloadsDisabled);
  const schemaCheck = collectSchemaCheck();
  const walCheck = collectWalCheck();
  const storageCheck = collectStorageCheck([
    CONFIG_DIR,
    DB_PATH,
    downloadPath,
    musicPath,
    spatialPath,
    videoPath,
  ]);
  const lastDeepResult = options.deepResult ?? readLastDeepHealthResult();
  const deepCheck = deepHealthCheckResult(lastDeepResult, schemaCheck);
  const commandQueueCheck = collectCommandQueueCheck(runtime);
  const scheduledTaskCheck = collectScheduledTaskCheck(runtime);
  const importCheck = collectImportCheck();
  const statisticsCheck = collectStatisticsCheck();
  const catalogCheck = collectCatalogCheck();

  const issues = flattenChecks(
    [
      configPathCheck,
      databasePathCheck,
      downloadPathCheck,
      musicPathCheck,
      spatialPathCheck,
      videoPathCheck,
      tiddlConfigCheck,
      capabilities.ffmpeg,
      capabilities.tiddlCommand,
      schemaCheck,
      walCheck,
      storageCheck,
      deepCheck,
      commandQueueCheck,
      scheduledTaskCheck,
      importCheck,
      statisticsCheck,
      catalogCheck,
    ],
    capabilities.tiddl.checks,
  );

  return {
    checkedAt: new Date().toISOString(),
    status: rollupHealthStatus(issues),
    runtime,
    paths: {
      config: configPathCheck,
      database: databasePathCheck,
      download: downloadPathCheck,
      library: {
        music: musicPathCheck,
        spatial: spatialPathCheck,
        video: videoPathCheck,
      },
      runtime: {
        tiddl: tiddlConfigCheck,
      },
    },
    tools: {
      ffmpeg: capabilities.ffmpeg,
      tiddl: capabilities.tiddlCommand,
    },
    backends: {
      tiddl: capabilities.tiddl,
    },
    controls: {
      downloadQueue: getDownloadQueueControlState(),
    },
    subsystems: {
      database: {
        schema: schemaCheck,
        wal: walCheck,
        storage: storageCheck,
        deep: deepCheck,
        lastDeepResult,
      },
      commandQueue: commandQueueCheck,
      scheduledTasks: scheduledTaskCheck,
      imports: importCheck,
      statistics: statisticsCheck,
      catalog: catalogCheck,
    },
    issues,
  };
}
