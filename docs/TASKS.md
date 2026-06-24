# Discogenius Task Backlog

Single source of truth for outstanding work. Shipped history belongs in
`CHANGELOG.md`; this file should only describe work that still needs a decision,
implementation, or release validation.

Status: pending | in progress | done | revisit

## 2.0.8 - Canonical Alignment Release

Scope: canonical database alignment, monitoring download-cycle fix,
upgrade-check forcing fix, Servarr Metadata Server terminology, and related
canonical-provider cleanup already listed under the unreleased `CHANGELOG.md`
section.

Release blockers before tagging:

- done: Full `yarn ci` passed on 2026-06-23 after the 2.0.8 version bump.
- done: Remaining schema/index cleanup is deferred to 2.0.9.
- done: Prepared the release metadata with
  `node .github/workflows/release/prepare-release.mjs --version 2.0.8`, then run
  `yarn install --frozen-lockfile --non-interactive`; no lockfile change was
  needed.
- done: Replaced `## [2.0.8] - Unreleased` in `CHANGELOG.md` with
  `## [2.0.8] - 2026-06-23`.
- done: Ran `docker compose up -d --build` and smoke-tested the container on
  2026-06-23. Docker health was healthy; `/`, `/health`, `/api/health`, and
  `/api/v1/status` responded. The smoke-test container was stopped afterward.

## 2.0.9 - Upgrade Cutoff Cleanup

Scope: remove the materialized upgrade ledger and keep upgrade decisions on the
Lidarr-style cutoff path.

Release blockers before tagging:

- done: `CheckUpgrades` no longer reads or writes `upgrade_queue`; upgrade
  decisions stay in `UpgradableSpecification` and queue normal download
  commands.
- done: Recent completed upgrade download/import command history now suppresses
  immediate no-improvement requeues, replacing the old skipped ledger.
- done: `downloaded-tracks-import-service` no longer clears upgrade ledger rows.
- done: Fresh schema no longer creates `upgrade_queue` or its indexes, and the
  baseline test asserts that the table is absent.
- done: Focused upgrader/schema tests passed under WSL on 2026-06-23.

## 2.0.10 - File And Release Schema Cleanup + Refresh-Load Responsiveness

Scope: deeper file-table and release-media normalization, plus fixing the
container freeze/`unhealthy` lockup under heavy refresh load. Keep the schema
Lidarr-aligned where that buys clarity, and remove Discogenius-specific
transitional/provider shadows where they no longer pay for themselves.

- done: Fixed the main-thread SQLite freeze that made the container unreachable
  under refresh load. The main thread now fails fast (`busy_timeout = 1000ms`,
  single retry) instead of blocking the event loop for ~30s on a contended
  write; workers keep 30s + 8 retries. Large catalog write transactions are
  chunked (`runChunkedWrite`) so no single refresh holds the write lock for a
  whole big artist. Validated live: `/health` ~85ms, event-loop p99 ~20ms,
  zero `database is locked`. See `db-responsiveness-facts` memory.
- done: Replace remaining file/sidecar joins that still read
  `TrackFiles.album_id` and `TrackFiles.media_id` with provider identity and
  catalog FK joins, then remove those columns from the file tables. The
  fresh-schema columns are removed, provider identity is aliased only at API
  compatibility boundaries, and import, manual import, rename/tag, search,
  disk-scan, download-state, stats, and sidecar replication paths were
  converted. Full CI green and runtime-validated in Docker against real data.
- done: Fold `AlbumReleaseMedia` into `AlbumReleases.data`; release medium/disc
  summaries now derive from the MusicBrainz release JSON unless a measured hot
  query later needs an indexed projection.
- done: Normalized v1 API resource routes against Lidarr's singular controller
  convention. Core catalog routes remain `/api/v1/artist`, `/api/v1/album`,
  `/api/v1/track`, and `/api/v1/video`; system tasks moved to
  `/api/v1/system/task`; managed playable files moved to `/api/v1/mediaFile`
  because Discogenius tracks audio and video files; streaming provider status
  moved to `/api/v1/provider`.
- pending: Prune redundant `TrackFiles` canonical indexes where composite indexes
  fully cover the hot paths.
- pending: Keep the `TrackFiles` table name unless the cleanup uncovers a real
  product or maintenance benefit from a rename. Lidarr calls playable files
  `TrackFile`; our table intentionally tracks playable audio and videos, while
  sidecars stay in separate Lidarr-style `MetadataFiles`, `LyricFiles`, and
  `ExtraFiles` tables.
- pending: Audit sidecar file identity at the same time as the `TrackFiles`
  cleanup so sidecars link by `track_file_id`, catalog FK/MBID, and provider
  provenance instead of legacy `album_id`/`media_id` shadows.
