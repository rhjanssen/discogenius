import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";

interface SyntheticWorkerData {
  databasePath: string;
  runId: string;
  workerId: string;
  leaseMs: number;
  heartbeatMs: number;
  maxAttempts: number;
  latencyScale: number;
  injectFailures: boolean;
}

interface SyntheticPayload {
  artistId?: string;
  artistName?: string;
  syntheticLoad?: {
    runId: string;
    role: "primary" | "credited" | "preexisting_download" | "global";
    artistIndex?: number;
    index?: number;
    cycle?: number;
    stage: string;
    behavior?: {
      kind?: "normal" | "slow" | "transient_failure" | "poison" | "worker_crash" | "worker_hang";
      stage?: string;
    };
  };
  [key: string]: unknown;
}

interface ClaimedCommand {
  id: number;
  name: string;
  ref_id: string;
  payload: string;
  priority: number;
  trigger: number;
  queue_order: number;
  attempt: number;
}

const config = workerData as SyntheticWorkerData;
if (!parentPort) {
  throw new Error("Synthetic load worker must run in a worker thread");
}

const db = new Database(config.databasePath, { timeout: 5_000 });
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
// Keep a single native wait below the heartbeat cadence. A five-second
// better-sqlite3 busy wait blocks this worker's JS heartbeat and makes a healthy
// DB waiter indistinguishable from a dead worker.
db.pragma(`busy_timeout = ${Math.max(10, Math.min(100, config.heartbeatMs))}`);

const runRefStart = `rh:${config.runId}:`;
const runRefEnd = `${runRefStart}\uffff`;
let stopping = false;
let busyRetries = 0;
let claimed = 0;
let completed = 0;
let failed = 0;
let cumulativeClaimLatencyMs = 0;
let activeCommandId: number | null = null;
let waitingOnDatabase = false;
let suppressWorkerHeartbeat = false;

const workerHeartbeatTimer = setInterval(() => {
  if (suppressWorkerHeartbeat) return;
  post({
    type: "worker_heartbeat",
    commandId: activeCommandId,
    blockedReason: waitingOnDatabase ? "waiting on database" : null,
  });
}, Math.max(10, config.heartbeatMs));
workerHeartbeatTimer.unref();

parentPort.on("message", (message: { type?: string }) => {
  if (message?.type === "stop") {
    stopping = true;
  }
});

function post(message: Record<string, unknown>): void {
  parentPort?.postMessage({
    at: new Date().toISOString(),
    workerId: config.workerId,
    ...message,
  });
}

function isBusy(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate?.code === "SQLITE_BUSY"
    || candidate?.code === "SQLITE_LOCKED"
    || /database is (?:locked|busy)/i.test(String(candidate?.message ?? ""));
}

async function withBusyRetry<T>(operation: () => T, attempts = 20): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      const result = operation();
      waitingOnDatabase = false;
      return result;
    } catch (error) {
      if (!isBusy(error) || attempt >= attempts) {
        waitingOnDatabase = false;
        throw error;
      }
      lastError = error;
      waitingOnDatabase = true;
      busyRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 2 ** Math.min(attempt, 6))));
    }
  }
  throw lastError;
}

function leaseExpiry(): string {
  return new Date(Date.now() + config.leaseMs).toISOString();
}

