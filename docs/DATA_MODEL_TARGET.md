<!-- markdownlint-disable MD012 MD013 -->
# Discogenius — Target Data Model & App Structure

Status: **target architecture / contract** (2026-06-20). This is the agreed destination for
the data layer and provider/catalog abstractions. It supersedes the `ProviderItems`-centric
shape described in `ARCHITECTURE.md` for *new* work. There is **no data migration** — fresh
schema, no backfill.

This document is the contract that the parallel build units (U1–U7) implement against. Read
it before touching schema, provider, or catalog code.

---

## 1. Principles

1. **MusicBrainz/Lidarr catalog stays the source of truth.** Streaming providers are
   availability/acquisition resources only; they never create canonical entities.
2. **MBID is the durable join key for everything Discogenius owns** (matches, slots,
   selections, files, monitor state). Internal integer ids are a *local acceleration cache
   only*, never the cross-table source of truth. This is what makes MB-local mode a backend
   swap instead of a rewrite.
3. **Persist all match candidates, not just the selected one.** A provider album may match
   several MB releases; keep every candidate with status + evidence so the UI can offer a
   Lidarr-style release switcher and manual correction.
4. **Rows keyed by provider, never a column-per-provider.** Adding a provider must never be a
   schema change; one entity has many offers per provider (stereo / Atmos / explicit / clean
   / remaster), each with its own quality/UPC/ISRC.
5. **Provider UPC/ISRC is match evidence, never canonical.** Never copy provider UPC/ISRC
   into `AlbumReleases.barcode` / `Recordings.isrcs`. Those are filled only from
   MusicBrainz/MB-local.
6. **No premature normalization.** UPC is 1:1 with an album offer and ISRC 1:1 with a track
   offer → inline columns, not identifier side-tables, until matching perf proves otherwise.

---

## 2. Layers

### Layer A — Canonical catalog (replaceable)

`ArtistMetadata`, `Artists` (local subscription), `Albums` (release group), `AlbumReleases`,
`Tracks`, `Recordings`, plus `AlbumArtists` / `ArtistReleaseGroups` /
`ArtistReleaseGroupCuration` / `RecordingRelations`. Keyed by MBID.

