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

## Lidarr parity: scheduling, file tracking, tagging, packaging (2026-07-24)

Grounded in a `.ref_lidarr` comparison. Root-cause notes inline so each item is
actionable without re-deriving. See [[discogenius-roadmap]].

### Scheduled tasks & automation parity

- pending: **Auto tag-sync on metadata change** (highest value). Lidarr's
  `WriteAudioTags=Sync` makes the scheduled `RefreshArtist → RefreshTrackService.SyncTags`
  re-write tags for tracks whose metadata changed. Our retag is manual-only and is
  never chained off the scheduled refresh, so fixes like `ep;live`→`album;live`
  only land on a manual retag. Add an opt-in "sync tags on metadata change" mode.
- pending: **Scheduled DB backup.** Lidarr `BackupCommand` runs on a schedule
  (default ~weekly). We have none — Housekeeping only VACUUMs. Add a scheduled
  SQLite backup (retention + restore path).
- pending: **Unify the two "Rescan Folders" registry entries.** `root-scan`
  (scheduled) and `rescan-folders` (manual) both call `queueRescanFoldersPass`
  with identical default args. Lidarr uses ONE `RescanFoldersCommand`; scope comes
  from params (folders/artistIds/filter) and `UpdateScheduledTask => ArtistIds.Empty()`
  means a scoped/manual run does NOT reset the daily clock. Adopt: one command,
  scope-by-param, and the schedule-reset gating.
- pending: **`Matched` vs `Known` filter tuning.** Lidarr deep-rescans unmatched
  files only when metadata changed, else scans new files only (`FilterFilesType`).
  We always pass `fullProcessing:false`. Perf parity for large libraries.
- pending: **Scheduled health check.** Lidarr `CheckHealth` runs every 6h and
  surfaces in the UI; we only run a startup preflight (promoting it would also have
  caught the E2E `/health` library-path issue — see [[e2e-playwright-preflight-blocker]]).
- revisit: **New-release cadence.** Lidarr RSS ~15m vs our 24h monitoring cycle —
  decide whether a lighter, more frequent "any new releases?" pass is worth it for
  streaming providers.
- revisit: confirm followed-artists-import scheduling vs Lidarr `ImportListSync`
  (~5m); command/message cleanup cadence (Lidarr 5m vs our daily Housekeeping).
- note: Rename is NOT scheduled in Lidarr either (import-time per config, or manual
  `RenameFiles`) — we're aligned; do not add scheduled rename.

### File scanning & tracking parity (bugs)

- pending: **Orphan removal doesn't invalidate the album status cache.**
  `cleanOrphanedRecords` selects `NULL AS album_id`, so `updateAlbumDownloadStatus`
  never fires; only `updateArtistDownloadStatusFromMedia(provider_id)` runs — and
  canonical-linked (provider-free) rows have a null `provider_id`, so they get NO
  invalidation at all. Effect: after files are deleted, the album keeps showing
  "downloaded" until an incidental 30s cache expiry / later pass. Fix: resolve the
  affected RG(s) from the deleted row's `canonical_release_group_mbid` (and/or
  recompute) and invalidate album + RG status.
- pending: **Scan lifecycle / progress reporting.** "Rescan Folders" reported
  **completed** minutes before the emptied library was reflected. Lidarr reconciles
  the file table synchronously inside the command and its progress messages reflect
  file-table work; "Completed" means the DB is reconciled. Make our task completion
  reflect actual reconciliation, and report file-table deltas (removed/added/updated),
  not just the disk-walk progress. See [[lidarr-terminology]].
- pending: **Files not matched on root scan + artist refresh** (user report). Verify
  the 2.6.11 embedded-MBID linking + Phase E self-heal actually take effect on a real
  rescan of a deployed library; confirm on deployment with logs.
- pending: **Cross-album cover/lyric bleed.** The fuzzy matcher proposed another
  album's cover/lyrics for the iTunes Festival album. Tighten `folderAlbumIds` /
  `matchAudioFileByMetadata` album scoping so sidecars never migrate across albums.

### Tagging parity with Lidarr (keep Plex-compatible types)

