# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [2.6.10] - 2026-07-23

### Fixed
- **Embedded Cover Art Proxy Sizing**: Audio file tag embedding now uses ~500px cover art proxies (`cover-500.jpg`, ~50 KiB) instead of embedding multi-megabyte master origin images (`cover.jpg`, ~5.9 MiB) into every individual track file. This saves ~80 MB per album in audio file binary bloat, speeds up tag reading, and matches Lidarr/Plex embedded image standards. Master origin covers (`cover.jpg`) remain 100% full-resolution for folder sidecars.
- **Plex Release Type Tagging**: Formatted `release_type` (`MusicBrainz Album Type` / `RELEASETYPE`) tags so secondary release types (e.g. `live`, `compilation`, `soundtrack`, `remix`) set the primary type to `album` (e.g. `album; live`), ensuring Plex categorizes live releases under Live Albums while preserving MusicBrainz metadata. Written with both `RELEASETYPE` and `MUSICBRAINZ_ALBUMTYPE` fields for Vorbis/FLAC comments.
- **Original Release Date & Media Format Tagging**: Added `original_date` (`ORIGINALDATE` / `TDOR` / `TXXX:Original Release Date` / `WM/OriginalReleaseTime`) and `media_format` (`MEDIA` / `TMED` / `WM/Media`) tagging across all audio formats.
- **Genre Fallback Tagging**: Added fallback from `Albums.genres` to `ArtistMetadata.genres`, ensuring tracks inherit artist genres when album genres are not explicitly specified.

## [2.6.9] - 2026-07-23

### Fixed
- **SoundCloud DRM Filtering & Match Rejection**: Official SoundCloud release searches that yield DRM-encrypted tracks (such as track `26282908`) now evaluate downloadable coverage and fall back to wide playlist searches for downloadable, non-DRM fan sets (e.g. `emmatad` releases with progressive streams). If no DRM-free alternative exists, the DRM-only offer is rejected so Discogenius does not register an undownloadable match.
- **Lidarr-Style Full-Resolution Media Cover Storage**: Full-resolution origin cover images are now stored locally in the `MediaCover` folder alongside 500/250 proxies for both albums and artists (Lidarr-style), ensuring embedded artwork and sidecars can read origin files directly without fragile import-time re-fetches.
- **Artwork Preference Toggle Refresh**: Toggling `artwork_preference` in Settings ("canonical" ↔ "provider") now triggers a background cover refresh across all stored albums and artists to re-resolve artwork according to the new preference and regenerate proxies.
- **Incomplete Album Track Downloading**: Hardened catalog album acquisition so incomplete albums (`presentCount > 0`) download missing tracks via `trackOffers` mode, using fallback ProviderItems track/recording lookups when child items are unlinked.

## [2.6.8] - 2026-07-23

### Fixed
- Apple Music decryption wrapper no longer strands first-time login at "Login
  request sent to the decryption wrapper...". The supervisor script is now
  provisioned into the shared `wrapper-rootfs/data` volume (a directory mount)
  and the sidecar's compose entrypoint is a static bootstrap that waits for the
  script and then execs it. This removes the Docker "bind-mount a not-yet-created
  file" trap — where the host `wrapper-entrypoint.sh` didn't exist when the
  sidecar started (`depends_on` only waits for Discogenius to *start*), so Docker
  created an empty directory in its place and the wrapper never consumed the
  login trigger. Fresh deploys now self-heal with no manual container recreate.
  The stale pre-2.6.8 entrypoint artifact is cleaned up automatically.
  **Action required:** update the `apple-music-wrapper` service block in your
  compose to the new form (new `entrypoint`, and drop the
  `wrapper-entrypoint.sh:/app/wrapper-entrypoint.sh` volume) — see
  `docker-compose.example.yml`.

## [2.6.7] - 2026-07-23

### Fixed
- Music-video ↔ audio live/studio matching: one shared
  `live-performance-markers` helper (TS + SQL) for `live` / `performance` /
  `unplugged` (incl. MTV Unplugged). Live-marked videos no longer associate to
  studio-only album/track titles; main OMVs skip live-album-only session audio
  without Bastille TV-show deny lists. Duration gates unchanged — the live
  mismatch still wins when durations are close.
- Global search paints local FTS hits before remote catalog discovery (Lidarr-
  style), slims track/video enrichment SQL (indexed COALESCE lookups, no
  album-offer join for autocomplete), and uses `COLLATE NOCASE` artist dedupe
  instead of `lower()` scans.
- Rename/retag preview no longer writes `expected_path` on every GET; conflict
  probes use cached statements + page-local occupancy maps; runtime indexes
  cover `expected_path` / `(provider_id, file_type, library_slot)`. Lyric same-
  stem collisions show as selectable duplicates (“Apply keeps destination and
  removes this file”) instead of opaque Conflicts; hard conflicts explain
  destination collisions. Retag preview skips external lyrics network fetches.
- MusicBrainz video titles stay bare when venue-live provider titles attach
  (`Live at …` stays on `ProviderItems`); rename no longer rewrites imported
  bare stems with marketing parentheticals.
- Hybrid album `trackOffers` import re-reads resolved tip ids from the live
  queue payload after per-track fallback (fixes organizer “Could not match
  downloaded album files”). Private YouTube / SoundCloud DRM classified as
  permanent; SoundCloud all-DRM album errors no longer fall through to yt-dlp;
  Streamrip exit-1 includes stdout+stderr (not opaque “unknown error”).
- Library scan rematches Discogenius-organized audio that lacks an embedded
  provider id: tag title/duration (and MBID/ISRC when present) against sibling
  album provider offers so missing album tracks become TrackFiles instead of
  Unmapped Files. Rename leftovers that already have a TrackFile for the same
  offer are classified as duplicates rather than “no matching provider item”.
  Same-folder unmapped duplicates prefer the sibling already owning the
  recording over alternate editions.
- Unmapped Files table: column resize no longer treats responsive hide
  breakpoints (700–1100px) as resize floors, so Identified cannot explode to
  most of the row; Properties auto-sizes to fit quality strings like
  `24-BIT 44.1KHZ FLAC`.
- Music-video album ranking prefers studio Album/EP/Single over compilations
  and live sets (larger compilations no longer beat a smaller studio album).
  Album associated-video strips only list videos whose preferred association
  is that release group, so studio OMVs that also appear as DVD tracks on a
  live compilation (e.g. Amy Winehouse “Back to Black” on *At the BBC*) stay
  off the live album strip. Main OMVs no longer follow live-marked or
  live-album-only session audio for Appears On / inline placement.
- Album page load no longer re-syncs MusicBrainz release groups or live-fetches
  provider tracklists / editorial text on every navigation. Detail GETs are
  DB-first (Lidarr/Jellyfin pattern); provider track offers come from
  `ProviderItems` with live `getAlbumTracks` only as a fallback. Release
  availability loads as a deferred secondary query so the header + tracklist
  can paint without waiting on the switcher payload.
- Loading skeletons re-aligned to live layouts: album/artist art sizes and
  header title-block rhythm, media-card chrome, queue/activity row padding,
  and a 16:9 video-detail skeleton (replacing the centered spinner). Unused
  `artistSearch` card skeleton removed. Album full-page skeleton stays
  header+tracks only so it matches deferred release-availability paint.

### Docs
- Video matching vs Lidarr/Jellyfin notes and YouTube semi-official source
  guidance (`docs/VIDEO_MATCHING_VS_LIDARR_JELLYFIN.md`,
  `docs/YOUTUBE_SEMI_OFFICIAL_SOURCES.md`).

## [2.6.6] - 2026-07-23

### Fixed
- Horizontal carousel scroll restore on artist singles/videos and album
  associated-video strips after Back navigation (browser-verified on Bastille).
- Video→audio heal keeps explicit provider `related_track` and ATV↔OMV
  counterpart links instead of dropping them when studio-album membership is
  not yet hydrated.

### Changed
- Video offer codec defaults (provider×tier, corrected after rejecting
  `d0893da`): YouTube/YTM HD+ assumed AV1; YouTube SD unset (thin sample);
  Apple Music QHD+/UHD assumed HEVC and FHD/below h.264; TIDAL h.264.
  Re-audit excluded YT-fallback-as-Apple TrackFiles (AV1/VP9 or Opus audio on
  apple-music rows); ffprobe confirmed real Apple 4K is HEVC.
- Video associations prefer studio-audio MusicBrainz links and heal live
  offer merges that previously left canonical videos without provider offers
  (e.g. videos 2/7/9/20/2170).
- SoundCloud matching prefers downloadable (progressive/plain-HLS) playlist
  coverage over DRM/SNIP shells: mixtape secondary search ranks by downloadable
  track count, then fewer DRM tracks in the covering set. DRM-only SoundCloud
  catalog offers are rejected (`unavailable`) so they cannot alone fill a slot
  or drive monitoring when `require_provider_availability` is on. Track search
  drops DRM/SNIP/phantom-HLS when `policy` + `media.transcodings` are present.
  Auth status notes that Go+ does not unlock major-label downloads for
  Discogenius.

### Docs
- Partial video-stream / Chromaprint grouping feasibility deferred
  (`docs/VIDEO_CONTENT_MATCHING_FEASIBILITY.md`); reject refresh-time sampling.

## [2.6.5] - 2026-07-23

### Added
- SoundCloud plain-HLS preview: `getPlaybackInfo` returns HLS when progressive
  is unavailable; playback rewrites the playlist through a signed segment proxy
  so hls.js can play past CDN CORS (encrypted HLS remains unplayable).
- SoundCloud native plain-HLS download via ffmpeg when progressive resolve fails
  but unencrypted HLS resolves.