- In **SkyHook mode** this is a refreshed local replica (today's behavior), filled on demand
  for monitored artists + their releases/collaborators.
- In **MB-local mode** it is **not populated** — catalog reads are served straight from the
  MB-docker container via `LocalMusicBrainzCatalogProvider`.
- Fold `AlbumReleaseMedia` into `AlbumReleases.data`; keep `medium_position` on `Tracks`.
- **Rule:** nothing Discogenius-owned treats an internal catalog integer id as source of
  truth — it references MBIDs.

### Layer B — Provider resources (pure offer cache)

`ProviderResources` — PK `(provider, entity_type, provider_id)`, where `entity_type` ∈
{artist, album, track, video}. Offer facts only:

```
provider, entity_type, provider_id,
title, version, explicit, quality, quality_tags,
duration, release_date, availability,
upc,            -- album offers
isrc,           -- track/video offers
provider_album_id, medium_position, position,  -- track/video offers (track ids are album-scoped)
provider_url, asset_id,
data,           -- compact raw/provider JSON
updated_at
```

**No `*_mbid` match columns here.** Match edges live in Layer C. (There is no separate
tracklist-membership table — provider track ids are album-scoped on TIDAL/Apple/YT, so the
single `provider_album_id` parent pointer is sufficient.)

### Layer C — Persistent match graph (provider → MB, all candidates)

**ONE table, not four.** A simplicity audit confirmed the per-entity match tables share an
identical shape, so collapse them into a single `ProviderMatches`:

```
ProviderMatches(
  provider, entity_type,          -- 'artist' | 'release' | 'recording'
  provider_id,                    -- the provider entity id (artist id / album id / track|video id)
  provider_album_id,              -- owning provider album for track/video matches (nullable)
  target_mbid,                    -- artist_mbid | release_mbid | recording_mbid
  target_kind,                    -- mirrors entity_type for clarity ('artist'|'release'|'recording')
  status,                         -- candidate | probable | verified | manual | rejected
  confidence,                     -- REAL
  method, evidence,               -- TEXT, JSON
  updated_at
)
UNIQUE(provider, entity_type, provider_id, target_mbid)  -- multiple candidates per source allowed
```

- **Release matches** (`entity_type='release'`, `provider_id`=provider album id →
  `release_mbid`): **many candidate rows per provider album allowed** (ambiguous candidates).
  This is what powers the release switcher. **No release-group match** — release-group
  availability is derived by joining matched releases up to `Albums`.
- **Recording matches** (`entity_type='recording'`): a provider track/video → `recording_mbid`,
  scoped by `provider_album_id` (video → provisional recording mbid when none exists yet).
  Best-match is enough here (the switcher operates at release level); persist a single row per
  source unless a real need for candidates appears.
- **Artist matches** (`entity_type='artist'`): provider artist → `artist_mbid`.

Targets are MBIDs (+ optional cached internal id). Index by `target_mbid` and by
`(provider, entity_type, provider_id)`.

**Matching evidence order:** exact MBID if the provider supplies it → UPC/barcode for release
→ ISRC for recording → track/medium count → title/version → date/type → position/duration →
title similarity.

**Identifier semantics:** a UPC/ISRC *match* is strong positive evidence; its *absence is not*
negative (TIDAL vs Apple routinely carry different UPCs for the same album). Cross-provider
"same album/recording" is established by **both providers matching the same MB
`release_mbid`/`recording_mbid`**, not by shared UPC/ISRC.

**Rate limits:** do **not** enrich per-scan against the public MB API (1 req/s). Full UPC/ISRC
matching is the payoff of MB-local mode (your own instance has no limit). In SkyHook mode
(SkyHook exposes no UPC/ISRC), match on title/track-count/date/duration/position plus any
provider-side UPC/ISRC that happen to align, and accept slightly weaker matching until
MB-local is connected.

### Layer D — Library overlay (two tables, not four)

A simplicity audit confirmed there is exactly **one selection per slot**, so policy and
selection live in the **same** row; only the "which provider offers satisfy it" part is a
genuine 1:N child.

- `LibraryTypes` (config) — `{ id, name, root, kind: audio|video, desired_quality }`, seeded
  with **3 fixed rows** (stereo / spatial / video). Introduce it now only as a stable FK
  target replacing the hardcoded slot enum — do **not** build per-type editing/ordering/icons
  yet (that's the 2.2 feature).
- `LibrarySlots` = **policy + selection together**, keyed `(release_group_mbid,
  library_type_id)`: policy (`monitored`, `monitored_lock`, `quality_profile`, `locked_at`,
  `checked_at`) **and** the single selection (`selected_release_mbid`, `selection_source`
  auto|manual, `selected_at`). This is Lidarr's `AlbumRelease.Monitored` mechanism generalized
  to one selected release *per slot*.
- `SlotResources` = **rows** of provider offers satisfying a slot:
  `(slot_id, provider, provider_album_id, quality, rank)`. The one genuine 1:N — replaces the
  semicolon-encoded `selected_provider_id`; supports an Atmos-only album filling both
  stereo+spatial, multi-album coverage, and multi-provider.

### File inventory (MBID-keyed + provenance, debt removed)

`TrackFiles` (and `MetadataFiles` / `LyricFiles` / `ExtraFiles`) keep: file facts; provider
provenance (`provider`, `provider_entity_type`, `provider_id`, `provider_album_id`); canonical
identity by **MBID** (`recording_mbid`, `track_mbid`, `release_mbid`, `release_group_mbid`,
`artist_mbid`); library slot. **Drop** `album_id`/`media_id`, the `canonical_*` naming debt,
and the duplicated integer-FK source-of-truth (no migration → just define the clean columns).
Files are inventory, not catalog and not match state.

---

## 3. Catalog source abstraction (`CatalogProvider`)

Symmetric to `StreamingProvider`. Methods: `getArtist`, `getArtistReleaseGroups`,
`getReleaseGroup`, `getReleaseWithTracks`, `getRecording`, `lookupByUPC`, `lookupByISRC`,
`search`. Implementations:

- `SkyhookCatalogProvider` — wraps today's SkyHook/MB-API replica flow.
- `LocalMusicBrainzCatalogProvider` — reads the MB-docker container. `.ref_musicbrainz-docker`
  exposes both Postgres (`:5432`) and a full MB web-service API mirror (`:5000`); on your own
  instance neither has the 1-req/s limit. Start against the **`:5000` mirror** (same JSON
  shape existing MB-shaped code consumes), with the direct-**Postgres** path
  (`artist`/`release_group`/`release`/`medium`/`track`/`recording`/`isrc` by `gid`, with
  `artist_credit`/`artist_credit_name` + split-date translation) as the performance follow-up.
  The adapter always translates MB's normalized shape into our DTOs — we never point our
  schema at MB's tables directly.

**Mode switching:** because Layers C/D/files key on MBID, Layer A is pure cache. MB-local →
SkyHook triggers an on-demand catalog build for the monitored set; SkyHook → MB-local stops
replicating and lazily empties Layer A *after a delay* (so an accidental toggle doesn't force
a rebuild).

---

## 4. Universal streaming-provider abstraction

The registry (`api/src/services/providers/index.ts`) already supports N providers; only
`getDefaultStreamingProvider()` hardcodes `"tidal"` and the download backend (tiddl) is
TIDAL-only. Target:

- Provider **capability descriptor** `{ audio, spatialAudio, video, lyrics, download, search,
  followedArtists }` so the app degrades gracefully per provider.
- **Neutral quality model** (normalized quality enum + per-provider mapping) instead of TIDAL
  quality strings leaking through the app.
- **`DownloadBackend` interface** per provider (tiddl stays the TIDAL backend; others bring
  their own).
- **Config-driven** active/default provider selection; clear auth / `syncCredentials` /
  `syncSettings` plug points.

**Acquisition pattern (Tidarr/tiddl style):** wrap a proven OSS downloader as the
`DownloadBackend`, then reuse the auth/token it establishes for our own catalog/metadata API
calls. Candidate tools:

- **Apple Music:** `zhaarey/apple-music-downloader` (Go; ALAC/Atmos/MV) or `gamdl/custom_gamdl`
  (Python). Reuse the Apple `media-user-token` + developer token.
- **YouTube Music:** `yt-dlp` (download) + `ytmusicapi` (catalog), per `gytmdl`. Reuse the
  browser-cookie auth.
- **Amazon Music:** weakest OSS story — metadata/availability-first, download best-effort/stub.

---

## 5. Release switcher (feature unlocked by Layers C/D)

- `GET /api/v1/album/:rgMbid/slots/:slot/releases` → every MB release in the group, each with
  its `ProviderReleaseMatches` (provider, quality, slot-compatibility, confidence, identifier
  evidence, available/unavailable) and which is currently selected. Filters: provider,
  quality, slot compatibility, UPC/ISRC evidence, availability, auto/manual.
- `PATCH /api/v1/album/:rgMbid/slots/:slot/selection` →
  `{ releaseMbid, providerResourceIds[], source: 'manual' }` updates `SlotReleaseSelections`
  + `SlotSelectionResources`.
- UI: a switcher on the album page (extend `ProviderQualityPill` / the "Other releases" grid
  in `app/src/pages/AlbumPage.tsx`).

---

## 6. Roadmap convergence

This model is the foundation the existing roadmap (`docs/TASKS.md`) converges toward, not a
detour: 2.1 (Apple Music + hardened provider abstraction) = §4; 2.2 (configurable library
types) = Layer D's `LibraryTypes`; 3.0 (MB-local mode + unified matching) = §3 + Layer C.
