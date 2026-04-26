# Discogenius Product Repair Plan

Last updated: 2026-04-26

## Product Target

Discogenius should be a standalone Lidarr-like music library automation app, but built around streaming-service acquisition and Discogenius curation.

The core product is:

- artist monitoring and discography management,
- MusicBrainz-first metadata with provider availability layered on later,
- redundancy filtering so singles/subset releases do not clutter the wanted library when their recordings are already covered,
- simpler quality decisions than Lidarr,
- separate stereo music, spatial audio, and music video libraries,
- local import, tagging, NFO/sidecar generation, and playback without depending on Lidarr, Jellyfin, Tidarr, or Kometa.

The monitoring model should follow Lidarr closely:

- artist monitored,
- album concept monitored,
- one selected exact release/edition monitored under that album concept,
- tracks expected from the selected release rather than independently monitored by default,
- music videos as Discogenius' extra monitored media type.

Reference projects remain useful:

- Lidarr: workflow boundaries, MusicBrainz metadata model, wanted/missing semantics, import lifecycle, health/history patterns.
- Tidarr: TIDAL acquisition experiments and playback/provider behavior to study, not the app control plane.
- Jellyfin: local media streaming/playback behavior to study, not the library automation source of truth.

## Reality Check

The current app has useful working parts, but too many of them overlap:

- curation, wanted state, and queueing were partly duplicated,
- provider IDs are still app identity in many paths,
- large backend services own too many concerns at once,
- playback has both provider-preview and local-file responsibilities,
- frontend pages are very large and mix control-plane state, presentation, and workflow actions.
- the current `albums` table still mixes Lidarr's album concept, exact release, and provider candidate roles.

The repair strategy is now a breaking domain migration. Existing installations may need to start with a fresh database. New implementation work should move toward the canonical MusicBrainz/Lidarr-style model instead of preserving TIDAL-primary tables as the source of truth.

## Core Architecture

### 1. Metadata Catalog

Discogenius owns a canonical catalog graph:

- Artist
- Release Group as the broad album concept
- Exact Release as the edition/tracklist/UPC object
- Recording/Track with ISRCs
- Provider candidates mapped to canonical items

MusicBrainz should be primary for canonical metadata. TIDAL, Apple Music, and other providers answer availability and acquisition questions.

### 2. Curation

Curation decides what Discogenius wants before provider lookup.

Inputs:

- monitored artist state,
- release type settings,
- stereo/spatial/video library settings,
- Lidarr-style release-group selection with one selected exact release,
- explicit/clean preference,
- redundancy rules,
- manual monitor locks.

Outputs:

- monitored releases/tracks/videos,
- redundancy reasons,
- wanted items,
- explainable skip/unavailable states.

MusicBrainz release groups define the album concept, matching Lidarr. Discogenius selects one exact MusicBrainz release beneath that group, normally preferring the existing selection and then the largest track count, with provider availability only as a tie-breaker. Redundancy filtering then works across selected releases by recording/ISRC/title coverage so singles can be suppressed when a wanted album already covers them.

Core music curation chooses releases, not individual tracks.

### 3. Wanted List

Wanted state is the bridge between curation and acquisition.

It must answer:

- what is missing,
- why it is wanted,
- whether a queue/import job already covers it,
- whether it is blocked by provider availability,
- which library root it belongs to.

Queueing should consume wanted state. It should not re-implement missing-item discovery.

### 4. Provider Availability

Provider resolution is separate from catalog and curation.

For each wanted item, provider matching should try:

- exact UPC to provider album,
- exact MusicBrainz release where available,
- ISRC coverage for tracks,
- strict tracklist scoring as fallback,
- account/region availability,
- quality and spatial/video capability.

TIDAL is the first provider. Apple Music support should fit the same shape later.

### 5. Acquisition and Import

Acquisition consumes a concrete wanted/provider target and emits structured progress. Import verifies files and commits them into the managed library.

Download backends are adapters:

- Orpheus for current music downloads,
- tidal-dl-ng for current video downloads,
- future tiddl/other tools only if they can satisfy the same contract.

### 6. Local Playback

Discogenius' player should prefer local imported files through the local file API. Provider playback is preview/fallback behavior.

Stereo, spatial, and video playback need explicit capability handling rather than one generic streaming path.

## Release Repair Rules

