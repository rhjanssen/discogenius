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

- api/src/services/curation-service.ts
  - CurationService — core curation engine:
  - category filtering
  - version-group selection
  - equal-track-set dedup
  - subset filtering
  - monitor/redundant writes
  - monitor cascade and targeted optional cleanup (without a full per-artist empty-directory sweep)
  - monitored-missing queue generation

- api/src/services/task-scheduler.ts
  - Scheduled orchestration: Lidarr-aligned per-artist pipeline (RefreshMetadata inline → per-artist RescanFolders → per-artist CurateArtist → DownloadMissing).

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

## Module and MusicBrainz Tag Determination

This section defines how release module categories and MusicBrainz release-group tags are derived today.

### Canonical module categories

Discogenius currently uses these stable module categories for album-level grouping:

- ALBUM
- EP
- SINGLE
- COMPILATION
- LIVE
- REMIX
- SOUNDTRACK
- DEMO
- APPEARS_ON

DJ_MIXES remains recognized where already present, but we intentionally do not expand into less reliable secondary buckets beyond the currently supported set.

### Determination precedence (per artist scan)

1. Artist page modules from TIDAL (/pages/artist) are treated as strongest explicit section signals when available.
2. Version-group propagation is then applied so secondary module signals can normalize all variants in the same release group.
3. If page module is absent, group/type fallback applies:
- group_type = COMPILATIONS -> APPEARS_ON
- otherwise derive from release type (EP, SINGLE, else ALBUM)

### Title-derived module heuristics

For initial classification where page/module data is incomplete, title signals may set:

- REMIX ("remix", "remixed", "remixes")
- SOUNDTRACK ("soundtrack", "o.s.t.", "original score", "motion picture")
- DEMO ("demo", "demos")

These feed canonical module assignment and are later normalized by module-fixer.

### MusicBrainz tag mapping

albums.mb_secondary is constrained to valid MusicBrainz release-group secondary values.

Current module -> mb_secondary mapping:

- LIVE -> live
- COMPILATION -> compilation
- REMIX -> remix
- SOUNDTRACK -> soundtrack
- DEMO -> demo

APPEARS_ON is relationship context and is not written to mb_secondary.

When any mb_secondary is present, mb_primary is forced to album; otherwise primary falls back to release type (album/ep/single).

### Supported vs intentionally omitted

Supported in module determination today:

- compilation, live, remix, soundtrack, demo

Intentionally omitted from module expansion for now due to inconsistent real-world behavior across toolchains/clients:

- dj-mix
- mixtape/street
- other less reliably surfaced MusicBrainz secondary types

## Implemented vs Planned

### Implemented today

- Queue-driven curation orchestration.
- Event-driven handoff from scan completion into curation jobs.
- Multi-pass music/atmos curation behavior.
- Version-group and ISRC/subset dedup pipeline.
- Lock-aware writes and lock-aware completion metrics.
- Download candidate queueing from monitored-missing state.

### Planned/in progress

- Further decomposition of curation-service.ts into smaller focused modules.
- More explicit history/audit persistence for curation decisions.
- Additional typed lifecycle events around file and curation state transitions.

Track these architecture changes in docs/ARCHITECTURE_WORKPLAN.md.

