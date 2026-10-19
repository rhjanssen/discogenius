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
leases. A command is alive when its heartbeat (lease) is fresh and its
sub-phase progress is fresh. The watchdog terminates the dedicated worker when
either:

- its lease expires because heartbeats stopped; or
- a command keeps heartbeating but has made no phase or per-file progress
  beyond `DISCOGENIUS_DOWNLOAD_NO_PROGRESS_MS`.

Artwork, lyrics, and tag rules used to emit one percent (94 for tags) and then
go silent for the whole album, so a live tag pass looked frozen. Each file now
ticks at the start of the file. The percent can stay at 94. The tick still
moves `last_progress_at`, `progress_current`, and the lease, and it renews
`heartbeat_at`, so a long synchronous tag write is covered for one no-progress
window. A phase that stops ticking is still poisoned.

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

## Upgrade replacement

An import may delete a previous file only when that file is the same release
track: `Tracks.id`, or that row's track MBID, in the same library slot.
Stereo and spatial copies of one track are siblings. A recording MBID and a
provider track id are not replacement keys. One streaming track is often a
member of several releases (a studio album and a later box set), and deleting
by that id removes the other album's file and its `TrackFiles` row.

A video import may delete only another `file_type = 'video'` row of the same
provider video. That query cannot name an album track.

The bytes are removed under the folder lock and the HDD permit. The row
delete is inside the write gate, after the permit is dropped.

## Import handoff self-heal

The command row is the source of truth for an import handoff. Every scheduling
pass reads queued and started download commands whose payload says
`importPending`, once, through `idx_commands_status_name_started`. That same
read is the import-backpressure count, so a steady tick adds no second query
and no write. A write happens only when a handoff is missing from this
worker's memory and its owner is queued, null, or its lease is dead. Taking
that owner does not increment `attempt`. A live owner minted by this process
start (its token carries that start's `importWorkerInstanceId`) is put back
in memory with no write. A token from a previous boot, including the old
`download-attempt:<pid>:` form, is foreign: a still-live lease is left with
its owner, and an expired lease is taken by compare-and-swap.

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
library files. Before artwork, lyrics, or tags it also stores
`downloadImportHandoff.importTouchedFileIds`, the TrackFiles ids already
placed. If its worker dies after that point, Discogenius fails the command
visibly and preserves its staging workspace. It does **not** automatically
replay the import: without a per-file operation journal, the prior attempt
may already have moved, tagged, or registered some files. When those ids were
recorded, the poison queues `RetagFiles` for exactly that list
(`ref_id` `import-tag-repair:<command id>`), so provider tags are not left
on the files the import had reached. An older in-flight import with no id
list is still failed and does not invent a library-wide retag.

This fail-closed behavior is intentional. Safe automatic recovery of partial
imports remains blocked on an idempotent per-file operation journal and
reconciliation pass.

## Disk admission

Retag, rename, folder rescan, and import no longer share one global disk slot.
Lock order, never inverted:

1. Album-folder lock. A rename that touches two folders takes both in one call,
   paths normalized and sorted, lanes acquired in ascending index. Do not take
   a new folder lock while one is held, and do not take one while an I/O permit
   or the SQLite write gate is held.
2. HDD I/O permit, only while the folder lock is held, never while the write
   gate is held. Default limit is 1 for spinning disks. `DISCOGENIUS_HDD_IO_LIMIT`
   clamps to 1..8.
3. SQLite write gate. No file or network I/O inside it.

Imports waiting on a folder outrank retag, rename, and rescan. The retag drops
the folder between files so an import of that album enters before the next
file. An import of a different album takes the permit when the retag drops it,
so the two interleave. A wait is logged once:
`[disk-admission] <role> command <id> waiting: <reason>`.
Whole-library commands (rescan all roots, move artist, cleanup, backup,
compact, housekeeping) still take the single global disk slot and do not start
beside a folder-scoped command.

## File-command restart resume

RetagArtist, RetagFiles, RenameArtist, and RenameFiles store progress in
`CommandFileWork` or `CommandRenameWork`. The command definition declares that
with `fileWorkCheckpoint`. A process restart runs `FileMutationJournal.recoverPending()`
and then requeues those commands from the plan. Settled rows stay settled. The
claimed-but-unsettled album is reclaimed; a cursor file that has already been
restarted five times is stored as a per-file error and the command continues.
Five restarts in a row that leave the checkpoint cursor where it was fail the
command with `no checkpoint progress`. A resume that advances the cursor,
including a per-file skip, clears that count.

New retag and rename plans stream. The first album is inserted and started
before the rest of the library is selected. `plan_complete` stays 0 until the
scope is exhausted. Migration `retag-album-scheduling` adds that column with
default 1 and does not bump `user_version` (stays 46), so a plan written by
the previous process — including RetagArtist 19285, whose rows were inserted
in one transaction — is already complete and resumes from its cursor. It is
not reselected. A null `managed_tag_fingerprint` opens that file once and then
stores the catalogue hash. Commands without `fileWorkCheckpoint` keep today's
fail-closed attempt budget. Imports are not replayed.