- in progress: Remove legacy import/backfill code that exists only to hydrate
  provider-era `TrackFiles.album_id`/`TrackFiles.media_id` rows after the
  provider provenance replacement is complete.
- pending: Port Lidarr's naming token parser/formatter model instead of growing
  a Discogenius-only parser. Keep Discogenius extensions additive only, such as
  provider name/id variables for users who want streaming-service provenance in
  folder or file names.
- pending: Port/review metadata tag writing against Lidarr's implementation
  instead of growing a Discogenius-only tagging model. Keep MusicBrainz tags and
  standard media tags Lidarr-compatible first; add Discogenius-only provider or
  streaming-quality tags only as optional extensions that do not replace the
  canonical MusicBrainz tag set.

## 2.0.11 - Background Import + Responsiveness Follow-Ups

Scope: finish moving long-running, request-triggered work off the HTTP path,
the way Lidarr runs import-list sync as a scheduled command.

- pending: Convert the TIDAL followed-artists import into a background
  `ImportFollowedArtists` command. Today `FollowedArtistsImportService.importFollowedArtists`
  runs the per-artist loop (MusicBrainz identity resolve + `syncArtist` +
  monitor) inline in the request, so `POST /api/v1/artist/import-followed`
  blocks for the whole import (~180s for a large follow list). The 2.0.10
  busy-timeout + chunked-write fixes stop this from freezing the server and the
  primary UI path already uses the long-lived `import-followed-stream` SSE
  endpoint, but the work still belongs on a worker: register the command, have
  the route enqueue and return immediately, and stream worker progress events
  back over SSE (the worker pool already bridges `appEvents` to the main thread).
- pending: Audit other request-triggered routes for inline heavy work that
  should be commands (e.g. bulk monitor/scan/import-list paths), using the same
  enqueue-and-stream pattern.

## 2.1 - Settings And Provider UX

Scope: reduce settings overload before adding more provider and metadata-source
surface area.

- pending: Move editable Discogenius app settings out of `config.toml` into
  DB-backed settings with a UI, using Lidarr's pattern: a small `config`
  key/value table, typed service accessors, defaults in code, an in-memory
  cache, and cache invalidation on writes. Avoid reading the TOML file on hot
  request paths.
- pending: Keep bootstrap/runtime settings that must exist before SQLite opens
  in environment variables or a small file-backed config. Do not move DB path,
  auth bootstrap secrets, host/port, or container identity into DB-only storage.
- pending: Treat tiddl/Tidarr-style downloader configuration separately from
  app settings. Tidarr edits `.tiddl/config.toml` directly and reloads it into
  process memory; Discogenius should keep tiddl-owned auth/config files under
  `/config/providers/tidal/.tiddl` and only mirror normalized UI settings into
  DB when the app needs typed policy decisions.
- pending: Add a settings-write path that batches/saves changes through a
  service layer, clears the settings cache, and emits a config-changed event.
  This must avoid chatty per-control writes and must not add long synchronous DB
  work to high-traffic routes.
- pending: Redesign connected-provider settings so each provider gets a compact
  connection card with status, primary actions, and capability summary. Move
  advanced/token/backend details behind disclosure panels or diagnostics instead
  of showing them inline by default.
- pending: Add multi-provider selection/switching UX once the second provider is
  real. The UI should distinguish default provider, enabled providers, provider
  capability gaps, and per-library-type availability without duplicating raw
  provider config fields.
- pending: Simplify metadata embedding settings to match Lidarr's mental model:
  one main "Embed metadata tags" toggle backed by the tag-write policy, with
  separate sidecar toggles for NFO, artwork, lyrics, video thumbnails, and
  ReplayGain/fingerprinting only where they are genuinely independent.
- pending: Review metadata tag-writing UX alongside the Lidarr port so settings
  describe consumer-facing behavior rather than exposing implementation detail;
  advanced provider/provenance tag extensions should live behind disclosure or
  diagnostics, not in the main happy path.
- pending: Review naming settings UX alongside the parser port so file/folder
  variables, previews, and examples match Lidarr terminology and behavior, with
  clearly separated Discogenius provider-token additions.
- pending: Move provider health, catalog-source health, and download-backend
  diagnostics into a dedicated status/diagnostics area so the main Settings page
  stays task-oriented.

## 2.2 - Streaming Provider Expansion

Scope: make additional streaming-service integrations real without changing the
database model for each provider. TIDAL is the only fully working provider
today; Apple Music is planned but not yet functional end to end.

- pending: Finish the Apple Music provider and bring it to TIDAL parity:
  auth/token handling, catalog and artist search, followed/favorite import,
  lossless/spatial/video downloads, lyrics, artwork, download backend binding,
  provider capability reporting, diagnostics, and provider evidence capture.
