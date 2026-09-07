# Stability work and reference comparison

This review accompanies the changes after 2.16.4. The release validation and its limits are recorded in LIVE_AUDIT_2026-09-06.md. The local reference checkouts are design evidence, not proof that those applications never fail.

## What Lidarr actually keeps in memory

`CommandQueueManager` uses an in-memory `CommandQueue` for active commands, duplicate checks and current messages. `SetMessage` changes the command object. Enqueue, start and end persist through the repository. Startup orphans interrupted commands and reloads queued commands. `QueueService` replaces its in-memory download list when it receives `TrackedDownloadRefreshedEvent`.

This reduces database traffic for frequently changing UI state. It does not put the entire music catalogue in RAM or eliminate SQLite's writer lock. `ConnectionStringFactory` configures a roughly 20 MB SQLite page cache, WAL outside macOS, connection pooling and a 1-second busy timeout. `CommandExecutor` starts three dedicated command threads. `BasicRepository` supports SQL pagination and transactional bulk writes. `RefreshTrackService` separates added, changed, merged, deleted and unchanged tracks, then writes the changed sets.

Sources in the read-only checkout:

- `.ref_lidarr/src/NzbDrone.Core/Messaging/Commands/CommandQueueManager.cs`
- `.ref_lidarr/src/NzbDrone.Core/Messaging/Commands/CommandQueue.cs`
- `.ref_lidarr/src/NzbDrone.Core/Messaging/Commands/CommandExecutor.cs`
- `.ref_lidarr/src/NzbDrone.Core/Queue/QueueService.cs`
- `.ref_lidarr/src/NzbDrone.Core/Datastore/ConnectionStringFactory.cs`
- `.ref_lidarr/src/NzbDrone.Core/Datastore/BasicRepository.cs`
- `.ref_lidarr/src/NzbDrone.Core/Music/Services/RefreshTrackService.cs`

## Decisions for Discogenius

| Concern | Reference method | Discogenius decision and validation |
| --- | --- | --- |
| Frequent progress | Lidarr updates active command objects in memory | Consolidate telemetry buffering. Keep ownership, execution plans and final outcomes durable. Verify that a progress burst does not cause one database write per event and that completion preserves the final payload. |
| Expensive catalogue writes | Lidarr reconciles changed sets and uses bulk repository methods | Keep content hashes and short transactions. Fix FTS triggers that scan the entire search table even for unchanged titles. Measure at the observed 3.5-million-track scale. |
| HTTP stalls | Dedicated command threads in Lidarr | Keep heavy work on workers. A Node HTTP event loop must never wait synchronously for a worker's database lock. A shared admission queue is our adaptation, not a mechanism copied from Lidarr. |
| Execution conflicts | Lidarr checks disk, type and global exclusivity | Verify rename, retag, scan and import together, including the dedicated download/import path. A separate worker pool must not bypass disk exclusion. |
| Worker failure | Lidarr marks interrupted work and reloads its queue | Keep physical liveness separate from persisted leases. Await worker exit before releasing ownership. Retry failed recovery and discard obsolete active-state snapshots. |
| Current downloads | Lidarr replaces one current queue snapshot | Use one explicit identity from durable queue through events and UI. Do not construct actionable queue rows from incomplete progress messages. Verify reconnect, requeue and finish races. |
| Search repair | Derived index must remain replaceable | Recreate FTS tables from canonical rows atomically. A database lock is not evidence of corruption. Test rollback and preservation of canonical rows. |
| Catalogue lists | Repository pagination and scoped queries | Examine query plans and relation fan-out before adding caches. Bound caches and invalidate after successful writes. Do not cache the entire provider/catalogue graph. |

Tidarr uses `node-json-db` for its queue and history with cached reads and save-on-push. That is useful evidence for keeping transient download state small. It is not a suitable replacement for Discogenius's relational catalogue, per-library curation or exact import identity. See `.ref_tidarr/api/src/services/db-json.ts` and `batch-queue.ts`.