### Changed
- SoundCloud album jobs skip DRM/SNIP (and other account-terminal) tracks,
  download the playable remainder, emit per-track `skipped` status, and finish
  with `completedWithWarning` — no whole-set abort, no Widevine decrypt, no
  analog-hole capture (see `docs/PROVIDER_DOWNLOADER_DECISION.md`).
- Video associations honor MusicBrainz `music_video_for` as well as
  `provider_video_for`; Appears On / inline placement prefer the largest
  monitored stereo release group.
- `(Moving artwork)` titles classify as Visualizer; `MTV Unplugged` titles
  classify as Live (Visualizer stays separate from Official Audio).
- Video offer codec defaults: YouTube/YouTube Music assumed AV1 at all
  resolutions (TrackFiles evidence), not VP9 below UHD.
- Horizontal carousel scroll restore keys by stable `storageKey` only (not
  React Router `location.key`), saves on unmount, and waits for scrollable
  content before restoring.
- Lyric rename expected paths prefer the exact provider-id TrackFile (Lidarr-
  style stem follow); duplicate `.lrc` rows that collide on the same stem are
  deduped instead of permanent Rename Conflicts.

### Fixed
- SoundCloud preview no longer returns null for plain-HLS-only tracks.

## [2.6.4] - 2026-07-23

### Added
- Video offer ranking: same-resolution codec preference
  (AV1 > VP9 > HEVC > h.264), so FHD Apple Music (HEVC) beats FHD TIDAL
  (h.264) regardless of provider priority order.
- Horizontal carousel scroll restore on artist and album video strips when
  navigating back from a video detail page.
- Housekeeping: prune orphaned `/downloads/**/job_*` folders and re-tag video
  quality from stored width/height (fixes ultrawide Apple Music “UHD” files
  that were mislabeled FHD).

### Changed
- Cover art GET path is Lidarr-style static serve with long-lived cache headers;
  missing files still warm on demand, but existing bytes are never blocked on
  preference re-checks.
- Queue progress is transparent: granular percent when the downloader reports
  it, file x/y when that is all we have, and an indeterminate bar when there is
  no file-level progress (no more fake Apple Music ~35% ramp).
- Artist video cards show release year only (not artist name); album associated
  videos show disc/track number only (not track title).
- README trimmed toward a Lidarr/Jellyfin-style overview.

### Fixed
- Artist page video provider badges: API now returns `provider` / `provider_id`
  for ranked video offers.
- Apple Music video quality: probe preview HLS before trusting catalog `has4K`,
  prefer on-disk probed quality in offer badges, and classify ultrawide masters
  (e.g. 3832×1592) as UHD via the longer edge.
- SoundCloud: do not fall through to yt-dlp for SNIP/DRM-only tracks (clear
  error instead); playlist downloads continue to use the api-host URL.

## [2.6.3] - 2026-07-23

### Added
- Settings: a dedicated **Music Videos** category that consolidates the video
  download toggle, maximum resolution, music-video type filters, and folder
  layout that were previously scattered across Quality, Curation, and Media
  Management.
- Settings: grouped, reordered navigation (Connections / Music & Video / Library
  / Application) on desktop and a grouped dropdown on mobile. Catalog is renamed
  Metadata Source and Quality is split into Audio + Music Videos.
- Provider + quality badge on music-video cards (album "Associated videos" and
  the artist page), matching album cards.
- Settings Curation: Official Audio music-video type filter
  (`include_video_official_audio`, default on) — catalog `audio` variant
  ("(Official Audio)" / "(Audio)") is no longer folded into Official.
- Video offer quality backfill: RefreshArtist probes youtube-music video offers
  ingested from MusicBrainz streaming-URL relations (previously stored with no
  resolution tag) through the provider `getVideo` height probe.

### Changed
- Album "Associated videos" now honors the monitored state and music-video type
  filters — a video whose type is turned off (e.g. lyric videos) no longer shows
  — while videos already downloaded to disk stay visible.
- Download queue reorder is optimistic: moving a queued item updates its position
  immediately (instead of only after a manual reload) and reconciles with the
  server list.

### Fixed
- YouTube-only video thumbnails: fall back to `sddefault` / `hqdefault` when the
  `hq720` still 404s on YouTube's CDN, so youtube-only music videos reliably
  render a poster/thumbnail instead of a blank frame.
- SoundCloud album/playlist download: use the api-host playlist URL
  (`api.soundcloud.com/playlists/<id>`) that yt-dlp can resolve — fixes 404s on
  sets whose tracks preview fine in the browser.
- Organizer file matching after a cross-provider download fallback: the import
  now scopes to the provider that actually produced the files (e.g. YouTube
  Music) instead of the failed primary (e.g. Deezer), so downloaded album files
  match their tracks instead of failing with "Could not match downloaded album
  files".
- SoundCloud mixtape playlist matching: accept near-complete tracklist coverage
  (≥85%), strip `Artist - Title` fan-upload prefixes, and rank out empty official
  album stubs so unofficial sets (e.g. Other People’s Heartache) can match.
- Cover prefetch: RefreshArtist / MatchArtistProviders warm missing artist,
  album, and video bytes into `config/media-cover` based on on-disk cache
  (not `cover_image_id`); page `/media-cover` routes remain a cold fallback.

## [2.6.2] - 2026-07-22

### Added
- Queue history filters: outcome (Completed / Warning / Failed) and library kind
  (Stereo / Spatial / Video), server-side on the paginated history feed.
- Settings Curation: Visualizer music-video type filter
  (`include_video_visualizer`, default on) — separate from Official.
- MusicBrainz free-streaming / streaming URL relations ingested as
  `youtube-music` offers on video refresh (so catalog videos with an MB YouTube
  link get a downloadable offer).

### Changed
- Video thumbnails: store full-aspect origin; cards use a 250px aspect-preserving
  proxy; album/artist cover art still uses 500 + 250 proxies. Video cards are
  16:9 with `object-fit: cover` (taller thumbs crop top/bottom; card width
  unchanged).
- Cover identity: list and detail share one `/media-cover/.../cover.jpg` URL plus
  `?lastWrite=` / `?source=` so proxy vs origin no longer drift across pages.
- Album Associated videos honor the artist page list/grid (carousel) preference.
- Settings: naming template inputs stretch full width; path/layout controls stack
  on mobile for breathing room.
- TIDAL video quality offers: probe stream height instead of trusting catalog
  `MP4_1080P`; Apple no longer invents FHD; YouTube downloads respect Settings
  max resolution.

### Fixed
- Cross-provider live video merge: named venue twins (e.g. Other Voices) attach
  onto the MusicBrainz row instead of minting duplicates and double-downloading.
- Upgrader is provider-aware: no longer queues Apple (or other) album IDs as
  TIDAL downloads (Grace Note–style 404s).
- Artist/album mobile action bars: AppTooltip blocked Fluent Overflow measure
  refs — More overflow menu restored on narrow viewports.

## [2.6.1] - 2026-07-22

### Changed
- Settings: Official / Lyric / Live music-video type filters live under
  Curation (with release-type filters); Music videos settings keep download
  enable + resolution only.
- Settings: Video Folder Layout help moved into a compact tooltip instead of a
  multi-paragraph description under the control.

### Fixed
- Album matching: title-only provider shells with an empty/unknown tracklist
  (common SoundCloud album stubs) are no longer promoted to verified or
  selected into a tracklisted stereo slot — no more “matched” offers without
  per-track tips or previews.
- Slot selection: incomplete pure cross-release-group partials cannot steal a
  slot when every tip comes from an album matched to a different RG (e.g. Bad
  Blood X tips on Other People’s Heartache, Pt. 2).
- SoundCloud mixtape wide search is no longer blocked by empty official album
  stubs on the same release group; stored-offer rematch clears stale provider
  selections that no longer win.
- SoundCloud preview: allow SNIP progressive streams for browser preview and
  skip dead legacy media endpoints (post-2025 MP3 HLS 404s) when resolving.
- Scroll restoration: POP back-nav retries longer (4s growth budget +
  ResizeObserver) so artist pages restore scroll after slow hydrate.

## [2.6.0] - 2026-07-22

### Added
- SoundCloud experimental provider: api-v2 catalog matching, oauth token paste
  auth, native progressive download with yt-dlp fallback, liked-tracks + playlist
  import sources, and mixtape/dj-mix/demo (and primary Other) playlist/set wide
  search with tracklist-coverage matching (`probable` /
  `playlist-tracklist-coverage`; supersets OK). Official Album/EP/Single stay
  album-search-only.
- Local file quality tooltips (`localQualityTooltip`) plus `video_codec` /
  `width` / `height` columns on TrackFiles (schema-39 CREATE baseline only).
- Scroll restoration for catalog navigation (`ScrollRestoration`).
- Settings Catalog section reorder (catalog source next to provider settings).
- Provider public surface at `api/src/providers/` (registry + types) for 2.6
  modularity phase 1; adapters still under `services/providers/<id>/`.
- Catalog SQLite write gate (`withSqliteWriteGate`) so RefreshArtist fetches can
  overlap under local-MB while commits stay single-flight.
- Album Associated videos section + track music-video icons that scroll to the
  matching video; `inline_only` video folder layout option.
- Download offer retry/fallback with yellow warning UX when a fallback offer
  completes (`completedWithWarning`).
- Video type filters (official / lyric / live) and strip-tags manage action on
  artist/album (`POST /api/v1/retag/strip`).

### Changed
- Video placement: inline stereo linked videos, release-group gate, and
  auto-relocate of separated->inline videos when stereo audio is imported.
- RefreshArtist concurrency: Servarr remains 1; local-MB may run 2 when the
  write gate is active (do not raise further without measurement).
