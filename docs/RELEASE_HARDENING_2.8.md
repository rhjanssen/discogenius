# Discogenius 2.8 Release Hardening

This document records the release-candidate audit methodology and current
architecture. Test verdicts belong in
[`RELEASE_READINESS_2.8.0.md`](RELEASE_READINESS_2.8.0.md); this document
explains what is being exercised and why.

## Command and scheduler architecture

Discogenius has three cooperating execution paths:

1. `scheduler.ts` persists recurring definitions in `scheduled_tasks` and
   enqueues due commands. A schedule row is configuration, not evidence that a
   command ran.
2. `command-executor.ts` claims non-download commands from the durable
   `commands` table and dispatches them to the bounded worker-thread pool.
3. `download-processor.ts` owns provider downloads and finished-download
   imports. It observes the same durable queue but has separate concurrency and
   pause controls.

SQLite WAL permits concurrent readers and one writer. Every worker has its own
`better-sqlite3` connection. The intended operation shape is:

1. network fetch outside a transaction;
2. normalization and diff construction in worker memory;
3. a short, batched SQLite write transaction;
4. commit and release of the writer lock.

Filesystem mutation is serialized separately where operations can conflict.
The release audit treats missing cross-path serialization, a filesystem move
without a durable recovery record, or a synchronous main-thread scan as a
correctness or responsiveness defect even when a unit test passes.

### Scheduled-task truth

The persisted interval is authoritative. A monitoring configuration update may
change whether the cycle is enabled, but may not overwrite the user's interval.
Task status distinguishes:

- last queued time;
- last start time;
- last terminal execution and status;
- last successful completion;
- last failed completion;
- next due time.

SQLite `CURRENT_TIMESTAMP` values are UTC despite having no suffix. They are
parsed as UTC so deployments outside UTC do not immediately requeue fresh work.

## Per-Artist monitoring pipeline

The intended pipeline is:

`RefreshArtist → MatchArtistProviders → RescanFolders (when needed) → CurateArtist → Artist-scoped DownloadMissing`

Each handoff is a separate durable command. This permits Artist A to reach
download-ready state while Artists B, C, and D occupy earlier stages. A final
global `DownloadMissing` pass reconciles the cycle after all tagged workflow
children finish.

Primary monitored Artists have higher base priority than credited-Artist
hydration. Credited expansion creates first-degree, unmonitored skeletons only;
those skeletons do not recursively expand credits. The remaining release gate
is to prove under 500+ Artist load that credited batches remain bounded, make
eventual progress, and never delay the originating Artist's curation/download
handoff.

## Execution leases and progress

Non-download command claims use an opaque token for one exact attempt. The
durable evidence model is:

- `started_at`;
- `worker_id`;
- `attempt`;
- `heartbeat_at`;
- `last_progress_at`;
- `progress_phase`;
- `progress_current` / `progress_total`;
- `lease_expires_at`;
- `blocked_reason`;
- `retry_after`;
- `last_retry_reason`.

Heartbeat renewal proves that the worker event loop is alive. Phase/progress
transitions separately prove useful work. A persisted blocked reason identifies
a known external wait and prevents a no-progress watchdog from treating it as a
silent hang.

Recovery is ownership-guarded: a stale attempt cannot complete, fail, report
progress, or enqueue the next Artist stage after its token has been replaced.
Worker death restores pool capacity. Infrastructure retries use persisted
backoff and a bounded attempt count; poison commands fail visibly. Recovery of
downloads/imports and safety classification for non-idempotent filesystem
commands remain separate gates until explicitly tested.

## Download pause policy

`download_queue_paused` is a persistent control-plane record. The record is
written before cooperatively aborting provider work, so API or container restart
cannot silently resume downloads.

While paused:

- no new provider download is claimed;
- queued download order, priority, trigger, and attempts remain unchanged;
- already-downloaded material may continue through safe import;
- metadata, matching, curation, reads, and other non-download work continue.

The environment variable supplies only a first-start default. Once an operator
has chosen pause/resume, the database record wins.

## Lidarr reference patterns

The local `.ref_lidarr` checkout is a design reference, not a source dependency.
The audit reviewed:

