# Runtime foundation review

Status: 2.19.2 deployed and verified on the NAS, 2026-10-03. Bounded catalogue
hydration follow-up is in validation.
Working branch: `codex/runtime-foundation`.

## Production evidence

The audited baseline server ran 2.16.24. At 23:21 UTC on September 28, `/api/health`
returned HTTP 503. Docker liveness was healthy. These checks answer different
questions and must not be used interchangeably.

| Observation | Consequence |
| --- | --- |
| Shared writer's longest hold was 223,077 ms, labelled `refresh-artist:videos`; longest wait was 219,488 ms | Whole-artist repair still monopolizes database admission despite preparation being moved outside some transactions |
| Retag command 14488 started at 18:31 UTC and had processed 24,772 of 34,385 files at 04:34 UTC on September 29 | It is progressing, but owns the global disk slot for the full library operation |
| Five album downloads were at 100% and waiting for import | Download completion is not library completion; bulk maintenance prevents import admission and occupies acquisition capacity |
| Rename 14487 failed at 59%, with 2,711 files renamed and zero file errors | A process restart interrupted it; filesystem mutation commands intentionally have no automatic replay without a journal |
| Request p50 4.17 ms, p95 739.28 ms, p99 779.84 ms; event-loop maximum lag 1,043.33 ms | Request latency and event-loop lag require separate tracing; these aggregates do not identify a particular SQL query |
| Deep integrity check passed, including zero foreign-key violations | No current evidence of database corruption |
| Embedded SQLite is 3.51.2 | Upgrade to a version containing the WAL reset fix before changing concurrency |
| The live query plan for video audio-album classification used indexed lookups | That specific OR join is not a demonstrated table-scan culprit; do not rewrite SQL on intuition alone |

Raw health, queue, query-plan and log evidence is retained in the local audit
directory. It includes runtime state and must not be committed as application data.

## Underlying ownership problems

Database admission, SQLite transactions, command workers, and disk admission are
four separate resources. Their lifetimes currently follow service or command
boundaries rather than the operations that actually require each resource.

1. Bulk video upsert opens one transaction containing identity scoring and
   whole-artist assignment/relation repair. `prepareArtistVideoUpsert` only moves
   audio candidate preparation; its returned callback is not a persistence-only
   contract. Other callers also wrap the combined operation in writer admission.
2. `requiresDiskAccess` reserves one global slot for the command's entire life.
   Yielding the event loop after a retag batch does not release this slot.
   Manual-command priority can also delay completed download imports indefinitely.
3. File mutation has no durable intent/result journal. A planned restart can
   leave successful partial work and a failed parent command. Raising retry
   attempts would hide this gap and risk destructive replay.
4. Every worker has a synchronous SQLite connection and can invoke broad service
   functions through the database proxy. A writer mutex coordinates threads, but
   does not enforce a small persistence boundary. HTTP still performs synchronous
   reads. Library statistics already use a short-lived read-only worker and a
   ten-second snapshot cache. A slow statistics response is therefore not proof
   of synchronous SQL on the HTTP thread. A new runtime alone would preserve
   these ownership mistakes.

The call-site inventory found 145 writer-gate calls. The only literal asynchronous
callbacks were in the mutex test fixture. Network awaits inside production writer
callbacks have not been demonstrated by that inventory; indirect service calls
and read/compute work require separate tracing.

## What the reference projects establish

The reference checkouts are read-only. Patterns can be adapted; their different
schemas, identity rules and file policies cannot be copied blindly.