- tiddl download failures surface actionable stderr detail instead of Rich UI
  chrome.
- Wipe-oriented schema open path: no late open-39 `ALTER TABLE` additive
  migration helpers; fresh installs get `video_codec`/`width`/`height` from the
  CREATE TABLE baseline only. Existing non-39 DBs still refuse to start until
  wiped.

### Fixed
- World Gone Mad wrong-match: stricter structural title threshold and
  cross-release-group hybrid requires ISRC.
- Amy OST hybrid trackSources: HIRES tip wins over composite LOSSLESS slot badge
  for per-track quality display.

## [2.5.1] - 2026-07-22

### Added
- Artist delete from the Artist page (optional on-disk file removal) via a
  proper library delete path instead of a bare DB row delete.
- Deezer artist import sources: followed artists, favorite tracks, and
  playlists (gw-light API with `error: []` treated as success).
- Apple Music import: Made for You recommendations plus Library songs, with
  truncated editorial subtitles so Import list rows stay readable.
- Library selection-bar Preview Rename / Write Tags actions (Settings keeps
  templates and tag policy only).

### Changed
- Product voice: drop Lidarr-style marketing and UI copy from README, AGENTS,
  Settings/Naming, and related comments; TrackList drops dead Plex/provider
  column shims.
- Safer factory defaults for new installs: do not remove unmonitored files and
  do not create empty artist folders by default.
- MediaCover serves existing cached artwork immediately while preference
  refresh runs in the background; derivatives are prepared before clearing the
  previous cache variant.
- Hybrid album acquisition keeps the full composite provider album id set and
  falls back to coverage `trackSources` when ProviderItems lack MBIDs (e.g.
  trailing discs / Bastille GMTF stereo vol 3).
- Providerâ†’MusicBrainz ISRC matching prefers releases whose track/media counts
  match the provider album (stable MBID tie-break).
- Music-video matching treats shared ISRC as a strong twin signal; video refresh
  and affiliation navigation improvements.
- YouTube Music bridge upgrades bare `Mozilla/5.0` user-agents and maps expired
  cookie / liked-songs auth failures to a reconnect message (reconnect still
  required when cookies are expired).

### Fixed
- TIDAL Hits / editorial playlist import images prefer `squareImage` (and mix
  detail artwork) so landscape assets stop 403ing in the Import modal.
- Album organize can bind provider tracks to the selected release by ISRC when
  track/recording MBIDs were never written back onto ProviderItems.
- Manual Import / unmapped table layout clamps to the viewport instead of
  overflowing horizontally.
- Import Artists modal clamps long subtitles to two lines.

## [2.5.0] - 2026-07-21

### Added
- `SeedVideo` command executor so queued video seed jobs actually run.
- Database schema modules under `api/src/database/schema/` (catalog / files /
  commands / projections / search) with a thinner `database.ts` entrypoint.
- Frontend page splits for Settings sections, Library toolbar/artists tab,
  Album release switcher, Queue history panel, and UltraBlur helpers
  (`useUltraBlurHero`, color extract / bitmap render).

### Changed
- Catalog-first hybrid identity for download/import/organize/rename/retag:
  track numbers, titles, and slot binding come from `Tracks`/`Recordings` on
  the selected MusicBrainz release â€” never provider `match_evidence` positions.
- Hybrid album acquisition queues one `DownloadAlbum` with
  `acquisitionMode: "trackOffers"` (shared plan for manual + download-missing)
  instead of exploding into separate queue cards per source album.
- Inline music videos use one primary Plex file per audio stem + type suffix
  (`01 - Track-video.mp4`): download-missing collapses multi-provider offers for
  the same related audio/`-video`/`-lyrics`/`-live` slot (quality then provider
  preference), skips when that slot is already imported, and organize replaces
  a worse occupant at the primary path instead of writing descriptive or
  `{Provider-id}` siblings.
- Prefer-provider artist artwork walks `streaming.provider_priority`; album
  covers prefer the stereo slot's selected provider offer, then spatial, then
  other matches, then Servarr/canonical.
- UltraBlur heroes seed immediately when cached images are already complete,
  set `crossOrigin` before `src`, and stop remapping to slow on-the-fly
  `-250` cover derivatives.
- SQLite hot-path hygiene: prefer `col = 1` over `COALESCE(col,0)=1` and
  `IN (subquery)` over `OR EXISTS` on monitored/video filters.
- Removed dead similar-albums/artists surfaces, unused FileList, check-stream
  diagnostics, and dual monitor command-body keys.
- Video type filename helpers renamed to `resolveVideoTypeSuffix` (Plex-style
  suffixes retained).

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Apple Music album-tracklist music videos can carry a `cover` on
  `ProviderTrack` (Docker `tsc` build blocker).
- Frontend typecheck after WP7 splits (`SwitchableSlot`, Library toolbar /
  FilterMenu types, Queue history `onLoadMore`).

## [2.4.0] - 2026-07-20

### Added
- Amazon Music provider plugin: catalog, availability, artwork, lyrics when the
  external service supplies them, lossless/hi-res and Dolby Atmos quality
  mapping, and a non-interactive `amazon-music==1.7.7` download bridge. Amazon's
  official Web API is still closed beta, so this integration explicitly uses
  an unofficial external API/token and supports an alternate compatible API
  base URL. **Auth lists Amazon as Soon for 2.4.0** while the hosted token API
  (`amz.dezalty.com`) is unreliable; the plugin remains in-tree for re-enable.
- Spotify provider plugin: official Web API catalog/search via client
  credentials, artwork and Spotify-supplied previews, plus an optional
  `votify[librespot]==1.9.9` cookie-backed lossy-stereo downloader. Lossless,
  spatial audio, and video are not advertised, and operators remain
  responsible for complying with Spotify's terms. **Auth lists Spotify as Soon
  for 2.4.0** until connection is simpler than a Developer app; plugin code
  stays in-tree.
- YouTube / YouTube Music provider plugin: public catalog, artist releases,
  videos, synchronized lyrics, and lossy audio/video downloads through
  `ytmusicapi` + `yt-dlp`.
  Optional browser-header JSON and cookies enable account-library import
  sources and restricted/authenticated media without making public catalog use
  require a login.
- Deezer provider plugin: public Deezer API catalog/search and previews without
  authentication, plus MP3/FLAC downloads through Streamrip when the user
  supplies a Deezer ARL cookie.
- Provider authentication is manifest-driven: the Auth UI renders each
  plugin's declared credential fields and help text while retaining TIDAL's
  device login and Apple Music's wrapper login/2FA workflow. Providers may set
  `auth.comingSoon` to stay visible in Auth as Soon without accepting
  credentials (Amazon Music and Spotify use this for 2.4.0).
- The Docker image bundles each third-party provider runtime in an isolated,
  pinned virtual environment (`ytmusicapi`/`yt-dlp`, Streamrip,
  `amazon-music`, and Votify) so conflicting Python dependencies cannot change
  another provider's behavior. Provider diagnostics report credentials and
  backend readiness separately.
- Release switcher offer chips: each release row on the album page lists every
  matched provider offer as a selectable chip (provider mark, quality, match
  tooltip, hybrid indicator), so the user picks both the MusicBrainz edition
  AND which provider source fills the slot. The availability payload now
  reports the currently selected offer per slot.
- Apple Music download diagnostics explain the one-time wrapper Apple ID login
  when decryption fails with an "Invalid CKC" error.
- Album-bundled music videos (Apple Music deluxe/festival editions) download
  and import as first-class videos: they map onto the release's canonical
  video tracks, land in the video library with video naming, and register a
  provider video offer on the same recording standalone uploads dedupe to.
- YouTube Music ATVâ†’OMV counterparts: album-track refresh resolves the UI
  audio/video switcher via `get_watch_playlist`, persists the OMV as an
  album-scoped video offer (plus a video-slot track offer when the OMV id
  differs), and writes `provider_video_for` to the matched audio recording so
  download offers and inline video layout can sit beside the album track.
  Album tracks that are already official music videos (self-OMV, no separate
  counterpart id) also get a video offer without overwriting the stereo row.
- Provider-plugin boundary hardening: generic downloader-login auth routes,
  provider-neutral import decision types, default-provider fallbacks instead
  of hardcoded TIDAL, and removal of dead TIDAL quality tables from core.
- Fully self-contained Apple Music wrapper login from the Auth page: the
  Apple ID and password are handed to the decryption sidecar through the
  shared config volume (no docker socket, no credentials in compose files) and
  are never persisted by Discogenius; the 2FA code is submitted from the same
  page. Discogenius provisions the sidecar's supervisor entrypoint at boot, so
  fresh headless deployments work without the repo checked out.
- Docker Compose no longer uses an `apple-music` profile: `apple-music-wrapper`
  is a normal service in `docker-compose.yml` / `docker-compose.example.yml`
  with comments explaining how to delete the block if Apple Music downloads
  are not needed. `docker compose up -d` starts the full stack.
- Fresh databases create schema **v38** in one plain-`CREATE` pass (no
  `IF NOT EXISTS` ensure* path on empty DBs). Existing v38 databases open
  without re-running upgrade repairs; v38 is the floor for forward migrations
  after 2.4.0. Adds indexes for artist-scoped ProviderItems slot filters and
  ArtistMetadata name lookup.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Artist bios and album reviews now prefer streaming-provider editorial text
  in Settings provider order (`provider_priority`): the first authenticated
  provider that returns a non-empty bio/review wins. MusicBrainz artists no
  longer skip provider biography lookup; Apple Music `editorialNotes` are
  wired as bio/review sources alongside TIDAL. Album pages read stored
  `Albums.review_text` first and fall back to a priority walk of matched
  offers (then Servarr overview). Servarr overview remains hole-fill only and
  no longer overwrites an existing provider bio.
