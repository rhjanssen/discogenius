# Discogenius Data Model Direction

> **2.8.0 / schema 41 target:** The former fixed-slot and generic provider-match
> design below describes the pre-cutover tree and is superseded by
> [SCHEMA_41_AUTHORITY_CUTOVER.md](SCHEMA_41_AUTHORITY_CUTOVER.md). Schema 41
> makes canonical facts, provider facts, typed match evidence, and per-library
> curation/acquisition independent authorities. The historical material remains
> here only until all runtime callers have been migrated and the document can be
> consolidated without losing implementation context.

This document describes the current data-model rules and the direction for new
schema/provider work. It is not a migration log. Current schema details live in
`api/src/database.ts`; release blockers and future work live in `docs/TASKS.md`.

## Current Rules

1. MusicBrainz/Servarr Metadata Server is the catalog source of truth in the shipping app.
2. Streaming providers are availability and acquisition resources only.
3. Providers must not create canonical artists, release groups, releases,
   tracks, or recordings by themselves.
4. Provider UPC/barcode and ISRC are matching evidence. In normal Servarr Metadata Server mode
   they stay provider-scoped and are not copied into catalog barcode/ISRC fields.
5. Provider data may supplement catalog holes where it directly improves library
   management: artwork asset ids, copyright, replay gain/peak, provider URLs,
   availability, and download facts.
6. Provider-only discovery features should be removed unless they can be
   re-sourced from MusicBrainz/Servarr Metadata Server.

## Current Schema Shape

### Canonical Catalog

Core catalog tables:

- `ArtistMetadata`, `Artists`, `ArtistStatistics`
- `Albums` for MusicBrainz release groups
- `AlbumEditions` for MusicBrainz releases
- `Tracks` for release-specific track positions
- `Recordings` for canonical recording-level identity: MusicBrainz audio and
  video recordings
- `AlbumArtists`, `ArtistReleaseGroups`, `ArtistReleaseGroupCuration`
- `RecordingRelations`

`Recordings` intentionally exists separately from `Tracks`: a recording can
appear on many releases, and a standalone music video may have no release track
row at all.

### Provider Offers And Matches

`ProviderItems` is the provider resource cache. Its identity is the full
`(provider, entity_type, provider_id)` triple, or its surrogate `id`.
`ProviderEditionMembers` represents track/video occurrences on provider
editions, and `ProviderItemAudioVariants` represents source capabilities.

`ProviderArtistMatches`, `ProviderEditionMatches`, `ProviderTrackMatches`, and
`ProviderVideoMatches` are the only provider-to-MusicBrainz edges. Provider
items do not carry MusicBrainz shadow identity.

An unmatched provider video remains a cached `ProviderItems` offer. It must not
mint a provisional `Recordings` row or an accepted match. Every identity-bearing
`ProviderVideoMatches` target is an existing MusicBrainz video recording; a
provider-supplied MBID is matching evidence, not authority to create that row.

There are no active provider catalog tables such as `ProviderAlbums` or
`ProviderMedia`.

### Library Overlay

`Libraries`, `LibraryAlbums`, and `LibraryEditions` store per-library curation.
Acquisition plans choose accepted typed provider matches for a selected edition.
No album-wide “selected edition” is assumed.

### File And Sidecar Inventory

`TrackFiles` is the playable media inventory. The name is intentionally
Lidarr-aligned: Lidarr uses `TrackFile` for managed playable music files. In
Discogenius it also covers playable music videos because videos are first-class
downloaded media, not sidecars. Each row belongs to exactly one configured
library through `library_id`; root-only assignment fails closed when zero or
several libraries match.

`MetadataFiles`, `LyricFiles`, and `ExtraFiles` are the Lidarr-style sidecar
inventories for artwork, NFO, lyrics, and other extra files. One physical
sidecar can be referenced by multiple libraries through
`MetadataFileLibraries`, `LyricFileLibraries`, or `ExtraFileLibraries`.
`library_slot` is not an ownership relation.