| Project and source | Useful lesson | Limit |
| --- | --- | --- |
| Lidarr `Messaging/Commands/CommandExecutor.cs` and `Datastore/ConnectionStringFactory.cs` | One process, three command threads, SQLite, 1,000 ms busy timeout. Process count does not explain our starvation | Its command granularity and file lifecycle still need comparison for each operation |
| Lidarr `MediaFiles/RenameTrackFileService.cs` | Update exact file identity after each move; publish file and artist completion events | Our edition, spatial and artwork-sidecar ownership rules differ |
| Jellyfin `Jellyfin.Database.Providers.Sqlite/SqliteDatabaseProvider.cs` | Private cache, connection pooling and explicit SQLite settings | .NET still has SQLite writer and checkpoint constraints |
| qBittorrent `base/keyvaluedatastorage.cpp` | A dedicated database thread owns a typed job queue and connection | It batches a key/value queue until empty. Our catalogue volume needs bounded transactions and fairness instead |

SQLite allows one WAL writer at a time, irrespective of the application language.
Long readers can prevent checkpoint reset. `journal_size_limit` is not a hard WAL
size cap. SQLite also documents a rare WAL reset defect in versions through
3.51.2, fixed in 3.51.3 and specified backports. These are separate from our
measured service-level mutex and scheduler problems.
[SQLite WAL documentation](https://www.sqlite.org/wal.html).

`better-sqlite3` 12.8.0 embeds SQLite 3.51.3. The foundation branch pins that
version and verifies the actual embedded engine, rather than assuming a package
version proves what production runs.
[Upstream release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.8.0).

## October 2 follow-up on 2.18.0

The NAS was verified running revision `78ca1d51` and API version 2.18.0 after
the user's manual update. Download admission remained paused. Rename 14723
stopped when a lyric's linked TrackFiles identity changed. Retag 14724 reached
all 34,919 planned files, with 33,797 tagged, 1,038 skipped, 16 missing and 73
reported errors. It was not a wholly stalled retag.

The longest writer hold was 64,056 ms under `housekeeping:stale-assets`.
The long hold was application admission, not evidence of SQLite corruption.
Housekeeping also removed audio rows without removing their physical files,
allowing the next scan to mint new IDs and rebind sidecars. This defeated the
identity guarantees of persisted file plans. Acquisition/import owns physical
replacement; housekeeping now preserves distinct physical audio paths.

Stale-sidecar stat calls now run asynchronously outside writer admission.
Only definite missing-path errors qualify for deletion. A short commit compares
the captured ID and path facts so a concurrent rename or scan repair survives.
Directory checks use expression indexes and bounded prefix ranges. Sidecar
deduplication still performs synchronous filesystem work under a writer gate,
but each artist releases that gate before the next artist. Further splitting
requires measuring the largest artist, not assuming this boundary is sufficient.

Artist refresh can write media without owning the maintenance disk slot. Shared
file reservations now cover native writes, compatibility rewrites and rename
source/destination paths across the command and download workers. Retag keeps
its reservation through read/write/verification and uses one desired metadata
snapshot. A worker's reservation is reclaimed only after its physical exit.
These reservations do not replace durable intent or the mutation journal.

Of the retag errors, 65 were embedded-cover failures. Two copied source covers
were 18.5 and 27.6 MB, above FLAC's 24-bit metadata-block size limit. Embedded
copies retain their 4,000 by 4,000 dimensions and use JPEG encoding below that
limit; the library sidecar remains byte-identical. Five errors were track-field
verification notices and three were native writes. All ten copied problem files
accepted native tag/cover writes locally without changing decoded audio. Live
retries are still needed to validate the remaining context-dependent failures.

Apple Music repeatedly returned HTTP 429 during collaboration searches.
Lidarr's `TooManyRequestsException` parses seconds or HTTP-date Retry-After and
its indexer records a cooldown. Discogenius now follows that behavior with a
shared worker cooldown and ends the throttled collaboration search pass.
It does not interpret throttling as unavailable media or silently claim that
provider authentication and acquisition are healthy.

A read-only container audit decoded 123 live audio files, including problem
tracks and samples from successful retag work. All decoded successfully. Of
the 98 present in the September 29 snapshot, all decoded audio hashes matched.
The other 25 had no baseline in that snapshot. No whole-library integrity claim
or complete Plex presentation claim follows from this sample.

Linux validation wrote tags and embedded artwork on ten copied problem files.
Each retained identical decoded audio and original sidecar bytes. On the
production database copy, 27-file strip and retag commands completed with no
errors in four seconds while sharing checkpointed admission. Mobile portrait
and landscape selection controls remain accessible through the overflow menu.

Manual API testing also found that an empty file selection fell through to
the default all-library query. Both retag routes and command execution now
reject empty or malformed selections. An all-files query requires an explicit
artist, album or edition scope and `applyAll`. This protects persisted commands
as well as HTTP callers.

The stopped Bob Marley rename provided a second authority mismatch: its stored
edition differed from the curated sibling used by rename's identity resolver.
Its adjacent audio still carried tags for a third, older album context. Rename
now requests stored-file edition context, retaining its recorded canonical
edition regardless of monitoring selection. Acquisition retains the deliberate
curated-destination behavior before import. Rebinding a stored file remains an
explicit reconciliation operation that changes its file identity before a new
rename plan. Cached and uncached rename tests cover the same unmonitored sibling
alongside acquisition remapping tests.

## Changes and validation still required

Implemented locally:

- Pin the SQLite binding to 12.8.0. The local engine reports 3.51.3.
- Bulk artist/provider video refresh now commits ten video identities at a time,
  yields writer admission and the event loop, and performs bounded repair passes.
  Assignment passes reload exact row identities after merges.
- Regression tests check concurrent writer admission, canonical identity and
  repair when the provider returns no new videos.
- Audio/video retag and strip commands persist exact file identities in indexed
  command work records. Each file records its intent before writing and its
  verified outcome afterwards. A dispatch settles at most 25 files or 30 seconds
  between files, then returns to the queue and releases disk admission.
- Continuations preserve progress and do not consume infrastructure retries.
  Ownership checks prevent an expired worker from settling or starting another
  file. In-flight writes still require explicit retry after interruption.
- Completed downloads waiting at least one minute for import take precedence
  over newly admitted manual disk maintenance. Existing disk work is not
  preempted and conflicting filesystem operations remain exclusive.
- File plans are independent of command payload JSON, so settling one file does
  not rewrite a library-wide ID list. A 33,140-file production-copy plan took
  330 ms to prepare outside admission and 218 ms to commit locally.
- Production-copy video refresh produced identical recording, accepted match,
  and relation snapshots. The old path ran for 4.69 seconds with no event-loop
  timer ticks; bounded work ran for 5.27 seconds with 137 timer ticks. These local
  measurements do not establish a bound for the live 223-second case.
- The first complete validation passed 1,891 backend and 186 frontend tests,
  lint, type checking and both builds. Linux real-file and mixed-load validation
  remain release gates.
- The Linux test container used an 11.4 GB completed production backup copied
  onto a named ext4 volume. Its embedded SQLite reports 3.51.3. Existing queued
  work was isolated and provider downloads/monitoring disabled for this test.
- Real M4A copies with deliberately stale titles were corrected through the
  command workers and through the app's artist retag dialog. All 26 settled
  without errors. Mutagen independently confirmed titles, artist, album and
  recording MBID; decoded audio of the inspected copy remained unchanged.
- Queue page reads on the copied database sorted and joined more than 40,000
  waiting rows to return 50 entries. Selecting running and pending identities
  through their existing indexes before loading details reduced warm SQL time
  from about 90 ms to about 1 ms. Tests cover pages crossing that boundary,
  tied order ranks, claimed/unclaimed rows and exclusion of terminal commands.
- Single-video organizer, seed and manual-import paths now use bounded video
  persistence too. Manual imports group video entries by artist. Orphan cleanup
  also releases admission between batches rather than retaining a whole-artist
  transaction after the other passes have finished.
- Canonical edition/video relation derivation runs outside writer admission.
  Edition relations commit ten at a time; standalone inferred relations release
  admission individually and recheck for a stronger relation before writing.
  An active-schema test admits a concurrent writer before 30 videos finish.
- Rename commands persist exact typed file identities, naming configuration,
  settled outcomes and a cursor. They release disk admission after 25 primary
  files or 30 seconds between files. Linked extras remain part of their primary
  file unit. Failed files require explicit retry; retired owners cannot settle.
- A filesystem journal records move/delete intent before changing bytes. Exact
  row updates acknowledge the intent in the same database transaction. Recovery
  restores uncommitted moves and retains verified committed destinations.
  Cross-filesystem copies use owned temporary files and SHA-256 verification;
  publication refuses to overwrite an occupied destination. Unresolved evidence
  blocks new disk work and appears in health diagnostics.
- Four real Linux process-kill cases cover same-filesystem and EXDEV moves,
  both before and after DB commit. Fresh-process recovery retained the expected
  path and identical bytes, with no pending journal entries. This establishes
  process-crash recovery, not power-loss durability.
- The app's rename preview correctly refused conflicting duplicate targets.
  A single actionable real M4A then completed through the UI with one rename,
  no errors, the exact DB path and identical full-file SHA-256. One unrelated
  existing lyric was absent from the disposable fixture and reported missing.
- Disk cancellation keeps ownership until the current file settles, then stops
  before starting another file. A real 27-file UI retag cancelled at 26 settled
  files, one pending, zero in-flight and zero errors. Non-file commands release
  ownership only after worker exit. Explicit retry clears cancellation intent.
- Planned shutdown stops new dispatch and drains worker units for up to 60
  seconds. Compose grants 90 seconds. A timeout preserves interruption evidence;
  it does not claim that an in-place tag write completed safely. A real worker
  fixture verifies drain completion and rejection of new work during shutdown.
- Production-copy query comparisons returned identical complete result JSON:
  top-track enrichment 358 to 27 ms; artist album state 254 to 4 ms for 126 rows;
  artist videos 49 to 2 ms for 111 rows; ranking selection 43 to 3 ms for 100
  tracks. Artist-scoped CTEs and indexed edition membership prevent global
  materialization and per-library repeated scans. These are local SQL timings.
- Browser queue status exposed a cold aggregate reading large pending payload
  rows. A partial covering index on unclaimed command names avoids those table
  fetches. The forced covering scan returned identical counts in 2 ms compared
  with 39 ms for the previous warm query. This is separate from queue pagination.
- Four-client mixed HTTP checks produced 543 successful requests in 30 seconds.
  Ping p95 was 51 ms and queue p95 65 ms while navigating artist/rename pages.
  Those checks did not exercise live acquisition or prove NAS throughput.
- A subsequent 45-second container run combined 27 real M4A retags and a
  two-artist scan removing 30 deliberately missing records with 814 successful
  HTTP requests. Ping p95 was 43 ms and queue p95 61 ms. Both maintenance jobs
  completed through checkpointed worker dispatches with no file errors or
  database-lock errors. This fixture did not perform provider acquisition.
- The complete CI run after cancellation and catalogue-link changes passed
  1,916 backend and 186 frontend tests, lint, type checking and both builds.
  The final cancellation-event guard also passed the complete run.

- Ordinary reconciliation checkpoints one artist per dispatch, including its
  sidecar repair and statistics. The root scope is fixed once and survives
  restart. Unmapped cleanup reads 100 identities at a time, checks paths outside
  writer admission and commits at most 25 deletions per gate. New-artist discovery
  retains the previous root workflow. One very large artist can still delay
  imports until that artist's unit settles.
- Real scanning exposed synchronous orphan deletion contending with another
  writer. It now awaits writer admission and emits deletion events only after
  the exact row is deleted. A contention regression uses the active schema.
- With the dashboard event stream connected and no command active, the rebuilt
  app exited successfully on SIGTERM. HTTP streams close after worker drain.
- All 27 files in the cancellation fixture retained the source's decoded audio
  MD5. Independent tag inspection found the expected title in the 26 settled
  files and the deliberately stale title in the one pending file.

MoveArtist and new-artist discovery still retain whole-command disk ownership. TagLib and FFmpeg already prepare a working file and replace the original with
one filesystem rename. The Mutagen compatibility backend now uses the same
working-copy protocol, with a bounded child lifetime. Both scanners exclude
owned rewrite files, so an interrupted working copy cannot become a library track.
Power-loss durability and recovery of abandoned rewrite files still need tests. Newly created sidecar copies
also need wider filesystem journal coverage before 3.0.

Provider edition ingestion was traced to one provider edition per transaction,
including exact member replacement and dependent match/plan invalidation. It is
not the demonstrated 223-second video callback. Matching computation inside that
transaction still needs measured preparation/persistence separation. Ranking
rebuild is indexed now but can still initialize synchronously on a first page
read. Move that initialization to durable queued work before 3.0.

Required for this release:

- Full `yarn ci`, Linux container checks, crash recovery and actual mobile/desktop
  app use. Verify ordinary scan checkpoints and streaming-connection shutdown.
- Verify the published running image on the NAS, observe the waiting imports
  completing, and inspect fresh provider errors separately from old attempts.
- Preserve pre-upgrade library/config snapshots. The currently deployed tag
  writer lacks worker drain, so validate files affected by its stop before
  retrying maintenance.

Remaining work before 3.0:

- Compare bulk video end states and writer duration on a production-size database
  copy. A row-count limit alone does not guarantee a latency bound.
- Extend bounded durable work units to remaining bulk scan/move operations. Persist
  exact file IDs, desired operation/configuration and settled outcomes. Release
  disk admission between units; reserve conflicting file/album scopes rather than
  allowing overlapping rename, import, cover replacement and retag blindly.
- Extend mutation journaling to atomic metadata replacement and new sidecar
  copies. Keep process-crash verification distinct from power-loss verification.
- Give ready imports bounded waiting time while bulk maintenance remains active.
  Parked import work must not exhaust download execution capacity.
- Trace every bulk writer path, including provider edition ingestion, catalogue
  video links, artist statistics and sparse video twins. Separate preparation
  from persistence and remove duplicate combined paths as they are replaced.
- Measure HTTP query cost separately. Move expensive read/compute operations off
  the HTTP event loop and use indexed, bounded queries and explicit cache
  invalidation. Do not add more workers to conceal unbounded queries.
- Compare an incremental dedicated writer thread with the current fair mutex on
  realistic mixed workloads. A writer actor improves ownership only when callers
  submit small typed operations; moving a 223-second callback to it changes no
  throughput guarantee.
- Repeat mixed acquisition/import/retag/scan load and crash recovery across
  providers after the remaining mutation paths adopt these boundaries.

## Runtime choice

Keep TypeScript while these measurable boundaries are corrected. Node already
runs command, download and maintenance worker threads. A .NET prototype is worth
comparing if bounded operations still fail latency/throughput targets, or if a
measured workload needs different tooling. Switching Node to another JavaScript
runtime, or porting to C#, does not itself remove SQLite's single writer or the
global disk reservation. A PostgreSQL migration would change write concurrency,
but would not fix filesystem recovery or command starvation.

## 3.0 acceptance gates

- Exact file and edition identity survives import, rename, retag and restart.
- Selected full-resolution artwork is stored in cache before import, then owned
  by the album sidecar. Cache retains only proxies for imported albums. Source
  changes refetch the selected original and update sidecars and embedded art.
- Tags and embedded covers match the selected catalogue facts; decoded audio
  remains unchanged after metadata-only edits. Validate real Plex-visible files.
- All enabled providers have a documented successful and partial-failure path.
- Bulk maintenance makes progress without starving imports or HTTP requests.
- Progress is monotonic within an attempt and reflects the actual pipeline stage.
- Core code has one authoritative implementation per operation, an active schema
  contract, no obsolete adapters, and no provider identity shortcuts.
- Mobile selection/actions, queue/activity pagination and import interactions
  pass real browser checks at portrait and landscape widths.
- Observe a representative mixed workload over time before declaring stability.
- Preserve the existing Git history until these gates pass. Plan any 3.0 history
  prune separately, preserving release artifacts, provenance and license notices.

Future Plex, Jellyfin and Navidrome refresh integrations should consume settled
file/library events after commit. They must not report success before local
files, tags and artwork are verified.

## Live follow-up after 2.17.0

The NAS replay exposed remaining relation batches holding the writer for six to
ten seconds. Casts on provider identity columns forced repeated scans while
resolving album and video memberships. Exact TEXT equality restores the
provider/entity/id index. Repair relation reads now use the current recording
batch, and album counterpart repair runs after the edition transaction releases
writer admission. Identical database copies produced identical normalized
recordings, matches and relations. The 275-offer Olly Murs replay fell from
23.5 to 4.3 seconds; its longest writer hold fell from 6,486 to 270 ms.

The main-thread download proxy listened only for terminal maintenance updates.
It now relays queued checkpoints too, and the worker schedules the earliest
future download retry deadline. A recovered handoff no longer needs an
unrelated terminal event to obtain admission after its retry delay expires.

New-file indexing, duplicate indexing, unresolved-file relinking, unmapped
tracking and derived selection updates await short writer sections. A real
PCM WAV discovery test holds a competing writer and verifies both persistence
and exclusion of abandoned tag/FFmpeg files. Mutagen now modifies a private
working copy; a real M4A test verifies successful tags independently, unchanged
decoded audio and byte-identical preservation after a failing writer.

## Live admission and telemetry follow-up

The published 2.17.1 image was verified on the NAS at revision
`8a7d391587a2d780e8b8d66fe4d4f9a1cba281a4`. The five recovered TIDAL and
Apple handoffs completed. The live workload also exposed three separate
boundaries that writer batching alone does not fix:

- A checkpoint released the worker but retained its original FIFO rank. An
  older root scan could immediately reclaim the disk slot ahead of waiting
  rename and retag work. Continuations now move to the maintenance queue tail;
  priority and trigger rank still govern admission.
- Routine filesystem scans performed online lyric enrichment while reserving
  the disk queue. Scans now register existing lyrics locally. Import and
  explicit metadata refresh remain the enrichment paths. Cover and NFO repair
  remain part of scanning; this does not claim every optional network phase is
  bounded yet.
- File events deleted the statistics snapshot, forcing dashboard requests to
  await repeated catalogue recounts. Mutation invalidation now marks a valid
  snapshot stale and refreshes it in the background. Explicit cache resets
  still discard it.

Download terminal state also shared the lossy telemetry buffer. Completing the
command then clearing its buffer could discard its final state under writer
contention. Completion and failure now write their buffered state directly
under the owned terminal writer section before retiring the command. Late
progress remains fenced out.

The local 2.18.0 container replayed three 27-file retag commands together. These
were idempotent replays of already-correct files, and all settled without missing
files or errors. The dispatch sequence rotated through all three first work
units before returning to their remaining files. Twenty HTTP statistics reads
during that workload took 3–4 ms each; the initial cold recount remains a worker
read and can take several seconds on the production-sized catalogue. The live
cache audit measured 97 GiB. Several recovered imports retained only 250/500
proxies with their full-resolution sidecar, while a multi-edition album still
retained a separate album-level original. This does not establish complete
library-wide artwork cleanup.

Remaining 3.0 work includes bounded optional enrichment, finer scan work units
for very large artists, interrupted-import journaling and library-wide artwork
ownership verification. A clean shutdown can still interrupt an import after
partial file work; recovery deliberately requires an explicit retry instead of
automatically replaying mutations.


## Manual import recovery found during release validation

A real Bakermat TIDAL acquisition took nine seconds. A local canonical import
then failed on filesystem permissions after writing a TrackFiles row and deleting
its UnmappedFiles work. Retry skipped the consumed mapping and reported completion
without the canonical edition or MusicBrainz tags. The audio still decoded, but
the operation had not completed.

Canonical import now binds the exact operation file IDs before finalization and
tag writing. Unmapped work is consumed after those phases succeed. Database row
creation, canonical binding, status updates and completion use writer admission;
provider reads and native media work remain outside those sections. This follows
Lidarr's separation of a resolved LocalTrack/TrackFile from tagging and import
results, as shown in `.ref_lidarr/src/NzbDrone.Core/MediaFiles/TrackImport/ImportApprovedTracks.cs`.

The revised container reproduced the permission failure with the canonical
edition already attached and unmapped work retained. Retrying the same command
kept TrackFiles ID 33810, moved the file to the canonical album directory, wrote
MusicBrainz album tags and preserved decoded audio exactly. The mutation journal
was empty after completion. Publication of the earlier 2.19.0 candidate was
cancelled; it was not deployed to the NAS.

## Physical file identity at every entry point

The live 2.19.1 retry repaired the 65 oversized-cover failures and the three
native-write failures. Five unresolved recording-level files still received a
track-zero target because their edition count was known but their canonical
track occurrence was not. Retag now leaves track/disc positions under the
existing file's authority until that occurrence is resolved. Native tests cover
FLAC, M4A and MP3, including scrubbing and an idempotent second pass.

Housekeeping was not the only file-row deduplication entry point. The shared
upsert selected a provider resource's newest file and deleted the remaining rows,
even when their physical paths differed. Its active-schema regression retained
one of two real files before correction. Upsert now resolves only the path it
writes; explicit replacement/rename services own file retirement. Track-sidecar
deduplication uses the linked TrackFiles ID, with directory scope for unresolved
links. An existing path's Library ownership is validated before writing.

Lidarr was also configured with automatic tag writing set to `sync` and tag
scrubbing enabled while importing 23,612 existing tracks from the shared Music
root. Both settings were disabled on the NAS after preserving a settings backup.
Both apps remain connected for recognition/database comparison. This prevents
Lidarr's automatic retags; it does not make its writable mount read-only or
prevent explicitly requested manual file changes.

## Bounded catalogue hydration

After 2.19.2 deployment, retag command 14724 retried its five remaining failed
files. Generation 3 completed all five with zero errors or missing files; all
five were already correct under the resolved-position rules and needed no write.
Each retained its exact TrackFiles ID and decoded SHA-256 from the pre-update
snapshot. Rename 14723 resumed generation 1 above cursor 12,758 of 64,047. It
is still unfinished; the retag result does not establish rename completion.

Bruce Springsteen refresh 14730 still failed against the local MusicBrainz
server. A read-only replay reproduced the 20-second statement timeout in the
edition/track/recording join for all 2,138 credited release groups. The previous
"one fetch per artist" optimization removed round trips but made the artist's
entire catalogue one unbounded query and payload.

Full-detail queries now use at most 32 groups per backend batch. The refresh
service reconciles each batch before requesting the next, including the hosted
Servarr fallback, so it does not retain the complete artist track payload before
starting persistence. A later failed bulk fetch propagates the error while
earlier groups remain committed. Active-schema tests verify that order and
partial progress; backend tests verify all unique identities survive batching.

The revised read-only replay returned all 2,138 groups and 146,972 track
occurrences. Across 670 queries, total SQL time was 34,706 ms and the longest
statement was 615 ms. This measures the catalogue read, not complete artist
refresh duration, provider matching, sidecar enrichment or a cold mirror.
