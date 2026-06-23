<!-- markdownlint-disable MD012 -->
# Discogenius Architecture (Current State)

Last updated: 2026-06-23

## Purpose

This document describes the current Discogenius architecture and the stable boundaries we preserve while iterating.

For curation flow details, use docs/CURATION_DEDUPLICATION.md.

## System Shape

Discogenius is a monorepo with a TypeScript backend and frontend:

- api/: Express + TypeScript + better-sqlite3
- app/: React + Vite + Fluent UI v9 + react-query
- config/: TOML settings, SQLite metadata DB, auth/runtime state
- library/: managed media library roots (music, spatial, videos)

## Stable Architectural Principles

1. Keep long-running work in the queue, not in route handlers.

1. Keep one download backend per provider: all TIDAL downloads (audio, Atmos, video) run through tiddl (`api/src/services/providers/tidal/tiddl.ts` + `tiddl-backend.ts`). Tokens and settings are synced into tiddl's config dir (`config/.tiddl`) whenever the provider login or quality settings change.

1. Preserve explicit workflow boundaries:

- queue and exclusivity
- scheduling and orchestration
- scanning/import and organization
- curation/dedup and download queueing

1. Treat `TrackFiles` as canonical on-disk inventory for managed playable media. Treat `MetadataFiles`, `LyricFiles`, and `ExtraFiles` as the Lidarr-style sidecar inventories for artwork, NFO, lyrics, and other sidecars.

1. Respect lock semantics (monitor_lock) as intentional user state.

## Runtime Components

### Queue and Command Lifecycle

- [api/src/services/commands/command-queue-manager.ts](../api/src/services/commands/command-queue-manager.ts): SQLite-backed persistent command queue, state transitions, dedupe, and reorder operations
- [api/src/services/commands/command.ts](../api/src/services/commands/command.ts): command exclusivity and dedup gating
- [api/src/services/commands/command-executor.ts](../api/src/services/commands/command-executor.ts): main-thread queue poller and state owner; dispatches handler execution to the command-worker pool
- [api/src/services/commands/worker/command-worker-pool.ts](../api/src/services/commands/worker/command-worker-pool.ts): worker-thread execution pool for command handlers and heavy import work
- [api/src/services/commands/scheduler.ts](../api/src/services/commands/scheduler.ts): 30s scheduled-task trigger that enqueues due commands
- [api/src/services/commands/system-task-service.ts](../api/src/services/commands/system-task-service.ts): shared catalog for scheduled tasks and manually-triggerable operator commands
- [api/src/services/download/download-processor.ts](../api/src/services/download/download-processor.ts): exact media download orchestration; heavy import finalization runs through the command-worker pool
- [api/src/services/commands/command-history.ts](../api/src/services/commands/command-history.ts): activity history projection and summary derivation
- [api/src/routes/v1/queue.ts](../api/src/routes/v1/queue.ts): live queue authority (`/api/v1/queue`), dedicated queue history, and reorder operations
- [api/src/routes/v1/command.ts](../api/src/routes/v1/command.ts): manual command enqueue surface
- [api/src/routes/status.ts](../api/src/routes/status.ts): summary-only control-plane snapshot for queue stats, activity summary, command stats, running commands, and rate-limit metrics

#### Control-Plane Endpoint Boundaries (Increment 1)

