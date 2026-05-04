# Discogenius AI Coding Agent Instructions

## Canonical Location
This repo uses a single agent directory: `.github`.
All agents (Copilot, Claude, Gemini, GPT) should read instructions here and load skills from `.github/skills`.

## GitHub Custom Instruction Compatibility
- Keep repository-wide guidance in `.github/copilot-instructions.md`.
- Keep path-specific guidance in `.github/instructions/**/*.instructions.md` using frontmatter `applyTo` globs when needed.
- Keep coding-agent operational guidance in a repository-level `AGENTS.md`.
- Avoid conflicting directives across instruction types; when adding new rules, update all relevant files in the same change.
- Validate behavior against GitHub docs support matrix and instruction precedence before introducing new instruction files.

## Project Snapshot
Discogenius is a self-hosted MusicBrainz/Lidarr-style library manager with provider-backed streaming/download integrations. Monorepo with `api/` (Express + TypeScript) and `app/` (React + Vite). Local development (Node + Yarn + a repo-local `.venv` for `tidal-dl-ng`, or `TIDAL_DL_NG_BIN`/PATH override) and Docker builds are both supported.

Discogenius should stay architecturally close to Lidarr (/.ref_lidarr) where it makes sense: MusicBrainz/Lidarr metadata is the canonical artist/release-group/release/track graph, and providers expose availability, preview, lyrics, and download resources. TIDAL is the first provider, not the core metadata model. Tidarr (/.ref_tidarr) is a good reference for pragmatic provider/indexer/downloader integration. Although it uses tiddl, and Discogenius uses Orpheus for music and tidal-dl-ng for video, the general download staging flow should be similar and attach to our Lidarr-style management structure.

### Architecture Overview
- **Download System**: Uses media-specific download backends with a Lidarr-style command queue: Orpheus for music downloads and tidal-dl-ng for video downloads
- **Metadata Model**: Uses Lidarr/MusicBrainz artist, release-group, release, medium, track, and recording identity as canonical library metadata
- **Provider Layer**: Keeps provider-specific catalog IDs, quality flags, preview URLs, lyrics, and download resources behind provider interfaces; do not add new direct TIDAL catalog calls outside provider implementations
- **Task Queue**: SQLite-backed queue with `DownloadProcessor` (exact media downloads only) and `Scheduler` (all control, scan, import, and maintenance jobs)
- **Command Manager**: Handles job exclusivity (type-exclusive, disk-intensive, globally exclusive)
- **Organization**: Downloaded files are staged, then organized into library with metadata, optional fingerprints, and library file tracking
- **Manual Import**: Dashboard-based manual import flow is backed by unmapped file tracking, `import-discovery.ts`, `import-matcher-service.ts`, `manual-import-service.ts`, `import-finalize-service.ts`, `import-service.ts`, and `identification-service.ts`

## Hard Rules
- **TypeScript**: Use TypeScript for runtime code in `api/src` and `app/src`, and keep Playwright tests in `e2e/` in TypeScript. Use JavaScript only where tooling or external config conventions make it the better fit.
- **Backend**: Use `better-sqlite3` synchronously. Never use async DB wrappers.
- **Backend**: Use Orpheus for music downloads (`album`, `track`, `playlist`) and tidal-dl-ng for `video` downloads. Do not route music downloads through tidal-dl-ng; Atmos-capable music handling depends on the Orpheus path.
- **Backend**: Resolve tidal-dl-ng via `Config.getTidalDlNgPath()`/`buildTidalDlNgEnv()` from `api/src/services/tidal-dl-ng.ts`, and keep Orpheus session/runtime handling in `api/src/services/orpheus.ts`.
- **Backend**: Prefer a repo-local `.venv` for `tidal-dl-ng` during local development. Keep the auto-detection/path bootstrap aligned with that convention before adding new per-machine flags.
- **Backend**: Quality profiles map to tidal-dl-ng: `HI_RES_LOSSLESS` (Max), `LOSSLESS` (High), `HIGH` (Normal AAC 320k), `LOW` (AAC 96k).
- **Backend**: Preserve Lidarr-style separation between queueing, command exclusivity, scheduling, organization, and scan/import flows.
- **Backend**: Long-running maintenance operations such as curation, root scans, rename applies, and retag applies must queue background jobs and surface through `/api/status`; do not run them inline from routes.
- **Backend**: Use fingerprinting for manually added audio files where available. Prefer the existing `fpcalc`/AcoustID/MusicBrainz path instead of inventing a new matching path.
- **Backend**: Preserve the core discography workflow: curation and download of full/partial artist discographies with deduplication safeguards, while supporting import of existing local files as first-class managed library content.
- **Backend**: A TypeScript backend is an acceptable architecture for Discogenius. Do not treat a C# rewrite as a prerequisite for Lidarr-style rigor.
- **Backend**: Downloaded dashboard counts are monitored-first, but album/media rows with `monitor_lock = 1` count as intentionally kept library state. Artist completion must still be gated by monitored artist state or explicitly locked child items.
- **Frontend**: Use Fluent UI React v9 components, tokens, and `makeStyles`. Do not import other UI libraries.
- **Frontend**: Use `@tanstack/react-query` for data fetching.
- **Frontend**: Theme state must come from `FluentThemeProvider`/`useTheme`; do not duplicate dark-mode detection in layout components.
- **General**: Use Yarn only. Do not switch this repo to npm or pnpm.
- **General**: Pre-1.0, prefer deleting stale compatibility paths over carrying aliases, legacy job types, or old route names forward.
- **General**: Do not introduce parallel implementations or long-lived compatibility layers without a documented migration/removal plan. When a new path replaces an old path, delete or consolidate the superseded path as part of the work whenever feasible.
- **General**: After meaningful frontend/backend changes, validate with `yarn --cwd app build && yarn --cwd api build`, and when packaging/runtime behavior matters, rebuild and run the Docker container with `docker compose up --build -d`.