async function claimNext(): Promise<ClaimedCommand | null> {
  const started = performance.now();
  const result = await withBusyRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = db.prepare(`
        SELECT id, name, ref_id, payload, priority, trigger, queue_order, attempt
        FROM commands
        WHERE status = 'queued'
          AND ref_id >= ? AND ref_id < ?
          AND (retry_after IS NULL OR julianday(retry_after) <= julianday('now'))
        ORDER BY priority DESC, trigger DESC, queue_order ASC, created_at ASC, id ASC
        LIMIT 1
      `).get(runRefStart, runRefEnd) as ClaimedCommand | undefined;
      if (!candidate) {
        db.exec("COMMIT");
        return null;
      }
      const now = new Date().toISOString();
      const update = db.prepare(`
        UPDATE commands
        SET status = 'started',
            progress = 1,
            attempts = attempts + 1,
            attempt = attempt + 1,
            worker_id = ?,
            heartbeat_at = ?,
            last_progress_at = ?,
            progress_phase = 'claimed',
            progress_current = 0,
            progress_total = 3,
            lease_expires_at = ?,
            blocked_reason = NULL,
            retry_after = NULL,
            error = NULL,
            started_at = ?,
            completed_at = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(
        config.workerId,
        now,
        now,
        leaseExpiry(),
        now,
        now,
        candidate.id,
      );
      if (update.changes !== 1) {
        db.exec("ROLLBACK");
        return null;
      }
      db.exec("COMMIT");
      candidate.attempt += 1;
      return candidate;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The statement may have failed before BEGIN acquired the lock.
      }
      throw error;
    }
  });
  cumulativeClaimLatencyMs += performance.now() - started;
  if (result) claimed += 1;
  return result;
}

async function updateProgress(
  command: ClaimedCommand,
  phase: string,
  current: number,
  total: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await withBusyRetry(() => db.prepare(`
    UPDATE commands
    SET progress = ?,
        heartbeat_at = ?,
        last_progress_at = ?,
        progress_phase = ?,
        progress_current = ?,
        progress_total = ?,
        lease_expires_at = ?,
        blocked_reason = NULL,
        updated_at = ?
    WHERE id = ? AND status = 'started' AND worker_id = ?
  `).run(
    Math.min(95, Math.max(1, Math.round((current / Math.max(1, total)) * 90))),
    now,
    now,
    phase,
    current,
    total,
    leaseExpiry(),
    now,
    command.id,
    config.workerId,
  ));
  return result.changes === 1;
}

async function delayWithHeartbeat(
  command: ClaimedCommand,
  phase: string,
  current: number,
  total: number,
  durationMs: number,
): Promise<boolean> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const owned = await updateProgress(command, phase, current, total);
    if (!owned) return false;
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(config.heartbeatMs, Math.max(1, remaining))));
  }
  return updateProgress(command, phase, current, total);
}

function nextStage(stage: string): string | null {
  const order = [
    "RefreshArtist",
    "MatchArtistProviders",
    "RescanFolders",
    "CurateArtist",
    "DownloadMissing",
  ];
  const index = order.indexOf(stage);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : null;
}

function nextRef(payload: SyntheticPayload, stage: string): string {
  const synthetic = payload.syntheticLoad;
  if (!synthetic || synthetic.role !== "primary") {
    throw new Error("Only primary synthetic workflows have a next stage");
  }
  return `rh:${config.runId}:p:${synthetic.artistIndex}:c:${synthetic.cycle ?? 1}:s:${stage}`;
}

async function completeCommand(command: ClaimedCommand, payload: SyntheticPayload): Promise<boolean> {
  const synthetic = payload.syntheticLoad;
  if (!synthetic) throw new Error("Synthetic command has no syntheticLoad payload");
  const stage = synthetic.stage;
  const followingStage = synthetic.role === "primary" ? nextStage(stage) : null;
  return withBusyRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const update = db.prepare(`
        UPDATE commands
        SET status = 'completed',
            progress = 100,
            heartbeat_at = ?,
            last_progress_at = ?,
            progress_phase = 'completed',
            progress_current = 3,
            progress_total = 3,
            lease_expires_at = NULL,
            blocked_reason = NULL,
            retry_after = NULL,
            error = NULL,
            completed_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'started' AND worker_id = ?
      `).run(now, now, now, now, command.id, config.workerId);
      if (update.changes !== 1) {
        db.exec("ROLLBACK");
        return false;
      }
      if (followingStage) {
        const nextPayload: SyntheticPayload = {
          ...payload,
          syntheticLoad: {
            ...synthetic,
            stage: followingStage,
          },
        };
        const inserted = db.prepare(`
          INSERT INTO commands (
            name, ref_id, payload, status, progress, priority, trigger,
            queue_order, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, 'queued', 0, 10, ?, NULL, 0, ?, ?)
        `).run(
          followingStage,
          nextRef(payload, followingStage),
          JSON.stringify(nextPayload),
          command.trigger,
          now,
          now,
        );
        const nextId = Number(inserted.lastInsertRowid);
        db.prepare("UPDATE commands SET queue_order = ? WHERE id = ?").run(nextId, nextId);
      }
      db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure and report the original error.
      }
      throw error;
    }
  });
}

async function failOrRetry(command: ClaimedCommand, error: Error): Promise<"failed" | "requeued" | "not-owner"> {
  const terminal = command.attempt >= config.maxAttempts;
  const now = new Date().toISOString();
  const retryAt = new Date(Date.now() + Math.min(1_000, 25 * 2 ** Math.max(0, command.attempt - 1))).toISOString();
  const result = await withBusyRetry(() => db.prepare(`
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
    terminal ? "poisoned synthetic command" : "synthetic retry backoff",
    terminal ? null : retryAt,
    error.message,
    error.message,
    terminal ? now : null,
    now,
    command.id,
    config.workerId,
  ));
  if (result.changes !== 1) return "not-owner";
  return terminal ? "failed" : "requeued";
}

