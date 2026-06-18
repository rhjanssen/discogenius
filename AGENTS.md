# Discogenius Agent Guide & Memories

This file contains accumulated knowledge, architectural constraints, and user preferences for the Discogenius project. It serves as persistent memory for agents working in this repository and is automatically loaded on every session.

## Universal Project Structure
- **Instructions**: This file (`AGENTS.md`) is the single source of truth for rules.
- **Skills**: Reusable agent workflows and capabilities are located in the `skills/` directory at the root.
- **MCP Servers**: Model Context Protocol configuration is stored in `mcp.json` at the root.

## Project Identity & Goals
- Discogenius is a self-hosted, Lidarr-style music library manager that uses streaming-service rippers (TIDAL via tiddl) instead of torrent indexers.
- Adds discography deduplication on top of release-type filtering.
- Manages stereo, spatial (Atmos), and music-video libraries — by default in three separate library roots.
- **Key decisions**: Keep the TypeScript stack (Express+better-sqlite3 api/, React+Vite+Fluent UI v9 app/). Frontend must stay pure Fluent UI. MusicBrainz is canonical identity; providers are availability/download resources only.

## Layout
- `api/` — Express + TypeScript + better-sqlite3 (synchronous DB access only)
- `app/` — React + Vite + Fluent UI v9 + TanStack Query
- `e2e/` — Playwright tests
- `config/` — runtime state (TOML config, SQLite DB, provider tokens) — never commit
- `.ref_*` — read-only reference checkouts; consult them, never import from them

## Architecture & Development Rules
- TypeScript everywhere; Yarn 1.x only.
- Keep routes thin; durable workflow logic lives in services/repositories.
- Long-running work goes through the queue (`api/src/services/jobs/`), never inline in route handlers. Queue separation: `command-executor.ts` drains the queue, `scheduler.ts` enqueues due scheduled tasks. Use `CommandExecutor.yieldToEventLoop()` (setImmediate) in heavy inline loops.
- Validate external boundaries explicitly.
- Respect `monitored_lock` / `monitor_lock` columns: automation must never flip user-locked monitor state.
- **tiddl integration**: lives in `api/src/services/providers/tidal/tiddl.ts`. Auth is at `config/.tiddl`. tiddl steering = config(global) + args(per-job).
- **Atmos vs Stereo**: TIDAL Atmos has a SEPARATE stereo stream. An Atmos-only release filling the stereo slot is downloaded AS Atmos m4a and organized into `stereo-music`.
- **Hi-Res needs ffmpeg**: TIDAL ships hi-res as FLAC-in-MP4; tiddl extracts via ffmpeg.
- **Matching**: One shared matcher is used for slot-candidate tracks. Beware camelCase vs snake_case differences between callers.
- **Skyhook**: Strips ISRC/UPC. Use local-MB mode for exact ISRC/UPC if needed later. Match on MBID + duration + title distance.

## Performance Facts
- The API uses **synchronous better-sqlite3 on the single Node event loop**, so any slow query stalls the WHOLE app.
- Never scan big tables. Use indexes for foreign keys/filter columns.
- Replace `OR EXISTS(subquery)` with `OR col IN (subquery)`.
- Use `col = 1` not `COALESCE(col,0)=1` for `is_video`/`monitored` so indexes apply.

## Robert's Preferences & Testing
- Use artists **Bastille** and **Bakermat** for live app tests.
- Real-data testing over mocks (use live TIDAL token in `config/`).
- Propose findings back to Robert before larger fix rounds.
- **Reviewing other AI's work**: Be critical of Codex/Claude output. Run FULL `yarn ci` because vite `app build` tolerates type errors. Clean scratch debris. Verify behavioural claims against the running container before trusting them.
- **Native Tools**: DO NOT claim native tools (ffmpeg/fpcalc) are untestable on Windows. Either use `winget install` or test inside the Docker container since the Dockerfile bundles `ffmpeg` + `libchromaprint-tools` (fpcalc).

## Validation Checklist
- `yarn --cwd api build` (after backend changes)
- `yarn --cwd app build` (after frontend changes)
- `yarn ci` = `yarn lint && yarn typecheck && yarn test:api && yarn build` (ALWAYS run before tagging a release to catch tsc-only errors).
- `docker compose up -d --build` (when runtime packaging changes)
- Test flake: the node test-runner occasionally fails a whole file with "Unable to deserialize cloned data" — rerun in isolation.

## Releases
- The Docker image is published by `.github/workflows/release-dockerhub.yml`.
- `yarn release:prepare` drives version bumps.
- Local Docker validation uses `docker-compose.yml` (build) vs `docker-compose.example.yml` (published image).
- Hand-write the CHANGELOG `## [x.y.z]` section first. `node .github/workflows/release/prepare-release.mjs --version x.y.z`. Commit `release: x.y.z`, tag `vX.Y.Z`, push.

## Roadmap & Backlog
- Authoritative, versioned task backlog lives in `docs/TASKS.md`. Always read this to pick up work and keep statuses current.
- See `docs/TASKS.md` for the version plan (2.0.4 - 3.0).
- Deprioritized items: Lidarr parity items (notifications, tags, blocklist, per-artist metadata/quality profiles).

## Database Rules
- Never touch the host SQLite DB directly while the container is running. For ad-hoc inspection, run `docker exec discogenius sh -c 'node /tmp/x.js'` opening better-sqlite3 with `{readonly:true, fileMustExist:true}`.

## Import & M4A
- M4A stores tags fine (iTunes-style atoms).
- Duration "—" bug was due to `music-metadata` failing on Atmos MP4. Fixed with `probeMediaDuration()` (ffprobe).
- Track stays "unknown" when `music-metadata` fails and fuzzy match of title from filename to a provider/MB recording fails.

## AcoustID & MBID Embedding
- Fingerprinting (`fpcalc`) identifies a file. We already embed the full set of `MUSICBRAINZ_*` tags when present.
- Downloads get MBIDs embedded directly.
- We only fingerprint files with NO mbid (imports / pre-existing library).
- Plex matches by its own fingerprint/database, not embedded MBID tags. Jellyfin natively reads `MUSICBRAINZ_*` tags.
