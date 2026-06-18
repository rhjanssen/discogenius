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
| Local files | `TrackFiles` (`canonical_*_mbid` cols) + `media_id`/`album_id` → legacy ids | — |
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
housekeeping (`runtime-maintenance.repairMonitoringGaps` still writes
`ProviderMedia`/`ProviderAlbums`).

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
Rewrite `runtime-maintenance.repairMonitoringGaps` to operate on
`ReleaseGroupSlots`/`Recordings` (canonical monitored state) instead of
`ProviderMedia`/`ProviderAlbums`. Remove provider-only discovery sections such as
similar artists/albums unless they can be driven from MusicBrainz/SkyHook data.
Do not migrate `ProviderSimilar*` into another provider-catalog table just to
preserve a non-core UI section.

**Phase 5 — Drop legacy tables.**
Once nothing reads or writes them: drop `ProviderAlbums`, `ProviderMedia`,
`ProviderAlbumArtists`, `ProviderMediaArtists`, `ProviderSimilarArtists`,
`ProviderSimilarAlbums`, and the now-unused `TrackFiles.media_id`/`album_id`
columns, via a numbered schema migration (bump `user_version`). Keep a one-time
data-migration guard so existing DBs backfill before the drop.

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
- Provider data may supplement holes in canonical rows where MusicBrainz/SkyHook
  lacks a field needed for a library-manager workflow (e.g. artwork asset ids,
  video copyright, provider URLs, download availability), but the core app should
  remain MusicBrainz/SkyHook-primary. Provider-exclusive, non-essential discovery
  features such as similar artists/albums or top tracks should be removed rather
  than preserved through new provider catalog tables.

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
- `services/metadata/metadata-identity-service.ts`, `services/metadata/version-grouper.ts`.
- `services/config/module-fixer.ts` — one-time repair UPDATEs.
- `services/jobs/runtime-maintenance.ts` (`repairMonitoringGaps`) + `scheduler-maintenance-handlers.ts` — **Phase 4**.

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
progress fallback, `import-matcher-service`; lyric-service has a legacy
`ProviderMedia` fallback that should later become a `ProviderItems` path).
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

Remaining order:

1. **Finish Phase 2 readers** still on legacy as PRIMARY: `organizer.ts` (also a
   writer — video INSERT/UPDATE), `metadata-files.ts`,
   `audio-tag-service.ts` (also a writer), `quality.ts`/`upgrader.ts` (entangled
   with `upgrade_queue`'s legacy `media_id`/`album_id` FKs). `lyric-service.ts` and
   `library-file-identity.ts` use legacy only as a FALLBACK after `ProviderItems`
   — remove those right before the Phase 5 drop.
2. **Phase 3 — write path.** The `repositories/music/*Repository.ts` files the
   original plan called "keystones" were dead code (zero imports) and have been
   deleted; the active write SQL is inline in the services. Cut over
   `refresh-album-service`, `import-service`, `manual-import-service`,
   `organizer`, `audio-tag-service`, `library-scan`, `metadata-identity-service`,
   `version-grouper`, `module-fixer` to write canonical + `ProviderItems`.
3. **Phase 4 — housekeeping.** Repoint/retire `repairMonitoringGaps` +
   `scheduler-maintenance-handlers` to canonical monitored/skip state; remove
   provider-only similar/top-track discovery code unless a MusicBrainz/SkyHook
   source can drive it.
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
  - Remaining read-path lookups (`lyric`, `audio-tag`, organizer,
    metadata-backfill, rename) still join `TrackFiles.media_id → ProviderMedia →
    ProviderAlbums`; these move in Phase 2.

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
