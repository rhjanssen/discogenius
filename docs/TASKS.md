# Discogenius Task Backlog

Single source of truth for outstanding work. Shipped history belongs in
`CHANGELOG.md`; this file should only describe work that still needs a decision,
implementation, or release validation.

Status: pending | in progress | done | revisit

## Post-2.3.1 Performance Follow-ups

- pending: Replace the remaining large-artist top-track ranking query with a
  bounded/cached catalog projection. The 2.3.1 staged artist page makes the
  identity header available in about 0.2s, but a 10-track slice can still take
  roughly 5s on the current 2 GB catalog.
- pending: Profile and bound artist-wide retag preview/status on a large library;
  a live two-file check was correct but still took about 14s while catalog work
  was active.
- revisit: Housekeeping currently owns the exclusive command slot for its full
  database optimization pass. Add granular progress/cancellation or split the
  maintenance work if another large-catalog run confirms that user commands
  wait unreasonably long behind it.

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
  blob-consumer migration map). Live scale re-measurement is now complete on the
  user's large runtime DB (2026-07-02): 6.5k artists, 69k release groups, 154k
  releases, 810k recordings, 2.0M tracks, ~1.3 GB SQLite file. During a timed
  drain sample after the worker-slot/video-matcher fixes, completed commands
  advanced 611 → 620 in 3 minutes, queued commands dropped 448 → 446, and
  RefreshArtist / MatchArtistProviders / CurateArtist / RescanFolders cycled
  end-to-end with `/health` healthy and no `database is locked` or crash-loop
  signatures in recent logs.
- The Library track-table UI is unified: `LibraryTrackList.tsx` was merged
  into `TrackList.tsx` (2026-07-01) and deleted — Library/Album/Artist all
  render tracks through the one shared DataGrid-backed component now.
- Stability under the 531-artist import stress test (2026-07-02): the
  crash-restart loop (unhandled worker rejection on SQLITE_BUSY) and the
  video-matcher write-lock livelock (156s-per-video candidate query inside the
  write transaction) are both fixed — see commits b17d5fe/362ef82/cc577b6.
  Import summaries now itemize monitored/already-monitored/unmatched/failed so
  a 531→494 shortfall is visible in the task description (457dcde).
- done (2026-07-02): unmatched provider-import artists are surfaced on
  System Status → Import (name + reason: no MB match vs ambiguous), served by
  `/system/status` via `ProviderArtistIdentityService.listUnmatched()`.
  Same commit wires the default provider's live request-pacing/rate-limit
  metrics (from `/v1/status`) into the Providers section — closing the
  "pending, low effort" note under the Status-page item. Also fixed a
  dashboard queue render loop (`useSelectableCollection` returned a
  fresh-but-equal selection array every render → "Maximum update depth
  exceeded" under queue SSE load) and executor slot starvation (top-20
  candidate window filled by one concurrency-capped type; per-type rank now
  keeps every queued type represented — Lidarr's whole-queue TryGet
  equivalent).
