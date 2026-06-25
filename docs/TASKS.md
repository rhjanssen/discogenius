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
- done: Fold `AlbumReleaseMedia` into release metadata; 2.1.0 later moved the
  release medium/disc summary into the curated `AlbumReleases.media` column.
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

## 2.1.0 - Settings, Provider UX, And General Artist Import

Scope: reduce settings overload before adding more provider and metadata-source
surface area, and replace the followed-only import with a general provider
artist-import. (The 2.0.11 import/responsibility-follow-up work was folded into
this release.)

### Fresh-session context (validation status — read before assuming "done")

- Work for 2.1.0 lives on git branch `2.1.0` (3 commits past main; 2.0.10 is
  released on main). Check out that branch.
- Import feature: backend + enqueue + `import-sources` are live-validated against
  TIDAL. The modal was browser-tested end-to-end through the TIDAL playlist
  source (`Trouwdienst`): SSE queues immediately, streams status/progress, can run
  in background under worker load, and the resulting `ImportProviderArtists`
  command completed successfully.
- Responsiveness under refresh load IS validated (15/15 enqueues, 64ms health).
  Refresh THROUGHPUT: the diff-reconcile skip-unchanged write path HAS landed
  (`content_hash` change-key on ArtistMetadata + Albums; syncArtist/
  syncReleaseGroup skip rewriting unchanged rows — Lidarr's UpdateMany-only-
  changed). This eliminates the re-upsert-everything cost on re-refresh. NOT yet
  done: shrinking the per-row `data` blob to curated columns (the row-size half
  of the write cost) — see the blob-consumer map under the schema section.
  Live scale re-measurement against the 2.3GB DB is still pending.
- Line numbers in plans below drift — grep, don't trust them.

### General artist import (folded from 2.0.11)

Replace the followed-only import with a general "Import artists" entry point that
pulls artists from any provider list, with the heavy work on a background command
(the way Lidarr runs import-list sync as a command). TIDAL-first but defined on
the provider abstraction so a second provider can declare its own sources.

- done: Background command. `ImportProviderArtists` registered (type-exclusive,
  runs on a worker); generalised `FollowedArtistsImportService.importArtists(selection)`.
  Routes enqueue and return immediately; the ~180s blocking followed-only import
  is gone.
- done: Provider import-source abstraction on the streaming-provider interface
  (`listImportSources()`, `getArtistsForImportSource(selection)`), implemented for
  TIDAL: followed artists, user playlists, favorite tracks, and home/start-screen
  mixes & featured playlists (all v1 reads, matching Tidarr; v2 only for search).
- done: Routes. `GET /api/v1/provider/import-sources`; `GET /api/v1/artist/import-stream`
  (SSE, enqueues the command and relays bridged `IMPORT_ARTISTS_PROGRESS`) and
  `POST /api/v1/artist/import` (enqueue + 202). The old `import-followed`
  compatibility aliases were removed; followed artists are now just one import
  source category. Full CI green.
- done: Frontend. A single "Import artists" button (Library empty-state + toolbar)
  → `ImportArtistsModal`: pick a source category, then (for playlists/mixes) pick a
  specific list, then run with streamed per-artist progress. SettingsPage import
  now queues in the background. Replaces the followed-only entry points. Validated
  live against the real TIDAL API (followed, favorites, 2 user playlists, 30 home
  mixes/featured all enumerated correctly).
