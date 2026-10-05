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
- pending: audit scan counter accuracy and repeat work. Live command 15214 completed all 518 artists on October 4 at 20:45 UTC (592 indexed, 21,048 updated, none removed). Scheduled follow-up 15496 already reports 9 indexed and 35 updated after 3 artists. Duplicate-extra re-evaluation increments indexed even when an existing row is upserted; distinguish new owned files from reclassification, and verify why file facts change on the repeat before declaring the scan idempotent. The mutation journal is empty and downloads remain paused.
- locally validated: duplicate rescans preserve the ownership row through inspection, count only its first registration, and transactionally replace it on promotion. Audio-fact backfill uses the shared writer gate and counts only changed facts. Active-schema tests cover stable duplicate IDs, failed-promotion rollback and writer contention. A native ffmpeg/real-file full-handler repeat produced no changes and preserved decoded audio; Activity displayed the no-change result and Unmapped retained unknown FLACs. Full CI passed after an edition-monitoring test-runner clone flake passed its isolated retry. Linux container validation subsequently passed in the October 5 scheduling candidate. Not deployed. This does not yet eliminate probing for files whose quality remains unknown.
- locally validated: daily root scans wait one full configured interval after successful whole-library completion. The completion timestamp is persisted atomically with the command and survives history cleanup. Scoped artist scans, failed commands and stale worker claims do not satisfy this schedule. Targeted active-schema and Linux tests passed; system/task reports the same completion-based next execution. Full CI passed 1,975 backend and 186 frontend tests. Not deployed. Other scheduled tasks still use their existing queue-based intervals.

- locally validated: canonical tag-link backfill now obtains writer admission, resolves the catalog inside that admitted unit, and updates only the same still-unlinked file row. A competing rename, track assignment or conflicting edition leaves the row untouched and does not count as healed. Four real tagged-FLAC regressions pass on Windows and Linux. Removed the retired duplicate-ownership release helper and its obsolete tests; atomic promotion coverage remains. Full CI passed 1,977 backend and 186 frontend tests. Not deployed.
- locally validated: the shared catalog-detail writer reconciles by stable track MBID, preserving integer identity through position changes and cross-edition moves. Connected editions commit together; unrelated editions release admission separately. Exact membership checks repair incomplete or surplus unreferenced rows even with an unchanged content hash. Incomplete track lists and obsolete identities referenced by files, matches or plans fail explicitly. Active-schema tests cover swaps, source-order independence, rollback, file references and no-change repeats. A native replay of 280 incoming tracks and 11 captured Ray Charles/Yes identity conflicts preserved a real FLAC's row reference and decoded audio, with zero repeat writes. This replay does not cover all live obsolete plan references. Not deployed.
- locally validated: command/pipeline artist statistics compute outside writer admission and persist current projections in bounded batches. Contention tests cover changed inputs, artist deletion and fairness between batches. Five scoped native checks on the local 11 GB production clone took 53-248 ms without write holds above the 10 ms logging threshold; these uncontended checks do not prove whole-library contention is resolved. ApplyCuration now retains per-artist failures and fails the command instead of reporting successful completion with errors. The local Activity UI showed both successful and deliberately failed outcomes. Live command 15502's 13 errors were database locks, separate from the eight catalog-identity failures. Not deployed.
- locally validated: removed catalog tracks release only unused acquisition candidates, transactionally with edition reconciliation. Library selections, DownloadQueue holders and queued/active command plan references prevent removal. Indexed holder lookups avoid scanning the download backlog. Captured live Yes references comprised three unused plans and 14 assignments; replaying all eight failed groups with those actual references reconciled 1,808 incoming tracks and 37 position/edition conflicts, preserved surviving integer IDs and decoded test audio, had zero foreign-key violations and made zero repeat writes. The local UI queued curation for all eight artists; the command executor completed all eight and Activity showed successful history with no active jobs. Eight active-schema safety/index tests and 31 catalog-writer tests pass on Windows and Linux. Full CI passed 2,000 backend and 186 frontend tests. Not deployed.
- pending: expose a clear review/replan action for catalog changes blocked by a selected, queued or active acquisition plan. Preserve the standing manual choice and imported file identities; do not silently substitute a provider or delete held assignments. Complete live foundation/library acceptance before retrying the failed production refreshes or resuming downloads.
- validation, October 5: full CI passed after a provider-registry clone-deserialization failure passed its isolated retry. Final focused catalog/statistics/curation tests passed all 37 on Windows and native Linux; the candidate Docker image builds. The latest persisted live deep-health result is healthy with zero foreign-key violations, and downloads remain paused. These are local candidate checks and read-only live inspection, not deployment acceptance.
- locally validated, October 6: async statistics use smaller event-loop batches and indexed integer/MBID artist scopes. On the 11 GB, 518-artist clone, a warm competing-writer comparison reduced maximum event-loop delay from 412 ms to 55 ms with identical result digests. During 17 full refreshes, 850 mixed HTTP requests succeeded with p95 47-52 ms. Initial cold baseline delay reached 3.1 s; these warm comparisons do not establish cold NAS performance. Twenty-four broader statistics/curation/query tests pass on Windows and native Linux, including persisted restart truth. Prepare 2.21.0 for controlled live validation with downloads paused; unresolved library conflicts are not permission to overwrite media or resume acquisition.