- Catalog refresh no longer freezes already-hydrated MusicBrainz release groups:
  artist refresh re-reconciles every scoped album (content_hash still skips
  unchanged payloads), album page load always re-syncs, and stub/video sync no
  longer early-returns just because rows already exist. Local MusicBrainz now
  also loads release labels/url-rels and release-group genres/links/aliases/
  ratings into curated SQLite columns, and recording ISRCs / video flags
  (including MusicBrainz video sync) persist on reconcile.
- Retag and album NFO writers now embed catalog genre/label alongside existing
  barcode (UPC) and ISRC: audio tags get GENRE / LABEL (Kodi/Picard/Jellyfin
  primary path), album.nfo gets Kodi `<genre>` / `<label>`, keeps Discogenius
  `<upc>`, and writes track-level `<isrc>` only inside `<track>` children (not
  album-root; Kodi has no album ISRC and Jellyfin/Kodi music libraries rely on
  embedded tags for identifiers consumers actually read).
- Retag writes a plain `RELEASECOUNTRY` (not a JSON array string), embeds
  `INITIALKEY` from provider musical key when present, and skips ReplayGain
  placeholders (`+0.00 dB`, peak `0.0` / `1.0`).
- Servarr metadata refresh preserves release barcodes with `COALESCE` (same
  pattern as recording ISRCs) so a later Servarr pass cannot wipe UPC filled by
  MusicBrainz-local mode.
- Hybrid album quality badges use the majority track quality in a composite
  stitch (ties break higher), so a few hi-res festival tracks no longer make a
  mostly-lossless album advertise Max.
- Settings: provider capability dialogs show badges only (tooltips keep the
  detail); settings rows use balanced Fluent-style vertical padding; copy is
  shorter and less technical across catalog, quality, monitoring, metadata,
  and naming.
- Queue/Activity: hide album tracklists until download/import is actually
  running; ignore stale client progress on requeued jobs; filter progress-tick
  SSE noise on the Active feed (stops completed-item flicker). Hybrid track
  jobs carry disc/track numbers into the queue UI.
- Downloads: up to two concurrent downloads when providers differ
  (`DISCOGENIUS_MAX_CONCURRENT_DOWNLOADS`, default 2). Organize refuses a silent
  TIDAL default when `provider` is missing (looks up ProviderItems instead) â€”
  fixes Apple Music videos named/tagged as TIDAL / Unknown Video. Hybrid album
  organize falls back when `release_mbid` does not match the source edition.
  Embedded cover preference uses the canonical release group (not the foreign
  source album). Lyrics sidecars are written whenever lyrics are embedded so
  retag does not false-positive. Failed imports clean staging folders; rename/
  retag settings scan up to 1000 files with an explicit Scan library action.
  Album folder naming templates can include `{Provider Name}` after the release
  year; organize now passes the provider into the naming renderer. Command
  workers re-read Settings from SQLite on every job so curation/naming changes
  (e.g. `include_videos`) apply without a container restart. Video offer upserts
  no longer wipe a known title with a null/empty refresh payload; video organize
  and seed prefer mapped provider titles over raw catalog payloads (fixes YouTube
  `videoDetails.title` â†’ `Unknown Video`). Video `computeExpectedPath` receives
  `provider`/`provider_id` so filenames stop defaulting to `{TIDAL-â€¦}`. Stereoâ†”
  spatial lyric sharing works across distinct recording MBIDs. Slot repair without
  tracklists prefers offers matched to the representative release.
- Video detail/list titles prefer a real ProviderItems title when the recording
  row is still `Unknown Video`. Settings release-type checklists use compact
  Fluent checkbox rows (two columns on wide cards).
- Apple Music progress no longer sticks at 50% for single-file downloads.

### Fixed (Apple Music downloads)
- One Apple catalog album can now fill both stereo and spatial slots: Atmos
  availability no longer hides the album from stereo matching, and its
  lossless/hi-res and Dolby Atmos traits remain attached to the stored offers.
  Track downloads compose `--song` with the selected slot's `--atmos`, `--aac`,
  or hi-res ALAC arguments instead of dropping the quality choice.
- Strict hybrid matching: multi-album provider stitches require catalog ISRC on
  every track (no title/duration-only hybrids; Servarr mode without ISRCs forms
  none), drop the previous 4-album cap, and rank complete covers of the same
  MusicBrainz release by quality with hybrid and direct offers treated equally
  so TIDAL MAX beats Apple HIGH. Hybrid quality badges use the majority album
  quality in the stitch (ties break higher). Hybrid explicit badges aggregate member
  albums (any explicit â†’ E). Apple browser preview remains 30-second
  catalog clips only â€” full-song Apple streams are FairPlay DRM and not available
  as a TIDAL-like third-party progressive preview. Dolby Atmos from Apple and
  TIDAL remain equally scored; equal-coverage ties use provider preference order.
- Album-bundled Apple videos whose downloader filenames contain a track number
  and title instead of an Apple resource id are matched deterministically to
  same-provider album VIDEO rows by position/title. Ambiguous files remain in
  staging rather than being attached to the wrong canonical video.
- The Apple downloader can no longer hang a download slot on errors: it is
  spawned with stdin closed and `exit-on-error` enabled, so failures return to
  Discogenius's bounded, resumable queue retry policy instead of entering the
  upstream interactive retry loop (which spins forever when stdin is at EOF).
  Lyric embedding stays force-disabled because the upstream binary
  crashes (nil TTML) on tracks without lyrics â€” both constraints are pinned by
  tests.
- Apple Music no longer advertises catalog lyrics: the supported catalog API
  does not expose a lyrics resource, and raw TTML is not synthesized as LRC.
- The wrapper supervisor survives failed logins (previously a failed login
  attempt terminated the sidecar) and restarts the decryption server after
  login attempts.
- Provider credential saves never store the wrapper Apple ID or password in
  token.json (regression from an intermediate implementation; existing token
  files are scrubbed on next save).
- Provider preference order: the Settings provider list is now reorderable
  (drag or arrow buttons); the first provider is the default and wins
  equal-quality/equal-coverage matching tie-breaks (`streaming.provider_priority`,
  `PUT /api/v1/provider/priority`). Equal-merit offers no longer fall back to
  alphabetical provider order.
- Apple Music preview playback: track previews (30-second AAC clips) and
  music-video previews now play in the browser through the same signed
  streaming path as TIDAL.
- Apple Music download provisioning: the image now bundles a static MP4Box
  (GPAC 2.4) and Bento4 mp4decrypt, and the managed downloader config follows
  the app's video-resolution setting. Download routing honors each slot's
  selected provider instead of always dispatching to the default downloader.
- 4K (2160p) music-video quality option. Every resolution remains selectable
  and falls back to the provider's best available rendition; TIDAL requests
  clamp to 1080p while Apple Music passes the chosen ceiling per job and
  recognizes catalog videos marked as 4K-capable.
- Right-click or touch long-press on a library card enters selection mode with
  that card selected.

### Added (video pages)
- The video page lists every provider offer for the video as selectable chips
  (provider mark, quality, tooltip with a link to the provider's public video
  page); the selection drives both preview playback and download.
- Videos that appear on an album (e.g. Apple Music bundled music videos) show a
  queue-style "Appears on" row (cover + title, plus disc/track position when the
  video sits on a release tracklist). Clicking opens the album and scrolls to
  that track when a MusicBrainz track id is known.

### Changed
- Library track rows now use one shared Fluent grid with fixed Provider,
  Available, and Local quality columns, so headers and rows stay aligned and a
  downloaded file's measured quality is no longer confused with the selected
  remote offer. Provider and neutral MAX/HIGH/NORMAL/LOW filters now apply to
  tracks as well as albums; provider filters also apply to grouped videos.
- Provider-native quality strings collapse to one semantic badge per neutral
  tier (with video resolutions kept as resolutions), preventing equivalent
  MAX/lossless/lossy labels from producing badge stacks. Album release offers
  expose clean/explicit state and use a Fluent selected surface/checkmark
  instead of an ambiguous outline.
- Canonical artwork is the default across UI caches, saved cover sidecars, and
  embedded audio artwork. Settings can opt into provider-first artwork; both
  modes retain the other source as fallback, with Cover Art Archive in the
  canonical album path and Servarr/Fanart-derived artist imagery where present.
- Provider-specific download backends remain the architecture of record rather
  than adding OrpheusDL beneath Discogenius's existing plugin/queue layer.
  `spotDL` is not used as a Spotify downloader because its audio comes from
  YouTube; the per-provider feasibility and revisit criteria are documented.
- Provider connection cards moved to a single priority-ordered list with a
  Fluent details modal (status, capability summary, connect/disconnect) instead
  of inline disclosure rows.
- Provider capability copy is consistent across services (lossless ceiling,
  Dolby Atmos, video resolution) â€” Apple Music now declares the same explicit
  quality strings as TIDAL.
- Dashboard queue/activity loading skeletons mirror the real Active/History
  dual-column layout and follow the shared delayed-loading policy, as do the
  unmapped-files table and import modal.
- Import modal per-artist status icons use the Fluent colored icon family.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Apple Music video downloads now pass `--mv-max` per job from the app's video
  quality setting (including 4K/2160p), matching the managed downloader config.
- Dual-capability Apple/Amazon albums (stereo + Atmos on one album id) now
  advertise a spatial offer in the release switcher from stored quality tags,
  and album refresh preserves those tags instead of wiping them.
