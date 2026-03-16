# Curation and Deduplication Workflow

Last updated: 2026-03-15

## Why This Exists

Discogenius is not only a downloader. Its core differentiator is building and maintaining full artist discographies while filtering redundant overlap (duplicate editions, equal-track variants, subset releases) without losing intentional user choices.

## End-to-End Flow

### Entry points

Curation can be triggered from:

- Monitoring passes (managed artists)
- Explicit curation actions
- Refresh/scan workflows that emit scan-completion events

### Runtime sequence

1. A queue workflow enqueues curation-oriented jobs (ApplyCuration or CurateArtist).
2. scheduler dispatches CurateArtist.
3. redundancy.processAll runs the curation passes for the artist.
4. processAll executes music curation, then optional atmos curation if enabled.
5. Album/media monitor state is updated (respecting locks) and cascaded to tracks.
6. Optional targeted cleanup runs (unmonitored media cleanup and metadata sidecar cleanup).
7. Per-artist curation intentionally skips a full empty-directory sweep to keep queue throughput responsive.
8. queueMonitoredItems can enqueue concrete download jobs for monitored-missing items.

## Key Services and Data Flow

- api/src/services/artist-workflow.ts
  - Defines workflow phases (metadata-refresh, refresh-scan, curation, monitoring-intake, full-monitoring).
  - Shapes payloads that decide whether curation and download queueing occur.

- api/src/services/curation.listener.ts
  - Event handoff from ARTIST_SCANNED and RESCAN_COMPLETED into queued curation jobs.

- api/src/services/scheduler.ts
  - Executes ApplyCuration (managed artist fanout) and CurateArtist (per artist).

- api/src/services/redundancy.ts
  - Core curation engine:
  - category filtering
  - version-group selection
  - equal-track-set dedup
  - subset filtering
  - monitor/redundant writes
  - monitor cascade and targeted optional cleanup (without a full per-artist empty-directory sweep)
  - monitored-missing queue generation

- api/src/services/monitoring-scheduler.ts
  - Scheduled orchestration and pass chaining (refresh -> root scan -> curation -> download missing).

- api/src/services/download-state.ts and api/src/services/managed-artists.ts
  - Completion/count semantics that include monitor_lock rows as intentionally kept state.

## Deduplication Pipeline (Implemented)

Inside redundancy.processRedundancy:

1. Load artist albums and tracks.
2. Split by library type quality scope:
- music pass: stereo targets (LOSSLESS, HIRES_LOSSLESS)
- atmos pass: DOLBY_ATMOS only
3. Apply category inclusion filters from filtering config.
4. If redundancy filtering is enabled:
- group by version_group_id (fallback to title key)
- choose best release per group by quality, explicit preference, then newest id
5. Deduplicate equal track sets via ISRC grouping (with Atmos-specific handling).
6. Filter subset releases (track-set subset of a kept release).
7. Persist monitor and redundant decisions on albums (skip locked rows).
8. Cascade monitor state to unlocked tracks.
9. Update video monitor state from include_videos (skip locked rows).

## Download Queue Coupling

queueMonitoredItems enqueues downloads from monitored-but-missing inventory:

- Album-level download when all tracks are monitored and missing.
- Track-level download when only a subset is monitored.
- Video download when include_videos is enabled.
- Existing pending/processing jobs are checked to avoid duplicate queue work.

## Lock and Monitored Semantics

### monitor

- Marks records as automation scope.
- Curation sets this for selected releases and clears it for filtered ones.

### monitor_lock

- Hard manual override.
- Curation, scan/import updates, and monitor cascades do not overwrite locked rows.
- Locked child rows are also treated as intentionally kept state in completion logic.

### redundant

- Stores curation reason/context for filtered releases.
- Used to explain why a release is currently excluded from active monitoring.

### Completion/count behavior

- Downloaded and completion metrics include monitored rows and locked rows.
- Artist completion remains gated by monitored artist state or explicitly locked child rows.

## Config Surface Used by Curation

From filtering config:

- include_album, include_single, include_ep
- include_compilation, include_soundtrack, include_live, include_remix, include_appears_on
- include_atmos
- include_videos
- prefer_explicit
- enable_redundancy_filter

From monitoring config:

- remove_unmonitored_files

## Implemented vs Planned

### Implemented today

- Queue-driven curation orchestration.
- Event-driven handoff from scan completion into curation jobs.
- Multi-pass music/atmos curation behavior.
- Version-group and ISRC/subset dedup pipeline.
- Lock-aware writes and lock-aware completion metrics.
- Download candidate queueing from monitored-missing state.

### Planned/in progress

- Further decomposition of redundancy.ts into smaller focused modules.
- More explicit history/audit persistence for curation decisions.
- Additional typed lifecycle events around file and curation state transitions.

Track these architecture changes in docs/ARCHITECTURE_WORKPLAN.md.
