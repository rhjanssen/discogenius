# Changelog

## [1.2.2] - 2026-04-11

### Changed
- Auth bootstrap now follows the *arr model more closely: app auth gates shell access, TIDAL provider auth no longer blocks the local library shell, and admin-session failures no longer fail open.
- Artist folder handling is closer to Lidarr: generated artist paths now avoid parent/child collisions, `MoveArtist` performs a real folder move with rollback, and tracked file rows are rebased after successful folder moves.
- Library scan reliability improved by recalculating download-state invalidation on orphan cleanup and by disabling the top-level prebuilt root index when nested artist-folder templates are in use.
- Loading and settings UX were tightened with branded boot loading, more faithful skeletons, and clearer separation between `Disconnect TIDAL` and Discogenius `Sign out`.

<!-- markdownlint-disable MD024 MD012 -->

All notable changes to this project are documented in this file.

## [Unreleased]

## [1.2.1] - 2026-03-30

### Changed

- Dashboard header actions now stay inline with the title on desktop while mobile keeps a capped action row with overflow.
- Queue section headers now use Fluent subheader typography with improved spacing, and active download metadata stays stacked on mobile to avoid squeezed badges.
- Queue selection controls moved inline with the `Active` header for a simpler Lidarr-style workflow.
- Multi-selection queue moves now batch refreshes so moving several items feels faster and steadier.

### Fixed

- Existing databases can now upgrade cleanly to the current schema because migrations run before indexes that depend on migration-added columns like `job_queue.queue_order`.
- Queue drag handles and delete actions now apply consistently to the whole selected set instead of only the row you happened to grab.

## [1.2.0] - 2026-03-30

### Added

