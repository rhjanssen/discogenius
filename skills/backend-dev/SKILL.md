# Backend development (`api/`)

Use this skill when changing backend code under `api/src/`: routes, services, the command queue, matching, import/download, or schema.

Lidarr (`.ref_lidarr`) is the control-plane template. Discogenius has three library roots, so do not copy Lidarr's single Artist row. `docs/LIDARR_STRUCTURE_ALIGNMENT.md` is historical folder mapping. Living rules: `docs/SCHEMA_41_AUTHORITY_CUTOVER.md`, `docs/DATA_MODEL_TARGET.md`, `AGENTS.md`.

## Stack

- TypeScript. Yarn 1.x. ESM `.js` specifiers in TS imports.
- Synchronous `better-sqlite3` on the one Node event loop. A slow query stalls the whole app.
- Validate provider payloads and request bodies at the boundary.
- Respect `monitored_lock` / `monitor_lock`: automation never flips a user-locked monitor value.

## Layers

- Routes parse/validate and delegate. No durable workflow in a handler.
- Services own workflow. Keep SQL out of fat routes when you touch them.
- Long-running work goes through the command queue. Enqueue a `CommandModel` via the queue manager (`services/commands/command-queue-manager.ts`). `command-executor.ts` drains and dispatches to `services/commands/handlers/`. `scheduler.ts` enqueues due scheduled tasks. In heavy loops call `ctx.yieldToEventLoop()` (`command-context.ts`).
- *Refresh* pulls metadata. *Scan* reacts to disk. The table is `TrackFiles`; the folder/route say `mediafiles` / `/api/v1/mediaFile`. Do not rename either to match the other.

Do not edit `database.ts`, `catalog.ts`, `library-v41.ts`, `version.ts`, or artist query/monitor services while schema 46 is in flight unless you own that cutover.

## SQLite

- Never scan big tables. Index FK and filter columns.
- `OR col IN (subquery)`, not `OR EXISTS (subquery)`.
- `col = 1`, not `COALESCE(col, 0) = 1`, for `is_video` / flags so indexes apply.
- Integer catalog FKs on new file joins. No provider-shadow catalog columns.
- Chunked writes for bulk catalog hydration. Not one giant transaction.

## Data model

- MusicBrainz / the configured catalog provider is truth. Providers download and fill allowed holes only (cover-art ids, copyright, replay gain/peak, provider URLs/availability).
- Catalog artists: `ArtistMetadata`. Membership: `LibraryArtists` (2.12 target: FK `artist_metadata_id`, unmonitor = DELETE, `policy` on a kept row). Do not mint `LibraryArtists` from a feat. credit. Do not treat `Artists` / `ManagedArtists` as the future.
- Albums in the UI are release groups (`Albums`). Coverage is `AlbumEditions` plus `LibraryEditions`. There is no `AlbumReleases`.
- Typed matches only: `ProviderArtistMatches`, `ProviderEditionMatches`, `ProviderTrackMatches`, `ProviderVideoMatches`. There is no `ProviderItemMatches`. `provider_id` alone is not identity.
- `ProviderItemAudioVariants` is source capability. A file's quality is the file (or `TrackFiles` technical columns).
- Acquisition plans are mono-provider. A composite may cover tracks from several editions of that provider, never combine providers.
- Catalog tables have no `monitored` columns. Wanted-in-this-library is row existence on `LibraryAlbums` / `LibraryEditions` / `LibraryVideos`.
- See `docs/DATA_MODEL_TARGET.md`. Per-edition set cover is in `acquisition-plan-optimizer.ts` (`docs/MATCHING_SET_COVER_DESIGN.md`).

## Matching

One shared matcher scores edition-candidate tracks. Watch camelCase vs snake_case between callers. Online catalog strips ISRC/UPC; use local-MB for those, otherwise MBID + duration + title distance.

## Done means

- `yarn --cwd api build` after backend changes (this is `tsc`).
- `yarn ci` before a release. Vite `app build` tolerates type errors.
- Focused tests: `node api/scripts/run-tests.mjs <file>`. "Unable to deserialize cloned data" is a known flake; rerun in isolation.
- Production-service tests boot `active-schema-fixture.ts`, not `domain-baseline.ts`.
- Live checks use Bastille and Bakermat, preferably in the container.

## Lidarr conventions (`.ref_lidarr`)

Command queue, naming, extras, health, backup map. The Artist table does not: Discogenius membership is per library. Matcher distance (title + length + ids) is the shape to copy, not per-case title branches. Single operator, no roles.
