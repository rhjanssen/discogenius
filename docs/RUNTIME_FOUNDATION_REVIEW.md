# Runtime foundation review

Status: local 2.17.0 release gates passed, 2026-09-29.
Working branch: `codex/runtime-foundation`. NAS verification follows publication.

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

MoveArtist and new-artist discovery still retain whole-command disk ownership. TagLib
and Mutagen metadata writers still edit files in place. Their intent/outcome
records prevent false success and unsafe automatic replay, but are not an atomic
replacement protocol for interrupted tag writes. Newly created sidecar copies
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