- done: Main-thread user-write resilience. Route enqueues use a new
  `runWithAsyncBusyRetry` (async backoff that YIELDS the event loop, vs the
  worker's synchronous retry) so a user action doesn't fail just because a refresh
  worker briefly held the write lock. Write chunk size lowered to 100 for more
  lock-release points.
- done: Responsiveness under heavy refresh at scale, the Lidarr way. A hand-rolled
  cross-thread write mutex was tried and REMOVED (fragile: reentrancy bug,
  lost-wakeup deadlock, intermittent stalls — and Lidarr has no such thing).
  Final model matches Lidarr (`BasicRepository`/`ConnectionStringFactory`): SQLite-
  native locking + retry + SHORT writes. Workers keep `busy_timeout=30s`+8 retries;
  the main thread uses `busy_timeout=1s` + `withDbWrite`/`runWithAsyncBusyRetry`
  (async backoff that yields the loop); `runChunkedWrite` (chunk 50) keeps worker
  write sections short. Validated live under Springsteen-scale refresh (2099 RGs)
  on the 2453-artist/743K-track DB: 15/15 import enqueues succeeded, max 614ms,
  health 64ms, zero failures, no deadlock. Profile with
  `DISCOGENIUS_WRITE_PROFILE_MS=1000`.
- done (lever 1): skip re-syncing UNCHANGED rows. `content_hash` change-key on
  ArtistMetadata + Albums; `syncArtist` skips the artist+RG-list rewrite when the
  remote artist payload is unchanged, `syncReleaseGroup` skips the whole RG
  tracklist rewrite when the remote RG detail is unchanged (with a repair guard:
  a hash match never suppresses re-hydration of an RG whose child rows are
  missing). Tested in `servarr-metadata.test.ts`.
- pending (lever 2, the row-SIZE half): shrink/normalise the per-row `data` blob
  to curated columns (Lidarr stores columns, not raw JSON). This is the schema
  rework below; the blob-consumer map there is the precise migration list. Until
  the blob is gone, a CHANGED row still writes the multi-KB JSON.
- pending (lever 3): chunk the remaining `syncReleaseGroup` RG+releases
  transaction if a measured write still holds the lock too long after lever 2.
  NOTE: the catalog FK triggers fire only on INSERT / UPDATE OF mbid — NOT on
  `ON CONFLICT DO UPDATE` re-syncs — so they're a new-row cost, not a re-refresh
  cost.
- done (2026-06-25): Removed the user-facing fixed refresh interval controls
  from Settings and stopped using `scan_interval_hours` / `*_refresh_days` to
  decide artist refresh due-ness. The monitoring scheduled task is now only an
  internal due-check cadence (`DISCOGENIUS_MONITORING_DUE_CHECK_INTERVAL_MINUTES`,
  default 60m); artist selection uses the adaptive `ShouldRefreshArtist` policy.
  The old monitoring config/API fields and `/v1/config/monitoring` endpoint were
  removed; old interval fields are now rejected instead of accepted for
  compatibility.
- done (2026-06-25): `RefreshMetadata` no longer refreshes managed artists
  inline. It queues per-artist workflow entry jobs so scheduled/manual refreshes
  reuse the same `RefreshArtist` -> `MatchArtistProviders` -> optional
  `RescanFolders` / `CurateArtist` chain.
- done (2026-06-26): `RefreshArtist` no longer recursively queues first-order
  credited collaborators as unmanaged artist refreshes. Credited release groups
  stay local canonical metadata, and active refresh dedupe ignores label-only
  payload drift plus stale expansion flags, preventing thousands of queued
  unmanaged collaborator jobs from one managed artist.
- done (2026-06-25): Album/track provider refresh checks no longer use
  `album_refresh_days` / `track_refresh_days`; `RefreshAlbumService` now uses
  the adaptive album and track-set refresh policies. Removed the dead
  `scan-refresh-state` helper/tests so the old fixed-day refresh model no longer
  exists in production or test-only code.
- done (2026-06-25): Runtime compatibility cleanup: fresh DB startup remains the
  only supported path. Startup now rejects non-current existing schemas instead
  of running historical migrations/backfills; obsolete trigger cleanup and schema
  format marker writes were removed. Config loading now normalizes to current
  monitoring/filtering/metadata shapes instead of carrying old keys forward, and
  the frontend no longer migrates old library localStorage settings.
- pending: Audit other request-triggered routes for inline heavy work that should
  be commands (bulk monitor/scan/import paths), same enqueue-and-stream pattern,
  and adopt `runWithAsyncBusyRetry` for their writes.

### Architecture decision: keep TypeScript, decompose (not a .NET port)

DECIDED (2026-06-24): do NOT port to .NET/C#. A port would not fix the scale
bottleneck — SQLite's single-writer limit is language-agnostic (Lidarr hits
`database is locked` too), and the actual cost is the data model (per-row raw
JSON `data` blobs → ~21ms/upsert) + write volume, identical in any language.
.NET's only real edge is responsiveness-under-contention, which we've matched
with worker_threads + async-retry (validated: 15/15 enqueues, 64ms health under
Springsteen-scale refresh). Stay on TypeScript; fix scale via decomposition +
data-model + skip-unchanged, all Lidarr-aligned.