- done (2026-07-03, branch 2.1.1): the unmatched list is now actionable
  (Lidarr-style manual mapping). Each row has "Find match" (dialog with MB
  candidates ranked by discography-overlap evidence — shared album titles
  shown — plus name-match badges and a raw-MBID escape hatch; applying reuses
  the import's `ensureMonitoredArtist` + identity store + intake queue) and
  "Ignore" (`match_status='ignored'`, for karaoke/typo/pseudo-artists with
  nothing to match). Same session: discography-overlap fallback in the
  automatic resolver (resolved LU BACH, Laura Reed, Niemen, R. City, Ray
  Charles Orchestra live — unmatched 35→14) and multi-identity hydration
  (`resolveProviderArtistIds` unions release catalogs when a provider splits
  one artist into several entries, e.g. TIDAL's two Concertgebouworkest ids).
- done (2026-07-03, branch 2.1.1): provider-artist identity fallback now uses
  structured provider album evidence instead of title strings only. When
  name/alias/URL evidence is inconclusive, the resolver samples provider albums
  (title, UPC, date, type, track/volume count), expands the MusicBrainz
  candidate set via bounded Servarr `type=all` release searches, and scores
  artist candidates with the existing release matcher evidence tiers (UPC/ISRC
  when exposed, then release-title/year/type/track-shape). The sampler strips
  remix/version noise, searches short titles first, paces metadata calls, and
  exits once a candidate clears the ambiguity guard. Live validation:
  TIDAL `33469788` "Eden" resolves to MusicBrainz
  `1be7cde4-8c97-4a83-8a85-5fd251da4be8` (Eden Alene) via
  `provider-discography-release-search` from shared release evidence, despite
  the provider catalog also containing unrelated homonymous "Eden" releases.
- done (2026-07-02): provider↔MusicBrainz matching now uses canonical provider
  URL relationships before falling back to names/titles. Artist import accepts
  exact MusicBrainz artist URLs and high-confidence alias-prefix matches (fixes
  the Concertgebouworkest → Koninklijk Concertgebouworkest miss), while release
  matching normalizes provider URLs across TIDAL, Apple Music, and Spotify
  instead of treating URL evidence as TIDAL-only. ListenBrainz Labs and Odesli
  were researched: Labs is a useful future track-level MBID→Spotify/Apple/
  SoundCloud fallback; Odesli is useful for user-facing link discovery, but is
  not canonical enough to outrank MusicBrainz URL relations, UPC, or ISRC
  evidence in the download matcher.
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
- closed by measurement (2026-07-02, lever 3): NOT needed. With write
  profiling at 1s (`DISCOGENIUS_WRITE_PROFILE_MS=1000`) during a live
  494-artist intake drain on the ~1 GB DB, zero write transactions exceeded
  1s after the video-matcher livelock fix (commit cc577b6) — the earlier long
  holds were that query, not `syncReleaseGroup`'s transaction size. Re-open
  only if a future `[write-profile]` log implicates it.
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
- done (2026-07-02): Reset/rebuild + large-library live throughput validation is
  complete on the user's populated runtime DB. Keep iterating green via
  `yarn test:api` / `yarn ci`; no additional reset is required before release
  unless a later schema change demands it.

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

## 2.1.1 - Queue Robustness And Load Responsiveness

Scope: keep the app usable while tens of thousands of downloads are queued —
download coordination off the main thread, real per-track download progress,
cheap queue/stats reads, and the queue-card/boot UX polish from the 2.1.1 arc.

- done (2026-07-02): Download coordinator moved into a dedicated worker thread
  (`DownloadProcessorWorkerProxy` + `download-processor-worker-entry.ts`).
  The proxy relays main-thread `COMMAND_ADDED` events into the worker (route
  and command-worker enqueues now wake it), command workers get an inert stub
  so the upgrader cannot start a competing download loop, and worker status
  posts before request acks so pause/resume status is never stale. Smoke test
  under WSL passed (initialize/pause/resume round-trips + event bridging).
  2026-07-03 hardening: only `initialize()` may spawn the worker (control
  calls pre-init no-op) and the worker is unref()'d — otherwise any api test
  touching the upgrader spawned a worker thread that kept the node test
  runner alive forever (upgrader-canonical hang). Full suite 431/431 after.
- done (2026-07-02): True numeric per-track download progress via a provider-
  side tiddl wrapper (`tiddl-progress-wrapper.py`) that monkey-patches
  `RichOutput.download_start/advance/finish` + `aiohttp.ClientSession._request`
  and emits `DISCOGENIUS_TIDDL_PROGRESS` JSONL on stderr (bytesTotal from
  Content-Length → percent). Emission is throttled (percent change or 250ms),
  writes are single-syscall atomic (ffmpeg shares the stderr pipe and split a
  JSON line mid-write), and the backend ignores fragment lines defensively.
  Verified live: percent flows wrapper → backend → worker → SSE → QueueTab.
- done (2026-07-02): Fixed progress state loss: `persistDownloadState` now
  merges partial progress events into the buffered snapshot instead of
  replacing it (a generic status line used to wipe per-track fields before the
  1s flush), and resets per-track fields when the current track changes.
- done (2026-07-02): Fixed the under-load collapse. Root cause: the SSE
  progress-stream handler called `getActiveProgressSnapshots()`, which mapped
  the ENTIRE backlog (5000-row cap, ~33s of synchronous main-thread work at
  ~28k queued commands) per connection — reconnecting EventSources piled up
  and livelocked the API. It now maps only `started` jobs (~15ms). Also:
  id-first sorted pagination in `listJobsByTypesAndStatuses` (payload blobs no
  longer dragged through the sorter), `ROW_NUMBER()` queue positions instead
  of a correlated COUNT per row, a covering index
  (`idx_commands_queue_view`), a 1.5s event-invalidated snapshot cache for
  queue/history/details/status reads, and stale-while-revalidate `/stats`.
  Measured: `getQueue(50)` 3.1s → 0.9s cold / 0ms cached; snapshots 33s →
  14ms; event-loop p95 ~20ms with 28k queued commands during active
  downloads + imports.
- done (2026-07-02): Frontend request fan-out: dashboard feeds ignore
  per-second `command.updated` progress ticks (SSE carries live progress) and
  poll only as fallback (queue 5s, history/activity 15s);
  `QueueStatusProvider` no longer double-fires invalidate+refetch pairs.
- done (2026-07-03): Removed the remaining avoidable Library mount fetch. The
  `useLibrary` hook now initializes artist/album server-side filters, sort, and
  album library/download/lock filters from the same persisted settings that the
  Library page renders, instead of mounting under broad default query keys and
  immediately replacing them from a later effect. Browser CDP verification on a
  dev build showed the first `/api/v1/artist` request already included
  `monitored=true` and no aborted artist requests were emitted during the
  capture.
- done (2026-07-02): UI polish per feedback: error pages use the Fluent
  `ErrorCircle48Color` icon (general icons stay monochrome regular); the
  Lidarr-style pulsing-circles indicator is gone (Fluent `Spinner` for route
  fallbacks); the boot page shows a larger Discogenius logo with the Auth-page
  blur-glow behind it, pulsing as the loading indicator (funny lines kept).
  Boot is a short bounded phase again: 4s auth-status check, then the app
  loads optimistically even if the API is slow (no fatal access-gate page).
- done (2026-07-03): Album-level download progress now derives from item
  counts, like imports. tiddl's "Total Progress" panel is a Rich Live table
  that never prints on a piped stdout (why cards sat at 0% then jumped to
  done). The wrapper hooks `RichOutput.total_increment` (queue_total) and
  `show_item_result` (queue_progress — fires for downloaded, overwritten AND
  already-existing items, so skips don't stall the bar); the backend converts
  completed/total into progress + currentFileNum/totalFiles. Validated live:
  33-item album climbing 27%→30%→38% with 10/33→14/33 file counts.
- done (2026-07-03): Track rows now update live and correctly under tiddl's
  parallel downloads: per-title statuses accumulate across the progress
  buffer window (`trackStatusByTitle`) and are applied to catalog rows by
  longest-prefix title match, with index inference kept as the import-path
  fallback; the SSE client applies the same per-title updates between polls.
  Fixed OSC-8 hyperlink escapes (Rich file links) leaking into
  statusMessages — stripAnsi now removes OSC sequences.
- done (2026-07-03): Queue card indicator scheme per design feedback: active
  download/import rows show a spinner; downloaded rows show a brand-orange
  filled checkmark; download+import complete uses the multicolor
  CheckmarkCircle Color variant (also for history completed); the group chip
  shows spinner + "importing" (checkmark removed). Active and history cards
  share one desktop layout (title + artist left on one line, badges +
  progress/indicator right); mobile keeps the stacked layout.
- done (2026-07-03): Import progress rows now preserve the album tracklist
  across the download -> import handoff, import progress SSE includes the
  active track list, and the organizer emits per-track import progress before
  it starts moving/tagging the file (then completion after the file record is
  written). Queue rows merge live SSE progress with persisted queue rows so
  active import rows show a spinner instead of stale downloaded/completed
  state. Removed visible "importing" row/header text; the spinner/checkmark
  icons carry the state. Desktop and mobile dev-preview checks passed.
- done (2026-07-03): Hardened the import progress handoff after live feedback:
  every download/import progress event now carries the current stored track
  list when the tick itself is partial, so the browser can render the active
  import spinner immediately instead of waiting for the next queue poll.
- done (2026-07-03): Hardened the dashboard queue fallback refresh. The active
  queue feed now polls the first page once per second with a short timeout and
  replaces the previously loaded first page instead of merging stale completed
  rows back into Active; additional loaded pages remain preserved for manual
  pagination.
- done (2026-07-03): Provider track evidence is now materialized instead of
  buried in album JSON. Whenever the TIDAL album-track API is fetched for
  disambiguation or album refresh, Discogenius persists real
  `ProviderItems(entity_type='track')` rows keyed by provider track id and maps
  them to MusicBrainz tracks by selected-release medium/position. Album
  provider rows no longer store `data.tracks`; the provider-track table shape is
  the locked contract for future streaming plugins and local-MusicBrainz mode.
- done (2026-07-03): TIDAL/tiddl staging filenames now use provider identity
  (`{album.id}/{item.id}` for audio and `{item.id}` for videos) instead of
  track number + title. This is deliberately download-workspace-only: final
  managed library filenames still come from Discogenius naming profiles and
  canonical MusicBrainz metadata. The album importer now matches staged files
  through the materialized provider track id -> MusicBrainz map only, with the
  old title/ISRC/track-number/blob-overlay fallbacks removed. Focused WSL
  coverage was retargeted in `organizer-canonical.test.ts`.
- done (2026-07-03): Provider-id import matching now tolerates stale/partial
  materialization. If any staged numeric provider-id filename is not present in
  the album's `ProviderItems(entity_type='track')` rows, the organizer forces
  one provider track refresh and retries the exact-id match before reporting
  an unmatched file.
- done (2026-07-03): Download and import now use one persisted lifecycle row.
  `DownloadAlbum`/`DownloadTrack`/`DownloadVideo` stay `started` through the
  import phase and transition their `downloadState` from downloading to
  import-pending/importing/completed; the import worker runs as a transient
  internal phase on the same command id. The queue/history UI no longer needs a
  separate `ImportDownload` row to represent the same logical download.
- done (2026-07-03): `DownloadMissing` no longer bulk-enqueues the entire
  wanted backlog as tens of thousands of concrete download rows. It runs as a
  bounded coordinator that recomputes monitored missing media from canonical
  library state, keeps at most 50 concrete download commands buffered, treats
  failed rows as represented until retry/clear, and refills as the queue drains.
  Focused WSL coverage asserts monitored albums can be queued in bounded
  batches.
- done (2026-07-03): Empty or missing download workspaces no longer fail as
  opaque "No media files found" imports. The import service now detects whether
  the staged workspace actually contains supported media files; if not, it
  recovers already-imported library files when possible and otherwise emits a
  retryable "Re-download the item to retry import" failure so download recovery
  queues a fresh download even when the stale workspace directory still exists.
  Focused WSL coverage was added in `download-recovery-canonical.test.ts`.
- done (2026-07-03): Schema-contract audit added for the provider-plugin/local
  MusicBrainz boundary. Fresh-schema tests now assert that catalog rows keep
  integer catalog FKs, have no raw `data` blobs, and do not store provider
  resource evidence (`provider`, `provider_id`, provider URLs/assets, UPC, or
  ISRC). `ProviderItems` and `ProviderItemMatches` are asserted to remain
  provider-agnostic evidence/match-edge tables with MusicBrainz IDs as targets.
  `AlbumReleases.barcode` is intentionally retained for canonical MusicBrainz
  release barcodes; provider UPC stays in `ProviderItems.upc`.
- revisit: A full Lidarr-style in-memory queue projection is still useful if
  the bounded concrete queue ever becomes insufficient, but the 28k-row backlog
  is no longer materialized into the active download queue by `DownloadMissing`.

## 2.2 - Streaming Provider Expansion

Scope: 2.2.0 currently focuses on local MusicBrainz catalog mode and the
download/import simplification that it unlocks. Additional streaming providers
remain planned, but are no longer the first 2.2 cut.

- done (2026-07-04): Local MusicBrainz-docker mode now has a runtime
  `PostgresMusicBrainzCatalogProvider` that reads the MusicBrainz Postgres
  schema directly and optionally uses the co-located `/ws/2` Solr search when
  reachable. The provider registry switches from config, sync paths fetch
  through the active provider, global search and artist lookup/manual-match
  candidate search use the active provider, MB recording ISRCs persist to the
  curated `Recordings.isrcs` column, and MB mode was smoke-tested live against
  `192.168.1.100` (`Bakermat`, `Strandfeest`).
- done (2026-07-04): MusicBrainz settings are host-only. Users enter
  `192.168.1.100`, `musicbrainz.mydomain.com`, `db`, or `host:postgresPort`;
  Discogenius derives the Postgres DSN and optional `/ws/2` probe. Old
  `musicbrainz_url` / `MB_LOCAL_WS_URL` compatibility paths were deliberately
  removed while the schema/config surface is still in active development.
  Focused coverage now asserts host normalization and DSN/search-URL derivation.
- done (2026-07-04): MB mode artwork now keeps Servarr/fanart as the preferred
  artist-image supplement and provider artist pictures as backup; album art
  remains Servarr/CAA/provider.
- done (2026-07-04): MB-local Solr search now hydrates artist hits from
  Postgres before returning them, so global search, artist lookup, manual match,
  and import-identity flows get full release-group/discography evidence instead
  of Solr-only artist shells.
- done (2026-07-04): Credited-release discovery now uses the active catalog
  source. In MB-local mode it queries MusicBrainz Postgres for release groups
  plus full artist-credit rows instead of calling public `musicbrainz.org/ws/2`;
  Servarr mode keeps the previous web fallback.
- done (2026-07-04): TIDAL/tiddl progress now carries provider track identity
  from the native downloader item context. The wrapper patches
  `Downloader.download` as well as Rich progress hooks, emits
  `providerTrackId`, provider track number, and volume number on item progress,
  and suppresses duplicate completion events when tiddl reports both download
  finish and item result. Backend queue snapshots/SSE and the frontend progress
  cache now prefer provider-id row matching, with title matching kept only as a
  legacy/partial-event fallback.
- done (2026-07-05): Added the first provider-plugin manifest contract slice.
  `StreamingProvider` now exposes an optional manifest describing provider id,
  config root, auth mode, download backends, catalog/import capabilities,
  quality mapping coverage, and a typed diagnostics vocabulary. TIDAL and
  Apple Music publish manifests, `/api/v1/provider` returns them, frontend
  provider status types understand them, and the provider registry test asserts
  built-in manifest consistency. Route management flags no longer hardcode
  TIDAL authentication.
- done (2026-07-05): Provider diagnostics now execute from the manifest contract
  instead of being only descriptive strings. `getProviderDiagnostics` produces
  typed auth/catalog/download-backend/rate-limit rows from cheap local checks,
  verifies declared download backends against the registered backend map, and is
  exposed at `/api/v1/provider/:providerId/diagnostics` with frontend response
  types. The System Status provider card now renders these diagnostic rows for
  each provider, including disconnected providers such as Apple Music. Focused
  provider diagnostics and registry tests cover the contract; the UI was
  browser-verified through the Vite dev server against the local API.
- done (2026-07-05): Auth lifecycle routes no longer assume TIDAL as the
  implicit provider. Device login, login polling, and logout now default to the
  configured streaming provider, and aggregate auth status derives
  `canAuthenticate` from providers that actually declare app-managed auth plus
  a device-login handler.
- done (2026-07-05): Provider contract hardened beyond the first manifest
  slice. Manifests now declare integration source (`official-api`, `web-api`,
  `unofficial-api`), download source (`native-cli`, external service, none),
  stable provider resource-id kinds, optional credential fields, download-backend
  setup notes, and import-source categories. The shared import category set now
  includes `library-artists` for Apple/YouTube-style library imports, and
  `docs/STREAMING_PROVIDER_PLUGIN_CONTRACT.md` documents the TIDAL/Apple/YouTube
  common denominator.
- done (2026-07-05): Apple Music provider buildout advanced through the offline
  contract slice. Apple now exposes `library-artists` and `playlist` import
  sources through the same import command/modal contract as TIDAL, maps Apple
  library resources back to catalog artist/track evidence when available, and
  has a generic credential-save route/UI path for the required media-user-token,
  optional bearer/developer-token override, and storefront credentials. The Apple
  auth path now mirrors the downloader by auto-resolving the Apple Music web
  bearer token when no override is supplied. The Apple downloader wrapper
  now matches `zhaarey/apple-music-downloader`'s actual runtime shape: managed
  `config.yaml`, job-specific save folders, provider-id file/folder templates,
  cwd-based invocation, and album/track/video URL construction. Focused provider
  tests cover Apple import sources, manifest consistency, diagnostics, and
  downloader args.
- done (2026-07-05): Apple Music pre-live downloader diagnostics and progress
  parsing are wired. The provider now reports Apple-specific provisioning facts
  (download enable flag, downloader binary, MP4Box, mp4decrypt, wrapper ports,
  managed config presence) through System Status diagnostics, and the downloader
  backend parses native output (`Track x of y`, provider-id filename lines,
  downloaded/decrypted/existing/error status) into Discogenius progress events
  keyed by Apple provider ids. Focused provider tests cover the parser and
  readiness snapshot.
- done (2026-07-05): Apple Music credential save now performs a real user-token
  validation probe before persisting credentials. The provider calls Apple's
  `/v1/me/storefront` endpoint with the supplied `media-user-token` plus the
  auto-resolved or overridden bearer token, then stores the detected storefront
  when the user leaves storefront blank. Fixture-backed tests cover the
  validation mapper; live success still needs Robert's Apple Music token.
- done (2026-07-05): Apple Music downloader provisioning advanced one step in
  the Docker runtime. The production image now copies the upstream static
  `apple-music-dl` binary from a digest-pinned
  `ghcr.io/zhaarey/apple-music-downloader` image, keeps an
  `apple-music-downloader` compatibility symlink, and defaults
  `APPLE_MUSIC_DL_BIN=apple-music-dl`. Compose files include a disabled Apple
  wrapper sidecar profile that shares Discogenius's network namespace so the
  downloader can reach wrapper ports on `127.0.0.1`. MP4Box and the wrapper's
  authenticated rootfs are intentionally reported by diagnostics as separate
  live-download prerequisites, without adding another global enable/disable env
  flag.
- done (2026-07-05): External dependency policy documented in
  `docs/EXTERNAL_DEPENDENCIES.md`. Provider direct-spawn tools are bundled or
  mounted through pinned artifacts and diagnostics; provider sidecars are
  optional Compose profiles; stateful catalog infrastructure such as
  MusicBrainz-docker remains external/user-managed and is joined over the
  network instead of being cloned or built into the Discogenius image.
- done (2026-07-05): Release validation for the 2.2.0 TIDAL path passed on a
  fresh runtime DB. Live flow: searched and added Bakermat, refreshed and
  provider-matched against TIDAL, curated monitored slots/videos, downloaded
  three TIDAL tracks, imported them into the managed stereo library, verified
  artwork on search/artist/album/dashboard queue-history surfaces, verified new
  `TrackFiles.duration` persistence and refreshed artist statistics, and
  confirmed retag status reported no immediate retag work for freshly imported
  TIDAL files. Full WSL `yarn ci` passed afterward: lint, API build, app
  typecheck, 456 API tests, and production builds.

- pending (2.2.2): Finish the Apple Music provider and bring it to TIDAL parity:
  live Apple credentials validation using Robert's account, catalog/search smoke
  tests against the real API, import-source smoke tests, MP4Box/wrapper runtime
  provisioning around the packaged `zhaarey/apple-music-downloader` CLI, real
  lossless/spatial/video download validation, live progress parser confirmation,
  lyrics/artwork sidecar behavior, and provider evidence capture during live
  refresh/import.
- pending (2.2.2): Complete the remaining provider-plugin contract beyond the offline
  Apple slice: catalog/offers edge cases, download progress event semantics,
  lyrics/artwork hooks, and quality mapping semantics validated against a live
  second provider.
- done (2026-07-05): Stabilized the persistent-deployment TIDAL path for the
  2.2.1 release. Queue live progress now accepts the
  backend's `commandId` events as `jobId` and the backend emits both names;
  the Dashboard queue removed its competing one-second first-page poll/full
  refetch loop so SSE owns live progress and structural events own refetches;
  failed download rows can be retried/deleted unless the exact command is still
  truly processing; scheduled monitoring cycles with zero due artists now stop
  without chaining no-op root scans/download-missing passes; Download Missing
  activity text reads as a wanted-media check; canonical videos honor
  `require_provider_availability`; import retag finalization resolves freshly
  imported tracks by provider id, canonical track MBID, or recording MBID; and
  provider/type/quality badges regained readable theme-aware glass tints, queue
  child rows no longer duplicate parent download/import text, queue grouped
  cover art is backfilled from later rows, and artist/album/mobile detail
  actions use Fluent overflow before labels clip. Local Docker validation added
  Bakermat from MusicBrainz, confirmed Refresh & Scan did not auto-queue
  downloads, downloaded/imported a one-track TIDAL album, verified dashboard
  queue-history cover art, and confirmed fresh import rename/retag status stayed
  clean (`renameNeeded=0`, `retagNeeded=0`). Full WSL `yarn ci` passed: lint,
  typecheck, 460 API tests, and production builds.
- pending (2.2.2): Validate the stabilization release on the persistent test
  deployment (`192.168.1.50:3737` / public hostname) after upgrading it: confirm
  long-running queue rows update by SSE without reload, active rows remain
  stable while downloading/importing, failed provider-missing videos can be
  cleared, and no MusicBrainz-only video becomes monitored when provider
  availability is required.
- pending (2.2.2): Fix the active queue artwork regression specifically for
  active downloading/importing rows. Queued and history rows already carry cover
  art; the active projection must preserve the same artwork source instead of
  showing the video/album placeholder while the command is running.
- pending (2.2.2): Use the MusicBrainz full display title in queue album
  tracklists, including disambiguation/version text where MB exposes it. Do not
  substitute provider title/version unless the catalog identity is genuinely
  missing.
- pending (2.2.2 schema): Remove remaining provider JSON blobs from durable
  provider rows. Promote queried/provider evidence fields such as ReplayGain,
  peak, storefront/resource URLs, explicitness, quality, provider artwork ids,
  duration, media number, and track number to typed columns or documented
  side tables; keep JSON only if a field is explicitly non-durable/non-queried,
  and prefer no JSON at all for fresh schema if practical.
- pending (2.2.2): Polish Dashboard empty states: on mobile the combined
  icon+heading cluster should be centered as a unit, with optional secondary
  text omitted for compact queue/activity states.
- pending (2.2.2): Repair Unmapped Files detection and UI. Clearly named files
  should show title and duration when probeable; unmatched text must be
  provider-neutral ("No provider match" / "No streaming-provider match"), not
  TIDAL-specific; desktop columns should fit by default and support user
  resizing for long title/path values.
- pending (2.2.2): Fix album/mobile tracklists and quality-column sizing.
  Mobile album track rows must still expose duration plus download/info actions.
  Quality columns in album and library tracklists should size to badge content
  with token padding and avoid wrapping three badges to a second row on desktop.
- pending (2.2.2): Rework detail-page action overflow. Artist/album pages should
  keep filters/view controls on the primary row and move secondary actions
  (tags, rename, etc.) into overflow earlier based on the total available width,
  instead of pushing filters/view onto a second row at intermediate widths.
- pending (2.2.2): Diagnose missing release year for Bakermat's "The Spirit" in
  both Servarr Metadata Server mode and local MusicBrainz (`192.168.1.100`) and
  fix the catalog mapping or UI fallback so known release years render.
- pending (2.2.2): Debug Bakermat video downloads such as
  `/video/193` "Living (feat. Alex Clare) (Official Video)": a playable preview
  and thumbnail are not sufficient; download availability must be based on a
  real provider item, and failures should report actionable provider-neutral
  status.
- pending (2.2.2): Fix the Library empty-state import button so it opens the
  same import modal as the Library toolbar and Settings page. Extend TIDAL import
  sources to include "My Mix" style mixes/playlists from the TIDAL API with
  working artwork in the picker.
- pending (2.2.2): Use Fluent colored failure icons matching the current colored
  success icon family (for example `DismissCircle*Color`) for failed downloads
  and review other useful Fluent colored icons without overusing them.
- pending (2.2.2): Investigate incorrect provider-version matching for album
  `9aad95d9-0674-433b-ab50-2229c93d32b2`, where preview playback appears to
  select a remix instead of the original/radio edit. Fix release/provider offer
  selection evidence if the wrong offer is persisted.
- pending (2.2.2): Align artist and album sidecar paths with the configured
  naming templates. Artist images/NFOs must be written under the same
  `{artistName} {mbid-{artistMbId}}` folder used for managed music files, and
  album sidecars should follow the album folder template as well. Validate
  against local test roots and the persistent SMB shares when available.
- pending (2.2.2/2.3.0): Research YouTube Music downloader/catalog options and
  implement the provider if a viable downloader path is found. The provider must
  speak the shared core plugin contract without schema-specific exceptions.
- pending (2.2.2/2.3.0): Research Amazon Music, Spotify, and Deezer provider
  feasibility. Implement only if the catalog API + downloader path is simple and
  robust enough for this release; otherwise document the intended downloader,
  catalog/import APIs, auth requirements, and plugin-contract implications for
  a later provider release.
- schema outlook (2.2.1): No database schema change is expected for this
  stabilization slice. The current schema already has the provider-neutral
  surfaces needed for additional streaming services (`ProviderItems`,
  `ProviderItemMatches`, `ReleaseGroupSlots`, provider provenance on file
  tables, and sidecar file tables). Local-MusicBrainz live-query work should
  not need new provider tables; the likely future DB changes, if any, are
  narrow indexes/materialized read helpers found by measurement, not new
  provider-shadow catalog columns.
- pending (2.2.1+): Add at least one more provider candidate after Apple Music as a proof
  of the plugin contract. Candidate selection should be based on available
  download backend viability, not catalog-only browsing. Current research points
  to YouTube Music via `ytmusicapi` for catalog/user-library reads and `yubal`
  / `yt-dlp` as the downloader reference because it exercises lossy audio and
  higher-resolution video without new schema.
- pending (2.2.2): Audit and trim the API test suite. The release gate now runs
  460 API tests and is still useful for schema/provider/download regressions,
  but too many tests duplicate broad behavior or lock in transitional details.
  Categorize tests into release-contract, focused regression, and low-value
  implementation-detail coverage; keep the first two, delete or collapse the
  last category, and preserve focused live-flow checks for TIDAL.
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

## 2.3.1 - Load Stabilization And UI Cleanup

Scope: findings from the July 2026 fresh 500-artist import in local-MusicBrainz
mode. This is an unreleased stabilization pass; move the completed details to
`CHANGELOG.md` when it ships.

- in progress: The load/UI stabilization slice bounds Library infinite scrolling
  to the viewport and one request at a time, lazy-loads card artwork, restores
  DataGrid accessibility/deep-link row props, rejects incomplete TIDAL bulk
  tracklists, preserves bulk-track artists/copyright, keeps unknown-country and
  local-MB release dates, reduces MusicBrainz video upserts, and deduplicates
  credited/canonical release-group statistics.
- done: Replaced the artist-page top-track and video correlated lookups with
  bounded, set-based queries (top tracks are capped at 100 recordings). On the
  active 500-artist database the pathological track enrichment phase fell from
  more than 124 seconds to about four seconds in isolation; rebuilt API requests
  now complete under load instead of timing out, with worker contention still a
  follow-up profiling target.
- done: Aligned scheduled metadata refresh with Lidarr's daily cadence and
  command de-duplication semantics: all due artists are considered in one pass,
  while artists with pending refresh/scan/match/curate work are not enqueued
  again. The per-artist commands remain Discogenius' queue fan-out adaptation.
- done: The hosted Servarr fallback now fetches required release-group details
  with bounded concurrency and reconciles SQLite writes serially. Artist content
  hashes are committed only after child summaries succeed, following Lidarr's
  parent-last refresh invariant.
- done: Weak ISRC overlap is retained as candidate evidence for hybrid coverage
  without becoming direct provider availability. A single provider release is
  preferred when it is the best complete source; candidate evidence becomes
  verified release availability only with complete canonical track coverage,
  while incomplete coverage remains explicitly probable/partial.
- done: Replaced whole-album-first hybrid selection with a deterministic
  per-canonical-track acquisition plan. The objective is: maximize covered
  recordings, prefer a complete edition on equal coverage, maximize per-track
  quality, then minimize provider albums and redundant source tracks. This lets
  hi-res standard-edition tracks supplement lossless deluxe-only tracks and keeps
  strict partial coverage explicit. Composite/partial plans queue provider tracks
  individually for both automatic and manual downloads, avoiding duplicate
  whole-album downloads. Logical provider tracks are one-to-one with canonical
  tracks, and repeated ambiguous titles require MBID/ISRC evidence so vocal tracks
  cannot falsely cover a same-title instrumental disc.
- done: Split the artist page into identity, album, top-track, and video resources
  at the read boundary. The frontend renders the local artist header first, then
  loads the three collections independently, following Lidarr's separately fetched
  artist/album/track collections.
- done: Provider matching now narrows a bulk artist release list with cheap album
  metadata before fetching detailed provider tracklists. Full canonical
  MusicBrainz tracklists remain available for curation/deduplication, while
  non-candidate provider compilations no longer monopolize the match worker.
- done: Separated Lidarr-style scheduled tasks and refresh events. RefreshArtist
  and root-folder RescanFolders now have independent daily schedules; unchanged
  automatic artist refreshes skip their per-artist disk scan and continue directly
  to curation, while new artists, changed metadata, and manual refresh-scan actions
  still rescan.
- done: Provider album/track release dates and copyright now survive the common
  provider model where supplied, and locked music videos are represented and
  disabled consistently in the frontend monitor controls.
- pending: Finish catalog diff reconciliation: reconcile removals and do not
  stamp `last_scanned` after partial refresh failures.
- pending: Surface track-level coverage and mixed-quality distributions in the
  release switcher so partial/composite availability is visible before download.
- pending: Replace provider availability/match edges for a refreshed artist
  instead of upsert-only accumulation; partition composite coverage by library
  slot and remove the divergent duplicate composite matcher.
- pending: Remove the unused synchronous `monitoring/check-stream` refresh path,
  fix locked-video monitor actions consistently, give artwork URLs a revisioned
  cache key, and split `TrackList`/detail action rows into smaller shared Fluent
  UI components without changing the visual result.
- pending: Add frontend unit coverage for pagination/locked actions and run the
  full Playwright suite in CI.

## 3.0 - Catalog Source Modes And Local MusicBrainz

Scope: full metadata-provider/backend-mode implementation in backend and
frontend. Users should be able to choose the hosted Servarr Metadata Server or a
local MusicBrainz-docker instance.

- done (2026-07-04): Wire `CatalogProvider` into the live runtime so artist search,
  artist refresh, release-group refresh, matching, artwork hydration, and import
  identity all go through the selected catalog source instead of directly
  importing `ServarrMetadataService`.
- done (2026-07-04): Add backend config and persistence for catalog source mode:
  `servarr-metadata` and `musicbrainz-local`, plus the local MusicBrainz host,
  connection test, and user-facing validation errors. Health history/last-successful
  timestamps can be added once the status page is wired to catalog health.
- done (2026-07-04): Add frontend settings for catalog source selection: Servarr Metadata
  Server as the hosted default, Local MusicBrainz as the advanced/self-hosted
  mode, with host-only connection test, clear warnings about setup cost, and links to
  `docs/MB_LOCAL_MODE.md`.
- pending: Implement safe mode switching. Switching from MB-local to Servarr
  Metadata Server must build the local canonical cache for monitored artists;
  switching from Servarr Metadata Server to MB-local must avoid destructive cache
  churn and should lazily refresh records through MBIDs.
- done (2026-07-04): Define and implement supplemental Servarr Metadata Server lookups for
  fields a local MusicBrainz mirror does not serve well or at all. Examples:
  cached/normalized artwork URLs, metadata-server ratings/popularity, and any
  Servarr-specific convenience fields. Supplemental data must never override
  MusicBrainz identity, release grouping, track identity, UPC/ISRC evidence, or
  provider-resource evidence.
- done: Add the MusicBrainz external-link matching tier to runtime matching.
  Release links now compare normalized provider resource identities across
  TIDAL/Apple/Spotify, and artist import uses provider artist links when present.
  Remaining local-MusicBrainz mode work is source selection/switching, not the
  matching tier itself.
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
