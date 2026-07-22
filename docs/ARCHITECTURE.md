# Discogenius Architecture (Current State)

This document describes the current architecture and the stable boundaries we
preserve while iterating. Curation flow lives in
`docs/CURATION_DEDUPLICATION.md`; data-model rules in `docs/DATA_MODEL_TARGET.md`;
the Lidarr folder mapping in `docs/LIDARR_STRUCTURE_ALIGNMENT.md`.

## System shape

Discogenius is a monorepo with a TypeScript backend and frontend:

- `api/` — Express + TypeScript + better-sqlite3 (synchronous DB access only)
- `app/` — React + Vite + Fluent UI v9 + TanStack Query
- `config/` — TOML settings, SQLite metadata DB, auth/runtime state (never
  committed)
- `library/` — managed media roots (stereo music, spatial, videos)

## Stable architectural principles

1. Long-running work runs on the command queue, never inline in route handlers.
2. One download backend per provider; provider-specific tooling stays inside the
   provider adapter/backend.
3. MusicBrainz is canonical identity; providers supply availability, downloads,
   artwork, and allowed metadata supplements only.
4. `TrackFiles` is the canonical on-disk inventory for managed playable media
   (audio and video). `MetadataFiles`, `LyricFiles`, and `ExtraFiles` are the
   Lidarr-style sidecar inventories.
5. Respect lock semantics (`monitor_lock`) as intentional user state; automation
   must never flip a locked monitor value.

## Command queue and lifecycle

The queue mirrors Lidarr: `CommandModel` rows in the `commands` table are
enqueued via the queue manager, drained by an executor on the main thread, and
dispatched to per-command handlers that run on a worker-thread pool.

- `api/src/services/commands/command-queue-manager.ts` — SQLite-backed queue,
  state transitions, dedupe, reorder.
- `api/src/services/commands/command.ts` — exclusivity and dedup gating.
- `api/src/services/commands/command-executor.ts` — main-thread poller/state
  owner; dispatches handler execution to the worker pool.
- `api/src/services/commands/worker/command-worker-pool.ts` — worker-thread
  execution for command handlers and heavy import work.
- `api/src/services/commands/scheduler.ts` — periodic trigger that enqueues due
  scheduled tasks.
- `api/src/services/commands/system-task-service.ts` — shared catalog of
  scheduled tasks and manually triggerable operator commands.
- `api/src/services/commands/command-history.ts` — activity history projection.
- `api/src/services/download/download-processor.ts` — download orchestration;
  heavy import finalization runs on the worker pool.

Routes stay thin. `api/src/routes/v1/queue.ts` is authoritative for live queue
state and reorder; `api/src/routes/v1/command.ts` is the manual enqueue surface;
`api/src/routes/status.ts` is a summary-only control-plane snapshot. Terminal
queue states (`completed`, `failed`, `cancelled`) are immutable so a cancelled
import cannot later overwrite itself as completed once an async worker catches up.

### Commands

Manual operator commands (via `POST /api/v1/command`, also surfaced through
`/api/v1/system/task` and selected Dashboard run-now actions):

| Command | Purpose | Exclusivity |
| --- | --- | --- |
| `BulkRefreshArtist` | Refresh metadata for all monitored artists | Type-exclusive |
| `DownloadMissingForce` | Queue a missing-download pass for monitored media | Type-exclusive |
| `RescanAllRoots` | Full disk scan for all enabled root folders | Type-exclusive |
| `CheckHealth` | Runtime/writable-path/tool/backend diagnostics | Globally exclusive |
| `CompactDatabase` | SQLite VACUUM + ANALYZE | Globally exclusive |
| `CleanupTempFiles` | Remove orphaned staging files | Globally exclusive |
| `UpdateLibraryMetadata` | Backfill/update library metadata sidecars | Globally exclusive |
| `ConfigPrune` | Prune disabled metadata sources, backfill enabled ones | Globally exclusive |