### Port Lidarr's refresh model; drop shallow/deep; separate provider matching

Our shallow/deep scan split is a pre-2.0 artifact from when the catalog WAS the
provider (TIDAL) and rate limits forced partial scans. Now the catalog is
MusicBrainz/metadata-server, so we should port Lidarr's refresh model instead.

Lidarr's model (studied in `.ref_lidarr/src/NzbDrone.Core/Music/Services/`):
- `RefreshEntityServiceBase<TEntity,TChild>` — a template method: `GetRemoteData`
  (fetch from metadata source) → `UpdateEntity` (upsert) → reconcile children into
  Added/Updated/Removed (`SortedChildren`) → `InsertMany`/`UpdateMany` ONLY the
  changed rows → `RefreshChildren` cascade. Hierarchy: RefreshArtist → RefreshAlbum
  → RefreshAlbumRelease → RefreshTrack, each its own service + command.
- `ShouldRefreshArtist` staleness (no shallow/deep): new / >30d / <12h-skip /
  not-ended+>2d / last-release<30d → refresh; else skip. Optional MB
  changed-since (`GetChangedArtists`) to refresh only what MB says changed.
- Disk rescan (`RescanArtists`) is a SEPARATE, config-gated concern after refresh.

Target Discogenius design:
- `RefreshArtist` (Lidarr-port): fetch MB artist + release groups, **diff** vs
  local (Added/Updated/Removed), batch-write only changes, cascade to release/
  track refresh when changed. Gated by a `ShouldRefreshArtist` staleness check.
  Removes scanShallow/scanDeep AND the full re-upsert every refresh — the
  diff-only writes are exactly the short-write / skip-unchanged scale fix.
- `MatchArtistProviders` (our provider feature, kept separate): the connected-
  providers loop + provider↔MB matching + slot selection.
  - DONE (commit e529277): extracted from `scanDeep` into
    `RefreshArtistService.matchArtistProviders(artistId, artistMbid, options,
    shouldHydrateCatalog)` — the standalone method seam. Behaviour-preserving
    (scanDeep does metadata intake → calls matchArtistProviders → stamps
    last_scanned; full suite 394/394). `scanDeep` still calls it INLINE.
  - DONE (commit f3034b0): promoted to its own queued command (name/body/model/
    registry/handler + `buildMatchArtistProvidersCommand`). `scanDeep` gained
    `deferProviderMatching` and returns `{artistMbid, shouldHydrateCatalog}`; the
    RefreshArtist handler runs intake-only then ENQUEUES MatchArtistProviders
    with that context; `ARTIST_REFRESH_COMPLETED` now fires from the match
    handler so RescanFolders→CurateArtist still chain AFTER slots are selected.
    Direct callers (scheduler, bulk RefreshMetadata) keep inline matching. The
    enqueue is a DB-backed queue write (worker-safe; scheduler claims on next
    tick). LIVE-VALIDATED in Docker on Bastille: RefreshArtist (intake, 109 RGs)
    → MatchArtistProviders #35 (192 TIDAL albums → 82 stereo + 18 spatial slots)
    → RescanFolders, event chain intact, 0 errors, 113 albums visible.
- Chain: `RefreshArtist` → `MatchArtistProviders` → `RescanFolders` →
  `CurateArtist`. Each a short, independently-queued unit.
- done (2026-06-25): Artist refresh no longer accepts `scanDepth` and
  `upsertMusicBrainzArtist` no longer stamps `last_scanned` during display-only
  seeding. Search-result navigation can seed the artist page, then queue the
  normal refresh workflow instead of making a shallow row look fully scanned.
