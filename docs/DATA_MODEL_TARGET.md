# Discogenius data model

Living rules. Cutover history and the 2.12 artist-identity model are in [SCHEMA_41_AUTHORITY_CUTOVER.md](SCHEMA_41_AUTHORITY_CUTOVER.md). Outstanding work is in [TASKS.md](TASKS.md). Production DDL is `createBaselineSchemaV41()` in `api/src/database.ts` (`user_version` 46). The CORE contract is `api/src/database/schema/domain-baseline.ts`; it is not what `initDatabase()` builds.

## Rules

1. MusicBrainz (Servarr or local-MB) is catalog truth for audio. Video catalog is MusicBrainz plus public YouTube.
2. Providers are availability and download. YouTube public listing is core video catalog, not the download plugin.
3. Providers do not mint canonical artists, release groups, releases, or tracks. A video recording may be minted only after MB and YouTube lookup miss (`metadata_status = 'provider_catalog'`).
4. Provider UPC/ISRC stay on `ProviderItems` as matching evidence. They are not copied onto catalog barcode/ISRC in Servarr mode.
5. Allowed catalog holes providers may fill: cover-art ids, copyright, replay gain/peak, provider URLs, availability, download facts.
6. If a UI section is populated only from provider data, re-source it from the catalog or delete the section.
7. `provider_id` alone is never identity. Carry `ProviderItems.id` or `(provider, entity_type, provider_id)`.

## Catalog

- `ArtistMetadata`. Every catalog artist. No path, no policy, no `monitored`.
- `Albums`. MusicBrainz release group. The thing the artist page names. No `monitored`.
- `AlbumEditions`. MusicBrainz release. Coverage and folder unit. Not `AlbumReleases`. No `monitored`.
- `Tracks`. Position on an edition. No `monitored`.
- `Recordings`. Recording identity (audio MBID; video MBID and/or `youtube_video_id`). No `monitored`.
- Integer `*ArtistCredits`. Credited names. A feat. line is not a library artist.

`Artists` (TEXT PK) and `ManagedArtists` are gone as of schema 46 / 2.12. Catalog artists are `ArtistMetadata`; membership is `LibraryArtists`.

## Provider offers and matches

`ProviderItems` is the resource cache. `ProviderEditionMembers` is occurrence on a provider edition. `ProviderItemAudioVariants` is source capability, not a local file's quality.

Typed edges only: `ProviderArtistMatches`, `ProviderEditionMatches`, `ProviderTrackMatches`, `ProviderVideoMatches`. There is no `ProviderItemMatches` and no MBID shadow column on `ProviderItems`.

## Library overlay

Default roots are stereo, spatial, and video. They are library rows, not slots on a release group.

- `LibraryArtists`. Membership after add. FK `artist_metadata_id`. Unmonitor = DELETE. `policy` (`all` / `new` / `none`) only on a kept row; `none` is pause, not leave-the-library.
- `LibraryAlbums`. This release group is wanted here. Row existence.
- `LibraryEditions`. This release is held here. Representative plus supplementals.
- `LibraryVideos`. This video is selected here. Row existence.

No album-wide "the selected edition." Acquisition plans are `(library_id, edition_id)`.

## Files

`TrackFiles` is playable audio/video inventory. One `library_id` per row. Artist column is `artist_metadata_id` (no FK to `LibraryArtists`; deleting membership must not cascade-delete files).

`MetadataFiles`, `LyricFiles`, and `ExtraFiles` are sidecars. One physical sidecar may belong to several libraries through `*FileLibraries`.

Do not rename `TrackFiles` to `MediaFiles`.

## Matching

Provider albums match MusicBrainz releases. Release groups group work; they do not constrain matching. Identity edges live only in the typed match tables. Multi-source coverage lives in `AcquisitionPlanSources` / `AcquisitionPlanTracks`. Evidence order: external links, UPC/ISRC, shape, title/version, date/type, position/duration. Per-edition minimum set cover is implemented in `acquisition-plan-optimizer.ts`. See [MATCHING_SET_COVER_DESIGN.md](MATCHING_SET_COVER_DESIGN.md).

## Catalog source

`CatalogProvider` is Servarr or local-MB. Both replicate into Discogenius SQLite on refresh. Switching modes flips the provider; the next refresh re-reads. No catalog flush. Local-MB fills ISRC/UPC holes Servarr usually lacks.

## Libraries

Named library: name, root, audio vs video, quality profile. Type filters stay on the release group and apply to every audio library. The same recording may exist as lossless, Atmos, and video in different roots. Spatial never fills stereo.
