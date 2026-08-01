#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import {
  SYNTHETIC_RUN_FORMAT,
  appendNdjson,
  parseCli,
  readIntegerOption,
  readJson,
  readNdjson,
  readStringOption,
  requireRunMarker,
  sleep,
  writeJson,
  type ParsedCli,
  type SyntheticExpectedState,
  type SyntheticRunManifest,
} from "./synthetic-load-common.js";

interface RunnerOptions {
  runRoot: string;
  concurrency: number;
  cycles: number;
  latencyScale: number;
  maxAttempts: number;
  leaseMs: number;
  heartbeatMs: number;
  metricsMs: number;
  timeoutMs: number;
  injectFailures: boolean;
}

interface CreditedEdge {
  index: number;
  parentIndex: number;
  artistId: string;
  artistName: string;
}

interface WorkerState {
  worker: Worker;
  workerId: string;
  slot: number;
  generation: number;
  status: "starting" | "idle" | "busy" | "stopping";
  currentCommandId: number | null;
  lastSeenAt: number;
  claimed: number;
  completed: number;
  failed: number;
  busyRetries: number;
  meanClaimLatencyMs: number;
  blockedReason: string | null;
}

interface CommandRow {
  id: number;
  name: string;
  ref_id: string;
  status: "queued" | "started" | "completed" | "failed" | "cancelled";
  priority: number;
  attempt: number;
  worker_id: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  retry_after: string | null;
  updated_at: string | null;
}

interface RunSnapshot {
  at: string;
  elapsedMs: number;
  completedArtists: number;
  failedArtists: number;
  terminalPrimaryArtists: number;
  activeCommands: number;
  queueDepth: number;
  eligibleQueueDepth: number;
  completedCreditedArtists: number;
  failedCreditedArtists: number;
  oldestEligibleCommandAgeMs: number | null;
  oldestHeartbeatAgeMs: number | null;
  database: {
    databaseBytes: number;
    walBytes: number;
    pageCount: number;
    pageSize: number;
    readLatencyMs: number;
  };
  eventLoop: {
    meanMs: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  apiLatency: null;
  apiLatencyReason: string;
  sseDelay: null;
  sseDelayReason: string;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
  };
  cpu: {
    userMicros: number;
    systemMicros: number;
    percentOfOneCore: number;
  };
  workers: {
    configured: number;
    live: number;
    busy: number;
    idle: number;
    utilization: number;
    busyRetries: number;
    meanClaimLatencyMs: number;
  };
  recovery: {
    workerDeaths: number;
    expiredLeases: number;
    requeued: number;
    terminalFailures: number;
  };
  lastProgressTransition: string | null;
  failureEvents: number;
}

interface AssertionResult {
  name: string;
  pass: boolean;
  expected: unknown;
  actual: unknown;
  severity: "blocking" | "warning";
}

const HELP = `
Run deterministic mixed command load against a generated disposable fixture.

Usage:
  yarn --cwd api tsx scripts/release-hardening/run-synthetic-load.ts --run-root PATH [options]

Options:
  --run-root PATH          Existing generated run directory (required)
  --concurrency N          SQLite worker threads (default: manifest value)
  --cycles N               Primary Artist workflow cycles (default: 1)
  --latency-scale N        Synthetic external wait multiplier (default: 1)
  --max-attempts N         Bounded attempts before terminal failure (default: 3)
  --lease-ms N             Execution lease duration (default: 1500)
  --heartbeat-ms N         Heartbeat interval while progressing (default: 100)
  --metrics-ms N           Durable metric sampling interval (default: 1000)
  --timeout-ms N           Whole-run deadline (default: 1800000)
  --no-failure-injection   Disable crash/hang/transient/poison injection
  --help                   Show this text
`.trim();

function readPositiveNumber(cli: ParsedCli, key: string, fallback: number, min: number, max: number): number {
  const raw = cli[key];
  if (raw == null) return fallback;
  if (raw === true) throw new Error(`--${key} requires a numeric value`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${key} must be between ${min} and ${max}`);
  }
  return value;
}

function parseOptions(argv: readonly string[]): {
  cli: ParsedCli;
  runRoot: string;
} {
  const cli = parseCli(argv);
  if (cli.help === true) {
    console.log(HELP);
    process.exit(0);
  }
  return {
    cli,
    runRoot: path.resolve(readStringOption(cli, "run-root")),
  };
}

function commandRange(runId: string): readonly [string, string] {
  const start = `rh:${runId}:`;
  return [start, `${start}\uffff`];
}

function primaryRef(runId: string, artistIndex: number, cycle: number, stage: string): string {
  return `rh:${runId}:p:${artistIndex}:c:${cycle}:s:${stage}`;
}

function creditedRef(runId: string, index: number): string {
  return `rh:${runId}:c:${index}:s:RefreshArtist`;
}

function globalRef(runId: string, cycle: number): string {
  return `rh:${runId}:global:c:${cycle}`;
}

function parsePrimaryRef(runId: string, refId: string): {
  artistIndex: number;
  cycle: number;
  stage: string;
} | null {
  const escaped = runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^rh:${escaped}:p:(\\d+):c:(\\d+):s:([^:]+)$`).exec(refId);
  if (!match) return null;
  return {
    artistIndex: Number(match[1]),
    cycle: Number(match[2]),
    stage: match[3],
  };
}

function parseCreditedRef(runId: string, refId: string): number | null {
  const escaped = runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^rh:${escaped}:c:(\\d+):s:RefreshArtist$`).exec(refId);
  return match ? Number(match[1]) : null;
}

function insertQueuedCommand(
  db: Database.Database,
  input: {
    name: string;
    refId: string;
    payload: unknown;
    priority: number;
    trigger?: number;
  },
): number {
  const existing = db.prepare(`
    SELECT id FROM commands WHERE ref_id = ? LIMIT 1
  `).get(input.refId) as { id: number } | undefined;
  if (existing) return existing.id;
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO commands (
      name, ref_id, payload, status, progress, priority, trigger,
      queue_order, attempts, created_at, updated_at
    ) VALUES (?, ?, ?, 'queued', 0, ?, ?, NULL, 0, ?, ?)
  `).run(
    input.name,
    input.refId,
    JSON.stringify(input.payload),
    input.priority,
    input.trigger ?? 0,
    now,
    now,
  );
  const id = Number(result.lastInsertRowid);
  db.prepare("UPDATE commands SET queue_order = ? WHERE id = ?").run(id, id);
  return id;
}

function getCommandRows(db: Database.Database, runId: string): CommandRow[] {
  return db.prepare(`
    SELECT id, name, ref_id, status, priority, attempt, worker_id,
           heartbeat_at, lease_expires_at, retry_after, updated_at
    FROM commands
    WHERE ref_id >= ? AND ref_id < ?
    ORDER BY id
  `).all(...commandRange(runId)) as CommandRow[];
}