## TypeScript Discipline
- Treat Lidarr's workflow architecture as the thing to emulate, not its implementation language.
- Validate external boundaries explicitly. TypeScript types do not validate HTTP payloads, CLI output, DB rows, or filesystem state at runtime.
- Do not let backend code collapse into route-heavy orchestration with weak domain models. Keep routes thin and move durable workflow logic into services/repositories.
- Avoid casual `any`, ad hoc object shapes, and untyped cross-service payloads, especially around queue jobs, manual import, and scan results.
- Model long-running job state and import decisions explicitly so retries, failure reasons, and exclusivity remain explainable.

## Skills
Skills live in `.github/skills` and should be loaded when relevant:
- `discogenius-backend` for auth flows, tidal-dl-ng integration, task queue, command system, and database schema.
- `discogenius-frontend` for Fluent UI patterns, theming, and Tidal image/video rules.
- `discogenius-architecture` for architecture boundaries, queue/event/datastore separation, and documentation update rules.
- `discogenius-theming` for centralized Fluent theme and dynamic brand handling.

## Key Services
| Service | Purpose |
|---------|---------|
| `tidal-dl-ng.ts` | tidal-dl-ng CLI wrapper for video downloads, environment setup, progress parsing |
| `orpheus.ts` | Orpheus runtime bootstrap, TIDAL session sync, and music download spawning |
| `download-processor.ts` | Handles exact media download jobs: `DownloadTrack`, `DownloadVideo`, `DownloadAlbum`, `DownloadPlaylist` |
| `scheduler.ts` | Handles non-download jobs: `DownloadMissing`, `RefreshMetadata`, `CurateArtist`, `RescanFolders`, `ImportDownload`, `MoveArtist`, `RenameArtist`, `RenameFiles`, `RetagArtist`, `RetagFiles` and operator commands: `BulkRefreshArtist`, `DownloadMissingForce`, `RescanAllRoots`, `CheckHealth`, `CompactDatabase`, `CleanupTempFiles`, `UpdateLibraryMetadata`, `ConfigPrune` |
| `health.ts` | Collects runtime/path/tool/backend diagnostics used by startup preflight and the real `CheckHealth` scheduler command |
| `playback.ts` / `playback-segment-worker.ts` | Provides signed browser-safe playback, preferring BTS/progressive and falling back to DASH segment streaming when needed |
| `command.ts` | Defines command types and exclusivity rules (Lidarr-style) |
| `command-history.ts` | Builds `/api/status` activity from queued jobs, including pending command-style work |
| `queue.ts` | `TaskQueueService` and job type definitions for the persistent task queue |
| `organizer.ts` | Moves downloaded files to library with proper naming |
| `refresh-artist-service.ts` | Lidarr-style artist metadata orchestration (basic/shallow/deep refresh) |
| `refresh-album-service.ts` | Lidarr-style album metadata orchestration and track hydration |
| `refresh-playlist-service.ts` | Playlist metadata and membership refresh |
| `refresh-video-service.ts` | Video upsert/refresh helpers for artist catalog scans |
| `media-seed-service.ts` | Targeted metadata seed flows for single track/video intake |
| `providers/` | Provider interface and provider implementations; TIDAL-specific catalog logic belongs here |
| `metadata/lidarr-metadata-service.ts` | Lidarr metadata API cache for MusicBrainz artist/release-group/release/track graph |
| `tidal.ts` | Low-level TIDAL API client used by the TIDAL provider and legacy compatibility paths only |
| `import-discovery.ts` | Scans local/root folders into grouped local import candidates and derives common tags |
| `import-matcher-service.ts` | Resolves TIDAL candidates (direct IDs, search, fingerprint evidence), scores matches, and applies auto-import policy |
| `manual-import-service.ts` | Applies strict manual import mappings and updates artists/albums/media/library_files with dedup safeguards |
| `import-finalize-service.ts` | Finalizes imported directory moves, sidecar reconciliation, and post-import rename hooks |
| `import-service.ts` | Orchestrates root-folder scan/import flows and delegates matching/apply/finalize services |
| `library-media-metrics.ts` | Shared unmapped-media metric extraction used by scan/import review persistence |
| `library-scan-root-review.ts` | Handles root-folder review cleanup and unmapped review-candidate persistence |
| `library-scan-relink.ts` | Repairs unresolved `library_files` rows by relinking to known media via injected scan dependencies |
| `task-scheduler.ts` | Orchestrates scheduled task passes (Lidarr-aligned per-artist pipeline) and queue lifecycle |
| `task-state.ts` | Persists scheduled-task runtime progress and resolves active-workflow state from queue/runtime |
| `schedule-policy.ts` | Schedule normalization, staleness/due policy helpers, and include-decision helpers |
| `curation-service.ts` | Artist-level curation engine: category filtering, version-group selection, ISRC/subset dedup, monitor propagation, download candidate generation |
| `library-metadata-backfill.ts` | Handles artist/album/track/video metadata file backfill and tracked metadata-sidecar updates |
| `identification-service.ts` | Assigns manual import candidates to TIDAL tracks using file/title matching |
| `fingerprint.ts` / `audioUtils.ts` | Chromaprint/AcoustID helpers for audio identification and enrichment |

