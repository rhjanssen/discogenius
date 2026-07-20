# Discogenius Agent Guide & Memories

Accumulated architectural constraints and user preferences. Auto-loaded every
session. This file is the single source of truth for rules; `docs/` holds the
living design/operator docs and `docs/TASKS.md` is the backlog.

## Project identity & goals
- Self-hosted, Lidarr-style music library manager that uses streaming-service
  rippers instead of torrent indexers, plus discography deduplication on top of
  release-type filtering.
- Manages stereo, spatial (Atmos), and music-video libraries — by default in
  three separate library roots.
- Providers: TIDAL, Apple Music, Amazon Music, Spotify, YouTube / YouTube Music,
  and Deezer. Each is an availability/download resource behind one shared
  adapter contract (`docs/STREAMING_PROVIDER_PLUGIN_CONTRACT.md`); TIDAL is the
  most exercised.
- **Key decisions**: keep the TypeScript stack (Express + better-sqlite3 `api/`,
  React + Vite + Fluent UI v9 `app/`). Frontend stays pure Fluent UI.
  MusicBrainz is canonical identity; providers are availability/download only.
- Core views are MusicBrainz/Servarr-primary. Provider data may supplement
  canonical holes (artwork asset ids, copyright, provider URLs,
  availability/downloads), but do not preserve provider-only catalog/discovery
  features (similar artists/albums, top tracks) unless MusicBrainz/Servarr can
  drive them. Drop provider-only sections rather than adding provider catalog
  tables.

## Layout
- `api/` — Express + TypeScript + better-sqlite3 (synchronous DB access only)
- `app/` — React + Vite + Fluent UI v9 + TanStack Query
- `e2e/` — Playwright tests
- `config/` — runtime state (TOML config, SQLite DB, provider tokens) — never commit
- `.ref_*` — read-only reference checkouts; consult them, never import from them
- `docs/LIDARR_STRUCTURE_ALIGNMENT.md` maps our folders to Lidarr's.

## Architecture & development rules
- TypeScript everywhere; Yarn 1.x only.
- Keep routes thin; durable workflow logic lives in services/repositories.
- Long-running work goes through the command queue
  (`api/src/services/commands/`), never inline in route handlers. `CommandModel`s
  (the `commands` table) are enqueued via the queue manager, `command-executor.ts`
  drains and dispatches to handlers in `commands/handlers/`, and `scheduler.ts`
  enqueues due scheduled tasks. Use `CommandExecutor.yieldToEventLoop()` in heavy
  inline loops.
- Validate external boundaries explicitly.
- Respect `monitored_lock` / `monitor_lock`: automation must never flip
  user-locked monitor state.
- **Provider tooling** stays inside the provider adapter/backend. TIDAL's `tiddl`
  lives in `api/src/services/providers/tidal/`; its auth/config live under
  `config/providers/tidal/.tiddl`. tiddl steering = config (global) + args
  (per-job).
- **Atmos vs stereo**: TIDAL Atmos has a SEPARATE stereo stream. An Atmos-only
  release filling the stereo slot is downloaded AS Atmos m4a and organized into
  `stereo-music`.
- **Hi-Res needs ffmpeg**: TIDAL ships hi-res as FLAC-in-MP4; tiddl extracts via
  ffmpeg.
- **Matching**: one shared matcher scores slot-candidate tracks. Beware
  camelCase vs snake_case differences between callers.
- **Servarr Metadata Server** strips ISRC/UPC. Use local-MB mode for exact
  ISRC/UPC; otherwise match on MBID + duration + title distance.

## Performance facts
- The API uses **synchronous better-sqlite3 on the single Node event loop**, so
  any slow query stalls the whole app.
- Never scan big tables. Use indexes for foreign-key/filter columns.
- Replace `OR EXISTS(subquery)` with `OR col IN (subquery)`.
- Use `col = 1` not `COALESCE(col,0)=1` for `is_video`/`monitored` so indexes
  apply.

## Robert's preferences & testing
- Use artists **Bastille** and **Bakermat** for live app tests.
- Real-data testing over mocks (live provider token in `config/`).
- Propose findings before larger fix rounds.
- **Reviewing other AI's work**: be critical. Run FULL `yarn ci` because vite
  `app build` tolerates type errors. Clean scratch debris. Verify behavioural
  claims against the running container before trusting them.
- **Native tools**: do not claim ffmpeg/fpcalc are untestable on Windows. Use
  `winget install` or test inside the Docker container (the Dockerfile bundles
  `ffmpeg` + `libchromaprint-tools` for fpcalc).

## Validation checklist
- `yarn --cwd api build` after backend changes; `yarn --cwd app build` after
  frontend changes.
- `yarn ci` = `yarn lint && yarn typecheck && yarn test:api && yarn build`.
  ALWAYS run before tagging a release to catch tsc-only errors.
- `docker compose up -d --build` when runtime packaging changes.
- Test flake: the node test-runner occasionally fails a whole file with "Unable
  to deserialize cloned data" — rerun in isolation.

## Releases
- The Docker image is published by `.github/workflows/release-dockerhub.yml`;
  `yarn release:prepare` drives version bumps.
- Local Docker validation: `docker-compose.yml` (build) vs
  `docker-compose.example.yml` (published image).
- Hand-write the CHANGELOG `## [x.y.z]` section first, then
  `node .github/workflows/release/prepare-release.mjs --version x.y.z`. Commit
  `release: x.y.z`, tag `vX.Y.Z`, push.

## Database rules
- Never touch the host SQLite DB directly while the container is running. For
  ad-hoc inspection, `docker exec discogenius sh -c 'node /tmp/x.js'` opening
  better-sqlite3 with `{readonly:true, fileMustExist:true}`.
- **MusicBrainz/Servarr is the catalog source of truth.** Providers exist only to
  download media and to supplement allowed catalog holes (cover-art ids,
  copyright, replay gain/peak, provider URLs/availability), never to seed a
  parallel catalog table. Provider UPC/barcode and ISRC are matching evidence and
  stay on `ProviderItems`, not `Albums`/`AlbumReleases`/`Recordings`; normal
  Servarr mode does not populate catalog UPC/ISRC from provider data. There are
  no provider catalog tables: `ProviderItems` is offers/availability and
  `ProviderItemMatches` is match evidence. If a feature is populated exclusively
  from provider data, re-source it from MB/Servarr or remove it. Prefer integer
  catalog FKs for new file joins; do not add provider-shadow catalog columns.

## Import & M4A
- M4A stores tags fine (iTunes-style atoms).
- The duration "—" bug was `music-metadata` failing on Atmos MP4; fixed with
  `probeMediaDuration()` (ffprobe).
- A track stays "unknown" when `music-metadata` fails and the filename-title
  fuzzy match to a provider/MB recording also fails.

## AcoustID & MBID embedding
- `fpcalc` produces a Chromaprint fingerprint + duration; the AcoustID
  web-service lookup maps it to an AcoustID and, when available, MusicBrainz
  recording IDs (it does not return MBIDs without the lookup).
- Fingerprinting is for unknown/mistagged imports; we only fingerprint files with
  NO mbid. We already embed the full `MUSICBRAINZ_*` tag set when present, and
  downloads get MBIDs embedded directly.
- Plex matches by its own fingerprint/database, not embedded MBID tags. Jellyfin
  natively reads `MUSICBRAINZ_*` tags.
