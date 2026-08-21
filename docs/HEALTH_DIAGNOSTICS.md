# Health diagnostics

Discogenius has two deliberately different health paths.

Docker `HEALTHCHECK` and Compose `depends_on: service_healthy` use `/ping`
(plain `pong`). That probe only asks whether the HTTP server is up. Diagnostic
status lives on `/health` so a failed deep check or last week's import cannot
mark the container unhealthy and block the Apple Music wrapper.

The HTTP `/health`, `/api/health`, and authenticated `/api/v1/system/status`
paths are lightweight snapshots. They inspect writable paths, configured-volume
free space, schema/WAL state, command leases and backlog age, scheduler
queueing, recent/stale imports, persisted projection markers, queue pause, and
locally available downloader capabilities. Executable discovery is cached for
one minute. These probes do not run database table scans, integrity PRAGMAs,
provider requests, MusicBrainz queries, or Servarr requests.

The scheduled `CheckHealth` command runs in the command worker pool. It performs
`PRAGMA quick_check` and `PRAGMA foreign_key_check` on that worker's SQLite
connection, then stores a bounded summary in the `runtime_controls` row
`last_deep_health_result`. Lightweight probes report the last result and warn
when it is missing or older than `DISCOGENIUS_DEEP_HEALTH_STALE_MS` (24 hours by
default). A failed deep result makes health unhealthy until a later successful
deep check replaces it.

Useful thresholds can be changed without a schema migration:

- `DISCOGENIUS_WAL_WARNING_BYTES` and `DISCOGENIUS_WAL_ERROR_BYTES`;
- `DISCOGENIUS_DISK_WARNING_FREE_BYTES` and
  `DISCOGENIUS_DISK_ERROR_FREE_BYTES`;
- `DISCOGENIUS_QUEUE_AGE_WARNING_MS` and
  `DISCOGENIUS_QUEUE_AGE_ERROR_MS`;
- `DISCOGENIUS_IMPORT_STALE_MS`;
- `DISCOGENIUS_DEEP_HEALTH_STALE_MS`.

Catalog connectivity is shown as configured/unknown in the lightweight
snapshot. This is intentional: a liveness request must not generate external
traffic. TIDAL/tiddl authentication is inspected from local credential state.
Other provider and catalog connectivity still needs explicit integration
checks; the HTTP probe does not claim those services are reachable.

Library lists page from membership tables, so empty Album/Track projection
markers are informational rather than a health warning.
`ArtistStatistics.updated_at` is reported as evidence, while the dashboard's
in-memory stale-while-revalidate cache age is not currently externally
observable. Health reports that limitation rather than claiming cache freshness.
