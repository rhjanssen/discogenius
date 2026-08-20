# Discogenius Task Backlog

Outstanding work only. Shipped history belongs in `CHANGELOG.md`.

Status: pending | in progress | decided | revisit

## Manual validation (needs Robert)

- **Spatial audio:** turn Spatial audio ON if Atmos chips are missing on albums
  with matched Atmos offers, then confirm TIDAL + Apple Atmos on Bastille.
- **Apple Music:** Auth-page wrapper login (Apple ID / password / 2FA), then one
  stereo/hi-res, one Atmos, one standalone video, one album-bundled video.
- **YouTube Music:** browser-header JSON + cookies; one authenticated audio and
  video download (public catalog/lyrics work without credentials).
- **Deezer:** `arl` cookie; one Streamrip MP3/FLAC download.
- **Amazon Music / Spotify:** Auth shows **Soon** — no live validation until
  re-enabled.

## Done: the 2.8.0 architecture

Landed on `claude/implementation-brief-reconcile-taw5jb`. Schema 42 is
clean-start; `initDatabase()` refuses any other `user_version`.

**Monitoring is row existence, everywhere.** `LibraryAlbums.monitored` and
`Recordings.monitored` / `monitored_lock` are gone. `LibraryAlbums`,
`LibraryEditions` and `LibraryVideos` all say the same thing the same way.
Unmonitoring an Album withdraws the Editions monitored under it, and takes the
Album's lock with the row.

**Album and video commands name their library.** One library, or an explicit
`allLibraries` meaning every *audio* library. A library is an audio library
unless its quality profile accepts `video`, read from the profile so a renamed
library stays classified. The Video Library never holds a `LibraryAlbums` row.

**The Album lock is aimed at automation.** Curation may not drop a locked
Album's editions, add to them, or reclaim its plan choice; the user may change
editions, representative and plan while locked, and none of it clears the lock.
A locked plan the provider withdraws stays selected and marked `unavailable`
rather than being swapped for another.

**Acquisition Plans** are scoped to `(library_id, edition_id)`, so an Edition
needs no row of any kind to carry offers. `LibraryEditions.preferred_plan_key`
is the only statement of which plan executes, backed by a deferred composite
foreign key. `SelectedAcquisitionPlans` joins monitored and selected in one
place. Planning runs before curation and survives unmonitoring.

**The planner decides the outcome first.** Best delivered result per canonical
track, then the fewest sources fitted to it by minimum set cover with dominance
pruning — no source-subset enumeration and no cliff at sixteen sources. Every
non-dominated single-source offer is kept alongside a combined offer that earns
its place.

**A manual edition choice** stands while its missing recordings are reachable
elsewhere in the artist's discography, and is overruled only when the declined
edition is the only place they exist. Locked albums are exempt. Overruling
writes `curation_override_unreachable_recordings`.

**Track-list tabs** are decided from canonical Recording sets
(`track-list-tabs.ts`), exposed per library on the availability endpoint, and
drawn by the album page; `GET /v1/album/:albumId/editions/:editionId/tracks`
serves the complete canonical list for one edition.

**Videos** are canonical Recordings with `is_video = 1`. Two questions about
them are kept strictly apart, because conflating them is what broke the model:

- **Association** — on which Album and Edition pages does this video appear?
  Derived, many-to-many, and free. A video belongs on every Edition that carries
  it as a canonical Track outright, or carries a Track for the exact audio
  Recording it is a video of. One official video therefore shows on the original
  album, the deluxe, the single and the compilation. There is deliberately no
  video-to-Edition table: the canonical Tracks already are one.
- **Placement** — where does its one physical file go? One persisted destination
  per selected video, on `LibraryVideos`. `video-placement-resolver.ts` is the
  only thing that answers it, and download, import finalisation, the organizer,
  expected-path, rename and the layout gate all read it rather than deriving
  their own. Re-deriving independently is how the same video ended up copied
  into several album folders.

Display never consults placement. The album strip used to ask which single
album would host the file and hide the video everywhere else; that rule is gone.

The video→audio link is **exact Recording identity**, performance-specific. An
Alchemy live video links to the live recording and never to the Making Movies
studio cut, whatever the titles and durations say. Evidence comes from
MusicBrainz's own `music video` relation, from provider-edition membership read
from either side, and from canonical Edition co-membership — a release carrying
members 1–5 as audio and 6–7 as video says which performance each video is of,
and scoping the comparison to one release is what makes it safe.

**Several videos may relate to one audio Recording** — an official, a lyric cut,
a live cut, a visualizer — and every valid relation is kept. Curation decides
which of them a Library takes; losing candidates stay visible.

**Canonical video types are `video` / `live` / `lyrics`**; visualizer and
official audio normalise to `video`, and the raw provider variant stays on the
recording as matching evidence.

**Inline slots.** Plex gives a track one regular-video extra and one lyrics
extra. `video` and `live` compete for the first, `lyrics` owns the second, and a
partial unique index over
`(library, placement library, track, slot) WHERE placement_mode = 'inline'`
makes a second occupant unrepresentable. Winners are ranked by exact recording
relation, then direct canonical membership, then release context, then accepted
over inferred, confidence, availability, quality, id.

**Layout modes.** `separated` stores every eligible video in the video library.
`inline` monitors them all and moves the slot winners beside their exact track,
the rest staying separated — never both. `inline_only` monitors only the
winners, leaving losers as visible candidates with no row and no download.

**Plex suffixes** follow the *role*, not the type. Inline: `video` → `-video`,
`live` → `-video` (it occupies the regular slot), `lyrics` → `-lyrics`.
Separated: `video` → `-video`, `live` → `-live`, `lyrics` → `-lyrics`.

