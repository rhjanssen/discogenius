# Discogenius Data Model Direction

Last updated: 2026-06-23

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
- `AlbumReleases`, `AlbumReleaseMedia`
- `Tracks` for release-specific track positions
- `Recordings` for recording-level identity, audio recordings, MusicBrainz
  video recordings, and provider-only provisional videos
- `AlbumArtists`, `ArtistReleaseGroups`, `ArtistReleaseGroupCuration`
- `RecordingRelations`

`Recordings` intentionally exists separately from `Tracks`: a recording can
appear on many releases, and a standalone music video may have no release track
row at all.

### Provider Offers And Matches

`ProviderItems` is the provider offer cache. It stores provider-native ids,
provider album ownership for tracks/videos, quality/availability facts, artwork
or provider URL supplements, provider UPC/ISRC evidence, compact provider data,
and canonical links when a match is known.

`ProviderItemMatches` is the provider-to-MusicBrainz match graph. It stores
candidate/probable/verified/manual/rejected edges from provider resources to
MusicBrainz artists, releases, tracks, or recordings. Composite release coverage
is represented here as first-class match rows.

There are no active provider catalog tables such as `ProviderAlbums` or
`ProviderMedia`.

### Library Overlay

`ReleaseGroupSlots` stores policy and selection per release group and library
slot. The shipping slots are still fixed as stereo, spatial, and video. A slot
can select its own MusicBrainz release and provider offer; stereo and spatial
slots must not be collapsed to one release-group-wide representative.

Future configurable library types should replace fixed slot names with
library-type ids while preserving monitored and lock semantics.

### File And Sidecar Inventory

`TrackFiles` is the playable media inventory. It stores file facts, provider
provenance, canonical identity, quality, and the library slot.

`MetadataFiles`, `LyricFiles`, and `ExtraFiles` are the Lidarr-style sidecar
inventories for artwork, NFO, lyrics, and other extra files.

Existing `canonical_*` file columns and nullable provider-resource shadow ids
are transitional debt. New work should prefer clear provider provenance fields,
integer FKs where they are already available, and neutral MBID names only where
file-level MBID provenance is required.

## Provider Abstraction Direction

The provider layer should support multiple providers without schema changes:

- One row per provider resource, not one table or column per provider.
- Provider capability descriptors for audio, spatial audio, video, lyrics,
  download, search, and followed/favorite import.
- Provider-neutral quality decisions with per-provider mapping.
- A `DownloadBackend` per provider. TIDAL uses tiddl; Apple Music or other
  providers should bring their own backend.
- Config-driven active/default provider selection.

TIDAL is the only fully working provider today. Finishing the Apple Music
provider in `docs/TASKS.md` is the next real test of this abstraction.

## Catalog Source Direction

The `CatalogProvider` abstraction is the planned seam between:

- `ServarrMetadataCatalogProvider`: current normal mode, backed by Servarr Metadata Server/MusicBrainz
  replica flows.
- `LocalMusicBrainzCatalogProvider`: future MB-local mode, backed by a local
  MusicBrainz-docker `/ws/2` mirror first and direct Postgres later only if
  needed for performance.

Local MusicBrainz mode should not require a parallel Discogenius catalog. It
should use MusicBrainz as the catalog backend, while Discogenius-owned state
such as provider matches, slots, files, and monitoring decisions remains keyed
to MBIDs or local FKs.

Local MusicBrainz mode may still use the Servarr Metadata Server as a
supplemental metadata service for fields that MusicBrainz-docker does not serve
well in the `/ws/2` mirror, such as cached/normalized artwork URLs or
metadata-server ratings. Supplemental Servarr data must not override
MusicBrainz identity, release grouping, track identity, UPC/ISRC evidence, or
provider-resource evidence.

## Matching Direction

Release-centric matching is the desired end state:

1. Provider albums match candidate MusicBrainz releases directly.
2. Release groups are fetch/grouping containers, not matching constraints.
3. Composite provider coverage is persisted in `ProviderItemMatches`, not
   recomputed only at read time.
4. Matching evidence order is external streaming links, UPC/ISRC, track/medium
   shape, title/version, date/type, position/duration, and title distance.
5. Servarr Metadata Server mode must degrade gracefully when UPC/ISRC or external-link data is
   unavailable.

Detailed remaining work is in `docs/RELEASE_CENTRIC_MATCHING_PLAN.md`.

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
