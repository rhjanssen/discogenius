# Lidarr DB Alignment — Legacy Provider Table Retirement Plan

**Status:** Proposal for review. No code changes yet.
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
| Similar artists/albums | (provider `data` / future) | `ProviderSimilarArtists`, `ProviderSimilarAlbums` |
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

- Canonical identity: `ArtistMetadata` / `Artists` → `Albums` (RG) →
  `AlbumReleases` → `Tracks` → `Recordings`. (Already in place.)
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
`ProviderMedia`/`ProviderAlbums`. Move similar-artist/album storage off
`ProviderSimilar*` (either drop, or fold into `ProviderItems.data`/a small
canonical relation).

**Phase 5 — Drop legacy tables.**
Once nothing reads or writes them: drop `ProviderAlbums`, `ProviderMedia`,
`ProviderAlbumArtists`, `ProviderMediaArtists`, `ProviderSimilarArtists`,
`ProviderSimilarAlbums`, and the now-unused `TrackFiles.media_id`/`album_id`
columns, via a numbered schema migration (bump `user_version`). Keep a one-time
data-migration guard so existing DBs backfill before the drop.

## 4. Distinguishing features to PRESERVE (do not "align away")

- `ReleaseGroupSlots` (stereo/spatial/video slot model) — core to multi-library
  + Atmos support; Lidarr has no equivalent.
- `ProviderItems` as availability-only, keyed to canonical mbids — the
  "providers never create canonical entities" rule from AGENTS.md.
- Curation/dedup (`ArtistReleaseGroupCuration`) — Discogenius's discography
  dedup on top of Lidarr's release-type filtering.

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
