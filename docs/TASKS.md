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
- pending: structure audit incremental moves (see `docs/STRUCTURE_AUDIT_2.6.md`)

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
`docs/STREAMING_PROVIDER_PLUGIN_CONTRACT.md` (§ 2.6 modularity target) and
`docs/STRUCTURE_AUDIT_2.6.md`.

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

- shipped: findings doc `docs/STRUCTURE_AUDIT_2.6.md` — proposed incremental
  moves; no mass move yet. Leave sibling `.tmp-*` scratch until those threads
  finish.
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
