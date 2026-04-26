# Discogenius Standalone-First Architecture

## Product Decision

Discogenius is a standalone music-library automation app.

Lidarr, Tidarr, Jellyfin, and Kometa are useful references or future integration targets, but Discogenius should not require them for its core workflow. The target remains:

> Lidarr-like library automation, but with streaming-service availability and Discogenius curation rules.

The current implementation direction is intentionally breaking: new work should move code to the
MusicBrainz/Lidarr-style domain and should not preserve TIDAL-primary IDs or track-monitoring behavior
for upgrade compatibility.

## What Standalone Means

Discogenius owns these domains internally:

- metadata catalog,
- curation and wanted state,
- provider availability resolution,
- acquisition/download queue,
- import, tagging, NFO, and file organization,
- local playback of imported files,
- health, history, and user-facing status.

External services can be optional adapters later, not required control planes.

## Reference, Not Dependency

Lidarr should be used as an architectural reference for:

- workflow boundaries,
- MusicBrainz-first metadata,
- release-group vs exact-release modeling,
- wanted/missing semantics,
- queue/history/health concepts,
- import and file lifecycle structure.

Discogenius should not use Lidarr as the source of truth for:

- monitored releases,
- wanted lists,
- provider matching,
- download decisions,
- library file state.

## Core Boundaries

### 1. Metadata Catalog

MusicBrainz-first.

Discogenius should model:

- artist metadata,
- release groups as album concepts,
- exact MusicBrainz releases as editions,
- recordings/tracks,
- provider-neutral identifiers: MBIDs, ISRCs, UPCs.

Streaming providers may enrich this data, but provider catalog payloads should not define the canonical model.

The target monitoring model follows Lidarr's artist -> album concept -> exact release shape. Tracks are expected from the selected exact release; they are not the default curation monitor unit.

Current canonical tables:

- `artist_metadata`
- `managed_artists`
- `release_groups`
- `album_releases`
- `tracks`
- `release_group_monitoring`
- `track_files`
- `provider_releases`
- `provider_tracks`
- `videos`
- `provider_videos`
- `video_files`

### 2. Curation

Discogenius decides what the library wants before provider lookup.

Curation should produce deterministic wanted state from:

- monitored artists,
- release type settings,
- standard/deluxe/complete edition preference,
- explicit/clean preference,
- quality profile,
- redundancy filter,
- manual monitor locks.

Provider availability should not be the first input to curation. It is a filter applied after the desired catalog is known.

### 3. Provider Availability

Providers answer:

> Which available provider item satisfies this wanted MusicBrainz release or recording?

Matching should use:

- UPC for exact release matching,
- ISRC for recording matching,
- strict tracklist scoring as fallback,
- quality and spatial-audio capability,
- region/account availability.

This layer should be pluggable so TIDAL and Apple Music can coexist later.

### 4. Wanted List

Discogenius needs a clearer first-class wanted concept.

The wanted list should contain curation output plus provider resolution status:

- wanted release/video,
- curation reason,
- selected exact release,
- selected provider candidate, if any,
- blocked/unavailable reason,
- current file/import state.

This lets the UI explain why something is monitored, skipped, redundant, missing, queued, downloading, imported, or unavailable.

Normal music wanted items are release-level. Track-level wanted rows are not part of core discography curation; tracks are derived from the selected exact release. Music-video wanted rows are Discogenius-specific.

### 5. Acquisition And Import

Acquisition should consume wanted/provider-resolved items.

It should not decide curation policy inline. Download code should receive a concrete acquisition target and report status.

Import should verify files, attach MusicBrainz/provider identity, write tags and sidecars, and update library file state.

### 6. Playback

The default player should stream local imported files through Discogenius' file API.

Provider playback can exist as preview/fallback, but it should not be the core library playback path.

## Immediate Refactor Direction

1. Move all new curation/wanted work to the canonical MusicBrainz/Lidarr-style tables.
2. Stop writing track monitor state from curation.
3. Keep provider-specific search/download assumptions behind provider-resolution interfaces.
4. Keep release identity MusicBrainz-first: release group for album concepts, exact release for selected editions, recordings/ISRCs for redundancy.
5. Preserve manual locks and make automated decisions explainable in the new model only.

## Deferred Integrations

These can be useful later, but should not steer the core build:

- Lidarr sidecar or plugin,
- Kometa reporting/collection integration,
- Jellyfin/Navidrome playback/library sync,
- Tidarr-compatible indexer/download-client mode.

The standalone workflow should remain complete without any of them.