function terminalPrimaryIndexes(
  rows: readonly CommandRow[],
  runId: string,
  cycle: number,
): Set<number> {
  const result = new Set<number>();
  for (const row of rows) {
    const parsed = parsePrimaryRef(runId, row.ref_id);
    if (!parsed || parsed.cycle !== cycle) continue;
    if (row.status === "failed" || (parsed.stage === "DownloadMissing" && row.status === "completed")) {
      result.add(parsed.artistIndex);
    }
  }
  return result;
}

function completedPrimaryRefreshIndexes(
  rows: readonly CommandRow[],
  runId: string,
  cycle: number,
): Set<number> {
  const result = new Set<number>();
  for (const row of rows) {
    const parsed = parsePrimaryRef(runId, row.ref_id);
    if (
      parsed
      && parsed.cycle === cycle
      && parsed.stage === "RefreshArtist"
      && row.status === "completed"
    ) {
      result.add(parsed.artistIndex);
    }
  }
  return result;
}

function completedPrimaryDownloads(
  rows: readonly CommandRow[],
  runId: string,
  cycles: number,
): number {
  return rows.filter((row) => {
    const parsed = parsePrimaryRef(runId, row.ref_id);
    return parsed
      && parsed.cycle <= cycles
      && parsed.stage === "DownloadMissing"
      && row.status === "completed";
  }).length;
}

function failedPrimaryWorkflows(
  rows: readonly CommandRow[],
  runId: string,
  cycles: number,
): number {
  return rows.filter((row) => {
    const parsed = parsePrimaryRef(runId, row.ref_id);
    return parsed && parsed.cycle <= cycles && row.status === "failed";
  }).length;
}

function completedCreditedIndexes(rows: readonly CommandRow[], runId: string): Set<number> {
  const result = new Set<number>();
  for (const row of rows) {
    const index = parseCreditedRef(runId, row.ref_id);
    if (index != null && row.status === "completed") result.add(index);
  }
  return result;
}

function failedCreditedIndexes(rows: readonly CommandRow[], runId: string): Set<number> {
  const result = new Set<number>();
  for (const row of rows) {
    const index = parseCreditedRef(runId, row.ref_id);
    if (index != null && row.status === "failed") result.add(index);
  }
  return result;
}

function databaseFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function safeAgeMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  // SQLite CURRENT_TIMESTAMP is UTC but has no zone suffix. JavaScript treats
  // that shape as local time, which inflated queue age by the host UTC offset.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
}

