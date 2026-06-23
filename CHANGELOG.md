# Changelog

All notable changes to this project are documented in this file.

## [2.0.9] - 2026-06-23

### Changed
- **Upgrade checks now use cutoff/history semantics instead of a materialized ledger.** `CheckUpgrades` still evaluates installed files with `UpgradableSpecification` and queues normal download commands, but no longer reads or writes `upgrade_queue`.
- **No-improvement upgrade loops are guarded by command history.** A recent completed upgrade download/import for the same provider item or album suppresses immediate requeue when the installed file still fails the cutoff, replacing the old skipped-row memory.

### Removed
- **`upgrade_queue` was removed from the fresh schema.** Import completion no longer clears upgrade ledger rows, and the baseline schema test now asserts the table is absent.

## [2.0.8] - 2026-06-23

### Removed
- **Similar-artists section removed.** It was populated exclusively from TIDAL's `getSimilarArtists` into legacy `ProviderSimilarArtists`; MusicBrainz/Servarr Metadata Server has no similar-artist concept and Lidarr has no such section. Per the canonical-source-of-truth policy (providers download + supplement canonical columns only, never seed parallel catalogs/features), the artist-page "Similar Artists" module, its read (`artist-query-service`) and population (`refresh-artist-service`), and the `ProviderSimilarArtists`/`ProviderSimilarAlbums` tables were retired. Top-tracks stays (already MusicBrainz-driven).
- **Dead provider-catalog repair helpers removed:** `version-grouper` and `module-fixer` had no production imports and only wrote/derived data from legacy `ProviderAlbumArtists`/`ProviderAlbums` catalog tables. Removing them shrinks the remaining DB-alignment surface to active read/write paths.