- pending: Harden the provider abstraction so adding a provider is a plugin-level
  integration, not a schema change. Providers remain availability/download
  resources only.
- pending: Define the provider-plugin contract: provider manifest, capability
  descriptors, auth lifecycle, catalog/offers API, download backend binding,
  lyrics/artwork hooks, quality mapping, and diagnostics.
- pending: Add at least one more provider candidate after Apple Music as a proof
  of the plugin contract. Candidate selection should be based on available
  download backend viability, not catalog-only browsing.
- pending: Add import sources for provider playlists, external chart lists, and
  the existing followed-artist set.
- pending: Add import-list exclusions so removed items are not re-added.

## 2.3 - Library Types

Scope: replace fixed stereo/spatial/video slots with user-configurable library
types.

- pending: Replace the fixed stereo/spatial/video slots with configurable
  library types: name, root, content kind, and desired quality.
- pending: Migrate `ReleaseGroupSlots` from fixed slot names to library-type
  identifiers while preserving monitored and lock semantics.
- pending: Download/curate per library type while keeping release-type filtering
  global.

## 3.0 - Catalog Source Modes And Local MusicBrainz

Scope: full metadata-provider/backend-mode implementation in backend and
frontend. Users should be able to choose the hosted Servarr Metadata Server or a
local MusicBrainz-docker instance.

- pending: Wire `CatalogProvider` into the live runtime so artist search,
  artist refresh, release-group refresh, matching, artwork hydration, and import
  identity all go through the selected catalog source instead of directly
  importing `servarrMetadataProxy`.
- pending: Add backend config and persistence for catalog source mode:
  `servarr-metadata` and `musicbrainz-local`, plus the local `/ws/2` base URL,
  health status, last successful check, and user-facing validation errors.
- pending: Add frontend settings for catalog source selection: Servarr Metadata
  Server as the hosted default, Local MusicBrainz as the advanced/self-hosted
  mode, with connection test, clear warnings about setup cost, and links to
  `docs/MB_LOCAL_MODE.md`.
- pending: Implement safe mode switching. Switching from MB-local to Servarr
  Metadata Server must build the local canonical cache for monitored artists;
  switching from Servarr Metadata Server to MB-local must avoid destructive cache
  churn and should lazily refresh records through MBIDs.
- pending: Define and implement supplemental Servarr Metadata Server lookups for
  fields a local MusicBrainz mirror does not serve well or at all. Examples:
  cached/normalized artwork URLs, metadata-server ratings/popularity, and any
  Servarr-specific convenience fields. Supplemental data must never override
  MusicBrainz identity, release grouping, track identity, UPC/ISRC evidence, or
  provider-resource evidence.
- pending: Add the local-MusicBrainz external-link matching tier once MB-local
  mode is wired into runtime.
- revisit: Unify edition-aware matching around one shared scoring path that uses
  recording MBID/ISRC, position, volume, duration, and title-distance evidence.
- pending: Add multi-user support with users, roles, and auth.

## Ongoing Matching And Availability

These tasks can land in any release above if they unblock that release.

- in progress: Finish release-centric provider matching. Current state:
  composite release matches are persisted in `ProviderItemMatches`, and slot
  selection can use those persisted matches. Remaining work is to refactor
  `provider-release-group-matcher` so provider albums score directly against
  all candidate MusicBrainz releases for the artist rather than being
  constrained to one release group container. Evidence priority should be local
  MusicBrainz external links, UPC/barcode and ISRC/recording coverage, then
  title/version/date/type/medium/tracklist shape.
- pending: Implement artist-wide release/recording coverage optimization before
  final per-release-group slot selection. Use MusicBrainz recording MBIDs first,
  ISRC fallback second, and title/duration/position shape only when stronger
  identity is missing. Apply the user's release-type, secondary-type,
  explicit/clean, spatial/video, and library-type filters before solving
  coverage, so unchecked or disallowed releases are not candidates. Objective:
  full filtered-discography coverage with the fewest releases/provider downloads
  and least redundant overlap, then use quality, explicit/clean preference,
  evidence strength, and track count as tie-breakers.
- pending: Add curation tests for edition choice affecting global coverage:
  verify that a smaller edition plus one EP can beat a larger edition that
  forces multiple singles or leaves recordings unavailable.
- pending: Only recompute composite matches for artists/release groups whose
  provider offers changed.

## Deprioritized

Pick these up only if a concrete need appears:

- Notifications, tags, blocklist/failed releases.
- Per-artist metadata or quality profiles. The preferred model is library-type
  quality, not per-artist quality.
- Metadata-consumer profiles beyond the existing MBID tagging and NFO/artwork
  sidecar support.