- Lidarr-aligned audio tag write policy (`WriteAudioTagsPolicy`: `no`, `new_files`, `all_files`) and tag scrubbing (`scrub_audio_tags`) for clean metadata rewrites.
- `removeAllTags()` utility for stripping all existing metadata before tag writes (Lidarr's `ScrubAudioTags` equivalent).
- Structured import rejection types (`ImportRejection` with `permanent`/`temporary` classification) for smarter import decision tracking.
- Automatic job history pruning: finished queue jobs older than 1 day are cleaned during housekeeping (aligned with Lidarr's `CommandRepository.Trim()`).
- Database batch operation helpers (`batchRun`, `batchDelete`) for efficient bulk SQL transactions.
- `GET /api/queue/history` endpoint for dedicated queue history surface.
- Real `HealthCheck` diagnostics across runtime state, writable paths, tool availability, and downloader capabilities.
- Browser playback fallback chain: BTS/progressive preferred, DASH segment streaming as fallback.
- Dolby Atmos browser streaming path for web playback of downloaded Atmos audio.
- Two-column desktop queue layout: active queue and history side-by-side at ≥960px.
- Mobile infinite scroll for both active queue and history lists.
- Bulk queue reorder: per-row reorder buttons apply to entire selection when multiple items are selected.

### Changed

- `/api/activity` is now the canonical paginated/filterable activity feed; `/api/status` is summary-only. Removed `/api/status/tasks`.
- Queue SSE/download events now include `quality` metadata with grace-window reconciliation to prevent flicker.
- Album/track organization, scanner metadata writes, playlist imports, and manual import now use transaction batching instead of per-row auto-commits.
- Manual import apply service rewritten to Lidarr-style two-phase collect-then-commit pattern.
- Artist page release modules ordered: Albums → EPs → Singles → Live → Compilations → Soundtracks → Demos → Remixes → Appears On.
- Deprecated `write_audio_metadata` boolean in favor of `write_audio_tags_policy` enum.
- Adopted pure SSE event-driven updates (Tidarr-style); removed all fallback polling intervals.
- Queue item layout uses stacked title/artist/badge rows for pending items; active/importing items retain inline layout.
- Queue reorder icons updated to `ArrowUpload`/`ArrowDownload` for move-to-top/bottom.
- Error display icons use Fluent `ErrorCircle48Color` for richer visual feedback.

### Fixed

- Removed debug `console.log` calls from SSE event stream lifecycle.
- ArtistPage module sections now use stable React keys instead of array indices.
- Dashboard activity/status refresh uses stale-data non-blocking semantics with explicit empty/error states.
- Clicking a queue item in selection mode now toggles selection instead of navigating to the album page.

## [1.1.0] - 2026-03-22

### Added

- Lidarr-style named naming variables with clean/the/clean+the variants and quality metadata tokens (`quality`, `codec`, `bitrate`, `sampleRate`, `bitDepth`, `channels`).
- New backend refresh policy helpers and expanded scheduler command surface introduced in this cycle.

### Changed

- Refactored naming token resolution to be cleaner and less redundant while preserving legacy compatibility where practical.
- Updated default configuration values to match current Discogenius runtime preferences (monitoring, quality, metadata, and naming defaults).
- Aligned Settings fallback monitoring defaults with backend defaults.

### Fixed

- Startup download-processor recovery no longer relies on a nonexistent `job_queue.title` column; recovery now works with the durable queue schema.
- Release preparation metadata updated for app/api package versions to `1.1.0`.

## [1.0.10] - 2026-03-21

### Added

- **Phase 1 Scheduler Commands**: Added 8 manually-triggerable non-download job types: `RefreshAllMonitored`, `DownloadMissingForce`, `RescanAllRoots`, `HealthCheck`, `CompactDatabase`, `CleanupTempFiles`, `UpdateLibraryMetadata`, `ConfigPrune`. All commands are accessible via POST `/api/command` with case-insensitive JSON body `{ "name": "CommandName" }`. Each command includes proper payload typing, command exclusivity rules, scheduler handlers with job progress tracking, and REST route integration.

### Changed

- Updated [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) with Phase 1 command summary table, grouping manually-triggerable commands and legacy orchestration commands separately.
- Updated [docs/ARCHITECTURE_WORKPLAN.md](docs/ARCHITECTURE_WORKPLAN.md) to mark Phase 1 complete and define Phase 2 scope (UI dashboard exposure and periodic scheduling configuration).

## [1.0.9] - 2026-03-21

### Changed

- Frontend improvements: README restructured and simplified, activity badges cleaned, responsive UI fixes.

## [1.0.8] - 2026-03-21

### Changed

- Release preparation and maintenance updates.

## [1.0.7] - 2026-03-21

### Changed

- Aligned agent customization with GitHub agent documentation by adding a repository-level `AGENTS.md` and synchronizing guidance across `.github` instruction files.
- Updated custom agent governance to explicitly validate frontmatter/handoff/tool compatibility against GitHub custom-instruction support and precedence rules.
- Added agent-focused documentation set in `docs/` for pattern discovery, quick reference, and architecture-aligned implementation guidance.
- Consolidated frontend utility patterns for monitoring state, status badges, and infinite-scroll behavior to reduce duplicate implementations and improve consistency.

## [1.0.6] - 2026-03-21

### Changed

- **Performance & Scaling**: Optimized backend for massive libraries (millions of tracks) by eliminating SQLite FILESORT bottlenecks in track/video queries.
- **Event-Driven Queue**: Removed background polling loop in download processor; queue is now purely event-driven (triggered on startup, item addition, and completion).
- **Job Queue Resilience**: Added proper job recovery on container restart—interrupted jobs transition from `processing` to `pending` automatically.
- **SSE Stability**: Added 30-second keep-alive heartbeats to SSE connections to prevent proxy/load-balancer timeouts.
- **Queue Performance**: Fixed job queue polling with native column sorting instead of CASE expressions; added `idx_jobs_poll` index for rapid pending-job selection.
- **UI Virtualization**: Refactored QueueTab with `@tanstack/react-virtual` to handle massive queues without DOM node explosion.
- **Pagination**: Implemented infinite-scroll pagination for Tracks and Videos tabs to prevent memory exhaustion with large libraries.
- **Frontend Icons & Branding**: Updated theme color to Discogenius orange (#fc7134), refreshed app icons and splash screens.
- **Async File Operations**: Converted synchronous filesystem calls to async equivalents in hot paths (import-discovery, import-service, download-processor).
- **UI Consistency**: Unified empty states across Dashboard, Library, Tracks, and Videos using the shared EmptyState component.

## [1.0.5] - 2026-03-20

### Changed

- Added current-versus-latest release status to Settings > About, including release-note links and Docker/NAS update guidance.
- Added release metadata contracts and tests so the frontend and API treat update-status payloads as typed data instead of ad hoc JSON.
- Made the auth screen a true standalone viewport-fit page so it no longer scrolls just enough to hide the theme toggles.
- Hardened the container entrypoint to fail fast with clearer diagnostics when `/config` or SQLite sidecar files are not writable on NAS deployments.
- Updated Docker documentation and compose examples to explain why pinned tags are more reliable than `latest` on platforms that cache images aggressively.

## [1.0.4] - 2026-03-19

### Changed

- Fixed the initial TIDAL auth popup so the first click opens the real device-login URL instead of `about:blank`.
- Added auth-flow regression coverage and refreshed stale dashboard, search, library, and manual-import E2E fixtures so the full suite runs green in mock-provider mode.
- Shared the remaining queue/status/list contracts across the app and API, and stabilized the PWA/service-worker path.
- Documented the provider/backend abstraction RFC and updated GitHub workflows/release-note generation for cleaner Node 24-compatible releases.

## [1.0.3] - 2026-03-19

### Changed

- Docker images now honor `PUID` and `PGID` through the container entrypoint instead of requiring a matching `user:` override.
- Orpheus runtime state now lives under `/config/runtime`, removing the need for a separate writable `/app/.runtime` mount on NAS deployments.
- Updated Docker examples and documentation to show the supported `PUID`, `PGID`, and `TZ` environment variables with `Etc/UTC` as the default timezone.

## [1.0.2] - 2026-03-19

### Changed

- Validate config and media update payloads.
- Add deterministic provider auth modes.
- Add shared config and media contracts.

## [1.0.1] - 2026-03-19

### Changed

- Reset database schema versioning to an independent integer baseline starting at `1`.
- Added regression coverage for schema baseline normalization and migration provenance.
- Fixed the Windows release-preparation helper and added truthful PR CI gates.

## [1.0.0] - 2026-03-16

### Changed

- Initial public release.