- `/api/tasks` is the canonical non-download task surface (scans/other categories) and supports detailed rows, filtering (`statuses`, `categories`, `types`), pagination (`limit`, `offset`), and task actions (add/retry/cancel/clear completed).
- `/api/activity` is the canonical read-only activity surface for command activity snapshots. Defaults are history-oriented (`completed`, `failed`, `cancelled`) across downloads/scans/other, with explicit filter overrides for status/category/type.
- `/api/activity/events` returns a merged paginated event feed from task-queue events and persisted history events, sorted newest-first with deterministic tie-breaking, and item IDs prefixed by source (`task:<id>`, `history:<id>`).
- `/api/status` is intentionally summary-only and should not be treated as a paginated task list surface.
- `/api/status/tasks` has been removed.
- `/api/queue` remains authoritative for live queue state and ordering/reorder behavior.
- `GET /api/queue/history` is the queue-tab history surface for completed/failed/cancelled download/import rows and returns queue-shaped `QueueItemContract` payloads.
- `/api/activity` is not the queue-history source for the Dashboard queue tab.
- Queue reorder requests must target pending download jobs and provide exactly one anchor (`beforeJobId` xor `afterJobId`) with deduplicated positive integer `jobIds`.
- Terminal queue states (`completed`, `failed`, `cancelled`) are immutable for late progress/state/complete/fail calls. This prevents cancelled imports from later overwriting themselves as completed after an async worker catches up.

#### Library List Filter Contract

- `/api/albums`, `/api/tracks`, and `/api/videos` support optional list filters: `monitored`, `downloaded`, and `locked`.
- These list endpoints keep existing pagination/search/sort behavior (`limit`, `offset`, `search`, `sort`, `dir`), and media-specific filters such as `library_filter` where applicable.
- Boolean query parsing is normalized to accept `1|true|yes|on` and `0|false|no|off` (case-insensitive). Unknown boolean values are treated as not provided.
- `locked` maps to `monitor_lock` filtering and is used to keep intentional user lock state queryable across library list surfaces.

#### Control-Plane Optimization Increment (Completed)

- Shared filter/pagination parsing is centralized in [api/src/utils/activity-query.ts](api/src/utils/activity-query.ts) and reused by [api/src/routes/activity.ts](api/src/routes/activity.ts) and [api/src/routes/queue.ts](api/src/routes/queue.ts) to keep validation behavior consistent across tasks/activity surfaces.
- Activity row mapping in [api/src/services/command-history.ts](api/src/services/command-history.ts) now batches artist/album/track/video lookups and reuses a per-page description context, reducing repeated DB lookups during page mapping.
- `/api/activity/events` pagination in [api/src/services/command-history.ts](api/src/services/command-history.ts) now merges task/history streams incrementally in bounded chunks instead of materializing large merged sets for each page request.
- `queuePosition` derivation for pending activity rows is page-bounded: only pending IDs present on the current page are ranked, instead of scanning/numbering the full pending set first.

#### Command Summary

**Manual operator commands** (via POST `/api/command` with `{ "name": "CommandName" }`; case-insensitive, and available through `/api/system-task`, with selected run-now actions surfaced in the Dashboard overflow menu):

| Command | Purpose | Exclusivity |
| --- | --- | --- |
| `BulkRefreshArtist` | Refresh metadata for all monitored artists | Type-exclusive |
| `DownloadMissingForce` | Queue a missing-download pass for monitored media | Type-exclusive |
| `RescanAllRoots` | Full disk scan for all enabled root folders | Type-exclusive |
| `CheckHealth` | System health diagnostics (runtime, writable paths, tool availability, backend capability checks) | Globally exclusive |
| `CompactDatabase` | SQLite VACUUM + ANALYZE for maintenance | Globally exclusive |
| `CleanupTempFiles` | Remove orphaned staging files | Globally exclusive |
| `UpdateLibraryMetadata` | Backfill/update metadata sidecars in library | Globally exclusive |
| `ConfigPrune` | Prune disabled metadata sources, backfill enabled ones | Globally exclusive |

**Orchestration commands** (used by monitoring scheduler and resolved through the shared system-task catalog rather than a route-local switch):

| Command | Purpose |
| --- | --- |
| `RefreshMetadata` | Metadata refresh pass for queued artists |
| `MonitoringCycle` | Full monitoring lifecycle (refresh → root scan → curation → download) |
| `ApplyCuration` | Apply curation rules to monitored release-group slots |
| `DownloadMissing` | Queue concrete downloads for missing monitored media |
| `CheckUpgrades` | Check for upgrade candidates in library |
| `Housekeeping` | General system cleanup and maintenance |
| `RescanFolders` | Disk scan for root folders with minimal reprocessing |

