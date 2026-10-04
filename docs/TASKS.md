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

### Runtime and file safety gates

The measured ownership problems and remaining acceptance gates are in
`RUNTIME_FOUNDATION_REVIEW.md`. Complete these before the 3.0 history prune:

- pending: atomic replacement for embedded metadata writes and journal coverage
  for new sidecar copies; test process crashes separately from power loss.
- pending: bounded MoveArtist and new-artist discovery; split very large artist
  reconciliation further if measured import waiting time requires it.
- pending: separate provider-edition matching preparation from persistence and
  move first-read ranking initialization into queued work.
- pending: representative mixed acquisition/import/retag/scan observation across
  enabled providers, including partial failures and exact file identity.
- pending: verify selected artwork source changes across originals, proxies,
  sidecars and embedded covers, then validate media-server presentation.
- pending: compare a typed dedicated writer with the bounded fair-mutex design
  on measured workloads before changing runtimes or database engines.

## UI and terminology pass after runtime stability

- pending: distinguish Running, Waiting, and Waiting to continue. Maintenance
  work can yield its slot without losing progress; a waiting row must not say
  it is currently processing. Remove the appended queue-position text.
- pending: use one status contract across Activity and Queue. Show durable
  completed/total counts, the current artist/album/file, and a percentage only
  when the total is known. Keep these updated through events plus reconciliation;
  show the last confirmed state when no fresh progress is available.
- pending: compare Jellyfin's scheduled-task progress and current-item display.
  Exercise rename, retag, scan, metadata refresh, download and import in both
  desktop and mobile layouts, including yielded work and restart recovery.
- pending: use Streaming services for media sources and provider-specific
  download tools. Explain artwork supplementation separately from canonical
  metadata, rather than describing everything as one provider.
- pending: name the two metadata modes clearly: MusicBrainz metadata through
  Servarr, and the local MusicBrainz database. Show the selected mode and mirror
  freshness. Detailed transport, matching and edition explanations belong in
  help popovers, while useful edition distinctions remain visible.
- pending: audit labels, icons, empty/error states, spacing and overflow menus
  throughout the app. Prefer concise actions and descriptions; keep operational
  detail available without putting implementation terminology in routine flows.

## Artwork storage and embedding acceptance

- in progress: restore the configured embedded-art resolution and impose a
  separate byte budget for JPEG derivatives across FLAC, MP3, M4A and Xiph.
  Preserve original sidecars. Verify decoded audio, tags and repeat comparisons.
- pending: reconcile remaining imported-cache masters with tracked library
  sidecars after rename, verifying exact content and ownership before removing
  duplicate originals. Ordinary scans must remain no-ops for unchanged files.
- pending: decide whether catalog browsing retains full originals or only
  250/500 proxies. Full-quality acquisition artwork must become the library
  sidecar after import. Validate source switching across sidecar and embeds.
- pending: expose cache usage by originals, proxies, database and backups, and
  define retention for unimported artwork. Do not treat archival library covers
  as disposable cache files.

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


## After 2.16.5 validation

- pending: merge remote catalogue discovery with local identities and show progress for queued hydration of unknown album/artist pages. Page opening must not monitor or download implicitly.
- pending: measure broad one/two-character search and cold track-list filters separately from selective album searches.
- pending: update persisted file size/mtime after standalone tag stripping, as retagging already does.
- pending: profile cold statistics reads and video-update transactions during concurrent catalogue refresh; the scale run still recorded 2.3 s and 6.5 s respectively.
- pending: reproduce artwork-cache temporary-file loss during concurrent metadata refresh.

## Live library readiness and conflict review

- pending: add a conflict-review workflow showing source and destination,
  canonical edition/track identities, current tracking ownership and technical
  quality. Preview a safe association correction or an explicit keep/replace
  choice; never hide an identity collision with an arbitrary suffix.
- pending: inspect the eight audio rename conflicts from command 14723. Their
  destinations exist but no TrackFiles row owns the exact container or host
  path at audit time. Verify normalized ownership and both media contents before
  any replacement or deduplication. Edition-MBID folders do not solve two files
  targeting the same track within the same edition.
- pending: reconcile the nonempty plain Bastille directory, whose music and
  artwork are not tracked under either its container or host path. Preserve
  unknown media until it has been matched or explicitly reviewed.
- pending: retry the 33 sidecars refused by the old rename plan through a fresh
  scoped preview; verify album/edition/recording/track ownership first.
- pending: report actual empty-parent cleanup counts. Rename currently removes
  empty parents but its cleanedDirectories result remains zero. October 4's
  read-only audit found no empty subdirectories in stereo or spatial roots.
- pending: after the artwork release, run an idempotent tag/artwork verification
  and update only mismatches. Keep Plex presentation acceptance separate from
  command completion and from folder naming.
- pending: make Check Upgrades clearly mean media quality acquisition. Scan
  Folders reconciles disk inventory and sidecars; it does not rewrite all tags
  or replace audio with a higher-quality provider download.

## Managed-library cleanup clarification

- in progress: implement the inventory-before-deletion contract in MANAGED_LIBRARY_CLEANUP.md. Keep delete-untracked, delete-empty and remove-unmonitored policies separate.
- locally validated: routine scans include unambiguously identified plain-name artist siblings and register unmatched media for review.
- locally validated: resumable whole-root inventory registers loose and unknown-folder media, preserves ignored review entries, and uses indexed ownership checks. Orphan pruning preserves records when their root is unavailable. Not deployed.
- pending: automatic canonical identification of media in unknown folders, grouped unmapped album review, exact sidecar ownership and bounded journaled strict cleanup before enabling that policy. An empty mount point must not count as a healthy root.
- pending: after Discogenius reconciliation, snapshot Lidarr and test read-only rescans on Bastille/Bakermat before library-wide edition reassignment.
