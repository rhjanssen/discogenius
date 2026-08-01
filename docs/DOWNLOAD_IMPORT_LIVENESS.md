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

Recovery happens only after physical worker termination. Resumable downloads
and import handoffs that have not started are requeued with persisted reason and
bounded attempt count. The worker is then replaced, restoring capacity.

Relevant settings:

- `DISCOGENIUS_DOWNLOAD_LEASE_MS` (default `90000`);
- `DISCOGENIUS_DOWNLOAD_HEARTBEAT_MS` (default one third of the lease);
- `DISCOGENIUS_DOWNLOAD_NO_PROGRESS_MS` (default `1800000`);
- `DISCOGENIUS_DOWNLOAD_WATCHDOG_MS` (default `30000`);
- `DISCOGENIUS_DOWNLOAD_RECOVERY_MAX_ATTEMPTS` (default `3`);
- `DISCOGENIUS_DOWNLOAD_RECOVERY_RETRY_MS` (default `5000`).

These are liveness expectations, not global download-duration limits. A
multi-hour download remains healthy while it heartbeats and reports meaningful
progress.

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