### Persistent History

- api/src/services/history-events.ts: persistent history write service for file lifecycle and operational events
- api/src/routes/history.ts: `/api/history` read surface for persisted history records
- History writes are emitted from organizer/scheduler/library-files flows where file lifecycle state changes are finalized

### Event Coordination

- api/src/services/app-events.ts: typed app-level event bus
- api/src/services/download-events.ts: download progress/event stream
- api/src/services/curation.listener.ts: event-driven handoff from scan completion to curation jobs
- Queue SSE/download event contracts include optional `quality` metadata so live queue recovery and queue-history badges can preserve the selected quality across reconnects and refreshes

### Logging and Diagnostics

- api/src/services/app-logger.ts: in-process app logging buffer and JSONL persistence under config/logs/
- Startup behavior tail-loads persisted logs into memory from the end of discogenius.jsonl with a 4 MiB read cap, then continues append-only writes
- api/src/services/health.ts: health-diagnostics snapshot covering runtime state, writable paths, tool availability, and downloader/backend capability checks

### Playback and Browser Streaming

- api/src/routes/playback.ts: signed browser playback routes backed by the active streaming provider
- Browser audio playback prefers progressive sources, but falls back to DASH segment playback when that is the only browser-safe provider path available
- Browser-incompatible Atmos/Hi-Res audio is served through backend browser-compatible streaming/transcode paths so local/downloaded playback remains usable in standard browsers

### Metadata, Scan, and Import

- api/src/services/refresh-artist-service.ts: Lidarr-style artist metadata orchestration (basic/shallow/deep refresh)
- api/src/services/refresh-album-service.ts: Lidarr-style album metadata orchestration
- api/src/services/refresh-video-service.ts: video upsert/refresh helpers for artist catalog scans
- api/src/services/media-seed-service.ts: small targeted metadata seed flows for single track/video intake
- api/src/services/metadata-identity-service.ts: MusicBrainz and AcoustID identity enrichment for artists, albums, tracks, and videos during scan/import
- api/src/services/metadata/musicbrainz-video-service.ts: MusicBrainz-first music-video recording sync and recording-to-recording relationship import
- api/src/services/library-scan.ts: disk reconciliation/import coordination
- api/src/services/import-service.ts + import-* services: manual import discovery/matching/apply/finalize pipeline
- api/src/services/identification-service.ts + fingerprint.ts: local-file identification support
- api/src/services/metadata-files.ts: Jellyfin/Kodi NFO/artwork sidecar generation using provider data when available and local database metadata as fallback
- api/src/services/extras/files/extra-file-service.ts: Lidarr-style base extra-file inventory helpers
- api/src/services/extras/metadata/files/metadata-file-service.ts: Lidarr-style `MetadataFiles` write path for artwork/NFO sidecars
- api/src/services/extras/lyrics/lyric-file-service.ts: Lidarr-style `LyricFiles` write/read path for lyric sidecars
- api/src/services/extras/lyrics/lyric-service.ts: Lidarr-style lyric sidecar lookup plus stereo/spatial lyric sharing across related provider recordings

### Curation and Download Candidate Selection

- api/src/services/curation-service.ts: CurationService — MusicBrainz release-group slot curation and download queue candidate generation
- api/src/services/artist-workflow.ts: workflow phase definitions and queued handoff payloads
- api/src/services/task-scheduler.ts: scheduled pass orchestration (Lidarr-aligned per-artist pipeline)

Detailed flow and semantics are documented in docs/CURATION_DEDUPLICATION.md.

### File Organization and Library Tracking

- api/src/services/organizer.ts: stage-to-library file organization
- api/src/services/library-files.ts: managed file tracking/prune helpers
- api/src/services/naming.ts + library-paths.ts: naming/path conventions
- api/src/routes/config.ts: naming validation and preview endpoints used by the settings UI before persisting templates