function stageDurationMs(payload: SyntheticPayload, stage: string): number {
  const synthetic = payload.syntheticLoad;
  const index = Number(synthetic?.artistIndex ?? synthetic?.index ?? 0);
  const stageHash = [...stage].reduce((total, character) => total + character.charCodeAt(0), 0);
  const base = 2 + ((index * 17 + stageHash) % 7);
  const slow = synthetic?.behavior?.kind === "slow" && synthetic.behavior.stage === stage;
  return Math.max(1, Math.round(base * config.latencyScale * (slow ? 25 : 1)));
}

async function processCommand(command: ClaimedCommand): Promise<void> {
  const payload = JSON.parse(command.payload) as SyntheticPayload;
  const synthetic = payload.syntheticLoad;
  if (!synthetic || synthetic.runId !== config.runId) {
    throw new Error(`Worker claimed a non-synthetic command ${command.id}`);
  }
  const behavior = synthetic.behavior ?? { kind: "normal" as const };
  activeCommandId = command.id;
  const behaviorApplies = behavior.stage === synthetic.stage;
  post({
    type: "command_claimed",
    commandId: command.id,
    commandName: command.name,
    refId: command.ref_id,
    attempt: command.attempt,
    role: synthetic.role,
    stage: synthetic.stage,
    artistIndex: synthetic.artistIndex,
  });

  if (config.injectFailures && behaviorApplies && behavior.kind === "worker_crash" && command.attempt === 1) {
    post({
      type: "failure_injected",
      failure: "worker_crash",
      commandId: command.id,
      stage: synthetic.stage,
    });
    // Give the failure event one turn to leave the message port, then die while
    // still owning exactly this command. Never return to the claim loop.
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.exit(86);
  }
  if (config.injectFailures && behaviorApplies && behavior.kind === "worker_hang" && command.attempt === 1) {
    suppressWorkerHeartbeat = true;
    post({
      type: "failure_injected",
      failure: "worker_hang",
      commandId: command.id,
      stage: synthetic.stage,
    });
    setInterval(() => {
      // Deliberately no DB heartbeat. Parent watchdog must recover this lease.
    }, 60_000);
    await new Promise<void>(() => {
      // Deliberately unresolved.
    });
    return;
  }
  if (config.injectFailures && behaviorApplies && behavior.kind === "transient_failure" && command.attempt === 1) {
    throw new Error(`deterministic transient ${synthetic.stage} failure`);
  }
  if (config.injectFailures && behaviorApplies && behavior.kind === "poison") {
    throw new Error(`deterministic poisoned ${synthetic.stage} command`);
  }

  const duration = stageDurationMs(payload, synthetic.stage);
  for (let phase = 1; phase <= 3; phase += 1) {
    const owned = await delayWithHeartbeat(
      command,
      `${synthetic.stage.toLowerCase()}:${phase}`,
      phase,
      3,
      Math.ceil(duration / 3),
    );
    if (!owned) {
      post({
        type: "ownership_lost",
        commandId: command.id,
        stage: synthetic.stage,
      });
      return;
    }
  }
  const didComplete = await completeCommand(command, payload);
  if (didComplete) {
    completed += 1;
    post({
      type: "command_completed",
      commandId: command.id,
      commandName: command.name,
      refId: command.ref_id,
      attempt: command.attempt,
      role: synthetic.role,
      stage: synthetic.stage,
      artistIndex: synthetic.artistIndex,
      cycle: synthetic.cycle ?? 1,
    });
  } else {
    post({
      type: "ownership_lost",
      commandId: command.id,
      stage: synthetic.stage,
    });
  }
}

async function main(): Promise<void> {
  post({ type: "worker_started" });
  while (!stopping) {
    try {
      const command = await claimNext();
      if (!command) {
        post({
          type: "worker_idle",
          claimed,
          completed,
          failed,
          busyRetries,
          meanClaimLatencyMs: claimed > 0 ? cumulativeClaimLatencyMs / claimed : 0,
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      try {
        await processCommand(command);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        const disposition = await failOrRetry(command, normalized);
        if (disposition === "failed") failed += 1;
        post({
          type: "command_error",
          commandId: command.id,
          commandName: command.name,
          refId: command.ref_id,
          attempt: command.attempt,
          disposition,
          error: normalized.message,
        });
      } finally {
        activeCommandId = null;
        waitingOnDatabase = false;
      }
    } catch (error) {
      post({
        type: "worker_error",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  db.close();
  clearInterval(workerHeartbeatTimer);
  post({
    type: "worker_stopped",
    claimed,
    completed,
    failed,
    busyRetries,
    meanClaimLatencyMs: claimed > 0 ? cumulativeClaimLatencyMs / claimed : 0,
  });
  parentPort?.close();
}

main().catch((error) => {
  post({
    type: "worker_fatal",
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exitCode = 1;
});