- Fresh installs default Spatial audio and Music Videos off, with Ultra HD as
  the default video quality target; Settings exposes
  preferred artwork source (canonical vs streaming service) and embed-video-
  thumbnail. Queue status icons are smaller; Activity icons are consistently
  larger; library video list columns share one grid alignment.
- Import lyric materialization and LRC/TXT sidecars are wired through download
  import; provider-registry tests follow the DB-backed streaming config.
- Queue drag/arrow reordering now changes the downloader's effective execution
  order even across priority/trigger boundaries. Deleting an active download
  aborts only that provider job without pausing the queue; deleting an active
  import waits for cooperative safe-boundary cancellation, cleans staging, and
  preserves files already organized into a library.
- Grouped video rows retain every `(provider, provider id, quality)` offer.
  Filtering to Apple/TIDAL/YouTube chooses that provider for the row action,
  grouped provider/quality badges stay paired, and canonical `recording_id`
  files reliably mark the grouped video downloaded without cross-provider id
  collisions.
- Music-video thumbnails are downloaded through the owning provider, embedded
  after tagging, and reflected in `TrackFiles`. MP4 metadata rewrites preserve
  attached pictures and custom MusicBrainz/provider atoms; M4A cover replacement
  likewise preserves custom tags through a dedicated Mutagen runtime.
- Download imports now resolve lyrics immediately, persist synchronized lyrics
  as `.lrc` and unsynchronized lyrics as Lidarr-compatible `.txt` sidecars,
  track both in `LyricFiles`, and pass the same resolved value into
  the audio tag writer. TIDAL's tiddl and Spotify's Votify are allowed to emit
  their native synced sidecars, while Apple/Spotify/Deezer tracks can reuse a
  cached or remotely fetched lyric from another provider when both offers map
  to the same MusicBrainz recording. Failed lookups are cached for the import
  retag pass instead of being repeated during preview and write.
- YouTube Music lyrics are converted from ytmusicapi timestamp objects into
  provider-neutral plain text and LRC. Public live validation succeeded against
  Bastille's â€œGive Me the Futureâ€.
- YouTube downloads ship with the required EJS challenge-solver dependency and
  an explicitly enabled Node 22 runtime. The old Node 20/bare-pip image made
  yt-dlp warn that no supported JavaScript runtime was available and could omit
  formats. The bundled TIDAL downloader is also updated to `tiddl==3.4.4`.
- Provider resource lookups in the download processor are keyed by the full
  `(provider, entity type, provider id)` identity, including album-track and
  selected-slot fallbacks. Equal numeric ids from TIDAL and Apple Music can no
  longer resolve to each other's catalog or download rows.
- Provider resource IDs and persisted import paths are confined to the
  configured download root before any backend creates, renames, imports, or
  cleans files. Amazon output IDs receive the same containment checks.
- Provider credential handling is hardened: Deezer disconnect removes the
  Streamrip ARL copy, YouTube drops cross-domain cookies from browser exports,
  Spotify/Amazon auth probes have bounded deadlines, and Amazon custom API
  bases reject redirects, embedded credentials, private DNS targets, and
  cleartext public endpoints unless private self-hosting is explicitly enabled.
- Live Deezer album payloads that omit `track_position` now preserve their
  authoritative array order, avoiding a whole release being matched as track
  number zero.
- Global search finds artists that are not in the library again (remote
  canonical discovery was only enabled while the library was empty).
- Apple Music hi-res albums are no longer reported as 16-bit: the provider now
  takes the best `audioTraits` entry instead of the first (Apple lists traits
  lowest-fidelity first).
- The same music video from two providers now dedupes onto one canonical
  recording with provider links from both; genuinely different uploads
  (audio-only, lyric video, live) stay separate via variant classes and a
  duration guard. A parenthetical qualifier one provider omits (TIDAL
  "SAVE MY SOUL" vs Apple `SAVE MY SOUL ("FROM ALL SIDES" Tour)`, identical
  durations) no longer defeats the match, and every video refresh retro-merges
  duplicate recordings that predate the current rules, repointing offers and
  files to the surviving recording.
- Video offer actions now respect provider capabilities: unavailable offers
  are hidden, download-only YouTube offers do not break Play when a TIDAL or
  Apple preview exists, and the player/offer controls are keyboard-accessible
  Fluent UI controls. Unknown-quality offers remain selectable.
- Video downloads no longer fail with "Resource not found": deduped videos are
  referenced by canonical recording id, which the queue, the download
  processor (including retries of previously-failed payloads), and the preview
  signing route now resolve to the preference-ranked provider's actual video
  offer instead of sending the internal id to a provider API. Apple-only
  videos preview and download standalone as a result â€” both paths previously
  hardcoded TIDAL.
- Video metadata seeding queries the provider that owns the resolved offer
  rather than always the default provider.
- Download Missing queues one job per canonical video recording (rather than
  one per normalized base title), scopes installed-file checks to the owning
  provider, and resolves the exact selected offer before falling back to
  provider preference. Official, lyric, audio-only, visualizer, and live
  variants therefore remain independently downloadable without duplicate jobs
  for equivalent cross-provider offers.
- API tests are hermetic again: the runner isolates `DISCOGENIUS_CONFIG_DIR`
  so live provider tokens in `./config` cannot change test results.
- Artist top-track previews play again: the playback signing route no longer
  rejects tracks that carry a direct provider track id when no canonical match
  edge exists for that provider.
- The playing track row no longer shows doubled stop icons (a bundled filled +
  regular icon pair was force-displayed by a style override) and the track
  number no longer shines through the stop overlay.

## [2.3.4] - 2026-07-15

### Added
- Library artist import now starts with a connected-provider picker, previews
  the provider artists before enqueueing, supports select-all and shift-range
  selection, and reports per-artist progress with grouped success, skipped,
  unmatched, and failed results.
- Library cards now support Lidarr-style selection mode in grid and list views.

### Changed
- Fluent action icons now provide regular and filled variants throughout the
  frontend so Fluent UI can apply its native hover/pressed icon treatment.
- Library collections, selection surfaces, and queue rows share tokenized
  content insets and symmetric row padding.
- Library artist actions now use explicit `Curate` and `Download missing` copy.

### Changed (UX polish)
- Page-level loading skeletons (Library tabs, artist and album pages) now
  follow a shared delayed-loading policy: sub-second cached loads render
  without a skeleton flash, while slow loads still show the skeleton after a
  short grace window.
- Unmapped-file deletion now confirms through a Fluent dialog with destructive
  styling instead of a browser `window.confirm` prompt.
- Failed activity entries use the Fluent colored failure icon, matching the
  queue's colored success/failure icon family.
- Dashboard compact empty states center the icon and heading as a unit on
  mobile.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Library selection mode now toggles card selection when clicking anywhere on
  a card, Lidarr-style, instead of navigating to the detail page.
- Import-artists source rows no longer render a doubled chevron icon.
- The library listing no longer shows unhydrated credit-seeded artist shells
  whose display name is still a raw MusicBrainz ID; they reappear once
  monitored or hydrated with real metadata.
- TIDAL playlist and mix artwork is normalized into renderable image URLs, and
  personalized My Mix entries are loaded from TIDAL's collection page alongside
  home/editorial lists.
- Provider imports no longer terminate their progress stream when one artist
  fails; failures remain item-level while the rest of the selection continues.
- Completed queue rows no longer reserve trailing action spacing when no action
  is present.

## [2.3.3] - 2026-07-15

### Changed
- Artist pages now show five top tracks initially while retaining the expandable
  indexed top-100 list.
- Rename and retag previews now share Lidarr-style default selection, tri-state
  select-all, shift-range selection, selected counts, and consistent change rows.
- Queue, unmapped-file, library, rename, and retag selection now use the shared
  Lidarr-style selection model, including select-all-visible and shift ranges.
- Card, table, artist, and album loading skeletons now mirror their rendered
  layouts more closely and follow Fluent UI loading/accessibility guidance.
- Artist and album UI artwork caches now retain only 500px and 250px derivatives;
  full-resolution originals are reserved for managed library directories. Video
  artwork retains its 720p source alongside UI derivatives.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Fresh spatial-audio and music-video imports now embed canonical MusicBrainz,
  provider, and quality metadata before import completion.
- Known spatial downloads no longer enter unnecessary fingerprinting, and
  import-time tag application no longer performs optional lyric lookups.
- Tag writing now handles database file extensions consistently and no longer
  writes synthetic zero ReplayGain values when the provider supplied no value.
- Video retag work now reports per-file progress and cooperatively honors
  cancellation between files.
- Download imports now refresh full provider track metadata before tagging so
  ReplayGain, peak, and copyright omitted by bulk catalog responses are retained.
- Provider track persistence now normalizes camel/snake-case supplement fields,
  retains track copyright, and skips redundant import-time provider calls when
  ReplayGain, peak, and copyright are already materialized.
- Monitored-only remains the default library/artist preference, but falls back to
  showing all content on tabs and artist pages that have no monitored items.
- Shared media cards are keyboard-focusable and activate with native link/button
  key semantics.
- Fixed empty-library catalog search, the empty-state artist-import button, and
  replaced search-flyout skeletons with a single progress indicator.

## [2.3.2] - 2026-07-15

### Added
- Added maintained `ArtistTopTracks`, `AlbumLibraryIndex`, and
  `TrackLibraryIndex` projections so top tracks and library album/track pages
  page, filter, and sort compact indexed data instead of walking the full
  MusicBrainz track catalog at request time.
- Added partial video-library sort/filter indexes and regression coverage for
  canonical video rows, provider offers, downloaded files, and legacy-row
  exclusion.

### Changed
- Artist top tracks now rank provider-priority popularity after matching, keep
  a durable top-100 set, and render 25 initially with an expandable full list.
