# Lidarr DB Alignment — Legacy Provider Table Retirement Plan

**Status:** Active implementation for 2.0.8. Phase 1 is partially shipped;
Phase 2 read-path cutover has started.
**Goal:** Collapse the legacy provider-shaped tables into the canonical
MusicBrainz/Lidarr-aligned graph + `ProviderItems`, so the database has a single
identity model. Deviate from Lidarr only where a distinguishing feature requires
it (spatial/Atmos + video libraries, discography curation/dedup, provider data
as availability-only).

## 1. The problem: two parallel models

Discogenius currently stores library identity **twice**:

| Concern | Canonical (keep — Lidarr-aligned) | Legacy (retire — provider-shaped) |
|---|---|---|
| Artist metadata | `ArtistMetadata`, `Artists` | — |
| Release group / album | `Albums` (RG, has `mbid`) | `ProviderAlbums` (string provider id) |
| Release / edition | `AlbumReleases` | — |
| Track | `Tracks` | `ProviderMedia` (type≠video) |
| Recording / video | `Recordings` | `ProviderMedia` (type=video) |
| Album↔artist credit | `AlbumArtists` | `ProviderAlbumArtists` |
| Track↔artist credit | (via `Recordings.artist_credit`) | `ProviderMediaArtists` |
| Similar artists/albums | Drop unless MusicBrainz/SkyHook-backed | `ProviderSimilarArtists`, `ProviderSimilarAlbums` |
| Provider availability/offers | `ProviderItems` (keyed to mbids) | embedded in `ProviderAlbums`/`ProviderMedia` rows |
| Local files | `TrackFiles` integer FKs to catalog rows; transitional MBID/provider ids until Phase 5 | — |
| Spatial/stereo/video selection | `ReleaseGroupSlots` (**distinguishing feature, keep**) | — |

Lidarr has **no** equivalent of `ProviderAlbums`/`ProviderMedia` — indexer
results are transient. Discogenius's correct replacement already exists:
`ProviderItems` (one row per provider offer, keyed to canonical mbids +
`library_slot`). The legacy tables are 1.x leftovers from before the canonical
graph existed.

Scope of entanglement (non-test files referencing each, today):
`ProviderAlbums` ~25, `ProviderMedia` ~25, `ProviderAlbumArtists` ~7,
`ProviderMediaArtists` ~2, `ProviderSimilarArtists` ~2, `ProviderSimilarAlbums` 0.
Heaviest in `services/mediafiles/*` (import, scan, organizer, upgrader, rename,
manual-import), the `repositories/music/*` repos, lyrics, audio-tag, and
housekeeping. `runtime-maintenance.repairMonitoringGaps` now writes canonical
`ReleaseGroupSlots`/`Recordings`; remaining runtime-maintenance provider-id work
is compatibility backfill/indexing for `TrackFiles.media_id`/`album_id` until
Phase 5.

## 2. Target model (after migration)

**`Recordings` vs `Tracks` (clarified — the intended canonical shape):** stay
close to Lidarr, where one table (`Track`) carries the recording-level info. We
split it into two on purpose, to support **music videos that belong to no
album/release**:

- **`Recordings` = the canonical recording/work entity, holding ALL the
  recording-level info** (title, artist credit, duration, ISRC, AcoustID/MBID,
  whether it's audio or a video, …). This is the table that plays Lidarr's
  `Track` role. A standalone music video lives here with **no** `Tracks`/release
  row. **All track information that isn't release-specific belongs on
  `Recordings`.**
- **`Tracks` = a release↔recording mapping table.** A recording can appear on
  many releases, so `Tracks` stores only the **release-specific** facts:
  `release` association, volume number, track number/position, and any other
  per-release detail. It carries no recording properties of its own.

So the canonical chain is `ArtistMetadata`/`Artists` → `Albums` (RG) →
`AlbumReleases` → `Tracks` (release↔recording map) → `Recordings` (the work).
Provider availability is `ProviderItems` (keyed to canonical mbids), never the
legacy `Provider*` tables.
- Provider availability/offers: `ProviderItems` only.
- Slot selection (stereo/spatial/video): `ReleaseGroupSlots`. (Keep — this is the
  spatial + video feature that justifies deviating from Lidarr.)
- Local files: `TrackFiles` linked **only** by `canonical_track_mbid` /
  `canonical_recording_mbid` / `canonical_release_group_mbid` (the columns
  already exist); drop the `media_id` / `album_id` provider-id linkage.
- Curation/dedup: `ArtistReleaseGroupCuration`, `ReleaseGroupSlots`. (Keep.)

## 3. Migration phases (incremental, each independently shippable)

Each phase ends green (build + `yarn test:api`) and is reversible; no big-bang.

**Phase 0 — Inventory & read/write map (no code).**
For every one of the ~25 `ProviderAlbums`/`ProviderMedia` files, classify each
access as read vs write and map it to its canonical equivalent. Produce a
checklist. (This doc is the seed.)

**Phase 1 — Make `TrackFiles` canonical-first.**
The riskiest coupling: `TrackFiles.media_id`/`album_id` point at legacy provider
ids. Backfill `canonical_track_mbid`/`canonical_recording_mbid` for all existing
rows (already populated on new downloads/imports per the AcoustID/MBID work), add
a maintenance pass to fill gaps, then switch all file lookups/dedup/import logic
to the canonical columns. Keep `media_id`/`album_id` as nullable shadow columns
until Phase 5.

**Phase 2 — Read-path cutover.**
Point all *read* queries (library list/query services, lyric service,
audio-tag, library-files-query, organizer path resolution) at the canonical
tables + `ProviderItems`. Legacy tables still written but no longer read.

**Phase 3 — Write-path cutover.**
Import/scan/manual-import/upgrader/rename write canonical rows + `ProviderItems`
instead of `ProviderAlbums`/`ProviderMedia`. Update `repositories/music/*`
(`AlbumRepository`, `MediaRepository`, `ArtistRepository`).

**Phase 4 — Housekeeping & monitoring repair.**
Rewrite housekeeping monitor/skip repairs to operate on canonical monitored
state. `runtime-maintenance.repairMonitoringGaps` now repairs installed audio
into `ReleaseGroupSlots` and installed videos into `Recordings`; the
`DownloadMissingForce` legacy skip reset is retired. Remove provider-only
discovery sections such as similar artists/albums unless they can be driven from
MusicBrainz/SkyHook data. Do not migrate `ProviderSimilar*` into another
provider-catalog table just to preserve a non-core UI section.

**Phase 5 — Drop legacy tables.**
Once nothing reads or writes them: drop `ProviderAlbums`, `ProviderMedia`,
`ProviderAlbumArtists`, `ProviderMediaArtists`, `ProviderSimilarArtists`,
`ProviderSimilarAlbums`, and the now-unused `TrackFiles.media_id`/`album_id`
columns, via a numbered schema migration (bump `user_version`). Keep a one-time
data-migration guard so existing DBs backfill before the drop.

## 3b. Provider-data policy (Robert, 2026-06-18) — governs every cutover decision

MusicBrainz/Skyhook is the **catalog source of truth**; providers (TIDAL, future
Apple Music) exist for exactly two things:

1. **The download capability** MusicBrainz can't offer (the core feature).
2. **Supplementing allowed holes in the catalog tables** — provider data may *fill
   selected columns* on `Albums`/`AlbumReleases`/`Recordings`/`ArtistMetadata` that
   MB/Skyhook lacks (e.g. cover-art ids, copyright strings, replay gain/peak). It
   populates the catalog row; it does **not** get its own catalog table.

Provider UPC/barcode and ISRC are exceptions: they are **matching evidence**, not
provider supplements to the catalog. In normal SkyHook mode, provider UPC/ISRC
must stay on `ProviderItems.upc` / `ProviderItems.isrc`; do not copy provider UPC
into `AlbumReleases.barcode` or provider ISRC into `Recordings.isrcs`. Local
MusicBrainz-docker mode may later fill or model authoritative MB UPC/ISRC
directly, but that is a separate mode/design decision.

There are **no separate provider catalog tables** after this migration — that is the
whole point. `ProviderItems` stays, but only as *availability/offer* rows keyed to
canonical mbids (which provider can download what, at which quality/slot), never as a
parallel catalog of titles/relationships.

**When a feature is found to be populated *exclusively* from provider data, stop and
decide:** can it be sourced from MusicBrainz/Skyhook instead? If yes, re-source it. If
no, **remove the feature and its code** — Discogenius is a discography downloader
(Lidarr-shaped); non-essential provider-only features are not worth a parallel data
model. Applied so far:
- **Similar artists** (`ProviderSimilarArtists`, TIDAL `getSimilarArtists`): no MB/
  Skyhook equivalent, no Lidarr counterpart → **removed** (read in
  `artist-query-service`, population in `refresh-artist-service`, the "Similar Artists"
  artist-page module, and the `ProviderSimilarArtists`/`ProviderSimilarAlbums` tables).
- **Top tracks**: already MB-driven (canonical `Tracks` scoped to the artist's release
  groups) → **kept**.

## 4. Distinguishing features to PRESERVE (do not "align away")

> **Video canonical-identity wrinkle (verified on real data, 2026-06-18).**
> Provider-only music videos (e.g. TIDAL videos not matched in MusicBrainz) get a
> canonical `Recordings` row (`is_video = 1`) **with no `recording_mbid`** — they
> are linked from `ProviderItems.recording_id` (numeric FK), not by mbid. So
> `TrackFiles.canonical_recording_mbid` is *structurally NULL* for these (the
> Phase 1 gap-fill correctly leaves it NULL — there is no mbid to fill). The
> correct canonical read path for videos is therefore
> `TrackFiles.provider_id + provider_entity_type='video' → ProviderItems →
> recording_id → Recordings`, **never** legacy `ProviderMedia`.
> `TrackFiles.provider_id` is a canonical-era column (distinct from the legacy
> `media_id`/`album_id` being dropped), so this path survives Phase 5. The
> committed `library-files-query-service` cutover already resolves videos this
> way; remaining readers (lyrics/audio-tag/etc.) and the write path must too.

- `ReleaseGroupSlots` (stereo/spatial/video slot model) — core to multi-library
  + Atmos support; Lidarr has no equivalent.
- `ProviderItems` as availability-only, keyed to canonical mbids — the
  "providers never create canonical entities" rule from AGENTS.md.
- Curation/dedup (`ArtistReleaseGroupCuration`) — Discogenius's discography
  dedup on top of Lidarr's release-type filtering.
- Provider data may supplement allowed holes in catalog rows where MusicBrainz/SkyHook
  lacks a field needed for a library-manager workflow (e.g. artwork asset ids,
  copyright, replay gain/peak, provider URLs, download availability), but the
  core app should remain MusicBrainz/SkyHook-primary. UPC/barcode and ISRC are
  matching evidence and stay on `ProviderItems`. Provider-exclusive,
  non-essential discovery features such as similar artists/albums or top tracks
  should be removed rather than preserved through new provider catalog tables.

## 5. Risks & verification

- **Highest risk:** `TrackFiles` re-linking (Phase 1) — a wrong mapping
  orphans local files from their tracks. Mitigate with a dry-run report
  (counts of files that would re-link vs orphan) before cutover, and keep the
  shadow columns until Phase 5.
- Verify each phase with `yarn --cwd api build`, `yarn test:api`, and a
  container run against a real-data `./config` DB (Bastille + a prolific artist
  like *NSYNC), checking artist/album pages, import, and download flows.
- Each phase is small enough to land + validate independently; abort/rollback is
  per-phase.

## 6. Effort estimate

Large. ~25 files per legacy table, concentrated in mediafiles. Realistically
3–5 focused sessions (one per phase). Phases 1–3 are the bulk; 4–5 are cleanup.

## 6b. TrackFiles linkage = canonical integer FKs (Robert's decision, 2026-06-18)

Local files link **directly to the catalog graph via integer FKs** (Lidarr-style),
not by mbid-join and not through `ProviderItems`:
- `TrackFiles.release_group_id → Albums.id`, `album_release_id → AlbumReleases.id`,
  `track_id → Tracks.id`, `recording_id → Recordings.id`.
- `recording_id` cleanly covers **mbid-less provider videos** (points straight at
  their `Recordings` row), retiring the `provider_id→ProviderItems→recording_id`
  read workaround.
- Existing `canonical_*_mbid` columns are transitional migration debt. Do not add
  more of them. Phase 5 should either remove them where integer FKs are enough or
  rename any truly necessary file-level MBID provenance to neutral names such as
  `artist_mbid`, `release_mbid`, `track_mbid`, or `recording_mbid`. Legacy
  `media_id`/`album_id` are dropped once readers/writers are off them.

**Foundation COMPLETE + validated (2026-06-18):** v23 migration + base schema add
the four FK columns; backfill from canonical mbids (videos from the video
`ProviderItems` offer) via the v23 migration + `runtime-maintenance.backfillTrackFileForeignKeys`;
and a **v25 populate-on-write trigger** (`trg_trackfiles_canonical_fks_ai/_au`)
derives the FKs from the mbids on every INSERT/UPDATE so new imports link to the
catalog graph immediately. Validated on a fresh Bastille+Bakermat rebuild:
monitoring cycle queued 139 downloads, and post-restart imports show 100% FK
coverage (recording_id + track_id + release_group_id). **Remaining for the pivot:**
(1) ~~populate at write time~~ DONE (trigger); (2) convert
the readers from mbid-joins to FK-joins (`library-files`, `library-files-query`,
`metadata-files`, `library-metadata-backfill`, `rename`, `lyric`, `audio-tag`,
`organizer`, query-services); (3) subtract legacy writes; (4) numbered migration
dropping `media_id`/legacy `album_id` + the legacy provider tables; (5) migrate
test seeds and validate via a from-scratch rebuild (Bastille + Bakermat).

Similar-artists feature already removed (provider-exclusive, no MB equivalent — see
§3b); that retires `ProviderSimilarArtists`/`ProviderSimilarAlbums` from the drop set.

### Critical ordering for the finish (learned the hard way, 2026-06-18)

Converting a reader/resolver/writer to canonical-only **breaks every test that
seeds the legacy `ProviderMedia`/`ProviderAlbums` tables and expects resolution
from them** (≈100 tests). A trial conversion of `library-file-identity` alone
broke 6 tests across 3 files and undercut the Phase-1 `backfillCanonicalTrackFiles`
(whose premise is "resolve canonical FROM legacy `media_id`"). So the safe finish
order is **test-seeds first**:
1. Migrate the shared test seed helpers (`seedLegacyGraph` etc.) to seed
   `ProviderItems` + canonical (instead of/alongside legacy `Provider*`).
2. THEN convert production readers/resolver to `ProviderItems`-only
   (`library-file-identity`, `organizer`, `metadata-identity`, `audio-tag`).
3. THEN the keystone: `refresh-album-service` — its legacy catalog block
   (`ProviderAlbums`/`ProviderMedia` INSERT/UPDATE at ~470/763/1016) is now
   *vestigial* (data homed canonically via v24; monitored state in
   `ReleaseGroupSlots`; availability in `ProviderItems`) BUT the scan reads its own
   writes (`existing.monitored`/`last_scanned` at 462/707/1010) — rewire those to
   `ReleaseGroupSlots`/`ProviderItems.updated_at` before deleting the block.
4. Re-point/remove the Phase-1 legacy-id backfill (old-DB-only; deferred).
5. Numbered migration dropping the legacy `Provider*` tables + `TrackFiles.media_id`
   /legacy `album_id`; final from-scratch rebuild validation (Bastille + Bakermat).

This is a focused multi-hour pass; it touches the core scan→curate→download path,
so it must NOT be rushed (that is where the parallel agents repeatedly broke
things). The integer-FK foundation + monitoring + supplement homing are DONE and
validated, so the app is fully functional in the meantime.

### Progress (2026-06-19): `library-file-identity` resolver is ProviderItems-only ✓

Done + green (committed): the core identity resolver no longer reads
`ProviderMedia`/`ProviderAlbums` — provider ids resolve through `ProviderItems`
+ the canonical graph + `ReleaseGroupSlots`. Established the cutover pattern:
**convert a reader → migrate its test seeds to `ProviderItems`, keeping minimal
legacy rows only for the transitional `TrackFiles.media_id`/`album_id` FK** (the
FK is dropped in Phase 5; until then, an upsert that sets `media_id`/`album_id`
needs the legacy rows present).

### Remaining-reader gotcha: tag-field re-sourcing (not just fallback removal)

`audio-tag-service.buildTrackRowsSql` reads ~20 legacy `m.`/`a.` COALESCE
fallbacks. Several are **only on `ProviderMedia`** and must be *re-sourced* from
canonical, not just dropped — verify each canonical home is populated by the scan
first, or the tag loses the value:
- `m.replay_gain` / `m.peak` → `Recordings.replay_gain` / `Recordings.peak`
  (confirm the scan writes them; `Recordings.peak` may need adding).
- `m.acoustid_id` / `m.acoustid_fingerprint` / `m.fingerprint_duration` →
  `TrackFiles.acoustid_id` / `.fingerprint` / `.fingerprint_duration` (the file's
  own AcoustID, already on `TrackFiles`).
- `m.credits` → `Recordings.credits` (homed by v24); `a.review_text` →
  `Albums.review_text` (v24); `a.upc` stays on `ProviderItems.upc` only.
This is the same `canonical_recording.replay_gain` mistake the stashed broken WIP
made. `organizer` and `metadata-identity` have analogous re-sourcing needs (video
provider rows, identity columns).

## 6c. Write-path cutover — the real blocker is supplement-field homing (2026-06-18)

The writers (`refresh-album-service` keystone, `organizer`, `metadata-identity`,
`import-service`, `manual-import`) already write `ProviderItems` (availability,
with `track_id`/`recording_id`) **alongside** the legacy `ProviderAlbums`/
`ProviderMedia`. So the legacy *writes* are redundant for identity/availability —
**except** for provider *supplement* fields the legacy tables hold that
`ProviderItems` does not: album `cover` (already in `ProviderItems.data`),
`popularity`, `copyright`, `vibrant_color`, `video_cover`, `num_tracks/volumes/
videos`, `review_text`; and per-track `copyright`/credits. Provider UPC/ISRC
stay in `ProviderItems` as matching evidence and are not catalog supplements.

Per Robert's directive (§3b) these **supplement the canonical row**, so before the
legacy writes can be removed:
1. Decide each field's canonical home (add columns as needed): `cover`→`Albums`/
   `Recordings.cover_image_id` (exists), `copyright`→`AlbumReleases`/`Recordings`,
   `popularity`/`vibrant_color`/`video_cover`/`review_text` → catalog column
   or `ProviderItems.data` if purely provider-flavour. UPC/ISRC stay in
   `ProviderItems`.
2. Write them onto the canonical row during scan (`refresh-album-service`).
3. Point the readers (`metadata-files`, `library-metadata-backfill`, NFO/cover
   generation, `audio-tag`) at the canonical source.
4. Only then delete the legacy `ProviderAlbums`/`ProviderMedia` INSERT/UPDATE and
   their internal SELECTs.

**Progress (2026-06-18, continued):** v24 adds catalog provider-supplement
columns (`Albums.cover_image_id`/`vibrant_color`/`video_cover`/`popularity`/
review fields, `AlbumReleases.copyright`, `Recordings.copyright`/`popularity`/
`credits`). `refresh-album-service` now mirrors album/release/track provider
supplements into those catalog rows while keeping the legacy compatibility
`ProviderAlbums`/`ProviderMedia` writes. `metadata-files`,
`library-metadata-backfill`, and `audio-tag-service` now prefer those catalog
supplement values before falling back to `ProviderItems.data` or legacy rows.
Regressions cover canonical album/release supplement homing, canonical recording
copyright/popularity, NFO review fallback from `Albums.review_text`, and audio
tags from canonical review/copyright with zero legacy provider rows.

**Correction (2026-06-19):** provider UPC/ISRC were reclassified as matching
evidence, not catalog supplements. `refresh-album-service` no longer homes
provider UPC into `AlbumReleases.barcode`; provider UPC/ISRC remain on
`ProviderItems.upc` / `ProviderItems.isrc` and can still be embedded in tags or
used for matching. Regression coverage asserts provider album UPC and track ISRC
stay on `ProviderItems` while catalog barcode/ISRC fields remain untouched.

**AcoustID/Lidarr research note (2026-06-19):** `fpcalc` produces a Chromaprint
fingerprint plus duration; AcoustID lookup maps that fingerprint to an AcoustID
and optional MusicBrainz recording IDs. Lidarr uses this only as an import-time
identification aid (`AllowFingerprinting = Never/NewFiles/AllFiles`,
`LocalTrack.AcoustIdResults`), not as catalog enrichment. Discogenius should
fingerprint only unknown/mistagged local imports; downloaded files with known
MBIDs should embed those MBIDs directly and skip fingerprinting.

Also still legacy-coupled: the **upgrade subsystem ledger** (`upgrade_queue` stores
legacy `media_id`/`album_id`; re-key to `recording_id`/canonical), and active
import/scan/tag write paths. Runtime monitor-gap repair has been repointed to
canonical `ReleaseGroupSlots`/`Recordings`, while `TrackFiles.media_id`/
`album_id` compatibility backfill/indexing remains until Phase 5. Dead
provider-catalog-only repair helpers
(`version-grouper`, `module-fixer`) have been removed after verifying zero
production imports.

This is the careful core of Phase 3 (artwork/NFO/scan correctness) and is the
next focused session's work; rushing it risks breaking display/organization.

## 7. Phase 0 inventory (read/write map) — done

Reference scope (non-test files): `ProviderAlbums` 26, `ProviderMedia` 26,
`ProviderAlbumArtists` 8, `ProviderMediaArtists` 3, `ProviderSimilarArtists` 3,
`ProviderSimilarAlbums` 1.

**Writers (cut over in Phase 3 — write canonical + `ProviderItems` instead):**
- `repositories/music/AlbumRepository.ts` — INSERT/UPDATE/DELETE `ProviderAlbums` (keystone).
- `repositories/music/MediaRepository.ts` — INSERT/UPDATE/DELETE `ProviderMedia` (keystone).
- `services/mediafiles/import-service.ts` — INSERT/UPDATE `ProviderMedia`/`ProviderAlbums`, `ProviderAlbumArtists`.
- `services/mediafiles/manual-import-service.ts` — INSERT/UPDATE `ProviderMedia`/`ProviderAlbums`/`ProviderAlbumArtists`.
- `services/mediafiles/organizer.ts` — INSERT/UPDATE `ProviderMedia`.
- `services/mediafiles/library-scan.ts` — UPDATE `ProviderMedia`/`ProviderAlbums`.
- `services/mediafiles/audio-tag-service.ts` — UPDATE `ProviderMedia`/`ProviderAlbums` (tag write-back).
- `services/music/refresh-album-service.ts`, `services/music/refresh-artist-service.ts` — scan upserts.
- `services/metadata/metadata-identity-service.ts`.
- `services/jobs/runtime-maintenance.ts` — legacy `TrackFiles.media_id`/`album_id` compatibility backfill/indexing remains until Phase 5; monitor-gap repair is canonical.

**Readers (cut over in Phase 2 — point at canonical + `ProviderItems`):**
`lyric-service`, `library-files-query-service`, `library-file-identity`,
`library-files`, `library-metadata-backfill`, `metadata-files`,
`rename-track-file-service`, `upgrader`, `import-matcher-service`,
`provider-release-group-matcher`, `scan-refresh-state`, `refresh-policy`,
`config/quality`, `jobs/command-history`, `providers/tidal/tidal-provider`,
`repositories/music/ArtistRepository` (+ read paths of the two keystone repos).

**Keystone:** `AlbumRepository` / `MediaRepository` are both the heaviest readers
and writers — Phases 2 and 3 hinge on giving them canonical-backed
implementations behind their existing method signatures, so call sites change
little.

## 7b. Remaining-work sequencing (verified 2026-06-18, post multi-agent churn)

State after this session: **Phase 1 complete** (gap-fill + canonical dedupe).
**Phase 2 partially complete** (Codex cut over `library-files-query-service`,
`command-history`, `scan-refresh-state`, `refresh-policy`, `tidal-provider`
progress fallback, `import-matcher-service`; later passes also cut over
`library-files`, metadata backfill, metadata sidecars, rename sidecar
replication, and lyric sharing).
Branch is green. A broken Phase 3 attempt (test-only `INSTEAD OF` trigger shim +
half-done writes) was discarded to `git stash@{0}`; **do not resurrect that
approach** — write canonical rows + `ProviderItems` directly.

**Progress (2026-06-18, continued):** the keystone `library-files.ts` is now
**fully canonical** — `computeExpectedPath` (audio + video naming/layout/root),
the inline video→audio match, and `pruneUnmonitoredFiles` all resolve from the
canonical graph + `ProviderItems` (videos via `getCanonicalVideoMetadataForRow`,
which uses `ProviderItems.recording_id` for mbid-less provider videos). The dead
`repositories/music/*` were deleted. Dependent tests (rename / move-artist /
import-finalize / inline-video) were migrated to seed the canonical graph +
`ProviderItems` (legacy provider rows kept only for the transitional
`TrackFiles` FK until Phase 5). Full suite green.

**Progress (2026-06-18, continued):** `library-metadata-backfill.ts` no longer
reads `ProviderAlbums`/`ProviderMedia`. Album sidecars are discovered from
canonical `TrackFiles.canonical_release_group_mbid` + `ReleaseGroupSlots` +
album `ProviderItems`; lyrics/video sidecars use `TrackFiles.provider_id` and
`ProviderItems`; video tag backfill uses canonical `Recordings` plus
provider-supplemental data from `ProviderItems.data`. Sidecar upserts now carry
provider/canonical identity and can link directly to the owning `TrackFiles` row.
Regression: `library-metadata-backfill.test.ts` covers canonical-only album/video
sidecar discovery with zero legacy provider rows. Full suite green.

**Progress (2026-06-18, continued):** `metadata-files.ts` no longer has direct
`ProviderAlbums`/`ProviderMedia` reads. Local NFO/artwork fallbacks now resolve
album metadata, selected releases, reviews, track lists, video metadata, and
artist/album MBIDs from `ProviderItems` + canonical `Albums`/`AlbumReleases`/
`Tracks`/`Recordings`. Regression:
`metadata-files.test.ts` now covers album/video NFO fallback with zero legacy
provider rows.

**Progress (2026-06-18, continued):** `lyric-service.ts` no longer reads
`ProviderMedia`/`ProviderAlbums`. The remaining metadata lyric helper still
accepts provider track ids, but resolves them through `ProviderItems` and
canonical `Tracks`/`Recordings`; cached counterpart lyrics are matched by
provider id, track MBID, or recording MBID. Regression: `metadata-files.test.ts`
covers stereo-to-spatial lyric sharing with zero legacy provider rows.

Remaining order:

1. **Finish Phase 2 readers** still on legacy as PRIMARY: `organizer.ts` (also a
   writer — video INSERT/UPDATE). `library-file-identity.ts`
   still has the final legacy fallback to remove right before the Phase 5 drop.
   `audio-tag-service.ts` retag context is now canonical/provider-item first,
   but its compatibility fallbacks and MB/AcoustID write-backs remain legacy.
   `upgrader.ts` now scans canonical `TrackFiles` + `ProviderItems`; its
   remaining legacy coupling is the `upgrade_queue` ledger re-key, not provider
   catalog reads.
2. **Phase 3 — write path.** The `repositories/music/*Repository.ts` files the
   original plan called "keystones" were dead code (zero imports) and have been
   deleted; the active write SQL is inline in the services. Cut over
   `refresh-album-service` (supplement-field homing started; legacy compatibility
   writes still present), `import-service`, `manual-import-service`,
   `organizer`, `audio-tag-service`, `library-scan`, and
   `metadata-identity-service` to write canonical + `ProviderItems`.
3. **Phase 4 — housekeeping.** Monitor-gap repair and the
   `DownloadMissingForce` skip reset are canonical/retired. Remaining
   housekeeping work is Phase-5 compatibility cleanup for legacy `TrackFiles`
   provider ids plus any provider-only discovery code that cannot be driven from
   MusicBrainz/SkyHook.
4. **Phase 5 — numbered schema migration** dropping the six `Provider*` tables +
   `TrackFiles.media_id`/`album_id`, with a one-time backfill guard.

## 8. Phase 1 dry-run result (re-link safety check)

Read-only check against a real-data DB (the dev `./config` DB, post-import):

- 18 `TrackFiles`, **all** with both legacy linkage (`media_id`/`album_id`) AND
  all canonical mbids (`canonical_recording_mbid`, `canonical_track_mbid`,
  `canonical_release_group_mbid`) populated.
- **0 orphan-risk rows** (no row has a `media_id` without a
  `canonical_recording_mbid`).
- **100% resolve:** every `canonical_recording_mbid` → a real `Recordings` row;
  every `canonical_release_group_mbid` → a real `Albums` row.

So switching `TrackFiles` lookups/dedup to the canonical columns orphans nothing
on current data — the AcoustID/MBID embedding work already populates them on
import/download. **Caveat:** a large/older library may hold pre-canonical rows;
Phase 1 still needs the gap-fill maintenance pass + re-run this dry-run on real
libraries before flipping reads.

### Phase 1 progress (2026-06-18)

- ✅ **Gap-fill maintenance pass shipped** — `backfillCanonicalTrackFiles()` in
  `runtime-maintenance.ts` runs inside the housekeeping transaction. For any
  `TrackFiles` row that still relies on legacy `media_id`/`album_id` and is
  missing a canonical id, it resolves via the shared `resolveLibraryFileIdentity`
  and COALESCE-fills the `canonical_*_mbid` columns (NULL-only, never overwrites;
  idempotent). Reports `canonicalTrackFilesBackfilled` in the maintenance summary.
  Tests: `runtime-maintenance-backfill.test.ts` (fill, no-overwrite/idempotent,
  skip-no-linkage, no-op-when-full).
- ✅ **Dry-run re-validated on real post-download DB** — 94 `TrackFiles`, 0 gap
  rows, 0 orphan-risk, 100% of canonical ids resolve to real `Recordings`/`Albums`.
  New downloads/imports populate the canonical columns on write, so the gap-fill
  is a safe no-op on healthy data (its value is legacy/older libraries).
- ✅ **Lookup/dedup canonical-switch started.** `runtime-maintenance.dedupeLibraryFiles`
  now runs a canonical duplicate pass keyed by
  `(canonical_recording_mbid, file_type, library_slot)` alongside the legacy
  `(media_id, file_type)` pass. This catches duplicate files for the same
  recording inside one slot without merging legitimate stereo/spatial copies.
- ⬜ **Remaining schema/import identity switch.** Deliberately deferred — it is
  entangled with the import write-path (Phase 3) and a schema change, so it is
  NOT independently low-risk:
  - The UNIQUE index `idx_track_files_media_identity (media_id, file_type)` and the
    import upsert's ON CONFLICT target are media-id-based; switching them to a
    canonical `(canonical_recording_mbid, file_type, library_slot)` identity is a
    numbered schema migration that belongs with the Phase 3 write-path cutover.
  - Remaining read/write lookups (organizer, the audio-tag MB/AcoustID
    write-back + compatibility fallbacks, and the final file-identity fallback)
    still touch legacy provider tables; these move in Phase 2/3 or the final
    pre-Phase-5 cleanup. `upgrader.ts` now scans canonical `TrackFiles` +
    `ProviderItems`; its remaining schema work is re-keying `upgrade_queue`
    away from legacy `media_id`/`album_id`.

Keep `media_id`/`album_id` as shadow columns until Phase 5.

### Phase 2 progress (2026-06-18)

- ✅ **`library-files-query-service` read-path cutover started** — library-file
  listings now carry canonical/provider identity from `TrackFiles`, derive video
  status from `Recordings`/`library_slot`, and read source/album quality from
  `ProviderItems` scalar lookups instead of joining `ProviderMedia` and
  `ProviderAlbums`. Legacy `album_id`/`media_id` response fields remain for API
  compatibility while callers migrate. Regression:
  `library-files-query-service.test.ts` proves a canonical-only file with no
  legacy provider rows still receives its provider source quality and avoids an
  impossible upgrade above provider availability.
- ✅ **`command-history` activity description cutover** — activity/history task
  descriptions for `DownloadAlbum`, `DownloadTrack`, `DownloadVideo`,
  `RefreshAlbum`, and `ScanAlbum` now resolve provider refs through
  `ProviderItems` plus `ArtistMetadata`/`Albums`/`AlbumReleases`/`Tracks`/
  `Recordings`, with payload text as the legacy-job fallback. The service no
  longer references `ProviderAlbums` or `ProviderMedia`. Regression:
  `activity.test.ts` covers canonical-only album/track/video download jobs with
  zero legacy provider rows; browser smoke verified `/api/v1/history/activity`
  returns the canonical descriptions from a temp runtime DB.
- ✅ **`scan-refresh-state` cutover** — provider catalog track/video freshness now
  uses `ProviderItems.updated_at` joined by canonical album release/release-group
  and artist MBID identity, rather than `ProviderMedia.last_scanned`.
  Regression: `scan-refresh-state.test.ts` covers fresh, missing, and stale
  canonical-only track/video provider items with zero legacy provider rows.
- ✅ **`refresh-policy` cutover** — artist active/inactive release freshness now
  reads canonical `Albums.first_release_date`, and the exported track/video
  freshness helpers use `ProviderItems.updated_at` joined through canonical
  release and artist identity instead of legacy provider scan columns.
  Regression: `refresh-policy.test.ts` covers recent/inactive artists plus
  fresh/stale canonical-only track/video provider items with zero legacy provider
  rows.
- ✅ **`providers/tidal/tidal-provider` read fallback cutover** — TIDAL album
  download-progress track info still prefers selected canonical `Tracks`, but
  when no canonical release is selected yet it now falls back to album/track
  `ProviderItems` instead of `ProviderMedia`. Regression:
  `tidal-provider-canonical.test.ts` covers provider-only album/track items with
  zero legacy provider rows.
- ✅ **`import-matcher-service` fingerprint candidate cutover** — fingerprinted
  local files now resolve candidate album provider ids through canonical
  `TrackFiles` MBIDs plus album/track `ProviderItems` instead of joining
  `ProviderMedia`. Regression: `import-matcher-service.test.ts` covers a
  canonical-only fingerprint match with zero legacy provider rows.
- ✅ **`library-metadata-backfill` cutover** — missing sidecar discovery no
  longer joins `TrackFiles` to `ProviderMedia`/`ProviderAlbums`. Album sidecars
  are keyed by canonical release group + slot + album `ProviderItems`; lyrics,
  video thumbnails/NFOs, and video tag candidates use `TrackFiles.provider_id`
  plus `ProviderItems`, with provider/canonical identity written into sidecar
  rows. Regression: `library-metadata-backfill.test.ts` covers canonical-only
  album/video sidecar discovery with zero legacy provider rows.
- ✅ **`metadata-files` cutover** — local NFO/artwork fallback helpers now read
  canonical album/release/track/video metadata plus `ProviderItems` instead of
  `ProviderAlbums`/`ProviderMedia`.
  Regression: `metadata-files.test.ts` covers canonical-only album/video NFO
  fallback with zero legacy provider rows.
- ✅ **`lyric-service` cutover** — cached lyric sharing for provider track ids now
  resolves from `ProviderItems`, `Tracks`, `Recordings`, and canonical
  `LyricFiles` fields instead of `ProviderMedia`/`ProviderAlbums`. Regression:
  `metadata-files.test.ts` covers a stereo cached lyric shared to a spatial
  provider item with zero legacy provider rows.
- ✅ **`rename-track-file-service` sidecar replication cutover** — separated-root
  sidecar replication no longer joins through legacy provider album/track titles.
  Album sidecars are matched by canonical release group via album
  `ProviderItems`, lyrics are matched by canonical track/recording identity, and
  direct sidecar rename applies now fetch provider/canonical fields consistently.
  Regression: `rename-track-file-service.test.ts` covers canonical-only lyric
  replication with zero legacy provider rows and album cover replication where
  legacy provider titles intentionally disagree.
- ✅ **`audio-tag-service` retag context cutover** — retag previews/tag target
  construction now hydrate canonical `Tracks`/`Recordings`/`AlbumReleases` plus
  exact `ProviderItems` before legacy provider rows. MusicBrainz recording
  credits and `AlbumArtists` drive Artist/Album Artist tags, provider track ids
  drive provider URLs, and provider album UPC/track explicit flags fill holes
  without `ProviderAlbums`/`ProviderMedia`. The remaining legacy refs in this
  file are compatibility fallbacks plus MB/AcoustID enrichment write-backs for
  Phase 3. Regression: `audio-tag-service-canonical.test.ts` covers target tags
  from canonical/provider-item rows with zero legacy provider rows.
- ✅ **`organizer` exact track helper partial cutover** — the canonical album
  import helper that resolves an exact provider track id now reads
  `ProviderItems.match_evidence` and canonical `Tracks` directly instead of
  joining `ProviderMedia` for fallback title/position/MBID fields. The broader
  organizer album fallback, single-track import, video import, and write paths
  remain on the legacy list. Regression: `organizer-canonical.test.ts` covers
  exact provider track resolution with zero legacy media rows.
- ✅ **`upgrader` scan cutover** — `CheckUpgrades` now scans installed
  `TrackFiles` through canonical/provider identity and `ProviderItems` instead
  of joining `ProviderMedia`/`ProviderAlbums`. Canonical-only audio tracks queue
  album-level upgrade downloads where possible, canonical-only videos queue
  video upgrades, and forced/manual runs now enable the effective redownload
  profile even when the persisted `upgrade_existing_files` setting is false.
  The only remaining upgrader legacy coupling is the transitional
  `upgrade_queue` ledger, which is still keyed to legacy `media_id`/`album_id`
  until the schema re-key. Regression: `upgrader-canonical.test.ts` covers
  audio and video upgrade queuing with zero legacy provider rows.
