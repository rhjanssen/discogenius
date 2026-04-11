---
name: discogenius-backend
description: Backend workflow for Discogenius (Express + TypeScript) covering Orpheus music downloads, tidal-dl-ng video downloads, Lidarr-style command/job orchestration, local/manual import scanning, fingerprint-based identification, and SQLite schema updates. Use when editing API routes, services, database schema, job processing, or download/import pipelines.
---

# Discogenius Backend

## Core rules
- Use TypeScript for backend runtime code. Do not add new `.js` files under `api/src`.
- Use `better-sqlite3` synchronously; never `await` DB calls.
- Keep route handlers thin; place logic in `api/src/services`.
- Use `Config` helpers for paths and config access.
- Prefer Yarn for all dependency and script execution.
- Validate packaging/runtime-sensitive changes with Docker, not just local `yarn dev`.

## TypeScript stance
- Keep Discogenius on a TypeScript backend unless there is a concrete platform reason to rewrite. Lidarr-style rigor does not require C#.
- Mirror Lidarr's architecture in workflow design: command orchestration, import stages, unmapped-file handling, organization, and auditability.
- Do not rely on TypeScript alone for safety at process boundaries. Validate request bodies, DB rows, CLI output, and filesystem-derived metadata explicitly.
- Avoid `any`-driven service contracts. Use named types for queue payloads, import candidates, identification results, and route/service boundaries.
- Watch for TypeScript-specific failure modes: thin types over dynamic data, route handlers accumulating business logic, and implicit state transitions that are not captured in the queue/import model.

## Architecture Overview

### Lidarr-Inspired Design
Discogenius follows Lidarr-style patterns:
- **Command System** (`api/src/services/command.ts`): Defines command exclusivity rules (type-exclusive, disk-intensive, globally exclusive)
- **Download Processor**: Handles exact media download jobs only: `DownloadTrack`, `DownloadVideo`, `DownloadAlbum`, `DownloadPlaylist`
- **Scheduler**: Handles all non-download jobs including `DownloadMissing`, `RefreshMetadata`, `RefreshArtist`, `RefreshAlbum`, `CurateArtist`, `RescanFolders`, `ImportDownload`, `ConfigPrune`, `MoveArtist`, `RenameArtist`, `RenameFiles`, `RetagArtist`, and `RetagFiles`
- **Task Queue Service** (`api/src/services/queue.ts`): Persistent task queue in SQLite
- **Manual Import Flow**: `import-discovery.ts` + `import-matcher-service.ts` + `manual-import-service.ts` + `import-finalize-service.ts` + `import-service.ts` + unmapped routes + `identification-service.ts`
- **Fingerprinting Flow**: `fingerprint.ts` / `audioUtils.ts` + MusicBrainz/AcoustID data for local-file enrichment and identification

### Command Types and Exclusivity
| Command | Type Exclusive | Disk Intensive | Notes |
|---------|----------------|----------------|-------|
| DownloadTrack / DownloadVideo | No | No | Small media downloads |
| DownloadAlbum / DownloadPlaylist | No | No | Larger media downloads |
| RefreshArtist | Yes | No | Only one artist refresh at a time |
| RefreshAlbum / ScanPlaylist | No | No | Metadata scans can run in parallel |
| CurateArtist | Yes | No | Per-artist curation pass |
| RescanFolders / RescanAllRoots | No / Yes | Yes | Disk reconciliation for artist or full-library passes |
| MoveArtist / RenameArtist / RenameFiles / RetagArtist / RetagFiles | Yes | Yes | Queue maintenance work instead of running it inline |
| ConfigPrune / Housekeeping / CheckHealth | Yes | Yes | Cleanup and maintenance passes |

## Download backends
- Use Orpheus for music downloads (`album`, `track`, `playlist`) and tidal-dl-ng for `video` downloads.
- Do not route music downloads through tidal-dl-ng. Discogenius keeps Orpheus specifically for music handling, including Atmos-capable paths that tidal-dl-ng can no longer cover reliably.
- Keep backend routing logic in `api/src/services/download-routing.ts`.

## tidal-dl-ng + ffmpeg
- Spawn tidal-dl-ng via `Config.getTidalDlNgPath()` and `buildTidalDlNgEnv()` from `api/src/services/tidal-dl-ng.ts`.
- Use it for video downloads and video progress parsing; do not re-implement download logic in Node.
- Respect `TIDAL_DL_NG_BIN`/`TIDAL_DL_NG_EXECUTABLE` overrides; otherwise rely on PATH.
- Quality profiles are mapped: `HI_RES_LOSSLESS` (Max), `LOSSLESS` (High), `HIGH` (Normal AAC 320k), `LOW` (AAC 96k)
- Video quality: `1080` (fhd), `720` (hd), `480` (sd)
- For downloads: `tidal-dl-ng dl <tidal_url>` (settings via config file)
- tidal-dl-ng handles Dolby Atmos mode automatically via `download_dolby_atmos: True`