- Global search is local and indexed by default; remote catalog discovery is
  explicit and remains available through lookup flows or `remote=true`.
- Optional missing lyric downloads moved out of the synchronous media-import
  loop into the durable library-metadata backfill. Provider-delivered sidecars
  are still imported immediately.
- Retired redundant multi-million-row track indexes whose keys were already
  covered by unique or composite indexes.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Fixed album, track, video, artist top-track, search, release-availability,
  and queue reads that became multi-second or minute-long synchronous SQLite
  scans on established libraries.
- Fixed artist and album detail pages repeatedly refetching their complete
  payload for unrelated queue activity while downloads were active.
- Fixed artist and album preview controls using different provider identity
  fallbacks. Downloaded files are now selected first on both surfaces, with a
  browser-compatible provider preview used only when needed.
- Fixed active queue cards using a separate artwork path; active, queued, and
  history rows now resolve the same canonical cover renderer used by library
  pages.
- Fixed TIDAL artwork supplementation to retain origin/highest-resolution
  assets, and discard generated proxies when they are not smaller than their
  source.
- Fixed provider-popularity supplementation, monitoring-cycle authority,
  video import artist identity, canonical file linkage, expected paths, and
  post-import tag application found during live download/import validation.

## [2.3.1] - 2026-07-14

### Added
- Added maintained full-text indexes for track, artist, album, and video search
  so global search no longer walks the multi-million-row catalog tables.
- Added startup repair for legacy music-video files and sidecars that were
  attached to provider-only artists instead of their canonical MusicBrainz
  artist.

### Changed
- Artist pages now render their identity and actions immediately while albums,
  tracks, and videos load independently, persist one shared filter preference
  across artists, default to monitored content, and move actions into overflow
  before the filter/view controls clip.
- Fresh installations now use the validated monitoring, quality, naming,
  fingerprinting, and library-folder defaults while keeping spatial audio and
  music videos disabled and Servarr Metadata Server as the catalog source.
- Artwork derivatives are retained only when they are smaller than the source;
  oversized stale proxies transparently fall back to the original asset.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Fixed scheduled monitoring cycles dropping their cycle authority between
  provider matching and curation, which prevented `DownloadMissing` from ever
  being queued after monitored-artist refreshes.
- Fixed album, track, video, artist-page, and download-filter queries that
  synchronously scanned large catalog tables and stalled the entire API.
- Fixed downloaded/not-downloaded filtering on artist albums, tracks, and
  videos, plus the empty-state flash during staged artist-page loading.
- Fixed TIDAL video imports creating duplicate plain-name artist directories;
  imports now resolve through the provider offer's canonical recording and
  MusicBrainz artist, including thumbnails and NFO sidecars.
- Fixed video-sidecar rename previews preferring a recording MBID over the
  provider video id, which could give the thumbnail a different stem from its
  video.
- Fixed ID-only rename commands launching library-wide statistics, sidecar,
  and empty-folder passes after moving a single file.
- Fixed provider artwork enrichment joins and preserved TIDAL origin/max-size
  assets as the source for album, artist, and video artwork fallbacks.
- Fixed imported audio identity/enrichment paths so real downloads retain their
  canonical integer links, expected path, embedded MusicBrainz metadata,
  ReplayGain, lyrics, covers, and NFOs without an immediate rename or retag.

## [2.3.0] - 2026-07-09

### Changed
- Fix clipped action buttons on artist and album detail pages
- Unify artwork pipeline and fix video handling
- Fix provider matching and speed up MusicBrainz-mode refresh
- Fix Docker build reproducibility and provider-item schema compile errors
- Refactor provider item handling and database schema
- Fix UI glitches, active download cover art, and unmapped files metadata detection
- Fix UI glitches, queue artwork, and video handling

## [2.2.1] - 2026-07-05

### Changed
- Simplified queue live-refresh ownership: SSE progress is now the primary live
  signal, with slower query refetches left as a structural fallback instead of a
  competing one-second full refresh.
- Tightened queue, activity, artist, and album UI behavior for the
  persistent-deployment path: mobile empty states are more compact, detail-page
  action rows overflow before labels clip, queue child rows no longer repeat the
  parent download/import label, and badge colors use the provider/type/quality
  accent palette with theme-aware glass tints.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Fixed queue progress events that carried `commandId` but not `jobId`, which
  caused dashboard progress to appear stale until a manual reload.
- Fixed retry/delete guards for failed queue rows so stale failed downloads can
  be cleared or retried unless that exact command is still actively processing.
- Fixed scheduled monitoring cycles with no due artists so they stop cleanly
  instead of chaining repeated no-op refresh, rescan, and Download Missing
  commands.
- Fixed canonical video curation when provider availability is required; videos
  without a provider offer are now unmonitored instead of remaining queued.
- Fixed immediate post-import retag prompts by resolving freshly imported files
  through provider/canonical identities and falling back to matched provider
  ReplayGain/peak metadata when canonical recording supplements are not yet
  populated.
- Fixed active queue cover art fallback for grouped items and kept track version
  disambiguation in seeded album queue rows.

## [2.2.0] - 2026-07-05

### Added
- Added local MusicBrainz-docker catalog mode. Discogenius can now read the
  MusicBrainz Postgres schema directly, use the co-located `/ws/2` search when
  available, and route search, refresh, matching, artist lookup, manual match,
  and credited-release discovery through the selected catalog provider.
- Added the first streaming-provider plugin contract slice. Providers now expose
  manifests for auth mode, integration/download source, resource-id kinds,
  import capabilities, quality mapping, diagnostics, and setup notes; TIDAL and
  Apple Music publish the same core contract.
- Added Apple Music's offline integration slice: provider API mapping, library
  artist and playlist import-source contracts, credential-save UI/API paths,
  storefront validation, downloader invocation shaping, progress parsing, and
  diagnostics. Live Apple download validation remains a 2.2.1 follow-up.
- Added documentation for provider/plugin dependencies and Apple downloader
  selection. Small direct-spawn provider tools are pinned and diagnosed; larger
  stateful infrastructure such as MusicBrainz-docker remains user-managed.

### Changed
- MusicBrainz local settings now accept a host-oriented value and derive the
  Postgres DSN plus optional search endpoint. Legacy `musicbrainz_url` and
  `MB_LOCAL_WS_URL` compatibility paths were removed while configuration is
  still pre-release and actively changing.
- TIDAL/tiddl progress now carries provider track identity from native
  downloader item context, so queue snapshots and SSE can prefer provider-id
  track matching instead of title matching.
- Authentication, provider status, and diagnostics UI were generalized beyond
  TIDAL and aligned with the glassy Fluent styling used elsewhere in the app.
- Badge styling, shared track lists, top tracks, album track rows, queue cards,
  and history rows were tightened for consistent provider/type/quality display
  and stable download/import state rendering.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Fixed TIDAL download/import validation issues found in the live release pass:
  new imports now persist measured file duration, artist statistics refresh
  after targeted imports, completed download-state track rows finish as
  completed, and retag status no longer immediately asks to rewrite freshly
  imported TIDAL tracks.
- Fixed queue artwork and video thumbnail regressions, search-result artwork in
  local MusicBrainz mode, album/top-track quality duplication, and several
  badge-order/opacity inconsistencies reported during browser QA.
- Fixed container/library-root permission handling for fresh Docker runs.

## [2.1.1] - 2026-07-03

### Added
- Added a provider-track evidence contract for future streaming plugins.
  Provider album-track API results are now materialized as
  `ProviderItems(entity_type='track')` rows keyed by provider track id and
  linked to MusicBrainz tracks by selected-release medium/position. Album
  provider rows no longer carry duplicated `data.tracks` blobs.
- Added a tiddl progress wrapper that exposes per-track byte progress and
  album item-count progress to Discogenius while preserving tiddl as the
  downloader. Queue cards can now show active track progress, completed
  download state, and import state without relying on tiddl's terminal-only
  Rich progress display.

### Changed
- Download and import now run as one durable lifecycle row. Album, track, and
  video download commands remain active through the import phase and then move
  to history as a single completed or failed item.
- Album imports now match staged files by provider track id only. tiddl stages
  audio as `{album.id}/{item.id}` and videos as `{item.id}`, then the organizer
  resolves the staged provider id through `ProviderItems` to the canonical
  MusicBrainz track or recording. Title, ISRC, position, and album JSON overlay
  fallbacks were removed from the download import path.
- `DownloadMissing` is now a bounded coordinator instead of a backlog
  materializer. It recomputes monitored missing media from canonical state and
  keeps a small buffer of concrete download jobs instead of queuing tens of
  thousands of commands at once.
- Queue, history, status, and stats reads were reworked for large backlogs:
  started-job progress snapshots avoid full backlog scans, queue pagination
  sorts ids before loading payloads, queue positions use window functions, and
  hot dashboard reads use short event-invalidated caches.
- Queue cards were aligned across active and history rows. Desktop keeps title
  and artist on the left with badges and progress/status indicators on the
  right; mobile keeps the stacked layout. Track rows use a spinner for active
  download/import, the Discogenius orange checkmark for downloaded, and the
  Fluent color checkmark once download and import are both complete.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Fixed dashboard and Library request fan-out loops caused by unstable query
  invalidation identities and invalidate/refetch double-firing.
- Fixed progress-stream startup under heavy queues; SSE snapshots now map only
  active work and progress ticks carry the current track list so import rows
  can show the active spinner immediately after the download-to-import handoff.
- Fixed stale Active queue cards when browser-side live ticks are missed. The
  dashboard now refreshes the active first page once per second with a bounded
  timeout and replaces stale first-page rows instead of merging completed rows
  back into Active.
