# Job Execution & Threading — Lidarr Parity Plan

**Status:** Done. The pragmatic mitigations (§3) plus the full worker_threads
refactor (§4) are implemented and **always on** — the command executor and the
heavy import step run on worker threads, mirroring Lidarr's `CommandExecutor`
(no single/multi toggle). See §5 for what shipped.

## 1. How Lidarr avoids choking

- `CommandExecutor` spawns **3 real OS threads** (`THREAD_LIMIT = 3`) at startup,
  each looping over a blocking command queue (`CommandQueueManager`) and executing
  commands. (`Jobs/Scheduler.cs` is just a 30s timer that *enqueues* due
  `ScheduledTask`s; `TaskManager.cs` holds the task intervals.)
- The HTTP API runs on **separate ASP.NET request threads**, and EF Core uses a
  **DB connection pool**. So a heavy command (RefreshArtist, etc.) runs on a
  background thread and never blocks request handling. True parallelism.

## 2. Why Discogenius chokes

- Node executes JS on **one thread** (one event loop). Our `Scheduler.loop()`
  already mirrors Lidarr's design — a queue + up to `SCHEDULER_THREAD_LIMIT`
  concurrent jobs — but those "slots" are **async Promises on the same event
  loop, not OS threads.**
- `better-sqlite3` is **synchronous**: every query/transaction blocks the entire
  event loop for its duration — including all in-flight HTTP requests *and* the
  other "concurrent" jobs. Concurrency is only real at `await` points (network
  I/O); synchronous DB work serializes and blocks everything.
- Net: one slow query (the 38s `/api/stats`, 128s artist page, 15s `/api/v1/queue`
  — all since fixed) or a long synchronous scan write freezes the whole app.

## 3. Pragmatic mitigations (DONE)

These remove most real-world choking without a rewrite:
- **Fix slow queries** — a single slow synchronous query blocks the loop
  regardless of threading, so this is the highest-leverage fix. Done for
  stats/page-db/queue via indexing (`idx_recordings_*`, `idx_provider_items_provider_id`,
  release-group-scoped rewrites). See [[discogenius-perf-facts]].
- **Cooperative yielding** — `Scheduler.yieldToEventLoop()` (`setImmediate`)
  between artists in the heavy inline loops (RefreshMetadata monitoring cycle,
  RenameArtist, RetagArtist) so a long batch hands the loop back to the API
  between units. Helps "many small units"; does **not** help a single huge
  synchronous transaction.

## 4. True parallelism (worker_threads) — the follow-up

Node's real-thread primitive is `worker_threads`. better-sqlite3 works inside a
worker (open a **separate** connection to the same file; WAL allows concurrent
readers + one writer). Target architecture:

- **Main thread:** HTTP API + SSE only. Never runs heavy DB/scan work.
- **Job worker thread(s):** run the command executor + heavy services
  (RefreshArtist, RescanFolders, Curation, DownloadMissing, Housekeeping), each
  with its own DB connection. This is the direct analogue of Lidarr's
  `CommandExecutor` threads.
- **Message bridge (the hard part):** today many services share **in-process
  memory** that a worker thread would not see:
  - download-state caches (`Map`s in `download-state.ts`),
  - SSE/event fan-out (`app-events`, the global event stream),
  - monitoring progress / `isChecking` flags.
  Workers communicate via `postMessage`, so these need an explicit bridge:
  worker → main "invalidate cache X" / "emit SSE event Y" / "progress update",
  and main → worker "cancel job". Without it, the UI wouldn't see progress and
  caches would go stale across the thread boundary.

### Phased approach
1. **Extract a clean job entrypoint** the worker can call (job type + payload →
   result), with no reliance on main-thread singletons beyond the DB.
2. **Define the message protocol** (events, cache invalidation, progress, cancel).
3. **Move the download processor first** (it's already the most isolated worker
   and the heaviest IO) into a worker thread; validate SSE/progress still flow.
4. **Move the command executor** (RefreshArtist/Rescan/Curate/etc.) into a small
   worker pool (size ≈ `SCHEDULER_THREAD_LIMIT`).
5. Keep the main-thread fallback behind an env flag during rollout.

### Risks
- Shared-state bridging is the bulk of the effort and the main correctness risk
  (stale caches / missing SSE updates).
- SQLite single-writer: concurrent writer threads will serialize on the write
  lock (busy_timeout already set). That's fine — it bounds write concurrency but
  keeps the **API (main thread) responsive**, which is the whole point.

## 5. What shipped — command executor on worker_threads (2026-06-22)

All four phases of §4 are implemented: clean job entrypoint (1), message protocol
(2), the command-executor worker pool (4), and the download/import work (3).

**Layout** (`api/src/services/commands/`):
- `job-context.ts` — shared handler-context helpers (progress/label/yield),
  extracted from `CommandExecutor` so the inline path and the worker path run
  **identical** execution semantics.