## Tests to retain, replace and add

Lidarr's `CommandQueueFixture` tests disk access, type exclusivity, exclusive commands and empty queues as behavior. Its `DbTest` framework creates databases through the production factory and migrations, optionally copying a cached fresh database. Our production-service tests must similarly boot the active schema. The separate target-schema contract tests must not be mistaken for production validation.

Fluent UI's testing guide separates component interaction/accessibility, visual regression and integrated browser flows. Discogenius should test its own composition: focus restoration after dialogs, keyboard actions, responsive layout, loading/error states and live queue updates. Repeating Fluent UI's internal component conformance suite would add little protection.

Sources:

- `.ref_lidarr/src/NzbDrone.Core.Test/Messaging/Commands/CommandQueueFixture.cs`
- `.ref_lidarr/src/NzbDrone.Core.Test/Messaging/Commands/CommandQueueManagerFixture.cs`
- `.ref_lidarr/src/NzbDrone.Core.Test/Framework/DbTest.cs`
- `.ref_fluentui/docs/workflows/testing.md`

The retired postMessage write-lock protocol and its tests have been removed in this working change. Their replacement exercises the actual shared mutex in real worker threads and real SQLite connections, including a dead holder and a dead waiter. Test removal is based on a retired responsibility, not test age or a desired count.

Before release, record results for the following:

- Full `yarn ci`, comparing failing test names with the previous baseline.
- Fresh container with the active schema, real acquisition/import, rename and retag.
- Representative large database with concurrent catalogue work and HTTP requests.
- Worker interruption while queued, writing and importing, followed by recovery.
- Desktop and mobile browser checks with real data, including queue progress and errors.

## Findings that need qualification

The live audit observed historical FTS corruption reports. Their timestamps predate the running process, so they are not a fresh integrity check. The retag command advanced during the first observation and was later confirmed failed with a database-lock error. The download worker did die on an uncaught lease-renewal lock error, and recovery also failed.

An early code audit suspected a general command-id/queue-id mismatch. `download-events.ts` already maps command ids through `DownloadWaitQueue.getIdByCommandId`. That suspicion alone does not establish a bug in every progress event. The unresolved cases are fallback identity after queue removal and UI creation of progress-only rows. They require behavioral tests before changing the public identity contract.


## Search behavior and scope

Lidarr's header selector builds a small local artist list. `Components/Page/Header/fuse.worker.js` searches artist name, foreign ID and tags in a browser worker, with a ten-result limit. `ArtistSearchInput.js` debounces input and offers a separate action for catalogue discovery. `SearchController` delegates new artist/album searches to `SkyHookProxy`, including MusicBrainz identifier queries. This is not an example of loading millions of catalogue tracks into browser memory.

`SkyHookProxySearchFixture.cs` exercises real HTTP, punctuation, direct IDs, no-result queries and mixed artist/album results. The checked-out fixture has an Ignore annotation for metadata availability, so its presence is not evidence of a passing upstream test run. Discogenius uses deterministic active-schema tests for local matching plus separate real-catalogue validation.

The existing word-prefix indexes remain for discovery. Album-list substring filters now use a compact trigram index for title/artist candidates before detail joins. This retains partial words, punctuation and LIKE wildcard behavior. One- and two-character filters cannot use trigram narrowing; they remain a documented broad-query limit. A second derived catalogue index is justified by the different tokenization needs, not a second catalogue authority.

A future discovery page should merge configured Servarr/local-MusicBrainz results with local rows by typed canonical IDs. An unknown release group can use its canonical album URL and show a bounded, retryable loading state while a queued hydration command imports its catalogue facts. Opening it must not create library membership or start downloads. This is outside the 2.16.5 fix release.

Fluent's `packages/tokens/src/alias/lightColor.ts` gives text and filled controls distinct brand steps. The previous app override used bright logo colors for both and explicitly accepted insufficient contrast. Restoring Fluent fill and interaction mapping, with readable dark text steps, removes that exception; tests now check label contrast across accents and interaction states.