- pending: Finish the remaining album-side shallow/deep vocabulary cleanup.
  `RefreshAlbumService` still has `scanBasic`/`scanShallow`/`scanDeep` naming,
  although its refresh due checks now use the adaptive policy.

Execution notes: big redesign — do with full focus, build/test-gated. Reuse the
existing catalog tables; the win is the diff-reconcile write path (port
`RefreshEntityServiceBase` + `SortedChildren` + `ShouldRefresh*`). Split oversized
service files + trim comments toward Lidarr's structure in the same passes.

### Schema target: curated columns, drop the raw `data` blobs

Do this WITH the refresh port (above). Today every catalog row stores the entire
raw metadata response as a `data` TEXT blob (~3KB/row → the 743K-track DB is
mostly duplicated JSON → ~21ms/upsert). Lidarr stores NO raw blob: it extracts
~12–15 fields per entity and discards the rest — scalars as real columns, small
bounded arrays/objects as ONE JSON column per field (its `EmbeddedDocumentConverter`
pattern), relational sets as child tables.

Decision rule per field: filter/join on individual elements → child table; store
as a set for display/membership → one JSON column; single value → scalar column.

Target columns = Lidarr's set + our UPC/ISRC/provider value-adds (most scalars
already exist; the change is dropping the raw blob and adding the per-field JSON
columns, then computing FK ids in code):

- ArtistMetadata: scalars name, sort_name, type, status, disambiguation, overview;
  JSON cols images, links, genres, ratings, aliases, members, old_foreign_ids.
- Albums (release group): scalars title, primary_type, first_release_date,
  disambiguation, overview; JSON cols secondary_types, images, links, genres,
  ratings, old_foreign_ids; child table AlbumReleases.
- AlbumReleases: scalars title, status, duration, date, track_count, media_count,
  barcode (UPC, 1:1); JSON cols label, country, media (disc structure),
  old_foreign_ids; child table Tracks.
- Recordings: scalars title, length_ms, artist_credit; JSON col isrcs (1:many —
  graduate to indexed child table RecordingISRCs(recording_id, isrc) if ISRC→
  recording lookup becomes a hot matching path).
- Tracks: scalars number, absolute_number, title, length_ms, explicit,
  medium_position, position; JSON col ratings.

UPC vs ISRC shape (why they differ): a release has exactly one barcode → scalar;
a recording can have many ISRCs (MB returns a list) → set/JSON. Both are our
value-add beyond Lidarr (Skyhook strips UPC/ISRC — the reason for local-MB) and
must be preserved as queryable columns, NOT in a blob.

Payoff: rows shrink from ~3KB to a handful of typed fields → fast writes (the
scale fix) AND cheap diff change-detection. The change-detection half is ALREADY
DONE via `content_hash` (compare a hash, never the blob); dropping the blob is
the remaining row-SIZE win.

Blob-consumer migration map (grep-verified 2026-06-24 — migrate each off the
catalog `data` blob to columns BEFORE dropping the blob, or these break). The
catalog `data` blob (ArtistMetadata/Albums/AlbumReleases/Recordings/Tracks) is
read in these places; `ProviderItems.data` is a SEPARATE provider blob, out of
scope here.

DONE (schema 32→34, on branch `2.1.0`):
- Step 1: curated columns ADDED + populated in the write path, grounded in real
  /artist + /album payloads (not guessed): ArtistMetadata +overview,status,links,
  genres,ratings,aliases,old_foreign_ids; Albums +overview,links,genres,ratings,
  aliases,old_foreign_ids; AlbumReleases +label,media,old_foreign_ids (and now
  persists barcode/UPC, which the old write silently dropped).
- `getCachedReleaseGroupsForArtist`: external-link evidence now from the release-
  GROUP `links` column via `extractLinkUrls` (the URLs live on the RG, not the
  release — old `extractExternalUrls(release.data)` was effectively empty).
