<!-- markdownlint-disable MD012 -->
# Discogenius Architecture (Current State)

Last updated: 2026-03-16

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
- [api/src/services/download-processor.ts](api/src/services/download-processor.ts): exact media download jobs
- [api/src/services/scheduler.ts](api/src/services/scheduler.ts): non-download jobs (scan/import/curation/maintenance)
- [api/src/services/command-history.ts](api/src/services/command-history.ts) + [api/src/routes/status.ts](api/src/routes/status.ts): activity/status projection

#### Command Summary

**Phase 1 Manually-Triggerable Commands** (via POST `/api/command` with `{ "name": "CommandName" }`; case-insensitive):

| Command | Purpose | Exclusivity |
| --- | --- | --- |
| `RefreshAllMonitored` | Refresh metadata for all monitored artists | Type-exclusive |
| `DownloadMissingForce` | Reset skip flags and requeue missing downloads for all monitored media | Type-exclusive |
| `RescanAllRoots` | Full disk scan for all enabled root folders | Type-exclusive |
| `HealthCheck` | System health validation (auth, runtime, paths) | Globally exclusive |
| `CompactDatabase` | SQLite VACUUM + ANALYZE for maintenance | Globally exclusive |
| `CleanupTempFiles` | Remove orphaned staging files | Globally exclusive |
| `UpdateLibraryMetadata` | Backfill/update metadata sidecars in library | Globally exclusive |
| `ConfigPrune` | Prune disabled metadata sources, backfill enabled ones | Globally exclusive |

**Legacy Orchestration Commands** (used by monitoring scheduler; remain queryable):

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

### Logging and Diagnostics

- api/src/services/app-logger.ts: in-process app logging buffer and JSONL persistence under config/logs/
- Startup behavior tail-loads persisted logs into memory from the end of discogenius.jsonl with a 4 MiB read cap, then continues append-only writes

### Metadata, Scan, and Import

- api/src/services/scanner.ts: TIDAL metadata scan tiers (BASIC/SHALLOW/DEEP)
- api/src/services/library-scan.ts: disk reconciliation/import coordination
- api/src/services/import-service.ts + import-* services: manual import discovery/matching/apply/finalize pipeline
- api/src/services/identification-service.ts + fingerprint.ts: local-file identification support

### Curation and Download Candidate Selection

- api/src/services/redundancy.ts: artist-level curation, redundancy filtering, monitor propagation, download queue candidate generation
- api/src/services/artist-workflow.ts: workflow phase definitions and queued handoff payloads
- api/src/services/monitoring-scheduler.ts: scheduled pass orchestration

Detailed flow and semantics are documented in docs/CURATION_DEDUPLICATION.md.

### File Organization and Library Tracking

- api/src/services/organizer.ts: stage-to-library file organization
- api/src/services/library-files.ts: managed file tracking/prune helpers
- api/src/services/naming.ts + library-paths.ts: naming/path conventions

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
- Legacy modifier syntax (e.g., `{artistName:clean:the}`) is deprecated but still supported for backward compatibility; new code should use named variables instead.
- Unknown tokens resolve to an empty string; if the rendered relative path has no valid segments, it normalizes to `Unknown`.
- MBID and track-artist fields are metadata-dependent: `artistMbId`, `albumMbId`, and `trackArtistMbId` are optional, and track-artist naming fields use available track-artist metadata when present.

## Data and State Model

Primary persisted entities:

- artists, albums, media
- album_artists, media_artists
- library_files
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
- System task state is exposed through scheduled task snapshots and status APIs.

## Auth and Connection Model

- Discogenius requires an active TIDAL connection. All protected routes redirect to `/auth` when not connected.
- Auth state is polled via `useTidalConnection` (TanStack Query, 30 s stale time) and gate-kept by `ProtectedRoute`.
- Search and metadata endpoints return 401 when no TIDAL token is present. No local/disconnected fallback modes exist.
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