async function run(): Promise<void> {
  const parsed = parseOptions(process.argv.slice(2));
  const paths = requireRunMarker(parsed.runRoot);
  const manifest = readJson<SyntheticRunManifest>(paths.manifestPath);
  const expected = readJson<SyntheticExpectedState>(paths.expectedPath);
  if (manifest.format !== SYNTHETIC_RUN_FORMAT) {
    throw new Error(`Unsupported synthetic run format: ${manifest.format}`);
  }
  if (path.resolve(manifest.paths.databasePath) !== path.resolve(paths.databasePath)) {
    throw new Error("Manifest database path does not match the guarded run directory");
  }
  const options: RunnerOptions = {
    runRoot: paths.runRoot,
    concurrency: readIntegerOption(
      parsed.cli,
      "concurrency",
      manifest.configuration.requestedConcurrency,
      { min: 1, max: 64 },
    ),
    cycles: readIntegerOption(parsed.cli, "cycles", 1, { min: 1, max: 1_000 }),
    latencyScale: readPositiveNumber(parsed.cli, "latency-scale", 1, 0.1, 10_000),
    maxAttempts: readIntegerOption(parsed.cli, "max-attempts", 3, { min: 1, max: 20 }),
    leaseMs: readIntegerOption(parsed.cli, "lease-ms", 1_500, { min: 250, max: 600_000 }),
    heartbeatMs: readIntegerOption(parsed.cli, "heartbeat-ms", 100, { min: 10, max: 60_000 }),
    metricsMs: readIntegerOption(parsed.cli, "metrics-ms", 1_000, { min: 100, max: 3_600_000 }),
    timeoutMs: readIntegerOption(parsed.cli, "timeout-ms", 1_800_000, { min: 1_000, max: 172_800_000 }),
    injectFailures: parsed.cli["no-failure-injection"] !== true,
  };
  if (options.heartbeatMs >= options.leaseMs / 2) {
    throw new Error("--heartbeat-ms must be less than half --lease-ms");
  }
  if (fs.existsSync(paths.finalPath)) {
    throw new Error(
      `Run already has final.json. Generate a fresh run instead of silently overwriting evidence: ${paths.finalPath}`,
    );
  }

  const creditedEdges = readNdjson<CreditedEdge>(paths.creditedEdgesPath);
  const db = new Database(paths.databasePath, { timeout: 5_000 });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const schemaVersion = Number(db.pragma("user_version", { simple: true }));
  if (schemaVersion !== 42) {
    throw new Error(`Synthetic runner requires schema 42, found ${schemaVersion}`);
  }
  const requiredLeaseColumns = [
    "attempt",
    "worker_id",
    "heartbeat_at",
    "last_progress_at",
    "progress_phase",
    "progress_current",
    "progress_total",
    "lease_expires_at",
    "blocked_reason",
    "retry_after",
    "last_retry_reason",
  ];
  const commandColumns = new Set(
    (db.prepare("PRAGMA table_info(commands)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  const missingColumns = requiredLeaseColumns.filter((column) => !commandColumns.has(column));
  if (missingColumns.length > 0) {
    throw new Error(
      `Synthetic runner requires the command lease schema; missing: ${missingColumns.join(", ")}`,
    );
  }

  const startedAt = new Date();
  const startedAtMs = startedAt.getTime();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  let lastMetricsAt = 0;
  let lastCpuAt = performance.now();
  let lastCpuUsage = process.cpuUsage();
  let stopping = false;
  let completedNormally = false;
  let currentCycle = 1;
  let nextWorkerGeneration = 1;
  let fairnessPromotionBucket = 0;
  let lastTerminalPrimaryCount = 0;
  let lastProgressTransition: string | null = null;
  let firstPrimaryDownloadReadyAt: string | null = null;
  let firstPrimaryDownloadReadyTerminalCount: number | null = null;
  let firstCreditedCompletedAt: string | null = null;
  let lastPrimaryTerminalAt: string | null = null;
  let eligibleIdleSince: number | null = null;
  let failureEvents = 0;
  let maxQueueDepth = 0;
  let maxWalBytes = 0;
  let maxEventLoopP99Ms = 0;
  let maxEventLoopDelayMs = 0;
  let maxDatabaseReadLatencyMs = 0;
  let maxOldestEligibleAgeMs = 0;
  let maxRssBytes = 0;
  let maxWorkerBusyRetries = 0;
  let maxMeanClaimLatencyMs = 0;
  let metricsSamples = 0;
  let workerDeaths = 0;
  let expiredLeases = 0;
  let recoveredCommands = 0;
  let recoveryTerminalFailures = 0;
  const workerStates = new Map<string, WorkerState>();
  const recoveryWorkerIds = new Set<string>();
  const assertionNotes: AssertionResult[] = [];

  appendNdjson(paths.eventsPath, {
    at: startedAt.toISOString(),
    type: "load_run_started",
    runId: manifest.runId,
    gitSha: manifest.gitSha,
    schemaVersion,
    options,
    dataset: manifest.configuration,
  });

  const sourceMode = import.meta.url.endsWith(".ts");
  const workerUrl = new URL(
    sourceMode ? "./synthetic-load-worker.ts" : "./synthetic-load-worker.js",
    import.meta.url,
  );

  const recoverOwnedCommands = (
    workerId: string,
    reason: string,
  ): { requeued: number; failed: number } => {
    const rows = db.prepare(`
      SELECT id, attempt
      FROM commands
      WHERE status = 'started' AND worker_id = ?
        AND ref_id >= ? AND ref_id < ?
      ORDER BY id
    `).all(workerId, ...commandRange(manifest.runId)) as Array<{ id: number; attempt: number }>;
    let requeued = 0;
    let failedCount = 0;
    const now = new Date().toISOString();
    const retryAt = new Date(Date.now() + 50).toISOString();
    db.transaction(() => {
      for (const row of rows) {
        const terminal = row.attempt >= options.maxAttempts;
        const update = db.prepare(`
          UPDATE commands
          SET status = ?,
              progress = 0,
              worker_id = NULL,
              heartbeat_at = NULL,
              lease_expires_at = NULL,
              blocked_reason = ?,
              retry_after = ?,
              last_retry_reason = ?,
              error = ?,
              completed_at = ?,
              updated_at = ?
          WHERE id = ? AND status = 'started' AND worker_id = ?
        `).run(
          terminal ? "failed" : "queued",
          terminal ? "synthetic recovery exhausted" : "stuck/recovering",
          terminal ? null : retryAt,
          reason,
          reason,
          terminal ? now : null,
          now,
          row.id,
          workerId,
        );
        if (update.changes === 1) {
          if (terminal) failedCount += 1;
          else requeued += 1;
        }
      }
    }).immediate();
    recoveredCommands += requeued;
    recoveryTerminalFailures += failedCount;
    if (requeued || failedCount) {
      appendNdjson(paths.eventsPath, {
        at: now,
        type: "commands_recovered",
        workerId,
        reason,
        requeued,
        failed: failedCount,
      });
    }
    return { requeued, failed: failedCount };
  };

  const spawnWorker = (slot: number): void => {
    if (stopping) return;
    const generation = nextWorkerGeneration;
    nextWorkerGeneration += 1;
    const workerId = `synthetic-${slot}-${generation}`;
    const worker = new Worker(workerUrl, {
      workerData: {
        databasePath: paths.databasePath,
        runId: manifest.runId,
        workerId,
        leaseMs: options.leaseMs,
        heartbeatMs: options.heartbeatMs,
        maxAttempts: options.maxAttempts,
        latencyScale: options.latencyScale,
        injectFailures: options.injectFailures,
      },
      execArgv: sourceMode ? ["--import", "tsx"] : [],
    });
    const state: WorkerState = {
      worker,
      workerId,
      slot,
      generation,
      status: "starting",
      currentCommandId: null,
      lastSeenAt: Date.now(),
      claimed: 0,
      completed: 0,
      failed: 0,
      busyRetries: 0,
      meanClaimLatencyMs: 0,
      blockedReason: null,
    };
    workerStates.set(workerId, state);
    worker.on("message", (message: Record<string, unknown>) => {
      state.lastSeenAt = Date.now();
      const type = String(message.type ?? "worker_message");
      if (type === "worker_started" || type === "worker_idle") {
        state.status = "idle";
        state.currentCommandId = null;
      } else if (type === "command_claimed") {
        state.status = "busy";
        state.currentCommandId = Number(message.commandId);
        state.claimed += 1;
        state.blockedReason = null;
      } else if (
        type === "command_completed"
        || type === "command_error"
        || type === "ownership_lost"
      ) {
        state.status = "idle";
        state.currentCommandId = null;
        state.blockedReason = null;
        if (type === "command_completed") state.completed += 1;
        if (type === "command_error" && message.disposition === "failed") state.failed += 1;
      }
      if (type === "worker_heartbeat") {
        state.blockedReason = typeof message.blockedReason === "string"
          ? message.blockedReason
          : null;
      }
      if (typeof message.busyRetries === "number") state.busyRetries = message.busyRetries;
      if (typeof message.meanClaimLatencyMs === "number") {
        state.meanClaimLatencyMs = message.meanClaimLatencyMs;
      }
      if (type !== "worker_idle" && type !== "worker_heartbeat") {
        appendNdjson(paths.eventsPath, message);
      }
      if (type === "failure_injected" || type === "command_error" || type === "worker_error") {
        failureEvents += 1;
      }
      if (
        type === "command_completed"
        && message.role === "primary"
        && message.stage === "DownloadMissing"
        && firstPrimaryDownloadReadyAt == null
      ) {
        firstPrimaryDownloadReadyAt = String(message.at);
        const rows = getCommandRows(db, manifest.runId);
        firstPrimaryDownloadReadyTerminalCount = terminalPrimaryIndexes(
          rows,
          manifest.runId,
          Number(message.cycle ?? 1),
        ).size;
      }
      if (
        type === "command_completed"
        && message.role === "credited"
        && firstCreditedCompletedAt == null
      ) {
        firstCreditedCompletedAt = String(message.at);
      }
    });
    worker.on("error", (error) => {
      failureEvents += 1;
      appendNdjson(paths.eventsPath, {
        at: new Date().toISOString(),
        type: "worker_thread_error",
        workerId,
        error: error.stack ?? error.message,
      });
    });
    worker.on("exit", (code) => {
      workerStates.delete(workerId);
      if (!stopping) {
        workerDeaths += 1;
        const injectedRecovery = recoveryWorkerIds.delete(workerId);
        if (!injectedRecovery) {
          recoverOwnedCommands(workerId, `worker ${workerId} exited with code ${code}`);
        }
        appendNdjson(paths.eventsPath, {
          at: new Date().toISOString(),
          type: "worker_exited",
          workerId,
          slot,
          generation,
          code,
          capacityRestored: true,
        });
        spawnWorker(slot);
      }
    });
  };

  for (let slot = 0; slot < options.concurrency; slot += 1) {
    spawnWorker(slot);
  }

  const enqueueCredited = (rows: readonly CommandRow[], cycle: number): number => {
    if (cycle !== 1 || creditedEdges.length === 0) return 0;
    const completedRefreshes = completedPrimaryRefreshIndexes(rows, manifest.runId, 1);
    const existingCredited = new Set<number>();
    let activeCredited = 0;
    for (const row of rows) {
      const creditedIndex = parseCreditedRef(manifest.runId, row.ref_id);
      if (creditedIndex == null) continue;
      existingCredited.add(creditedIndex);
      if (row.status === "queued" || row.status === "started") activeCredited += 1;
    }
    const terminalPrimary = terminalPrimaryIndexes(rows, manifest.runId, 1).size;
    const admissionLimit = terminalPrimary >= expected.artists.primary
      ? creditedEdges.length
      : Math.min(creditedEdges.length, completedRefreshes.size * 2);
    const availableSlots = Math.max(0, options.concurrency * 4 - activeCredited);
    const toAdmit = Math.max(0, Math.min(
      availableSlots,
      admissionLimit - existingCredited.size,
      25,
    ));
    if (toAdmit === 0) return 0;
    let inserted = 0;
    db.transaction(() => {
      for (const edge of creditedEdges) {
        if (inserted >= toAdmit) break;
        if (existingCredited.has(edge.index) || !completedRefreshes.has(edge.parentIndex)) continue;
        insertQueuedCommand(db, {
          name: "RefreshArtist",
          refId: creditedRef(manifest.runId, edge.index),
          priority: 0,
          payload: {
            artistId: edge.artistId,
            artistName: edge.artistName,
            workflow: "metadata-refresh",
            monitorArtist: false,
            hydrateCatalog: true,
            hydrateAlbumTracks: false,
            scanLibrary: false,
            forceDownloadQueue: false,
            forceUpdate: false,
            syntheticLoad: {
              runId: manifest.runId,
              role: "credited",
              artistIndex: edge.index,
              parentIndex: edge.parentIndex,
              stage: "RefreshArtist",
              behavior: { kind: "normal" },
            },
          },
        });
        existingCredited.add(edge.index);
        inserted += 1;
      }
    }).immediate();
    return inserted;
  };

  const promoteCreditedFairness = (rows: readonly CommandRow[], terminalPrimary: number): number => {
    const bucket = Math.floor(terminalPrimary / 10);
    if (bucket <= fairnessPromotionBucket || terminalPrimary >= expected.artists.primary) return 0;
    fairnessPromotionBucket = bucket;
    const candidates = rows
      .filter((row) => parseCreditedRef(manifest.runId, row.ref_id) != null && row.status === "queued")
      .slice(0, options.concurrency);
    if (candidates.length === 0) return 0;
    const update = db.prepare(`
      UPDATE commands SET priority = 2, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'
    `);
    db.transaction(() => {
      for (const candidate of candidates) update.run(candidate.id);
    }).immediate();
    appendNdjson(paths.eventsPath, {
      at: new Date().toISOString(),
      type: "credited_fairness_promotion",
      terminalPrimary,
      promoted: candidates.map((candidate) => candidate.id),
    });
    return candidates.length;
  };

  const enqueuePrimaryCycle = (cycle: number): number => {
    let inserted = 0;
    db.transaction(() => {
      for (let artistIndex = 0; artistIndex < expected.artists.primary; artistIndex += 1) {
        const artistMbid = db.prepare(`
          SELECT mbid FROM Artists
          WHERE library_origin = 'synthetic-load'
          ORDER BY name, id
          LIMIT 1 OFFSET ?
        `).get(artistIndex) as { mbid: string } | undefined;
        if (!artistMbid?.mbid) throw new Error(`Missing primary Artist ${artistIndex}`);
        const artistName = db.prepare("SELECT name FROM Artists WHERE mbid = ?").get(artistMbid.mbid) as {
          name: string;
        };
        const initialRef = primaryRef(manifest.runId, artistIndex, cycle, "RefreshArtist");
        const existing = db.prepare("SELECT id FROM commands WHERE ref_id = ?").get(initialRef);
        if (existing) continue;
        const behaviorKind = artistIndex % 397 === 13
          ? "worker_hang"
          : artistIndex % 331 === 11
            ? "worker_crash"
            : artistIndex % 251 === 7
              ? "poison"
              : artistIndex % 113 === 5
                ? "transient_failure"
                : artistIndex % 97 === 3 ? "slow" : "normal";
        const stage = behaviorKind === "worker_hang"
          ? "RescanFolders"
          : behaviorKind === "worker_crash"
            ? "RefreshArtist"
            : behaviorKind === "poison"
              ? "CurateArtist"
              : behaviorKind === "transient_failure" || behaviorKind === "slow"
                ? "MatchArtistProviders"
                : undefined;
        insertQueuedCommand(db, {
          name: "RefreshArtist",
          refId: initialRef,
          priority: 1,
          payload: {
            artistId: artistMbid.mbid,
            artistName: artistName.name,
            workflow: "metadata-refresh",
            monitorArtist: true,
            hydrateCatalog: true,
            hydrateAlbumTracks: true,
            scanLibrary: true,
            forceDownloadQueue: true,
            forceUpdate: false,
            syntheticLoad: {
              runId: manifest.runId,
              role: "primary",
              artistIndex,
              cycle,
              stage: "RefreshArtist",
              behavior: { kind: behaviorKind, stage },
            },
          },
        });
        inserted += 1;
      }
    }).immediate();
    appendNdjson(paths.eventsPath, {
      at: new Date().toISOString(),
      type: "primary_cycle_queued",
      cycle,
      inserted,
    });
    return inserted;
  };

  const queueGlobalReconciliation = (cycle: number): number => {
    return db.transaction(() => (
      insertQueuedCommand(db, {
        name: "DownloadMissing",
        refId: globalRef(manifest.runId, cycle),
        priority: -20,
        payload: {
          monitoringCycle: "full-cycle",
          syntheticLoad: {
            runId: manifest.runId,
            role: "global",
            cycle,
            stage: "DownloadMissing",
            behavior: { kind: "normal" },
          },
        },
      })
    )).immediate();
  };

  const recoverExpiredLeases = (): void => {
    const now = new Date().toISOString();
    const expired = db.prepare(`
      SELECT id, worker_id
      FROM commands
      WHERE status = 'started'
        AND ref_id >= ? AND ref_id < ?
        AND worker_id IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND julianday(lease_expires_at) <= julianday(?)
    `).all(...commandRange(manifest.runId), now) as Array<{ id: number; worker_id: string }>;
    for (const row of expired) {
      const state = workerStates.get(row.worker_id);
      const workerHeartbeatFresh = state
        && state.status === "busy"
        && state.currentCommandId === row.id
        && state.blockedReason === "waiting on database"
        && Date.now() - state.lastSeenAt <= Math.max(250, options.heartbeatMs * 3);
      if (workerHeartbeatFresh) {
        // The worker is alive and explicitly reports a known DB wait. Do not
        // steal its command merely because the same contention delayed the
        // persisted heartbeat. Its next successful update renews the lease.
        continue;
      }
      expiredLeases += 1;
      recoveryWorkerIds.add(row.worker_id);
      recoverOwnedCommands(row.worker_id, `lease expired at watchdog ${now}`);
      if (state) {
        void state.worker.terminate();
      }
    }
  };

  const sampleMetrics = (rows: readonly CommandRow[]): RunSnapshot => {
    const nowMs = Date.now();
    const queryStarted = performance.now();
    const queueCountRow = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'started' THEN 1 ELSE 0 END) AS started
      FROM commands
      WHERE ref_id >= ? AND ref_id < ?
    `).get(...commandRange(manifest.runId)) as { total: number; queued: number; started: number };
    const databaseReadLatencyMs = performance.now() - queryStarted;
    const eligible = rows.filter((row) => (
      row.status === "queued"
      && (!row.retry_after || Date.parse(row.retry_after) <= nowMs)
    ));
    const oldestEligibleAge = eligible
      .map((row) => safeAgeMs(row.updated_at, nowMs))
      .filter((age): age is number => age != null)
      .reduce<number | null>((maximum, age) => maximum == null ? age : Math.max(maximum, age), null);
    const heartbeatAges = rows
      .filter((row) => row.status === "started")
      .map((row) => safeAgeMs(row.heartbeat_at, nowMs))
      .filter((age): age is number => age != null);
    const oldestHeartbeatAge = heartbeatAges.length ? Math.max(...heartbeatAges) : null;
    const cycleTerminal = terminalPrimaryIndexes(rows, manifest.runId, currentCycle);
    const completedDownloads = completedPrimaryDownloads(rows, manifest.runId, options.cycles);
    const failedWorkflows = failedPrimaryWorkflows(rows, manifest.runId, options.cycles);
    const completedCredits = completedCreditedIndexes(rows, manifest.runId);
    const failedCredits = failedCreditedIndexes(rows, manifest.runId);
    const activeWorkers = [...workerStates.values()];
    const totalClaimed = activeWorkers.reduce((sum, worker) => sum + worker.claimed, 0);
    const weightedClaimLatency = activeWorkers.reduce(
      (sum, worker) => sum + worker.meanClaimLatencyMs * worker.claimed,
      0,
    );
    const busyWorkers = activeWorkers.filter((worker) => worker.status === "busy").length;
    const nowCpu = process.cpuUsage();
    const nowPerf = performance.now();
    const cpuMicros = (nowCpu.user - lastCpuUsage.user) + (nowCpu.system - lastCpuUsage.system);
    const cpuElapsedMicros = Math.max(1, (nowPerf - lastCpuAt) * 1_000);
    const cpuPercent = (cpuMicros / cpuElapsedMicros) * 100;
    lastCpuAt = nowPerf;
    lastCpuUsage = nowCpu;
    const memory = process.memoryUsage();
    const walBytes = databaseFileSize(`${paths.databasePath}-wal`);
    maxWalBytes = Math.max(maxWalBytes, walBytes);
    maxQueueDepth = Math.max(maxQueueDepth, Number(queueCountRow.queued ?? 0));
    const snapshot: RunSnapshot = {
      at: new Date(nowMs).toISOString(),
      elapsedMs: nowMs - startedAtMs,
      completedArtists: completedDownloads,
      failedArtists: failedWorkflows,
      terminalPrimaryArtists: cycleTerminal.size,
      activeCommands: Number(queueCountRow.started ?? 0),
      queueDepth: Number(queueCountRow.queued ?? 0),
      eligibleQueueDepth: eligible.length,
      completedCreditedArtists: completedCredits.size,
      failedCreditedArtists: failedCredits.size,
      oldestEligibleCommandAgeMs: oldestEligibleAge,
      oldestHeartbeatAgeMs: oldestHeartbeatAge,
      database: {
        databaseBytes: databaseFileSize(paths.databasePath),
        walBytes,
        pageCount: Number(db.pragma("page_count", { simple: true })),
        pageSize: Number(db.pragma("page_size", { simple: true })),
        readLatencyMs: databaseReadLatencyMs,
      },
      eventLoop: {
        meanMs: Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1_000_000 : 0,
        p95Ms: eventLoop.percentile(95) / 1_000_000,
        p99Ms: eventLoop.percentile(99) / 1_000_000,
        maxMs: eventLoop.max / 1_000_000,
      },
      apiLatency: null,
      apiLatencyReason: "Synthetic DB runner does not launch the HTTP API; Docker/API layer must measure this.",
      sseDelay: null,
      sseDelayReason: "Synthetic DB runner does not launch SSE; Docker/browser layer must measure this.",
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
      cpu: {
        userMicros: nowCpu.user,
        systemMicros: nowCpu.system,
        percentOfOneCore: cpuPercent,
      },
      workers: {
        configured: options.concurrency,
        live: activeWorkers.length,
        busy: busyWorkers,
        idle: activeWorkers.filter((worker) => worker.status === "idle").length,
        utilization: activeWorkers.length > 0 ? busyWorkers / activeWorkers.length : 0,
        busyRetries: activeWorkers.reduce((sum, worker) => sum + worker.busyRetries, 0),
        meanClaimLatencyMs: totalClaimed > 0 ? weightedClaimLatency / totalClaimed : 0,
      },
      recovery: {
        workerDeaths,
        expiredLeases,
        requeued: recoveredCommands,
        terminalFailures: recoveryTerminalFailures,
      },
      lastProgressTransition,
      failureEvents,
    };
    maxEventLoopP99Ms = Math.max(maxEventLoopP99Ms, snapshot.eventLoop.p99Ms);
    maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, snapshot.eventLoop.maxMs);
    maxDatabaseReadLatencyMs = Math.max(
      maxDatabaseReadLatencyMs,
      snapshot.database.readLatencyMs,
    );
    maxOldestEligibleAgeMs = Math.max(
      maxOldestEligibleAgeMs,
      snapshot.oldestEligibleCommandAgeMs ?? 0,
    );
    maxRssBytes = Math.max(maxRssBytes, snapshot.memory.rssBytes);
    maxWorkerBusyRetries = Math.max(maxWorkerBusyRetries, snapshot.workers.busyRetries);
    maxMeanClaimLatencyMs = Math.max(
      maxMeanClaimLatencyMs,
      snapshot.workers.meanClaimLatencyMs,
    );
    eventLoop.reset();
    metricsSamples += 1;
    appendNdjson(paths.metricsPath, snapshot);
    writeJson(paths.heartbeatPath, {
      format: SYNTHETIC_RUN_FORMAT,
      runId: manifest.runId,
      startTime: startedAt.toISOString(),
      lastHeartbeat: snapshot.at,
      status: "running",
      ...snapshot,
    });
    return snapshot;
  };

  try {
    while (Date.now() - startedAtMs < options.timeoutMs) {
      recoverExpiredLeases();
      let rows = getCommandRows(db, manifest.runId);
      const terminalCurrent = terminalPrimaryIndexes(rows, manifest.runId, currentCycle);
      if (terminalCurrent.size !== lastTerminalPrimaryCount) {
        lastTerminalPrimaryCount = terminalCurrent.size;
        lastProgressTransition = new Date().toISOString();
        if (terminalCurrent.size === expected.artists.primary) {
          lastPrimaryTerminalAt = lastProgressTransition;
        }
      }

      const admittedCredits = enqueueCredited(rows, currentCycle);
      if (admittedCredits > 0) rows = getCommandRows(db, manifest.runId);
      promoteCreditedFairness(rows, terminalCurrent.size);

      const active = rows.filter((row) => row.status === "queued" || row.status === "started");
      const eligibleQueued = rows.filter((row) => (
        row.status === "queued"
        && (!row.retry_after || Date.parse(row.retry_after) <= Date.now())
      ));
      const started = rows.filter((row) => row.status === "started");
      if (eligibleQueued.length > 0 && started.length === 0) {
        eligibleIdleSince ??= Date.now();
        if (Date.now() - eligibleIdleSince > Math.max(1_000, options.leaseMs)) {
          failureEvents += 1;
          appendNdjson(paths.eventsPath, {
            at: new Date().toISOString(),
            type: "global_idle_with_eligible_work",
            eligibleQueueDepth: eligibleQueued.length,
            idleMs: Date.now() - eligibleIdleSince,
          });
          eligibleIdleSince = Date.now();
        }
      } else {
        eligibleIdleSince = null;
      }

      const completedCredits = completedCreditedIndexes(rows, manifest.runId).size;
      const failedCredits = failedCreditedIndexes(rows, manifest.runId).size;
      const allCreditsTerminal = completedCredits + failedCredits === creditedEdges.length;
      const currentGlobal = rows.find((row) => row.ref_id === globalRef(manifest.runId, currentCycle));
      if (terminalCurrent.size === expected.artists.primary && allCreditsTerminal && !currentGlobal) {
        queueGlobalReconciliation(currentCycle);
        rows = getCommandRows(db, manifest.runId);
      }
      const globalAfterQueue = rows.find((row) => row.ref_id === globalRef(manifest.runId, currentCycle));
      if (globalAfterQueue?.status === "completed") {
        if (currentCycle < options.cycles) {
          currentCycle += 1;
          lastTerminalPrimaryCount = 0;
          fairnessPromotionBucket = 0;
          enqueuePrimaryCycle(currentCycle);
          rows = getCommandRows(db, manifest.runId);
        } else {
          const remaining = rows.filter((row) => row.status === "queued" || row.status === "started");
          if (remaining.length === 0) {
            completedNormally = true;
            break;
          }
        }
      }

      if (Date.now() - lastMetricsAt >= options.metricsMs) {
        sampleMetrics(rows);
        lastMetricsAt = Date.now();
      }
      await sleep(50);
    }
  } finally {
    stopping = true;
    for (const state of workerStates.values()) {
      state.status = "stopping";
      state.worker.postMessage({ type: "stop" });
    }
    await Promise.allSettled(
      [...workerStates.values()].map((state) => new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          void state.worker.terminate().finally(() => resolve());
        }, Math.max(1_000, options.leaseMs));
        state.worker.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      })),
    );
  }

  const finalRows = getCommandRows(db, manifest.runId);
  const quickCheck = String(db.pragma("quick_check", { simple: true }));
  const foreignKeyErrors = db.pragma("foreign_key_check") as unknown[];
  const finalCounts = {
    artistsCanonical: Number((db.prepare("SELECT COUNT(*) AS count FROM ArtistMetadata").get() as { count: number }).count),
    artistsLegacy: Number((db.prepare("SELECT COUNT(*) AS count FROM Artists").get() as { count: number }).count),
    managedArtists: Number((db.prepare("SELECT COUNT(*) AS count FROM ManagedArtists").get() as { count: number }).count),
    albums: Number((db.prepare("SELECT COUNT(*) AS count FROM Albums").get() as { count: number }).count),
    editions: Number((db.prepare("SELECT COUNT(*) AS count FROM AlbumEditions").get() as { count: number }).count),
    recordings: Number((db.prepare("SELECT COUNT(*) AS count FROM Recordings").get() as { count: number }).count),
    tracks: Number((db.prepare("SELECT COUNT(*) AS count FROM Tracks").get() as { count: number }).count),
    providerItems: Number((db.prepare("SELECT COUNT(*) AS count FROM ProviderItems").get() as { count: number }).count),
    providerArtistMatches: Number((db.prepare("SELECT COUNT(*) AS count FROM ProviderArtistMatches").get() as { count: number }).count),
    providerEditionMatches: Number((db.prepare("SELECT COUNT(*) AS count FROM ProviderEditionMatches").get() as { count: number }).count),
    providerTrackMatches: Number((db.prepare("SELECT COUNT(*) AS count FROM ProviderTrackMatches").get() as { count: number }).count),
    providerVideoMatches: Number((db.prepare("SELECT COUNT(*) AS count FROM ProviderVideoMatches").get() as { count: number }).count),
    audioVariants: Number((db.prepare("SELECT COUNT(*) AS count FROM ProviderItemAudioVariants").get() as { count: number }).count),
    libraryArtists: Number((db.prepare("SELECT COUNT(*) AS count FROM LibraryArtists").get() as { count: number }).count),
    libraryAlbums: Number((db.prepare("SELECT COUNT(*) AS count FROM LibraryAlbums").get() as { count: number }).count),
    libraryEditions: Number((db.prepare("SELECT COUNT(*) AS count FROM LibraryEditions").get() as { count: number }).count),
    libraryVideos: Number((db.prepare("SELECT COUNT(*) AS count FROM LibraryVideos").get() as { count: number }).count),
    inlineVideos: Number((db.prepare("SELECT COUNT(*) AS count FROM LibraryVideos WHERE placement_mode = 'inline'").get() as { count: number }).count),
    plans: Number((db.prepare("SELECT COUNT(*) AS count FROM AcquisitionPlans").get() as { count: number }).count),
    planSources: Number((db.prepare("SELECT COUNT(*) AS count FROM AcquisitionPlanSources").get() as { count: number }).count),
    planTracks: Number((db.prepare("SELECT COUNT(*) AS count FROM AcquisitionPlanTracks").get() as { count: number }).count),
    trackFiles: Number((db.prepare("SELECT COUNT(*) AS count FROM TrackFiles").get() as { count: number }).count),
    unmappedFiles: Number((db.prepare("SELECT COUNT(*) AS count FROM UnmappedFiles").get() as { count: number }).count),
    history: Number((db.prepare(`
      SELECT COUNT(*) AS count FROM commands WHERE ref_id >= ? AND ref_id < ?
    `).get(
      `synthetic-history-${manifest.seed}-`,
      `synthetic-history-${manifest.seed}-\uffff`,
    ) as { count: number }).count),
  };
  const fileRows = db.prepare(`
    SELECT file_path FROM TrackFiles
    UNION ALL
    SELECT file_path FROM UnmappedFiles
  `).all() as Array<{ file_path: string }>;
  const filesOutsideRun = fileRows.filter((row) => {
    const relative = path.relative(paths.mediaRoot, path.resolve(row.file_path));
    return relative.startsWith("..") || path.isAbsolute(relative);
  });
  const missingFiles = fileRows.filter((row) => !fs.existsSync(row.file_path));
  const finalPrimaryDownloads = completedPrimaryDownloads(finalRows, manifest.runId, options.cycles);
  const finalPrimaryFailures = failedPrimaryWorkflows(finalRows, manifest.runId, options.cycles);
  const finalCompletedCredits = completedCreditedIndexes(finalRows, manifest.runId).size;
  const finalFailedCredits = failedCreditedIndexes(finalRows, manifest.runId).size;
  const expectedPoisonPerCycle = options.injectFailures ? expected.behavior.poison : 0;
  const expectedSuccessfulPrimary = (expected.artists.primary - expectedPoisonPerCycle) * options.cycles;
  const expectedFailedPrimary = expectedPoisonPerCycle * options.cycles;
  const terminalStatuses = finalRows.filter((row) => row.status === "queued" || row.status === "started");
  const globalCompleted = Array.from({ length: options.cycles }, (_, index) => index + 1)
    .filter((cycle) => finalRows.some((row) => (
      row.ref_id === globalRef(manifest.runId, cycle) && row.status === "completed"
    ))).length;
  const retryRecovered = finalRows.filter((row) => row.attempt > 1 && row.status === "completed").length;
  const expectedRecoveryEvents = options.injectFailures
    ? (expected.behavior.worker_crash + expected.behavior.worker_hang) * options.cycles
    : 0;
  const expectedExpiredLeases = options.injectFailures
    ? expected.behavior.worker_hang * options.cycles
    : 0;

  const assertEqual = (
    name: string,
    actual: unknown,
    expectedValue: unknown,
    severity: AssertionResult["severity"] = "blocking",
  ): void => {
    assertionNotes.push({
      name,
      pass: Object.is(actual, expectedValue),
      expected: expectedValue,
      actual,
      severity,
    });
  };
  assertEqual("schema version", schemaVersion, 42);
  assertEqual("PRAGMA quick_check", quickCheck, "ok");
  assertEqual("foreign_key_check rows", foreignKeyErrors.length, 0);
  assertEqual("canonical Artist count", finalCounts.artistsCanonical, expected.artists.canonical);
  assertEqual("legacy Artist count", finalCounts.artistsLegacy, expected.artists.legacy);
  assertEqual("managed Artist count", finalCounts.managedArtists, expected.artists.managed);
  assertEqual("Album count", finalCounts.albums, expected.catalogue.albums);
  assertEqual("Edition count", finalCounts.editions, expected.catalogue.editions);
  assertEqual("Recording count", finalCounts.recordings, expected.catalogue.recordings);
  assertEqual("Track count", finalCounts.tracks, expected.catalogue.tracks);
  assertEqual("ProviderItems count", finalCounts.providerItems, expected.provider.items);
  assertEqual("ProviderArtistMatches count", finalCounts.providerArtistMatches, expected.provider.artistMatches);
  assertEqual("ProviderEditionMatches count", finalCounts.providerEditionMatches, expected.provider.editionMatches);
  assertEqual("ProviderTrackMatches count", finalCounts.providerTrackMatches, expected.provider.trackMatches);
  assertEqual("ProviderVideoMatches count", finalCounts.providerVideoMatches, expected.provider.videoMatches);
  assertEqual("audio variant count", finalCounts.audioVariants, expected.provider.audioVariants);
  assertEqual("LibraryArtists count", finalCounts.libraryArtists, expected.curation.libraryArtists);
  assertEqual("LibraryAlbums count", finalCounts.libraryAlbums, expected.curation.libraryAlbums);
  assertEqual("LibraryEditions count", finalCounts.libraryEditions, expected.curation.libraryEditions);
  assertEqual("LibraryVideos count", finalCounts.libraryVideos, expected.curation.libraryVideos);
  assertEqual("inline video winners", finalCounts.inlineVideos, expected.curation.inlineVideos);
  assertEqual("AcquisitionPlans count", finalCounts.plans, expected.curation.plans);
  assertEqual("AcquisitionPlanSources count", finalCounts.planSources, expected.curation.planSources);
  assertEqual("AcquisitionPlanTracks count", finalCounts.planTracks, expected.curation.planTracks);
  assertEqual("TrackFiles count", finalCounts.trackFiles, expected.files.trackFiles);
  assertEqual("UnmappedFiles count", finalCounts.unmappedFiles, expected.files.unmappedFiles);
  assertEqual("historical command count", finalCounts.history, expected.commands.history);
  assertEqual("file rows outside disposable media root", filesOutsideRun.length, 0);
  assertEqual("file rows missing physical placeholder", missingFiles.length, 0);
  assertEqual("non-terminal synthetic commands", terminalStatuses.length, 0);
  assertEqual("successful primary workflows", finalPrimaryDownloads, expectedSuccessfulPrimary);
  assertEqual("visibly failed primary workflows", finalPrimaryFailures, expectedFailedPrimary);
  assertEqual("completed credited hydration", finalCompletedCredits, expected.artists.credited);
  assertEqual("failed credited hydration", finalFailedCredits, 0);
  assertEqual("global reconciliations", globalCompleted, options.cycles);
  assertEqual("run reached deterministic completion", completedNormally, true);
  assertionNotes.push({
    name: "WAL remained below the production 64 MiB journal size limit",
    pass: maxWalBytes <= 64 * 1024 * 1024,
    expected: "<= 67108864 bytes",
    actual: maxWalBytes,
    severity: "blocking",
  });
  assertionNotes.push({
    name: "synthetic coordinator event-loop p99 observation",
    pass: maxEventLoopP99Ms <= 500,
    expected: "<= 500 ms (warning budget; not HTTP API latency)",
    actual: maxEventLoopP99Ms,
    severity: "warning",
  });
  assertionNotes.push({
    name: "synthetic command-state read latency observation",
    pass: maxDatabaseReadLatencyMs <= 100,
    expected: "<= 100 ms (warning budget)",
    actual: maxDatabaseReadLatencyMs,
    severity: "warning",
  });
  assertionNotes.push({
    name: "first monitored Artist became download-ready before all primary Artists terminated",
    pass: expected.artists.primary <= 1
      || (
        firstPrimaryDownloadReadyAt != null
        && firstPrimaryDownloadReadyTerminalCount != null
        && firstPrimaryDownloadReadyTerminalCount < expected.artists.primary
      ),
    expected: `< ${expected.artists.primary} terminal primary Artists`,
    actual: firstPrimaryDownloadReadyTerminalCount,
    severity: "blocking",
  });
  assertionNotes.push({
    name: "credited hydration made progress before the last primary Artist terminated",
    pass: expected.artists.primary < 20
      || expected.artists.credited === 0
      || (
        firstCreditedCompletedAt != null
        && lastPrimaryTerminalAt != null
        && Date.parse(firstCreditedCompletedAt) <= Date.parse(lastPrimaryTerminalAt)
      ),
    expected: "credited completion timestamp <= last primary terminal timestamp",
    actual: { firstCreditedCompletedAt, lastPrimaryTerminalAt },
    severity: "blocking",
  });
  assertionNotes.push({
    name: "injected worker death/hang recovery observed",
    pass: recoveredCommands === expectedRecoveryEvents,
    expected: expectedRecoveryEvents,
    actual: recoveredCommands,
    severity: "blocking",
  });
  assertEqual("expired leases match injected hangs", expiredLeases, expectedExpiredLeases);
  assertEqual("worker deaths match injected crash/hang count", workerDeaths, expectedRecoveryEvents);
  assertEqual("recovery attempts exhausted unexpectedly", recoveryTerminalFailures, 0);
  assertionNotes.push({
    name: "bounded retry recovered transient/interrupted work",
    pass: !options.injectFailures
      || (expected.behavior.transient_failure + expected.behavior.worker_crash + expected.behavior.worker_hang === 0)
      || retryRecovered > 0,
    expected: "> 0 completed command with attempt > 1 when recoverable failures exist",
    actual: retryRecovered,
    severity: "blocking",
  });

  const blockingFailures = assertionNotes.filter((assertion) => (
    assertion.severity === "blocking" && !assertion.pass
  ));
  const endedAt = new Date();
  const finalSummary = {
    format: SYNTHETIC_RUN_FORMAT,
    runId: manifest.runId,
    status: blockingFailures.length === 0 ? "passed" : "failed",
    startTime: startedAt.toISOString(),
    endTime: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAtMs,
    gitSha: manifest.gitSha,
    schemaVersion,
    options,
    dataset: manifest.configuration,
    integrity: {
      quickCheck,
      foreignKeyErrors: foreignKeyErrors.length,
    },
    progress: {
      completedArtists: finalPrimaryDownloads,
      failedArtists: finalPrimaryFailures,
      completedCreditedArtists: finalCompletedCredits,
      failedCreditedArtists: finalFailedCredits,
      firstPrimaryDownloadReadyAt,
      firstPrimaryDownloadReadyTerminalCount,
      firstCreditedCompletedAt,
      lastPrimaryTerminalAt,
    },
    queue: {
      active: finalRows.filter((row) => row.status === "started").length,
      queued: finalRows.filter((row) => row.status === "queued").length,
      failed: finalRows.filter((row) => row.status === "failed").length,
      maxQueueDepth,
    },
    database: {
      databaseBytes: databaseFileSize(paths.databasePath),
      walBytes: databaseFileSize(`${paths.databasePath}-wal`),
      maxWalBytes,
    },
    performance: {
      maxEventLoopP99Ms,
      maxEventLoopDelayMs,
      maxDatabaseReadLatencyMs,
      maxOldestEligibleAgeMs,
      maxRssBytes,
      maxWorkerBusyRetries,
      maxMeanClaimLatencyMs,
      apiLatency: null,
      sseDelay: null,
    },
    recovery: {
      workerDeaths,
      expiredLeases,
      recoveredCommands,
      terminalFailures: recoveryTerminalFailures,
      retryRecovered,
    },
    metricsSamples,
    failureEvents,
    counts: finalCounts,
    assertions: assertionNotes,
    blockers: blockingFailures.map((assertion) => assertion.name),
    limitations: [
      "Production command handlers were not invoked; deterministic synthetic workers own only this guarded run.",
      "HTTP API latency and SSE delay remain null and require the Docker/API layer.",
      "Synthetic media bytes are intentionally not valid codecs and do not prove ffmpeg/tag/import behavior.",
      "This result does not substitute for local MusicBrainz, Servarr, provider, browser, or long-soak runs.",
    ],
  };
  writeJson(paths.finalPath, finalSummary);
  writeJson(paths.heartbeatPath, {
    format: SYNTHETIC_RUN_FORMAT,
    runId: manifest.runId,
    startTime: startedAt.toISOString(),
    lastHeartbeat: endedAt.toISOString(),
    status: finalSummary.status,
    completedArtists: finalPrimaryDownloads,
    failedArtists: finalPrimaryFailures,
    activeCommands: 0,
    queueDepth: terminalStatuses.length,
    finalResult: paths.finalPath,
  });
  appendNdjson(paths.eventsPath, {
    at: endedAt.toISOString(),
    type: "load_run_completed",
    status: finalSummary.status,
    durationMs: finalSummary.durationMs,
    blockers: finalSummary.blockers,
  });
  eventLoop.disable();
  db.close();

  console.log(JSON.stringify({
    status: finalSummary.status,
    runId: manifest.runId,
    durationMs: finalSummary.durationMs,
    final: paths.finalPath,
    metrics: paths.metricsPath,
    events: paths.eventsPath,
    blockers: finalSummary.blockers,
  }, null, 2));
  if (blockingFailures.length > 0) {
    process.exitCode = 1;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return invoked === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}

export { parseOptions, run };