## Download Pipeline
1. Job added to `job_queue` table via `TaskQueueService.addJob()`
2. `DownloadProcessor` polls for pending exact media download jobs
3. Checks retry limit (max 3 attempts)
4. Creates per-job staging folder: `{downloads}/.staging/job_{id}_{tidalId}`
5. Chooses the backend based on media type (`download-routing.ts`)
6. Spawns Orpheus for music downloads or tidal-dl-ng for video downloads
7. Emits SSE events via `downloadEvents` with track-level progress
8. On success: `OrganizerService.organizeDownload()` moves files to library
9. Updates `media.downloaded` and album download percentages
10. Cleans up staging on success; `DownloadMissing` stays in the scheduler path and queues concrete download jobs instead of entering the download worker directly

## Import + organization
- Local file scanning/grouping uses `api/src/services/import-discovery.ts`.
- Candidate resolution and match scoring use `api/src/services/import-matcher-service.ts`.
- Manual apply writes use `api/src/services/manual-import-service.ts`.
- Import finalization helpers (sidecars/rename hooks) use `api/src/services/import-finalize-service.ts`.
- Import orchestration and root-folder coordination use `api/src/services/import-service.ts`.
- Download organization uses `api/src/services/organizer.ts`.
- Metadata fetch: prefer `RefreshAlbumService.scanShallow()` / `RefreshArtistService.scan*()` plus helpers in `api/src/services/tidal.ts`.
- Keep `library_files` paths relative to the configured library roots in `Config`.
- For manual import and locally added files, prefer the existing fingerprint + AcoustID/MusicBrainz path over adding ad hoc matching logic.

## Queue + scheduler
- `DownloadProcessor` handles `DownloadTrack`, `DownloadVideo`, `DownloadAlbum`, and `DownloadPlaylist` with real-time progress streaming
- Before Orpheus downloads, make sure the TIDAL token is synced into Orpheus session storage; the session file must not be left empty or partially written.
- `Scheduler` handles all other job types with command exclusivity checks
- Use `CommandManager.canStartCommand()` to check if a job can run
- Emit progress events via `downloadEvents` when changing download flow.
- Current queue/job names live in `api/src/services/queue.ts` and `api/src/services/command.ts`; do not reintroduce stale names like `SCAN_ARTIST`, `LIBRARY_SCAN`, or `REDUNDANCY_CHECK` in new code.
- `RefreshArtist` refreshes TIDAL metadata. `CurateArtist` is the per-artist task behind the user-facing Curation action.
- Queue long-running maintenance actions such as rename apply and retag apply so they appear in `/api/status` activity immediately.

## Monitoring, stats, and locks
- `monitor_lock` on albums and media preserves intentional keep/drop decisions across automated refresh, scan, and curation passes.
- Dashboard downloaded counts are monitored-first, but locked albums/media still count as intentionally kept library state.
- Artist completion is stricter than child-row completion: only monitored artists, or artists with explicitly locked child items, should qualify as completed/downloaded artists.

## Schema updates
- Update `api/src/database.ts` only (no migrations pre-release).
- If schema changes, update related services and docs in the same change.
- The schema already tracks file fingerprints and AcoustID-related import settings; preserve that path when extending manual import.

## Job Types
- `DownloadTrack`, `DownloadVideo`, `DownloadAlbum`, `DownloadPlaylist`
- `RefreshArtist`, `RefreshAlbum`, `ScanPlaylist`, `RefreshMetadata`
- `ApplyCuration`, `DownloadMissing`, `CheckUpgrades`, `Housekeeping`
- `CurateArtist`, `RescanFolders`, `RescanAllRoots`, `ImportDownload`, `ConfigPrune`
- `MoveArtist`, `RenameArtist`, `RenameFiles`, `RetagArtist`, `RetagFiles`
- `BulkRefreshArtist`, `DownloadMissingForce`, `CheckHealth`

## Validation
- Minimum validation for backend changes: `yarn --cwd api build`
- For runtime-sensitive changes (download pipeline, file paths, Docker-only tooling, env/config handling), also validate with `docker compose up --build -d`

## Documentation Canon
- Treat `docs/ARCHITECTURE.md` as current-state architecture truth.
- Track architecture backlog/alignment work in `docs/ARCHITECTURE_WORKPLAN.md`.
- Keep curation/redundancy behavior documentation in `docs/CURATION_DEDUPLICATION.md`.
- Keep `docs/ROADMAP.md` forward-looking only.
- Avoid overlap docs: update existing canonical docs above instead of creating parallel variants.
