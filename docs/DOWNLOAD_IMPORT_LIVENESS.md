# Download and import liveness

The dedicated download worker uses the same durable command-attempt leases as
the general command executor. A queued download is atomically claimed with a
fresh opaque `worker_id`; its `attempt`, `heartbeat_at`, `last_progress_at`, and
`lease_expires_at` fields describe that exact execution attempt.

The owner token remains unchanged across:

1. provider download;
2. the durable `importPending` handoff;
3. active import.

Progress, payload, pause-requeue, completion, and failure writes all include
that token. A callback from a retired worker therefore cannot modify or finish
the replacement attempt.

## Heartbeats and watchdog

The download worker renews leases for active downloads, queued import
handoffs, and active imports. The main API thread independently checks download
leases. It terminates the dedicated worker when either:

- its lease expires because heartbeats stopped; or
- a command keeps heartbeating but has made no phase/progress transition beyond
  the configured expectation.

Recovery happens only after physical worker termination. Resumable provider
downloads are requeued with a persisted reason and a bounded attempt count.
An `importPending` handoff that has not set `executionStartedAt` stays on the
same attempt and the same row. The scheduler re-adopts it. The worker is then
replaced, restoring capacity.

Relevant settings:

- `DISCOGENIUS_DOWNLOAD_LEASE_MS` (default `90000`);
- `DISCOGENIUS_DOWNLOAD_HEARTBEAT_MS` (default one third of the lease);
- `DISCOGENIUS_DOWNLOAD_NO_PROGRESS_MS` (default `1800000`);
- `DISCOGENIUS_DOWNLOAD_WATCHDOG_MS` (default `30000`);
- `DISCOGENIUS_DOWNLOAD_RECOVERY_MAX_ATTEMPTS` (default `3`);
- `DISCOGENIUS_DOWNLOAD_RECOVERY_RETRY_MS` (default `5000`);
- `DISCOGENIUS_IMPORT_ADMISSION_WATCHDOG_MS` (default `60000`);
- `DISCOGENIUS_IMPORT_ADMISSION_STALL_MS` (default `300000`).

These are liveness expectations, not global download-duration limits. A
multi-hour download remains healthy while it heartbeats and reports meaningful
progress.

## Import handoff self-heal

The command row is the source of truth for an import handoff. Every scheduling
pass reads queued and started download commands whose payload says
`importPending`, once, through `idx_commands_status_name_started`. That same
read is the import-backpressure count, so a steady tick adds no second query
and no write. A write happens only when a handoff is missing from this
worker's memory and its owner is queued, null, or its lease is dead. Taking
that owner does not increment `attempt`. A live owner minted in this process
is put back in memory with no write.

One unclaimable head does not stop the handoff behind it. An entry leaves the
in-memory list only when its import starts, the durable row is terminal, or
another live owner holds it.

The admission watchdog runs on `DISCOGENIUS_IMPORT_ADMISSION_WATCHDOG_MS`. It
is a read. A handoff is stranded when it has an import payload, has not set
`executionStartedAt`, has waited longer than
`DISCOGENIUS_IMPORT_ADMISSION_STALL_MS`, and no started download is in
`importing` or already marked `executionStartedAt`. The watchdog logs those
ids, `/health` reports `imports.health` until the rows clear, and it schedules
one reconcile. It does not loop inside the tick. A handoff that is still
waiting after that reconcile stays visible until the next interval.

## Import recovery safety

The download-to-import handoff is persisted in the command payload before the
download slot releases its workspace. A restart can therefore resume a command
in `importPending` without downloading the media again, including while new
provider downloads are paused.

An import sets a durable `executionStartedAt` marker before it may mutate
library files. If its worker dies after that point, Discogenius fails the
command visibly and preserves its staging workspace. It does **not**
automatically replay the import: without a per-file operation journal, the
prior attempt may already have moved, tagged, or registered some files.

This fail-closed behavior is intentional. Safe automatic recovery of partial
imports remains blocked on an idempotent per-file operation journal and
reconciliation pass.

## File-command restart resume

RetagArtist, RetagFiles, RenameArtist, and RenameFiles store progress in
`CommandFileWork` or `CommandRenameWork`. The command definition declares that
with `fileWorkCheckpoint`. A process restart runs `FileMutationJournal.recoverPending()`
and then requeues those commands from the plan. Settled rows stay settled. The
claimed-but-unsettled row is reclaimed. The plan row is inserted in the same
transaction as every work row, so the row's existence is the complete plan and
startup does not select the library again. A file still claimed after five
restarts is stored as a per-file error and the command continues. Five restarts
in a row that leave the checkpoint cursor where it was fail the command with
`no checkpoint progress`. A resume that advances the cursor, including a
per-file skip, clears that count. Commands without `fileWorkCheckpoint` keep
today's fail-closed attempt budget. Imports are not replayed.

