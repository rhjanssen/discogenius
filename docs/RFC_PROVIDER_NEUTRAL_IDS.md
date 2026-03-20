# RFC: Provider-Neutral Internal IDs with Provider Mappings

Last updated: 2026-03-20
Status: Approved direction for phased implementation

## Why This RFC Exists

Discogenius still treats TIDAL IDs as the app's primary identity in too many places:

- schema primary keys in `api/src/database.ts`
- queue payloads in `api/src/services/job-payloads.ts`
- queue/history mapping in `api/src/services/command-history.ts`
- browse/search lookup paths in `api/src/routes/search.ts`
- download routing and URL reconstruction in `api/src/services/download-routing.ts` and `api/src/utils/url-helpers.ts`
- import/retry flows in `api/src/routes/download-queue.ts`

That makes multi-provider support harder than it needs to be, and it keeps backend/provider-specific assumptions inside app-core code.

Lidarr is the useful comparison point here. Lidarr does not use MusicBrainz foreign IDs as the application's local identity. It keeps local entities with local IDs and stores upstream metadata identity separately:

- `Artist.Id` is local, while `ArtistMetadata.ForeignArtistId` carries the source MusicBrainz ID in [.ref_lidarr/src/NzbDrone.Core/Music/Model/Artist.cs](/E:/projects/discogenius/.ref_lidarr/src/NzbDrone.Core/Music/Model/Artist.cs) and [.ref_lidarr/src/NzbDrone.Core/Music/Model/ArtistMetadata.cs](/E:/projects/discogenius/.ref_lidarr/src/NzbDrone.Core/Music/Model/ArtistMetadata.cs)
- `Album.Id` is local, while `Album.ForeignAlbumId` carries the source album ID in [.ref_lidarr/src/NzbDrone.Core/Music/Model/Album.cs](/E:/projects/discogenius/.ref_lidarr/src/NzbDrone.Core/Music/Model/Album.cs)
- refresh, naming, and tagging operate on the local managed graph, not on provider IDs as primary keys, in [.ref_lidarr/src/NzbDrone.Core/Music/RefreshArtistService.cs](/E:/projects/discogenius/.ref_lidarr/src/NzbDrone.Core/Music/RefreshArtistService.cs), [.ref_lidarr/src/NzbDrone.Core/Organizer/FileNameBuilder.cs](/E:/projects/discogenius/.ref_lidarr/src/NzbDrone.Core/Organizer/FileNameBuilder.cs), and [.ref_lidarr/src/NzbDrone.Core/MediaFiles/AudioTagService.cs](/E:/projects/discogenius/.ref_lidarr/src/NzbDrone.Core/MediaFiles/AudioTagService.cs)

Discogenius needs that same separation before Apple Music or other providers can fit cleanly.

## Goals

1. Make local entity identity independent from any one provider.
2. Keep provider mappings explicit and queryable.
3. Preserve current TIDAL behavior during a phased migration.
4. Support provider-neutral queue payloads and backend routing.
5. Keep MusicBrainz Release Groups and ISRCs as cross-provider matching keys, not as local primary keys.

## Non-Goals

- Implementing Apple Music support in this RFC.
- Swapping SQLite for PostgreSQL in this RFC.
- Rewriting every route and service in one step.
- Using `mb_release_group_id` as a deduplication key.

## Current-State Problems

### Schema identity is TIDAL-primary

`api/src/database.ts` still defines:

- `artists.id INT PRIMARY KEY` as the TIDAL artist ID
- `albums.id INT PRIMARY KEY` as the TIDAL album ID
- `media.id INT PRIMARY KEY` as the TIDAL track or video ID

The same assumption flows into:

- `album_artists`
- `media_artists`
- `similar_artists`
- `similar_albums`
- `library_files`
- `upgrade_queue`
- `history_events`
- `provider_ids`

`provider_ids` exists, but it still references provider-primary entity IDs instead of stable internal IDs.

### Queue and status payloads are provider-shaped

`api/src/services/job-payloads.ts` still centers `tidalId`, `artistId`, and `albumId` as stringly typed remote IDs. The same assumption appears in:

- `api/src/routes/download-queue.ts`
- `api/src/services/download-processor.ts`
- `api/src/services/download-recovery.ts`
- `api/src/contracts/status.ts`
- `api/src/services/download-events.ts`

### UI and helper paths still resolve identity through TIDAL IDs

Examples:

- `api/src/services/command-history.ts` resolves titles by `job.ref_id || payload.tidalId`
- `api/src/routes/search.ts` checks monitored/in-library state by `id = tidalId`
- `api/src/utils/url-helpers.ts` is entirely TIDAL-specific
- `api/src/services/audio-tag-maintenance.ts` writes a `TIDAL_URL` tag directly from `media_id`

### Playlists are closer, but not fully there

The `playlists` table is directionally better because it has a stable local row keyed by `uuid`, while remote identity is also stored in `tidal_id`. But right now those two values are the same in `api/src/routes/playlists.ts`, so playlists are only conceptually closer to the target model.

## Comparison with Lidarr

Lidarr's pattern is:

- local entity IDs are app-owned
- metadata identity is separate
- queue/refresh logic talks about local entities and command models
- naming/tagging derive from the local graph plus metadata, not from foreign IDs in the core schema

The important implication for Discogenius is not "copy MusicBrainz." The important implication is "separate local identity from source identity."

For Discogenius, that means:

- local artist/album/media IDs must become internal IDs
- TIDAL IDs move into provider mappings
- MusicBrainz IDs and ISRC stay as matching/enrichment data

## Target Identity Model

### Local IDs

Discogenius should use app-owned UUIDs as the durable IDs for:

- artists
- albums
- media
- playlists

The local ID should be the app truth for:

- foreign keys
- queue references
- history references
- library file linkage
- UI routes once the migration is complete

### Provider Mappings

Remote/provider identifiers should move to a normalized mapping table.

Proposed logical model:

```ts
type EntityType = "artist" | "album" | "media" | "playlist";

interface ProviderMapping {
  entityType: EntityType;
  entityId: string;      // internal UUID
  provider: string;      // "tidal", "apple-music", "musicbrainz", ...
  externalId: string;    // provider-owned identifier
  fetchedAt?: string;
}
```

This generalizes the current `provider_ids` table and makes TIDAL just another provider entry.

### Matching Keys

The local ID is not the only important key.

Canonical matching responsibilities:

| Layer | Key | Purpose |
|---|---|---|
| Local app identity | internal UUID | Stable Discogenius entity identity |
| Track matching | `isrc` | Cross-provider recording identity |
| Album edition matching | `upc` / MB Release ID | Specific pressing/edition |
| Abstract album linking | `mb_release_group_id` | Cross-provider album concept |
| Artist linking | MusicBrainz artist ID | Cross-provider artist hint |

Important: `mb_release_group_id` remains a linking hint only. It is not a dedup key because standard and deluxe releases can share the same release group.

## Proposed Schema Direction

### Final Shape

The target tables should look like this conceptually:

- `artists.id TEXT PRIMARY KEY` (internal UUID)
- `albums.id TEXT PRIMARY KEY` (internal UUID)
- `media.id TEXT PRIMARY KEY` (internal UUID)
- `playlists.id TEXT PRIMARY KEY` (internal UUID)
- `provider_ids.entity_id TEXT` references those internal IDs

Foreign keys in tables like `library_files`, `history_events`, `upgrade_queue`, `album_artists`, and `media_artists` should all reference internal IDs.

### Additive Migration First

SQLite does not support in-place primary-key rewrites cleanly. The safe path is additive first, rebuild later.

Phase A:

- add `uuid` columns to `artists`, `albums`, and `media`
- backfill UUIDs for all existing rows
- add `entity_uuid` to `provider_ids`
- backfill `provider_ids` with `provider='tidal'` entries for all existing entities
- add new UUID-based foreign-key columns to dependent tables without removing old INT columns yet

Phase B:

- dual-write old ID columns and new UUID columns
- add resolver helpers that can map provider refs to internal IDs
- move new queue payloads and read paths to UUID-first logic

Phase C:

- rebuild the core tables in a versioned SQLite migration so internal UUID columns become the actual primary keys
- drop legacy TIDAL-primary columns only after the codebase no longer depends on them

## Proposed Runtime Model

### ProviderRef

New app-core flows should use a provider-neutral remote reference:

```ts
interface ProviderRef {
  provider: string;
  entityType: "artist" | "album" | "track" | "video" | "playlist";
  externalId: string;
}
```

### LocalEntityRef

Queue and history paths should eventually prefer a local entity reference:

```ts
interface LocalEntityRef {
  entityType: "artist" | "album" | "media" | "playlist";
  id: string; // internal UUID
}
```

### Compatibility Rule

During migration, queue payloads may temporarily carry both:

```ts
{
  ref?: ProviderRef;
  entity?: LocalEntityRef;
  tidalId?: string; // legacy compatibility only
}
```

The rule should be:

1. prefer `entity`
2. fall back to `ref`
3. fall back to legacy `tidalId` only where the migration has not reached yet

## Affected Discogenius Areas

Highest-risk code and schema areas that the migration must explicitly cover:

### Schema and repositories

- `api/src/database.ts`
- `api/src/repositories/ArtistRepository.ts`
- `api/src/repositories/AlbumRepository.ts`
- `api/src/repositories/MediaRepository.ts`

### Queue, jobs, and status

- `api/src/services/job-payloads.ts`
- `api/src/routes/download-queue.ts`
- `api/src/services/download-processor.ts`
- `api/src/services/download-recovery.ts`
- `api/src/services/download-events.ts`
- `api/src/contracts/status.ts`
- `api/src/services/command-history.ts`

### Search, playback, import, and helper surfaces

- `api/src/routes/search.ts`
- `api/src/routes/albums.ts`
- `api/src/routes/videos.ts`
- `api/src/routes/unmapped.ts`
- `api/src/routes/playlists.ts`
- `api/src/utils/url-helpers.ts`
- `api/src/services/audio-tag-maintenance.ts`
- `api/src/services/artist-query-service.ts`

### Planned provider/backend work that depends on this RFC

- `docs/RFC_PROVIDER_BACKEND_ABSTRACTION.md`
- backend capability routing
- multi-provider auth and metadata interfaces
- provider-neutral playback/download requests

## Playlist Direction

Playlists need to follow the same pattern eventually:

- add internal `playlists.id`
- keep remote provider playlist IDs in `provider_ids`
- stop assuming `uuid === tidal_id`

The current playlist table is still useful because it already proves Discogenius can keep a provider-specific identifier alongside a separate local record.

## Migration Plan

### Phase 1: RFC and instrumentation

- approve the target model
- document affected tables/routes/payloads
- add lookup/reporting helpers to quantify current TIDAL coupling

### Phase 2: additive schema groundwork

- add UUID columns and backfill them
- add `provider='tidal'` mappings for all current entities
- add UUID shadow columns to dependent tables
- add tests for backfill correctness

### Phase 3: runtime dual-read/dual-write

- introduce `ProviderRef` and `LocalEntityRef`
- make queue/status/history payloads UUID-capable
- update read paths to resolve from provider mappings
- update new writes to persist both old and new columns until cut-over

### Phase 4: primary-key cut-over

- build new UUID-primary tables in a versioned migration
- copy rows and dependent relations in one transaction
- verify row counts, foreign keys, and unique constraints
- swap tables and preserve a backup copy

### Phase 5: cleanup

- remove legacy TIDAL-primary columns
- remove `tidalId` compatibility payloads
- move TIDAL URL generation behind provider-aware helpers

## Rollback and Safety Expectations

This migration is high risk and must not be treated as a casual refactor.

Required safety rules:

1. Create an automatic DB backup before any primary-key swap migration.
2. Rehearse the migration on a copy of a real user database first.
3. Keep additive phases reversible until the primary-key swap is complete.
4. Validate row counts, foreign keys, unique constraints, and representative queries before final cut-over.
5. Preserve a restore path documented for Docker/NAS users before the destructive cleanup phase.

## Test Plan

### Automated

- migration smoke test from current TIDAL-primary schema to additive UUID shadow columns
- provider mapping backfill test for artists/albums/media/playlists
- queue payload tests covering `entity`, `ref`, and legacy `tidalId`
- search/history/status contract tests proving UUID-first behavior

### Staging / real-data rehearsal

- run the migration against a copy of a populated real database
- verify:
  - row counts per entity table
  - provider mapping counts
  - library file linkage
  - history/event linkage
  - queue retry/import behavior
  - playlist sync lookup behavior

### Manual

- import/scan an existing TIDAL-managed library
- retry a failed import
- navigate artist/album/video/playlists after migration
- verify rename/retag and playback still resolve correctly

## Decision

Discogenius will adopt provider-neutral internal IDs with normalized provider mappings.

The implementation order is:

1. approve this RFC
2. do additive schema groundwork
3. make runtime payloads/provider resolution UUID-capable
4. perform the primary-key swap only after dual-read/dual-write has stabilized

This keeps Discogenius aligned with the part of Lidarr's architecture that matters most here: local managed identity is stable, and source/provider identity is attached to it rather than embedded into the app's core primary keys.