- `CommandQueueManager`: equality-based deduplication performed under one queue
  mutex with insertion;
- `CommandQueue`: started-command-aware arbitration for disk access, type
  exclusivity, long-running work, and global exclusivity;
- `CommandExecutor`: a bounded executor in which one command failure does not
  stop other consumers;
- `CommandRepository`: explicit started/ended transitions and startup orphan
  handling;
- `TaskManager`: persisted definitions and last-execution updates driven by
  command completion;
- `RefreshArtistService`: per-Artist exception isolation and conditional rescan;
- disk scan/import services: identify, decide, import, publish lifecycle events.

### Adopted

- Equality and durable insertion must be one atomic decision.
- Arbitration must inspect all running operations, including download/import
  disk work, rather than only the executor's local promise map.
- Priority plus stable queued time/order determine execution; trigger origin is
  metadata and must not silently make scheduled work outrank manual work.
- One failed Artist must not stop unrelated Artists.
- A scheduled task's execution time comes from a terminal command event, not
  from enqueue time.
- Disk mutation commands need an explicit resource/exclusivity model.

### Rejected or adapted

- Lidarr's global all-Artist refresh followed by one bulk rescan does not provide
  Discogenius's required depth-first progress. Discogenius keeps per-Artist
  durable stages and only uses a final global reconciliation pass.
- Marking every started command merely “orphaned” on restart is insufficient.
  Discogenius needs attempt ownership, retry reason, bounded recovery, and
  protection against a late stale worker.
- Lidarr's single-library file assumptions cannot be copied into Discogenius.
  Track completion, file ownership, moves, and deletion are Library-scoped, and
  Stereo, Spatial, and Video can have separate or shared roots.
- A central database process is not assumed necessary. The existing WAL +
  worker-connection model is measured first; only measured write-lock pressure
  can justify a narrower coordinator or broker.

## Test-run contract

Every durable load/soak run records:

- run ID, seed, Git SHA, Docker image ID, schema version, configuration, roots,
  and start/end time;
- completed/failed Artists, active commands, depth by state/type, oldest
  eligible age, worker utilization, retry/stuck/recovery events;
- event-loop and API latency, CPU, memory, SQLite busy retries, write/read
  profiles, WAL size/checkpoints, provider/catalog latency;
- final queue, canonical, curation, provider, plan, file, and statistics
  assertions.

Long runs write heartbeat and final JSON files. A process still running normally
at an intermediate observation is not a pass.

### Isolated Docker release-candidate runtime

`docker-compose.release-hardening.yml` is a standalone Compose definition for
functional, browser, restart, and final-integrity runs. It neither reads nor
writes the ordinary repository `config`, `downloads`, or `library` mounts.
Compose requires `DISCOGENIUS_RC_ROOT` to name an explicit disposable run
directory and publishes the RC app on port `3837` by default. Provider downloads
start disabled and require the test operator to opt in deliberately.

Example (PowerShell):

```powershell
$env:DISCOGENIUS_RC_ROOT = (Resolve-Path test-results/release-hardening/rc-docker).Path
docker compose -p discogenius-rc -f docker-compose.release-hardening.yml up -d --build
```

The named root must contain `config` and the five `media` subdirectories before
startup. It must never point at Robert's real media collection.

## Statistics semantics and measured cost

Dashboard entity buckets are canonical-global:

- one collaborative Album is one Album;
- one Track selected in Stereo and Spatial is one Track with two independent
  completion requirements;
- an Album is downloaded only when every selected `(Library, Track)`
  requirement has its exact file;
- one selected canonical video is one video regardless of duplicate physical
  files, and unselected files do not count as downloaded selections;
- file count and size remain a physical inventory.

On a generated schema-42 database, the cold truth query measured:

| Artists | Albums | Tracks | Files | Cold query |
| ---: | ---: | ---: | ---: | ---: |
| 500 | 1,500 | 15,000 | 30,000 | 94.68 ms |
| 500 | 5,000 | 100,000 | 200,000 | 693.87 ms |

The 10-second snapshot avoids repeated work, but the 100,000-Track cold-path
cost remains a recorded responsiveness limit for subsequent profiling.