## Repository Maintenance
- **Dependencies**: Keep dependencies updated. Access `package.json` in `api/` or `app/` to check versions.
- **Linting**: Ensure code passes `eslint` checks. Run `yarn lint` if unsure.
- **Cleanup**: Remove unused files and dead code proactively.
- **E2E**: The `e2e/` folder is real and wired to root scripts, but it is currently lightweight and not CI-enforced. Do not delete it as dead code without checking coverage expectations first.

## Documentation
- **Location**: User/dev documentation lives in `README.md` and `docs/`.
- **Architecture canon**: Keep current-state architecture in `docs/ARCHITECTURE.md`.
- **Architecture backlog**: Keep architecture consolidation/Lidarr-alignment work in `docs/ARCHITECTURE_WORKPLAN.md`.
- **Curation canon**: Keep curation/redundancy semantics in `docs/CURATION_DEDUPLICATION.md`.
- **Roadmap scope**: Keep `docs/ROADMAP.md` forward-looking; do not use it as implemented-feature history.
- **Alpha release planning**: `docs/RELEASE_DISTRIBUTION_PLAN.md` is alpha operational guidance and should not be treated as a required document in the cleaned public 1.0 runtime repo.
- **Updates**: When changing significant logic (e.g., UltraBlur, monitoring), update the relevant MD file in `docs/`.
- **New Features**: Create a new design/documentation file in `docs/` before implementing complex features.

## Workflows
See `.github/workflows` for local + Docker dev steps, Docker deploy, and docs update guidance.



## Agent Release Workflow
- Treat public-repo cutover as one-time only at `1.0.0`.
- Use `yarn release:cutover <new_repo_git_url> 1.0.0 <target_dir> [--push]` exactly once when creating the new public repo.
- For all future releases (`1.0.1`, `1.1.0`, `2.0.0`, etc.), do not use cutover; use:
  - `yarn release:prepare --version <semver>`
  - `yarn install && yarn build && yarn lint`
  - commit + tag `v<semver>` + push
- Rely on `.github/workflows/release-dockerhub.yml` for Docker publish + GitHub release asset/notes publication.
- Keep `CHANGELOG.md` updated and concise; release workflow reads from it.
- Database schema upgrades remain PRAGMA `user_version` migrations; the 1.0.x baseline uses an independent integer schema series starting at `1`, and runtime app/api/schema provenance is tracked in `config` keys and `database_version_history`.
