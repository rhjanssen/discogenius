# Schema 41 authority cutover

Discogenius 2.8.0 split durable state into four authorities. That split shipped. This file is the ledger, not a pending design.

1. Canonical MusicBrainz catalogue facts.
2. Provider-native identity, membership, credits, availability, and variants.
3. Typed provider-to-canonical match evidence.
4. Per-library curation, acquisition plans, and imported-file completion.

The CORE contract DDL is `api/src/database/schema/domain-baseline.ts`. There is no `domain-v41.ts`. Production is `createBaselineSchemaV41()` in `api/src/database.ts`, currently `user_version` 46, clean-start, no schema-39/40 compatibility tables.

**2.12.0 (schema 46, shipped):** catalog artists are `ArtistMetadata`. Membership is `LibraryArtists`. Unmonitor is `DELETE` that row. Policy (`all` / `new` / `none`) lives only on a row you kept. `Artists` and `ManagedArtists` are gone. Catalog tables have no `monitored` columns.

## Authority map

| Retired writer or concept | Authority now | Notes |
| --- | --- | --- |
| Canonical integer and MBID foreign keys written together | Integer foreign keys; MBIDs only on canonical entity rows | Relation-table MBID sync triggers are leftover; integer FKs are the join |
| `ProviderItems` canonical IDs and match fields | Typed `Provider*Matches` | Ingestion writes facts; matcher writes edges |
| `ProviderItems.provider_album_id` | `ProviderEditionMembers` | One provider track may sit on several provider editions |
| Scalar provider artist fields | `ProviderItemCredits` | Ordered credits, no invented join phrases |
| `ProviderItems.quality` / `library_slot` | `ProviderItemAudioVariants` | One identity, several stereo/spatial renditions. Source capability, not a local file's quality |
| `ProviderItemMatches` | `ProviderArtistMatches`, `ProviderEditionMatches`, `ProviderTrackMatches`, `ProviderVideoMatches` | Shipped. Do not revive a generic match table |
| `ReleaseGroupSlots` | `LibraryAlbums` and `LibraryEditions` | Stereo, Spatial, and Video are library rows, not enum slots |
| Credited content changing canonical ownership | `LibraryEditionScopes` | Scope explains why content is wanted |
| `ReleaseGroupSlotTargets` | Canonical `Tracks` selected through `LibraryEditions` | Wanted/availability/completion are derived |
| `ReleaseGroupSlotSources` | `AcquisitionPlanSources` | Sources reference accepted typed edition matches |
| `ReleaseGroupSlotTrackAssignments` | `AcquisitionPlanTracks` | Assignments reference canonical tracks, typed matches, and variants |
| Semicolon `selected_provider_id` composites | Rows in `AcquisitionPlanSources` | Shipped |
| Position-selected canonical tracks | Shared one-to-one track matcher | Position is evidence, never identity |
| Audio `monitored` on catalogue rows | Per-library curation tables | `Albums` / `AlbumEditions` / `Tracks` / `Recordings` comments in `catalog.ts` already forbid the column |
| Video `monitored` on `Recordings` | `LibraryVideos` row existence | Shipped. A video can be selected in Video and absent from stereo |
| Download command success as completion | `TrackFiles` with `library_id` plus track/recording FKs | Only a successfully imported assigned file is complete |

## Ledger

A legacy authority is gone when its last reader and writer are gone. "Target DDL complete; operational cutover pending" was true before 2.8. It is a lie for slots, typed matches, plans, and library overlay.

| Authority | Status |
| --- | --- |
| Slot target/source/assignment tables | Shipped as `LibraryAlbums` / `LibraryEditions` / `AcquisitionPlan*` |
| Generic provider match graph | Shipped as typed `Provider*Matches`. `ProviderItemMatches` must not return |
| Provider/canonical mixed item rows | Shipped. `ProviderItems` holds provider facts only |
| Fixed stereo/spatial slot selection | Shipped as library rows. Default roots are stereo, spatial, video |
| Delimited acquisition reconstruction | Shipped as `AcquisitionPlanSources` / `AcquisitionPlanTracks` |
| Library-slot completion | Shipped as `TrackFiles.library_id` |
| Video monitoring on `Recordings` | Shipped as `LibraryVideos` |
| `Artists` TEXT PK + `ManagedArtists` hop + `LibraryArtists.monitored` | **Shipped (schema 46).** `ArtistMetadata` + `LibraryArtists` (FK `artist_metadata_id`), unmonitor = DELETE, `policy` on a kept row |
| `AlbumArtists` dual-write beside `*ArtistCredits` | In progress. Integer credits are the writers |
| MBID sync triggers on relation tables | Leftover. Integer FKs are the join |
| `TrackFiles.artist_id` TEXT → `Artists` | **Shipped (schema 46).** `library_id` + `artist_metadata_id`, no FK to `LibraryArtists` |
| `domain-baseline.ts` vs production artist DDL | **Aligned on schema 46.** Both use `ArtistMetadata` + `LibraryArtists(artist_metadata_id)`. Contract remains aspirational CORE elsewhere; it is still not what `initDatabase()` builds |

## 2.12 artist identity

Lidarr has one library, so every added artist is an Artist row with `Monitored` and `MonitorNewItems` on it. Discogenius has three library roots. Catalog search must not mint membership.

| Job | Table | Rule |
| --- | --- | --- |
| Name, bio, images, sort | `ArtistMetadata` | Catalog. Most rows have no library membership |
| In this library, path, origin, refresh ops | `LibraryArtists` | Only after add. Point at `ArtistMetadata.id` |
| Unmonitor / leave this library | `DELETE LibraryArtists` | Absence, not `monitored = 0` |
| What automation grabs while they stay | `LibraryArtists.policy` | `all`, `new`, `none` (pause). Do not insert `policy = none` to mean "not in the library" |
| This album is wanted here | `LibraryAlbums` | Row existence. No album-level monitor-new |
| This edition is coverage here | `LibraryEditions` | Representative plus supplementals for novel recordings |
| Video selected in a library | `LibraryVideos` | Row in or out |
| Feat. display | `*ArtistCredits` | Catalog. Never mint `LibraryArtists` from a credit line |

`domain-baseline.ts` and production DDL both key `LibraryArtists` by `artist_metadata_id` onto `ArtistMetadata`. There is no `Artists` TEXT PK and no `ManagedArtists` hop. Schema 46 is the stamp that made production match this table.

## Invariants

- Canonical entity MBIDs are unique external identifiers, never relation-table join authorities.
- A provider item is unique by `(provider, entity_type, provider_id)` and is not duplicated for libraries or audio variants.
- `provider_id` alone is never identity. Carry `ProviderItems.id` or the full triple.
- A provider release relation is calculated from accepted matched sets: `exact`, `source_superset`, `source_subset`, or `overlap`.
- Only an accepted provider-track match with an exact canonical `track_id` can be selected into an acquisition plan.
- One acquisition plan belongs to `(library_id, edition_id)`.
- Completion is proved only by an imported `TrackFiles` row in that library.
- Canonical credits control display, tags, naming, and file placement.
- Each playable `TrackFiles` row has exactly one `library_id`.
- Catalog artists have no path and no policy until `LibraryArtists` exists.