## Remaining after 2.9.0

- **Live provider validation.** No controlled real-provider download has been
  run against the video placement path — see "Manual validation" at the top.
- done: **Manual video placement override UI.** Video page File location menu
  picks Video library or beside an exact related track; `keep` retains an
  `inline_only` loser. Curation still will not overwrite
  `placement_selection_mode = 'manual'`.
- pending: medley / multi-recording video UX (one video of several tracks).

### Open defects (found during 2.8 hardening, not yet fixed)

- done: **Mid-album provider fallback no longer fails the import on a provider
  stamp mismatch.** Prepared quality is applied by the organizer's
  `TrackFiles.id`. A fallback can stamp the supplying provider (`tidal`) while
  the command still names the album's (`apple-music`); that is not an identity
  error. Provenance still rewrites the stamp from the offer. Covered by
  `import-operation-identity.test.ts`. Re-request the Aerosmith spatial slot
  (`8a58cc1a-be0d-3b1b-8d0d-aa8f467a59da`) on a live catalog to confirm the
  command completes.

- done: **Apple Music video download.** Bastille live *Pompeii* (2013)
  Apple FHD downloaded, decrypted, imported beside the stereo track, and
  played 1920×1080 from `/api/v1/mediaFile/stream`. Queue history linking
  that job to Apple's provider id is fixed in 2.9.2.

### Test matrix still to run

Covered so far: metadata refresh, provider matching, curation, and TIDAL +
Apple Music stereo *and* spatial download → import → organize (verified 8/8
FLAC 24/96 into the stereo library and 8/8 Atmos E-AC-3 into the spatial one,
with correct per-library routing). Also verified: re-requesting a fully
downloaded album queues nothing, and a cross-provider fallback now files its
tracks under the provider that supplied them.

Not yet covered:

- Video downloads end to end (any provider).
- Unmapped-file / manual import.
- Per-provider capability sweep: Deezer, YouTube Music, SoundCloud, Amazon
  Music — stereo audio, and video where the provider claims it.
- Restart / idempotence: re-running a completed download+import must be a
  no-op rather than a duplicate.
- Fresh-database soak with 500+ artists and no code changes during the run.

### Derived-state invalidation — the shape behind most 2.8 defects

`provider evidence → ProviderTrackMatches → AcquisitionPlans → curation`. Each
layer is cached and derived from the one before, and every one of them failed to
invalidate at some point during 2.8. When touching any of them:

- Bump `PROVIDER_TRACK_MATCHER_VERSION` in the *same commit* as any change to
  `describeTrackMatch` or the title helpers it depends on. Stored matches are
  cached decisions; without the bump an improved matcher only ever reaches
  releases the provider happens to return again.
- A monitored Edition must always point at one of its plans. `plansMatchFingerprint`
  refuses to reuse plans when `preferred_plan_key` is missing or unresolvable —
  skipping that check strands Editions with no selection and the album page then
  shows no provider and no offers.
- Two foreign keys abort a re-ingest wholesale if their references are not
  released first: `AcquisitionPlanTracks.provider_track_match_id` (no cascade)
  and `LibraryEditions.preferred_plan_key → AcquisitionPlans`. Release the
  LibraryEditions reference *before* deleting plans, as
  `AcquisitionPlanRepository.replacePlans` documents.
- Anything that runs after the bytes are on disk is enrichment and must fail
  soft. A provider 404 during organize used to lose a completed download.

## Engineering principles (apply to every planned task below)

These tasks describe *symptoms*. Fix the *root* with one well-designed, universal
implementation — never patchwork, bandaids, special-cases, or yet another fallback.
Grounded in a `.ref_lidarr` comparison; see [[discogenius-roadmap]], [[lidarr-terminology]].

- **Port from Lidarr 1:1 where possible.** Reference is `.ref_lidarr` (and
  `.ref_jellyfin` for media-server / sidecar conventions). Match its structure, control
  flow, and naming (`MediaCoverService`, `AudioTagService.WriteTags`,
  `RescanFoldersCommand`, …). Prefer **deleting our divergent code** and adopting
  Lidarr's shape over layering compatibility shims on top of it.
- **One code path for all cases — no special-casing.** e.g. do NOT add hybrid-specific
  artwork/embed logic; that bloats the code. Fix the single tagging + artwork pipeline
  so it reliably embeds the correct tags and cover for *every* album (hybrid or not)
  through the same path.
- **No fallback-stacking / no provider leakage.** Provider metadata is match-time only.
  Every `COALESCE(canonical, provider, …)` that reaches display/organize/tag is a bug —
  the persisted/user-facing path uses catalog data with one clear catalog→catalog
  fallback, never the provider.
- **Store once, reuse everywhere.** Resolve/fetch once, persist, and have every consumer
  read the stored artifact. Divergent independent resolutions (sidecar ≠ UI ≠ embed) are
  exactly the bug class to eliminate.
- **Delete, don't accumulate.** Favor removing bespoke logic for the Lidarr-shaped
  approach over adding branches.

Version buckets below are the proposed grouping — rebucket freely.

## 2.6.12 (planned) — file-tracking correctness

Contained, shippable bug fixes — each a proper fix, not a bandaid.