Existing `canonical_*` file columns and nullable provider-resource shadow ids
are transitional debt. New work should prefer clear provider provenance fields,
integer FKs where they are already available, and neutral MBID names only where
file-level MBID provenance is required.

Do not rename `TrackFiles` to `MediaFiles` as part of cleanup unless there is a
specific maintenance win that outweighs Lidarr parity and churn across import,
rename, sidecar, and query services.

## Provider Abstraction Direction

The provider layer should support multiple providers without schema changes:

- One row per provider resource, not one table or column per provider.
- Provider capability descriptors for audio, spatial audio, video, lyrics,
  download, search, and followed/favorite import.
- Provider-neutral quality decisions with per-provider mapping.
- A `DownloadBackend` per provider. TIDAL uses tiddl; Apple Music or other
  providers should bring their own backend.
- Config-driven active/default provider selection.
- Provider manifests describe the integration source, auth fields, download
  backends, stable resource IDs, import-source categories, and diagnostics. The
  current contract and provider research live in
  `docs/STREAMING_PROVIDER_PLUGIN_CONTRACT.md`.

TIDAL remains the most exercised provider. Every provider, including adapters
that are experimental or disabled pending credentials, uses the same contract.

## Catalog Source Direction

The `CatalogProvider` abstraction is the planned seam between:

- `ServarrMetadataCatalogProvider`: current normal mode, backed by Servarr Metadata Server/MusicBrainz
  replica flows.
- `LocalMusicBrainzCatalogProvider`: future MB-local mode, backed by a local
  MusicBrainz-docker `/ws/2` mirror first and direct Postgres later only if
  needed for performance.

Local MusicBrainz mode reads Postgres during refresh and **replicates** scoped
catalog into Discogenius SQLite (same write path as Servarr). It is not a
live-query-only UI backend and does not require flushing the SQLite catalog on
every request.

**Mode switching (current):** flipping `catalog.source` swaps
`CatalogProvider` only. The next refresh hydrates from the new source into the
same SQLite tables. Servarr typically lacks ISRC/UPC; MB-local fills them.
App state (monitoring, slots, files, matches) is keyed by MBID and is not
deleted by the toggle; matching/curation/library can still change after a
refresh rematch. Prefer MBID-value references over cascading FKs into catalog
tables for future schema hygiene.

Do **not** implement the older “flush SQLite + live-query Postgres only” switch
design unless architecture deliberately changes — see `docs/MB_LOCAL_MODE.md`
and `docs/TASKS.md`.

Local MusicBrainz mode may still use the Servarr Metadata Server as a
supplemental metadata service for fields that MusicBrainz-docker does not serve
well, such as cached/normalized artwork URLs or metadata-server ratings.
Supplemental Servarr data must not override MusicBrainz identity, release
grouping, track identity, UPC/ISRC evidence, or provider-resource evidence.

## Matching Direction

Release-centric matching is the desired end state:

1. Provider albums match candidate MusicBrainz releases directly.
2. Release groups are fetch/grouping containers, not matching constraints.
3. Direct identity decisions live only in the typed `ProviderEditionMatches`
   and `ProviderTrackMatches` tables. Multi-source coverage is materialized in
   `AcquisitionPlanSources` and `AcquisitionPlanTracks`, never in a generic
   provider-match graph.
4. Matching evidence order is external streaming links, UPC/ISRC, track/medium
   shape, title/version, date/type, position/duration, and title distance.
5. Servarr Metadata Server mode must degrade gracefully when UPC/ISRC or external-link data is
   unavailable.

The design is detailed in `docs/MATCHING_SET_COVER_DESIGN.md`; remaining work is
tracked in `docs/TASKS.md`.

## Library Type Direction

The current fixed stereo/spatial/video slots should become configurable library
types:

- name
- root/location
- content kind: audio or video
- desired quality

Release-type filtering remains global. A monitored artist's discography can be
downloaded into every applicable library type, so one recording may exist as
lossless, lossy, Atmos, and video versions across separate roots.
