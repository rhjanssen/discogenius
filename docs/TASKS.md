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
- locally validated, October 6: rename and artist moves count actual removed
  empty parents. Pruning retains the root, refuses directory symlinks/junctions,
  recognizes Windows path casing and stops at nonempty parents. Not deployed.
- pending: after the artwork release, run an idempotent tag/artwork verification
  and update only mismatches. Keep Plex presentation acceptance separate from
  command completion and from folder naming.
- pending: make Check Upgrades clearly mean media quality acquisition. Scan
  Folders reconciles disk inventory and sidecars; it does not rewrite all tags
  or replace audio with a higher-quality provider download.

## Managed-library cleanup clarification

- requested, October 6: after inventory, identity, duplicate and sidecar handling
  are fixed and validated, run a fresh library-wide rename followed by retag,
  then strict unowned/duplicate cleanup and empty-parent pruning. Verify outcomes
  and no-change repeat previews. This is authorized follow-up work; incomplete
  inventory or a conflicting edition must be resolved before deletion.
- locally validated, October 6: sidecar deduplication checks scope and identical
  bytes, fixes the destination artist-field alias, verifies the staged source
  again and retains file witnesses through commit. Different lyrics/artwork and
  concurrently changed destination files are preserved; rollback keeps ownership.
  Native Linux tests passed 81 with one Windows-only case skipped. Final full CI
  passed after the known provider-registry clone flake passed its isolated retry;
  no new assertion failures. These fixes are on codex/managed-library-cleanup,
  not live 2.21.0.
- live validation, October 6: all eight failed catalog refreshes (15508-15515)
  completed on 2.21.0. Root scan 15506 completed with 187 additions, 61 updates,
  no removals and 26 new review files. Its root inventory checked 63,445 files
  across 3,802 directories with no missing roots. Activity shows completion and
  no active jobs; Unmapped shows 79 files, including grouped Bastille mixtapes.
  Downloads remain paused. A fresh audio
  audit of the eight earlier rename conflicts found seven equal decoded PCM
  pairs (32-bit decode hash; both sources 16-bit FLAC), two with differing
  edition tags, and one absent destination. All seven destinations are now
  TrackFiles rows 36044-36050 with the same canonical track, edition and stereo
  quality as their sources. Implement journaled consolidation preserving linked
  sidecars; retag must repair the two stale destination edition tags. Do not
  discard an edition solely because its decoded audio matches another edition.