- done: **Orphan removal must invalidate the album/RG download-status cache.**
  `cleanOrphanedRecords` selected `NULL AS album_id`, so `updateAlbumDownloadStatus`
  never fired; canonical-linked (provider-free) rows also have a null `provider_id`, so
  they got no invalidation at all — a deleted-then-still-"downloaded" album until an
  incidental cache expiry. Now selects `canonical_release_group_mbid` (written on every
  canonically-linked row alongside the track/recording mbid) and drives
  `updateAlbumDownloadStatus` off it, invalidating album + RG + artist status on removal;
  provider-only rows invalidate via `provider_id`. Covered by
  `library-scan-orphan-cleanup.test.ts`.
- done: **Scan lifecycle reflects reconciliation.** "Rescan Folders" reported completed
  before the emptied library was reflected. The handler already awaits the scan
  synchronously (reconcile runs inline inside the command), so "Completed" already means
  the DB is reconciled — the real lag was the stale download-status cache (above). Fixed
  the reporting: the completion description now surfaces file-table deltas
  (`N removed, N added, N updated`, or "up to date, no file changes") for both the
  per-artist and library-wide paths, instead of leaving a generic in-progress line.
- pending (needs Robert / live deploy): **Confirm 2.6.11 linking works on the
  deployment.** Verify the embedded-MBID linking + Phase E self-heal actually match/relink
  files on a real root scan + artist refresh (user saw none matched); confirm with logs
  before layering more. Cannot be verified from the repo — run a root scan on the deployed
  instance and check `[DiskScan] Artist …: N files updated` / Phase E heal counts.

## 2.7.0 (planned) — Lidarr file-management, tagging & artwork parity

The big "do it right" release. Port Lidarr's MediaFiles pipeline and delete our
divergent paths. **Read the engineering principles above first.**

### File tracking & download status — materialize the link, drop the cache

Lidarr has **no download-status cache**. It stores the link as an integer FK on the
track (`Track.TrackFileId`; `HasFile => TrackFileId > 0`) and computes status live as a
trivial indexed join. `MediaFileTableCleanupService.Clean` deletes the missing
`TrackFile` row *and* zeroes the orphaned tracks' `TrackFileId`. Our cache
(`albumStatsCache` / `artistStatsCache` / `mediaDownloadCache` in `download-state.ts`)
exists only because we compute status via multi-table canonical/provider joins instead
of a materialized FK. We already have the materialized FKs on `TrackFiles`
(`track_id`, `recording_id`, `release_group_id`, `album_release_id`) — we just don't
compute status off them.

- pending: **Compute download status off the materialized catalog FKs and delete the
  cache.** Port Lidarr's model: status = a live indexed join/count over
  `TrackFiles.track_id` / `recording_id` (add the covering indexes), not the cached
  canonical-mbid joins. Then remove `albumStatsCache` / `artistStatsCache` /
  `mediaDownloadCache` and every `invalidate*DownloadStatus` call. **Guard the perf
  regression** the cache was papering over ([[discogenius-perf-facts]],
  [[sluggishness-root-cause]]): the whole point is that the FK join is cheap enough that
  no cache is needed — verify with the read-profiler before deleting the cache, not after.
- pending: **Cleanup zeroes the link, Lidarr-style.** Once status is FK-based, orphan
  removal just deletes the `TrackFiles` row (the FK is on the file row, so no separate
  "zero the track" step is needed) — the 2.6.12 cache-invalidation logic in
  `cleanOrphanedRecords` is then deletable dead weight. Remove it with the cache.
- confirmed (already satisfied): **We already store ≥ Lidarr's file-table data.**
  `TrackFiles` carries all five canonical MBIDs (artist / release-group / release / track
  / recording) **and** the four integer catalog FKs, plus size/duration/bitrate/quality/
  `original_filename` (= Lidarr `SceneName`) / `release_group`. No new columns needed for
  "store all MBIDs". (One minor gap vs Lidarr: an explicit `DateAdded`/`created_at` on
  every file row — confirm ours is always populated at import.)

### Sidecar / extra files — port `ExtraService` (fixes rename-preview clutter)

Lidarr keeps **only audio/video** in `TrackFile`; lyrics (`.lrc`), metadata (`.nfo`) and
images live in separate tables and are **moved as a side effect** of the audio file's
rename (`ExtraService.MoveFilesAfterRename`), never listed as their own rename decisions.
We already have the tables (`ExtraFiles` / `LyricFiles` / `MetadataFiles`, each with a
`track_file_id` FK) and write to them — but the rename plan UNIONs all four tables, so the
preview is cluttered with cover/lyric/nfo rows.

- done: **Preview shows media files only; extras follow on apply.**
  `RenameTrackFileService` preview + status now filter to `file_type IN ('track','video')`
  (`mediaOnly`); the apply path stays full so extras still rename. Landed together with the
  co-move below so selected media-only ids never orphan lrc/jpg.
- done: **Id-based apply co-moves track-linked extras (`ExtraService.MoveFilesAfterRename`).**
  `executeRenameFiles(ids)` expands each media `TrackFiles` id to its extras linked via
  `track_file_id` (`expandWithLinkedExtras`, across MetadataFiles/ExtraFiles/LyricFiles,
  idempotent) so an id-based apply co-moves them. Covered by a rename-service test.
  Folder-scoped sidecars (cover.jpg/folder.jpg/artist.nfo — null `track_file_id`) remain
  handled by the by-query `reconcileSeparatedSidecars` path, matching Lidarr (its metadata
  consumers move folder-level images, ExtraService moves track-linked extras).
