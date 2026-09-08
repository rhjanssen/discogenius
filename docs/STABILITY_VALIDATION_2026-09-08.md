# Stability validation, 8 September 2026

## Production failure and correction

The copied live database contained 13,660 artists and a large provider graph. The previous synthetic catalogue test did not reproduce that graph and missed expensive provider-rematch writes. Production logs showed SQLite admission failures escaping download/import error handlers and killing the download worker.

Download/import completion, failure, handoff and fallback provenance now await the shared write gate. Progress tries the mutex atomically and stays buffered when another writer owns it. Scheduler ticks and manual task submission await admission too. A real worker-thread regression holds the writer for 15.1 seconds while completion, failure and progress run; terminal writes wait, progress remains responsive, and late progress cannot reopen finished work.

Lidarr's `CommandQueueManager.SetMessage` updates the in-memory command; its terminal `Update` persists completion/failure. This remains the reference for separating transient progress from durable outcomes. Moving all catalogue data into memory would not fix the expensive writes found here.

Provider rematching previously loaded every album edition barcode for each release and repeatedly scanned acquisition dependencies. An indexed, SQLite-maintained barcode projection preserves digit-only/leading-zero normalization. Foreign-key indexes cover the affected plan, file and recording references. The projection is derived from AlbumEditions and is not another catalogue authority.

## Same-data comparison

Consistent copies of the supplied live snapshot were tested with published 2.16.5 and the candidate. Each pair produced the same accepted track count. Times are individual local rematches, not whole-artist throughput or production latency.

| Provider release | Before | Candidate |
| --- | ---: | ---: |
| TIDAL 5616658 | 2,076 ms | 165 ms |
| TIDAL 3188237 | 2,228 ms | 899 ms |
| TIDAL 2134027 | 1,201 ms | 206 ms |
| Apple 1440801714 | 1,541 ms | 216 ms |
| TIDAL 13152058 | 1,083 ms | 55 ms |

These cases do not reproduce the longest production writer hold. Further load measurements should retain the provider graph, not just millions of catalogue tracks.

## Runtime validation

The supplied database/WAL/SHM files were copied into isolated Docker volumes. The original supplied directory was not edited. Old queued commands were cleared only in the test copy before startup. Automatic monitoring was disabled to avoid replaying the entire live backlog. Existing local TIDAL credentials were copied separately; the supplied providers directory was empty.

Brand New Day downloaded and imported while Bastille curation ran. All ten resulting TrackFiles rows belong to stereo library 1. All ten physical FLAC files exist, ffprobe reads their duration, and every file contains recording and release-track MusicBrainz tags. The album API reports ten tracks, ten files and complete download status. Retag and rename commands subsequently completed without errors and made no changes to these already-current files. This does not exercise a fresh rename or tag rewrite.

A subsequent 60-second run issued four concurrent HTTP request loops during Bastille curation:

| Endpoint | Requests | Median | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| System status | 105 | 63 ms | 84 ms | 738 ms |
| Queue | 112 | 3 ms | 72 ms | 739 ms |
| Album details | 104 | 62 ms | 75 ms | 810 ms |
| Artist search | 111 | 9 ms | 72 ms | 868 ms |

All 432 requests returned HTTP 200. Desktop and 390 by 844 mobile browser inspection showed the imported album, artwork, durations and file availability. A separate container started with empty database/config/library volumes and began Bastille catalogue intake.

## Video identity

Apple/TIDAL videos without a MusicBrainz or YouTube counterpart retain their own `provider_catalog` recording and accepted provider match. A provider-supplied MBID is evidence only; it cannot mint a MusicBrainz identity. YouTube provider offers can match an existing catalogue row by exact watch ID.

Later discovery joins compatible YouTube and MusicBrainz recordings before attaching the offer. Contradictory provider MBID evidence cannot redirect an exact YouTube match. Merges run in one transaction, preserve library selection identity and placement, move dependent tracks/files/matches, and retain recording relations. A dependency failure rolls the merge back. Existing YouTube-only rows no longer suppress MusicBrainz video discovery.

Remote YouTube video search and preview hydration are not included in this patch. They must merge results by catalogue identity, preserve exclusive provider videos and avoid monitoring or downloading when a user merely opens a result. Authenticated Apple/YouTube downloads and a complete replay of the 500-artist backlog remain separate validation work.

## Additional clean-start finding

The blank-container download test exposed another admission gap. An album with multiple selected editions queued its first edition, then returned HTTP 500 when another worker acquired the writer before the second enqueue. AlbumCommandService now awaits admission and performs the complete request in one transaction. The multi-edition contract test injects a failure on the second DownloadQueue insert, verifies the first insert rolls back, then verifies both editions queue successfully on retry.

The updated production-data container accepted Bad Blood during concurrent Bastille curation and returned both queue IDs, 9091 and 9092, without a lock error. Downloads were paused in that container to limit this check to admission; the separate clean-start container continued its real TIDAL transfer.

Bad Blood's selected 30-track acquisition completed in the clean-start container. All thirty FLAC files exist in library 1, are readable by ffprobe, and contain recording and release-track MBIDs. SQLite quick_check returned ok and foreign_key_check returned no violations after import. This verifies the first selected acquisition, not every edition of the release group.

The successful import exposed a misleading 30/41 partial-download warning: the importer used the provider's full release count for an explicit track subset. Selected-track imports now use the requested offer count for progress, reconciliation and history. Full-album imports retain the provider count; an existing regression also verifies that a missing selected track still fails the import. The final image was rebuilt and restarted against the retained clean-start volumes.

## Release gate, 9 September

Full `yarn ci` completed successfully after the final change, including lint, TypeScript checks, API tests, 181 frontend tests in 45 files, and both builds. The first API TAP summary reported 1,822 tests with three whole-file Node structured-clone failures. All three files passed the runner's isolated retries: edition-monitoring-contract, video-recording-relations, and provider-registry. There were no new assertion failures. The normal Dockerfile build also passed; the final test image starts healthy on the retained test data.