### Changed
- **DB alignment Phase 1 (TrackFiles canonical-first), foundational step:** housekeeping now runs a `backfillCanonicalTrackFiles` pass that resolves and COALESCE-fills the `canonical_*_mbid` columns for any `TrackFiles` row still relying on the legacy `media_id`/`album_id` provider linkage (NULL-only, never overwrites, idempotent). This closes canonical gaps on older/pre-canonical-column rows so file lookups/dedup can later switch off the legacy ids without orphaning files. New downloads/imports already populate these on write; a real-DB dry-run confirmed 0 orphan-risk and 100% canonical resolution.
- **Library-file dedupe is now canonical-aware:** the housekeeping dedupe runs a canonical pass keyed on release-specific track identity for audio (`canonical_track_mbid`, `file_type`, `library_slot`) and recording identity for videos (`canonical_recording_mbid`, `file_type`, `library_slot`) in addition to the legacy `(media_id, file_type)` pass, while never merging stereo and spatial copies.
- **DB alignment Phase 2 has started with library-file listings:** `library-files-query-service` now decorates file rows from canonical `TrackFiles` identity, `Recordings`, and `ProviderItems` instead of joining `TrackFiles.media_id`/`album_id` to `ProviderMedia`/`ProviderAlbums`. This lets canonical-only file rows report provider source quality correctly while preserving legacy `album_id`/`media_id` fields in the API response during the migration.
- **Activity/download history descriptions now resolve from canonical provider items:** `command-history` no longer reads `ProviderAlbums`/`ProviderMedia` to label queued or completed download jobs. It resolves provider ids through `ProviderItems` and the canonical MusicBrainz graph, so canonical-only album/track/video jobs display useful activity text without legacy rows.
- **Track/video scan freshness checks now use canonical provider items:** `scan-refresh-state` no longer reads `ProviderMedia.last_scanned`; it evaluates track and video refresh due-ness from `ProviderItems.updated_at` joined through canonical release and artist identity.
- **Refresh policy now uses canonical release/provider state:** `refresh-policy` reads artist release freshness from canonical `Albums.first_release_date`, and its track/video freshness helpers read `ProviderItems.updated_at` instead of legacy provider scan columns.
- **TIDAL album download progress now falls back to canonical provider items:** when a provider album has no selected canonical release yet, the TIDAL download-progress track list is built from `ProviderItems` instead of `ProviderMedia`, so provider-only fallback progress works without legacy media rows.
- **Import matcher fingerprint candidates now resolve through canonical provider items:** `import-matcher-service` no longer joins fingerprinted `TrackFiles` to `ProviderMedia` to find candidate albums; it resolves album provider ids from canonical `TrackFiles` identity plus `ProviderItems`.
- **`library-files.ts` is now fully canonical (no `ProviderMedia`/`ProviderAlbums` reads):** video naming/path resolution, inline-vs-separated video layout (incl. the inline video→audio match), the video library-root routing, and the previously-converted audio path computation all resolve from the canonical graph + `ProviderItems` (videos via `getCanonicalVideoMetadataForRow`, which uses `ProviderItems.recording_id` for mbid-less provider videos). Removed dead helpers (`getAudioRoot`, lookup-row types). The inline-video layout test was migrated to seed canonical video `Recordings`/`ProviderItems`.
- **Metadata backfill now discovers sidecars from canonical `ProviderItems`:** `library-metadata-backfill` no longer joins `TrackFiles` through `ProviderMedia`/`ProviderAlbums` to find albums, tracks, videos, or video tag metadata. Album sidecars resolve from canonical release groups/slots plus album `ProviderItems`; lyrics/video sidecars use `TrackFiles.provider_id` and `ProviderItems` and carry provider/canonical identity into sidecar rows. Added a canonical-only regression test with zero legacy provider rows.
- **Metadata sidecar writers now fall back to canonical/provider-item metadata:** `metadata-files` no longer uses `ProviderAlbums`/`ProviderMedia` for local album/video NFO or artwork fallback data. Artist NFO album lists read canonical `Albums`; album NFOs resolve MBIDs, selected releases, reviews, artwork context, and tracks through `ProviderItems`, `ReleaseGroupSlots`, `AlbumReleases`, and `Tracks`; video NFOs resolve artist/album MBIDs through video `ProviderItems` + canonical `Recordings`.
- **Lyric sharing now resolves through canonical provider items:** `lyric-service` no longer falls back to `ProviderMedia`/`ProviderAlbums` when sharing cached lyrics between stereo/spatial counterparts. It resolves provider track items through `ProviderItems`, `Tracks`, and `Recordings`, then matches cached lyric files by provider id, track MBID, or recording MBID.
- **Rename sidecar replication now follows canonical identity:** `rename-track-file-service` no longer joins separated-root sidecar replication through `ProviderAlbums`/`ProviderMedia` titles. Album sidecars match by canonical release group via album `ProviderItems`, lyrics match by canonical track/recording identity, and direct sidecar rename applies now carry provider/canonical fields consistently.
- **Audio tag context is canonical/provider-item first:** retag previews and target tag construction now hydrate title/date/track count/MBIDs, MusicBrainz artist credits, provider URLs, explicit flags, and provider UPC fallback from `TrackFiles` canonical identity plus `ProviderItems`/`AlbumArtists`/`Recordings`. Legacy provider tag data remains as a compatibility fallback and MB/AcoustID enrichment still writes back to legacy provider tables until the Phase 3 write-path cutover.
- **Upgrader scan and ledger are canonical/provider-item first:** `CheckUpgrades` now reads installed files from `TrackFiles` canonical/provider identity plus `ProviderItems`, not `ProviderMedia`/`ProviderAlbums`. Canonical-only audio and video files can queue upgrade downloads with zero legacy provider rows, and schema v27 re-keys `upgrade_queue` to provider resource identity (`provider`/`entity_type`/`provider_id`) while leaving nullable legacy shadow ids for transition cleanup.
- **Organizer exact track import helper now stays on canonical/provider items:** the canonical album import path resolves exact provider track ids from `ProviderItems.match_evidence` and canonical `Tracks`, not a `ProviderMedia` fallback join. Broader organizer legacy album/video fallback and write paths remain for a later cutover.
- **File-path computation (`computeExpectedPath`) is now canonical-only for audio:** album and track naming context resolve from `Albums`/`AlbumReleases`/`Tracks`/`Recordings` (via `getCanonicalAlbumMetadata`/`getCanonicalTrackMetadata`/`resolveCanonicalTrackPosition`) instead of falling back to `ProviderAlbums`/`ProviderMedia`. Removed the now-dead `resolveNamingAlbumId` legacy helper. Dependent rename/move/import-finalize tests migrated to seed the canonical graph + `ProviderItems` (legacy provider rows kept only to satisfy the transitional `TrackFiles` FK until Phase 5).
- **Unmonitored-file pruning is now canonical:** `LibraryFilesService.pruneUnmonitoredFiles` selects delete candidates from canonical monitored state (`ReleaseGroupSlots` for audio by release group + library slot; `Recordings` for videos, via `canonical_recording_mbid` or `ProviderItems.recording_id` for mbid-less provider videos) instead of `ProviderMedia.monitored`/`ProviderAlbums.monitored`. Files are pruned only when they have a canonical anchor and none of their anchors are monitored or user-locked; files with no canonical anchor are never auto-deleted. Removed the legacy repositories (`AlbumRepository`/`MediaRepository`/`ArtistRepository`, dead code).
- **DB alignment Phase 3 supplement-field homing has started:** schema v24 adds canonical homes for provider supplements (`Albums.cover_image_id`/`vibrant_color`/`video_cover`/`popularity`/review fields, `AlbumReleases.copyright`, `Recordings.copyright`/`popularity`/`credits`). `refresh-album-service` now mirrors album, release, and track supplements there while preserving the legacy compatibility writes, and NFO/audio-tag fallbacks read those canonical values first.
- **Provider UPC/ISRC stays provider-scoped:** provider UPC/barcode and ISRC are now treated as matching evidence, not catalog supplements. `refresh-album-service` no longer copies provider UPC into `AlbumReleases.barcode`; provider UPC/ISRC stay on `ProviderItems.upc`/`ProviderItems.isrc` while copyright, popularity, replay gain, and similar allowed supplements can still home onto catalog rows.
- **Stereo/Atmos slot selection preserves separate release identity:** provider slot matching now gates tracklist coverage by the candidate's compatible MusicBrainz release MBIDs, so a stereo offer cannot satisfy an Atmos release just because titles and positions match. This preserves different stereo vs Dolby Atmos UPC/barcode and recording/ISRC evidence through separate `ReleaseGroupSlots.selected_release_mbid` values.
- **Atmos-only provider albums can fill both audio slots:** when a provider has only a Dolby Atmos offer for a MusicBrainz release group, slot selection links that offer to both the spatial and stereo slots. If a separate stereo offer exists, stereo still prefers the distinct stereo provider release.
- **`DownloadMissingForce` now only queues the missing-download pass:** the obsolete provider-media skip-flag reset branch was removed because the current schema no longer has those legacy skip columns.
- **Runtime monitor-gap repair is now canonical:** housekeeping repairs installed audio files into unlocked `ReleaseGroupSlots` and installed videos into unlocked `Recordings`, including mbid-less provider videos through `ProviderItems.recording_id`, instead of writing `ProviderMedia.monitored`/`ProviderAlbums.monitored`.
- **Dead legacy quality helpers removed:** `quality.ts` no longer exposes the unused `QualityService` methods that read `ProviderAlbums`/`ProviderMedia` and wrote `upgrade_queue`; active quality evaluation stays in `UpgradableSpecification` and `upgrader.ts`.