- done: **Stop storing sidecars as `TrackFiles` rows.** `file_type` still allows
  `cover`/`lyrics`/`bio`/etc. on `TrackFiles`; migrated non-media rows so `TrackFiles` is audio/video-only (Lidarr's invariant).
- done: **Normalize shared-root ownership.** A playable `TrackFiles` row has one
  exact `library_id` and ambiguous root-only imports fail closed. Physical
  metadata, lyric, and other-extra rows can be referenced by several libraries
  through `MetadataFileLibraries`, `LyricFileLibraries`, and
  `ExtraFileLibraries`; releasing one owner cannot delete another owner's file.
- consolidates: the "Cross-album cover/lyric bleed" item under Tagging below.

### Artwork — two independent entries (corrected regression ledger)

#### A. Sidecar placement and missing-file regeneration
- done (2.7.4): **Sidecar placement and missing-file regeneration.** Writing into the actual existing album folder is known-good (`ensureAlbumCoverArtSidecarSync`, regenerated on scan).
- done: **Store-once, reuse-everywhere (MediaCover Cache).** Local disk cache in `CONFIG_DIR/media-cover` serves sidecars and audio tag embedding offline without live network re-fetches.
- pending: Preserve and strengthen testing for sidecar generation and backfill/repair without network fetching during tagging or sidecar reconciliation.

#### B. Artwork identity in hybrid albums and supplemental singles
- done: **Artwork identity is the release group (or release), never the plan.**
  `resolveAlbumArtwork` keys on `Albums.mbid`. A hybrid/composite acquisition
  may download from contributing singles; those sources cannot become the
  cover. Covered by `artwork-identity-regression.test.ts` (single does not
  override album art; source-order invariant; cache survives hybrid import).
- done: **Slot isolation.** Stereo and spatial folders each write `cover.jpg`
  from the same RG cache. They do not borrow each other's folder art.
- done: **Both preference orderings** in `resolveAlbumArtwork` (canonical vs
  provider), applied to cache + sidecar + embed.
- pending: **Per-provider high-res master (API digging).** Each provider already has `getArtworkUrl({size})`; make a "max" size return the true master: TIDAL `origin`; Apple `{w}x{h}` at max advertised; Deezer CDN `{size}x{size}`; SoundCloud `-original`; Spotify ceiling 640; YouTube maxres; Amazon largest variant; canonical CAA verbatim.
- done (kept): 1200px embed cap (`EMBEDDED_COVER_HEIGHT`), both preference modes.

### Provider metadata is match-time-only (catalog-first everywhere)

Provider artist/title/credits are used only for match scoring. Display, organizing/
naming, and tagging use catalog (Servarr / local-MB) exclusively. Remove the leaks:

- done: **Album-page track artists** — album tracks read `Recordings.credits`
  (canonical). The old `read-service.ts` provider override is gone.
- done: **Tag writer artist fallback** — dropped `COALESCE(canonical…, provider_recording.credits)`
  in `getTrackArtistNames` / `buildTrackRowsSql`; tagger uses canonical catalog credits exclusively.
- done: **Organizer naming** — 2.8.1 stopped falling back to `ProviderItems.title`;
  file names come from the catalog.
- pending: **Broad sweep** — audit every `COALESCE(canonical, provider)` / override in
  read services, tag builder, organizer. See [[discogenius-goals]], [[matching-facts]].

### Tagging — port `AudioTagService.WriteTags` (keep Plex release types)

- done: **Field-by-field parity** with Lidarr `WriteTags`; writes an identical tag
  set (23 standard fields + review comment + lyrics + replaygain), keeping our Plex `album; <secondary>` release types.
- done: **Genres populated at import.** Artist-summary upsert does not write
  `Albums.genres`; full release-group detail does. Import now hydrates any dest
  album whose genres are still empty *before* the tagger runs, so catalog
  genres replace the downloader's leftover single genre without changing the
  writer.
- done: **Auto tag-sync on metadata change** — `write_audio_tags_policy=sync`
  queues `RetagArtist` after MatchArtistProviders when the catalog fingerprint
  changed. New downloads still tag; manual import of existing files does not.
- done: **Retag preview surfaces the cover diff** like tag fields.
- done: **Rename & Retag preview FluentUI modal parity.** Redesigned `FileMaintenanceDialogs.tsx` matching Lidarr's modal layout/UX, adding empty tag symbol `∅`, Fluent icons (`AddCircle16Filled`, `SubtractCircle16Filled`, `Record20Regular`, `Prohibited16Regular`), and selection toolbars.
- done: **Library list view consistency & spatial/stereo track deduplication.** Standardized separate `Thumb` column across all 4 library tables (Artists, Albums, Tracks, Videos); added dedicated desktop `Artist` column on Albums and Videos (retaining mobile-only title subtitle); updated Artist tab stats to `downloaded_albums / monitored_albums` and `downloaded_tracks / monitored_tracks`; updated Album tab stats to `downloaded_tracks / total_tracks`; standardized `Local Files` column across Album, Track, and Video views with vertical flex badge alignment; placed `Tracks` counter behind `Local Files` on Album view; mapped majority local quality badge + dual stereo/spatial quality badges; deduplicated track stats counters so Stereo and Spatial versions of the same track count as 1 track.

### Scheduling & automation parity

- done: **One Rescan Folders command.** The duplicate manual `rescan-folders`
  registry entry is gone; `root-scan` is the scheduled task and the command-name
  target. Payload scopes by `artistIds` / `addNewArtists` / `filter`. Per-artist
  workflow scans no longer count as the daily root-scan being active, so they
  do not reset or skip the scheduled clock.
- done: **`Matched` vs `Known`.** Scheduled and unchanged-metadata manual scans
  use `known` (new files + size/mtime). A metadata-changed refresh uses
  `matched` (also rematch unmatched existing files). Port of Lidarr
  `FilterFilesType`.
- done: **Scheduled DB backup & restore capability** (ported Lidarr `BackupCommand` via `executeDatabaseBackup` + 7-backup retention + `/api/system/backups` REST endpoints for list/download/delete/restore; verified Lidarr parity that artwork/MediaCover is excluded from backup archives).
- done: **ReplayGain & Peak tag embedding** (verified `REPLAYGAIN_TRACK_GAIN` & `REPLAYGAIN_TRACK_PEAK` formatting across FLAC/Vorbis, MP3 ID3v2 TXXX, M4A Apple atoms, and WMA).
- done: **Scheduled health check** (ported `CheckHealth` diagnostic command).
- note: Rename stays import-time/manual (Lidarr doesn't schedule it) — do NOT add
  scheduled rename.
- revisit: followed-artists-import vs `ImportListSync` cadence; message-cleanup cadence.

### Repo & container hygiene

- done: **Provider videos fail closed at the canonical boundary.** Provider
  refresh now caches unmatched video offers without minting `Recordings` or
  accepted matches. Identity-bearing `ProviderVideoMatches` are constrained in
  the active and contract schemas and in the repository to existing
  MusicBrainz video recordings. Legacy provisional assignments are repaired
  without deleting the physical file; files are rehomed only when a canonical
  target exists.
- done: **Test-suite audit and targeted consolidation (first pass).** Confirmed
  that the near-1,000 count is mostly distinct coverage rather than duplicate
  execution. Consolidated `refresh-video-service.test.ts` from 26 tests / 1,287
  lines to 11 tests / 558 lines by removing matcher-detail duplication already
  covered in focused matcher suites, while retaining authority, ambiguity,
  legacy-repair, exact-file, schema, and supplement-only behavior. See
  `docs/TEST_SUITE_AUDIT.md`; further active-schema conversions remain.
- pending: **Broad legacy cleanup pass** — orphaned files, dead dirs, redundant/legacy
  code, unused exports (extends today's stray-DB/dead-dir removal). Pairs with
  "Repo-wide structure audit" below.
- pending: **Docker image efficiency** — study `.ref_lidarr` / `.ref_jellyfin` container
  packaging (base image, multi-stage builds, layer caching, runtime-only deps, image
  size) and adopt wins for a smaller image.

## 3.0.0 (planned) — monitoring / catalog architecture

- revisit: **New-release detection cadence.** Lidarr checks new releases frequently via
  RSS (~15m) separately from the 24h metadata refresh; we fold detection into the 24h
  cycle. Decide the streaming-native equivalent (a light, frequent "any new releases?"
  pass) as part of the catalog/monitoring architecture. Relates to "Catalog source
  modes" and "Configurable library types" below.

## 2.6.0 (shipped 2026-07-22)

Shipped themes: SoundCloud experimental, quality tooltips/`video_codec`, scroll
restore, Settings catalog reorder, provider public surface + SQLite write gate,
album Associated videos + `inline_only`, download fallback warnings, video
gates/filters/strip tags, tiddl error capture, WGM matcher + Amy HIRES tip.
Wipe installs: no late open-39 ALTER path (CREATE baseline only).

Residual / follow-ups below. Manual provider validation still needed (see top).

### Follow-ups from 2.6

- pending: hybrid tooltip quality breakdown (`qualityTrackCounts` in UI)
- pending: SoundCloud Auth/Go+/permalink polish; contract parity
- pending: measure Bastille/Bakermat bulk refresh under local-MB with gate + 2
- pending: migrate one provider end-to-end (SoundCloud pilot) for modularity
- pending: structure audit incremental moves (provider-folder migration; core↔provider boundary-debt cleanup — see "Repo-wide structure audit" below)

### SoundCloud provider (experimental)

Research (2026-07): yt-dlp covers **download** (tracks, sets, private links, user
likes via URL); **catalog** and stable URNs need the official SoundCloud API
(OAuth 2.1) or a thin api-v2 client — yt-dlp alone is CLI-shaped, omits ISRC,
and is a poor fit for `ProviderItems`. Hybrid: API for catalog/auth/import;
native progressive and/or `YtDlpBackend` for acquisition. Lossy-only; no RG
automation; major-label DRM/Go+ gaps; API ToS forbids file-save on registered
credentials — label experimental and at-operator risk.

Live probe (2026-07-22, free session): api-v2 `oauth_token` + public `client_id`
validates `/me`, search, user albums, and progressive MP3 resolve on some
indie/downloadable tracks. Major-label Bastille offers often return
`policy=SNIP` or encrypted HLS for free accounts — native progressive fails;
yt-dlp remains the fallback. Official OAuth 2.1 (registered app + PKCE) deferred;
Auth uses token paste like Deezer/YTM.

Mixtape / less-official matching (2026-07-22): for MusicBrainz secondary types
`mixtape/street`, `dj-mix`, `demo` (and primary `Other`), SoundCloud casts a
wider net via `/search/playlists` (not only the matched artist’s `/albums`).
User playlists that **cover** the MB tracklist are accepted even with extra
tracks (superset OK). Conviction is always `probable` with method
`playlist-tracklist-coverage` — never `verified` (fan sets are not identity).
Official Album/EP/Single without those secondaries stay album-search-only so
fan playlists cannot false-positive against standard releases. Example: Bastille
OPH (`375227dd-…`, EP + Mixtape/Street) ↔ `emmatad/sets/other-peoples-heartache`.

- shipped: first-pass module under `api/src/services/providers/soundcloud/`
  (api-v2 catalog matching, oauth token paste auth, native progressive download
  + yt-dlp fallback, liked-tracks + playlist import sources, mixtape playlist
  coverage matching).
- decided (2026-07-23): **no** Widevine/FairPlay decrypt and **no** analog-hole
  (browser→loopback) capture for `cbc-`/`ctr-encrypted-hls`. Evidence and
  rationale: `docs/PROVIDER_DOWNLOADER_DECISION.md` § SoundCloud DRM. yt-dlp/scdl
  refuse the same streams; Apple’s FairPlay wrapper pattern does not transfer.
- shipped (2.6.5): skip DRM/SNIP tracks + complete partial albums with per-track
  `skipped` status and a job-level warning (no abort of the whole set; no
  yt-dlp fallthrough for encrypted formats).
- ready (2.6.6): DRM-aware matching — prefer downloadable progressive/plain-HLS
  fan sets; reject DRM/SNIP-only shells so they cannot alone fill slots / drive
  monitoring; search-time track filter; Auth notes Go+ ≠ Discogenius download
  unlock. Live OPH: emmatad + other progressive sets match; Bastille `26282908`
  is DRM; mixed rumourhasit ranks below zero-DRM covers.
- pending: richer permalink resolve; Auth / Settings / diagnostics polish;
  contract parity with other lossy providers.
- defer: followed artists → MB monitoring, official-API download path /
  registered-app PKCE, ISRC-first matching automation, lossless/hi-res/spatial;
  any DRM decrypt/record revisit only if a maintained, non-CDM-theft SoundCloud
  backend appears (unlikely).

### Video offer codec×resolution map

- shipped (2.6.4): same-resolution codec preference AV1 > VP9 > HEVC > h.264;
  YouTube assumed AV1@UHD / VP9 otherwise; Apple HEVC; TIDAL h.264.
- shipped (2.6.5): **shallow** YouTube/YTM default flipped to AV1 at all
  resolutions. No full provider × quality-tier matrix audit in that tag.
- **rejected (`d0893da`)**: Apple UHD→AV1 from muddy TrackFiles (YT fallbacks
  labeled apple-music).
- corrected (2.6.6 pending): exclusion = apple-music rows with AV1/VP9 video
  **or** Opus audio (Apple MVs are AAC). Clean sample: Apple UHD/QHD HEVC,
  FHD/HD h.264; YTM HD+ AV1; TIDAL h.264. ffprobe Bastille Apple UHD
  `1769245454` → hevc@3840×2160. Map: YTM HD+ AV1 / SD unset; Apple QHD+
  HEVC else h.264; TIDAL h.264.

### Local-MB refresh concurrency redesign

Motivated by local Postgres MB **not** being public-API rate-limited (bulk SQL
fetches are fine). SQLite + sync `better-sqlite3` remains the bottleneck.

- decided: keep chunked SQLite writes (`runChunkedWrite`) — do **not** switch
  catalog hydration to one giant transaction.
- shipped: **single-flight write gate** (`withSqliteWriteGate`) around
  catalog SQLite commits in `servarr-metadata` sync paths so fetches can overlap
  while only one writer commits chunks at a time.
- shipped: `RefreshArtist` `resolveMaxConcurrent` — Servarr stays `1`;
  local-MB may run `2` (fetches overlap; writes gated). Do **not** raise further
  without measuring busy-timeout / main-thread claim latency.
- pending: measure Bastille/Bakermat bulk refresh under local-MB with gate + 2;
  consider MatchArtistProviders similarly only if needed.

### Provider plugin modularity

Product goal: streaming services are swappable modules. Core Discogenius
(MusicBrainz catalog, library, command queue, curation, import) must stay useful
if a streamer (e.g. TIDAL) blocks third-party access/download. Easy to disable,
remove, or swap a provider without core entanglement.

Today we are **adapters in a folder**, not true plugins: shared
`StreamingProvider` / `ProviderManifest` contract and per-id folders under
`api/src/services/providers/<id>/`. Registration is compile-time. See
`docs/STREAMING_PROVIDER_PLUGIN_CONTRACT.md` (§ 2.6 modularity target).

- shipped (phase 1): public surface at `api/src/providers/` (registry +
  types). `services/providers/index.ts` re-exports for compatibility. Concrete
  adapters still under `services/providers/<id>/`.
- pending: investigate Lidarr `ThingiProvider` + `Indexers/` /
  `Download/Clients/` (compiled-in plugins via factory), Lidarr’s thin
  `Plugins/` surface, Tidarr / Jellyfin layouts under `.ref_*`.
- pending: migrate one provider end-to-end (SoundCloud pilot), then roll others;
  kill direct core→`tiddl` / provider-private imports; replace tidal-shaped
  health with backend-id-keyed diagnostics (already noted under Performance).
- defer: dynamic npm/runtime plugin loading, separate publishable packages per
  provider — not required for 2.6 unless the boundary work makes it cheap.

### Repo-wide structure audit

- pending: incremental provider-folder moves — relocate adapters from
  `services/providers/<id>/` to `api/src/providers/<id>/` behind the stable
  registry barrel, smallest/experimental first (SoundCloud → Deezer → Apple /
  YouTube / TIDAL last). Leave a thin re-export stub for one release, then delete
  stubs once grep is clean. No reorg-only mass move; split alongside feature work.
- pending: boundary debt — replace core→provider-private imports
  (`commands/health.ts` → `providers/tidal/tiddl`) with backend-id-keyed
  diagnostics from the provider contract.
- Guides (present checkouts only): `.ref_lidarr` (core folder map —
  `docs/LIDARR_STRUCTURE_ALIGNMENT.md`), `.ref_tidarr` (TS streaming-arr shape),
  `.ref_jellyfin` / `.ref_kodi` (media-server / sidecar metadata layout). Also
  useful for provider tooling boundaries: `.ref_tiddl`, `.ref_yt-dlp`,
  `.ref_apple-music-downloader`. Do not invent missing refs.
- Aligns with provider modularity: separate **core** paths from
  **streaming-service** modules so disabling TIDAL (or any provider) is a
  registration/config change, not a core rewrite.

## Post-2.4.0 priorities

### Performance and intake (top)

- pending: skip / lazily hydrate release-group detail for RGs excluded by
  release-type filters or that failed cheap provider-match narrowing. Today
  `hydrateScopedReleaseGroups` still syncs every scoped RG (Servarr-mode cost).
  Document MB-local as recommended for very large imports.
- revisit: Housekeeping exclusive slot — add progress/cancel or split if large
  catalogs block user commands too long.
- pending: replace tidal-shaped `health.ts` `backends.tiddl` with a
  backend-id-keyed projection from provider diagnostics; continue splitting
  large modules (`organizer.ts`, Settings page — sections already extracted)
  alongside feature work. (`tiddl.ts` / `tiddl-backend.ts` already split.)

### Library tools

- done (2026-07-31): real-provider tag-writer preservation sweep across TIDAL
  AAC, FLAC, and E-AC-3/JOC Atmos plus TIDAL 1080p and Apple 4K video.
  `node-taglib-sharp` is now the primary `.m4a`/`.mp4` writer for proven
  iTunes-style containers, with atomic copy, exact tag/cover reread, and
  technical-structure verification. FFmpeg `mdta/keys` containers are detected
  and retained on Mutagen; Mediabunny was rejected because its remux changed
  Atmos signaling and lost custom MP4 tags. See `docs/TAG_IO_STRATEGY.md`.
- deferred: strip tags for video files (audio strip at artist/album is shipped
  via Manage → Strip Tags + `POST /api/v1/retag/strip`); per-track strip UI.
- deferred: optional Settings toggle for inline stereo vs spatial — product
  decision is stereo-only for now (spatial folders stay Atmos audio).

### Matching and curation

- decided (2026-07-23): MV↔audio matching vs Lidarr/Jellyfin — architecture (MB
  `music_video_for`, `provider_video_for`, duration/variant/ISRC) is sound; there
  is no open-source MV↔track matcher to copy (Lidarr is audio-only; Jellyfin uses
  a closed extras token list + NFO/provider ids). **2.6.7:** centralized
  `live-performance-markers.ts` (`live` / `performance` / `unplugged` +
  live-album-only membership); removed Bastille TV-show deny phrases. Live↔studio
  gate applies even when duration is close. Next: larger artist stress-test; fix
  failures structurally (RG types, venue signatures, MB relations), not with more
  show-name `LIKE`s.
- deferred (post-2.6.6): partial video-stream / Chromaprint grouping evidence.
  Reject refresh-time stream sampling — multi-second fixed cost per offer × N
  videos = minutes/artist + rate-limit/ToS risk, and audio-only fingerprints
  false-merge lyric↔OMV. Optional later: import-only `fpcalc` on downloaded MVs,
  local compare, `video_variant`-gated, top-K / already-downloaded only — never
  full-offer refresh, never a sole merge key.
- deferred (post-2.6.6): semi-official YouTube sources (VEVO / MTV / similar) —
  **DEFER WITH GUARDRAILS**. Reject automatic MTV/network-channel harvest (mixed
  artists/promos, title-parsed attribution, multi-upload twin risk); keep YTM
  artist catalog + MB free-streaming URL relations as the only discovery paths.
  Optional later: channel preference scoring only (VEVO / `- Topic` / Official /
  verified artist channel) as ranking evidence, never sole acceptance.
- pending: hybrid / multi-provider album fills — decide whether incomplete
  single-provider coverage should warn (yellow) vs require full set-cover before
  marking an album complete; Lioness-style missing-track cases are the litmus.
- in progress: release-centric matching — direct decisions persist only in
  typed edition/track match tables and composite coverage persists in
  acquisition-plan sources/assignments; still need provider albums to score
  against **all** candidate MB releases for the artist (not one RG container). Evidence:
  MB external links → UPC/ISRC/recording coverage → title/version/date/type.
  See `docs/MATCHING_SET_COVER_DESIGN.md`.
- pending: artist-wide coverage optimization before final slot selection
  (recording MBID → ISRC → shape; apply filters first). Partial set-cover
  helper exists; not the full pre-slot solver.
- pending: recording-centric song set — queryable recording↔artist-credit
  (primary + featured); today only `Recordings.artist_mbid` + `credits` TEXT.
- pending: only recompute composites when provider offers for that artist/RG
  changed.
- pending: curation tests for edition choice vs global coverage.

### Import, monitoring, library

- done (2026-07-31): provider matching no longer manufactures monitoring state.
  Curation seeds unmonitored catalog artists into enabled library overlays with
  `monitored=0`; the explicit Monitor action materializes `LibraryArtists` as
  monitored. Active-schema regression coverage guards both directions.
- decided (not implemented): Lidarr import-list monitor modes —
  EntireArtist vs SpecificAlbum (album granularity only). Needs import modal
  selector + deferred-monitoring reconciliation.
- decided (not implemented): artist manage modals — artist-scoped Interactive
  Import + MonitoringOptions (all/future/missing/…).
- pending: richer album-tracklist video UX (inline preview + VIDEO offers on
  album-scoped video recordings). Glyph + Associated videos section already
  ship via `associatedVideos` on the album page payload.
- pending: playlist **SYNC** (recurring ImportList-style sync + exclusions),
  not only one-shot import.

### Metadata tagging

- pending (later): Lidarr `WriteAudioTagsType.Sync` — retag files when curated
  MB columns change on refresh (`write_audio_tags_policy` has no `sync` yet).

### Catalog source modes

Runtime wiring, Settings selection, and SQLite hydration from either source
already shipped. Current behavior (correct mental model):

- Both Servarr and MB-local **replicate into Discogenius SQLite** on refresh.
  MB-local reads live Postgres during refresh; it is not a live-query-only UI
  path and not a “flush SQLite and query Postgres forever” mode.
- Switching modes only flips `CatalogProvider`. The next refresh re-reads from
  the new source. No catalog flush runs today.
- Servarr typically lacks ISRC/UPC; MB-local fills them. ISRCs and barcodes are
  preserved across a Servarr re-hydrate (`COALESCE`). Switching back to MB-local
  and refreshing fills remaining holes. Matching/curation/slots/downloads can
  then change, and with `remove_unmonitored_files` some library files can be
  pruned or replaced via new selected offers.

Remaining work:

- pending: document and harden the switch UX (optional “refresh monitored now”
  prompt). Full catalog-flush / live-query-only redesign from
  `SCHEMA_MODE_SWITCH_DESIGN` is **obsolete relative to what shipped** — do not
  implement flush-on-switch unless we deliberately change architecture.
- revisit: unify edition-aware matching onto one shared scoring path.
- pending (schema hygiene): reduce residual JSON TEXT where typed columns
  suffice (notably release `country` stored as a JSON array string). ProviderItems
  typed promotion is largely done.

### Configurable library types

- pending: replace fixed stereo/spatial/video slots with named library types
  (name, root, content kind, desired quality).
- pending: migrate `ReleaseGroupSlots` off fixed slot names; download/curate
  per library type; keep release-type filters global.

### Load / UI stabilization

Shipped pieces (not pending): Library one-at-a-time infinite scroll, lazy card
artwork, shared quality columns, empty-state import button, client-only
UltraBlur (no backend `/ultrablur`), Fluent Alpha layer surfaces on nav/cards,
bounded artist retag preview/status (`scanLimit`).

Album vs artist page load (2026-07-23 audit + partial fix):
- Root causes vs artist: album `/page` was monolithic and re-synced the release
  group (remote catalog) + live `getAlbumTracks` + live editorial on every GET;
  artist is sectioned (identity→albums→tracks/videos) and DB-first with
  conditional hydrate. Lidarr/Jellyfin also keep detail GETs local-only and
  stage secondary fetches.
- Measured (Bastille, live container before fix): artist identity ~35–55ms;
  album `/page` ~0.3–2.4s (Bad Blood cold ~2.3s; health flagged slowRequests
  >1.5s). Release-availability alone ~20–45ms.
- Shipped (Unreleased / candidate 2.6.7): DB-first album page (skip sync when
  AlbumReleases exist; ProviderItems for track offers; no live review on read);
  deferred release-availability query so header+tracks paint without waiting.
- pending: section album page like artist (`identity` / `tracks` /
  `associatedVideos`) so header paints before tracklist + video SQL; slim
  `getAlbumAssociatedVideos` (correlated track-label subqueries × N videos —
  Bad Blood has 19). Estimated additional first-paint win: hundreds of ms on
  video-heavy albums after the DB-first fix lands in the running container.

Still open:

- pending: catalog diff — reconcile removals; do not stamp `last_scanned` after
  partial refresh failures.
- pending: richer track-level / mixed-quality coverage in the release switcher
  (`coverageSummary` is persisted but not rendered).
- pending: replace availability/match edges cleanly on refresh (not upsert-only
  accumulation); partition composites by library slot.
- pending: revisioned artwork cache keys (preference/`fulfilledBy` invalidation
  shipped; URLs still lack content-revision hashes for browser cache busting).
- pending: split `TrackList` without visual change.
- pending: DataGrid keyboard resize/ARIA; Unmapped Files repair; mobile
  tracklist duration/actions; detail overflow earlier by width; Bakermat “The
  Spirit” year; album `9aad95d9-…` version matching; sidecar path vs naming
  template validation on SMB.
- pending: frontend unit coverage for pagination/locks; full Playwright suite
  in CI (smoke-only today).

### Test suite

- pending: trim API tests into release-contract vs focused regression vs
  low-value detail; keep the first two.
- revisit: full Lidarr-style in-memory queue projection if the bounded download
  queue becomes insufficient.

## Decisions worth keeping

- TypeScript stack; do not port to .NET. Fix scale via decomposition + data
  model + skip-unchanged.
- Keep the `TrackFiles` table name (Lidarr `TrackFile` semantics for playable
  audio/video; sidecars in separate tables).
- No multi-user / roles for the foreseeable future (Lidarr posture:
  single-operator). Auth stays the app/session gate.
- Schema **v39** is the upgrade floor (adds `Recordings.video_variant`). After
  2.4.0’s v38 baseline, schema changes use forward migrations (not wipe), once
  the migration runner lands.

## Deprioritized

- Notifications, tags, blocklist/failed releases.
- Multi-user accounts / roles / per-user libraries.
- Per-artist metadata or quality profiles (prefer library-type quality).
- Metadata-consumer profiles beyond MBID tagging and NFO/artwork sidecars.
- Implementing the old “flush SQLite catalog + live-query Postgres only”
  mode-switch design (superseded by replicated-cache behavior).
