# Discogenius task backlog

Outstanding work only. Shipped history belongs in `CHANGELOG.md`.

Status: pending | in progress | decided | revisit

**2.12.0** is the model-correct release: one artist identity, policy that is not unmonitor, albums still release groups in the UI, editions as coverage, catalog tables without `monitored` columns.

**3.0.0** is a later GitHub prune / initial commit with no history baggage. It is not this release.

## 2.12.0: artist identity (schema 46, shipped)

Production `createBaselineSchemaV41()` opens as `user_version` 46. Catalog artists are `ArtistMetadata`; membership is `LibraryArtists`. Unmonitor is `DELETE` that row. Policy (`all` / `new` / `none`) lives only on a kept row. `Artists` and `ManagedArtists` are gone.

Shipped:

- Catalog artists live in `ArtistMetadata`. No library row until you add them.
- Add writes `LibraryArtists` (`library_id`, `artist_metadata_id`). Path, origin, refresh ops, and policy live there.
- Unmonitor / leave this library is `DELETE` that row. Same as `LibraryAlbums` and `LibraryVideos`.
- `LibraryArtists.policy` on a kept row: `all`, `new`, `none` (pause). Pause is not unmonitor.
- Catalog `Albums` / `AlbumEditions` / `Tracks` / `Recordings` stay without `monitored` columns.
- `TrackFiles` use `library_id` + `artist_metadata_id`. Deleting membership does not cascade-delete files.
- Library artist list is `FROM LibraryArtists JOIN ArtistMetadata`. Catalog search does not invent membership. `ArtistStatistics` keys `(library_id, artist_metadata_id)`.

UI that the schema work does not finish:

- pending: artist card shows edition multiplicity when the library holds more than one; unmonitored card shows collapsed-twin count. Derive both. No new table.
- pending: album header names how many editions Download will queue. Switcher collapses equal digital twins.
- shipped: track rows offer download only. Monitoring and locking are album actions; no track endpoint changes every audio library.

## Manual validation (needs Robert)

- **Spatial audio:** turn Spatial audio ON if Atmos chips are missing on albums with matched Atmos offers, then confirm TIDAL + Apple Atmos on Bastille.
- **Apple Music:** Auth-page wrapper login, then one stereo/hi-res, one Atmos, one standalone video, one album-bundled video.
- **YouTube Music:** browser-header JSON + cookies; one authenticated audio and video download.
- **Deezer:** `arl` cookie; one Streamrip MP3/FLAC download.
- **Amazon Music / Spotify:** Auth shows **Soon**. No live validation until re-enabled.
- pending: video download → import → placement, any provider, end to end.
- pending: unmapped-file / manual import on a real root.
- pending: restart / idempotence of a completed download+import (must be a no-op).
- pending: confirm 2.6.11 embedded-MBID linking on a live root scan (`[DiskScan] Artist …: N files updated`).

## After 2.12, still open

- pending: medley / multi-recording video UX (one video of several tracks).
- pending: `COALESCE(canonical, provider)` sweep in read services, tag builder, organizer. Provider values are match-time only.
- pending: per-provider high-res artwork master (`getArtworkUrl({size: "max"})`).
- pending: SoundCloud permalink / Auth / diagnostics polish. DRM decrypt stays rejected.
- pending: provider plugin move. `api/src/providers` is a re-export; adapters still live under `services/providers/<id>/`. SoundCloud first if anything moves.
- pending: skip / lazily hydrate release groups excluded by type filters (Servarr-mode cost).
- pending: Housekeeping progress/cancel if large catalogs block user commands too long.
- pending: catalog mode-switch UX (optional "refresh monitored now"). Do not implement flush-on-switch.
- pending: import-list monitor modes (EntireArtist vs SpecificAlbum) and playlist **SYNC**. Decided, not implemented.
- pending: artist-wide coverage before edition pick (recording MBID → ISRC → shape). Per-edition set cover is already in `acquisition-plan-optimizer.ts`.
- pending: Docker image size vs `.ref_lidarr` / `.ref_jellyfin` packaging.
- pending: production service tests that still boot `domain-baseline.ts` move onto `active-schema-fixture.ts`.
- revisit: new-release detection cadence vs folding it into the 24h refresh.
- revisit: followed-artists-import vs Lidarr `ImportListSync` cadence.

## 3.0.0: later GitHub prune

Not 2.12.0. After the model is stable, replace the public history with a clean initial commit. No compatibility migrations, no dual writers, no leftover `Artists` / slot / `ProviderItemMatches` names in the tree. Until then, do not pretend the repo is already that commit.

## Decisions worth keeping

- TypeScript stack. Do not port to .NET.
- Keep the `TrackFiles` table name (playable audio/video). Sidecars stay in their own tables.
- No multi-user / roles. Auth is the app/session gate.
- Three library roots by default (stereo, spatial, video). Spatial never fills stereo.
- Albums in the UI are release groups. Editions are coverage and folders.
- Schema 41 is the catalogue-model *name*. Production `createBaselineSchemaV41()` opens as `user_version` 46 (artist identity). There are no compatibility migrations. The CORE contract is `api/src/database/schema/domain-baseline.ts`; it is not what `initDatabase()` builds.

## Deprioritized

- Notifications, tags, blocklist/failed releases.
- Per-artist metadata or quality profiles (prefer library-type quality).
- Metadata-consumer profiles beyond MBID tagging and NFO/artwork sidecars.
- Flush SQLite catalog + live-query Postgres only (superseded by replicated-cache behavior).
- Dynamic npm plugin loading per provider.