Naming renderer behavior (api/src/services/naming.ts):

- Supports Discogenius camelCase tokens and Lidarr-style aliases by normalizing token names as space/underscore/dot/dash-insensitive.
- Implements Lidarr-compatible naming cleaners:
  - `CleanTitle`: removes special chars, replaces & with "and", replaces / with space, removes diacritics
  - `TitleThe`: moves prefix (The/An/A) to end of name (e.g., "The Beatles" → "Beatles, The"), preserves parenthetical suffixes
  - `CleanTitleThe`: splits prefix, cleans main and suffix parts separately, rebuilds (e.g., "The AC/DC" → "AC DC, The")
- Provides named variable variants for all text fields:
  - Base form: `{artistName}`, `{albumTitle}`, `{trackTitle}`, `{trackArtistName}`, `{videoTitle}`
  - Clean form: `{artistCleanName}`, `{albumCleanTitle}`, `{trackCleanTitle}`, etc. (applies CleanTitle)
  - The form: `{artistNameThe}`, `{albumTitleThe}`, `{trackTitleThe}`, etc. (applies TitleThe)
  - Clean+The form: `{artistCleanNameThe}`, `{albumCleanTitleThe}`, `{trackCleanTitleThe}`, etc. (applies CleanTitleThe)
- Supports numeric formatting for track and medium tokens using format suffixes such as `{trackNumber:00}`, `{trackNumber:000}`, `{medium:00}`, and `{medium:000}`.
- Supports quality metadata tokens: `{quality}`, `{codec}`, `{bitrate}`, `{sampleRate}`, `{bitDepth}`, `{channels}` with optional format modifiers (e.g., `{sampleRate:kHz}`)
- Validates persisted naming templates server-side. Format suffixes inside tokens, such as `{track:00}`, are allowed; invalid filename characters are checked only in literal template text.
- Modifier syntax such as `{artistName:clean:the}` is not supported. Use named variables such as `{artistCleanNameThe}`.
- Unknown tokens resolve to an empty string; if the rendered relative path has no valid segments, it normalizes to `Unknown`.
- MBID and track-artist fields are metadata-dependent: `artistMbId`, `albumMbId`, and `trackArtistMbId` are optional, and track-artist naming fields use available track-artist metadata when present.

MusicBrainz identity behavior:

- Artist refresh resolves `Artists.mbid` from existing IDs or MusicBrainz artist search and stores match status in `metadata_identity_status`.
- MusicBrainz/Lidarr release-group metadata is stored in `Albums`; provider album IDs do not define album identity.
- Track identity resolution uses MusicBrainz release tracklists, provider UPC/ISRC evidence, and AcoustID/fingerprint matches where available. Provider UPC/ISRC stays in `ProviderItems`; normal Servarr Metadata Server mode does not copy provider UPC/ISRC into catalog barcode/ISRC columns. Imported-file provenance belongs on `TrackFiles`.
- MusicBrainz video recordings are synced into `Recordings` with `IsVideo = 1` where MusicBrainz exposes them. Provider videos are represented as provisional local recordings when they do not yet have an MBID, and provider acquisition IDs stay in `ProviderItems`.
- Imported audio runs the identity phase before audio tags are applied, so MusicBrainz and AcoustID values can be embedded alongside provider provenance.
- `save_nfo` controls Jellyfin/Kodi `artist.nfo`, `album.nfo`, and music-video sidecar generation. Artist biographies and album reviews are embedded in NFO files; `bio.txt` and `review.txt` sidecars are not generated.
- Artwork resolution is metadata-source first: Servarr Metadata Server/Lidarr and Cover Art Archive URLs are preferred for artist/album art, while provider artwork remains a fallback or selected-offer supplement. Album cover settings use CAA-friendly `Original`, `1200`, `500`, and `250` sizes rather than TIDAL-only size names.

## Data and State Model

Primary persisted entities:

- `Artists`, `ArtistMetadata`
- `ArtistStatistics`
- `Albums`, `AlbumReleases`, `AlbumReleaseMedia`, `Tracks`, `Recordings`
- `ProviderItems`, `ProviderItemMatches`, `ReleaseGroupSlots`
- `TrackFiles`
- `MetadataFiles`, `LyricFiles`, `ExtraFiles`
- metadata_identity_status
- history_events
- `UnmappedFiles`
- commands, scheduled_tasks, monitoring_runtime_state
- quality_profiles, upgrade_queue
- config

Operationally important semantics:

- monitor = eligible for automation (curation/download/maintenance scope)
- monitor_lock = manual override; automation must not flip locked state
- redundant = why a release is filtered out of active curation selection
- MusicBrainz/Lidarr tables are the canonical metadata graph.
- Provider data is a cache/resource layer only: `ProviderItems` stores available provider offers, `ProviderItemMatches` stores provider-to-MusicBrainz match evidence including provider UPC/ISRC, `ReleaseGroupSlots` stores the selected provider offer for a MusicBrainz release-group slot, and `TrackFiles`/extra-file tables store provider provenance for already imported files and sidecars.
- Stereo and spatial slots are release-specific. A Dolby Atmos provider offer may have a different UPC/barcode and different recording/ISRC set from the stereo offer inside the same MusicBrainz release group, so each `ReleaseGroupSlots` row keeps its own `selected_release_mbid` and selected provider album. Readers must resolve tracks through the slot's selected release, not a release-group-wide representative.
- Provider raw response blobs are not durable catalog data. Persist only normalized availability/action fields plus compact selected-offer snapshots required for queue/display behavior.
- Provider offer rows must not create canonical artists, albums, releases, tracks, or wanted state by themselves.
- MusicBrainz catalog tables carry Lidarr-style local `Id` and `Foreign*Id` columns where those entities exist in Lidarr. Prefer integer FKs for file joins and neutral MBID names for new file identity work.
- `Recordings` is Discogenius' extension point for audio recordings, spatial/alternate mixes, MusicBrainz video recordings, and provider-only provisional video recordings. MusicBrainz videos use `IsVideo = 1`; provider-only videos use `MetadataStatus = 'provider_only'` until matched.
- `RecordingRelations` stores MusicBrainz `music_video_for` links and Discogenius-inferred relationships such as `same_lyrical_content`.
- Lyrics are treated as sidecar files in `LyricFiles`, like Lidarr's extra-file flow and like generated NFO/artwork sidecars in `MetadataFiles`. The lyric payload is not stored in metadata tables; `RecordingRelations` only records evidence that two recordings can share lyrical content.

## Current Workflow Topology

### Artist-oriented lifecycle

1. Queue workflow entry (refresh, scan, curation, or monitoring pass).
2. Metadata refresh and/or library scan runs.
3. Scan completion emits events.
4. Curation pass updates MusicBrainz-driven wanted/redundant state.
5. Provider availability fills selected slot resources, and download-missing queueing adds concrete jobs only for wanted slots with an available provider offer.
6. Download processor fetches media, then organizer commits files.
7. Library file cleanup/metadata sidecar cleanup runs as needed.

### Monitoring lifecycle

- Monitoring scheduler drives periodic metadata/root-scan passes.
- Follow-up pass chaining is explicit (refresh -> root scan -> curation -> download missing).
- System task state is exposed through scheduled task snapshots, the `/api/system-task` operator surface, and status APIs.
- `/api/system-task` now projects both scheduled tasks and manual operator commands with task metadata, active state, last/next execution, and run-now capability, plus schedule metadata for supported scheduled tasks.
- The current frontend uses that surface selectively: operator run-now actions are available from the Dashboard overflow menu, while Settings remains focused on monitoring configuration and the monitoring-cycle trigger rather than a general system-task control plane.

### Frontend Activity/Status Refresh Semantics