### Fixed
- **Monitoring-cycle downloads now wait for artist intake/curation work before the terminal missing-download pass.** The scheduled/manual cycle's terminal `DownloadMissing` was gated only on monitoring-cycle-tagged jobs and ignored in-flight per-artist intake work (`RefreshArtist`/`RescanFolders`/`CurateArtist`). On a fresh setup it could fire the moment the metadata refresh finished — before artist intake had curated any release-group slots — so it queued 0 downloads, then nothing retried until the next 24h boundary. The pre-download gate now also waits for all artist-workflow and library-rescan jobs to drain. Standalone artist add, scan, curation, and collaborator scanning still do not auto-download; downloads remain part of the explicit manual/scheduled monitoring cycle or download command.
- **Forced upgrade checks now actually force redownload evaluation.** Manual `CheckUpgrades`/queue-triggered forced runs now pass an enabled redownload profile into `UpgradableSpecification`; previously they skipped the top-level setting guard but still evaluated with `allowRedownloads=false` when `upgrade_existing_files` was disabled.

## [2.0.7] - 2026-06-18

### Fixed
- Artist artwork and basic info now hydrate immediately for hot-loaded or search-added MusicBrainz artists, instead of rendering a blank "needs scan" card.
- Album, track, and video search results now return resolvable artwork URLs (tracks resolve their album's art, videos resolve a canonical or provider thumbnail) instead of raw provider asset ids that never rendered.
- Album cards fall back to selected-provider artwork when MusicBrainz/Cover Art Archive has none, through a single shared resolver (no duplicate art-fetch paths, no temporary cross-matching).
- First-order collaborating artists now get a full canonical + provider-slot scan while staying unmonitored and uncurated (no snowball into their own collaborators).
- Artist page filter state persists per artist when navigating to an album and back.
- Detail-page loading skeletons align with the real layout (top spacing/header height).

### Changed
- Search stays local + MusicBrainz/Servarr Metadata Server only for artists/albums/tracks/videos — no provider live-search.
- Tracklist: clickable artist names (linking via the known MusicBrainz id), a Duration column and a Quality column, the volume separator hidden on single-volume releases, and refined play/stop controls.
- Background UltraBlur is generated small and blurred client-side (Plex-style), cutting the payload ~35x, and new pages now cross-fade in once decoded instead of snapping.
- Runtime Docker image slimmed via a yarn cache mount and node_modules pruning.

## [2.0.6] - 2026-06-17

### Fixed
- Download queue and tracklist quality pills now match the height of the media-type pill (the `QualityBadge` no longer forces its own height, so a small quality badge lines up exactly with a small `MediaTypeBadge`).
- Album page now shows a single quality pill when one provider release fills both the stereo and spatial library slots (the Atmos-fallback case), with a hover explaining it covers both libraries, instead of two identical Dolby Atmos pills.
- Album page split Download button no longer clips its hover shadow/lift; the whole control now lifts and shadows as one unit like the other action buttons.
- Atmos-only releases that fall back into the stereo slot now organize into `stereo-music` (not `spatial-music`), and `--dolby-atmos allow` is applied for stereo downloads so the fallback actually downloads.
- Eliminated the concurrent stereo+spatial download race that caused `ENOENT … rename` import failures: each download job now uses its own `job_<id>` workspace, so jobs can't wipe each other's files.
- Resolved "ghost" queue items that lingered as active after a job completed until a manual page reload.
- Removed the constant GPU load from the background: the full-viewport `backdrop-filter` (re-sampled on every repaint) was replaced with a static `filter` baked onto the cached gradient image.
- Reduced the visible grain/texture on the background by dialing the gradient dither way down.

### Changed
- tiddl is now steered with a clean split: `config.toml` holds only global settings (video quality, threads, metadata embedding, templates, …) while per-job values (download/scan path, track-quality cap, Dolby Atmos mode, video filter) are passed as CLI args. This removes the previous config/args duplication.
- Removed a stale Playwright smoke test for the `/search` route that was dropped in 2.0.4 (search now lives in the nav bar), fixing CI.

## [2.0.5] - 2026-06-17

### Added
- Added List view mode for the global library and artist discography pages, using DataGrids for dense layout.
- Added "Fetch-on-click" functionality for collaborating artists; clicking an unknown collaborating artist now automatically fetches their basic info from MusicBrainz and queues a full discography scan instead of landing on a 404 page.

### Fixed
- Fixed an inconsistency in the download queue UI where the media type pill was smaller than the quality pill. Both are now consistently sized as small pills.

## [2.0.4] - 2026-06-17

### Fixed
- Album imports now resolve exact provider track IDs to their linked MusicBrainz tracks instead of allowing one provider row to join every track on the release. This fixes single-file and partial album downloads being named/tagged as track 01 while containing a later album track, across stereo and Atmos imports.
- Added a regression test for the exact provider-ID canonical import path.

### Changed
- The library page now relies on the persistent nav search and no longer has a duplicate local search box or add-artist action.
- Mobile navigation now uses the same button order as desktop, keeps search in the top row, hides the wordmark, enlarges the app icon, and keeps the queue badge inside the dashboard button.
- Search results use a clearer primary add/monitor action so adding artists from the global search surface is easier on mobile.

## [2.0.3] - 2026-06-17

### Changed
- docs: add Lidarr schema audit + alignment, DB migration, and threading plans
- fix(ui): consolidate card styles, rebalance spacing, align loading skeletons to real UI
- refactor(api): consolidate routes under /api/v1 and adopt Lidarr-aligned job execution
- perf(db): fix event-loop-blocking queries on large libraries
- fix(ui): unify card glassmorphism + enlarge mobile album cover
- fix(ui): nudge mobile page edge padding back up to SNudge
- fix(ui): add vertical breathing room to mobile tracklist rows
- fix(ui): tighten mobile tracklist spacing instead of stacking pills
- refactor(ui): rebuild tracklist on Fluent UI Table
- fix(ui): tighten tracklist sizing and bio/review spacing
- feat(ui): rework tracklist — hover-play, artist always, compact right cluster
- fix(ui): tighten mobile artist name↔bio spacing
- feat(ui): theme-aware quality/provider pills + revert header order
- feat(ui): album header row swap, declutter cards, auth page polish
- fix(import): ffprobe duration fallback for unmapped Atmos/MP4 files
- fix(ui): auth page scrolls; welcome header stays one line
- fix(api): resolve blank artist-credit ids so tracklist artists link
- fix(ui): mobile badge layout — own lines, card stacking, smaller card pills
- fix(ui): white-on-black provider chip, consistent badge size & order
- fix(ui): theme-aware provider marks everywhere (settings + auth too)
- fix(ui): 24px badges, center the header badge block
- feat(ui): unified provider pill + quality badges, horizontal Atmos logo
- fix(ui): tighten provider pill size, space tracklist quality badges
- fix(ui): theme-aware provider pill, concentric radii

## [2.0.2] - 2026-06-13

### Changed
- **Unified track matching**: curation, the album page, and playback now score MusicBrainz↔provider track matches through one shared matcher (recording-MBID / ISRC exact → position+title+duration structural → title-dominant fallback), so the three paths can no longer disagree. Fixes albums showing "no tracks matched / available" while the same release downloaded fine elsewhere (e.g. Bad Blood now reads 33/33).
- **Verified status for full-coverage editions**: a release group whose provider release fully covers an "… EP" / "… X" style title-expansion now reads **verified** instead of being capped at "probable" (e.g. Goosebumps EP).
- **Combined provider + quality pill**: the album header shows one chip per filled slot — a provider mark fused with its quality badge (e.g. TIDAL · 24-BIT, TIDAL · Atmos). With multiple providers this makes it obvious where each version came from; match confidence, combined-release count, and the selected MusicBrainz edition moved into the hover tooltip. A small corner dot flags only probable/ambiguous matches.
- **Spatial-only albums** now read **"Dolby Atmos only"** in the header when the provider has no stereo release, presenting correctly instead of as a missing stereo match. (No empty stereo download was ever queued — Atmos candidates already route to the spatial slot.)
- **TIDAL plugin files consolidated** under `config/providers/tidal/` (`.tiddl/` beside the token), with a one-time migration of a pre-2.0.2 `config/.tiddl`. Our app owns token refresh and writes the derived tiddl `auth.json`, so the app and `tiddl` no longer contend over the token. `TIDDL_PATH` now points at `config/providers/tidal/.tiddl`.

### Fixed
- **Badge squishing**: quality badges held their intrinsic width (`flex-shrink: 0`, no-wrap), so labels no longer spill outside the rounded body when a row gets tight — album header, media cards, and the dashboard alike.
- **Single-track organizer collision**: a track that was also released as a standalone single embeds `trackNumber: 1`; the organizer only overrides album position with that embedded number when the candidate's title also matches, so track 13 no longer maps onto position 1.
- **Artwork source consistency**: artist-page album cards now prefer the same persisted canonical (Cover Art Archive) cover the album page resolves, instead of falling through to provider art whenever the cached data blob lacked an image. (Backfilling canonical art for never-viewed release groups is tracked for 2.0.3.)
- The misleading "Add Another Provider" button (it re-ran the already-connected TIDAL flow and bounced to the library) is replaced by a roadmap hint until the universal provider-onboarding flow lands.

## [2.0.1] - 2026-06-12

### Added
- **HLS audio previews**: provider previews now stream over HLS (generated VOD playlist + per-segment proxy), so lossless DASH-backed tracks start instantly and seek anywhere without the server materializing the whole file first. The player falls back to the buffered proxy automatically for progressive-only sources.
- **Provider-match visibility**: album pages show per-slot match badges (matched / probable / ambiguous / not available) with the provider release and selected MusicBrainz edition, and "Other releases" labels the selected edition.
- **Plex extras naming for music videos**: video files and their thumbnail/NFO sidecars get a type suffix (`-video`, `-lyrics`, `-live`, `-concert`, `-behindthescenes`, `-interview`) classified from the provider title, in both separated and inline layouts.
- An "Add Provider" empty state and "Add Another Provider" action in the provider settings section.

### Changed
- **Most-extensive-edition selection**: coverage targets are ordered by tracklist size and track matching understands MusicBrainz parenthetical bonus-track qualifiers ("Haunt (demo)" vs the provider's plain "Haunt"), so anniversary/deluxe editions are selected when the provider carries them (Bastille's Bad Blood now selects the 33-track Bad Blood X).
- **Lidarr-style upgrade semantics**: lowering the audio quality never queues automatic re-downloads (existing better files are kept), and the configured quality now caps download quality for stereo tracks.
- **One video per song**: duplicate provider videos (official/lyric/live re-uploads) are grouped by song and only the best one is queued, preferring official videos.
- Credit-only collaborator artists get a basic metadata refresh instead of a full provider catalog/video sweep, and hydrate once instead of on every parent refresh.
- Page ambience (UltraBlur background + accent) persists across navigation and on dashboard/settings, cross-fading between artworks instead of snapping through the neutral default.
- The Docker image is ~40% smaller (2.31GB → ~1.4GB): runtime installs only the API workspace dependencies, and git plus repo-setup tools are no longer shipped.
- Naming examples render with consistent separators and real Bastille/MusicBrainz sample data, and the token help now documents recording/media/provider-video ids and album tokens for video templates.

### Fixed
- Importing one slot of a release group no longer deletes the other slot's file: stereo FLAC and Atmos M4A of the same release now coexist instead of ping-pong replacing each other.
- Music video imports failed on a phantom `ProviderMedia.monitor` column; video downloads now import with thumbnail and NFO.
- Video↔track matching never linked anything because it filtered audio recordings by an always-empty `artist_mbid` column; candidates now resolve through release groups (Men I Trust: 0/13 → 13/13 videos linked), giving inline video placement real anchors.
- Merging library roots no longer strands artist/album sidecars in unresolvable rename conflicts — same-scope duplicates are merged automatically.
- Album pages derive the accent color from cover art like artist/video pages, so seekbars and brand UI no longer stay default orange.
- Artist images load in dev (`/MediaCoverProxy` proxy), artist-page album cards prefer canonical Cover Art Archive artwork over provider art, and `docker-compose.yml` no longer points `TIDDL_BIN` at the removed tidal-dl-ng.
- Restored authentication on the video preview sign endpoint and fixed TIDAL video playback URLs (countryCode + HTML-entity unescaping in DASH manifests).

## [2.0.0] - 2026-06-11

### Added
- Provider-match visibility in the UI: album pages show a per-slot TIDAL match badge (matched / probable / ambiguous / not available) with the provider release and selected MusicBrainz edition in the tooltip, and the "Other releases" list labels the selected edition.
- tiddl integration test coverage (auth file shape, quality mapping, environment pinning) and regression tests for edition-aware release matching.

### Changed
- **Single download backend:** all TIDAL downloads (stereo, Dolby Atmos, music videos) now run through tiddl. OrpheusDL and tidal-dl-ng have been removed, together with their runtime setup, token sync paths, and health checks. The Docker image installs tiddl and pins `TIDDL_PATH=/config/.tiddl`.
- **One login:** the in-app TIDAL device login is synced straight into tiddl (`auth.json` in the exact shape tiddl expects, plus matching OAuth client credentials via `TIDDL_AUTH`), so downloads work immediately after connecting your account — no separate downloader authentication.
- **Edition-aware matching:** provider albums are validated against the tracklist of every release in a MusicBrainz release group (representative edition first, then by tracklist size). The slot records the edition that the chosen provider album actually covers, so a standard edition on TIDAL no longer shows as "unavailable" just because MusicBrainz's largest release is a deluxe, and the stored release MBID always describes the content that gets downloaded.
- Documentation and agent guidance consolidated: one `AGENTS.md` at the repository root, refreshed `ARCHITECTURE.md`/`CURATION_DEDUPLICATION.md`/`ROADMAP.md`, and removal of ~30 stale agent-session documents, RFCs, and instruction files.

### Fixed
- Album imports failed for every download: the organizer referenced a never-created `MediaCovers` table and a non-existent `AlbumReleases.primary_type` column. Canonical artwork now resolves through the existing album-artwork cache.
- `api/src/services/config` (18 source files) was never committed because the runtime-state ignore patterns (`config/`, `downloads/`, `library/`) were unanchored; fresh clones could not compile and CI failed on every run. Patterns are now anchored to the repository root.
- TIDAL's `HIGH` quality tag (320 kbps AAC) was conflated with tiddl's `high` tier (16-bit FLAC); config values now pass through verbatim and provider tags are mapped explicitly.
- Combined slot selections (`id1;id2`) were passed to the downloader as a single URL; they now download sequentially into the same workspace with aggregated progress.
- Hardcoded album-specific words were removed from the release-group matcher's edition-suffix heuristic.
- Vite dev proxy: use the IPv4 loopback (Node 17+ resolves `localhost` to `::1` while the API listens on IPv4) and ignore a `PORT` value that points at the dev server itself.

## [1.2.6] - 2026-04-28

### Changed
- Stabilized the Docker runtime and health checks so `/config`, `/downloads`, `/library/music`, `/library/atmos`, and `/library/videos` are created writable for UID/GID 568 and startup preflight failures roll up into the top-level health status.
- Moved metadata output to NFO-only sidecars: artist biographies and album reviews are embedded in Jellyfin/Plex-compatible NFO files, and new `bio.txt`/`review.txt` generation has been removed.
- Made MusicBrainz identity first-class across scans/imports with persisted identity status, release/release-group IDs, track MBIDs, and MusicBrainz release-group type data driving album/module classification when available.
- Reworked naming around Lidarr-style tokens, backend-owned validation/previews, MBID-safe artist folders (`{artistName} {mbid-{artistMbId}}`), TRaSH-style nested identifiers, and cursor-aware token editing in Settings.
- Repaired durable queue visibility so pending, processing, importing, and recoverable failed jobs survive reloads and share one backend contract for retry/delete/reorder/progress behavior.

### Fixed
- Fixed the e2e managed-server harness for WSL/IPv6 localhost behavior and updated stale navigation assertions for empty-library roots.
- Excluded `.ref_*` reference repositories from git/docker contexts so local reference checkouts cannot leak into release images.

## [1.2.5] - 2026-04-22

### Changed
- Aligned artist path rebuild/move flow more closely with Lidarr by introducing `ArtistPathBuilder` and keeping artist path changes on the explicit `MoveArtistService` path.
- Organizer and audio-tag MBID enrichment now reapply artist folder naming through the move workflow when a legacy generated folder should be rebuilt with `{artistMbId}`.
- Search submissions now hydrate the dedicated search page correctly, and naming settings flush before rename preview/apply so library rename actions do not run against stale templates.

## [1.2.2] - 2026-04-11

### Changed
- Auth bootstrap now follows the *arr model more closely: app auth gates shell access, TIDAL provider auth no longer blocks the local library shell, and admin-session failures no longer fail open.
- Artist folder handling is closer to Lidarr: generated artist paths now avoid parent/child collisions, `MoveArtist` performs a real folder move with rollback, and tracked file rows are rebased after successful folder moves.
- Library scan reliability improved by recalculating download-state invalidation on orphan cleanup and by disabling the top-level prebuilt root index when nested artist-folder templates are in use.
- Loading and settings UX were tightened with branded boot loading, more faithful skeletons, and clearer separation between `Disconnect TIDAL` and Discogenius `Sign out`.

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
- Updated the architecture workplan to mark Phase 1 complete and define Phase 2 scope (UI dashboard exposure and periodic scheduling configuration).

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
