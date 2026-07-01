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
- done: Pruned redundant `TrackFiles` canonical track/recording single-column
  indexes; the fresh schema keeps the covering `(canonical_*_mbid, file_type)`
  composites and asserts the redundant singles stay absent.
- pending: Keep the `TrackFiles` table name unless the cleanup uncovers a real
  product or maintenance benefit from a rename. Lidarr calls playable files
  `TrackFile`; our table intentionally tracks playable audio and videos, while
  sidecars stay in separate Lidarr-style `MetadataFiles`, `LyricFiles`, and
  `ExtraFiles` tables.
- done: Audited sidecar file identity with the `TrackFiles` cleanup. Fresh
  `MetadataFiles`, `LyricFiles`, and `ExtraFiles` rows no longer store legacy
  `album_id` / `media_id` shadows; they link by `track_file_id`, canonical MBIDs,
  provider provenance, and API-only aliases at response boundaries.
- done: Removed legacy import/backfill code that existed only to hydrate
  provider-era `TrackFiles.album_id`/`TrackFiles.media_id` rows; the fresh
  schema no longer creates those `TrackFiles` columns. The sidecar identity audit
  is complete above.
- done (2026-07-01): Ported Lidarr's naming token parser/formatter model.
  Direct source comparison (`.ref_lidarr/src/NzbDrone.Core/Organizer/
  FileNameBuilder.cs` vs `api/src/services/config/naming.ts`) found the
  "port" was already ~90% done — same regex-based `{token}` approach, same
  illegal-character sanitization map, same "The"-prefix transform, same
  case-transform convention (all-lowercase/all-uppercase token name forces
  output case), most of the token vocabulary, and provider tokens already
  additive as this item asked. Closed the three verified remaining gaps:
  - Reserved Windows device names (`aux`/`com1-9`/`con`/`lpt1-9`/`nul`/`prn`
    followed by a dot, e.g. `con.flac` → `con_.flac`) now sanitized in
    `cleanPathSegment`, using Lidarr's exact anchored regex so it can't
    over-match names like "Console" or "Prince".
  - Added `{Artist Genre}` / `{Album Genre}` tokens (first genre, matching
    Lidarr's `Genres?.FirstOrDefault()`), reading the existing
    `ArtistMetadata.genres` / `Albums.genres` JSON columns. Wired through
    all 3 naming-context construction sites in `organizer.ts`
    (`resolveCanonicalArtistForAlbum` now also selects/returns
    `artistGenre`).
  - Added `{Album Disambiguation}` token, reading `Albums.disambiguation`
    (now selected by `getCanonicalAlbumMetadata()`, which previously
    dropped it).
  - Deliberately NOT ported (Lidarr concepts that don't map to
    Discogenius's provider-download model): the Custom Formats system
    (indexer/torrent-release scoring), scene "Release Group" naming +
    Proper/Repack suffix (`{Provider Name}` already covers the analogous
    need; no scene releases), `{Medium Name}`/`{Medium Format}`
    physical-media tokens (Discogenius is always a digital download, so
    this would be a constant value), `{Original Title}`/`{Original
    Filename}` (no scene-release filenames to preserve), configurable
    colon-replacement modes (Lidarr has 5; Discogenius hardcodes the
    equivalent of Lidarr's default "Smart Replace" behavior), and Lidarr's
    title-truncation/ellipsis system for extreme path lengths (real but
    non-trivial — logged as a possible future item, not done now).
  - `{Artist Genre}` support in the `artist_folder` template specifically
    was also deferred: track/video templates get it via `organizer.ts`,
    but artist-folder templates would need `artistGenre` threaded through
    `ArtistFolderSeed` in `api/src/services/music/artist-paths.ts` and its
    own call sites — separate, smaller follow-up if wanted.
  - Added 5 tests to `naming.test.ts` (37 total, was 32): reserved-name
    sanitization (with/without extension, anchor-doesn't-over-match), and
    the three new tokens (present + empty-fallback cases).
- done (2026-07-01): Port/review metadata tag writing against Lidarr's
  implementation. Direct comparison with Lidarr's `AudioTagService` confirmed
  Discogenius already writes the core Lidarr-compatible tag set: standard media
  tags, MusicBrainz artist/release/track/recording ids, release metadata,
  ReplayGain, no-op diff detection, and full-scrub rewrite behavior. Closed the
  verified gaps instead of replacing the working path wholesale:
  - Fixed `write_audio_tags_policy = "all_files"` for manual imports. Existing
    provider downloads and explicit retag commands were already correctly
    tagged; manually imported pre-existing files now get `AudioTagService.apply`
    only under `all_files`, preserving Lidarr's `new_files` vs `all_files`
    distinction.
  - Extended format coverage for imported/downloaded files beyond the current
    TIDAL happy path: `.opus` uses the Xiph/Vorbis-comment mapping, `.wma` uses
    ASF-style field names, `.ape` is recognized but skipped for writes when
    ffmpeg cannot mux it, and `.ape`/`.mp2` are accepted by library scanning so
    old imported libraries are not silently ignored.
  - Investigated Lidarr's `RemoveMusicBrainzTags`: no production caller or API
    endpoint exists in Lidarr, only a unit test, so it remains intentionally out
    of scope unless a real unmap/remap workflow needs it later.
  - Kept the ffmpeg writer. Current retag work runs through background commands
    and no measured bottleneck shows ffmpeg process startup as the limiting
    factor; if future large-library measurements prove otherwise, revisit only
    the tag-write backend as a targeted performance task.

## 2.1.0 - Settings, Provider UX, And General Artist Import

Scope: reduce settings overload before adding more provider and metadata-source
surface area, and replace the followed-only import with a general provider
artist-import. (The 2.0.11 import/responsibility-follow-up work was folded into
this release.)

### Fresh-session context (validation status — read before assuming "done")

- Work for 2.1.0 lives on git branch `2.1.0` (47+ commits past main; 2.0.10 is
  released on main). Check out that branch.
- Import feature: backend + enqueue + `import-sources` are live-validated against
  TIDAL. The modal was browser-tested end-to-end through the TIDAL playlist
  source (`Trouwdienst`): SSE queues immediately, streams status/progress, can run
  in background under worker load, and the resulting `ImportProviderArtists`
  command completed successfully.
- Responsiveness under refresh load IS validated (15/15 enqueues, 64ms health).
  Refresh THROUGHPUT: BOTH scale levers have landed — the diff-reconcile
  skip-unchanged write path (`content_hash` change-key on ArtistMetadata +
  Albums; syncArtist/syncReleaseGroup skip rewriting unchanged rows) AND the
  row-SIZE reduction (fresh schema 34 drops the raw catalog `data` blobs in
  favor of curated columns — see the schema section below for the full
  blob-consumer migration map). Live scale re-measurement against a large
  (multi-thousand-artist) library is still pending and needs the user's real
  library data — not reproducible from a fresh/reset dev DB.
- The Library track-table UI is unified: `LibraryTrackList.tsx` was merged
  into `TrackList.tsx` (2026-07-01) and deleted — Library/Album/Artist all
  render tracks through the one shared DataGrid-backed component now.
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
- done (lever 2, the row-SIZE half): shrink/normalise the per-row `data` blob
  to curated columns (Lidarr stores columns, not raw JSON). Fresh schema 34 no
  longer creates raw catalog `data` columns on ArtistMetadata, Albums,
  AlbumReleases, Recordings, or Tracks; tests assert those blobs stay absent.
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
- done: Audit other request-triggered routes for inline heavy work that
  should be commands (bulk monitor/scan/import paths), same enqueue-and-stream
  pattern, and adopt `runWithAsyncBusyRetry` for their writes. `metadata`
  regeneration now queues `RetagArtist` / `RetagFiles` / `RescanFolders` instead
  of running tag and metadata-sidecar work inline, and `/retag/apply` uses the
  same async busy-retry path for request-thread command enqueueing. Root-folder
  rescans now use only the queued `RescanFolders` path; the old immediate
  `/scan-roots-now` SSE route was removed. Bulk artist download now queues a
  `DownloadMissing` command instead of walking monitored items inline, and
  unmapped manual imports now queue `ImportUnmappedFiles` instead of importing
  mapped files on the request thread. `/library-bulk` now queues
  `LibraryBulkAction`, so bulk monitor/download/lock operations no longer run on
  the request thread. Video search-result clicks now queue add/monitor for
  unknown videos instead of navigating to a detail page that hydrates on GET;
  explicit video add queues `SeedVideo` and returns immediately instead of
  seeding provider metadata inline.
- done (2026-07-01): Fixed video curation so `include_videos=true` monitors
  canonical video recordings even when an artist has no release groups to curate
  yet, while still respecting `monitored_lock`. Runtime-validated on a clean DB
  with Imagine Dragons: refresh/curation found videos, marked 160 as monitored,
  and both Library and artist-page video cards loaded local
  `/media-cover/Videos/...` thumbnails with `mm:ss` duration badges.
- done (2026-07-01): Stabilized the release CI gate by running API test files
  serially (`tsx --test --test-concurrency=1`). This keeps the same 400 API
  tests while avoiding the pre-existing Node test-runner cloned-data flake; full
  `yarn ci` passed afterward.
- done (2026-07-01): Fixed Library track popularity sorting to use track-level
  recording/provider popularity evidence instead of artist popularity, with a
  route-level regression test.
- done (2026-07-01): Reconciled the duplicate Library list/table rendering path.
  The Tracks tab now uses the shared DataGrid table engine through a track-specific
  column wrapper with inline playback row details, while Artists/Albums/Videos keep
  the grid/list view toggle and preserve the selected view. The bulk selection bar
  now appears only when rows are selected.
- done (2026-07-01): Folded AlbumPage tracklists and ArtistPage top tracks into
  the same DataGrid-backed track table path, including inline playback row
  details, number-to-play hover controls, quality badge ordering, and album volume
  section headers.
- done (2026-07-01): Finished the table reconciliation — `LibraryTrackList.tsx`
  was still a parallel, near-duplicate implementation of `TrackList.tsx` (own
  copy of the column-building/styles/playback-dialog code). Merged its
  Library-only behavior (bulk-selection checkboxes, cover-as-play-button
  column, "Downloaded" checkmark column, lazy per-track file loading before
  opening the info dialog) into `TrackList.tsx` behind props
  (`selection`, `showCover`, `showDownloadedColumn`, `disableStickyHeader`),
  deleted `LibraryTrackList.tsx`, and switched `Library.tsx`'s tracks tab to
  the shared component. Also fixed a real bug found in the process: the Album
  column in `TrackList` had no click-to-navigate handler (a pre-existing gap
  on the ArtistPage top-tracks table); it now navigates like the Artist
  column does. Removed the now-dead `TrackTableSkeleton` (zero consumers) and
  its `trackTable*` styles from `LoadingSkeletons.tsx`.
- done (2026-07-01): Naming pass against `.ref_lidarr` on the areas touched by
  this release. Renamed `AppEvent.ARTIST_REFRESH_COMPLETED` /
  `ArtistRefreshCompletedEventPayload` (backend) and the matching
  `"artist.refresh.completed"` SSE event-name literals (frontend hooks +
  `api.ts`) to `ARTIST_REFRESH_COMPLETE` / `ArtistRefreshCompleteEventPayload`
  / `"artist.refresh.complete"`, matching Lidarr's `ArtistRefreshCompleteEvent`
  (`.ref_lidarr/src/NzbDrone.Core/Music/Events/`) — the code comment already
  referenced that name but the implementation had drifted to a past-tense
  suffix. No other naming drift found in commands/events or the audio-tag
  service for this release's scope.
- done (2026-07-01): Documented (not fixed) a real gap Codex's contract tests
  surfaced: Lidarr's `WriteAudioTagsType.Sync` (re-tag already-downloaded files
  when their metadata changes on a later refresh) is deliberately NOT
  implemented — `write_audio_tags_policy` only supports Lidarr's
  `No`/`NewFiles`/`AllFiles`, and `"sync"` is explicitly rejected. Logged as a
  pending item under the metadata-embedding section with the Lidarr source
  reference and an implementation sketch (hook into the diff-reconcile refresh
  port), so it reads as a tracked scope cut rather than a silent omission.

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
- done (2026-06-30): Finished the remaining album-side shallow/deep vocabulary
  cleanup. `RefreshAlbumService` now exposes refresh-level methods
  (`refreshOffer`, `refreshMetadata`, `refreshDetails`, `refreshTracks`) and
  `AlbumRefreshLevel` (`OFFER`/`METADATA`/`DETAILS`) while keeping the same
  adaptive refresh policy behavior. Direct callers were updated; no compatibility
  wrappers for the old scan-depth names remain.

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
- Frontend added-library views (artist, album, library, video, queue/list cards)
  consume backend-shaped artwork URLs only (`/media-cover/...` or other
  renderable URLs). The old client-side TIDAL CDN image builder was deleted so
  provider artwork URL construction stays inside provider interfaces.
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

- done: Centralized editable Discogenius app settings back through the file-backed
  `config.toml` service with normalized typed accessors and cache invalidation on
  writes. The DB-backed override layer was removed so UI, API routes, workers,
  and curation all read the same runtime source.
- done: Keep bootstrap/runtime settings that must exist before SQLite opens in
  environment variables or file-backed config. DB path, auth bootstrap secrets,
  host/port, and container identity are not DB-only storage.
- done (verified 2026-07-01, already satisfied by earlier work): tiddl/Tidarr-
  style downloader configuration is separate from app settings. tiddl owns
  `TIDDL_AUTH_FILE`/`TIDDL_CONFIG_FILE` under `/config/providers/tidal/.tiddl`
  (`api/src/services/providers/tidal/tiddl.ts`) — the TIDAL auth token lives
  ONLY there (grep-confirmed: not duplicated into `config.ts`/DB anywhere).
  `syncTiddlSettings()` one-way mirrors specific normalized Discogenius
  settings (embed_cover, embed_lyrics, video_quality) into tiddl's own
  config.toml; nothing flows the other direction.
- done: Settings writes batch through the config service and clear the file cache,
  avoiding a split DB/file override path and avoiding synchronous DB work for
  settings changes.
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
- done (2026-07-01): Simplified metadata embedding settings to match Lidarr's
  mental model: one main audio-tag writing control backed by
  `write_audio_tags_policy`, separate sidecar sections for artwork/NFO/lyrics/
  video thumbnails, and ReplayGain/fingerprinting kept as independent advanced
  behavior instead of being mixed into provider or sidecar settings.
  - DECIDED (Robert, 2026-06-25) — fold these into the embedding rework:
    - done (2026-07-01): Metadata tag writing now exposes the Lidarr-style
      policy directly in Settings: off, new downloads only, or all files. Fresh
      config defaults to tagging new files only, fingerprinting defaults off,
      and unsupported policy values are normalized/rejected at the config/API
      boundary.
    - pending (deliberate scope cut, not an oversight): Lidarr's 4th
      `WriteAudioTagsType` value, `Sync` (`.ref_lidarr/src/NzbDrone.Core/
      Configuration/WriteAudioTagsType.cs`), is intentionally NOT implemented.
      `Sync` re-writes tags on ALREADY-DOWNLOADED files whenever their
      MusicBrainz metadata changes on a later refresh (Lidarr's
      `AudioTagService.SyncTags`, invoked from the track-refresh path). Our
      `write_audio_tags_policy` only covers Lidarr's `No`/`NewFiles`/`AllFiles`
      (`WRITE_AUDIO_TAGS_POLICY_VALUES` in `api/src/contracts/config.ts`);
      `"sync"` is explicitly rejected by `parseMetadataConfigUpdate`
      (`config-updates.test.ts`) until we actually wire a re-tag-on-metadata-
      change hook into the refresh/curation pipeline. Implement by having
      `RefreshArtist`/`RefreshAlbumService`'s diff-reconcile path (see the
      Lidarr refresh port above) call an equivalent `syncTags` step for tracks
      whose curated columns changed, gated on this policy value.
    - done (2026-07-01): Lyrics now always prefer SYNCHRONISED lyrics over
      plain, for both the saved `.lrc` sidecar and the embedded tag. The
      user-facing plain/synced selector and retired `embed_synced_lyrics`
      config field were removed; providers still fall back to plain text when
      synced lyrics are unavailable.
    - done (2026-07-01): Cover images — for SAVING (the `cover.jpg`/`folder.jpg`
      sidecar files organizer/backfill write into the library folder), always
      request `"origin"` resolution from `resolveAlbumArtwork`/
      `resolveArtistArtwork`/`downloadAlbumVideoCover`, independent of the
      configured `metadata.album_cover_resolution` /
      `artist_picture_resolution`. Those config values now affect ONLY the
      cached `/media-cover/...` image `media-cover-service.ts` serves to the
      UI (`configuredAlbumCoverResolution`/`configuredArtistPictureResolution`,
      used as the last-resort provider-fallback size when no local/Servarr/
      Cover Art Archive image is available — the earlier resolution branches
      already cache/serve the source image at full size unconstrained).
      Fixed at all 6 call sites across `organizer.ts` (both the
      whole-album and per-track reorganize paths) and
      `library-metadata-backfill.ts`.
      EMBEDDING is a separate, already-satisfied case, not something to
      "fix": `audio-tag-service.ts` has no image-embedding code at all —
      cover embedding for provider downloads is fully delegated to tiddl
      (`tiddl.ts` `syncTiddlSettings` writes `[metadata] cover = <bool>`,
      an on/off toggle only; tiddl decides its own fetch resolution, out of
      our control and not resolution-configurable from our side). No action
      needed unless we later add our own in-house tag-embedding path.
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
- done (2026-07-01): Reviewed metadata tag-writing UX alongside the Lidarr port.
  Settings now describes consumer-facing behavior ("Write Audio Tags", "When To
  Write Tags", "Sidecar Files", "Advanced Import Verification") instead of
  exposing implementation details as the primary model. The Retag preview/action
  copy now frames the operation as applying current tag-writing, ReplayGain, and
  fingerprinting settings to tracked audio files.
- done (2026-07-01): Kept the Settings retag status card cheap. The automatic
  `/api/v1/retag/status` request now performs a bounded local scan and skips
  external lyric lookups; the UI labels partial results as a fast scan. Full
  metadata diffing remains behind the explicit preview/apply actions instead of
  blocking Settings page load.
- done (2026-07-01): Kept the Settings rename status card cheap and exposed the
  same maintenance flow at artist/album scope. The automatic
  `/api/v1/mediaFile/rename/status` request now counts the scoped candidate set
  cheaply and evaluates only a bounded scan for rename/conflict/missing samples,
  so Settings no longer has to diff every tracked file on load. `SettingsPage`,
  `ArtistPage`, and `AlbumPage` now share the same Fluent preview dialogs for
  rename and retag actions; artist and album detail pages expose scoped Rename
  and Tags buttons that preview/apply only that artist or album instead of
  forcing users back to the all-library Settings controls.
- done (2026-07-01): Reviewed naming settings UX alongside the parser-gap
  closing work above. `SettingsPage.tsx`'s `NAMING_HELP` copy (field
  titles/descriptions for Artist Folder, Single/Multi-volume Album Track
  Path, Video File) was already clear and appropriately adapted for a
  digital-only library (using "volume" instead of Lidarr's CD-era "disc"
  terminology) — no rewrite needed. Added the three new tokens to
  `ARTIST_NAMING_TOKENS`/`ALBUM_NAMING_TOKENS` with example values so the
  token picker documents them; Discogenius's provider-token additions
  (`{Provider Name}`, `{Provider ArtistId}`, etc.) were already clearly
  separated into their own `PROVIDER_NAMING_TOKENS` section.
- done (2026-07-01): Added a dedicated System/Status page (Lidarr-style
  System → Status/Health), route `/system/status`, nav icon in `Layout.tsx`.
  Backend: new `collectHealthDiagnosticsSnapshot()`-backed route at
  `GET /api/v1/system/status` (`api/src/routes/system-status.ts`, registered
  next to the existing `/api/v1/system/task`), reusing the health-check
  machinery that already existed for the container's `/health` probe
  (`api/src/services/commands/health.ts`) but was never surfaced in the UI.
  Frontend: `StatusPage.tsx` renders three sections — Health (path/tool
  writability + availability checks), Download Backend (tiddl status/
  checks/notes), and Providers (full per-provider capability chips, moved
  out of Settings). Settings' provider cards now collapse capabilities
  behind a "Details" toggle (one-line status + actions visible by default,
  per the decision), with a link to System Status for cross-cutting
  diagnostics.
  NOT done (no backing data exists yet, left as placeholders/omitted rather
  than fabricated): token validity/expiry (not tracked anywhere), Servarr
  Metadata Server reachability (no such check exists — CatalogProvider
  health is a 3.0 concept), rate-limit metrics/last-successful-check
  (available via `/api/v1/status`'s `rateLimitMetrics` but not yet wired
  into the new page — pending, low effort to add later).

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
- done (2026-07-01): Removed curation's title-based dedup fallback.
  `Tracks.recording_mbid`
  is NOT NULL and MB-sourced, so curation always has the recording MBID — the
  `normalizedTitles` fallback in `getPreferredReleaseRecordings` /
  redundancy filter is not just redundant but harmful (two different recordings
  sharing a title — studio vs. live, or unrelated same-named songs — get wrongly
  merged, dropping a release group with unique songs). Dedup/redundancy by
  recording MBID only (guarded to MusicBrainz-shaped MBIDs). The title+duration/
  position/version fallback remains in PROVIDER/import matching, where UPC/ISRC
  may be absent and a weaker key is a legitimate fallback — different context.
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