- Shared dashboard infinite-feed behavior is centralized in [app/src/hooks/useDashboardInfiniteFeed.ts](app/src/hooks/useDashboardInfiniteFeed.ts) and reused by activity/tasks feeds for dedupe, cached refresh semantics, fallback polling, and event-driven invalidation.
- Dashboard tab data fetching is active-tab gated (`enabled`) so non-visible tabs do not continuously query or paginate in the background.
- Dashboard activity and status reads keep previous data during refresh (`placeholderData`) and use short staleness windows so polling updates are non-blocking.
- Refresh failures with cached data are presented as "showing cached" notices instead of blocking the view.
- Dashboard queue history uses [app/src/hooks/useQueueHistoryFeed.ts](app/src/hooks/useQueueHistoryFeed.ts) against `GET /api/queue/history`, so queue history is rendered from `QueueItemContract` rows instead of remapped `/api/activity` jobs.
- Queue shell status in [app/src/providers/QueueStatusProvider.tsx](app/src/providers/QueueStatusProvider.tsx) reconciles queue-status SSE, progress batches, and global queue/job invalidation events, while full paged queue reads stay local to queue-focused views instead of the global shell.
- Activity retry suppression in [app/src/pages/dashboard/ActivityTab.tsx](app/src/pages/dashboard/ActivityTab.tsx) now checks in-flight `/api/activity` results first (pending/processing). If that feed reports `hasMore`, retry stays suppressed conservatively to avoid duplicate/redundant retries while newer in-flight work may exist off-page.
- Activity tab empty/error behavior is explicit:
  - "Activity unavailable" when initial load fails and there is no cached activity.
  - "No recent activity" when load succeeds but there are no activity or audit entries.
- Loading UX now prefers layout-matching skeletons (`CardGridSkeleton`, `DataGridSkeleton`, `TrackTableSkeleton`, `DetailPageSkeleton`) for library/detail/suspense fallbacks where preserving layout structure improves perceived responsiveness, while app bootstrap uses the branded `BootLoadingPage`.

## Auth and Connection Model

- App access and provider access are separate concerns. `AppBootstrapGate` blocks the shell only for Discogenius app auth; missing TIDAL auth no longer blocks local-library navigation.
- Provider auth state is polled via `useTidalConnection` (TanStack Query, 30 s stale time). It controls remote catalog and login-required provider features, not shell access.
- Search and metadata endpoints still require a live TIDAL session where remote catalog access is necessary, but users can still load the local library shell without a live TIDAL session.
- The TIDAL provider adapter emits canonical `id` values plus provider-neutral `provider_id` aliases for remaining provider-row hydration paths.
- Internal matching paths key on canonical `id` or `provider_id`; generic queue/API payloads use `providerId`.

## Boundaries We Intentionally Keep

- No downloader invocations outside the tiddl backend in the TIDAL provider.
- No heavy route-level orchestration for scan/import/curation/download operations.
- No provider-shaped shadow file state. Playable media lives in `TrackFiles`; sidecar inventory lives in the Lidarr-style extra-file tables.
- No lock-blind monitor updates.
- Provider authentication is optional for MusicBrainz library management; downloads, previews, followed artists, provider artwork, and provider lyrics require a capable connected provider.

## Documentation Ownership

- docs/ARCHITECTURE.md: current architecture and stable boundaries (this file)
- docs/CURATION_DEDUPLICATION.md: curation flow deep-dive
- docs/TASKS.md: outstanding work and release blockers
- docs/DATA_MODEL_TARGET.md: current data-model rules and future data-model direction
- docs/MB_LOCAL_MODE.md: local MusicBrainz catalog-provider notes
- docs/RELEASE_CENTRIC_MATCHING_PLAN.md: release-centric matching follow-up plan
- docs/UPGRADE_CUTOFF_MODEL_PLAN.md: upgrade cutoff-model follow-up plan
- docs/LIDARR_STRUCTURE_ALIGNMENT.md: file/folder alignment and deferred split candidates
- AGENTS.md (repo root): coding-agent expectations and validation checklist