- pending: **Genres still wrong on 2.6.11-downloaded files.** Files imported *after*
  the retag-query fix still show the provider's single genre (e.g. Apple "Alternative")
  instead of the MB list. The tag writer is correct (`album.genres → artist.genres`,
  joined `" / "`), so the gap is upstream: confirm `Albums.genres` / `ArtistMetadata.genres`
  are actually populated at import time (servarr refresh) before import-time tagging runs;
  if not, the tagger has nothing to write. Likely ordering/population bug in the
  download→import→tag path. **This is the "not on par" root for genres.**
- pending: **Field-by-field tag audit vs Lidarr `AudioTagService.WriteTags`.**
  Produce a mapping table and close gaps so we write an identical tag set — while
  keeping our Plex-compatible `album; <secondary>` release types.
- pending: **Embedded cover surfaced in retag preview.** Retag preview flags
  release-type/year but not the cover. Cover *is* embedded on apply (now a 1200px
  capped rendition); surface cover changes in the retag preview/diff like tag fields.
- done (2.6.x, kept): **1200px embedded-cover cap.** Embed a ~1200px rendition
  (`EMBEDDED_COVER_HEIGHT`) instead of the multi-MB origin or the too-small 500px —
  so neither catalog nor provider preference embeds a 6 MB cover.

### Provider-vs-catalog data leaks (MB-canonical model)

We should present/tag/store catalog (MusicBrainz) data and only fall back to provider
data when the catalog genuinely lacks it. Known leaks:

- pending: **Album-page track artists show the provider's artists.**
  `musicbrainz-release-group-read-service.ts:~1284-1287` unconditionally overrides the
  canonical `artist_name`/`artist_credits` with the matched provider credits
  (`credits.length > 0 ? credits : track.artist_credits`). Make it canonical-first
  (only use provider credits when the canonical recording has none) — mirroring the
  tag writer. (Seen on a SoundCloud album showing SoundCloud artists.)
- pending: **Tag writer provider fallback for artists.** `getTrackArtistNames` is
  canonical-first but falls back to `provider_recording.credits` when the canonical
  recording has no credits — so provider (e.g. SoundCloud) artists can be written into
  files. Decide/limit when that fallback is acceptable.
- pending: **Broad provider-vs-catalog sweep.** Audit every `COALESCE(canonical…, provider…)`
  and provider-override site (read services, tag builder, naming) to guarantee
  canonical-first per the [[discogenius-goals]] MB-canonical model.

### Artwork: sidecar source & hybrid picking

- pending: **Sidecar `cover.jpg` should be the canonical full-res (Servarr/CAA) image,
  not always the provider cover.** `downloadAlbumCover(..., "origin", { provider })`
  resolves canonical first but falls back to the provider origin (and the organizer
  always passes the provider), so the sidecar ends up as the multi-MB provider cover
  even in canonical mode — while the UI proxy (`mapAlbumArtworkToLocalUrl`) correctly
  shows canonical. Make the sidecar honor `artwork_preference`: canonical mode →
  full-res CAA/Servarr; provider mode → provider. (Embed stays 1200px-capped either way.)
- pending: **Hybrid artwork picking by album-title match.** A hybrid album got a
  completely wrong sidecar cover because one track came from a single, so provider
  artwork was pulled from that single's album. Pick the provider album whose title
  best matches the hybrid release group (title similarity) rather than any contributing
  offer. Embedded/UI were right; only provider sidecar picking is wrong — and it would
  worsen under provider artwork preference.

### Repo & container hygiene

- pending: **Broad legacy cleanup pass.** Extend today's stray-DB/dead-dir removal
  into a systematic sweep: orphaned files, dead directories, redundant/legacy code,
  unused exports/config. Pairs with "Repo-wide structure audit" below.
- pending: **Docker image efficiency.** Study how `.ref_lidarr` and `.ref_jellyfin`
  build/package their containers (base image, multi-stage builds, layer caching,
  runtime-only deps, final image size) and adopt wins for a smaller, more efficient
  Discogenius image.

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
- in progress: release-centric matching — composites persist in
  `ProviderItemMatches`; still need provider albums to score against **all**
  candidate MB releases for the artist (not one RG container). Evidence:
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
