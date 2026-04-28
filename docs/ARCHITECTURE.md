<!-- markdownlint-disable MD012 -->
# Discogenius Architecture (Current State)

Last updated: 2026-03-27

## Purpose

This document describes the current Discogenius architecture and the stable boundaries we preserve while iterating.

For planned architecture consolidation and Lidarr-alignment backlog, use docs/ARCHITECTURE_WORKPLAN.md.
For curation and redundancy flow details, use docs/CURATION_DEDUPLICATION.md.

## System Shape

Discogenius is a monorepo with a TypeScript backend and frontend:

- api/: Express + TypeScript + better-sqlite3
- app/: React + Vite + Fluent UI v9 + react-query
- config/: TOML settings, SQLite metadata DB, auth/runtime state
- library/: managed media library roots (music, atmos, videos)

## Stable Architectural Principles

1. Keep long-running work in the queue, not in route handlers.

1. Keep download backends split by media type:

- Orpheus for music (album, track, playlist)
- tidal-dl-ng for video

1. Preserve explicit workflow boundaries:

- queue and exclusivity
- scheduling and orchestration
- scanning/import and organization
- curation/dedup and download queueing

1. Treat library_files as canonical on-disk inventory for managed media and sidecars.

1. Respect lock semantics (monitor_lock) as intentional user state.

## Runtime Components

### Queue and Command Lifecycle

- [api/src/services/queue.ts](api/src/services/queue.ts): SQLite-backed persistent job queue and payload typing
- [api/src/services/command.ts](api/src/services/command.ts): command exclusivity and dedup gating
- [api/src/services/system-task-service.ts](api/src/services/system-task-service.ts): shared catalog for scheduled tasks and manually-triggerable operator commands
- [api/src/services/download-processor.ts](api/src/services/download-processor.ts): exact media download jobs
- [api/src/services/scheduler.ts](api/src/services/scheduler.ts): non-download jobs (scan/import/curation/maintenance)
- [api/src/services/scheduler-maintenance-handlers.ts](api/src/services/scheduler-maintenance-handlers.ts): focused low-coupling Phase-1/maintenance handlers invoked by `scheduler.ts`, while scheduler keeps queue completion/failure ownership
- [api/src/services/command-history.ts](api/src/services/command-history.ts): activity history projection and summary derivation
- [api/src/routes/queue.ts](api/src/routes/queue.ts): non-download task API (`/api/tasks`) for list/filter plus add/retry/cancel/clear operations
- [api/src/routes/activity.ts](api/src/routes/activity.ts): activity/history read APIs (`/api/activity`, `/api/activity/events`) for filtered command activity and merged event feed pagination
- [api/src/routes/status.ts](api/src/routes/status.ts): summary-only control-plane snapshot (`/api/status`) for queue stats, activity summary, command stats, running commands, and rate-limit metrics
- [api/src/routes/download-queue.ts](api/src/routes/download-queue.ts): live queue authority (`/api/queue`), dedicated queue history (`GET /api/queue/history`), and reorder operations

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
| `DownloadMissingForce` | Reset skip flags and requeue missing downloads for all monitored media | Type-exclusive |
| `RescanAllRoots` | Full disk scan for all enabled root folders | Type-exclusive |
| `CheckHealth` | System health diagnostics (runtime, writable paths, tool availability, backend capability checks) | Globally exclusive |
| `CompactDatabase` | SQLite VACUUM + ANALYZE for maintenance | Globally exclusive |
| `CleanupTempFiles` | Remove orphaned staging files | Globally exclusive |
| `UpdateLibraryMetadata` | Backfill/update metadata sidecars in library | Globally exclusive |
| `ConfigPrune` | Prune disabled metadata sources, backfill enabled ones | Globally exclusive |

**Legacy orchestration commands** (used by monitoring scheduler, remain queryable, and are now resolved through the shared system-task catalog rather than a route-local switch):

| Command | Purpose |
| --- | --- |
| `RefreshMetadata` | Metadata refresh pass for queued artists |
| `MonitoringCycle` | Full monitoring lifecycle (refresh → root scan → curation → download) |
| `ApplyCuration` | Apply curation rules and update redundancy flags |
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

- api/src/routes/playback.ts: signed browser playback routes for TIDAL audio/video streaming
- Browser audio playback prefers BTS/progressive sources, but falls back to DASH segment playback when that is the only browser-safe TIDAL path available
- Browser-incompatible Atmos/Hi-Res audio is served through backend browser-compatible streaming/transcode paths so local/downloaded playback remains usable in standard browsers

### Metadata, Scan, and Import