- `getLinkedProviderArtistId`: reads `ArtistMetadata.links`.
- `syncArtist`: merge dance removed; shallow album no longer clobbers detail cols.
- `musicbrainz-release-group-read-service` + `musicbrainz-release-selection-service`
  + `provider-matches`: the three `json_each(...,'$.Media')` reads now iterate the
  `AlbumReleases.media` column.
- `artist-query-service`: album-card artwork resolves from the `images` column via
  `imageContainerFromImagesColumn` (new helper in media-cover-service).
- `release-group-artwork-service.ts`, `musicbrainz-release-group-read-service.ts`,
  and `routes/search.ts`: release-group artwork now resolves from `Albums.images`
  via `imageContainerFromImagesColumn`.
- `metadata-files.ts` (NFO/artwork): album and artist artwork now read `images`;
  album review/overview and release copyright use typed columns; video artist
  credits use `Recordings.credits`.
- `musicbrainz-release-group-read-service.ts`, `track-query-service`, and
  `audio-tag-service`: recording artist credits now read `Recordings.credits`.
- `download-queue-query-service`: queue cover art now uses the shared
  canonical-first album artwork resolver (`Albums.images` / Servarr Metadata
  Server or Cover Art Archive URL first, provider artwork as fallback) and
  replaces provider cover IDs already present in older queue payloads.
- Fresh schema 34 drops the raw catalog `data` columns from ArtistMetadata,
  Albums, AlbumReleases, Recordings, and Tracks. Writers no longer populate those
  blobs.

REMAINING before release validation:
- `provider-matches.ts:720` (`album.data`): NOT catalog — this is a provider
  album row (`ProviderItems.data`, parses `.tracks`). Out of scope; leave as-is.
- Reset/rebuild the dev DB, re-import, and re-measure refresh write throughput on
  the big library. Tests build a fresh schema each run, so only the FINAL live
  scale validation needs the reset — keep iterating green via `yarn test:api`
  until then.

### Settings and provider UX

Reduce settings overload before adding more provider and metadata-source surface
area.

- done: Move editable Discogenius app settings out of `config.toml` into
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
- done: Add a settings-write path that batches/saves changes through a
  service layer, clears the settings cache, and emits a config-changed event.
  This must avoid chatty per-control writes and must not add long synchronous DB
  work to high-traffic routes.
- done: Redesign connected-provider settings so each provider gets a compact
  connection card with status, primary actions, and capability summary. Move
  advanced/token/backend details behind disclosure panels or diagnostics instead
  of showing them inline by default. DECIDED: collapse the capability "wall of
  checkmarks" to the few axes that differ between services and that the library
  quality model curates around — baseline "download" (not a chip), one tiered
  "Lossless up to 24-bit" quality line (not separate 16-bit/24-bit chips),
  "Spatial / Dolby Atmos", and "Music videos". Lower-level capabilities (lyrics,
  artwork, ReplayGain, codecs) live in the card's "Details" disclosure, not as
  chips.
- pending: Add multi-provider selection/switching UX once the second provider is
  real. The UI should distinguish default provider, enabled providers, provider
  capability gaps, and per-library-type availability without duplicating raw
  provider config fields.