Orchestration commands (scheduler-driven, resolved through the system-task
catalog): `RefreshMetadata`, `MonitoringCycle`, `ApplyCuration`,
`DownloadMissing`, `CheckUpgrades`, `Housekeeping`, `RescanFolders`.

## SQLite concurrency and main-thread responsiveness

`better-sqlite3` is synchronous and SQLite allows one writer at a time. Up to
four writers contend: three command-worker threads plus the main HTTP/SSE thread.
The hard constraint is that the **main thread is the event loop** — any
synchronous wait there freezes all requests, SSE streams, and `/health`. The
model in `api/src/database.ts`:

- **Main thread fails fast** (`busy_timeout = 1000ms`, single quick retry) and
  retries at the next scheduler tick rather than blocking the loop, mirroring
  Lidarr's short request-path timeout.
- **Workers wait** (`busy_timeout = 30000ms` + retries) so heavy refresh writes
  wait their turn instead of erroring with `database is locked`.
- **Chunked catalog writes** commit large refresh/hydration in bounded chunks so
  no single transaction holds the write lock long enough to starve peers.
  Keep this pattern; do not collapse hydration into one giant transaction.
  Optional 2.6 work (local-MB): parallel catalog fetches across artists with a
  single-flight write gate — see `docs/TASKS.md` (do not bump `RefreshArtist`
  `maxConcurrent` without that gate).
- **Bounded WAL** (`journal_size_limit`, `wal_autocheckpoint`, periodic passive
  checkpoint) keeps the WAL from ballooning under a write storm.

## Metadata, scan, and import

- `api/src/services/music/refresh-artist-service.ts`,
  `refresh-album-service.ts`, `refresh-video-service.ts` — Lidarr-style
  artist/album/video metadata orchestration.
- `api/src/services/catalog/` — the `CatalogProvider` seam (Servarr Metadata
  Server and local MusicBrainz). See `docs/MB_LOCAL_MODE.md`.
- `api/src/services/metadata/` — MusicBrainz/AcoustID identity enrichment,
  MusicBrainz video sync, artwork resolution, and provider↔MB matching.
- `api/src/services/mediafiles/library-scan.ts` — disk reconciliation/import
  coordination; `import-service.ts` and siblings run the manual import pipeline.
- `api/src/services/mediafiles/metadata-files.ts` — Jellyfin/Kodi NFO/artwork
  sidecar generation (provider data when available, local DB as fallback).
- `api/src/services/extras/` — Lidarr-style `ExtraFiles`/`MetadataFiles`/
  `LyricFiles` write paths, including stereo/spatial lyric sharing across related
  provider recordings.

## Curation and file organization

- `api/src/services/music/curation-service.ts` — MusicBrainz release-group slot
  curation and download-candidate generation.
- `api/src/services/mediafiles/organizer.ts` — stage-to-library organization;
  `library-files.ts` tracks/prunes managed files.
- `api/src/services/config/naming.ts` — Lidarr-compatible naming renderer.
  Supports Discogenius camelCase tokens plus Lidarr-style aliases (normalized
  space/underscore/dot/dash-insensitive), the `CleanTitle`/`TitleThe`/
  `CleanTitleThe` cleaners, numeric formatting (`{trackNumber:00}`), and quality
  tokens (`{quality}`, `{codec}`, `{bitrate}`, `{sampleRate}`, …). Templates are
  validated server-side; unknown tokens resolve to empty and empty paths
  normalize to `Unknown`.

MusicBrainz identity behavior: artist refresh resolves `Artists.mbid` and stores
match status in `metadata_identity_status`; release-group metadata lives in
`Albums` (provider album IDs never define album identity); provider UPC/ISRC stay
in `ProviderItems` and are not copied into catalog columns in normal Servarr mode;
MusicBrainz videos are `Recordings` with `IsVideo = 1`, provider-only videos are
provisional recordings until matched. Artwork resolution is metadata-source first
(Servarr/CAA), provider artwork as fallback.