- in progress: implement the inventory-before-deletion contract in MANAGED_LIBRARY_CLEANUP.md. Keep delete-untracked, delete-empty and remove-unmonitored policies separate.
- locally validated, October 7: root inventory links sidecars from exact physical/canonical ownership and repairs missing edition identity in existing rows while retaining IDs and rename/provider information. Ambiguous files/editions and conflicting canonical assignments remain protected; shared edition covers retain all confirmed library associations. Fixed library-ID-only inference that attached folder metadata to a sole track. Cleanup refuses unsettled recognized sidecars and protects APE/MP2/WebM/TS media. Sixteen active-schema sidecar tests pass; the broader checks pass 48 tests on Windows and 47 on native Linux with one Windows-only skip. Standalone catalogue and MBID-less YouTube video thumbnails retain exact physical ownership without invented edition or MBID context. The actual app repaired a real FLAC's existing cover/LRC rows, reported two sidecars linked, then completed an unchanged repeat with identical full-file hashes. Full CI passed 2,058 API and 187 frontend tests without failing names or clone retries. Not deployed. Finish artist-level ownership, review sidecar persistence/grouping, conflict diagnostics and bounded cleanup planning before live cleanup.
- locally validated, October 7: operational LibraryCleanupJournal stages unowned files without fake media ownership, rechecks complete current scan/configuration/all-root witnesses, protects review media by default, and recovers after process exit or command-history pruning. Pending intents block disk jobs and share startup/watchdog recovery and health reporting. Ten Windows cleanup tests and 34 native Linux cleanup/journal/scan tests pass. Not deployed; bounded planning, sidecar reconciliation and the public preview/apply workflow remain open, so strict deletion is not enabled.
- live, October 7: healthy 2.21.0, downloads paused, zero active jobs. Scan 15506 aged out of history; completed scan 15759 reports 62,973 files and no missing roots, but lacks candidate filesystem witnesses. New a-ha 15602 and Dirty Honey 15628 refresh failures involve obsolete catalogue tracks held by selected automatic TIDAL plans with waiting DownloadQueue rows. Preserve and replan their acquisition intent instead of deleting held bindings. No live cleanup performed; earlier eight successful retries remain successful.
- locally validated, October 7: fresh-container startup exposed synchronous monitoring follow-up writes throwing SQLITE_BUSY after successful commands. Command handoff now awaits async writer admission. The contention test verifies the terminal pass survives another writer and allows its release timer to run; a rebuilt fresh container completed all six startup/scan jobs without those errors. Fifty-one native cleanup/scan/monitoring tests pass. Not deployed, and this does not prove all live contention is resolved.
- validation, October 7: final full CI passed all 2,040 API and 187 frontend tests, lint, typechecks and builds with no failing names or clone retries. The existing serialization test now waits for an admitted owner instead of assuming cold-import resolution order. Candidate remains undeployed; complete strict planning and sidecar/artwork acceptance before the full live reconciliation.
- locally validated, October 6: same-edition stereo audio consolidation uses exact catalogue/library ownership, probed lossless quality and complete PCM hashes. Journaled deletion rechecks both file/row witnesses and transfers MetadataFiles/LyricFiles/ExtraFiles links atomically to the retained row. Different editions, spatial slots, inconsistent facts and changed targets remain protected. The rename preview exposes candidate verification while ordinary conflicts remain disabled. Fifty native rename/journal tests pass. Actual app rename retained the exact destination ID and moved a real lyric, then retag wrote canonical fixture tags and lyrics with unchanged decoded audio; repeat rename/retag previews had no changes. Not deployed. Finish strict cleanup and artwork acceptance before the full live reconciliation.
- authorized final reconciliation: after identification and validated complete inventory, explicitly dispose of remaining Unmapped media as requested by the active goal, separately from default review-preserving strict cleanup. Verify all surviving files have catalogue/sidecar ownership, then complete library-wide rename/retag acceptance before clearing and resuming downloads.
- locally validated: routine scans include unambiguously identified plain-name artist siblings and register unmatched media for review.
- live 2.21.0: resumable whole-root inventory registers loose and unknown-folder media, preserves ignored review entries, and uses indexed ownership checks. Orphan pruning preserves records when their root is unavailable.
- locally validated, October 6: root inventory rejects disappeared subdirectories and replacement roots/current directories, persists filesystem identity across continuations, and checks containment and ancestor links before reading empty directories. Roots absent at scan start remain marked missing if they reappear. Ten active-schema checks passed on Windows and native Linux; final full CI passed with no new failing names and the known provider-registry clone failure passing its isolated retry. The rebuilt app registered real stereo FLACs and a repeat preserved review row IDs with no additions. Legacy checkpoints lack this new identity evidence; an empty failed mount still needs a separate health gate. Candidate is not deployed.
- locally validated, October 6: manual Scan Library Files and scheduled RescanFolders now share artist reconciliation and root inventory. New-artist discovery is a persisted phase, not a separate handler path; inventory continuations do not repeat it. The rebuilt app registered three real FLACs for review, including loose root media and disabled spatial-library media, and a repeat preserved row IDs with no additions. Both manual runs persisted complete root inventories and discovery counts. Empty roots preserve missing owned/review records, and admitted writer transactions recheck missing files before removing ownership. Forty-one native Linux tests cover these scan phases and safety checks. This candidate is not deployed; discovery still needs bounded work units, and a completed scan alone does not authorize strict deletion.
- pending: automatic canonical identification of media in unknown folders, grouped unmapped album review, exact sidecar ownership and bounded journaled strict cleanup before enabling that policy. An empty mount point must not count as a healthy root.
- pending: after Discogenius reconciliation, snapshot Lidarr and test read-only rescans on Bastille/Bakermat before library-wide edition reassignment.
- pending: audit scan counter accuracy and repeat work. Live command 15214 completed all 518 artists on October 4 at 20:45 UTC (592 indexed, 21,048 updated, none removed). Scheduled follow-up 15496 already reports 9 indexed and 35 updated after 3 artists. Duplicate-extra re-evaluation increments indexed even when an existing row is upserted; distinguish new owned files from reclassification, and verify why file facts change on the repeat before declaring the scan idempotent. The mutation journal is empty and downloads remain paused.
- locally validated: duplicate rescans preserve the ownership row through inspection, count only its first registration, and transactionally replace it on promotion. Audio-fact backfill uses the shared writer gate and counts only changed facts. Active-schema tests cover stable duplicate IDs, failed-promotion rollback and writer contention. A native ffmpeg/real-file full-handler repeat produced no changes and preserved decoded audio; Activity displayed the no-change result and Unmapped retained unknown FLACs. Full CI passed after an edition-monitoring test-runner clone flake passed its isolated retry. Linux container validation subsequently passed in the October 5 scheduling candidate. Not deployed. This does not yet eliminate probing for files whose quality remains unknown.
- locally validated: daily root scans wait one full configured interval after successful whole-library completion. The completion timestamp is persisted atomically with the command and survives history cleanup. Scoped artist scans, failed commands and stale worker claims do not satisfy this schedule. Targeted active-schema and Linux tests passed; system/task reports the same completion-based next execution. Full CI passed 1,975 backend and 186 frontend tests. Not deployed. Other scheduled tasks still use their existing queue-based intervals.