- pending: Simplify metadata embedding settings to match Lidarr's mental model:
  one main "Embed metadata tags" toggle backed by the tag-write policy, with
  separate sidecar toggles for NFO, artwork, lyrics, video thumbnails, and
  ReplayGain/fingerprinting only where they are genuinely independent.
  - DECIDED (Robert, 2026-06-25) — fold these into the embedding rework:
    - Lyrics: always prefer SYNCHRONISED lyrics over plain, for both the saved
      `.lrc` sidecar and the embedded tag. Today `lyric-service` keys synced on
      the `.lrc` extension (`isSynced`); choose synced whenever a provider
      offers it, only falling back to plain when synced is unavailable.
    - Cover images: for EMBEDDING + saving, always use the HIGHEST resolution
      available from either the Servarr metadata server or the provider (TIDAL
      album art = `origin` size; artist art = the provider's max). The UI may
      keep serving smaller cached sizes; only the embed/save path forces max-res.
    - AcoustID (RESEARCHED 2026-06-25, authoritative — see sources in chat):
      - Plex does NOT read embedded `ACOUSTID_*` tags — its sonic/fingerprint
        analysis RE-COMPUTES its own fingerprint server-side. So embedding
        AcoustID does nothing for Plex. What helps Plex is the embedded
        MusicBrainz IDs (Local Media Assets / MB-aware matching) — which we
        already write and should keep front-and-centre.
      - Embedded `ACOUSTID_ID`/`ACOUSTID_FINGERPRINT` ARE consumed by Picard,
        beets (chroma), and Jellyfin (reads Picard-written tags) — a niche
        re-tagging-workflow benefit, not a Plex one.
      - Lidarr confirms the split: `AudioTag.cs` writes ONLY MusicBrainz IDs (no
        acoustid field); `Parser/FingerprintingService.cs` uses fpcalc → AcoustID
        `meta=recordingids` purely as IMPORT-MATCH evidence (score threshold),
        gated by `AllowFingerprinting` (incl. existing files). It never embeds.
      - DECISION: (1) do NOT embed AcoustID tags by default — make it an explicit
        advanced opt-in (Picard/beets/Jellyfin users), off by default, never in
        the main happy path. (2) Reframe fpcalc as an optional IMPORT-VERIFICATION
        gate, not a tagging feature: for provider-downloaded files we already
        hold the MB recording id from the provider→MB match, so the fingerprint
        is redundant for identity; only run it to CROSS-CHECK files that lack
        clean provenance (user's pre-existing library files), Lidarr-style —
        AcoustID's returned recording ids scored against our expected recording.
- pending: Review metadata tag-writing UX alongside the Lidarr port so settings
  describe consumer-facing behavior rather than exposing implementation detail;
  advanced provider/provenance tag extensions should live behind disclosure or
  diagnostics, not in the main happy path.
- pending: Review naming settings UX alongside the parser port so file/folder
  variables, previews, and examples match Lidarr terminology and behavior, with
  clearly separated Discogenius provider-token additions.
- pending: Move provider health, catalog-source health, and download-backend
  diagnostics into a dedicated status/diagnostics area so the main Settings page
  stays task-oriented. DECIDED: a dedicated System/Status page (Lidarr-style
  System → Status/Health) for cross-cutting health (token validity/expiry,
  download-backend/tiddl health, Servarr Metadata Server reachability, rate-limit
  metrics, last successful check). Provider cards keep only a one-line status with
  a "Details" disclosure for provider-specific diagnostics.

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
  importing `ServarrMetadataService`.
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
- pending: Make the artist song-set RECORDING-centric, not release-group-centric.
  Today curation gathers songs from release groups the artist is primary on OR
  credited in (`Albums.artist_mbid` OR `ArtistReleaseGroups.scope`), so it can
  MISS track/recording-level contributions — a featured vocal on one track of
  someone else's album, a guest verse, a session/remix credit — which are
  credited at the MusicBrainz *recording* level, not the release group. To "get
  all individual songs by an artist AND songs they contributed on", gather by
  recording artist-credit (recording MBID). Blocker: we only store
  `Recordings.artist_mbid` (the PRIMARY artist) + an `artist_credit`/`credits`
  TEXT blob, so "all recordings where artist X is any credit" is not queryable.
  Model recording↔artist-credit as a queryable relation (primary + featured) —
  fits the curated-column/refresh-port schema work. Identity stays recording MBID
  (already what curation dedups on); ISRC remains matching evidence only.
- pending: Remove curation's title-based dedup fallback. `Tracks.recording_mbid`
  is NOT NULL and MB-sourced, so curation always has the recording MBID — the
  `normalizedTitles` fallback in `getPreferredReleaseRecordings` /
  redundancy filter is not just redundant but harmful (two different recordings
  sharing a title — studio vs. live, or unrelated same-named songs — get wrongly
  merged, dropping a release group with unique songs). Dedup/redundancy by
  recording MBID only (guard that it's a valid MBID). KEEP the title+duration/
  position/version fallback in PROVIDER/import matching, where UPC/ISRC may be
  absent and a weaker key is a legitimate fallback — different context.
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