- Fixed stale or partial provider-track rows causing provider-id staged files
  to miss during import. The organizer now refreshes provider track evidence
  once when a numeric staged provider id is not present, then retries the exact
  provider-id match before failing.
- Fixed empty or missing download workspaces producing opaque import errors.
  Imports now recover already-imported files when possible, otherwise they
  emit a retryable re-download failure.
- Fixed Docker/local runtime health for the validated container by ensuring the
  configured library roots are writable by the application user.
- Fixed boot/loading and error surfaces: route fallbacks use Fluent spinners,
  the boot page uses the larger logo with the blur-glow pulse, and error pages
  use the Fluent color error icon.

## [2.1.0] - 2026-07-02

### Added
- Added a general provider artist import flow. TIDAL followed artists, playlist
  sources, and explicit provider artist selections can now queue durable
  background imports with streamed progress and clear monitored / already in
  library / unmatched / failed counts.
- Added System Status diagnostics for runtime health, paths, native tools,
  download backend readiness, provider capabilities, request pacing, and
  provider artists that were skipped because they could not be matched safely.
- Added release and artist rename/retag command surfaces backed by the command
  queue, plus canonical metadata sidecar, artwork, lyric, and tag regeneration
  paths.

### Changed
- Refresh, provider matching, curation, rescans, and missing-download work now
  follow the Lidarr-style command model more closely: typed executors, bounded
  worker concurrency, durable queue ordering, exclusive housekeeping, and
  process-level failure guards prevent worker failures from taking down the API.
- Large-library refresh throughput was reworked around short SQLite writes and
  indexed lookups. Unchanged catalog rows are skipped by content hash, raw
  catalog JSON blobs were removed from the fresh schema, and the video matcher
  now resolves audio candidates once per artist outside the write transaction.
- Provider-to-MusicBrainz matching now uses canonical provider URL evidence
  before falling back to names. TIDAL, Apple Music, Spotify, SoundCloud, and
  YouTube-style resource URLs normalize through one provider-neutral identity
  parser; aliases are used with ambiguity protection for artist import.
- Cover art and video thumbnail resolution now go through the shared
  canonical-first media-cover pipeline, with provider artwork used as a fallback
  through provider interfaces rather than service-specific core logic.
- Library, album, and artist track lists now share one polished table/list
  component with consistent quality badge ordering, hover playback controls,
  column sizing, mobile behavior, and downloaded-state display.
- Settings were simplified around outcome-focused controls: metadata embedding
  is always complete when tag writing is enabled, artwork filenames/resolution
  controls were removed, and the page copy was trimmed to plain user-facing
  language.
- Naming and audio-tag writing were reviewed against Lidarr. The naming parser
  now handles reserved Windows device names and additional genre/disambiguation
  tokens; tag writing now covers manual-import policy correctly and accepts more
  imported audio formats.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Fixed crash loops and stale active tasks under heavy provider import load by
  catching worker-pool rejections at the command executor and global process
  layers.
- Fixed SQLite write-lock livelock from video matching by replacing a
  multi-minute per-video candidate query inside a transaction with an indexed
  per-artist lookup measured at sub-second runtime on the user's large library.
- Fixed command worker starvation where one concurrency-capped command type
  filled the candidate window and prevented other queued work from starting.
- Fixed `no such column` regressions from removed file/provider shadow columns
  in history, queue, import, retag, sidecar, and library-file paths.
- Fixed top-tracks placement and limits on artist pages. Top tracks now render
  after all release sections and before videos, and can expand up to 100 tracks.
- Fixed video curation, video thumbnail persistence, video-card spacing, video
  page artist links/images, and playback routing for downloaded videos.
- Fixed global library track cover loading, popularity sorting, and table
  spacing regressions on the Library page.
- Fixed the API test runner so the full API suite is executed reliably instead
  of silently matching only a subset of files through a shell glob.

### Removed
- Removed backwards-compatibility migration/backfill code and legacy schema
  shadows that only existed for old runtime data. Fresh schema version 34 is the
  clean baseline for this release.
- Removed the old followed-only import UI and duplicate/special-case library
  track-list implementation.

## [2.0.10] - 2026-06-24

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- **The container no longer freezes and goes `unhealthy` under heavy refresh load.** `better-sqlite3` is synchronous, so any wait on the single SQLite write lock blocks the entire Node event loop. The main (HTTP/SSE) thread used a 15s `busy_timeout` plus a synchronous retry backoff, so one contended write (chiefly the `markProcessing` job-claim) froze every request, SSE stream, and `/health` probe for ~30s while worker threads held the lock during a large refresh â€” exactly the "scanned 1000 artists then became unreachable" symptom, and the source of the `database is locked` errors on big-discography artists. The main thread now fails fast (`busy_timeout = 1000ms`, a single quick retry) and is retried at the next scheduler tick instead of freezing, mirroring Lidarr's 100ms request-path `busy_timeout`. Worker threads keep the generous 30s timeout + 8 retries because they run off the event loop. Measured under live refresh load: `/health` ~85ms (was timing out at 30s), event-loop lag p99 ~20ms / max bounded ~2s (was 25â€“30s), zero `database is locked`.

### Changed
- **Large catalog write transactions are chunked (`runChunkedWrite`).** A big artist's refresh previously upserted its entire catalog (hundreds of release groups, thousands of tracks) in one transaction, holding the write lock long enough to starve concurrent workers and time out the main-thread claim. The MusicBrainz catalog hydration (`servarr-metadata-proxy` artist/release-group sync) and provider-album offer writes now commit in bounded chunks so the lock is released between batches.
- **`AlbumReleaseMedia` folded into `AlbumReleases.data`.** Release medium/disc summaries now derive from the MusicBrainz release JSON instead of a separate table.
- **`TrackFiles` no longer carries provider-shadow `album_id`/`media_id` columns.** File/sidecar joins resolve through canonical MusicBrainz identity and provider `ProviderItems` provenance; the legacy columns are removed from the fresh schema, with provider identity aliased only at API compatibility boundaries. Import, manual import, rename/tag, search, disk-scan, download-state, stats, and sidecar replication paths were converted.
- **v1 API resource routes normalized to Lidarr's singular-controller convention.** System tasks moved to `/api/v1/system/task`, managed playable files to `/api/v1/mediaFile`, streaming provider status to `/api/v1/provider`.
- **Artist page reads are now read-only projections.** `getArtistPageDb` no longer runs a provider-selection write pass or per-card Servarr metadata hydration on the request thread â€” first-load artwork hydration is left to refresh workers â€” fixing multi-second artist-page loads under refresh load.
- **Popularity sort works for artists and albums.** TIDAL album popularity is carried through provider mapping/refresh into `Albums.popularity` (with provider-snapshot fallback), exposed in the album/artist list contracts, and album sort uses a real popularity expression instead of falling back to release date.

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
- **`library-files.ts` is now fully canonical (no `ProviderMedia`/`ProviderAlbums` reads):** video naming/path resolution, inline-vs-separated video layout (incl. the inline videoâ†’audio match), the video library-root routing, and the previously-converted audio path computation all resolve from the canonical graph + `ProviderItems` (videos via `getCanonicalVideoMetadataForRow`, which uses `ProviderItems.recording_id` for mbid-less provider videos). Removed dead helpers (`getAudioRoot`, lookup-row types). The inline-video layout test was migrated to seed canonical video `Recordings`/`ProviderItems`.
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
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- **Monitoring-cycle downloads now wait for artist intake/curation work before the terminal missing-download pass.** The scheduled/manual cycle's terminal `DownloadMissing` was gated only on monitoring-cycle-tagged jobs and ignored in-flight per-artist intake work (`RefreshArtist`/`RescanFolders`/`CurateArtist`). On a fresh setup it could fire the moment the metadata refresh finished â€” before artist intake had curated any release-group slots â€” so it queued 0 downloads, then nothing retried until the next 24h boundary. The pre-download gate now also waits for all artist-workflow and library-rescan jobs to drain. Standalone artist add, scan, curation, and collaborator scanning still do not auto-download; downloads remain part of the explicit manual/scheduled monitoring cycle or download command.
- **Forced upgrade checks now actually force redownload evaluation.** Manual `CheckUpgrades`/queue-triggered forced runs now pass an enabled redownload profile into `UpgradableSpecification`; previously they skipped the top-level setting guard but still evaluated with `allowRedownloads=false` when `upgrade_existing_files` was disabled.