1. Prefer the canonical MusicBrainz/Lidarr-style tables over legacy TIDAL-primary tables for all new work.
2. Do not model track monitoring as core discography curation.
3. Do not let provider availability define the canonical catalog.
4. Do not let queueing duplicate wanted/missing logic.
5. Do not add frontend controls without a backend contract that explains state.
6. Every release candidate must pass API build, API tests, lint, build, and smoke tests before release.
7. Playback changes must be tested with local files first, provider playback second.

## Execution TODOs

### Batch 1: Stabilize Product Boundaries

- [x] Document standalone-first architecture and defer Lidarr/Kometa sidecars.
- [x] Document Lidarr's actual artist/album/release monitoring model.
- [x] Add a first-class wanted-list read model over canonical release/video tables.
- [x] Make curation download queueing consume wanted state instead of duplicating missing-item discovery.
- [x] Preserve locked monitored items as wanted user intent.
- [x] Avoid requeueing albums with imported files but missing track rows.
- [x] Label wanted items by monitor scope so release and video targets are not conflated.
- [x] Add provider-resolution status to wanted items: matched/missing vs unavailable provider candidate.
- [ ] Add a wanted-page/frontend surface that explains curation and queue state.

### Batch 2: Make Metadata MusicBrainz-First

- [x] Add exact MusicBrainz release cache and UPC/barcode matching foundation.
- [x] Keep exact-release identity out of broad release-group dedup keys.
- [x] Add artist/release-group/release catalog tables that can represent MusicBrainz data without TIDAL IDs as the model.
- [x] Split provider candidates from album concepts and exact releases, matching Lidarr's `Album`/`AlbumRelease` separation.
- [ ] Move refresh flows toward DB-first metadata reads.
- [x] Add provider candidate tables for TIDAL albums/tracks/videos mapped to canonical releases/recordings.
- [ ] Add low-priority MusicBrainz enrichment jobs for UPC and ISRC lookups.

### Batch 3: Formalize Discography Curation

- [x] Extract curation decision building from `curation-service.ts` DB mutation.
- [x] Persist curation decisions with reason codes.
- [x] Stop treating track monitor state as core curation output.
- [ ] Add deterministic edition grouping tests for standard, deluxe, anniversary, remaster, clean/explicit, and Atmos variants.
- [ ] Add redundancy tests for ISRC subsets, track-title fallback subsets, missing ISRCs, and multi-disc editions.
- [ ] Add a manual override model that cleanly separates locked wanted, locked skipped, and automatic decisions.

### Batch 4: Simplify Quality and Library Types

- [ ] Replace Lidarr-style profile complexity with Discogenius profiles: stereo, spatial, video.
- [ ] Route stereo, Atmos/spatial, and video to explicit library roots.
- [ ] Add quality capability checks to wanted/provider resolution before download.
- [ ] Surface "available but not in requested quality" separately from "not available".

### Batch 5: Acquisition and Import Contract

- [ ] Add a provider/backend download request contract with provider ref, media traits, workspace, and correlation ID.
- [ ] Move Orpheus and tidal-dl-ng behind backend adapters.
- [ ] Keep CLI parsing inside adapters and emit structured Discogenius events.
- [ ] Make import consume artifacts from the backend contract instead of guessing from workspace layout.
- [ ] Add retry/failure reasons that are queryable from wanted and history.

### Batch 6: Playback Repair

- [ ] Make local-file playback the default player path.
- [ ] Split provider preview playback from library playback.
- [ ] Add range/seek tests for audio and video.
- [ ] Evaluate Jellyfin's playback approach for transcoding and browser compatibility.
- [ ] Add a frontend player that chooses local stereo/spatial/video sources predictably.

### Batch 7: Frontend Repair

- [ ] Split oversized dashboard/settings pages into feature components backed by stable API contracts.
- [ ] Add a curation/wanted view before adding more queue buttons.
- [ ] Make artist pages show catalog, curation, provider availability, and local files as separate states.
- [ ] Keep empty/error/loading states explicit and non-blocking.
- [ ] Add Playwright smoke tests for artist add, wanted queueing, local playback, and settings save.

## Current Execution Batch

The active batch is the breaking Lidarr-domain migration. The immediate implementation goal is to move refresh/search/UI pages off legacy `artists`/`albums`/`media` provider-primary rows and onto `artist_metadata`, `managed_artists`, `release_groups`, `album_releases`, `tracks`, provider candidate tables, and release/video wanted state.