## Logging, playback, and events

- `api/src/services/config/app-logger.ts` — in-process log buffer + JSONL
  persistence under `config/logs/`.
- `api/src/services/commands/health.ts` — health snapshot (runtime, writable
  paths, tool availability, downloader/backend capability checks).
- `api/src/routes/playback.ts` — signed browser playback backed by the active
  provider; browser-incompatible Atmos/Hi-Res audio is transcoded to a
  browser-safe path so downloaded playback stays usable.
- `api/src/services/commands/app-events.ts`,
  `api/src/services/download/download-events.ts` — typed event bus and download
  progress stream. Scan completion drives an event-driven handoff to curation.

## Data and state model

Primary persisted entities: `Artists`/`ArtistMetadata`/`ArtistStatistics`;
`Albums`/`AlbumReleases`/`Tracks`/`Recordings`;
`ProviderItems`/`ProviderItemMatches`/`ReleaseGroupSlots`; `TrackFiles`;
`MetadataFiles`/`LyricFiles`/`ExtraFiles`; `UnmappedFiles`;
`metadata_identity_status`; `history_events`; `commands`; `scheduled_tasks`;
`monitoring_runtime_state`; `quality_profiles`; `config`.

Operational semantics:

- monitor = eligible for automation; `monitor_lock` = manual override automation
  must not flip; `redundant` = why a release is filtered out of active curation.
- MusicBrainz tables are the canonical metadata graph. Provider data is a
  cache/resource layer: `ProviderItems` are offers, `ProviderItemMatches` are
  provider↔MusicBrainz match evidence (incl. provider UPC/ISRC), and
  `ReleaseGroupSlots` hold the selected offer per MusicBrainz release-group slot.
- Stereo and spatial slots are release-specific. A Dolby Atmos offer may have a
  different UPC and recording/ISRC set from the stereo offer in the same release
  group, so each `ReleaseGroupSlots` row keeps its own `selected_release_mbid`
  and selected provider album. Readers must resolve tracks through the slot's
  selected release, not a release-group-wide representative.
- Provider rows store only normalized availability/action fields plus compact
  selected-offer snapshots — not raw response blobs — and must not create
  canonical artists/albums/releases/tracks or wanted state by themselves.
- `Recordings` is the extension point for audio recordings, spatial/alternate
  mixes, MusicBrainz video recordings, and provider-only provisional videos.
  `RecordingRelations` stores MusicBrainz `music_video_for` links plus inferred
  relations like `same_lyrical_content`.
- Lyrics are sidecar files in `LyricFiles`; the payload is never stored in
  metadata tables.

## Workflow topology

Artist lifecycle: queue a workflow entry (refresh/scan/curation/monitoring) →
metadata refresh and/or library scan → scan completion emits events → curation
updates MusicBrainz-driven wanted/redundant state → provider availability fills
selected slot resources → download-missing queues concrete jobs only for wanted
slots with an available offer → download processor fetches, organizer commits →
library/sidecar cleanup runs as needed.

Monitoring lifecycle: the scheduler drives periodic metadata/root-scan passes;
follow-up chaining is explicit (refresh → root scan → curation → download
missing). `/api/v1/system/task` projects scheduled tasks and manual operator
commands with active state, last/next execution, and run-now capability.

## Auth and connection model

App access and provider access are separate concerns. `AppBootstrapGate` blocks
the shell only for Discogenius app auth; missing provider auth does not block
local-library navigation. Provider auth state is polled and controls remote
catalog and login-required features. Provider authentication is optional for
MusicBrainz library management; downloads, previews, followed artists, provider
artwork, and provider lyrics require a capable connected provider.

## Boundaries we intentionally keep

- No downloader invocations outside a provider's registered download backend.
- No heavy route-level orchestration for scan/import/curation/download.
- No provider-shaped shadow file state. Playable media lives in `TrackFiles`;
  sidecars live in the Lidarr-style extra-file tables.
- No lock-blind monitor updates.