- api/src/services/refresh-artist-service.ts: Lidarr-style artist metadata orchestration (basic/shallow/deep refresh)
- api/src/services/refresh-album-service.ts: Lidarr-style album metadata orchestration
- api/src/services/refresh-playlist-service.ts: playlist metadata and membership refresh
- api/src/services/refresh-video-service.ts: video upsert/refresh helpers for artist catalog scans
- api/src/services/media-seed-service.ts: small targeted metadata seed flows for single track/video intake
- api/src/services/metadata-identity-service.ts: MusicBrainz and AcoustID identity enrichment for artists, albums, tracks, and videos during scan/import
- api/src/services/library-scan.ts: disk reconciliation/import coordination
- api/src/services/import-service.ts + import-* services: manual import discovery/matching/apply/finalize pipeline
- api/src/services/identification-service.ts + fingerprint.ts: local-file identification support
- api/src/services/metadata-files.ts: Jellyfin/Kodi NFO sidecar generation using live TIDAL data when available and local database metadata as fallback

### Curation and Download Candidate Selection

- api/src/services/curation-service.ts: CurationService — artist-level curation, redundancy filtering, monitor propagation, download queue candidate generation
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
- Legacy modifier syntax (e.g., `{artistName:clean:the}`) is deprecated but still supported for backward compatibility; new code should use named variables instead.
- Unknown tokens resolve to an empty string; if the rendered relative path has no valid segments, it normalizes to `Unknown`.
- MBID and track-artist fields are metadata-dependent: `artistMbId`, `albumMbId`, and `trackArtistMbId` are optional, and track-artist naming fields use available track-artist metadata when present.

MusicBrainz identity behavior:

- Artist refresh resolves `artists.mbid` from existing IDs or MusicBrainz artist search and stores match status in `metadata_identity_status`.
- Album refresh resolves `albums.mbid` and `albums.mb_release_group_id` by UPC first, then MusicBrainz release search.
- Track identity resolution uses MusicBrainz release tracklists, ISRC, and AcoustID/fingerprint matches where available and writes `media.mbid`, `media.acoustid_id`, and fingerprint metadata.
- Music videos are tracked in the same status table, but MusicBrainz video IDs are treated as generally unavailable; video NFO files still include artist and album MusicBrainz IDs when the linked rows have them.
- Imported audio runs the identity phase before audio tags are applied, so MusicBrainz and AcoustID values can be embedded alongside TIDAL metadata.
- `save_nfo` controls Jellyfin/Kodi `artist.nfo`, `album.nfo`, and music-video sidecar generation. Artist biographies and album reviews are embedded in NFO files; `bio.txt` and `review.txt` sidecars are not generated.

## Data and State Model

Primary persisted entities:

- artists, albums, media
- album_artists, media_artists
- library_files
- metadata_identity_status
- history_events
- unmapped_files
- job_queue, scheduled_tasks, monitoring_runtime_state
- quality_profiles, upgrade_queue
- config

Operationally important semantics:

- monitor = eligible for automation (curation/download/maintenance scope)
- monitor_lock = manual override; automation must not flip locked state
- redundant = why a release is filtered out of active curation selection

## Current Workflow Topology

### Artist-oriented lifecycle

1. Queue workflow entry (refresh, scan, curation, or monitoring pass).
2. Metadata refresh and/or library scan runs.
3. Scan completion emits events.
4. Curation pass updates monitored/redundant state.
5. Download-missing queueing adds concrete download jobs.
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
- Search and metadata endpoints still require a live TIDAL session where remote catalog access is necessary, but disconnected or mock provider modes can still load the local library shell.
- The TIDAL API layer now emits canonical `id` values across both search mappers (`mapArtist`, `mapTrack`, `mapVideo`) and core getter responses (`getArtist`, `getTrack`, `getArtistVideos`, `getVideo`) in `tidal.ts`, while retaining `tidal_id` for compatibility where still consumed.
- Internal matching paths that previously depended on `tidal_id` fallbacks (for example in `import-matcher-service.ts` candidate keys and fingerprint track loops) now key on canonical `id`.

## Boundaries We Intentionally Keep

- No direct music downloads through tidal-dl-ng.
- No heavy route-level orchestration for scan/import/curation/download operations.
- No shadow file-state source outside library_files.
- No lock-blind monitor updates.
- No local/offline/disconnected mode. The application requires an authenticated TIDAL session.

## Documentation Ownership

- docs/ARCHITECTURE.md: current architecture and stable boundaries (this file)
- docs/ARCHITECTURE_WORKPLAN.md: architecture improvements and backlog
- docs/CURATION_DEDUPLICATION.md: curation/redundancy deep-dive
- docs/ROADMAP.md: forward-looking product priorities only
- docs/RELEASE_DISTRIBUTION_PLAN.md: alpha operational release planning guidance
