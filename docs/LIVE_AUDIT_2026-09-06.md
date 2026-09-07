# Live audit, 6 September 2026

Audited https://discogenius.spikkelpoot.com, running 2.16.4, through read-only API calls and Chrome. The earlier DNS failure concerned a misspelled hostname and is resolved. Production was not modified. Local containers provide separate evidence.

## Runtime findings

- RenameArtist 8838 failed with `database is locked` at 5%.
- RetagArtist 8839 advanced from 145 to 580 of 7,268 files during the first observation. At 22:05 UTC it was confirmed failed with `database is locked`, after 1,015 files at 17%. It was not proven frozen throughout the earlier observation.
- Download-worker logs recorded uncaught `SQLITE_BUSY` in `DownloadProcessor.renewOwnedAttemptLeases`. Recovery also encountered lock errors and could leave obsolete active downloads in the proxy snapshot.
- Initial diagnostics recorded a 267-second writer hold, 472-second maximum wait and 28.57-second maximum main-thread event-loop lag. Rename and retag API submissions took roughly 20 and 22 seconds, while many ordinary reads took 44-56 ms.
- Initial library size was 518 monitored artists and 3,471,269 catalogue tracks. The late UI rounded its growing catalogue to 3.6 million tracks. Artist count alone understates the workload.
- At 22:05 UTC, command and queue-status reads took 6-86 ms, despite the failed retag. Command 8868 was started at 0%, reporting track 1/16. Queue status reported one active worker download while the UI showed two started download cards. History contained both completed acquisitions and recent worker/import failures.

Historical deep-health records reported FTS corruption at 06:44 UTC, before the observed process startup around 06:59 UTC. This is not a fresh corruption check. Foreign-key violations were not reported in that stored audit. A successful `/health` response only establishes liveness. No network-throughput conclusion follows from these observations.

## Code changes under validation

- FTS triggers scanned unindexed text IDs, even for unchanged titles. Deterministic integer rowids and change-sensitive triggers avoid those scans. Derived indexes can be rebuilt transactionally from canonical rows.
- Frequent command descriptions/progress now coalesce in memory, with periodic checkpoints and durable terminal outcomes. Execution ownership remains durable.
- Shared writer admission keeps HTTP waiting asynchronous and reports actual holders/waiters. Dead-worker cleanup removes abandoned tickets. Heartbeats remain independent of lease persistence; failed download recovery retries and discards obsolete active snapshots.
- The separate download/import pipeline bypassed disk-access exclusion. Import claims now check the same exclusion rules atomically as rename/retag commands.
- Rename/retag handlers now fail on returned per-file errors, reporting the count and a bounded sample of exact file IDs. Media rewriting retains the original until replacement is ready and waits for timed-out child processes to exit before cleanup.
- Queue cards retain each acquisition's exact queue-row identity, sort active work first and refresh on start transitions. Incomplete progress events cannot create actionable rows.
- A shared occurrence-aware reducer replaces separate persisted/browser/import progress rules. Ambiguous titles or repeated provider IDs do not select the first row. Equal list lengths do not establish completion order.

The early suspicion of a general command-id/queue-id mismatch was too broad. `download-events.ts` already maps commands to public wait-queue IDs. The confirmed defects do not justify changing that public identity contract.

## References and validation limits

See [the reference review](STABILITY_REFERENCE_REVIEW_2026-09-06.md) for Lidarr, Tidarr and Fluent UI mechanisms and test decisions. Lidarr keeps active commands/download snapshots in memory, not the entire catalogue.

An isolated 3.5-million-row FTS benchmark measured ten unchanged updates at 6,074 ms before and below 1 ms after; ten changed updates took 5,593 ms and about 1 ms. This is an index benchmark, not a whole-server speedup.

The first fresh-container start exposed an additional collision between download scheduling and its lease timer. Scheduling now uses shared writer admission. The subsequent start initialized both worker systems without that error. Full CI, real acquisition/file verification, large-database HTTP load and responsive browser checks remain release gates. The older 2.16.4 validation used 25 files and does not establish production-scale performance.


## Release 2.16.5 validation

The final image also booted with new, empty named volumes on port 3858: schema 46, all three search indexes present, empty statistics/queue, quick_check OK and no foreign-key violations. Command and download workers initialized without lock errors. The older user container on port 3737 remains untouched at 2.16.2; its reported Bad Blood destination failure is covered by the 2.16.4 destination validation.

The separate test library on port 3838 started empty earlier in this validation. Real catalogue acquisition for Bastille and Bakermat completed. Five TIDAL acquisitions imported 27 stereo FLAC files. Every file was probed for channels, destination, provider identity and MusicBrainz recording/edition tags. Rename and retag commands completed, including a deliberately changed naming pattern and stripping/rewriting one file's tags. The audio-stream SHA-256 was unchanged. All 27 files passed verification again after restarting with 2.16.5.

The large test database retained real curation from a local read-only snapshot and added synthetic catalogue rows through the active schema: about 12,600 artists, 442,000 albums and 3.53 million tracks. It is not a clone of the 518-artist production workload. An 80-request test with four concurrent clients returned all 200s. Representative maxima before/after the read-query changes were dashboard stats 4,869/165 ms and album substring search 2,457/287 ms. Exact results depend on cache state and other machine load.

A further run during real Bastille/Bakermat metadata refresh also returned all 200s and both refresh commands completed. It still recorded a 2,334 ms cold stats read and a 6,506 ms video-update transaction. The new writer admission prevents HTTP from synchronously waiting for that worker lock, but does not make every cold read or catalogue write fast. Those remaining costs should be profiled independently. Artwork requests also reported a timeout and one missing temporary-cache file during this run; these were not download/import failures.

The final browser suite passed all 74 tests. Eight additional checks against real data covered library, dashboard, artist and settings at 1440 px and 390 px, with no page-script errors, horizontal page overflow or axe WCAG A/AA violations. The initial run found low contrast on the Resume button and exposed outdated queue-order/identity expectations; the final run includes their corrections.

Live acquisition evidence is for TIDAL stereo. This validation does not certify every provider, Atmos/video imports, arbitrary network speed, or production behavior after Robert deploys the image. Worker failure/recovery evidence comes from real worker/SQLite tests, not a production power-loss experiment.


Final code checks: 1,815 API tests and 181 frontend tests passed. The first TAP result set has no failing names, as did the earlier 1,810-test comparison run; no clone-flake retry was needed. Lint, both TypeScript checks and production builds passed in the full release CI command. The 3.53-million-track database also completed quick_check with no foreign-key violations and no failed validation commands.
