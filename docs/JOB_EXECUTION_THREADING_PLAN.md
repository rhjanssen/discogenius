# Job Execution & Threading — Lidarr Parity Plan

**Status:** Proposal for review. The pragmatic mitigations (below, §3) are done;
the worker_threads refactor (§4) is the larger follow-up.

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

## 5. Naming (aligned to Lidarr, 2026-06-16)
- `command-executor.ts` (class `CommandExecutor`) — the worker that executes
  queued jobs (was the confusingly-named `scheduler.ts`). ≈ Lidarr `CommandExecutor`.
- `scheduler.ts` — the periodic 30s trigger that enqueues due scheduled tasks
  (was `task-scheduler.ts`). ≈ Lidarr `Jobs/Scheduler` + `TaskManager`.
- `queue.ts` (`TaskQueueService`) ≈ Lidarr `CommandQueueManager`;
  `command.ts` (`CommandManager`) holds command-exclusivity rules.