- locally validated: canonical tag-link backfill now obtains writer admission, resolves the catalog inside that admitted unit, and updates only the same still-unlinked file row. A competing rename, track assignment or conflicting edition leaves the row untouched and does not count as healed. Four real tagged-FLAC regressions pass on Windows and Linux. Removed the retired duplicate-ownership release helper and its obsolete tests; atomic promotion coverage remains. Full CI passed 1,977 backend and 186 frontend tests. Not deployed.
- locally validated: the shared catalog-detail writer reconciles by stable track MBID, preserving integer identity through position changes and cross-edition moves. Connected editions commit together; unrelated editions release admission separately. Exact membership checks repair incomplete or surplus unreferenced rows even with an unchanged content hash. Incomplete track lists and obsolete identities referenced by files, matches or plans fail explicitly. Active-schema tests cover swaps, source-order independence, rollback, file references and no-change repeats. A native replay of 280 incoming tracks and 11 captured Ray Charles/Yes identity conflicts preserved a real FLAC's row reference and decoded audio, with zero repeat writes. This replay does not cover all live obsolete plan references. Not deployed.
- locally validated: command/pipeline artist statistics compute outside writer admission and persist current projections in bounded batches. Contention tests cover changed inputs, artist deletion and fairness between batches. Five scoped native checks on the local 11 GB production clone took 53-248 ms without write holds above the 10 ms logging threshold; these uncontended checks do not prove whole-library contention is resolved. ApplyCuration now retains per-artist failures and fails the command instead of reporting successful completion with errors. The local Activity UI showed both successful and deliberately failed outcomes. Live command 15502's 13 errors were database locks, separate from the eight catalog-identity failures. Not deployed.
- locally validated: removed catalog tracks release only unused acquisition candidates, transactionally with edition reconciliation. Library selections, DownloadQueue holders and queued/active command plan references prevent removal. Indexed holder lookups avoid scanning the download backlog. Captured live Yes references comprised three unused plans and 14 assignments; replaying all eight failed groups with those actual references reconciled 1,808 incoming tracks and 37 position/edition conflicts, preserved surviving integer IDs and decoded test audio, had zero foreign-key violations and made zero repeat writes. The local UI queued curation for all eight artists; the command executor completed all eight and Activity showed successful history with no active jobs. Eight active-schema safety/index tests and 31 catalog-writer tests pass on Windows and Linux. Full CI passed 2,000 backend and 186 frontend tests. Not deployed.
- pending: expose a clear review/replan action for catalog changes blocked by a selected, queued or active acquisition plan. Preserve the standing manual choice and imported file identities; do not silently substitute a provider or delete held assignments. Complete live foundation/library acceptance before resuming downloads or strict cleanup. Bounded failed-refresh retries are part of controlled deployment validation.
- validation, October 5: full CI passed after a provider-registry clone-deserialization failure passed its isolated retry. Final focused catalog/statistics/curation tests passed all 37 on Windows and native Linux; the candidate Docker image builds. The latest persisted live deep-health result is healthy with zero foreign-key violations, and downloads remain paused. These are local candidate checks and read-only live inspection, not deployment acceptance.
- locally validated, October 6: async statistics use smaller event-loop batches and indexed integer/MBID artist scopes. On the 11 GB, 518-artist clone, a warm competing-writer comparison reduced maximum event-loop delay from 412 ms to 55 ms with identical result digests. During 17 full refreshes, 850 mixed HTTP requests succeeded with p95 47-52 ms. Initial cold baseline delay reached 3.1 s; these warm comparisons do not establish cold NAS performance. Twenty-four broader statistics/curation/query tests pass on Windows and native Linux, including persisted restart truth. Prepare 2.21.0 for controlled live validation with downloads paused; unresolved library conflicts are not permission to overwrite media or resume acquisition.
- deployed, October 6: 2.21.0 is healthy on TrueNAS, verified by actual image digest/revision and both package versions after a stopped-app ZFS snapshot. Full local/release CI passed (2,001 API, 186 frontend). Downloads remain paused; scan 15506 resumed its checkpoint. Ray Charles retry 15508 completed; seven remaining failed artists were requeued for bounded validation. Bastille's live rename preview reports zero changes. Still investigate the observed 1.834-second provider-ingestion writer hold, 2.58-second cold dashboard statistics request, non-monotonic provider progress and root scan's prolonged unchanged file progress. Config remains 108 GB, primarily 93 GB artwork and 11 GB backups; artwork/storage acceptance remains open.
- locally validated, October 7: exact persisted LibraryArtists directories now own artist pictures/NFO without arbitrary track/edition links, with indexed lookups, shared-library scope and writer rechecks. Actual-app testing reproduced unsafe scan-time deletion of an artist picture grouped with an incomplete album cover. Removed the stale-sidecar/audio-presence deletion heuristic; automatic deduplication now merges only aliases of the same resolved path and preserves distinct physical assets for verified cleanup. Twenty-four inventory tests and 62 combined Windows checks pass; native Linux passes 92 of 94 broader checks with two Windows-only skips. The rebuilt app preserved three correct metadata rows and unchanged JPEG/NFO bytes through scan 9 and unchanged repeat 10. Full CI passed 2,066 API and 187 frontend tests, lint, typechecks and builds with no failing names or clone retries. The adjusted stale-lyric lifecycle test also passes all nine backfill tests on Windows and native Linux. Candidate remains undeployed; strict planner, review-sidecar disposition and ownership without a persisted artist membership path remain open.
- live storage, October 7: config media-cover is 94 GB, backups 11 GB and logs 13 MB. A bounded 2,000-file sample contains 499 full-resolution images and 1,000 proxies; one sampled directory holds poster and fanart originals, not proven provider/canonical duplicates. Whole-cache ownership/relocation and backup retention still need validation. No storage pruning performed.
- locally validated, October 7: root inventory collects witnessed cleanup candidates in its existing bounded walk; indexed preview pages require a new completed/configuration-current/all-root-witnessed inventory and recheck current ownership and file identity. Protected review sidecars and unresolved metadata are reported at exact paths. Eight new active-schema checks pass; native Linux passes 53 of 54 broader tests with one Windows-only skip. Actual app scans 6/7 produced the same four-entry preview, with only loose JSON eligible and all file bytes unchanged. Full CI passed 2,074 API and 187 frontend tests, lint, typechecks and builds without failing names or clone retries. Public queued apply, persisted outcomes/empty-parent pruning and app review controls remain open; no live cleanup or deployment.
- locally validated, October 7: public cleanup apply queues an exclusive bounded disk command using exact inventory witnesses. Removal outcomes and cursor commit together; failed commits restore bytes, replacements survive retry, review companions remain protected, and witnessed empty-parent pruning retains roots. Preview exposes per-path refusal diagnostics. All 27 focused tests pass on Windows/native Linux; final full CI passes 2,081 API and 187 frontend tests without failing names or clone retries. Actual-app Activity showed both unresolved/permission refusals and a successful retry, with unchanged known/review media and sidecars. No live cleanup or deployment. Finish ownership without artist membership paths, secondary artwork, persistent review sidecars and app review controls before broad live cleanup. Directory counts can underreport a crash between rmdir and outcome persistence; see MANAGED_LIBRARY_CLEANUP.md.