- `worker/job-protocol.ts` — message types + the thread bridge. Dependency-light
  (only `node:worker_threads`) so hot-path modules can import it. `isJobWorker()`
  is true only inside a worker we spawned (a `workerData` marker).
- `worker/job-worker-entry.ts` — the worker thread: opens its **own**
  better-sqlite3 connection (WAL → concurrent readers + 1 writer), resolves the
  handler from the registry, runs it, posts `done`/`error`. Never runs
  migrations (those stay a main-thread concern).
- `worker/job-worker-bootstrap.mjs` — dev/test only. tsx's loader does **not**
  reach worker threads, so a `.ts` worker can't resolve its `.js`-suffixed TS
  imports. This plain-JS shim registers tsx inside the worker, then imports the
  `.ts` entry. Production spawns the compiled `.js` entry directly (no shim).
- `worker/job-worker-pool.ts` — main-thread pool of `SCHEDULER_THREAD_LIMIT`
  persistent workers (Lidarr's `THREAD_LIMIT = 3`). Dispatches jobs, re-emits
  bridged `appEvents`, applies bridged cache invalidations, settles done/error,
  respawns dead workers.

**The bridge (the §4 "hard part") — a single chokepoint, not N hooks:**
- *Events*: `appEvents.emit` forwards every emission to the main thread when
  called from a worker (`app-events.ts`). The pool re-emits it on the main
  `appEvents`, so SSE **and** main-thread listeners (`curation.listener`,
  `download-processor`) see worker-originated events unchanged. One hook covers
  all event types (COMMAND_*, ARTIST_REFRESH_COMPLETED, ARTIST_SCANNED, FILE_*, …).
- *Caches*: the `download-state.ts` invalidators forward to the main thread when
  called from a worker, keeping the main thread's 30s read-through stats caches
  coherent with worker writes.
- Both forwarders are guarded by `isJobWorker()`, so they are inert no-ops on
  the main thread (no loops, no overhead).

**Control flow stays on the main thread.** The `CommandExecutor` still owns the
queue poll, exclusivity rules, slot accounting, and the command state
transitions (markProcessing/complete/fail/queueNextMonitoringPass). Only handler
*execution* moves off-thread (`CommandExecutor.runHandler` → `JobWorkerPool.run`
when the pool `isActive()`, else in-process). Job rows are written by whichever
connection runs the handler; the main thread reads them back via WAL.

**Downloads/imports (phase 3).** The download processor's *orchestration* stays
on the main thread (queue poll, COMMAND_ADDED trigger, concurrency slots,
pause/resume/cancel, status the API reads). Only the heavy step —
`DownloadedTracksImportService.process` (metadata parse + matching + tagging +
sync DB writes) — moves off-thread: `dispatchImportJob` runs it via
`JobWorkerPool.run(job, { onProgress })` when the pool is active, else
in-process. The import's
own `appEvents` (FILE_ADDED) and `download-state` invalidations ride the existing
bridge; import progress (the `download-events` SSE channel) is bridged via a
dedicated `importProgress` message routed back to the same `emitImportProgress`
sink. The network download step stays inline (it's non-blocking I/O). Imports
share the command pool's threads — Lidarr-faithful, since its `CommandExecutor`
threads run every command including imports. *Known limitation:* cancelling an
in-flight import doesn't terminate the worker mid-run (same as the prior inline
behaviour — the job is marked, the import finishes).

**Operation**
- Always on: the pool starts unconditionally at boot (no toggle, like Lidarr).
  Thread count = `DISCOGENIUS_SCHEDULER_THREAD_LIMIT` (default 3); the pool covers
  both queued commands and ImportDownload jobs.
- Unit tests that call `processJob` directly never start the pool, so they run
  handlers in-process (cf. Lidarr's CommandExecutorFixture) — no worker spawning.
- Validate (needs a Linux/Docker env with real provider auth + downloaded files):
  trigger a large RescanFolders / RefreshMetadata **and** a multi-track import,
  and confirm the UI (artist pages, `/api/stats`, `/api/v1/queue`, command SSE,
  and the download-progress SSE) stays responsive while the work runs, and that
  progress / FILE_ADDED events still stream.

## 6. Naming (aligned to Lidarr, 2026-06-16)
- `command-executor.ts` (class `CommandExecutor`) — the worker that executes
  queued jobs (was the confusingly-named `scheduler.ts`). ≈ Lidarr `CommandExecutor`.
- `scheduler.ts` — the periodic 30s trigger that enqueues due scheduled tasks
  (was `task-scheduler.ts`). ≈ Lidarr `Jobs/Scheduler` + `TaskManager`.
- `queue.ts` (`TaskQueueService`) ≈ Lidarr `CommandQueueManager`;
  `command.ts` (`CommandManager`) holds command-exclusivity rules.