## [2.0.7] - 2026-06-18

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Artist artwork and basic info now hydrate immediately for hot-loaded or search-added MusicBrainz artists, instead of rendering a blank "needs scan" card.
- Album, track, and video search results now return resolvable artwork URLs (tracks resolve their album's art, videos resolve a canonical or provider thumbnail) instead of raw provider asset ids that never rendered.
- Album cards fall back to selected-provider artwork when MusicBrainz/Cover Art Archive has none, through a single shared resolver (no duplicate art-fetch paths, no temporary cross-matching).
- First-order collaborating artists now get a full canonical + provider-slot scan while staying unmonitored and uncurated (no snowball into their own collaborators).
- Artist page filter state persists per artist when navigating to an album and back.
- Detail-page loading skeletons align with the real layout (top spacing/header height).

### Changed
- Search stays local + MusicBrainz/Servarr Metadata Server only for artists/albums/tracks/videos â€” no provider live-search.
- Tracklist: clickable artist names (linking via the known MusicBrainz id), a Duration column and a Quality column, the volume separator hidden on single-volume releases, and refined play/stop controls.
- Background UltraBlur is generated small and blurred client-side (Plex-style), cutting the payload ~35x, and new pages now cross-fade in once decoded instead of snapping.
- Runtime Docker image slimmed via a yarn cache mount and node_modules pruning.

## [2.0.6] - 2026-06-17

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Download queue and tracklist quality pills now match the height of the media-type pill (the `QualityBadge` no longer forces its own height, so a small quality badge lines up exactly with a small `MediaTypeBadge`).
- Album page now shows a single quality pill when one provider release fills both the stereo and spatial library slots (the Atmos-fallback case), with a hover explaining it covers both libraries, instead of two identical Dolby Atmos pills.
- Album page split Download button no longer clips its hover shadow/lift; the whole control now lifts and shadows as one unit like the other action buttons.
- Atmos-only releases that fall back into the stereo slot now organize into `stereo-music` (not `spatial-music`), and `--dolby-atmos allow` is applied for stereo downloads so the fallback actually downloads.
- Eliminated the concurrent stereo+spatial download race that caused `ENOENT â€¦ rename` import failures: each download job now uses its own `job_<id>` workspace, so jobs can't wipe each other's files.
- Resolved "ghost" queue items that lingered as active after a job completed until a manual page reload.
- Removed the constant GPU load from the background: the full-viewport `backdrop-filter` (re-sampled on every repaint) was replaced with a static `filter` baked onto the cached gradient image.
- Reduced the visible grain/texture on the background by dialing the gradient dither way down.

### Changed
- tiddl is now steered with a clean split: `config.toml` holds only global settings (video quality, threads, metadata embedding, templates, â€¦) while per-job values (download/scan path, track-quality cap, Dolby Atmos mode, video filter) are passed as CLI args. This removes the previous config/args duplication.
- Removed a stale Playwright smoke test for the `/search` route that was dropped in 2.0.4 (search now lives in the nav bar), fixing CI.

## [2.0.5] - 2026-06-17

### Added
- Added List view mode for the global library and artist discography pages, using DataGrids for dense layout.
- Added "Fetch-on-click" functionality for collaborating artists; clicking an unknown collaborating artist now automatically fetches their basic info from MusicBrainz and queues a full discography scan instead of landing on a 404 page.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Fixed an inconsistency in the download queue UI where the media type pill was smaller than the quality pill. Both are now consistently sized as small pills.

## [2.0.4] - 2026-06-17

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
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
- feat(ui): rework tracklist â€” hover-play, artist always, compact right cluster
- fix(ui): tighten mobile artist nameâ†”bio spacing
- feat(ui): theme-aware quality/provider pills + revert header order
- feat(ui): album header row swap, declutter cards, auth page polish
- fix(import): ffprobe duration fallback for unmapped Atmos/MP4 files
- fix(ui): auth page scrolls; welcome header stays one line
- fix(api): resolve blank artist-credit ids so tracklist artists link
- fix(ui): mobile badge layout â€” own lines, card stacking, smaller card pills
- fix(ui): white-on-black provider chip, consistent badge size & order
- fix(ui): theme-aware provider marks everywhere (settings + auth too)
- fix(ui): 24px badges, center the header badge block
- feat(ui): unified provider pill + quality badges, horizontal Atmos logo
- fix(ui): tighten provider pill size, space tracklist quality badges
- fix(ui): theme-aware provider pill, concentric radii

## [2.0.2] - 2026-06-13

### Changed
- **Unified track matching**: curation, the album page, and playback now score MusicBrainzâ†”provider track matches through one shared matcher (recording-MBID / ISRC exact â†’ position+title+duration structural â†’ title-dominant fallback), so the three paths can no longer disagree. Fixes albums showing "no tracks matched / available" while the same release downloaded fine elsewhere (e.g. Bad Blood now reads 33/33).
- **Verified status for full-coverage editions**: a release group whose provider release fully covers an "â€¦ EP" / "â€¦ X" style title-expansion now reads **verified** instead of being capped at "probable" (e.g. Goosebumps EP).
- **Combined provider + quality pill**: the album header shows one chip per filled slot â€” a provider mark fused with its quality badge (e.g. TIDAL Â· 24-BIT, TIDAL Â· Atmos). With multiple providers this makes it obvious where each version came from; match confidence, combined-release count, and the selected MusicBrainz edition moved into the hover tooltip. A small corner dot flags only probable/ambiguous matches.
- **Spatial-only albums** now read **"Dolby Atmos only"** in the header when the provider has no stereo release, presenting correctly instead of as a missing stereo match. (No empty stereo download was ever queued â€” Atmos candidates already route to the spatial slot.)
- **TIDAL plugin files consolidated** under `config/providers/tidal/` (`.tiddl/` beside the token), with a one-time migration of a pre-2.0.2 `config/.tiddl`. Our app owns token refresh and writes the derived tiddl `auth.json`, so the app and `tiddl` no longer contend over the token. `TIDDL_PATH` now points at `config/providers/tidal/.tiddl`.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- **Badge squishing**: quality badges held their intrinsic width (`flex-shrink: 0`, no-wrap), so labels no longer spill outside the rounded body when a row gets tight â€” album header, media cards, and the dashboard alike.
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
- The Docker image is ~40% smaller (2.31GB â†’ ~1.4GB): runtime installs only the API workspace dependencies, and git plus repo-setup tools are no longer shipped.
- Naming examples render with consistent separators and real Bastille/MusicBrainz sample data, and the token help now documents recording/media/provider-video ids and album tokens for video templates.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
- Importing one slot of a release group no longer deletes the other slot's file: stereo FLAC and Atmos M4A of the same release now coexist instead of ping-pong replacing each other.
- Music video imports failed on a phantom `ProviderMedia.monitor` column; video downloads now import with thumbnail and NFO.
- Videoâ†”track matching never linked anything because it filtered audio recordings by an always-empty `artist_mbid` column; candidates now resolve through release groups (Men I Trust: 0/13 â†’ 13/13 videos linked), giving inline video placement real anchors.
- Merging library roots no longer strands artist/album sidecars in unresolvable rename conflicts â€” same-scope duplicates are merged automatically.
- Album pages derive the accent color from cover art like artist/video pages, so seekbars and brand UI no longer stay default orange.
- Artist images load in dev (`/MediaCoverProxy` proxy), artist-page album cards prefer canonical Cover Art Archive artwork over provider art, and `docker-compose.yml` no longer points `TIDDL_BIN` at the removed tidal-dl-ng.
- Restored authentication on the video preview sign endpoint and fixed TIDAL video playback URLs (countryCode + HTML-entity unescaping in DASH manifests).

## [2.0.0] - 2026-06-11

### Added
- Provider-match visibility in the UI: album pages show a per-slot TIDAL match badge (matched / probable / ambiguous / not available) with the provider release and selected MusicBrainz edition in the tooltip, and the "Other releases" list labels the selected edition.
- tiddl integration test coverage (auth file shape, quality mapping, environment pinning) and regression tests for edition-aware release matching.

### Changed
- **Single download backend:** all TIDAL downloads (stereo, Dolby Atmos, music videos) now run through tiddl. OrpheusDL and tidal-dl-ng have been removed, together with their runtime setup, token sync paths, and health checks. The Docker image installs tiddl and pins `TIDDL_PATH=/config/.tiddl`.
- **One login:** the in-app TIDAL device login is synced straight into tiddl (`auth.json` in the exact shape tiddl expects, plus matching OAuth client credentials via `TIDDL_AUTH`), so downloads work immediately after connecting your account â€” no separate downloader authentication.
- **Edition-aware matching:** provider albums are validated against the tracklist of every release in a MusicBrainz release group (representative edition first, then by tracklist size). The slot records the edition that the chosen provider album actually covers, so a standard edition on TIDAL no longer shows as "unavailable" just because MusicBrainz's largest release is a deluxe, and the stored release MBID always describes the content that gets downloaded.
- Documentation and agent guidance consolidated: one `AGENTS.md` at the repository root, refreshed `ARCHITECTURE.md`/`CURATION_DEDUPLICATION.md`/`ROADMAP.md`, and removal of ~30 stale agent-session documents, RFCs, and instruction files.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
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
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.
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
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.

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
- Two-column desktop queue layout: active queue and history side-by-side at â‰¥960px.
- Mobile infinite scroll for both active queue and history lists.
- Bulk queue reorder: per-row reorder buttons apply to entire selection when multiple items are selected.

### Changed

- `/api/activity` is now the canonical paginated/filterable activity feed; `/api/status` is summary-only. Removed `/api/status/tasks`.
- Queue SSE/download events now include `quality` metadata with grace-window reconciliation to prevent flicker.
- Album/track organization, scanner metadata writes, playlist imports, and manual import now use transaction batching instead of per-row auto-commits.
- Manual import apply service rewritten to Lidarr-style two-phase collect-then-commit pattern.
- Artist page release modules ordered: Albums â†’ EPs â†’ Singles â†’ Live â†’ Compilations â†’ Soundtracks â†’ Demos â†’ Remixes â†’ Appears On.
- Deprecated `write_audio_metadata` boolean in favor of `write_audio_tags_policy` enum.
- Adopted pure SSE event-driven updates (Tidarr-style); removed all fallback polling intervals.
- Queue item layout uses stacked title/artist/badge rows for pending items; active/importing items retain inline layout.
- Queue reorder icons updated to `ArrowUpload`/`ArrowDownload` for move-to-top/bottom.
- Error display icons use Fluent `ErrorCircle48Color` for richer visual feedback.

### Fixed
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.

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
- MediaCover cache preference checks resolve the config directory from the
  environment at call time (fixes CI flake when test files override
  `DISCOGENIUS_CONFIG_DIR` after module load). API test runner retries once
  on known Node test-runner clone deserialization failures.

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
- **Job Queue Resilience**: Added proper job recovery on container restartâ€”interrupted jobs transition from `processing` to `pending` automatically.
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
